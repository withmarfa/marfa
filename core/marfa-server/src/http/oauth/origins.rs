use std::collections::BTreeSet;
use std::sync::{Arc, LazyLock};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    ORIGIN, VARY,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use crate::app::App;
use crate::app::oauth::clients::page_approved;
use crate::http::root::DOCUMENT;

const METHODS: &str = "GET, HEAD, PUT, POST, DELETE, PATCH";
/// RFC 9700 section 2.6: no page's scripts may read these.
const AUTHORIZATION_DOORS: [&str; 4] = [
    "/auth/oauth2/authorize",
    "/auth/authorize",
    "/auth/authorize/decision",
    "/auth/device/consent",
];

/// A browser lets a page read only the safelisted response headers unless the answer lists the rest.
const SAFELISTED: [&str; 7] = [
    "cache-control",
    "content-language",
    "content-length",
    "content-type",
    "expires",
    "last-modified",
    "pragma",
];

fn response_headers(response: &serde_json::Value, found: &mut BTreeSet<String>) {
    if let Some(headers) = response
        .get("headers")
        .and_then(|headers| headers.as_object())
    {
        found.extend(headers.keys().cloned());
    }
}

fn declared_headers(document: &serde_json::Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let operations = document["paths"].as_object().into_iter().flatten();
    for operation in operations.flat_map(|(_, path)| path.as_object().into_iter().flatten()) {
        for response in operation.1["responses"].as_object().into_iter().flatten() {
            response_headers(response.1, &mut found);
        }
    }
    for response in document["components"]["responses"]
        .as_object()
        .into_iter()
        .flatten()
    {
        response_headers(response.1, &mut found);
    }
    found
}

/// Pages need access to the response headers declared in the document.
static EXPOSED: LazyLock<Option<HeaderValue>> = LazyLock::new(|| {
    let document: serde_json::Value = serde_json::from_str(DOCUMENT).ok()?;
    let mut found = declared_headers(&document);
    found.retain(|name| {
        let lower = name.to_ascii_lowercase();
        lower != "set-cookie" && !SAFELISTED.contains(&lower.as_str())
    });
    HeaderValue::from_str(&found.into_iter().collect::<Vec<_>>().join(", ")).ok()
});

fn preflight_answer(
    app: &App,
    origin: HeaderValue,
    asked_headers: Option<HeaderValue>,
) -> Response {
    let mut answer = Response::new(Body::empty());
    *answer.status_mut() = StatusCode::NO_CONTENT;
    let headers = answer.headers_mut();
    headers.insert("x-marfa-contract", HeaderValue::from(app.contract()));
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(METHODS),
    );
    if let Some(asked) = asked_headers {
        headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, asked);
    }
    answer
}

pub async fn page_origins(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    if AUTHORIZATION_DOORS.contains(&request.uri().path()) {
        return next.run(request).await;
    }
    let origin = request.headers().get(ORIGIN).cloned();
    let preflight = request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(ACCESS_CONTROL_REQUEST_METHOD);
    let asked_headers = request
        .headers()
        .get(ACCESS_CONTROL_REQUEST_HEADERS)
        .cloned();
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .append(VARY, HeaderValue::from_static("Origin"));
    let Some(origin) = origin else {
        return response;
    };
    if response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN) {
        return response;
    }
    let Ok(text) = origin.to_str() else {
        return response;
    };
    if !page_approved(&app, text).await.unwrap_or(false) {
        return response;
    }
    if preflight {
        return preflight_answer(&app, origin, asked_headers);
    }
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    if let Some(exposed) = EXPOSED.as_ref() {
        headers.insert(ACCESS_CONTROL_EXPOSE_HEADERS, exposed.clone());
    }
    response
}
