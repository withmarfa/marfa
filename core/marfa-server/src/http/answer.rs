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

#[derive(Debug)]
pub enum Stopped {
    Refused(Refusal),
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

/// Left on a response that streams until the client closes it. Its duration is how long it stayed
/// open, which says nothing about latency, so the request-duration metric leaves it out.
#[derive(Clone, Copy, Debug)]
pub struct Endless;

/// Left on the answer to a fault no refusal foresaw, for the layer that tells the outside once.
#[derive(Clone, Debug)]
pub struct Unhandled(pub Arc<Fault>);

pub fn json_answer(status: StatusCode, value: &impl Serialize) -> Response {
    match marfa_rules::number::to_vec(value) {
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
    let mut out = Map::new();
    out.insert("error".into(), Value::Object(error));
    if let Some(members) = &refusal.members {
        out.extend((**members).clone());
    }
    Value::Object(out)
}

pub fn refusal_body(refusal: &Refusal) -> Vec<u8> {
    marfa_rules::number::to_vec(&envelope(refusal)).unwrap_or_default()
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
        .and_then(|details| details.get("retry_after_seconds").and_then(Value::as_i64));
    if let Some(seconds) = wait {
        headers.insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    }
    if let Some(challenge) = step_up_challenge(refusal) {
        headers.insert(header::WWW_AUTHENTICATE, challenge);
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

/// RFC 9470 section 3.
fn step_up_challenge(refusal: &Refusal) -> Option<HeaderValue> {
    if refusal.code != Code::InsufficientUserAuthentication {
        return None;
    }
    let max_age = refusal
        .details
        .as_ref()
        .and_then(|details| details.get("max_age").and_then(Value::as_i64))?;
    HeaderValue::from_str(&format!(
        "Bearer error=\"insufficient_user_authentication\", max_age=\"{max_age}\""
    ))
    .ok()
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

pub fn panicked(_: Box<dyn Any + Send>) -> Response {
    refusal_answer(&Refusal::panicked("a request panicked"))
}

/// Whether one range of an `Accept` header names `media`: the type is read without regard to
/// case, and a range with a quality of zero is one the caller refuses.
fn range_names(range: &str, media: &str) -> bool {
    let mut parts = range.split(';');
    if !parts
        .next()
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(media))
    {
        return false;
    }
    !parts.any(|parameter| {
        parameter.split_once('=').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("q")
                && value
                    .trim()
                    .parse::<f32>()
                    .is_ok_and(|quality| quality == 0.0)
        })
    })
}

/// Whether an `Accept` header names `media` as a range the caller takes.
pub fn names(accept: &str, media: &str) -> bool {
    accept.split(',').any(|range| range_names(range, media))
}

fn position(accept: &str, media: &str) -> Option<usize> {
    accept
        .split(',')
        .position(|range| range_names(range, media))
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

#[cfg(test)]
mod tests {
    use super::{asks_for_html, names};

    #[test]
    fn a_range_is_read_without_regard_to_case_and_a_quality_of_zero_refuses_it() {
        assert!(names("Application/JSON", "application/json"));
        assert!(names(
            "text/html, application/json;q=0.5",
            "application/json"
        ));
        assert!(names("application/json; Q=1", "application/json"));
        assert!(!names("application/json, text/html;q=0", "text/html"));
        assert!(!names("text/html;Q=0.0", "text/html"));
        assert!(!names("application/jsonish", "application/json"));
    }

    #[test]
    fn a_page_is_asked_for_only_by_a_range_the_caller_takes_before_json() {
        assert!(asks_for_html(Some("text/html, application/json")));
        assert!(!asks_for_html(Some("text/html;q=0, application/json")));
        assert!(!asks_for_html(Some("application/json, text/html")));
        assert!(asks_for_html(Some("application/json;q=0, TEXT/HTML")));
    }
}
