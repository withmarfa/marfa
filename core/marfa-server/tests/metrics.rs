use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    public: Router,
    control: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

fn request(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
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
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = marfa_server::app::App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            public: public(app.clone()),
            control: control(app.clone()),
        }
    }

    async fn key(&self, permissions: &[&str]) -> (String, String) {
        let source = permissions.join("-");
        let body = json!({ "label": source, "source": source, "permissions": permissions });
        let minted = send(
            &self.control,
            request(Method::POST, "/keys", None, Some(body)),
        )
        .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        (
            minted.body["id"].as_str().unwrap().to_string(),
            minted.body["key"].as_str().unwrap().to_string(),
        )
    }

    async fn metrics(&self, token: &str) -> Reply {
        send(
            &self.public,
            request(Method::GET, "/metrics", Some(token), None),
        )
        .await
    }
}

fn keys_of(value: &Value) -> Vec<&str> {
    let mut names: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    names
}

#[tokio::test]
async fn a_reader_is_told_what_the_instance_holds_as_it_stands() {
    let instance = Instance::start().await;
    let (_, reader) = instance.key(&["instance.read"]).await;
    let first = instance.metrics(&reader).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(
        keys_of(&first.body),
        [
            "blobs",
            "items",
            "keys",
            "process",
            "storage",
            "types",
            "uptime_seconds",
            "webhooks"
        ]
    );
    assert_eq!(
        keys_of(&first.body["process"]),
        [
            "cpu_system_seconds",
            "cpu_user_seconds",
            "memory_rss_bytes",
            "memory_rss_peak_bytes",
            "release"
        ]
    );
    assert_eq!(
        keys_of(&first.body["storage"]),
        ["database_bytes", "rows", "wal_bytes"]
    );
    assert_eq!(
        keys_of(&first.body["storage"]["rows"]),
        ["audit_log", "event_log", "items", "versions"]
    );
    assert!(first.body["types"]["core"].as_i64().unwrap() > 0);
    assert!(first.body["process"]["memory_rss_bytes"].as_u64().unwrap() > 0);
    assert!(first.body["storage"]["database_bytes"].as_u64().unwrap() > 0);
    let before = first.body["keys"]["total"].as_i64().unwrap();
    let audited = first.body["storage"]["rows"]["audit_log"].as_i64().unwrap();

    let (id, _) = instance.key(&["keys.manage"]).await;
    let after = instance.metrics(&reader).await;
    assert_eq!(after.body["keys"]["total"], before + 1);
    assert!(after.body["storage"]["rows"]["audit_log"].as_i64().unwrap() > audited);

    let revoked = send(
        &instance.control,
        request(Method::DELETE, &format!("/keys/{id}"), None, None),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
    assert_eq!(
        instance.metrics(&reader).await.body["keys"]["total"],
        before
    );
}

#[tokio::test]
async fn a_key_without_instance_read_is_refused() {
    let instance = Instance::start().await;
    let (_, plain) = instance.key(&["keys.mint"]).await;
    let refused = instance.metrics(&plain).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.body["error"]["code"], "forbidden");
}
