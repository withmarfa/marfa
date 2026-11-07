//! What signing in must survive that the contract's fixtures cannot stage.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";
const EMAIL: &str = "owner@example.test";
const PASSWORD: &str = "the first password";

struct Instance {
    dir: TempDir,
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
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
    }
}

fn post(path: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn read_owner(cookie: &str) -> Request<Body> {
    Request::builder()
        .uri("/owner")
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap()
}

fn sign_in_body(password: &str) -> Value {
    json!({ "email": EMAIL, "password": password })
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
    async fn claimed() -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot(&dir).await;
        let instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir,
        };
        let claim = json!({ "email": EMAIL, "password": PASSWORD });
        let reply = send(
            instance.control.clone(),
            post("/_control/setup/claim", &claim),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CREATED);
        instance
    }

    async fn restarted(self) -> Instance {
        self.app.db.close().await;
        let app = boot(&self.dir).await;
        Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            dir: self.dir,
        }
    }

    async fn sign_in(&self, password: &str) -> Reply {
        send(
            self.public.clone(),
            post("/auth/sign-in/email", &sign_in_body(password)),
        )
        .await
    }
}

#[tokio::test]
async fn a_sign_in_whose_commit_is_unknown_sets_no_cookie_and_can_be_made_again() {
    let instance = Instance::claimed().await;
    let faults = &instance.app.faults;
    faults
        .set("fail:commit-full", Some("auth.sign_in.success"))
        .unwrap();
    let unknown = instance.sign_in(PASSWORD).await;
    assert!(unknown.status.is_server_error());
    assert_eq!(unknown.body["error"]["details"]["write_outcome"], "unknown");
    assert!(unknown.cookie().is_none());
    faults.clear(None);
    let again = instance.sign_in(PASSWORD).await;
    assert_eq!(again.status, StatusCode::OK);
    assert!(again.cookie().is_some());
}

#[tokio::test]
async fn a_restart_inside_a_window_keeps_what_it_counted() {
    let instance = Instance::claimed().await;
    for _ in 0..10 {
        let wrong = instance.sign_in("not the password").await;
        assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    }
    let instance = instance.restarted().await;
    let held = instance.sign_in(PASSWORD).await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(held.headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn a_full_disk_costs_a_session_its_renewal_and_not_the_request() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    instance.app.clock.advance(120_000).unwrap();
    instance
        .app
        .faults
        .set("fail:commit-full", Some("auth.session.use"))
        .unwrap();
    let admitted = send(instance.public.clone(), read_owner(&cookie)).await;
    assert_eq!(admitted.status, StatusCode::OK);
    assert!(admitted.cookie().is_none());
    instance.app.faults.clear(None);
    let recorded = send(instance.public.clone(), read_owner(&cookie)).await;
    assert_eq!(recorded.status, StatusCode::OK);
    assert_eq!(recorded.cookie().as_ref(), Some(&cookie));
}

#[tokio::test]
async fn a_password_changed_during_a_sign_in_ends_that_sign_in() {
    let instance = Instance::claimed().await;
    let faults = instance.app.faults.clone();
    faults
        .set("hold:write", Some("auth.sign_in.success"))
        .unwrap();
    let signing_in = tokio::spawn(send(
        instance.public.clone(),
        post("/auth/sign-in/email", &sign_in_body(PASSWORD)),
    ));
    while faults.list().iter().all(|fault| fault.waiting == 0) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let recovered = send(
        instance.control.clone(),
        post(
            "/_control/owner/recover",
            &json!({ "password": "the second password" }),
        ),
    )
    .await;
    assert_eq!(recovered.status, StatusCode::OK);
    faults.clear(None);
    let late = signing_in.await.unwrap();
    assert_eq!(late.status, StatusCode::UNAUTHORIZED);
    assert!(late.cookie().is_none());
    assert_eq!(
        instance.sign_in("the second password").await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_table_keeps_a_digest_and_never_the_token() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let token = cookie.split_once('=').unwrap().1.to_string();
    let held: String = instance
        .app
        .db
        .read(|tx| Ok(tx.query_row("SELECT token FROM auth_session", [], |row| row.get(0))?))
        .await
        .unwrap();
    assert_ne!(held, token);
}
