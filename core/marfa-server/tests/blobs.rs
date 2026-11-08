//! Files kept on disk: what an upload leaves behind when it fails, and what a download holds.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body::Frame;
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}

/// A body that hands out its frames in order, ending in the error when it has one.
struct Frames {
    frames: VecDeque<Result<Vec<u8>, std::io::Error>>,
}

impl http_body::Body for Frames {
    type Data = axum::body::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Poll::Ready(
            self.frames
                .pop_front()
                .map(|next| next.map(|data| Frame::data(data.into()))),
        )
    }
}

fn hash_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn upload_request(token: Option<&str>, body: Body, media: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(Method::POST).uri("/blobs");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(media) = media {
        builder = builder.header(header::CONTENT_TYPE, media);
    }
    builder.body(body).unwrap()
}

fn get(method: Method, path: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty()).unwrap()
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap_or_default();
    Reply {
        status: parts.status,
        headers: parts.headers,
        bytes: bytes.to_vec(),
    }
}

impl Instance {
    async fn start() -> Instance {
        Instance::with(&[]).await
    }

    async fn with(more: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut pairs = vec![
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(more);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
        }
    }

    fn folder(&self) -> PathBuf {
        self.dir.path().join("blobs")
    }

    /// Every file the blob folder holds apart from its marker, as paths below it.
    fn files(&self) -> Vec<PathBuf> {
        fn walk(folder: &Path, root: &Path, into: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, into);
                } else if path.file_name().is_some_and(|name| name != ".marfa-store") {
                    into.push(path.strip_prefix(root).unwrap().to_path_buf());
                }
            }
        }
        let mut found = Vec::new();
        walk(&self.folder(), &self.folder(), &mut found);
        found
    }

    async fn put(&self, bytes: &[u8]) -> Reply {
        let body = Body::from(bytes.to_vec());
        send(&self.control, upload_request(None, body, None)).await
    }

    async fn fetch(&self, hash: &str) -> Reply {
        send(
            &self.control,
            get(Method::GET, &format!("/blobs/{hash}"), None),
        )
        .await
    }

    async fn writer(&self, source: &str, permissions: Value) -> String {
        let body = json!({
            "label": source,
            "source": source,
            "permissions": [],
            "type_permissions": permissions,
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/keys")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let minted = send(&self.control, request).await;
        assert_eq!(minted.status, StatusCode::CREATED);
        minted.json()["key"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn an_upload_is_kept_under_its_hash_and_read_back_whole_and_by_range() {
    let instance = Instance::start().await;
    let bytes = b"0123456789abcdef".repeat(1000);
    let hash = hash_of(&bytes);

    let stored = instance.put(&bytes).await;
    assert_eq!(stored.status, StatusCode::CREATED);
    assert_eq!(stored.json()["hash"], hash.as_str());
    assert_eq!(stored.json()["size_bytes"], bytes.len());
    assert_eq!(stored.json()["mime_type"], "application/octet-stream");
    let hex = hash.strip_prefix("sha256:").unwrap();
    let placed = Path::new(&hex[0..4]).join(hex);
    assert_eq!(instance.files(), vec![placed]);

    let whole = instance.fetch(&hash).await;
    assert_eq!(whole.status, StatusCode::OK);
    assert_eq!(whole.bytes, bytes);
    assert_eq!(whole.headers[header::ACCEPT_RANGES], "bytes");
    assert_eq!(whole.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");

    let mut ranged = get(Method::GET, &format!("/blobs/{hash}"), None);
    ranged
        .headers_mut()
        .insert(header::RANGE, "bytes=10-19".parse().unwrap());
    let part = send(&instance.control, ranged).await;
    assert_eq!(part.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.bytes, bytes[10..20]);
    assert_eq!(part.headers[header::CONTENT_RANGE], "bytes 10-19/16000");

    let head = send(
        &instance.control,
        get(Method::HEAD, &format!("/blobs/{hash}"), None),
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert_eq!(head.headers[header::CONTENT_LENGTH], "16000");
    assert!(head.bytes.is_empty());
}

#[tokio::test]
async fn an_upload_dropped_half_way_leaves_nothing_behind() {
    let instance = Instance::start().await;
    let dropped = Frames {
        frames: VecDeque::from([
            Ok(vec![7u8; 64 * 1024]),
            Err(std::io::Error::other("the connection closed")),
        ]),
    };
    let reply = send(
        &instance.control,
        upload_request(None, Body::new(dropped), None),
    )
    .await;
    assert!(!reply.status.is_success(), "{}", reply.status);
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    let whole = vec![7u8; 64 * 1024];
    assert_eq!(
        instance.fetch(&hash_of(&whole)).await.code(),
        "blob_not_found"
    );
    let complete = instance.put(&whole).await;
    assert_eq!(complete.status, StatusCode::CREATED);
}

#[tokio::test]
async fn a_failed_write_answers_507_keeps_nothing_and_the_next_upload_lands() {
    let instance = Instance::start().await;
    instance
        .app
        .faults
        .set("fail:blob-write", Some("1"))
        .unwrap();
    let bytes = vec![1u8; 4096];

    let refused = instance.put(&bytes).await;
    assert_eq!(refused.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(refused.code(), "insufficient_storage");
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    let landed = instance.put(&bytes).await;
    assert_eq!(landed.status, StatusCode::CREATED);
    assert_eq!(instance.files().len(), 1);
}

#[tokio::test]
async fn a_file_with_no_record_is_never_served_and_the_next_upload_records_it() {
    let instance = Instance::start().await;
    let bytes = b"renamed into place, then the process died".to_vec();
    let hash = hash_of(&bytes);
    let hex = hash.strip_prefix("sha256:").unwrap();
    let folder = instance.folder().join(&hex[0..4]);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(hex), &bytes).unwrap();

    let unserved = instance.fetch(&hash).await;
    assert_eq!(unserved.status, StatusCode::NOT_FOUND);
    assert_eq!(unserved.code(), "blob_not_found");
    assert!(folder.join(hex).is_file());

    let recorded = instance.put(&bytes).await;
    assert_eq!(recorded.status, StatusCode::CREATED);
    assert_eq!(instance.fetch(&hash).await.bytes, bytes);
    assert_eq!(std::fs::read(folder.join(hex)).unwrap(), bytes);
}

#[tokio::test]
async fn two_uploads_of_the_same_bytes_at_once_both_answer_201_and_keep_one_file() {
    let instance = Instance::start().await;
    let bytes = vec![9u8; 3 * 1024 * 1024];
    let (first, second) = tokio::join!(instance.put(&bytes), instance.put(&bytes));
    assert_eq!(first.status, StatusCode::CREATED);
    assert_eq!(second.status, StatusCode::CREATED);
    assert_eq!(first.json()["hash"], second.json()["hash"]);
    assert_eq!(instance.files().len(), 1);
    assert_eq!(instance.fetch(&hash_of(&bytes)).await.bytes, bytes);
}

#[tokio::test]
async fn a_reader_that_stalls_is_cut_off_and_one_that_leaves_changes_nothing() {
    let instance = Instance::with(&[("MARFA_BLOB_READ_IDLE_TIMEOUT_MS", "200")]).await;
    let bytes = vec![3u8; 16 * 1024 * 1024];
    let hash = hash_of(&bytes);
    assert_eq!(instance.put(&bytes).await.status, StatusCode::CREATED);

    let response = instance
        .control
        .clone()
        .oneshot(get(Method::GET, &format!("/blobs/{hash}"), None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(to_bytes(response.into_body(), usize::MAX).await.is_err());

    let left = instance
        .control
        .clone()
        .oneshot(get(Method::GET, &format!("/blobs/{hash}"), None))
        .await
        .unwrap();
    drop(left);
    assert_eq!(instance.fetch(&hash).await.bytes, bytes);
}

#[tokio::test]
async fn an_upload_is_refused_before_its_body_is_read_in_the_order_the_contract_gives() {
    let instance = Instance::start().await;
    let unread = || {
        Body::new(Frames {
            frames: VecDeque::new(),
        })
    };

    let anonymous = send(&instance.public, upload_request(None, unread(), None)).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);

    let reader = instance
        .writer("reader", json!({ "core.note": "read" }))
        .await;
    let may_not = send(
        &instance.public,
        upload_request(Some(&reader), unread(), None),
    )
    .await;
    assert_eq!(may_not.status, StatusCode::FORBIDDEN);
    assert_eq!(may_not.code(), "type_not_permitted");

    let writer = instance
        .writer("writer", json!({ "core.note": "write" }))
        .await;
    let mut query = upload_request(Some(&writer), unread(), None);
    *query.uri_mut() = "/blobs?mime=text".parse().unwrap();
    let unknown = send(&instance.public, query).await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        unknown.json()["error"]["details"]["unknown_parameters"],
        json!(["mime"])
    );

    let multipart = send(
        &instance.public,
        upload_request(
            Some(&writer),
            Body::from("x"),
            Some("multipart/form-data; boundary=x"),
        ),
    )
    .await;
    assert_eq!(multipart.status, StatusCode::BAD_REQUEST);

    let empty = send(
        &instance.public,
        upload_request(Some(&writer), Body::empty(), None),
    )
    .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    let kept = send(
        &instance.public,
        upload_request(
            Some(&writer),
            Body::from("hello"),
            Some("Text/Plain; charset=utf-8"),
        ),
    )
    .await;
    assert_eq!(kept.status, StatusCode::CREATED);
    assert_eq!(kept.json()["mime_type"], "Text/Plain");

    let hash = hash_of(b"hello");
    let unreached = send(
        &instance.public,
        get(Method::GET, &format!("/blobs/{hash}"), Some(&writer)),
    )
    .await;
    assert_eq!(unreached.status, StatusCode::NOT_FOUND);
    assert_eq!(unreached.code(), "blob_not_found");
}
