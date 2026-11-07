//! What a passkey ceremony must survive that the contract's fixtures cannot
//! stage. The fixtures reach the server on `127.0.0.1`, which no browser and
//! no relying party takes, so this software authenticator works at `localhost`.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use marfa_server::app::App;
use marfa_server::app::auth::passkeys;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:8600";
const HOST: &str = "localhost";
const EMAIL: &str = "owner@example.test";
const PASSWORD: &str = "the first password";
const MINUTE_MS: u64 = 60_000;
const VERIFIED: u8 = 0x05;
const PRESENT_ONLY: u8 = 0x01;
const ATTESTED: u8 = 0x40;

fn text(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

/// Writes the one CBOR head this file's maps and strings need.
fn head(major: u8, length: usize) -> Vec<u8> {
    let major = major << 5;
    match length {
        0..=23 => vec![major | length as u8],
        24..=255 => vec![major | 24, length as u8],
        _ => vec![major | 25, (length >> 8) as u8, (length & 0xff) as u8],
    }
}

fn bytes_of(value: &[u8]) -> Vec<u8> {
    [head(2, value.len()), value.to_vec()].concat()
}

fn text_of(value: &str) -> Vec<u8> {
    [head(3, value.len()), value.as_bytes().to_vec()].concat()
}

/// A software authenticator holding one ES256 credential.
struct Device {
    key: SigningKey,
    id: Vec<u8>,
}

/// What differs from a browser's honest answer.
#[derive(Clone)]
struct Saying {
    origin: String,
    host: String,
    flags: u8,
    counter: u32,
    user_handle: Value,
}

impl Default for Saying {
    fn default() -> Saying {
        Saying {
            origin: ORIGIN.to_string(),
            host: HOST.to_string(),
            flags: VERIFIED,
            counter: 1,
            user_handle: Value::Null,
        }
    }
}

impl Device {
    fn new() -> Device {
        Device {
            key: SigningKey::from_slice(&random::<32>()).unwrap(),
            id: random::<32>().to_vec(),
        }
    }

    fn client_data(challenge: &str, origin: &str, kind: &str) -> Vec<u8> {
        json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
            .to_string()
            .into_bytes()
    }

    fn authenticator_data(host: &str, flags: u8, counter: u32) -> Vec<u8> {
        [
            Sha256::digest(host.as_bytes()).to_vec(),
            vec![flags],
            counter.to_be_bytes().to_vec(),
        ]
        .concat()
    }

    fn public_key(&self) -> Vec<u8> {
        let point = self.key.verifying_key().to_sec1_point(false);
        let point = point.as_bytes();
        [
            vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21],
            bytes_of(&point[1..33]),
            vec![0x22],
            bytes_of(&point[33..65]),
        ]
        .concat()
    }

    fn registration(&self, challenge: &str, saying: &Saying) -> Value {
        let data = [
            Self::authenticator_data(&saying.host, saying.flags | ATTESTED, 0),
            vec![0; 16],
            (self.id.len() as u16).to_be_bytes().to_vec(),
            self.id.clone(),
            self.public_key(),
        ]
        .concat();
        let attestation = [
            vec![0xa3],
            text_of("fmt"),
            text_of("none"),
            text_of("attStmt"),
            vec![0xa0],
            text_of("authData"),
            bytes_of(&data),
        ]
        .concat();
        json!({
            "id": text(&self.id),
            "rawId": text(&self.id),
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": text(&Self::client_data(
                    challenge,
                    &saying.origin,
                    "webauthn.create",
                )),
                "attestationObject": text(&attestation),
                "transports": ["internal"],
            },
        })
    }

    fn assertion(&self, challenge: &str, saying: &Saying) -> Value {
        let client = Self::client_data(challenge, &saying.origin, "webauthn.get");
        let data = Self::authenticator_data(&saying.host, saying.flags, saying.counter);
        let signed = [data.clone(), Sha256::digest(&client).to_vec()].concat();
        let signature: Signature = self.key.sign(&signed);
        json!({
            "id": text(&self.id),
            "rawId": text(&self.id),
            "type": "public-key",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": text(&client),
                "authenticatorData": text(&data),
                "signature": text(signature.to_der().as_bytes()),
                "userHandle": saying.user_handle,
            },
        })
    }
}

#[derive(Debug)]
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

    fn session_cookie(&self) -> Option<String> {
        self.cookie()
            .filter(|cookie| cookie.contains("session_token"))
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

fn request(method: Method, path: &str, cookie: &str, origin: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, cookie)
}

async fn boot(dir: &TempDir, address: &str) -> Arc<App> {
    let database = dir.path().join("marfa.db");
    let blobs = dir.path().join("blobs");
    let socket = dir.path().join("s.sock");
    let pairs = [
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_AUTH_BASE_URL", address),
        ("API_KEY_SALT", "a salt for these tests"),
    ];
    let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
    App::start(settings).await.unwrap()
}

/// A ceremony's first half, as a browser holds it.
struct Asked {
    challenge: String,
    cookie: String,
}

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    origin: String,
    owner: String,
}

impl Instance {
    async fn at(address: &str) -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot(&dir, address).await;
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
            origin: address.to_string(),
            owner: String::new(),
        };
        let claim = json!({ "email": EMAIL, "password": PASSWORD });
        let reply = instance.control_post("/_control/setup/claim", &claim).await;
        assert_eq!(reply.status, StatusCode::CREATED);
        instance.owner = instance.signed_in().await;
        instance
    }

    async fn claimed() -> Instance {
        Instance::at(ORIGIN).await
    }

    async fn control_post(&self, path: &str, body: &Value) -> Reply {
        let request = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        send(self.control.clone(), request).await
    }

    async fn get(&self, path: &str, cookie: &str) -> Reply {
        let request = request(Method::GET, path, cookie, &self.origin);
        send(self.public.clone(), request.body(Body::empty()).unwrap()).await
    }

    async fn post(&self, path: &str, cookie: &str, body: &Value) -> Reply {
        let request = request(Method::POST, path, cookie, &self.origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        send(self.public.clone(), request).await
    }

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        let request = request(Method::DELETE, path, cookie, &self.origin);
        send(self.public.clone(), request.body(Body::empty()).unwrap()).await
    }

    async fn signed_in(&self) -> String {
        let body = json!({ "email": EMAIL, "password": PASSWORD });
        let reply = self.post("/auth/sign-in/email", "", &body).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        reply.cookie().unwrap()
    }

    async fn asked(&self, door: &str, cookie: &str) -> Asked {
        let reply = self.get(door, cookie).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        Asked {
            challenge: reply.body["challenge"].as_str().unwrap().to_string(),
            cookie: [cookie.to_string(), reply.cookie().unwrap()].join("; "),
        }
    }

    async fn asked_to_add(&self) -> Asked {
        self.asked("/auth/passkey/generate-register-options", &self.owner)
            .await
    }

    async fn asked_to_prove(&self) -> Asked {
        self.asked("/auth/passkey/generate-authenticate-options", "")
            .await
    }

    async fn verify_registration(&self, cookie: &str, response: Value) -> Reply {
        let body = json!({ "name": "A device", "response": response });
        self.post("/auth/passkey/verify-registration", cookie, &body)
            .await
    }

    async fn verify_assertion(&self, cookie: &str, response: Value) -> Reply {
        let body = json!({ "response": response });
        self.post("/auth/passkey/verify-authentication", cookie, &body)
            .await
    }

    /// Registers `device` and answers its passkey's id.
    async fn add(&self, device: &Device) -> String {
        let asked = self.asked_to_add().await;
        let response = device.registration(&asked.challenge, &self.saying());
        let reply = self.verify_registration(&asked.cookie, response).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
        reply.body["id"].as_str().unwrap().to_string()
    }

    fn saying(&self) -> Saying {
        Saying {
            origin: self.origin.clone(),
            ..Saying::default()
        }
    }

    async fn sign_in_with(&self, device: &Device, counter: u32) -> Reply {
        let asked = self.asked_to_prove().await;
        let saying = Saying {
            counter,
            ..self.saying()
        };
        let response = device.assertion(&asked.challenge, &saying);
        self.verify_assertion(&asked.cookie, response).await
    }

    async fn listed(&self) -> Vec<Value> {
        let reply = self.get("/owner/passkeys", &self.owner).await;
        assert_eq!(reply.status, StatusCode::OK);
        reply.body["data"].as_array().unwrap().clone()
    }

    async fn count(&self, table: &'static str) -> i64 {
        self.app
            .db
            .read(move |tx| {
                let sql = format!("SELECT count(*) FROM {table}");
                Ok(tx.query_row(&sql, [], |row| row.get(0))?)
            })
            .await
            .unwrap()
    }

    fn move_to(&mut self, address: &str) {
        self.app
            .settings
            .apply_stored(&[("sign_in_address".to_string(), address.to_string())]);
        self.origin = address.to_string();
    }
}

fn is_refused(reply: &Reply) -> bool {
    matches!(
        reply.status,
        StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
    )
}

#[tokio::test]
async fn a_passkey_added_signs_in_and_the_table_holds_no_token() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let reply = instance
        .get("/auth/passkey/generate-register-options", &instance.owner)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let options = &reply.body;
    assert_eq!(options["rp"]["id"], HOST);
    assert_eq!(options["attestation"], "none");
    assert_eq!(options["authenticatorSelection"]["residentKey"], "required");
    assert_eq!(
        options["authenticatorSelection"]["userVerification"],
        "required"
    );
    let line = reply.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(line.contains("HttpOnly") && line.contains("SameSite=Strict"));
    assert!(line.contains("Max-Age=300"));
    let token = line.split(';').next().unwrap().split_once('=').unwrap().1;
    let held: Vec<String> = instance
        .app
        .db
        .read(|tx| {
            let mut statement = tx.prepare("SELECT digest FROM auth_passkey_challenge")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .await
        .unwrap();
    assert_eq!(held.len(), 1);
    assert_ne!(held[0], token);

    let id = instance.add(&device).await;
    let excluded = instance
        .get("/auth/passkey/generate-register-options", &instance.owner)
        .await;
    assert_eq!(
        excluded.body["excludeCredentials"][0]["id"],
        text(&device.id)
    );

    let proving = instance
        .get("/auth/passkey/generate-authenticate-options", "")
        .await;
    assert_eq!(proving.body["rpId"], HOST);
    assert_eq!(proving.body["userVerification"], "required");
    assert_eq!(proving.body["allowCredentials"], json!([]));

    let signed = instance.sign_in_with(&device, 1).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
    let session = signed.session_cookie().unwrap();
    assert_eq!(
        instance.get("/owner", &session).await.status,
        StatusCode::OK
    );
    let listed = instance.listed().await;
    assert_eq!(listed[0]["id"], id.as_str());
    assert!(listed[0]["last_used_at"].is_string());
    assert_eq!(listed[0].as_object().unwrap().len(), 4);
}

#[tokio::test]
async fn an_answered_challenge_cannot_be_answered_again() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let first = device.assertion(&asked.challenge, &instance.saying());
    let second = device.assertion(
        &asked.challenge,
        &Saying {
            counter: 2,
            ..instance.saying()
        },
    );
    let accepted = instance.verify_assertion(&asked.cookie, first).await;
    assert_eq!(accepted.status, StatusCode::OK);
    let replay = instance.verify_assertion(&asked.cookie, second).await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert!(replay.session_cookie().is_none());
}

#[tokio::test]
async fn a_refused_assertion_spends_its_challenge_and_moves_nothing() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let good = device.assertion(&asked.challenge, &instance.saying());
    let mut forged = Device::new().assertion(&asked.challenge, &instance.saying());
    forged["id"] = json!(text(&device.id));
    forged["rawId"] = json!(text(&device.id));
    let refused = instance.verify_assertion(&asked.cookie, forged).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    assert!(refused.session_cookie().is_none());
    assert_eq!(instance.listed().await[0]["last_used_at"], Value::Null);
    let after = instance.verify_assertion(&asked.cookie, good).await;
    assert_eq!(after.status, StatusCode::BAD_REQUEST);
    assert_eq!(instance.count("auth_passkey_challenge").await, 0);
}

#[tokio::test]
async fn a_challenge_lives_five_minutes_by_the_servers_clock() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let inside = instance.asked_to_prove().await;
    instance.app.clock.advance(5 * MINUTE_MS - 1_000).unwrap();
    let response = device.assertion(&inside.challenge, &instance.saying());
    let accepted = instance.verify_assertion(&inside.cookie, response).await;
    assert_eq!(accepted.status, StatusCode::OK);

    let late = instance.asked_to_prove().await;
    instance.app.clock.advance(5 * MINUTE_MS).unwrap();
    let saying = Saying {
        counter: 2,
        ..instance.saying()
    };
    let response = device.assertion(&late.challenge, &saying);
    let refused = instance.verify_assertion(&late.cookie, response).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert!(refused.session_cookie().is_none());
}

#[tokio::test]
async fn a_challenge_from_before_an_address_change_is_spent() {
    let mut instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    instance.move_to("http://localhost:8601");
    let response = device.assertion(&asked.challenge, &instance.saying());
    let refused = instance.verify_assertion(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert!(refused.session_cookie().is_none());
    assert_eq!(instance.count("auth_passkey_challenge").await, 0);
    // The witness: at the new port the host is the same, so the passkey signs in.
    let signed = instance.sign_in_with(&device, 1).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
}

#[tokio::test]
async fn a_passkey_of_another_host_cannot_sign_in_and_stays_listed() {
    let mut instance = Instance::claimed().await;
    let device = Device::new();
    let id = instance.add(&device).await;
    assert_eq!(
        passkeys::stranded_by(&instance.app, HOST.to_string())
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        passkeys::stranded_by(&instance.app, "marfa.example".to_string())
            .await
            .unwrap(),
        1
    );
    instance.move_to("https://marfa.example");
    let asked = instance
        .asked("/auth/passkey/generate-authenticate-options", "")
        .await;
    assert!(
        asked
            .cookie
            .contains("__Host-marfa.auth.passkey_challenge=")
    );
    // An authenticator that signs for the new host still has the old key.
    let saying = Saying {
        host: "marfa.example".to_string(),
        ..instance.saying()
    };
    let response = device.assertion(&asked.challenge, &saying);
    let refused = instance.verify_assertion(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    assert!(refused.session_cookie().is_none());

    instance.owner = instance.signed_in().await;
    let listed = instance.listed().await;
    assert_eq!(listed[0]["id"], id.as_str());
    assert!(!listed[0].as_object().unwrap().contains_key("host"));
    let page = instance.get("/auth/owner/passkeys", &instance.owner).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text.contains("data-passkey-remove"));
    let removed = instance
        .delete(&format!("/owner/passkeys/{id}"), &instance.owner)
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text);
}

#[tokio::test]
async fn an_assertion_for_a_removed_passkey_is_refused() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let id = instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let response = device.assertion(&asked.challenge, &instance.saying());
    let removed = instance
        .delete(&format!("/owner/passkeys/{id}"), &instance.owner)
        .await;
    assert_eq!(removed.status, StatusCode::OK);
    let refused = instance.verify_assertion(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    assert!(refused.session_cookie().is_none());
}

#[tokio::test]
async fn a_sign_in_whose_commit_is_unknown_sets_no_cookie_and_keeps_nothing() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let response = device.assertion(&asked.challenge, &instance.saying());
    let faults = &instance.app.faults;
    faults
        .set("fail:commit-full", Some("auth.sign_in.success"))
        .unwrap();
    let unknown = instance
        .verify_assertion(&asked.cookie, response.clone())
        .await;
    assert!(unknown.status.is_server_error());
    assert_eq!(unknown.body["error"]["details"]["write_outcome"], "unknown");
    assert!(unknown.cookie().is_none());
    assert_eq!(instance.listed().await[0]["last_used_at"], Value::Null);
    faults.clear(None);
    let again = instance.verify_assertion(&asked.cookie, response).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.text);
    assert!(again.session_cookie().is_some());
}

#[tokio::test]
async fn a_challenge_whose_commit_is_unknown_sets_no_cookie() {
    let instance = Instance::claimed().await;
    let faults = &instance.app.faults;
    faults
        .set("fail:commit-full", Some("auth.passkey.challenge"))
        .unwrap();
    let unknown = instance
        .get("/auth/passkey/generate-authenticate-options", "")
        .await;
    assert!(unknown.status.is_server_error());
    assert!(unknown.cookie().is_none());
}

#[tokio::test]
async fn a_registration_whose_commit_is_unknown_can_be_made_again() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let asked = instance.asked_to_add().await;
    let response = device.registration(&asked.challenge, &instance.saying());
    let faults = &instance.app.faults;
    faults
        .set("fail:commit-full", Some("owner.passkey.added"))
        .unwrap();
    let unknown = instance
        .verify_registration(&asked.cookie, response.clone())
        .await;
    assert!(unknown.status.is_server_error());
    assert_eq!(instance.count("auth_passkey").await, 0);
    faults.clear(None);
    let again = instance.verify_registration(&asked.cookie, response).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.text);
}

#[tokio::test]
async fn two_registrations_of_one_credential_at_once_store_one_passkey() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let one = instance.asked_to_add().await;
    let two = instance.asked_to_add().await;
    let (first, second) = tokio::join!(
        instance.verify_registration(
            &one.cookie,
            device.registration(&one.challenge, &instance.saying())
        ),
        instance.verify_registration(
            &two.cookie,
            device.registration(&two.challenge, &instance.saying())
        ),
    );
    let mut statuses = [first.status.as_u16(), second.status.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 409]);
    assert_eq!(instance.count("auth_passkey").await, 1);
}

#[tokio::test]
async fn two_assertions_on_one_challenge_at_once_open_one_session() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let one = device.assertion(&asked.challenge, &instance.saying());
    let two = device.assertion(
        &asked.challenge,
        &Saying {
            counter: 2,
            ..instance.saying()
        },
    );
    let (first, second) = tokio::join!(
        instance.verify_assertion(&asked.cookie, one),
        instance.verify_assertion(&asked.cookie, two),
    );
    let mut statuses = [first.status.as_u16(), second.status.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 400]);
}

#[tokio::test]
async fn a_counter_that_goes_back_is_refused_and_an_absent_one_is_not() {
    let instance = Instance::claimed().await;
    let counted = Device::new();
    instance.add(&counted).await;
    let first = instance.sign_in_with(&counted, 7).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    let used = instance.listed().await[0]["last_used_at"].clone();
    instance.app.clock.advance(1_000).unwrap();
    assert_eq!(
        instance.sign_in_with(&counted, 7).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(instance.listed().await[0]["last_used_at"], used);
    assert_eq!(
        instance.sign_in_with(&counted, 8).await.status,
        StatusCode::OK
    );

    let synced = Device::new();
    instance.add(&synced).await;
    for _ in 0..2 {
        assert_eq!(
            instance.sign_in_with(&synced, 0).await.status,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn an_unverified_user_is_refused_at_both_ceremonies() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let unverified = Saying {
        flags: PRESENT_ONLY,
        ..instance.saying()
    };
    let asked = instance.asked_to_add().await;
    let response = device.registration(&asked.challenge, &unverified);
    let refused = instance.verify_registration(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(instance.count("auth_passkey").await, 0);

    instance.add(&device).await;
    let asked = instance.asked_to_prove().await;
    let response = device.assertion(&asked.challenge, &unverified);
    let refused = instance.verify_assertion(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_assertion_for_another_origin_or_relying_party_is_refused() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    for saying in [
        Saying {
            origin: "http://localhost:8601".to_string(),
            ..instance.saying()
        },
        Saying {
            origin: "https://marfa.example".to_string(),
            ..instance.saying()
        },
        Saying {
            host: "marfa.example".to_string(),
            ..instance.saying()
        },
    ] {
        let asked = instance.asked_to_prove().await;
        let response = device.assertion(&asked.challenge, &saying);
        let refused = instance.verify_assertion(&asked.cookie, response).await;
        assert_eq!(
            refused.status,
            StatusCode::UNAUTHORIZED,
            "{}",
            saying.origin
        );
    }
}

#[tokio::test]
async fn a_user_handle_must_be_the_owners_when_it_is_sent() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let owner = instance.get("/owner", &instance.owner).await;
    let id = uuid::Uuid::parse_str(owner.body["id"].as_str().unwrap()).unwrap();
    for (handle, wanted, counter) in [
        (json!(text(&[7; 16])), StatusCode::UNAUTHORIZED, 1),
        (json!(text(id.as_bytes())), StatusCode::OK, 2),
    ] {
        let asked = instance.asked_to_prove().await;
        let saying = Saying {
            user_handle: handle,
            counter,
            ..instance.saying()
        };
        let response = device.assertion(&asked.challenge, &saying);
        let reply = instance.verify_assertion(&asked.cookie, response).await;
        assert_eq!(reply.status, wanted, "{}", reply.text);
    }
}

#[tokio::test]
async fn a_challenge_serves_only_its_own_ceremony_and_session() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let adding = instance.asked_to_add().await;
    let saying = instance.saying();
    let refused = instance
        .verify_assertion(&adding.cookie, device.assertion(&adding.challenge, &saying))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    let spent = instance
        .verify_registration(
            &adding.cookie,
            device.registration(&adding.challenge, &saying),
        )
        .await;
    assert_eq!(spent.status, StatusCode::BAD_REQUEST);

    let adding = instance.asked_to_add().await;
    let other = instance.signed_in().await;
    let challenge_only = adding.cookie.split("; ").last().unwrap();
    let cookie = [other.as_str(), challenge_only].join("; ");
    let refused = instance
        .verify_registration(&cookie, device.registration(&adding.challenge, &saying))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(instance.count("auth_passkey").await, 0);
}

#[tokio::test]
async fn a_registration_rechecks_the_recent_sign_in_when_it_finishes() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let asked = instance.asked_to_add().await;
    instance.app.clock.advance(6 * MINUTE_MS).unwrap();
    let response = device.registration(&asked.challenge, &instance.saying());
    let refused = instance.verify_registration(&asked.cookie, response).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(
        refused.body["error"]["message"],
        "Sign in again to perform this operation"
    );
    assert_eq!(instance.count("auth_passkey").await, 0);
}

#[tokio::test]
async fn a_refused_confirmation_leaves_the_session_and_a_good_one_replaces_it() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let stale = instance.owner.clone();
    instance.app.clock.advance(6 * MINUTE_MS).unwrap();

    let asked = instance
        .asked("/auth/passkey/generate-authenticate-options", &stale)
        .await;
    let body = json!({ "passkey": Device::new().assertion(&asked.challenge, &instance.saying()) });
    let refused = instance.post("/auth/confirm", &asked.cookie, &body).await;
    assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    assert!(refused.session_cookie().is_none());
    assert_eq!(instance.get("/owner", &stale).await.status, StatusCode::OK);

    let body = json!({ "passkey": device.assertion(&asked.challenge, &instance.saying()) });
    let spent = instance.post("/auth/confirm", &asked.cookie, &body).await;
    assert_eq!(spent.status, StatusCode::BAD_REQUEST);

    let asked = instance
        .asked("/auth/passkey/generate-authenticate-options", &stale)
        .await;
    let body = json!({ "passkey": device.assertion(&asked.challenge, &instance.saying()) });
    let confirmed = instance.post("/auth/confirm", &asked.cookie, &body).await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.text);
    let renewed = confirmed.session_cookie().unwrap();
    assert_eq!(
        instance.get("/owner", &renewed).await.status,
        StatusCode::OK
    );
    assert_eq!(
        instance.get("/owner", &stale).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_passkey_signs_in_through_a_password_lockout_and_leaves_it_in_place() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let wrong = json!({ "email": EMAIL, "password": "not the password" });
    // The owner's first sign-in spent one of the ten.
    for _ in 0..9 {
        let refused = instance.post("/auth/sign-in/email", "", &wrong).await;
        assert_eq!(refused.status, StatusCode::UNAUTHORIZED);
    }
    let right = json!({ "email": EMAIL, "password": PASSWORD });
    let held = instance.post("/auth/sign-in/email", "", &right).await;
    assert_eq!(held.status, StatusCode::TOO_MANY_REQUESTS);

    let signed = instance.sign_in_with(&device, 1).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
    assert!(signed.session_cookie().is_some());

    let still = instance.post("/auth/sign-in/email", "", &right).await;
    assert_eq!(still.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn an_ip_address_or_plain_http_has_no_passkeys_and_says_why() {
    let instance = Instance::at("http://127.0.0.1:8600").await;
    let door = "/auth/passkey/generate-authenticate-options";
    let reply = instance.get(door, "").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert!(
        reply.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("IP address")
    );
    assert!(reply.cookie().is_none());
    assert_eq!(instance.count("auth_passkey_challenge").await, 0);
    let adding = instance
        .get("/auth/passkey/generate-register-options", &instance.owner)
        .await;
    assert_eq!(adding.status, StatusCode::FORBIDDEN);
    let page = instance.get("/auth/owner/passkeys", &instance.owner).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text.contains("HTTPS") && page.text.contains("localhost"));

    let mut instance = Instance::claimed().await;
    instance.move_to("http://marfa.example");
    let reply = instance.get(door, "").await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert!(
        reply.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("HTTPS")
    );
}

#[tokio::test]
async fn a_foreign_page_cannot_start_or_finish_a_sign_in() {
    let instance = Instance::claimed().await;
    let foreign = "https://foreign.example";
    let door = "/auth/passkey/generate-authenticate-options";
    let asked = request(Method::GET, door, "", foreign);
    let reply = send(instance.public.clone(), asked.body(Body::empty()).unwrap()).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let finish = request(
        Method::POST,
        "/auth/passkey/verify-authentication",
        "",
        foreign,
    )
    .header(header::CONTENT_TYPE, "application/json")
    .body(Body::from(json!({ "response": {} }).to_string()))
    .unwrap();
    let reply = send(instance.public.clone(), finish).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_flood_of_challenges_stays_bounded_and_the_newest_still_works() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    for _ in 0..1100 {
        instance.asked_to_prove().await;
    }
    assert_eq!(instance.count("auth_passkey_challenge").await, 1024);
    let signed = instance.sign_in_with(&device, 1).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
}

#[tokio::test]
async fn the_page_escapes_a_name_and_sends_a_stranger_to_sign_in() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    let asked = instance.asked_to_add().await;
    let body = json!({
        "name": "<script>alert(1)</script>",
        "response": device.registration(&asked.challenge, &instance.saying()),
    });
    let added = instance
        .post("/auth/passkey/verify-registration", &asked.cookie, &body)
        .await;
    assert_eq!(added.status, StatusCode::OK);
    let page = instance.get("/auth/owner/passkeys", &instance.owner).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text.contains("Password and passkeys"));
    assert!(!page.text.contains("<script>alert(1)"));

    let stranger = instance.get("/auth/owner/passkeys", "").await;
    assert_eq!(stranger.status, StatusCode::FOUND);
    assert_eq!(
        stranger.headers[header::LOCATION],
        "/auth/sign-in?return_to=%2Fauth%2Fowner%2Fpasskeys"
    );
}

fn nested_cbor(depth: usize) -> Vec<u8> {
    [vec![0x81; depth], vec![0x00]].concat()
}

fn hostile_values() -> Vec<Value> {
    let long = "A".repeat(100_000);
    vec![
        json!({}),
        json!({ "id": 1, "rawId": [], "response": null, "type": 7 }),
        json!({ "id": "", "rawId": "", "type": "public-key", "response": {} }),
        json!({ "id": "x", "rawId": "!!!!", "type": "public-key", "response": {
            "clientDataJSON": "!!!!", "authenticatorData": "!!!!", "signature": "!!!!",
            "attestationObject": "!!!!", "userHandle": "!!!!" } }),
        json!({ "id": long, "rawId": long, "type": "public-key", "response": {
            "clientDataJSON": long, "authenticatorData": long, "signature": long,
            "attestationObject": long, "userHandle": long } }),
    ]
}

fn hostile_attestations() -> Vec<Vec<u8>> {
    vec![
        vec![],
        vec![0xff],
        vec![0xa3],
        vec![0xbf; 4096],
        vec![0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        vec![0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        nested_cbor(100_000),
    ]
}

#[tokio::test]
async fn hostile_json_and_cbor_are_refused_without_a_panic() {
    let instance = Instance::claimed().await;
    let device = Device::new();
    instance.add(&device).await;
    let saying = instance.saying();
    for hostile in hostile_values() {
        let asked = instance.asked_to_add().await;
        let reply = instance
            .verify_registration(&asked.cookie, hostile.clone())
            .await;
        assert!(is_refused(&reply), "{} {}", reply.status, reply.text);
        let asked = instance.asked_to_prove().await;
        let reply = instance.verify_assertion(&asked.cookie, hostile).await;
        assert!(is_refused(&reply), "{} {}", reply.status, reply.text);
    }
    for attestation in hostile_attestations() {
        let asked = instance.asked_to_add().await;
        let mut response = Device::new().registration(&asked.challenge, &saying);
        response["response"]["attestationObject"] = json!(text(&attestation));
        let reply = instance.verify_registration(&asked.cookie, response).await;
        assert!(is_refused(&reply), "{} {}", reply.status, reply.text);

        let asked = instance.asked_to_prove().await;
        let mut response = device.assertion(&asked.challenge, &saying);
        response["response"]["authenticatorData"] = json!(text(&attestation));
        let reply = instance.verify_assertion(&asked.cookie, response).await;
        assert!(is_refused(&reply), "{} {}", reply.status, reply.text);
    }
    let signed = instance.sign_in_with(&device, 1).await;
    assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
}

fn flip(response: &mut Value, field: &str, at: usize, by: u8) {
    let old = response["response"][field].as_str().unwrap();
    let mut bytes = URL_SAFE_NO_PAD.decode(old).unwrap();
    let at = at % bytes.len();
    bytes[at] ^= by;
    response["response"][field] = json!(text(&bytes));
}

/// Any flipped byte of a signed assertion is refused. Noise in, or a flipped
/// byte of, a registration's attestation never reaches a server error; a flip
/// in its unsigned public key may be accepted, as `none` attestation allows.
#[test]
fn a_flipped_byte_never_passes_or_panics() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let (instance, device) = runtime.block_on(async {
        let instance = Instance::claimed().await;
        let device = Device::new();
        instance.add(&device).await;
        (instance, device)
    });
    let strategy = (
        prop::sample::select(vec!["clientDataJSON", "authenticatorData", "signature"]),
        any::<usize>(),
        1u8..=255,
        prop::collection::vec(any::<u8>(), 0..512),
    );
    let config = ProptestConfig {
        cases: 256,
        failure_persistence: None,
        ..ProptestConfig::default()
    };
    TestRunner::new(config)
        .run(&strategy, |(field, at, by, noise)| {
            runtime.block_on(async {
                let saying = instance.saying();
                let asked = instance.asked_to_prove().await;
                let mut response = device.assertion(&asked.challenge, &saying);
                flip(&mut response, field, at, by);
                let reply = instance.verify_assertion(&asked.cookie, response).await;
                assert!(is_refused(&reply), "{} {}", reply.status, reply.text);

                let asked = instance.asked_to_add().await;
                let mut response = Device::new().registration(&asked.challenge, &saying);
                response["response"]["attestationObject"] = json!(text(&noise));
                let reply = instance.verify_registration(&asked.cookie, response).await;
                assert!(is_refused(&reply), "{} {}", reply.status, reply.text);

                let asked = instance.asked_to_add().await;
                let mut response = Device::new().registration(&asked.challenge, &saying);
                flip(&mut response, "attestationObject", at, by);
                let reply = instance.verify_registration(&asked.cookie, response).await;
                assert!(!reply.status.is_server_error(), "{}", reply.text);
            });
            Ok(())
        })
        .unwrap();
    runtime.block_on(async {
        let signed = instance.sign_in_with(&device, 1).await;
        assert_eq!(signed.status, StatusCode::OK, "{}", signed.text);
    });
}
