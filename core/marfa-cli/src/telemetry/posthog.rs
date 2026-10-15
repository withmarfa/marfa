//! A failed run as one PostHog `$exception` event, when the environment names
//! a PostHog project as well as a collector.
//!
//! PostHog's error tracking groups `$exception` events, and a trace does not
//! produce them, so this is a post of its own. It is sent from a thread of
//! its own beside the trace's last send, once, with no retry, and a PostHog
//! that is unreachable, slow or refusing changes neither the output nor the
//! exit code.
//!
//! The event carries no person: a fresh random distinct id for the process,
//! `$process_person_profile` false and `$geoip_disable` true. Its exception
//! is a type and a fixed sentence from `describe`; never the error's message.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use url::Url;

use super::describe;
use super::layer;
use super::otlp;
use super::settings::text;
use crate::cleartext::is_loopback;
use crate::error::CliError;

const HOST: &str = "MARFA_POSTHOG_HOST";
const TOKEN: &str = "MARFA_POSTHOG_PROJECT_TOKEN";

const HOST_ALONE: &str = "MARFA_POSTHOG_HOST is set without MARFA_POSTHOG_PROJECT_TOKEN, so this run sends no exception report";
const TOKEN_ALONE: &str = "MARFA_POSTHOG_PROJECT_TOKEN is set without MARFA_POSTHOG_HOST, so this run sends no exception report";
const NOT_HTTPS: &str =
    "MARFA_POSTHOG_HOST is not an https address, so this run sends no exception report";

#[derive(Debug, PartialEq)]
pub enum Reading {
    /// Neither variable is set: nothing here asks for anything.
    Off,
    /// PostHog stays off for this run, and the sentence says why. It names a
    /// variable and never its value, which can carry a credential.
    Said(&'static str),
    On(Settings),
}

#[derive(PartialEq)]
pub struct Settings {
    url: String,
    token: String,
    service: String,
    timeout: Duration,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Settings")
            .field("url", &self.url)
            .field("token", &"..")
            .finish_non_exhaustive()
    }
}

/// `service` and `timeout` are the trace's: the exception is reported under
/// the same name and waited for within the same budget.
pub fn read(get: impl Fn(&str) -> Option<String>, service: &str, timeout: Duration) -> Reading {
    let (host, token) = match (text(&get, HOST), text(&get, TOKEN)) {
        (None, None) => return Reading::Off,
        (Some(_), None) => return Reading::Said(HOST_ALONE),
        (None, Some(_)) => return Reading::Said(TOKEN_ALONE),
        (Some(host), Some(token)) => (host, token),
    };
    match capture_url(&host) {
        Some(url) => Reading::On(Settings {
            url,
            token,
            service: service.to_string(),
            timeout,
        }),
        None => Reading::Said(NOT_HTTPS),
    }
}

/// Where an event is posted, under the host as written. The project token
/// travels in the body, so only `https` is used, and `http` only to this
/// machine, which a test or a local PostHog needs.
fn capture_url(host: &str) -> Option<String> {
    let mut url = Url::parse(host).ok()?;
    let private = match url.scheme() {
        "https" => true,
        "http" => is_loopback(&url),
        _ => false,
    };
    if !private
        || url.host_str().is_none()
        || url.cannot_be_a_base()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(["i", "v0", "e", ""]);
    Some(url.to_string())
}

pub struct Reporter {
    settings: Settings,
    command: String,
}

/// A post under way, which `wait` gives until its deadline to finish.
pub struct Pending {
    done: mpsc::Receiver<()>,
    deadline: Instant,
}

impl Pending {
    pub fn wait(self) {
        let left = self.deadline.saturating_duration_since(Instant::now());
        let _ = self.done.recv_timeout(left);
    }
}

impl Reporter {
    /// `command` is the path of a command's names as clap parsed them.
    pub fn new(settings: Settings, command: &str) -> Reporter {
        Reporter {
            settings,
            command: command
                .strip_prefix("marfa ")
                .unwrap_or(command)
                .to_string(),
        }
    }

    /// Starts the post of a failed run's event. `None` where the thread
    /// cannot be made: the run then sends nothing.
    pub fn report(self, status: u8, error: Option<&CliError>) -> Option<Pending> {
        let body = self.event(status, error);
        let Settings { url, timeout, .. } = self.settings;
        let (finished, done) = mpsc::channel();
        crate::interrupt::spawn_apart("posthog", move || {
            // Whatever goes wrong, nothing is said: PostHog's trouble is not
            // the command's. The answer is never read past its status.
            let _ = otlp::agent(timeout)
                .post(&url)
                .header("Content-Type", "application/json")
                .send(&body);
            let _ = finished.send(());
        })
        .ok()?;
        Some(Pending {
            done,
            deadline: Instant::now() + timeout,
        })
    }

    fn event(&self, status: u8, error: Option<&CliError>) -> Vec<u8> {
        let (kind, value) = match error {
            Some(error) => (error.code(), describe::error(error)),
            None => ("exit", describe::exit(status)),
        };
        let version = env!("CARGO_PKG_VERSION");
        let mut properties = json!({
            "$process_person_profile": false,
            "$geoip_disable": true,
            "$lib": "marfa-cli",
            "$lib_version": version,
            "$os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "$exception_list": [{
                "type": kind,
                "value": value,
                "mechanism": { "handled": true, "synthetic": false },
            }],
            "$exception_level": "error",
            "command": self.command,
            "exit_code": status,
            "service.name": self.settings.service,
            "service.version": version,
        });
        if error.is_some() {
            properties["error_code"] = kind.into();
        }
        let event: Value = json!({
            "api_key": self.settings.token,
            "event": "$exception",
            "distinct_id": hex::encode(layer::random::<16>()),
            "properties": properties,
        });
        serde_json::to_vec(&event).expect("a JSON value serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(2);

    fn with(pairs: &[(&str, &str)]) -> Reading {
        read(
            |name| {
                pairs
                    .iter()
                    .find(|(set, _)| *set == name)
                    .map(|(_, value)| value.to_string())
            },
            "marfa-cli",
            TIMEOUT,
        )
    }

    fn on(host: &str) -> Settings {
        match with(&[(HOST, host), (TOKEN, "phc_token")]) {
            Reading::On(settings) => settings,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn neither_variable_is_off_and_one_alone_is_said_without_its_value() {
        assert_eq!(with(&[]), Reading::Off);
        assert_eq!(with(&[(HOST, "  "), (TOKEN, "")]), Reading::Off);
        assert_eq!(
            with(&[(HOST, "https://us.i.posthog.com")]),
            Reading::Said(HOST_ALONE)
        );
        assert_eq!(with(&[(TOKEN, "phc_x")]), Reading::Said(TOKEN_ALONE));
        for said in [HOST_ALONE, TOKEN_ALONE, NOT_HTTPS] {
            assert!(!said.contains("phc_"), "{said}");
        }
    }

    #[test]
    fn events_go_to_the_capture_path_under_the_host_as_written() {
        assert_eq!(
            on("https://eu.i.posthog.com").url,
            "https://eu.i.posthog.com/i/v0/e/"
        );
        assert_eq!(
            on("https://eu.i.posthog.com/").url,
            "https://eu.i.posthog.com/i/v0/e/"
        );
        assert_eq!(
            on("https://proxy.example/ingest/?key=x#top").url,
            "https://proxy.example/ingest/i/v0/e/"
        );
        assert_eq!(
            on("http://127.0.0.1:8123").url,
            "http://127.0.0.1:8123/i/v0/e/"
        );
        assert_eq!(on("http://[::1]:8123").url, "http://[::1]:8123/i/v0/e/");
        assert_eq!(on("http://localhost").url, "http://localhost/i/v0/e/");
    }

    #[test]
    fn the_token_is_never_sent_in_the_clear_or_to_an_address_with_a_login() {
        for host in [
            "http://us.i.posthog.com",
            "http://10.0.0.5",
            "http://localhost.example",
            "ftp://us.i.posthog.com",
            "us.i.posthog.com",
            "not a url",
            "https://user:pass@us.i.posthog.com",
            "https://user@us.i.posthog.com",
            "https://",
        ] {
            assert_eq!(
                with(&[(HOST, host), (TOKEN, "phc_token")]),
                Reading::Said(NOT_HTTPS),
                "{host}"
            );
        }
    }

    #[test]
    fn an_event_is_personless_and_carries_the_fixed_sentence_and_the_codes() {
        let reporter = Reporter::new(on("https://eu.i.posthog.com"), "marfa items create");
        let error = CliError::NotHeld("item-secret".into());
        let event: Value = serde_json::from_slice(&reporter.event(1, Some(&error))).unwrap();
        assert_eq!(event["api_key"], "phc_token");
        assert_eq!(event["event"], "$exception");
        assert_eq!(event["distinct_id"].as_str().unwrap().len(), 32);
        let properties = &event["properties"];
        assert_eq!(properties["$process_person_profile"], false);
        assert_eq!(properties["$geoip_disable"], true);
        assert_eq!(properties["command"], "items create");
        assert_eq!(properties["error_code"], "not_held");
        assert_eq!(properties["exit_code"], 1);
        assert_eq!(properties["service.name"], "marfa-cli");
        let exception = &properties["$exception_list"][0];
        assert_eq!(exception["type"], "not_held");
        assert_eq!(exception["value"], describe::error(&error));
        assert!(exception.get("stacktrace").is_none());
        assert!(!event.to_string().contains("secret"));
    }

    #[test]
    fn each_process_has_a_distinct_id_of_its_own() {
        let reporter = Reporter::new(on("https://eu.i.posthog.com"), "marfa status");
        let id = |reporter: &Reporter| {
            let event: Value = serde_json::from_slice(&reporter.event(3, None)).unwrap();
            event["distinct_id"].as_str().unwrap().to_string()
        };
        assert_ne!(id(&reporter), id(&reporter));
    }

    #[test]
    fn a_run_that_failed_with_a_status_alone_is_described_by_the_status() {
        let reporter = Reporter::new(on("https://eu.i.posthog.com"), "marfa device drain");
        let event: Value = serde_json::from_slice(&reporter.event(5, None)).unwrap();
        let exception = &event["properties"]["$exception_list"][0];
        assert_eq!(exception["type"], "exit");
        assert_eq!(exception["value"], describe::exit(5));
        assert!(event["properties"].get("error_code").is_none());
        assert_eq!(event["properties"]["exit_code"], 5);
    }

    #[test]
    fn the_token_is_not_shown_by_the_settings_debug_output() {
        assert!(!format!("{:?}", on("https://eu.i.posthog.com")).contains("phc_token"));
    }
}
