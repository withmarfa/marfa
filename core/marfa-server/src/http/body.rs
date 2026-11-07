//! A JSON body, read only once the handler has checked what comes before it.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{FromRequest, Request};
use axum::http::{HeaderMap, header};
use serde_json::{Map, Value};

use super::answer::Stopped;
use crate::app::App;
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

impl JsonBody {
    async fn bytes(self) -> Result<axum::body::Bytes, Stopped> {
        let limit = self.limit;
        let too_large = || {
            Refusal::new(
                Code::RequestTooLarge,
                format!("The body is larger than {limit} bytes."),
            )
        };
        let declared_length = self
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        if declared_length.is_some_and(|length| length > limit) {
            return Err(too_large().into());
        }
        axum::body::to_bytes(self.body, limit)
            .await
            .map_err(|error| {
                let over = std::error::Error::source(&error)
                    .is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
                if over {
                    too_large().into()
                } else {
                    Stopped::ClientClosed
                }
            })
    }

    /// The body as a JSON object holding no key outside `allowed`.
    pub async fn object(self, allowed: &[&str]) -> Result<Map<String, Value>, Stopped> {
        let declared = self
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json);
        if !declared {
            return Err(Refusal::validation(
                "Send the body as JSON, with Content-Type: application/json.",
            )
            .into());
        }
        let bytes = self.bytes().await?;
        if bytes.is_empty() {
            return Err(Refusal::validation("The body is empty; send a JSON object.").into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| Refusal::validation(format!("The body is not valid JSON: {error}")))?;
        let Value::Object(object) = value else {
            return Err(Refusal::validation("The body must be a JSON object.").into());
        };
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
        .with_detail("unknown_body_fields", unknown)
        .into())
    }
}
