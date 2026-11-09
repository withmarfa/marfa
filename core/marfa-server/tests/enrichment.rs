//! The reader starts this test program as its child; `main` must serve it first.

#[allow(dead_code)]
mod fake_s3;

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use libtest_mimic::{Arguments, Trial};
use marfa_server::app::{App, housekeeping};
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SWEEP: &str = "enrichment-sweep";

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    token: String,
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Instance {
    async fn start(settings: &[(&str, &str)]) -> Instance {
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
            ("MARFA_ENRICHMENT_ENABLED", "true"),
            ("MARFA_ENRICHMENT_OCR_ENABLED", "false"),
            ("MARFA_ENRICHMENT_INTERVAL_MS", "3600000"),
        ];
        pairs.extend_from_slice(settings);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
            token: String::new(),
        };
        let body = json!({
            "label": "writer",
            "source": "writer",
            "permissions": [],
            "type_permissions": { "core.file": "write", "core.file.image": "write" },
        });
        let (status, minted) = instance.local(Method::POST, "/keys", body).await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        instance.token = minted["key"].as_str().unwrap().to_string();
        instance
    }

    async fn local(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        send(&self.control, request).await
    }

    async fn upload(&self, bytes: &[u8]) -> String {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let (status, stored) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::CREATED, "{stored}");
        stored["hash"].as_str().unwrap().to_string()
    }

    async fn file(&self, bytes: &[u8], mime: &str, extra: Value) -> String {
        let hash = self.upload(bytes).await;
        let mut properties = json!({ "blob_ref": hash, "mime_type": mime, "title": "a file" });
        properties
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let request = Request::builder()
            .method(Method::POST)
            .uri("/items")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "type": "core.file", "properties": properties }).to_string(),
            ))
            .unwrap();
        let (status, made) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        made["item"]["id"].as_str().unwrap().to_string()
    }

    async fn item(&self, id: &str) -> Value {
        let request = Request::builder()
            .uri(format!("/items/{id}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::empty())
            .unwrap();
        let (status, found) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::OK, "{found}");
        found["item"].clone()
    }

    async fn change(&self, id: &str, properties: Value, clear: &[&str]) {
        let version = self.item(id).await["version"].clone();
        let request = Request::builder()
            .method(Method::PATCH)
            .uri(format!("/items/{id}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "version": version, "properties": properties, "clear_properties": clear })
                    .to_string(),
            ))
            .unwrap();
        let (status, changed) = send(&self.public, request).await;
        assert_eq!(status, StatusCode::OK, "{changed}");
    }

    async fn sweep(&self) -> Value {
        let ended = housekeeping::run_now(&self.app, SWEEP).await.unwrap();
        assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
        ended.result.unwrap()
    }

    fn database(&self, flags: OpenFlags) -> Connection {
        Connection::open_with_flags(self.dir.path().join("marfa.db"), flags).unwrap()
    }

    fn execute(&self, sql: &str, id: &str) {
        let db = self.database(OpenFlags::SQLITE_OPEN_READ_WRITE);
        db.execute(sql, [id]).unwrap();
    }

    fn next_run(&self) -> String {
        let sql = "SELECT next_run_at FROM housekeeping_jobs WHERE name = 'enrichment-sweep'";
        let db = self.database(OpenFlags::SQLITE_OPEN_READ_ONLY);
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn blob_path(&self, hash: &str) -> std::path::PathBuf {
        let hex = hash.strip_prefix("sha256:").unwrap();
        self.dir.path().join("blobs").join(&hex[0..4]).join(hex)
    }

    async fn hash_of(&self, id: &str) -> String {
        let item = self.item(id).await;
        item["properties"]["blob_ref"].as_str().unwrap().to_string()
    }

    fn count(&self, sql: &str, id: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [id], |row| row.get(0)).unwrap()
    }
}

/// Copies each file to the object store and leaves it there alone.
async fn keep_only_far_away(one: &Instance, ids: &[String]) {
    let ended = housekeeping::run_now(&one.app, "blob-replicate")
        .await
        .unwrap();
    assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
    for id in ids {
        std::fs::remove_file(one.blob_path(&one.hash_of(id).await)).unwrap();
    }
    let ended = housekeeping::run_now(&one.app, "blob-integrity")
        .await
        .unwrap();
    assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
}

/// The object store's key for a file's bytes.
fn object_of(s3: &fake_s3::FakeS3, hash: &str) -> String {
    let hex = hash.strip_prefix("sha256:").unwrap();
    let keys = s3.objects_under("");
    keys.into_iter().find(|key| key.contains(hex)).unwrap()
}

async fn far_instance(s3: &fake_s3::FakeS3) -> Instance {
    let named = s3.settings("marfa", "blobs");
    let named: Vec<(&str, &str)> = named
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    Instance::start(&named).await
}

fn counts(extracted: u64, skipped: u64, failed: u64) -> Value {
    json!({ "extracted": extracted, "skipped": skipped, "failed": failed })
}

async fn reads_text_and_announces_it() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(b"the quokka ledger, page one", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let item = one.item(&id).await;
    assert_eq!(
        item["properties"]["extracted_text"],
        "the quokka ledger, page one"
    );
    assert_eq!(item["version"], 2);
    let announced = "SELECT count(*) FROM event_log WHERE event_type = 'item.updated' \
                     AND item_id = ?1 AND payload LIKE '%quokka ledger%'";
    assert_eq!(one.count(announced, &id), 1);
    let audited = "SELECT count(*) FROM audit_log WHERE action = 'item.enrich' AND resource_id = ?1 \
                   AND kind = 'housekeeping'";
    assert_eq!(one.count(audited, &id), 1);
    assert_eq!(one.sweep().await, counts(0, 0, 0));
}

async fn leaves_what_the_client_wrote() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(
            b"what the file says",
            "text/plain",
            json!({ "extracted_text": "what the client says" }),
        )
        .await;
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let item = one.item(&id).await;
    assert_eq!(item["properties"]["extracted_text"], "what the client says");
    assert_eq!(item["version"], 1);
}

async fn counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next() {
    let one = Instance::start(&[]).await;
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let broken = one.file(b"PK this is no document", docx, json!({})).await;
    let good = one
        .file(b"the wombat ledger", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 1));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let item = one.item(&broken).await;
    assert!(item["properties"].get("extracted_text").is_none());
    assert_eq!(
        one.item(&good).await["properties"]["extracted_text"],
        "the wombat ledger"
    );
}

async fn offers_a_skipped_file_again_when_its_limit_is_raised() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_MAX_BLOB_BYTES", "10")]).await;
    let id = one
        .file(b"more than ten bytes of text", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_max_blob_bytes": 1000 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "more than ten bytes of text"
    );
}

async fn reads_the_bytes_a_file_is_changed_to_though_the_item_named_them_before() {
    let one = Instance::start(&[]).await;
    let other = one.upload(b"the bytes a note names").await;
    let id = one
        .file(
            b"the bytes a file starts with",
            "text/plain",
            json!({ "description": format!("see {other}") }),
        )
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    one.change(&id, json!({ "blob_ref": other }), &["extracted_text"])
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the bytes a note names"
    );
}

async fn reads_a_file_again_when_the_text_it_was_given_is_cleared() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(b"words to read twice", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    one.change(&id, json!({}), &["extracted_text"]).await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "words to read twice"
    );
}

async fn reads_a_file_again_after_its_type_is_corrected() {
    let one = Instance::start(&[]).await;
    let id = one
        .file(
            b"words that were typed wrongly",
            "application/octet-stream",
            json!({}),
        )
        .await;
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    one.change(&id, json!({ "mime_type": "text/plain" }), &[])
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "words that were typed wrongly"
    );
}

async fn does_not_use_up_a_files_attempts_while_its_bytes_cannot_be_opened() {
    let one = Instance::start(&[]).await;
    let id = one.file(b"the dingo ledger", "text/plain", json!({})).await;
    let hash = one.item(&id).await["properties"]["blob_ref"]
        .as_str()
        .unwrap()
        .to_string();
    let hex = hash.strip_prefix("sha256:").unwrap();
    let stored = one.dir.path().join("blobs").join(&hex[0..4]).join(hex);
    let away = one.dir.path().join("away");
    std::fs::rename(&stored, &away).unwrap();
    for _ in 0..4 {
        assert_eq!(one.sweep().await, counts(0, 0, 0));
    }
    let attempts = "SELECT attempts FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                    WHERE i.id = ?1";
    assert_eq!(one.count(attempts, &id), 0);
    std::fs::rename(&away, &stored).unwrap();
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the dingo ledger"
    );
}

async fn reads_a_file_added_after_files_whose_bytes_cannot_be_opened() {
    let one = Instance::start(&[]).await;
    for number in 0..3 {
        let id = one
            .file(
                format!("a ledger kept elsewhere, number {number}").as_bytes(),
                "text/plain",
                json!({}),
            )
            .await;
        let stored = one.blob_path(&one.hash_of(&id).await);
        std::fs::rename(&stored, one.dir.path().join(format!("away-{number}"))).unwrap();
    }
    let healthy = one.file(b"the tapir ledger", "text/plain", json!({})).await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&healthy).await["properties"]["extracted_text"],
        "the tapir ledger"
    );
}

async fn reads_files_held_elsewhere_while_an_object_store_fails() {
    let s3 = fake_s3::FakeS3::start().await;
    let one = far_instance(&s3).await;
    let mut far = Vec::new();
    for number in 0..3 {
        let bytes = format!("a ledger kept far away, number {number}");
        far.push(one.file(bytes.as_bytes(), "text/plain", json!({})).await);
    }
    keep_only_far_away(&one, &far).await;
    let near = one.file(b"the okapi ledger", "text/plain", json!({})).await;
    s3.set_mode(fake_s3::Mode::AllNotFound);
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&near).await["properties"]["extracted_text"],
        "the okapi ledger"
    );
    let waiting = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                   WHERE i.id = ?1 AND f.state = 'waiting' AND f.attempts = 0";
    for id in &far {
        assert_eq!(one.count(waiting, id), 1);
    }
    let mut asked = 0;
    for id in &far {
        let key = object_of(&s3, &one.hash_of(id).await);
        asked += s3.requests(&Method::GET, &key);
    }
    assert_eq!(asked, 2, "the store was asked about every file");
    s3.set_mode(fake_s3::Mode::Normal);
    assert_eq!(one.sweep().await, counts(3, 0, 0));
}

async fn reads_the_files_around_an_object_that_will_not_open() {
    let s3 = fake_s3::FakeS3::start().await;
    let one = far_instance(&s3).await;
    let mut far = Vec::new();
    for number in 0..3 {
        let bytes = format!("a ledger kept far away, number {number}");
        far.push(one.file(bytes.as_bytes(), "text/plain", json!({})).await);
    }
    keep_only_far_away(&one, &far).await;
    let key = object_of(&s3, &one.hash_of(&far[0]).await);
    let object = s3.stored(&key).unwrap();
    s3.remove_object(&key);
    assert_eq!(one.sweep().await, counts(2, 0, 0));
    for id in &far[1..] {
        assert!(one.item(id).await["properties"]["extracted_text"].is_string());
    }
    let waiting = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                   WHERE i.id = ?1 AND f.state = 'waiting' AND f.attempts = 0";
    assert_eq!(one.count(waiting, &far[0]), 1);
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    s3.restore(&key, object);
    assert_eq!(one.sweep().await, counts(1, 0, 0));
}

async fn reads_the_files_behind_objects_that_will_not_open() {
    let s3 = fake_s3::FakeS3::start().await;
    let one = far_instance(&s3).await;
    let mut far = Vec::new();
    for number in 0..4 {
        let bytes = format!("a ledger kept far away, number {number}");
        far.push(one.file(bytes.as_bytes(), "text/plain", json!({})).await);
    }
    keep_only_far_away(&one, &far).await;
    for id in &far[..2] {
        s3.remove_object(&object_of(&s3, &one.hash_of(id).await));
    }
    let mut read = 0;
    for _ in 0..2 {
        let swept = one.sweep().await;
        read += swept["extracted"].as_u64().unwrap();
        assert_eq!(swept["failed"], 0);
    }
    assert_eq!(read, 2);
    let waiting = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                   WHERE i.id = ?1 AND f.state = 'waiting' AND f.attempts = 0";
    for id in &far[..2] {
        assert_eq!(one.count(waiting, id), 1);
    }
}

async fn reads_a_file_again_when_its_type_is_corrected_after_its_attempts_ran_out() {
    let one = Instance::start(&[]).await;
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let id = one
        .file(b"plain words under a wrong type", docx, json!({}))
        .await;
    for _ in 0..3 {
        assert_eq!(one.sweep().await, counts(0, 0, 1));
    }
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    one.change(&id, json!({ "mime_type": "text/plain" }), &[])
        .await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "plain words under a wrong type"
    );
}

async fn leaves_a_file_with_no_copy_until_its_bytes_change() {
    let one = Instance::start(&[]).await;
    let id = one.file(b"the lost ledger", "text/plain", json!({})).await;
    let hash = one.hash_of(&id).await;
    one.execute("DELETE FROM blob_copies WHERE hash = ?1", &hash);
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let left = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                WHERE i.id = ?1 AND f.state = 'skipped' AND f.reason = 'missing'";
    assert_eq!(one.count(left, &id), 1);
    let other = one.upload(b"the found ledger").await;
    one.change(&id, json!({ "blob_ref": other }), &[]).await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the found ledger"
    );
}

async fn reads_a_file_again_when_its_bytes_are_uploaded_again() {
    let one = Instance::start(&[]).await;
    let id = one.file(b"the lost ledger", "text/plain", json!({})).await;
    let hash = one.hash_of(&id).await;
    one.execute("DELETE FROM blob_copies WHERE hash = ?1", &hash);
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.upload(b"the lost ledger").await, hash);
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the lost ledger"
    );
}

async fn reads_a_file_again_when_its_store_is_attached_again() {
    let one = Instance::start(&[]).await;
    let id = one.file(b"the away ledger", "text/plain", json!({})).await;
    let db = || one.database(OpenFlags::SQLITE_OPEN_READ_WRITE);
    db().execute(
        "UPDATE stores SET detached_at = '2026-01-01T00:00:00.000Z'",
        [],
    )
    .unwrap();
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    db().execute("UPDATE stores SET detached_at = NULL", [])
        .unwrap();
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the away ledger"
    );
}

async fn does_not_run_again_at_once_for_files_it_handed_back() {
    let batch = [("MARFA_ENRICHMENT_BATCH_SIZE", "2")];
    let one = Instance::start(&batch).await;
    for number in 0..3 {
        let bytes = format!("a ledger kept elsewhere, number {number}");
        let id = one.file(bytes.as_bytes(), "text/plain", json!({})).await;
        let stored = one.blob_path(&one.hash_of(&id).await);
        std::fs::rename(&stored, one.dir.path().join(format!("away-{number}"))).unwrap();
    }
    let ended = housekeeping::run_now(&one.app, SWEEP).await.unwrap();
    assert_eq!(ended.result.unwrap(), counts(0, 0, 0));
    assert!(
        one.next_run() > ended.finished_at,
        "{} is not after {}",
        one.next_run(),
        ended.finished_at
    );

    // The witness: files that were read leave more behind, and the run comes again at once.
    let more = Instance::start(&batch).await;
    for number in 0..3 {
        let bytes = format!("a ledger kept here, number {number}");
        more.file(bytes.as_bytes(), "text/plain", json!({})).await;
    }
    let ended = housekeeping::run_now(&more.app, SWEEP).await.unwrap();
    assert_eq!(ended.result.unwrap(), counts(2, 0, 0));
    assert!(more.next_run() <= ended.finished_at);

    // Files with no copy are left, not handed back, so a second run takes the rest and stops.
    let lost = Instance::start(&batch).await;
    for number in 0..3 {
        let bytes = format!("a ledger with no copy, number {number}");
        let id = lost.file(bytes.as_bytes(), "text/plain", json!({})).await;
        let hash = lost.hash_of(&id).await;
        lost.execute("DELETE FROM blob_copies WHERE hash = ?1", &hash);
    }
    let ended = housekeeping::run_now(&lost.app, SWEEP).await.unwrap();
    assert_eq!(ended.result.unwrap(), counts(0, 2, 0));
    assert!(lost.next_run() <= ended.finished_at);
    let ended = housekeeping::run_now(&lost.app, SWEEP).await.unwrap();
    assert_eq!(ended.result.unwrap(), counts(0, 1, 0));
    assert!(lost.next_run() > ended.finished_at);
}

#[cfg(feature = "native")]
const SENTENCE: &[u8] = include_bytes!("../../marfa-enrichment/fixtures/sentence.png");

const JPEG: &[u8] = include_bytes!("../../marfa-enrichment/fixtures/sample.jpg");

async fn picture_item(one: &Instance, bytes: &[u8], mime: &str) -> String {
    let hash = one.upload(bytes).await;
    let made = json!({ "type": "core.file.image", "properties": {
        "blob_ref": hash, "mime_type": mime, "title": "a picture" } });
    let request = Request::builder()
        .method(Method::POST)
        .uri("/items")
        .header(header::AUTHORIZATION, format!("Bearer {}", one.token))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(made.to_string()))
        .unwrap();
    let (status, body) = send(&one.public, request).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["item"]["id"].as_str().unwrap().to_string()
}

#[cfg(feature = "native")]
async fn reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on() {
    let one = Instance::start(&[]).await;
    let id = picture_item(&one, SENTENCE, "image/png").await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let item = one.item(&id).await;
    assert!(item["properties"]["width"].as_u64().unwrap() > 0);
    assert!(item["properties"].get("extracted_text").is_none());
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_ocr_enabled": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    let text = one.item(&id).await["properties"]["extracted_text"].clone();
    assert!(
        text.as_str()
            .unwrap()
            .contains("Marfa reads this sentence upright."),
        "{text}"
    );
}

#[cfg(feature = "native")]
async fn counts_a_damaged_picture_when_ocr_is_on() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_OCR_ENABLED", "true")]).await;
    let mut damaged = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    damaged.extend_from_slice(&[0x5a; 4096]);
    let broken = picture_item(&one, &damaged, "image/png").await;
    let good = picture_item(&one, SENTENCE, "image/png").await;
    assert_eq!(one.sweep().await, counts(1, 0, 1));
    assert!(one.item(&broken).await["properties"].get("width").is_none());
    assert!(
        one.item(&good).await["properties"]
            .get("extracted_text")
            .is_some()
    );
}

async fn fills_the_size_of_a_picture_left_for_its_words_when_the_size_is_cleared() {
    let one = Instance::start(&[]).await;
    let id = picture_item(&one, JPEG, "image/jpeg").await;
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert!(one.item(&id).await["properties"]["width"].as_u64().unwrap() > 0);
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    one.change(&id, json!({}), &["width"]).await;
    assert!(one.item(&id).await["properties"].get("width").is_none());
    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert!(one.item(&id).await["properties"]["width"].as_u64().unwrap() > 0);
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let left = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                WHERE i.id = ?1 AND f.state = 'skipped' AND f.reason = 'ocr'";
    assert_eq!(one.count(left, &id), 1);
}

async fn reads_a_skipped_file_again_for_a_cleared_field_and_still_holds_its_refusal() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_MAX_BLOB_BYTES", "10")]).await;
    let id = one
        .file(b"more than ten bytes of text", "text/plain", json!({}))
        .await;
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    one.change(&id, json!({ "extracted_text": "typed by a person" }), &[])
        .await;
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    one.change(&id, json!({}), &["extracted_text"]).await;
    assert_eq!(one.sweep().await, counts(0, 1, 0));
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    let held = "SELECT count(*) FROM enrichment_files f JOIN items i ON i.seq = f.item_seq \
                WHERE i.id = ?1 AND f.state = 'skipped' AND f.reason = 'over_limit' \
                AND f.capped_by = 'blob' AND f.capped_at = 10";
    assert_eq!(one.count(held, &id), 1);
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_max_blob_bytes": 1000 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
}

async fn leaves_a_disabled_sweep_with_its_files_waiting() {
    let one = Instance::start(&[("MARFA_ENRICHMENT_ENABLED", "false")]).await;
    let id = one.file(b"waiting text", "text/plain", json!({})).await;
    assert_eq!(one.sweep().await, counts(0, 0, 0));
    assert!(
        one.item(&id).await["properties"]
            .get("extracted_text")
            .is_none()
    );
    let (status, body) = one
        .local(
            Method::PATCH,
            "/config",
            json!({ "enrichment_enabled": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(one.sweep().await, counts(1, 0, 0));
}

async fn reads_a_file_whose_only_copy_is_in_the_object_store() {
    let s3 = fake_s3::FakeS3::start().await;
    let named = s3.settings("marfa", "blobs");
    let named: Vec<(&str, &str)> = named
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let one = Instance::start(&named).await;
    let id = one
        .file(b"the numbat ledger, kept far away", "text/plain", json!({}))
        .await;
    let hash = one.item(&id).await["properties"]["blob_ref"]
        .as_str()
        .unwrap()
        .to_string();
    for job in ["blob-replicate", "blob-integrity"] {
        if job == "blob-integrity" {
            let hex = hash.strip_prefix("sha256:").unwrap();
            let file = one.dir.path().join("blobs").join(&hex[0..4]).join(hex);
            std::fs::remove_file(file).unwrap();
        }
        let ended = housekeeping::run_now(&one.app, job).await.unwrap();
        assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
    }
    let copies = "SELECT count(*) FROM blob_copies c JOIN stores s ON s.id = c.store_id \
                  WHERE c.hash = ?1 AND s.kind = 's3'";
    assert_eq!(one.count(copies, &hash), 1);
    let all = "SELECT count(*) FROM blob_copies WHERE hash = ?1";
    assert_eq!(one.count(all, &hash), 1);

    assert_eq!(one.sweep().await, counts(1, 0, 0));
    assert_eq!(
        one.item(&id).await["properties"]["extracted_text"],
        "the numbat ledger, kept far away"
    );
    let spool = std::fs::read_dir(one.dir.path().join("blobs").join("tmp")).unwrap();
    assert_eq!(spool.count(), 0);
}

fn main() {
    marfa_enrichment::serve_child_if_asked();
    let arguments = Arguments::from_args();
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap(),
    );
    let trial =
        |name: &'static str,
         case: fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>| {
            let runtime = runtime.clone();
            Trial::test(name, move || {
                runtime.block_on(case());
                Ok(())
            })
        };
    let trials = vec![
        trial("reads_text_and_announces_it", || {
            Box::pin(reads_text_and_announces_it())
        }),
        trial("leaves_what_the_client_wrote", || {
            Box::pin(leaves_what_the_client_wrote())
        }),
        trial(
            "counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next",
            || Box::pin(counts_a_damaged_file_until_its_attempts_run_out_and_reads_the_next()),
        ),
        trial(
            "offers_a_skipped_file_again_when_its_limit_is_raised",
            || Box::pin(offers_a_skipped_file_again_when_its_limit_is_raised()),
        ),
        trial(
            "reads_the_bytes_a_file_is_changed_to_though_the_item_named_them_before",
            || Box::pin(reads_the_bytes_a_file_is_changed_to_though_the_item_named_them_before()),
        ),
        trial(
            "reads_a_file_again_when_the_text_it_was_given_is_cleared",
            || Box::pin(reads_a_file_again_when_the_text_it_was_given_is_cleared()),
        ),
        trial(
            "fills_the_size_of_a_picture_left_for_its_words_when_the_size_is_cleared",
            || Box::pin(fills_the_size_of_a_picture_left_for_its_words_when_the_size_is_cleared()),
        ),
        trial(
            "reads_a_skipped_file_again_for_a_cleared_field_and_still_holds_its_refusal",
            || {
                Box::pin(
                    reads_a_skipped_file_again_for_a_cleared_field_and_still_holds_its_refusal(),
                )
            },
        ),
        trial(
            "reads_a_file_whose_only_copy_is_in_the_object_store",
            || Box::pin(reads_a_file_whose_only_copy_is_in_the_object_store()),
        ),
        trial("reads_a_file_again_after_its_type_is_corrected", || {
            Box::pin(reads_a_file_again_after_its_type_is_corrected())
        }),
        trial(
            "does_not_use_up_a_files_attempts_while_its_bytes_cannot_be_opened",
            || Box::pin(does_not_use_up_a_files_attempts_while_its_bytes_cannot_be_opened()),
        ),
        trial(
            "reads_a_file_added_after_files_whose_bytes_cannot_be_opened",
            || Box::pin(reads_a_file_added_after_files_whose_bytes_cannot_be_opened()),
        ),
        trial(
            "reads_files_held_elsewhere_while_an_object_store_fails",
            || Box::pin(reads_files_held_elsewhere_while_an_object_store_fails()),
        ),
        trial(
            "reads_a_file_again_when_its_type_is_corrected_after_its_attempts_ran_out",
            || Box::pin(reads_a_file_again_when_its_type_is_corrected_after_its_attempts_ran_out()),
        ),
        trial("leaves_a_file_with_no_copy_until_its_bytes_change", || {
            Box::pin(leaves_a_file_with_no_copy_until_its_bytes_change())
        }),
        trial(
            "does_not_run_again_at_once_for_files_it_handed_back",
            || Box::pin(does_not_run_again_at_once_for_files_it_handed_back()),
        ),
        trial(
            "reads_the_files_around_an_object_that_will_not_open",
            || Box::pin(reads_the_files_around_an_object_that_will_not_open()),
        ),
        trial("reads_the_files_behind_objects_that_will_not_open", || {
            Box::pin(reads_the_files_behind_objects_that_will_not_open())
        }),
        trial(
            "reads_a_file_again_when_its_bytes_are_uploaded_again",
            || Box::pin(reads_a_file_again_when_its_bytes_are_uploaded_again()),
        ),
        trial(
            "reads_a_file_again_when_its_store_is_attached_again",
            || Box::pin(reads_a_file_again_when_its_store_is_attached_again()),
        ),
        trial("leaves_a_disabled_sweep_with_its_files_waiting", || {
            Box::pin(leaves_a_disabled_sweep_with_its_files_waiting())
        }),
    ];
    #[cfg(feature = "native")]
    let trials = {
        let mut trials = trials;
        trials.push(trial(
            "reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on",
            || Box::pin(reads_a_picture_for_its_size_and_again_for_its_words_once_ocr_is_on()),
        ));
        trials.push(trial("counts_a_damaged_picture_when_ocr_is_on", || {
            Box::pin(counts_a_damaged_picture_when_ocr_is_on())
        }));
        trials
    };
    libtest_mimic::run(&arguments, trials).exit();
}
