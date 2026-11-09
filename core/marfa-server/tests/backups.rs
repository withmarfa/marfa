//! What counts as a change a backup must hold, and what an instance with no object store says
//! of backups.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::backups;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

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
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
        }
    }

    async fn send(
        &self,
        router: &Router,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path);
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

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send(&self.control, method, path, body).await
    }

    async fn changes(&self) -> i64 {
        self.app.db.read(|tx| backups::changes(tx)).await.unwrap()
    }
}

#[tokio::test]
async fn a_row_or_a_setting_moves_the_change_count_and_the_health_probe_does_not() {
    let instance = Instance::start().await;
    let start = instance.changes().await;

    let (status, body) = instance
        .send(&instance.public, Method::GET, "/health", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(instance.changes().await, start);

    let (status, minted) = instance
        .local(
            Method::POST,
            "/keys",
            Some(json!({
                "label": "writer",
                "source": "writer",
                "permissions": [],
                "type_permissions": { "core.note": "write" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{minted}");
    let key = minted["key"].as_str().unwrap();
    let after_key = instance.changes().await;
    let request = Request::builder()
        .method(Method::POST)
        .uri("/items")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "type": "core.note", "properties": { "title": "kept" } }).to_string(),
        ))
        .unwrap();
    let response = instance.public.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let after_item = instance.changes().await;
    assert!(after_item > after_key, "{after_item} after {after_key}");

    let (status, body) = instance
        .local(
            Method::PATCH,
            "/config",
            Some(json!({ "backup_interval_ms": 7_200_000 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let after_setting = instance.changes().await;
    assert!(
        after_setting > after_item,
        "{after_setting} after {after_item}"
    );

    let (status, body) = instance
        .send(&instance.public, Method::GET, "/health", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(instance.changes().await, after_setting);
}

#[tokio::test]
async fn with_no_object_store_health_says_backups_are_off_and_the_doors_refuse() {
    let instance = Instance::start().await;
    let (status, body) = instance
        .send(&instance.public, Method::GET, "/health", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "ok");
    assert_eq!(
        body["backups"],
        json!({ "status": "off", "reason": "no_bucket" })
    );

    for (method, path) in [
        (Method::GET, "/backups"),
        (Method::POST, "/backups"),
        (
            Method::POST,
            "/backups/2026-11-09T10:15:30.250Z.tar/restore",
        ),
    ] {
        let (status, body) = instance.local(method, path, None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
        assert_eq!(body["error"]["code"], "no_bucket", "{path}");
    }

    let (status, body) = instance.local(Method::GET, "/housekeeping", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let names: Vec<&str> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|job| job["name"].as_str())
        .collect();
    assert!(names.contains(&"trash-purge"), "{names:?}");
    assert!(!names.contains(&"backup"), "{names:?}");
}
