//! Traces and log records over OTLP/HTTP with JSON bodies, sent by a blocking
//! client from the exporters' own threads. There is no retry: a collector that
//! refuses or hangs loses what was queued for it, and nothing else.

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

/// The most spans a trace holds back while it is undecided.
pub const MAX_HELD_SPANS: usize = 500;
/// How many traces are undecided at once; a trace over the number goes
/// unexported unless an error shows in its first span after that.
const MAX_HELD_TRACES: usize = 256;
/// A trace whose root never ends is let go after this long.
const HOLD_LIMIT: Duration = Duration::from_secs(60);

/// A blocking client behind the exporters' asynchronous interface. The
/// exporters call it from threads of their own, which a blocking call
/// holds up and no request.
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
        let request = Request::from_parts(parts, body.to_vec());
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
    /// No span of it has failed, and its root has not ended.
    Held {
        spans: Vec<SpanData>,
        since: Instant,
    },
    /// A span of it failed: what follows is exported as it ends.
    Kept,
}

/// Decides a trace when its spans end. The ratio decides a trace as the
/// specification's `TraceIdRatioBased` does. A trace the ratio does not keep
/// is held, up to [`MAX_HELD_SPANS`] spans, until its local root ends; if a
/// span of it has failed by then, or fails after, the held spans and every
/// span after are exported whatever the ratio says.
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
