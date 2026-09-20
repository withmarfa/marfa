use thiserror::Error;

/// Every way the core can refuse or fail. Server refusals keep the server's
/// own `code`.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoreError {
    #[error("not found ({code}): {message}")]
    NotFound { code: String, message: String },
    #[error("unauthorized ({code}): {message}")]
    Unauthorized { code: String, message: String },
    #[error("forbidden ({code}): {message}")]
    Forbidden { code: String, message: String },
    #[error("validation ({code}): {message}")]
    Validation { code: String, message: String },
    #[error("unknown type: {message}")]
    UnknownType { message: String },
    #[error("rate limited ({code}): {message}")]
    RateLimited {
        code: String,
        message: String,
        retry_after_seconds: Option<u64>,
    },
    #[error("server answered {status} ({code}): {message}")]
    Server {
        status: u16,
        code: String,
        message: String,
    },
    #[error("network: {0}")]
    Network(String),
    #[error("decoding: {0}")]
    Decoding(String),
    #[error("store: {0}")]
    Store(String),
    #[error("no server configured for this call")]
    NoServer,
    #[error("no event cursor stored; hydrate first")]
    NoCursor,
    #[error("hydration did not complete; hydrate again before reading")]
    HydrationIncomplete,
    #[error(
        "this store was written by schema {found} and this build expects {expected}; there are no migrations, so delete {path} and hydrate again"
    )]
    WrongSchema {
        expected: String,
        found: String,
        path: String,
    },
    #[error(
        "the event log no longer holds the cursor (oldest retained id {min_retained_id}); hydrate again"
    )]
    CatchUpTooOld { min_retained_id: String },
    #[error("the event stream ended early: {reason}")]
    StreamIncomplete { reason: String },
    #[error("this file belongs to {expected}, not {got}")]
    WrongServer { expected: String, got: String },
    #[error("{0}")]
    Invalid(String),
}

impl From<rusqlite::Error> for CoreError {
    fn from(error: rusqlite::Error) -> Self {
        CoreError::Store(error.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        CoreError::Decoding(error.to_string())
    }
}

impl From<url::ParseError> for CoreError {
    fn from(error: url::ParseError) -> Self {
        CoreError::Invalid(format!("invalid url: {error}"))
    }
}
