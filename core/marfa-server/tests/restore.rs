//! What a restore does past its answer: files read from a slow object store, and the database
//! log it leaves behind.

#[allow(dead_code)]
mod fake_s3;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

use fake_s3::{FakeS3, Mode};

const BUCKET: &str = "restore-bucket";

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
    writer: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    bytes: Vec<u8>,
}

impl Instance {
    async fn start(more: &[(String, String)]) -> Instance {
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
        pairs.extend(
            more.iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            control: control(app.clone()),
            public: public(app.clone()),
            app,
            dir,
            writer: String::new(),
        };
        let body = json!({
            "label": "writer",
            "source": "writer",
            "permissions": ["blobs.manage"],
            "type_permissions": { "*": "write" },
        });
        let minted = instance.json(Method::POST, "/keys", body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.writer = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn send(&self, method: Method, path: &str, body: Body, kind: &str) -> Reply {
        call(&self.control, None, method, path, body, kind).await
    }

    /// A request on the public door under the instance's own key.
    async fn keyed(&self, method: Method, path: &str, body: Body, kind: &str) -> Reply {
        let key = Some(self.writer.as_str());
        call(&self.public, key, method, path, body, kind).await
    }

    async fn write(&self, path: &str, body: Value) -> Reply {
        let body = Body::from(body.to_string());
        self.keyed(Method::POST, path, body, "application/json")
            .await
    }

    async fn json(&self, method: Method, path: &str, body: Value) -> Reply {
        self.send(
            method,
            path,
            Body::from(body.to_string()),
            "application/json",
        )
        .await
    }

    async fn restore(&self, archive: Vec<u8>) -> Reply {
        self.send(
            Method::POST,
            "/restore",
            Body::from(archive),
            "application/x-tar",
        )
        .await
    }

    async fn archive(&self, query: &str) -> Vec<u8> {
        let exported = self
            .keyed(
                Method::GET,
                &format!("/export?format=archive{query}"),
                Body::empty(),
                "application/json",
            )
            .await;
        assert_eq!(exported.status, StatusCode::OK);
        exported.bytes
    }

    fn log_size(&self) -> u64 {
        std::fs::metadata(self.dir.path().join("marfa.db-wal"))
            .map(|held| held.len())
            .unwrap_or(0)
    }
}

async fn call(
    router: &Router,
    key: Option<&str>,
    method: Method,
    path: &str,
    body: Body,
    kind: &str,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, kind);
    if let Some(key) = key {
        request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        bytes,
    }
}

fn s3_settings(s3: &FakeS3) -> Vec<(String, String)> {
    s3.settings(BUCKET, "blobs")
}

fn hash_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_taken_from_the_object_store_may_take_longer_than_the_check_while_it_keeps_arriving()
{
    let s3 = FakeS3::start().await;
    let origin = Instance::start(&s3_settings(&s3)).await;
    let bytes: Vec<u8> = (0..65_536u32).map(|at| (at % 251) as u8).collect();
    let stored = origin
        .send(
            Method::POST,
            "/blobs",
            Body::from(bytes.clone()),
            "text/plain",
        )
        .await;
    assert_eq!(stored.status, StatusCode::CREATED, "{}", stored.body);
    let hash = hash_of(&bytes);
    let item = json!({ "type": "core.file", "properties": { "blob_ref": hash, "mime_type": "text/plain" } });
    let made = origin.write("/items", item).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let run = origin
        .json(Method::POST, "/housekeeping/blob-replicate/run", json!({}))
        .await;
    assert_eq!(run.body["result"]["copied"], 1, "{}", run.body);
    let archive = origin.archive("&files=false").await;

    let fresh = Instance::start(&s3_settings(&s3)).await;
    fresh
        .app
        .faults
        .set("store-check-deadline", Some("1500"))
        .unwrap();
    // Three pieces a second apart: no gap reaches the check, the whole read outlasts it.
    s3.set_mode(Mode::Trickle(3));
    let began = Instant::now();
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert!(began.elapsed() > Duration::from_millis(1500));
    assert_eq!(restored.body["blobs_missing"], json!([]));
    s3.set_mode(Mode::Normal);
    let read = fresh
        .send(
            Method::GET,
            &format!("/blobs/{hash}"),
            Body::empty(),
            "application/json",
        )
        .await;
    assert_eq!(read.status, StatusCode::OK);
    assert!(read.bytes == bytes);
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let began = Instant::now();
    while !done() {
        assert!(began.elapsed() < Duration::from_secs(10), "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_restore_leaves_the_database_log_emptied_once_it_has_committed() {
    let origin = Instance::start(&[]).await;
    let notes: Vec<Value> = (0..2_000)
        .map(|at| json!({ "type": "core.note", "properties": { "body": format!("note {at} {}", "words ".repeat(40)) } }))
        .collect();
    for page in notes.chunks(500) {
        let written = origin.write("/items/bulk", json!({ "items": page })).await;
        assert!(written.status.is_success(), "{}", written.body);
    }
    let archive = origin.archive("").await;

    let fresh = Instance::start(&[]).await;
    let restored = fresh.restore(archive).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["imported"], 2_000);
    // The witness that the log held the restore: the database file has grown past it.
    let database = std::fs::metadata(fresh.dir.path().join("marfa.db")).unwrap();
    assert!(database.len() > 1_000_000, "{}", database.len());
    wait_for("the log was never emptied", || fresh.log_size() == 0);
    assert!(Path::new(&fresh.dir.path().join("marfa.db-wal")).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_keeps_an_ordered_table_in_its_order_from_its_answer_on() {
    let source = Instance::start(&[]).await;
    let made = source
        .write(
            "/items",
            json!({ "type": "core.conversation", "properties": {} }),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let id = made.body["item"]["id"].as_str().unwrap().to_string();
    let ids: Vec<String> = (0..40).map(|_| uuid::Uuid::now_v7().to_string()).collect();
    let operations: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(at, row)| {
            let minute = (at * 17) % 40;
            json!({ "op": "put", "id": row, "values": {
                "author": "ada", "sent_at": format!("2026-01-01T10:{minute:02}:00+01:00") } })
        })
        .collect();
    let written = source
        .write(
            &format!("/items/{id}/tables/messages/rows"),
            json!({ "operations": operations }),
        )
        .await;
    assert_eq!(written.status, StatusCode::OK, "{}", written.body);
    let mut by_sent: Vec<(usize, String)> = ids
        .iter()
        .enumerate()
        .map(|(at, row)| ((at * 17) % 40, row.clone()))
        .collect();
    by_sent.sort();
    let by_sent: Vec<String> = by_sent.into_iter().map(|(_, row)| row).collect();

    let destination = Instance::start(&[]).await;
    let restored = destination.restore(source.archive("").await).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["rows_imported"], 40);

    let db = rusqlite::Connection::open(destination.dir.path().join("marfa.db")).unwrap();
    let ordered_by: Option<String> = db
        .query_row(
            "SELECT ordered_by FROM table_summaries WHERE table_name = 'messages'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ordered_by.as_deref(), Some("datetime:sent_at"));
    let kept: Vec<String> = db
        .prepare("SELECT id FROM table_rows ORDER BY ord, id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(kept, by_sent);
    let marks: Vec<i64> = db
        .prepare("SELECT DISTINCT batch FROM table_rows")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(marks, [0]);
}
