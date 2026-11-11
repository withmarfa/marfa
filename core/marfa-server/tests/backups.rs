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
use marfa_server::app::blobs::Hash;
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
    /// A key that may write and purge any item.
    writer: String,
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
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        pairs.extend_from_slice(more);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
            writer: String::new(),
        };
        let (status, minted) = instance
            .local(
                Method::POST,
                "/keys",
                Some(json!({
                    "label": "file writer",
                    "source": "file-writer",
                    "permissions": ["items.purge"],
                    "type_permissions": { "*": "write" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        instance.writer = minted["key"].as_str().unwrap().to_string();
        instance
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

    /// A file a `core.file` item names, with a copy on disk and one in the object store.
    async fn named_file(&self, words: &str) -> (String, String) {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer))
            .body(Body::from(words.repeat(64)))
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let uploaded: Value = serde_json::from_slice(&bytes).unwrap();
        let hash = uploaded["hash"].as_str().unwrap().to_string();
        let (status, made) = self
            .as_writer(
                Method::POST,
                "/items",
                Some(json!({
                    "type": "core.file",
                    "properties": { "blob_ref": hash, "mime_type": "text/plain" },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        let (status, run) = self
            .local(Method::POST, "/housekeeping/blob-replicate/run", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{run}");
        assert_eq!(run["result"]["remaining"], 0, "{run}");
        (hash, made["item"]["id"].as_str().unwrap().to_string())
    }

    /// Trashes and purges the item, so no row names its file.
    async fn unname(&self, item: &str) {
        let (status, body) = self
            .as_writer(Method::DELETE, &format!("/items/{item}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = self
            .as_writer(Method::POST, &format!("/items/{item}/purge"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    async fn as_writer(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer));
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .public
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

    async fn object_store(&self) -> String {
        let (status, body) = self.local(Method::GET, "/blobs/stores", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let stores = body["data"].as_array().unwrap();
        let s3 = stores.iter().find(|store| store["kind"] == "s3").unwrap();
        s3["id"].as_str().unwrap().to_string()
    }

    /// Asks to drop the object store's copy of `hash`.
    async fn drop_copy(&self, hash: &str) -> (StatusCode, Value) {
        let path = format!("/blobs/{hash}/copies/{}", self.object_store().await);
        self.local(Method::DELETE, &path, None).await
    }

    /// Whether a backup this instance keeps holds `hash` in its object store.
    async fn held(&self, hash: &str) -> bool {
        let store = self.app.blobs.s3().unwrap().id().to_string();
        let hash = Hash::parse(hash).unwrap();
        let asked = hash.clone();
        self.app
            .db
            .read(move |tx| backups::held(tx, &store, std::slice::from_ref(&asked)))
            .await
            .unwrap()
            .contains(&hash)
    }

    async fn count(&self, sql: &'static str) -> i64 {
        self.app
            .db
            .read(move |tx| Ok(tx.query_row(sql, [], |row| row.get::<_, i64>(0))?))
            .await
            .unwrap()
    }

    async fn back_up(&self) -> (StatusCode, Value) {
        self.local(Method::POST, "/backups", None).await
    }

    async fn when_held(&self) {
        let began = std::time::Instant::now();
        while began.elapsed() < Duration::from_secs(10) {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("nothing was held");
    }

    /// Moves the instance's clock past the time thinning keeps any backup but the newest.
    fn past_retention(&self) {
        self.app.clock.pause(true);
        self.app.clock.advance(40 * DAY_MS).unwrap();
    }
}

const DAY_MS: u64 = 24 * 3_600_000;
const BACKUPS: &str = "/marfa/backups-test/backups/";

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
async fn a_scheduled_backup_runs_when_the_last_one_was_written_at_another_archive_version() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "put");

    let outcome = || async {
        let (status, body) = instance
            .local(Method::POST, "/housekeeping/backup/run", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["result"]["outcome"].clone()
    };
    assert_eq!(outcome().await, "unchanged");

    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute("UPDATE backup_state SET backed_up_version = 0", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(outcome().await, "put");
    assert_eq!(outcome().await, "unchanged");
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

#[tokio::test]
async fn failed_attempts_stay_recorded_until_listings_omit_them_past_retention_and_an_unreachable_store_adds_none()
 {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let recorded = || instance.count("SELECT count(*) FROM backups");
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(recorded().await, 1);

    store.refuse_writes(BACKUPS);
    for attempt in 1..=4 {
        let (status, body) = instance.back_up().await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(recorded().await, 1 + attempt);
    }

    store.set_mode(Mode::AllNotFound);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(recorded().await, 5);

    store.set_mode(Mode::Normal);
    store.allow_writes();
    instance.past_retention();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1, "{body}");
    assert_eq!(recorded().await, 3);

    instance.past_retention();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(recorded().await, 1);
}

#[tokio::test]
async fn the_only_good_backup_keeps_its_files_when_one_listing_omits_it_after_a_failed_attempt() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (file, item) = instance.named_file("named only by the good backup ").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    instance.unname(&item).await;

    store.refuse_writes(BACKUPS);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");

    instance.past_retention();
    store.omit_from_listings(BACKUPS, 1);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(instance.held(&file).await);
    let (status, body) = instance.drop_copy(&file).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "copy_held_by_backup", "{body}");
}

#[tokio::test]
async fn an_attempt_whose_put_lands_after_it_failed_keeps_its_files_until_a_listing_names_it() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (file, item) = instance.named_file("named only by the late attempt ").await;

    store.late_write(BACKUPS);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(store.late_keys().len(), 1);
    instance.unname(&item).await;

    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(store.objects_under(BACKUPS).len(), 1);
    let (status, body) = instance.drop_copy(&file).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "copy_held_by_backup", "{body}");

    store.land_late_writes();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        instance
            .count("SELECT count(*) FROM backups WHERE confirmed = 0")
            .await,
        0
    );
    let (status, body) = instance.drop_copy(&file).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    instance.past_retention();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 3, "{body}");
    assert!(!instance.held(&file).await);
}

#[tokio::test]
async fn a_kept_backup_one_listing_leaves_out_keeps_its_files() {
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (file, item) = instance.named_file("named only by the first backup ").await;
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    instance.unname(&item).await;

    store.omit_from_listings(BACKUPS, 1);
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = instance.drop_copy(&file).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "copy_held_by_backup", "{body}");

    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(instance.held(&file).await);

    instance.past_retention();
    let (status, body) = instance.back_up().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 3, "{body}");
    assert!(!instance.held(&file).await);
    assert_eq!(instance.count("SELECT count(*) FROM backup_files").await, 0);
}

#[tokio::test]
async fn a_copy_dropped_while_the_backup_is_read_fails_the_backup_and_one_dropped_after_is_refused()
{
    let store = FakeS3::start().await;
    let instance = Instance::backing_up_to(&store).await;
    let (early, _) = instance.named_file("dropped before the holds ").await;
    let faults = &instance.app.faults;

    faults.set("hold:backup:read", None).unwrap();
    let control = instance.control.clone();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/backups")
        .body(Body::empty())
        .unwrap();
    let running = tokio::spawn(async move { control.oneshot(request).await.unwrap() });
    instance.when_held().await;
    let (status, body) = instance.drop_copy(&early).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    faults.clear(Some("hold:backup:read"));
    let answer = running.await.unwrap();
    let status = answer.status();
    let bytes = to_bytes(answer.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    assert!(store.objects_under(BACKUPS).is_empty());
    assert_eq!(instance.backups_health().await["status"], "failing");

    let (late, _) = instance.named_file("dropped after the holds ").await;
    faults.set("hold:backup:put", None).unwrap();
    let control = instance.control.clone();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/backups")
        .body(Body::empty())
        .unwrap();
    let running = tokio::spawn(async move { control.oneshot(request).await.unwrap() });
    instance.when_held().await;
    let (status, body) = instance.drop_copy(&late).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "copy_held_by_backup", "{body}");
    faults.clear(Some("hold:backup:put"));
    assert_eq!(running.await.unwrap().status(), StatusCode::OK);
    assert_eq!(store.objects_under(BACKUPS).len(), 1);
    assert!(instance.held(&late).await);
}
