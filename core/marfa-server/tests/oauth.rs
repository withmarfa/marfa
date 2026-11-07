//! What the sign-in server must survive that the contract's fixtures cannot
//! stage.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
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
const VERIFIER: &str = "a-verifier-long-enough-for-the-pkce-rule-of-43-characters";

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
        let claimed = send(control(app.clone()), post_json("/_control/setup/claim", &claim)).await;
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

    async fn register(&self, scope: &str) -> String {
        let body = json!({
            "client_name": "a fixture app",
            "application_type": "native",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        });
        let reply = self.send(post_json("/auth/oauth2/register", &body)).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text);
        reply.json()["client_id"].as_str().unwrap().to_string()
    }

    /// The signed link of the consent screen a request lands on.
    async fn consent_link(&self, client: &str, scope: &str) -> String {
        let query = encoded(&[
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", CALLBACK),
            ("state", "the-state"),
            ("scope", scope),
            ("code_challenge", &challenge()),
            ("code_challenge_method", "S256"),
        ]);
        let reply = self
            .send(get(
                &format!("/auth/oauth2/authorize?{query}"),
                Some(&self.cookie),
            ))
            .await;
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
    assert!(sent.query_pairs().any(|(name, _)| name == "code"));
    let grants: i64 = instance
        .app
        .db
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT count(*) FROM items WHERE type_id = 'system.connection'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(grants, 1);
}
