use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::{sleep, timeout};
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";

struct Instance {
    dir: TempDir,
    public: Router,
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
    /// An instance that holds four bytes of inbound bodies in flight, with one address.
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_AUTH_BASE_URL", ORIGIN),
            ("API_KEY_SALT", "a salt for these tests"),
            ("RATE_LIMIT_ENABLED", "false"),
            ("MARFA_INBOUND_IN_FLIGHT_BYTES", "4"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        let (public, control) = (public(app.clone()), control(app));
        let key = json!({ "label": "feed", "source": "feed", "permissions": [],
            "type_permissions": { "*": "write" } });
        let asked = Request::builder()
            .method(Method::POST)
            .uri("/keys")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(key.to_string()))
            .unwrap();
        let (status, minted) = json_of(&control, asked).await;
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
            json_of(&public, door("/connectors", json!({ "name": "feed" }))).await;
        assert_eq!(status, StatusCode::CREATED, "{registered}");
        let uri = format!(
            "/connectors/{}/endpoints",
            registered["id"].as_str().unwrap()
        );
        let (status, made) = json_of(&public, door(&uri, json!({}))).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        Instance {
            dir,
            public,
            address: made["path"].as_str().unwrap().to_string(),
        }
    }

    fn receipt(&self, body: &'static str) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(&self.address)
            .body(Body::from(body))
            .unwrap()
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
    let instance = Instance::start().await;
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
