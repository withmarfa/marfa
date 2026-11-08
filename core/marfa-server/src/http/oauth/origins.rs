//! The pages the owner approved, which a browser may let read an answer.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD, ORIGIN, VARY,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use crate::app::App;
use crate::app::oauth::clients::page_approved;

const METHODS: &str = "GET, HEAD, PUT, POST, DELETE, PATCH";
/// What RFC 9700 section 2.6 keeps from every page's scripts.
const AUTHORIZATION_DOORS: [&str; 4] = [
    "/auth/oauth2/authorize",
    "/auth/authorize",
    "/auth/authorize/decision",
    "/auth/device/consent",
];

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

/// `keys-and-oauth/page-origin-allowed`. What a door answers for itself, as
/// the documents every origin may read do, stands.
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
    response
        .headers_mut()
        .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    response
}
