//! A view saved before app items were hidden lists none of them when it is read.

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

    fn rewrite_view_types(&self, id: &str, types: &Value) {
        let file = self.dir.path().join("marfa.db");
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        let changed = db
            .execute(
                "UPDATE items SET properties = jsonb_set(properties, '$.query.types', jsonb(?2)) WHERE id = ?1",
                rusqlite::params![id, types.to_string()],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }
}

#[tokio::test]
async fn a_view_saved_to_list_an_app_type_lists_no_app_item() {
    let instance = Instance::start().await;
    for id in ["app.acme.setting", "user.probe"] {
        let declared = json!({ "id": id, "fields": { "name": { "type": "string" } } });
        instance
            .local(Method::POST, "/types", Some(declared))
            .await
            .landed(StatusCode::CREATED);
    }
    let hidden = instance
        .item(json!({ "type": "app.acme.setting", "properties": { "name": "an app's own" } }))
        .await;
    let shown = instance
        .item(json!({ "type": "user.probe", "properties": { "name": "a person's" } }))
        .await;
    let made = instance
        .call(
            Method::POST,
            "/views",
            Some(json!({ "title": "probes", "query": { "types": ["user.probe"] } })),
        )
        .await;
    let view = made.landed(StatusCode::CREATED)["item"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let listed = instance
        .call(Method::GET, &format!("/views/{view}/items"), None)
        .await;
    let ids = |reply: &Reply| -> Vec<String> {
        reply.landed(StatusCode::OK)["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(ids(&listed), vec![shown.clone()], "the witness is listed");

    instance.rewrite_view_types(&view, &json!(["app.acme.setting", "user.probe"]));
    let after = instance
        .call(Method::GET, &format!("/views/{view}/items"), None)
        .await;
    assert_eq!(ids(&after), vec![shown], "{hidden} is not listed");
}
