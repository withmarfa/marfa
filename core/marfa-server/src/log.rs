//! Stdout carries only JSON objects, one per line. A log record has `level`
//! and `message`; a request record has neither.

use std::io::Write;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;

pub fn init() {
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .with_writer(std::io::stdout)
        .init();
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

fn write_line(record: &impl Serialize) {
    let Ok(mut line) = serde_json::to_vec(record) else {
        return;
    };
    line.push(b'\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&line);
    let _ = out.flush();
}

pub fn request(record: &Request<'_>) {
    write_line(record);
}

/// A warning for whoever reads this server's own output, written past
/// `tracing` so that nothing listening there can carry it elsewhere.
pub fn local_only(message: &str) {
    write_line(&serde_json::json!({
        "timestamp": now(),
        "level": "WARN",
        "message": message,
    }));
}
