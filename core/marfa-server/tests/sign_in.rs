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
const USERNAME: &str = "owner";
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
    text: String,
    headers: HeaderMap,
}

impl Reply {
    fn cookie(&self) -> Option<String> {
        let line = self.headers.get(header::SET_COOKIE)?.to_str().ok()?;
        Some(line.split(';').next()?.to_string())
    }

    /// The `name=value` of the cookie this reply sets under `name`.
    fn named(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|line| line.to_str().ok()?.split(';').next())
            .find(|pair| pair.split_once('=').is_some_and(|(key, _)| key == name))
            .map(str::to_string)
    }

    /// The id the device cookie this reply sets carries.
    fn device_id(&self) -> Option<String> {
        let pair = self.named("marfa_device")?;
        Some(pair.split_once('=')?.1.split('.').next()?.to_string())
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
        text: String::from_utf8_lossy(&bytes).into_owned(),
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

/// What a browser sends for a form on a page: the fields as a form, and a page asked for.
fn page_form(path: &str, fields: &[(&str, &str)], cookie: &str) -> Request<Body> {
    let mut body = form_urlencoded::Serializer::new(String::new());
    for (name, value) in fields {
        body.append_pair(name, value);
    }
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ACCEPT, "text/html")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie)
        .body(Body::from(body.finish()))
        .unwrap()
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
    json!({ "username": USERNAME, "password": password })
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
        let claim = json!({ "username": USERNAME, "password": PASSWORD });
        let reply = send(
            instance.control.clone(),
            post("/_control/setup/claim", &claim),
        )
        .await;
        assert_eq!(reply.status, StatusCode::CREATED);
        instance
    }

    async fn restarted(self) -> Instance {
        self.app.close().await;
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
            post("/auth/sign-in", &sign_in_body(password)),
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
async fn a_restart_starts_every_count_afresh() {
    let instance = Instance::claimed().await;
    for _ in 0..10 {
        let wrong = instance.sign_in("not the password").await;
        assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    }
    let held = instance.sign_in(PASSWORD).await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(held.headers.contains_key(header::RETRY_AFTER));

    let instance = instance.restarted().await;
    assert!(instance.sign_in(PASSWORD).await.cookie().is_some());
}

#[tokio::test]
async fn a_wrong_password_whose_refusal_is_not_recorded_stays_counted() {
    let instance = Instance::claimed().await;
    for failure in ["fail:commit", "fail:commit-full"] {
        for _ in 0..5 {
            instance
                .app
                .faults
                .set(failure, Some("auth.sign_in.failed"))
                .unwrap();
            let wrong = instance.sign_in("not the password").await;
            assert!(wrong.status.is_server_error(), "{failure}");
        }
    }
    let held = instance.sign_in(PASSWORD).await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_full_disk_costs_a_session_its_renewal_and_not_the_request() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    instance.app.clock.advance(120_000).unwrap();
    instance
        .app
        .faults
        .set("fail:commit-full", Some("auth.sign_in.used"))
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
        post("/auth/sign-in", &sign_in_body(PASSWORD)),
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
async fn a_username_changed_during_a_sign_in_ends_that_sign_in() {
    let instance = Instance::claimed().await;
    let faults = instance.app.faults.clone();
    faults
        .set("hold:write", Some("auth.sign_in.success"))
        .unwrap();
    let signing_in = tokio::spawn(send(
        instance.public.clone(),
        post("/auth/sign-in", &sign_in_body(PASSWORD)),
    ));
    while faults.list().iter().all(|fault| fault.waiting == 0) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let mut change = post("/profile", &json!({ "username": "moved" }));
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
    for (path, body, action) in [("/auth/sign-out", json!({}), "auth.sign_in.ended")] {
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
    let mut request = post("/auth/sign-in", &sign_in_body(PASSWORD));
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
        "/auth/passkeys/sign-in",
    ] {
        let cookie = "marfa_session=none";
        let request = from(AWAY, post_signed_in(path, &json!({}), cookie));
        let refused = send(instance.public.clone(), request).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{path}");
        let message = refused.body["error"]["message"].as_str().unwrap();
        assert!(message.contains("sign_in_address"), "{path}: {message}");
    }
    let unknown = from(
        AWAY,
        post_signed_in("/auth/confirm", &json!({}), "marfa_session=none"),
    );
    let refused = send(instance.public.clone(), unknown).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
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
            "skip_sign_in_address_check": true,
        }),
    );
    *set.method_mut() = Method::PATCH;
    let moved = send(instance.control.clone(), set).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
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
async fn a_loopback_listener_excuses_no_caller_from_elsewhere() {
    for hooks in ["false", "true"] {
        let held = [
            ("MARFA_LISTEN_HOST", "127.0.0.1"),
            ("MARFA_TEST_HOOKS", hooks),
        ];
        let instance = Instance::claimed_with(&held).await;
        let refused = send(instance.public.clone(), from(AWAY, sign_in_at(ORIGIN))).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "hooks {hooks}");
    }
}

#[tokio::test]
async fn a_caller_is_on_this_machine_only_by_its_own_connection() {
    let forwarded = |peer: &str, named: &str| {
        let mut request = from(peer, sign_in_at(NO_ADDRESS_ORIGIN));
        request
            .headers_mut()
            .insert("x-client", named.parse().unwrap());
        request
    };
    for trust in [
        vec![("MARFA_TRUSTED_PROXY_CIDRS", "0.0.0.0/0")],
        vec![
            ("MARFA_TRUSTED_PROXY_HEADER", "X-Client"),
            ("MARFA_TRUSTED_PROXY_CIDRS", "0.0.0.0/0"),
        ],
    ] {
        let instance = Instance::claimed_with(&trust).await;
        let mut named_here = forwarded(AWAY, "127.0.0.1");
        named_here
            .headers_mut()
            .insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        let refused = send(instance.public.clone(), named_here).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{trust:?}");
        let mut through_an_edge = forwarded("127.0.0.1", AWAY);
        through_an_edge
            .headers_mut()
            .insert("x-forwarded-for", AWAY.parse().unwrap());
        let refused = send(instance.public.clone(), through_an_edge).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{trust:?}");
        // The witness: this machine, named as itself, gets past.
        let here = send(instance.public.clone(), forwarded("127.0.0.1", "127.0.0.1")).await;
        assert_eq!(here.status, StatusCode::OK, "{trust:?}");
    }
}

#[tokio::test]
async fn a_claim_refuses_a_name_that_is_not_text() {
    let dir = TempDir::new().unwrap();
    let router = public(boot(&dir).await);
    for path in ["/setup/claim", "/owner"] {
        let claim = |name: Value| {
            let body = json!({ "username": USERNAME, "password": PASSWORD, "code": "000000", "name": name });
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
    let path = "/housekeeping/credential-cleanup/run";
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
                "SELECT (SELECT count(*) FROM audit_log WHERE action = 'auth.sign_in.ended'), \
                 (SELECT count(*) FROM sign_ins)",
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
    let claim = json!({ "username": USERNAME, "password": PASSWORD });
    let claimed = send(router, post_signed_in("/owner", &claim, &setup)).await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    let cleared = claimed
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|line| line.to_str().ok())
        .any(|line| line.starts_with(&format!("{name}=;")) && line.contains("Max-Age=0"));
    assert!(cleared, "{:?}", claimed.headers);
    assert!(claimed.named("marfa_session").is_some());
    assert!(claimed.device_id().is_some(), "{:?}", claimed.headers);
}

#[tokio::test]
async fn a_device_cookie_set_before_a_recovery_is_no_cookie_after_it() {
    let instance = Instance::claimed().await;
    let first = instance.sign_in(PASSWORD).await;
    let device = first.named("marfa_device").unwrap();
    let id = first.device_id().unwrap();
    let sign_in_from_device = || {
        send(
            instance.public.clone(),
            post_signed_in("/auth/sign-in", &sign_in_body(PASSWORD), &device),
        )
    };
    // The witness: before the recovery the cookie names its device again.
    assert_eq!(sign_in_from_device().await.device_id(), Some(id.clone()));
    let recovered = send(
        instance.control.clone(),
        post("/_control/owner/recover", &json!({ "password": PASSWORD })),
    )
    .await;
    assert_eq!(recovered.status, StatusCode::OK);
    let after = sign_in_from_device().await;
    assert_eq!(after.status, StatusCode::OK);
    let renewed = after.device_id().unwrap();
    assert_ne!(renewed, id);
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
            .append_pair("username", USERNAME)
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
        .read(|tx| Ok(tx.query_row("SELECT digest FROM sign_ins", [], |row| row.get(0))?))
        .await
        .unwrap();
    assert_ne!(held, token);
}

#[tokio::test]
async fn a_json_sign_in_answers_ok_and_sets_the_session_cookie() {
    let instance = Instance::claimed().await;
    let signed = instance.sign_in(PASSWORD).await;
    assert_eq!(signed.status, StatusCode::OK);
    assert_eq!(signed.body, json!({ "ok": true }));
    let line = signed.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(line.starts_with("marfa_session="), "{line}");
    assert!(line.contains("Max-Age="), "{line}");

    let wrong = instance.sign_in("not the password").await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert!(wrong.cookie().is_none());

    let asked = json!({ "username": USERNAME, "password": PASSWORD, "rememberMe": false });
    let refused = send(instance.public.clone(), post("/auth/sign-in", &asked)).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert!(refused.cookie().is_none());
}

#[tokio::test]
async fn a_session_token_under_an_old_cookie_name_signs_no_one_in() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let token = cookie.split_once('=').unwrap().1;
    let held = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert_eq!(held.status, StatusCode::OK);
    for name in ["marfa.session_token", "marfa.auth.session_token"] {
        let old = format!("{name}={token}");
        let refused = send(instance.public.clone(), on_the_passkey_list(&old)).await;
        assert_eq!(refused.status, StatusCode::UNAUTHORIZED, "{name}");
    }
}

#[tokio::test]
async fn sign_out_answers_ok_and_ends_the_cookie() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let ended = send(
        instance.public.clone(),
        post_signed_in("/auth/sign-out", &json!({}), &cookie),
    )
    .await;
    assert_eq!(ended.status, StatusCode::OK);
    assert_eq!(ended.body, json!({ "ok": true }));
    let gone = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert_eq!(gone.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_form_sign_out_shows_the_signed_out_notice_and_ends_the_cookie() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let ended = send(
        instance.public.clone(),
        page_form("/auth/sign-out", &[], &cookie),
    )
    .await;
    assert_eq!(ended.status, StatusCode::OK);
    assert!(ended.text.contains("signed out"), "{}", ended.text);
    let line = ended.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(line.starts_with("marfa_session=;"), "{line}");
    let gone = send(instance.public.clone(), on_the_passkey_list(&cookie)).await;
    assert_eq!(gone.status, StatusCode::UNAUTHORIZED);
}

fn goes_to(reply: &Reply) -> String {
    assert_eq!(reply.status, StatusCode::SEE_OTHER, "{}", reply.text);
    reply.headers[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string()
}

async fn change_from_the_page(instance: &Instance, cookie: &str, fields: [&str; 3]) -> Reply {
    let [current, new, again] = fields;
    send(
        instance.public.clone(),
        page_form(
            "/auth/owner/password",
            &[
                ("current_password", current),
                ("new_password", new),
                ("confirm_password", again),
            ],
            cookie,
        ),
    )
    .await
}

#[tokio::test]
async fn a_form_password_change_goes_back_to_the_page_with_what_happened() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let new = "the second password";
    for (fields, problem) in [
        ([PASSWORD, "short", "short"], "new_too_short"),
        ([PASSWORD, new, "the third password"], "not_the_same"),
        (["not the password", new, new], "current_not_right"),
        (["", new, new], "current_missing"),
    ] {
        let reply = change_from_the_page(&instance, &cookie, fields).await;
        assert_eq!(
            goes_to(&reply),
            format!("/auth/owner/passkeys?problem={problem}"),
            "{fields:?}"
        );
        assert!(
            reply.headers.get(header::SET_COOKIE).is_none(),
            "{fields:?}"
        );
    }
    assert_eq!(instance.sign_in(PASSWORD).await.status, StatusCode::OK);

    let reply = change_from_the_page(&instance, &cookie, [PASSWORD, new, new]).await;
    assert_eq!(goes_to(&reply), "/auth/owner/passkeys?changed=1");
    assert_eq!(
        instance.sign_in(PASSWORD).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(instance.sign_in(new).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_form_password_change_that_is_tried_too_often_says_how_long_to_wait() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let mut places = Vec::new();
    for _ in 0..60 {
        let reply = change_from_the_page(
            &instance,
            &cookie,
            [
                "not the password",
                "the second password",
                "the second password",
            ],
        )
        .await;
        let place = goes_to(&reply);
        let stop = place.contains("too_many_attempts");
        places.push(place);
        if stop {
            break;
        }
    }
    assert_eq!(places[0], "/auth/owner/passkeys?problem=current_not_right");
    let last = places.last().unwrap();
    assert!(
        last.starts_with("/auth/owner/passkeys?problem=too_many_attempts&retry_after_seconds="),
        "{last}"
    );
}

#[tokio::test]
async fn a_json_password_change_still_answers_in_json() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let wrong = send(
        instance.public.clone(),
        post_signed_in(
            "/auth/owner/password",
            &json!({ "current_password": "not the password", "new_password": "the second password" }),
            &cookie,
        ),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let changed = send(
        instance.public.clone(),
        post_signed_in(
            "/auth/owner/password",
            &json!({ "current_password": PASSWORD, "new_password": "the second password" }),
            &cookie,
        ),
    )
    .await;
    assert_eq!(changed.status, StatusCode::OK);
    assert_eq!(changed.body, json!({ "ok": true }));
}

#[tokio::test]
async fn the_passkeys_page_shows_what_a_form_password_change_got() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let page = |query: &str| {
        let request = Request::builder()
            .uri(format!("/auth/owner/passkeys{query}"))
            .header(header::COOKIE, &cookie)
            .header(header::ACCEPT, "text/html")
            .body(Body::empty())
            .unwrap();
        send(instance.public.clone(), request)
    };
    let plain = page("").await;
    assert_eq!(plain.status, StatusCode::OK);
    let shown = "data-password-changed>Your password has been changed.";
    assert!(plain.text.contains("data-password-changed hidden>"));
    assert!(!plain.text.contains(shown));
    assert!(!plain.text.contains(r#"class="err" id="current-note""#));
    let changed = page("?changed=1").await;
    assert!(changed.text.contains(shown), "{}", changed.text);
    let wrong = page("?problem=current_not_right").await;
    assert!(
        wrong
            .text
            .contains(r#"class="err" id="current-note" aria-live="polite" data-note data-hint="">That password isn’t right."#),
        "{}",
        wrong.text
    );
    let waiting = page("?problem=too_many_attempts&retry_after_seconds=600").await;
    assert!(
        waiting.text.contains("Try again in 10 minutes"),
        "{}",
        waiting.text
    );
}

#[tokio::test]
async fn a_form_password_change_refuses_an_overlong_current_password_without_counting_it() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let new = "the second password";
    let overlong = "x".repeat(1025);
    for _ in 0..12 {
        let reply = change_from_the_page(&instance, &cookie, [&overlong, new, new]).await;
        assert_eq!(
            goes_to(&reply),
            "/auth/owner/passkeys?problem=current_missing"
        );
    }
    let too_long_new = "y".repeat(129);
    let reply =
        change_from_the_page(&instance, &cookie, [PASSWORD, &too_long_new, &too_long_new]).await;
    assert_eq!(goes_to(&reply), "/auth/owner/passkeys?problem=new_too_long");
    let reply = change_from_the_page(&instance, &cookie, [PASSWORD, new, new]).await;
    assert_eq!(goes_to(&reply), "/auth/owner/passkeys?changed=1");
}

#[tokio::test]
async fn a_form_password_change_from_an_ended_session_is_sent_to_sign_in() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let ended = send(
        instance.public.clone(),
        post_signed_in("/auth/sign-out", &json!({}), &cookie),
    )
    .await;
    assert_eq!(ended.status, StatusCode::OK);
    let new = "the second password";
    let reply = change_from_the_page(&instance, &cookie, [PASSWORD, new, new]).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.text);
    assert!(reply.text.contains("Sign in needed"), "{}", reply.text);
    assert!(
        reply.text.contains(r#"href="/auth/sign-in""#),
        "{}",
        reply.text
    );
    assert_eq!(instance.sign_in(PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_wrong_password_names_its_field_and_an_ended_session_names_none() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let new = "the second password";
    let change = json!({ "current_password": "not the password", "new_password": new });
    let wrong = send(
        instance.public.clone(),
        post_signed_in("/auth/owner/password", &change, &cookie),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body["error"]["details"]["field"], "current_password");
    let confirm = json!({ "password": "not the password" });
    let wrong = send(
        instance.public.clone(),
        post_signed_in("/auth/confirm", &confirm, &cookie),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body["error"]["details"]["field"], "password");

    let ended = send(
        instance.public.clone(),
        post_signed_in("/auth/sign-out", &json!({}), &cookie),
    )
    .await;
    assert_eq!(ended.status, StatusCode::OK);
    for (path, body) in [
        ("/auth/owner/password", &change),
        ("/auth/confirm", &confirm),
    ] {
        let gone = send(instance.public.clone(), post_signed_in(path, body, &cookie)).await;
        assert_eq!(gone.status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            gone.body["error"]["details"]["field"],
            Value::Null,
            "{path}"
        );
    }
}

#[tokio::test]
async fn the_passkeys_page_marks_only_the_fields_a_problem_is_about() {
    let instance = Instance::claimed().await;
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let invalid = async |query: &str| {
        let request = Request::builder()
            .uri(format!("/auth/owner/passkeys{query}"))
            .header(header::COOKIE, &cookie)
            .header(header::ACCEPT, "text/html")
            .body(Body::empty())
            .unwrap();
        let page = send(instance.public.clone(), request).await;
        assert_eq!(page.status, StatusCode::OK);
        ["current-password", "new-password", "new-password-again"]
            .into_iter()
            .filter(|id| {
                let start = page.text.find(&format!(r#"<input id="{id}""#)).unwrap();
                let end = start + page.text[start..].find('>').unwrap();
                page.text[start..end].contains(r#"aria-invalid="true""#)
            })
            .collect::<Vec<_>>()
    };
    let both = vec!["new-password", "new-password-again"];
    assert_eq!(invalid("?problem=not_the_same").await, both);
    assert_eq!(invalid("?problem=new_too_short").await, both);
    assert_eq!(invalid("?problem=new_too_long").await, both);
    assert_eq!(
        invalid("?problem=current_not_right").await,
        ["current-password"]
    );
    assert_eq!(
        invalid("?problem=current_missing").await,
        ["current-password"]
    );
    assert!(
        invalid("?problem=too_many_attempts&retry_after_seconds=60")
            .await
            .is_empty()
    );
    assert!(invalid("?problem=something_else").await.is_empty());
    assert!(invalid("").await.is_empty());
}
