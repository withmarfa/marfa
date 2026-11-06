//! A JSON body, read only once the handler has checked the credential and
//! the standing permission, since those refusals come first.

use axum::body::Body;
use axum::extract::{FromRequest, Request};
use axum::http::{HeaderMap, StatusCode, header};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::error::{ApiError, ApiResult};

pub struct JsonBody {
    headers: HeaderMap,
    body: Body,
    limit: usize,
}

impl FromRequest<App> for JsonBody {
    type Rejection = ApiError;

    async fn from_request(request: Request, app: &App) -> Result<JsonBody, ApiError> {
        let (parts, body) = request.into_parts();
        Ok(JsonBody {
            headers: parts.headers,
            body,
            limit: app.settings.max_request_bytes,
        })
    }
}

impl JsonBody {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The body as a JSON object holding no key outside `allowed`.
    pub async fn object(self, allowed: &[&str]) -> ApiResult<Map<String, Value>> {
        let declared = self
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json);
        if !declared {
            return Err(ApiError::validation(
                "Send the body as JSON, with Content-Type: application/json.",
            ));
        }
        let too_large = || {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                format!("The body is larger than {} bytes.", self.limit),
            )
        };
        let length = self
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        if length.is_some_and(|length| length > self.limit) {
            return Err(too_large());
        }
        let bytes = match axum::body::to_bytes(self.body, self.limit).await {
            Ok(bytes) => bytes,
            Err(error) => {
                let over = std::error::Error::source(&error)
                    .is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
                return Err(if over {
                    too_large()
                } else {
                    ApiError::validation("The body could not be read.")
                });
            }
        };
        if bytes.is_empty() {
            return Err(ApiError::validation("The body is empty; send a JSON object."));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| ApiError::validation(format!("The body is not valid JSON: {error}")))?;
        let Value::Object(object) = value else {
            return Err(ApiError::validation("The body must be a JSON object."));
        };
        let mut unknown: Vec<&String> = object
            .keys()
            .filter(|key| !allowed.contains(&key.as_str()))
            .collect();
        if !unknown.is_empty() {
            unknown.sort();
            let names: Vec<&str> = unknown.iter().map(|key| key.as_str()).collect();
            return Err(ApiError::validation(format!(
                "The body names fields this operation does not take: {}.",
                names.join(", ")
            ))
            .with(json!({ "unknown_body_fields": names })));
        }
        Ok(object)
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
