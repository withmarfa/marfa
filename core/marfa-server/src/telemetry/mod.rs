//! What the server tells the outside about itself: traces and log records to
//! an OTLP collector, an exception report to PostHog's error tracking and a
//! notice to an error webhook.
//!
//! Nothing here is on a request's way. A request hands a finished fact to a
//! bounded queue that drops when full; a thread of its own sends it, with a
//! timeout and no retry. A collector that is absent, slow, refusing or hanging
//! changes nothing for a request.

pub mod config;
mod fault;
mod lane;
mod logs;
mod otel;
mod sinks;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{Span as _, SpanKind, Status, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_http::HeaderExtractor;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider, Span};

pub use config::Config;
pub use fault::{Fault, Kind, install_panic_hook};
pub use logs::{Logs, REQUEST_TARGET};

use lane::Lane;
use sinks::Report;

/// How long a stop waits for what is queued, unless the caller says less.
pub const FLUSH_WITHIN: Duration = Duration::from_millis(750);

/// The facts of a finished request that telemetry may carry. A raw path is
/// here only for the two sinks that name it; a span and a log record carry
/// the route's template.
pub struct Finished<'a> {
    pub request_id: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub route: Option<&'a str>,
    pub transport: &'a str,
    pub status: u16,
    pub error_code: Option<&'a str>,
    pub fault: Option<&'a Arc<Fault>>,
    /// Whether the effective `error_reporting_enabled` is on.
    pub reporting: bool,
    pub timestamp: &'a str,
}

struct Active {
    tracer: Option<SdkTracer>,
    tracers: Option<SdkTracerProvider>,
    loggers: Option<SdkLoggerProvider>,
    exceptions: Option<Lane<Report>>,
    webhook: Option<Lane<Report>>,
}

/// The server's telemetry, off until [`Telemetry::start`] turns on what the
/// settings ask for.
#[derive(Clone, Default)]
pub struct Telemetry {
    active: Arc<OnceLock<Active>>,
}

/// One request's span, to be ended with the answer.
pub struct RequestSpan(Span);

/// Stops what [`Telemetry::start`] began, sending what is queued, when it is
/// dropped or [`Guard::stop`] is called.
pub struct Guard {
    telemetry: Telemetry,
    stopped: bool,
}

impl Guard {
    /// Sends what is queued, waiting no longer than `within` in all.
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

/// The attributes everything exported carries: the server's own, each
/// replaced by the operator's attribute of the same name.
fn identity(config: &Config, instance_id: &str) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("service.name".to_string(), config.service.clone()),
        ("service.instance.id".to_string(), instance_id.to_string()),
        (
            "deployment.environment".to_string(),
            config.environment.clone(),
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
    /// Turns on what `config` asks for. The instance's id is read from the
    /// database, which opens after the process starts, so this comes after.
    pub fn start(&self, config: &Config, instance_id: &str) -> Guard {
        for notice in &config.notices {
            notice.say();
        }
        let pairs = identity(config, instance_id);
        fault::capture_stacks(config.exceptions.is_some());
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
        let exceptions = config
            .exceptions
            .clone()
            .map(|settings| sinks::exceptions(settings, pairs.clone()));
        let webhook = config
            .webhook
            .clone()
            .map(|settings| sinks::webhook(settings, config.environment.clone()));
        let _ = self.active.set(Active {
            tracer,
            tracers,
            loggers,
            exceptions,
            webhook,
        });
        Guard {
            telemetry: self.clone(),
            stopped: false,
        }
    }

    /// Begins the span of a request, a child of the trace its `traceparent`
    /// header names.
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

    /// Ends a request's span and reports its fault, if it had one. Whatever
    /// goes wrong in here is this function's, never the request's.
    pub fn finish(&self, span: Option<RequestSpan>, done: &Finished<'_>) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Some(RequestSpan(mut span)) = span {
                annotate(&mut span, done);
                span.end();
            }
            if let (Some(fault), true, Some(active)) =
                (done.fault, done.reporting, self.active.get())
            {
                let report = Report {
                    fault: fault.clone(),
                    request_id: done.request_id.to_string(),
                    method: done.method.to_string(),
                    path: done.path.to_string(),
                    error_code: done.error_code.unwrap_or("internal_error").to_string(),
                    timestamp: done.timestamp.to_string(),
                };
                if let Some(lane) = &active.webhook {
                    lane.offer(report.clone());
                }
                if let Some(lane) = &active.exceptions {
                    lane.offer(report);
                }
            }
        }));
    }

    /// Sends what is queued, waiting no longer than `within` in all.
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
        for lane in [&active.exceptions, &active.webhook].into_iter().flatten() {
            lane.flush(left());
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
