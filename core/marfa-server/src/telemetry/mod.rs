//! Nothing here is on a request's way: facts go to a bounded queue that drops when full.

pub mod config;
mod fault;
mod lane;
mod logs;
mod otel;
mod sinks;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use http::HeaderMap;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{Span as _, SpanKind, Status, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_http::HeaderExtractor;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider, Span};

pub use config::Config;
pub use fault::{Fault, Kind, caught, install_panic_hook};
pub use logs::{Logs, REQUEST_TARGET};

use lane::Lane;
use sinks::{Failed, Raised, Report, Tracked};

use crate::settings::Snapshot;
use crate::settings::registry::{ALLOW_PRIVATE_ADDRESSES, ERROR_REPORTING_ENABLED};

pub const FLUSH_WITHIN: Duration = Duration::from_millis(750);
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

struct Active {
    tracer: Option<SdkTracer>,
    tracers: Option<SdkTracerProvider>,
    loggers: Option<SdkLoggerProvider>,
    off: bool,
    exceptions: Lane<Tracked>,
}

#[derive(Clone, Default)]
pub struct Telemetry {
    active: Arc<OnceLock<Active>>,
}

pub struct RequestSpan(Span);

pub struct Guard {
    telemetry: Telemetry,
    stopped: bool,
}

impl Guard {
    pub fn stop(mut self, within: Duration) {
        self.stopped = true;
        self.telemetry.flush(within);
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.stopped {
            self.telemetry.flush(FLUSH_WITHIN);
        }
    }
}

fn identity(config: &Config, instance_id: &str) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("service.name".to_string(), config.service.clone()),
        ("service.instance.id".to_string(), instance_id.to_string()),
        (
            "service.version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    for (key, value) in &config.resource {
        match pairs.iter_mut().find(|(held, _)| held == key) {
            Some(held) => held.1 = value.clone(),
            None => pairs.push((key.clone(), value.clone())),
        }
    }
    pairs
}

impl Telemetry {
    /// The instance id is read from the database, which opens after the process starts.
    pub fn start(&self, config: &Config, instance_id: &str, settings: &Snapshot) -> Guard {
        let pairs = identity(config, instance_id);
        let sampler = marfa_telemetry::sampler::Sampler::Ratio(config.ratio);
        let (mut tracer, mut tracers, mut loggers) = (None, None, None);
        if let Some(export) = &config.traces {
            match otel::tracer_provider(export, otel::resource(&pairs), sampler) {
                Ok(provider) => {
                    use opentelemetry::trace::TracerProvider;
                    tracer = Some(provider.tracer("marfa-server"));
                    tracers = Some(provider);
                }
                Err(error) => tracing::error!(%error, "Traces could not be set up"),
            }
        }
        if let Some(export) = &config.logs {
            match otel::logger_provider(export, otel::resource(&pairs)) {
                Ok(provider) => {
                    crate::log::logs().connect(&provider);
                    loggers = Some(provider);
                }
                Err(error) => tracing::error!(%error, "Logs could not be set up"),
            }
        }
        let exceptions = sinks::exceptions(pairs);
        let _ = self.active.set(Active {
            tracer,
            tracers,
            loggers,
            off: config.off,
            exceptions,
        });
        self.follow(settings);
        Guard {
            telemetry: self.clone(),
            stopped: false,
        }
    }

    /// A stack is taken at a fault only while the settings name somewhere to report it.
    pub fn follow(&self, settings: &Snapshot) {
        if let Some(active) = self.active.get() {
            fault::capture_stacks(!active.off && settings.exception_receiver().is_some());
        }
    }

    pub fn begin(&self, headers: &HeaderMap, method: &str) -> Option<RequestSpan> {
        let tracer = self.active.get()?.tracer.as_ref()?;
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
        let Some(active) = self.active.get().filter(|active| !active.off) else {
            return;
        };
        if !settings.get(ERROR_REPORTING_ENABLED) {
            return;
        }
        if let Some(receiver) = settings.exception_receiver() {
            active.exceptions.offer(Tracked {
                report,
                receiver,
                private_allowed: settings.get(ALLOW_PRIVATE_ADDRESSES),
            });
        }
    }

    pub fn flush(&self, within: Duration) {
        let Some(active) = self.active.get() else {
            return;
        };
        let deadline = Instant::now() + within;
        let left = || deadline.saturating_duration_since(Instant::now());
        if let Some(provider) = &active.tracers {
            let _ = provider.shutdown_with_timeout(left());
        }
        if let Some(provider) = &active.loggers {
            let _ = provider.shutdown_with_timeout(left());
        }
        active.exceptions.flush(left());
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
