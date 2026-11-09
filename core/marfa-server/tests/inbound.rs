use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use http_body::{Body as HttpBody, Frame};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Notify;
use tokio::time::{sleep, timeout};
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";

/// A body that sends its bytes and then waits for ever, telling `asked_again` when it is asked for a frame after them.
struct Stalled(Option<Bytes>, Option<Arc<Notify>>);

impl HttpBody for Stalled {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match self.0.take() {
            Some(bytes) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            None => {
                if let Some(asked_again) = &self.1 {
                    asked_again.notify_one();
                }
                Poll::Pending
            }
        }
    }
}

struct Instance {
    dir: TempDir,
    public: Router,
    control: Router,
    address: String,
}

async fn json_of(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Instance {
    /// An instance with one address, and the settings named in `extra`.
    async fn start(extra: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
            ("MARFA_KEY_SALT", "a salt for these tests"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let pairs: Vec<(&str, &str)> = pairs.iter().chain(extra).copied().collect();
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        let (public, control) = (public(app.clone()), control(app));
        let mut instance = Instance {
            dir,
            public,
            control,
            address: String::new(),
        };
        instance.address = instance.source("feed").await;
        instance
    }

    /// A source of its own with one address, which it answers.
    async fn source(&self, label: &str) -> String {
        let key = json!({ "label": label, "source": label, "permissions": [],
            "type_permissions": { "*": "write" } });
        let asked = Request::builder()
            .method(Method::POST)
            .uri("/keys")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(key.to_string()))
            .unwrap();
        let (status, minted) = json_of(&self.control, asked).await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        let token = minted["key"].as_str().unwrap();
        let door = |uri: &str, body: Value| {
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let (status, registered) =
            json_of(&self.public, door("/connectors", json!({ "name": label }))).await;
        assert_eq!(status, StatusCode::CREATED, "{registered}");
        let uri = format!(
            "/connectors/{}/endpoints",
            registered["id"].as_str().unwrap()
        );
        let (status, made) = json_of(&self.public, door(&uri, json!({}))).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        made["path"].as_str().unwrap().to_string()
    }

    fn post(address: &str, body: Body) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(address)
            .body(body)
            .unwrap()
    }

    fn receipt(&self, body: &'static str) -> Request<Body> {
        Self::post(&self.address, Body::from(body))
    }

    /// The status the server answers within a second, or `None` while it is still reading.
    async fn answered(&self, request: Request<Body>) -> Option<StatusCode> {
        timeout(Duration::from_secs(1), self.public.clone().oneshot(request))
            .await
            .ok()
            .map(|response| response.unwrap().status())
    }

    fn deliveries(&self) -> i64 {
        Connection::open(self.dir.path().join("marfa.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM inbound_deliveries", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

#[tokio::test]
async fn a_cancelled_receipt_keeps_its_bytes_in_flight_until_its_body_is_gone() {
    let instance = Instance::start(&[("MARFA_INBOUND_IN_FLIGHT_BYTES", "8")]).await;
    let lock = Connection::open(instance.dir.path().join("marfa.db")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();

    // The write waits on the held lock; the sender gives up and the request is cancelled.
    let cancelled = timeout(
        Duration::from_millis(300),
        instance.public.clone().oneshot(instance.receipt("abcd")),
    )
    .await;
    assert!(
        cancelled.is_err(),
        "the first receipt should still be waiting"
    );

    // Its body is still queued for the write, so its four bytes are still held.
    let second = timeout(
        Duration::from_secs(1),
        instance.public.clone().oneshot(instance.receipt("efgh")),
    )
    .await
    .expect("a second receipt was not refused while the first body waited")
    .unwrap();
    assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);

    lock.execute_batch("COMMIT").unwrap();
    for _ in 0..100 {
        if instance.deliveries() == 1 {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(instance.deliveries(), 1);

    // The body is stored and gone, so its bytes are given back.
    let third = instance
        .public
        .clone()
        .oneshot(instance.receipt("ijkl"))
        .await
        .unwrap();
    assert_eq!(third.status(), StatusCode::ACCEPTED);
    assert_eq!(instance.deliveries(), 2);
}

#[tokio::test]
async fn a_refusal_the_store_already_knows_is_given_before_the_body_is_read() {
    let instance = Instance::start(&[
        ("MARFA_INBOUND_RETAINED_DELIVERIES", "1"),
        ("MARFA_INBOUND_BACKLOG_BYTES", "4"),
        ("MARFA_INBOUND_RETAINED_BYTES", "1000"),
    ])
    .await;
    let stalled = |declared: &str| {
        let mut request = Instance::post(&instance.address, Body::new(Stalled(None, None)));
        request
            .headers_mut()
            .insert(header::CONTENT_LENGTH, declared.parse().unwrap());
        request
    };

    // The witness: with room for one more delivery and bytes, a body that never comes is waited for.
    assert_eq!(instance.answered(stalled("1")).await, None);

    let first = instance
        .public
        .clone()
        .oneshot(instance.receipt("abcd"))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::ACCEPTED);

    // The retained count is full, so the body is not read.
    assert_eq!(
        instance.answered(stalled("1")).await,
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
}

#[tokio::test]
async fn the_bytes_a_declared_length_would_add_are_refused_before_the_body_is_read() {
    let instance = Instance::start(&[("MARFA_INBOUND_BACKLOG_BYTES", "4")]).await;
    let declared = |length: &str, body: Body| {
        let mut request = Instance::post(&instance.address, body);
        request
            .headers_mut()
            .insert(header::CONTENT_LENGTH, length.parse().unwrap());
        request
    };
    let first = instance
        .public
        .clone()
        .oneshot(instance.receipt("abcd"))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::ACCEPTED);

    assert_eq!(
        instance
            .answered(declared("1", Body::new(Stalled(None, None))))
            .await,
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
    // An empty body adds no bytes, so the full backlog still takes it.
    assert_eq!(
        instance.answered(declared("0", Body::empty())).await,
        Some(StatusCode::ACCEPTED)
    );
}

#[tokio::test]
async fn headers_and_query_are_held_in_flight_before_the_body() {
    let instance = Instance::start(&[("MARFA_INBOUND_IN_FLIGHT_BYTES", "16")]).await;
    let mut request = Instance::post(&format!("{}?a=1", instance.address), Body::empty());
    request
        .headers_mut()
        .insert("x-sender", "ten-bytes!".parse().unwrap());
    // The header alone is eighteen bytes, over the eight a source may hold of sixteen.
    assert_eq!(
        instance.answered(request).await,
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );

    // The witness: the same request without the header is taken.
    let request = Instance::post(&format!("{}?a=1", instance.address), Body::empty());
    assert_eq!(instance.answered(request).await, Some(StatusCode::ACCEPTED));
}

#[tokio::test]
async fn one_source_may_hold_half_the_bytes_in_flight_and_no_more() {
    let instance = Instance::start(&[("MARFA_INBOUND_IN_FLIGHT_BYTES", "8")]).await;
    let other = instance.source("other").await;

    // The first source holds four bytes of a body that has not ended. The server asks the body for
    // another frame only after it has taken the first frame's bytes into its reservation.
    let asked_again = Arc::new(Notify::new());
    let held = {
        let router = instance.public.clone();
        let request = Instance::post(
            &instance.address,
            Body::new(Stalled(
                Some(Bytes::from("abcd")),
                Some(asked_again.clone()),
            )),
        );
        tokio::spawn(async move { router.oneshot(request).await })
    };
    timeout(Duration::from_secs(30), asked_again.notified())
        .await
        .expect("the server never asked for a frame after the first");

    assert_eq!(
        instance
            .answered(Instance::post(&instance.address, Body::from("e")))
            .await,
        Some(StatusCode::SERVICE_UNAVAILABLE)
    );
    assert_eq!(
        instance
            .answered(Instance::post(&other, Body::from("efgh")))
            .await,
        Some(StatusCode::ACCEPTED)
    );
    assert!(!held.is_finished(), "the stalled delivery was answered");
    held.abort();
}
