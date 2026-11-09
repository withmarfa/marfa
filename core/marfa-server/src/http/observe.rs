//! Every answer gets a request id, the `x-marfa-contract` header, a page for a browser in
//! place of a refusal's body, and one record on stdout.

use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::body::Body;
use axum::extract::{ConnectInfo, MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::{Page, Unhandled, asks_for_html};
use super::body::Shared;
use super::caller_address::caller_address;
use super::listening::Peer;
use super::pages::{self, Notice};
use crate::app::provenance::{self, Origin};
use crate::app::refusal::Code;
use crate::app::{App, instance};
use crate::listener::{Declaration, Transport};
use crate::log;
use crate::settings::registry::ERROR_REPORTING_ENABLED;
use crate::telemetry::Finished;

#[derive(Default)]
pub struct Notes {
    pub key_id: OnceLock<String>,
    pub renewal: OnceLock<HeaderValue>,
    route: OnceLock<String>,
}

#[derive(Clone)]
pub struct RequestContext {
    pub transport: Transport,
    pub caller_address: Option<IpAddr>,
    pub notes: Arc<Notes>,
}

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

async fn offer_page(app: &App, response: &mut Response) {
    let Some(page) = response.extensions().get::<Page>().cloned() else {
        return;
    };
    if keeps_its_envelope(page.code) {
        return;
    }
    let name = instance::name(app)
        .await
        .unwrap_or_else(|_| instance::DEFAULT_NAME.to_string());
    let notice = Notice::refusal(&name, response.status(), &page.message);
    if let Ok(rendered) = pages::notice(&notice) {
        rendered.write_over(response);
    }
}

pub async fn observe(State(observed): State<Observed>, request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let body = Shared::new(body);
    let mut request = Request::from_parts(parts, Body::new(body.clone()));
    let started = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let logged = crate::app::inbound::loggable(&path);
    // A sender's headers are its content, so nothing from them reaches the log or a span.
    let from_sender = crate::app::inbound::is_address(&path);
    let wants_html = asks_for_html(
        request
            .headers()
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok()),
    );
    let request_id = request
        .headers()
        .get("x-request-id")
        .filter(|_| !from_sender)
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

    let span = if from_sender {
        observed.app.telemetry.begin(&HeaderMap::new(), &method)
    } else {
        observed.app.telemetry.begin(request.headers(), &method)
    };
    let upload = super::blobs::is_upload(&request) || super::restore::is_restore(&request);
    let origin = Origin {
        client_ip: caller_address.map(|address| address.to_string()),
        via: None,
    };
    let mut response = provenance::within(origin, next.run(request)).await;
    if upload && !body.is_whole() {
        // An upload refused before its body was read drops the body with the connection.
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
    } else {
        body.finish();
    }

    if wants_html {
        offer_page(&observed.app, &mut response).await;
    }
    let unanswered = !response.headers().contains_key(header::SET_COOKIE);
    if let Some(cookie) = notes.renewal.get()
        && unanswered
        && response.status() != StatusCode::UNAUTHORIZED
        && !response.status().is_server_error()
    {
        response
            .headers_mut()
            .insert(header::SET_COOKIE, cookie.clone());
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
    let timestamp = log::now();
    let route = notes.route.get().map(String::as_str);
    let fault = response
        .extensions()
        .get::<Unhandled>()
        .map(|held| held.0.clone());
    if let Some(fault) = &fault {
        log::unhandled(&request_id, &method, &logged, route, &fault.message);
    }
    let status = response.status().as_u16();
    log::request(&log::Request {
        timestamp: &timestamp,
        request_id: &request_id,
        method: &method,
        transport: transport.name(),
        path: &logged,
        route,
        status,
        duration_ms: (started.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0,
        key_id: notes.key_id.get().map(String::as_str),
        error_code,
    });
    let reporting = fault.is_some() && observed.app.settings.live().get(ERROR_REPORTING_ENABLED);
    observed.app.telemetry.finish(
        span,
        &Finished {
            request_id: &request_id,
            method: &method,
            path: &logged,
            route,
            transport: observed.listener.transport.name(),
            status,
            error_code,
            fault: fault.as_ref(),
            reporting,
            timestamp: &timestamp,
        },
    );
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
