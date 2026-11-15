//! Emptying the bin: what the answer counts and what it reports as failed.

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

struct Instance {
    dir: TempDir,
    _app: Arc<App>,
    public: Router,
    control: Router,
    owner: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn landed(&self, status: StatusCode) -> &Value {
        assert_eq!(self.status, status, "{}", self.text);
        &self.body
    }
}

async fn send(
    router: Router,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Reply {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    };
    let response = router.oneshot(request.unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    Reply {
        status,
        body: serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
    }
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
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            _app: app,
            dir,
            owner: String::new(),
        };
        let grants = json!({
            "label": "owner",
            "source": "owner",
            "permissions": ["items.purge", "schema.write"],
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
            "metadata_permissions": { "edge_types": "write" },
        });
        let minted = send(
            instance.control.clone(),
            None,
            Method::POST,
            "/keys",
            Some(grants),
        )
        .await;
        instance.owner = minted.landed(StatusCode::CREATED)["key"]
            .as_str()
            .unwrap()
            .to_string();
        instance
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(self.public.clone(), Some(&self.owner), method, path, body).await
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(self.control.clone(), None, method, path, body).await
    }

    async fn item(&self, body: Value) -> String {
        let made = self.call(Method::POST, "/items", Some(body)).await;
        made.landed(StatusCode::CREATED)["item"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn note(&self, tags: &[&str]) -> String {
        self.item(json!({ "type": "core.note", "properties": { "body": "a note" }, "tags": tags }))
            .await
    }

    async fn edge(&self, source: &str, target: &str, edge_type: &str) {
        let body = json!({ "source_id": source, "target_id": target, "edge_type": edge_type });
        self.call(Method::POST, "/edges", Some(body))
            .await
            .landed(StatusCode::CREATED);
    }

    async fn bin(&self, id: &str) {
        self.call(Method::DELETE, &format!("/items/{id}"), None)
            .await
            .landed(StatusCode::OK);
    }

    async fn empty(&self) -> Value {
        self.local(Method::POST, "/trash/empty", None)
            .await
            .landed(StatusCode::OK)
            .clone()
    }

    fn count(&self, sql: &str) -> i64 {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }
}

#[tokio::test]
async fn an_empty_bin_empties_to_nothing_and_reports_nothing() {
    let instance = Instance::start().await;
    let kept = instance.note(&[]).await;
    let answer = instance.empty().await;
    assert_eq!(
        answer,
        json!({ "purged": 0, "failures": [], "next_cursor": null })
    );
    let state = format!("SELECT count(*) FROM items WHERE id = '{kept}' AND state = 'active'");
    assert_eq!(instance.count(&state), 1);
}

#[tokio::test]
async fn a_host_in_the_bin_with_its_part_counts_both_and_reports_no_failure() {
    let instance = Instance::start().await;
    let part = instance.note(&[]).await;
    let host = instance.note(&[]).await;
    let other = instance.note(&[]).await;
    instance.edge(&part, &host, "comments-on").await;
    instance.bin(&host).await;
    instance.bin(&other).await;
    let binned = "SELECT count(*) FROM items WHERE state = 'trashed'";
    assert_eq!(instance.count(binned), 3);

    let answer = instance.empty().await;
    assert_eq!(
        answer,
        json!({ "purged": 3, "failures": [], "next_cursor": null })
    );
    assert_eq!(instance.count("SELECT count(*) FROM items"), 0);
    assert_eq!(instance.count("SELECT count(*) FROM edges"), 0);
}

const LEDGER: &str = "user.ledger";

impl Instance {
    async fn ledger_type(&self) {
        let declared = json!({
            "id": LEDGER,
            "fields": { "title": { "type": "string" } },
            "tables": { "lines": { "columns": { "memo": { "type": "string" } } } },
        });
        self.local(Method::POST, "/types", Some(declared))
            .await
            .landed(StatusCode::CREATED);
    }

    async fn ledger(&self, tags: &[&str]) -> String {
        let body = json!({ "type": LEDGER, "properties": { "title": "Ledger" }, "tags": tags });
        let id = self.item(body).await;
        let rows = json!({ "operations": [{ "op": "put", "values": { "memo": "one" } }] });
        self.call(
            Method::POST,
            &format!("/items/{id}/tables/lines/rows"),
            Some(rows),
        )
        .await
        .landed(StatusCode::OK);
        id
    }

    async fn file(&self) -> String {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/blobs")
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.owner))
            .body(Body::from("a file in the bin"))
            .unwrap();
        let response = self.public.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let hash = serde_json::from_slice::<Value>(&bytes).unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string();
        self.item(json!({
            "type": "core.file",
            "properties": { "blob_ref": hash, "mime_type": "text/plain" },
        }))
        .await
    }

    async fn revise(&self, id: &str, body: &str) {
        let change = json!({ "version": 1, "properties": { "body": body } });
        self.call(Method::PATCH, &format!("/items/{id}"), Some(change))
            .await
            .landed(StatusCode::OK);
    }
}

#[tokio::test]
async fn a_bin_of_hosts_and_parts_with_edges_versions_tags_rows_and_files_counts_every_item() {
    let instance = Instance::start().await;
    instance.ledger_type().await;
    let file_part = instance.file().await;
    let note_part = instance.note(&["red", "blue"]).await;
    let host = instance.ledger(&["green"]).await;
    let second_host = instance.note(&["red"]).await;
    let lone = instance.note(&[]).await;
    let kept = instance.note(&["red"]).await;
    instance.revise(&note_part, "second").await;
    instance.edge(&file_part, &host, "comments-on").await;
    instance.edge(&note_part, &host, "comments-on").await;
    instance.edge(&note_part, &second_host, "references").await;
    instance.edge(&lone, &kept, "references").await;
    for id in [&host, &second_host, &lone] {
        instance.bin(id).await;
    }
    let binned = "SELECT count(*) FROM items WHERE state = 'trashed'";
    assert_eq!(instance.count(binned), 5);
    let before = instance.count("SELECT count(*) FROM items");

    let answer = instance.empty().await;
    let after = instance.count("SELECT count(*) FROM items");
    let removed = before - after;
    assert_eq!(answer["failures"], json!([]), "{answer}");
    assert_eq!(answer["purged"], json!(removed), "{answer}");
    assert_eq!(removed, 5);
    for gone in [&host, &file_part, &note_part, &second_host, &lone] {
        let sql = format!("SELECT count(*) FROM items WHERE id = '{gone}'");
        assert_eq!(instance.count(&sql), 0, "{gone}");
    }
    let sql = format!("SELECT count(*) FROM items WHERE id = '{kept}' AND state = 'active'");
    assert_eq!(instance.count(&sql), 1);
    assert_eq!(instance.count("SELECT count(*) FROM edges"), 0);
    let versions = instance.count("SELECT count(*) FROM item_versions");
    let kept_versions = format!("SELECT count(*) FROM item_versions WHERE id = '{kept}'");
    assert_eq!(versions, instance.count(&kept_versions));
    assert_eq!(instance.count("SELECT count(*) FROM item_tags"), 1);
    assert_eq!(instance.count("SELECT count(*) FROM table_summaries"), 0);
}

#[tokio::test]
async fn a_part_the_bin_lists_after_its_host_is_not_counted_twice_or_reported() {
    let instance = Instance::start().await;
    let host = instance.note(&[]).await;
    let part = instance.note(&[]).await;
    instance.edge(&part, &host, "comments-on").await;
    instance.bin(&host).await;
    let answer = instance.empty().await;
    assert_eq!(
        answer,
        json!({ "purged": 2, "failures": [], "next_cursor": null })
    );
    assert_eq!(instance.count("SELECT count(*) FROM items"), 0);
}

#[tokio::test]
async fn an_item_another_request_removes_while_the_bin_empties_is_not_a_failure() {
    let instance = Instance::start().await;
    let later = instance.note(&[]).await;
    let first = instance.note(&[]).await;
    instance.bin(&first).await;
    instance.bin(&later).await;
    let file = instance.dir.path().join("marfa.db");
    let db = Connection::open(file).unwrap();
    db.execute_batch(&format!(
        "CREATE TRIGGER vanish AFTER DELETE ON items WHEN old.id = '{first}' BEGIN \
         DELETE FROM item_versions WHERE id = '{later}'; \
         DELETE FROM items WHERE id = '{later}'; END;"
    ))
    .unwrap();
    drop(db);

    let answer = instance.empty().await;
    assert_eq!(answer["failures"], json!([]), "{answer}");
    assert_eq!(answer["purged"], json!(1), "{answer}");
    assert_eq!(instance.count("SELECT count(*) FROM items"), 0);
}
