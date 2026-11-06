//! Every refusal in the contract's envelope:
//! `{"error":{"code","message","details"?}}`, with the code repeated in
//! `X-Error-Code`.

use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use marfa_core::CoreError;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with(mut self, details: Value) -> ApiError {
        self.details = Some(details);
        self
    }

    pub fn validation(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "validation_error", message)
    }

    pub fn not_found() -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "not_found", "Not found")
    }

    pub fn unauthorized() -> ApiError {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "This request carries no credential the server accepts.",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::CONFLICT, code, message)
    }

    /// Logged in full on stderr; the caller sees only the fixed answer.
    pub fn internal(cause: impl std::fmt::Display) -> ApiError {
        tracing::error!("internal error: {cause}");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Internal server error",
        )
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> ApiError {
        if let rusqlite::Error::SqliteFailure(failure, _) = &error
            && matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
        {
            return ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "write_contention",
                "The database stayed busy past the write budget. Try again.",
            );
        }
        ApiError::internal(error)
    }
}

/// A core refusal keeps the core's code and message. Anything else the core
/// answers is the server's fault.
impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> ApiError {
        match error {
            CoreError::Validation {
                code,
                message,
                details,
            } => {
                let mut refusal = ApiError::new(StatusCode::BAD_REQUEST, known(&code), message);
                refusal.details = details.map(|details| *details);
                refusal
            }
            CoreError::UnknownType { message } => {
                ApiError::new(StatusCode::BAD_REQUEST, "unknown_type", message)
            }
            CoreError::NotFound { code, message } => {
                ApiError::new(StatusCode::NOT_FOUND, known(&code), message)
            }
            other => ApiError::internal(other),
        }
    }
}

/// The codes the core refuses with, as the static strings the envelope
/// carries. A code outside the list is the core's and is answered as
/// `validation_error`, which every 400 may be.
fn known(code: &str) -> &'static str {
    const CODES: [&str; 6] = [
        "validation_error",
        "invalid_properties",
        "invalid_id",
        "missing_required_field",
        "type_not_found",
        "edge_type_not_found",
    ];
    CODES
        .iter()
        .find(|known| **known == code)
        .copied()
        .unwrap_or("validation_error")
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = if self.status == StatusCode::INTERNAL_SERVER_ERROR {
            json!({ "error": { "code": "internal_error", "message": "Internal server error" } })
        } else {
            let mut error = json!({ "code": self.code, "message": self.message });
            if let Some(details) = self.details {
                error["details"] = details;
            }
            json!({ "error": error })
        };
        let mut response = (self.status, axum::Json(body)).into_response();
        response
            .headers_mut()
            .insert("x-error-code", HeaderValue::from_static(self.code));
        response
    }
}
