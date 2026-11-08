//! What the standard `OTEL_*` variables say, read once and before anything
//! else happens. Whether traces are asked for depends on the endpoint; the
//! identity a report travels under, and the time it may take, do not, so an
//! exception report has them without one. How each variable reads is
//! `marfa-telemetry`'s, which the server follows too.

use marfa_telemetry::environment::text;
use marfa_telemetry::identity;
use marfa_telemetry::otlp::{self, Endpoint, Signal};
use marfa_telemetry::sampler::Sampler;

pub use marfa_telemetry::environment::disabled;
pub use marfa_telemetry::identity::Identity;

const DEFAULT_SERVICE: &str = "marfa-cli";

#[derive(Debug, PartialEq)]
pub enum Reading {
    /// No endpoint: the run sends no trace.
    Off,
    /// An endpoint that cannot be used. Names the variable and never its
    /// value, which can carry a credential.
    Ignored(&'static str),
    On(Settings),
}

#[derive(Debug, PartialEq)]
pub struct Settings {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub sampler: Sampler,
    pub identity: Identity,
}

/// The timeout, service name and resource attributes, which no endpoint is
/// needed for.
pub fn identity(get: &impl Fn(&str) -> Option<String>) -> Identity {
    identity::identity(get, DEFAULT_SERVICE, Signal::Traces)
}

/// What the run's traces are sent with, where an endpoint names a collector.
pub fn read(get: &impl Fn(&str) -> Option<String>, identity: Identity) -> Reading {
    let url = match otlp::endpoint(get, Signal::Traces) {
        Endpoint::Off => return Reading::Off,
        Endpoint::Ignored(variable) => return Reading::Ignored(variable),
        Endpoint::On(url) => url,
    };
    // A header that cannot be read is left out and the rest are sent.
    let (headers, _) = otlp::signal_headers(get, Signal::Traces);
    let set = |name: &str| text(get, name);
    Reading::On(Settings {
        url,
        headers,
        sampler: Sampler::named(
            set("OTEL_TRACES_SAMPLER").as_deref(),
            set("OTEL_TRACES_SAMPLER_ARG").as_deref(),
        ),
        identity,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn getter<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn with(pairs: &[(&str, &str)]) -> Reading {
        let get = getter(pairs);
        read(&get, identity(&get))
    }

    fn on(pairs: &[(&str, &str)]) -> Settings {
        match with(pairs) {
            Reading::On(settings) => settings,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_endpoint_is_no_traces_whatever_else_is_set() {
        assert_eq!(with(&[]), Reading::Off);
        assert_eq!(
            with(&[
                ("OTEL_EXPORTER_OTLP_HEADERS", "a=b"),
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "500"),
                ("OTEL_TRACES_SAMPLER", "always_on"),
            ]),
            Reading::Off
        );
        // The identity and the timeout need no endpoint.
        assert_eq!(with(&[("OTEL_SERVICE_NAME", "mine")]), Reading::Off);
    }

    #[test]
    fn the_traces_endpoint_alone_turns_traces_on_and_a_bad_one_is_named() {
        let alone = [(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "http://alone:4318/v1/traces",
        )];
        assert!(matches!(with(&alone), Reading::On(_)));
        assert_eq!(
            with(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "nonsense")]),
            Reading::Ignored("OTEL_EXPORTER_OTLP_ENDPOINT")
        );
    }

    #[test]
    fn a_run_is_sent_with_the_headers_the_sampler_and_the_identity_the_variables_name() {
        let settings = on(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318"),
            (
                "OTEL_EXPORTER_OTLP_HEADERS",
                "Authorization=Bearer%20abc,bad pair",
            ),
            ("OTEL_TRACES_SAMPLER", "traceidratio"),
            ("OTEL_TRACES_SAMPLER_ARG", "0.25"),
            ("OTEL_SERVICE_NAME", "mine"),
            ("OTEL_EXPORTER_OTLP_TIMEOUT", "750"),
        ]);
        assert_eq!(settings.url, "http://collector:4318/v1/traces");
        assert_eq!(
            settings.headers,
            vec![("Authorization".to_string(), "Bearer abc".to_string())]
        );
        assert_eq!(settings.sampler, Sampler::Ratio(0.25));
        assert_eq!(settings.identity.service, "mine");
        assert_eq!(settings.identity.timeout, Duration::from_millis(750));
        assert_eq!(identity(&getter(&[])).service, "marfa-cli");
    }
}
