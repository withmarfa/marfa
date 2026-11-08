//! The MCP endpoint: who may call it, what a call writes and how a confirmation is spent.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::listening::Peer;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const CALLER: &str = "203.0.113.9:4000";

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    headers: HeaderMap,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
    }
}

fn from(address: &str, mut request: Request<Body>) -> Request<Body> {
    let address: SocketAddr = address.parse().unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(Peer(Some(address.ip()))));
    request
}

fn request(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let sent = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    from(CALLER, sent)
}

impl Instance {
    async fn start(extra: &[(&str, &str)]) -> Instance {
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
        ];
        pairs.extend_from_slice(extra);
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            public: public(app.clone()),
            control: control(app.clone()),
            app,
        }
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.control, request(method, path, None, body)).await
    }

    async fn key(&self, grants: Value) -> String {
        let mut body = json!({ "label": "agent", "source": "agent", "permissions": [] });
        body.as_object_mut()
            .unwrap()
            .extend(grants.as_object().unwrap().clone());
        let minted = self.local(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn writer(&self) -> String {
        self.key(json!({ "type_permissions": { "*": "write" } }))
            .await
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.public, request(method, path, Some(token), body)).await
    }

    async fn audited(&self, action: &str) -> Vec<Value> {
        let path = format!("/audit?action={action}");
        let page = self.local(Method::GET, &path, None).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.body);
        page.body["data"].as_array().unwrap().clone()
    }
}

#[tokio::test]
async fn a_direct_write_records_the_address_it_came_from_and_no_via() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let made = instance
        .call(
            &token,
            Method::POST,
            "/items",
            Some(json!({ "type": "core.note", "properties": { "body": "direct" } })),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let entries = instance.audited("item.create").await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["client_ip"], "203.0.113.9");
    assert!(entries[0]["details"].get("via").is_none());
}
