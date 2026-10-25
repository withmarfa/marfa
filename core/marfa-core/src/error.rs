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
        /// The envelope's `error.details`, supplied only by a caller that
        /// read the envelope itself; `Http` does not read them.
        details: Option<Box<serde_json::Value>>,
    },
    #[error("{0}")]
    Io(String),
    /// The words are the whole message and do not repeat the code `network`,
    /// which a surface that prints a code beside a message would show twice.
    #[error("{0}")]
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
    #[error(
        "the working copy is not whole: wait for the hydration under way to complete, or hydrate again"
    )]
    HydrationIncomplete,
    #[error("this working copy has never held the server's type catalog; hydrate first")]
    NoCatalog,
    #[error(
        "this is a reading handle: another process holds the writer handle for this store, and one store has one writer"
    )]
    ReadingHandle,
    #[error("{}", wrong_schema(path, reason, *unsent, folder.as_ref()))]
    WrongSchema {
        path: String,
        reason: String,
        /// Writes in the store the server has not taken, waiting, blocked,
        /// refused or dead. In a folder's store, the writes still to be sent,
        /// each dead write, each refused write but one of a change the folder
        /// records against a file to an item a file is bound to, and each
        /// answered write a file's state still waits on. `None` where they
        /// cannot be read.
        unsent: Option<u64>,
        /// Where the store is a folder's, what this build's folder commands
        /// can do with it.
        folder: Option<FolderStore>,
    },
    /// A removal of a store was refused, leaving it as it was, because the
    /// writes it holds that the server has not taken are not the number the
    /// caller agreed to lose.
    #[error("{}", unsent_differs(path, *unsent, *agreed))]
    UnsentDiffers {
        path: String,
        /// The writes the store holds that the server has not taken, as
        /// `WrongSchema` counts them; `None` where they cannot be counted.
        unsent: Option<u64>,
        /// The count the caller agreed to lose.
        agreed: u64,
    },
    /// The cursor is dropped, so the copy reports itself expired until a
    /// hydration, which keeps the queue.
    #[error("{}", copy_expired(reason))]
    CopyExpired { reason: String },
    #[error("the event stream ended early: {reason}")]
    StreamIncomplete { reason: String },
    #[error("this file belongs to {expected}, not {got}")]
    WrongServer { expected: String, got: String },
    #[error("the bytes of {hash} are not held here and cannot be fetched: {reason}")]
    BytesAbsent { hash: String, reason: String },
    #[error(
        "the {size} bytes of {hash} would not fit: {free} bytes are free on the volume that holds the file cache"
    )]
    NoRoom { hash: String, size: u64, free: u64 },
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
    /// hydration left unfinished answers lists and searches marked partial,
    /// and takes writes only to the rows it holds and new ones, and no edge writes, until a hydration completes (the next one of the same slice carries on from the page it reached where it can), a catch-up keeps the cursor it reached, and a drain leaves what it had not sent queued, and an
    /// upload or keyed write it had in flight queued as sent, under its key,
    /// for the next drain to send again.
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
    UnsentDiffers: CoreError::UnsentDiffers { .. } => "unsent_differs",
    CopyExpired: CoreError::CopyExpired { .. } => "copy_expired",
    StreamIncomplete: CoreError::StreamIncomplete { .. } => "stream_incomplete",
    WrongServer: CoreError::WrongServer { .. } => "wrong_server",
    BytesAbsent: CoreError::BytesAbsent { .. } => "bytes_absent",
    NoRoom: CoreError::NoRoom { .. } => "no_room",
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

/// What this build's folder commands can do with a folder's store that
/// another build of the core made, once it holds nothing unsent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderStore {
    /// It names the folder and every table of the folder's own is of this
    /// build's shape, so the folder's next push, pull, scan or watch replaces
    /// it, carrying them.
    Replaceable,
    /// It names no folder, so only `folders add` replaces it.
    Unnamed,
    /// The named table of the folder's own is of another shape, so this
    /// build cannot carry it.
    Uncarried(String),
}

/// Never advises deleting the store: only the build that made it can send
/// what it holds.
fn wrong_schema(
    path: &str,
    reason: &str,
    unsent: Option<u64>,
    folder: Option<&FolderStore>,
) -> String {
    let writes = |count: u64| if count == 1 { "write" } else { "writes" };
    let holds = match (unsent, folder) {
        (Some(0), None) => "Every write it holds the server has taken, so a store hydrated in its place loses nothing".to_string(),
        (Some(0), Some(FolderStore::Replaceable)) => "It holds no write still to be sent and no answer the folder has yet to record, so the folder's next push, pull, scan or watch replaces it with a store of this build's shape that keeps what the folder records of each file, and fills that from the server; the replacement changes none of the folder's files".to_string(),
        (Some(0), Some(FolderStore::Unnamed)) => "It holds no write still to be sent, but it names no folder, so no push, pull, scan or watch replaces it: add the folder again (`marfa folders add`), which replaces it".to_string(),
        (Some(0), Some(FolderStore::Uncarried(table))) => format!(
            "It holds no write still to be sent and no answer the folder has yet to record, but its table {table}, part of what the folder records of its files, is not of a shape this build can keep, so this build leaves the store and the folder's files as they are: with the build that made the store, remove the folder (`marfa folders remove`, which leaves its files), then add it again with this build"
        ),
        (Some(count), None) => format!(
            "It holds {count} {} the server has not taken, waiting, blocked, refused or dead, which only the build that made it can send or show: open it with that build and drain or discard them before hydrating a new store",
            writes(count)
        ),
        (Some(count), Some(FolderStore::Replaceable)) => format!(
            "It holds {count} {} still to be sent or whose answer the folder has yet to record, which only the build that made it can send or record, so this build leaves the store and the folder's files as they are: with the build that made the store, push the folder (`marfa folders push`, after `marfa folders confirm` where its first sync waits), and once the store holds none, this build replaces it. A write the server refused or gave up on that the push leaves goes only with the folder: with the build that made the store, remove the folder (`marfa folders remove`, which leaves its files), then add it again with this build. The removal drops that write, so a file whose deletion the server never took comes back when the folder is added again, and must be deleted again",
            writes(count)
        ),
        (Some(count), Some(_)) => format!(
            "It holds {count} {} still to be sent or whose answer the folder has yet to record, which only the build that made it can send or record, so this build leaves the store and the folder's files as they are: with the build that made the store, push the folder (`marfa folders push`) and remove it (`marfa folders remove`, which leaves its files), then add it again with this build",
            writes(count)
        ),
        (None, None) => "Whether it holds writes the server has not taken cannot be read: open it with the build that made it and drain or discard them before hydrating a new store".to_string(),
        (None, Some(_)) => "Whether it holds writes still to be sent cannot be read, so this build leaves the store and the folder's files as they are: with the build that made the store, push the folder (`marfa folders push`) and remove it (`marfa folders remove`, which leaves its files), then add it again with this build".to_string(),
    };
    format!("{path} was made by another build of the core: {reason}. {holds}")
}

fn unsent_differs(path: &str, unsent: Option<u64>, agreed: u64) -> String {
    let writes = |count: u64| if count == 1 { "write" } else { "writes" };
    match unsent {
        Some(count) => format!(
            "{path} was not removed: it holds {count} {} the server has not taken, not the {agreed} agreed to; show the person the {count} and remove it with that count once they agree",
            writes(count)
        ),
        None => format!(
            "{path} was not removed: whether it holds writes the server has not taken cannot be read, so it cannot be known what removing it would lose"
        ),
    }
}

/// What an expired copy says, with the advice that fits why it expired. The
/// reason is a code for the causes the core names and a sentence for the
/// rest, so a person is never shown a bare code, nor the name of an internal
/// step. A rebuild keeps the writes not yet sent.
fn copy_expired(reason: &str) -> String {
    let cause_and_advice = match reason {
        "credential_ended" => {
            "the credential it reads with has ended; sign in or approve this app again, or use a new key, then rebuild the copy from the server (changes not yet sent are kept)".to_string()
        }
        "reach_changed" => "what the credential may read, or how the server arranges items and types, has changed; rebuild the copy from the server (changes not yet sent are kept)".to_string(),
        crate::http::INSTANCE_CHANGED => {
            "another Marfa now answers at this address; rebuild the copy from it (changes not yet sent are kept, held until released or withdrawn)".to_string()
        }
        crate::catch_up::CATCHUP_TOO_OLD => "the server's event log no longer holds the point this copy had reached; refill the copy from the server, which keeps what it holds and the changes not yet sent".to_string(),
        "reach_invalid" => "this copy holds no proof it can accept of what the credential may read; rebuild the copy from the server".to_string(),
        "slice_changed" => "the types, tier or edge types asked for are not the ones it holds, so it cannot be filled again in place; rebuild the copy from the server (changes not yet sent are kept)".to_string(),
        "head_past_log" => "the server's event log ends before the point this copy had reached, as after a restore from a backup, so it cannot be filled again in place; rebuild the copy from the server (changes not yet sent are kept)".to_string(),
        crate::hydrate::NOT_STALE => {
            return format!(
                "this working copy is not waiting to be filled again in place ({reason}), so nothing was filled; hydrate it without asking for a fill in place"
            );
        }
        sentence => {
            return format!(
                "this working copy can no longer be kept current: {sentence}; rebuild the copy from the server"
            );
        }
    };
    format!("this working copy can no longer be kept current ({reason}): {cause_and_advice}")
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

/// An answer that does not read, named by where it came from. Serde's text
/// for a value of the wrong type quotes the value, so only a syntax error or
/// a missing field is repeated; another is named by what it fails to be. A
/// position is given where serde knows one: a value already parsed has none.
pub(crate) fn unreadable(what: &str, error: &serde_json::Error) -> CoreError {
    use serde_json::error::Category;
    let why = match error.classify() {
        Category::Data if !error.to_string().starts_with("missing field") => {
            let mut why = String::from("not the shape the contract describes");
            if error.line() > 0 {
                why.push_str(&format!(
                    " at line {} column {}",
                    error.line(),
                    error.column()
                ));
            }
            why
        }
        _ => error.to_string(),
    };
    CoreError::Decoding(format!("{what}: {why}"))
}

impl From<url::ParseError> for CoreError {
    fn from(error: url::ParseError) -> Self {
        CoreError::Invalid(format!("invalid url: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(reason: &str) -> String {
        CoreError::CopyExpired {
            reason: reason.into(),
        }
        .to_string()
    }

    #[test]
    fn an_expired_copy_says_what_to_do_for_the_reason_it_expired() {
        let ended = said("credential_ended");
        assert!(
            ended.contains("sign in or approve this app again, or use a new key")
                && ended.contains("then rebuild the copy from the server"),
            "{ended}"
        );
        let changed = said("reach_changed");
        assert!(
            changed.contains("what the credential may read")
                && changed.contains("rebuild the copy from the server")
                && changed.contains("not yet sent are kept"),
            "{changed}"
        );
        assert!(
            !changed.contains("sign in"),
            "a changed reach needs no new approval: {changed}"
        );
        let other = said("instance_changed");
        assert!(other.contains("another Marfa now answers"), "{other}");
        let invalid = said("reach_invalid");
        assert!(
            invalid.contains("holds no proof it can accept"),
            "{invalid}"
        );
        let aged = said("catchup_too_old");
        assert!(aged.contains("keeps what it holds"), "{aged}");
        // The reason is named, so a caller can tell why the copy expired.
        for reason in [
            "credential_ended",
            "reach_changed",
            "instance_changed",
            "reach_invalid",
            "catchup_too_old",
        ] {
            assert!(said(reason).contains(&format!("({reason})")), "{reason}");
        }
        // A reason that is a sentence is shown as it is.
        let sentence = said("the server's event log ends at 5");
        assert!(
            sentence
                .ends_with("the server's event log ends at 5; rebuild the copy from the server"),
            "{sentence}"
        );
    }

    #[test]
    fn an_expired_copy_never_shows_the_word_hydrate_to_a_person() {
        for reason in [
            "credential_ended",
            "reach_changed",
            "reach_invalid",
            "instance_changed",
            "catchup_too_old",
            "the event log no longer holds the cursor 4",
        ] {
            let text = said(reason);
            assert!(!text.to_lowercase().contains("hydrat"), "{text}");
            assert_eq!(
                CoreError::CopyExpired {
                    reason: reason.into()
                }
                .code(),
                "copy_expired"
            );
        }
    }

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
            details: None,
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

    #[test]
    fn an_answer_that_does_not_read_is_named_without_repeating_what_it_said() {
        #[derive(serde::Deserialize, Debug)]
        struct Row {
            #[allow(dead_code)]
            count: u32,
        }
        let message = |text: &str| match serde_json::from_str::<Row>(text) {
            Err(error) => match unreadable("/rows", &error) {
                CoreError::Decoding(message) => message,
                other => panic!("{other:?}"),
            },
            Ok(row) => panic!("{row:?}"),
        };
        let quoted = message(r#"{"count":"private words"}"#);
        assert!(quoted.starts_with("/rows: "), "{quoted}");
        assert!(!quoted.contains("private words"), "{quoted}");
        // The witness: serde's own text for this does quote the value.
        let own = serde_json::from_str::<Row>(r#"{"count":"private words"}"#)
            .unwrap_err()
            .to_string();
        assert!(own.contains("private words"), "{own}");
        assert!(quoted.contains("at line 1 column"), "{quoted}");
        assert!(message("{}").contains("missing field `count`"));
        assert!(message(r#"{"count":"#).contains("EOF"));

        // A value parsed already has no position, and none is made up.
        let parsed = serde_json::from_value::<Row>(serde_json::json!({"count": "private words"}))
            .unwrap_err();
        let CoreError::Decoding(text) = unreadable("edge type 2", &parsed) else {
            panic!("not a decoding failure");
        };
        assert!(text.starts_with("edge type 2: not the shape"), "{text}");
        assert!(
            !text.contains("line 0") && !text.contains("private words"),
            "{text}"
        );
    }
}
