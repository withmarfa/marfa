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
        "this is a reading handle: another process holds the writer handle for this store, and one store has one writer"
    )]
    ReadingHandle,
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
    /// The item is whole and its bytes are not here (`device.md` 30).
    #[error("the bytes of {hash} are not held here and cannot be fetched: {reason}")]
    BytesAbsent { hash: String, reason: String },
    /// The server speaks a contract this core was not built for, so its
    /// answer may be shaped in ways the core cannot read, and was not read.
    #[error("{}", contract_mismatch(origin, served.as_deref(), *expected, *status, *write_sent))]
    ContractMismatch {
        origin: String,
        /// The contract the answer named, or `None` where a success named
        /// none.
        served: Option<String>,
        expected: u64,
        status: u16,
        /// Whether the answer was to a write, which the server acted on
        /// before the answer could say it speaks another contract.
        write_sent: bool,
    },
    #[error("{0}")]
    Invalid(String),
}

fn contract_mismatch(
    origin: &str,
    served: Option<&str>,
    expected: u64,
    status: u16,
    write_sent: bool,
) -> String {
    let sent = if write_sent {
        ". The write was sent and may have taken effect, and it stays queued with no verdict"
    } else {
        ""
    };
    match served {
        Some(served) => format!(
            "{origin} answered {status} on contract {served}, and this build of the core speaks contract {expected}, so the answer was not read: use a build for the server's contract{sent}"
        ),
        // Nothing here says the answer came from a Marfa server at all: a
        // captive portal or a mistyped URL answers the same way.
        None => format!(
            "{origin} answered {status} naming no contract, so it may not be a Marfa server: check the URL. This build of the core speaks contract {expected}{sent}"
        ),
    }
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
