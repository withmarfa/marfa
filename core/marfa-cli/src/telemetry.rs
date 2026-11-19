//! Traces of a command run, sent over OTLP when the standard
//! `OTEL_EXPORTER_OTLP_*` variables name where to send them.
//! `OTEL_SDK_DISABLED=true` turns them off. With no endpoint set nothing here
//! starts: no subscriber, no thread, no request, and no output of its own.
//!
//! A run is one trace. Its root span is named for the command path
//! (`marfa items create`), the core's spans hang beneath it, and a failure
//! adds an `error` event with the CLI's error code and the exit code. What
//! leaves the process is the allowlist in `layer`: the command path, exit and
//! error codes, counts, outcomes and durations. Never an argument, a
//! credential, an address, an item's content or an error's message.
//!
//! This module and its children are the only files in the binary that name
//! `tracing`.

mod carried;
mod export;
mod layer;
mod otlp;
mod settings;

use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::layer::SubscriberExt;

use crate::error::CliError;
use crate::interrupt::INTERRUPTED;

use export::{Exporter, Sink};
use settings::{Identity, Reading, Settings};

pub use carried::{FILE_ENV, FILE_NAME, carry, load as load_carried};

/// One run of one command.
pub struct Run {
    live: Option<Live>,
}

struct Live {
    root: tracing::Span,
    exporter: Arc<Exporter>,
    budget: Duration,
}

/// Starts telemetry for `command`, the path of a command's names as clap
/// parsed them, if the environment asks for it.
///
/// A malformed endpoint turns traces off and is said on standard error
/// unless `json` is set.
pub fn start(command: &str, json: bool) -> Run {
    start_with(command, json, |name| std::env::var(name).ok())
}

fn start_with(command: &str, json: bool, get: impl Fn(&str) -> Option<String>) -> Run {
    if settings::disabled(&get) {
        return Run::off();
    }
    let identity = settings::identity(&get);
    let live = match settings::read(&get, identity) {
        Reading::Off => None,
        Reading::Ignored(variable) => {
            if !json {
                crate::errln!(
                    "marfa: {variable} is not an http or https address, so this run sends no traces"
                );
            }
            None
        }
        Reading::On(settings) => live(command, &settings),
    };
    Run { live }
}

fn resource(identity: &Identity) -> otlp::Resource {
    otlp::Resource {
        service: identity.service.clone(),
        attributes: identity.resource.clone(),
    }
}

fn live(command: &str, settings: &Settings) -> Option<Live> {
    let trace_id: [u8; 16] = layer::random();
    if !settings.sampler.keeps(&trace_id) {
        return None;
    }
    let exporter = Arc::new(Exporter::start(
        otlp::Poster::new(settings),
        resource(&settings.identity),
    )?);
    let subscriber = tracing_subscriber::registry().with(layer::Export::new(
        trace_id,
        layer::fresh(),
        Arc::clone(&exporter) as Arc<dyn Sink>,
    ));
    tracing::subscriber::set_global_default(subscriber).ok()?;
    let root = tracing::info_span!(
        "command",
        command = command,
        exit_code = tracing::field::Empty,
        dropped_spans = tracing::field::Empty,
    );
    Some(Live {
        root,
        exporter,
        budget: settings.identity.timeout,
    })
}

/// Whether a run that ends with `status` failed. A command the person
/// stopped with Ctrl-C did not: it ended `canceled`, or, as a command that
/// runs until it is stopped does, with the status of an interrupt. Whether
/// Ctrl-C arrived does not decide it, so an error that comes in the same
/// moment as an interrupt is still a failure. A watch that ended so the
/// service manager starts a new build did not fail either, though its status
/// says so to the manager.
fn failed(status: u8, error: Option<&CliError>, ended_for_new_build: bool) -> bool {
    status != 0
        && status != INTERRUPTED
        && !(ended_for_new_build && error.is_none())
        && !error.is_some_and(|error| error.code() == "canceled")
}

/// The status a process leaves with when a panic unwinds out of `main`.
const PANICKED: u8 = 101;

impl Run {
    fn off() -> Run {
        Run { live: None }
    }

    /// Runs the command inside the run's root span, so that the core's spans
    /// on this thread are beneath it.
    pub fn within<T>(&self, command: impl FnOnce() -> T) -> T {
        match &self.live {
            Some(live) => live.root.in_scope(command),
            None => command(),
        }
    }

    /// Ends the run with the status the process is about to leave with, and
    /// the error that caused it where there is one, then sends what is
    /// pending. Waits no longer than the timeout, and changes nothing the
    /// command has said or will exit with.
    pub fn finish(self, status: u8, error: Option<&CliError>) {
        let failure = failed(status, error, crate::new_build::ended_for_it());
        self.end(status, failure, error.map(CliError::code));
    }

    /// Ends a run whose command panicked, which leaves the process with the
    /// status Rust gives a panic. The panic's message and location are not
    /// recorded: either can carry content.
    pub fn panicked(self) {
        self.end(PANICKED, true, Some("panic"));
    }

    /// `code` names the error the trace records a failure by, where there is
    /// one.
    fn end(self, status: u8, failure: bool, code: Option<&str>) {
        if let Some(live) = self.live {
            live.root.record("exit_code", u64::from(status));
            if failure {
                match code {
                    Some(code) => tracing::error!(
                        parent: &live.root,
                        code,
                        exit_code = u64::from(status),
                        "the command failed"
                    ),
                    None => tracing::error!(
                        parent: &live.root,
                        exit_code = u64::from(status),
                        "the command failed"
                    ),
                }
            }
            let dropped = live.exporter.dropped();
            if dropped > 0 {
                live.root.record("dropped_spans", dropped);
            }
            drop(live.root);
            live.exporter.close(live.budget);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn a_stopped_command_is_not_a_failed_one() {
        let canceled = CliError::from(marfa_core::CoreError::Canceled);
        let refused = CliError::Usage("x".into());
        assert!(failed(3, Some(&refused), false));
        assert!(failed(3, None, false));
        assert!(!failed(0, None, false));
        assert!(!failed(INTERRUPTED, None, false));
        assert!(!failed(3, Some(&canceled), false));
        // The witness: a real failure is one whether or not Ctrl-C came with
        // it, since the rule takes no account of the signal.
        let credential = CliError::from(marfa_core::CoreError::SignedOut {
            origin: "https://marfa.example".into(),
        });
        let local = CliError::from(marfa_core::CoreError::NoCursor);
        assert!(failed(5, Some(&credential), false));
        assert!(failed(4, Some(&local), false));
    }

    #[test]
    fn a_watch_that_ended_for_a_new_build_did_not_fail() {
        assert!(!failed(3, None, true));
        // The witness: the same status without the new build is a failure,
        // and so is an error that came while the watch was ending for one.
        assert!(failed(3, None, false));
        assert!(failed(3, Some(&CliError::Usage("x".into())), true));
    }

    fn started(pairs: &[(&str, &str)]) -> Run {
        start_with("marfa status", true, |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn with_no_setting_a_run_starts_nothing() {
        let run = started(&[]);
        assert!(run.live.is_none());
        assert_eq!(run.within(|| 7), 7);
        run.finish(3, None);
    }

    /// The trace side is shown by the binary's own tests: starting one sets
    /// the process's global subscriber, which a unit test must not.
    #[test]
    fn a_malformed_endpoint_and_a_disabled_sdk_start_no_trace() {
        assert!(
            started(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "not a url")])
                .live
                .is_none()
        );
        assert!(
            started(&[
                ("OTEL_SDK_DISABLED", "true"),
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9"),
            ])
            .live
            .is_none()
        );
    }

    /// The privacy rule is kept by one place naming `tracing`, so a field can
    /// only be added where a reviewer will look for it.
    #[test]
    fn only_the_telemetry_files_name_tracing() {
        fn rust_files(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    rust_files(&path, found);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    found.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        let named: Vec<_> = files
            .iter()
            .filter(|path| {
                !path.starts_with(src.join("telemetry")) && !path.ends_with("telemetry.rs")
            })
            .filter(|path| {
                let source = std::fs::read_to_string(path).unwrap();
                source.contains("tracing::") || source.contains("#[instrument")
            })
            .collect();
        assert!(named.is_empty(), "{named:?}");
        assert!(
            files
                .iter()
                .any(|path| path.ends_with("telemetry/layer.rs"))
        );
    }
}
