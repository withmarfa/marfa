//! The sign-in server end to end, with a software browser.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::access::Caller;
use marfa_server::app::auth::Visit;
use marfa_server::app::auth::sign_ins;
use marfa_server::app::keys;
use marfa_server::app::oauth::authorize::sign_in_then;
use marfa_server::app::oauth::grants::{self, Narrowing};
use marfa_server::app::oauth::scope::ScopeSet;
use marfa_server::app::oauth::signed_link;
use marfa_server::app::refusal::Code;
use marfa_server::app::{App, housekeeping};
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::registry::{
    DCR_CLIENT_RETENTION_DAYS, GRANT_INACTIVITY_DAYS, REVOKED_GRANT_RETENTION_DAYS,
};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use support::{commit_unpublished, remove_unpublished};

mod support;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

const ORIGIN: &str = "http://127.0.0.1:8600";
const EMAIL: &str = "owner@example.test";
const PASSWORD: &str = "the first password";
const CALLBACK: &str = "http://127.0.0.1:9/callback";
const NOTES: &str = "core.note:read";
const OFFLINE_NOTES: &str = "core.note:write offline_access";
const VERIFIER: &str = "a-verifier-long-enough-for-the-pkce-rule-of-43-characters";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DAY_MS: u64 = 86_400_000;
const AN_APPROVED_PAGE: &str = "https://approved.example";

struct Cleaned {
    deleted: u64,
    retired: u64,
}

async fn cleaned(app: &Arc<App>) -> Cleaned {
    let ended = housekeeping::run_now(app, "credential-cleanup")
        .await
        .unwrap();
    assert_eq!(ended.outcome, "ok", "{:?}", ended.error);
    let result = ended.result.unwrap();
    let count = |name: &str| result[name].as_u64().unwrap();
    Cleaned {
        deleted: count("deleted"),
        retired: count("retired"),
    }
}

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    cookie: String,
}

struct Reply {
    status: StatusCode,
    text: String,
    headers: HeaderMap,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }

    fn location(&self) -> Option<Url> {
        let line = self.headers.get(header::LOCATION)?.to_str().ok()?;
        Url::parse(line)
            .or_else(|_| Url::parse(ORIGIN)?.join(line))
            .ok()
    }

    fn cookie(&self) -> Option<String> {
        let line = self.headers.get(header::SET_COOKIE)?.to_str().ok()?;
        Some(line.split(';').next()?.to_string())
    }
}

async fn send(router: Router, request: Request<Body>) -> Reply {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        headers,
    }
}

fn post_json(path: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn encoded(fields: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish()
}

fn post_form(path: &str, cookie: Option<&str>, fields: &[(&str, &str)]) -> Request<Body> {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ORIGIN, ORIGIN);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::from(encoded(fields))).unwrap()
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().uri(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::empty()).unwrap()
}

fn challenge() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER))
}

async fn boot(dir: &TempDir) -> Arc<App> {
    let database = dir.path().join("marfa.db");
    let blobs = dir.path().join("blobs");
    let socket = dir.path().join("s.sock");
    let pairs = [
        ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
        ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
        ("MARFA_KEY_SALT", "a salt for these tests"),
    ];
    let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
    App::start(settings).await.unwrap()
}

impl Instance {
    async fn signed_in() -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot(&dir).await;
        let claim = json!({ "email": EMAIL, "password": PASSWORD });
        let claimed = send(
            control(app.clone()),
            post_json("/_control/setup/claim", &claim),
        )
        .await;
        assert_eq!(claimed.status, StatusCode::CREATED);
        let public = public(app.clone());
        let signed_in = send(public.clone(), post_json("/auth/sign-in", &claim)).await;
        assert_eq!(signed_in.status, StatusCode::OK);
        Instance {
            cookie: signed_in.cookie().unwrap(),
            _dir: dir,
            app,
            public,
        }
    }

    fn without_limits(&self) {
        self.app
            .settings
            .apply_stored(&[("rate_limit_enabled".to_string(), "false".to_string())]);
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        send(self.public.clone(), request).await
    }

    async fn register_with(&self, body: Value) -> String {
        let reply = self.send(post_json("/auth/oauth2/register", &body)).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text);
        reply.json()["client_id"].as_str().unwrap().to_string()
    }

    async fn register(&self, scope: &str) -> String {
        self.register_with(json!({
            "client_name": "a fixture app",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        }))
        .await
    }

    async fn authorize(&self, client: &str, scope: &str, redirect_uri: &str) -> Reply {
        let query = encoded(&[
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", redirect_uri),
            ("state", "the-state"),
            ("scope", scope),
            ("code_challenge", &challenge()),
            ("code_challenge_method", "S256"),
        ]);
        self.send(get(
            &format!("/auth/oauth2/authorize?{query}"),
            Some(&self.cookie),
        ))
        .await
    }

    async fn consent_link(&self, client: &str, scope: &str) -> String {
        self.consent_link_to(client, scope, CALLBACK).await
    }

    async fn consent_link_to(&self, client: &str, scope: &str, redirect_uri: &str) -> String {
        let reply = self.authorize(client, scope, redirect_uri).await;
        assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
        let landed = reply.location().unwrap();
        assert_eq!(landed.path(), "/auth/authorize", "{landed}");
        landed.query().unwrap().to_string()
    }

    async fn decide(&self, link: &str, scopes: &[&str]) -> Reply {
        let mut fields = vec![("accept", "true"), ("oauth_query", link)];
        fields.extend(scopes.iter().map(|scope| ("scopes", *scope)));
        self.send(post_form(
            "/auth/authorize/decision",
            Some(&self.cookie),
            &fields,
        ))
        .await
    }

    async fn code(&self, client: &str, scope: &str) -> String {
        let reply = self.authorize(client, scope, CALLBACK).await;
        if let Some(code) = code_in(&reply) {
            return code;
        }
        let link = reply.location().unwrap().query().unwrap().to_string();
        let scopes: Vec<&str> = scope.split(' ').collect();
        let reply = self.decide(&link, &scopes).await;
        assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
        code_in(&reply).unwrap()
    }

    async fn exchange(&self, client: &str, code: &str) -> Reply {
        self.exchange_at(client, code, CALLBACK).await
    }

    async fn exchange_at(&self, client: &str, code: &str, redirect_uri: &str) -> Reply {
        let fields = [
            ("grant_type", "authorization_code"),
            ("client_id", client),
            ("code", code),
            ("code_verifier", VERIFIER),
            ("redirect_uri", redirect_uri),
        ];
        self.send(post_form("/auth/oauth2/token", None, &fields))
            .await
    }

    async fn refresh(&self, client: &str, token: &str) -> Reply {
        let fields = [
            ("grant_type", "refresh_token"),
            ("client_id", client),
            ("refresh_token", token),
        ];
        self.send(post_form("/auth/oauth2/token", None, &fields))
            .await
    }

    async fn revoke(&self, client: &str, token: &str) {
        let fields = [("client_id", client), ("token", token)];
        let reply = self
            .send(post_form("/auth/oauth2/revoke", None, &fields))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    }

    async fn tokens(&self, client: &str, scope: &str) -> Value {
        let code = self.code(client, scope).await;
        let reply = self.exchange(client, &code).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.json()
    }

    async fn write_note(&self, token: &str) -> Reply {
        let body = json!({ "type": "core.note", "properties": { "body": "from an app" } });
        self.write_item(token, &body).await
    }

    async fn write_item(&self, token: &str, body: &Value) -> Reply {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/items")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
    }

    async fn register_device(&self, scope: &str) -> String {
        self.register_with(json!({
            "client_name": "a fixture device",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": [DEVICE_GRANT, "refresh_token"],
            "response_types": [],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        }))
        .await
    }

    async fn device_asked(&self, client: &str, scope: &str) -> Value {
        let fields = [("client_id", client), ("scope", scope)];
        let asked = self
            .send(post_form("/auth/device/code", None, &fields))
            .await;
        assert_eq!(asked.status, StatusCode::OK, "{}", asked.text);
        asked.json()
    }

    async fn device_requested(&self, client: &str, scope: &str) -> String {
        let asked = self.device_asked(client, scope).await;
        text_at(&asked, "device_code").to_string()
    }

    async fn device_approved(&self, client: &str, scope: &str) -> String {
        let asked = self.device_asked(client, scope).await;
        let mut fields = vec![
            ("user_code", text_at(&asked, "user_code")),
            ("decision", "approve"),
        ];
        fields.extend(scope.split(' ').map(|scope| ("scopes", scope)));
        let reply = self
            .send(post_form(
                "/auth/device/consent",
                Some(&self.cookie),
                &fields,
            ))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        text_at(&asked, "device_code").to_string()
    }

    async fn poll(&self, client: &str, device_code: &str) -> Reply {
        let fields = [
            ("grant_type", DEVICE_GRANT),
            ("client_id", client),
            ("device_code", device_code),
        ];
        self.send(post_form("/auth/oauth2/token", None, &fields))
            .await
    }

    async fn stage(&self, statement: &'static str) {
        self.app
            .db
            .write(Write::own(), move |tx| {
                tx.execute(statement, [])?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn count(&self, query: &'static str) -> i64 {
        self.app
            .db
            .read(move |tx| Ok(tx.query_row(query, [], |row| row.get(0))?))
            .await
            .unwrap()
    }

    async fn text_of(&self, query: &'static str) -> String {
        self.app
            .db
            .read(move |tx| Ok(tx.query_row(query, [], |row| row.get(0))?))
            .await
            .unwrap()
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

    async fn grant_and_browser_stand(&self, client: &str, scope: &str) {
        let session = self.send(get("/owner/passkeys", Some(&self.cookie))).await;
        assert_eq!(session.status, StatusCode::OK, "{}", session.text);
        let reply = self.authorize(client, scope, CALLBACK).await;
        assert!(code_in(&reply).is_some(), "{:?}", reply.location());
    }
}

fn code_in(reply: &Reply) -> Option<String> {
    let sent = reply.location()?;
    sent.query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, code)| code.into_owned())
}

fn text_at<'v>(answer: &'v Value, field: &str) -> &'v str {
    answer[field].as_str().unwrap()
}

fn refused_as(reply: &Reply, error: &str) {
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
    assert_eq!(reply.json()["error"], error, "{}", reply.text);
}

#[tokio::test]
async fn an_approval_writes_the_grant_and_answers_a_code() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let reply = instance.decide(&link, &[NOTES]).await;
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let sent = reply.location().unwrap();
    assert!(sent.as_str().starts_with(CALLBACK), "{sent}");
    assert!(code_in(&reply).is_some());
    let grants = "SELECT count(*) FROM items WHERE type = 'system.connection'";
    assert_eq!(instance.count(grants).await, 1);
}

#[tokio::test]
async fn two_exchanges_of_one_code_at_once_leave_no_tokens_standing() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let code = instance.code(&client, NOTES).await;
    let (first, second) = tokio::join!(
        instance.exchange(&client, &code),
        instance.exchange(&client, &code)
    );
    let mut statuses = [first.status, second.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::BAD_REQUEST]);
    let loser = if first.status == StatusCode::OK {
        second
    } else {
        first
    };
    refused_as(&loser, "invalid_grant");
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 0);
}

#[tokio::test]
async fn a_replayed_code_ends_everything_it_issued_and_nothing_else() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let code = instance.code(&client, OFFLINE_NOTES).await;
    let issued = instance.exchange(&client, &code).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let rotated = instance
        .refresh(&client, text_at(&issued.json(), "refresh_token"))
        .await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.text);
    let rotated = rotated.json();
    let other = instance.tokens(&client, OFFLINE_NOTES).await;

    refused_as(&instance.exchange(&client, &code).await, "invalid_grant");

    let ended = instance.write_note(text_at(&rotated, "access_token")).await;
    assert_eq!(ended.status, StatusCode::UNAUTHORIZED, "{}", ended.text);
    let refreshed = instance
        .refresh(&client, text_at(&rotated, "refresh_token"))
        .await;
    refused_as(&refreshed, "invalid_grant");
    let standing = instance.write_note(text_at(&other, "access_token")).await;
    assert_eq!(standing.status, StatusCode::CREATED, "{}", standing.text);

    let replays = "SELECT count(*) FROM audit_log WHERE action = 'auth.code.replayed'";
    assert_eq!(instance.count(replays).await, 1);
    let details = "SELECT details FROM audit_log WHERE action = 'auth.code.replayed'";
    assert!(!instance.text_of(details).await.contains(&code));
    refused_as(&instance.exchange(&client, &code).await, "invalid_grant");
    assert_eq!(instance.count(replays).await, 1);
}

#[tokio::test]
async fn a_spent_code_stays_until_its_expiry_and_ends_nothing_after() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let code = instance.code(&client, NOTES).await;
    let issued = instance.exchange(&client, &code).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let rows = "SELECT count(*) FROM oauth_codes";
    assert_eq!(instance.count(rows).await, 1);

    instance.app.clock.advance(601_000).unwrap();
    refused_as(&instance.exchange(&client, &code).await, "invalid_grant");
    let replays = "SELECT count(*) FROM audit_log WHERE action = 'auth.code.replayed'";
    assert_eq!(instance.count(replays).await, 0);
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 1);

    cleaned(&instance.app).await;
    assert_eq!(instance.count(rows).await, 0);
}

#[tokio::test]
async fn an_exchange_that_failed_burns_the_code_and_names_no_replay() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let code = instance.code(&client, NOTES).await;
    let fields = [
        ("grant_type", "authorization_code"),
        ("client_id", client.as_str()),
        ("code", code.as_str()),
        (
            "code_verifier",
            "a-wrong-verifier-long-enough-for-the-pkce-rule-of-43",
        ),
        ("redirect_uri", CALLBACK),
    ];
    let wrong = instance
        .send(post_form("/auth/oauth2/token", None, &fields))
        .await;
    refused_as(&wrong, "invalid_grant");

    refused_as(&instance.exchange(&client, &code).await, "invalid_grant");
    let replays = "SELECT count(*) FROM audit_log WHERE action = 'auth.code.replayed'";
    assert_eq!(instance.count(replays).await, 0);
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 0);
}

#[tokio::test]
async fn a_refresh_retried_after_a_lost_answer_ends_the_chain_and_nothing_else() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let spent = text_at(&issued, "refresh_token");

    let lost = instance.refresh(&client, spent).await;
    assert_eq!(lost.status, StatusCode::OK, "{}", lost.text);
    let lost = lost.json();
    let written = instance.write_note(text_at(&lost, "access_token")).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);

    let retried = instance.refresh(&client, spent).await;
    refused_as(&retried, "invalid_grant");
    let after = instance.write_note(text_at(&lost, "access_token")).await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED, "{}", after.text);
    let next = instance
        .refresh(&client, text_at(&lost, "refresh_token"))
        .await;
    refused_as(&next, "invalid_grant");
    instance
        .grant_and_browser_stand(&client, OFFLINE_NOTES)
        .await;
}

#[tokio::test]
async fn two_refreshes_at_once_cannot_both_leave_a_live_token() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let token = text_at(&issued, "refresh_token");
    let (first, second) = tokio::join!(
        instance.refresh(&client, token),
        instance.refresh(&client, token)
    );
    let mut statuses = [first.status, second.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::BAD_REQUEST]);
    let live = "SELECT count(*) FROM oauth_refresh_tokens \
                WHERE ended_at IS NULL AND rotated_at IS NULL";
    assert_eq!(instance.count(live).await, 0);
    instance
        .grant_and_browser_stand(&client, OFFLINE_NOTES)
        .await;
}

#[tokio::test]
async fn a_decision_whose_commit_is_unknown_hands_out_no_code() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let aim = Some("item.create");
    instance.app.faults.set("fail:commit-full", aim).unwrap();
    let reply = instance.decide(&link, &[NOTES]).await;
    instance.app.faults.clear(None);
    assert!(reply.status.is_server_error(), "{}", reply.text);
    assert_eq!(
        reply.json()["error"]["details"]["write_outcome"],
        "unknown",
        "{}",
        reply.text
    );
    assert!(reply.location().is_none());
    assert!(!reply.text.contains(CALLBACK), "{}", reply.text);
    let reply = instance.decide(&link, &[NOTES]).await;
    assert!(code_in(&reply).is_some(), "{}", reply.text);
}

#[tokio::test]
async fn an_exchange_whose_commit_is_unknown_hands_out_no_token() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let code = instance.code(&client, NOTES).await;
    let action = Some("auth.token.issued");
    instance.app.faults.set("fail:commit-full", action).unwrap();
    let reply = instance.exchange(&client, &code).await;
    instance.app.faults.clear(None);
    assert!(reply.status.is_server_error(), "{}", reply.text);
    assert_eq!(
        reply.json()["error"]["details"]["write_outcome"],
        "unknown",
        "{}",
        reply.text
    );
    assert!(!reply.text.contains("access_token"), "{}", reply.text);
}

#[tokio::test]
async fn a_failed_audit_undoes_the_whole_approval() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let grants = "SELECT count(*) FROM items WHERE type = 'system.connection'";
    let consents = "SELECT count(*) FROM oauth_consents";
    let events = "SELECT count(*) FROM event_log";
    let codes = "SELECT count(*) FROM oauth_codes";
    let events_before = instance.count(events).await;

    let aim = Some("item.create");
    instance.app.faults.set("fail:audit", aim).unwrap();
    let reply = instance.decide(&link, &[NOTES]).await;
    instance.app.faults.clear(None);
    assert!(reply.status.is_server_error(), "{}", reply.text);
    assert_eq!(instance.count(grants).await, 0);
    assert_eq!(instance.count(consents).await, 0);
    assert_eq!(instance.count(codes).await, 0);
    assert_eq!(instance.count(events).await, events_before);

    let reply = instance.decide(&link, &[NOTES]).await;
    assert!(code_in(&reply).is_some(), "{}", reply.text);
    assert_eq!(instance.count(grants).await, 1);
    assert_eq!(instance.count(consents).await, 1);
    assert_eq!(instance.count(codes).await, 1);
    assert!(instance.count(events).await > events_before);
}

#[tokio::test]
async fn a_failed_audit_leaves_a_withdrawal_undone() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let aim = Some("auth.grant.revoked");
    instance.app.faults.set("fail:audit", aim).unwrap();
    let fields = [
        ("client_id", client.as_str()),
        ("token", text_at(&issued, "refresh_token")),
    ];
    let reply = instance
        .send(post_form("/auth/oauth2/revoke", None, &fields))
        .await;
    instance.app.faults.clear(None);
    assert!(reply.status.is_server_error(), "{}", reply.text);
    let written = instance.write_note(text_at(&issued, "access_token")).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);
    let withdrawn = "SELECT count(*) FROM oauth_consents WHERE withdrawn_at IS NOT NULL";
    assert_eq!(instance.count(withdrawn).await, 0);
}

#[tokio::test]
async fn a_code_dies_with_the_browser_session_that_approved_it() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let code = instance.code(&client, NOTES).await;
    let witness = instance.code(&client, NOTES).await;
    let reply = instance.exchange(&client, &witness).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);

    let left = instance
        .send(post_form("/auth/sign-out", Some(&instance.cookie), &[]))
        .await;
    assert!(left.status.is_success(), "{}", left.text);
    let reply = instance.exchange(&client, &code).await;
    refused_as(&reply, "invalid_request");
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 1);
}

#[tokio::test]
async fn a_grant_revoked_between_approval_and_poll_issues_nothing() {
    let instance = Instance::signed_in().await;
    let scope = "core.note:read offline_access";
    let client = instance.register_device(scope).await;

    let first = instance.device_approved(&client, scope).await;
    let issued = instance.poll(&client, &first).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let late = instance.device_approved(&client, scope).await;
    instance
        .revoke(&client, text_at(&issued.json(), "refresh_token"))
        .await;
    refused_as(&instance.poll(&client, &late).await, "invalid_grant");
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 0);
}

#[tokio::test]
async fn a_poll_that_cannot_read_the_consent_fails_as_the_server() {
    let instance = Instance::signed_in().await;
    let scope = "core.note:read offline_access";
    let client = instance.register_device(scope).await;
    let device_code = instance.device_approved(&client, scope).await;
    instance
        .stage("UPDATE oauth_consents SET scopes = 'not a list'")
        .await;

    let reply = instance.poll(&client, &device_code).await;
    assert_eq!(
        reply.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        reply.text
    );
    let spent = "SELECT count(*) FROM oauth_device_codes WHERE status = 'spent'";
    assert_eq!(instance.count(spent).await, 0);
}

#[tokio::test]
async fn a_stored_set_whose_literals_do_not_cover_each_other_still_stands() {
    let instance = Instance::signed_in().await;
    let scope = "*:write core.*:read";
    let client = instance.register(scope).await;
    let code = instance.code(&client, scope).await;
    let reply = instance.exchange(&client, &code).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);

    let again = instance.authorize(&client, scope, CALLBACK).await;
    assert!(code_in(&again).is_some(), "{:?}", again.location());
    let wider = instance
        .register("*:write core.*:read offline_access")
        .await;
    let first = instance.consent_link(&wider, "*:read").await;
    let held = instance.decide(&first, &["*:read"]).await;
    assert!(code_in(&held).is_some(), "{}", held.text);
    let more = instance.authorize(&wider, "*:write", CALLBACK).await;
    assert_eq!(more.location().unwrap().path(), "/auth/authorize");
}

#[tokio::test]
async fn a_post_naming_a_scope_the_request_narrowed_away_grants_nothing() {
    let instance = Instance::signed_in().await;
    let client = instance.register("*:read").await;
    let wide = "*:read system.*:read";
    let shown = instance.consent_link(&client, "*:read").await;
    let destinations = url::form_urlencoded::parse(shown.as_bytes())
        .find(|(name, _)| name == "destinations")
        .unwrap()
        .1
        .into_owned();
    let params: Vec<(String, String)> = [
        ("client_id", client.as_str()),
        ("redirect_uri", CALLBACK),
        ("response_type", "code"),
        ("code_challenge", &challenge()),
        ("code_challenge_method", "S256"),
        ("scope", wide),
        ("destinations", &destinations),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value.to_string()))
    .collect();
    let exp = instance.app.clock.now_ms() / 1_000 + 600;
    let secret = &instance.app.settings.start.auth_secret;
    let link = signed_link::sign(&params, exp, secret).unwrap();
    let consents = "SELECT count(*) FROM oauth_consents";

    let reply = instance.decide(&link, &["system.*:read"]).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
    assert_eq!(instance.count(consents).await, 0);
    let witness = instance.decide(&link, &["*:read"]).await;
    assert!(code_in(&witness).is_some(), "{}", witness.text);
    assert_eq!(instance.count(consents).await, 1);
}

#[tokio::test]
async fn approving_with_nothing_chosen_denies() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let reply = instance.decide(&link, &[]).await;
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let sent = reply.location().unwrap();
    assert!(sent.as_str().starts_with(CALLBACK), "{sent}");
    assert!(
        sent.query_pairs()
            .any(|(n, v)| n == "error" && v == "access_denied")
    );
    assert_eq!(
        instance
            .count("SELECT count(*) FROM oauth_consents")
            .await,
        0
    );
}

#[tokio::test]
async fn the_exchange_compares_the_redirect_uri_as_the_authorization_wrote_it() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let elsewhere = "http://127.0.0.1:4242/callback";
    let link = instance.consent_link_to(&client, NOTES, elsewhere).await;
    let reply = instance.decide(&link, &[NOTES]).await;
    let sent = reply.location().unwrap();
    assert!(sent.as_str().starts_with(elsewhere), "{sent}");
    let code = code_in(&reply).unwrap();
    let refused = instance.exchange_at(&client, &code, CALLBACK).await;
    refused_as(&refused, "invalid_grant");

    let reply = instance.authorize(&client, NOTES, elsewhere).await;
    let code = code_in(&reply).unwrap();
    let passed = instance.exchange_at(&client, &code, elsewhere).await;
    assert_eq!(passed.status, StatusCode::OK, "{}", passed.text);
}

#[tokio::test]
async fn an_unregistered_redirect_is_never_used_or_echoed() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    for (uri, what) in [
        ("https://elsewhere.example/callback", "elsewhere.example"),
        ("http://2130706433:9/callback", "2130706433"),
        ("HTTP://127.0.0.1:9/callback", "HTTP:"),
    ] {
        let reply = instance.authorize(&client, NOTES, uri).await;
        assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
        let line = reply.headers[header::LOCATION].to_str().unwrap();
        assert_eq!(line, "/auth/error?error=invalid_redirect");
        assert!(!reply.text.contains(what));
        assert!(!reply.text.contains("the-state"));
    }
}

#[tokio::test]
async fn the_consent_page_never_loads_a_logo() {
    let instance = Instance::signed_in().await;
    let logo = "https://images.example/logo.png";
    let client = instance
        .register_with(json!({
            "client_name": "An app with a logo",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": NOTES,
            "logo_uri": logo,
        }))
        .await;
    let link = instance.consent_link(&client, NOTES).await;
    let page = instance
        .send(get(
            &format!("/auth/authorize?{link}"),
            Some(&instance.cookie),
        ))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    assert!(page.text.contains("An app with a logo"), "{}", page.text);
    assert!(!page.text.contains("images.example"), "{}", page.text);
}

#[tokio::test]
async fn a_return_to_beside_a_link_never_leaves_this_server() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let forged = format!("/auth/authorize?{link}&return_to=https%3A%2F%2Felsewhere.example%2F");
    let reply = instance.send(get(&forged, None)).await;
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let landed = reply.location().unwrap();
    assert_eq!(landed.path(), "/auth/sign-in");
    let back = landed
        .query_pairs()
        .find(|(name, _)| name == "return_to")
        .map(|(_, back)| back.into_owned())
        .unwrap();
    assert!(back.starts_with("/auth/authorize?"), "{back}");

    for elsewhere in ["https://elsewhere.example/", "//elsewhere.example/"] {
        let way = sign_in_then(&instance.app, elsewhere);
        assert!(!way.contains("elsewhere"), "{way}");
    }
}

#[tokio::test]
async fn a_page_the_cors_origins_setting_names_is_answered_and_no_other() {
    let instance = Instance::signed_in().await;
    let named = "https://named.example";
    instance
        .app
        .settings
        .apply_stored(&[("cors_origins".to_string(), json!([named]).to_string())]);
    let asks = |page: &str| {
        from_page(Method::GET, "/keys", page)
            .body(Body::empty())
            .unwrap()
    };

    let answered = instance.send(asks(named)).await;
    assert_eq!(answered.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], named);

    let preflight = from_page(Method::OPTIONS, "/items", named)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .body(Body::empty())
        .unwrap();
    let reply = instance.send(preflight).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text);
    assert!(reply.headers.contains_key("x-marfa-contract"));

    let other = instance.send(asks("https://other.example")).await;
    assert!(
        !other
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
}

#[tokio::test]
async fn the_item_door_still_refuses_a_grant_a_person_did_not_approve() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.code(&client, NOTES).await;
    let grants = "SELECT count(*) FROM items WHERE type = 'system.connection'";
    assert_eq!(instance.count(grants).await, 1);
    let body = json!({ "type": "system.connection", "properties": { "kind": "app" } });
    let mut request = post_json("/items", &body);
    request
        .headers_mut()
        .insert(header::COOKIE, instance.cookie.parse().unwrap());
    let reply = instance.send(request).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.text);
    assert_eq!(instance.count(grants).await, 1);
}

#[tokio::test]
async fn a_browser_session_reaches_no_content_door() {
    let instance = Instance::signed_in().await;
    let by_owner = |path: &str| {
        Request::builder()
            .uri(path)
            .header(header::COOKIE, &instance.cookie)
            .body(Body::empty())
            .unwrap()
    };
    // The witness: the same session counts on the passkey page's list.
    let page = instance.send(by_owner("/owner/passkeys")).await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    for path in [
        "/items/stats",
        "/items",
        "/edges",
        "/search?q=kept",
        "/metadata/tags",
    ] {
        let refused = instance.send(by_owner(path)).await;
        assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{path}");
    }

    let by_command = Request::builder()
        .uri("/items/stats")
        .body(Body::empty())
        .unwrap();
    let local = send(control(instance.app.clone()), by_command).await;
    assert_eq!(local.status, StatusCode::UNAUTHORIZED, "{}", local.text);
}

#[tokio::test]
async fn a_tool_call_an_app_lacks_a_scope_for_is_challenged_to_step_up() {
    let instance = Instance::signed_in().await;
    let scope = "core.task:write core.note:read offline_access";
    let client = instance.register(scope).await;
    let issued = instance.tokens(&client, scope).await;
    let token = text_at(&issued, "access_token");
    let create = |type_id: &str| {
        let message = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "marfa_create",
                "arguments": { "type": type_id, "properties": { "title": "Needs a scope" } },
            },
        });
        Request::builder()
            .method(Method::POST)
            .uri("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(message.to_string()))
            .unwrap()
    };
    let challenged = instance.send(create("core.note")).await;
    assert_eq!(
        challenged.status,
        StatusCode::FORBIDDEN,
        "{}",
        challenged.text
    );
    let header = challenged
        .headers
        .get(header::WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let origin = instance.app.addresses().sign_in().origin().to_string();
    assert!(header.starts_with("Bearer "), "{header}");
    assert!(header.contains("error=\"insufficient_scope\""), "{header}");
    assert!(header.contains("scope=\"core.note:write\""), "{header}");
    assert!(
        header.contains(&format!(
            "resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\""
        )),
        "{header}"
    );
    // The witnesses: the type the token writes is saved, and a type nothing registered is the
    // tool's error, not a challenge.
    let saved = instance.send(create("core.task")).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);
    assert!(saved.text.contains("created"), "{}", saved.text);
    let unregistered = instance.send(create("user.nothing")).await;
    assert_eq!(unregistered.status, StatusCode::OK, "{}", unregistered.text);
    assert!(unregistered.headers.get(header::WWW_AUTHENTICATE).is_none());
}

#[tokio::test]
async fn an_app_cannot_write_a_system_type_its_scope_names() {
    let instance = Instance::signed_in().await;
    let scope = "core.note:write system.view:write offline_access";
    let client = instance.register(scope).await;
    let issued = instance.tokens(&client, scope).await;
    let token = text_at(&issued, "access_token");

    let written = instance.write_note(token).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);

    let body = json!({ "type": "system.view", "properties": { "name": "from an app" } });
    let refused = instance.write_item(token, &body).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    assert_eq!(refused.json()["error"]["code"], "type_not_permitted");
    let views = "SELECT count(*) FROM items WHERE type = 'system.view'";
    assert_eq!(instance.count(views).await, 0);
}

#[tokio::test]
async fn the_instance_levers_hold_for_a_key_and_an_app() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let token = text_at(&issued, "access_token");
    let written = instance.write_note(token).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);
    let body = json!({
        "label": "a reader",
        "source": "a-reader",
        "type_permissions": { "core.note": "read" },
    });
    let minted = instance.local(post_json("/keys", &body)).await;
    assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
    let reader = text_at(&minted.json(), "key").to_string();

    let counted = async || {
        let request = from_token(Method::GET, "/items/stats?type=core.note", &reader);
        let reply = instance.send(request).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.json()
    };
    let by_app = || {
        Request::builder()
            .uri("/items?type=core.note")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let listed = async |request| {
        let reply = instance.send(request).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.json()["data"].as_array().unwrap().len()
    };
    assert_eq!(counted().await, json!({ "active": 1 }));
    assert_eq!(listed(by_app()).await, 1);

    let held = json!({
        "enforcement": {
            "source_filter": { "types": ["core.note"], "sources": ["elsewhere"] },
            "source_allowlist": { "types": ["core.note"], "sources": ["elsewhere"] },
        }
    });
    let mut configure = post_json("/config", &held);
    *configure.method_mut() = Method::PATCH;
    let configured = send(control(instance.app.clone()), configure).await;
    assert_eq!(configured.status, StatusCode::OK, "{}", configured.text);

    assert_eq!(counted().await, json!({}));
    assert_eq!(listed(by_app()).await, 0);
    let refused = instance.write_note(token).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
}

#[tokio::test]
async fn an_app_revoked_while_its_write_waits_writes_nothing() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let token = text_at(&issued, "access_token");
    let notes = "SELECT count(*) FROM items WHERE type = 'core.note'";
    let witness = instance.write_note(token).await;
    assert_eq!(witness.status, StatusCode::CREATED, "{}", witness.text);
    assert_eq!(instance.count(notes).await, 1);

    instance
        .app
        .faults
        .set("hold:write", Some("item.create"))
        .unwrap();
    let write = instance.write_note(token);
    let revoke = async {
        instance.when_held().await;
        instance
            .revoke(&client, text_at(&issued, "refresh_token"))
            .await;
        instance.app.faults.clear(None);
    };
    let (written, ()) = tokio::join!(write, revoke);
    assert_eq!(written.status, StatusCode::UNAUTHORIZED, "{}", written.text);
    assert_eq!(instance.count(notes).await, 1);
}

#[tokio::test]
async fn a_version_an_app_wrote_names_its_grant() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let written = instance.write_note(text_at(&issued, "access_token")).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);
    let kind = "SELECT writer_kind FROM items WHERE type = 'core.note'";
    let id = "SELECT writer_id FROM items WHERE type = 'core.note'";
    let grant = "SELECT id FROM items WHERE type = 'system.connection'";
    assert_eq!(instance.text_of(kind).await, "app");
    assert_eq!(instance.text_of(id).await, instance.text_of(grant).await);
}

#[tokio::test]
async fn cleanup_takes_only_the_clients_nothing_holds() {
    let instance = Instance::signed_in().await;
    let idle = instance.register(NOTES).await;
    let approved = instance.register(NOTES).await;
    instance.code(&approved, NOTES).await;
    let revoked = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&revoked, OFFLINE_NOTES).await;
    instance
        .revoke(&revoked, text_at(&issued, "refresh_token"))
        .await;
    let offered = instance.register(NOTES).await;
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 4);
    cleaned(&instance.app).await;
    assert_eq!(instance.count(clients).await, 4);

    instance.app.clock.advance(2 * DAY_MS).unwrap();
    let link = instance.consent_link(&offered, NOTES).await;
    let page = instance
        .send(get(
            &format!("/auth/authorize?{link}"),
            Some(&instance.cookie),
        ))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    cleaned(&instance.app).await;
    assert_eq!(instance.count(clients).await, 3);

    let held = async |client: &str| {
        let fields = [
            ("grant_type", "refresh_token"),
            ("client_id", client),
            ("refresh_token", "x"),
        ];
        let reply = instance
            .send(post_form("/auth/oauth2/token", None, &fields))
            .await;
        reply.json()["error"].as_str().unwrap().to_string()
    };
    assert_eq!(held(&idle).await, "invalid_client");
    assert_eq!(held(&approved).await, "invalid_grant");
    assert_eq!(held(&revoked).await, "invalid_grant");
    assert_eq!(held(&offered).await, "invalid_grant");
    let purged = "SELECT count(*) FROM audit_log WHERE action = 'auth.clients.purged'";
    assert_eq!(instance.count(purged).await, 1);
}

#[tokio::test]
async fn a_failing_stage_leaves_the_later_stages_to_run_and_fails_the_run() {
    let instance = Instance::signed_in().await;
    let kept = instance.register(OFFLINE_NOTES).await;
    instance.tokens(&kept, OFFLINE_NOTES).await;
    instance.register(NOTES).await;
    let app = &instance.app;
    app.clock.advance(366 * DAY_MS).unwrap();
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 2);

    app.faults
        .set("fail:commit", Some("auth.grant.retired"))
        .unwrap();
    let ended = housekeeping::run_now(app, "credential-cleanup")
        .await
        .unwrap();
    assert_eq!(instance.count(clients).await, 1);
    assert_eq!(ended.outcome, "error");
    let error = ended.error.unwrap();
    assert!(error.starts_with("idle grants: "), "{error}");

    app.faults.clear(None);
    assert_eq!(cleaned(app).await.retired, 1);
}

#[tokio::test]
async fn an_idle_grant_retires_then_goes_and_its_client_can_follow() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let app = &instance.app;
    assert_eq!(cleaned(app).await.retired, 0);
    let named_by_nobody = "SELECT count(*) FROM items \
                           WHERE type = 'system.connection' AND writer_kind IS NULL";
    assert_eq!(instance.count(named_by_nobody).await, 0);

    app.clock.advance(364 * DAY_MS).unwrap();
    assert_eq!(cleaned(app).await.retired, 0);
    app.clock.advance(2 * DAY_MS).unwrap();
    assert_eq!(cleaned(app).await.retired, 1);
    assert_eq!(cleaned(app).await.retired, 0);
    let refused = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    refused_as(&refused, "invalid_grant");
    let retired = "SELECT count(*) FROM audit_log WHERE action = 'auth.grant.retired'";
    assert_eq!(instance.count(retired).await, 1);
    assert_eq!(instance.count(named_by_nobody).await, 1);
    let grants = "SELECT count(*) FROM items WHERE type = 'system.connection'";
    assert_eq!(instance.count(grants).await, 1);

    let consents = "SELECT count(*) FROM oauth_consents";
    let clients = "SELECT count(*) FROM oauth_clients";
    app.clock.advance(89 * DAY_MS).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(consents).await, 1);
    assert_eq!(instance.count(clients).await, 1);
    app.clock.advance(2 * DAY_MS).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(grants).await, 0);
    assert_eq!(instance.count(consents).await, 0);
    assert_eq!(instance.count(clients).await, 0);
}

#[tokio::test]
async fn a_refreshed_token_spends_the_allowance_of_the_one_before_it() {
    let instance = Instance::signed_in().await;
    instance.app.settings.apply_stored(&[
        ("rate_limit_enabled".to_string(), "true".to_string()),
        ("rate_limit_requests".to_string(), "3".to_string()),
    ]);
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let first = text_at(&issued, "access_token").to_string();
    let refreshed = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    let second = text_at(&refreshed.json(), "access_token").to_string();
    assert_ne!(first, second);

    let read = async |token: &str| {
        let request = Request::builder()
            .uri("/items?type=core.note")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        instance.send(request).await.status
    };
    assert_eq!(read(&first).await, StatusCode::OK);
    assert_eq!(read(&second).await, StatusCode::OK);
    assert_eq!(read(&first).await, StatusCode::OK);
    assert_eq!(read(&second).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(read(&first).await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_purged_grant_takes_the_folder_reports_it_made() {
    let instance = Instance::signed_in().await;
    let scope = "system.folder:read offline_access";
    let client = instance.register(scope).await;
    let issued = instance.tokens(&client, scope).await;
    let body = json!({
        "label": "folders",
        "source": "folders",
        "type_permissions": { "system.folder": "write" },
    });
    let minted = send(control(instance.app.clone()), post_json("/keys", &body)).await;
    assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
    let key = text_at(&minted.json(), "key").to_string();
    let made = Request::builder()
        .method(Method::POST)
        .uri("/folders")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .body(Body::from(json!({ "title": "Copies" }).to_string()))
        .unwrap();
    let made = instance.send(made).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    let folder = text_at(&made.json()["item"], "id").to_string();
    let report = json!({
        "folder_store_id": "copy",
        "sequence": 1,
        "last_success_at": null,
        "pending_uploads": 0,
        "pending_downloads": 0,
        "paused_removals": 0,
        "first_sync_waiting": false,
        "problems": [],
    });
    let report = Request::builder()
        .method(Method::PUT)
        .uri(format!("/folders/{folder}/status"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", text_at(&issued, "access_token")),
        )
        .body(Body::from(report.to_string()))
        .unwrap();
    let reported = instance.send(report).await;
    assert_eq!(reported.status, StatusCode::OK, "{}", reported.text);
    let reports = "SELECT count(*) FROM folder_status WHERE sign_in_kind = 'app'";
    assert_eq!(instance.count(reports).await, 1);

    let grant = instance.grant_of(&client).await;
    assert_eq!(
        instance.end_grant(&grant).await.status,
        StatusCode::NO_CONTENT
    );
    instance.app.clock.advance(89 * DAY_MS).unwrap();
    cleaned(&instance.app).await;
    assert_eq!(instance.count(WITHDRAWN).await, 1);
    assert_eq!(instance.count(reports).await, 1);
    instance.app.clock.advance(2 * DAY_MS).unwrap();
    cleaned(&instance.app).await;
    assert_eq!(instance.count(WITHDRAWN).await, 0);
    assert_eq!(instance.count(reports).await, 0);
}

#[tokio::test]
async fn a_grant_in_use_is_not_idle() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    instance.app.clock.advance(20 * DAY_MS).unwrap();
    let renewed = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.text);
    instance.app.clock.advance(350 * DAY_MS).unwrap();
    assert_eq!(cleaned(&instance.app).await.retired, 0);
}

async fn idle_revoked_and_unused() -> Instance {
    let instance = Instance::signed_in().await;
    let idle = instance.register(OFFLINE_NOTES).await;
    instance.tokens(&idle, OFFLINE_NOTES).await;
    let revoked = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&revoked, OFFLINE_NOTES).await;
    instance
        .revoke(&revoked, text_at(&issued, "refresh_token"))
        .await;
    instance.register(NOTES).await;
    instance.app.clock.advance(366 * DAY_MS).unwrap();
    instance
}

const STANDING: &str = "SELECT count(*) FROM oauth_consents WHERE withdrawn_at IS NULL";
const WITHDRAWN: &str = "SELECT count(*) FROM oauth_consents WHERE withdrawn_at IS NOT NULL";
const CLIENTS: &str = "SELECT count(*) FROM oauth_clients";

#[tokio::test]
async fn the_cleanup_keeps_what_a_retention_committed_before_it_is_live_keeps() {
    let instance = idle_revoked_and_unused().await;
    let app = &instance.app;
    app.faults
        .set("hold:write", Some("auth.grant.retired"))
        .unwrap();
    let running = app.clone();
    let run = tokio::spawn(async move { cleaned(&running).await });
    for (key, next) in [
        ("grant_inactivity_days", Some("auth.grants.purged")),
        ("revoked_grant_retention_days", Some("auth.clients.purged")),
        ("dcr_client_retention_days", None),
    ] {
        instance.when_held().await;
        commit_unpublished(app, key, "0").await;
        app.faults.clear(Some("hold:write"));
        if let Some(next) = next {
            app.faults.set("hold:write", Some(next)).unwrap();
        }
    }
    assert_eq!(run.await.unwrap().retired, 0);
    let live = app.settings.live();
    assert_eq!(live.get(GRANT_INACTIVITY_DAYS), 365);
    assert_eq!(live.get(REVOKED_GRANT_RETENTION_DAYS), 90);
    assert_eq!(live.get(DCR_CLIENT_RETENTION_DAYS), 1);
    assert_eq!(instance.count(STANDING).await, 1);
    assert_eq!(instance.count(WITHDRAWN).await, 1);
    assert_eq!(instance.count(CLIENTS).await, 3);
}

#[tokio::test]
async fn a_retention_that_does_not_read_ends_the_cleanup_in_error_and_deletes_nothing_it_decides() {
    let instance = idle_revoked_and_unused().await;
    let app = &instance.app;
    let rows = [STANDING, WITHDRAWN, CLIENTS];
    let mut before = Vec::new();
    for sql in rows {
        before.push(instance.count(sql).await);
    }

    let keys = [
        "grant_inactivity_days",
        "revoked_grant_retention_days",
        "dcr_client_retention_days",
    ];
    for key in keys {
        commit_unpublished(app, key, "soon").await;
    }
    let ended = housekeeping::run_now(app, "credential-cleanup")
        .await
        .unwrap();
    assert_eq!(ended.outcome, "error");
    let error = ended.error.unwrap();
    for key in keys {
        assert!(error.contains(key), "{key}: {error}");
    }
    let mut kept = Vec::new();
    for sql in rows {
        kept.push(instance.count(sql).await);
    }
    assert_eq!(kept, before);

    for key in keys {
        remove_unpublished(app, key).await;
    }
    assert_eq!(cleaned(app).await.retired, 1);
    assert_eq!(instance.count(STANDING).await, 0);
    let purged = "SELECT count(*) FROM audit_log WHERE action = 'auth.grants.purged'";
    assert_eq!(instance.count(purged).await, 1);
    assert_eq!(instance.count(CLIENTS).await, 1);
}

#[tokio::test]
async fn the_expired_go_and_a_rotated_token_waits_for_its_own_end() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let refreshed = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.text);
    instance.code(&client, OFFLINE_NOTES).await;
    let app = &instance.app;
    assert_eq!(cleaned(app).await.deleted, 0);

    app.clock.advance(2 * 3_600_000).unwrap();
    let both_codes_and_both_access_tokens = 4;
    assert_eq!(
        cleaned(app).await.deleted,
        both_codes_and_both_access_tokens
    );
    let rotated = "SELECT count(*) FROM oauth_refresh_tokens WHERE rotated_at IS NOT NULL";
    assert_eq!(instance.count(rotated).await, 1);
    app.clock.advance(31 * DAY_MS).unwrap();
    let both_tokens_and_the_browser_session = 3;
    assert_eq!(
        cleaned(app).await.deleted,
        both_tokens_and_the_browser_session
    );
    assert_eq!(instance.count(rotated).await, 0);
}

#[tokio::test]
async fn an_expired_browser_session_goes_and_a_live_one_stays() {
    let instance = Instance::signed_in().await;
    let claim = json!({ "email": EMAIL, "password": PASSWORD });
    let again = post_json("/auth/sign-in", &claim);
    assert_eq!(instance.send(again).await.status, StatusCode::OK);
    let sessions = "SELECT count(*) FROM sign_ins";
    assert_eq!(instance.count(sessions).await, 2);
    let app = &instance.app;
    app.db
        .write(Write::own(), |tx| {
            tx.execute(
                "UPDATE sign_ins SET expires_at = '2000-01-01T00:00:00.000Z' \
                 WHERE id = (SELECT id FROM sign_ins LIMIT 1)",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(cleaned(app).await.deleted, 1);
    assert_eq!(instance.count(sessions).await, 1);
}

#[tokio::test]
async fn a_pass_works_through_more_than_one_batch() {
    const MORE_THAN_A_BATCH: u64 = 201;
    let instance = Instance::signed_in().await;
    instance.without_limits();
    for _ in 0..MORE_THAN_A_BATCH {
        instance.register(NOTES).await;
    }
    let user = instance.text_of("SELECT id FROM owner").await;
    let app = &instance.app;
    app.db
        .write(Write::own(), move |tx| {
            tx.execute(
                "INSERT INTO oauth_consents \
                 (client_id, owner_id, grant_id, scopes, created_at, updated_at) \
                 SELECT client_id, ?1, client_id, '[]', ?2, ?2 FROM oauth_clients",
                [user.as_str(), "2000-01-01T00:00:00.000Z"],
            )?;
            tx.execute(
                "INSERT INTO oauth_codes (digest, client_id, owner_id, session_id, grant_id, \
                 redirect_uri, scopes, challenge, resources, expires_at) \
                 SELECT client_id, client_id, ?1, 's', client_id, 'r', '[]', 'c', '[]', ?2 \
                 FROM oauth_clients",
                [user.as_str(), "2000-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let first = cleaned(app).await;
    assert_eq!(first.deleted, MORE_THAN_A_BATCH);
    assert_eq!(first.retired, MORE_THAN_A_BATCH);
    app.clock.advance(91 * DAY_MS).unwrap();
    let second = cleaned(app).await;
    let grants_the_clients_they_kept_and_the_browser_session = 2 * MORE_THAN_A_BATCH + 1;
    assert_eq!(
        second.deleted,
        grants_the_clients_they_kept_and_the_browser_session
    );
}

fn from_page(method: Method, path: &str, page: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, page)
}

async fn an_approved_page(instance: &Instance) -> (String, Value) {
    let callback = format!("{AN_APPROVED_PAGE}/callback");
    let client = instance
        .register_with(json!({
            "client_name": "a web page",
            "application_type": "web",
            "redirect_uris": [callback],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": OFFLINE_NOTES,
        }))
        .await;
    let link = instance
        .consent_link_to(&client, OFFLINE_NOTES, &callback)
        .await;
    let scopes: Vec<&str> = OFFLINE_NOTES.split(' ').collect();
    let reply = instance.decide(&link, &scopes).await;
    let code = code_in(&reply).unwrap();
    let tokens = instance.exchange_at(&client, &code, &callback).await;
    assert_eq!(tokens.status, StatusCode::OK, "{}", tokens.text);
    (client, tokens.json())
}

#[tokio::test]
async fn an_approved_page_is_answered_for_as_long_as_it_is_approved() {
    let instance = Instance::signed_in().await;
    let asks = |page: &str| {
        from_page(Method::GET, "/keys", page)
            .body(Body::empty())
            .unwrap()
    };
    let unknown = instance.send(asks(AN_APPROVED_PAGE)).await;
    assert!(
        !unknown
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );

    let (client, tokens) = an_approved_page(&instance).await;
    let answered = instance.send(asks(AN_APPROVED_PAGE)).await;
    assert_eq!(
        answered.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        AN_APPROVED_PAGE
    );
    assert!(
        !answered
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
    );
    assert!(
        answered
            .headers
            .get_all(header::VARY)
            .iter()
            .any(|value| value == "Origin")
    );
    let other = instance.send(asks("https://other.example")).await;
    assert!(
        !other
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );

    let preflight = from_page(Method::OPTIONS, "/items", AN_APPROVED_PAGE)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization")
        .body(Body::empty())
        .unwrap();
    let reply = instance.send(preflight).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text);
    assert_eq!(
        reply.headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "authorization"
    );

    instance
        .revoke(&client, text_at(&tokens, "refresh_token"))
        .await;
    let withdrawn = instance.send(asks(AN_APPROVED_PAGE)).await;
    assert!(
        !withdrawn
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
}

#[tokio::test]
async fn registration_answers_a_page_only_for_the_post_it_serves() {
    let instance = Instance::signed_in().await;
    let preflight = |asked: &str| {
        from_page(
            Method::OPTIONS,
            "/auth/oauth2/register",
            "https://any.example",
        )
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, asked)
        .body(Body::empty())
        .unwrap()
    };
    let posting = instance.send(preflight("POST")).await;
    assert_eq!(posting.status, StatusCode::NO_CONTENT, "{}", posting.text);
    assert_eq!(posting.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(
        posting.headers[header::ACCESS_CONTROL_ALLOW_METHODS],
        "POST"
    );
    assert_eq!(
        posting.headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "Content-Type"
    );
    let deleting = instance.send(preflight("DELETE")).await;
    assert!(
        !deleting
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
    assert!(
        !deleting
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_METHODS)
    );
}

/// A request through the private local command, which carries no credential.
fn from_local(method: Method, path: &str, body: Option<&Value>) -> Request<Body> {
    let request = Request::builder().method(method).uri(path);
    match body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    }
}

fn from_token(method: Method, path: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

impl Instance {
    async fn local(&self, request: Request<Body>) -> Reply {
        send(control(self.app.clone()), request).await
    }

    async fn grant_of(&self, client: &str) -> Value {
        let listed = self
            .local(from_local(Method::GET, "/auth/grants", None))
            .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
        let rows = listed.json()["data"].as_array().unwrap().clone();
        rows.into_iter()
            .find(|row| row["client_id"] == client)
            .unwrap()
    }

    async fn narrow(&self, grant: &Value, scopes: &[&str], expected: &[&str]) -> Reply {
        let path = format!("/auth/grants/{}", text_at(grant, "id"));
        let body = json!({ "scopes": scopes, "expected_scopes": expected });
        self.local(from_local(Method::PATCH, &path, Some(&body)))
            .await
    }

    async fn end_grant(&self, grant: &Value) -> Reply {
        let path = format!("/auth/grants/{}", text_at(grant, "id"));
        self.local(from_local(Method::DELETE, &path, None)).await
    }

    async fn sign_ins(&self) -> Vec<Value> {
        let listed = self
            .local(from_local(Method::GET, "/owner/sign-ins", None))
            .await;
        assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
        listed.json()["data"].as_array().unwrap().clone()
    }

    async fn end_sign_in(&self, id: &str) -> Reply {
        let path = format!("/owner/sign-ins/{id}");
        self.local(from_local(Method::DELETE, &path, None)).await
    }

    async fn key_holding(&self, permissions: &[&str]) -> Value {
        let body = json!({ "label": "a key", "source": "a-key", "permissions": permissions });
        let minted = send(control(self.app.clone()), post_json("/keys", &body)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        minted.json()
    }

    async fn reads(&self, token: &str) -> StatusCode {
        self.send(from_token(Method::GET, "/items?type=core.note", token))
            .await
            .status
    }

    async fn last_use(&self) -> String {
        let query = "SELECT coalesce(max(last_used_at), '') FROM oauth_consents";
        self.text_of(query).await
    }

    async fn when_use_moves_from(&self, last: String) -> String {
        for _ in 0..500 {
            let now = self.last_use().await;
            if now != last {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("no use was recorded");
    }

    /// Whoever holds the instance's own cookie stays signed in.
    async fn sign_in_again(&self) -> String {
        let claim = json!({ "email": EMAIL, "password": PASSWORD });
        let signed_in = self.send(post_json("/auth/sign-in", &claim)).await;
        assert_eq!(signed_in.status, StatusCode::OK, "{}", signed_in.text);
        signed_in.cookie().unwrap()
    }

    async fn asks_a_new_sign_in(&self, client: &str, prompt: &str, cookie: Option<&str>) -> Reply {
        let query = encoded(&[
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", CALLBACK),
            ("state", "the-state"),
            ("scope", NOTES),
            ("code_challenge", &challenge()),
            ("code_challenge_method", "S256"),
            ("prompt", prompt),
        ]);
        self.send(get(&format!("/auth/oauth2/authorize?{query}"), cookie))
            .await
    }
}

fn way_back(reply: &Reply) -> String {
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let sent = reply.location().unwrap();
    assert_eq!(sent.path(), "/auth/sign-in", "{sent}");
    let pair = |name: &str| {
        sent.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let prompt = pair("prompt").unwrap();
    assert!(prompt.split(' ').any(|word| word == "login"), "{sent}");
    pair("return_to").unwrap()
}

#[tokio::test]
async fn an_ended_grant_keeps_no_destination_and_a_narrowed_one_keeps_them() {
    let instance = Instance::signed_in().await;
    let app = &instance.app;
    let destinations = "SELECT count(*) FROM oauth_consent_destinations";
    let both = "core.note:read core.task:read";
    let client = instance.register(both).await;
    instance.tokens(&client, both).await;
    let approved = instance.count(destinations).await;
    assert!(approved > 0);

    let grant = instance.grant_of(&client).await;
    let scopes: Vec<&str> = both.split(' ').collect();
    let narrowed = instance.narrow(&grant, &["core.note:read"], &scopes).await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);
    assert_eq!(instance.count(destinations).await, approved);

    let ended = instance.end_grant(&grant).await;
    assert!(ended.status.is_success(), "{}", ended.text);
    assert_eq!(instance.count(destinations).await, 0);

    let other = instance.register(both).await;
    instance.tokens(&other, both).await;
    assert!(instance.count(destinations).await > 0);
    let grant = instance.grant_of(&other).await;
    assert!(instance.end_grant(&grant).await.status.is_success());
    app.clock.advance(91 * DAY_MS).unwrap();
    assert!(cleaned(app).await.deleted > 0);
    assert_eq!(instance.count(destinations).await, 0);
}

fn target_of(url: &Url) -> String {
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

fn hidden_field(page: &str, name: &str) -> Option<String> {
    let opening = format!("name=\"{name}\" value=\"");
    let (_, rest) = page.split_once(&opening)?;
    let (value, _) = rest.split_once('"')?;
    Some(value.replace("&#38;", "&").replace("&amp;", "&"))
}

const APP_NAME: &str = "a fixture app";
const CAUTION: &str = "hasn't verified this app";

#[tokio::test]
async fn the_sign_in_page_names_the_app_only_for_a_link_the_instance_signed() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let reply = instance.asks_a_new_sign_in(&client, "consent", None).await;
    let sent = reply.location().unwrap();
    assert_eq!(sent.path(), "/auth/sign-in", "{sent}");
    let page = instance.send(get(&target_of(&sent), None)).await.text;
    assert!(page.contains(APP_NAME), "{page}");
    assert!(page.contains(CAUTION), "{page}");

    let unsigned = target_of(&sent).replace("sig=", "unsigned=");
    let edited = target_of(&sent).replace("state=the-state", "state=another");
    assert_ne!(edited, target_of(&sent));
    for link in [unsigned, edited] {
        let page = instance.send(get(&link, None)).await.text;
        assert!(!page.contains(APP_NAME), "{page}");
        assert!(!page.contains(CAUTION), "{page}");
    }

    instance.app.clock.advance(11 * 60_000).unwrap();
    let page = instance.send(get(&target_of(&sent), None)).await.text;
    assert!(!page.contains(APP_NAME), "{page}");
}

#[tokio::test]
async fn a_consent_link_and_a_new_sign_in_name_the_app_on_the_way_to_sign_in() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let opened = instance
        .send(get(&format!("/auth/authorize?{link}"), None))
        .await;
    assert_eq!(opened.status, StatusCode::FOUND, "{}", opened.text);
    let sent = target_of(&opened.location().unwrap());
    let page = instance.send(get(&sent, None)).await.text;
    assert!(page.contains(APP_NAME), "{page}");

    let reply = instance
        .asks_a_new_sign_in(&client, "login", Some(&instance.cookie))
        .await;
    way_back(&reply);
    let sent = target_of(&reply.location().unwrap());
    let page = instance.send(get(&sent, Some(&instance.cookie))).await.text;
    assert!(page.contains(APP_NAME), "{page}");
    assert!(page.contains("name=\"password\""), "{page}");
}

#[tokio::test]
async fn a_wrong_password_keeps_the_app_on_the_sign_in_page() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let reply = instance
        .asks_a_new_sign_in(&client, "login", Some(&instance.cookie))
        .await;
    let sent = target_of(&reply.location().unwrap());
    let page = instance.send(get(&sent, Some(&instance.cookie))).await.text;
    let return_to = hidden_field(&page, "return_to").unwrap();
    let authorization = hidden_field(&page, "authorization").unwrap();
    let wrong = instance
        .send(post_form(
            "/auth/sign-in",
            Some(&instance.cookie),
            &[
                ("email", EMAIL),
                ("password", "not the password"),
                ("return_to", &return_to),
                ("authorization", &authorization),
            ],
        ))
        .await;
    assert_eq!(wrong.status, StatusCode::FOUND, "{}", wrong.text);
    let again = target_of(&wrong.location().unwrap());
    let page = instance
        .send(get(&again, Some(&instance.cookie)))
        .await
        .text;
    assert!(page.contains("That email or password"), "{page}");
    assert!(page.contains(APP_NAME), "{page}");
    assert!(page.contains("name=\"password\""), "{page}");
    assert!(hidden_field(&page, "authorization").is_some(), "{page}");
}

#[tokio::test]
async fn a_new_sign_in_signs_only_what_the_server_read_of_the_request() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let genuine = instance.consent_link(&client, NOTES).await;
    let listed = url::form_urlencoded::parse(genuine.as_bytes())
        .find(|(name, _)| name == "destinations")
        .map(|(_, value)| value.into_owned())
        .unwrap();
    let query = encoded(&[
        ("response_type", "code"),
        ("client_id", &client),
        ("redirect_uri", CALLBACK),
        ("state", "the-state"),
        ("scope", NOTES),
        ("code_challenge", &challenge()),
        ("code_challenge_method", "S256"),
        ("prompt", "login"),
        ("destinations", &listed),
    ]);
    let reply = instance
        .send(get(
            &format!("/auth/oauth2/authorize?{query}"),
            Some(&instance.cookie),
        ))
        .await;
    let back = way_back(&reply);
    let (_, link) = back.split_once('?').unwrap();
    assert!(!link.contains("destinations="), "{link}");
    let refused = instance.decide(link, &[NOTES]).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);

    let approved = instance.decide(&genuine, &[NOTES]).await;
    assert!(code_in(&approved).is_some(), "{}", approved.text);
}

#[tokio::test]
async fn a_request_nothing_can_be_granted_for_goes_to_no_sign_in() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let asked = |scope: &str, prompt: &str| {
        let query = encoded(&[
            ("response_type", "code"),
            ("client_id", &client),
            ("redirect_uri", CALLBACK),
            ("state", "the-state"),
            ("scope", scope),
            ("code_challenge", &challenge()),
            ("code_challenge_method", "S256"),
            ("prompt", prompt),
        ]);
        format!("/auth/oauth2/authorize?{query}")
    };
    for prompt in ["login", "consent"] {
        let refused = instance
            .send(get(&asked("not.a.type:read", prompt), None))
            .await;
        let sent = refused.location().unwrap();
        assert_eq!(sent.path(), "/auth/error", "{prompt}: {sent}");
        assert_eq!(sent.query(), Some("error=invalid_scope"), "{sent}");

        let witness = instance.send(get(&asked(NOTES, prompt), None)).await;
        let sent = witness.location().unwrap();
        assert_eq!(sent.path(), "/auth/sign-in", "{prompt}: {sent}");
    }
    let refused = instance
        .send(get(
            &asked("not.a.type:read", "login"),
            Some(&instance.cookie),
        ))
        .await;
    assert_eq!(refused.location().unwrap().path(), "/auth/error");
}

#[tokio::test]
async fn a_shipped_edge_type_can_be_asked_for_and_is_published() {
    let instance = Instance::signed_in().await;
    let scope = "edge.parent-of:read";
    let client = instance.register(scope).await;
    let issued = instance.tokens(&client, scope).await;
    assert_eq!(text_at(&issued, "scope"), scope);
    let discovery = instance
        .send(get("/.well-known/oauth-authorization-server/auth", None))
        .await;
    let published = discovery.json()["scopes_supported"].clone();
    assert!(published.as_array().unwrap().contains(&json!(scope)));

    let unknown = instance
        .authorize(&client, "edge.no-such-edge:read", CALLBACK)
        .await;
    let sent = unknown.location().unwrap();
    assert!(
        sent.query().unwrap().contains("error=invalid_scope"),
        "{sent}"
    );
}

#[tokio::test]
async fn dropping_an_override_reads_as_more_access_and_is_refused() {
    let instance = Instance::signed_in().await;
    let both = ["*:write", "core.*:read"];
    let client = instance.register(&both.join(" ")).await;
    let issued = instance.tokens(&client, &both.join(" ")).await;
    let token = text_at(&issued, "access_token");
    let grant = instance.grant_of(&client).await;

    let dropped = instance.narrow(&grant, &["*:write"], &both).await;
    assert_eq!(dropped.status, StatusCode::FORBIDDEN, "{}", dropped.text);
    assert_eq!(instance.grant_of(&client).await["scopes"], json!(both));
    assert_eq!(instance.reads(token).await, StatusCode::OK);

    let kept = instance.narrow(&grant, &["core.*:read"], &both).await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text);
    assert_eq!(kept.json()["scopes"], json!(["core.*:read"]));
    assert_eq!(instance.reads(token).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_narrowing_ends_what_exceeds_it_and_only_that() {
    let instance = Instance::signed_in().await;
    let both = "core.note:read core.task:read";
    let client = instance.register(both).await;
    let wide = instance.tokens(&client, both).await;
    let covered = instance.tokens(&client, NOTES).await;
    let unspent = instance.code(&client, NOTES).await;
    let grant = instance.grant_of(&client).await;

    let narrowed = instance
        .narrow(&grant, &[NOTES], &["core.task:read", NOTES])
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);

    let wide = text_at(&wide, "access_token");
    assert_eq!(instance.reads(wide).await, StatusCode::UNAUTHORIZED);
    let covered = text_at(&covered, "access_token");
    assert_eq!(instance.reads(covered).await, StatusCode::OK);
    refused_as(&instance.exchange(&client, &unspent).await, "invalid_grant");
    let item = "SELECT count(*) FROM items WHERE type = 'system.connection' \
                AND json_extract(properties, '$.scopes[0]') = 'core.note:read' \
                AND json_array_length(json_extract(properties, '$.scopes')) = 1";
    assert_eq!(instance.count(item).await, 1);
}

#[tokio::test]
async fn only_a_live_grant_can_be_narrowed_or_ended() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let tokens = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;
    let written = instance.write_note(text_at(&tokens, "access_token")).await;
    assert_eq!(written.status, StatusCode::CREATED, "{}", written.text);
    let note = written.json()["item"]["id"].clone();
    let nothing = json!({ "id": "019537a0-7b80-7000-8000-000000000000" });
    let note = json!({ "id": note });

    let not_found = |reply: &Reply| {
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.text);
        assert_eq!(reply.headers["x-error-code"], "oauth_grant_not_found");
    };
    let scopes = ["core.note:read"];
    for id in [&nothing, &note] {
        not_found(&instance.end_grant(id).await);
        not_found(&instance.narrow(id, &scopes, &scopes).await);
    }

    let ended = instance.end_grant(&grant).await;
    assert_eq!(ended.status, StatusCode::NO_CONTENT, "{}", ended.text);
    not_found(&instance.end_grant(&grant).await);
    not_found(&instance.narrow(&grant, &scopes, &scopes).await);
}

#[tokio::test]
async fn a_refresh_after_a_narrowing_gives_nothing_back() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let wide = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;

    let left = ["core.note:read", "offline_access"];
    let narrowed = instance
        .narrow(&grant, &left, &["core.note:write", "offline_access"])
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);

    let old = text_at(&wide, "refresh_token");
    refused_as(&instance.refresh(&client, old).await, "invalid_grant");
}

#[tokio::test]
async fn a_chain_reaching_past_its_grant_refreshes_to_nothing() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let plain = instance.tokens(&client, OFFLINE_NOTES).await;
    let asking = instance.tokens(&client, OFFLINE_NOTES).await;

    let witness = instance
        .refresh(&client, text_at(&plain, "refresh_token"))
        .await;
    assert_eq!(witness.status, StatusCode::OK, "{}", witness.text);
    let plain = witness.json();

    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute(
                "UPDATE oauth_consents SET scopes = '[\"core.note:read\",\"offline_access\"]'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let refused = instance
        .refresh(&client, text_at(&plain, "refresh_token"))
        .await;
    refused_as(&refused, "invalid_grant");
    let fields = [
        ("grant_type", "refresh_token"),
        ("client_id", client.as_str()),
        ("refresh_token", text_at(&asking, "refresh_token")),
        ("scope", "core.note:read offline_access"),
    ];
    let reply = instance
        .send(post_form("/auth/oauth2/token", None, &fields))
        .await;
    refused_as(&reply, "invalid_grant");

    for ended in [&plain, &asking] {
        let token = text_at(ended, "access_token");
        assert_eq!(instance.reads(token).await, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn a_request_naming_no_scope_asks_for_what_the_client_registered() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let challenge = challenge();
    let named_scope = |sent: &Url| {
        sent.query_pairs()
            .find(|(name, _)| name == "scope")
            .map(|(_, scope)| scope.into_owned())
    };
    for scope in [None, Some(""), Some("   ")] {
        let mut fields = vec![
            ("response_type", "code"),
            ("client_id", client.as_str()),
            ("redirect_uri", CALLBACK),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ];
        fields.extend(scope.map(|scope| ("scope", scope)));
        let path = format!("/auth/oauth2/authorize?{}", encoded(&fields));

        let signed_out = instance.send(get(&path, None)).await;
        let sign_in = signed_out.location().unwrap();
        assert_eq!(sign_in.path(), "/auth/sign-in", "{sign_in}");
        assert_eq!(named_scope(&sign_in).as_deref(), Some(NOTES), "{sign_in}");

        let back = instance.send(get(&path, Some(&instance.cookie))).await;
        let screen = back.location().unwrap();
        assert_eq!(screen.path(), "/auth/authorize", "{screen}");
        assert_eq!(named_scope(&screen).as_deref(), Some(NOTES), "{screen}");
    }
}

#[tokio::test]
async fn a_refresh_is_judged_by_what_the_grant_reaches_not_how_it_is_spelled() {
    let instance = Instance::signed_in().await;
    let scope = "*:write core.*:read offline_access";
    let client = instance.register(scope).await;
    let tokens = instance
        .tokens(&client, "core.note:read offline_access")
        .await;

    instance
        .app
        .db
        .write(Write::own(), |tx| {
            tx.execute(
                "UPDATE oauth_consents \
                 SET scopes = '[\"*:write\",\"core.*:read\",\"offline_access\"]'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    let reply = instance
        .refresh(&client, text_at(&tokens, "refresh_token"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    assert_eq!(reply.json()["scope"], "core.note:read offline_access");
}

#[tokio::test]
async fn a_narrowing_the_same_set_in_any_order_changes_nothing() {
    let instance = Instance::signed_in().await;
    let both = "core.note:read core.task:read";
    let client = instance.register(both).await;
    let issued = instance.tokens(&client, both).await;
    let unspent = instance.code(&client, both).await;
    let grant = instance.grant_of(&client).await;
    let reversed = ["core.task:read", NOTES];
    let same = instance.narrow(&grant, &reversed, &reversed).await;
    assert_eq!(same.status, StatusCode::OK, "{}", same.text);
    assert_eq!(
        instance.reads(text_at(&issued, "access_token")).await,
        StatusCode::OK
    );
    let exchanged = instance.exchange(&client, &unspent).await;
    assert_eq!(exchanged.status, StatusCode::OK, "{}", exchanged.text);
}

#[tokio::test]
async fn an_approval_landing_before_a_narrowing_commits_stops_it() {
    let instance = Instance::signed_in().await;
    let both = "core.note:read core.task:read";
    let client = instance.register(both).await;
    let issued = instance.tokens(&client, NOTES).await;
    let token = text_at(&issued, "access_token");
    let grant = instance.grant_of(&client).await;
    let wider = instance.consent_link(&client, both).await;

    let held = Some("auth.grant.narrowed");
    instance.app.faults.set("hold:write", held).unwrap();
    let narrow = instance.narrow(&grant, &[], &[NOTES]);
    let approve = async {
        instance.when_held().await;
        let approved = instance.decide(&wider, &[NOTES, "core.task:read"]).await;
        instance.app.faults.clear(None);
        approved
    };
    let (narrowed, approved) = tokio::join!(narrow, approve);
    assert_eq!(approved.status, StatusCode::FOUND, "{}", approved.text);
    assert_eq!(narrowed.status, StatusCode::CONFLICT, "{}", narrowed.text);
    assert_eq!(narrowed.json()["error"]["code"], "conflict");
    assert_eq!(
        instance.grant_of(&client).await["scopes"],
        json!([NOTES, "core.task:read"])
    );
    assert_eq!(instance.reads(token).await, StatusCode::OK);
}

#[tokio::test]
async fn a_narrowing_landing_before_an_approval_stands_and_the_approval_adds_to_it() {
    let instance = Instance::signed_in().await;
    let both = "core.note:read core.task:read";
    let client = instance.register(both).await;
    let issued = instance.tokens(&client, both).await;
    let grant = instance.grant_of(&client).await;
    let again = instance
        .authorize(&client, "core.task:read", CALLBACK)
        .await;
    assert!(code_in(&again).is_some());

    let narrowed = instance
        .narrow(&grant, &[NOTES], &[NOTES, "core.task:read"])
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);
    let token = text_at(&issued, "access_token");
    assert_eq!(instance.reads(token).await, StatusCode::UNAUTHORIZED);

    let asked = instance
        .authorize(&client, "core.task:read", CALLBACK)
        .await;
    assert!(code_in(&asked).is_none(), "{:?}", asked.location());
    assert_eq!(asked.location().unwrap().path(), "/auth/authorize");
}

#[tokio::test]
async fn a_refresh_landing_before_a_revocation_commits_leaves_no_token() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;

    let held = Some("auth.grant.revoked");
    instance.app.faults.set("hold:write", held).unwrap();
    let revoke = instance.end_grant(&grant);
    let refresh = async {
        instance.when_held().await;
        let renewed = instance
            .refresh(&client, text_at(&issued, "refresh_token"))
            .await;
        instance.app.faults.clear(None);
        renewed
    };
    let (revoked, renewed) = tokio::join!(revoke, refresh);
    assert_eq!(revoked.status, StatusCode::NO_CONTENT, "{}", revoked.text);
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.text);
    let renewed = renewed.json();
    let token = text_at(&renewed, "access_token");
    assert_eq!(instance.reads(token).await, StatusCode::UNAUTHORIZED);
    let again = instance
        .refresh(&client, text_at(&renewed, "refresh_token"))
        .await;
    refused_as(&again, "invalid_grant");
}

#[tokio::test]
async fn a_revocation_landing_before_a_refresh_commits_issues_nothing() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;

    let held = Some("auth.token.issued");
    instance.app.faults.set("hold:write", held).unwrap();
    let refresh = instance.refresh(&client, text_at(&issued, "refresh_token"));
    let revoke = async {
        instance.when_held().await;
        let revoked = instance.end_grant(&grant).await;
        instance.app.faults.clear(None);
        revoked
    };
    let (renewed, revoked) = tokio::join!(refresh, revoke);
    assert_eq!(revoked.status, StatusCode::NO_CONTENT, "{}", revoked.text);
    refused_as(&renewed, "invalid_grant");
}

#[tokio::test]
async fn a_failed_audit_undoes_an_ending_through_either_door() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;
    let aim = Some("auth.grant.revoked");
    instance.app.faults.set("fail:audit", aim).unwrap();
    let by_grant = instance.end_grant(&grant).await;
    instance.app.faults.set("fail:audit", aim).unwrap();
    let by_sign_in = instance.end_sign_in(text_at(&grant, "id")).await;
    instance.app.faults.clear(None);
    assert!(by_grant.status.is_server_error(), "{}", by_grant.text);
    assert!(by_sign_in.status.is_server_error(), "{}", by_sign_in.text);
    let token = text_at(&issued, "access_token");
    assert_eq!(instance.reads(token).await, StatusCode::OK);
    assert_eq!(instance.grant_of(&client).await["id"], grant["id"]);
    let renewed = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.text);
}

#[tokio::test]
async fn a_failed_audit_keeps_a_browser_session_and_a_retry_ends_it() {
    let instance = Instance::signed_in().await;
    let rows = instance.sign_ins().await;
    let own = rows.iter().find(|row| row["kind"] == "browser").unwrap();
    let id = text_at(own, "id");

    let aim = Some("auth.session.delete");
    instance.app.faults.set("fail:audit", aim).unwrap();
    let failed = instance.end_sign_in(id).await;
    instance.app.faults.clear(None);
    assert!(failed.status.is_server_error(), "{}", failed.text);
    assert_eq!(instance.sign_ins().await.len(), rows.len());
    let page = instance
        .send(get("/owner/passkeys", Some(&instance.cookie)))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);

    let ended = instance.end_sign_in(id).await;
    assert_eq!(ended.status, StatusCode::OK, "{}", ended.text);
    let after = instance
        .send(get("/owner/passkeys", Some(&instance.cookie)))
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED, "{}", after.text);
}

#[tokio::test]
async fn a_dead_key_is_no_sign_in_and_its_ending_names_nothing() {
    let instance = Instance::signed_in().await;
    let key = instance.key_holding(&["grants.manage"]).await;
    let id = text_at(&key, "id");
    let ended = instance.end_sign_in(id).await;
    assert_eq!(ended.status, StatusCode::OK, "{}", ended.text);

    let secret = text_at(&key, "key");
    let refused = instance
        .send(from_token(Method::GET, "/auth/grants", secret))
        .await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{}", refused.text);
    let rows = instance.sign_ins().await;
    assert!(rows.iter().all(|row| row["id"] != id), "{rows:?}");
    let again = instance.end_sign_in(id).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND, "{}", again.text);
    assert_eq!(again.json()["error"]["code"], "sign_in_not_found");
    let path = format!("/owner/sign-ins/{id}");
    let body = json!({ "name": "too late" });
    let renamed = instance
        .local(from_local(Method::PATCH, &path, Some(&body)))
        .await;
    assert_eq!(renamed.status, StatusCode::NOT_FOUND, "{}", renamed.text);
}

#[tokio::test]
async fn a_key_holding_only_grants_manage_ends_an_app_and_the_audit_names_it() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let grant = instance.grant_of(&client).await;
    let key = instance.key_holding(&["grants.manage"]).await;

    let path = format!("/auth/grants/{}", text_at(&grant, "id"));
    let revoked = instance
        .send(from_token(Method::DELETE, &path, text_at(&key, "key")))
        .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT, "{}", revoked.text);
    let token = text_at(&issued, "access_token");
    assert_eq!(instance.reads(token).await, StatusCode::UNAUTHORIZED);
    let named = instance
        .text_of("SELECT key_id FROM audit_log WHERE action = 'auth.grant.revoked'")
        .await;
    assert_eq!(named, text_at(&key, "id"));
    let shown = "SELECT count(*) FROM items WHERE type = 'system.connection' \
                 AND json_extract(properties, '$.status') = 'revoked'";
    assert_eq!(instance.count(shown).await, 1);
}

#[tokio::test]
async fn a_name_an_app_chose_never_reaches_the_owner_unprintable() {
    let instance = Instance::signed_in().await;
    let hostile = "evil\u{202e}gnp.exe";
    let client = instance
        .register_with(json!({
            "client_name": hostile,
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": NOTES,
        }))
        .await;
    instance.tokens(&client, NOTES).await;
    let grant = instance.grant_of(&client).await;
    assert_eq!(grant["client_name"], Value::Null);
    let rows = instance.sign_ins().await;
    let app = rows.iter().find(|row| row["kind"] == "app").unwrap();
    assert_eq!(app["name"], client.as_str());
}

#[tokio::test]
async fn no_answer_about_a_sign_in_holds_a_credential() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let key = instance.key_holding(&[]).await;
    let token = instance.cookie.split('=').nth(1).unwrap();
    let listed = json!([instance.sign_ins().await, instance.grant_of(&client).await]).to_string();
    assert!(!listed.contains(token));
    assert!(!listed.contains(text_at(&issued, "access_token")));
    assert!(!listed.contains(text_at(&issued, "refresh_token")));
    assert!(!listed.contains(text_at(&key, "key")));
}

#[tokio::test]
async fn a_grant_records_its_use_at_most_once_a_minute_and_starts_over_when_stood_again() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let issued = instance.tokens(&client, NOTES).await;
    let token = text_at(&issued, "access_token");
    let issuing = instance.last_use().await;
    assert!(!issuing.is_empty());

    instance.app.clock.advance(30_000).unwrap();
    assert_eq!(instance.reads(token).await, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(instance.last_use().await, issuing);
    instance.app.clock.advance(31_000).unwrap();
    assert_eq!(instance.reads(token).await, StatusCode::OK);
    assert!(instance.when_use_moves_from(issuing.clone()).await > issuing);

    let grant = instance.grant_of(&client).await;
    let ended = instance.end_grant(&grant).await;
    assert_eq!(ended.status, StatusCode::NO_CONTENT, "{}", ended.text);
    instance.code(&client, NOTES).await;
    assert_eq!(
        instance.grant_of(&client).await["last_used_at"],
        Value::Null
    );
}

#[tokio::test]
async fn a_silent_code_reads_its_destination_inside_the_write() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.code(&client, NOTES).await;
    let codes = "SELECT count(*) FROM oauth_codes";
    assert_eq!(instance.count(codes).await, 1);

    instance
        .app
        .faults
        .set("hold:write", Some("auth.verification.create"))
        .unwrap();
    let asked = instance.authorize(&client, NOTES, CALLBACK);
    let moved = async {
        instance.when_held().await;
        instance
            .stage("UPDATE oauth_clients SET redirect_uris = '[\"http://127.0.0.1:9/moved\"]'")
            .await;
        instance.app.faults.clear(None);
    };
    let (reply, ()) = tokio::join!(asked, moved);

    let sent = reply.location().unwrap();
    assert_eq!(sent.path(), "/auth/error", "{sent}");
    assert_eq!(sent.query(), Some("error=invalid_redirect"), "{sent}");
    assert_eq!(instance.count(codes).await, 1);
}

#[tokio::test]
async fn a_foreign_form_neither_uses_nor_renews_a_session() {
    let instance = Instance::signed_in().await;
    instance.app.clock.advance(120_000).unwrap();
    let last_use = "SELECT updated_at FROM sign_ins";
    let before = instance.text_of(last_use).await;

    for door in [
        "/auth/authorize/decision",
        "/auth/device",
        "/auth/device/consent",
    ] {
        let form = Request::builder()
            .method(Method::POST)
            .uri(door)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::ORIGIN, "https://foreign.example")
            .header(header::COOKIE, &instance.cookie)
            .body(Body::from("accept=true"))
            .unwrap();
        let reply = instance.send(form).await;
        assert_eq!(
            reply.status,
            StatusCode::FORBIDDEN,
            "{door}: {}",
            reply.text
        );
        assert!(reply.cookie().is_none(), "{door}");
    }

    assert_eq!(instance.text_of(last_use).await, before);
    let own = instance
        .send(get("/owner/passkeys", Some(&instance.cookie)))
        .await;
    assert_eq!(own.cookie().as_ref(), Some(&instance.cookie));
}

#[tokio::test]
async fn the_doors_of_a_sign_in_hold_a_session_to_a_safe_address() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let address = "http://marfa.example";
    instance
        .app
        .settings
        .apply_stored(&[("sign_in_address".to_string(), address.to_string())]);

    let asked = instance.authorize(&client, NOTES, CALLBACK).await;
    assert_eq!(asked.status, StatusCode::FORBIDDEN, "{}", asked.text);
    assert!(asked.text.contains("HTTPS"), "{}", asked.text);
    let screen = format!("/auth/authorize?{link}");
    let shown = instance.send(get(&screen, Some(&instance.cookie))).await;
    assert_eq!(shown.status, StatusCode::FORBIDDEN, "{}", shown.text);
    let form = Request::builder()
        .method(Method::POST)
        .uri("/auth/authorize/decision")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ORIGIN, address)
        .header(header::COOKIE, &instance.cookie)
        .body(Body::from(encoded(&[
            ("accept", "true"),
            ("oauth_query", &link),
            ("scopes", NOTES),
        ])))
        .unwrap();
    let decided = instance.send(form).await;
    assert_eq!(decided.status, StatusCode::FORBIDDEN, "{}", decided.text);
    let consents = "SELECT count(*) FROM oauth_consents";
    assert_eq!(instance.count(consents).await, 0);
}

#[tokio::test]
async fn no_page_may_read_the_doors_of_an_authorization() {
    let instance = Instance::signed_in().await;
    an_approved_page(&instance).await;
    let allowed = |reply: &Reply| {
        reply
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    };
    let witness = from_page(Method::GET, "/keys", AN_APPROVED_PAGE)
        .body(Body::empty())
        .unwrap();
    assert!(allowed(&instance.send(witness).await));

    for (method, door) in [
        (Method::GET, "/auth/oauth2/authorize"),
        (Method::GET, "/auth/authorize"),
        (Method::POST, "/auth/authorize/decision"),
        (Method::GET, "/auth/device/consent"),
        (Method::POST, "/auth/device/consent"),
    ] {
        let asked = from_page(method.clone(), door, AN_APPROVED_PAGE)
            .header(header::COOKIE, &instance.cookie)
            .body(Body::empty())
            .unwrap();
        assert!(!allowed(&instance.send(asked).await), "{door}");
        let preflight = from_page(Method::OPTIONS, door, AN_APPROVED_PAGE)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, method.as_str())
            .body(Body::empty())
            .unwrap();
        assert!(!allowed(&instance.send(preflight).await), "{door}");
    }
}

#[tokio::test]
async fn registrations_from_one_address_stop_at_their_limit() {
    let instance = Instance::signed_in().await;
    for _ in 0..9 {
        instance.register(NOTES).await;
    }
    let unreadable = post_json("/auth/oauth2/register", &json!({ "redirect_uris": 1 }));
    assert_eq!(
        instance.send(unreadable).await.status,
        StatusCode::BAD_REQUEST
    );

    let body = json!({ "redirect_uris": [CALLBACK], "token_endpoint_auth_method": "none" });
    let held = instance
        .send(post_json("/auth/oauth2/register", &body))
        .await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS, "{}", held.text);
    assert!(held.headers.contains_key(header::RETRY_AFTER));
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 9);

    instance.app.clock.advance(60_000).unwrap();
    instance.register(NOTES).await;
}

#[tokio::test]
async fn an_expired_device_code_answers_its_poll_then_goes() {
    let instance = Instance::signed_in().await;
    let app = &instance.app;
    commit_unpublished(app, "dcr_client_retention_days", "0").await;
    let client = instance.register_device(NOTES).await;
    let device_code = instance.device_requested(&client, NOTES).await;
    let left_alone = instance.device_requested(&client, NOTES).await;
    let codes = "SELECT count(*) FROM oauth_device_codes";

    app.clock.advance(11 * 60_000).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(codes).await, 2);
    let expired = instance.poll(&client, &device_code).await;
    refused_as(&expired, "expired_token");
    assert_eq!(instance.count(codes).await, 1);
    refused_as(&instance.poll(&client, &device_code).await, "invalid_grant");

    app.clock.advance(DAY_MS - 2 * 60_000).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(codes).await, 1);
    app.clock.advance(2 * 60_000).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(codes).await, 0);
    refused_as(&instance.poll(&client, &left_alone).await, "invalid_grant");
}

#[tokio::test]
async fn ending_a_grant_ends_the_device_code_left_on_a_screen() {
    let instance = Instance::signed_in().await;
    let client = instance.register_device(NOTES).await;
    let elsewhere = instance.register_device(NOTES).await;
    let approved = instance.device_approved(&client, NOTES).await;
    let issued = instance.poll(&client, &approved).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let on_screen = instance.device_asked(&client, NOTES).await;
    let unrelated = instance.device_asked(&elsewhere, NOTES).await;

    let grant = instance.grant_of(&client).await;
    let ended = instance.end_grant(&grant).await;
    assert!(ended.status.is_success(), "{}", ended.text);

    let approve = async |asked: &Value| {
        let fields = [
            ("user_code", text_at(asked, "user_code")),
            ("decision", "approve"),
            ("scopes", NOTES),
        ];
        instance
            .send(post_form(
                "/auth/device/consent",
                Some(&instance.cookie),
                &fields,
            ))
            .await
    };
    let refused = approve(&on_screen).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND, "{}", refused.text);
    let device_code = text_at(&on_screen, "device_code");
    refused_as(&instance.poll(&client, device_code).await, "invalid_grant");
    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    assert_eq!(instance.count(tokens).await, 0);

    let kept = approve(&unrelated).await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text);
    let device_code = text_at(&unrelated, "device_code");
    let issued = instance.poll(&elsewhere, device_code).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
}

#[tokio::test]
async fn a_narrowed_grant_leaves_the_device_code_left_on_a_screen() {
    let instance = Instance::signed_in().await;
    let both = "core.note:read core.task:read";
    let client = instance.register_device(both).await;
    let approved = instance.device_approved(&client, both).await;
    let issued = instance.poll(&client, &approved).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let on_screen = instance.device_requested(&client, NOTES).await;

    let grant = instance.grant_of(&client).await;
    let narrowed = instance
        .narrow(&grant, &[NOTES], &["core.task:read", NOTES])
        .await;
    assert_eq!(narrowed.status, StatusCode::OK, "{}", narrowed.text);

    refused_as(
        &instance.poll(&client, &on_screen).await,
        "authorization_pending",
    );
}

#[tokio::test]
async fn a_device_code_outlives_its_client_and_its_page_says_so() {
    let instance = Instance::signed_in().await;
    let app = &instance.app;
    let client = instance.register_device(NOTES).await;
    app.clock.advance(DAY_MS - 5 * 60_000).unwrap();
    let asked = instance.device_asked(&client, NOTES).await;
    app.clock.advance(6 * 60_000).unwrap();
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 1);
    cleaned(app).await;
    assert_eq!(instance.count(clients).await, 0);

    let page_of = |asked: &Value| {
        let code = text_at(asked, "user_code").to_string();
        get(
            &format!("/auth/device/consent?user_code={code}"),
            Some(&instance.cookie),
        )
    };
    let registered = instance.register_device(NOTES).await;
    let standing = instance.device_asked(&registered, NOTES).await;
    let shown = instance.send(page_of(&standing)).await;
    assert_eq!(shown.status, StatusCode::OK, "{}", shown.text);
    let refused = instance.send(page_of(&asked)).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    assert_eq!(refused.headers["x-error-code"], "invalid_client");
    assert_eq!(refused.json()["error"]["code"], "invalid_client");
    let polled = instance.poll(&client, text_at(&asked, "device_code")).await;
    assert_eq!(polled.json()["error"], "invalid_client", "{}", polled.text);

    let codes = "SELECT count(*) FROM oauth_device_codes";
    assert_eq!(instance.count(codes).await, 2);
    app.clock.advance(DAY_MS + 15 * 60_000).unwrap();
    cleaned(app).await;
    assert_eq!(instance.count(codes).await, 0);
}

#[tokio::test]
async fn no_door_takes_the_scope_that_writes_the_sign_in_address() {
    let instance = Instance::signed_in().await;
    let asked = "core.note:read profile.email:write";
    let registration = |scope: &str| {
        json!({
            "client_name": "a fixture app",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        })
    };
    let refused = instance
        .send(post_json("/auth/oauth2/register", &registration(asked)))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    refused_as(&refused, "invalid_scope");
    let client = instance.register_with(registration(OFFLINE_NOTES)).await;

    let authorization = request_with(&client, &[("scope", Some(asked))]);
    for cookie in [None, Some(instance.cookie.as_str())] {
        let refused = instance.send(get(&authorization, cookie)).await;
        assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
        refused_as(&refused, "invalid_scope");
    }
    let open = request_with(&client, &[("scope", Some(NOTES))]);
    let landed = instance.send(get(&open, Some(&instance.cookie))).await;
    assert_eq!(landed.status, StatusCode::FOUND, "{}", landed.text);

    let device = instance.register_device(NOTES).await;
    let fields = [("client_id", device.as_str()), ("scope", asked)];
    let refused = instance
        .send(post_form("/auth/device/code", None, &fields))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    refused_as(&refused, "invalid_scope");

    let link = instance.consent_link(&client, NOTES).await;
    let refused = instance.decide(&link, &["profile.email:write"]).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    let consents = "SELECT count(*) FROM oauth_consents";
    assert_eq!(instance.count(consents).await, 0);

    let code = instance.code(&client, OFFLINE_NOTES).await;
    let exchange = |code: &str, scope: Option<&str>| {
        let mut fields = vec![
            ("grant_type", "authorization_code".to_string()),
            ("client_id", client.clone()),
            ("code", code.to_string()),
            ("code_verifier", VERIFIER.to_string()),
            ("redirect_uri", CALLBACK.to_string()),
        ];
        fields.extend(scope.map(|scope| ("scope", scope.to_string())));
        fields
    };
    let form = exchange(&code, Some(asked));
    let form: Vec<(&str, &str)> = form.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let refused = instance
        .send(post_form("/auth/oauth2/token", None, &form))
        .await;
    refused_as(&refused, "invalid_scope");

    let form = exchange(&code, None);
    let form: Vec<(&str, &str)> = form.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let issued = instance
        .send(post_form("/auth/oauth2/token", None, &form))
        .await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let issued = issued.json();
    let fields = [
        ("grant_type", "refresh_token"),
        ("client_id", client.as_str()),
        ("refresh_token", text_at(&issued, "refresh_token")),
        ("scope", asked),
    ];
    let refused = instance
        .send(post_form("/auth/oauth2/token", None, &fields))
        .await;
    refused_as(&refused, "invalid_scope");
    let refreshed = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    assert_eq!(refreshed.status, StatusCode::OK, "{}", refreshed.text);
}

fn registering(content_type: Option<&str>, bearer: Option<&str>, body: &Value) -> Request<Body> {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/auth/oauth2/register");
    if let Some(content_type) = content_type {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(bearer) = bearer {
        request = request.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}

fn fixture_registration() -> Value {
    json!({
        "client_name": "a fixture app",
        "application_type": "native",
        "redirect_uris": [CALLBACK],
    })
}

#[tokio::test]
async fn a_registration_not_sent_as_json_gets_the_answer_of_its_own_shape() {
    let instance = Instance::signed_in().await;
    let body = fixture_registration();
    for content_type in [
        None,
        Some("text/plain"),
        Some("application/x-www-form-urlencoded"),
        Some("application/jsonish"),
        Some("application/problem+json"),
    ] {
        let reply = instance.send(registering(content_type, None, &body)).await;
        assert_eq!(
            reply.status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{content_type:?}: {}",
            reply.text
        );
        let answer = reply.json();
        assert_eq!(answer["code"], "UNSUPPORTED_MEDIA_TYPE");
        assert!(answer["message"].is_string());
        assert!(answer.get("error").is_none());
        assert!(!reply.headers.contains_key("x-error-code"));
    }
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 0);
    for content_type in ["application/json", "APPLICATION/JSON; charset=utf-8"] {
        let reply = instance
            .send(registering(Some(content_type), None, &body))
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text);
    }
}

#[tokio::test]
async fn a_registration_carrying_a_bearer_is_refused_as_an_unaccepted_token() {
    let instance = Instance::signed_in().await;
    let key = instance.key_holding(&["keys.mint"]).await;
    let key = text_at(&key, "key");
    let body = fixture_registration();
    let json = Some("application/json");
    for bearer in [key, "anything else"] {
        let reply = instance.send(registering(json, Some(bearer), &body)).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.text);
        assert_eq!(reply.json()["error"], "invalid_token");
    }
    let clients = "SELECT count(*) FROM oauth_clients";
    assert_eq!(instance.count(clients).await, 0);

    let refused = instance
        .send(registering(json, Some(key), &json!({ "redirect_uris": 1 })))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.text);
    let made = instance.send(registering(json, None, &body)).await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
}

#[tokio::test]
async fn a_request_for_a_client_nobody_holds_goes_to_the_error_page() {
    let instance = Instance::signed_in().await;
    let gone = request_with("no-client-has-this-id", &[]);
    for cookie in [None, Some(instance.cookie.as_str())] {
        let reply = instance.send(get(&gone, cookie)).await;
        assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
        let sent = reply.location().unwrap();
        assert_eq!(sent.path(), "/auth/error");
        assert_eq!(sent.query(), Some("error=invalid_client"));
    }
    let page = instance
        .send(get("/auth/error?error=invalid_client", None))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);

    let refused = request_with("https://127.0.0.1/client.json", &[]);
    refused_as(&instance.send(get(&refused, None)).await, "invalid_client");
}

#[tokio::test]
async fn the_source_an_app_writes_under_shows_its_sign_in_name() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let issued = instance.tokens(&client, NOTES).await;
    let token = text_at(&issued, "access_token");

    let listed = instance
        .send(from_token(Method::GET, "/sources", token))
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    let answer = listed.json();
    let rows = answer["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{}", listed.text);
    let own = &rows[0];
    assert_eq!(own["name"], "a fixture app", "{}", listed.text);
    assert_eq!(own["name_from"], "app", "{}", listed.text);
    let code = text_at(own, "source").to_string();
    assert!(code.starts_with("oauth:"), "{code}");

    let path = format!("/source?{}", encoded(&[("source", &code)]));
    let read = instance.local(from_local(Method::GET, &path, None)).await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text);
    assert_eq!(read.json(), *own);

    let grant = instance.grant_of(&client).await;
    let ended = instance.end_grant(&grant).await;
    assert!(ended.status.is_success(), "{}", ended.text);
    let read = instance.local(from_local(Method::GET, &path, None)).await;
    assert_eq!(read.json()["name_from"], "code", "{}", read.text);
    let listed = instance
        .local(from_local(Method::GET, "/sources", None))
        .await;
    assert!(!listed.text.contains(&code), "{}", listed.text);
}

#[tokio::test]
async fn a_key_that_may_not_purge_is_refused_before_its_request_is_read() {
    let instance = Instance::signed_in().await;
    let purge = |key: &str| {
        let mut request = from_token(
            Method::POST,
            "/items/not%20an%20id/purge?version=not-a-number",
            key,
        );
        request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        request
    };
    let held = instance.key_holding(&[]).await;
    let refused = instance.send(purge(text_at(&held, "key"))).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);

    let body = json!({ "label": "b key", "source": "b-key", "permissions": ["items.purge"] });
    let held = send(control(instance.app.clone()), post_json("/keys", &body)).await;
    assert_eq!(held.status, StatusCode::CREATED, "{}", held.text);
    let read = instance.send(purge(text_at(&held.json(), "key"))).await;
    assert_eq!(read.status, StatusCode::BAD_REQUEST, "{}", read.text);
}

#[tokio::test]
async fn device_codes_for_one_address_stop_at_their_limit() {
    let instance = Instance::signed_in().await;
    let client = instance.register_device(NOTES).await;
    let fields = [("client_id", client.as_str()), ("scope", NOTES)];
    for _ in 0..30 {
        let asked = instance
            .send(post_form("/auth/device/code", None, &fields))
            .await;
        assert_eq!(asked.status, StatusCode::OK, "{}", asked.text);
    }

    let held = instance
        .send(post_form("/auth/device/code", None, &fields))
        .await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS, "{}", held.text);
    assert!(held.headers.contains_key(header::RETRY_AFTER));
    let codes = "SELECT count(*) FROM oauth_device_codes";
    assert_eq!(instance.count(codes).await, 30);
}

#[tokio::test]
async fn a_server_with_limits_off_holds_no_registration_or_device_code() {
    let instance = Instance::signed_in().await;
    instance.without_limits();
    for _ in 0..11 {
        instance.register(NOTES).await;
    }
    let client = instance.register_device(NOTES).await;
    let fields = [("client_id", client.as_str()), ("scope", NOTES)];
    for _ in 0..31 {
        let asked = instance
            .send(post_form("/auth/device/code", None, &fields))
            .await;
        assert_eq!(asked.status, StatusCode::OK, "{}", asked.text);
    }
}

const AN_ADDED_PAGE: &str = "https://added.example";

async fn an_approved_client_naming_another_page(instance: &Instance) -> (String, Value) {
    let approved = an_approved_page(instance).await;
    instance
        .stage(
            "UPDATE oauth_clients SET redirect_uris = \
             '[\"https://approved.example/callback\",\"https://added.example/callback\"]'",
        )
        .await;
    approved
}

fn answers_page(reply: &Reply, page: &str) -> bool {
    reply
        .headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_some_and(|origin| origin == page)
}

#[tokio::test]
async fn a_destination_nobody_approved_gets_no_silent_code_and_no_page() {
    let instance = Instance::signed_in().await;
    let (client, _) = an_approved_client_naming_another_page(&instance).await;
    let approved = format!("{AN_APPROVED_PAGE}/callback");
    let added = format!("{AN_ADDED_PAGE}/callback");
    let asks = |page: &str| {
        from_page(Method::GET, "/keys", page)
            .body(Body::empty())
            .unwrap()
    };

    let screen = instance.authorize(&client, OFFLINE_NOTES, &added).await;
    assert!(code_in(&screen).is_none(), "{:?}", screen.location());
    let landed = screen.location().unwrap();
    assert_eq!(landed.path(), "/auth/authorize", "{landed}");
    let silent = encoded(&[
        ("response_type", "code"),
        ("client_id", &client),
        ("redirect_uri", &added),
        ("scope", OFFLINE_NOTES),
        ("code_challenge", &challenge()),
        ("code_challenge_method", "S256"),
        ("prompt", "none"),
    ]);
    let refused = instance
        .send(get(
            &format!("/auth/oauth2/authorize?{silent}"),
            Some(&instance.cookie),
        ))
        .await;
    let sent = refused.location().unwrap();
    assert!(code_in(&refused).is_none(), "{sent}");
    assert_ne!(sent.path(), "/auth/authorize", "{sent}");
    assert!(sent.as_str().contains("consent_required"), "{sent}");
    let stranger = instance.send(asks(AN_ADDED_PAGE)).await;
    assert!(!answers_page(&stranger, AN_ADDED_PAGE));

    let known = instance.authorize(&client, OFFLINE_NOTES, &approved).await;
    assert!(code_in(&known).is_some(), "{:?}", known.location());
    let witness = instance.send(asks(AN_APPROVED_PAGE)).await;
    assert!(answers_page(&witness, AN_APPROVED_PAGE));

    let link = landed.query().unwrap().to_string();
    let scopes: Vec<&str> = OFFLINE_NOTES.split(' ').collect();
    let decided = instance.decide(&link, &scopes).await;
    assert!(code_in(&decided).is_some(), "{}", decided.text);
    let again = instance.authorize(&client, OFFLINE_NOTES, &added).await;
    assert!(code_in(&again).is_some(), "{:?}", again.location());
    let page = instance.send(asks(AN_ADDED_PAGE)).await;
    assert!(answers_page(&page, AN_ADDED_PAGE));
}

#[tokio::test]
async fn an_approval_stands_only_for_the_destinations_its_screen_showed() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    instance
        .stage(
            "UPDATE oauth_clients SET redirect_uris = \
             '[\"http://127.0.0.1:9/callback\",\"https://added.example/callback\"]'",
        )
        .await;

    let approved = instance.decide(&link, &[NOTES]).await;
    assert!(code_in(&approved).is_none(), "{:?}", approved.location());
    let consents = "SELECT count(*) FROM oauth_consents";
    assert_eq!(instance.count(consents).await, 0);

    let declined = instance
        .send(post_form(
            "/auth/authorize/decision",
            Some(&instance.cookie),
            &[("accept", "false"), ("oauth_query", &link)],
        ))
        .await;
    assert!(
        declined
            .location()
            .is_some_and(|sent| sent.as_str().contains("access_denied")),
        "{:?}",
        declined.location()
    );
}

#[tokio::test]
async fn a_new_sign_in_asked_for_is_met_only_by_a_new_session() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;

    let asked = instance
        .asks_a_new_sign_in(&client, "login", Some(&instance.cookie))
        .await;
    let back = way_back(&asked);
    let same_browser = instance.send(get(&back, Some(&instance.cookie))).await;
    way_back(&same_browser);

    let fresh = instance.sign_in_again().await;
    let returned = instance.send(get(&back, Some(&fresh))).await;
    assert!(code_in(&returned).is_some(), "{:?}", returned.location());
}

#[tokio::test]
async fn a_returning_link_opened_by_an_older_session_asks_again() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;
    let older = instance.sign_in_again().await;
    instance.app.clock.advance(10_000).unwrap();

    let asked = instance
        .asks_a_new_sign_in(&client, "login", Some(&instance.cookie))
        .await;
    let back = way_back(&asked);
    let replayed = instance.send(get(&back, Some(&older))).await;
    way_back(&replayed);
}

#[tokio::test]
async fn a_returning_link_cannot_be_forged_or_kept_past_its_time() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;
    let asked = instance
        .asks_a_new_sign_in(&client, "login", Some(&instance.cookie))
        .await;
    let back = way_back(&asked);
    let fresh = instance.sign_in_again().await;

    let edited = back.replace("state=the-state", "state=another-state");
    let forged = instance.send(get(&edited, Some(&fresh))).await;
    way_back(&forged);

    let unsigned = instance
        .asks_a_new_sign_in(&client, "login", Some(&fresh))
        .await;
    way_back(&unsigned);

    instance.app.clock.advance(601_000).unwrap();
    let late = instance.sign_in_again().await;
    let expired = instance.send(get(&back, Some(&late))).await;
    way_back(&expired);
}

#[tokio::test]
async fn a_new_sign_in_keeps_what_else_the_prompt_asked() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;
    let asked = instance
        .asks_a_new_sign_in(&client, "login consent", Some(&instance.cookie))
        .await;
    let back = way_back(&asked);
    let fresh = instance.sign_in_again().await;
    let returned = instance.send(get(&back, Some(&fresh))).await;
    assert!(code_in(&returned).is_none(), "{:?}", returned.location());
    assert_eq!(returned.location().unwrap().path(), "/auth/authorize");
}

#[tokio::test]
async fn a_prompt_to_select_an_account_changes_nothing() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;

    let cookie = Some(instance.cookie.as_str());
    let plain = instance
        .asks_a_new_sign_in(&client, "select_account", cookie)
        .await;
    assert!(code_in(&plain).is_some(), "{:?}", plain.location());

    let asked = instance
        .asks_a_new_sign_in(&client, "login select_account", cookie)
        .await;
    let back = way_back(&asked);
    let fresh = instance.sign_in_again().await;
    let returned = instance.send(get(&back, Some(&fresh))).await;
    assert!(code_in(&returned).is_some(), "{:?}", returned.location());
}

#[tokio::test]
async fn a_new_sign_in_asked_of_nobody_returns_to_the_request() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;
    let asked = instance.asks_a_new_sign_in(&client, "login", None).await;
    let back = way_back(&asked);
    let nobody = instance.send(get(&back, None)).await;
    way_back(&nobody);
    let fresh = instance.sign_in_again().await;
    let returned = instance.send(get(&back, Some(&fresh))).await;
    assert!(code_in(&returned).is_some(), "{:?}", returned.location());
}

#[tokio::test]
async fn a_device_approval_stands_only_for_the_destinations_asked_about() {
    let instance = Instance::signed_in().await;
    let client = instance.register_device(NOTES).await;
    let fields = [("client_id", client.as_str()), ("scope", NOTES)];
    let asked = instance
        .send(post_form("/auth/device/code", None, &fields))
        .await
        .json();
    instance
        .stage(
            "UPDATE oauth_clients SET redirect_uris = \
             '[\"http://127.0.0.1:9/callback\",\"https://added.example/callback\"]'",
        )
        .await;

    let fields = [
        ("user_code", text_at(&asked, "user_code")),
        ("decision", "approve"),
        ("scopes", NOTES),
    ];
    instance
        .send(post_form(
            "/auth/device/consent",
            Some(&instance.cookie),
            &fields,
        ))
        .await;
    let consents = "SELECT count(*) FROM oauth_consents";
    assert_eq!(instance.count(consents).await, 0);
}

type Changes<'a> = &'a [(&'a str, Option<&'a str>)];

fn request_with(client: &str, changes: Changes<'_>) -> String {
    let challenge = challenge();
    let valid = [
        ("response_type", "code"),
        ("client_id", client),
        ("redirect_uri", CALLBACK),
        ("state", "the-state"),
        ("scope", NOTES),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    let mut fields: Vec<(&str, &str)> = valid
        .into_iter()
        .filter(|(name, _)| !changes.iter().any(|(changed, _)| changed == name))
        .collect();
    fields.extend(
        changes
            .iter()
            .filter_map(|(name, value)| value.map(|value| (*name, value))),
    );
    format!("/auth/oauth2/authorize?{}", encoded(&fields))
}

const REFUSED: [(Changes<'_>, &str); 4] = [
    (
        &[("response_type", Some("token"))],
        "unsupported_response_type",
    ),
    (&[("code_challenge", None)], "invalid_request"),
    (&[("scope", Some("no.such:thing"))], "invalid_scope"),
    (
        &[("resource", Some("https://elsewhere.example/"))],
        "invalid_target",
    ),
];

fn sent_to_the_error_page(reply: &Reply, error: &str) {
    assert_eq!(reply.status, StatusCode::FOUND, "{}", reply.text);
    let line = reply.headers[header::LOCATION].to_str().unwrap();
    assert_eq!(line, format!("/auth/error?error={error}"));
}

fn sent_to_the_app(reply: &Reply, error: &str) {
    let sent = reply.location().unwrap();
    assert_eq!(sent.host_str(), Some("127.0.0.1"), "{sent}");
    assert_eq!(sent.path(), "/callback", "{sent}");
    let named = sent.query_pairs().find(|(name, _)| name == "error");
    assert_eq!(named.unwrap().1, error, "{sent}");
}

#[tokio::test]
async fn a_refusal_reaches_only_an_app_the_person_approved() {
    let instance = Instance::signed_in().await;
    let unknown = instance.register(NOTES).await;
    let approved = instance.register(NOTES).await;
    instance.code(&approved, NOTES).await;
    let cookie = Some(instance.cookie.as_str());

    for (changes, error) in REFUSED {
        let path = request_with(&unknown, changes);
        sent_to_the_error_page(&instance.send(get(&path, cookie)).await, error);
        let path = request_with(&approved, changes);
        sent_to_the_app(&instance.send(get(&path, cookie)).await, error);
    }
    let silent = [("prompt", Some("none"))];
    let path = request_with(&unknown, &silent);
    sent_to_the_error_page(&instance.send(get(&path, cookie)).await, "consent_required");
    let wider = [("prompt", Some("none")), ("scope", Some("core.note:write"))];
    let path = request_with(&approved, &wider);
    let reply = instance.send(get(&path, cookie)).await;
    sent_to_the_app(&reply, "consent_required");
}

#[tokio::test]
async fn a_withdrawn_consent_sends_no_refusal_to_the_app() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    instance
        .revoke(&client, text_at(&issued, "refresh_token"))
        .await;
    let path = request_with(&client, &[("code_challenge", None)]);
    let reply = instance.send(get(&path, Some(&instance.cookie))).await;
    sent_to_the_error_page(&reply, "invalid_request");
}

#[tokio::test]
async fn a_refusal_for_a_destination_nobody_approved_stays_here() {
    let instance = Instance::signed_in().await;
    let (client, _) = an_approved_client_naming_another_page(&instance).await;
    let added = format!("{AN_ADDED_PAGE}/callback");
    let changes = [
        ("redirect_uri", Some(added.as_str())),
        ("code_challenge", None),
    ];
    let path = request_with(&client, &changes);
    let reply = instance.send(get(&path, Some(&instance.cookie))).await;
    sent_to_the_error_page(&reply, "invalid_request");
}

#[tokio::test]
async fn a_signed_out_browser_goes_to_sign_in_only_with_a_valid_request() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    for (changes, error) in REFUSED {
        let path = request_with(&client, changes);
        sent_to_the_error_page(&instance.send(get(&path, None)).await, error);
    }
    let path = request_with(&client, &[("prompt", Some("none"))]);
    sent_to_the_error_page(&instance.send(get(&path, None)).await, "login_required");

    let reply = instance.send(get(&request_with(&client, &[]), None)).await;
    let landed = reply.location().unwrap();
    assert_eq!(landed.path(), "/auth/sign-in", "{landed}");
}

#[tokio::test]
async fn a_person_who_declines_is_sent_back_to_the_app() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let link = instance.consent_link(&client, NOTES).await;
    let declined = instance
        .send(post_form(
            "/auth/authorize/decision",
            Some(&instance.cookie),
            &[("accept", "false"), ("oauth_query", &link)],
        ))
        .await;
    sent_to_the_app(&declined, "access_denied");
}

#[tokio::test]
async fn the_error_page_explains_each_code_and_shows_nothing_of_the_request() {
    let instance = Instance::signed_in().await;
    let planted = "planted-by-the-request";
    let fallback = instance
        .send(get(&format!("/auth/error?error={planted}"), None))
        .await;
    assert!(!fallback.text.contains(planted), "{}", fallback.text);
    let unexplained = "continue with this request";
    assert!(fallback.text.contains(unexplained));
    for code in [
        "invalid_request",
        "unsupported_response_type",
        "unauthorized_client",
        "invalid_scope",
        "invalid_target",
        "login_required",
        "consent_required",
    ] {
        let path = format!(
            "/auth/error?error={code}&error_description={planted}&state={planted}&client_id={planted}"
        );
        let page = instance.send(get(&path, None)).await;
        assert_eq!(page.status, StatusCode::OK, "{code}");
        assert!(!page.text.contains(planted), "{code}: {}", page.text);
        assert!(!page.text.contains(unexplained), "{code}");
    }
}

/// Sets every access token's end, as a hand edit or a later reader would find it.
async fn end_tokens_at(app: &Arc<App>, expires_at: String) {
    app.db
        .write(Write::own(), move |tx| {
            tx.execute(
                "UPDATE oauth_access_tokens SET expires_at = ?1",
                [&expires_at],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn an_access_token_opens_until_the_millisecond_it_ends_and_the_sweep_takes_it_then() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let token = text_at(&instance.tokens(&client, NOTES).await, "access_token").to_string();
    let app = &instance.app;
    app.clock.pause(true);
    let now = app.clock.instant();

    end_tokens_at(app, now.plus_ms(1).unwrap().text()).await;
    assert_eq!(instance.reads(&token).await, StatusCode::OK);
    end_tokens_at(app, now.text()).await;
    assert_eq!(instance.reads(&token).await, StatusCode::UNAUTHORIZED);

    let tokens = "SELECT count(*) FROM oauth_access_tokens";
    end_tokens_at(app, now.plus_ms(1).unwrap().text()).await;
    cleaned(app).await;
    assert_eq!(instance.count(tokens).await, 1);
    end_tokens_at(app, now.text()).await;
    cleaned(app).await;
    assert_eq!(instance.count(tokens).await, 0);
}

#[tokio::test]
async fn an_access_token_whose_end_does_not_read_is_refused_and_never_taken_as_ended() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    let token = text_at(&instance.tokens(&client, NOTES).await, "access_token").to_string();
    assert_eq!(instance.reads(&token).await, StatusCode::OK);
    for stored in ["soon", "1800000000000", "2027-01-15T08:00:00Z"] {
        end_tokens_at(&instance.app, stored.to_string()).await;
        assert_eq!(
            instance.reads(&token).await,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{stored}"
        );
    }
}

impl Instance {
    /// A key that holds the permission each of these writes asks, which only the private local command may use.
    async fn key_caller(&self) -> (Caller, String) {
        let key = self.key_holding(&["grants.manage", "keys.manage"]).await;
        let found = keys::authenticate(&self.app, text_at(&key, "key"))
            .await
            .unwrap()
            .unwrap();
        (
            Caller::Key(Box::new(found)),
            text_at(&key, "id").to_string(),
        )
    }
}

fn only_local(refused: Result<impl std::fmt::Debug, marfa_server::app::refusal::Refusal>) {
    let refusal = refused.unwrap_err();
    assert_eq!(refusal.code, Code::Forbidden, "{refusal:?}");
}

#[tokio::test]
async fn a_key_cannot_narrow_a_grant_inside_the_write() {
    let instance = Instance::signed_in().await;
    let client = instance.register("core.note:read core.note:write").await;
    instance
        .tokens(&client, "core.note:read core.note:write")
        .await;
    let grant = instance.grant_of(&client).await;
    let (caller, _) = instance.key_caller().await;
    let both = ScopeSet::parse("core.note:read core.note:write");
    let asked = Narrowing {
        scopes: ScopeSet::parse("core.note:read"),
        expected: both.clone(),
    };

    let refused = grants::narrow(
        &instance.app,
        &caller,
        text_at(&grant, "id").to_string(),
        asked,
    )
    .await;
    only_local(refused);
    assert_eq!(instance.grant_of(&client).await["scopes"], grant["scopes"]);

    let witness = instance
        .narrow(
            &grant,
            &["core.note:read"],
            &["core.note:read", "core.note:write"],
        )
        .await;
    assert_eq!(witness.status, StatusCode::OK, "{}", witness.text);
}

#[tokio::test]
async fn a_key_cannot_end_or_rename_a_sign_in_inside_the_write() {
    let instance = Instance::signed_in().await;
    let client = instance.register(NOTES).await;
    instance.tokens(&client, NOTES).await;
    let grant = instance.grant_of(&client).await;
    let (caller, key_id) = instance.key_caller().await;
    let before = instance.sign_ins().await;

    for id in [text_at(&grant, "id"), key_id.as_str()] {
        let ended = sign_ins::end(
            &instance.app,
            &caller,
            id.to_string(),
            false,
            Visit::default(),
        )
        .await;
        only_local(ended);
        let renamed =
            sign_ins::rename(&instance.app, &caller, id.to_string(), "taken".into()).await;
        only_local(renamed);
    }
    assert_eq!(instance.sign_ins().await.len(), before.len());
    assert!(
        instance
            .sign_ins()
            .await
            .iter()
            .any(|row| row["id"] == grant["id"])
    );
    assert_eq!(instance.grant_of(&client).await["id"], grant["id"]);

    let witness = instance.end_sign_in(text_at(&grant, "id")).await;
    assert_eq!(witness.status, StatusCode::OK, "{}", witness.text);
}
