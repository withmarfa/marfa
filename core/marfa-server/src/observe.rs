//! What every request gets, whatever answers it: a request id, the contract
//! version, and one record on stdout.

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;

use crate::log;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Http,
    LocalSocket,
}

impl Transport {
    fn name(self) -> &'static str {
        match self {
            Transport::Http => "http",
            Transport::LocalSocket => "local_socket",
        }
    }
}

/// What a request learns about itself on the way in, for its record.
#[derive(Default)]
pub struct Notes {
    pub key_id: OnceLock<String>,
    route: OnceLock<String>,
}

#[derive(Clone)]
pub struct RequestContext {
    pub transport: Transport,
    pub notes: Arc<Notes>,
}

pub const CONTRACT: &str = "0";

pub async fn observe(transport: Transport, mut request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|id| acceptable_id(id))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let notes = Arc::new(Notes::default());
    request.extensions_mut().insert(RequestContext {
        transport,
        notes: notes.clone(),
    });

    let mut response = next.run(request).await;

    let headers = response.headers_mut();
    headers.insert("x-marfa-contract", HeaderValue::from_static(CONTRACT));
    if !path.starts_with("/auth/")
        && !path.starts_with("/.well-known/")
        && let Ok(value) = HeaderValue::from_str(&request_id)
    {
        headers.insert("x-request-id", value);
    }
    let error_code = response
        .headers()
        .get("x-error-code")
        .and_then(|value| value.to_str().ok());
    log::request(log::Request {
        request_id: &request_id,
        method: &method,
        transport: transport.name(),
        path: &path,
        route: notes.route.get().map(String::as_str),
        status: response.status().as_u16(),
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        key_id: notes.key_id.get().map(String::as_str),
        error_code,
    });
    response
}

/// Layered on the routes alone, so a request no route answers has no route.
pub async fn remember_route(matched: MatchedPath, request: Request, next: Next) -> Response {
    let notes = request
        .extensions()
        .get::<RequestContext>()
        .map(|context| context.notes.clone());
    let response = next.run(request).await;
    // A route asked with a method it does not serve is answered by the
    // fallback, so no route answered it.
    let unmatched = response
        .headers()
        .get("x-error-code")
        .is_some_and(|code| code == "not_found");
    if let Some(notes) = notes
        && !unmatched
    {
        let _ = notes.route.set(matched.as_str().to_string());
    }
    response
}

fn acceptable_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
