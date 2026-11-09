use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::app::auth::claim;
use marfa_server::http::listening::Peer;
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

fn post_signed_in(path: &str, body: &Value, cookie: &str) -> Request<Body> {
    let mut request = post(path, body);
    request
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    request
}

/// A use of the session at the one door it counts on: the passkey page's list.
fn on_the_passkey_list(cookie: &str) -> Request<Body> {
    Request::builder()
        .uri("/owner/passkeys")
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap()
}

fn sign_in_body(password: &str) -> Value {
    json!({ "email": EMAIL, "password": password })
}

async fn boot(dir: &TempDir) -> Arc<App> {
    boot_with(
        dir,
        &[
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
        ],
    )
    .await
}

async fn boot_with(dir: &TempDir, extra: &[(&str, &str)]) -> Arc<App> {
    let database = dir.path().join("marfa.db");
    let blobs = dir.path().join("blobs");
    let socket = dir.path().join("s.sock");
    let mut pairs = vec![
        ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
        ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_KEY_SALT", "a salt for these tests"),
    ];
    pairs.extend_from_slice(extra);
    let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
    App::start(settings).await.unwrap()
}

impl Instance {
    async fn claimed() -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot(&dir).await;
        Instance::claimed_on(dir, app).await
    }

    async fn claimed_with(extra: &[(&str, &str)]) -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot_with(&dir, extra).await;
        Instance::claimed_on(dir, app).await
    }

    async fn claimed_on(dir: TempDir, app: Arc<App>) -> Instance {
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
    let admitted = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert_eq!(admitted.status, StatusCode::OK);
    assert!(admitted.cookie().is_none());
    instance.app.faults.clear(None);
    let recorded = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert_eq!(recorded.status, StatusCode::OK);
    assert_eq!(recorded.cookie().as_ref(), Some(&cookie));
}

#[tokio::test]
async fn a_refused_request_that_records_a_use_sends_the_cookie_again() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    instance.app.clock.advance(120_000).unwrap();
    let refused = Request::builder()
        .method(Method::DELETE)
        .uri("/owner/passkeys/absent")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    let refused = send(instance.public.clone(), refused).await;
    assert_eq!(refused.status, StatusCode::NOT_FOUND);
    assert_eq!(refused.cookie().as_ref(), Some(&cookie));
    let within_the_minute = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert!(within_the_minute.cookie().is_none());
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
async fn an_email_changed_during_a_sign_in_ends_that_sign_in() {
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
    let mut change = post("/owner", &json!({ "email": "moved@example.test" }));
    *change.method_mut() = Method::PATCH;
    let changed = send(instance.control.clone(), change).await;
    assert_eq!(changed.status, StatusCode::OK);
    faults.clear(None);
    let late = signing_in.await.unwrap();
    assert_eq!(late.status, StatusCode::UNAUTHORIZED);
    assert!(late.cookie().is_none());
}

#[tokio::test]
async fn an_unknown_outcome_changes_no_cookie() {
    for (path, body, action) in [("/auth/sign-out", json!({}), "auth.session.delete")] {
        let instance = Instance::claimed().await;
        let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
        instance.app.clock.advance(120_000).unwrap();
        instance
            .app
            .faults
            .set("fail:commit-full", Some(action))
            .unwrap();
        let failed = send(
            instance.public.clone(),
            post_signed_in(path, &body, &cookie),
        )
        .await;
        assert_eq!(failed.status, StatusCode::INSUFFICIENT_STORAGE, "{path}");
        assert!(failed.cookie().is_none(), "{path}");
    }
}

fn from(address: &str, mut request: Request<Body>) -> Request<Body> {
    request
        .extensions_mut()
        .insert(ConnectInfo(Peer(Some(address.parse().unwrap()))));
    request
}

const AWAY: &str = "203.0.113.9";
const NO_ADDRESS_ORIGIN: &str = "http://localhost:8600";

fn sign_in_at(origin: &str) -> Request<Body> {
    let mut request = post("/auth/sign-in/email", &sign_in_body(PASSWORD));
    request
        .headers_mut()
        .insert(header::ORIGIN, origin.parse().unwrap());
    request
}

#[tokio::test]
async fn until_an_address_is_set_only_this_machine_gets_past_the_doors() {
    let instance = Instance::claimed_with(&[("MARFA_TEST_HOOKS", "true")]).await;
    for path in [
        "/setup/exchange",
        "/setup/claim",
        "/owner",
        "/auth/sign-in",
        "/auth/sign-in/email",
        "/auth/confirm",
        "/auth/passkey/verify-authentication",
    ] {
        let cookie = "marfa.session_token=none";
        let request = from(AWAY, post_signed_in(path, &json!({}), cookie));
        let refused = send(instance.public.clone(), request).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{path}");
        let message = refused.body["error"]["message"].as_str().unwrap();
        assert!(message.contains("sign_in_address"), "{path}: {message}");
    }
    let here = send(
        instance.public.clone(),
        from("127.0.0.1", sign_in_at(NO_ADDRESS_ORIGIN)),
    )
    .await;
    assert_eq!(here.status, StatusCode::OK);
    let cookie = here.cookie().unwrap();
    let body = json!({ "password": PASSWORD });
    let request = from(AWAY, post_signed_in("/auth/confirm", &body, &cookie));
    let refused = send(instance.public.clone(), request).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    let mapped = send(
        instance.public.clone(),
        from("::ffff:127.0.0.1", sign_in_at(NO_ADDRESS_ORIGIN)),
    )
    .await;
    assert_eq!(mapped.status, StatusCode::OK);
    let mut set = post(
        "/config",
        &json!({
            "sign_in_address": "https://marfa.example",
            "confirm_sign_in_address_change": true,
        }),
    );
    *set.method_mut() = Method::PATCH;
    let moved = send(instance.control.clone(), set).await;
    assert_eq!(moved.status, StatusCode::OK);
    let away = send(
        instance.public.clone(),
        from(AWAY, sign_in_at("https://marfa.example")),
    )
    .await;
    assert_eq!(away.status, StatusCode::OK);
}

#[tokio::test]
async fn a_seeded_address_counts_as_set_under_test_hooks() {
    let instance = Instance::claimed().await;
    let away = send(instance.public.clone(), from(AWAY, sign_in_at(ORIGIN))).await;
    assert_eq!(away.status, StatusCode::OK);
}

#[tokio::test]
async fn only_test_hooks_excuse_a_caller_named_behind_a_loopback_listener() {
    let held = [("MARFA_LISTEN_HOST", "127.0.0.1")];
    let instance = Instance::claimed_with(&held).await;
    let origin = "http://127.0.0.1:8600";
    let refused = send(instance.public.clone(), from(AWAY, sign_in_at(origin))).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    let hooked = [
        ("MARFA_LISTEN_HOST", "127.0.0.1"),
        ("MARFA_TEST_HOOKS", "true"),
    ];
    let instance = Instance::claimed_with(&hooked).await;
    let away = send(instance.public.clone(), from(AWAY, sign_in_at(origin))).await;
    assert_eq!(away.status, StatusCode::OK);
}

#[tokio::test]
async fn a_new_email_is_not_a_verified_one() {
    let instance = Instance::claimed().await;
    let verified = || async {
        instance
            .app
            .db
            .read(|tx| {
                Ok(
                    tx.query_row("SELECT email_verified FROM auth_user", [], |row| {
                        row.get::<_, bool>(0)
                    })?,
                )
            })
            .await
            .unwrap()
    };
    let change = |body: Value| {
        let mut request = post("/owner", &body);
        *request.method_mut() = Method::PATCH;
        send(instance.control.clone(), request)
    };
    assert_eq!(
        change(json!({ "name": "Owner" })).await.status,
        StatusCode::OK
    );
    assert!(verified().await);
    assert_eq!(
        change(json!({ "email": EMAIL })).await.status,
        StatusCode::OK
    );
    assert!(verified().await);
    let moved = change(json!({ "email": "moved@example.test" })).await;
    assert_eq!(moved.status, StatusCode::OK);
    assert!(!verified().await);
}

#[tokio::test]
async fn a_claim_refuses_a_name_that_is_not_text() {
    let dir = TempDir::new().unwrap();
    let router = public(boot(&dir).await);
    for path in ["/setup/claim", "/owner"] {
        let claim = |name: Value| {
            let body =
                json!({ "email": EMAIL, "password": PASSWORD, "code": "000000", "name": name });
            send(router.clone(), post(path, &body))
        };
        assert_eq!(
            claim(json!(42)).await.status,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
        assert_ne!(
            claim(json!("Owner")).await.status,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}

#[tokio::test]
async fn the_setup_status_refuses_a_bad_bearer() {
    let instance = Instance::claimed().await;
    let status = |bearer: Option<&str>| {
        let mut request = Request::builder().uri("/_control/setup/status");
        if let Some(bearer) = bearer {
            request = request.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
        }
        send(
            instance.control.clone(),
            request.body(Body::empty()).unwrap(),
        )
    };
    assert_eq!(status(None).await.status, StatusCode::OK);
    assert_eq!(
        status(Some("not-a-key")).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn the_sweep_removes_a_setup_proof_past_its_end_and_keeps_the_code() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    let router = control(app.clone());
    for path in ["/_control/setup/code", "/_control/setup/ticket"] {
        let issued = send(router.clone(), post(path, &json!({}))).await;
        assert_eq!(issued.status, StatusCode::OK, "{path}");
    }
    let proofs = || async {
        app.db
            .read(|tx| {
                Ok(tx.query_row(
                    "SELECT count(*), count(expires_at) FROM setup_proof",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?)
            })
            .await
            .unwrap()
    };
    assert_eq!(proofs().await, (2, 1));
    app.clock.advance(6 * 60_000).unwrap();
    let path = "/housekeeping/auth-session-cleanup/run";
    let swept = send(router.clone(), post(path, &json!({}))).await;
    assert_eq!(swept.status, StatusCode::OK);
    assert_eq!(proofs().await, (1, 0));
}

#[tokio::test]
async fn a_session_past_its_end_leaves_no_entry_when_all_are_ended() {
    let instance = Instance::claimed().await;
    instance.sign_in(PASSWORD).await.cookie().unwrap();
    instance.app.clock.advance(8 * 24 * 3_600_000).unwrap();
    instance.sign_in(PASSWORD).await.cookie().unwrap();
    let recovered = send(
        instance.control.clone(),
        post(
            "/_control/owner/recover",
            &json!({ "password": "the second password" }),
        ),
    )
    .await;
    assert_eq!(recovered.status, StatusCode::OK);
    let (entries, left): (i64, i64) = instance
        .app
        .db
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT (SELECT count(*) FROM audit_log WHERE action = 'auth.session.delete'), \
                 (SELECT count(*) FROM auth_session)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!((entries, left), (1, 0));
}

#[tokio::test]
async fn a_claim_through_the_owner_door_ends_the_setup_cookie_it_used() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    let (router, private) = (public(app.clone()), control(app));
    let issued = send(private, post("/_control/setup/code", &json!({}))).await;
    let code = json!({ "code": issued.body["code"] });
    let exchanged = send(router.clone(), post("/setup/exchange", &code)).await;
    assert_eq!(exchanged.status, StatusCode::OK);
    let setup = exchanged.cookie().unwrap();
    let name = setup.split_once('=').unwrap().0;
    let claim = json!({ "email": EMAIL, "password": PASSWORD });
    let claimed = send(router, post_signed_in("/owner", &claim, &setup)).await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    let cleared = claimed
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|line| line.to_str().ok())
        .any(|line| line.starts_with(&format!("{name}=;")) && line.contains("Max-Age=0"));
    assert!(cleared, "{:?}", claimed.headers);
}

#[tokio::test]
async fn the_code_a_start_announces_is_recorded_as_the_servers_own_work() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    claim::announce_at_start(&app).await.unwrap();
    let actor: String = app
        .db
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT actor FROM audit_log WHERE action = 'instance.setup_code.issued'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    let actor: Value = serde_json::from_str(&actor).unwrap();
    assert_eq!(actor["kind"], "server");
}

#[tokio::test]
async fn a_form_sign_in_sends_a_browser_only_to_a_path_on_the_instance() {
    let instance = Instance::claimed().await;
    let own = format!("{ORIGIN}//foreign.example");
    for (asked, wanted) in [
        ("/\t/foreign.example", "/"),
        ("/.//foreign.example", "/"),
        ("/a/..//foreign.example", "/"),
        ("/%2e//foreign.example", "/"),
        ("/.\\/foreign.example", "/"),
        ("//foreign.example", "/"),
        (own.as_str(), "/"),
        (
            "/auth/device?from=sign-in#entry",
            "/auth/device?from=sign-in#entry",
        ),
    ] {
        let fields = form_urlencoded::Serializer::new(String::new())
            .append_pair("email", EMAIL)
            .append_pair("password", PASSWORD)
            .append_pair("return_to", asked)
            .finish();
        let request = Request::builder()
            .method(Method::POST)
            .uri("/auth/sign-in")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::ORIGIN, ORIGIN)
            .body(Body::from(fields))
            .unwrap();
        let reply = send(instance.public.clone(), request).await;
        assert_eq!(reply.status, StatusCode::FOUND, "{asked:?}");
        assert_eq!(reply.headers[header::LOCATION], wanted, "{asked:?}");
    }
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
