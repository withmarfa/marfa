//! Where an unhandled fault is told to someone: PostHog's error tracking and
//! the error webhook. Both post from a thread of their own and neither retries.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use marfa_telemetry::exception::{Event, Exception};
use marfa_telemetry::host::{CONNECT_LIMIT, may_use_proxy};
use serde_json::{Value, json};

use super::config::{Exceptions, Webhook};
use super::fault::Fault;
use super::lane::Lane;

/// How many reports wait for a thread that is slow to post.
const QUEUE: usize = 256;
/// Reports are gathered for this long, so a burst is one post.
const WINDOW: Duration = Duration::from_secs(2);
const BATCH: usize = 20;
/// The same error at the same path is told once in this long.
const DEBOUNCE: Duration = Duration::from_secs(60);
const MAX_DEBOUNCED: usize = 1_024;

/// One fault, with the request it ended.
#[derive(Clone)]
pub struct Report {
    pub fault: Arc<Fault>,
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub error_code: String,
    pub timestamp: String,
}

/// An agent for a post that may take `total`, and no longer, to `target`. A
/// proxy from the environment is used for an address on another host and not
/// for one on this machine, which a proxy cannot reach.
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

/// Exception reports to error tracking, in batches.
pub fn exceptions(config: Exceptions, attributes: Vec<(String, String)>) -> Lane<Report> {
    let agent = agent(config.timeout, &config.url);
    Lane::start(
        "exceptions",
        QUEUE,
        WINDOW,
        BATCH,
        move |reports: Vec<Report>| {
            let events = reports
                .iter()
                .map(|report| event(report, &attributes))
                .collect();
            let body = marfa_telemetry::exception::batch(&config.token, events);
            // PostHog's trouble is not a request's: the answer is never read.
            let _ = agent
                .post(&config.url)
                .header("Content-Type", "application/json")
                .send(body.to_string().as_bytes());
        },
    )
}

fn event(report: &Report, attributes: &[(String, String)]) -> Value {
    let frames = report.fault.frames();
    let distinct_id = uuid::Uuid::now_v7().to_string();
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
        properties: vec![
            ("request_id", report.request_id.as_str().into()),
            ("method", report.method.as_str().into()),
            ("path", report.path.as_str().into()),
            ("error_code", report.error_code.as_str().into()),
        ],
        attributes,
    }
    .json()
}

/// A notice of a 500 to the error webhook, one for the same error at the same
/// path in a minute.
pub fn webhook(config: Webhook, environment: String) -> Lane<Report> {
    let agent = agent(config.timeout, &config.url);
    let mut told: HashMap<String, Instant> = HashMap::new();
    Lane::start(
        "error-webhook",
        QUEUE,
        Duration::ZERO,
        1,
        move |reports: Vec<Report>| {
            for report in reports {
                let now = Instant::now();
                told.retain(|_, at| now.duration_since(*at) < DEBOUNCE);
                let key = format!(
                    "{}:{}",
                    report.fault.message.chars().take(100).collect::<String>(),
                    report.path
                );
                if told.contains_key(&key) || told.len() >= MAX_DEBOUNCED {
                    continue;
                }
                told.insert(key, now);
                let notice = json!({
                    "timestamp": report.timestamp,
                    "request_id": report.request_id,
                    "error": report.fault.message,
                    "path": report.path,
                    "method": report.method,
                    "environment": environment,
                });
                let _ = agent
                    .post(&config.url)
                    .header("Content-Type", "application/json")
                    .send(notice.to_string().as_bytes());
            }
        },
    )
}
