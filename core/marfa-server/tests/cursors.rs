//! Every listing pages with a cursor only it issued.

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

const ABSENT: &str = "01a1bf41-0000-7000-8000-000000000000";

struct Instance {
    _dir: TempDir,
    _app: Arc<App>,
    public: Router,
    control: Router,
    key: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

async fn send(router: &Router, token: Option<&str>, method: Method, path: &str, body: Option<Value>) -> Reply {
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
    let response = router.clone().oneshot(request.unwrap()).await.unwrap();
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
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            _app: app,
            _dir: dir,
            key: String::new(),
        };
        let grants = json!({
            "label": "writer",
            "source": "writer",
            "permissions": ["items.purge", "schema.write", "webhooks.manage"],
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
        });
        let minted = send(&instance.control, None, Method::POST, "/keys", Some(grants)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        instance.key = minted.body["key"].as_str().unwrap().to_string();
        instance
    }

    async fn write(&self, method: Method, path: &str, body: Value) -> Value {
        let reply = send(&self.public, Some(&self.key), method, path, Some(body)).await;
        assert!(reply.status.is_success(), "{path}: {}", reply.text);
        reply.body
    }

    async fn note(&self, body: &str) -> String {
        let made = self
            .write(
                Method::POST,
                "/items",
                json!({ "type": "core.note", "properties": { "body": body } }),
            )
            .await;
        made["item"]["id"].as_str().unwrap().to_string()
    }

    /// The owner's listings on the private socket, and the rest with the key.
    async fn list(&self, path: &str) -> Reply {
        let local = ["/items/summaries", "/trash", "/folders", "/audit", "/connectors/"];
        let keyed = !local.iter().any(|door| path.starts_with(door));
        let token = keyed.then_some(self.key.as_str());
        let router = if keyed { &self.public } else { &self.control };
        let method = if path.starts_with("/trash/empty") {
            Method::POST
        } else {
            Method::GET
        };
        send(router, token, method, path, None).await
    }
}

fn id_in(made: &Value) -> String {
    [&made["id"], &made["item"]["id"], &made["view"]["id"], &made["webhook"]["id"]]
        .into_iter()
        .find_map(Value::as_str)
        .unwrap_or_else(|| panic!("no id in {made}"))
        .to_string()
}

fn with_cursor(path: &str, cursor: &str) -> String {
    let joint = if path.contains('?') { '&' } else { '?' };
    format!("{path}{joint}cursor={cursor}")
}

#[tokio::test]
async fn every_listing_refuses_a_cursor_another_listing_issued() {
    let instance = Instance::start().await;
    let mut notes = Vec::new();
    for at in 0..3 {
        notes.push(instance.note(&format!("findable note {at}")).await);
    }
    let first = &notes[0];
    for version in 1..3 {
        let body = json!({ "properties": { "body": format!("findable again {version}") }, "version": version });
        instance.write(Method::PATCH, &format!("/items/{first}"), body).await;
    }
    for target in &notes[1..] {
        let edge = json!({ "source_id": first, "target_id": target, "edge_type": "about" });
        instance.write(Method::POST, "/edges", edge).await;
    }
    let other = instance.note("another source").await;
    let edge = json!({ "source_id": other, "target_id": &notes[1], "edge_type": "about" });
    instance.write(Method::POST, "/edges", edge).await;
    for _ in 0..2 {
        let binned = instance.note("binned").await;
        let path = format!("/items/summaries/{binned}/trash?version=1");
        let moved = send(&instance.control, None, Method::POST, &path, None).await;
        assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    }
    for title in ["one", "two"] {
        instance.write(Method::POST, "/folders", json!({ "title": title, "include": [] })).await;
    }
    let view = instance.write(Method::POST, "/views", json!({ "title": "every note" })).await;
    let view = id_in(&view);
    let hook = json!({ "url": "http://127.0.0.1:9/hook", "events": ["item.created"] });
    let hook = instance.write(Method::POST, "/webhooks", hook).await;
    let hook = id_in(&hook);

    let issuing = [
        ("items", "/items?limit=1".to_string()),
        ("search", "/search?q=findable&limit=1".to_string()),
        ("versions", format!("/items/{first}/versions?limit=1")),
        ("edges", "/edges?limit=1".to_string()),
        ("outbound", format!("/items/{first}/edges?limit=1")),
        ("backrefs", format!("/items/{}/backrefs?limit=1", notes[1])),
        ("summaries", "/items/summaries?limit=1".to_string()),
        ("bin", "/trash?limit=1".to_string()),
        ("audit", "/audit?limit=1".to_string()),
        ("folders", "/folders?limit=1".to_string()),
        ("view", format!("/views/{view}/items?limit=1")),
    ];
    let mut issued = Vec::new();
    for (name, path) in &issuing {
        let page = instance.list(path).await;
        assert_eq!(page.status, StatusCode::OK, "{name}: {}", page.text);
        let cursor = page.body["next_cursor"]
            .as_str()
            .unwrap_or_else(|| panic!("{name} gave no cursor: {}", page.text))
            .to_string();
        let next = instance.list(&with_cursor(path, &cursor)).await;
        assert_eq!(next.status, StatusCode::OK, "{name} continues: {}", next.text);
        issued.push((*name, cursor));
    }

    let mut taking: Vec<(&str, String)> = issuing.to_vec();
    taking.extend([
        ("bin selection", "/trash/empty".to_string()),
        ("deliveries", format!("/webhooks/{hook}/deliveries?limit=1")),
        ("runs", format!("/connectors/{ABSENT}/runs?limit=1")),
        ("agreements", format!("/connectors/{ABSENT}/agreements?limit=1")),
        ("inbound", format!("/connectors/{ABSENT}/deliveries?limit=1")),
    ]);
    let mut taken = Vec::new();
    for (name, path) in &taking {
        for (from, cursor) in &issued {
            if from == name || (*name == "bin selection" && *from == "bin") {
                continue;
            }
            let refused = instance.list(&with_cursor(path, cursor)).await;
            let answer = (
                refused.status,
                refused.body["error"]["code"].as_str(),
                refused.body["error"]["details"]["field"].as_str(),
            );
            if answer != (StatusCode::BAD_REQUEST, Some("validation_error"), Some("cursor")) {
                taken.push(format!("{name} given a cursor from {from}: {}", refused.text));
            }
        }
    }
    assert!(taken.is_empty(), "{}", taken.join("\n"));
}
