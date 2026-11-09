//! Every copy of a blob kept safe on the disk store: what start refuses, what the jobs strike
//! and purge, and what the drop door refuses, with an object store beside it where a test
//! says so.

#[allow(dead_code)]
mod fake_s3;
mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use futures_util::StreamExt;
use marfa_server::app::{App, housekeeping};
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::registry::{
    BLOB_CLEANUP_GRACE_MS, BLOB_CLEANUP_INTERVAL_MS, BLOB_MIN_COPIES,
};
use marfa_server::settings::{Accepted, Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

use fake_s3::{FakeS3, Mode};
use support::{commit_unpublished, remove_unpublished};

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    writer: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    bytes: Vec<u8>,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

fn settings(dir: &Path, more: &[(&str, &str)]) -> Accepted {
    let database = dir.join("marfa.db");
    let blobs = dir.join("blobs");
    let socket = dir.join("s.sock");
    let mut pairs = vec![
        ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
        ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_RATE_LIMIT_ENABLED", "false"),
    ];
    pairs.extend_from_slice(more);
    Settings::read(Environment::from_pairs(&pairs)).unwrap()
}

fn hash_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap_or_default()
        .to_vec();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        bytes,
    }
}

fn pairs(owned: &[(String, String)]) -> Vec<(&str, &str)> {
    owned
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect()
}

/// An endpoint nothing listens on.
async fn closed_endpoint() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    endpoint
}

impl Instance {
    async fn start(more: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let app = App::start(settings(dir.path(), more)).await.unwrap();
        app.clock.pause(true);
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
            writer: String::new(),
        };
        let body = json!({
            "label": "writer",
            "source": "writer",
            "permissions": [],
            "type_permissions": { "*": "write" },
        });
        let minted = instance.call(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED);
        instance.writer = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let request = Request::builder().method(method).uri(path);
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        send(&self.control, request.unwrap()).await
    }

    async fn put(&self, bytes: &[u8]) -> Reply {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        send(&self.control, request).await
    }

    async fn stored(&self, bytes: &[u8]) -> String {
        let stored = self.put(bytes).await;
        assert_eq!(stored.status, StatusCode::CREATED, "{}", stored.body);
        hash_of(bytes)
    }

    async fn fetch(&self, hash: &str) -> Reply {
        self.call(Method::GET, &format!("/blobs/{hash}"), None)
            .await
    }

    async fn note(&self, body: &str) {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/items")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.writer))
            .body(Body::from(
                json!({ "type": "core.note", "properties": { "body": body } }).to_string(),
            ))
            .unwrap();
        let made = send(&self.public, request).await;
        assert!(made.status.is_success(), "{} {}", made.status, made.body);
    }

    async fn run(&self, job: &str) -> Value {
        let run = self
            .call(
                Method::POST,
                &format!("/housekeeping/{job}/run"),
                Some(json!({})),
            )
            .await;
        assert_eq!(run.body["outcome"], "ok", "{}", run.body);
        run.body["result"].clone()
    }

    async fn inspect(&self, hash: &str) -> Reply {
        let path = format!("/_control/test/blob-stores?hash={hash}");
        self.call(Method::GET, &path, None).await
    }

    async fn copies(&self, hash: &str) -> Vec<Value> {
        let listed = self
            .call(Method::GET, &format!("/blobs/{hash}/copies"), None)
            .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["data"].as_array().unwrap().clone()
    }

    async fn disk(&self) -> String {
        let listed = self.call(Method::GET, "/blobs/stores", None).await;
        let stores = listed.body["data"].as_array().unwrap();
        let disk = stores.iter().find(|store| store["kind"] == "disk").unwrap();
        disk["id"].as_str().unwrap().to_string()
    }

    fn folder(&self) -> PathBuf {
        self.dir.path().join("blobs")
    }

    fn file(&self, hash: &str) -> PathBuf {
        let hex = hash.strip_prefix("sha256:").unwrap();
        self.folder().join(&hex[0..4]).join(hex)
    }

    fn count(&self, sql: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn arm(&self, fault: &str, arg: Option<&str>) {
        self.app.faults.set(fault, arg).unwrap();
    }

    async fn when_held(&self) {
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(4) {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("nothing was held");
    }
}

#[tokio::test]
async fn start_over_a_missing_or_unmarked_folder_with_recorded_copies_is_refused_and_makes_nothing()
{
    let instance = Instance::start(&[]).await;
    instance.stored(b"a copy the record names").await;
    let folder = instance.folder();
    let marker = folder.join(".marfa-store");

    std::fs::remove_file(&marker).unwrap();
    let refused = App::start(settings(instance.dir.path(), &[])).await;
    let message = refused.err().map(|failure| failure.to_string()).unwrap();
    assert!(message.contains(folder.to_str().unwrap()), "{message}");
    assert!(!marker.exists());

    std::fs::remove_dir_all(&folder).unwrap();
    let refused = App::start(settings(instance.dir.path(), &[])).await;
    let message = refused.err().map(|failure| failure.to_string()).unwrap();
    assert!(message.contains(folder.to_str().unwrap()), "{message}");
    assert!(!folder.exists());
}

#[tokio::test]
async fn start_over_a_missing_folder_with_no_recorded_copies_makes_a_fresh_store() {
    let instance = Instance::start(&[]).await;
    std::fs::remove_dir_all(instance.folder()).unwrap();
    let again = App::start(settings(instance.dir.path(), &[])).await;
    assert!(again.is_ok());
    assert!(instance.folder().join(".marfa-store").is_file());
}

#[tokio::test]
async fn the_drop_door_refuses_in_order_and_never_leaves_fewer_than_min_copies() {
    let instance = Instance::start(&[]).await;
    let hash = instance.stored(b"the only copy").await;
    let disk = instance.disk().await;
    let missing = hash_of(b"never stored");
    let door = |hash: &str, store: &str| format!("/blobs/{hash}/copies/{store}");

    let malformed = instance
        .call(Method::DELETE, &door("sha256:xyz", "nowhere"), None)
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);

    let queried = instance
        .call(
            Method::DELETE,
            &format!("{}?force=1", door(&hash, &disk)),
            None,
        )
        .await;
    assert_eq!(queried.status, StatusCode::BAD_REQUEST);

    let unknown = instance
        .call(Method::DELETE, &door(&missing, &disk), None)
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.code(), "blob_not_found");

    let elsewhere = instance
        .call(Method::DELETE, &door(&hash, "nowhere"), None)
        .await;
    assert_eq!(elsewhere.status, StatusCode::NOT_FOUND);
    assert_eq!(elsewhere.code(), "blob_copy_not_found");

    let last = instance
        .call(Method::DELETE, &door(&hash, &disk), None)
        .await;
    assert_eq!(last.status, StatusCode::CONFLICT);
    assert_eq!(last.code(), "copies_below_minimum");
    assert_eq!(last.body["error"]["details"]["live"], 1);
    assert_eq!(last.body["error"]["details"]["min_copies"], 1);

    assert!(instance.file(&hash).is_file());
    assert_eq!(instance.copies(&hash).await.len(), 1);
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn integrity_strikes_an_altered_copy_and_a_deleted_one_and_keeps_an_intact_one() {
    let instance = Instance::start(&[]).await;
    let altered = instance.stored(b"altered on disk").await;
    let deleted = instance.stored(b"deleted from disk").await;
    let intact = instance.stored(b"left alone").await;
    std::fs::write(instance.file(&altered), b"altered on disk!").unwrap();
    std::fs::remove_file(instance.file(&deleted)).unwrap();

    let result = instance.run("blob-integrity").await;
    assert_eq!(result["verified"], 1, "{result}");
    assert_eq!(result["struck"], 2, "{result}");
    assert_eq!(result["unreachable"], 0, "{result}");

    assert!(instance.copies(&altered).await.is_empty());
    assert!(instance.copies(&deleted).await.is_empty());
    let kept = instance.copies(&intact).await;
    assert!(kept[0]["verified_at"].is_string());
    assert!(!instance.file(&altered).exists());
    assert!(instance.file(&intact).is_file());
    assert_eq!(
        instance.count(
            "SELECT count(*) FROM audit_log WHERE action = 'blob.copy_struck' \
             AND json_extract(details, '$.kind') = 'disk'"
        ),
        2
    );
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
    assert_eq!(instance.fetch(&altered).await.status, StatusCode::NOT_FOUND);
    assert_eq!(instance.fetch(&intact).await.bytes, b"left alone");
}

#[tokio::test]
async fn a_blob_fault_changes_what_the_disk_reads_and_never_what_it_holds() {
    let instance = Instance::start(&[]).await;
    let lost = instance.stored(b"read as absent").await;
    let damaged = instance.stored(b"read with a changed first byte").await;
    instance.arm("lose:blob", Some(&lost));
    instance.arm("damage:blob", Some(&damaged));

    for hash in [&lost, &damaged] {
        let seen = instance.inspect(hash).await;
        assert_eq!(seen.status, StatusCode::OK, "{}", seen.body);
        assert_eq!(seen.body["stores"][0]["kind"], "disk");
        assert_eq!(seen.body["stores"][0]["holds"], true);
        assert_eq!(seen.body["stores"][0]["intact"], true);
        assert_eq!(seen.body["spool"], json!([]));
    }
    let read = instance.fetch(&damaged).await;
    assert_eq!(read.bytes.len(), 30);
    assert_eq!(read.bytes[0], b'r' ^ 0xff);
    assert_eq!(&read.bytes[1..], &b"read with a changed first byte"[1..]);

    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 2, "{result}");
    for hash in [&lost, &damaged] {
        assert!(instance.copies(hash).await.is_empty());
        assert_eq!(
            instance.inspect(hash).await.body["stores"][0]["holds"],
            false
        );
    }
    let bare = instance
        .inspect(lost.strip_prefix("sha256:").unwrap())
        .await;
    assert_eq!(bare.status, StatusCode::BAD_REQUEST);
    assert_eq!(bare.code(), "validation_error");
}

#[tokio::test]
async fn a_folder_gone_while_running_is_unreachable_strikes_nothing_and_reads_answer_503() {
    let instance = Instance::start(&[]).await;
    let hash = instance.stored(b"kept while the folder is away").await;
    let away = instance.dir.path().join("away");
    std::fs::rename(instance.folder(), &away).unwrap();

    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 0, "{result}");
    assert_eq!(result["unreachable"], 1, "{result}");
    assert_eq!(instance.copies(&hash).await.len(), 1);

    let read = instance.fetch(&hash).await;
    assert_eq!(read.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(read.code(), "blob_store_unavailable");

    std::fs::rename(&away, instance.folder()).unwrap();
    assert_eq!(
        instance.fetch(&hash).await.bytes,
        b"kept while the folder is away"
    );
}

#[tokio::test]
async fn a_blob_held_only_by_a_detached_store_answers_503_and_an_unknown_one_404() {
    let instance = Instance::start(&[]).await;
    let hash = instance.stored(b"left in a folder no longer named").await;
    let elsewhere = instance.dir.path().join("elsewhere");
    let app = App::start(settings(
        instance.dir.path(),
        &[("MARFA_BLOB_PATH", elsewhere.to_str().unwrap())],
    ))
    .await
    .unwrap();
    let moved = Instance {
        public: public(app.clone()),
        control: control(app.clone()),
        app,
        dir: TempDir::new().unwrap(),
        writer: String::new(),
    };

    let copies = moved.copies(&hash).await;
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0]["detached"], true);
    let read = moved.fetch(&hash).await;
    assert_eq!(
        read.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        read.body
    );
    assert_eq!(read.code(), "blob_store_unavailable");

    let unknown = moved.fetch(&hash_of(b"never stored")).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.code(), "blob_not_found");
}

#[tokio::test]
async fn the_orphan_job_keeps_what_settings_committed_before_they_are_live_keep() {
    let mut purged = Vec::new();
    for (key, value) in [
        ("blob_cleanup_grace_ms", "86400000"),
        ("blob_cleanup_interval_ms", "0"),
    ] {
        let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
        let orphan = instance.stored(b"nothing names this").await;
        let first = instance.run("blob-orphans").await;
        assert_eq!(first["purged"], 0, "{first}");

        let faults = &instance.app.faults;
        faults.set("hold:write", Some("blob.purge")).unwrap();
        let app = instance.app.clone();
        let run = tokio::spawn(async move { housekeeping::run_now(&app, "blob-orphans").await });
        instance.when_held().await;
        commit_unpublished(&instance.app, key, value).await;
        let live = instance.app.settings.live();
        assert_eq!(live.get(BLOB_CLEANUP_GRACE_MS), 0);
        assert_eq!(live.get(BLOB_CLEANUP_INTERVAL_MS), 86_400_000);
        faults.clear(Some("hold:write"));
        let second = run.await.unwrap().unwrap();
        assert_eq!(second.outcome, "ok", "{:?}", second.error);
        purged.push((
            key,
            second.result.unwrap()["purged"].clone(),
            instance.file(&orphan).is_file(),
        ));
    }
    let kept = [
        ("blob_cleanup_grace_ms", json!(0), true),
        ("blob_cleanup_interval_ms", json!(0), true),
    ];
    assert_eq!(purged, kept);
}

#[tokio::test]
async fn the_orphan_job_ends_in_error_and_purges_nothing_while_its_settings_do_not_read() {
    for key in ["blob_cleanup_grace_ms", "blob_cleanup_interval_ms"] {
        let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
        let orphan = instance.stored(b"nothing names this").await;
        let first = instance.run("blob-orphans").await;
        assert_eq!(first["purged"], 0, "{first}");

        commit_unpublished(&instance.app, key, "soon").await;
        let ended = housekeeping::run_now(&instance.app, "blob-orphans")
            .await
            .unwrap();
        assert_eq!(ended.outcome, "error", "{key}");
        assert!(ended.error.unwrap().contains(key), "{key}");
        assert!(instance.file(&orphan).is_file(), "{key}");

        remove_unpublished(&instance.app, key).await;
        let purged = instance.run("blob-orphans").await;
        assert_eq!(purged["purged"], 1, "{key}: {purged}");
        assert!(!instance.file(&orphan).is_file(), "{key}");
    }
}

#[tokio::test]
async fn the_orphan_job_reports_then_purges_after_the_grace_and_keeps_what_an_item_names() {
    let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "1000")]).await;
    let orphan = instance.stored(b"nothing names this").await;
    let named = instance.stored(b"an item names this").await;
    instance.note(&format!("see {named}")).await;

    let first = instance.run("blob-orphans").await;
    assert_eq!(first["purged"], 0, "{first}");
    let listed = instance.call(Method::GET, "/blobs/orphans", None).await;
    let hashes: Vec<&str> = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|orphan| orphan["hash"].as_str())
        .collect();
    assert!(hashes.contains(&orphan.as_str()), "{}", listed.body);

    instance.app.clock.advance(1_001).unwrap();
    let second = instance.run("blob-orphans").await;
    assert_eq!(second["purged"], 1, "{second}");
    assert!(!instance.file(&orphan).exists());
    assert_eq!(instance.fetch(&orphan).await.status, StatusCode::NOT_FOUND);
    assert!(instance.file(&named).is_file());
    assert_eq!(instance.fetch(&named).await.bytes, b"an item names this");
    assert_eq!(
        instance.count("SELECT count(*) FROM audit_log WHERE action = 'blob.purge'"),
        1
    );
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn at_a_grace_of_zero_the_run_after_a_report_purges_within_the_same_millisecond() {
    let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
    let hash = instance.stored(b"reported and purged at one instant").await;

    let first = instance.run("blob-orphans").await;
    assert_eq!(first["purged"], 0, "{first}");
    let second = instance.run("blob-orphans").await;
    assert_eq!(second["purged"], 1, "{second}");
    assert_eq!(instance.fetch(&hash).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_purge_cut_short_leaves_its_deletion_queued_and_the_next_run_finishes_it() {
    let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
    let hash = instance.stored(b"purged in two runs").await;
    instance.run("blob-orphans").await;
    instance.app.clock.advance(1).unwrap();
    instance.arm("fail:blob-delete", None);

    let cut = instance.run("blob-orphans").await;
    assert_eq!(cut["purged"], 0, "{cut}");
    assert_eq!(instance.fetch(&hash).await.status, StatusCode::NOT_FOUND);
    assert!(instance.file(&hash).is_file());
    assert_eq!(
        instance.count(
            "SELECT count(*) FROM blob_pending_deletions WHERE attempts = 1 \
             AND last_error IS NOT NULL"
        ),
        1
    );

    instance.run("blob-orphans").await;
    assert!(!instance.file(&hash).exists());
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn an_upload_waits_on_a_late_deletion_of_its_bytes_and_answers_503_until_it_ends() {
    let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
    let bytes = b"deleted, then uploaded again".to_vec();
    let hash = instance.stored(&bytes).await;
    instance.run("blob-orphans").await;
    instance.app.clock.advance(1).unwrap();
    instance.arm("fail:blob-delete", None);
    instance.run("blob-orphans").await;
    assert!(instance.file(&hash).is_file());

    instance.arm("store-check-deadline", Some("200"));
    instance.arm("hold:blob-delete", None);
    let late = instance.put(&bytes).await;
    assert_eq!(late.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(late.code(), "blob_store_unavailable");
    instance.when_held().await;
    let unfinished = instance.put(&bytes).await;
    assert_eq!(unfinished.status, StatusCode::SERVICE_UNAVAILABLE);

    instance.app.faults.clear(Some("hold:blob-delete"));
    let began = Instant::now();
    while instance.file(&hash).exists() && began.elapsed() < Duration::from_secs(4) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let landed = instance.put(&bytes).await;
    assert_eq!(landed.status, StatusCode::CREATED, "{}", landed.body);
    assert_eq!(instance.fetch(&hash).await.bytes, bytes);
    assert!(instance.file(&hash).is_file());
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn an_upload_whose_record_is_refused_has_its_file_deleted_by_the_next_clean_up() {
    let instance = Instance::start(&[]).await;
    let bytes = b"placed, then its record refused".to_vec();
    let hash = hash_of(&bytes);
    instance.arm("fail:commit", Some("blob.upload"));
    let refused = instance.put(&bytes).await;
    assert!(refused.status.is_server_error(), "{}", refused.body);
    assert!(instance.file(&hash).is_file());

    instance.run("blob-orphans").await;
    assert!(!instance.file(&hash).exists());
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn an_upload_cut_off_between_its_file_and_its_record_is_deleted_after_a_restart() {
    let instance = Instance::start(&[]).await;
    let bytes = b"placed, then the server stopped".to_vec();
    let hash = hash_of(&bytes);
    instance.arm("hold:write", Some("blob.upload"));
    let router = instance.control.clone();
    let upload = bytes.clone();
    tokio::spawn(async move {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .body(Body::from(upload))
            .unwrap();
        send(&router, request).await
    });
    instance.when_held().await;
    assert!(instance.file(&hash).is_file());

    let restarted = App::start(settings(instance.dir.path(), &[]))
        .await
        .unwrap();
    let run = control(restarted)
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/housekeeping/blob-orphans/run")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(run.status(), StatusCode::OK);
    assert!(!instance.file(&hash).exists());
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

#[tokio::test]
async fn a_clean_up_waits_for_an_upload_of_the_same_bytes_and_keeps_its_file() {
    let instance = Instance::start(&[]).await;
    let bytes = b"refused once, then uploaded again".to_vec();
    let hash = hash_of(&bytes);
    instance.arm("fail:commit", Some("blob.upload"));
    instance.put(&bytes).await;
    instance.app.faults.clear(Some("fail:commit"));

    instance.arm("hold:write", Some("blob.upload"));
    let landing = async {
        let landed = instance.put(&bytes).await;
        assert_eq!(landed.status, StatusCode::CREATED, "{}", landed.body);
    };
    let cleaning = async {
        instance.when_held().await;
        let control = instance.control.clone();
        let run = tokio::spawn(async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/housekeeping/blob-orphans/run")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap();
            send(&control, request).await
        });
        settle().await;
        instance.app.faults.clear(Some("hold:write"));
        let run = run.await.unwrap();
        assert_eq!(run.body["outcome"], "ok", "{}", run.body);
    };
    tokio::join!(landing, cleaning);

    assert!(instance.file(&hash).is_file());
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
    assert_eq!(fetched.bytes, bytes);
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

const BUCKET: &str = "marfa";

/// Where the keys of a blob's objects in the fake store, in `prefix`, start.
fn objects_of(prefix: &str, hash: &str) -> String {
    format!(
        "/{BUCKET}/{prefix}/{}",
        hash.strip_prefix("sha256:").unwrap()
    )
}

/// The key of the one object the fake store holds for a blob, in `prefix`.
fn object_key(s3: &FakeS3, prefix: &str, hash: &str) -> String {
    let keys = s3.objects_under(&objects_of(prefix, hash));
    assert_eq!(keys.len(), 1, "{keys:?}");
    keys[0].clone()
}

fn marker_key(prefix: &str) -> String {
    format!("/{BUCKET}/{prefix}/.marfa-store")
}

impl Instance {
    /// Stores the bytes and copies them into the object store.
    async fn replicated(&self, s3: &FakeS3, bytes: &[u8]) -> String {
        let hash = self.stored(bytes).await;
        self.run("blob-replicate").await;
        object_key(s3, "blobs", &hash);
        assert_eq!(self.copies(&hash).await.len(), 2);
        hash
    }
}

#[tokio::test]
async fn an_object_store_that_answers_404_everywhere_has_nothing_struck() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance.replicated(&s3, b"kept in two stores").await;

    s3.set_mode(Mode::AllNotFound);
    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 0, "{result}");
    assert_eq!(result["unreachable"], 1, "{result}");
    assert_eq!(instance.copies(&hash).await.len(), 2);

    s3.set_mode(Mode::Normal);
    let marker = s3.object(&marker_key("blobs")).unwrap();
    s3.put_object(
        &marker_key("blobs"),
        uuid::Uuid::now_v7().to_string().as_bytes(),
    );
    s3.remove_object(&object_key(&s3, "blobs", &hash));
    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 0, "{result}");
    assert_eq!(result["unreachable"], 1, "{result}");
    assert_eq!(instance.copies(&hash).await.len(), 2);

    // The witness: the store answering as itself has its missing copy struck.
    s3.put_object(&marker_key("blobs"), &marker);
    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 1, "{result}");
    let copies = instance.copies(&hash).await;
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0]["kind"], "disk");
}

#[tokio::test]
async fn a_start_falls_back_to_the_recorded_object_store_only_when_it_is_not_reached() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    instance
        .replicated(&s3, b"a copy in the object store")
        .await;

    s3.set_mode(Mode::AllNotFound);
    let refused = App::start(settings(instance.dir.path(), &pairs(&env))).await;
    let message = refused.err().map(|failure| failure.to_string()).unwrap();
    assert!(message.contains("s3://marfa/blobs"), "{message}");

    let mut closed = env.clone();
    closed[2].1 = closed_endpoint().await;
    let again = App::start(settings(instance.dir.path(), &pairs(&closed))).await;
    assert!(
        again.is_ok(),
        "{:?}",
        again.err().map(|failure| failure.to_string())
    );
}

#[tokio::test]
async fn a_start_refused_for_its_object_store_leaves_the_blob_folder_untouched() {
    let dir = TempDir::new().unwrap();
    let endpoint = closed_endpoint().await;
    let env = [
        ("S3_BUCKET", BUCKET),
        ("S3_ENDPOINT", endpoint.as_str()),
        ("S3_ACCESS_KEY_ID", "test-key"),
        ("S3_SECRET_ACCESS_KEY", "test-secret"),
    ];
    let refused = App::start(settings(dir.path(), &env)).await;
    assert!(refused.is_err());
    assert!(!dir.path().join("blobs").exists());
}

#[tokio::test]
async fn a_missing_folder_is_filled_only_from_an_object_store_the_server_kept_copies_in() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance.replicated(&s3, b"rebuilt from the bucket").await;
    let folder = instance.folder();
    std::fs::remove_dir_all(&folder).unwrap();

    let fresh = s3.settings(BUCKET, "elsewhere");
    let refused = App::start(settings(instance.dir.path(), &pairs(&fresh))).await;
    let message = refused.err().map(|failure| failure.to_string()).unwrap();
    assert!(message.contains(folder.to_str().unwrap()), "{message}");
    assert!(!folder.exists());
    assert!(s3.object(&marker_key("elsewhere")).is_none());

    let mut closed = env.clone();
    closed[2].1 = closed_endpoint().await;
    let refused = App::start(settings(instance.dir.path(), &pairs(&closed))).await;
    let message = refused.err().map(|failure| failure.to_string()).unwrap();
    assert!(message.contains(folder.to_str().unwrap()), "{message}");
    assert!(!folder.exists());

    let rebuilt = App::start(settings(instance.dir.path(), &pairs(&env)))
        .await
        .map_err(|failure| failure.to_string())
        .unwrap();
    rebuilt.clock.pause(true);
    let control = control(rebuilt.clone());
    let run = |job: &'static str| {
        let control = control.clone();
        async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri(format!("/housekeeping/{job}/run"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap();
            send(&control, request).await
        }
    };
    assert_eq!(run("blob-replicate").await.body["result"]["copied"], 1);
    let request = Request::builder()
        .uri(format!("/blobs/{hash}"))
        .body(Body::empty())
        .unwrap();
    let fetched = send(&control, request).await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.bytes, b"rebuilt from the bucket");
    assert!(instance.file(&hash).is_file());
}

#[tokio::test]
async fn a_head_asks_the_object_store_and_reads_no_bytes() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance
        .replicated(&s3, b"held only by the object store")
        .await;
    std::fs::remove_file(instance.file(&hash)).unwrap();
    assert_eq!(instance.run("blob-integrity").await["struck"], 1);
    let key = object_key(&s3, "blobs", &hash);
    let before = s3.requests(&Method::GET, &key);

    let headed = instance
        .call(Method::HEAD, &format!("/blobs/{hash}"), None)
        .await;
    assert_eq!(headed.status, StatusCode::OK);
    assert_eq!(s3.requests(&Method::GET, &key), before);
    assert!(s3.requests(&Method::HEAD, &key) > 0);

    s3.remove_object(&key);
    let headed = instance
        .call(Method::HEAD, &format!("/blobs/{hash}"), None)
        .await;
    assert_eq!(headed.status, StatusCode::SERVICE_UNAVAILABLE);
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn a_blob_that_never_copies_does_not_hold_back_the_others() {
    let s3 = FakeS3::start().await;
    let mut env = s3.settings(BUCKET, "blobs");
    env.push(("MARFA_BLOB_REPLICATE_BATCH".to_string(), "1".to_string()));
    let instance = Instance::start(&pairs(&env)).await;
    let stuck = b"refused by the object store";
    s3.refuse_writes(&objects_of("blobs", &hash_of(stuck)));
    instance.stored(stuck).await;
    instance.app.clock.advance(5).unwrap();
    let other = instance.stored(b"copied all the same").await;

    for _ in 0..3 {
        instance.run("blob-replicate").await;
    }
    assert_eq!(instance.copies(&other).await.len(), 2);
    assert_eq!(instance.copies(&hash_of(stuck)).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_object_store_body_that_outlasts_thirty_seconds_arrives_whole() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes: Vec<u8> = (0..65_536u32).map(|at| (at % 251) as u8).collect();
    let hash = instance.replicated(&s3, &bytes).await;
    std::fs::remove_file(instance.file(&hash)).unwrap();
    assert_eq!(instance.run("blob-integrity").await["struck"], 1);

    s3.set_mode(Mode::Trickle(33));
    let began = Instant::now();
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert!(began.elapsed() > Duration::from_secs(30));
    assert_eq!(fetched.bytes.len(), bytes.len());
    assert!(fetched.bytes == bytes);
}

#[tokio::test]
async fn a_deletion_that_lands_after_the_server_gave_it_up_leaves_the_copy_made_since() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes = b"copied again while an old deletion is out".to_vec();
    let hash = instance.replicated(&s3, &bytes).await;
    let store = instance
        .copies(&hash)
        .await
        .iter()
        .find(|copy| copy["kind"] == "s3")
        .map(|copy| copy["store_id"].as_str().unwrap().to_string())
        .unwrap();

    instance.arm("store-check-deadline", Some("200"));
    let release = s3.delay_next_delete();
    let dropped = instance
        .call(
            Method::DELETE,
            &format!("/blobs/{hash}/copies/{store}"),
            None,
        )
        .await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    let began = Instant::now();
    loop {
        let run = instance.run("blob-replicate").await;
        if run["copied"] == 1 {
            break;
        }
        assert!(began.elapsed() < Duration::from_secs(10), "{run}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(instance.copies(&hash).await.len(), 2);

    release.notify_one();
    let began = Instant::now();
    while s3.late_deletes_landed() == 0 {
        assert!(
            began.elapsed() < Duration::from_secs(4),
            "the deletion never landed"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The late deletion took the object it named, and only that one.
    object_key(&s3, "blobs", &hash);
    instance.app.faults.clear(Some("store-check-deadline"));
    let checked = instance.run("blob-integrity").await;
    assert_eq!(checked["struck"], 0, "{checked}");
    assert_eq!(instance.copies(&hash).await.len(), 2);
    std::fs::remove_file(instance.file(&hash)).unwrap();
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
    assert_eq!(fetched.bytes, bytes);
}

#[tokio::test]
async fn an_object_store_that_stops_answering_as_itself_mid_run_has_nothing_more_struck() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let mut hashes = [
        instance.replicated(&s3, b"one copy truly gone").await,
        instance.replicated(&s3, b"one copy still there").await,
    ];
    hashes.sort();
    let (gone, kept) = (hashes[0].clone(), hashes[1].clone());
    s3.remove_object(&object_key(&s3, "blobs", &gone));

    s3.set_mode(Mode::NotFoundAfterMarkers(2));
    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 1, "{result}");
    assert_eq!(result["unreachable"], 1, "{result}");
    assert_eq!(instance.copies(&gone).await.len(), 1);
    assert_eq!(instance.copies(&kept).await.len(), 2);

    // The witness: once the store answers as itself again, the copy that is there is kept.
    s3.set_mode(Mode::Normal);
    let result = instance.run("blob-integrity").await;
    assert_eq!(result["struck"], 0, "{result}");
    assert_eq!(instance.copies(&kept).await.len(), 2);
}

#[tokio::test]
async fn the_drop_door_holds_to_a_minimum_committed_before_it_is_live() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance.stored(b"two copies, and a minimum of two").await;
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 1, "{run}");
    let disk = instance.disk().await;

    let faults = &instance.app.faults;
    faults.set("hold:write", Some("blob.copy_dropped")).unwrap();
    let door = format!("/blobs/{hash}/copies/{disk}");
    let router = instance.control.clone();
    let request = Request::builder().method(Method::DELETE).uri(&door);
    let request = request.body(Body::empty()).unwrap();
    let drop = tokio::spawn(async move { send(&router, request).await });
    instance.when_held().await;
    commit_unpublished(&instance.app, "blob_min_copies", "2").await;
    assert_eq!(instance.app.settings.live().get(BLOB_MIN_COPIES), 1);
    faults.clear(Some("hold:write"));
    let dropped = drop.await.unwrap();
    assert_eq!(dropped.status, StatusCode::CONFLICT, "{}", dropped.body);
    assert_eq!(dropped.code(), "copies_below_minimum");
    assert_eq!(instance.copies(&hash).await.len(), 2);
    assert!(instance.file(&hash).is_file());
}

#[tokio::test]
async fn the_drop_door_refuses_while_the_minimum_does_not_read() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance
        .stored(b"two copies, and a minimum that does not read")
        .await;
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 1, "{run}");
    let door = format!("/blobs/{hash}/copies/{}", instance.disk().await);

    commit_unpublished(&instance.app, "blob_min_copies", "many").await;
    let refused = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(
        refused.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        refused.body
    );
    remove_unpublished(&instance.app, "blob_min_copies").await;

    let faults = &instance.app.faults;
    faults.set("hold:write", Some("blob.copy_dropped")).unwrap();
    let router = instance.control.clone();
    let request = Request::builder().method(Method::DELETE).uri(&door);
    let request = request.body(Body::empty()).unwrap();
    let drop = tokio::spawn(async move { send(&router, request).await });
    instance.when_held().await;
    commit_unpublished(&instance.app, "blob_min_copies", "many").await;
    faults.clear(Some("hold:write"));
    let refused = drop.await.unwrap();
    assert_eq!(
        refused.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        refused.body
    );
    assert_eq!(instance.copies(&hash).await.len(), 2);
    assert!(instance.file(&hash).is_file());

    remove_unpublished(&instance.app, "blob_min_copies").await;
    let dropped = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    assert_eq!(instance.copies(&hash).await.len(), 1);
}

#[tokio::test]
async fn an_object_store_reaching_another_bucket_takes_no_copy_and_the_blob_survives() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes = b"replicated while the endpoint reached another bucket".to_vec();
    let hash = instance.stored(&bytes).await;
    let disk = instance.disk().await;
    let door = format!("/blobs/{hash}/copies/{disk}");

    s3.swap_buckets();
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 0, "{run}");
    assert_eq!(instance.copies(&hash).await.len(), 1);
    let dropped = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(dropped.status, StatusCode::CONFLICT, "{}", dropped.body);
    assert_eq!(dropped.code(), "copies_below_minimum");

    s3.swap_buckets();
    let checked = instance.run("blob-integrity").await;
    assert_eq!(checked["struck"], 0, "{checked}");
    assert!(instance.file(&hash).is_file());
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
    assert_eq!(fetched.bytes, bytes);

    // The witness: the store answering as itself takes the copy.
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 1, "{run}");
    object_key(&s3, "blobs", &hash);
    assert_eq!(instance.copies(&hash).await.len(), 2);
}

#[tokio::test]
async fn a_copy_written_to_another_bucket_than_the_one_answering_after_is_not_recorded() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance.stored(b"written where the marker is not").await;

    s3.swap_buckets();
    s3.set_mode(Mode::SwapAfterPut);
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 0, "{run}");
    assert_eq!(instance.copies(&hash).await.len(), 1);

    // The witness: the same run against one bucket throughout records the copy.
    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 1, "{run}");
    assert_eq!(instance.copies(&hash).await.len(), 2);
}

#[tokio::test]
async fn a_drop_is_not_confirmed_by_an_object_this_store_did_not_write() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes = b"held by the disk and by a bucket the store never wrote to";
    let hash = instance.replicated(&s3, bytes).await;
    let key = object_key(&s3, "blobs", &hash);
    let written = s3.stored(&key).unwrap();
    let disk = instance.disk().await;
    let door = format!("/blobs/{hash}/copies/{disk}");

    s3.remove_object(&key);
    s3.swap_buckets();
    s3.put_object(&key, bytes);
    s3.set_mode(Mode::SwapAfterHead);
    let refused = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.code(), "copies_below_minimum");
    assert!(instance.file(&hash).is_file());

    // The witness: the object the store wrote, answering at the same name, confirms the drop.
    s3.swap_buckets();
    s3.set_mode(Mode::SwapAfterHead);
    s3.restore(&key, written);
    let dropped = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    assert!(!instance.file(&hash).exists());
}

#[tokio::test]
async fn integrity_keeps_a_copy_whose_object_does_not_name_the_store_and_asks_the_store_no_more() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes = b"overwritten by hand with the same bytes";
    let hash = instance.replicated(&s3, bytes).await;
    let key = object_key(&s3, "blobs", &hash);
    let written = s3.stored(&key).unwrap();
    let s3_stamp = |copies: Vec<Value>| {
        copies
            .into_iter()
            .find(|copy| copy["kind"] == "s3")
            .map(|copy| copy["verified_at"].clone())
    };
    let first = instance.run("blob-integrity").await;
    assert_eq!(first["verified"], 2, "{first}");
    let stamp = s3_stamp(instance.copies(&hash).await).unwrap();
    assert!(stamp.is_string(), "{stamp}");
    instance.app.clock.advance(1000).unwrap();

    s3.put_object(&key, bytes);
    let run = instance.run("blob-integrity").await;
    assert_eq!(run["struck"], 0, "{run}");
    assert_eq!(run["unreachable"], 1, "{run}");
    assert_eq!(run["verified"], 1, "{run}");
    assert_eq!(instance.copies(&hash).await.len(), 2);
    assert_eq!(s3_stamp(instance.copies(&hash).await), Some(stamp.clone()));
    assert_eq!(s3.object(&key).as_deref(), Some(bytes.as_slice()));

    // The witness: the object the store wrote, back at the same name, is stamped.
    s3.restore(&key, written);
    let run = instance.run("blob-integrity").await;
    assert_eq!(run["verified"], 2, "{run}");
    assert_eq!(run["unreachable"], 0, "{run}");
    assert_ne!(s3_stamp(instance.copies(&hash).await), Some(stamp));
}

#[tokio::test]
async fn integrity_strikes_a_copy_whose_unnamed_object_is_not_as_long_as_the_blob() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance
        .replicated(&s3, b"overwritten by hand with fewer bytes")
        .await;
    let key = object_key(&s3, "blobs", &hash);
    s3.put_object(&key, b"fewer bytes");

    let run = instance.run("blob-integrity").await;
    assert_eq!(run["struck"], 1, "{run}");
    assert_eq!(run["unreachable"], 0, "{run}");
    let copies = instance.copies(&hash).await;
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0]["kind"], "disk");

    let run = instance.run("blob-replicate").await;
    assert_eq!(run["copied"], 1, "{run}");
    assert_eq!(instance.copies(&hash).await.len(), 2);
}

#[tokio::test]
async fn integrity_strikes_no_only_copy_in_an_object_store_that_drops_metadata() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let disk = instance.disk().await;
    let mut objects = Vec::new();
    for bytes in [b"only copy one".as_slice(), b"only copy two".as_slice()] {
        let hash = instance.replicated(&s3, bytes).await;
        let key = object_key(&s3, "blobs", &hash);
        objects.push((hash, key, bytes.to_vec()));
    }
    for (hash, _, _) in &objects {
        let door = format!("/blobs/{hash}/copies/{disk}");
        let dropped = instance.call(Method::DELETE, &door, None).await;
        assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    }

    s3.set_mode(Mode::StripMetadata);
    let run = instance.run("blob-integrity").await;
    assert_eq!(run["struck"], 0, "{run}");
    assert_eq!(run["verified"], 0, "{run}");
    assert_eq!(run["unreachable"], 1, "{run}");
    for (hash, key, bytes) in &objects {
        assert_eq!(instance.copies(hash).await.len(), 1);
        assert_eq!(s3.object(key).as_ref(), Some(bytes));
        assert_eq!(instance.fetch(hash).await.bytes, *bytes);
    }

    // The witness: the same store answering with its id has both copies stamped.
    s3.set_mode(Mode::Normal);
    let run = instance.run("blob-integrity").await;
    assert_eq!(run["verified"], 2, "{run}");
    assert_eq!(run["unreachable"], 0, "{run}");
}

/// Replaces the copy during its marker check, retaining the old object if `kept`.
async fn replaced_during_integrity(kept: bool) -> (Instance, FakeS3, Value, String, String) {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let hash = instance
        .replicated(&s3, b"replaced while integrity runs")
        .await;
    let copies = instance.copies(&hash).await;
    let id = copies.iter().find(|copy| copy["kind"] == "s3").unwrap()["store_id"]
        .as_str()
        .unwrap()
        .to_string();
    let key = object_key(&s3, "blobs", &hash);
    let replaced = s3.stored(&key).unwrap();

    let (release, arrived) = s3.hold_marker();
    let control = instance.control.clone();
    let integrity = tokio::spawn(async move {
        let run = Request::builder()
            .method(Method::POST)
            .uri("/housekeeping/blob-integrity/run")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        send(&control, run).await
    });
    tokio::time::timeout(Duration::from_secs(5), arrived)
        .await
        .unwrap()
        .unwrap();
    let door = format!("/blobs/{hash}/copies/{id}");
    let dropped = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    instance.app.clock.advance(1000).unwrap();
    let copied = instance.run("blob-replicate").await;
    assert_eq!(copied["copied"], 1, "{copied}");
    if kept {
        s3.restore(&key, replaced);
    }
    release.send(()).unwrap();
    let run = integrity.await.unwrap();
    assert_eq!(run.status, StatusCode::OK, "{}", run.body);
    let result = run.body["result"].clone();
    (instance, s3, result, hash, id)
}

/// The copy in `store`, which the run left unchecked, is stamped by the next run.
async fn unchecked_until_the_next_run(instance: &Instance, hash: &str, store: &str) {
    let stamped = |copies: Vec<Value>| {
        copies
            .into_iter()
            .find(|copy| copy["store_id"] == store)
            .map(|copy| !copy["verified_at"].is_null())
    };
    assert_eq!(stamped(instance.copies(hash).await), Some(false));
    let run = instance.run("blob-integrity").await;
    assert_eq!(run["struck"], 0, "{run}");
    assert_eq!(stamped(instance.copies(hash).await), Some(true));
}

#[tokio::test]
async fn a_copy_replaced_during_an_integrity_run_is_not_struck_for_the_object_it_replaced() {
    let (instance, _s3, result, hash, id) = replaced_during_integrity(false).await;
    assert_eq!(result["struck"], 0, "{result}");
    unchecked_until_the_next_run(&instance, &hash, &id).await;
}

#[tokio::test]
async fn a_copy_replaced_during_an_integrity_run_is_not_stamped_for_the_object_it_replaced() {
    let (instance, _s3, result, hash, id) = replaced_during_integrity(true).await;
    assert_eq!(result["verified"], 1, "{result}");
    unchecked_until_the_next_run(&instance, &hash, &id).await;
}

#[tokio::test]
async fn a_drop_is_not_confirmed_by_another_bucket_holding_the_same_object() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let bytes = b"held by the store and by a copy of its bucket".to_vec();
    let hash = instance.replicated(&s3, &bytes).await;
    let disk = instance.disk().await;
    let door = format!("/blobs/{hash}/copies/{disk}");
    let key = object_key(&s3, "blobs", &hash);
    let object = s3.object(&key).unwrap();

    s3.swap_buckets();
    s3.put_object(&key, &object);
    let refused = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.code(), "copies_below_minimum");
    assert!(instance.file(&hash).is_file());
    assert_eq!(instance.copies(&hash).await.len(), 2);
    let checked = instance.run("blob-integrity").await;
    assert_eq!(checked["verified"], 1, "{checked}");
    assert_eq!(checked["unreachable"], 1, "{checked}");
    let stamped = |copies: &[Value]| {
        copies
            .iter()
            .filter(|copy| !copy["verified_at"].is_null())
            .count()
    };
    assert_eq!(stamped(&instance.copies(&hash).await), 1);

    // The witnesses: the store answering as itself is stamped, and confirms the same drop.
    s3.swap_buckets();
    let checked = instance.run("blob-integrity").await;
    assert_eq!(checked["verified"], 2, "{checked}");
    assert_eq!(checked["unreachable"], 0, "{checked}");
    assert_eq!(stamped(&instance.copies(&hash).await), 2);
    let dropped = instance.call(Method::DELETE, &door, None).await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    assert!(!instance.file(&hash).exists());
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
    assert_eq!(fetched.bytes, bytes);
}

#[tokio::test]
async fn a_bucket_copy_a_retained_backup_names_is_not_dropped_while_the_disk_copy_is() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::start(&pairs(&env)).await;
    let held = instance.replicated(&s3, b"named by a backup").await;
    instance.note(&format!("see {held}")).await;
    let backup = instance.call(Method::POST, "/backups", None).await;
    assert_eq!(backup.status, StatusCode::OK, "{}", backup.body);
    assert_eq!(backup.body["outcome"], "put", "{}", backup.body);
    let witness = instance.replicated(&s3, b"named by no backup").await;
    let listed = instance.call(Method::GET, "/blobs/stores", None).await;
    let bucket = listed.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|store| store["kind"] == "s3")
        .and_then(|store| store["id"].as_str())
        .unwrap()
        .to_string();
    let door = |hash: &str, store: &str| format!("/blobs/{hash}/copies/{store}");

    let dropped = instance
        .call(Method::DELETE, &door(&witness, &bucket), None)
        .await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    assert!(s3.objects_under(&objects_of("blobs", &witness)).is_empty());

    let refused = instance
        .call(Method::DELETE, &door(&held, &bucket), None)
        .await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.body);
    assert_eq!(refused.code(), "copy_held_by_backup");
    assert_eq!(instance.copies(&held).await.len(), 2);
    object_key(&s3, "blobs", &held);

    let disk = instance.disk().await;
    let dropped = instance
        .call(Method::DELETE, &door(&held, &disk), None)
        .await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.body);
    assert_eq!(instance.fetch(&held).await.bytes, b"named by a backup");
}

/// Holds the writer and keeps its heartbeat alive until the sender releases it.
fn occupy_writer(
    app: &Arc<App>,
) -> (
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (started, began) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (app, pulse) = (app.clone(), app.db.pulse());
    tokio::spawn(async move {
        app.db
            .write(Write::own(), move |_tx| {
                let _ = started.send(());
                while let Err(RecvTimeoutError::Timeout) =
                    released.recv_timeout(Duration::from_millis(10))
                {
                    pulse.tick();
                }
                Ok(())
            })
            .await
            .unwrap();
    });
    (release, began)
}

/// Gives queued tasks an opportunity to run before the next step.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn an_upload_whose_client_goes_away_while_its_record_waits_behind_a_purge_keeps_its_file() {
    let instance = Instance::start(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "0")]).await;
    let bytes = b"uploaded again while its purge waits for the writer".to_vec();
    let hash = instance.stored(&bytes).await;
    instance.run("blob-orphans").await;
    instance.app.clock.advance(1).unwrap();

    instance.arm("hold:write", Some("blob.purge"));
    let control = instance.control.clone();
    let purge = tokio::spawn(async move {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/housekeeping/blob-orphans/run")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        send(&control, request).await
    });
    instance.when_held().await;

    // The writer's queue becomes: the purge, a second hold, then the upload's record.
    let (first, first_began) = occupy_writer(&instance.app);
    first_began.await.unwrap();
    instance.app.faults.clear(Some("hold:write"));
    settle().await;
    let (second, second_began) = occupy_writer(&instance.app);
    settle().await;
    let mut upload = Box::pin(instance.put(&bytes));
    let waited = tokio::time::timeout(Duration::from_millis(300), &mut upload).await;
    assert!(
        waited.is_err(),
        "the upload answered while the writer was held"
    );
    drop(upload);

    first.send(()).unwrap();
    second_began.await.unwrap();
    let began = Instant::now();
    while instance.file(&hash).exists() && began.elapsed() < Duration::from_millis(500) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    second.send(()).unwrap();
    let run = purge.await.unwrap();
    assert_eq!(run.body["outcome"], "ok", "{}", run.body);

    assert!(instance.file(&hash).is_file(), "{}", run.body);
    let fetched = instance.fetch(&hash).await;
    assert_eq!(fetched.status, StatusCode::OK, "{}", fetched.body);
    assert_eq!(fetched.bytes, bytes);
    assert_eq!(instance.copies(&hash).await.len(), 1);
    assert_eq!(
        instance.count("SELECT count(*) FROM blob_pending_deletions"),
        0
    );
}

/// A picture `width` pixels wide, so each width is a different blob.
fn jpeg(width: u8) -> Vec<u8> {
    vec![
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 8, 0, width, 1, 1, 0x11, 0, 0xff, 0xda, 0x00,
        0x08, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
    ]
}

impl Instance {
    async fn with_owner(more: &[(&str, &str)]) -> Instance {
        let mut pairs = vec![
            ("MARFA_BLOB_CLEANUP_GRACE_MS", "0"),
            ("MARFA_SIGN_IN_ADDRESS", "http://127.0.0.1:8600"),
        ];
        pairs.extend_from_slice(more);
        let instance = Instance::start(&pairs).await;
        let claim = json!({ "email": "owner@example.test", "password": "the first password" });
        let claimed = instance
            .call(Method::POST, "/_control/setup/claim", Some(claim))
            .await;
        assert_eq!(claimed.status, StatusCode::CREATED, "{}", claimed.body);
        instance
    }

    async fn picture(&self, bytes: &[u8]) -> String {
        let request = Request::builder()
            .method(Method::PUT)
            .uri("/owner/picture")
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let stored = send(&self.control, request).await;
        assert_eq!(stored.status, StatusCode::OK, "{}", stored.body);
        hash_of(bytes)
    }

    fn blobs_named(&self, hash: &str) -> i64 {
        self.count(&format!("SELECT count(*) FROM blobs WHERE hash = '{hash}'"))
    }
}

#[tokio::test]
async fn the_owners_picture_is_replicated_and_purged_only_once_replaced() {
    let s3 = FakeS3::start().await;
    let env = s3.settings(BUCKET, "blobs");
    let instance = Instance::with_owner(&pairs(&env)).await;
    let first = instance.picture(&jpeg(8)).await;
    instance.run("blob-replicate").await;
    object_key(&s3, "blobs", &first);
    assert_eq!(instance.copies(&first).await.len(), 2);
    for _ in 0..3 {
        let run = instance.run("blob-orphans").await;
        assert_eq!(run["purged"], 0, "{run}");
        instance.app.clock.advance(1).unwrap();
    }
    assert_eq!(instance.blobs_named(&first), 1);

    let second = instance.picture(&jpeg(9)).await;
    instance.run("blob-replicate").await;
    instance.run("blob-orphans").await;
    instance.app.clock.advance(1).unwrap();
    let run = instance.run("blob-orphans").await;
    assert_eq!(run["purged"], 1, "{run}");
    assert_eq!(instance.blobs_named(&first), 0);
    assert!(!instance.file(&first).exists());
    assert!(s3.objects_under(&objects_of("blobs", &first)).is_empty());

    assert_eq!(instance.copies(&second).await.len(), 2);
    std::fs::remove_file(instance.file(&second)).unwrap();
    let served = instance.call(Method::GET, "/owner/picture", None).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.bytes, jpeg(9));
}

#[tokio::test]
async fn a_picture_set_while_a_purge_waits_for_the_writer_keeps_its_bytes() {
    let instance = Instance::with_owner(&[]).await;
    let bytes = jpeg(10);
    let picture = instance.stored(&bytes).await;
    let witness = instance.stored(b"named by nothing").await;
    instance.run("blob-orphans").await;
    instance.app.clock.advance(1).unwrap();

    instance.arm("hold:blob-orphans:purge", None);
    let set = async {
        instance.when_held().await;
        instance.picture(&bytes).await;
        instance.app.faults.clear(Some("hold:blob-orphans:purge"));
    };
    let (run, ()) = tokio::join!(instance.run("blob-orphans"), set);
    assert_eq!(run["purged"], 1, "{run}");
    assert_eq!(instance.blobs_named(&witness), 0);
    assert_eq!(instance.blobs_named(&picture), 1);
    let served = instance.call(Method::GET, "/owner/picture", None).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.bytes, bytes);
}

#[tokio::test]
async fn a_copy_that_runs_out_of_time_aborts_its_multipart_upload() {
    let s3 = FakeS3::start().await;
    let instance = Instance::start(&pairs(&s3.settings(BUCKET, "blobs"))).await;
    let bucket = instance.app.blobs.s3().unwrap();
    let whole = vec![7u8; 10 * 1024 * 1024];
    let hash = marfa_server::app::blobs::Hash::parse(&hash_of(&whole)).unwrap();
    let first = bytes::Bytes::copy_from_slice(&whole[..9 * 1024 * 1024]);
    let stalls = futures_util::stream::once(async move { Ok(first) })
        .chain(futures_util::stream::pending())
        .boxed();

    let written = bucket.write(
        "stalled/0190a1b2c3d4",
        &hash,
        "application/octet-stream",
        whole.len() as u64,
        stalls,
        Duration::from_secs(2),
    );
    let error = written.await.unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
    assert_eq!(s3.unfinished_uploads(), Vec::<String>::new());
    assert!(
        s3.objects_under(&format!("/{BUCKET}/blobs/stalled"))
            .is_empty()
    );
}
