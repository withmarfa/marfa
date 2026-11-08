//! The overview's folders and its text cut on characters.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    dir: TempDir,
    public: Router,
    control: Router,
    app: Arc<App>,
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
    async fn open(dir: TempDir) -> Instance {
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            dir,
            public: public(app.clone()),
            control: control(app.clone()),
            app,
        }
    }

    async fn key(&self, body: Value) -> String {
        let (status, minted) = send(
            &self.control,
            request(Method::POST, "/keys", None, Some(body)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        minted["key"].as_str().unwrap().to_string()
    }

    async fn call(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send(&self.public, request(method, path, Some(token), body)).await
    }

    async fn overview(&self, token: &str) -> Value {
        let (status, body) = self.call(token, Method::GET, "/overview", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Folders are stored items, so each view is copied as one.
    async fn views_as_folders(self) -> Instance {
        self.app.db.close().await;
        let Instance { dir, .. } = self;
        let connection = rusqlite::Connection::open(dir.path().join("marfa.db")).unwrap();
        let columns: Vec<String> = connection
            .prepare("SELECT name FROM pragma_table_info('items') WHERE name NOT IN ('seq', 'id', 'type')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let list = columns.join(", ");
        connection
            .execute(
                &format!(
                    "INSERT INTO items (id, type, {list}) \
                     SELECT 'folder-' || id, 'system.folder', {list} FROM items WHERE type = 'system.view'"
                ),
                [],
            )
            .unwrap();
        drop(connection);
        Instance::open(dir).await
    }
}

async fn widest(instance: &Instance) -> String {
    instance
        .key(json!({
            "label": "wide", "source": "wide", "permissions": [],
            "type_permissions": { "*": "read" },
        }))
        .await
}

#[tokio::test]
async fn a_title_is_cut_on_characters_not_bytes_or_utf16_units() {
    let instance = Instance::open(TempDir::new().unwrap()).await;
    let writer = instance
        .key(json!({
            "label": "writer", "source": "writer", "permissions": [],
            "type_permissions": { "*": "write" },
        }))
        .await;
    let exactly = "é".repeat(100);
    let over = "😀".repeat(101);
    for title in [&exactly, &over] {
        let (status, body) = instance
            .call(
                &writer,
                Method::POST,
                "/views",
                Some(json!({ "title": title })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let answer = instance.overview(&writer).await;
    let titles: Vec<&str> = answer["views"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles[0], exactly);
    assert_eq!(titles[1].chars().count(), 100);
    assert_eq!(titles[1], format!("{}\u{2026}", "😀".repeat(99)));
}

#[tokio::test]
async fn folders_are_listed_by_title_cut_at_their_cap_and_hidden_from_a_key_that_cannot_read_them()
{
    let instance = Instance::open(TempDir::new().unwrap()).await;
    let writer = instance
        .key(json!({
            "label": "writer", "source": "writer", "permissions": [],
            "type_permissions": { "*": "write" },
        }))
        .await;
    for at in (0..32).rev() {
        let (status, body) = instance
            .call(
                &writer,
                Method::POST,
                "/views",
                Some(json!({ "title": format!("{at:02} folder") })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let instance = instance.views_as_folders().await;

    let answer = instance.overview(&writer).await;
    let folders = answer["folders"].as_array().unwrap();
    assert_eq!(folders.len(), 30);
    assert_eq!(folders[0]["title"], "00 folder");
    assert_eq!(folders[29]["title"], "29 folder");
    assert_eq!(answer["truncated"]["folders"], 32);
    assert_eq!(answer["truncated"]["views"], 32);

    let notes_only = instance
        .key(json!({
            "label": "notes", "source": "notes", "permissions": [],
            "type_permissions": { "core.note": "read" },
        }))
        .await;
    let narrow = instance.overview(&notes_only).await;
    assert!(narrow.get("folders").is_none() && narrow.get("views").is_none());
    assert!(narrow.get("truncated").is_none());

    let only_folders = instance
        .key(json!({
            "label": "folders", "source": "folders", "permissions": [],
            "type_permissions": { "system.folder": "read" },
        }))
        .await;
    let answer = instance.overview(&only_folders).await;
    assert_eq!(answer["folders"].as_array().unwrap().len(), 30);
    assert!(answer.get("views").is_none() && answer.get("types").is_none());
}

#[tokio::test]
async fn an_empty_instance_lists_its_types_with_no_items_and_leaves_the_rest_out() {
    let instance = Instance::open(TempDir::new().unwrap()).await;
    let wide = widest(&instance).await;
    let answer = instance.overview(&wide).await;
    assert_eq!(answer["total"], 0);
    let types = answer["types"].as_array().unwrap();
    assert!(types.iter().all(|entry| entry["count"] == 0));
    assert!(
        types
            .windows(2)
            .all(|pair| pair[0]["id"].as_str() < pair[1]["id"].as_str())
    );
    for absent in ["tags", "views", "folders"] {
        assert!(answer.get(absent).is_none(), "{absent}");
    }
}
