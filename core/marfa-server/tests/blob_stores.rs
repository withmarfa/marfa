//! Every copy of a blob kept safe on the disk store: what start refuses, what the jobs strike
//! and purge, and what the drop door refuses.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Accepted, Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

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
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("RATE_LIMIT_ENABLED", "false"),
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
        &[("BLOB_PATH", elsewhere.to_str().unwrap())],
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
