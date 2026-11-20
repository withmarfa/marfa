//! What the stored settings ask telemetry to send, and where.

use marfa_telemetry::identity;
use marfa_telemetry::otlp::{self, Signal};

use crate::settings::Snapshot;
use crate::settings::registry::{
    ALLOW_PRIVATE_ADDRESSES, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_HEADERS,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    OTEL_RESOURCE_ATTRIBUTES, OTEL_SAMPLE_RATIO, OTEL_SERVICE_NAME, TELEMETRY_ENABLED,
};

const DEFAULT_SERVICE: &str = "marfa-server";

/// Where one OTLP signal is posted, with the headers it carries.
#[derive(Clone, PartialEq)]
pub struct Export {
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// `allow_private_addresses` as it stood when the export was built.
    pub private_allowed: bool,
}

/// What telemetry sends, compared with what it sends now so that a change of another setting
/// rebuilds nothing.
#[derive(Clone, PartialEq)]
pub struct Wanted {
    /// The resource attributes of every span, log record and metric, and the properties of every
    /// exception.
    pub pairs: Vec<(String, String)>,
    pub traces: Option<Export>,
    pub logs: Option<Export>,
    pub metrics: Option<Export>,
    pub ratio: f64,
}

pub fn wanted(settings: &Snapshot, instance_id: &str) -> Wanted {
    let on = settings.get(TELEMETRY_ENABLED);
    let base = settings.get(OTEL_EXPORTER_OTLP_ENDPOINT);
    let general = settings.get(OTEL_EXPORTER_OTLP_HEADERS);
    let private_allowed = settings.get(ALLOW_PRIVATE_ADDRESSES);
    let export = |signal: Signal| {
        let (own, own_headers) = match signal {
            Signal::Traces => (
                settings.get(OTEL_EXPORTER_OTLP_TRACES_ENDPOINT),
                settings.get(OTEL_EXPORTER_OTLP_TRACES_HEADERS),
            ),
            Signal::Logs => (
                settings.get(OTEL_EXPORTER_OTLP_LOGS_ENDPOINT),
                settings.get(OTEL_EXPORTER_OTLP_LOGS_HEADERS),
            ),
            Signal::Metrics => (
                settings.get(OTEL_EXPORTER_OTLP_METRICS_ENDPOINT),
                settings.get(OTEL_EXPORTER_OTLP_METRICS_HEADERS),
            ),
        };
        // A signal's own address counts only beside the base, as the settings' rule has it.
        let base = base.as_ref().map(|base| base.expose());
        let own = own
            .as_ref()
            .map(|own| own.expose())
            .filter(|_| base.is_some());
        let url = otlp::signal_url(own, base, signal).ok().flatten()?;
        let (headers, _) = otlp::merge_headers(
            general.as_ref().map(|list| list.expose()),
            own_headers.as_ref().map(|list| list.expose()),
        );
        Some(Export {
            url,
            headers,
            private_allowed,
        })
    };
    Wanted {
        pairs: pairs(settings, instance_id),
        traces: on.then(|| export(Signal::Traces)).flatten(),
        logs: on.then(|| export(Signal::Logs)).flatten(),
        metrics: on.then(|| export(Signal::Metrics)).flatten(),
        ratio: settings.get(OTEL_SAMPLE_RATIO),
    }
}

/// The server's own attributes, each replaced by one of the same name that
/// `otel_resource_attributes` names; `otel_service_name` wins over both.
fn pairs(settings: &Snapshot, instance_id: &str) -> Vec<(String, String)> {
    let mut named = settings
        .get(OTEL_RESOURCE_ATTRIBUTES)
        .as_deref()
        .and_then(identity::attributes)
        .unwrap_or_default();
    let listed_service = named
        .iter()
        .find(|(key, _)| key == "service.name")
        .map(|(_, value)| value.clone());
    named.retain(|(key, _)| key != "service.name");
    let service = settings
        .get(OTEL_SERVICE_NAME)
        .or(listed_service)
        .unwrap_or_else(|| DEFAULT_SERVICE.to_string());
    let mut pairs = vec![
        ("service.name".to_string(), service),
        ("service.instance.id".to_string(), instance_id.to_string()),
        (
            "service.version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    for (key, value) in named {
        match pairs.iter_mut().find(|(held, _)| *held == key) {
            Some(held) => held.1 = value,
            None => pairs.push((key, value)),
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::registry::{Seeds, Value};
    use crate::settings::sealed::Secret;

    fn snapshot(rows: &[(&str, &str)], secrets: &[(&'static str, &str)]) -> Snapshot {
        let seeds: Seeds = secrets
            .iter()
            .map(|(key, text)| (*key, Value::Secret(Some(Secret::new(text.to_string())))))
            .collect();
        let rows: Vec<(String, String)> = rows
            .iter()
            .map(|(key, text)| (key.to_string(), text.to_string()))
            .collect();
        Snapshot::resolve(&seeds, None, &rows, 0)
    }

    #[test]
    fn nothing_is_sent_when_nothing_is_set() {
        let wanted = wanted(&snapshot(&[], &[]), "id");
        assert!(wanted.traces.is_none() && wanted.logs.is_none() && wanted.metrics.is_none());
        assert_eq!(wanted.ratio, 0.05);
        assert_eq!(
            wanted.pairs[0],
            ("service.name".into(), "marfa-server".into())
        );
    }

    #[test]
    fn the_base_sends_every_signal_under_its_path_with_merged_headers() {
        let wanted = wanted(
            &snapshot(
                &[],
                &[
                    ("otel_exporter_otlp_endpoint", "http://collector:4318/?t=1"),
                    ("otel_exporter_otlp_headers", "a=1,b=2"),
                    ("otel_exporter_otlp_logs_headers", "B=3"),
                    ("otel_exporter_otlp_metrics_headers", "a=9"),
                    (
                        "otel_exporter_otlp_traces_endpoint",
                        "https://traces.example/in",
                    ),
                ],
            ),
            "id",
        );
        let traces = wanted.traces.expect("traces");
        let logs = wanted.logs.expect("logs");
        let metrics = wanted.metrics.expect("metrics");
        assert_eq!(traces.url, "https://traces.example/in");
        assert_eq!(logs.url, "http://collector:4318/v1/logs?t=1");
        assert_eq!(metrics.url, "http://collector:4318/v1/metrics?t=1");
        let pair = |key: &str, value: &str| (key.to_string(), value.to_string());
        assert_eq!(traces.headers, [pair("a", "1"), pair("b", "2")]);
        assert_eq!(logs.headers, [pair("a", "1"), pair("B", "3")]);
        assert_eq!(metrics.headers, [pair("b", "2"), pair("a", "9")]);
    }

    #[test]
    fn a_signal_endpoint_without_the_base_sends_nothing() {
        for (key, url) in [
            (
                "otel_exporter_otlp_traces_endpoint",
                "https://traces.example/in",
            ),
            (
                "otel_exporter_otlp_metrics_endpoint",
                "https://metrics.example/in",
            ),
        ] {
            let alone = wanted(&snapshot(&[], &[(key, url)]), "id");
            assert!(alone.traces.is_none() && alone.logs.is_none() && alone.metrics.is_none());
        }
    }

    #[test]
    fn the_switch_stops_every_signal_and_keeps_everything_else() {
        let base = [("otel_exporter_otlp_endpoint", "http://collector:4318")];
        let on = wanted(&snapshot(&[], &base), "id");
        assert!(on.traces.is_some() && on.logs.is_some() && on.metrics.is_some());
        let off = wanted(&snapshot(&[("telemetry_enabled", "false")], &base), "id");
        assert!(off.traces.is_none() && off.logs.is_none() && off.metrics.is_none());
        assert_eq!(off.pairs, on.pairs);
    }

    #[test]
    fn the_service_name_setting_wins_over_the_attribute_and_attributes_replace_the_servers() {
        let named = wanted(
            &snapshot(
                &[
                    ("otel_service_name", "mine"),
                    (
                        "otel_resource_attributes",
                        "service.name=theirs,service.instance.id=other,team=a%20b",
                    ),
                ],
                &[],
            ),
            "id",
        );
        let get = |key: &str| {
            named
                .pairs
                .iter()
                .find(|(held, _)| held == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("service.name"), Some("mine"));
        assert_eq!(get("service.instance.id"), Some("other"));
        assert_eq!(get("team"), Some("a b"));
        let listed = wanted(
            &snapshot(&[("otel_resource_attributes", "service.name=theirs")], &[]),
            "id",
        );
        assert_eq!(listed.pairs[0].1, "theirs");
    }

    #[test]
    fn another_setting_leaves_what_is_wanted_equal() {
        let base = [("otel_exporter_otlp_endpoint", "http://collector:4318")];
        let before = wanted(&snapshot(&[], &base), "id");
        let after = wanted(&snapshot(&[("trash_retention_days", "7")], &base), "id");
        assert!(before == after);
        let private = wanted(
            &snapshot(&[("allow_private_addresses", "true")], &base),
            "id",
        );
        assert!(before != private);
    }
}
