use std::io;

use marfa_core::{CatchUpFailed, CoreError, ERROR_CODES};

/// Agents read the exit code and the code string. The help and the command
/// reference list the codes from the lists they are made from, and each exit
/// code with its `Exit::meaning`.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Core(CoreError),
    /// Named by its cause; the envelope adds whether the catch-up changed the
    /// catalog the copy holds before it failed, which the copy keeps.
    #[error(
        "{error}{}",
        if *catalog_changed { "; the catalog this copy holds changed before the catch-up failed" } else { "" }
    )]
    CatchUp {
        error: Box<CliError>,
        catalog_changed: bool,
    },
    #[error("{0}")]
    Io(io::Error),
    #[error("{0} is not in the local copy")]
    NotHeld(String),
    /// The core's `ReadingHandle`, said of the folder rather than its store.
    #[error("{}", marfa_core::folder::held_by_another(.0))]
    FolderHeld(std::path::PathBuf),
    /// `FolderHeld`, for a command that asked the process holding the folder
    /// to let it go and waited.
    #[error("{}", marfa_core::folder::not_handed_over(.0))]
    FolderNotHandedOver(std::path::PathBuf),
    #[error("{0}")]
    Watch(String),
    #[error("output closed")]
    ClosedOutput,
    /// The status and the server's own code are both kept, because neither
    /// classifies alone.
    #[error(
        "the server refused ({status} {code}): {message}{}",
        details_suffix(details)
    )]
    Refused {
        status: u16,
        code: String,
        message: String,
        retry_after_seconds: Option<u64>,
        details: Option<Box<serde_json::Value>>,
    },
    #[error("{0}")]
    Usage(String),
    #[error("no working copy named: pass --db or set MARFA_DB")]
    NoStoreNamed,
    #[error(
        "no working copy at {}: `device hydrate` or `device status` makes one there",
        .0.display()
    )]
    NoStoreAt(std::path::PathBuf),
    #[error("no server named: pass --url or set MARFA_API_URL")]
    NoServerNamed,
    #[error(
        "a key from --key or MARFA_API_KEY needs its server named: pass --url or set MARFA_API_URL"
    )]
    NoServerForKey,
    #[error("no credential for {origin}: {}", crate::credentials::advice())]
    NoCredential { origin: String },
    #[error("the keychain cannot be used: {0}")]
    NoKeychain(String),
    #[error("signed out of {origin}: run `marfa login`")]
    SignedOut { origin: String },
    /// A stream's closing frame says so on a `200`, so the envelope names no
    /// server status.
    #[error(
        "the credential that holds this stream has ended: sign in again with `marfa login`, or use a new key"
    )]
    CredentialEnded,
    #[error("{0}")]
    Invalid(String),
    /// An export written whole but for the blobs its manifest names as
    /// missing.
    #[error(
        "the archive lacks {} blob(s), which its manifest lists under missing_blobs: {}; it holds everything else it names",
        .0.len(),
        hash_list(.0)
    )]
    ArchiveLacksBlobs(Vec<String>),
    /// An export to a file, written whole but for the blobs its manifest names
    /// as missing, and kept beside the path it was meant for instead of at it.
    #[error("{}", archive_kept_apart(.missing, .target, .incomplete, .kept, *.target_held, .refused.as_deref()))]
    ArchiveKeptApart {
        missing: Vec<String>,
        target: std::path::PathBuf,
        /// Where the archive belongs: `<target>.incomplete`.
        incomplete: std::path::PathBuf,
        /// Where the archive is: `incomplete`, or the partial file when the
        /// move to `incomplete` was refused.
        kept: std::path::PathBuf,
        target_held: bool,
        /// Why the move to `incomplete` was refused, when it was.
        refused: Option<String>,
    },
    /// A restore that wrote what the archive carries, of an archive that
    /// lacks blobs it names.
    #[error(
        "{} blob(s) the archive names are in neither the archive nor this instance: {}; `marfa blobs upload` with their bytes restores them",
        .0.len(),
        hash_list(.0)
    )]
    RestoreLacksBlobs(Vec<String>),
    #[error(
        "{origin} {}; this binary was built for contract {expected}: use a marfa built for the server's contract{}",
        contract_said(served.as_deref(), *status),
        if *write_sent { ". The write was sent, and may have taken effect before its answer was refused" } else { "" }
    )]
    ContractMismatch {
        origin: String,
        served: Option<String>,
        expected: u64,
        write_sent: bool,
        /// For a write, a 201 and a 409 say different things about whether
        /// it took effect.
        status: Option<u16>,
    },
    /// Not `Refused`: the docs site is not a Marfa server, so the envelope
    /// names no server status or code.
    #[error(
        "no docs page at {path}: `marfa docs search` finds pages and `marfa docs topics` lists them"
    )]
    DocsPageNotFound { path: String },
    #[error("cannot read the docs site at {address}: {reason}")]
    DocsUnreachable { address: String, reason: String },
    #[error(
        "{origin} answered {status}, a redirect to {}: name that address instead",
        location.as_deref().unwrap_or("nowhere it named")
    )]
    Redirected {
        origin: String,
        status: u16,
        location: Option<String>,
    },
}

impl CliError {
    /// For an error from a command's own request, where a mismatch is
    /// worded for the CLI. A device command keeps the core's own
    /// words, which say what became of a queued write.
    pub fn direct(error: CoreError) -> Self {
        match error {
            CoreError::ContractMismatch {
                origin,
                served,
                expected,
                write_sent,
                status,
            } => Self::ContractMismatch {
                origin,
                served,
                expected,
                write_sent,
                status,
            },
            other => Self::from(other),
        }
    }
}

impl From<CoreError> for CliError {
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::RenewalFailed(cause) => match *cause {
                CoreError::Server {
                    status,
                    code,
                    message,
                    details,
                } => Self::Refused {
                    status,
                    code,
                    message,
                    retry_after_seconds: None,
                    details,
                },
                CoreError::RateLimited {
                    code,
                    message,
                    retry_after_seconds,
                } => Self::Refused {
                    status: 429,
                    code,
                    message,
                    retry_after_seconds,
                    details: None,
                },
                CoreError::SignedOut { origin } => Self::SignedOut { origin },
                CoreError::NoKeychain(reason) => Self::NoKeychain(reason),
                other => Self::direct(other),
            },
            CoreError::Redirected {
                origin,
                status,
                location,
            } => Self::Redirected {
                origin,
                status,
                location,
            },
            // The credential that held a stream has ended: a new one is the
            // way on, and a retry with this one is not.
            CoreError::StreamIncomplete { reason } if reason == "credential_ended" => {
                Self::CredentialEnded
            }
            other => Self::Core(other),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Done = 0,
    Refused = 1,
    Usage = 2,
    Environment = 3,
    Local = 4,
    Credential = 5,
    /// Never the exit of a refusal: the status a shell gives a process that
    /// died of Ctrl-C.
    Interrupted = 130,
}

impl Exit {
    /// Every exit code, in the order the help lists them.
    pub const ALL: [Exit; 7] = [
        Exit::Done,
        Exit::Refused,
        Exit::Usage,
        Exit::Environment,
        Exit::Local,
        Exit::Credential,
        Exit::Interrupted,
    ];

    /// What the code tells an agent, as the help and the command reference say it.
    pub fn meaning(self) -> &'static str {
        match self {
            Exit::Done => "done",
            Exit::Refused => {
                "the request was refused, by the server (a wrong or spent setup code included), by the CLI before sending, for an answer on another contract, or for a docs page that does not exist, or the archive of an export or a restore lacks blobs it names; a retry does not change it"
            }
            Exit::Usage => "the command line was wrong, or named no store or server",
            Exit::Environment => {
                "the environment failed (unreachable, timed out, a 5xx, a 429, an answer naming no contract, full local storage, a docs site that cannot be read); try again"
            }
            Exit::Local => {
                "the working copy or the queue refused under the device rules, or the keychain cannot be used (locked, missing, unreadable, or none on this system)"
            }
            Exit::Credential => {
                "no credential, the credential was refused, or the sign-in ended; `marfa login` starts one"
            }
            Exit::Interrupted => {
                "a long-lived command (`folders watch`, `events`, `device changes`) was ended by Ctrl-C, or a second Ctrl-C ended a command that was still stopping"
            }
        }
    }
}

/// The core's own errors are named by `CoreError::code`; this names the rest.
/// One list drives the match and `OWN_CODES`, so a variant added here fails to
/// compile until it has a code, and the code then joins what the help lists.
macro_rules! own_codes {
    ($($pattern:pat => $code:literal,)*) => {
        const OWN_CODES: &[&str] = &[$($code),*];

        impl CliError {
            pub fn code(&self) -> &'static str {
                match self {
                    CliError::Core(core) => core.code(),
                    CliError::CatchUp { error, .. } => error.code(),
                    CliError::Refused { status, .. } => refused_code(*status),
                    $($pattern => $code,)*
                }
            }
        }
    };
}

own_codes! {
    CliError::Io(_) => "io",
    CliError::NotHeld(_) => "not_held",
    CliError::FolderHeld(_) | CliError::FolderNotHandedOver(_) => "reading_handle",
    CliError::Watch(_) => "watch",
    CliError::ClosedOutput => "closed_output",
    CliError::Usage(_) => "usage",
    CliError::NoStoreNamed | CliError::NoStoreAt(_) => "no_store",
    CliError::NoServerNamed | CliError::NoServerForKey => "no_server",
    CliError::NoCredential { .. } => "no_credential",
    CliError::NoKeychain(_) => "no_keychain",
    CliError::SignedOut { .. } => "signed_out",
    CliError::CredentialEnded => "unauthorized",
    CliError::Invalid(_) => "invalid",
    CliError::ArchiveLacksBlobs(_)
    | CliError::ArchiveKeptApart { .. }
    | CliError::RestoreLacksBlobs(_) => "blobs_missing",
    CliError::ContractMismatch { .. } => "contract_mismatch",
    CliError::Redirected { .. } => "redirect",
    CliError::DocsPageNotFound { .. } => "docs_page_not_found",
    CliError::DocsUnreachable { .. } => "docs_unreachable",
}

/// What the server's own refusal is named by, from its status.
pub(crate) fn refused_code(status: u16) -> &'static str {
    match status {
        400 | 422 => "validation",
        401 => "unauthorized",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        413 => "too_large",
        429 => "rate_limited",
        _ => "server",
    }
}

/// Every name `refused_code` answers.
pub(crate) const REFUSED_CODES: &[&str] = &[
    "validation",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "too_large",
    "rate_limited",
    "server",
];

/// Every code a refusal on stderr can carry, each once: the core's, then the
/// binary's own. `closed_output` is left out, as nothing is printed for it.
pub fn codes() -> Vec<&'static str> {
    let mut codes: Vec<&'static str> = Vec::new();
    for code in ERROR_CODES
        .iter()
        .chain(OWN_CODES)
        .chain(REFUSED_CODES)
        .filter(|code| **code != "closed_output")
    {
        if !codes.contains(code) {
            codes.push(code);
        }
    }
    codes
}

impl CliError {
    pub fn exit(&self) -> Exit {
        match self {
            CliError::CatchUp { error, .. } => error.exit(),
            CliError::Core(core) => match core {
                CoreError::RenewalFailed(cause) => CliError::from(*cause.clone()).exit(),
                CoreError::Redirected { .. }
                | CoreError::NotFound { .. }
                | CoreError::Forbidden { .. }
                | CoreError::Validation { .. }
                | CoreError::UnknownType { .. }
                | CoreError::ContractMismatch { .. }
                | CoreError::FirstSyncWaiting
                | CoreError::Invalid(_) => Exit::Refused,
                CoreError::Unauthorized { .. } | CoreError::SignedOut { .. } => Exit::Credential,
                CoreError::Io(_)
                | CoreError::StorageFull(_)
                | CoreError::RateLimited { .. }
                | CoreError::Server { .. }
                | CoreError::Network(_)
                | CoreError::Unnamed { .. }
                | CoreError::Decoding(_)
                | CoreError::StreamIncomplete { .. }
                | CoreError::BytesAbsent { .. }
                | CoreError::Canceled => Exit::Environment,
                CoreError::NoKeychain(_)
                | CoreError::Store(_)
                | CoreError::NoServer
                | CoreError::NoCursor
                | CoreError::HydrationIncomplete
                | CoreError::NoCatalog
                | CoreError::ReadingHandle
                | CoreError::WrongSchema { .. }
                | CoreError::CopyExpired { .. }
                | CoreError::WrongServer { .. } => Exit::Local,
            },
            CliError::Io(_) | CliError::Watch(_) | CliError::DocsUnreachable { .. } => {
                Exit::Environment
            }
            CliError::NotHeld(_)
            | CliError::Invalid(_)
            | CliError::ArchiveLacksBlobs(_)
            | CliError::ArchiveKeptApart { .. }
            | CliError::RestoreLacksBlobs(_)
            | CliError::DocsPageNotFound { .. }
            | CliError::ContractMismatch { .. }
            | CliError::Redirected { .. } => Exit::Refused,
            CliError::ClosedOutput => Exit::Done,
            CliError::Refused { status, code, .. } => match status {
                401 if code == "setup_proof_invalid" => Exit::Refused,
                401 => Exit::Credential,
                429 => Exit::Environment,
                500.. => Exit::Environment,
                _ => Exit::Refused,
            },
            CliError::Usage(_)
            | CliError::NoStoreNamed
            | CliError::NoStoreAt(_)
            | CliError::NoServerNamed
            | CliError::NoServerForKey => Exit::Usage,
            CliError::NoCredential { .. }
            | CliError::SignedOut { .. }
            | CliError::CredentialEnded => Exit::Credential,
            CliError::NoKeychain(_)
            | CliError::FolderHeld(_)
            | CliError::FolderNotHandedOver(_) => Exit::Local,
        }
    }

    fn server(&self) -> Option<(Option<u16>, Option<&str>, Option<&serde_json::Value>)> {
        match self {
            CliError::CatchUp { error, .. } => error.server(),
            CliError::Core(core) => match core {
                CoreError::NotFound { code, .. } => Some((Some(404), Some(code), None)),
                CoreError::Unauthorized { code, .. } => Some((Some(401), Some(code), None)),
                CoreError::Forbidden { code, .. } => Some((Some(403), Some(code), None)),
                // The variant folds 400 and 422 together, so no status.
                CoreError::Validation { code, .. } => Some((None, Some(code), None)),
                CoreError::UnknownType { .. } => Some((Some(400), Some("unknown_type"), None)),
                CoreError::RateLimited { code, .. } => Some((Some(429), Some(code), None)),
                CoreError::Server { status, code, .. } => Some((Some(*status), Some(code), None)),
                CoreError::ContractMismatch {
                    status: Some(status),
                    ..
                }
                | CoreError::Unnamed { status, .. }
                | CoreError::Redirected { status, .. } => Some((Some(*status), None, None)),
                _ => None,
            },
            CliError::Refused {
                status,
                code,
                details,
                ..
            } => Some((Some(*status), Some(code), details.as_deref())),
            // The body, and so the code, was not read.
            CliError::ContractMismatch {
                status: Some(status),
                ..
            }
            | CliError::Redirected { status, .. } => Some((Some(*status), None, None)),
            _ => None,
        }
    }

    fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            CliError::CatchUp { error, .. } => error.retry_after_seconds(),
            CliError::Core(CoreError::RateLimited {
                retry_after_seconds,
                ..
            }) => *retry_after_seconds,
            CliError::Refused {
                retry_after_seconds,
                ..
            } => *retry_after_seconds,
            _ => None,
        }
    }

    pub fn envelope(&self) -> serde_json::Value {
        let server = self
            .server()
            .map(|(status, code, details)| serde_json::json!({ "status": status, "code": code, "details": details }));
        let mut envelope = serde_json::json!({
            "error": {
                "code": self.code(),
                "message": self.to_string(),
                "server": server,
                "retry_after_seconds": self.retry_after_seconds(),
            },
            "exit": self.exit() as u8,
        });
        if let CliError::CatchUp {
            catalog_changed, ..
        } = self
        {
            envelope["catalog_changed"] = (*catalog_changed).into();
        }
        envelope
    }
}

fn contract_said(served: Option<&str>, status: Option<u16>) -> String {
    match served {
        Some(served) => format!("answers contract {served}"),
        None => status.map_or_else(
            || "answers no contract at its root".into(),
            |status| format!("answered {status} naming no contract"),
        ),
    }
}

/// The message of an archive kept beside its path: what it lacks, where it
/// is, and whether the path was left alone.
fn archive_kept_apart(
    missing: &[String],
    target: &std::path::Path,
    incomplete: &std::path::Path,
    kept: &std::path::Path,
    target_held: bool,
    refused: Option<&str>,
) -> String {
    let place = match refused {
        None => format!("it is kept at {}", kept.display()),
        Some(reason) => format!(
            "it could not be moved to {}: {reason}; it is kept at {}",
            incomplete.display(),
            kept.display()
        ),
    };
    let path = if target_held {
        format!(
            "{} still holds the file that was there before",
            target.display()
        )
    } else {
        format!(
            "nothing was written to {}, so nothing there lacks files",
            target.display()
        )
    };
    format!(
        "the archive lacks {} blob(s), which its manifest lists under missing_blobs: {}; it holds everything else it names, so {place}, and {path}",
        missing.len(),
        hash_list(missing)
    )
}

/// The first few hashes, and how many more: a message names what is
/// missing without growing with an instance that lost every file.
fn hash_list(hashes: &[String]) -> String {
    const SHOWN: usize = 10;
    let shown = hashes[..hashes.len().min(SHOWN)].join(", ");
    match hashes.len().saturating_sub(SHOWN) {
        0 => shown,
        more => format!("{shown} and {more} more"),
    }
}

fn details_suffix(details: &Option<Box<serde_json::Value>>) -> String {
    match details {
        Some(details) => format!(" {details}"),
        None => String::new(),
    }
}

impl From<CatchUpFailed> for CliError {
    fn from(failed: CatchUpFailed) -> Self {
        CliError::CatchUp {
            error: Box::new(failed.error.into()),
            catalog_changed: failed.catalog_changed,
        }
    }
}

impl From<io::Error> for CliError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::BrokenPipe {
            CliError::ClosedOutput
        } else {
            CliError::Io(error)
        }
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        CliError::Io(error.into())
    }
}

/// How a drain's report sets the exit code, said after the exit codes.
pub const DRAIN_EXITS: &str = "A device drain prints its complete report on stdout: 0 for a completed pass (including refused writes), 3 for undelivered writes or an unavailable pass, and 5 for a credential-stopped pass. A report exit prints no additional refusal on stderr. Refused verdicts have a separate plain-text count.";

/// What a failed catch-up adds to its refusal, said after the drain.
pub const CATCH_UP_FAILED: &str = "A device catch-up that fails says whether it had changed the catalog the copy holds, which the copy keeps; with --json, as \"catalog_changed\" beside \"exit\".";

/// The refusal `--json` prints, said after the drain and the catch-up: what
/// it is, its shape, and the words before the codes its `error.code` can be.
pub const JSON_REFUSAL: &str = "With --json a refusal is one JSON object on stderr:";
pub const JSON_REFUSAL_SHAPE: &str = r#"{"error":{"code":...,"message":...,"server":{"status":...,"code":...,"details":...}|null,"retry_after_seconds":...},"exit":N}"#;
pub const JSON_REFUSAL_CODES: &str = "where error.code is one of:";

/// The width the help wraps an exit code's meaning to, continuing under its first word.
const MEANING_WIDTH: usize = 70;

/// The exit codes and every code a refusal can carry, the second read from
/// the lists the codes are made from rather than written out again.
pub fn exit_codes_help() -> &'static str {
    static HELP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HELP.get_or_init(|| {
        let mut help = String::from("Exit codes:\n");
        for exit in Exit::ALL {
            let mut line = format!("  {}  ", exit as u8);
            let indent = line.len();
            let mut first = true;
            for word in exit.meaning().split(' ') {
                if !first && line.len() + 1 + word.len() > MEANING_WIDTH {
                    help.push_str(&line);
                    help.push('\n');
                    line = " ".repeat(indent);
                } else if !first {
                    line.push(' ');
                }
                line.push_str(word);
                first = false;
            }
            help.push_str(&line);
            help.push('\n');
        }
        let codes = codes().join(", ");
        help.push_str(&format!(
            "\n{DRAIN_EXITS}\n\n{CATCH_UP_FAILED}\n\n{JSON_REFUSAL}\n  {JSON_REFUSAL_SHAPE}\n{JSON_REFUSAL_CODES} {codes}."
        ));
        help
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(status: u16) -> CliError {
        CliError::Refused {
            status,
            code: "code".into(),
            message: String::new(),
            retry_after_seconds: None,
            details: None,
        }
    }

    #[test]
    fn a_refused_setup_proof_is_a_refusal_and_not_a_credential_problem() {
        let wrong_code = CliError::Refused {
            status: 401,
            code: "setup_proof_invalid".into(),
            message: "Setup proof is invalid, expired, spent or replaced".into(),
            retry_after_seconds: None,
            details: None,
        };
        assert_eq!(wrong_code.exit(), Exit::Refused);
        assert_eq!(wrong_code.envelope()["exit"], 1);
        assert_eq!(
            wrong_code.envelope()["error"]["server"]["code"],
            "setup_proof_invalid"
        );
        assert_eq!(refused(401).exit(), Exit::Credential);
    }

    #[test]
    fn a_stream_the_credential_ended_is_refused_as_a_credential_for_every_command() {
        let ended = CliError::from(CoreError::StreamIncomplete {
            reason: "credential_ended".into(),
        });
        assert_eq!(ended.code(), "unauthorized");
        assert_eq!(ended.exit(), Exit::Credential);
        // The advice is the same for a key and a sign-in as the core gives for
        // a copy whose credential ended, with the command that signs in.
        assert!(
            ended
                .to_string()
                .ends_with("sign in again with `marfa login`, or use a new key"),
            "{ended}"
        );
        // The server sent a `200` stream, so the envelope names no status.
        assert!(ended.envelope()["error"]["server"].is_null());
        // The witness: any other reason is the environment's.
        let behind = CliError::from(CoreError::StreamIncomplete {
            reason: "reader_behind".into(),
        });
        assert_eq!(behind.code(), "stream_incomplete");
        assert_eq!(behind.exit(), Exit::Environment);
    }

    #[test]
    fn local_storage_and_renewal_errors_have_no_server_status() {
        for (core, code, exit) in [
            (
                CoreError::StorageFull("full".into()),
                "storage_full",
                Exit::Environment,
            ),
            (
                CoreError::SignedOut {
                    origin: "https://marfa.example".into(),
                },
                "signed_out",
                Exit::Credential,
            ),
            (
                CoreError::NoKeychain("locked".into()),
                "no_keychain",
                Exit::Local,
            ),
            (CoreError::Store("malformed".into()), "store", Exit::Local),
        ] {
            let error = CliError::from(core);
            assert_eq!(error.code(), code);
            assert_eq!(error.exit(), exit);
            assert!(error.envelope()["error"]["server"].is_null());
        }
    }

    #[test]
    fn a_mismatch_keeps_the_core_words_unless_the_command_sent_the_request() {
        let mismatch = || CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: Some("other".into()),
            expected: 1,
            write_sent: true,
            status: Some(200),
        };
        let carried = CliError::from(mismatch());
        assert!(matches!(
            &carried,
            CliError::Core(CoreError::ContractMismatch { .. })
        ));
        assert_eq!(carried.to_string(), mismatch().to_string());
        assert!(matches!(
            CliError::direct(mismatch()),
            CliError::ContractMismatch { .. }
        ));
        assert_ne!(
            CliError::direct(mismatch()).to_string(),
            mismatch().to_string()
        );
    }

    #[test]
    fn a_renewal_that_finds_the_grant_dead_says_to_sign_in_with_the_command() {
        let signed_out = CliError::from(CoreError::RenewalFailed(Box::new(CoreError::SignedOut {
            origin: "https://marfa.example".into(),
        })));
        assert!(matches!(signed_out, CliError::SignedOut { .. }));
        let no_keychain = CliError::from(CoreError::RenewalFailed(Box::new(
            CoreError::NoKeychain("locked".into()),
        )));
        assert!(matches!(no_keychain, CliError::NoKeychain(_)));
    }

    /// The codes in the help, as an agent reads them.
    fn listed() -> Vec<&'static str> {
        exit_codes_help()
            .split("one of: ")
            .nth(1)
            .unwrap()
            .trim_end_matches('.')
            .split(", ")
            .collect()
    }

    #[test]
    fn the_help_names_every_code_the_core_and_the_binary_answer_and_nothing_else() {
        let mut expected: Vec<&str> = ERROR_CODES.to_vec();
        for own in [
            "usage",
            "conflict",
            "too_large",
            "not_held",
            "watch",
            "no_store",
            "no_credential",
            "docs_page_not_found",
            "docs_unreachable",
            "blobs_missing",
        ] {
            expected.push(own);
        }
        let mut listed = listed();
        // The witness that the list is read, not assumed: the code the help
        // left out was `bytes_absent`, which `device blobs get` answers.
        assert!(listed.contains(&"bytes_absent"));
        assert!(!listed.contains(&"closed_output"));
        let mut once = listed.clone();
        once.sort_unstable();
        once.dedup();
        assert_eq!(once.len(), listed.len(), "a code is listed twice");
        listed.sort_unstable();
        expected.sort_unstable();
        expected.dedup();
        assert_eq!(listed, expected);
    }

    #[test]
    fn every_code_an_error_answers_is_in_the_help() {
        let listed = listed();
        let errors = [
            CliError::Io(io::Error::other("x")),
            CliError::NotHeld(String::new()),
            CliError::FolderHeld(std::path::PathBuf::new()),
            CliError::FolderNotHandedOver(std::path::PathBuf::new()),
            CliError::Watch(String::new()),
            CliError::Usage(String::new()),
            CliError::NoStoreNamed,
            CliError::NoStoreAt(std::path::PathBuf::new()),
            CliError::NoServerNamed,
            CliError::NoServerForKey,
            CliError::NoCredential {
                origin: String::new(),
            },
            CliError::NoKeychain(String::new()),
            CliError::SignedOut {
                origin: String::new(),
            },
            CliError::CredentialEnded,
            CliError::Invalid(String::new()),
            CliError::ContractMismatch {
                origin: String::new(),
                served: None,
                expected: 1,
                write_sent: false,
                status: None,
            },
            CliError::Redirected {
                origin: String::new(),
                status: 302,
                location: None,
            },
            CliError::DocsPageNotFound {
                path: String::new(),
            },
            CliError::DocsUnreachable {
                address: String::new(),
                reason: String::new(),
            },
            CliError::Core(CoreError::BytesAbsent {
                hash: String::new(),
                reason: String::new(),
            }),
        ];
        for error in errors {
            assert!(listed.contains(&error.code()), "{}", error.code());
        }
        // Every status a server can answer, each named by a listed code and
        // each listed code reached by one.
        let mut reached: Vec<&str> = Vec::new();
        for status in 100..=599 {
            let code = refused(status).code();
            assert!(listed.contains(&code), "{status} is {code}");
            assert!(REFUSED_CODES.contains(&code), "{status} is {code}");
            if !reached.contains(&code) {
                reached.push(code);
            }
        }
        for code in REFUSED_CODES {
            assert!(reached.contains(code), "no status is {code}");
        }
        // `no_server` is answered twice, by the core's variant and the
        // binary's, and `closed_output` never leaves the process.
        assert_eq!(CliError::Core(CoreError::NoServer).code(), "no_server");
        assert_eq!(CliError::ClosedOutput.exit(), Exit::Done);
        for (status, code) in [
            (400, "validation"),
            (422, "validation"),
            (401, "unauthorized"),
            (403, "forbidden"),
            (404, "not_found"),
            (429, "rate_limited"),
            (500, "server"),
            (503, "server"),
        ] {
            assert_eq!(refused(status).code(), code, "{status}");
        }
    }

    #[test]
    fn a_failed_catch_up_says_in_its_envelope_whether_it_changed_the_catalog() {
        let failed = |catalog_changed| {
            CliError::from(CatchUpFailed {
                error: CoreError::Network("refused".into()),
                catalog_changed,
            })
        };
        let changed = failed(true);
        let envelope = changed.envelope();
        assert_eq!(envelope["catalog_changed"], true);
        assert_eq!(
            (
                envelope["error"]["code"].as_str(),
                envelope["exit"].as_u64()
            ),
            (Some("network"), Some(3)),
            "the catch-up's failure was not named by its cause"
        );
        assert!(changed.to_string().contains("catalog"));
        assert_eq!(failed(false).envelope()["catalog_changed"], false);
        assert!(!failed(false).to_string().contains("catalog"));
        // The witness: no other refusal carries it.
        assert!(
            CliError::Core(CoreError::Network("refused".into())).envelope()["catalog_changed"]
                .is_null()
        );
    }

    #[test]
    fn a_refusal_from_the_server_carries_its_status_and_code_in_the_envelope() {
        let error = CliError::Core(CoreError::RateLimited {
            code: "rate_limited".into(),
            message: "slow down".into(),
            retry_after_seconds: Some(7),
        });
        let envelope = error.envelope();
        assert_eq!(envelope["error"]["code"], "rate_limited");
        assert_eq!(envelope["error"]["server"]["status"], 429);
        assert_eq!(envelope["error"]["server"]["code"], "rate_limited");
        assert_eq!(envelope["error"]["retry_after_seconds"], 7);
        assert_eq!(envelope["exit"], 3);

        let local = CliError::Core(CoreError::HydrationIncomplete);
        let envelope = local.envelope();
        assert_eq!(envelope["error"]["code"], "hydration_incomplete");
        assert!(envelope["error"]["server"].is_null());
        assert!(envelope["error"]["retry_after_seconds"].is_null());
        assert_eq!(envelope["exit"], 4);

        let validation = CliError::Core(CoreError::Validation {
            code: "invalid_properties".into(),
            message: "body is required".into(),
        });
        assert!(validation.envelope()["error"]["server"]["status"].is_null());
        assert_eq!(validation.envelope()["exit"], 1);

        let direct = CliError::Refused {
            status: 422,
            code: "bulk_atomic_rollback".into(),
            message: "entry 3 failed".into(),
            retry_after_seconds: None,
            details: Some(Box::new(serde_json::json!({ "index": 3 }))),
        };
        let envelope = direct.envelope();
        assert_eq!(envelope["error"]["code"], "validation");
        assert_eq!(envelope["error"]["server"]["status"], 422);
        assert_eq!(envelope["error"]["server"]["code"], "bulk_atomic_rollback");
        assert_eq!(envelope["error"]["server"]["details"]["index"], 3);
        assert_eq!(envelope["exit"], 1);
        assert!(direct.to_string().ends_with(r#"{"index":3}"#));
    }

    #[test]
    fn each_class_of_refusal_leaves_by_its_own_door() {
        assert_eq!(CliError::NoStoreNamed.exit(), Exit::Usage);
        assert_eq!(
            CliError::NoStoreAt("missing.sqlite".into()).exit(),
            Exit::Usage
        );
        assert_eq!(CliError::NoServerNamed.exit(), Exit::Usage);
        assert_eq!(CliError::NoServerForKey.exit(), Exit::Usage);
        assert_eq!(
            CliError::NoCredential {
                origin: String::new()
            }
            .exit(),
            Exit::Credential
        );
        assert_eq!(CliError::NoKeychain(String::new()).exit(), Exit::Local);
        assert_eq!(
            CliError::SignedOut {
                origin: String::new()
            }
            .exit(),
            Exit::Credential
        );
        assert_eq!(CliError::NotHeld("x".into()).exit(), Exit::Refused);
        assert_eq!(
            CliError::DocsPageNotFound { path: "x".into() }.exit(),
            Exit::Refused
        );
        assert_eq!(
            CliError::DocsUnreachable {
                address: "x".into(),
                reason: "x".into()
            }
            .exit(),
            Exit::Environment
        );
        assert_eq!(CliError::Invalid("x".into()).exit(), Exit::Refused);
        assert_eq!(CliError::ArchiveLacksBlobs(vec![]).exit(), Exit::Refused);
        assert_eq!(
            CliError::ArchiveKeptApart {
                missing: vec![],
                target: std::path::PathBuf::new(),
                incomplete: std::path::PathBuf::new(),
                kept: std::path::PathBuf::new(),
                target_held: false,
                refused: None,
            }
            .exit(),
            Exit::Refused
        );
        assert_eq!(CliError::RestoreLacksBlobs(vec![]).exit(), Exit::Refused);
        assert_eq!(
            CliError::Core(CoreError::Unauthorized {
                code: "unauthorized".into(),
                message: String::new(),
            })
            .exit(),
            Exit::Credential
        );
        assert_eq!(
            CliError::Core(CoreError::Network("refused".into())).exit(),
            Exit::Environment
        );
        assert_eq!(CliError::Core(CoreError::ReadingHandle).exit(), Exit::Local);
        assert_eq!(
            CliError::from(io::Error::from(io::ErrorKind::BrokenPipe)).exit(),
            Exit::Done
        );
        assert_eq!(refused(401).exit(), Exit::Credential);
        assert_eq!(refused(429).exit(), Exit::Environment);
        assert_eq!(refused(502).exit(), Exit::Environment);
        for status in [400, 403, 404, 409, 413, 422] {
            assert_eq!(refused(status).exit(), Exit::Refused, "{status}");
        }
    }
}

#[cfg(test)]
mod hash_list_tests {
    use super::*;

    #[test]
    fn names_ten_hashes_and_counts_the_rest() {
        let hashes: Vec<String> = (0..12).map(|n| format!("sha256:{n:02}")).collect();
        let message = CliError::ArchiveLacksBlobs(hashes).to_string();
        assert!(message.contains("lacks 12 blob(s)"), "{message}");
        assert!(message.contains("sha256:09 and 2 more"), "{message}");
        assert!(!message.contains("sha256:10"), "{message}");
    }
}
