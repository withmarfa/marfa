use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";
const PROCESS: &str = "worker";

struct Reply {
    status: StatusCode,
    body: Value,
}

async fn send(router: &Router, request: Request<Body>) -> Reply {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

fn request(method: Method, path: &str, token: Option<&str>, body: Option<&Value>) -> Request<Body> {
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

struct Instance {
    dir: TempDir,
    public: Router,
    control: Router,
}

struct Connector {
    id: String,
    token: String,
    item: String,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
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
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        Instance {
            dir,
            public: public(app.clone()),
            control: control(app),
        }
    }

    async fn local(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        send(&self.control, request(method, path, None, body.as_ref())).await
    }

    async fn call(&self, c: &Connector, method: Method, path: &str, body: Option<Value>) -> Reply {
        let path = path.replace("{id}", &c.id);
        let asked = request(method, &path, Some(&c.token), body.as_ref());
        send(&self.public, asked).await
    }

    /// A registered connector that holds, has a run, a state and an agreement.
    async fn connector(&self) -> Connector {
        let key = json!({
            "label": "feed", "source": "feed", "permissions": [],
            "type_permissions": { "*": "write" },
        });
        let minted = self.local(Method::POST, "/keys", Some(key)).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        let token = minted.body["key"].as_str().unwrap().to_string();
        let item = self.note(&token).await;
        let mut connector = Connector {
            id: String::new(),
            token,
            item,
        };
        let name = json!({ "name": "feed" });
        let registered = self
            .call_bare(&connector, Method::POST, "/connectors", name)
            .await;
        assert_eq!(
            registered.status,
            StatusCode::CREATED,
            "{}",
            registered.body
        );
        connector.id = registered.body["id"].as_str().unwrap().to_string();
        let held = json!({ "process": PROCESS });
        self.landed(&connector, Method::POST, "/connectors/{id}/hold", held)
            .await;
        let run = json!({
            "outcome": "succeeded",
            "started_at": "2026-01-01T00:00:00Z",
            "finished_at": "2026-01-01T00:00:01Z",
        });
        self.landed(&connector, Method::POST, "/connectors/runs", run)
            .await;
        let state = json!({ "process": PROCESS, "state": { "cursor": 1 } });
        self.landed(&connector, Method::PUT, "/connectors/{id}/state", state)
            .await;
        let agreement = json!({
            "process": PROCESS,
            "set": [{ "item_id": connector.item, "waiting": false, "record": { "etag": "a" } }],
        });
        self.landed(
            &connector,
            Method::POST,
            "/connectors/{id}/agreements",
            agreement,
        )
        .await;
        self.landed(&connector, Method::POST, "/connectors/heartbeat", json!({}))
            .await;
        connector
    }

    async fn note(&self, token: &str) -> String {
        let body = json!({ "type": "core.note", "properties": { "body": "a note" } });
        let made = send(
            &self.public,
            request(Method::POST, "/items", Some(token), Some(&body)),
        )
        .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn call_bare(&self, c: &Connector, method: Method, path: &str, body: Value) -> Reply {
        send(
            &self.public,
            request(method, path, Some(&c.token), Some(&body)),
        )
        .await
    }

    async fn landed(&self, c: &Connector, method: Method, path: &str, body: Value) {
        let reply = self.call(c, method, path, Some(body)).await;
        assert!(
            matches!(reply.status, StatusCode::OK | StatusCode::CREATED),
            "{path}: {}",
            reply.body
        );
    }

    fn db(&self) -> Connection {
        Connection::open(self.dir.path().join("marfa.db")).unwrap()
    }
}

/// Each stored time has a working request as its witness.
fn doors(c: &Connector) -> Vec<(&'static str, &'static str, Method, String, Option<Value>)> {
    let state = json!({ "process": PROCESS, "state": { "cursor": 2 } });
    let lookup = json!({ "item_ids": [c.item] });
    vec![
        (
            "connectors",
            "registered_at",
            Method::GET,
            "/connectors/{id}".into(),
            None,
        ),
        (
            "connectors",
            "updated_at",
            Method::GET,
            "/connectors/{id}".into(),
            None,
        ),
        (
            "connectors",
            "last_heartbeat_at",
            Method::GET,
            "/connectors/{id}".into(),
            None,
        ),
        (
            "connector_runs",
            "reported_at",
            Method::GET,
            "/connectors/{id}/runs".into(),
            None,
        ),
        (
            "connector_runs",
            "started_at",
            Method::GET,
            "/connectors/{id}".into(),
            None,
        ),
        (
            "connector_runs",
            "finished_at",
            Method::GET,
            "/connectors/{id}/runs".into(),
            None,
        ),
        (
            "connector_states",
            "updated_at",
            Method::GET,
            "/connectors/{id}/state".into(),
            None,
        ),
        (
            "connector_agreements",
            "updated_at",
            Method::GET,
            "/connectors/{id}/agreements".into(),
            None,
        ),
        (
            "connector_agreements",
            "updated_at",
            Method::POST,
            "/connectors/{id}/agreements/lookup".into(),
            Some(lookup),
        ),
        (
            "connector_holds",
            "expires_at",
            Method::PUT,
            "/connectors/{id}/state".into(),
            Some(state),
        ),
        (
            "connector_holds",
            "expires_at",
            Method::POST,
            "/connectors/{id}/hold".into(),
            Some(json!({ "process": PROCESS })),
        ),
        (
            "connector_holds",
            "expires_at",
            Method::GET,
            "/connectors/{id}".into(),
            None,
        ),
    ]
}

#[tokio::test]
async fn a_stored_time_that_does_not_read_is_refused_and_never_served() {
    let instance = Instance::start().await;
    let connector = instance.connector().await;
    for (table, column, method, path, body) in doors(&connector) {
        let label = format!("{table}.{column} at {method} {path}");
        let witness = instance
            .call(&connector, method.clone(), &path, body.clone())
            .await;
        assert_eq!(witness.status, StatusCode::OK, "{label}: {}", witness.body);
        let held: String = instance
            .db()
            .query_row(&format!("SELECT {column} FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        for unreadable in ["not-a-time", "9999-99-99"] {
            instance
                .db()
                .execute(&format!("UPDATE {table} SET {column} = ?1"), [unreadable])
                .unwrap();
            let refused = instance
                .call(&connector, method.clone(), &path, body.clone())
                .await;
            assert_eq!(
                refused.status,
                StatusCode::INTERNAL_SERVER_ERROR,
                "{label} ({unreadable}): {}",
                refused.body
            );
        }
        instance
            .db()
            .execute(&format!("UPDATE {table} SET {column} = ?1"), [&held])
            .unwrap();
    }
}

#[tokio::test]
async fn a_state_write_under_a_hold_whose_stored_expiry_does_not_read_commits_nothing() {
    let instance = Instance::start().await;
    let connector = instance.connector().await;
    instance
        .db()
        .execute("UPDATE connector_holds SET expires_at = 'not-a-time'", [])
        .unwrap();
    let state = json!({ "process": PROCESS, "state": { "cursor": 9 } });
    let refused = instance
        .call(
            &connector,
            Method::PUT,
            "/connectors/{id}/state",
            Some(state),
        )
        .await;
    assert_ne!(refused.status, StatusCode::OK, "{}", refused.body);
    let stored: String = instance
        .db()
        .query_row("SELECT state FROM connector_states", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, r#"{"cursor":1}"#);
}

#[tokio::test]
async fn a_read_only_generation_that_is_not_an_integer_cannot_be_stored_and_an_absent_one_is_zero()
{
    let instance = Instance::start().await;
    let connector = instance.connector().await;
    let path = format!("/items/{}", connector.item);
    let asked = request(Method::GET, &path, Some(&connector.token), None);
    instance
        .db()
        .execute("DELETE FROM read_only_generation", [])
        .unwrap();
    let absent = send(&instance.public, asked).await;
    assert_eq!(absent.status, StatusCode::OK, "{}", absent.body);

    let db = instance.db();
    db.execute(
        "INSERT INTO read_only_generation (id, value) VALUES (1, 7)",
        [],
    )
    .unwrap();
    for bad in ["'x'", "'7.5'", "7.5", "NULL"] {
        let sql = format!("UPDATE read_only_generation SET value = {bad}");
        assert!(db.execute(&sql, []).is_err(), "{bad} was stored");
    }
    let kept: i64 = db
        .query_row("SELECT value FROM read_only_generation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(kept, 7);

    let key = json!({ "label": "other", "source": "other", "permissions": [] });
    let minted = instance.local(Method::POST, "/keys", Some(key)).await;
    assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
    let other = Connector {
        id: String::new(),
        token: minted.body["key"].as_str().unwrap().to_string(),
        item: String::new(),
    };
    let registered = instance
        .call_bare(
            &other,
            Method::POST,
            "/connectors",
            json!({ "name": "other" }),
        )
        .await;
    assert_eq!(
        registered.status,
        StatusCode::CREATED,
        "{}",
        registered.body
    );
    let raised: i64 = db
        .query_row("SELECT value FROM read_only_generation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(raised > 7, "{raised}");
}

#[tokio::test]
async fn a_run_time_is_strict_rfc_3339() {
    let instance = Instance::start().await;
    let connector = instance.connector().await;
    for (started, finished) in [
        ("2026", "2026-01-01T00:00:01Z"),
        ("2026-01-01T00:00:00Z", "2026-01-01T00:00:01"),
        ("2026-01-01T00:00:00Z", "2026-01-01T24:00:00Z"),
        ("2026-01-01T00:00Z", "2026-01-01T00:00:01Z"),
        ("2026-01-01T00:00:00Z", "2026-01-01"),
    ] {
        let run = json!({ "outcome": "failed", "started_at": started, "finished_at": finished });
        let refused = instance
            .call(&connector, Method::POST, "/connectors/runs", Some(run))
            .await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{started} {finished}: {}",
            refused.body
        );
        assert_eq!(refused.body["error"]["code"], "validation_error");
    }
    let run = json!({
        "outcome": "succeeded",
        "started_at": "2026-01-01T01:00:00+01:00",
        "finished_at": "2026-01-01T00:00:00.5Z",
    });
    let kept = instance
        .call(&connector, Method::POST, "/connectors/runs", Some(run))
        .await;
    assert_eq!(kept.status, StatusCode::CREATED, "{}", kept.body);
    assert_eq!(kept.body["started_at"], "2026-01-01T00:00:00.000Z");
}

#[tokio::test]
async fn an_owner_session_cookie_reaches_no_connector_door_and_the_private_socket_does() {
    let instance = Instance::start().await;
    let connector = instance.connector().await;
    let claim = json!({ "email": "owner@example.test", "password": "the first password" });
    let claimed = instance
        .local(Method::POST, "/_control/setup/claim", Some(claim.clone()))
        .await;
    assert_eq!(claimed.status, StatusCode::CREATED);
    let mut signing_in = request(Method::POST, "/auth/sign-in", None, Some(&claim));
    signing_in
        .headers_mut()
        .insert(header::ORIGIN, ORIGIN.parse().unwrap());
    let response = instance.public.clone().oneshot(signing_in).await.unwrap();
    let line = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    let cookie = line.split(';').next().unwrap().to_string();

    let path = format!("/connectors/{}", connector.id);
    for (method, path, body) in [
        (Method::GET, "/connectors".to_string(), None),
        (Method::GET, path.clone(), None),
        (Method::DELETE, path.clone(), None),
        (
            Method::POST,
            "/connectors".to_string(),
            Some(json!({ "name": "x" })),
        ),
        (Method::DELETE, format!("{path}/state"), None),
        (Method::GET, format!("{path}/runs"), None),
    ] {
        for origin in [true, false] {
            let mut asked = request(method.clone(), &path, None, body.as_ref());
            asked
                .headers_mut()
                .insert(header::COOKIE, cookie.parse().unwrap());
            if origin {
                asked
                    .headers_mut()
                    .insert(header::ORIGIN, ORIGIN.parse().unwrap());
            }
            let refused = send(&instance.public, asked).await;
            assert_eq!(
                refused.status,
                StatusCode::UNAUTHORIZED,
                "{method} {path}: {}",
                refused.body
            );
        }
    }
    let listed = instance.local(Method::GET, "/connectors", None).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let registered = instance
        .local(Method::POST, "/connectors", Some(json!({ "name": "x" })))
        .await;
    assert_eq!(
        registered.status,
        StatusCode::FORBIDDEN,
        "{}",
        registered.body
    );
    let witness = instance
        .call(&connector, Method::GET, "/connectors/{id}", None)
        .await;
    assert_eq!(witness.status, StatusCode::OK);
}
