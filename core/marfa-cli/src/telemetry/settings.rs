//! What the standard `OTEL_*` variables say, read once and before anything
//! else happens. With no endpoint named, nothing here asks for anything.

use std::time::Duration;

use url::Url;

/// How long the last export may take, and each one before it, unless the
/// standard timeout variable says otherwise.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

const DEFAULT_SERVICE: &str = "marfa-cli";

#[derive(Debug, PartialEq)]
pub enum Reading {
    /// No endpoint, or telemetry disabled: the run loads and sends nothing.
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
    pub timeout: Duration,
    pub sampler: Sampler,
    pub service: String,
    /// `OTEL_RESOURCE_ATTRIBUTES`, less `service.name`, which is `service`.
    pub resource: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sampler {
    On,
    Off,
    Ratio(f64),
}

impl Sampler {
    /// The rule of the specification's `TraceIdRatioBased`: the low 63 bits
    /// of the id, so that a collector deciding the same way agrees.
    pub fn keeps(self, trace_id: &[u8; 16]) -> bool {
        match self {
            Sampler::On => true,
            Sampler::Off => false,
            Sampler::Ratio(ratio) => {
                let bound = (ratio.clamp(0.0, 1.0) * (1u64 << 63) as f64) as u64;
                let low = u64::from_be_bytes(trace_id[8..].try_into().expect("eight bytes"));
                (low >> 1) < bound
            }
        }
    }
}

/// A variable's value without its surrounding space, where it has one: an
/// empty variable is an unset one.
pub fn text(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn read(get: impl Fn(&str) -> Option<String>) -> Reading {
    let set = |name: &str| text(&get, name);
    if set("OTEL_SDK_DISABLED").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
        return Reading::Off;
    }
    let (variable, named, appends) = match (
        set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        set("OTEL_EXPORTER_OTLP_ENDPOINT"),
    ) {
        (Some(address), _) => ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", address, false),
        (None, Some(base)) => ("OTEL_EXPORTER_OTLP_ENDPOINT", base, true),
        (None, None) => return Reading::Off,
    };
    let parsed = Url::parse(&named).ok().filter(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && !url.cannot_be_a_base()
    });
    let Some(mut parsed) = parsed else {
        return Reading::Ignored(variable);
    };
    if appends {
        // On the path, so that a query the base carries stays a query.
        let Ok(mut path) = parsed.path_segments_mut() else {
            return Reading::Ignored(variable);
        };
        path.pop_if_empty().push("v1").push("traces");
        drop(path);
        parsed.set_fragment(None);
    }
    let address = parsed.to_string();
    let mut headers = Vec::new();
    for name in [
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ] {
        for (key, value) in set(name).as_deref().map(headers_of).unwrap_or_default() {
            headers.retain(|(held, _): &(String, String)| !held.eq_ignore_ascii_case(&key));
            headers.push((key, value));
        }
    }
    let timeout = [
        "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
        "OTEL_EXPORTER_OTLP_TIMEOUT",
    ]
    .iter()
    .find_map(|name| set(name))
    .and_then(|text| text.parse::<u64>().ok())
    .filter(|milliseconds| *milliseconds > 0)
    .map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    let mut resource = set("OTEL_RESOURCE_ATTRIBUTES")
        .as_deref()
        .map(resource_of)
        .unwrap_or_default();
    // The service name variable wins over the same name among the
    // attributes, as the specification asks.
    let named = resource
        .iter()
        .find(|(key, _)| key == "service.name")
        .map(|(_, value)| value.clone());
    resource.retain(|(key, _)| key != "service.name");
    Reading::On(Settings {
        url: address,
        headers,
        timeout,
        sampler: sampler(set("OTEL_TRACES_SAMPLER"), set("OTEL_TRACES_SAMPLER_ARG")),
        service: set("OTEL_SERVICE_NAME")
            .or(named)
            .unwrap_or_else(|| DEFAULT_SERVICE.into()),
        resource,
    })
}

/// A run has no parent trace, so a parent-based sampler decides as the one
/// it wraps. A name or an argument that is not understood leaves every trace
/// kept, which is the specification's default.
fn sampler(name: Option<String>, argument: Option<String>) -> Sampler {
    let ratio = || {
        argument
            .as_deref()
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|ratio| (0.0..=1.0).contains(ratio))
            .map_or(Sampler::On, Sampler::Ratio)
    };
    match name.map(|name| name.to_ascii_lowercase()).as_deref() {
        Some("always_off" | "parentbased_always_off") => Sampler::Off,
        Some("traceidratio" | "parentbased_traceidratio") => ratio(),
        _ => Sampler::On,
    }
}

/// `key=value,key=value`, a value percent-encoded. A pair that is not a valid
/// header is left out, as the specification asks.
fn headers_of(text: &str) -> Vec<(String, String)> {
    text.split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            let value = decoded(value.trim())?;
            let token = !key.is_empty()
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
            let plain = value
                .bytes()
                .all(|byte| byte == b'\t' || (b' '..0x7f).contains(&byte));
            let own = [
                "content-type",
                "content-length",
                "host",
                "transfer-encoding",
            ]
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name));
            (token && plain && !own).then(|| (key.to_string(), value))
        })
        .collect()
}

/// `key=value,key=value`, a value percent-encoded. The specification asks
/// that a list with any pair that cannot be read be discarded whole, so that
/// half of what an operator wrote is not taken for all of it. A repeated key
/// keeps its last value.
fn resource_of(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for pair in text.split(',').filter(|pair| !pair.trim().is_empty()) {
        let parsed = pair.split_once('=').and_then(|(key, value)| {
            let key = key.trim();
            let value = decoded(value.trim())?;
            (!key.is_empty()).then(|| (key.to_string(), value))
        });
        let Some((key, value)) = parsed else {
            return Vec::new();
        };
        out.retain(|(held, _)| *held != key);
        out.push((key, value));
    }
    out
}

fn decoded(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(pairs: &[(&str, &str)]) -> Reading {
        read(|name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        })
    }

    fn on(pairs: &[(&str, &str)]) -> Settings {
        match with(pairs) {
            Reading::On(settings) => settings,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_endpoint_is_off_whatever_else_is_set() {
        assert_eq!(with(&[]), Reading::Off);
        assert_eq!(
            with(&[
                ("OTEL_EXPORTER_OTLP_HEADERS", "a=b"),
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "500"),
                ("OTEL_TRACES_SAMPLER", "always_on"),
            ]),
            Reading::Off
        );
        // An empty variable is an unset one.
        assert_eq!(with(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "  ")]), Reading::Off);
    }

    #[test]
    fn the_general_endpoint_gets_the_traces_path_and_the_traces_one_is_used_as_written() {
        assert_eq!(
            on(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/")]).url,
            "http://collector:4318/v1/traces"
        );
        assert_eq!(
            on(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/base")]).url,
            "http://collector:4318/base/v1/traces"
        );
        assert_eq!(
            on(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/base/")]).url,
            "http://collector:4318/base/v1/traces"
        );
        // A query stays a query, and a fragment is not sent.
        assert_eq!(
            on(&[(
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "http://collector:4318/?token=abc"
            )])
            .url,
            "http://collector:4318/v1/traces?token=abc"
        );
        assert_eq!(
            on(&[(
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "https://collector/base?a=1&b=2#frag"
            )])
            .url,
            "https://collector/base/v1/traces?a=1&b=2"
        );
        assert_eq!(
            on(&[(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "http://collector:4318/in?token=abc"
            )])
            .url,
            "http://collector:4318/in?token=abc"
        );
        assert_eq!(
            on(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://general:4318"),
                (
                    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                    "https://traces.example/in"
                ),
            ])
            .url,
            "https://traces.example/in"
        );
        assert!(matches!(
            with(&[(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "http://alone:4318/v1/traces"
            )]),
            Reading::On(_)
        ));
    }

    #[test]
    fn an_endpoint_that_cannot_be_used_is_named_and_never_shown() {
        for bad in ["not a url", "ftp://collector/", "collector:4318", "http://"] {
            assert_eq!(
                with(&[("OTEL_EXPORTER_OTLP_ENDPOINT", bad)]),
                Reading::Ignored("OTEL_EXPORTER_OTLP_ENDPOINT"),
                "{bad}"
            );
        }
        assert_eq!(
            with(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://fine:4318"),
                ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "nonsense"),
            ]),
            Reading::Ignored("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        );
    }

    #[test]
    fn the_sdk_can_be_disabled_the_standard_way() {
        assert_eq!(
            with(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318"),
                ("OTEL_SDK_DISABLED", "TRUE"),
            ]),
            Reading::Off
        );
    }

    #[test]
    fn headers_are_decoded_overridden_by_the_traces_ones_and_never_malformed() {
        let settings = on(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318"),
            (
                "OTEL_EXPORTER_OTLP_HEADERS",
                "Authorization=Bearer%20abc, x-team = core ,bad pair,=empty,bad key=1,Content-Type=text/plain,x-line=a%0Ab,x-open=%zz",
            ),
            ("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "X-Team=traces"),
        ]);
        assert_eq!(
            settings.headers,
            vec![
                ("Authorization".to_string(), "Bearer abc".to_string()),
                ("X-Team".to_string(), "traces".to_string()),
            ]
        );
    }

    #[test]
    fn the_timeout_is_two_seconds_unless_the_standard_variable_says_milliseconds() {
        let base = ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
        assert_eq!(on(&[base]).timeout, Duration::from_secs(2));
        assert_eq!(
            on(&[base, ("OTEL_EXPORTER_OTLP_TIMEOUT", "750")]).timeout,
            Duration::from_millis(750)
        );
        assert_eq!(
            on(&[
                base,
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "750"),
                ("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "100"),
            ])
            .timeout,
            Duration::from_millis(100)
        );
        for bad in ["0", "-5", "soon", "1.5"] {
            assert_eq!(
                on(&[base, ("OTEL_EXPORTER_OTLP_TIMEOUT", bad)]).timeout,
                Duration::from_secs(2),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_sampler_follows_the_standard_names_and_defaults_to_keeping_every_trace() {
        let base = ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
        let sampled = |name: &str, argument: Option<&str>| {
            let mut pairs = vec![base, ("OTEL_TRACES_SAMPLER", name)];
            if let Some(argument) = argument {
                pairs.push(("OTEL_TRACES_SAMPLER_ARG", argument));
            }
            on(&pairs).sampler
        };
        assert_eq!(on(&[base]).sampler, Sampler::On);
        assert_eq!(sampled("always_on", None), Sampler::On);
        assert_eq!(sampled("always_off", None), Sampler::Off);
        assert_eq!(sampled("parentbased_always_off", None), Sampler::Off);
        assert_eq!(sampled("traceidratio", Some("0.25")), Sampler::Ratio(0.25));
        assert_eq!(
            sampled("parentbased_traceidratio", Some("0")),
            Sampler::Ratio(0.0)
        );
        assert_eq!(sampled("traceidratio", None), Sampler::On);
        assert_eq!(sampled("traceidratio", Some("2")), Sampler::On);
        assert_eq!(sampled("jaeger_remote", None), Sampler::On);
    }

    #[test]
    fn a_ratio_keeps_the_share_it_names_by_the_trace_id() {
        let id = |low: u64| {
            let mut id = [7u8; 16];
            id[8..].copy_from_slice(&low.to_be_bytes());
            id
        };
        assert!(Sampler::Ratio(1.0).keeps(&id(u64::MAX)));
        assert!(!Sampler::Ratio(0.0).keeps(&id(0)));
        assert!(Sampler::Ratio(0.5).keeps(&id(1 << 61)));
        assert!(!Sampler::Ratio(0.5).keeps(&id(1 << 63)));
        assert!(Sampler::On.keeps(&id(u64::MAX)));
        assert!(!Sampler::Off.keeps(&id(0)));
    }

    #[test]
    fn resource_attributes_are_decoded_and_a_list_with_a_bad_pair_is_discarded_whole() {
        let base = ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
        assert_eq!(on(&[base]).resource, Vec::new());
        assert_eq!(
            on(&[
                base,
                (
                    "OTEL_RESOURCE_ATTRIBUTES",
                    "deployment.environment=rehearsal, team=a%20b%2Cc,deployment.environment=last",
                ),
            ])
            .resource,
            vec![
                ("team".to_string(), "a b,c".to_string()),
                ("deployment.environment".to_string(), "last".to_string()),
            ]
        );
        for bad in ["a=b,c", "=x", "a=%zz", "a=b,%=c,d"] {
            assert_eq!(
                on(&[base, ("OTEL_RESOURCE_ATTRIBUTES", bad)]).resource,
                Vec::new(),
                "{bad}"
            );
        }
        // The witness: the same list without the bad pair is read.
        assert_eq!(
            on(&[base, ("OTEL_RESOURCE_ATTRIBUTES", "a=b")])
                .resource
                .len(),
            1
        );
    }

    #[test]
    fn the_service_name_variable_wins_over_service_name_among_the_attributes() {
        let base = ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
        let attributes = ("OTEL_RESOURCE_ATTRIBUTES", "service.name=from-list,a=b");
        let from_list = on(&[base, attributes]);
        assert_eq!(from_list.service, "from-list");
        // `service.name` is the service, not a second copy of it.
        assert_eq!(from_list.resource, vec![("a".to_string(), "b".to_string())]);
        assert_eq!(
            on(&[base, attributes, ("OTEL_SERVICE_NAME", "from-variable")]).service,
            "from-variable"
        );
    }

    #[test]
    fn the_service_name_is_the_standard_one_or_ours() {
        let base = ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
        assert_eq!(on(&[base]).service, "marfa-cli");
        assert_eq!(on(&[base, ("OTEL_SERVICE_NAME", "mine")]).service, "mine");
    }
}
