//! The page an item's link opens answers from the address alone.

use std::sync::Arc;

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
const PASSWORD: &str = "the first password";

struct Seen {
    status: StatusCode,
    headers: Vec<(String, String)>,
    body: String,
}

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    key: String,
    session: String,
}

async fn call(router: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let response = router.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}

fn json_request(method: Method, path: &str, body: &Value, token: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    request.body(Body::from(body.to_string())).unwrap()
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let settings = Settings::read(Environment::from_pairs(&[
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_KEY_SALT", "a salt for these tests"),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_SIGN_IN_ADDRESS", ORIGIN),
        ]))
        .unwrap();
        let app = App::start(settings).await.unwrap();
        let (public, control) = (public(app.clone()), control(app.clone()));
        let claim = json!({ "username": "owner", "password": PASSWORD });
        let (status, ..) = call(
            &control,
            json_request(Method::POST, "/_control/setup/claim", &claim, None),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let grants = json!({
            "label": "writer",
            "source": "writer",
            "permissions": ["items.purge"],
            "type_permissions": { "*": "write" },
        });
        let (status, _, text) =
            call(&control, json_request(Method::POST, "/keys", &grants, None)).await;
        assert_eq!(status, StatusCode::CREATED, "{text}");
        let key = serde_json::from_str::<Value>(&text).unwrap()["key"]
            .as_str()
            .unwrap()
            .to_string();
        let signing = json!({ "username": "owner", "password": PASSWORD });
        let (status, headers, text) = call(
            &public,
            json_request(Method::POST, "/auth/sign-in", &signing, None),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let session = headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        Instance {
            _dir: dir,
            app,
            public,
            key,
            session,
        }
    }

    async fn write(&self, method: Method, path: &str, body: Value) -> Value {
        let request = json_request(method, path, &body, Some(&self.key));
        let (status, _, text) = call(&self.public, request).await;
        assert!(status.is_success(), "{path}: {status} {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn note(&self) -> String {
        let made = self
            .write(
                Method::POST,
                "/items",
                json!({ "type": "core.note", "properties": { "body": "a note" } }),
            )
            .await;
        made["item"]["id"].as_str().unwrap().to_string()
    }

    /// The answer to `request`, with what differs between any two answers masked:
    /// the id, the nonce, the request id and the date.
    async fn seen(&self, id: &str, request: Request<Body>) -> Seen {
        let (status, headers, body) = call(&self.public, request).await;
        let mask = |text: &str| {
            let mut masked = text.replace(id, "<id>");
            while let Some(at) = masked.find("nonce-") {
                masked.replace_range(at..at + "nonce-".len() + 32, "NONCE");
            }
            while let Some(at) = masked.find("nonce=\"") {
                masked.replace_range(at..at + "nonce=\"".len() + 32, "NONCE=\"");
            }
            masked
        };
        let mut headers: Vec<_> = headers
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), "date" | "x-request-id"))
            .map(|(name, value)| (name.to_string(), mask(value.to_str().unwrap())))
            .collect();
        headers.sort();
        Seen {
            status,
            headers,
            body: mask(&body),
        }
    }
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().uri(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn every_well_formed_id_gets_one_page_whatever_became_of_the_item() {
    let instance = Instance::start().await;
    let existing = instance.note().await;
    let trashed = instance.note().await;
    let purged = instance.note().await;
    for id in [&trashed, &purged] {
        instance
            .write(Method::DELETE, &format!("/items/{id}"), json!({}))
            .await;
    }
    instance
        .write(Method::POST, &format!("/items/{purged}/purge"), json!({}))
        .await;
    let never = "01a1ff7f-a1a5-7568-9989-53778f0e85d2".to_string();

    // The witness: the three items that were made are told apart by the item door.
    let read = |id: &str, state: &str| {
        let request = Request::builder()
            .uri(format!("/items/{id}?state={state}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", instance.key))
            .body(Body::empty())
            .unwrap();
        let public = instance.public.clone();
        async move { call(&public, request).await.0 }
    };
    assert_eq!(read(&existing, "active").await, StatusCode::OK);
    assert_eq!(read(&trashed, "trashed").await, StatusCode::OK);
    assert_eq!(read(&purged, "any").await, StatusCode::NOT_FOUND);
    assert_eq!(read(&never, "any").await, StatusCode::NOT_FOUND);

    let session = instance.session.as_str();
    let mut answers = Vec::new();
    for id in [&existing, &trashed, &purged, &never] {
        for cookie in [None, Some(session)] {
            let path = format!("/i/{id}");
            answers.push(instance.seen(id, get(&path, cookie)).await);
        }
    }
    let first = &answers[0];
    assert_eq!(first.status, StatusCode::OK);
    assert!(
        first
            .body
            .contains(&format!("marfa://{}/<id>", instance.app.instance_id))
    );
    for answer in &answers {
        assert_eq!(answer.status, first.status);
        assert_eq!(answer.headers, first.headers);
        assert_eq!(answer.body, first.body);
    }
    let names: Vec<_> = first
        .headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert!(!names.contains(&"set-cookie"));
}

#[tokio::test]
async fn a_head_a_json_request_and_a_query_get_the_same_page() {
    let instance = Instance::start().await;
    let id = instance.note().await;
    let path = format!("/i/{id}");
    let plain = instance.seen(&id, get(&path, None)).await;
    let queried = instance
        .seen(&id, get(&format!("{path}?next=%3Cb%3E&id={id}"), None))
        .await;
    assert_eq!(queried.headers, plain.headers);
    assert_eq!(queried.body, plain.body);
    let asked = |accept: &str| {
        Request::builder()
            .uri(&path)
            .header(header::ACCEPT, accept.to_string())
            .body(Body::empty())
            .unwrap()
    };
    let json = instance.seen(&id, asked("application/json")).await;
    assert_eq!(json.headers, plain.headers);
    assert_eq!(json.body, plain.body);
    let head = Request::builder()
        .method(Method::HEAD)
        .uri(&path)
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = call(&instance.public, head).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_empty());
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers["x-robots-tag"], "noindex");
}

#[tokio::test]
async fn text_that_is_not_an_id_gets_a_404_page_that_repeats_none_of_it() {
    let instance = Instance::start().await;
    let id = instance.note().await;
    let upper = id.to_uppercase();
    let encoded: String = id.chars().map(|c| format!("%{:02x}", c as u32)).collect();
    let long = "a".repeat(5000);
    let malformed = [
        "/i/".to_string(),
        "/i/not-an-id".to_string(),
        format!("/i/{upper}"),
        format!("/i/{id}/"),
        format!("/i/{id}/more"),
        format!("/i/{encoded}"),
        format!("/i/{id}%20"),
        format!("/i/{long}"),
        "/i/%3Cscript%3Ealert(1)%3C/script%3E".to_string(),
    ];
    let reference = instance.seen("@no-id@", get("/i/not-an-id", None)).await;
    assert_eq!(reference.status, StatusCode::NOT_FOUND);
    assert!(reference.body.contains("This is not a Marfa link"));
    for path in &malformed {
        let seen = instance.seen("@no-id@", get(path, None)).await;
        assert_eq!(seen.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(seen.headers, reference.headers, "{path}");
        assert_eq!(seen.body, reference.body, "{path}");
    }
    let header_names: Vec<_> = reference.headers.iter().map(|(n, _)| n.as_str()).collect();
    assert!(header_names.contains(&"x-robots-tag"));
    assert!(!reference.body.contains("marfa://"));
}
