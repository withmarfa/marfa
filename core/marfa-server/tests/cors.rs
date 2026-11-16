use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::public;
use marfa_server::settings::{Environment, Settings};
use serde_json::Value;
use std::sync::Arc;
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
    let (dir, router, _) = start_with_app().await;
    (dir, router)
}

async fn start_with_app() -> (TempDir, Router, Arc<App>) {
    let dir = TempDir::new().unwrap();
    let (database, blobs) = (dir.path().join("marfa.db"), dir.path().join("blobs"));
    let socket = dir.path().join("s.sock");
    let settings = Settings::read(Environment::from_pairs(&[
        ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
        ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_CORS_ORIGINS", PAGE),
    ]))
    .unwrap();
    let app = App::start(settings).await.unwrap();
    (dir, public(app.clone()), app)
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
    assert_eq!(
        reply.headers[header::ACCESS_CONTROL_ALLOW_METHODS],
        "GET, HEAD, POST"
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

fn varies(reply: &Reply) -> Vec<String> {
    reply
        .headers
        .get_all(header::VARY)
        .iter()
        .flat_map(|value| value.to_str().unwrap().split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .collect()
}

fn preflight_for<'a>(origin: &'a str, method: &'a str) -> [(&'static str, &'a str); 3] {
    [
        ("origin", origin),
        ("access-control-request-method", method),
        ("access-control-request-headers", "authorization"),
    ]
}

fn named_origins(app: &App, origins: &[&str]) {
    let listed = serde_json::to_string(origins).unwrap();
    app.settings
        .apply_stored(&[("cors_origins".to_string(), listed)]);
}

#[tokio::test]
async fn a_preflight_names_the_methods_the_path_takes_and_no_others() {
    let (_dir, router) = start().await;
    let items = send(
        &router,
        Method::OPTIONS,
        "/items",
        &preflight_for(PAGE, "POST"),
    )
    .await;
    assert_eq!(items.status, StatusCode::NO_CONTENT);
    let methods = |reply: &Reply| {
        let mut named: Vec<String> = reply.headers[header::ACCESS_CONTROL_ALLOW_METHODS]
            .to_str()
            .unwrap()
            .split(',')
            .map(|name| name.trim().to_string())
            .collect();
        named.sort();
        named
    };
    assert_eq!(methods(&items), ["GET", "HEAD", "POST"]);

    let one = send(
        &router,
        Method::OPTIONS,
        "/items/abc",
        &preflight_for(PAGE, "PATCH"),
    )
    .await;
    assert_eq!(one.status, StatusCode::NO_CONTENT);
    assert_eq!(methods(&one), ["DELETE", "GET", "HEAD", "PATCH"]);
}

#[tokio::test]
async fn a_preflight_for_what_no_operation_takes_is_refused() {
    let (_dir, router) = start().await;
    // The witness: the same origin and path, asking for a method the path takes.
    let taken = send(
        &router,
        Method::OPTIONS,
        "/health",
        &preflight_for(PAGE, "GET"),
    )
    .await;
    assert_eq!(allowed_origin(&taken), Some(PAGE));
    for (path, method) in [
        ("/health", "DELETE"),
        ("/items", "PUT"),
        ("/items", "OPTIONS"),
        ("/items", "get"),
        ("/items", "TRACE"),
        ("/nowhere", "GET"),
    ] {
        let reply = send(&router, Method::OPTIONS, path, &preflight_for(PAGE, method)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{method} {path}");
        assert_eq!(reply.body["error"]["code"], "not_found", "{method} {path}");
        assert_eq!(allowed_origin(&reply), None, "{method} {path}");
        assert!(varies(&reply).contains(&"origin".to_string()));
    }
}

#[tokio::test]
async fn a_preflight_naming_a_header_that_is_no_header_is_refused() {
    let (_dir, router) = start().await;
    let asked = |headers: &'static str| {
        [
            ("origin", PAGE),
            ("access-control-request-method", "POST"),
            ("access-control-request-headers", headers),
        ]
    };
    let witness = send(
        &router,
        Method::OPTIONS,
        "/items",
        &asked("authorization, x-custom"),
    )
    .await;
    assert_eq!(witness.status, StatusCode::NO_CONTENT);
    assert_eq!(
        witness.headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "authorization, x-custom"
    );
    for junk in ["authorization,, x-custom", "bad header", "a;b", ","] {
        let reply = send(&router, Method::OPTIONS, "/items", &asked(junk)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{junk}");
        assert_eq!(allowed_origin(&reply), None, "{junk}");
    }
}

#[tokio::test]
async fn an_origin_written_other_than_as_a_browser_serializes_it_is_refused() {
    let (_dir, router) = start().await;
    let witness = send(&router, Method::GET, "/health", &[("origin", PAGE)]).await;
    assert_eq!(allowed_origin(&witness), Some(PAGE));
    for written in [
        "HTTPS://page.example",
        "https://PAGE.example",
        "https://page.example:443",
        "https://page.example/",
        "https://page.example/path",
        " https://page.example",
        "null",
        "",
    ] {
        let reply = send(&router, Method::GET, "/health", &[("origin", written)]).await;
        assert_eq!(allowed_origin(&reply), None, "{written:?}");
        let asked = send(
            &router,
            Method::OPTIONS,
            "/items",
            &preflight_for(written, "GET"),
        )
        .await;
        assert_eq!(allowed_origin(&asked), None, "{written:?}");
    }
}

#[tokio::test]
async fn two_origin_headers_are_no_origin() {
    let (_dir, router) = start().await;
    let one = send(&router, Method::GET, "/health", &[("origin", PAGE)]).await;
    assert_eq!(allowed_origin(&one), Some(PAGE));
    let two = send(
        &router,
        Method::GET,
        "/health",
        &[("origin", PAGE), ("origin", PAGE)],
    )
    .await;
    assert_eq!(allowed_origin(&two), None);
    let stranger_second = send(
        &router,
        Method::GET,
        "/health",
        &[("origin", PAGE), ("origin", STRANGER)],
    )
    .await;
    assert_eq!(allowed_origin(&stranger_second), None);
}

#[tokio::test]
async fn a_loopback_origin_is_allowed_only_once_named() {
    let (_dir, router, app) = start_with_app().await;
    let loopback = "http://localhost:5173";
    for origin in [loopback, "http://127.0.0.1:5173", "http://[::1]:5173"] {
        let reply = send(&router, Method::GET, "/health", &[("origin", origin)]).await;
        assert_eq!(allowed_origin(&reply), None, "{origin}");
    }
    named_origins(&app, &[PAGE, loopback]);
    let named = send(&router, Method::GET, "/health", &[("origin", loopback)]).await;
    assert_eq!(allowed_origin(&named), Some(loopback));
    let beside = send(
        &router,
        Method::GET,
        "/health",
        &[("origin", "http://localhost:5174")],
    )
    .await;
    assert_eq!(allowed_origin(&beside), None);
}

#[tokio::test]
async fn an_origin_taken_off_the_setting_is_refused_on_the_next_request() {
    let (_dir, router, app) = start_with_app().await;
    let ask = |origin: &'static str| {
        let router = router.clone();
        async move {
            let plain = send(&router, Method::GET, "/health", &[("origin", origin)]).await;
            let asked = send(
                &router,
                Method::OPTIONS,
                "/items",
                &preflight_for(origin, "GET"),
            )
            .await;
            (
                allowed_origin(&plain).is_some(),
                allowed_origin(&asked).is_some(),
            )
        }
    };
    assert_eq!(ask(PAGE).await, (true, true));
    named_origins(&app, &[STRANGER]);
    assert_eq!(ask(PAGE).await, (false, false));
    assert_eq!(ask(STRANGER).await, (true, true));
    named_origins(&app, &[]);
    assert_eq!(ask(STRANGER).await, (false, false));
}

#[tokio::test]
async fn an_answer_that_depends_on_the_origin_says_so() {
    let (_dir, router) = start().await;
    let origin = "origin".to_string();
    let none = send(&router, Method::GET, "/health", &[]).await;
    assert!(varies(&none).contains(&origin));
    let allowed = send(&router, Method::GET, "/health", &[("origin", PAGE)]).await;
    assert!(varies(&allowed).contains(&origin));
    let refused = send(&router, Method::GET, "/health", &[("origin", STRANGER)]).await;
    assert!(varies(&refused).contains(&origin));
    let nowhere = send(&router, Method::GET, "/nowhere", &[("origin", PAGE)]).await;
    assert!(varies(&nowhere).contains(&origin));

    let preflight = send(&router, Method::OPTIONS, "/items", &preflight(PAGE)).await;
    assert_eq!(preflight.status, StatusCode::NO_CONTENT);
    let named = varies(&preflight);
    for field in [
        "origin",
        "access-control-request-method",
        "access-control-request-headers",
    ] {
        assert!(named.contains(&field.to_string()), "{field} in {named:?}");
    }
}

#[tokio::test]
async fn a_request_with_no_origin_gets_no_cors_headers() {
    let (_dir, router) = start().await;
    for path in [
        "/health",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
    ] {
        let reply = send(&router, Method::GET, path, &[]).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        for name in [
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        ] {
            assert!(!reply.headers.contains_key(&name), "{name} on {path}");
        }
    }
    for path in ["/oauth/register", "/items"] {
        let reply = send(
            &router,
            Method::OPTIONS,
            path,
            &[
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "content-type"),
            ],
        )
        .await;
        let named: Vec<_> = reply
            .headers
            .keys()
            .filter(|name| name.as_str().starts_with("access-control-"))
            .collect();
        assert!(named.is_empty(), "{path}: {named:?}");
    }
    // The witness: the same discovery documents name every origin when asked from one.
    let asked = send(
        &router,
        Method::GET,
        "/.well-known/oauth-authorization-server",
        &[("origin", STRANGER)],
    )
    .await;
    assert_eq!(allowed_origin(&asked), Some("*"));
    assert!(varies(&asked).contains(&"origin".to_string()));
    // The witness for the preflights: each one is answered once it names an origin.
    for (path, origin, allowed) in [("/oauth/register", STRANGER, "*"), ("/items", PAGE, PAGE)] {
        let asked = send(
            &router,
            Method::OPTIONS,
            path,
            &[
                ("origin", origin),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "content-type"),
            ],
        )
        .await;
        assert_eq!(allowed_origin(&asked), Some(allowed), "{path}");
    }
}

#[tokio::test]
async fn registration_answers_only_the_preflight_it_serves() {
    let (_dir, router) = start().await;
    let register = |method: &'static str| {
        [
            ("origin", STRANGER),
            ("access-control-request-method", method),
            ("access-control-request-headers", "content-type"),
        ]
    };
    let served = send(
        &router,
        Method::OPTIONS,
        "/oauth/register",
        &register("POST"),
    )
    .await;
    assert_eq!(served.status, StatusCode::NO_CONTENT);
    assert_eq!(allowed_origin(&served), Some("*"));
    assert_eq!(served.headers[header::ACCESS_CONTROL_ALLOW_METHODS], "POST");
    assert_eq!(
        served.headers[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "Content-Type"
    );
    assert!(varies(&served).contains(&"origin".to_string()));

    for headers in [
        &register("DELETE")[..],
        &[][..],
        &[("origin", STRANGER)][..],
        &[("access-control-request-method", "POST")][..],
    ] {
        let reply = send(&router, Method::OPTIONS, "/oauth/register", headers).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{headers:?}");
        assert_eq!(reply.body["error"]["code"], "not_found");
        assert_eq!(allowed_origin(&reply), None);
    }
}
