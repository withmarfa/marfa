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
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
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

/// A body that sends one frame and then waits for ever.
struct Stalling(Option<Vec<u8>>);

impl http_body::Body for Stalling {
    type Data = axum::body::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.0.take() {
            Some(data) => Poll::Ready(Some(Ok(Frame::data(data.into())))),
            None => Poll::Pending,
        }
    }
}

/// A body that sends one frame, runs `before_second` as the second is asked for, then ends.
struct Tripping {
    first: Option<Vec<u8>>,
    before_second: Option<Box<dyn FnOnce() + Send>>,
}

impl http_body::Body for Tripping {
    type Data = axum::body::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if let Some(data) = self.first.take() {
            return Poll::Ready(Some(Ok(Frame::data(data.into()))));
        }
        if let Some(trip) = self.before_second.take() {
            trip();
            return Poll::Ready(Some(Ok(Frame::data(vec![2u8; 1000].into()))));
        }
        Poll::Ready(None)
    }
}

fn closes(reply: &Reply) -> bool {
    reply
        .headers
        .get(header::CONNECTION)
        .is_some_and(|value| value == "close")
}

const RESERVE: &[(&str, &str)] = &[
    ("MARFA_DISK_RESERVE_BYTES", "1000000"),
    ("MARFA_UPLOAD_IDLE_TIMEOUT_MS", "200"),
];

#[tokio::test]
async fn an_upload_that_stops_arriving_is_ended_with_408_and_nothing_is_kept() {
    let instance = Instance::with(RESERVE).await;
    let ended = send(
        &instance.control,
        upload_request(None, Body::new(Stalling(Some(vec![1u8; 4096]))), None),
    )
    .await;
    assert_eq!(ended.status, StatusCode::REQUEST_TIMEOUT);
    assert_eq!(ended.code(), "request_timeout");
    assert!(closes(&ended));
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    let whole = instance.put(&[1u8; 4096]).await;
    assert_eq!(whole.status, StatusCode::CREATED);
    assert!(!closes(&whole));
}

#[tokio::test]
async fn an_upload_that_would_leave_less_than_the_reserve_is_refused_with_507_and_nothing_is_kept()
{
    let instance = Instance::with(RESERVE).await;
    instance
        .app
        .faults
        .set("free:blobs", Some("1500000"))
        .unwrap();

    let mut declared = upload_request(None, Body::new(Stalling(None)), None);
    declared
        .headers_mut()
        .insert(header::CONTENT_LENGTH, "600000".parse().unwrap());
    let refused = send(&instance.control, declared).await;
    assert_eq!(refused.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(refused.code(), "insufficient_storage");
    assert_eq!(
        refused.json()["error"]["details"]["reserve_bytes"],
        1_000_000
    );
    assert!(closes(&refused));
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    let faults = instance.app.faults.clone();
    let streamed = Tripping {
        first: Some(vec![1u8; 1000]),
        before_second: Some(Box::new(move || {
            faults.set("free:blobs", Some("900000")).unwrap();
        })),
    };
    let refused = send(
        &instance.control,
        upload_request(None, Body::new(streamed), None),
    )
    .await;
    assert_eq!(refused.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(refused.code(), "insufficient_storage");
    assert!(closes(&refused));
    assert_eq!(instance.files(), Vec::<PathBuf>::new());

    instance
        .app
        .faults
        .set("free:blobs", Some("1500000"))
        .unwrap();
    assert_eq!(instance.put(&[1u8; 1000]).await.status, StatusCode::CREATED);
}

/// What a client sees of one request on a real connection: the answer, and whether the
/// server then closed the connection.
async fn over_a_socket(public: &Router, request: &str, then_wait: Duration) -> (String, bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(marfa_server::http::serve(
        marfa_server::http::listening::Tcp::new(listener, "test"),
        public.clone(),
        std::future::pending(),
        Duration::from_secs(30),
    ));
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut seen = Vec::new();
    let mut buffer = [0u8; 4096];
    let closed = loop {
        match tokio::time::timeout(then_wait, stream.read(&mut buffer)).await {
            Err(_) => break false,
            Ok(Ok(0) | Err(_)) => break true,
            Ok(Ok(count)) => seen.extend_from_slice(&buffer[..count]),
        }
    };
    (String::from_utf8_lossy(&seen).to_string(), closed)
}

#[tokio::test]
async fn an_answer_to_an_upload_given_before_its_body_is_read_closes_the_connection() {
    let instance = Instance::with(RESERVE).await;
    instance
        .app
        .faults
        .set("free:blobs", Some("1500000"))
        .unwrap();
    let reader = instance
        .writer("reader", json!({ "core.note": "read" }))
        .await;
    let writer = instance
        .writer("writer", json!({ "core.note": "write" }))
        .await;
    let ahead = |token: Option<&str>, path: &str, length: u64, extra: &str| {
        let auth = token.map_or(String::new(), |t| format!("Authorization: Bearer {t}\r\n"));
        format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\n{auth}{extra}Content-Length: {length}\r\n\r\n{}",
            "x".repeat(2000)
        )
    };
    let big = 1u64 << 30;
    let cases = [
        (ahead(None, "/blobs", big, ""), "401"),
        (ahead(Some(&reader), "/blobs", big, ""), "403"),
        (ahead(Some(&writer), "/blobs?mime=text", big, ""), "400"),
        (
            ahead(
                Some(&writer),
                "/blobs",
                big,
                "Content-Type: multipart/form-data; boundary=x\r\n",
            ),
            "400",
        ),
        (ahead(Some(&writer), "/blobs", 600_000, ""), "507"),
        (ahead(Some(&writer), "/blobs", 3000, ""), "408"),
    ];
    for (request, status) in cases {
        let (answer, closed) =
            over_a_socket(&instance.public, &request, Duration::from_secs(3)).await;
        assert!(
            answer.starts_with(&format!("HTTP/1.1 {status}")),
            "{answer}"
        );
        assert!(
            answer.to_ascii_lowercase().contains("connection: close"),
            "{answer}"
        );
        assert!(closed, "the connection stayed open after {status}");
    }

    let whole = format!(
        "POST /blobs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {writer}\r\nContent-Length: 5\r\n\r\nhello"
    );
    let (answer, closed) =
        over_a_socket(&instance.public, &whole, Duration::from_millis(500)).await;
    assert!(answer.starts_with("HTTP/1.1 201"), "{answer}");
    assert!(
        !answer.to_ascii_lowercase().contains("connection: close"),
        "{answer}"
    );
    assert!(!closed);
}

#[tokio::test]
async fn a_link_is_minted_fetched_and_refused_when_altered_expired_or_over_the_cap() {
    let instance = Instance::start().await;
    let bytes = b"0123456789abcdef".to_vec();
    let hash = hash_of(&bytes);
    assert_eq!(instance.put(&bytes).await.status, StatusCode::CREATED);

    let minted = send(
        &instance.control,
        get(Method::GET, &format!("/blobs/{hash}/url?ttl=60"), None),
    )
    .await;
    assert_eq!(minted.status, StatusCode::OK);
    assert_eq!(minted.json()["expires_in"], 60);
    let url = minted.json()["url"].as_str().unwrap().to_string();
    let mut path = url[url.find("/blobs/").unwrap()..].to_string();

    let fetched = send(&instance.control, get(Method::GET, &path, None)).await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.bytes, bytes);
    let head = send(&instance.control, get(Method::HEAD, &path, None)).await;
    assert_eq!(head.status, StatusCode::OK);
    assert_eq!(head.headers[header::CONTENT_LENGTH], "16");
    assert!(head.bytes.is_empty());

    let last = path.pop().unwrap();
    let altered = format!("{path}{}", if last == '0' { '1' } else { '0' });
    path.push(last);
    let refused = send(&instance.control, get(Method::GET, &altered, None)).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);

    let capped = send(
        &instance.control,
        get(
            Method::GET,
            &format!("/blobs/{hash}/url?ttl=99999999"),
            None,
        ),
    )
    .await;
    assert_eq!(capped.json()["expires_in"], 604_800);

    instance.app.clock.advance(61_000).unwrap();
    let expired = send(&instance.control, get(Method::GET, &path, None)).await;
    assert_eq!(expired.status, StatusCode::UNAUTHORIZED);
    let expired_head = send(&instance.control, get(Method::HEAD, &path, None)).await;
    assert_eq!(expired_head.status, StatusCode::UNAUTHORIZED);
    let capped_path = {
        let url = capped.json()["url"].as_str().unwrap().to_string();
        url[url.find("/blobs/").unwrap()..].to_string()
    };
    let still = send(&instance.control, get(Method::GET, &capped_path, None)).await;
    assert_eq!(still.status, StatusCode::OK);
}

#[tokio::test]
async fn a_range_past_the_end_is_416_and_head_answers_a_range_without_a_body() {
    let instance = Instance::start().await;
    let bytes = b"0123456789abcdef".to_vec();
    let hash = hash_of(&bytes);
    assert_eq!(instance.put(&bytes).await.status, StatusCode::CREATED);
    let ranged = |method: Method, range: &str| {
        let mut request = get(method, &format!("/blobs/{hash}"), None);
        request
            .headers_mut()
            .insert(header::RANGE, range.parse().unwrap());
        request
    };

    let past = send(&instance.control, ranged(Method::GET, "bytes=100-200")).await;
    assert_eq!(past.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(past.code(), "range_not_satisfiable");
    assert_eq!(past.headers[header::CONTENT_RANGE], "bytes */16");
    assert_eq!(past.json()["error"]["details"]["size_bytes"], 16);

    let head = send(&instance.control, ranged(Method::HEAD, "bytes=2-5")).await;
    assert_eq!(head.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(head.headers[header::CONTENT_LENGTH], "4");
    assert_eq!(head.headers[header::CONTENT_RANGE], "bytes 2-5/16");
    assert!(head.bytes.is_empty());
}

#[tokio::test]
async fn every_read_door_answers_a_key_that_reaches_no_type_403_before_looking_at_the_hash() {
    let instance = Instance::start().await;
    let hash = hash_of(b"never uploaded");
    let blind = instance.writer("blind", json!({})).await;
    let sighted = instance
        .writer("sighted", json!({ "core.note": "read" }))
        .await;
    let doors = [
        (Method::GET, format!("/blobs/{hash}")),
        (Method::HEAD, format!("/blobs/{hash}")),
        (Method::GET, format!("/blobs/{hash}/url")),
        (Method::GET, format!("/blobs/{hash}/copies")),
        (Method::GET, "/blobs/not-a-hash".to_string()),
    ];
    for (method, path) in doors {
        let refused = send(&instance.public, get(method.clone(), &path, Some(&blind))).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{method} {path}");
        if method != Method::HEAD {
            assert_eq!(refused.code(), "type_not_permitted", "{method} {path}");
        }
        let looked = send(&instance.public, get(method.clone(), &path, Some(&sighted))).await;
        assert_ne!(looked.status, StatusCode::FORBIDDEN, "{method} {path}");
    }
}
