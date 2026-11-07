//! What every answer gets, whatever gave it: a request id, the contract
//! version, a page for a browser in place of a refusal's body, and one record
//! on stdout.

use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::body::Body;
use axum::extract::{ConnectInfo, MatchedPath, Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::{Page, asks_for_html};
use super::body::Shared;
use super::caller_address::caller_address;
use super::listening::Peer;
use super::page;
use crate::app::App;
use crate::app::refusal::Code;
use crate::listener::{Declaration, Transport};
use crate::log;

/// What a request learns about itself on the way in, for its record.
#[derive(Default)]
pub struct Notes {
    pub key_id: OnceLock<String>,
    route: OnceLock<String>,
}

#[derive(Clone)]
pub struct RequestContext {
    pub transport: Transport,
    /// `None` on a connection with no network address, such as the control
    /// socket.
    pub caller_address: Option<IpAddr>,
    pub notes: Arc<Notes>,
}

/// Left on the answer to a request no route serves.
#[derive(Clone, Copy)]
pub struct Unmatched;

#[derive(Clone)]
pub struct Observed {
    pub app: Arc<App>,
    pub listener: Arc<Declaration>,
}

fn acceptable_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn keeps_its_envelope(code: Code) -> bool {
    matches!(code, Code::VersionConflict | Code::AncestorUnavailable)
}

fn offer_page(response: &mut Response) {
    let Some(page) = response.extensions().get::<Page>().cloned() else {
        return;
    };
    if keeps_its_envelope(page.code) {
        return;
    }
    let status = response.status().as_u16().to_string();
    let Ok(rendered) = page::render(&status, &page.message) else {
        return;
    };
    *response.body_mut() = Body::from(rendered.html);
    let headers = response.headers_mut();
    headers.remove(header::CONTENT_LENGTH);
    headers.insert(header::CONTENT_SECURITY_POLICY, rendered.policy);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
}

pub async fn observe(State(observed): State<Observed>, request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let body = Shared::new(body);
    let mut request = Request::from_parts(parts, Body::new(body.clone()));
    let started = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let wants_html = asks_for_html(
        request
            .headers()
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok()),
    );
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|id| acceptable_id(id))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let notes = Arc::new(Notes::default());
    let peer = request
        .extensions()
        .get::<ConnectInfo<Peer>>()
        .and_then(|ConnectInfo(Peer(address))| *address);
    let caller_address =
        peer.map(|peer| caller_address(peer, &observed.listener.trust, request.headers()));
    let transport = observed.listener.transport;
    request.extensions_mut().insert(RequestContext {
        transport,
        caller_address,
        notes: notes.clone(),
    });

    let mut response = next.run(request).await;
    body.finish();

    if wants_html {
        offer_page(&mut response);
    }
    let headers = response.headers_mut();
    headers.insert(
        "x-marfa-contract",
        HeaderValue::from(observed.app.contract()),
    );
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
    log::request(&log::Request {
        timestamp: &log::now(),
        request_id: &request_id,
        method: &method,
        transport: transport.name(),
        path: &path,
        route: notes.route.get().map(String::as_str),
        status: response.status().as_u16(),
        duration_ms: (started.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0,
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
    if let Some(notes) = notes
        && response.extensions().get::<Unmatched>().is_none()
    {
        let _ = notes.route.set(matched.as_str().to_string());
    }
    response
}
