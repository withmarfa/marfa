//! How an export ends when its client stalls, and when its credential narrows while it sends.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

const IDLE_MS: u64 = 200;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    setup: String,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let idle = IDLE_MS.to_string();
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("RATE_LIMIT_ENABLED", "false"),
            ("MARFA_BLOB_READ_IDLE_TIMEOUT_MS", idle.as_str()),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
            setup: String::new(),
        };
        let (status, body) = instance
            .local(
                Method::POST,
                "/keys",
                Some(json!({
                    "label": "setup",
                    "source": "setup",
                    "permissions": ["config.manage"],
                    "type_permissions": { "*": "write" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        instance.setup = body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send(&self.control, None, method, path, body).await
    }

    async fn written(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(&self.public, Some(&self.setup), method, path, Some(body))
            .await
    }

    async fn send(
        &self,
        router: &Router,
        token: Option<&str>,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn mint(&self, permissions: Value) -> (String, String) {
        let (status, body) = self
            .local(
                Method::POST,
                "/keys",
                Some(json!({
                    "label": "exporter",
                    "source": "exporter",
                    "permissions": permissions,
                    "type_permissions": { "core.note": "read", "core.file": "read" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["id"].as_str().unwrap().to_string(),
            body["key"].as_str().unwrap().to_string(),
        )
    }

    async fn notes(&self, count: usize, body: &str) {
        for first in (0..count).step_by(100) {
            let items: Vec<Value> = (first..count.min(first + 100))
                .map(|at| {
                    json!({
                        "type": "core.note",
                        "properties": { "title": format!("note {at}"), "body": body },
                    })
                })
                .collect();
            let (status, answer) = self
                .written(
                    Method::POST,
                    "/items/bulk",
                    json!({ "atomic": false, "items": items }),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{answer}");
        }
    }

    async fn file(&self, bytes: Vec<u8>) {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.setup))
            .body(Body::from(bytes))
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let hash = serde_json::from_slice::<Value>(&bytes).unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string();
        let (status, answer) = self
            .written(
                Method::POST,
                "/items",
                json!({
                    "type": "core.file",
                    "properties": { "blob_ref": hash, "mime_type": "application/octet-stream" },
                }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{answer}");
    }

    async fn export(&self, key: &str, format: &str) -> Body {
        let request = Request::builder()
            .uri(format!("/export?format={format}"))
            .header(header::AUTHORIZATION, format!("Bearer {key}"))
            .body(Body::empty())
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body()
    }

    async fn when_held(&self) {
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(10) {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("nothing was held");
    }
}

/// Bytes nothing compresses, from a hash chain.
fn noise(size: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(size);
    let mut block = Sha256::digest(b"export").to_vec();
    while bytes.len() < size {
        block = Sha256::digest(&block).to_vec();
        bytes.extend_from_slice(&block);
    }
    bytes.truncate(size);
    bytes
}

struct Taken {
    bytes: Vec<u8>,
    failed: bool,
}

/// Takes the first frame, pauses for `pause`, and reads to the end.
async fn take(mut body: Body, pause: Duration) -> Taken {
    let mut bytes = Vec::new();
    let mut first = true;
    loop {
        match body.frame().await {
            None => {
                return Taken {
                    bytes,
                    failed: false,
                };
            }
            Some(Err(_)) => {
                return Taken {
                    bytes,
                    failed: true,
                };
            }
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    bytes.extend_from_slice(&data);
                }
            }
        }
        if first {
            first = false;
            tokio::time::sleep(pause).await;
        }
    }
}

/// Whether a tar ends in its two empty blocks.
fn tar_ends(bytes: &[u8]) -> bool {
    bytes.len() >= 1024 && bytes[bytes.len() - 1024..].iter().all(|byte| *byte == 0)
}

#[tokio::test]
async fn an_archive_whose_client_pauses_past_the_idle_limit_ends_with_an_error() {
    let instance = Instance::start().await;
    instance.notes(10, "a note").await;
    instance.file(noise(8 * 1024 * 1024)).await;
    let (_, key) = instance.mint(json!([])).await;

    let whole = take(instance.export(&key, "archive").await, Duration::ZERO).await;
    assert!(!whole.failed);
    assert!(tar_ends(&whole.bytes));

    let paused = take(
        instance.export(&key, "archive").await,
        Duration::from_millis(IDLE_MS * 5),
    )
    .await;
    assert!(paused.bytes.len() < whole.bytes.len());
    assert!(paused.failed, "a cut archive ended cleanly");
}

#[tokio::test]
async fn ndjson_whose_client_pauses_past_the_idle_limit_ends_with_an_error() {
    let instance = Instance::start().await;
    instance.notes(600, "a note").await;
    let (_, key) = instance.mint(json!([])).await;

    let whole = take(instance.export(&key, "ndjson").await, Duration::ZERO).await;
    assert!(!whole.failed);
    let lines = String::from_utf8(whole.bytes.clone()).unwrap();
    assert_eq!(lines.lines().count(), 600);

    let paused = take(
        instance.export(&key, "ndjson").await,
        Duration::from_millis(IDLE_MS * 5),
    )
    .await;
    assert!(paused.bytes.len() < whole.bytes.len());
    assert!(paused.failed, "a cut export ended cleanly");
}

/// Narrows the key to `narrowed` while the selection is read, then reads the archive.
async fn narrowed_during_selection(narrowed: Value) -> Taken {
    let instance = Arc::new(Instance::start().await);
    instance.notes(3, "a note").await;
    let (status, answer) = instance
        .written(
            Method::PATCH,
            "/config",
            json!({ "audit_retention_days": 30 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (id, key) = instance
        .mint(json!(["config.manage", "connectors.manage"]))
        .await;
    instance
        .app
        .faults
        .set("hold:export-page", Some("1"))
        .unwrap();
    let opened = {
        let instance = instance.clone();
        tokio::spawn(async move { instance.export(&key, "archive").await })
    };
    instance.when_held().await;
    let (status, answer) = instance
        .local(
            Method::PATCH,
            &format!("/keys/{id}"),
            Some(json!({ "permissions": narrowed })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    instance.app.faults.clear(Some("hold:export-page"));
    take(opened.await.unwrap(), Duration::ZERO).await
}

#[tokio::test]
async fn an_archive_whose_key_loses_the_settings_it_carries_ends_with_an_error() {
    let witness = narrowed_during_selection(json!(["config.manage"])).await;
    assert!(!witness.failed);
    assert!(tar_ends(&witness.bytes));
    let carried = b"\"setting_count\":1";
    assert!(
        witness
            .bytes
            .windows(carried.len())
            .any(|held| held == carried)
    );

    let cut = narrowed_during_selection(json!(["connectors.manage"])).await;
    assert!(
        cut.failed,
        "an archive carried settings its key no longer manages"
    );
}
