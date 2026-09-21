use std::io;

use marfa_core::CoreError;

/// Every way the binary can refuse or fail, and how each one leaves.
///
/// The exit code is one of six and the code string is from a closed set,
/// both documented in the root's help. An agent reads the exit code to decide
/// what to do next and the code string to say why, so neither may be one
/// thing here and another in the help.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("{0}")]
    Io(io::Error),
    #[error("{0} is not in the local copy")]
    NotHeld(String),
    #[error("{0}")]
    Watch(String),
    /// The reader went away (a closed pipe); nothing is wrong.
    #[error("output closed")]
    ClosedOutput,
    /// The server refused a call from the direct surface. The status and the
    /// server's own code are both kept, because neither classifies alone.
    #[error(
        "the server refused ({status} {code}): {message}{}",
        details_suffix(details)
    )]
    Refused {
        status: u16,
        code: String,
        message: String,
        retry_after_seconds: Option<u64>,
        /// The envelope's `details`, carried whole: a bulk door names the
        /// entry that failed there, and a validation names the field.
        details: Option<Box<serde_json::Value>>,
    },
    #[error("no working copy named: pass --db or set MARFA_DB")]
    NoStoreNamed,
    #[error("no server named: pass --url or set MARFA_API_URL")]
    NoServerNamed,
    #[error(
        "no credential for {origin}: pass --key, set MARFA_API_KEY, or keep one with `marfa keys keep`"
    )]
    NoCredential { origin: String },
    #[error("no keychain on this system: {0}")]
    NoKeychain(String),
    /// The kept token could not be refreshed, so the sign-in is over.
    #[error("signed out of {origin}: run `marfa login`")]
    SignedOut { origin: String },
    /// An argument the binary judged wrong before anything was sent.
    #[error("{0}")]
    Invalid(String),
}

/// The six ways out, and what each means to a caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// Done.
    Done = 0,
    /// The request was wrong: refused by the server, or by the binary before
    /// sending, for something a retry does not change.
    Refused = 1,
    /// The command line was wrong. clap's own code, shared by the binary's
    /// own refusals of an incomplete one.
    Usage = 2,
    /// The environment failed: unreachable, timed out, a 5xx, a 429. Try
    /// again; `retry_after_seconds` says when, if the server said.
    Environment = 3,
    /// The working copy or the queue refused under the device rules.
    Local = 4,
    /// No credential, or the credential was refused.
    Credential = 5,
}

impl CliError {
    /// The closed set a caller reads.
    pub fn code(&self) -> &'static str {
        match self {
            CliError::Core(core) => match core {
                CoreError::NotFound { .. } => "not_found",
                CoreError::Unauthorized { .. } => "unauthorized",
                CoreError::Forbidden { .. } => "forbidden",
                CoreError::Validation { .. } => "validation",
                CoreError::UnknownType { .. } => "unknown_type",
                CoreError::RateLimited { .. } => "rate_limited",
                CoreError::Server { .. } => "server",
                CoreError::Network(_) => "network",
                CoreError::Decoding(_) => "decoding",
                CoreError::Store(_) => "store",
                CoreError::NoServer => "no_server",
                CoreError::NoCursor => "no_cursor",
                CoreError::HydrationIncomplete => "hydration_incomplete",
                CoreError::ReadingHandle => "reading_handle",
                CoreError::WrongSchema { .. } => "wrong_schema",
                CoreError::CatchUpTooOld { .. } => "catch_up_too_old",
                CoreError::StreamIncomplete { .. } => "stream_incomplete",
                CoreError::WrongServer { .. } => "wrong_server",
                CoreError::Invalid(_) => "invalid",
            },
            CliError::Io(_) => "io",
            CliError::NotHeld(_) => "not_held",
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
            CliError::NoStoreNamed => "no_store",
            CliError::NoServerNamed => "no_server",
            CliError::NoCredential { .. } => "no_credential",
            CliError::NoKeychain(_) => "no_keychain",
            CliError::SignedOut { .. } => "signed_out",
            CliError::Invalid(_) => "invalid",
        }
    }

    pub fn exit(&self) -> Exit {
        match self {
            CliError::Core(core) => match core {
                CoreError::NotFound { .. }
                | CoreError::Forbidden { .. }
                | CoreError::Validation { .. }
                | CoreError::UnknownType { .. }
                | CoreError::Invalid(_) => Exit::Refused,
                CoreError::Unauthorized { .. } => Exit::Credential,
                CoreError::RateLimited { .. }
                | CoreError::Server { .. }
                | CoreError::Network(_)
                | CoreError::Decoding(_)
                | CoreError::StreamIncomplete { .. } => Exit::Environment,
                CoreError::Store(_)
                | CoreError::NoServer
                | CoreError::NoCursor
                | CoreError::HydrationIncomplete
                | CoreError::ReadingHandle
                | CoreError::WrongSchema { .. }
                | CoreError::CatchUpTooOld { .. }
                | CoreError::WrongServer { .. } => Exit::Local,
            },
            CliError::Io(_) | CliError::Watch(_) => Exit::Environment,
            CliError::NotHeld(_) | CliError::Invalid(_) => Exit::Refused,
            CliError::ClosedOutput => Exit::Done,
            CliError::Refused { status, .. } => match status {
                401 => Exit::Credential,
                429 => Exit::Environment,
                500.. => Exit::Environment,
                _ => Exit::Refused,
            },
            CliError::NoStoreNamed | CliError::NoServerNamed => Exit::Usage,
            CliError::NoCredential { .. } | CliError::SignedOut { .. } => Exit::Credential,
            CliError::NoKeychain(_) => Exit::Local,
        }
    }

    /// The server's answer, where there was one: its status, its own code,
    /// and its details.
    fn server(&self) -> Option<(Option<u16>, &str, Option<&serde_json::Value>)> {
        match self {
            CliError::Core(core) => match core {
                CoreError::NotFound { code, .. } => Some((Some(404), code, None)),
                CoreError::Unauthorized { code, .. } => Some((Some(401), code, None)),
                CoreError::Forbidden { code, .. } => Some((Some(403), code, None)),
                // The variant folds 400 and 422 together, so the status is
                // not known here and is not invented.
                CoreError::Validation { code, .. } => Some((None, code, None)),
                CoreError::UnknownType { .. } => Some((Some(400), "unknown_type", None)),
                CoreError::RateLimited { code, .. } => Some((Some(429), code, None)),
                CoreError::Server { status, code, .. } => Some((Some(*status), code, None)),
                _ => None,
            },
            CliError::Refused {
                status,
                code,
                details,
                ..
            } => Some((Some(*status), code, details.as_deref())),
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

    /// The one JSON object a refusal prints on stderr under `--json`.
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

/// The details of a refusal, on the human line, compact: the entry a bulk
/// door names or the field a validation names is the part a person acts on.
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

/// The text the root's help carries about leaving. `core/README.md`
/// carries the same table by hand.
pub const EXIT_CODES_HELP: &str = "\
Exit codes:
  0  done
  1  the request was refused, by the server or by the binary before sending; a retry does not change it
  2  the command line was wrong, or named no store or server; clap's own refusals print its usage text
  3  the environment failed (unreachable, timed out, a 5xx, a 429); try again
  4  the working copy or the queue refused under the device rules, or this system has no keychain
  5  no credential, or the credential was refused

With --json a refusal is one JSON object on stderr:
  {\"error\":{\"code\":...,\"message\":...,\"server\":{\"status\":...,\"code\":...,\"details\":...}|null,\"retry_after_seconds\":...},\"exit\":N}
where error.code is one of: invalid, not_found, unauthorized, forbidden, validation, conflict,
too_large, unknown_type, rate_limited, server, network, decoding, io, watch, store, no_store,
no_server, no_credential, no_keychain, signed_out, no_cursor, hydration_incomplete,
reading_handle, wrong_schema, catch_up_too_old, stream_incomplete, wrong_server, not_held.";

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

    /// Every code the help names is one a variant answers, and the other
    /// way round, so the closed set is closed in one place.
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
            CliError::Core(CoreError::Decoding(String::new())).code(),
            CliError::Io(io::Error::other("x")).code(),
            CliError::Watch(String::new()).code(),
            CliError::Core(CoreError::Store(String::new())).code(),
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
            CliError::Core(CoreError::ReadingHandle).code(),
            CliError::Core(CoreError::WrongSchema {
                expected: String::new(),
                found: String::new(),
                path: String::new(),
            })
            .code(),
            CliError::Core(CoreError::CatchUpTooOld {
                min_retained_id: String::new(),
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
        // A refusal from the direct surface takes its code from the status;
        // the ones with a code of their own are listed above, the rest fold
        // into the four the core also answers.
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

        // A validation folds two statuses, so the envelope names none
        // rather than guessing.
        let validation = CliError::Core(CoreError::Validation {
            code: "invalid_properties".into(),
            message: "body is required".into(),
        });
        assert!(validation.envelope()["error"]["server"]["status"].is_null());
        assert_eq!(validation.envelope()["exit"], 1);

        // The direct surface keeps the status and the details whole.
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
