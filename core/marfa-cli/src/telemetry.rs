//! Two reports of a command run, each asked for by settings of its own.
//! Traces go over OTLP when the standard `OTEL_EXPORTER_OTLP_*` variables name
//! where to send them, and a failed run's exception goes to PostHog when
//! `MARFA_POSTHOG_HOST` and `MARFA_POSTHOG_PROJECT_TOKEN` are set, whether or
//! not a collector is. `OTEL_SDK_DISABLED=true` turns both off. With neither
//! asked for nothing here starts: no subscriber, no thread, no request, and
//! no output of its own.
//!
//! A run is one trace. Its root span is named for the command path
//! (`marfa items create`), the core's spans hang beneath it, and a failure
//! adds an `error` event with the CLI's error code and the exit code. What
//! leaves the process is the allowlist in `layer` and the event `posthog`
//! builds: the command path, exit and error codes, counts, outcomes and
//! durations, and PostHog's project token in its own field. Never an
//! argument, another credential, an address, an item's content or an error's
//! message.
//!
//! This module and its children are the only files in the binary that name
//! `tracing`.

mod describe;
mod export;
mod layer;
mod otlp;
mod posthog;
mod settings;

use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::layer::SubscriberExt;

use crate::error::CliError;
use crate::interrupt::INTERRUPTED;

use export::{Exporter, Sink};
use posthog::Cause;
use settings::{Identity, Reading, Settings};

/// One run of one command.
pub struct Run {
    live: Option<Live>,
    exceptions: Option<posthog::Reporter>,
}

struct Live {
    root: tracing::Span,
    exporter: Arc<Exporter>,
    budget: Duration,
}

/// Starts telemetry for `command`, the path of a command's names as clap
/// parsed them, if the environment asks for it.
///
/// Traces and exception reports are asked for by different settings, and
/// each is off without its own. A malformed endpoint turns off the traces
/// only, and a malformed PostHog host the exception reports only; either is
/// said on standard error unless `json` is set.
pub fn start(command: &str, json: bool) -> Run {
    start_with(command, json, |name| std::env::var(name).ok())
}

fn start_with(command: &str, json: bool, get: impl Fn(&str) -> Option<String>) -> Run {
    if settings::disabled(&get) {
        return Run::off();
    }
    let identity = settings::identity(&get);
    let live = match settings::read(&get, identity.clone()) {
        Reading::Off => None,
        Reading::Ignored(variable) => {
            if !json {
                eprintln!(
                    "marfa: {variable} is not an http or https address, so this run sends no traces"
                );
            }
            None
        }
        Reading::On(settings) => live(command, &settings),
    };
    Run {
        exceptions: exceptions(command, json, &identity, &get),
        live,
    }
}

/// PostHog's trouble is said on standard error unless `json` is set, as a
/// collector's is.
fn exceptions(
    command: &str,
    json: bool,
    identity: &Identity,
    get: &impl Fn(&str) -> Option<String>,
) -> Option<posthog::Reporter> {
    match posthog::read(get, resource(identity), identity.timeout) {
        posthog::Reading::Off => None,
        posthog::Reading::Said(said) => {
            if !json {
                eprintln!("marfa: {said}");
            }
            None
        }
        posthog::Reading::On(posthog) => Some(posthog::Reporter::new(posthog, command)),
    }
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
/// moment as an interrupt is still a failure.
fn failed(status: u8, error: Option<&CliError>) -> bool {
    status != 0 && status != INTERRUPTED && !error.is_some_and(|error| error.code() == "canceled")
}

/// The status a process leaves with when a panic unwinds out of `main`.
const PANICKED: u8 = 101;

impl Run {
    fn off() -> Run {
        Run {
            live: None,
            exceptions: None,
        }
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
        let failure = failed(status, error);
        self.end(status, failure, error.map_or(Cause::Exit, Cause::Error));
    }

    /// Ends a run whose command panicked, which leaves the process with the
    /// status Rust gives a panic. The panic's message and location are not
    /// reported: either can carry content.
    pub fn panicked(self) {
        self.end(PANICKED, true, Cause::Panic);
    }

    fn end(self, status: u8, failure: bool, cause: Cause) {
        // Sent beside the trace's last send, not after it, so that the two
        // together wait no longer than one timeout.
        let exception = self
            .exceptions
            .filter(|_| failure)
            .and_then(|reporter| reporter.report(status, cause));
        if let Some(live) = self.live {
            live.root.record("exit_code", u64::from(status));
            if failure {
                match cause {
                    Cause::Error(error) => tracing::error!(
                        parent: &live.root,
                        code = error.code(),
                        exit_code = u64::from(status),
                        "the command failed"
                    ),
                    Cause::Panic => tracing::error!(
                        parent: &live.root,
                        code = "panic",
                        exit_code = u64::from(status),
                        "the command failed"
                    ),
                    Cause::Exit => tracing::error!(
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
        if let Some(exception) = exception {
            exception.wait();
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
        assert!(failed(3, Some(&refused)));
        assert!(failed(3, None));
        assert!(!failed(0, None));
        assert!(!failed(INTERRUPTED, None));
        assert!(!failed(3, Some(&canceled)));
        // The witness: a real failure is one whether or not Ctrl-C came with
        // it, since the rule takes no account of the signal.
        let credential = CliError::from(marfa_core::CoreError::SignedOut {
            origin: "https://marfa.example".into(),
        });
        let local = CliError::from(marfa_core::CoreError::NoCursor);
        assert!(failed(5, Some(&credential)));
        assert!(failed(4, Some(&local)));
    }

    fn started(pairs: &[(&str, &str)]) -> Run {
        start_with("marfa status", true, |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        })
    }

    const POSTHOG: [(&str, &str); 2] = [
        ("MARFA_POSTHOG_HOST", "http://127.0.0.1:9"),
        ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_token"),
    ];

    #[test]
    fn with_no_setting_a_run_starts_nothing() {
        let run = started(&[]);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_none());
        assert_eq!(run.within(|| 7), 7);
        run.finish(3, None);
    }

    #[test]
    fn posthog_alone_asks_for_the_exception_and_not_the_trace() {
        let run = started(&POSTHOG);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_some());
    }

    /// The trace side is shown by the binary's own tests: starting one sets
    /// the process's global subscriber, which a unit test must not.
    #[test]
    fn a_malformed_endpoint_leaves_the_exception_and_a_malformed_host_leaves_no_exception() {
        let mut env = POSTHOG.to_vec();
        env.push(("OTEL_EXPORTER_OTLP_ENDPOINT", "not a url"));
        let run = started(&env);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_some());

        let run = started(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "not a url"),
            ("MARFA_POSTHOG_HOST", "ftp://posthog.example"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_token"),
        ]);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_none());
    }

    #[test]
    fn a_disabled_sdk_turns_off_both_reports() {
        let mut env = POSTHOG.to_vec();
        env.push(("OTEL_SDK_DISABLED", "true"));
        let run = started(&env);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_none());

        env.push(("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9"));
        let run = started(&env);
        assert!(run.live.is_none());
        assert!(run.exceptions.is_none());
        // The witness: without the switch, PostHog alone is asked for.
        assert!(started(&POSTHOG).exceptions.is_some());
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
