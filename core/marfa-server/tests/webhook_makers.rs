use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::{App, webhooks};
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

const CAP: usize = 100;
const SHARE: usize = 8;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
            ("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        webhooks::start(&app);
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
        }
    }

    async fn send(
        &self,
        bearer: &str,
        method: Method,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// A key that registers webhooks and reads every type, or one that writes items.
    async fn key(&self, source: &str, writes: bool) -> String {
        let permissions = if writes {
            json!(["webhooks.manage", "schema.write"])
        } else {
            json!(["webhooks.manage"])
        };
        let body = json!({
            "label": source,
            "source": source,
            "permissions": permissions,
            "type_permissions": { "*": if writes { "write" } else { "read" } },
            "edge_permissions": { "*": "read" },
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/keys")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.control.clone().oneshot(request).await.unwrap();
        assert!(response.status().is_success(), "{}", response.status());
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        answer["key"].as_str().unwrap().to_string()
    }

    /// Holds the sender at the start of its next pass, which an item written now begins.
    async fn sender_parked(&self, writer: &str) {
        self.app.faults.set("hold:webhook-schedule", None).unwrap();
        announce(self, writer).await;
        until(
            "the sender did not begin another pass",
            Duration::from_secs(5),
            || self.app.faults.list().iter().any(|fault| fault.waiting > 0),
        )
        .await;
    }

    fn sender_released(&self) {
        self.app.faults.clear(Some("hold:webhook-schedule"));
    }

    async fn register(&self, key: &str, url: &str) -> (StatusCode, Value) {
        let body = json!({ "url": url, "events": ["item.created"] });
        self.send(key, Method::POST, "/webhooks", body).await
    }
}

/// Accepts connections and never answers; counts those it has accepted.
async fn stalling() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    let accepted = Arc::new(AtomicUsize::new(0));
    let counted = accepted.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
            counted.fetch_add(1, Ordering::SeqCst);
        }
    });
    (url, accepted)
}

/// Answers every delivery `200`; counts those it has read in full.
async fn answering() -> (String, Arc<AtomicUsize>) {
    replying(200).await
}

/// Answers the first delivery with `first` and every later one `200`; counts those it has read in full.
async fn replying(first: u16) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    let received = Arc::new(AtomicUsize::new(0));
    let counted = received.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let counted = counted.clone();
            tokio::spawn(async move {
                let mut read = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(size) = stream.read(&mut chunk).await else {
                        return;
                    };
                    if size == 0 {
                        return;
                    }
                    read.extend_from_slice(&chunk[..size]);
                    if complete(&read) {
                        break;
                    }
                }
                let status = if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    first
                } else {
                    200
                };
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    (url, received)
}

fn complete(read: &[u8]) -> bool {
    let text = String::from_utf8_lossy(read);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(str::to_string)
        })
        .and_then(|length| length.trim().parse::<usize>().ok())
        .unwrap_or(0);
    body.len() >= length
}

#[tokio::test]
async fn a_maker_holds_at_most_one_hundred_webhooks_and_a_deleted_one_frees_a_place() {
    let instance = Instance::start().await;
    let first = instance.key("first-maker", false).await;
    let second = instance.key("second-maker", false).await;
    let url = "http://127.0.0.1:9/hook";
    let mut ids = Vec::new();
    for _ in 0..CAP {
        let (status, made) = instance.register(&first, url).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        ids.push(made["id"].as_str().unwrap().to_string());
    }

    let (status, refused) = instance.register(&first, url).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "conflict");
    assert_eq!(refused["error"]["details"]["reason"], "webhook_cap");
    assert_eq!(refused["error"]["details"]["cap"], CAP);
    let (_, listed) = instance
        .send(&first, Method::GET, "/webhooks", Value::Null)
        .await;
    assert_eq!(listed["data"].as_array().unwrap().len(), CAP);

    let (status, made) = instance.register(&second, url).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "another maker's place is its own: {made}"
    );

    let path = format!("/webhooks/{}", ids[0]);
    let (status, _) = instance
        .send(&first, Method::DELETE, &path, Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, made) = instance.register(&first, url).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let (status, _) = instance.register(&first, url).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

async fn announce(instance: &Instance, writer: &str) {
    let note = json!({ "type": "core.note", "properties": { "body": "announced" } });
    let (status, made) = instance.send(writer, Method::POST, "/items", note).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
}

async fn until(what: &str, bound: Duration, holds: impl Fn() -> bool) {
    let began = Instant::now();
    while !holds() {
        assert!(began.elapsed() < bound, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_stalled_receiver_delays_no_other_makers_delivery() {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let slow = instance.key("slow-maker", false).await;
    let other = instance.key("other-maker", false).await;
    let (stalled, _) = stalling().await;
    let (answered, received) = answering().await;
    for _ in 0..70 {
        let (status, made) = instance.register(&slow, &stalled).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
    }
    let (status, made) = instance.register(&other, &answered).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");

    announce(&instance, &writer).await;
    until(
        "the second maker's delivery waited behind the first maker's stalled receiver",
        Duration::from_secs(5),
        || received.load(Ordering::SeqCst) > 0,
    )
    .await;
}

#[tokio::test]
async fn a_maker_holds_at_most_its_share_of_attempts_while_another_makers_delivery_is_due() {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let slow = instance.key("slow-maker", false).await;
    let other = instance.key("other-maker", false).await;
    let (stalled, accepted) = stalling().await;
    let (also_stalled, also_accepted) = stalling().await;
    for _ in 0..70 {
        let (status, made) = instance.register(&slow, &stalled).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
    }
    let (status, made) = instance.register(&other, &also_stalled).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");

    announce(&instance, &writer).await;
    until(
        "the second maker's delivery was not attempted",
        Duration::from_secs(5),
        || also_accepted.load(Ordering::SeqCst) == 1 && accepted.load(Ordering::SeqCst) == SHARE,
    )
    .await;
    // Each pass the sender begins has finished the one before it, fill included.
    for _ in 0..2 {
        instance.sender_parked(&writer).await;
        instance.sender_released();
    }
    instance.sender_parked(&writer).await;
    assert_eq!(accepted.load(Ordering::SeqCst), SHARE);
    assert_eq!(also_accepted.load(Ordering::SeqCst), 1);
    instance.sender_released();
}

#[tokio::test]
async fn a_maker_no_other_maker_waits_behind_attempts_past_its_share() {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let slow = instance.key("slow-maker", false).await;
    let (stalled, accepted) = stalling().await;
    for _ in 0..SHARE + 4 {
        let (status, made) = instance.register(&slow, &stalled).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
    }

    announce(&instance, &writer).await;
    until(
        "the maker's attempts stopped at its share",
        Duration::from_secs(5),
        || accepted.load(Ordering::SeqCst) == SHARE + 4,
    )
    .await;
}

#[tokio::test]
async fn a_maker_no_other_maker_waits_behind_is_retried_at_its_due_time_while_its_attempts_stall() {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let slow = instance.key("slow-maker", false).await;
    let (stalled, accepted) = stalling().await;
    let (retrying, received) = replying(503).await;
    for _ in 0..SHARE {
        let (status, made) = instance.register(&slow, &stalled).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
    }
    let (status, made) = instance.register(&slow, &retrying).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");

    announce(&instance, &writer).await;
    until(
        "the maker's attempts did not all start",
        Duration::from_secs(5),
        || accepted.load(Ordering::SeqCst) == SHARE && received.load(Ordering::SeqCst) == 1,
    )
    .await;
    until(
        "the retry waited for a stalled attempt to end",
        Duration::from_secs(5),
        || received.load(Ordering::SeqCst) == 2,
    )
    .await;
}
