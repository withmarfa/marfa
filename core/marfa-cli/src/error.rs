use std::io;

use marfa_core::CoreError;

/// Every way the binary can refuse or fail, and how each one leaves.
///
/// The exit code is one of five and the code string is from a closed set,
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
    #[error("no working copy named: pass --db or set MARFA_DB")]
    NoStoreNamed,
    #[error("no server named: pass --url or set MARFA_API_URL")]
    NoServerNamed,
    #[error("no credential named: pass --key or set MARFA_API_KEY")]
    NoCredentialNamed,
    /// An argument the binary judged wrong before anything was sent.
    #[error("{0}")]
    Invalid(String),
}

/// The five ways out, and what each means to a caller.
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
            CliError::NoStoreNamed => "no_store",
            CliError::NoServerNamed => "no_server",
            CliError::NoCredentialNamed => "no_credential",
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
            CliError::NoStoreNamed | CliError::NoServerNamed => Exit::Usage,
            CliError::NoCredentialNamed => Exit::Credential,
        }
    }

    /// The server's answer, where there was one: its status and its own
    /// code.
    fn server(&self) -> Option<(Option<u16>, &str)> {
        match self {
            CliError::Core(core) => match core {
                CoreError::NotFound { code, .. } => Some((Some(404), code)),
                CoreError::Unauthorized { code, .. } => Some((Some(401), code)),
                CoreError::Forbidden { code, .. } => Some((Some(403), code)),
                // The variant folds 400 and 422 together, so the status is
                // not known here and is not invented.
                CoreError::Validation { code, .. } => Some((None, code)),
                CoreError::UnknownType { .. } => Some((Some(400), "unknown_type")),
                CoreError::RateLimited { code, .. } => Some((Some(429), code)),
                CoreError::Server { status, code, .. } => Some((Some(*status), code)),
                _ => None,
            },
            _ => None,
        }
    }

    fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            CliError::Core(CoreError::RateLimited {
                retry_after_seconds,
                ..
            }) => *retry_after_seconds,
            _ => None,
        }
    }

    /// The one JSON object a refusal prints on stderr under `--json`.
    pub fn envelope(&self) -> serde_json::Value {
        let server = self
            .server()
            .map(|(status, code)| serde_json::json!({ "status": status, "code": code }));
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

/// The text the root's help carries about leaving. One place, quoted by the
/// help and by the README, so the two cannot disagree.
pub const EXIT_CODES_HELP: &str = "\
Exit codes:
  0  done
  1  the request was refused, by the server or by the binary before sending; a retry does not change it
  2  the command line was wrong, or named no store or server; clap's own refusals print its usage text
  3  the environment failed (unreachable, timed out, a 5xx, a 429); try again
  4  the working copy or the queue refused under the device rules
  5  no credential, or the credential was refused

With --json a refusal is one JSON object on stderr:
  {\"error\":{\"code\":...,\"message\":...,\"server\":{\"status\":...,\"code\":...}|null,\"retry_after_seconds\":...},\"exit\":N}
where error.code is one of: invalid, not_found, unauthorized, forbidden, validation, unknown_type,
rate_limited, server, network, decoding, io, watch, store, no_store, no_server, no_credential,
no_cursor, hydration_incomplete, reading_handle, wrong_schema, catch_up_too_old, stream_incomplete,
wrong_server, not_held.";

#[cfg(test)]
mod tests {
    use super::*;

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
            CliError::NoCredentialNamed.code(),
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
    }

    #[test]
    fn each_class_of_refusal_leaves_by_its_own_door() {
        assert_eq!(CliError::NoStoreNamed.exit(), Exit::Usage);
        assert_eq!(CliError::NoServerNamed.exit(), Exit::Usage);
        assert_eq!(CliError::NoCredentialNamed.exit(), Exit::Credential);
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
    }
}
