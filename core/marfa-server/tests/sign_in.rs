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

/// A browser's form post, which asks for a page.
fn post_form(path: &str, fields: &[(&str, &str)], cookie: &str) -> Request<Body> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish();
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ACCEPT, "text/html")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, cookie)
        .body(Body::from(body))
        .unwrap()
}

async fn page_of(router: Router, request: Request<Body>) -> (StatusCode, String) {
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// A setup session cookie, made the way a person's browser makes one: with the setup code.
async fn setup_session(router: &Router, private: &Router) -> String {
    let issued = send(private.clone(), post("/_control/setup/code", &json!({}))).await;
    let code = json!({ "code": issued.body["code"] });
    let exchanged = send(router.clone(), post("/setup/exchange", &code)).await;
    assert_eq!(exchanged.status, StatusCode::OK);
    exchanged.cookie().unwrap()
}

const MISMATCH: &str = "The passwords don’t match.";

#[tokio::test]
async fn a_claim_form_whose_passwords_differ_is_refused_and_claims_nothing() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    let (router, private) = (public(app.clone()), control(app.clone()));
    let setup = setup_session(&router, &private).await;
    let form = |confirm: &'static str| {
        post_form(
            "/setup/claim",
            &[
                ("username", USERNAME),
                ("name", ""),
                ("password", "first-password"),
                ("confirm_password", confirm),
            ],
            &setup,
        )
    };

    let (status, page) = page_of(router.clone(), form("first-passwrod")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(page.contains(MISMATCH), "{page}");
    assert!(page.contains("id=\"owner-form\""));
    assert!(page.contains(&format!("value=\"{USERNAME}\"")));
    assert!(!page.contains("first-pass"), "a password came back");
    assert!(!claim::is_claimed(&app).await.unwrap());

    // The witness: the same form with the passwords alike claims, and a blank name is the username.
    let (status, _) = page_of(router, form("first-password")).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(claim::is_claimed(&app).await.unwrap());
    let owner = marfa_server::app::auth::owner::find(&app)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.name, USERNAME);
}

#[tokio::test]
async fn the_forgot_password_page_answers_to_anyone_and_prints_no_path() {
    let instance = Instance::claimed().await;
    let socket = instance.dir.path().join("s.sock");
    let get = |path: &str, cookie: Option<&str>| {
        let mut request = Request::builder().uri(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::empty()).unwrap()
    };

    let (status, page) = page_of(instance.public.clone(), get("/auth/forgot-password", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("owner recover"), "{page}");
    assert!(page.contains("MARFA_OWNER_RECOVERY=true"), "{page}");
    assert!(!page.contains(socket.to_str().unwrap()), "{page}");
    assert!(
        !page.contains(instance.dir.path().to_str().unwrap()),
        "{page}"
    );
    // The witness: the page names the socket by a word, and the sign-in page links here.
    assert!(page.contains("socket PATH"), "{page}");
    let (_, sign_in) = page_of(instance.public.clone(), get("/auth/sign-in", None)).await;
    assert!(
        sign_in.contains("href=\"/auth/forgot-password\""),
        "{sign_in}"
    );

    // A signed-in person is answered the same page.
    let cookie = instance.sign_in(PASSWORD).await.cookie().unwrap();
    let (status, again) = page_of(
        instance.public.clone(),
        get("/auth/forgot-password", Some(&cookie)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(again.contains("owner recover"), "{again}");
}

#[tokio::test]
async fn a_claim_sent_as_json_needs_no_confirmation_and_a_blank_name_is_the_username() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    let router = control(app.clone());
    let claim_body = json!({ "username": USERNAME, "password": PASSWORD, "name": "  " });
    let reply = send(router, post("/_control/setup/claim", &claim_body)).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(reply.body["name"], USERNAME);
}

#[tokio::test]
async fn a_recovery_form_is_judged_for_its_owner_and_its_proof_before_its_passwords() {
    let form = |password: &'static str, confirm: Option<&'static str>| {
        let mut fields = vec![("password", password)];
        fields.extend(confirm.map(|confirm| ("confirm_password", confirm)));
        post_form("/setup/recover", &fields, "")
    };

    // No owner: whatever the passwords are, there is nothing to recover.
    let dir = TempDir::new().unwrap();
    let app = boot_with(
        &dir,
        &[
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
            ("MARFA_OWNER_RECOVERY", "true"),
        ],
    )
    .await;
    let unowned = public(app);
    for confirm in [Some("second-passwrod"), Some("second-password"), None] {
        let (status, _) = page_of(unowned.clone(), form("second-password", confirm)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{confirm:?}");
    }

    // An owner and no proof standing: the ended proof is said before a mismatch.
    let instance = Instance::claimed_with(&[
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
        ("MARFA_OWNER_RECOVERY", "true"),
    ])
    .await;
    for confirm in [Some("second-passwrod"), Some("second-password")] {
        let (status, page) =
            page_of(instance.public.clone(), form("second-password", confirm)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{confirm:?}");
        assert!(page.contains("recovery session ended"), "{page}");
    }
    assert!(instance.sign_in(PASSWORD).await.status.is_success());
}

#[tokio::test]
async fn a_form_that_sets_a_password_must_repeat_it() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    let (router, private) = (public(app.clone()), control(app.clone()));
    let setup = setup_session(&router, &private).await;
    let claim_form = |extra: &[(&str, &str)]| {
        let mut fields = vec![
            ("username", USERNAME),
            ("name", ""),
            ("password", "first-password"),
        ];
        fields.extend_from_slice(extra);
        post_form("/setup/claim", &fields, &setup)
    };

    // The page leaves the confirmation out: nothing is claimed.
    let (status, page) = page_of(router.clone(), claim_form(&[])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(page.contains(MISMATCH), "{page}");
    assert!(!claim::is_claimed(&app).await.unwrap());

    // A claim that also holds a field it does not declare is refused for that field first.
    let mut undeclared = claim_form(&[("confirm_password", "first-passwrod"), ("bogus", "1")]);
    undeclared
        .headers_mut()
        .insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, body) = page_of(router.clone(), undeclared).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("unknown_body_fields"), "{body}");
    assert!(body.contains("bogus"), "{body}");

    // A session that has ended is said before a mismatch.
    let ended = post_form(
        "/setup/claim",
        &[
            ("username", USERNAME),
            ("password", "first-password"),
            ("confirm_password", "first-passwrod"),
        ],
        "marfa_setup=gone",
    );
    let (status, _) = page_of(router.clone(), ended).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(!claim::is_claimed(&app).await.unwrap());

    // The witness: the same form with the confirmation alike claims.
    let (status, _) = page_of(
        router,
        claim_form(&[("confirm_password", "first-password")]),
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(claim::is_claimed(&app).await.unwrap());
}

#[tokio::test]
async fn a_start_without_an_owner_issues_a_setup_link_beside_its_code() {
    let dir = TempDir::new().unwrap();
    let app = boot(&dir).await;
    app.record_bound(ORIGIN.trim_start_matches("http://").parse().unwrap());
    claim::announce_at_start(&app).await.unwrap();
    let held = |kind: &'static str| {
        app.db.read(move |tx| {
            Ok(tx.query_row(
                "SELECT count(*) FROM setup_proof WHERE kind = ?1",
                [kind],
                |row| row.get::<_, i64>(0),
            )?)
        })
    };
    assert_eq!(
        (held("code").await.unwrap(), held("ticket").await.unwrap()),
        (1, 1)
    );
    assert_eq!(
        claim::handoff_link(&app, "abc"),
        format!("{ORIGIN}/setup#handoff=abc")
    );
    let claimed = Instance::claimed().await;
    claim::announce_at_start(&claimed.app).await.unwrap();
    let tickets: i64 = claimed
        .app
        .db
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT count(*) FROM setup_proof WHERE kind = 'ticket'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(tickets, 0);
}

#[tokio::test]
async fn a_start_offers_its_link_only_where_the_setup_page_can_take_it() {
    let notice = |extra: &'static [(&'static str, &'static str)], listening: bool| async move {
        let dir = TempDir::new().unwrap();
        let mut pairs = vec![("MARFA_TEST_HOOKS", "true")];
        pairs.extend_from_slice(extra);
        let app = boot_with(&dir, &pairs).await;
        if listening {
            app.record_bound("127.0.0.1:8600".parse().unwrap());
        }
        let line = claim::claim_notice(&app).await.unwrap().unwrap();
        let tickets: i64 = app
            .db
            .read(|tx| {
                Ok(tx.query_row(
                    "SELECT count(*) FROM setup_proof WHERE kind = 'ticket'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap();
        (line, tickets)
    };

    // The witness: an address the page serves on carries the link, and its ticket is held.
    let (line, tickets) = notice(&[("MARFA_SIGN_IN_ADDRESS", ORIGIN)], true).await;
    assert!(line.contains("setup code: "), "the notice lost its code");
    assert!(
        line.contains(&format!("{ORIGIN}/setup#handoff=")),
        "the loopback notice has no link"
    );
    assert_eq!(tickets, 1);
    let (line, tickets) = notice(&[("MARFA_SIGN_IN_ADDRESS", "https://marfa.example")], true).await;
    assert!(
        line.contains("https://marfa.example/setup#handoff="),
        "the https notice has no link"
    );
    assert_eq!(tickets, 1);

    // A control-only start has no public listener, so no address it holds can open the page.
    let control_only: [&'static [(&'static str, &'static str)]; 2] = [
        &[
            ("MARFA_CONTROL_ONLY", "true"),
            ("MARFA_PORT", "0"),
            ("MARFA_SIGN_IN_ADDRESS", "https://marfa.example"),
        ],
        &[("MARFA_CONTROL_ONLY", "true"), ("MARFA_PORT", "8600")],
    ];
    for extra in control_only {
        let (line, tickets) = notice(extra, false).await;
        assert!(line.contains("setup code: "), "the notice lost its code");
        assert!(
            !line.contains("handoff") && !line.contains("link"),
            "a control-only start printed a link"
        );
        assert_eq!(tickets, 0);
    }

    let (line, tickets) = notice(&[("MARFA_SIGN_IN_ADDRESS", "http://marfa.example")], true).await;
    assert!(line.contains("setup code: "), "the notice lost its code");
    assert!(
        !line.contains("handoff") && !line.contains("link"),
        "a plain http address printed a link"
    );
    assert_eq!(tickets, 0);
}
