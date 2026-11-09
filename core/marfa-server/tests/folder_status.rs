//! A sign-in holds at most sixteen reported copies of a folder, and the reports of a removed key go with it.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const MOST: usize = 16;
const DAY_MS: u64 = 86_400_000;

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        app.clock.pause(true);
        Instance {
            dir,
            control: control(app.clone()),
            public: public(app.clone()),
            app,
        }
    }

    async fn send(doors: &Router, request: axum::http::request::Builder, body: Value) -> Reply {
        let request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = doors.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    async fn key(&self, label: &str) -> (String, String) {
        let body = json!({
            "label": label,
            "source": label,
            "type_permissions": { "system.folder": "write" },
        });
        let request = Request::builder().method(Method::POST).uri("/keys");
        let minted = Instance::send(&self.control, request, body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        let text = |name: &str| minted.body[name].as_str().unwrap().to_string();
        (text("id"), text("key"))
    }

    async fn call(&self, key: &str, method: Method, path: &str, body: Value) -> Reply {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {key}"));
        Instance::send(&self.public, request, body).await
    }

    async fn folder(&self, key: &str) -> String {
        let made = self
            .call(key, Method::POST, "/folders", json!({ "title": "Copies" }))
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn report(&self, key: &str, folder: &str, copy: &str, sequence: u64) -> Reply {
        let body = json!({
            "folder_store_id": copy,
            "sequence": sequence,
            "last_success_at": null,
            "pending_uploads": 1,
            "pending_downloads": 0,
            "paused_removals": 0,
            "first_sync_waiting": false,
            "problems": [],
        });
        let path = format!("/folders/{folder}/status");
        self.call(key, Method::PUT, &path, body).await
    }

    async fn copies(&self, key: &str, folder: &str) -> Vec<Vec<String>> {
        let path = format!("/folders/{folder}/status");
        let read = self.call(key, Method::GET, &path, Value::Null).await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.text);
        read.body["sign_ins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| {
                let mut named: Vec<String> = group["copies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|copy| copy["folder_store_id"].as_str().unwrap().to_string())
                    .collect();
                named.sort();
                named
            })
            .collect()
    }

    fn count(&self, sql: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn tick(&self) {
        self.app.clock.advance(1).unwrap();
    }
}

fn names(copies: &[usize]) -> Vec<String> {
    let mut named: Vec<String> = copies.iter().map(|n| format!("copy-{n:02}")).collect();
    named.sort();
    named
}

#[tokio::test]
async fn a_seventeenth_copy_replaces_the_least_recently_reported() {
    let instance = Instance::start().await;
    let (_, key) = instance.key("reporter").await;
    let folder = instance.folder(&key).await;
    for n in 0..MOST {
        let sent = instance.report(&key, &folder, &names(&[n])[0], 1).await;
        assert_eq!(sent.status, StatusCode::OK, "{}", sent.text);
        instance.tick();
    }
    let all: Vec<usize> = (0..MOST).collect();
    assert_eq!(instance.copies(&key, &folder).await, vec![names(&all)]);

    let sent = instance.report(&key, &folder, "copy-16", 1).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.text);
    assert_eq!(sent.body["accepted"], true);
    let mut kept: Vec<usize> = (1..=MOST).collect();
    assert_eq!(instance.copies(&key, &folder).await, vec![names(&kept)]);

    instance.tick();
    let again = instance.report(&key, &folder, "copy-01", 2).await;
    assert_eq!(again.body["accepted"], true, "{}", again.text);
    instance.tick();
    let sent = instance.report(&key, &folder, "copy-17", 1).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.text);
    kept.retain(|n| *n != 2);
    kept.push(17);
    assert_eq!(instance.copies(&key, &folder).await, vec![names(&kept)]);
}

#[tokio::test]
async fn a_report_for_a_held_copy_replaces_none_and_the_limit_is_per_sign_in_and_folder() {
    let instance = Instance::start().await;
    let (_, key) = instance.key("reporter").await;
    let (_, other) = instance.key("other").await;
    let folder = instance.folder(&key).await;
    let elsewhere = instance.folder(&key).await;
    for n in 0..MOST {
        instance.report(&key, &folder, &names(&[n])[0], 1).await;
        instance.tick();
    }
    let all: Vec<usize> = (0..MOST).collect();

    let newer = instance.report(&key, &folder, "copy-00", 2).await;
    assert_eq!(newer.body["accepted"], true, "{}", newer.text);
    let stale = instance.report(&key, &folder, "copy-05", 1).await;
    assert_eq!(stale.body["accepted"], false, "{}", stale.text);
    assert_eq!(instance.copies(&key, &folder).await, vec![names(&all)]);

    for n in 0..MOST {
        let sent = instance.report(&key, &elsewhere, &names(&[n])[0], 1).await;
        assert_eq!(sent.status, StatusCode::OK, "{}", sent.text);
        let sent = instance.report(&other, &folder, &names(&[n])[0], 1).await;
        assert_eq!(sent.status, StatusCode::OK, "{}", sent.text);
    }
    assert_eq!(instance.copies(&key, &folder).await.len(), 2);
    assert_eq!(
        instance.count("SELECT count(*) FROM folder_status"),
        3 * MOST as i64
    );
}

#[tokio::test]
async fn copies_reported_in_one_instant_replace_the_last_by_copy_id() {
    let instance = Instance::start().await;
    let (_, key) = instance.key("reporter").await;
    let folder = instance.folder(&key).await;
    for n in 0..MOST {
        instance.report(&key, &folder, &names(&[n])[0], 1).await;
    }
    instance.report(&key, &folder, "copy-99", 1).await;
    let mut kept: Vec<usize> = (0..MOST - 1).collect();
    kept.push(99);
    assert_eq!(instance.copies(&key, &folder).await, vec![names(&kept)]);
}

#[tokio::test]
async fn a_removed_key_takes_its_reports_and_no_other_sign_ins() {
    let instance = Instance::start().await;
    let (ended, ended_key) = instance.key("ended").await;
    let (_, kept_key) = instance.key("kept").await;
    let folder = instance.folder(&kept_key).await;
    instance.report(&ended_key, &folder, "copy-00", 1).await;
    instance.report(&kept_key, &folder, "copy-00", 1).await;
    let revoked = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/keys/{ended}"));
    let revoked = Instance::send(&instance.control, revoked, Value::Null).await;
    assert!(revoked.status.is_success(), "{}", revoked.text);

    let run = |name: &str| {
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/housekeeping/{name}/run"));
        Instance::send(&instance.control, request, json!({}))
    };
    instance.app.clock.advance(29 * DAY_MS).unwrap();
    assert_eq!(run("revoked-key-reap").await.body["result"]["deleted"], 0);
    assert_eq!(instance.count("SELECT count(*) FROM folder_status"), 2);

    instance.app.clock.advance(2 * DAY_MS).unwrap();
    assert_eq!(run("revoked-key-reap").await.body["result"]["deleted"], 1);
    assert_eq!(instance.count("SELECT count(*) FROM folder_status"), 1);
    assert_eq!(
        instance.count(&format!(
            "SELECT count(*) FROM folder_status WHERE sign_in_id = '{ended}'"
        )),
        0
    );
}
