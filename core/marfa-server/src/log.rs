//! Stdout carries only JSON objects, one per line.

use std::io::Write;
use std::sync::OnceLock;

use serde::Serialize;
use tracing_subscriber::filter::{LevelFilter, filter_fn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Layer, fmt};

use marfa_rules::server_log::UpgradeRefusal;
use marfa_rules::time;

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

#[allow(clippy::disallowed_methods, reason = "the log records the host's time")]
fn now_micros() -> String {
    micros_text(jiff::Timestamp::now().as_microsecond())
}

fn micros_text(micros: i64) -> String {
    let millis = time::written(micros.div_euclid(1000));
    format!(
        "{}{:03}Z",
        millis.trim_end_matches('Z'),
        micros.rem_euclid(1000)
    )
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
#[allow(clippy::disallowed_methods, reason = "the log records the host's time")]
pub fn now() -> String {
    time::written(jiff::Timestamp::now().as_millisecond())
}

/// A read answered well within this is in the request log only, not exported.
const QUIET_READ_UNDER_MS: f64 = 1_000.0;

/// Quick successful reads, health checks and polling among them, would be nearly every
/// exported record.
fn exported(record: &Request<'_>) -> bool {
    let read = matches!(record.method, "GET" | "HEAD");
    let answered = (200..300).contains(&record.status) || record.status == 304;
    !(read && answered && record.duration_ms < QUIET_READ_UNDER_MS)
}

pub fn request(record: &Request<'_>) {
    if logs().is_on() && exported(record) {
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

/// The line the server writes as it stops for a failure to start, which the command line reads.
pub fn start_failed(failure: &crate::failure::Failure) {
    use marfa_rules::server_log::{ERROR, REFUSED, START_FAILED};
    tracing::error!(
        { ERROR } = %failure,
        { REFUSED } = failure.refusal.map(UpgradeRefusal::name),
        "{}",
        START_FAILED
    );
}

/// A request that ended in a fault no refusal foresaw. `error` is the fault's
/// message, which holds nothing a statement was given.
pub fn unhandled(request_id: &str, method: &str, path: &str, route: Option<&str>, error: &str) {
    tracing::error!(request_id, method, path, route, error, "Unhandled error");
}

/// A current-thread runtime's tasks share this thread's log capture.
#[cfg(test)]
pub(crate) struct Capture {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    _guard: tracing::subscriber::DefaultGuard,
}

#[cfg(test)]
impl Capture {
    pub(crate) fn start() -> Capture {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);

        impl Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        impl MakeWriter<'_> for Buffer {
            type Writer = Buffer;

            fn make_writer(&self) -> Buffer {
                self.clone()
            }
        }

        let buffer = Buffer::default();
        let subscriber = tracing_subscriber::registry()
            .with(fmt::layer().event_format(Lines).with_writer(buffer.clone()));
        Capture {
            buffer: buffer.0,
            _guard: tracing::subscriber::set_default(subscriber),
        }
    }

    pub(crate) fn log(&self) -> String {
        String::from_utf8(self.buffer.lock().unwrap().clone()).unwrap()
    }
}

/// What `f` logs, as the server writes it.
#[cfg(test)]
pub(crate) fn captured<R>(f: impl FnOnce() -> R) -> (R, String) {
    let capture = Capture::start();
    let result = f();
    (result, capture.log())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_read_that_went_well_and_quickly_stays_unexported() {
        let record = |method, path, status, duration_ms| Request {
            timestamp: "2026-11-19T10:00:00.000Z",
            request_id: "r",
            method,
            transport: "http",
            path,
            route: None,
            status,
            duration_ms,
            key_id: None,
            error_code: None,
        };
        for quiet in [
            record("GET", "/items", 200, 3.0),
            record("HEAD", "/items/x", 304, 999.9),
            record("GET", "/health", 200, 2.0),
        ] {
            assert!(
                !exported(&quiet),
                "{} {} {}",
                quiet.method,
                quiet.path,
                quiet.status
            );
        }
        for kept in [
            record("GET", "/health", 503, 2.0),
            record("POST", "/health", 405, 2.0),
            record("GET", "/items", 404, 3.0),
            record("GET", "/items", 500, 3.0),
            record("GET", "/items", 200, 1_000.0),
            record("POST", "/items", 201, 3.0),
            record("DELETE", "/items/x", 204, 3.0),
        ] {
            assert!(
                exported(&kept),
                "{} {} {}",
                kept.method,
                kept.path,
                kept.status
            );
        }
    }

    #[test]
    fn a_record_time_keeps_microseconds_and_a_stamp_milliseconds() {
        let at = time::epoch_ms("2026-11-18T12:34:56.123Z").unwrap();
        assert_eq!(micros_text(at * 1000 + 456), "2026-11-18T12:34:56.123456Z");
        assert_eq!(micros_text(at * 1000), "2026-11-18T12:34:56.123000Z");
        assert_eq!(micros_text(0), "1970-01-01T00:00:00.000000Z");
        assert_eq!(micros_text(-1), "1969-12-31T23:59:59.999999Z");
        assert_eq!(time::written(at), "2026-11-18T12:34:56.123Z");
    }
}
