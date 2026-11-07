//! What every report of a process shares, whichever of them is asked for: the
//! service's name, the attributes an operator added, and how long a send may
//! take.

use std::time::Duration;

use crate::environment::text;
use crate::otlp::Signal;

/// How long a send may take, and each one before it, unless the standard
/// timeout variable says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub timeout: Duration,
    pub service: String,
    /// `OTEL_RESOURCE_ATTRIBUTES`, less `service.name`, which is `service`.
    pub resource: Vec<(String, String)>,
}

/// The timeout, service name and resource attributes, which no endpoint is
/// needed for. `default_service` is the name of the program, and `signal`
/// the one whose timeout variable is read first.
///
/// `resource` is empty where `OTEL_RESOURCE_ATTRIBUTES` cannot be read: the
/// specification asks that a list with any pair that cannot be read be
/// discarded whole. [`attributes`] says whether it could, for a program that
/// refuses such a list.
pub fn identity(
    get: &impl Fn(&str) -> Option<String>,
    default_service: &str,
    signal: Signal,
) -> Identity {
    let set = |name: &str| text(get, name);
    let mut resource = set("OTEL_RESOURCE_ATTRIBUTES")
        .as_deref()
        .and_then(attributes)
        .unwrap_or_default();
    // The service name variable wins over the same name among the
    // attributes, as the specification asks.
    let named = resource
        .iter()
        .find(|(key, _)| key == "service.name")
        .map(|(_, value)| value.clone());
    resource.retain(|(key, _)| key != "service.name");
    Identity {
        timeout: timeout(get, signal),
        service: set("OTEL_SERVICE_NAME")
            .or(named)
            .unwrap_or_else(|| default_service.into()),
        resource,
    }
}

/// The signal's timeout variable, then the general one, in milliseconds; a
/// value that is not a positive whole number is not read.
pub fn timeout(get: &impl Fn(&str) -> Option<String>, signal: Signal) -> Duration {
    [signal.timeout_variable(), "OTEL_EXPORTER_OTLP_TIMEOUT"]
        .iter()
        .find_map(|name| text(get, name))
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|milliseconds| *milliseconds > 0)
        .map_or(DEFAULT_TIMEOUT, Duration::from_millis)
}

/// `key=value,key=value`, a value percent-encoded and possibly empty, as the
/// W3C Baggage format has it. `None` if any pair cannot be read. A repeated
/// key keeps its last value.
pub fn attributes(text: &str) -> Option<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for pair in text.split(',').filter(|pair| !pair.trim().is_empty()) {
        let (key, value) = pair.split_once('=')?;
        let key = key.trim();
        let value = decoded(value.trim())?;
        if key.is_empty() {
            return None;
        }
        out.retain(|(held, _)| held != key);
        out.push((key.to_string(), value));
    }
    Some(out)
}

/// `key=value,key=value`, a value percent-encoded. The headers that can be
/// sent, and whether every pair could be read: a pair that is not a valid
/// header is left out, as the specification asks, and a program that would
/// rather refuse the list says so from the second answer. One the exporter
/// sets itself is left out without being a fault.
pub fn headers(text: &str) -> (Vec<(String, String)>, bool) {
    let mut readable = true;
    let mut out = Vec::new();
    for pair in text.split(',').filter(|pair| !pair.trim().is_empty()) {
        let parsed = pair.split_once('=').and_then(|(key, value)| {
            let key = key.trim();
            let value = decoded(value.trim())?;
            let token = !key.is_empty()
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
            let plain = value
                .bytes()
                .all(|byte| byte == b'\t' || (b' '..0x7f).contains(&byte));
            (token && plain).then(|| (key.to_string(), value))
        });
        let Some((key, value)) = parsed else {
            readable = false;
            continue;
        };
        let own = [
            "content-type",
            "content-length",
            "host",
            "transfer-encoding",
        ]
        .iter()
        .any(|name| key.eq_ignore_ascii_case(name));
        if !own {
            out.push((key, value));
        }
    }
    (out, readable)
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

    fn getter<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn who(pairs: &[(&str, &str)]) -> Identity {
        identity(&getter(pairs), "marfa-test", Signal::Traces)
    }

    #[test]
    fn the_timeout_is_two_seconds_unless_the_standard_variable_says_milliseconds() {
        assert_eq!(who(&[]).timeout, Duration::from_secs(2));
        assert_eq!(
            who(&[("OTEL_EXPORTER_OTLP_TIMEOUT", "750")]).timeout,
            Duration::from_millis(750)
        );
        assert_eq!(
            who(&[
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "750"),
                ("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "100"),
            ])
            .timeout,
            Duration::from_millis(100)
        );
        // The logs' variable is not the traces' one.
        let logs = |pairs| timeout(&getter(pairs), Signal::Logs);
        assert_eq!(
            logs(&[("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "100")]),
            Duration::from_secs(2)
        );
        assert_eq!(
            logs(&[("OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "300")]),
            Duration::from_millis(300)
        );
        for bad in ["0", "-5", "soon", "1.5"] {
            assert_eq!(
                who(&[("OTEL_EXPORTER_OTLP_TIMEOUT", bad)]).timeout,
                Duration::from_secs(2),
                "{bad}"
            );
        }
    }

    #[test]
    fn headers_are_decoded_and_never_malformed() {
        let (kept, readable) = headers(
            "Authorization=Bearer%20abc, x-team = core ,bad pair,=empty,bad key=1,Content-Type=text/plain,x-line=a%0Ab,x-open=%zz",
        );
        assert_eq!(
            kept,
            vec![
                ("Authorization".to_string(), "Bearer abc".to_string()),
                ("x-team".to_string(), "core".to_string()),
            ]
        );
        assert!(!readable);
        // The witness: a list that is whole says so, and a header the
        // exporter sets itself is dropped without being a fault.
        assert_eq!(
            headers("a=b, Content-Type=text/plain"),
            (vec![("a".to_string(), "b".to_string())], true)
        );
        assert_eq!(headers(""), (Vec::new(), true));
    }

    #[test]
    fn resource_attributes_are_decoded_and_a_list_with_a_bad_pair_is_discarded_whole() {
        assert_eq!(who(&[]).resource, Vec::new());
        assert_eq!(
            who(&[(
                "OTEL_RESOURCE_ATTRIBUTES",
                "deployment.environment=rehearsal, team=a%20b%2Cc,deployment.environment=last",
            )])
            .resource,
            vec![
                ("team".to_string(), "a b,c".to_string()),
                ("deployment.environment".to_string(), "last".to_string()),
            ]
        );
        for bad in ["a=b,c", "=x", "a=%zz", "a=b,%=c,d"] {
            assert_eq!(attributes(bad), None, "{bad}");
            assert_eq!(
                who(&[("OTEL_RESOURCE_ATTRIBUTES", bad)]).resource,
                Vec::new(),
                "{bad}"
            );
        }
        // The witness: the same list without the bad pair is read, and an
        // empty value is a value.
        assert_eq!(attributes("a=b").map(|list| list.len()), Some(1));
        assert_eq!(
            attributes("a="),
            Some(vec![("a".to_string(), String::new())])
        );
    }

    #[test]
    fn the_service_name_variable_wins_over_service_name_among_the_attributes() {
        let attributes = ("OTEL_RESOURCE_ATTRIBUTES", "service.name=from-list,a=b");
        let from_list = who(&[attributes]);
        assert_eq!(from_list.service, "from-list");
        // `service.name` is the service, not a second copy of it.
        assert_eq!(from_list.resource, vec![("a".to_string(), "b".to_string())]);
        assert_eq!(
            who(&[attributes, ("OTEL_SERVICE_NAME", "from-variable")]).service,
            "from-variable"
        );
    }

    #[test]
    fn the_service_name_is_the_standard_one_or_the_programs() {
        assert_eq!(who(&[]).service, "marfa-test");
        assert_eq!(who(&[("OTEL_SERVICE_NAME", "mine")]).service, "mine");
    }
}
