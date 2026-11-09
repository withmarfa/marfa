//! What counts as a change a backup must hold, what an instance with no object store says of
//! backups, and how a backup meets an object store that fails or runs out of time.

#[allow(dead_code)]
mod fake_s3;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use bytes::Bytes;
use fake_s3::{FakeS3, Mode};
use futures_util::StreamExt;
use marfa_server::app::App;
use marfa_server::app::backups;
use marfa_server::db::Write;
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
        Instance::start_with(&[]).await
    }

    /// An instance backing up to `store`, with the schedule a year apart.
    async fn backing_up_to(store: &FakeS3) -> Instance {
        let mut more = store.settings("marfa", "backups-test");
        more.push((
            "MARFA_BACKUP_INTERVAL_MS".to_string(),
            "31536000000".to_string(),
        ));
        let more: Vec<(&str, &str)> = more
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        Instance::start_with(&more).await
    }

    async fn start_with(more: &[(&str, &str)]) -> Instance {
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
        self.app.db.read(backups::changes).await.unwrap()
    }

    async fn backups_health(&self) -> Value {
        let (status, body) = self.local(Method::GET, "/health", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["backups"].clone()
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
            "/backups/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/2026-11-09T10:15:30.250Z.tar/restore",
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

#[tokio::test]
async fn a_scheduled_backup_runs_after_a_failed_one_when_nothing_has_changed() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (status, body) = instance.local(Method::POST, "/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "put");

    store.set_mode(Mode::AllNotFound);
    let (status, body) = instance.local(Method::POST, "/backups", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(instance.backups_health().await["status"], "failing");

    store.set_mode(Mode::Normal);
    let (status, body) = instance
        .local(Method::POST, "/housekeeping/backup/run", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["outcome"], "put", "{body}");
    let health = instance.backups_health().await;
    assert_eq!(health["status"], "ok", "{health}");
    assert_eq!(health["failures"], 0, "{health}");
}

#[tokio::test]
async fn health_says_backups_are_failing_when_their_state_does_not_read() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    assert_eq!(instance.backups_health().await["status"], "ok");

    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute_batch("ALTER TABLE backup_state RENAME TO backup_state_gone")?;
            Ok(())
        })
        .await
        .unwrap();
    let (status, body) = instance
        .send(&instance.public, Method::GET, "/health", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["backups"], json!({ "status": "failing" }), "{body}");
    assert_ne!(body["status"], "ok", "{body}");
}

#[tokio::test]
async fn a_put_that_runs_out_of_time_aborts_its_multipart_upload() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let bucket = instance.app.blobs.s3().unwrap();
    let part = Bytes::from(vec![7u8; 9 * 1024 * 1024]);
    let stalls = futures_util::stream::once(async move { Ok(part) })
        .chain(futures_util::stream::pending())
        .boxed();

    let put = bucket.put_whole(
        "backups/stalled.tar",
        "application/x-tar",
        stalls,
        Duration::from_secs(2),
    );
    let error = put.await.unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
    assert_eq!(store.unfinished_uploads(), Vec::<String>::new());
    assert!(
        store
            .objects_under("/marfa/backups-test/backups/")
            .is_empty()
    );

    let part = Bytes::from(vec![7u8; 9 * 1024 * 1024]);
    let ends = futures_util::stream::once(async move { Ok(part) }).boxed();
    let put = bucket.put_whole(
        "backups/whole.tar",
        "application/x-tar",
        ends,
        Duration::from_secs(30),
    );
    assert_eq!(put.await.unwrap(), 9 * 1024 * 1024);
    assert_eq!(
        store
            .object("/marfa/backups-test/backups/whole.tar")
            .map(|bytes| bytes.len()),
        Some(9 * 1024 * 1024)
    );
}
