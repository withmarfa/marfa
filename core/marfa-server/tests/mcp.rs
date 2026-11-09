//! The MCP endpoint: who may call it, what a call writes and how a confirmation is spent.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
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
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
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
        self.key_with_id(grants).await.0
    }

    async fn key_with_id(&self, grants: Value) -> (String, String) {
        static KEYS: AtomicUsize = AtomicUsize::new(0);
        let source = format!("agent-{}", KEYS.fetch_add(1, Ordering::Relaxed));
        let mut body = json!({ "label": "agent", "source": source, "permissions": [] });
        body.as_object_mut()
            .unwrap()
            .extend(grants.as_object().unwrap().clone());
        let minted = self.local(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        (
            minted.body["key"].as_str().unwrap().to_string(),
            minted.body["id"].as_str().unwrap().to_string(),
        )
    }

    async fn writer(&self) -> String {
        self.key(json!({ "type_permissions": { "*": "write" } }))
            .await
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.public, request(method, path, Some(token), body)).await
    }

    async fn stored(&self, settings: Value) {
        let patched = self.local(Method::PATCH, "/config", Some(settings)).await;
        assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
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

fn rpc_request(
    path: &str,
    token: Option<&str>,
    headers: &[(&str, &str)],
    body: &Value,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    from(CALLER, builder.body(Body::from(body.to_string())).unwrap())
}

fn message(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn modern(params: Value) -> Value {
    let mut params = params;
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    params
}

/// What a tool answered: its payload, or the error it gave.
struct Tool {
    failed: bool,
    value: Value,
}

impl Tool {
    fn code(&self) -> &str {
        self.value["error"]["code"].as_str().unwrap_or("")
    }

    fn payload(&self) -> &Value {
        assert!(!self.failed, "{}", self.value);
        &self.value
    }
}

impl Instance {
    async fn rpc(&self, token: Option<&str>, headers: &[(&str, &str)], body: Value) -> Reply {
        self.rpc_at("/mcp", token, headers, body).await
    }

    async fn rpc_at(
        &self,
        path: &str,
        token: Option<&str>,
        headers: &[(&str, &str)],
        body: Value,
    ) -> Reply {
        send(&self.public, rpc_request(path, token, headers, &body)).await
    }

    async fn tool(&self, token: &str, name: &str, arguments: Value) -> Tool {
        self.tool_at("/mcp", token, name, arguments).await
    }

    async fn tool_at(&self, path: &str, token: &str, name: &str, arguments: Value) -> Tool {
        let sent = message(
            1,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        let reply = self.rpc_at(path, Some(token), &[], sent).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        let result = &reply.body["result"];
        assert!(result.is_object(), "{}", reply.body);
        if result["isError"] == true {
            let text = result["content"][0]["text"].as_str().unwrap();
            return Tool {
                failed: true,
                value: serde_json::from_str(text).unwrap(),
            };
        }
        Tool {
            failed: false,
            value: result["structuredContent"].clone(),
        }
    }

    async fn names(&self, token: &str) -> Vec<String> {
        self.names_at("/mcp", token).await
    }

    async fn names_at(&self, path: &str, token: &str) -> Vec<String> {
        let listed = self
            .rpc_at(path, Some(token), &[], message(2, "tools/list", json!({})))
            .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect()
    }

    async fn note(&self, token: &str, body: &str) -> Tool {
        self.tool(
            token,
            "marfa_create",
            json!({ "type": "core.note", "properties": { "body": body } }),
        )
        .await
    }
}

impl Instance {
    /// Posts `text` as it is written, so a number keeps the digits the client sent.
    async fn raw(&self, token: &str, text: &str) -> Reply {
        self.raw_at("/mcp", token, text).await
    }

    async fn raw_at(&self, path: &str, token: &str, text: &str) -> Reply {
        let request = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(text.to_string()))
            .unwrap();
        send(&self.public, from(CALLER, request)).await
    }

    async fn raw_tool(&self, token: &str, name: &str, arguments: &str) -> Tool {
        self.raw_tool_at("/mcp", token, name, arguments).await
    }

    async fn raw_tool_at(&self, path: &str, token: &str, name: &str, arguments: &str) -> Tool {
        let text = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}","arguments":{arguments}}}}}"#
        );
        let reply = self.raw_at(path, token, &text).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        let result = &reply.body["result"];
        assert!(result.is_object(), "{}", reply.body);
        if result["isError"] == true {
            let text = result["content"][0]["text"].as_str().unwrap();
            return Tool {
                failed: true,
                value: serde_json::from_str(text).unwrap(),
            };
        }
        Tool {
            failed: false,
            value: result["structuredContent"].clone(),
        }
    }
}

#[tokio::test]
async fn a_number_the_rest_api_refuses_is_refused_by_the_tools_and_never_rounded() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let big = "18446744073709551617";
    let rest = instance
        .call(
            &token,
            Method::POST,
            "/items",
            Some(json!({ "type": "core.note", "properties": { "body": "x" } })),
        )
        .await;
    assert_eq!(rest.status, StatusCode::CREATED, "{}", rest.body);
    let raw_rest = Request::builder()
        .method(Method::POST)
        .uri("/items")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(format!(
            r#"{{"type":"core.note","properties":{{"body":"x","n":{big}}}}}"#
        )))
        .unwrap();
    let refused_rest = send(&instance.public, from(CALLER, raw_rest)).await;
    assert_eq!(
        refused_rest.code(),
        "invalid_properties",
        "{}",
        refused_rest.body
    );

    let created = instance
        .raw_tool(
            &token,
            "marfa_create",
            &format!(r#"{{"type":"core.note","properties":{{"body":"x","n":{big}}}}}"#),
        )
        .await;
    assert_eq!(created.code(), "invalid_properties", "{}", created.value);
    let listed = instance
        .call(&token, Method::GET, "/items?type=core.note", None)
        .await;
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(1));

    let id = rest.body["item"]["id"].as_str().unwrap();
    let updated = instance
        .raw_tool(
            &token,
            "marfa_update",
            &format!(r#"{{"id":"{id}","version":1,"properties":{{"n":{big}}}}}"#),
        )
        .await;
    assert_eq!(updated.code(), "invalid_properties", "{}", updated.value);
    // The witnesses: digits a float keeps, and the same number as a string, are saved as sent.
    let kept = instance
        .raw_tool(
            &token,
            "marfa_update",
            &format!(r#"{{"id":"{id}","version":1,"properties":{{"n":18446744073709552000,"s":"{big}"}}}}"#),
        )
        .await;
    assert!(!kept.failed, "{}", kept.value);
    let read = instance
        .call(&token, Method::GET, &format!("/items/{id}"), None)
        .await;
    assert_eq!(read.body["item"]["properties"]["s"], big);
}

#[tokio::test]
async fn a_body_that_is_not_one_json_message_is_answered_in_json_rpc_at_every_depth_of_failure() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let deep = format!("{}1{}", "[".repeat(80), "]".repeat(80));
    let lone = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":"\ud800"}}"#;
    for (name, text, code) in [
        ("not JSON", "{".to_string(), -32700),
        ("a lone surrogate", lone.to_string(), -32700),
        (
            "nested too deep",
            format!(r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"a":{deep}}}}}"#),
            -32600,
        ),
        ("an array", "[]".to_string(), -32600),
        ("not a message", r#"{"a":1}"#.to_string(), -32600),
    ] {
        let reply = instance.raw(&token, &text).await;
        assert_eq!(
            reply.status,
            StatusCode::BAD_REQUEST,
            "{name}: {}",
            reply.body
        );
        assert_eq!(reply.body["jsonrpc"], "2.0", "{name}: {}", reply.body);
        assert_eq!(reply.body["error"]["code"], code, "{name}: {}", reply.body);
        assert!(reply.body["id"].is_null(), "{name}");
    }
    // The witness: the same lone surrogate to a door that is not MCP keeps the server's own refusal.
    let other = Request::builder()
        .method(Method::POST)
        .uri("/items")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            r#"{"type":"core.note","properties":{"body":"\ud800"}}"#,
        ))
        .unwrap();
    let refused = send(&instance.public, from(CALLER, other)).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert!(
        refused.body["error"]["code"].is_string(),
        "{}",
        refused.body
    );
}

#[tokio::test]
async fn a_credential_that_reaches_no_type_is_offered_no_tools_and_no_capability() {
    let instance = Instance::start(&[]).await;
    let none = instance
        .key(json!({ "permissions": ["webhooks.manage"], "type_permissions": {} }))
        .await;
    assert!(instance.names(&none).await.is_empty());
    let started = instance
        .rpc(
            Some(&none),
            &[],
            message(1, "initialize", json!({ "protocolVersion": "2025-11-25" })),
        )
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.body);
    assert!(
        started.body["result"]["capabilities"]
            .get("tools")
            .is_none()
    );
    let discovered = instance
        .rpc(
            Some(&none),
            &[
                ("mcp-protocol-version", "2026-07-28"),
                ("mcp-method", "server/discover"),
            ],
            message(3, "server/discover", modern(json!({}))),
        )
        .await;
    assert_eq!(discovered.status, StatusCode::OK, "{}", discovered.body);
    assert!(
        discovered.body["result"]["capabilities"]
            .get("tools")
            .is_none()
    );
    // The witness: a credential that reaches a type is offered tools and declares them.
    let reader = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    assert_eq!(
        instance.names(&reader).await,
        ["marfa_overview", "marfa_find", "marfa_get"]
    );
    let started = instance
        .rpc(
            Some(&reader),
            &[],
            message(1, "initialize", json!({ "protocolVersion": "2025-11-25" })),
        )
        .await;
    assert!(
        started.body["result"]["capabilities"]
            .get("tools")
            .is_some()
    );
}

#[tokio::test]
async fn a_request_from_a_foreign_origin_is_refused_403_before_its_credential_is_read() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let own = instance.app.addresses().sign_in().origin().to_string();
    let ping = message(1, "ping", json!({}));
    let foreign = instance
        .rpc(
            Some(&token),
            &[("origin", "https://evil.example")],
            ping.clone(),
        )
        .await;
    assert_eq!(foreign.status, StatusCode::FORBIDDEN, "{}", foreign.body);
    assert_eq!(foreign.code(), "forbidden");
    let nameless = instance
        .rpc(None, &[("origin", "https://evil.example")], ping.clone())
        .await;
    assert_eq!(nameless.status, StatusCode::FORBIDDEN);
    // The witnesses: this instance's own origin, and no origin at all, are answered.
    for origin in [Some(own.as_str()), None] {
        let headers: Vec<(&str, &str)> = origin.map(|o| ("origin", o)).into_iter().collect();
        let answered = instance.rpc(Some(&token), &headers, ping.clone()).await;
        assert_eq!(answered.status, StatusCode::OK, "{}", answered.body);
    }
}

#[tokio::test]
async fn a_call_with_no_credential_is_challenged_with_the_resource_metadata() {
    let instance = Instance::start(&[]).await;
    let ping = message(1, "ping", json!({}));
    for token in [None, Some("mfa_not-a-key")] {
        let refused = instance.rpc(token, &[], ping.clone()).await;
        assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{}", refused.body);
        let challenge = refused.headers["www-authenticate"].to_str().unwrap();
        let origin = instance.app.addresses().sign_in().origin().to_string();
        assert_eq!(
            challenge,
            format!(
                "Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\""
            )
        );
        assert_eq!(refused.code(), "unauthorized");
    }
}

#[tokio::test]
async fn the_endpoint_answers_post_and_nothing_else() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    for method in [Method::GET, Method::DELETE] {
        let refused = instance.call(&token, method, "/mcp", None).await;
        assert_eq!(refused.status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(refused.headers["allow"], "POST");
    }
    let listening = instance
        .rpc(
            Some(&token),
            &[
                ("mcp-protocol-version", "2026-07-28"),
                ("mcp-method", "subscriptions/listen"),
            ],
            message(7, "subscriptions/listen", modern(json!({}))),
        )
        .await;
    assert_eq!(listening.status, StatusCode::OK, "{}", listening.body);
    assert_eq!(listening.body["error"]["code"], -32601);
    assert_eq!(listening.body["id"], 7);
}

#[tokio::test]
async fn both_revisions_are_offered_the_same_tools_to_the_same_credential() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let legacy = instance.names(&token).await;
    let listed = instance
        .rpc(
            Some(&token),
            &[
                ("mcp-protocol-version", "2026-07-28"),
                ("mcp-method", "tools/list"),
            ],
            message(4, "tools/list", modern(json!({}))),
        )
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let modern: Vec<String> = listed.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(legacy, modern);
    assert_eq!(
        legacy,
        [
            "marfa_overview",
            "marfa_find",
            "marfa_get",
            "marfa_create",
            "marfa_update",
            "marfa_delete"
        ]
    );
    assert_eq!(listed.body["result"]["resultType"], "complete");
    for tool in listed.body["result"]["tools"].as_array().unwrap() {
        let open_world = tool["annotations"]["openWorldHint"] == true;
        assert_eq!(open_world, tool["name"] == "marfa_create", "{tool}");
    }
}

#[tokio::test]
async fn saving_finding_reading_editing_and_deleting_through_the_tools_is_audited_as_mcp() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let made = instance.note(&token, "buy oat milk on friday").await;
    let id = made.payload()["id"].as_str().unwrap().to_string();
    assert_eq!(made.payload()["version"], 1);

    let found = instance
        .tool(&token, "marfa_find", json!({ "query": "oat milk" }))
        .await;
    assert_eq!(found.payload()["items"][0]["id"], id.as_str());

    let read = instance
        .tool(&token, "marfa_get", json!({ "ids": [id.clone()] }))
        .await;
    assert_eq!(
        read.payload()["items"][0]["properties"]["body"],
        "buy oat milk on friday"
    );

    let stale = instance
        .tool(
            &token,
            "marfa_update",
            json!({ "id": id, "version": 7, "properties": { "body": "late" } }),
        )
        .await;
    assert!(stale.failed);
    assert_eq!(stale.code(), "version_conflict");
    assert_eq!(stale.value["error"]["current"]["version"], 1);

    let edited = instance
        .tool(
            &token,
            "marfa_update",
            json!({ "id": id, "version": 1, "properties": { "body": "oat milk and eggs" } }),
        )
        .await;
    assert_eq!(edited.payload()["version"], 2);

    let preview = instance
        .tool(&token, "marfa_delete", json!({ "ids": [id.clone()] }))
        .await;
    let confirm = preview.payload()["confirm"].as_str().unwrap().to_string();
    let still = instance
        .tool(&token, "marfa_get", json!({ "ids": [id.clone()] }))
        .await;
    assert_eq!(still.payload()["items"][0]["state"], "active");
    let deleted = instance
        .tool(
            &token,
            "marfa_delete",
            json!({ "ids": [id.clone()], "confirm": confirm }),
        )
        .await;
    assert_eq!(deleted.payload()["trashed"][0], id.as_str());

    for action in ["item.create", "item.update", "items.trash"] {
        let entries = instance.audited(action).await;
        assert_eq!(entries.len(), 1, "{action}");
        assert_eq!(entries[0]["details"]["via"], "mcp", "{action}");
        assert_eq!(entries[0]["client_ip"], "203.0.113.9", "{action}");
        assert!(entries[0]["key_id"].is_string(), "{action}");
    }
}

#[tokio::test]
async fn an_argument_the_tool_does_not_take_is_an_error_naming_it() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let refused = instance
        .tool(&token, "marfa_find", json!({ "quary": "oat" }))
        .await;
    assert!(refused.failed);
    assert_eq!(refused.code(), "validation_error");
    assert!(
        refused.value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("quary")
    );
}

/// Previews the deletion of `ids` and returns the token that confirms it.
async fn preview(instance: &Instance, token: &str, ids: &[&str]) -> String {
    let shown = instance
        .tool(token, "marfa_delete", json!({ "ids": ids }))
        .await;
    shown.payload()["confirm"].as_str().unwrap().to_string()
}

async fn state_of(instance: &Instance, token: &str, id: &str) -> String {
    let read = instance
        .tool(token, "marfa_get", json!({ "ids": [id] }))
        .await;
    read.payload()["items"][0]["state"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_confirmation_works_once_and_a_second_use_says_so_without_trashing_again() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let id = instance.note(&token, "once").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let confirm = preview(&instance, &token, &[&id]).await;
    let confirmed = json!({ "ids": [id.clone()], "confirm": confirm });

    let first = instance
        .tool(&token, "marfa_delete", confirmed.clone())
        .await;
    assert_eq!(first.payload()["trashed"][0], id.as_str());
    assert!(first.payload().get("already_trashed").is_none());

    // Restoring the item makes an unsafe replay observable.
    let restored = instance
        .tool(
            &token,
            "marfa_update",
            json!({ "id": id, "state": "active", "version": 1 }),
        )
        .await;
    assert!(!restored.failed, "{}", restored.value);
    assert_eq!(state_of(&instance, &token, &id).await, "active");

    let again = instance.tool(&token, "marfa_delete", confirmed).await;
    assert_eq!(again.payload()["already_trashed"], true);
    assert_eq!(state_of(&instance, &token, &id).await, "active");
    assert_eq!(instance.audited("items.trash").await.len(), 1);
}

#[tokio::test]
async fn a_confirmation_sent_by_another_credential_changes_nothing() {
    let instance = Instance::start(&[]).await;
    let (owner, other) = (instance.writer().await, instance.writer().await);
    let id = instance.note(&owner, "mine").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let confirm = preview(&instance, &owner, &[&id]).await;
    let refused = instance
        .tool(
            &other,
            "marfa_delete",
            json!({ "ids": [id.clone()], "confirm": confirm.clone() }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert!(refused.value["error"]["confirm"].is_string());
    assert_eq!(state_of(&instance, &owner, &id).await, "active");
    // The witness: the credential it was issued to spends it.
    let spent = instance
        .tool(
            &owner,
            "marfa_delete",
            json!({ "ids": [id], "confirm": confirm }),
        )
        .await;
    assert!(!spent.failed, "{}", spent.value);
}

#[tokio::test]
async fn a_confirmation_sent_after_five_minutes_changes_nothing() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let id = instance.note(&token, "late").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let confirm = preview(&instance, &token, &[&id]).await;
    instance.app.clock.advance(5 * 60_000 + 1).unwrap();
    let refused = instance
        .tool(
            &token,
            "marfa_delete",
            json!({ "ids": [id.clone()], "confirm": confirm }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert!(
        refused.value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expired")
    );
    assert_eq!(state_of(&instance, &token, &id).await, "active");
    // The witness: a fresh confirmation from the new preview works.
    let fresh = refused.value["error"]["confirm"].as_str().unwrap();
    let spent = instance
        .tool(
            &token,
            "marfa_delete",
            json!({ "ids": [id], "confirm": fresh }),
        )
        .await;
    assert!(!spent.failed, "{}", spent.value);
}

#[tokio::test]
async fn a_confirmation_that_expires_while_the_write_waits_changes_nothing() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let id = instance.note(&token, "waits").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let confirm = preview(&instance, &token, &[&id]).await;
    instance
        .app
        .faults
        .set("hold:write", Some("items.trash"))
        .unwrap();
    let confirming = instance.tool(
        &token,
        "marfa_delete",
        json!({ "ids": [id.clone()], "confirm": confirm }),
    );
    let expiring = async {
        for _ in 0..500 {
            if instance.app.faults.list().iter().any(|f| f.waiting > 0) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        instance.app.clock.advance(5 * 60_000 + 1).unwrap();
        instance.app.faults.clear(Some("hold:write"));
    };
    let (refused, ()) = tokio::join!(confirming, expiring);
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(state_of(&instance, &token, &id).await, "active");
    // The witness: the same wait inside the five minutes still trashes.
    let confirm = preview(&instance, &token, &[&id]).await;
    instance
        .app
        .faults
        .set("hold:write", Some("items.trash"))
        .unwrap();
    let confirming = instance.tool(
        &token,
        "marfa_delete",
        json!({ "ids": [id.clone()], "confirm": confirm }),
    );
    let waiting = async {
        for _ in 0..500 {
            if instance.app.faults.list().iter().any(|f| f.waiting > 0) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        instance.app.faults.clear(Some("hold:write"));
    };
    let (done, ()) = tokio::join!(confirming, waiting);
    assert!(!done.failed, "{}", done.value);
}

#[tokio::test]
async fn a_confirmation_does_not_cover_other_items_than_the_ones_it_previewed() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let first = instance.note(&token, "first").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let second = instance.note(&token, "second").await.payload()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let confirm = preview(&instance, &token, &[&first]).await;
    let refused = instance
        .tool(
            &token,
            "marfa_delete",
            json!({ "ids": [second.clone()], "confirm": confirm }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert_eq!(state_of(&instance, &token, &second).await, "active");
}

#[tokio::test]
async fn a_trash_plan_that_grows_between_the_check_and_the_commit_trashes_nothing() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
        }))
        .await;
    instance
        .local(
            Method::POST,
            "/edge-types",
            Some(json!({
                "id": "user.owns",
                "label": "Owns",
                "cardinality": "many-to-many",
                "cascade_on_delete": "cascade",
            })),
        )
        .await;
    let mut ids = Vec::new();
    for body in ["owner", "owned", "latecomer"] {
        ids.push(
            instance.note(&token, body).await.payload()["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    let link = |source: &str, target: &str| json!({ "source_id": source, "target_id": target, "edge_type": "user.owns" });
    let made = instance
        .call(&token, Method::POST, "/edges", Some(link(&ids[0], &ids[1])))
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let confirm = preview(&instance, &token, &[&ids[0]]).await;

    instance
        .app
        .faults
        .set("hold:write", Some("items.trash"))
        .unwrap();
    let confirming = instance.tool(
        &token,
        "marfa_delete",
        json!({ "ids": [ids[0].clone()], "confirm": confirm }),
    );
    let growing = async {
        for _ in 0..500 {
            if instance.app.faults.list().iter().any(|f| f.waiting > 0) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let grown = instance
            .call(&token, Method::POST, "/edges", Some(link(&ids[0], &ids[2])))
            .await;
        assert_eq!(grown.status, StatusCode::CREATED, "{}", grown.body);
        instance.app.faults.clear(Some("hold:write"));
    };
    let (refused, ()) = tokio::join!(confirming, growing);
    assert!(refused.failed);
    assert_eq!(refused.code(), "trash_plan_changed");
    for id in &ids {
        assert_eq!(state_of(&instance, &token, id).await, "active");
    }
    // The witness: a confirmation of the grown plan trashes all three.
    let confirm = preview(&instance, &token, &[&ids[0]]).await;
    let done = instance
        .tool(
            &token,
            "marfa_delete",
            json!({ "ids": [ids[0].clone()], "confirm": confirm }),
        )
        .await;
    assert_eq!(done.payload()["total"], 3);
}

/// A web server on this machine that answers each path as a fetch's failure needs.
struct Files {
    port: u16,
    arrived: Arc<AtomicUsize>,
    release: Arc<Notify>,
}

async fn files() -> Files {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let arrived = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let (counted, freed) = (arrived.clone(), release.clone());
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            let freed = freed.clone();
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut chunk = [0u8; 1024];
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => seen.extend_from_slice(&chunk[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&seen);
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let whole = |body: &str| {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                match path.split('?').next().unwrap_or("/") {
                    "/hello" => {
                        let _ = stream.write_all(whole("hello").as_bytes()).await;
                    }
                    "/hold" => {
                        freed.notified().await;
                        let _ = stream.write_all(whole("hello").as_bytes()).await;
                    }
                    "/moved" => {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 302 Found\r\nLocation: /hello\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                    }
                    "/declared" => {
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(head.as_bytes()).await;
                        let _ = stream.write_all(&[b'a'; 5000]).await;
                    }
                    "/endless" => {
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n";
                        if stream.write_all(head.as_bytes()).await.is_ok() {
                            let block = [b'a'; 16 * 1024];
                            while stream.write_all(&block).await.is_ok() {}
                        }
                    }
                    "/stall" => {
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\nConnection: close\r\n\r\na";
                        let _ = stream.write_all(head.as_bytes()).await;
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    }
                    _ => {
                        let _ = stream
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                    }
                }
            });
        }
    });
    Files {
        port,
        arrived,
        release,
    }
}

const FILES_HOST: &str = "files.test";

impl Files {
    fn url(&self, path: &str) -> String {
        format!("http://{FILES_HOST}:{}{path}", self.port)
    }

    fn contacted(&self) -> usize {
        self.arrived.load(Ordering::SeqCst)
    }
}

impl Instance {
    /// Scripts DNS answers, optionally mapping them to a local test host.
    fn resolves(&self, lookups: &str) {
        self.app
            .faults
            .set(&format!("resolve:{FILES_HOST}"), Some(lookups))
            .unwrap();
    }

    fn lookups(&self) -> u32 {
        self.app
            .faults
            .list()
            .iter()
            .find(|fault| fault.name == format!("resolve:{FILES_HOST}"))
            .map_or(0, |fault| fault.fired)
    }

    async fn fetch(&self, token: &str, url: &str) -> Tool {
        self.tool(token, "marfa_create", json!({ "url": url }))
            .await
    }
}

const PUBLIC_TO_LOCAL: &str = "93.184.216.34>127.0.0.1";

#[tokio::test]
async fn a_file_is_fetched_by_address_and_saved_with_its_bytes() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    let saved = instance
        .fetch(&token, &server.url("/hello?token=secret"))
        .await;
    let file = &saved.payload()["file"];
    assert_eq!(file["size_bytes"], 5);
    assert_eq!(file["mime_type"], "text/plain");
    let hash = file["hash"].as_str().unwrap();
    let blob = instance
        .call(&token, Method::GET, &format!("/blobs/{hash}"), None)
        .await;
    assert_eq!(blob.status, StatusCode::OK);

    let entries = instance.audited("mcp.file_fetch").await;
    assert_eq!(entries.len(), 1);
    let details = entries[0]["details"].to_string();
    assert!(details.contains(FILES_HOST), "{details}");
    assert!(details.contains("\"outcome\":\"fetched\""), "{details}");
    for hidden in ["secret", "token", "/hello"] {
        assert!(!details.contains(hidden), "{hidden} in {details}");
    }
    assert_eq!(entries[0]["details"]["via"], "mcp");
}

#[tokio::test]
async fn an_address_that_is_not_public_is_not_fetched_and_nothing_connects() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let server = files().await;
    let literal = |host: &str| format!("http://{host}:{}/hello", server.port);
    let literals = [
        literal("127.0.0.1"),
        literal("[::1]"),
        literal("169.254.169.254"),
        literal("10.0.0.5"),
        literal("[fe80::1]"),
    ];
    for url in &literals {
        let refused = instance.fetch(&token, url).await;
        assert_eq!(refused.code(), "file_not_fetched", "{url}");
        assert_eq!(refused.value["error"]["reason"], "not_public", "{url}");
    }
    for answer in [
        "10.0.0.5",
        "169.254.169.254",
        "127.0.0.1",
        "93.184.216.34,10.0.0.5",
    ] {
        instance.app.faults.clear(None);
        instance.resolves(answer);
        let refused = instance.fetch(&token, &server.url("/hello")).await;
        assert_eq!(refused.value["error"]["reason"], "not_public", "{answer}");
    }
    assert_eq!(server.contacted(), 0);
    // The witness: a public answer that reaches this machine is fetched.
    instance.app.faults.clear(None);
    instance.resolves(PUBLIC_TO_LOCAL);
    assert!(!instance.fetch(&token, &server.url("/hello")).await.failed);
    assert_eq!(server.contacted(), 1);
}

#[tokio::test]
async fn a_host_that_answers_a_private_address_on_a_second_lookup_is_looked_up_once() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(&format!("{PUBLIC_TO_LOCAL};10.0.0.5>127.0.0.1"));
    let saved = instance.fetch(&token, &server.url("/hello")).await;
    assert!(!saved.failed, "{}", saved.value);
    assert_eq!(instance.lookups(), 1);
    assert_eq!(server.contacted(), 1);
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    let refused = instance.fetch(&token, &server.url("/moved")).await;
    assert_eq!(refused.code(), "file_not_fetched");
    assert_eq!(refused.value["error"]["reason"], "redirect");
    assert_eq!(server.contacted(), 1);
}

#[tokio::test]
async fn a_body_over_the_limit_is_refused_declared_or_not_and_nothing_is_stored() {
    let instance = Instance::start(&[]).await;
    instance
        .stored(json!({ "mcp_fetch_max_bytes": 1000 }))
        .await;
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    for path in ["/declared", "/endless"] {
        let refused = instance.fetch(&token, &server.url(path)).await;
        assert_eq!(refused.code(), "file_not_fetched", "{path}");
        assert_eq!(refused.value["error"]["reason"], "too_large", "{path}");
    }
    let listed = instance
        .call(&token, Method::GET, "/items?type=core.file", None)
        .await;
    assert_eq!(listed.body["data"].as_array().map(Vec::len), Some(0));
    // The witness: a body inside the limit is stored.
    assert!(!instance.fetch(&token, &server.url("/hello")).await.failed);
}

#[tokio::test]
async fn a_body_that_stops_arriving_ends_at_the_time_limit() {
    let instance = Instance::start(&[]).await;
    instance
        .stored(json!({ "mcp_fetch_timeout_ms": 400 }))
        .await;
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    let started = std::time::Instant::now();
    let refused = instance.fetch(&token, &server.url("/stall")).await;
    assert_eq!(refused.code(), "file_not_fetched");
    assert_eq!(refused.value["error"]["reason"], "timeout");
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fifth_fetch_at_once_is_refused_busy_and_the_four_finish() {
    let instance = Arc::new(Instance::start(&[]).await);
    let token = instance.writer().await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    let mut held = Vec::new();
    for _ in 0..4 {
        let (instance, token, url) = (instance.clone(), token.clone(), server.url("/hold"));
        held.push(tokio::spawn(
            async move { instance.fetch(&token, &url).await },
        ));
    }
    for _ in 0..1000 {
        if server.contacted() == 4 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(server.contacted(), 4);
    let fifth = instance.fetch(&token, &server.url("/hello")).await;
    assert_eq!(fifth.code(), "file_not_fetched");
    assert_eq!(fifth.value["error"]["reason"], "busy");
    assert_eq!(server.contacted(), 4);
    for _ in 0..4 {
        server.release.notify_one();
    }
    for fetch in held {
        let done = fetch.await.unwrap();
        assert!(!done.failed, "{}", done.value);
    }
    // The witness: the four have finished, so the next fetch is let in.
    assert!(!instance.fetch(&token, &server.url("/hello")).await.failed);
}

#[tokio::test]
async fn a_fetch_whose_key_is_revoked_while_it_runs_is_still_audited_and_stores_nothing() {
    let instance = Arc::new(Instance::start(&[]).await);
    let (token, id) = instance
        .key_with_id(json!({ "type_permissions": { "*": "write" } }))
        .await;
    let server = files().await;
    instance.resolves(PUBLIC_TO_LOCAL);
    let fetching = {
        let (instance, token, url) = (instance.clone(), token.clone(), server.url("/hold"));
        tokio::spawn(async move { instance.fetch(&token, &url).await })
    };
    for _ in 0..1000 {
        if server.contacted() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(server.contacted(), 1);
    let revoked = instance
        .local(Method::DELETE, &format!("/keys/{id}"), None)
        .await;
    assert!(revoked.status.is_success(), "{}", revoked.body);
    server.release.notify_one();
    let refused = fetching.await.unwrap();
    assert_eq!(refused.code(), "unauthorized", "{}", refused.value);
    let entries = instance.audited("mcp.file_fetch").await;
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0]["key_id"], id.as_str());
    assert_eq!(entries[0]["details"]["outcome"], "error");
    let (live, _) = instance
        .key_with_id(json!({ "type_permissions": { "*": "write" } }))
        .await;
    let stored = |instance: &Arc<Instance>, live: String| {
        let instance = instance.clone();
        async move {
            let listed = instance
                .call(&live, Method::GET, "/items?type=core.file", None)
                .await;
            listed.body["data"].as_array().map(Vec::len)
        }
    };
    assert_eq!(stored(&instance, live.clone()).await, Some(0));
    // The witness: a key that stays live is audited the same way and its file is stored.
    assert!(!instance.fetch(&live, &server.url("/hello")).await.failed);
    assert_eq!(stored(&instance, live.clone()).await, Some(1));
    assert_eq!(instance.audited("mcp.file_fetch").await.len(), 2);
}

#[tokio::test]
async fn a_chat_file_is_fetched_under_the_same_rules_and_a_switched_off_instance_refuses() {
    let instance = Instance::start(&[]).await;
    let token = instance.writer().await;
    let server = files().await;
    let chat = |url: &str| {
        json!({
            "file": { "download_url": url, "file_id": "file_1", "mime_type": "text/plain" },
        })
    };
    let private = format!("http://127.0.0.1:{}/hello", server.port);
    let refused = instance.tool(&token, "marfa_create", chat(&private)).await;
    assert_eq!(refused.value["error"]["reason"], "not_public");
    instance.resolves(PUBLIC_TO_LOCAL);
    let saved = instance
        .tool(&token, "marfa_create", chat(&server.url("/hello")))
        .await;
    assert!(!saved.failed, "{}", saved.value);
    let off = instance
        .local(
            Method::PATCH,
            "/config",
            Some(json!({ "mcp_fetch_enabled": false })),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK, "{}", off.body);
    let refused = instance
        .tool(&token, "marfa_create", chat(&server.url("/hello")))
        .await;
    assert_eq!(refused.value["error"]["reason"], "disabled");
    assert_eq!(server.contacted(), 1);
}

const SCHEMA: &str = "/mcp/schema";
const ADMIN: &str = "/mcp/admin";

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

/// The JSON-RPC error a call to a tool the credential is not offered gets.
async fn unoffered(instance: &Instance, path: &str, token: &str, name: &str, arguments: Value) {
    let sent = message(
        1,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    );
    let reply = instance.rpc_at(path, Some(token), &[], sent).await;
    assert_eq!(
        reply.body["error"]["code"], -32602,
        "{name}: {}",
        reply.body
    );
}

#[tokio::test]
async fn the_overview_is_offered_to_a_credential_that_reaches_a_type_and_tells_what_it_may_do() {
    let instance = Instance::start(&[]).await;
    let reader = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    let overview = instance.tool(&reader, "marfa_overview", json!({})).await;
    assert_eq!(overview.payload()["credential"]["kind"], "key");
    assert!(
        overview.payload()["types"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == "core.note")
    );
    let one = instance
        .tool(&reader, "marfa_overview", json!({ "type": "core.note" }))
        .await;
    assert_eq!(one.payload()["type"]["id"], "core.note");
    assert!(one.payload()["type"]["fields"]["body"].is_object());
    let none = instance
        .key(json!({ "type_permissions": {}, "permissions": ["audit.read"] }))
        .await;
    unoffered(&instance, "/mcp", &none, "marfa_overview", json!({})).await;
}

#[tokio::test]
async fn the_schema_endpoint_offers_each_tool_only_to_a_credential_that_may_use_it() {
    let instance = Instance::start(&[]).await;
    let every = ["marfa_name_source", "marfa_search_docs", "marfa_sources"];
    let with = |extra: &[&str], base: &[&str]| {
        let mut names: Vec<String> = base.iter().chain(extra).map(|n| n.to_string()).collect();
        names.sort();
        names
    };
    let reads = ["marfa_overview", "marfa_find", "marfa_get"];
    let reader = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    assert_eq!(
        sorted(instance.names_at(SCHEMA, &reader).await),
        with(&every, &reads)
    );
    let schema_writer = instance
        .key(json!({
            "type_permissions": { "core.note": "read" },
            "permissions": ["schema.write"],
        }))
        .await;
    assert_eq!(
        sorted(instance.names_at(SCHEMA, &schema_writer).await),
        with(
            &["marfa_save_type"],
            &with(&every, &reads)
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        )
    );
    let registrar = instance
        .key(json!({
            "type_permissions": { "core.note": "read" },
            "metadata_permissions": { "types": "write" },
        }))
        .await;
    assert!(
        instance
            .names_at(SCHEMA, &registrar)
            .await
            .contains(&"marfa_save_type".to_string())
    );
    let views = instance
        .key(json!({ "type_permissions": { "system.view": "write" } }))
        .await;
    let listed = instance.names_at(SCHEMA, &views).await;
    assert!(
        listed.contains(&"marfa_save_view".to_string()),
        "{listed:?}"
    );
    assert!(!listed.contains(&"marfa_save_type".to_string()));
    // The group's tools are not offered at /mcp.
    assert!(
        !instance
            .names(&schema_writer)
            .await
            .contains(&"marfa_save_type".to_string())
    );
    // A credential not offered a tool is refused when it calls it anyway.
    unoffered(
        &instance,
        SCHEMA,
        &reader,
        "marfa_save_type",
        json!({ "action": "register", "id": "user.recipe", "fields": {} }),
    )
    .await;
    unoffered(
        &instance,
        SCHEMA,
        &reader,
        "marfa_save_view",
        json!({ "title": "Mine" }),
    )
    .await;
    unoffered(
        &instance,
        "/mcp",
        &schema_writer,
        "marfa_save_type",
        json!({ "action": "register", "id": "user.recipe", "fields": {} }),
    )
    .await;
}

fn recipe() -> Value {
    json!({
        "action": "register",
        "id": "user.recipe",
        "label": "Recipe",
        "fields": { "title": { "type": "string", "required": true }, "serves": { "type": "integer" } },
    })
}

#[tokio::test]
async fn a_type_is_registered_by_a_credential_that_may_register_and_changed_only_by_schema_write() {
    let instance = Instance::start(&[]).await;
    let registrar = instance
        .key(json!({
            "type_permissions": { "user.*": "write" },
            "metadata_permissions": { "types": "write" },
        }))
        .await;
    let made = instance
        .tool_at(SCHEMA, &registrar, "marfa_save_type", recipe())
        .await;
    assert_eq!(
        made.payload()["type"]["id"],
        "user.recipe",
        "{}",
        made.value
    );
    // Without schema.write, a change that adds a required field is refused.
    let refused = instance
        .tool_at(
            SCHEMA,
            &registrar,
            "marfa_save_type",
            json!({
                "action": "change",
                "id": "user.recipe",
                "fields": { "chef": { "type": "string", "required": true } },
            }),
        )
        .await;
    assert!(refused.failed, "{}", refused.value);
    assert_eq!(refused.code(), "forbidden");
    let writer = instance
        .key(json!({
            "type_permissions": { "user.*": "write" },
            "permissions": ["schema.write"],
        }))
        .await;
    let changed = instance
        .tool_at(
            SCHEMA,
            &writer,
            "marfa_save_type",
            json!({
                "action": "change",
                "id": "user.recipe",
                "label": "Recipes",
                "fields": { "chef": { "type": "string" }, "serves": null },
            }),
        )
        .await;
    assert!(!changed.failed, "{}", changed.value);
    let fields = &changed.payload()["type"]["fields"];
    assert!(fields["chef"].is_object());
    assert!(fields["title"].is_object());
    assert!(fields.get("serves").is_none());
    assert_eq!(changed.payload()["type"]["label"], "Recipes");
    assert_eq!(instance.audited("type.register").await.len(), 1);
    assert_eq!(
        instance.audited("type.replace").await[0]["details"]["via"],
        "mcp"
    );
}

#[tokio::test]
async fn a_view_is_saved_and_changed_from_the_version_read() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({ "type_permissions": { "system.view": "write", "core.note": "read" } }))
        .await;
    let made = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_save_view",
            json!({ "title": "Notes", "query": { "types": ["core.note"] } }),
        )
        .await;
    let view = made.payload();
    assert_eq!(view["title"], "Notes", "{}", made.value);
    let (id, version) = (view["id"].as_str().unwrap(), view["version"].clone());
    let refused = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_save_view",
            json!({ "id": id, "title": "Other" }),
        )
        .await;
    assert!(refused.failed, "{}", refused.value);
    let changed = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_save_view",
            json!({ "id": id, "version": version, "title": "Other" }),
        )
        .await;
    assert_eq!(changed.payload()["title"], "Other", "{}", changed.value);
    assert_eq!(
        instance.audited("view.create").await[0]["details"]["via"],
        "mcp"
    );
}

#[tokio::test]
async fn sources_are_listed_and_named_through_the_tools() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({ "source": "agent-own", "type_permissions": { "core.note": "write" } }))
        .await;
    let named = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_name_source",
            json!({ "source": "agent-own", "name": "My agent" }),
        )
        .await;
    assert!(!named.failed, "{}", named.value);
    let read = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_sources",
            json!({ "source": "agent-own" }),
        )
        .await;
    assert_eq!(read.payload()["sources"][0]["name"], "My agent");
    let nothing = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_name_source",
            json!({ "source": "agent-own" }),
        )
        .await;
    assert!(nothing.failed);
    let other = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_name_source",
            json!({ "source": "someone-else", "name": "Mine now" }),
        )
        .await;
    assert!(other.failed, "{}", other.value);
    assert_eq!(other.code(), "forbidden");
}

#[tokio::test]
async fn the_documentation_search_names_where_to_search_and_reaches_nowhere() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    let found = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_search_docs",
            json!({ "query": "view filters" }),
        )
        .await;
    assert_eq!(found.payload()["query"], "view filters");
    assert!(
        found.payload()["search_url"]
            .as_str()
            .unwrap()
            .contains("q=view+filters")
    );
}

#[tokio::test]
async fn each_admin_tool_is_offered_only_to_a_credential_that_holds_its_permission() {
    let instance = Instance::start(&[]).await;
    let cases: [(&str, &[&str]); 7] = [
        ("instance.read", &["marfa_health"]),
        ("connectors.manage", &["marfa_health"]),
        ("audit.read", &["marfa_audit"]),
        (
            "keys.mint",
            &["marfa_keys", "marfa_manage_key", "marfa_revoke_key"],
        ),
        (
            "keys.manage",
            &["marfa_keys", "marfa_manage_key", "marfa_revoke_key"],
        ),
        (
            "webhooks.manage",
            &["marfa_webhooks", "marfa_manage_webhook"],
        ),
        ("config.manage", &[]),
    ];
    for (permission, tools) in cases {
        let token = instance
            .key(json!({ "type_permissions": {}, "permissions": [permission] }))
            .await;
        let expected: Vec<String> = sorted(tools.iter().map(|n| n.to_string()).collect());
        assert_eq!(
            sorted(instance.names_at(ADMIN, &token).await),
            expected,
            "{permission}"
        );
    }
    let nobody = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    assert_eq!(
        instance.names_at(ADMIN, &nobody).await,
        ["marfa_overview", "marfa_find", "marfa_get"]
    );
    for (name, arguments) in [
        ("marfa_health", json!({})),
        ("marfa_audit", json!({})),
        ("marfa_keys", json!({})),
        (
            "marfa_manage_key",
            json!({ "action": "make", "label": "x", "source": "x" }),
        ),
        (
            "marfa_revoke_key",
            json!({ "id": "0192e6a8-7c6e-7000-8000-000000000000" }),
        ),
        ("marfa_webhooks", json!({})),
        (
            "marfa_manage_webhook",
            json!({ "action": "delete", "id": "0192e6a8-7c6e-7000-8000-000000000000" }),
        ),
    ] {
        unoffered(&instance, ADMIN, &nobody, name, arguments).await;
    }
    // The tools of a group are not offered at /mcp.
    let admin = instance
        .key(json!({ "type_permissions": {}, "permissions": ["audit.read"] }))
        .await;
    assert!(instance.names(&admin).await.is_empty());
}

#[tokio::test]
async fn the_audit_tool_reads_the_log_newest_first_and_narrows_it() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({
            "type_permissions": { "core.note": "write" },
            "permissions": ["audit.read"],
        }))
        .await;
    instance.note(&token, "one").await;
    instance.note(&token, "two").await;
    let all = instance
        .tool_at(
            ADMIN,
            &token,
            "marfa_audit",
            json!({ "action": "item.create", "limit": 1 }),
        )
        .await;
    assert_eq!(all.payload()["entries"].as_array().unwrap().len(), 1);
    assert!(all.payload()["next_cursor"].is_string(), "{}", all.value);
    let creates = instance
        .tool_at(
            ADMIN,
            &token,
            "marfa_audit",
            json!({ "action": "item.create" }),
        )
        .await;
    assert_eq!(creates.payload()["entries"].as_array().unwrap().len(), 2);
    let silent = instance
        .tool_at(
            ADMIN,
            &token,
            "marfa_audit",
            json!({ "action": "no.such.action" }),
        )
        .await;
    assert!(silent.payload()["entries"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_key_tools_share_the_key_operations_allowance_with_the_api() {
    let instance = Instance::start(&[]).await;
    let minter = instance
        .key(json!({ "type_permissions": {}, "permissions": ["keys.mint"] }))
        .await;
    instance
        .stored(json!({ "rate_limit_enabled": true, "rate_limit_keys_requests": 1 }))
        .await;
    let direct = instance.call(&minter, Method::GET, "/keys", None).await;
    assert_eq!(direct.status, StatusCode::OK, "{}", direct.body);
    let through_tool = instance
        .tool_at(ADMIN, &minter, "marfa_keys", json!({}))
        .await;
    assert!(through_tool.failed, "{}", through_tool.value);
    assert_eq!(through_tool.code(), "rate_limited");
    assert!(through_tool.value["error"]["retry_after_seconds"].is_number());
}

#[tokio::test]
async fn the_key_tools_show_every_grant_a_key_holds() {
    let instance = Instance::start(&[]).await;
    let minter = instance
        .key(json!({
            "type_permissions": { "*": "write" },
            "edge_permissions": { "*": "write" },
            "permissions": ["keys.mint"],
        }))
        .await;
    let made = instance
        .tool_at(
            ADMIN,
            &minter,
            "marfa_manage_key",
            json!({ "action": "make", "label": "edges", "source": "edges-source",
                    "type_permissions": { "core.note": "read" },
                    "edge_permissions": { "*": "write" } }),
        )
        .await;
    assert_eq!(made.payload()["key"]["edge_permissions"]["*"], "write");
    let made_id = made.payload()["key"]["id"].as_str().unwrap().to_string();
    let listed = instance
        .tool_at(ADMIN, &minter, "marfa_keys", json!({}))
        .await;
    let shown = listed.payload()["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["id"] == made_id.as_str())
        .cloned()
        .unwrap();
    assert_eq!(shown["edge_permissions"]["*"], "write", "{shown}");
}

#[tokio::test]
async fn the_keys_tool_lists_only_the_keys_the_credential_reaches() {
    let instance = Instance::start(&[]).await;
    let (minter, minter_id) = instance
        .key_with_id(json!({
            "type_permissions": { "core.note": "read" },
            "permissions": ["keys.mint"],
        }))
        .await;
    let (_, beyond_id) = instance
        .key_with_id(json!({ "type_permissions": { "*": "write" }, "permissions": ["audit.read"] }))
        .await;
    let made = instance
        .tool_at(
            ADMIN,
            &minter,
            "marfa_manage_key",
            json!({ "action": "make", "label": "narrow", "source": "narrow-source",
                    "type_permissions": { "core.note": "read" } }),
        )
        .await;
    let made_id = made.payload()["key"]["id"].as_str().unwrap().to_string();
    assert!(made.payload()["secret"].is_string());
    let listed = instance
        .tool_at(ADMIN, &minter, "marfa_keys", json!({}))
        .await;
    let ids: Vec<&str> = listed.payload()["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&minter_id.as_str()));
    assert!(ids.contains(&made_id.as_str()));
    assert!(!ids.contains(&beyond_id.as_str()), "{ids:?}");
    for key in listed.payload()["keys"].as_array().unwrap() {
        assert!(key.get("secret").is_none() && key.get("hash").is_none());
        assert_eq!(key["yours"] == true, key["id"] == minter_id.as_str());
    }
    // A key beyond the minter's grants is neither listed nor revocable by it.
    let refused = instance
        .tool_at(
            ADMIN,
            &minter,
            "marfa_revoke_key",
            json!({ "id": beyond_id }),
        )
        .await;
    assert_eq!(refused.code(), "api_key_not_found", "{}", refused.value);
    let wider = instance
        .tool_at(
            ADMIN,
            &minter,
            "marfa_manage_key",
            json!({ "action": "make", "label": "wide", "source": "wide-source",
                    "permissions": ["audit.read"] }),
        )
        .await;
    assert!(wider.failed, "{}", wider.value);
}

#[tokio::test]
async fn a_key_is_narrowed_and_never_widened_through_the_tool() {
    let instance = Instance::start(&[]).await;
    let manager = instance
        .key(json!({ "type_permissions": {}, "permissions": ["keys.mint", "keys.manage"] }))
        .await;
    let (secret, id) = instance
        .key_with_id(json!({ "type_permissions": { "core.note": "write" } }))
        .await;
    let narrowed = instance
        .tool_at(
            ADMIN,
            &manager,
            "marfa_manage_key",
            json!({ "action": "narrow", "id": id, "type_permissions": { "core.note": "read" } }),
        )
        .await;
    assert_eq!(
        narrowed.payload()["key"]["type_permissions"]["core.note"],
        "read",
        "{}",
        narrowed.value
    );
    let widened = instance
        .tool_at(
            ADMIN,
            &manager,
            "marfa_manage_key",
            json!({ "action": "narrow", "id": id, "type_permissions": { "core.note": "write" } }),
        )
        .await;
    assert!(widened.failed, "{}", widened.value);
    let held = instance
        .call(
            &secret,
            Method::POST,
            "/items",
            Some(json!({ "type": "core.note", "properties": { "body": "x" } })),
        )
        .await;
    assert_eq!(held.status, StatusCode::FORBIDDEN, "{}", held.body);
}

#[tokio::test]
async fn the_health_tool_reports_to_a_credential_that_holds_instance_read() {
    let instance = Instance::start(&[]).await;
    let token = instance
        .key(json!({ "type_permissions": {}, "permissions": ["instance.read"] }))
        .await;
    let health = instance
        .tool_at(ADMIN, &token, "marfa_health", json!({}))
        .await;
    assert!(
        health.payload()["health"]["status"].is_string(),
        "{}",
        health.value
    );
    assert!(health.payload()["health"]["housekeeping"].is_object());
    let blind = instance
        .key(json!({ "type_permissions": {}, "permissions": ["connectors.manage"] }))
        .await;
    let basic = instance
        .tool_at(ADMIN, &blind, "marfa_health", json!({}))
        .await;
    assert!(basic.payload()["health"].get("housekeeping").is_none());
}

struct Revocable {
    admin: String,
    target_id: String,
    target: String,
}

impl Instance {
    async fn revocable(&self) -> Revocable {
        let admin = self
            .key(json!({
                "type_permissions": { "core.note": "read" },
                "permissions": ["keys.mint"],
            }))
            .await;
        let made = self
            .tool_at(
                ADMIN,
                &admin,
                "marfa_manage_key",
                json!({ "action": "make", "label": "doomed", "source": "doomed-source",
                        "type_permissions": { "core.note": "read" } }),
            )
            .await;
        Revocable {
            admin,
            target_id: made.payload()["key"]["id"].as_str().unwrap().to_string(),
            target: made.payload()["secret"].as_str().unwrap().to_string(),
        }
    }

    async fn works(&self, key: &str) -> bool {
        self.call(key, Method::GET, "/keys/current", None)
            .await
            .status
            == StatusCode::OK
    }

    async fn revoke_preview(&self, who: &Revocable) -> String {
        let shown = self
            .tool_at(
                ADMIN,
                &who.admin,
                "marfa_revoke_key",
                json!({ "id": who.target_id }),
            )
            .await;
        assert_eq!(shown.payload()["key"]["id"], who.target_id.as_str());
        shown.payload()["confirm"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn a_revoke_without_a_confirmation_revokes_nothing_and_the_confirmation_revokes_once() {
    let instance = Instance::start(&[]).await;
    let who = instance.revocable().await;
    let confirm = instance.revoke_preview(&who).await;
    assert!(instance.works(&who.target).await);
    let done = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm }),
        )
        .await;
    assert_eq!(
        done.payload()["revoked"],
        who.target_id.as_str(),
        "{}",
        done.value
    );
    assert!(!instance.works(&who.target).await);
    assert_eq!(
        instance.audited("key.revoke").await[0]["details"]["via"],
        "mcp"
    );
    let again = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm }),
        )
        .await;
    assert_eq!(again.payload()["already_revoked"], true, "{}", again.value);
    assert_eq!(instance.audited("key.revoke").await.len(), 1);
}

#[tokio::test]
async fn a_revoke_confirmation_sent_by_another_credential_revokes_nothing() {
    let instance = Instance::start(&[]).await;
    let who = instance.revocable().await;
    let confirm = instance.revoke_preview(&who).await;
    let other = instance
        .key(json!({ "type_permissions": {}, "permissions": ["keys.manage"] }))
        .await;
    let refused = instance
        .tool_at(
            ADMIN,
            &other,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm.clone() }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(refused.value["error"]["key"]["id"], who.target_id.as_str());
    assert!(instance.works(&who.target).await);
    // The witness: the credential it was issued to spends it.
    let spent = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm }),
        )
        .await;
    assert!(!spent.failed, "{}", spent.value);
}

#[tokio::test]
async fn a_revoke_confirmation_sent_after_five_minutes_revokes_nothing() {
    let instance = Instance::start(&[]).await;
    let who = instance.revocable().await;
    let confirm = instance.revoke_preview(&who).await;
    instance.app.clock.advance(5 * 60_000 + 1).unwrap();
    let refused = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert!(
        refused.value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expired")
    );
    assert!(instance.works(&who.target).await);
}

#[tokio::test]
async fn a_revoke_confirmation_for_a_key_that_changed_revokes_nothing_but_use_does_not_change_it() {
    let instance = Instance::start(&[]).await;
    let who = instance.revocable().await;
    let confirm = instance.revoke_preview(&who).await;
    // Using the key changes only when it was last used.
    assert!(instance.works(&who.target).await);
    let narrowed = instance
        .local(
            Method::PATCH,
            &format!("/keys/{}", who.target_id),
            Some(json!({ "label": "renamed" })),
        )
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.body);
    let refused = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": confirm }),
        )
        .await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(refused.value["error"]["key"]["label"], "renamed");
    assert!(instance.works(&who.target).await);
    // The witness: with only its use between, the confirmation holds.
    let again = instance.revoke_preview(&who).await;
    assert!(instance.works(&who.target).await);
    let done = instance
        .tool_at(
            ADMIN,
            &who.admin,
            "marfa_revoke_key",
            json!({ "id": who.target_id, "confirm": again }),
        )
        .await;
    assert!(!done.failed, "{}", done.value);
}

#[tokio::test]
async fn no_tool_purges_exports_restores_claims_configures_or_manages_the_owner() {
    let instance = Instance::start(&[]).await;
    let everything = instance
        .key(json!({
            "type_permissions": { "*": "write" },
            "metadata_permissions": { "*": "write" },
            "permissions": [
                "audit.read", "blobs.manage", "config.manage", "connectors.manage",
                "grants.manage", "instance.maintain", "instance.read", "items.purge",
                "keys.manage", "keys.mint", "schema.write", "webhooks.manage",
            ],
        }))
        .await;
    for path in ["/mcp", SCHEMA, ADMIN] {
        let names = instance.names_at(path, &everything).await;
        for name in &names {
            for banned in [
                "purge",
                "export",
                "restore",
                "claim",
                "config",
                "setting",
                "owner",
                "passkey",
                "sign_in",
                "storage",
                "blob",
                "housekeeping",
            ] {
                assert!(!name.contains(banned), "{path} offers {name}");
            }
        }
    }
    assert!(instance.names_at(ADMIN, &everything).await.len() > 6);
}

#[tokio::test]
async fn many_items_are_saved_in_one_call_and_saving_them_again_skips_them() {
    let instance = Instance::start(&[]).await;
    let writer = instance.writer().await;
    let reader = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    unoffered(
        &instance,
        SCHEMA,
        &reader,
        "marfa_bulk_save",
        json!({ "items": [{ "type": "core.note", "properties": { "body": "no" } }] }),
    )
    .await;
    assert!(
        instance
            .names_at(SCHEMA, &writer)
            .await
            .contains(&"marfa_bulk_save".to_string())
    );
    let page = json!({ "items": [
        { "type": "core.note", "source_id": "a", "properties": { "body": "one" } },
        { "type": "core.note", "source_id": "b", "properties": { "body": "two" } },
    ] });
    let first = instance
        .tool_at(SCHEMA, &writer, "marfa_bulk_save", page.clone())
        .await;
    assert_eq!(first.payload()["counts"]["created"], 2, "{}", first.value);
    let again = instance
        .tool_at(SCHEMA, &writer, "marfa_bulk_save", page)
        .await;
    assert_eq!(again.payload()["counts"]["skipped"], 2, "{}", again.value);
    // A number past what a client can hold exactly is refused, never rounded.
    let refused = instance
        .raw_tool_at(
            SCHEMA,
            &writer,
            "marfa_bulk_save",
            r#"{"items":[{"type":"core.note","properties":{"body":"x","n":18446744073709551617}}]}"#,
        )
        .await;
    assert!(refused.failed, "{}", refused.value);
    assert_eq!(refused.code(), "invalid_properties");
}

const RECEIVER: &str = "http://93.184.216.34/";

impl Instance {
    async fn hooker(&self) -> String {
        self.key(json!({ "type_permissions": {}, "permissions": ["webhooks.manage"] }))
            .await
    }

    async fn hook(&self, token: &str, arguments: Value) -> Tool {
        self.tool_at(ADMIN, token, "marfa_manage_webhook", arguments)
            .await
    }

    async fn hooks(&self, token: &str) -> Vec<Value> {
        let listed = self
            .tool_at(ADMIN, token, "marfa_webhooks", json!({}))
            .await;
        listed.payload()["webhooks"].as_array().unwrap().clone()
    }

    /// A made webhook: the answer to the confirmed call.
    async fn made_hook(&self, token: &str, path: &str) -> Value {
        let args = json!({ "action": "make", "url": format!("{RECEIVER}{path}"), "events": ["item.created"] });
        let shown = self.hook(token, args.clone()).await;
        let mut confirmed = args;
        confirmed["confirm"] = shown.payload()["confirm"].clone();
        let done = self.hook(token, confirmed).await;
        done.payload()["webhook"].clone()
    }
}

#[tokio::test]
async fn a_webhook_is_made_only_by_the_confirmation_its_preview_gave_and_once() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let args = json!({
        "action": "make",
        "url": format!("{RECEIVER}made"),
        "events": ["item.created", "edge.created"],
        "type_filter": "core.note",
    });
    let shown = instance.hook(&token, args.clone()).await;
    assert_eq!(shown.payload()["preview"]["host"], "93.184.216.34");
    assert_eq!(shown.payload()["preview"]["active"], true);
    assert_eq!(shown.payload()["preview"]["type_filter"], "core.note");
    assert!(instance.hooks(&token).await.is_empty());

    let mut confirmed = args.clone();
    confirmed["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, confirmed.clone()).await;
    let made = done.payload()["webhook"].clone();
    assert_eq!(made["url"], format!("{RECEIVER}made"), "{}", done.value);
    assert_eq!(made["active"], true);
    assert_eq!(instance.hooks(&token).await.len(), 1);
    assert_eq!(instance.audited("webhook.create").await.len(), 1);

    let again = instance.hook(&token, confirmed).await;
    assert_eq!(again.code(), "confirmation_stale", "{}", again.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);
}

#[tokio::test]
async fn a_webhook_confirmation_stops_at_a_changed_result_another_credential_and_five_minutes() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let args =
        json!({ "action": "make", "url": format!("{RECEIVER}one"), "events": ["item.created"] });
    let shown = instance.hook(&token, args.clone()).await;
    let confirm = shown.payload()["confirm"].clone();

    // The address in the call is not the one previewed.
    let mut moved = args.clone();
    moved["url"] = format!("{RECEIVER}elsewhere").into();
    moved["confirm"] = confirm.clone();
    let moved = instance.hook(&token, moved).await;
    assert_eq!(moved.code(), "confirmation_stale", "{}", moved.value);
    assert_eq!(
        moved.value["error"]["preview"]["url"],
        format!("{RECEIVER}elsewhere")
    );
    assert!(instance.hooks(&token).await.is_empty());

    // Another credential holding the permission.
    let other = instance.hooker().await;
    let mut sent = args.clone();
    sent["confirm"] = confirm.clone();
    let refused = instance.hook(&other, sent.clone()).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert!(instance.hooks(&other).await.is_empty());
    assert!(instance.hooks(&token).await.is_empty());

    // Five minutes later.
    instance.app.clock.advance(5 * 60_000 + 1).unwrap();
    let late = instance.hook(&token, sent).await;
    assert_eq!(late.code(), "confirmation_stale", "{}", late.value);
    assert!(
        late.value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expired")
    );
    assert!(instance.hooks(&token).await.is_empty());

    // The witness: the fresh preview's confirmation, from the same credential, makes it.
    let mut fresh = args;
    fresh["confirm"] = late.value["error"]["confirm"].clone();
    let done = instance.hook(&token, fresh).await;
    assert!(!done.failed, "{}", done.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);
}

#[tokio::test]
async fn a_make_confirmation_is_stale_once_a_webhook_the_credential_reads_was_made_or_deleted() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let args =
        json!({ "action": "make", "url": format!("{RECEIVER}fresh"), "events": ["item.created"] });

    let shown = instance.hook(&token, args.clone()).await;
    let first = instance.made_hook(&token, "first").await;
    let mut sent = args.clone();
    sent["confirm"] = shown.payload()["confirm"].clone();
    let refused = instance.hook(&token, sent).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);

    let shown = instance.hook(&token, args.clone()).await;
    let deleted = instance
        .hook(&token, json!({ "action": "delete", "id": first["id"] }))
        .await;
    assert!(!deleted.failed, "{}", deleted.value);
    let mut sent = args.clone();
    sent["confirm"] = shown.payload()["confirm"].clone();
    let refused = instance.hook(&token, sent).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert!(instance.hooks(&token).await.is_empty());

    // The witness: a webhook another credential made is not one this credential reads.
    let other = instance.hooker().await;
    let shown = instance.hook(&token, args.clone()).await;
    instance.made_hook(&other, "theirs").await;
    let mut sent = args;
    sent["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, sent).await;
    assert!(!done.failed, "{}", done.value);
}

#[tokio::test]
async fn a_make_confirmation_is_stale_after_a_webhook_was_made_and_deleted_since_the_preview() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let other = instance.hooker().await;
    let args =
        json!({ "action": "make", "url": format!("{RECEIVER}fresh"), "events": ["item.created"] });

    // The witness: another credential's webhook, made and deleted, is not one this credential reads.
    let shown = instance.hook(&token, args.clone()).await;
    let theirs = instance.made_hook(&other, "theirs").await;
    let gone = instance
        .hook(&other, json!({ "action": "delete", "id": theirs["id"] }))
        .await;
    assert!(!gone.failed, "{}", gone.value);
    let mut sent = args.clone();
    sent["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, sent).await;
    assert!(!done.failed, "{}", done.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);

    // One of this credential's own, made and deleted, leaves the set as it was and still stales the token.
    let shown = instance.hook(&token, args.clone()).await;
    let second = instance.made_hook(&token, "second").await;
    let gone = instance
        .hook(&token, json!({ "action": "delete", "id": second["id"] }))
        .await;
    assert!(!gone.failed, "{}", gone.value);
    let mut sent = args;
    sent["confirm"] = shown.payload()["confirm"].clone();
    let refused = instance.hook(&token, sent).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);
    assert_eq!(instance.audited("webhook.create").await.len(), 3);
}

#[tokio::test]
async fn a_make_confirmation_refused_at_the_cap_stays_unspent() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    for place in 0..100 {
        let body = json!({ "url": format!("{RECEIVER}{place}"), "events": ["item.created"] });
        let made = instance
            .call(&token, Method::POST, "/webhooks", Some(body))
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    }
    let args =
        json!({ "action": "make", "url": format!("{RECEIVER}over"), "events": ["item.created"] });
    let shown = instance.hook(&token, args.clone()).await;
    let mut sent = args.clone();
    sent["confirm"] = shown.payload()["confirm"].clone();

    let refused = instance.hook(&token, sent.clone()).await;
    assert_eq!(refused.code(), "conflict", "{}", refused.value);
    assert_eq!(refused.value["error"]["details"]["reason"], "webhook_cap");
    assert_eq!(instance.hooks(&token).await.len(), 100);

    // A spent token would now answer `confirmation_stale`.
    let again = instance.hook(&token, sent).await;
    assert_eq!(again.code(), "conflict", "{}", again.value);
    assert_eq!(again.value["error"]["details"]["reason"], "webhook_cap");

    // The witness: with a place free, a fresh confirmation makes the webhook.
    let first = instance.hooks(&token).await[0]["id"].clone();
    let gone = instance
        .hook(&token, json!({ "action": "delete", "id": first }))
        .await;
    assert!(!gone.failed, "{}", gone.value);
    let shown = instance.hook(&token, args.clone()).await;
    let mut sent = args;
    sent["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, sent).await;
    assert!(!done.failed, "{}", done.value);
    assert_eq!(instance.hooks(&token).await.len(), 100);
}

#[tokio::test]
async fn a_change_is_confirmed_against_the_webhook_it_would_leave() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let made = instance.made_hook(&token, "change").await;
    let id = made["id"].as_str().unwrap();
    let change = json!({ "action": "change", "id": id, "url": format!("{RECEIVER}moved") });

    let shown = instance.hook(&token, change.clone()).await;
    assert_eq!(shown.payload()["preview"]["id"], id);
    assert_eq!(
        shown.payload()["preview"]["events"],
        json!(["item.created"])
    );
    assert_eq!(
        instance.hooks(&token).await[0]["url"],
        format!("{RECEIVER}change")
    );

    // What the webhook sends changes under the preview, so the result differs.
    let patched = instance
        .call(
            &token,
            Method::PATCH,
            &format!("/webhooks/{id}"),
            Some(json!({ "events": ["item.updated"] })),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
    let mut sent = change.clone();
    sent["confirm"] = shown.payload()["confirm"].clone();
    let stale = instance.hook(&token, sent).await;
    assert_eq!(stale.code(), "confirmation_stale", "{}", stale.value);
    assert_eq!(
        stale.value["error"]["preview"]["events"],
        json!(["item.updated"])
    );
    assert_eq!(
        instance.hooks(&token).await[0]["url"],
        format!("{RECEIVER}change")
    );

    // The witness: the new preview's confirmation changes it, once.
    let mut fresh = change;
    fresh["confirm"] = stale.value["error"]["confirm"].clone();
    let before = instance.audited("webhook.update").await.len();
    let done = instance.hook(&token, fresh.clone()).await;
    assert_eq!(done.payload()["webhook"]["url"], format!("{RECEIVER}moved"));
    assert_eq!(instance.audited("webhook.update").await.len(), before + 1);
    let replay = instance.hook(&token, fresh).await;
    assert_eq!(replay.code(), "confirmation_stale", "{}", replay.value);
    assert_eq!(instance.audited("webhook.update").await.len(), before + 1);
}

#[tokio::test]
async fn pausing_resuming_and_deleting_a_webhook_take_one_call() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let id = instance.made_hook(&token, "steps").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let paused = instance
        .hook(
            &token,
            json!({ "action": "change", "id": id, "active": false }),
        )
        .await;
    assert_eq!(
        paused.payload()["webhook"]["active"],
        false,
        "{}",
        paused.value
    );
    let resumed = instance
        .hook(
            &token,
            json!({ "action": "change", "id": id, "active": true }),
        )
        .await;
    assert_eq!(
        resumed.payload()["webhook"]["active"],
        true,
        "{}",
        resumed.value
    );
    let deleted = instance
        .hook(&token, json!({ "action": "delete", "id": id }))
        .await;
    assert_eq!(
        deleted.payload()["deleted"],
        id.as_str(),
        "{}",
        deleted.value
    );
    assert!(instance.hooks(&token).await.is_empty());
    let missing = instance
        .hook(&token, json!({ "action": "delete", "id": id }))
        .await;
    assert_eq!(missing.code(), "webhook_not_found", "{}", missing.value);
}

#[tokio::test]
async fn an_address_that_is_not_public_is_refused_at_the_preview_and_at_the_commit() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let id = instance.made_hook(&token, "kept").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let private =
        json!({ "action": "make", "url": "http://10.0.0.1/hook", "events": ["item.created"] });
    let refused = instance.hook(&token, private.clone()).await;
    assert_eq!(refused.code(), "validation_error", "{}", refused.value);

    let public =
        json!({ "action": "make", "url": format!("{RECEIVER}public"), "events": ["item.created"] });
    let shown = instance.hook(&token, public.clone()).await;
    let mut sent = private;
    sent["confirm"] = shown.payload()["confirm"].clone();
    let refused = instance.hook(&token, sent).await;
    assert_eq!(refused.code(), "validation_error", "{}", refused.value);
    assert_eq!(instance.hooks(&token).await.len(), 1);

    // A change is judged the same way.
    let refused = instance
        .hook(
            &token,
            json!({ "action": "change", "id": id, "url": "http://10.0.0.1/hook" }),
        )
        .await;
    assert_eq!(refused.code(), "validation_error", "{}", refused.value);

    // The witness: the public address with the same token makes it.
    let mut sent = public;
    sent["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, sent).await;
    assert!(!done.failed, "{}", done.value);
}

#[tokio::test]
async fn a_webhook_secret_is_shown_once_when_it_is_made_and_in_no_other_answer() {
    let instance = Instance::start(&[]).await;
    let token = instance.hooker().await;
    let args =
        json!({ "action": "make", "url": format!("{RECEIVER}secret"), "events": ["item.created"] });
    let shown = instance.hook(&token, args.clone()).await;
    assert!(shown.payload().get("secret").is_none());
    assert!(shown.payload()["preview"].get("secret").is_none());
    let mut confirmed = args;
    confirmed["confirm"] = shown.payload()["confirm"].clone();
    let done = instance.hook(&token, confirmed.clone()).await;
    let secret = done.payload()["webhook"]["secret"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        secret.len() >= 32 && !secret.starts_with("****"),
        "{}",
        done.value
    );
    let id = done.payload()["webhook"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let mut answers = vec![
        instance
            .tool_at(ADMIN, &token, "marfa_webhooks", json!({}))
            .await,
    ];
    answers.push(instance.hook(&token, confirmed).await);
    answers.push(
        instance
            .hook(
                &token,
                json!({ "action": "change", "id": id, "active": false }),
            )
            .await,
    );
    answers.push(
        instance
            .hook(
                &token,
                json!({ "action": "change", "id": id, "events": ["item.updated"] }),
            )
            .await,
    );
    for answer in &answers {
        let text = answer.value.to_string();
        assert!(!text.contains(&secret), "{text}");
        assert!(!text.contains("****"), "{text}");
    }
    assert!(answers[0].payload()["webhooks"][0].get("secret").is_none());
}

const FROM: &str = "user.lead";
const TO: &str = "user.contact";

/// A credential that may move items, with the two types registered and one lead saved.
async fn mover(instance: &Instance) -> String {
    marfa_server::app::jobs::start(&instance.app);
    let token = instance
        .key(json!({
            "type_permissions": { "*": "write" },
            "metadata_permissions": { "*": "write" },
            "permissions": ["schema.write", "webhooks.manage"],
        }))
        .await;
    for id in [TO, FROM] {
        let made = instance
            .tool_at(
                SCHEMA,
                &token,
                "marfa_save_type",
                json!({ "action": "register", "id": id, "fields": { "title": { "type": "string" } } }),
            )
            .await;
        assert!(!made.failed, "{}", made.value);
    }
    token
}

async fn lead(instance: &Instance, token: &str, title: &str) -> String {
    let made = instance
        .tool(
            token,
            "marfa_create",
            json!({ "type": FROM, "properties": { "title": title } }),
        )
        .await;
    made.payload()["id"].as_str().unwrap().to_string()
}

async fn type_of(instance: &Instance, token: &str, id: &str) -> String {
    let read = instance
        .tool(token, "marfa_get", json!({ "ids": [id] }))
        .await;
    read.payload()["items"][0]["type"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn move_preview(instance: &Instance, token: &str) -> Tool {
    instance
        .tool_at(
            SCHEMA,
            token,
            "marfa_move_items",
            json!({ "from": FROM, "to": TO }),
        )
        .await
}

async fn move_with(instance: &Instance, token: &str, confirm: &str) -> Tool {
    instance
        .tool_at(
            SCHEMA,
            token,
            "marfa_move_items",
            json!({ "from": FROM, "to": TO, "confirm": confirm }),
        )
        .await
}

/// Follows a started move until the job ends, and answers its status.
async fn finished(instance: &Instance, token: &str, started: &Tool) -> String {
    let id = started.payload()["job"]["id"].as_str().unwrap().to_string();
    for _ in 0..500 {
        let progress = instance
            .tool_at(SCHEMA, token, "marfa_move_items", json!({ "job_id": id }))
            .await;
        let status = progress.payload()["job"]["status"]
            .as_str()
            .unwrap()
            .to_string();
        if status == "completed" || status == "failed" {
            return status;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the move did not finish");
}

#[tokio::test]
async fn a_move_preview_names_the_items_and_moves_none_until_the_token_is_sent() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let id = lead(&instance, &token, "Ada").await;
    let shown = move_preview(&instance, &token).await;
    assert_eq!(shown.payload()["matched"], 1);
    assert_eq!(shown.payload()["ids"][0], id.as_str());
    assert_eq!(type_of(&instance, &token, &id).await, FROM);
    assert!(instance.audited("items.bulk_action").await.is_empty());
    // The witness: the same token starts the move, and the item changes type.
    let confirm = shown.payload()["confirm"].as_str().unwrap();
    let started = move_with(&instance, &token, confirm).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
    assert_eq!(type_of(&instance, &token, &id).await, TO);
}

#[tokio::test]
async fn a_move_confirmation_works_once() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let first = lead(&instance, &token, "Ada").await;
    let confirm = move_preview(&instance, &token).await.payload()["confirm"]
        .as_str()
        .unwrap()
        .to_string();
    let started = move_with(&instance, &token, &confirm).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
    assert_eq!(type_of(&instance, &token, &first).await, TO);

    // A lead saved after the move makes a replay observable.
    let later = lead(&instance, &token, "Grace").await;
    let replay = move_with(&instance, &token, &confirm).await;
    assert_eq!(replay.code(), "confirmation_stale");
    assert_eq!(type_of(&instance, &token, &later).await, FROM);
    assert_eq!(instance.audited("items.bulk_action").await.len(), 1);
}

#[tokio::test]
async fn a_move_confirmation_sent_by_another_credential_moves_nothing() {
    let instance = Instance::start(&[]).await;
    let owner = mover(&instance).await;
    let other = instance
        .key(json!({ "type_permissions": { "*": "write" } }))
        .await;
    let id = lead(&instance, &owner, "Ada").await;
    let confirm = move_preview(&instance, &owner).await.payload()["confirm"]
        .as_str()
        .unwrap()
        .to_string();
    let refused = move_with(&instance, &other, &confirm).await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert_eq!(type_of(&instance, &owner, &id).await, FROM);
    // The witness: the credential it was issued to starts the move.
    let started = move_with(&instance, &owner, &confirm).await;
    assert_eq!(finished(&instance, &owner, &started).await, "completed");
}

#[tokio::test]
async fn a_move_confirmation_sent_after_five_minutes_moves_nothing() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let id = lead(&instance, &token, "Ada").await;
    let confirm = move_preview(&instance, &token).await.payload()["confirm"]
        .as_str()
        .unwrap()
        .to_string();
    instance.app.clock.advance(5 * 60_000 + 1).unwrap();
    let refused = move_with(&instance, &token, &confirm).await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert!(
        refused.value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expired")
    );
    assert_eq!(type_of(&instance, &token, &id).await, FROM);
    // The witness: the new preview's confirmation starts the move.
    let fresh = refused.value["error"]["confirm"].as_str().unwrap();
    let started = move_with(&instance, &token, fresh).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
}

#[tokio::test]
async fn a_move_confirmation_is_refused_once_an_item_of_the_type_changed() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let first = lead(&instance, &token, "Ada").await;
    let confirm = move_preview(&instance, &token).await.payload()["confirm"]
        .as_str()
        .unwrap()
        .to_string();
    let second = lead(&instance, &token, "Grace").await;
    let refused = move_with(&instance, &token, &confirm).await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert_eq!(refused.value["error"]["matched"], 2);
    assert_eq!(type_of(&instance, &token, &first).await, FROM);
    assert_eq!(type_of(&instance, &token, &second).await, FROM);
    // The witness: the confirmation of the new preview moves both.
    let fresh = refused.value["error"]["confirm"].as_str().unwrap();
    let started = move_with(&instance, &token, fresh).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
    assert_eq!(type_of(&instance, &token, &second).await, TO);
}

#[tokio::test]
async fn a_move_confirmation_is_refused_once_a_setting_names_the_type() {
    let instance = Instance::start(&[("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES", "true")]).await;
    let token = mover(&instance).await;
    let id = lead(&instance, &token, "Ada").await;
    let shown = move_preview(&instance, &token).await;
    assert_eq!(shown.payload()["settings"], json!([]));
    let made = instance
        .call(
            &token,
            Method::POST,
            "/webhooks",
            Some(json!({
                "url": "http://127.0.0.1:9/move",
                "events": ["item.created"],
                "type_filter": FROM,
            })),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let confirm = shown.payload()["confirm"].as_str().unwrap();
    let refused = move_with(&instance, &token, confirm).await;
    assert_eq!(refused.code(), "confirmation_stale");
    assert_ne!(refused.value["error"]["settings"], json!([]));
    assert_eq!(type_of(&instance, &token, &id).await, FROM);
    // The witness: the new preview's confirmation moves the item.
    let fresh = refused.value["error"]["confirm"].as_str().unwrap();
    let started = move_with(&instance, &token, fresh).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
    assert_eq!(type_of(&instance, &token, &id).await, TO);
}

#[tokio::test]
async fn an_item_that_arrives_between_the_check_and_the_commit_is_not_moved() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let first = lead(&instance, &token, "Ada").await;
    let confirm = move_preview(&instance, &token).await.payload()["confirm"]
        .as_str()
        .unwrap()
        .to_string();
    instance
        .app
        .faults
        .set("hold:write", Some("items.bulk_action"))
        .unwrap();
    let confirming = move_with(&instance, &token, &confirm);
    let arriving = async {
        for _ in 0..500 {
            if instance.app.faults.list().iter().any(|f| f.waiting > 0) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let made = instance
            .call(
                &token,
                Method::POST,
                "/items",
                Some(json!({ "type": FROM, "properties": { "title": "Late" } })),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
        instance.app.faults.clear(Some("hold:write"));
    };
    let (refused, ()) = tokio::join!(confirming, arriving);
    assert_eq!(refused.code(), "confirmation_stale");
    assert_eq!(type_of(&instance, &token, &first).await, FROM);
    assert_eq!(refused.value["error"]["matched"], 2);
}

#[tokio::test]
async fn the_move_tool_is_offered_only_to_a_credential_that_writes_a_type() {
    let instance = Instance::start(&[]).await;
    let reader = instance
        .key(json!({ "type_permissions": { "core.note": "read" } }))
        .await;
    let one = instance
        .key(json!({ "type_permissions": { "core.note": "write" } }))
        .await;
    let mover = "marfa_move_items".to_string();
    assert!(!instance.names_at(SCHEMA, &reader).await.contains(&mover));
    assert!(instance.names_at(SCHEMA, &one).await.contains(&mover));
    assert!(!instance.names(&one).await.contains(&mover));
    unoffered(
        &instance,
        SCHEMA,
        &reader,
        "marfa_move_items",
        json!({ "from": FROM, "to": TO }),
    )
    .await;
}

async fn view_of_leads(instance: &Instance, token: &str) -> String {
    let made = instance
        .tool_at(
            SCHEMA,
            token,
            "marfa_save_view",
            json!({ "title": "Leads", "query": { "types": [FROM] } }),
        )
        .await;
    assert!(!made.failed, "{}", made.value);
    made.payload()["id"].as_str().unwrap().to_string()
}

async fn register_subtype(instance: &Instance, token: &str) {
    let made = instance
        .tool_at(
            SCHEMA,
            token,
            "marfa_save_type",
            json!({
                "action": "register",
                "id": "user.lead.cold",
                "parent": FROM,
                "fields": { "title": { "type": "string" } },
            }),
        )
        .await;
    assert!(!made.failed, "{}", made.value);
}

#[tokio::test]
async fn a_move_confirmation_is_refused_once_the_type_gained_a_subtype() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    lead(&instance, &token, "Ada").await;
    let view = view_of_leads(&instance, &token).await;
    let shown = move_preview(&instance, &token).await;
    assert_eq!(shown.payload()["settings"].as_array().unwrap().len(), 1);
    register_subtype(&instance, &token).await;
    let confirm = shown.payload()["confirm"].as_str().unwrap();
    let refused = move_with(&instance, &token, confirm).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    // The witness: the new preview's confirmation moves the items, and the view keeps its subtypes.
    let fresh = refused.value["error"]["confirm"].as_str().unwrap();
    let started = move_with(&instance, &token, fresh).await;
    assert_eq!(finished(&instance, &token, &started).await, "completed");
    let read = instance
        .call(&token, Method::GET, "/items?type=system.view", None)
        .await;
    let held = read.body["data"]
        .as_array()
        .and_then(|views| views.iter().find(|item| item["id"] == view.as_str()))
        .cloned();
    assert_eq!(
        held.as_ref()
            .map(|item| &item["properties"]["query"]["types"]),
        Some(&json!([FROM, TO])),
        "{}",
        read.body
    );
}

#[tokio::test]
async fn a_move_confirmation_is_stale_when_a_setting_became_blocked_after_the_preview() {
    let instance = Instance::start(&[("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES", "true")]).await;
    let token = mover(&instance).await;
    let id = lead(&instance, &token, "Ada").await;
    let shown = move_preview(&instance, &token).await;
    register_subtype(&instance, &token).await;
    let made = instance
        .call(
            &token,
            Method::POST,
            "/webhooks",
            Some(json!({
                "url": "http://127.0.0.1:9/move",
                "events": ["item.created"],
                "type_filter": FROM,
            })),
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let confirm = shown.payload()["confirm"].as_str().unwrap();
    let refused = move_with(&instance, &token, confirm).await;
    assert_eq!(refused.code(), "confirmation_stale", "{}", refused.value);
    assert_eq!(refused.value["error"]["settings"][0]["reason"], "subtypes");
    assert!(refused.value["error"].get("confirm").is_none());
    assert_eq!(type_of(&instance, &token, &id).await, FROM);
    // The witness: a fresh preview of the blocked move is refused as blocked.
    assert_eq!(
        move_preview(&instance, &token).await.code(),
        "type_move_blocked"
    );
}

#[tokio::test]
async fn a_move_confirmation_survives_properties_sent_in_another_order() {
    let instance = Instance::start(&[]).await;
    let token = mover(&instance).await;
    let id = lead(&instance, &token, "Ada").await;
    let shown = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_move_items",
            json!({ "from": FROM, "to": TO, "properties": { "title": "A", "notes": "B" } }),
        )
        .await;
    let confirm = shown.payload()["confirm"].as_str().unwrap();
    let started = instance
        .tool_at(
            SCHEMA,
            &token,
            "marfa_move_items",
            json!({ "from": FROM, "to": TO, "properties": { "notes": "B", "title": "A" }, "confirm": confirm }),
        )
        .await;
    assert!(!started.failed, "{}", started.value);
    finished(&instance, &token, &started).await;
    assert_eq!(type_of(&instance, &token, &id).await, TO);
}
