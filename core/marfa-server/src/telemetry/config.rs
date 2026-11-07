//! What telemetry is told, read once from the environment before the database
//! opens. Every one of these is the machine's, and several can hold a
//! credential, so a refusal names such a setting and never its value.

use std::time::Duration;

use marfa_telemetry::environment::{disabled, text};
use marfa_telemetry::host::{Capture, capture_url};
use marfa_telemetry::identity::{self, headers};
use marfa_telemetry::otlp::{self, Endpoint, GENERAL_ENDPOINT, GENERAL_HEADERS, Signal};
use url::Url;

use crate::settings::Environment;
use crate::settings::rule;

const DEFAULT_SERVICE: &str = "marfa-server";
const DEFAULT_RATIO: f64 = 0.05;
const DEFAULT_ENVIRONMENT: &str = "production";
const DEFAULT_WEBHOOK_TIMEOUT_MS: u64 = 5_000;
const MAX_I32: u64 = 2_147_483_647;
const PAIRS_RULE: &str = "must be comma-separated key=value pairs with percent-encoded values";
const URL_RULE: &str = "must be an absolute http or https URL";
const POSTHOG_HOST: &str = "MARFA_POSTHOG_HOST";
const POSTHOG_TOKEN: &str = "MARFA_POSTHOG_PROJECT_TOKEN";

/// Where one OTLP signal is posted.
#[derive(Clone, Debug)]
pub struct Export {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
}

/// Where exception reports go.
#[derive(Clone)]
pub struct Exceptions {
    pub url: String,
    pub token: String,
    pub timeout: Duration,
}

/// Where a notice of a 500 goes.
#[derive(Clone, Debug)]
pub struct Webhook {
    pub url: String,
    pub timeout: Duration,
}

/// What a boot says about telemetry that is not on, naming a setting and
/// never its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// `MARFA_POSTHOG_HOST` is not an address the token may travel to.
    HostUnusable,
}

impl Notice {
    pub fn say(self) {
        match self {
            Notice::HostUnusable => tracing::warn!(
                setting = POSTHOG_HOST,
                "{POSTHOG_HOST} is not an https address, or an http address on this machine, \
                 with no user name or password; exception reports are off"
            ),
        }
    }
}

#[derive(Clone)]
pub struct Config {
    /// `OTEL_SDK_DISABLED` is `true`: nothing is exported or sent.
    pub off: bool,
    pub service: String,
    /// `OTEL_RESOURCE_ATTRIBUTES`, less `service.name`.
    pub resource: Vec<(String, String)>,
    pub traces: Option<Export>,
    pub logs: Option<Export>,
    pub ratio: f64,
    pub exceptions: Option<Exceptions>,
    pub webhook: Option<Webhook>,
    /// What an error notice names: `deployment.environment.name`, then
    /// `deployment.environment`.
    pub environment: String,
    pub notices: Vec<Notice>,
}

impl Config {
    /// Reads every setting, adding a line to `problems` for each one outside
    /// its own rule. A rule between settings is [`disagreements`], which waits
    /// for every setting to read.
    pub fn read(environment: &Environment, problems: &mut Vec<String>) -> Config {
        let get = |name: &str| environment.get(name).map(str::to_string);
        let mut refuse = |line: String| {
            if !problems.contains(&line) {
                problems.push(line);
            }
        };

        let identity = identity::identity(&get, DEFAULT_SERVICE, Signal::Traces);
        if let Some(list) = text(&get, "OTEL_RESOURCE_ATTRIBUTES")
            && identity::attributes(&list).is_none()
        {
            refuse(rule::line("OTEL_RESOURCE_ATTRIBUTES", PAIRS_RULE, &list));
        }

        let mut export = |signal: Signal| {
            let url = match otlp::endpoint(&get, signal) {
                Endpoint::On(url) => Some(url),
                Endpoint::Off => None,
                Endpoint::Ignored(variable) => {
                    refuse(format!("{variable} {URL_RULE}"));
                    None
                }
            };
            url.map(|url| Export {
                url,
                headers: otlp::signal_headers(&get, signal).0,
                timeout: identity::timeout(&get, signal),
            })
        };
        let traces = export(Signal::Traces);
        let logs = export(Signal::Logs);
        if let Some(general) = text(&get, GENERAL_ENDPOINT)
            && !is_web_address(&general)
        {
            refuse(format!("{GENERAL_ENDPOINT} {URL_RULE}"));
        }
        for variable in [
            GENERAL_HEADERS,
            Signal::Traces.headers_variable(),
            Signal::Logs.headers_variable(),
        ] {
            if let Some(list) = text(&get, variable)
                && !headers(&list).1
            {
                refuse(format!("{variable} {PAIRS_RULE}"));
            }
        }

        let ratio = match text(&get, "MARFA_OTEL_SAMPLE_RATIO") {
            None => DEFAULT_RATIO,
            Some(given) => decimal(&given, 0.0, 1.0).unwrap_or_else(|rule_text| {
                refuse(rule::line("MARFA_OTEL_SAMPLE_RATIO", &rule_text, &given));
                DEFAULT_RATIO
            }),
        };

        let timeout = match text(&get, "MARFA_ERROR_WEBHOOK_TIMEOUT_MS") {
            None => DEFAULT_WEBHOOK_TIMEOUT_MS,
            Some(given) => rule::whole_number(&given, 1, MAX_I32).unwrap_or_else(|rule_text| {
                refuse(rule::line(
                    "MARFA_ERROR_WEBHOOK_TIMEOUT_MS",
                    &rule_text,
                    &given,
                ));
                DEFAULT_WEBHOOK_TIMEOUT_MS
            }),
        };
        let webhook = text(&get, "ERROR_WEBHOOK_URL").and_then(|address| {
            if is_web_address(&address) {
                Some(Webhook {
                    url: address,
                    timeout: Duration::from_millis(timeout),
                })
            } else {
                refuse(format!("ERROR_WEBHOOK_URL {URL_RULE}"));
                None
            }
        });

        // A secret is used as written, so whitespace around it is part of it.
        let token = environment.get(POSTHOG_TOKEN).map(str::to_string);
        if let Some(token) = &token
            && token != token.trim()
        {
            refuse(format!(
                "{POSTHOG_TOKEN} has whitespace around it, which would be part of the \
                 secret; remove it"
            ));
        }
        let host = text(&get, POSTHOG_HOST);

        let environment_name = ["deployment.environment.name", "deployment.environment"]
            .iter()
            .find_map(|key| {
                identity
                    .resource
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.clone())
            })
            .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_string());

        let off = disabled(&get);
        let mut notices = Vec::new();
        let exceptions = match (host, token) {
            (Some(host), Some(token)) if !off => match capture_url(&host, Capture::Batch) {
                Some(url) => Some(Exceptions {
                    url,
                    token,
                    timeout: identity::timeout(&get, Signal::Traces),
                }),
                None => {
                    notices.push(Notice::HostUnusable);
                    None
                }
            },
            _ => None,
        };

        Config {
            off,
            service: identity.service,
            resource: identity.resource,
            traces: traces.filter(|_| !off),
            logs: logs.filter(|_| !off),
            ratio,
            exceptions,
            webhook: webhook.filter(|_| !off),
            environment: environment_name,
            notices,
        }
    }

    /// Whether anything at all is on.
    pub fn any(&self) -> bool {
        self.traces.is_some()
            || self.logs.is_some()
            || self.exceptions.is_some()
            || self.webhook.is_some()
    }
}

/// The rules that compare settings, to be asked once every setting reads.
pub fn disagreements(environment: &Environment) -> Vec<String> {
    let get = |name: &str| environment.get(name).map(str::to_string);
    let mut problems = Vec::new();
    let get = &get;
    if text(get, GENERAL_ENDPOINT).is_none() {
        for signal in [Signal::Traces, Signal::Logs] {
            let variable = signal.endpoint_variable();
            if text(get, variable).is_some() {
                problems.push(format!("{variable} needs {GENERAL_ENDPOINT} set too"));
            }
        }
    }
    let host = text(get, POSTHOG_HOST).is_some();
    let token = get(POSTHOG_TOKEN).is_some();
    if host && !token {
        problems.push(format!("{POSTHOG_HOST} needs {POSTHOG_TOKEN} set too"));
    }
    if token && !host {
        problems.push(format!("{POSTHOG_TOKEN} needs {POSTHOG_HOST} set too"));
    }
    problems
}

fn is_web_address(text: &str) -> bool {
    Url::parse(text)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

fn decimal(text: &str, min: f64, max: f64) -> Result<f64, String> {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let (whole, fraction) = text
        .split_once('.')
        .map_or((text, None), |(w, f)| (w, Some(f)));
    let shaped = digits(whole) && fraction.is_none_or(digits);
    shaped
        .then(|| text.parse::<f64>().ok())
        .flatten()
        .filter(|number| number.is_finite() && (min..=max).contains(number))
        .ok_or_else(|| format!("must be a number from {min} to {max}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(pairs: &[(&str, &str)]) -> (Config, Vec<String>) {
        let mut problems = Vec::new();
        let config = Config::read(&Environment::from_pairs(pairs), &mut problems);
        (config, problems)
    }

    fn refused(pairs: &[(&str, &str)]) -> Vec<String> {
        read(pairs).1
    }

    fn disagree(pairs: &[(&str, &str)]) -> Vec<String> {
        disagreements(&Environment::from_pairs(pairs))
    }

    #[test]
    fn nothing_is_on_when_nothing_is_set() {
        let (config, problems) = read(&[]);
        assert!(problems.is_empty());
        assert!(!config.any());
        assert_eq!(config.service, "marfa-server");
        assert_eq!(config.environment, "production");
        assert_eq!(config.ratio, 0.05);
    }

    #[test]
    fn the_general_endpoint_turns_traces_and_logs_on_under_their_paths() {
        let (config, problems) = read(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")]);
        assert!(problems.is_empty());
        assert_eq!(
            config.traces.unwrap().url,
            "http://127.0.0.1:4318/v1/traces"
        );
        assert_eq!(config.logs.unwrap().url, "http://127.0.0.1:4318/v1/logs");
    }

    #[test]
    fn a_disabled_sdk_turns_everything_off_and_says_nothing() {
        let (config, problems) = read(&[
            ("OTEL_SDK_DISABLED", "TRUE"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
            ("MARFA_POSTHOG_HOST", "http://example.test"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_x"),
            ("ERROR_WEBHOOK_URL", "http://127.0.0.1:9/errors"),
        ]);
        assert!(problems.is_empty());
        assert!(config.off && !config.any());
        assert!(config.notices.is_empty());
    }

    #[test]
    fn any_other_value_leaves_telemetry_as_it_was() {
        let (config, _) = read(&[
            ("OTEL_SDK_DISABLED", "1"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
        ]);
        assert!(config.traces.is_some());
    }

    #[test]
    fn a_host_the_token_may_not_travel_to_stops_exceptions_alone() {
        let (config, problems) = read(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
            ("MARFA_POSTHOG_HOST", "http://posthog.example.test"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_x"),
        ]);
        assert!(problems.is_empty());
        assert!(config.exceptions.is_none());
        assert!(config.traces.is_some() && config.logs.is_some());
        assert_eq!(config.notices, [Notice::HostUnusable]);
    }

    #[test]
    fn a_loopback_http_host_and_an_https_host_are_used() {
        for host in ["http://127.0.0.1:9000", "https://eu.i.posthog.com"] {
            let (config, _) = read(&[
                ("MARFA_POSTHOG_HOST", host),
                ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_x"),
            ]);
            assert!(config.exceptions.is_some(), "{host}");
        }
    }

    #[test]
    fn an_exception_report_needs_no_otlp_setting() {
        let (config, _) = read(&[
            ("MARFA_POSTHOG_HOST", "http://127.0.0.1:9000"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_x"),
        ]);
        assert!(config.exceptions.is_some() && config.traces.is_none());
    }

    #[test]
    fn the_environment_comes_from_the_name_before_the_older_attribute() {
        let (config, _) = read(&[(
            "OTEL_RESOURCE_ATTRIBUTES",
            "deployment.environment=old,deployment.environment.name=named",
        )]);
        assert_eq!(config.environment, "named");
        let (config, _) = read(&[("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=old")]);
        assert_eq!(config.environment, "old");
    }

    #[test]
    fn the_service_name_variable_wins_over_the_attribute() {
        let (config, _) = read(&[
            ("OTEL_SERVICE_NAME", "mine"),
            ("OTEL_RESOURCE_ATTRIBUTES", "service.name=theirs,team=a%20b"),
        ]);
        assert_eq!(config.service, "mine");
        assert_eq!(config.resource, [("team".to_string(), "a b".to_string())]);
    }

    #[test]
    fn a_setting_outside_its_rule_is_named_and_a_secret_is_not_shown() {
        let lines = refused(&[
            ("OTEL_RESOURCE_ATTRIBUTES", "team"),
            ("MARFA_OTEL_SAMPLE_RATIO", "1.5"),
            ("MARFA_ERROR_WEBHOOK_TIMEOUT_MS", "0"),
            ("ERROR_WEBHOOK_URL", "nope-secret"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "ftp://collector-secret"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "broken-secret"),
        ]);
        assert!(
            lines.contains(
                &"OTEL_RESOURCE_ATTRIBUTES must be comma-separated key=value pairs with \
              percent-encoded values (got \"team\")"
                    .to_string()
            )
        );
        assert!(lines.iter().any(|line| {
            line.starts_with("MARFA_OTEL_SAMPLE_RATIO must be a number from 0 to 1 (got \"1.5\")")
        }));
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("MARFA_ERROR_WEBHOOK_TIMEOUT_MS "))
        );
        assert!(lines.contains(&format!("ERROR_WEBHOOK_URL {URL_RULE}")));
        assert!(lines.contains(&format!("OTEL_EXPORTER_OTLP_ENDPOINT {URL_RULE}")));
        assert!(lines.contains(&format!("OTEL_EXPORTER_OTLP_HEADERS {PAIRS_RULE}")));
        assert_eq!(lines.len(), 6);
        assert!(!lines.join("\n").contains("secret"));
    }

    #[test]
    fn a_token_with_whitespace_is_refused_without_its_value() {
        let lines = refused(&[
            ("MARFA_POSTHOG_HOST", "https://eu.i.posthog.com"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", " phc_secret "),
        ]);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("MARFA_POSTHOG_PROJECT_TOKEN has whitespace"));
        assert!(!lines[0].contains("phc_secret"));
    }

    #[test]
    fn a_rule_between_settings_names_the_one_that_needs_the_other() {
        assert_eq!(
            disagree(&[
                ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1"),
                ("MARFA_POSTHOG_HOST", "https://eu.i.posthog.com"),
            ]),
            [
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
                "MARFA_POSTHOG_HOST needs MARFA_POSTHOG_PROJECT_TOKEN set too",
            ]
        );
        assert_eq!(
            disagree(&[("MARFA_POSTHOG_PROJECT_TOKEN", "phc_x")]),
            ["MARFA_POSTHOG_PROJECT_TOKEN needs MARFA_POSTHOG_HOST set too"]
        );
        assert!(
            disagree(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1"),
                ("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "http://127.0.0.1:2"),
            ])
            .is_empty()
        );
    }

    #[test]
    fn the_sample_ratio_takes_the_edges_of_its_rule() {
        for (given, expected) in [("0", 0.0), ("1", 1.0), ("0.25", 0.25)] {
            let (config, problems) = read(&[("MARFA_OTEL_SAMPLE_RATIO", given)]);
            assert!(problems.is_empty(), "{given}");
            assert_eq!(config.ratio, expected);
        }
        for given in ["-0.1", "1.0001", ".5", "1e-1", "NaN"] {
            assert_eq!(
                refused(&[("MARFA_OTEL_SAMPLE_RATIO", given)]).len(),
                1,
                "{given}"
            );
        }
    }
}
