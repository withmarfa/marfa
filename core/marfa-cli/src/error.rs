use std::io;

use marfa_core::CoreError;

/// Agents read the exit code and the code string, which `EXIT_CODES_HELP`
/// documents by hand: change them together.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Core(CoreError),
    #[error("{0}")]
    Io(io::Error),
    #[error("{0} is not in the local copy")]
    NotHeld(String),
    /// The core's `ReadingHandle`, said of the folder rather than its store.
    #[error(
        "{} is being worked by another process, such as a running `folders watch`; one process works a folder at a time, so stop it and run this again",
        .0.display()
    )]
    FolderHeld(std::path::PathBuf),
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
        "no credential for {origin}: pass --key, set MARFA_API_KEY, keep a key with `marfa keys keep`, or sign in with `marfa login`"
    )]
    NoCredential { origin: String },
    #[error("no keychain on this system: {0}")]
    NoKeychain(String),
    #[error("signed out of {origin}: run `marfa login`")]
    SignedOut { origin: String },
    #[error("{0}")]
    Invalid(String),
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

impl From<CoreError> for CliError {
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::RenewalFailed(cause) => match *cause {
                CoreError::Server {
                    status,
                    code,
                    message,
                } => Self::Refused {
                    status,
                    code,
                    message,
                    retry_after_seconds: None,
                    details: None,
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
                other => Self::from(other),
            },
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
            CoreError::Redirected {
                origin,
                status,
                location,
            } => Self::Redirected {
                origin,
                status,
                location,
            },
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
}

impl CliError {
    pub fn code(&self) -> &'static str {
        match self {
            CliError::Core(core) => match core {
                CoreError::RenewalFailed(cause) => CliError::from(*cause.clone()).code(),
                CoreError::Redirected { .. } => "redirect",
                CoreError::NotFound { .. } => "not_found",
                CoreError::Unauthorized { .. } => "unauthorized",
                CoreError::Forbidden { .. } => "forbidden",
                CoreError::Validation { .. } => "validation",
                CoreError::UnknownType { .. } => "unknown_type",
                CoreError::RateLimited { .. } => "rate_limited",
                CoreError::Server { .. } => "server",
                CoreError::Io(_) => "io",
                CoreError::Network(_) => "network",
                CoreError::Unnamed { .. } => "unnamed_answer",
                CoreError::Decoding(_) => "decoding",
                CoreError::Store(_) => "store",
                CoreError::StorageFull(_) => "storage_full",
                CoreError::SignedOut { .. } => "signed_out",
                CoreError::NoKeychain(_) => "no_keychain",
                CoreError::NoServer => "no_server",
                CoreError::NoCursor => "no_cursor",
                CoreError::HydrationIncomplete => "hydration_incomplete",
                CoreError::NoCatalog => "no_catalog",
                CoreError::ReadingHandle => "reading_handle",
                CoreError::WrongSchema { .. } => "wrong_schema",
                CoreError::CopyExpired { .. } => "copy_expired",
                CoreError::StreamIncomplete { .. } => "stream_incomplete",
                CoreError::WrongServer { .. } => "wrong_server",
                CoreError::BytesAbsent { .. } => "bytes_absent",
                CoreError::ContractMismatch { .. } => "contract_mismatch",
                CoreError::Invalid(_) => "invalid",
            },
            CliError::Io(_) => "io",
            CliError::NotHeld(_) => "not_held",
            CliError::FolderHeld(_) => "reading_handle",
            CliError::Watch(_) => "watch",
            CliError::ClosedOutput => "closed_output",
            CliError::Refused { status, .. } => match status {
                400 | 422 => "validation",
                401 => "unauthorized",
                403 => "forbidden",
                404 => "not_found",
                409 => "conflict",
                413 => "too_large",
                429 => "rate_limited",
                _ => "server",
            },
            CliError::Usage(_) => "usage",
            CliError::NoStoreNamed | CliError::NoStoreAt(_) => "no_store",
            CliError::NoServerNamed => "no_server",
            CliError::NoCredential { .. } => "no_credential",
            CliError::NoKeychain(_) => "no_keychain",
            CliError::SignedOut { .. } => "signed_out",
            CliError::Invalid(_) => "invalid",
            CliError::ContractMismatch { .. } => "contract_mismatch",
            CliError::Redirected { .. } => "redirect",
        }
    }

    pub fn exit(&self) -> Exit {
        match self {
            CliError::Core(core) => match core {
                CoreError::RenewalFailed(cause) => CliError::from(*cause.clone()).exit(),
                CoreError::Redirected { .. }
                | CoreError::NotFound { .. }
                | CoreError::Forbidden { .. }
                | CoreError::Validation { .. }
                | CoreError::UnknownType { .. }
                | CoreError::ContractMismatch { .. }
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
                | CoreError::BytesAbsent { .. } => Exit::Environment,
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
            CliError::Io(_) | CliError::Watch(_) => Exit::Environment,
            CliError::NotHeld(_)
            | CliError::Invalid(_)
            | CliError::ContractMismatch { .. }
            | CliError::Redirected { .. } => Exit::Refused,
            CliError::ClosedOutput => Exit::Done,
            CliError::Refused { status, .. } => match status {
                401 => Exit::Credential,
                429 => Exit::Environment,
                500.. => Exit::Environment,
                _ => Exit::Refused,
            },
            CliError::Usage(_)
            | CliError::NoStoreNamed
            | CliError::NoStoreAt(_)
            | CliError::NoServerNamed => Exit::Usage,
            CliError::NoCredential { .. } | CliError::SignedOut { .. } => Exit::Credential,
            CliError::NoKeychain(_) | CliError::FolderHeld(_) => Exit::Local,
        }
    }

    fn server(&self) -> Option<(Option<u16>, Option<&str>, Option<&serde_json::Value>)> {
        match self {
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
        serde_json::json!({
            "error": {
                "code": self.code(),
                "message": self.to_string(),
                "server": server,
                "retry_after_seconds": self.retry_after_seconds(),
            },
            "exit": self.exit() as u8,
        })
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

fn details_suffix(details: &Option<Box<serde_json::Value>>) -> String {
    match details {
        Some(details) => format!(" {details}"),
        None => String::new(),
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

pub const EXIT_CODES_HELP: &str = "\
Exit codes:
  0  done
  1  the request was refused, by the server, by the binary before sending, or for an answer on another contract; a retry does not change it
  2  the command line was wrong, or named no store or server
  3  the environment failed (unreachable, timed out, a 5xx, a 429, an answer naming no contract, full local storage); try again
  4  the working copy or the queue refused under the device rules, or this system has no keychain
  5  no credential, the credential was refused, or the sign-in ended; `marfa login` starts one

A device drain prints its complete report on stdout: 0 for a completed pass (including refused writes),
3 for undelivered writes or an unavailable pass, and 5 for a credential-stopped pass.
A report exit prints no additional refusal on stderr. Refused verdicts have a separate plain-text count.

With --json a refusal is one JSON object on stderr:
  {\"error\":{\"code\":...,\"message\":...,\"server\":{\"status\":...,\"code\":...,\"details\":...}|null,\"retry_after_seconds\":...},\"exit\":N}
where error.code is one of: usage, invalid, not_found, unauthorized, forbidden, validation, conflict,
too_large, unknown_type, rate_limited, server, network, unnamed_answer, decoding, io, watch, store, storage_full, no_store,
no_server, no_credential, no_keychain, signed_out, no_cursor, hydration_incomplete,
no_catalog, reading_handle, wrong_schema, copy_expired, stream_incomplete, wrong_server, not_held,
contract_mismatch, redirect.";

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
    fn the_help_names_every_code_and_nothing_else() {
        let listed: Vec<&str> = EXIT_CODES_HELP
            .split("one of:")
            .nth(1)
            .unwrap()
            .trim_end_matches('.')
            .split(',')
            .map(str::trim)
            .collect();
        let answered = [
            CliError::Usage(String::new()).code(),
            CliError::Invalid(String::new()).code(),
            CliError::Core(CoreError::NotFound {
                code: String::new(),
                message: String::new(),
            })
            .code(),
            CliError::Core(CoreError::Unauthorized {
                code: String::new(),
                message: String::new(),
            })
            .code(),
            CliError::Core(CoreError::Forbidden {
                code: String::new(),
                message: String::new(),
            })
            .code(),
            CliError::Core(CoreError::Validation {
                code: String::new(),
                message: String::new(),
            })
            .code(),
            refused(409).code(),
            refused(413).code(),
            CliError::Core(CoreError::UnknownType {
                message: String::new(),
            })
            .code(),
            CliError::Core(CoreError::RateLimited {
                code: String::new(),
                message: String::new(),
                retry_after_seconds: None,
            })
            .code(),
            CliError::Core(CoreError::Server {
                status: 500,
                code: String::new(),
                message: String::new(),
            })
            .code(),
            CliError::Core(CoreError::Network(String::new())).code(),
            CliError::Core(CoreError::Unnamed {
                origin: String::new(),
                status: 401,
                retry_after_seconds: None,
            })
            .code(),
            CliError::Core(CoreError::Decoding(String::new())).code(),
            CliError::Io(io::Error::other("x")).code(),
            CliError::Watch(String::new()).code(),
            CliError::Core(CoreError::Store(String::new())).code(),
            CliError::Core(CoreError::StorageFull(String::new())).code(),
            CliError::NoStoreNamed.code(),
            CliError::NoServerNamed.code(),
            CliError::NoCredential {
                origin: String::new(),
            }
            .code(),
            CliError::NoKeychain(String::new()).code(),
            CliError::SignedOut {
                origin: String::new(),
            }
            .code(),
            CliError::Core(CoreError::NoCursor).code(),
            CliError::Core(CoreError::HydrationIncomplete).code(),
            CliError::Core(CoreError::NoCatalog).code(),
            CliError::Core(CoreError::ReadingHandle).code(),
            CliError::Core(CoreError::WrongSchema {
                path: String::new(),
                reason: String::new(),
                unsent: None,
            })
            .code(),
            CliError::Core(CoreError::CopyExpired {
                reason: String::new(),
            })
            .code(),
            CliError::Core(CoreError::StreamIncomplete {
                reason: String::new(),
            })
            .code(),
            CliError::Core(CoreError::WrongServer {
                expected: String::new(),
                got: String::new(),
            })
            .code(),
            CliError::NotHeld(String::new()).code(),
            CliError::ContractMismatch {
                origin: String::new(),
                served: Some(String::new()),
                expected: 1,
                write_sent: false,
                status: None,
            }
            .code(),
            CliError::Redirected {
                origin: String::new(),
                status: 302,
                location: None,
            }
            .code(),
        ];
        let mut sorted_listed = listed.clone();
        sorted_listed.sort_unstable();
        let mut sorted_answered = answered.to_vec();
        sorted_answered.sort_unstable();
        assert_eq!(sorted_listed, sorted_answered);
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
        assert_eq!(CliError::Invalid("x".into()).exit(), Exit::Refused);
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
