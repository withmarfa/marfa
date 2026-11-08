use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::public;
use marfa_server::settings::{Environment, Settings};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

const PAGE: &str = "https://page.example";
const STRANGER: &str = "https://stranger.example";

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn start() -> (TempDir, Router) {
    let dir = TempDir::new().unwrap();
    let (database, blobs) = (dir.path().join("marfa.db"), dir.path().join("blobs"));
    let socket = dir.path().join("s.sock");
    let settings = Settings::read(Environment::from_pairs(&[
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("CORS_ORIGINS", PAGE),
    ]))
    .unwrap();
    let app = App::start(settings).await.unwrap();
    (dir, public(app))
}

async fn send(router: &Router, method: Method, path: &str, headers: &[(&str, &str)]) -> Reply {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply {
        status,
        headers,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

fn allowed_origin(reply: &Reply) -> Option<&str> {
    reply
        .headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|value| value.to_str().ok())
}

fn preflight(origin: &str) -> [(&'static str, &str); 3] {
    [
        ("origin", origin),
        ("access-control-request-method", "POST"),
        (
            "access-control-request-headers",
            "authorization, content-type, idempotency-key, x-marfa-instance-id",
        ),
    ]
}

#[tokio::test]
async fn a_data_door_answers_a_preflight_from_an_allowed_origin() {
    let (_dir, router) = start().await;
    let reply = send(&router, Method::OPTIONS, "/items", &preflight(PAGE)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(allowed_origin(&reply), Some(PAGE));
    let methods = reply.headers[header::ACCESS_CONTROL_ALLOW_METHODS]
        .to_str()
        .unwrap();
    assert!(
        methods.contains("POST") && methods.contains("PATCH"),
        "{methods}"
    );
    assert_eq!(
        reply.headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "authorization, content-type, idempotency-key, x-marfa-instance-id"
    );
    assert!(
        !reply
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
    );
}

#[tokio::test]
async fn a_preflight_from_any_other_origin_is_refused() {
    let (_dir, router) = start().await;
    for origin in [STRANGER, "null"] {
        let reply = send(&router, Method::OPTIONS, "/items", &preflight(origin)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{origin}");
        assert_eq!(reply.body["error"]["code"], "not_found");
        assert_eq!(allowed_origin(&reply), None, "{origin}");
    }
    let bare = send(&router, Method::OPTIONS, "/items", &[]).await;
    assert_eq!(bare.status, StatusCode::NOT_FOUND);
    let nowhere = send(&router, Method::OPTIONS, "/nowhere", &preflight(STRANGER)).await;
    assert_eq!(nowhere.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_page_reads_the_headers_a_client_needs_and_a_stranger_reads_none() {
    let (_dir, router) = start().await;
    let allowed = send(&router, Method::GET, "/health", &[("origin", PAGE)]).await;
    assert_eq!(allowed_origin(&allowed), Some(PAGE));
    let exposed = allowed.headers[header::ACCESS_CONTROL_EXPOSE_HEADERS]
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    for needed in [
        "x-marfa-contract",
        "x-request-id",
        "retry-after",
        "etag",
        "idempotency-replayed",
    ] {
        assert!(exposed.contains(needed), "{needed} in {exposed}");
    }
    assert!(
        !exposed.contains("description"),
        "a schema member, not a header: {exposed}"
    );
    assert!(
        !allowed
            .headers
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
    );

    let refused = send(&router, Method::GET, "/health", &[("origin", STRANGER)]).await;
    assert_eq!(refused.status, StatusCode::OK);
    assert_eq!(allowed_origin(&refused), None);
    assert!(
        !refused
            .headers
            .contains_key(header::ACCESS_CONTROL_EXPOSE_HEADERS)
    );
}
