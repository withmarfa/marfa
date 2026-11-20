//! Request duration and resident memory over OTLP/HTTP with JSON bodies, through the same
//! blocking client as traces and log records.

use std::time::Duration;

use marfa_telemetry::identity::DEFAULT_TIMEOUT;
use opentelemetry::KeyValue;
use opentelemetry::metrics::{Histogram, MeterProvider as _};
use opentelemetry_otlp::{MetricExporter, Protocol, RetryPolicy, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider, Temporality};

use super::config::Export;
use super::otel::{Halt, client, resource};

pub const REQUEST_DURATION: &str = "http.server.request.duration";
pub const MEMORY_USAGE: &str = "process.memory.usage";

/// The bucket boundaries, in seconds, that the OpenTelemetry HTTP semantic conventions advise.
pub const DURATION_BOUNDARIES: [f64; 14] = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];

/// How often the SDK collects and sends. The reader reads `OTEL_METRIC_EXPORT_INTERVAL` unless
/// an interval is set.
pub const EXPORT_INTERVAL: Duration = Duration::from_secs(60);

const METHODS: [&str; 9] = [
    "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE",
];

/// What one request is recorded as. Nothing but these three is kept, so a path with ids, a query
/// or a header never reaches a metric.
pub struct Served<'a> {
    pub method: &'a str,
    pub route: Option<&'a str>,
    pub status: u16,
    pub elapsed: Duration,
}

/// The exporter one set of metric settings built, with its own resource.
#[derive(Debug)]
pub struct Meters {
    provider: SdkMeterProvider,
    duration: Histogram<f64>,
    pub halt: Halt,
}

impl Meters {
    pub fn record(&self, served: &Served<'_>) {
        let method = if METHODS.contains(&served.method) {
            served.method
        } else {
            "_OTHER"
        };
        let mut attributes = vec![KeyValue::new("http.request.method", method.to_string())];
        if let Some(route) = served.route {
            attributes.push(KeyValue::new("http.route", route.to_string()));
        }
        attributes.push(KeyValue::new(
            "http.response.status_code",
            i64::from(served.status),
        ));
        self.duration
            .record(served.elapsed.as_secs_f64(), &attributes);
    }

    /// Sends one last collection, and nothing after.
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.provider.shutdown_with_timeout(timeout)
    }
}

/// Every setting is pinned in code, since the exporter and the reader read
/// `OTEL_EXPORTER_OTLP_METRICS_*` and `OTEL_METRIC_EXPORT_INTERVAL` unless one is set.
pub fn metrics_leg(export: &Export, pairs: &[(String, String)]) -> Result<Meters, String> {
    let halt = Halt::default();
    let exporter = MetricExporter::builder()
        .with_http()
        .with_http_client(client(export, &halt))
        .with_protocol(Protocol::HttpJson)
        .with_endpoint(export.url.clone())
        .with_timeout(DEFAULT_TIMEOUT)
        .with_retry_policy(RetryPolicy::disabled())
        .with_temporality(Temporality::Cumulative)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(meters(exporter, pairs, halt, EXPORT_INTERVAL))
}

fn meters(
    exporter: impl PushMetricExporter,
    pairs: &[(String, String)],
    halt: Halt,
    interval: Duration,
) -> Meters {
    let reader = PeriodicReader::builder(exporter)
        .with_interval(interval)
        .build();
    let provider = SdkMeterProvider::builder()
        .with_resource(resource(pairs))
        .with_reader(reader)
        .build();
    let meter = provider.meter("marfa-server");
    let duration = meter
        .f64_histogram(REQUEST_DURATION)
        .with_description("How long the server took to answer a request.")
        .with_unit("s")
        .with_boundaries(DURATION_BOUNDARIES.to_vec())
        .build();
    // A reading that fails records no point.
    let _ = meter
        .i64_observable_up_down_counter(MEMORY_USAGE)
        .with_description("The memory the server process holds in physical memory.")
        .with_unit("By")
        .with_callback(|observer| {
            if let Some(bytes) =
                crate::app::metrics::resident_bytes().and_then(|bytes| i64::try_from(bytes).ok())
            {
                observer.observe(bytes, &[]);
            }
        })
        .build();
    Meters {
        provider,
        duration,
        halt,
    }
}

#[cfg(test)]
mod tests {
    use opentelemetry_sdk::metrics::InMemoryMetricExporter;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};

    use super::*;

    fn collected(exporter: &InMemoryMetricExporter) -> Vec<ResourceMetrics> {
        exporter.get_finished_metrics().unwrap()
    }

    fn meters_with(exporter: &InMemoryMetricExporter) -> Meters {
        meters(
            exporter.clone(),
            &[("service.name".into(), "t".into())],
            Halt::default(),
            Duration::from_secs(3600),
        )
    }

    fn named<'a>(
        resource: &'a ResourceMetrics,
        name: &str,
    ) -> Option<&'a opentelemetry_sdk::metrics::data::Metric> {
        resource
            .scope_metrics()
            .flat_map(|scope| scope.metrics())
            .find(|metric| metric.name() == name)
    }

    #[test]
    fn a_request_is_one_point_with_its_method_route_and_status_and_nothing_else() {
        let exporter = InMemoryMetricExporter::default();
        let meters = meters_with(&exporter);
        meters.record(&Served {
            method: "GET",
            route: Some("/items/{id}"),
            status: 200,
            elapsed: Duration::from_millis(30),
        });
        meters.record(&Served {
            method: "PURGE",
            route: None,
            status: 404,
            elapsed: Duration::from_millis(1),
        });
        meters.provider.force_flush().unwrap();
        let all = collected(&exporter);
        let metric = named(all.last().unwrap(), REQUEST_DURATION).expect("the histogram");
        assert_eq!(metric.unit(), "s");
        let AggregatedMetrics::F64(MetricData::Histogram(histogram)) = metric.data() else {
            panic!("not a histogram");
        };
        let mut seen: Vec<Vec<(String, String)>> = histogram
            .data_points()
            .map(|point| {
                assert_eq!(point.bounds().collect::<Vec<_>>(), DURATION_BOUNDARIES);
                point
                    .attributes()
                    .map(|kv| (kv.key.to_string(), kv.value.to_string()))
                    .collect()
            })
            .collect();
        seen.iter_mut().for_each(|attributes| attributes.sort());
        seen.sort();
        let pair = |key: &str, value: &str| (key.to_string(), value.to_string());
        assert_eq!(
            seen,
            [
                vec![
                    pair("http.request.method", "GET"),
                    pair("http.response.status_code", "200"),
                    pair("http.route", "/items/{id}"),
                ],
                vec![
                    pair("http.request.method", "_OTHER"),
                    pair("http.response.status_code", "404"),
                ],
            ]
        );
    }

    #[test]
    fn resident_memory_is_read_at_each_collection_in_bytes() {
        let exporter = InMemoryMetricExporter::default();
        let meters = meters_with(&exporter);
        meters.provider.force_flush().unwrap();
        let all = collected(&exporter);
        let metric = named(all.last().unwrap(), MEMORY_USAGE).expect("the memory metric");
        assert_eq!(metric.unit(), "By");
        let AggregatedMetrics::I64(MetricData::Sum(sum)) = metric.data() else {
            panic!("not a sum");
        };
        assert!(!sum.is_monotonic());
        let points: Vec<i64> = sum.data_points().map(|point| point.value()).collect();
        assert_eq!(points.len(), 1);
        assert!(points[0] > 1_000_000, "{points:?}");
    }
}
