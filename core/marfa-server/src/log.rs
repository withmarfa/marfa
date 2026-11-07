//! Stdout carries only JSON objects, one per line. A log record has `level`
//! and `message`; a request record has neither.
//!
//! The same events also leave for an OTLP collector, once telemetry has one:
//! see [`crate::telemetry`].

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

/// The layer that sends log records to a collector, once there is one.
pub fn logs() -> &'static Logs {
    LOGS.get_or_init(Logs::default)
}

pub fn init() {
    let lines = fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .with_writer(std::io::stdout)
        .with_filter(filter_fn(|metadata| metadata.target() != REQUEST_TARGET));
    let _ = tracing_subscriber::registry()
        .with(lines)
        .with(logs().clone())
        .with(LevelFilter::INFO)
        .try_init();
}

/// One request's record, written once its answer is ready.
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
    let Ok(mut line) = serde_json::to_vec(record) else {
        return;
    };
    line.push(b'\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&line);
    let _ = out.flush();
}

/// A request that ended in a fault no refusal foresaw. `error` is the fault's
/// message, which holds nothing a statement was given.
pub fn unhandled(request_id: &str, method: &str, path: &str, route: Option<&str>, error: &str) {
    tracing::error!(request_id, method, path, route, error, "Unhandled error");
}
