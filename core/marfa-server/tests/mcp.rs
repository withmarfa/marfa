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

fn rpc_request(token: Option<&str>, headers: &[(&str, &str)], body: &Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
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
        send(&self.public, rpc_request(token, headers, &body)).await
    }

    async fn tool(&self, token: &str, name: &str, arguments: Value) -> Tool {
        let sent = message(
            1,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        let reply = self.rpc(Some(token), &[], sent).await;
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
        let listed = self
            .rpc(Some(token), &[], message(2, "tools/list", json!({})))
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
        let request = Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(text.to_string()))
            .unwrap();
        send(&self.public, from(CALLER, request)).await
    }

    async fn raw_tool(&self, token: &str, name: &str, arguments: &str) -> Tool {
        let text = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}","arguments":{arguments}}}}}"#
        );
        let reply = self.raw(token, &text).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        let result = &reply.body["result"];
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
    assert_eq!(instance.names(&reader).await, ["marfa_find", "marfa_get"]);
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
