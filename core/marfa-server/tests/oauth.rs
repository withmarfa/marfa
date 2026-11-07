//! What the sign-in server must survive that the contract's fixtures cannot
//! stage.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::oauth::authorize::sign_in_then;
use marfa_server::app::oauth::signed_link;
use marfa_server::app::oauth::sweep;
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
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
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_AUTH_BASE_URL", ORIGIN),
        ("API_KEY_SALT", "a salt for these tests"),
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
        let signed_in = send(public.clone(), post_json("/auth/sign-in/email", &claim)).await;
        assert_eq!(signed_in.status, StatusCode::OK);
        Instance {
            cookie: signed_in.cookie().unwrap(),
            _dir: dir,
            app,
            public,
        }
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

    /// The signed link of the consent screen a request lands on.
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

    /// A code for `scope`, approved in full if a consent screen asks.
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

    /// The tokens of a new grant of `scope`.
    async fn tokens(&self, client: &str, scope: &str) -> Value {
        let code = self.code(client, scope).await;
        let reply = self.exchange(client, &code).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.json()
    }

    async fn write_note(&self, token: &str) -> Reply {
        let body = json!({ "type": "core.note", "properties": { "body": "from an app" } });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/items")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
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

    /// The app's grant stands and the person is still signed in: the next
    /// authorization gets a code with no consent screen.
    async fn grant_and_browser_stand(&self, client: &str, scope: &str) {
        let session = self
            .send(get("/auth/get-session", Some(&self.cookie)))
            .await;
        assert_eq!(session.json()["user"]["email"], EMAIL, "{}", session.text);
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
async fn two_exchanges_of_one_code_at_once_issue_one_set_of_tokens() {
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
    let tokens = "SELECT count(*) FROM auth_oauth_access_token";
    assert_eq!(instance.count(tokens).await, 1);
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
    let live = "SELECT count(*) FROM auth_oauth_refresh_token \
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
    let consents = "SELECT count(*) FROM auth_oauth_consent";
    let events = "SELECT count(*) FROM event_log";
    let codes = "SELECT count(*) FROM auth_oauth_code";
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
    let withdrawn = "SELECT count(*) FROM auth_oauth_consent WHERE withdrawn_at IS NOT NULL";
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
    let tokens = "SELECT count(*) FROM auth_oauth_access_token";
    assert_eq!(instance.count(tokens).await, 1);
}

#[tokio::test]
async fn a_grant_revoked_between_approval_and_poll_issues_nothing() {
    let instance = Instance::signed_in().await;
    let scope = "core.note:read offline_access";
    let client = instance
        .register_with(json!({
            "client_name": "a fixture device",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": [DEVICE_GRANT, "refresh_token"],
            "response_types": [],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        }))
        .await;
    let approved = async || {
        let fields = [("client_id", client.as_str()), ("scope", scope)];
        let asked = instance
            .send(post_form("/auth/device/code", None, &fields))
            .await;
        assert_eq!(asked.status, StatusCode::OK, "{}", asked.text);
        let asked = asked.json();
        let fields = [
            ("user_code", text_at(&asked, "user_code")),
            ("decision", "approve"),
            ("scopes", "core.note:read"),
            ("scopes", "offline_access"),
        ];
        let reply = instance
            .send(post_form(
                "/auth/device/consent",
                Some(&instance.cookie),
                &fields,
            ))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        text_at(&asked, "device_code").to_string()
    };
    let poll = async |device_code: &str| {
        let fields = [
            ("grant_type", DEVICE_GRANT),
            ("client_id", client.as_str()),
            ("device_code", device_code),
        ];
        instance
            .send(post_form("/auth/oauth2/token", None, &fields))
            .await
    };

    let first = approved().await;
    let issued = poll(&first).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text);
    let late = approved().await;
    instance
        .revoke(&client, text_at(&issued.json(), "refresh_token"))
        .await;
    refused_as(&poll(&late).await, "invalid_grant");
    let tokens = "SELECT count(*) FROM auth_oauth_access_token";
    assert_eq!(instance.count(tokens).await, 0);
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
    let params: Vec<(String, String)> = [
        ("client_id", client.as_str()),
        ("redirect_uri", CALLBACK),
        ("response_type", "code"),
        ("code_challenge", &challenge()),
        ("code_challenge_method", "S256"),
        ("scope", wide),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value.to_string()))
    .collect();
    let exp = instance.app.clock.now_ms() / 1_000 + 600;
    let secret = &instance.app.settings.start.auth_secret;
    let link = signed_link::sign(&params, exp, secret).unwrap();
    let consents = "SELECT count(*) FROM auth_oauth_consent";

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
            .count("SELECT count(*) FROM auth_oauth_consent")
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
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{}", reply.text);
    assert_eq!(instance.count(grants).await, 1);
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
    assert_eq!(sweep::remove_idle_clients(&instance.app).await.unwrap(), 0);

    instance.app.clock.advance(2 * DAY_MS).unwrap();
    let link = instance.consent_link(&offered, NOTES).await;
    let page = instance
        .send(get(
            &format!("/auth/authorize?{link}"),
            Some(&instance.cookie),
        ))
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text);
    assert_eq!(sweep::remove_idle_clients(&instance.app).await.unwrap(), 1);

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
async fn an_idle_grant_retires_then_goes_and_its_client_can_follow() {
    let instance = Instance::signed_in().await;
    let client = instance.register(OFFLINE_NOTES).await;
    let issued = instance.tokens(&client, OFFLINE_NOTES).await;
    let app = &instance.app;
    assert_eq!(sweep::retire_idle_grants(app).await.unwrap(), 0);

    app.clock.advance(364 * DAY_MS).unwrap();
    assert_eq!(sweep::retire_idle_grants(app).await.unwrap(), 0);
    app.clock.advance(2 * DAY_MS).unwrap();
    assert_eq!(sweep::retire_idle_grants(app).await.unwrap(), 1);
    assert_eq!(sweep::retire_idle_grants(app).await.unwrap(), 0);
    let refused = instance
        .refresh(&client, text_at(&issued, "refresh_token"))
        .await;
    refused_as(&refused, "invalid_grant");
    let retired = "SELECT count(*) FROM audit_log WHERE action = 'auth.grant.retired'";
    assert_eq!(instance.count(retired).await, 1);
    let grants = "SELECT count(*) FROM items WHERE type = 'system.connection'";
    assert_eq!(instance.count(grants).await, 1);

    app.clock.advance(89 * DAY_MS).unwrap();
    assert_eq!(sweep::purge_withdrawn_grants(app).await.unwrap(), 0);
    assert_eq!(sweep::remove_idle_clients(app).await.unwrap(), 0);
    app.clock.advance(2 * DAY_MS).unwrap();
    assert_eq!(sweep::purge_withdrawn_grants(app).await.unwrap(), 1);
    assert_eq!(instance.count(grants).await, 0);
    assert_eq!(
        instance
            .count("SELECT count(*) FROM auth_oauth_consent")
            .await,
        0
    );

    assert_eq!(sweep::remove_idle_clients(app).await.unwrap(), 0);
    assert!(sweep::sweep_expired(app).await.unwrap() > 0);
    assert_eq!(sweep::remove_idle_clients(app).await.unwrap(), 1);
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
    assert_eq!(sweep::retire_idle_grants(&instance.app).await.unwrap(), 0);
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
    assert_eq!(sweep::sweep_expired(app).await.unwrap(), 0);

    app.clock.advance(2 * 3_600_000).unwrap();
    assert_eq!(sweep::sweep_expired(app).await.unwrap(), 3);
    let rotated = "SELECT count(*) FROM auth_oauth_refresh_token WHERE rotated_at IS NOT NULL";
    assert_eq!(instance.count(rotated).await, 1);
    app.clock.advance(31 * DAY_MS).unwrap();
    assert_eq!(sweep::sweep_expired(app).await.unwrap(), 2);
    assert_eq!(instance.count(rotated).await, 0);
}

#[tokio::test]
async fn a_pass_works_through_more_than_one_batch() {
    const MORE_THAN_A_BATCH: usize = 201;
    let instance = Instance::signed_in().await;
    for _ in 0..MORE_THAN_A_BATCH {
        instance.register(NOTES).await;
    }
    let user = instance.text_of("SELECT id FROM auth_user").await;
    let app = &instance.app;
    app.db
        .write(Write::own(), move |tx| {
            tx.execute(
                "INSERT INTO auth_oauth_consent \
                 (client_id, user_id, grant_id, scopes, created_at, updated_at) \
                 SELECT client_id, ?1, client_id, '[]', 0, 0 FROM auth_oauth_client",
                [&user],
            )?;
            tx.execute(
                "INSERT INTO auth_oauth_code (digest, client_id, user_id, session_id, grant_id, \
                 redirect_uri, scopes, challenge, resources, expires_at) \
                 SELECT client_id, client_id, ?1, 's', client_id, 'r', '[]', 'c', '[]', 0 \
                 FROM auth_oauth_client",
                [&user],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(sweep::sweep_expired(app).await.unwrap(), MORE_THAN_A_BATCH);
    assert_eq!(
        sweep::retire_idle_grants(app).await.unwrap(),
        MORE_THAN_A_BATCH
    );
    app.clock.advance(91 * DAY_MS).unwrap();
    assert_eq!(
        sweep::purge_withdrawn_grants(app).await.unwrap(),
        MORE_THAN_A_BATCH
    );
    assert_eq!(
        sweep::remove_idle_clients(app).await.unwrap(),
        MORE_THAN_A_BATCH
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
