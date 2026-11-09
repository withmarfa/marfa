use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const WRONG_PREFIX: &str =
    "marfa_k2_0000000000000000000000000000000000000000000000000000000000000000";

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

    async fn call(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.public, request(method, path, Some(token), body)).await
    }

    async fn key(&self, body: Value) -> (String, String) {
        let minted = self.local(Method::POST, "/keys", Some(body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        (
            minted.body["id"].as_str().unwrap().to_string(),
            minted.body["key"].as_str().unwrap().to_string(),
        )
    }

    /// Holds the next write for `action`, and returns once one waits there.
    fn hold(&self, action: &str) {
        self.app.faults.set("hold:write", Some(action)).unwrap();
    }

    async fn when_held(&self) {
        for _ in 0..500 {
            if self.app.faults.list().iter().any(|fault| fault.waiting > 0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("no write reached the hold");
    }

    async fn ids(&self, token: &str) -> Vec<String> {
        let listed = self.call(token, Method::GET, "/keys", None).await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
        listed.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key["id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn audited(&self, action: &str) -> Vec<Value> {
        let path = format!("/audit?action={action}");
        let page = self.local(Method::GET, &path, None).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.body);
        page.body["data"].as_array().unwrap().clone()
    }
}

fn narrow_minter(source: &str) -> Value {
    json!({ "label": source, "source": source, "permissions": ["keys.mint"] })
}

fn bare(source: &str) -> Value {
    json!({ "label": source, "source": source, "permissions": [] })
}

#[tokio::test]
async fn a_valid_key_is_served_whatever_host_it_was_sent_to() {
    let instance = Instance::start(&[]).await;
    let (id, secret) = instance.key(bare("any route")).await;
    for host in ["marfa.example", "100.64.0.1:8600", "not a host name"] {
        let mut asked = request(Method::GET, "/keys/current", Some(&secret), None);
        asked
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_str(host).unwrap());
        let reply = send(&instance.public, asked).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        assert_eq!(reply.body["id"], id.as_str());
    }
}

#[tokio::test]
async fn a_key_holding_only_keys_mint_cannot_touch_a_wider_key_at_any_door() {
    let instance = Instance::start(&[]).await;
    let (own, minter) = instance.key(narrow_minter("minter")).await;
    let (wide, _) = instance
        .key(json!({ "label": "wide", "source": "wide", "permissions": ["audit.read", "keys.mint"] }))
        .await;
    let (within, _) = instance.key(bare("within")).await;

    let listed = instance.ids(&minter).await;
    assert!(
        listed.contains(&own) && listed.contains(&within),
        "{listed:?}"
    );
    assert!(!listed.contains(&wide), "{listed:?}");

    let path = format!("/keys/{wide}");
    let label = json!({ "label": "taken" });
    let patched = instance
        .call(&minter, Method::PATCH, &path, Some(label))
        .await;
    let revoked = instance.call(&minter, Method::DELETE, &path, None).await;
    let unknown_id = "01890000-0000-7000-8000-000000000000";
    let unknown = format!("/keys/{unknown_id}");
    let absent = instance.call(&minter, Method::DELETE, &unknown, None).await;
    for answer in [&patched, &revoked] {
        assert_eq!(answer.status, StatusCode::NOT_FOUND);
        assert_eq!(answer.code(), "api_key_not_found");
        assert_eq!(
            answer.body["error"]["message"]
                .as_str()
                .unwrap()
                .replace(&wide, "ID"),
            absent.body["error"]["message"]
                .as_str()
                .unwrap()
                .replace(unknown_id, "ID"),
        );
    }
    let still = instance.local(Method::GET, "/keys", None).await;
    let held = still.body["data"].as_array().unwrap();
    assert!(
        held.iter()
            .any(|key| key["id"] == wide.as_str() && key["label"] == "wide")
    );

    let path = format!("/keys/{within}");
    let done = instance.call(&minter, Method::DELETE, &path, None).await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
}

#[tokio::test]
async fn a_key_reached_through_a_claim_is_out_of_reach_until_the_caller_holds_the_claim() {
    let instance = Instance::start(&[]).await;
    let (_, minter) = instance.key(narrow_minter("minter")).await;
    let (target, _) = instance
        .key(json!({ "label": "t", "source": "t", "permissions": [], "sources": ["shared"] }))
        .await;
    assert!(!instance.ids(&minter).await.contains(&target));

    let (_, claimant) = instance
        .key(json!({ "label": "c", "source": "c", "permissions": ["keys.mint"], "sources": ["shared"] }))
        .await;
    assert!(instance.ids(&claimant).await.contains(&target));

    let (_, owning) = instance.key(narrow_minter("shared")).await;
    assert!(instance.ids(&owning).await.contains(&target));
}

#[tokio::test]
async fn a_mint_wider_than_its_maker_is_refused_in_every_family() {
    let instance = Instance::start(&[]).await;
    let (_, minter) = instance.key(narrow_minter("minter")).await;
    for (field, value) in [
        ("permissions", json!(["audit.read"])),
        ("type_permissions", json!({ "core.note": "read" })),
        ("type_permissions", json!({ "user.nothing-here": "read" })),
        ("edge_permissions", json!({ "about": "read" })),
        ("extension_permissions", json!({ "mine": "read" })),
        ("metadata_permissions", json!({ "types": "write" })),
        ("profile_permissions", json!({ "name": "read" })),
        ("sources", json!(["theirs"])),
    ] {
        let mut body = bare("wider");
        body[field] = value;
        let refused = instance
            .call(&minter, Method::POST, "/keys", Some(body))
            .await;
        assert_eq!(
            refused.status,
            StatusCode::FORBIDDEN,
            "{field}: {}",
            refused.body
        );
    }
    assert_eq!(instance.audited("key.create").await.len(), 1);
}

#[tokio::test]
async fn a_map_with_a_bad_level_names_each_entry() {
    let instance = Instance::start(&[]).await;
    let refused = instance
        .local(
            Method::POST,
            "/keys",
            Some(json!({
                "label": "bad",
                "source": "bad",
                "type_permissions": { "core.note": "admin", "Not A Type": "read", "core.task": "owner" },
                "edge_permissions": { "about": "none" },
            })),
        )
        .await;
    assert_eq!(refused.code(), "validation_error", "{}", refused.body);
    let paths: Vec<_> = refused.body["error"]["details"]["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|error| error["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [
            "type_permissions.core.note",
            "type_permissions.core.task",
            "edge_permissions.about",
        ]
    );
}

#[tokio::test]
async fn a_key_revoked_while_its_write_waits_writes_nothing() {
    let instance = Instance::start(&[]).await;
    let (id, secret) = instance.key(narrow_minter("minter")).await;
    instance.hold("key.create");
    let mint = instance.call(&secret, Method::POST, "/keys", Some(bare("late")));
    let revoke = async {
        instance.when_held().await;
        let path = format!("/keys/{id}");
        let done = instance.local(Method::DELETE, &path, None).await;
        assert_eq!(done.status, StatusCode::OK);
        instance.app.faults.clear(None);
    };
    let (minted, ()) = tokio::join!(mint, revoke);
    assert_eq!(minted.status, StatusCode::UNAUTHORIZED, "{}", minted.body);
    assert_eq!(instance.audited("key.create").await.len(), 1);
    assert_eq!(instance.audited("key.revoke").await.len(), 1);
}

#[tokio::test]
async fn a_key_that_expires_while_its_write_waits_writes_nothing() {
    let instance = Instance::start(&[]).await;
    let ends = instance
        .app
        .clock
        .now()
        .checked_add_signed(chrono::Duration::hours(1))
        .unwrap()
        .to_rfc3339();
    let mut body = bare("ending");
    body["expires_at"] = ends.into();
    let (_, secret) = instance.key(body).await;
    instance.hold("source.update");
    let path = "/source?source=ending";
    let write = instance.call(
        &secret,
        Method::PATCH,
        path,
        Some(json!({ "name": "Late" })),
    );
    let expire = async {
        instance.when_held().await;
        instance.app.clock.advance(2 * 3_600_000).unwrap();
        instance.app.faults.clear(None);
    };
    let (written, ()) = tokio::join!(write, expire);
    assert_eq!(written.status, StatusCode::UNAUTHORIZED, "{}", written.body);
    assert_eq!(instance.audited("source.update").await.len(), 0);
}

#[tokio::test]
async fn a_key_narrowed_while_its_mint_waits_is_held_to_what_it_holds_then() {
    let instance = Instance::start(&[]).await;
    let (id, secret) = instance
        .key(json!({ "label": "m", "source": "m", "permissions": ["keys.mint", "audit.read"] }))
        .await;
    instance.hold("key.create");
    let mut body = bare("late");
    body["permissions"] = json!(["audit.read"]);
    let mint = instance.call(&secret, Method::POST, "/keys", Some(body));
    let narrow = async {
        instance.when_held().await;
        let path = format!("/keys/{id}");
        let change = json!({ "permissions": ["keys.mint"] });
        let done = instance.local(Method::PATCH, &path, Some(change)).await;
        assert_eq!(done.status, StatusCode::OK, "{}", done.body);
        instance.app.faults.clear(None);
    };
    let (minted, ()) = tokio::join!(mint, narrow);
    assert_eq!(minted.status, StatusCode::FORBIDDEN, "{}", minted.body);
    assert_eq!(
        minted.body["error"]["details"]["required_scope"],
        "audit.read"
    );
}

#[tokio::test]
async fn mints_racing_for_one_source_leave_one_key_holding_it() {
    let instance = Instance::start(&[]).await;
    let mints: Vec<_> = (0..8)
        .map(|_| instance.local(Method::POST, "/keys", Some(bare("contested"))))
        .collect();
    let answers = futures_join_all(mints).await;
    let won = answers
        .iter()
        .filter(|answer| answer.status == StatusCode::CREATED);
    assert_eq!(won.count(), 1);
    for answer in answers
        .iter()
        .filter(|answer| answer.status != StatusCode::CREATED)
    {
        assert_eq!(answer.status, StatusCode::CONFLICT, "{}", answer.body);
        assert_eq!(answer.body["error"]["details"]["source"], "contested");
    }
}

async fn futures_join_all<F: Future<Output = Reply> + Send>(calls: Vec<F>) -> Vec<Reply> {
    let mut answers = Vec::new();
    let mut pending: Vec<_> = calls.into_iter().map(Box::pin).collect();
    std::future::poll_fn(|context| {
        pending.retain_mut(|call| match call.as_mut().poll(context) {
            std::task::Poll::Ready(answer) => {
                answers.push(answer);
                false
            }
            std::task::Poll::Pending => true,
        });
        if pending.is_empty() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    answers
}

#[tokio::test]
async fn what_is_no_credential_is_refused_and_earns_nothing_on_the_control_socket() {
    let instance = Instance::start(&[]).await;
    let long = "x".repeat(64 * 1024);
    let not_text = HeaderValue::from_bytes(b"Bearer \xff\xfe").unwrap();
    let cases = [
        HeaderValue::from_str(&format!("Bearer {WRONG_PREFIX}")).unwrap(),
        HeaderValue::from_str(&format!("Bearer {long}")).unwrap(),
        not_text,
        HeaderValue::from_static("Bearer"),
        HeaderValue::from_static("Basic abc"),
        HeaderValue::from_static(""),
    ];
    for value in cases {
        for router in [&instance.public, &instance.control] {
            let mut bad = request(Method::GET, "/keys", None, None);
            bad.headers_mut()
                .insert(header::AUTHORIZATION, value.clone());
            let refused = send(router, bad).await;
            assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{value:?}");
        }
    }
    let (_, secret) = instance.key(bare("twice")).await;
    let mut twice = request(Method::GET, "/keys/current", Some(&secret), None);
    twice.headers_mut().append(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {secret}")).unwrap(),
    );
    assert_eq!(
        send(&instance.public, twice).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_key_on_the_control_socket_is_that_key_and_not_the_local_command() {
    let instance = Instance::start(&[]).await;
    let (_, secret) = instance.key(bare("plain")).await;
    let asked = request(Method::GET, "/keys", Some(&secret), None);
    assert_eq!(
        send(&instance.control, asked).await.status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn a_read_does_not_wait_on_the_writer_to_record_a_use() {
    let instance = Instance::start(&[]).await;
    let (id, secret) = instance.key(bare("used")).await;
    let current = instance
        .call(&secret, Method::GET, "/keys/current", None)
        .await;
    assert_eq!(current.status, StatusCode::OK);
    assert_eq!(current.body["id"], id.as_str());
    assert!(current.body.get("key").is_none());
    for _ in 0..500 {
        let again = instance
            .call(&secret, Method::GET, "/keys/current", None)
            .await;
        if again.body["last_used_at"].is_string() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("the use was never recorded");
}

#[tokio::test]
async fn the_cap_counts_a_credential_only_under_keys() {
    let instance = Instance::start(&[
        ("MARFA_RATE_LIMIT_ENABLED", "true"),
        ("MARFA_RATE_LIMIT_KEYS_REQUESTS", "2"),
    ])
    .await;
    let (_, secret) = instance.key(bare("capped")).await;
    let limit = HeaderName::from_static("x-ratelimit-limit");
    for _ in 0..2 {
        let answer = instance
            .call(&secret, Method::GET, "/keys/current", None)
            .await;
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.headers[&limit], "2");
    }
    let over = instance.call(&secret, Method::GET, "/keys", None).await;
    assert_eq!(over.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(over.headers[&limit], "2");
    assert!(over.headers.contains_key(header::RETRY_AFTER));
    let elsewhere = instance.call(&secret, Method::GET, "/sources", None).await;
    assert_eq!(elsewhere.status, StatusCode::OK);
}
