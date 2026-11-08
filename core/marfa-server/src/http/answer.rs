//! What a handler answers with: one JSON writer, and one shape for a refusal.

use std::any::Any;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::app::refusal::{Code, Refusal};
use crate::telemetry::Fault;

const CLIENT_CLOSED: u16 = 499;

/// Why a handler ended without an answer of its own.
#[derive(Debug)]
pub enum Stopped {
    Refused(Refusal),
    /// The client closed the connection, so nobody reads what comes back.
    ClientClosed,
}

impl From<Refusal> for Stopped {
    fn from(refusal: Refusal) -> Stopped {
        Stopped::Refused(refusal)
    }
}

pub type Answer = Result<Response, Stopped>;

/// Left on a refusal's response, for the layer that may send a page instead.
#[derive(Clone, Debug)]
pub struct Page {
    pub code: Code,
    pub message: String,
}

/// Left on the answer to a request that ended in a fault no refusal foresaw,
/// for the layer that tells the outside of it, once.
#[derive(Clone, Debug)]
pub struct Unhandled(pub Arc<Fault>);

pub fn json_answer(status: StatusCode, value: &impl Serialize) -> Response {
    match marfa_rules::js::to_vec(value) {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            *response.status_mut() = status;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            response
        }
        Err(_) => refusal_answer(&Refusal::internal("an answer did not serialize")),
    }
}

/// An answer whose JSON is already text, so that what was stored goes out as
/// it stands.
pub fn text_answer(status: StatusCode, body: impl Into<Body>) -> Response {
    let mut response = Response::new(body.into());
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn envelope(refusal: &Refusal) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), refusal.code.wire().into());
    error.insert("message".into(), refusal.message.as_ref().into());
    if let Some(details) = &refusal.details {
        error.insert("details".into(), Value::Object((**details).clone()));
    }
    if refusal.members.is_some() {
        error.insert("status".into(), refusal.code.status().into());
    }
    let mut out = Map::new();
    out.insert("error".into(), Value::Object(error));
    if let Some(members) = &refusal.members {
        out.extend((**members).clone());
    }
    Value::Object(out)
}

/// A refusal's body as it is sent, for what keeps it.
pub fn refusal_body(refusal: &Refusal) -> Vec<u8> {
    marfa_rules::js::to_vec(&envelope(refusal)).unwrap_or_default()
}

pub fn refusal_answer(refusal: &Refusal) -> Response {
    let status =
        StatusCode::from_u16(refusal.code.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = Response::new(Body::from(refusal_body(refusal)));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        "x-error-code",
        HeaderValue::from_static(refusal.code.wire()),
    );
    let wait = refusal
        .details
        .as_ref()
        .and_then(|details| details.get("retry_after").and_then(Value::as_i64));
    if let Some(seconds) = wait {
        headers.insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    }
    response.extensions_mut().insert(Page {
        code: refusal.code,
        message: refusal.message.to_string(),
    });
    if refusal.code == Code::InternalError {
        let fault = refusal
            .fault
            .clone()
            .unwrap_or_else(|| Arc::new(Fault::internal("an internal error with no context")));
        response.extensions_mut().insert(Unhandled(fault));
    }
    response
}

impl IntoResponse for Stopped {
    fn into_response(self) -> Response {
        match self {
            Stopped::Refused(refusal) => refusal_answer(&refusal),
            Stopped::ClientClosed => {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::from_u16(CLIENT_CLOSED)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                response
            }
        }
    }
}

/// The answer to a handler that panicked.
pub fn panicked(_: Box<dyn Any + Send>) -> Response {
    refusal_answer(&Refusal::panicked("a request panicked"))
}

fn position(accept: &str, media: &str) -> Option<usize> {
    accept.split(',').position(|range| {
        range
            .split(';')
            .next()
            .is_some_and(|name| name.trim().eq_ignore_ascii_case(media))
    })
}

/// Whether `Accept` names `text/html` and not `application/json` before it.
pub fn asks_for_html(accept: Option<&str>) -> bool {
    let Some(accept) = accept else {
        return false;
    };
    match (
        position(accept, "text/html"),
        position(accept, "application/json"),
    ) {
        (Some(html), Some(json)) => html < json,
        (Some(_), None) => true,
        _ => false,
    }
}

