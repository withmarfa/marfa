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
const SLOTS: usize = 64;
const HEADROOM: usize = 8;

struct Instance {
    dir: TempDir,
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
            ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        webhooks::start(&app);
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
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
        self.minted(source, writes).await.1
    }

    /// The same key, with its ID.
    async fn minted(&self, source: &str, writes: bool) -> (String, String) {
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
        (
            answer["id"].as_str().unwrap().to_string(),
            answer["key"].as_str().unwrap().to_string(),
        )
    }

    async fn through_control(&self, method: Method, path: &str, body: Value) -> StatusCode {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.control
            .clone()
            .oneshot(request)
            .await
            .unwrap()
            .status()
    }

    /// Holds the sender at the start of a pass begun after this call. A pass already under way
    /// takes in every item committed before its own write, so an item can end without waking
    /// the sender; another item written once that pass is over does.
    async fn sender_parked(&self, writer: &str) {
        self.app.faults.set("hold:webhook-schedule", None).unwrap();
        let began = Instant::now();
        let mut written = Instant::now();
        announce(self, writer).await;
        while !self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
            assert!(
                began.elapsed() < Duration::from_secs(5),
                "the sender did not begin another pass"
            );
            if written.elapsed() >= Duration::from_millis(250) {
                announce(self, writer).await;
                written = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn sender_released(&self) {
        self.app.faults.clear(Some("hold:webhook-schedule"));
    }

    /// The status of the one delivery to `webhook`, and how many attempts it has had.
    fn recorded(&self, webhook: &str) -> (String, i64) {
        let db = rusqlite::Connection::open_with_flags(
            self.dir.path().join("marfa.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        db.query_row(
            "SELECT status, attempt FROM webhook_deliveries WHERE webhook_id = ?1",
            [webhook],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
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

/// Answers every delivery `200`, after reading it or, with `first`, as soon as it accepts the
/// connection. Counts each connection that sent any byte at all, a header alone included.
async fn counting_any_byte(first: bool) -> (String, Arc<AtomicUsize>) {
    const OK: &[u8] = b"HTTP/1.1 200 X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    let seen = Arc::new(AtomicUsize::new(0));
    let counted = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let counted = counted.clone();
            tokio::spawn(async move {
                if first && stream.write_all(OK).await.is_err() {
                    return;
                }
                let mut read = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(size) = stream.read(&mut chunk).await else {
                        return;
                    };
                    if size == 0 {
                        return;
                    }
                    if read.is_empty() {
                        counted.fetch_add(1, Ordering::SeqCst);
                    }
                    read.extend_from_slice(&chunk[..size]);
                    if complete(&read) {
                        break;
                    }
                }
                if !first {
                    let _ = stream.write_all(OK).await;
                }
            });
        }
    });
    (url, seen)
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

#[tokio::test]
async fn a_maker_alone_leaves_slots_free_for_a_maker_whose_delivery_falls_due_later() {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let slow = instance.key("slow-maker", false).await;
    let later = instance.key("later-maker", false).await;
    let (stalled, accepted) = stalling().await;
    let (answered, received) = answering().await;
    for _ in 0..SLOTS + 6 {
        let (status, made) = instance.register(&slow, &stalled).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
    }

    announce(&instance, &writer).await;
    until(
        "the first maker did not reach its attempts",
        Duration::from_secs(5),
        || accepted.load(Ordering::SeqCst) >= SLOTS - HEADROOM,
    )
    .await;
    let (status, made) = instance.register(&later, &answered).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    announce(&instance, &writer).await;
    until(
        "the later maker's delivery waited for a stalled attempt to end",
        Duration::from_secs(5),
        || received.load(Ordering::SeqCst) == 1,
    )
    .await;
    for _ in 0..2 {
        instance.sender_parked(&writer).await;
        instance.sender_released();
    }
    instance.sender_parked(&writer).await;
    assert_eq!(accepted.load(Ordering::SeqCst), SLOTS - HEADROOM);
    instance.sender_released();
}

/// Where a delivery is held while its key changes.
#[derive(Clone, Copy)]
enum Held {
    /// While the receiver's name is looked up.
    Lookup,
    /// Once the connection is ready, before the key is read again and the request sent.
    Connected,
}

/// What reached each receiver, and the status recorded for the delivery whose key changed.
struct Seen {
    changed: usize,
    standing: usize,
    recorded: String,
}

async fn deliveries_during(held: Held, change: impl AsyncFnOnce(&Instance, &str)) -> Seen {
    deliveries_answered_during(held, false, change).await
}

async fn deliveries_answered_during(
    held: Held,
    answers_first: bool,
    change: impl AsyncFnOnce(&Instance, &str),
) -> Seen {
    let instance = Instance::start().await;
    let writer = instance.key("writer", true).await;
    let (changed_id, changed) = instance.minted("changed-maker", false).await;
    let standing = instance.key("standing-maker", false).await;
    let (to_changed, changed_received) = counting_any_byte(answers_first).await;
    let (to_standing, standing_received) = answering().await;
    let by_name = |url: &str| url.replace("127.0.0.1", "localhost");
    let mut hooks = Vec::new();
    for (key, url) in [(&changed, &to_changed), (&standing, &to_standing)] {
        let (status, made) = instance.register(key, &by_name(url)).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        hooks.push(made["id"].as_str().unwrap().to_string());
    }
    match held {
        Held::Lookup => instance
            .app
            .faults
            .set("resolve:localhost", Some("stall:1500"))
            .unwrap(),
        Held::Connected => instance
            .app
            .faults
            .set("hold:webhook:connected", None)
            .unwrap(),
    }

    announce(&instance, &writer).await;
    until(
        "both deliveries did not wait",
        Duration::from_secs(5),
        || {
            instance.app.faults.list().iter().any(|fault| match held {
                Held::Lookup => fault.name == "resolve:localhost" && fault.fired >= 2,
                Held::Connected => fault.name == "hold:webhook:connected" && fault.waiting >= 2,
            })
        },
    )
    .await;
    change(&instance, &changed_id).await;
    instance.app.faults.clear(Some("hold:webhook:connected"));
    until(
        "the standing maker's delivery did not arrive",
        Duration::from_secs(10),
        || standing_received.load(Ordering::SeqCst) == 1,
    )
    .await;
    let changed_hook = hooks[0].clone();
    until(
        "the changed maker's delivery was not settled",
        Duration::from_secs(10),
        || {
            let (status, attempts) = instance.recorded(&changed_hook);
            status != "pending" || attempts >= 1
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    Seen {
        changed: changed_received.load(Ordering::SeqCst),
        standing: standing_received.load(Ordering::SeqCst),
        recorded: instance.recorded(&changed_hook).0,
    }
}

async fn revoke(instance: &Instance, id: &str) {
    let status = instance
        .through_control(Method::DELETE, &format!("/keys/{id}"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
}

async fn narrow(instance: &Instance, id: &str) {
    let status = instance
        .through_control(
            Method::PATCH,
            &format!("/keys/{id}"),
            json!({ "permissions": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

fn delivered(seen: &Seen) {
    assert_eq!((seen.changed, seen.standing), (1, 1));
    assert_eq!(seen.recorded, "succeeded");
}

fn canceled_unsent(seen: &Seen) {
    assert_eq!((seen.changed, seen.standing), (0, 1));
    assert_eq!(seen.recorded, "canceled");
}

#[tokio::test]
async fn a_delivery_goes_out_when_its_key_stands_through_the_lookup_of_the_receivers_name() {
    delivered(&deliveries_during(Held::Lookup, async |_, _| {}).await);
}

#[tokio::test]
async fn no_delivery_goes_out_when_its_key_is_revoked_during_the_lookup_of_the_receivers_name() {
    canceled_unsent(&deliveries_during(Held::Lookup, revoke).await);
}

#[tokio::test]
async fn no_delivery_goes_out_when_its_key_loses_webhooks_manage_during_the_lookup_of_the_receivers_name()
 {
    canceled_unsent(&deliveries_during(Held::Lookup, narrow).await);
}

#[tokio::test]
async fn a_delivery_goes_out_when_its_key_stands_while_its_connection_is_ready() {
    delivered(&deliveries_during(Held::Connected, async |_, _| {}).await);
}

#[tokio::test]
async fn nothing_is_sent_when_its_key_is_revoked_while_its_connection_is_ready() {
    canceled_unsent(&deliveries_during(Held::Connected, revoke).await);
}

#[tokio::test]
async fn nothing_is_sent_when_its_key_loses_webhooks_manage_while_its_connection_is_ready() {
    canceled_unsent(&deliveries_during(Held::Connected, narrow).await);
}

#[tokio::test]
async fn a_receiver_that_answers_before_it_is_sent_anything_is_not_recorded_as_delivered() {
    let seen = deliveries_answered_during(Held::Connected, true, async |_, _| {}).await;
    assert_eq!((seen.changed, seen.standing), (0, 1));
    assert_eq!(seen.recorded, "pending", "left due for another attempt");
}

#[tokio::test]
async fn a_receiver_that_answers_before_it_is_sent_anything_has_a_revoked_keys_delivery_canceled() {
    canceled_unsent(&deliveries_answered_during(Held::Connected, true, revoke).await);
}
