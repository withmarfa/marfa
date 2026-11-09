//! Traces and log records over OTLP/HTTP with JSON bodies, sent by a blocking client from
//! the exporters' own threads, with no retry.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use marfa_telemetry::sampler::Sampler;
use opentelemetry::KeyValue;
use opentelemetry::trace::{SpanId, Status, TraceId};
use opentelemetry_http::{Bytes, HttpClient, HttpError, Request, Response};
use opentelemetry_otlp::{
    LogExporter, Protocol, RetryPolicy, SpanExporter, WithExportConfig, WithHttpConfig,
};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::logs::{BatchLogProcessor, SdkLoggerProvider};
use opentelemetry_sdk::trace::{
    BatchSpanProcessor, SdkTracerProvider, Span, SpanData, SpanProcessor,
};

use super::config::Export;
use super::sinks::agent;

pub const MAX_HELD_SPANS: usize = 500;
/// How many traces are undecided at once; a trace over the number goes
/// unexported unless an error shows in its first span after that.
const MAX_HELD_TRACES: usize = 256;
const HOLD_LIMIT: Duration = Duration::from_secs(60);

/// Exporters call it from threads of their own, so a blocking call holds up no request.
#[derive(Debug)]
struct Blocking {
    agent: ureq::Agent,
}

impl HttpClient for Blocking {
    fn send_bytes<'a, 'b>(
        &'a self,
        request: Request<Bytes>,
    ) -> Pin<Box<dyn Future<Output = Result<Response<Bytes>, HttpError>> + Send + 'b>>
    where
        'a: 'b,
        Self: 'b,
    {
        let (parts, body) = request.into_parts();
        let request = Request::from_parts(parts, plain_integers(&body));
        let sent = self.agent.run(request);
        Box::pin(async move {
            let mut response = sent?;
            let status = response.status();
            let body = response.body_mut().read_to_vec()?;
            let mut out = Response::new(Bytes::from(body));
            *out.status_mut() = status;
            *out.headers_mut() = response.headers().clone();
            Ok(out)
        })
    }
}

/// The exporter writes every 64-bit integer as a string (protobuf JSON mapping); an
/// `intValue` that a double holds exactly is sent as a number, as most readers expect.
fn plain_integers(body: &[u8]) -> Vec<u8> {
    fn walk(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(digits)) = map.get("intValue")
                    && let Ok(whole) = digits.parse::<i64>()
                    && whole.unsigned_abs() <= 1 << 53
                {
                    map.insert("intValue".into(), whole.into());
                }
                map.values_mut().for_each(walk);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(walk),
            _ => {}
        }
    }
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(mut parsed) => {
            walk(&mut parsed);
            serde_json::to_vec(&parsed).unwrap_or_else(|_| body.to_vec())
        }
        Err(_) => body.to_vec(),
    }
}

fn client(export: &Export) -> Blocking {
    Blocking {
        agent: agent(export.timeout, &export.url),
    }
}

fn headers(export: &Export) -> HashMap<String, String> {
    export.headers.iter().cloned().collect()
}

pub fn resource(pairs: &[(String, String)]) -> Resource {
    Resource::builder_empty()
        .with_attributes(
            pairs
                .iter()
                .map(|(key, value)| KeyValue::new(key.clone(), value.clone())),
        )
        .build()
}

pub fn tracer_provider(
    export: &Export,
    resource: Resource,
    sampler: Sampler,
) -> Result<SdkTracerProvider, String> {
    let exporter = SpanExporter::builder()
        .with_http()
        .with_http_client(client(export))
        .with_protocol(Protocol::HttpJson)
        .with_endpoint(export.url.clone())
        .with_timeout(export.timeout)
        .with_headers(headers(export))
        .with_retry_policy(RetryPolicy::disabled())
        .build()
        .map_err(|error| error.to_string())?;
    let batch = BatchSpanProcessor::builder(exporter).build();
    Ok(SdkTracerProvider::builder()
        .with_resource(resource)
        .with_span_processor(Tail::new(batch, sampler))
        .build())
}

pub fn logger_provider(export: &Export, resource: Resource) -> Result<SdkLoggerProvider, String> {
    let exporter = LogExporter::builder()
        .with_http()
        .with_http_client(client(export))
        .with_protocol(Protocol::HttpJson)
        .with_endpoint(export.url.clone())
        .with_timeout(export.timeout)
        .with_headers(headers(export))
        .with_retry_policy(RetryPolicy::disabled())
        .build()
        .map_err(|error| error.to_string())?;
    Ok(SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_log_processor(BatchLogProcessor::builder(exporter).build())
        .build())
}

enum Trace {
    Held {
        spans: Vec<SpanData>,
        since: Instant,
    },
    Kept,
}

/// A held trace is exported whatever the ratio if a span fails by or after its root ends.
#[derive(Debug)]
pub struct Tail<P> {
    next: P,
    sampler: Sampler,
    traces: Mutex<HashMap<TraceId, Trace>>,
}

impl std::fmt::Debug for Trace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Trace::Held { spans, .. } => write!(f, "Held({})", spans.len()),
            Trace::Kept => write!(f, "Kept"),
        }
    }
}

impl<P> Tail<P> {
    pub fn new(next: P, sampler: Sampler) -> Tail<P> {
        Tail {
            next,
            sampler,
            traces: Mutex::new(HashMap::new()),
        }
    }
}

fn failed(span: &SpanData) -> bool {
    matches!(span.status, Status::Error { .. })
}

impl<P: SpanProcessor> SpanProcessor for Tail<P> {
    fn on_start(&self, span: &mut Span, cx: &opentelemetry::Context) {
        self.next.on_start(span, cx);
    }

    fn on_end(&self, span: SpanData) {
        let id = span.span_context.trace_id();
        if self.sampler.keeps(&id.to_bytes()) {
            self.next.on_end(span);
            return;
        }
        let root = span.parent_span_id == SpanId::INVALID || span.parent_span_is_remote;
        let failed = failed(&span);
        let mut export = Vec::new();
        {
            let mut traces = self
                .traces
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            traces.retain(|_, trace| match trace {
                Trace::Held { since, .. } => now.duration_since(*since) < HOLD_LIMIT,
                Trace::Kept => true,
            });
            let room = traces.len() < MAX_HELD_TRACES;
            match traces.entry(id) {
                Entry::Occupied(mut held) => match held.get_mut() {
                    Trace::Kept => {
                        export.push(span);
                        if root {
                            held.remove();
                        }
                    }
                    Trace::Held { spans, .. } if failed => {
                        export.append(spans);
                        export.push(span);
                        if root {
                            held.remove();
                        } else {
                            held.insert(Trace::Kept);
                        }
                    }
                    Trace::Held { .. } if root => {
                        held.remove();
                    }
                    Trace::Held { spans, .. } => {
                        if spans.len() < MAX_HELD_SPANS {
                            spans.push(span);
                        }
                    }
                },
                Entry::Vacant(slot) => {
                    if failed {
                        if !root {
                            slot.insert(Trace::Kept);
                        }
                        export.push(span);
                    } else if !root && room {
                        slot.insert(Trace::Held {
                            spans: vec![span],
                            since: now,
                        });
                    }
                }
            }
        }
        for span in export {
            self.next.on_end(span);
        }
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.next.force_flush()
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.next.shutdown_with_timeout(timeout)
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.next.set_resource(resource);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::SystemTime;

    use opentelemetry::InstrumentationScope;
    use opentelemetry::trace::{SpanContext, TraceFlags, TraceState};

    use super::*;

    #[derive(Debug, Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl SpanProcessor for Recorder {
        fn on_start(&self, _: &mut Span, _: &opentelemetry::Context) {}

        fn on_end(&self, span: SpanData) {
            self.0.lock().unwrap().push(span.name.to_string());
        }

        fn force_flush(&self) -> OTelSdkResult {
            Ok(())
        }

        fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
            Ok(())
        }
    }

    const TRACE: u128 = 1 << 127;

    fn span(trace: u128, name: &str, parent: Option<u64>, failed: bool) -> SpanData {
        SpanData {
            span_context: SpanContext::new(
                TraceId::from_bytes(trace.to_be_bytes()),
                SpanId::from_bytes(1u64.to_be_bytes()),
                TraceFlags::SAMPLED,
                false,
                TraceState::default(),
            ),
            parent_span_id: parent
                .map_or(SpanId::INVALID, |id| SpanId::from_bytes(id.to_be_bytes())),
            parent_span_is_remote: false,
            span_kind: opentelemetry::trace::SpanKind::Internal,
            name: name.to_string().into(),
            start_time: SystemTime::now(),
            end_time: SystemTime::now(),
            attributes: Vec::new(),
            dropped_attributes_count: 0,
            events: Default::default(),
            links: Default::default(),
            status: if failed {
                Status::error("failed")
            } else {
                Status::Unset
            },
            instrumentation_scope: InstrumentationScope::builder("t").build(),
        }
    }

    fn tail(sampler: Sampler) -> (Tail<Recorder>, Recorder) {
        let recorder = Recorder::default();
        (Tail::new(recorder.clone(), sampler), recorder)
    }

    fn names(recorder: &Recorder) -> Vec<String> {
        recorder.0.lock().unwrap().clone()
    }

    #[test]
    fn a_trace_the_ratio_keeps_goes_through_whole() {
        let (tail, seen) = tail(Sampler::On);
        tail.on_end(span(TRACE, "child", Some(7), false));
        tail.on_end(span(TRACE, "root", None, false));
        assert_eq!(names(&seen), ["child", "root"]);
    }

    #[test]
    fn a_trace_without_an_error_is_dropped_when_the_ratio_keeps_none() {
        let (tail, seen) = tail(Sampler::Off);
        tail.on_end(span(TRACE, "child", Some(7), false));
        tail.on_end(span(TRACE, "root", None, false));
        assert!(names(&seen).is_empty());
        assert!(tail.traces.lock().unwrap().is_empty());
    }

    #[test]
    fn an_error_releases_the_spans_held_for_it_and_every_span_after() {
        let (tail, seen) = tail(Sampler::Off);
        tail.on_end(span(TRACE, "before", Some(7), false));
        tail.on_end(span(TRACE, "failed", Some(7), true));
        tail.on_end(span(TRACE, "after", Some(7), false));
        tail.on_end(span(TRACE, "root", None, false));
        assert_eq!(names(&seen), ["before", "failed", "after", "root"]);
        assert!(tail.traces.lock().unwrap().is_empty());
    }

    #[test]
    fn a_root_that_fails_exports_the_held_spans() {
        let (tail, seen) = tail(Sampler::Off);
        tail.on_end(span(TRACE, "child", Some(7), false));
        tail.on_end(span(TRACE, "root", None, true));
        assert_eq!(names(&seen), ["child", "root"]);
    }

    #[test]
    fn at_most_the_limit_of_spans_are_held_for_a_trace() {
        let (tail, seen) = tail(Sampler::Off);
        for number in 0..MAX_HELD_SPANS + 100 {
            tail.on_end(span(TRACE, &format!("held-{number}"), Some(7), false));
        }
        tail.on_end(span(TRACE, "failed", None, true));
        assert_eq!(names(&seen).len(), MAX_HELD_SPANS + 1);
    }

    #[test]
    fn traces_are_decided_apart() {
        let (tail, seen) = tail(Sampler::Off);
        let other = TRACE | 1;
        tail.on_end(span(TRACE, "a-child", Some(7), false));
        tail.on_end(span(other, "b-child", Some(7), false));
        tail.on_end(span(other, "b-failed", Some(7), true));
        tail.on_end(span(TRACE, "a-root", None, false));
        assert_eq!(names(&seen), ["b-child", "b-failed"]);
    }

    #[test]
    fn a_whole_number_attribute_is_sent_as_a_number() {
        let body = br#"{"a":[{"key":"k","value":{"intValue":"500"}},{"key":"big","value":{"intValue":"9007199254740993"}},{"key":"s","value":{"stringValue":"500"}}]}"#;
        let sent: serde_json::Value = serde_json::from_slice(&plain_integers(body)).unwrap();
        assert_eq!(sent["a"][0]["value"]["intValue"], 500);
        assert_eq!(sent["a"][1]["value"]["intValue"], "9007199254740993");
        assert_eq!(sent["a"][2]["value"]["stringValue"], "500");
        assert_eq!(plain_integers(b"not json"), b"not json");
    }
}
