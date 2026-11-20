//! PostHog's error tracking, posted from a thread of its own without retries.

use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwapOption;
use marfa_telemetry::exception::{Event, Exception, batch};
use marfa_telemetry::host::CONNECT_LIMIT;
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

/// What a report says failed: a fault the server met, with its stack, or a fixed sentence.
#[derive(Clone)]
pub enum Raised {
    Fault(Arc<Fault>),
    Fixed {
        kind: &'static str,
        value: &'static str,
    },
}

/// The request or job a fault failed, which a fixed report never names.
#[derive(Clone)]
pub struct Failed {
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub error_code: String,
    /// The trace and span of the request that failed, where it was traced.
    pub trace: Option<(String, String)>,
}

#[derive(Clone)]
pub struct Report {
    pub raised: Raised,
    pub failed: Option<Failed>,
    pub timestamp: String,
}

/// Where reports go and what they carry, as the settings said when a report was made.
#[derive(PartialEq)]
pub struct Route {
    pub receiver: Receiver,
    pub private_allowed: bool,
    pub attributes: Vec<(String, String)>,
}

pub struct Tracked {
    pub report: Report,
    pub route: Arc<Route>,
}

/// PostHog capture v1. A report is sent only on the route the settings name as it is sent, so
/// one queued before a change of route is dropped.
pub fn exceptions(current: Arc<ArcSwapOption<Route>>) -> Lane<Tracked> {
    Lane::start(
        "exceptions",
        QUEUE,
        WINDOW,
        BATCH,
        move |reports: Vec<Tracked>| {
            let Some(route) = current.load_full() else {
                return;
            };
            let events: Vec<Value> = reports
                .iter()
                .filter(|tracked| Arc::ptr_eq(&tracked.route, &route))
                .map(|tracked| event(&tracked.report, &route.attributes))
                .collect();
            if events.is_empty() {
                return;
            }
            let receiver = &route.receiver;
            let connect = EXCEPTION_TIMEOUT.min(CONNECT_LIMIT);
            let Some(agent) = notice_agent(
                &receiver.url,
                EXCEPTION_TIMEOUT,
                connect,
                route.private_allowed,
            ) else {
                return;
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
        },
    )
}

fn event(report: &Report, attributes: &[(String, String)]) -> Value {
    let distinct_id = uuid::Uuid::now_v7().to_string();
    let mut properties: Vec<(&str, Value)> = Vec::new();
    if let Some(failed) = &report.failed {
        properties.push(("request_id", failed.request_id.as_str().into()));
        properties.push(("method", failed.method.as_str().into()));
        properties.push(("path", failed.path.as_str().into()));
        properties.push(("error_code", failed.error_code.as_str().into()));
        if let Some((trace_id, span_id)) = &failed.trace {
            properties.push(("$trace_id", trace_id.as_str().into()));
            properties.push(("$span_id", span_id.as_str().into()));
        }
    }
    let (kind, value, frames) = match &report.raised {
        Raised::Fault(fault) => (fault.kind.name(), fault.message.as_str(), fault.frames()),
        Raised::Fixed { kind, value } => (*kind, *value, None),
    };
    Event {
        distinct_id: &distinct_id,
        lib: "marfa-server",
        lib_version: env!("CARGO_PKG_VERSION"),
        exception: Exception {
            kind,
            value,
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
            raised: Raised::Fault(Arc::new(Fault::internal("a job"))),
            failed: Some(Failed {
                request_id: String::new(),
                method: String::new(),
                path: String::new(),
                error_code: "internal_error".into(),
                trace,
            }),
            timestamp: "2026-11-19T12:00:00.000Z".into(),
        }
    }

    #[test]
    fn a_fixed_report_names_no_request_and_carries_only_its_sentence() {
        let fixed = event(
            &Report {
                raised: Raised::Fixed {
                    kind: "ConnectorRunFailed",
                    value: "A connector's last run failed.",
                },
                failed: None,
                timestamp: "2026-11-19T12:00:00.000Z".into(),
            },
            &[],
        );
        let properties = &fixed["properties"];
        for absent in ["request_id", "method", "path", "error_code", "$trace_id"] {
            assert!(properties.get(absent).is_none(), "{absent} in {fixed}");
        }
        let exception = &properties["$exception_list"][0];
        assert_eq!(exception["type"], "ConnectorRunFailed");
        assert_eq!(exception["value"], "A connector's last run failed.");
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
