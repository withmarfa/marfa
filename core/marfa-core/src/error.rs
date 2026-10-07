use std::time::Duration;

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoreError {
    #[error("{}", classified("not found", Some(code), message))]
    NotFound { code: String, message: String },
    #[error("{}", classified("unauthorized", Some(code), message))]
    Unauthorized { code: String, message: String },
    #[error("{}", classified("forbidden", Some(code), message))]
    Forbidden { code: String, message: String },
    #[error("{}", classified("validation", Some(code), message))]
    Validation { code: String, message: String },
    #[error("{}", classified("unknown type", None, message))]
    UnknownType { message: String },
    #[error("{}", classified("rate limited", Some(code), message))]
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
    #[error("{0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
    /// The server names its contract on every answer, so one naming none is
    /// taken as from something in front of it. Environmental, whatever its
    /// status: a gateway's `401` is not the server's word on the key, nor a
    /// proxy's `404` on a row.
    #[error(
        "{origin} answered {status} naming no contract, taken as from something in front of the server; if it repeats while the server otherwise answers, its refusals are losing the contract header on the way"
    )]
    Unnamed {
        origin: String,
        status: u16,
        retry_after_seconds: Option<u64>,
    },
    #[error("decoding: {0}")]
    Decoding(String),
    /// A failed credential callback says nothing about the queued request.
    /// Client boundaries expose the cause; drain preserves this provenance.
    #[error("{0}")]
    RenewalFailed(Box<CoreError>),
    #[error("signed out of {origin}: sign in again")]
    SignedOut { origin: String },
    #[error("credential storage is unavailable: {0}")]
    NoKeychain(String),
    #[error("local storage is full: {0}")]
    StorageFull(String),
    #[error("store: {0}")]
    Store(String),
    #[error("{origin} answered {status}, a redirect to {}", location.as_deref().unwrap_or("nowhere it named"))]
    Redirected {
        origin: String,
        status: u16,
        location: Option<String>,
    },
    #[error("no server configured for this call")]
    NoServer,
    #[error("no event cursor stored; hydrate first")]
    NoCursor,
    #[error("hydration did not complete; hydrate again before reading")]
    HydrationIncomplete,
    #[error("this working copy has never held the server's type catalog; hydrate first")]
    NoCatalog,
    #[error(
        "this is a reading handle: another process holds the writer handle for this store, and one store has one writer"
    )]
    ReadingHandle,
    #[error("{}", wrong_schema(path, reason, *unsent))]
    WrongSchema {
        path: String,
        reason: String,
        /// Writes in the store the server has not taken, waiting, blocked,
        /// refused or dead; `None` where its queue cannot be read.
        unsent: Option<u64>,
    },
    /// The cursor is dropped, so the copy reports itself expired until a
    /// hydration, which keeps the queue.
    #[error("this working copy can no longer be kept current: {reason}; hydrate again")]
    CopyExpired { reason: String },
    #[error("the event stream ended early: {reason}")]
    StreamIncomplete { reason: String },
    #[error("this file belongs to {expected}, not {got}")]
    WrongServer { expected: String, got: String },
    #[error("the bytes of {hash} are not held here and cannot be fetched: {reason}")]
    BytesAbsent { hash: String, reason: String },
    #[error("{}", contract_mismatch(origin, served.as_deref(), *expected, *status, *write_sent))]
    ContractMismatch {
        origin: String,
        served: Option<String>,
        expected: u64,
        status: Option<u16>,
        /// The server acted on a write before its answer could say it speaks
        /// another contract.
        write_sent: bool,
    },
    /// The caller's stop was raised. What had been taken is consistent: a
    /// hydration left unfinished refuses reads, a catch-up keeps the cursor
    /// it reached, and a drain leaves what it had not sent queued.
    #[error("the operation was stopped before it finished")]
    Canceled,
    #[error(
        "this folder's first sync waits for confirmation, and nothing is written or sent until it is given: `folders push` says what it will do, `folders confirm` lets it go, and `folders remove` drops it"
    )]
    FirstSyncWaiting,
    #[error("{0}")]
    Invalid(String),
}

/// One list drives the match and the set of codes, so a variant added to
/// `CoreError` fails to compile until it has a code, and the code then joins
/// `CODES`, which the command line's help is held to list.
macro_rules! codes {
    ($($kind:ident: $pattern:pat => $code:literal,)*) => {
        /// Every code `CoreError::code` answers, each once.
        pub const CODES: &[&str] = &[$($code),*];

        /// The classification a binding retains when it carries different
        /// fields from `CoreError`. Its code comes from the core's one list.
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum CoreErrorKind {
            $($kind,)*
        }

        impl CoreErrorKind {
            pub fn code(self) -> &'static str {
                match self {
                    $(Self::$kind => $code,)*
                }
            }
        }

        impl CoreError {
            pub fn kind(&self) -> CoreErrorKind {
                match self {
                    CoreError::RenewalFailed(cause) => cause.kind(),
                    $($pattern => CoreErrorKind::$kind,)*
                }
            }

            /// What a surface names the error by: the same word in the command
            /// line's envelope, in a Node error and anywhere else one is named.
            /// A failed renewal answers the code of its cause, as it carries
            /// the cause's refusal.
            pub fn code(&self) -> &'static str {
                self.kind().code()
            }
        }
    };
}

codes! {
    NotFound: CoreError::NotFound { .. } => "not_found",
    Unauthorized: CoreError::Unauthorized { .. } => "unauthorized",
    Forbidden: CoreError::Forbidden { .. } => "forbidden",
    Validation: CoreError::Validation { .. } => "validation",
    UnknownType: CoreError::UnknownType { .. } => "unknown_type",
    RateLimited: CoreError::RateLimited { .. } => "rate_limited",
    Server: CoreError::Server { .. } => "server",
    Io: CoreError::Io(_) => "io",
    Network: CoreError::Network(_) => "network",
    Unnamed: CoreError::Unnamed { .. } => "unnamed_answer",
    Decoding: CoreError::Decoding(_) => "decoding",
    Store: CoreError::Store(_) => "store",
    StorageFull: CoreError::StorageFull(_) => "storage_full",
    SignedOut: CoreError::SignedOut { .. } => "signed_out",
    NoKeychain: CoreError::NoKeychain(_) => "no_keychain",
    Redirected: CoreError::Redirected { .. } => "redirect",
    NoServer: CoreError::NoServer => "no_server",
    NoCursor: CoreError::NoCursor => "no_cursor",
    HydrationIncomplete: CoreError::HydrationIncomplete => "hydration_incomplete",
    NoCatalog: CoreError::NoCatalog => "no_catalog",
    ReadingHandle: CoreError::ReadingHandle => "reading_handle",
    WrongSchema: CoreError::WrongSchema { .. } => "wrong_schema",
    CopyExpired: CoreError::CopyExpired { .. } => "copy_expired",
    StreamIncomplete: CoreError::StreamIncomplete { .. } => "stream_incomplete",
    WrongServer: CoreError::WrongServer { .. } => "wrong_server",
    BytesAbsent: CoreError::BytesAbsent { .. } => "bytes_absent",
    ContractMismatch: CoreError::ContractMismatch { .. } => "contract_mismatch",
    Canceled: CoreError::Canceled => "canceled",
    FirstSyncWaiting: CoreError::FirstSyncWaiting => "first_sync_waiting",
    Invalid: CoreError::Invalid(_) => "invalid",
}

fn classified(kind: &str, code: Option<&str>, message: &str) -> String {
    if message.to_lowercase().starts_with(&format!("{kind}:")) {
        return message.into();
    }
    let classification = match code.filter(|code| code.replace('_', " ") != kind) {
        Some(code) => format!("{kind} ({code})"),
        None => kind.into(),
    };
    if message.is_empty() {
        classification
    } else {
        format!("{classification}: {message}")
    }
}

impl CoreError {
    /// Whether asking again can clear it. A 404 or a 405 cannot: it may come
    /// from a server that is not Marfa's.
    pub fn is_environmental(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_environmental(),
            CoreError::Io(_)
            | CoreError::StorageFull(_)
            | CoreError::Network(_)
            | CoreError::RateLimited { .. }
            | CoreError::Unnamed { .. } => true,
            CoreError::Server { status, .. } => *status >= 500 || *status == 408,
            _ => false,
        }
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            CoreError::RenewalFailed(cause) => cause.retry_after(),
            CoreError::RateLimited {
                retry_after_seconds: Some(seconds),
                ..
            }
            | CoreError::Unnamed {
                status: 429,
                retry_after_seconds: Some(seconds),
                ..
            } => Some(Duration::from_secs(*seconds).min(RETRY_AFTER_MOST)),
            _ => None,
        }
    }
}

/// Past this a server could park the client indefinitely. The server's webhook
/// delivery honors the same bound.
pub(crate) const RETRY_AFTER_MOST: Duration = Duration::from_secs(300);

fn contract_mismatch(
    origin: &str,
    served: Option<&str>,
    expected: u64,
    status: Option<u16>,
    write_sent: bool,
) -> String {
    let sent = if write_sent {
        ". The write was sent and may have taken effect, and it stays queued with no verdict"
    } else {
        ""
    };
    let answered = status.map_or_else(
        || "answered".to_string(),
        |status| format!("answered {status}"),
    );
    match served {
        Some(served) => format!(
            "{origin} {answered} on contract {served}, and this build of the core speaks contract {expected}, so the answer was not read: use a build for the server's contract{sent}"
        ),
        // Nothing here says the answer came from a Marfa server at all: a
        // captive portal or a mistyped URL answers the same way.
        None => format!(
            "{origin} {answered} naming no contract, so it may not be a Marfa server: check the URL. This build of the core speaks contract {expected}{sent}"
        ),
    }
}

/// Never advises deleting the store: only the build that made it can send
/// what it holds.
fn wrong_schema(path: &str, reason: &str, unsent: Option<u64>) -> String {
    let holds = match unsent {
        Some(0) => "Every write it holds the server has taken, so a store hydrated in its place loses nothing".to_string(),
        Some(count) => format!(
            "It holds {count} {} the server has not taken, waiting, blocked, refused or dead, which only the build that made it can send or show: open it with that build and drain or discard them before hydrating a new store",
            if count == 1 { "write" } else { "writes" }
        ),
        None => "Whether it holds writes the server has not taken cannot be read: open it with the build that made it and drain or discard them before hydrating a new store".to_string(),
    };
    format!("{path} was made by another build of the core: {reason}. {holds}")
}

impl From<rusqlite::Error> for CoreError {
    fn from(error: rusqlite::Error) -> Self {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull) {
            CoreError::StorageFull(error.to_string())
        } else {
            CoreError::Store(error.to_string())
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_has_a_code_and_every_code_is_listed_once() {
        assert_eq!(CoreError::Canceled.code(), "canceled");
        assert_eq!(CoreError::Canceled.kind(), CoreErrorKind::Canceled);
        let renewal = CoreError::RenewalFailed(Box::new(CoreError::NoServer));
        assert_eq!(renewal.code(), "no_server");
        let mut seen = std::collections::HashSet::new();
        for code in CODES {
            assert!(seen.insert(*code), "{code} is listed twice");
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{code} is not snake case"
            );
        }
        // The witness: a code a variant answers is in the list.
        assert!(
            CODES.contains(
                &CoreError::BytesAbsent {
                    hash: String::new(),
                    reason: String::new()
                }
                .code()
            )
        );
    }

    #[test]
    fn server_refusal_display_does_not_repeat_its_classification() {
        let unknown = CoreError::UnknownType {
            message: "Unknown type: acme.missing".into(),
        };
        assert_eq!(unknown.to_string(), "Unknown type: acme.missing");
        let unauthorized = CoreError::Unauthorized {
            code: "unauthorized".into(),
            message: "Authentication required".into(),
        };
        assert_eq!(
            unauthorized.to_string(),
            "unauthorized: Authentication required"
        );
        assert!(!unauthorized.is_environmental());
        let validation = CoreError::Validation {
            code: "invalid_properties".into(),
            message: "read: Expected boolean".into(),
        };
        assert_eq!(
            validation.to_string(),
            "validation (invalid_properties): read: Expected boolean"
        );
    }

    #[test]
    fn sqlite_full_is_environmental_without_reclassifying_store_faults() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA max_page_count = 2; CREATE TABLE filling(bytes BLOB);")
            .unwrap();
        let failure = conn
            .execute("INSERT INTO filling VALUES (zeroblob(16384))", [])
            .unwrap_err();
        assert_eq!(
            failure.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DiskFull)
        );
        assert!(CoreError::from(failure).is_environmental());
        assert!(!CoreError::from(rusqlite::Error::InvalidQuery).is_environmental());
    }

    #[test]
    fn a_rate_limit_is_environmental_and_names_its_wait_up_to_the_bound() {
        let limited = |seconds| CoreError::RateLimited {
            code: "rate_limited".into(),
            message: String::new(),
            retry_after_seconds: seconds,
        };
        assert!(limited(None).is_environmental());
        assert_eq!(limited(None).retry_after(), None);
        assert_eq!(limited(Some(7)).retry_after(), Some(Duration::from_secs(7)));
        assert_eq!(RETRY_AFTER_MOST, Duration::from_secs(300));
        assert_eq!(limited(Some(86_400)).retry_after(), Some(RETRY_AFTER_MOST));
        let answered = |status| CoreError::Server {
            status,
            code: String::new(),
            message: String::new(),
        };
        assert!(answered(503).is_environmental());
        assert!(answered(408).is_environmental());
        assert!(!answered(405).is_environmental());
        let refused = CoreError::Forbidden {
            code: "type_not_permitted".into(),
            message: String::new(),
        };
        assert!(!refused.is_environmental());
        assert_eq!(refused.retry_after(), None);
    }
}
