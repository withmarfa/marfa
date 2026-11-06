//! Stdout carries only JSON objects, one per line, so a supervisor can read
//! every line. Diagnostics go to stderr through `tracing`.

use std::io::Write;

use serde_json::{Map, Value, json};

use crate::clock;

pub fn line(level: &str, message: &str) {
    let mut record = Map::new();
    record.insert("timestamp".into(), clock::now_stamp().into());
    record.insert("level".into(), level.into());
    record.insert("message".into(), message.into());
    emit(record);
}

/// One request's record, written once its answer is sent.
pub struct Request<'a> {
    pub request_id: &'a str,
    pub method: &'a str,
    pub transport: &'a str,
    pub path: &'a str,
    pub route: Option<&'a str>,
    pub status: u16,
    pub duration_ms: f64,
    pub key_id: Option<&'a str>,
    pub error_code: Option<&'a str>,
}

pub fn request(request: Request<'_>) {
    let level = match request.status {
        500.. => "error",
        400.. => "warn",
        _ => "info",
    };
    let mut record = Map::new();
    record.insert("timestamp".into(), clock::now_stamp().into());
    record.insert("level".into(), level.into());
    record.insert("message".into(), "request".into());
    record.insert("request_id".into(), request.request_id.into());
    record.insert("method".into(), request.method.into());
    record.insert("transport".into(), request.transport.into());
    record.insert("path".into(), request.path.into());
    if let Some(route) = request.route {
        record.insert("route".into(), route.into());
    }
    record.insert("status".into(), request.status.into());
    record.insert(
        "duration_ms".into(),
        json!((request.duration_ms * 1000.0).round() / 1000.0),
    );
    if let Some(key_id) = request.key_id {
        record.insert("key_id".into(), key_id.into());
    }
    if let Some(code) = request.error_code {
        record.insert("error_code".into(), code.into());
    }
    emit(record);
}

fn emit(record: Map<String, Value>) {
    let mut text = Value::Object(record).to_string();
    text.push('\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}
