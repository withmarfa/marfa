use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:8600";
const OTHER: &str = "019537a0-7b80-7000-8000-0000000000ff";
const STALE: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const ITEM: &str = "019537a0-7b80-7000-8000-000000000001";

struct Reply {
    status: StatusCode,
    code: String,
    body: Value,
}

struct Instance {
    _dir: TempDir,
    public: Router,
    control: Router,
    own: String,
    key: String,
    cookie: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Presents {
    Key,
    Cookie,
    /// A cookie with no `Origin` of its own; a test may add one.
    BareCookie,
    Nothing,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
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
            ("RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        let (public, control) = (public(app.clone()), control(app));
        let mut instance = Instance {
            _dir: dir,
            public,
            control,
            own: String::new(),
            key: String::new(),
            cookie: String::new(),
        };
        let root = instance
            .call(
                &instance.public,
                Method::GET,
                "/",
                Presents::Nothing,
                &[],
                None,
            )
            .await;
        instance.own = root.body["instance_id"].as_str().unwrap().to_owned();
        let key = json!({
            "label": "feed", "source": "feed", "permissions": [],
            "type_permissions": { "*": "write" },
        });
        let minted = instance
            .call(
                &instance.control,
                Method::POST,
                "/keys",
                Presents::Nothing,
                &[],
                Some(key),
            )
            .await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.body);
        instance.key = minted.body["key"].as_str().unwrap().to_owned();
        let claim = json!({ "email": "owner@example.test", "password": "the first password" });
        let claimed = instance
            .call(
                &instance.control,
                Method::POST,
                "/_control/setup/claim",
                Presents::Nothing,
                &[],
                Some(claim.clone()),
            )
            .await;
        assert_eq!(claimed.status, StatusCode::CREATED, "{}", claimed.body);
        let signing_in = Request::builder()
            .method(Method::POST)
            .uri("/auth/sign-in/email")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, ORIGIN)
            .body(Body::from(claim.to_string()))
            .unwrap();
        let response = instance.public.clone().oneshot(signing_in).await.unwrap();
        let line = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        instance.cookie = line.split(';').next().unwrap().to_owned();
        instance
    }

    async fn call(
        &self,
        router: &Router,
        method: Method,
        path: &str,
        presents: Presents,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        match presents {
            Presents::Key => {
                request = request.header(header::AUTHORIZATION, format!("Bearer {}", self.key));
            }
            Presents::Cookie => {
                request = request
                    .header(header::COOKIE, &self.cookie)
                    .header(header::ORIGIN, ORIGIN);
            }
            Presents::BareCookie => {
                request = request.header(header::COOKIE, &self.cookie);
            }
            Presents::Nothing => {}
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let code = body["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        Reply { status, code, body }
    }

    async fn on_socket(
        &self,
        method: Method,
        path: &str,
        presents: Presents,
        instance: Option<&str>,
        body: Option<Value>,
    ) -> Reply {
        let named: Vec<(&str, &str)> = instance
            .map(|id| ("x-marfa-instance-id", id))
            .into_iter()
            .collect();
        self.call(&self.control, method, path, presents, &named, body)
            .await
    }

    async fn on_public(
        &self,
        method: Method,
        path: &str,
        presents: Presents,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Reply {
        self.call(&self.public, method, path, presents, headers, body)
            .await
    }
}

fn note() -> Value {
    json!({ "type": "core.note", "source": "feed", "properties": { "body": "kept" } })
}

fn assert_refused(reply: &Reply, status: StatusCode, code: &str, what: &str) {
    assert_eq!(
        (reply.status, reply.code.as_str()),
        (status, code),
        "{what}: {}",
        reply.body
    );
}

#[tokio::test]
async fn the_private_socket_judges_the_header_of_a_write_that_presents_a_key() {
    let instance = Instance::start().await;
    for (method, path, body) in [
        (Method::POST, "/items", note()),
        (Method::POST, "/connectors", json!({ "name": "feed" })),
    ] {
        let what = format!("{method} {path} on the socket");
        let other = instance
            .on_socket(
                method.clone(),
                path,
                Presents::Key,
                Some(OTHER),
                Some(body.clone()),
            )
            .await;
        assert_refused(&other, StatusCode::CONFLICT, "instance_changed", &what);
        let malformed = instance
            .on_socket(
                method.clone(),
                path,
                Presents::Key,
                Some("not-an-instance"),
                Some(body.clone()),
            )
            .await;
        assert_refused(
            &malformed,
            StatusCode::BAD_REQUEST,
            "validation_error",
            &what,
        );
    }
    let own = instance
        .on_socket(
            Method::POST,
            "/items",
            Presents::Key,
            Some(&instance.own),
            Some(note()),
        )
        .await;
    assert_eq!(own.status, StatusCode::CREATED, "the witness: {}", own.body);
    let local = instance
        .on_socket(
            Method::POST,
            "/connectors",
            Presents::Nothing,
            Some(OTHER),
            Some(json!({ "name": "feed" })),
        )
        .await;
    assert_refused(
        &local,
        StatusCode::CONFLICT,
        "instance_changed",
        "no credential",
    );
}

#[tokio::test]
async fn a_cookie_is_no_credential_at_a_door_that_ignores_cookies() {
    let instance = Instance::start().await;
    let deep = (0..70).fold(json!("x"), |inner, _| json!([inner]));
    for (path, body) in [
        ("/items", note()),
        ("/connectors", json!({ "name": "feed" })),
    ] {
        for named in [
            Some(OTHER),
            Some("not-an-instance"),
            Some(instance.own.as_str()),
            None,
        ] {
            let headers: Vec<(&str, &str)> = named
                .map(|id| ("x-marfa-instance-id", id))
                .into_iter()
                .collect();
            let reply = instance
                .on_public(
                    Method::POST,
                    path,
                    Presents::Cookie,
                    &headers,
                    Some(body.clone()),
                )
                .await;
            assert_refused(
                &reply,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                &format!("cookie only, POST {path} naming {named:?}"),
            );
        }
        let nested = instance
            .on_public(
                Method::POST,
                path,
                Presents::Cookie,
                &[("x-marfa-instance-id", OTHER)],
                Some(json!({ "type": "core.note", "properties": { "deep": deep } })),
            )
            .await;
        assert_refused(
            &nested,
            StatusCode::BAD_REQUEST,
            "validation_error",
            &format!("cookie only, POST {path} with a body too deep"),
        );
        let with_key = instance
            .on_public(
                Method::POST,
                path,
                Presents::Key,
                &[("x-marfa-instance-id", OTHER)],
                Some(body),
            )
            .await;
        assert_refused(
            &with_key,
            StatusCode::CONFLICT,
            "instance_changed",
            &format!("the witness: a key at POST {path}"),
        );
    }
    let owner_door = instance
        .on_public(
            Method::PATCH,
            "/owner/passkeys/no-such-passkey",
            Presents::Cookie,
            &[("x-marfa-instance-id", OTHER)],
            Some(json!({ "name": "kept" })),
        )
        .await;
    assert_refused(
        &owner_door,
        StatusCode::CONFLICT,
        "instance_changed",
        "the witness: a cookie at a door that takes it",
    );
}

#[tokio::test]
async fn a_cookie_is_no_credential_at_a_folder_door_whatever_instance_it_names() {
    let instance = Instance::start().await;
    let folder = format!("/folders/{ITEM}");
    for (method, path, body) in [
        (
            Method::POST,
            "/folders".to_string(),
            json!({ "title": "Inbox" }),
        ),
        (
            Method::PATCH,
            folder.clone(),
            json!({ "title": "Inbox", "version": 1 }),
        ),
        (Method::POST, format!("{folder}/revoke"), json!({})),
        (Method::PUT, format!("{folder}/status"), json!({})),
    ] {
        for named in [Some(OTHER), Some("not-an-instance"), None] {
            let headers: Vec<(&str, &str)> = named
                .map(|id| ("x-marfa-instance-id", id))
                .into_iter()
                .collect();
            let reply = instance
                .on_public(
                    method.clone(),
                    &path,
                    Presents::Cookie,
                    &headers,
                    Some(body.clone()),
                )
                .await;
            assert_refused(
                &reply,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                &format!("cookie only, {method} {path} naming {named:?}"),
            );
        }
        let with_key = instance
            .on_public(
                method.clone(),
                &path,
                Presents::Key,
                &[("x-marfa-instance-id", OTHER)],
                Some(body.clone()),
            )
            .await;
        assert_refused(
            &with_key,
            StatusCode::CONFLICT,
            "instance_changed",
            &format!("the witness: a key at {method} {path}"),
        );
    }
}

#[tokio::test]
async fn another_instance_is_refused_before_a_conditional_read_judges_its_reach() {
    let instance = Instance::start().await;
    let read = json!({ "ids": [ITEM] });
    for reach in ["not-a-reach", STALE] {
        let reply = instance
            .on_public(
                Method::POST,
                "/items/bulk-get",
                Presents::Key,
                &[("x-marfa-instance-id", OTHER), ("x-marfa-reach", reach)],
                Some(read.clone()),
            )
            .await;
        assert_refused(
            &reply,
            StatusCode::CONFLICT,
            "instance_changed",
            &format!("reach {reach}"),
        );
        let on_socket = instance
            .call(
                &instance.control,
                Method::POST,
                "/items/bulk-get",
                Presents::Key,
                &[("x-marfa-instance-id", OTHER), ("x-marfa-reach", reach)],
                Some(read.clone()),
            )
            .await;
        assert_refused(
            &on_socket,
            StatusCode::CONFLICT,
            "instance_changed",
            &format!("reach {reach} on the socket"),
        );
    }
    let witness = instance
        .on_public(
            Method::POST,
            "/items/bulk-get",
            Presents::Key,
            &[
                ("x-marfa-instance-id", instance.own.as_str()),
                ("x-marfa-reach", "not-a-reach"),
            ],
            Some(read),
        )
        .await;
    assert_refused(
        &witness,
        StatusCode::BAD_REQUEST,
        "validation_error",
        "the witness: this instance and a malformed reach",
    );
}

#[tokio::test]
async fn a_method_no_door_serves_is_not_found_whatever_instance_it_names() {
    let instance = Instance::start().await;
    let metadata = format!("/items/{ITEM}/metadata");
    for (method, path) in [
        (Method::POST, "/health"),
        (Method::PATCH, metadata.as_str()),
        (Method::DELETE, "/"),
    ] {
        for named in [OTHER, "not-an-instance", instance.own.as_str()] {
            for presents in [Presents::Key, Presents::Nothing] {
                let reply = instance
                    .on_public(
                        method.clone(),
                        path,
                        presents,
                        &[("x-marfa-instance-id", named)],
                        Some(json!({})),
                    )
                    .await;
                assert_refused(
                    &reply,
                    StatusCode::NOT_FOUND,
                    "not_found",
                    &format!("{method} {path} naming {named}"),
                );
            }
        }
    }
    let served = instance
        .on_public(
            Method::PUT,
            &metadata,
            Presents::Key,
            &[("x-marfa-instance-id", OTHER)],
            Some(json!({})),
        )
        .await;
    assert_refused(
        &served,
        StatusCode::CONFLICT,
        "instance_changed",
        "the witness: a method the path serves",
    );
}

#[tokio::test]
async fn a_cookie_with_a_missing_or_foreign_origin_is_no_credential_at_a_folder_write() {
    let instance = Instance::start().await;
    let folder = format!("/folders/{ITEM}");
    for (method, path, body) in [
        (
            Method::POST,
            "/folders".to_string(),
            json!({ "title": "Inbox" }),
        ),
        (
            Method::PATCH,
            folder.clone(),
            json!({ "title": "Inbox", "version": 1 }),
        ),
        (Method::POST, format!("{folder}/revoke"), json!({})),
    ] {
        for origin in [None, Some("https://elsewhere.example")] {
            let headers: Vec<(&str, &str)> = origin.map(|o| ("origin", o)).into_iter().collect();
            let reply = instance
                .on_public(
                    method.clone(),
                    &path,
                    Presents::BareCookie,
                    &headers,
                    Some(body.clone()),
                )
                .await;
            assert_refused(
                &reply,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                &format!("cookie with origin {origin:?}, {method} {path}"),
            );
        }
    }
}
