//! Stdout carries only JSON objects, one per line. A log record has `level` and `message`;
//! a request record has neither. The same events also leave for an OTLP collector (see
//! [`crate::telemetry`]).

use std::io::Write;
use std::sync::OnceLock;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use tracing_subscriber::filter::{LevelFilter, filter_fn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Layer, fmt};

use crate::telemetry::{Logs, REQUEST_TARGET};

static LOGS: OnceLock<Logs> = OnceLock::new();

pub fn logs() -> &'static Logs {
    LOGS.get_or_init(Logs::default)
}

pub fn init() {
    let lines = fmt::layer()
        .event_format(Lines)
        .with_writer(std::io::stdout)
        .with_filter(filter_fn(|metadata| metadata.target() != REQUEST_TARGET));
    let _ = tracing_subscriber::registry()
        .with(lines)
        .with(logs().clone())
        .with(LevelFilter::INFO)
        .try_init();
}

struct Lines;

struct Collect(serde_json::Map<String, serde_json::Value>);

impl tracing::field::Visit for Collect {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), format!("{value:?}").into());
    }
}

impl<S, N> fmt::FormatEvent<S, N> for Lines
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    N: for<'a> fmt::FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _: &fmt::FmtContext<'_, S, N>,
        mut writer: fmt::format::Writer<'_>,
        event: &tracing::Event<'_>,
    ) -> std::fmt::Result {
        let mut record = Collect(serde_json::Map::new());
        record.0.insert("timestamp".into(), now_micros().into());
        record.0.insert(
            "level".into(),
            event.metadata().level().as_str().to_lowercase().into(),
        );
        event.record(&mut record);
        writeln!(writer, "{}", serde_json::Value::Object(record.0))
    }
}

fn now_micros() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, true)
}

#[derive(Serialize)]
pub struct Request<'a> {
    pub timestamp: &'a str,
    pub request_id: &'a str,
    pub method: &'a str,
    pub transport: &'a str,
    pub path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<&'a str>,
    pub status: u16,
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'a str>,
}

/// A record's time. The wall clock's, so a moved test clock cannot misplace it.
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn request(record: &Request<'_>) {
    if logs().is_on() {
        tracing::info!(
            target: REQUEST_TARGET,
            request_id = record.request_id,
            method = record.method,
            transport = record.transport,
            route = record.route,
            status = record.status,
            duration_ms = record.duration_ms,
            error_code = record.error_code,
            "Request"
        );
    }
    write_line(record);
}

fn write_line(record: &impl Serialize) {
    let Ok(mut line) = serde_json::to_vec(record) else {
        return;
    };
    line.push(b'\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&line);
    let _ = out.flush();
}

/// A warning for whoever reads this server's own output, written past
/// `tracing` so that nothing listening there can carry it elsewhere.
pub fn local_only(message: &str) {
    write_line(&serde_json::json!({
        "timestamp": now(),
        "level": "warn",
        "message": message,
    }));
}

/// A request that ended in a fault no refusal foresaw. `error` is the fault's
/// message, which holds nothing a statement was given.
pub fn unhandled(request_id: &str, method: &str, path: &str, route: Option<&str>, error: &str) {
    tracing::error!(request_id, method, path, route, error, "Unhandled error");
}
