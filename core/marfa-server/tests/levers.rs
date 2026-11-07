//! The enforcement levers as a caller meets them: set through `/config` or on a
//! key, and holding from the next request. The contract's fixtures hold the rest.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::{App, stored};
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    /// The sources of the rows a listing answers, in its order.
    fn sources(&self) -> Vec<String> {
        self.body["data"]
            .as_array()
            .unwrap_or_else(|| panic!("no data: {}", self.text))
            .iter()
            .map(|row| {
                let item = row.get("item").unwrap_or(row);
                item["source"].as_str().unwrap().to_string()
            })
            .collect()
    }
}

fn note(extra: Value) -> Value {
    let mut body = json!({ "type": "core.note", "properties": { "body": "text" } });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}

fn undeclared() -> Value {
    json!({ "type": "core.note", "properties": { "body": "text", "not_declared": "x" } })
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = vec![
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            control: control(app.clone()),
            public: public(app.clone()),
            app,
        }
    }

    async fn send(
        &self,
        doors: &Router,
        mut builder: axum::http::request::Builder,
        body: Option<Value>,
    ) -> Reply {
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = doors
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    /// What the private local command is answered.
    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let builder = Request::builder().method(method).uri(path);
        self.send(&self.control, builder, body).await
    }

    async fn call(&self, key: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        let builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {key}"));
        self.send(&self.public, builder, body).await
    }

    async fn key(&self, source: &str, extra: Value) -> String {
        let mut body = json!({
            "label": source,
            "source": source,
            "type_permissions": { "*": "write" },
        });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let minted = self.local(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn levers(&self, enforcement: Value) {
        let body = json!({ "enforcement": enforcement });
        let set = self.local(Method::PATCH, "/config", Some(body)).await;
        assert_eq!(set.status, StatusCode::OK, "{}", set.text);
    }

    async fn create(&self, key: &str, body: Value) -> Reply {
        self.call(key, Method::POST, "/items", Some(body)).await
    }

    async fn made(&self, key: &str, body: Value) -> String {
        let made = self.create(key, body).await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn strict_mode_set_on_the_instance_holds_the_next_write_and_lifts_with_it() {
    let instance = Instance::start().await;
    let key = instance.key("writer", json!({})).await;
    let id = instance.made(&key, undeclared()).await;

    instance
        .levers(json!({ "strict_mode": { "types": ["core.note"] } }))
        .await;
    let refused = instance.create(&key, undeclared()).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.code(), "invalid_properties");
    assert_eq!(refused.body["error"]["details"]["code"], "unknown_property");

    let patch = json!({ "version": 1, "properties": { "not_declared": "y" } });
    let update = instance
        .call(&key, Method::PATCH, &format!("/items/{id}"), Some(patch))
        .await;
    assert_eq!(update.code(), "invalid_properties", "{}", update.text);

    let bulk = json!({ "items": [undeclared(), note(json!({}))], "atomic": false });
    let page = instance
        .call(&key, Method::POST, "/items/bulk", Some(bulk))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    assert_eq!(page.body["counts"]["errored"], 1, "{}", page.text);
    assert_eq!(
        page.body["results"][0]["error"]["code"],
        "invalid_properties"
    );

    instance.levers(Value::Null).await;
    let lifted = instance.create(&key, undeclared()).await;
    assert_eq!(lifted.status, StatusCode::CREATED, "{}", lifted.text);
}

#[tokio::test]
async fn a_key_s_lever_replaces_the_instance_s_and_one_it_leaves_out_falls_to_it() {
    let instance = Instance::start().await;
    let plain = instance.key("plain", json!({})).await;
    let loosened = instance
        .key(
            "loosened",
            json!({ "enforcement_override": { "strict_mode": { "types": [] } } }),
        )
        .await;
    let tightened = instance
        .key(
            "tightened",
            json!({ "enforcement_override": { "strict_mode": { "types": ["core.bookmark"] } } }),
        )
        .await;
    instance
        .levers(json!({
            "strict_mode": { "types": ["core.note"] },
            "source_allowlist": { "types": ["core.task"], "sources": ["plain"] },
        }))
        .await;

    let held = instance.create(&plain, undeclared()).await;
    assert_eq!(held.status, StatusCode::BAD_REQUEST, "{}", held.text);
    for key in [&loosened, &tightened] {
        let free = instance.create(key, undeclared()).await;
        assert_eq!(free.status, StatusCode::CREATED, "{}", free.text);
    }
    let own = json!({
        "type": "core.bookmark",
        "properties": { "url": "https://example.com", "not_declared": "x" },
    });
    let tight = instance.create(&tightened, own.clone()).await;
    assert_eq!(tight.code(), "invalid_properties", "{}", tight.text);
    let wide = instance.create(&plain, own).await;
    assert_eq!(wide.status, StatusCode::CREATED, "{}", wide.text);

    let task = json!({ "type": "core.task", "properties": { "title": "t" } });
    let fallen = instance.create(&loosened, task).await;
    assert_eq!(fallen.status, StatusCode::FORBIDDEN, "{}", fallen.text);
    assert_eq!(fallen.body["error"]["details"]["allowed"], json!(["plain"]));
    assert_eq!(fallen.body["error"]["details"]["source"], "loosened");
}

#[tokio::test]
async fn a_key_changed_while_the_instance_holds_it_takes_the_next_request() {
    let instance = Instance::start().await;
    let key = instance.key("writer", json!({})).await;
    instance
        .levers(json!({ "strict_mode": { "types": ["core.note"] } }))
        .await;
    assert_eq!(
        instance.create(&key, undeclared()).await.status,
        StatusCode::BAD_REQUEST
    );

    let listed = instance.local(Method::GET, "/keys", None).await;
    let id = listed.body["data"][0]["id"].as_str().unwrap().to_string();
    let body = json!({ "enforcement_override": { "strict_mode": { "types": [] } } });
    let path = format!("/keys/{id}");
    let changed = instance.local(Method::PATCH, &path, Some(body)).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text);
    assert_eq!(
        instance.create(&key, undeclared()).await.status,
        StatusCode::CREATED
    );

    let body = json!({ "enforcement_override": null });
    instance.local(Method::PATCH, &path, Some(body)).await;
    assert_eq!(
        instance.create(&key, undeclared()).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn the_source_filter_narrows_what_a_key_lists_and_leaves_a_read_by_id() {
    let instance = Instance::start().await;
    let shown = instance.key("shown", json!({})).await;
    let hidden = instance.key("hidden", json!({})).await;
    let wide = instance
        .key(
            "wide",
            json!({
                "enforcement_override": {
                    "source_filter": { "types": [], "sources": [] },
                },
            }),
        )
        .await;
    let needle = note(json!({ "properties": { "body": "needle" } }));
    instance.made(&shown, needle.clone()).await;
    let left_out = instance.made(&hidden, needle).await;

    let reads = ["/items", "/search?q=needle"];
    for path in reads {
        let all = instance.call(&shown, Method::GET, path, None).await;
        assert_eq!(all.sources().len(), 2, "{path}: {}", all.text);
    }

    instance
        .levers(json!({
            "source_filter": { "types": ["core.note"], "sources": ["shown"] },
        }))
        .await;
    for path in reads {
        let narrowed = instance.call(&shown, Method::GET, path, None).await;
        assert_eq!(narrowed.sources(), ["shown"], "{path}: {}", narrowed.text);
        let free = instance.call(&wide, Method::GET, path, None).await;
        assert_eq!(free.sources().len(), 2, "{path}: {}", free.text);
    }

    let by_id = instance
        .call(&shown, Method::GET, &format!("/items/{left_out}"), None)
        .await;
    assert_eq!(by_id.status, StatusCode::OK, "{}", by_id.text);
}

#[tokio::test]
async fn the_local_command_lists_and_acts_on_only_what_the_filter_admits() {
    let instance = Instance::start().await;
    let shown = instance.key("shown", json!({})).await;
    let hidden = instance.key("hidden", json!({})).await;
    instance.made(&shown, note(json!({}))).await;
    instance.made(&hidden, note(json!({}))).await;
    let binned = instance.made(&shown, note(json!({}))).await;
    let kept_out = instance.made(&hidden, note(json!({}))).await;
    for id in [&binned, &kept_out] {
        let path = format!("/items/summaries/{id}/trash?version=1");
        let moved = instance.local(Method::POST, &path, None).await;
        assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    }
    let bin = instance.local(Method::GET, "/trash", None).await;
    assert_eq!(bin.sources().len(), 2, "{}", bin.text);

    instance
        .levers(json!({
            "source_filter": { "types": ["core.note"], "sources": ["shown"] },
        }))
        .await;
    let summaries = instance.local(Method::GET, "/items/summaries", None).await;
    assert_eq!(summaries.sources(), ["shown"], "{}", summaries.text);
    let bin = instance.local(Method::GET, "/trash", None).await;
    assert_eq!(bin.sources(), ["shown"], "{}", bin.text);

    let version = bin.body["data"][0]["version"].as_i64().unwrap();
    let path = format!("/items/summaries/{binned}/restore?version={version}");
    let admitted = instance.local(Method::POST, &path, None).await;
    assert_eq!(admitted.status, StatusCode::OK, "{}", admitted.text);

    for act in ["restore", "purge"] {
        let path = format!("/items/summaries/{kept_out}/{act}?version={version}");
        let refused = instance.local(Method::POST, &path, None).await;
        assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
    }
    instance.levers(Value::Null).await;
    let bin = instance.local(Method::GET, "/trash", None).await;
    assert_eq!(bin.sources(), ["hidden"], "{}", bin.text);
}

#[tokio::test]
async fn a_row_that_does_not_read_holds_every_type_until_config_replaces_it() {
    let instance = Instance::start().await;
    let key = instance.key("writer", json!({})).await;
    instance.made(&key, note(json!({}))).await;
    instance
        .app
        .db
        .write(Write::own(), |tx| {
            stored::put(tx, "enforcement", "{ this is not a lever")
        })
        .await
        .unwrap();

    let refused = instance.create(&key, note(json!({}))).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    let listed = instance.call(&key, Method::GET, "/items", None).await;
    assert!(listed.sources().is_empty(), "{}", listed.text);

    instance
        .levers(json!({ "strict_mode": { "types": [] } }))
        .await;
    let written = instance.create(&key, note(json!({}))).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);
    let listed = instance.call(&key, Method::GET, "/items", None).await;
    assert_eq!(listed.sources().len(), 2, "{}", listed.text);
}
