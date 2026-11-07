//! Log records for the collector. A record carries its message and the fields
//! listed here and no others: a field that nobody listed could hold what an
//! owner wrote, a path with a title in it, or a credential.

use std::fmt::Debug;
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use opentelemetry::logs::{AnyValue, LogRecord, Logger, LoggerProvider, Severity};
use opentelemetry_sdk::logs::{SdkLogger, SdkLoggerProvider};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// The target the request records are logged under. They go to the collector
/// and not to standard output, which gets the same facts in its own shape.
pub const REQUEST_TARGET: &str = "marfa::request";

const SCOPE: &str = "marfa-server";

/// The fields of an event that leave the process.
const SENT: [&str; 13] = [
    "request_id",
    "method",
    "route",
    "status",
    "duration_ms",
    "transport",
    "error_code",
    "error",
    "setting",
    "sqlite_code",
    "context",
    "type_id",
    "panic_message",
];

/// The layer is always in the subscriber and does nothing until a provider is
/// handed to it.
#[derive(Clone, Default)]
pub struct Logs {
    logger: Arc<OnceLock<SdkLogger>>,
}

impl Logs {
    pub fn connect(&self, provider: &SdkLoggerProvider) {
        let _ = self.logger.set(provider.logger(SCOPE));
    }

    pub fn is_on(&self) -> bool {
        self.logger.get().is_some()
    }
}

struct Fields {
    body: Option<String>,
    attributes: Vec<(&'static str, AnyValue)>,
}

impl Fields {
    fn keep(&mut self, field: &Field, value: AnyValue) {
        if let Some(name) = SENT.iter().find(|name| **name == field.name()) {
            self.attributes.push((name, value));
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.body = Some(value.to_string());
        } else {
            self.keep(field, value.to_string().into());
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.keep(field, value.into());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.keep(field, i64::try_from(value).unwrap_or(i64::MAX).into());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.keep(field, value.into());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.keep(field, value.into());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            self.body = Some(format!("{value:?}"));
        } else {
            self.keep(field, format!("{value:?}").into());
        }
    }
}

fn severity(level: &Level) -> (Severity, &'static str) {
    match *level {
        Level::ERROR => (Severity::Error, "ERROR"),
        Level::WARN => (Severity::Warn, "WARN"),
        Level::INFO => (Severity::Info, "INFO"),
        Level::DEBUG => (Severity::Debug, "DEBUG"),
        Level::TRACE => (Severity::Trace, "TRACE"),
    }
}

impl<S: Subscriber> Layer<S> for Logs {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let Some(logger) = self.logger.get() else {
            return;
        };
        let mut fields = Fields {
            body: None,
            attributes: Vec::new(),
        };
        event.record(&mut fields);
        let mut record = logger.create_log_record();
        let (number, text) = severity(event.metadata().level());
        let now = SystemTime::now();
        record.set_timestamp(now);
        record.set_observed_timestamp(now);
        record.set_severity_number(number);
        record.set_severity_text(text);
        if let Some(body) = fields.body {
            record.set_body(body.into());
        }
        record.add_attributes(fields.attributes);
        logger.emit(record);
    }
}
