use url::Url;

use crate::environment::text;
use crate::identity::headers;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Traces,
    Logs,
    Metrics,
}

pub const GENERAL_ENDPOINT: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
pub const GENERAL_HEADERS: &str = "OTEL_EXPORTER_OTLP_HEADERS";

impl Signal {
    pub const fn endpoint_variable(self) -> &'static str {
        match self {
            Signal::Traces => "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            Signal::Logs => "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            Signal::Metrics => "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        }
    }

    pub const fn headers_variable(self) -> &'static str {
        match self {
            Signal::Traces => "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
            Signal::Logs => "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
            Signal::Metrics => "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
        }
    }

    pub const fn timeout_variable(self) -> &'static str {
        match self {
            Signal::Traces => "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
            Signal::Logs => "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
            Signal::Metrics => "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Signal::Traces => "traces",
            Signal::Logs => "logs",
            Signal::Metrics => "metrics",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Endpoint {
    Off,
    /// Names the variable, never its value, which can carry a credential.
    Ignored(&'static str),
    On(String),
}

pub fn endpoint(get: &impl Fn(&str) -> Option<String>, signal: Signal) -> Endpoint {
    let own = text(get, signal.endpoint_variable());
    let base = text(get, GENERAL_ENDPOINT);
    match signal_url(own.as_deref(), base.as_deref(), signal) {
        Ok(None) => Endpoint::Off,
        Ok(Some(url)) => Endpoint::On(url),
        Err(Unusable::Own) => Endpoint::Ignored(signal.endpoint_variable()),
        Err(Unusable::Base) => Endpoint::Ignored(GENERAL_ENDPOINT),
    }
}

/// Which of the two addresses [`signal_url`] could not use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unusable {
    Own,
    Base,
}

/// Where a signal is posted: its own address as written, else the base with `v1/<signal>` on
/// its path, else nowhere.
pub fn signal_url(
    own: Option<&str>,
    base: Option<&str>,
    signal: Signal,
) -> Result<Option<String>, Unusable> {
    let (which, named, appends) = match (own, base) {
        (Some(address), _) => (Unusable::Own, address, false),
        (None, Some(base)) => (Unusable::Base, base, true),
        (None, None) => return Ok(None),
    };
    let parsed = Url::parse(named).ok().filter(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && !url.cannot_be_a_base()
    });
    let Some(mut parsed) = parsed else {
        return Err(which);
    };
    if appends {
        // On the path, so that a query the base carries stays a query.
        let Ok(mut path) = parsed.path_segments_mut() else {
            return Err(which);
        };
        path.pop_if_empty().push("v1").push(signal.path());
        drop(path);
        parsed.set_fragment(None);
    }
    Ok(Some(parsed.to_string()))
}

/// The signal's headers override the general variable's by name; also reports whether
/// every pair of both was readable.
pub fn signal_headers(
    get: &impl Fn(&str) -> Option<String>,
    signal: Signal,
) -> (Vec<(String, String)>, bool) {
    let general = text(get, GENERAL_HEADERS);
    let own = text(get, signal.headers_variable());
    merge_headers(general.as_deref(), own.as_deref())
}

/// The signal's own headers override the general ones by name; also reports whether every
/// pair of both was readable.
pub fn merge_headers(general: Option<&str>, own: Option<&str>) -> (Vec<(String, String)>, bool) {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut readable = true;
    for list in [general, own].into_iter().flatten() {
        let (kept, whole) = headers(list);
        readable &= whole;
        for (key, value) in kept {
            out.retain(|(held, _)| !held.eq_ignore_ascii_case(&key));
            out.push((key, value));
        }
    }
    (out, readable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn getter<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn url(pairs: &[(&str, &str)], signal: Signal) -> String {
        match endpoint(&getter(pairs), signal) {
            Endpoint::On(url) => url,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_endpoint_is_nothing_sent_whatever_else_is_set() {
        let none = |pairs: &[(&str, &str)]| endpoint(&getter(pairs), Signal::Traces);
        assert_eq!(none(&[]), Endpoint::Off);
        assert_eq!(
            none(&[
                ("OTEL_EXPORTER_OTLP_HEADERS", "a=b"),
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "500"),
            ]),
            Endpoint::Off
        );
        assert_eq!(none(&[(GENERAL_ENDPOINT, "  ")]), Endpoint::Off);
    }

    #[test]
    fn the_general_endpoint_gets_the_signal_path_and_the_signals_own_is_used_as_written() {
        let general = |value: &str, signal| url(&[(GENERAL_ENDPOINT, value)], signal);
        assert_eq!(
            general("http://collector:4318/", Signal::Traces),
            "http://collector:4318/v1/traces"
        );
        assert_eq!(
            general("http://collector:4318/base", Signal::Logs),
            "http://collector:4318/base/v1/logs"
        );
        assert_eq!(
            general("http://collector:4318/base/", Signal::Traces),
            "http://collector:4318/base/v1/traces"
        );
        assert_eq!(
            general("http://collector:4318/?token=abc", Signal::Traces),
            "http://collector:4318/v1/traces?token=abc"
        );
        assert_eq!(
            general("https://collector/base?a=1&b=2#frag", Signal::Logs),
            "https://collector/base/v1/logs?a=1&b=2"
        );
        assert_eq!(
            url(
                &[(
                    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                    "http://collector:4318/in?token=abc"
                )],
                Signal::Traces
            ),
            "http://collector:4318/in?token=abc"
        );
        let both = [
            (GENERAL_ENDPOINT, "http://general:4318"),
            (
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "https://traces.example/in",
            ),
        ];
        assert_eq!(url(&both, Signal::Traces), "https://traces.example/in");
        assert_eq!(url(&both, Signal::Logs), "http://general:4318/v1/logs");
        assert_eq!(
            url(&both, Signal::Metrics),
            "http://general:4318/v1/metrics"
        );
    }

    #[test]
    fn an_endpoint_that_cannot_be_used_is_named_and_never_shown() {
        for bad in ["not a url", "ftp://collector/", "collector:4318", "http://"] {
            assert_eq!(
                endpoint(&getter(&[(GENERAL_ENDPOINT, bad)]), Signal::Traces),
                Endpoint::Ignored(GENERAL_ENDPOINT),
                "{bad}"
            );
        }
        assert_eq!(
            endpoint(
                &getter(&[
                    (GENERAL_ENDPOINT, "http://fine:4318"),
                    ("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "nonsense"),
                ]),
                Signal::Logs
            ),
            Endpoint::Ignored("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
        );
    }

    #[test]
    fn a_signals_headers_override_the_general_ones_by_name() {
        let (kept, readable) = signal_headers(
            &getter(&[
                (
                    GENERAL_HEADERS,
                    "Authorization=Bearer%20abc, x-team=core,bad",
                ),
                ("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "X-Team=traces"),
            ]),
            Signal::Traces,
        );
        assert_eq!(
            kept,
            vec![
                ("Authorization".to_string(), "Bearer abc".to_string()),
                ("X-Team".to_string(), "traces".to_string()),
            ]
        );
        assert!(!readable);
        let (logs, readable) = signal_headers(
            &getter(&[("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "X-Team=traces")]),
            Signal::Logs,
        );
        assert!(logs.is_empty() && readable);
    }
}
