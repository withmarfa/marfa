//! A JSON body, read only once the handler has checked what comes before it.

use std::sync::Arc;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{FromRequest, Request, State};
use axum::http::{HeaderMap, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use marfa_rules::{integers, json_text};
use serde_json::{Map, Value, json};

use super::answer::{Stopped, refusal_answer};
use crate::app::App;
use crate::app::items::write::ruled;
use crate::app::refusal::{Code, Refusal};
use crate::settings::registry::MAX_REQUEST_BYTES;

pub struct JsonBody {
    headers: HeaderMap,
    body: Body,
    limit: usize,
}

impl FromRequest<Arc<App>> for JsonBody {
    type Rejection = Stopped;

    async fn from_request(request: Request, app: &Arc<App>) -> Result<JsonBody, Stopped> {
        let (parts, body) = request.into_parts();
        let limit = app.settings.live().get(MAX_REQUEST_BYTES);
        Ok(JsonBody {
            headers: parts.headers,
            body,
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
        })
    }
}

fn is_json(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    essence == "application/json"
        || essence
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json") && subtype.len() > "+json".len())
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn too_large(limit: usize) -> Refusal {
    Refusal::new(
        Code::RequestTooLarge,
        format!("The body is larger than {limit} bytes."),
    )
}

async fn buffered(body: Body, limit: usize) -> Result<Bytes, Stopped> {
    axum::body::to_bytes(body, limit).await.map_err(|error| {
        let over = std::error::Error::source(&error)
            .is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
        if over {
            too_large(limit).into()
        } else {
            Stopped::ClientClosed
        }
    })
}

impl JsonBody {
    async fn bytes(self) -> Result<Bytes, Stopped> {
        if declared_length(&self.headers) > Some(self.limit) {
            return Err(too_large(self.limit).into());
        }
        buffered(self.body, self.limit).await
    }

    fn declares_json(&self) -> bool {
        self.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json)
    }

    /// The body as it was sent, for an operation that must see it before it
    /// judges it.
    pub async fn read(self) -> Result<ReadBody, Stopped> {
        let declared = self.declares_json();
        Ok(ReadBody {
            declared,
            bytes: self.bytes().await?,
        })
    }

    /// The body as a JSON object holding no key outside `allowed`.
    pub async fn object(self, allowed: &[&str]) -> Result<Map<String, Value>, Stopped> {
        Ok(only_declared(self.open_object().await?, allowed)?)
    }

    /// The body as a JSON object, whatever keys it holds, for an operation
    /// that judges the keys itself.
    pub async fn open_object(self) -> Result<Map<String, Value>, Stopped> {
        if !self.declares_json() {
            return Err(not_json().into());
        }
        Ok(parsed_object(&self.bytes().await?, None)?)
    }
}

fn not_json() -> Refusal {
    Refusal::validation("Send the body as JSON, with Content-Type: application/json.")
}

/// Refuses a key of `object` outside `allowed`.
pub fn only_declared(
    object: Map<String, Value>,
    allowed: &[&str],
) -> Result<Map<String, Value>, Refusal> {
    let mut unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !allowed.contains(key))
        .collect();
    if unknown.is_empty() {
        return Ok(object);
    }
    unknown.sort_unstable();
    Err(Refusal::validation(format!(
        "The body names fields this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_body_fields", unknown))
}

/// `bytes` as a JSON object. A parse stops at a number too large for a float,
/// so `bag` names where such a number is the operation's to refuse by name.
fn parsed_object(bytes: &[u8], bag: Option<Bag>) -> Result<Map<String, Value>, Refusal> {
    if bytes.is_empty() {
        return Err(Refusal::validation(
            "The body is empty; send a JSON object.",
        ));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Err(Refusal::validation("The body must be a JSON object.")),
        Err(error) => {
            if let (Some(bag), Ok(text)) = (bag, std::str::from_utf8(bytes)) {
                bag.refuse_inexact_numbers(text)?;
            }
            Err(Refusal::validation(format!(
                "The body is not valid JSON: {error}"
            )))
        }
    }
}

/// Where a body carries values kept as sent.
#[derive(Clone, Copy, Debug)]
pub enum Bag {
    Properties,
    Whole,
}

impl Bag {
    fn refuse_inexact_numbers(self, text: &str) -> Result<(), Refusal> {
        let member = match self {
            Bag::Properties => Some("properties"),
            Bag::Whole => None,
        };
        integers::refuse_inexact_integers_in(text, member).map_err(ruled)
    }
}

/// A body already taken off the wire.
#[derive(Debug)]
pub struct ReadBody {
    declared: bool,
    bytes: Bytes,
}

impl ReadBody {
    pub fn declares_json(&self) -> bool {
        self.declared
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The JSON object sent, whatever keys it holds.
    pub fn object(&self, bag: Bag) -> Result<Map<String, Value>, Refusal> {
        if !self.declared {
            return Err(not_json());
        }
        parsed_object(&self.bytes, Some(bag))
    }

    /// Refuses a number in `bag` that would not come back as it was sent.
    pub fn refuse_inexact_numbers(&self, bag: Bag) -> Result<(), Refusal> {
        match std::str::from_utf8(&self.bytes) {
            Ok(text) => bag.refuse_inexact_numbers(text),
            Err(_) => Ok(()),
        }
    }
}

fn nested_too_deep() -> Refusal {
    Refusal::validation("The body nests deeper than 64 levels.")
}

fn ill_formed(pointer: String) -> Refusal {
    let message = "The body holds text that is not well-formed UTF-16.";
    Refusal::validation(message)
        .with_detail("errors", json!([{ "path": pointer, "message": message }]))
}

/// Refuses a body too deep or too ill-formed for anything to read, whoever
/// sent it and under whatever `Content-Type`. A body declared over the cap is
/// left to its operation, which answers the credential first.
pub async fn checked(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let limit = app.settings.live().get(MAX_REQUEST_BYTES);
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    if request.body().is_end_stream() || declared_length(request.headers()) > Some(limit) {
        return next.run(request).await;
    }
    let (parts, body) = request.into_parts();
    let bytes = match buffered(body, limit).await {
        Ok(bytes) => bytes,
        Err(stopped) => return stopped.into_response(),
    };
    if json_text::too_deep(&bytes) {
        return refusal_answer(&nested_too_deep());
    }
    if let Some(pointer) = json_text::ill_formed_at(&bytes) {
        return refusal_answer(&ill_formed(pointer));
    }
    next.run(Request::from_parts(parts, Body::from(bytes)))
        .await
}
