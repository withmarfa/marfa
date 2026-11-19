//! Nothing here is on a request's way: facts go to a bounded queue that drops when full.

pub mod config;
mod fault;
mod lane;
mod logs;
mod otel;
mod sinks;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use http::HeaderMap;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{Span as _, SpanKind, Status, Tracer, TracerProvider as _};
use opentelemetry::{Context, KeyValue};
use opentelemetry_http::HeaderExtractor;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider, Span};

pub use fault::{Fault, Kind, caught, install_panic_hook};
pub use logs::{Logs, REQUEST_TARGET};

use config::Wanted;
use lane::Lane;
use otel::{Leg, Relay};
use sinks::{Failed, Raised, Report, Tracked};

use crate::settings::registry::{
    ALLOW_PRIVATE_ADDRESSES, ERROR_REPORTING_ENABLED, TELEMETRY_ENABLED,
};
use crate::settings::{Settings, Snapshot};

pub const FLUSH_WITHIN: Duration = Duration::from_millis(750);
/// How long a retired exporter has to send what it holds.
const RETIRE_WITHIN: Duration = Duration::from_secs(3);
const CONNECTOR_RUN_FAILED: &str = "ConnectorRunFailed";
const CONNECTOR_RUN_FAILED_VALUE: &str = "A connector reported that its last run failed.";

/// A raw path is here only for the exception report, which names it; a span and a log record
/// carry the route's template.
pub struct Finished<'a> {
    pub request_id: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub route: Option<&'a str>,
    pub transport: &'a str,
    pub status: u16,
    pub error_code: Option<&'a str>,
    pub fault: Option<&'a Arc<Fault>>,
    /// The settings as they stand now, which say where a fault is reported.
    pub settings: &'a Snapshot,
    pub timestamp: &'a str,
}

/// An exporter taken out of use, shut down off the request path.
enum Retired {
    Traces(Arc<Leg>),
    Logs(SdkLoggerProvider),
    Drained(mpsc::SyncSender<()>),
}

/// What started once the instance's id was read.
struct Started {
    instance_id: String,
    relay: Relay,
    tracer: SdkTracer,
    tracers: SdkTracerProvider,
    exceptions: Lane<Tracked>,
    retire: Sender<Retired>,
}

#[derive(Default)]
struct Applied {
    wanted: Option<Wanted>,
    loggers: Option<SdkLoggerProvider>,
    stopped: bool,
}

#[derive(Default)]
struct Inner {
    started: OnceLock<Started>,
    applied: Mutex<Applied>,
    pairs: ArcSwap<Vec<(String, String)>>,
}

/// Traces, log records and exception reports, sent as the stored settings say and rebuilt
/// when they change.
#[derive(Clone, Default)]
pub struct Telemetry {
    inner: Arc<Inner>,
}

pub struct RequestSpan(Span);

pub struct Guard {
    telemetry: Telemetry,
    stopped: bool,
}

impl Guard {
    pub fn stop(mut self, within: Duration) {
        self.stopped = true;
        self.telemetry.stop(within);
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.stopped {
            self.telemetry.stop(FLUSH_WITHIN);
        }
    }
}

/// One thread shuts each retired exporter down, so a request or a write never waits on a
/// collector.
fn retirer() -> Sender<Retired> {
    let (sender, inbox) = mpsc::channel::<Retired>();
    let work = move || {
        for retired in inbox {
            match retired {
                Retired::Traces(leg) => {
                    let _ = leg.shutdown_with_timeout(RETIRE_WITHIN);
                }
                Retired::Logs(provider) => {
                    let _ = provider.shutdown_with_timeout(RETIRE_WITHIN);
                }
                Retired::Drained(done) => {
                    let _ = done.send(());
                }
            }
        }
    };
    // A thread that cannot start leaves each retired exporter to its own drop.
    let _ = thread::Builder::new()
        .name("telemetry-retire".to_string())
        .spawn(work);
    sender
}

impl Telemetry {
    /// The instance id is read from the database, which opens after the process starts.
    pub fn start(&self, instance_id: &str, settings: &Settings) -> Guard {
        let relay = Relay::default();
        let tracers = otel::relay_provider(relay.clone());
        let started = Started {
            instance_id: instance_id.to_string(),
            tracer: tracers.tracer("marfa-server"),
            relay,
            tracers,
            exceptions: sinks::exceptions(),
            retire: retirer(),
        };
        let _ = self.inner.started.set(started);
        self.follow(settings);
        Guard {
            telemetry: self.clone(),
            stopped: false,
        }
    }

    /// Takes the settings as they stand once it holds the lock, so the last change applied is
    /// the newest whichever caller gets here last. Building an exporter reads nothing and sends
    /// nothing; the one it replaces is shut down on the retire thread.
    pub fn follow(&self, settings: &Settings) {
        let Some(started) = self.inner.started.get() else {
            return;
        };
        let mut applied = self
            .inner
            .applied
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if applied.stopped {
            return;
        }
        let live = settings.live();
        fault::capture_stacks(live.get(TELEMETRY_ENABLED) && live.exception_receiver().is_some());
        let wanted = config::wanted(&live, &started.instance_id);
        if applied.wanted.as_ref() == Some(&wanted) {
            return;
        }
        let before = applied.wanted.take();
        let traces_same = before.as_ref().is_some_and(|held| {
            held.traces == wanted.traces && held.pairs == wanted.pairs && held.ratio == wanted.ratio
        });
        let logs_same = before
            .as_ref()
            .is_some_and(|held| held.logs == wanted.logs && held.pairs == wanted.pairs);
        self.inner.pairs.store(Arc::new(wanted.pairs.clone()));
        if !traces_same {
            let leg = wanted.traces.as_ref().and_then(|export| {
                otel::trace_leg(export, &wanted.pairs, wanted.ratio)
                    .map_err(|error| tracing::error!(%error, "Traces could not be set up"))
                    .ok()
            });
            if let Some(old) = started.relay.0.swap(leg.map(Arc::new)) {
                let _ = started.retire.send(Retired::Traces(old));
            }
        }
        if !logs_same {
            let provider = wanted.logs.as_ref().and_then(|export| {
                otel::logger_provider(export, &wanted.pairs)
                    .map_err(|error| tracing::error!(%error, "Logs could not be set up"))
                    .ok()
            });
            match &provider {
                Some(provider) => crate::log::logs().connect(provider),
                None => crate::log::logs().disconnect(),
            }
            if let Some(old) = std::mem::replace(&mut applied.loggers, provider) {
                let _ = started.retire.send(Retired::Logs(old));
            }
        }
        applied.wanted = Some(wanted);
    }

    pub fn begin(&self, headers: &HeaderMap, method: &str) -> Option<RequestSpan> {
        let started = self.inner.started.get()?;
        started.relay.0.load().as_ref()?;
        let tracer = &started.tracer;
        catch_unwind(AssertUnwindSafe(|| {
            let parent = TraceContextPropagator::new()
                .extract_with_context(&Context::new(), &HeaderExtractor(headers));
            let span = tracer
                .span_builder(method.to_string())
                .with_kind(SpanKind::Server)
                .start_with_context(tracer, &parent);
            RequestSpan(span)
        }))
        .ok()
    }

    /// Nothing that fails in here reaches the request.
    pub fn finish(&self, span: Option<RequestSpan>, done: &Finished<'_>) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let mut trace = None;
            if let Some(RequestSpan(mut span)) = span {
                annotate(&mut span, done);
                let context = span.span_context();
                if context.is_valid() {
                    trace = Some((
                        context.trace_id().to_string(),
                        context.span_id().to_string(),
                    ));
                }
                span.end();
            }
            if let Some(fault) = done.fault {
                self.offer(
                    done.settings,
                    Report {
                        raised: Raised::Fault(fault.clone()),
                        failed: Some(Failed {
                            request_id: done.request_id.to_string(),
                            method: done.method.to_string(),
                            path: done.path.to_string(),
                            error_code: done.error_code.unwrap_or("internal_error").to_string(),
                            trace,
                        }),
                        timestamp: done.timestamp.to_string(),
                    },
                );
            }
        }));
    }

    /// One report that a connector's run failed, which names no connector, run or error.
    pub fn report_connector_failure(&self, settings: &Snapshot, timestamp: &str) {
        self.offer(
            settings,
            Report {
                raised: Raised::Fixed {
                    kind: CONNECTOR_RUN_FAILED,
                    value: CONNECTOR_RUN_FAILED_VALUE,
                },
                failed: None,
                timestamp: timestamp.to_string(),
            },
        );
    }

    /// Error tracking takes a report only while the settings name a receiver and allow it.
    fn offer(&self, settings: &Snapshot, report: Report) {
        let Some(started) = self.inner.started.get() else {
            return;
        };
        if !settings.get(TELEMETRY_ENABLED) || !settings.get(ERROR_REPORTING_ENABLED) {
            return;
        }
        if let Some(receiver) = settings.exception_receiver() {
            started.exceptions.offer(Tracked {
                report,
                receiver,
                private_allowed: settings.get(ALLOW_PRIVATE_ADDRESSES),
                attributes: self.inner.pairs.load_full(),
            });
        }
    }

    /// Sends what the exporters hold, within `within` all told, and builds nothing after.
    fn stop(&self, within: Duration) {
        let Some(started) = self.inner.started.get() else {
            return;
        };
        let loggers = {
            let mut applied = self
                .inner
                .applied
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            applied.stopped = true;
            applied.wanted = None;
            applied.loggers.take()
        };
        let deadline = Instant::now() + within;
        let left = || deadline.saturating_duration_since(Instant::now());
        let _ = started.tracers.shutdown_with_timeout(left());
        crate::log::logs().disconnect();
        if let Some(provider) = loggers {
            let _ = provider.shutdown_with_timeout(left());
        }
        started.exceptions.flush(left());
        let (done, drained) = mpsc::sync_channel(1);
        if started.retire.send(Retired::Drained(done)).is_ok() {
            let _ = drained.recv_timeout(left());
        }
    }
}

fn annotate(span: &mut Span, done: &Finished<'_>) {
    let name = match done.route {
        Some(route) => format!("{} {route}", done.method),
        None => done.method.to_string(),
    };
    span.update_name(name);
    span.set_attribute(KeyValue::new(
        "http.request.method",
        done.method.to_string(),
    ));
    if let Some(route) = done.route {
        span.set_attribute(KeyValue::new("http.route", route.to_string()));
    }
    span.set_attribute(KeyValue::new(
        "http.response.status_code",
        i64::from(done.status),
    ));
    span.set_attribute(KeyValue::new(
        "marfa.request_id",
        done.request_id.to_string(),
    ));
    span.set_attribute(KeyValue::new("marfa.transport", done.transport.to_string()));
    if let Some(code) = done.error_code {
        span.set_attribute(KeyValue::new("error.code", code.to_string()));
    }
    if done.status >= 500 {
        span.set_status(Status::error(format!("{}", done.status)));
    }
    if let Some(fault) = done.fault {
        span.add_event(
            "exception",
            vec![
                KeyValue::new("exception.type", fault.kind.name()),
                KeyValue::new("exception.message", fault.message.clone()),
            ],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Environment;

    fn settings(dir: &tempfile::TempDir, seeds: &[(&str, &str)]) -> Settings {
        let database = dir.path().join("marfa.db");
        let mut pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
        ];
        pairs.extend_from_slice(seeds);
        Settings::read(Environment::from_pairs(&pairs))
            .unwrap()
            .open_secrets()
            .unwrap()
    }

    fn leg(telemetry: &Telemetry) -> Option<Arc<Leg>> {
        telemetry.inner.started.get().unwrap().relay.0.load_full()
    }

    fn rows(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn another_setting_rebuilds_nothing_and_the_last_of_many_changes_wins() {
        let dir = tempfile::TempDir::new().unwrap();
        let settings = settings(
            &dir,
            &[(
                "MARFA_OTEL_EXPORTER_OTLP_ENDPOINT",
                "http://collector.example:4318",
            )],
        );
        let telemetry = Telemetry::default();
        let guard = telemetry.start("id", &settings);
        let first = leg(&telemetry).expect("a leg for the endpoint");

        settings.apply_stored(&rows(&[("trash_retention_days", "7")]));
        telemetry.follow(&settings);
        assert!(Arc::ptr_eq(&first, &leg(&telemetry).unwrap()));
        assert!(crate::log::logs().is_on());

        for ratio in 1..=50 {
            settings.apply_stored(&rows(&[("otel_sample_ratio", &format!("0.{ratio:02}"))]));
            telemetry.follow(&settings);
        }
        assert!(!Arc::ptr_eq(&first, &leg(&telemetry).unwrap()));
        let applied = telemetry.inner.applied.lock().unwrap();
        assert_eq!(
            applied.wanted.as_ref().map(|wanted| wanted.ratio),
            Some(0.5)
        );
        drop(applied);

        settings.apply_stored(&rows(&[("telemetry_enabled", "false")]));
        telemetry.follow(&settings);
        assert!(leg(&telemetry).is_none());
        assert!(!crate::log::logs().is_on());
        guard.stop(Duration::from_secs(1));
        // Nothing is built once stopped.
        settings.apply_stored(&[]);
        telemetry.follow(&settings);
        assert!(leg(&telemetry).is_none());
    }

    #[test]
    fn a_stack_is_taken_only_while_a_sink_wants_one_and_starts_at_the_fault() {
        fault::capture_stacks(false);
        assert!(Fault::internal("x").frames().is_none());
        fault::capture_stacks(true);
        let frames = Fault::internal("x").frames().expect("a stack");
        fault::capture_stacks(false);
        let first = frames.first().expect("a frame");
        assert!(
            first.function.contains("a_stack_is_taken")
                || first
                    .module
                    .as_deref()
                    .is_some_and(|module| module.contains("telemetry::tests")),
            "{frames:#?}"
        );
    }
}
