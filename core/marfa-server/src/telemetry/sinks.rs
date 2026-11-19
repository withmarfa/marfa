//! PostHog's error tracking, posted from a thread of its own without retries.

use std::sync::Arc;
use std::time::Duration;

use marfa_telemetry::exception::{Event, Exception, batch};
use marfa_telemetry::host::{CONNECT_LIMIT, may_use_proxy};
use serde_json::Value;

use super::fault::Fault;
use super::lane::Lane;
use crate::app::outbound::notice_agent;
use crate::settings::registry::Receiver;

const QUEUE: usize = 256;
const WINDOW: Duration = Duration::from_secs(2);
const BATCH: usize = 20;
const EXCEPTION_TIMEOUT: Duration = Duration::from_secs(5);
const SDK_INFO: &str = concat!("marfa-server/", env!("CARGO_PKG_VERSION"));

#[derive(Clone)]
pub struct Report {
    pub fault: Arc<Fault>,
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub error_code: String,
    pub timestamp: String,
    /// The trace and span of the request that failed, where it was traced.
    pub trace: Option<(String, String)>,
}

/// A proxy from the environment is used for an address on another host, not for one on
/// this machine, which a proxy cannot reach.
pub fn agent(total: Duration, target: &str) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let mut config = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(total))
        .timeout_connect(Some(total.min(CONNECT_LIMIT)))
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")));
    if !may_use_proxy(target) {
        config = config.proxy(None);
    }
    config.build().into()
}

/// A report, with the receiver and `allow_private_addresses` as they stood when it was made.
pub struct Tracked {
    pub report: Report,
    pub receiver: Receiver,
    pub private_allowed: bool,
}

/// PostHog capture v1. A batch goes to each receiver its reports name, judged by its address
/// as it is sent.
pub fn exceptions(attributes: Vec<(String, String)>) -> Lane<Tracked> {
    Lane::start(
        "exceptions",
        QUEUE,
        WINDOW,
        BATCH,
        move |reports: Vec<Tracked>| {
            let mut posts: Vec<(Receiver, bool, Vec<Value>)> = Vec::new();
            for tracked in reports {
                let event = event(&tracked.report, &attributes);
                match posts.iter_mut().find(|(receiver, private_allowed, _)| {
                    *receiver == tracked.receiver && *private_allowed == tracked.private_allowed
                }) {
                    Some((_, _, events)) => events.push(event),
                    None => posts.push((tracked.receiver, tracked.private_allowed, vec![event])),
                }
            }
            for (receiver, private_allowed, events) in posts {
                let connect = EXCEPTION_TIMEOUT.min(CONNECT_LIMIT);
                let Some(agent) =
                    notice_agent(&receiver.url, EXCEPTION_TIMEOUT, connect, private_allowed)
                else {
                    continue;
                };
                let sent_at = crate::log::now();
                let body = batch(&sent_at, events);
                // PostHog's trouble is not a request's: the answer is never read.
                let _ = agent
                    .post(&receiver.url)
                    .header("Authorization", format!("Bearer {}", receiver.token))
                    .header("Content-Type", "application/json")
                    .header("PostHog-Sdk-Info", SDK_INFO)
                    .header("PostHog-Request-Id", uuid::Uuid::now_v7().to_string())
                    .header("PostHog-Attempt", "1")
                    .header("PostHog-Request-Timestamp", &sent_at)
                    .send(body.to_string().as_bytes());
            }
        },
    )
}

fn event(report: &Report, attributes: &[(String, String)]) -> Value {
    let frames = report.fault.frames();
    let distinct_id = uuid::Uuid::now_v7().to_string();
    let mut properties = vec![
        ("request_id", report.request_id.as_str().into()),
        ("method", report.method.as_str().into()),
        ("path", report.path.as_str().into()),
        ("error_code", report.error_code.as_str().into()),
    ];
    if let Some((trace_id, span_id)) = &report.trace {
        properties.push(("$trace_id", trace_id.as_str().into()));
        properties.push(("$span_id", span_id.as_str().into()));
    }
    Event {
        distinct_id: &distinct_id,
        lib: "marfa-server",
        lib_version: env!("CARGO_PKG_VERSION"),
        exception: Exception {
            kind: report.fault.kind.name(),
            value: &report.fault.message,
            frames: frames.as_deref(),
            handled: true,
        },
        timestamp: Some(&report.timestamp),
        properties,
        attributes,
    }
    .v1(&uuid::Uuid::now_v7().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(trace: Option<(String, String)>) -> Report {
        Report {
            fault: Arc::new(Fault::internal("a job")),
            request_id: String::new(),
            method: String::new(),
            path: String::new(),
            error_code: "internal_error".into(),
            timestamp: "2026-11-19T12:00:00.000Z".into(),
            trace,
        }
    }

    #[test]
    fn an_event_names_its_trace_only_where_the_fault_was_traced() {
        let traced = event(
            &report(Some(("a".repeat(32), "b".repeat(16)))),
            &[("service.version".into(), "1.2.3".into())],
        );
        let properties = &traced["properties"];
        assert_eq!(properties["$trace_id"], "a".repeat(32));
        assert_eq!(properties["$span_id"], "b".repeat(16));
        assert_eq!(properties["service.version"], "1.2.3");
        assert_eq!(traced["options"]["process_person_profile"], false);
        assert!(traced["uuid"].as_str().is_some());

        let untraced = event(&report(None), &[]);
        assert!(untraced["properties"].get("$trace_id").is_none());
        assert!(untraced["properties"].get("$span_id").is_none());
    }
}
