//! Finished spans as an OTLP/HTTP JSON request, and the post that carries it.
//!
//! Not implemented: protobuf, gzip, gRPC, and a retry. A post that fails, or
//! that the collector refuses, is dropped.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::settings::Settings;

/// A span or an event attribute. The allowlist in `layer` decides which keys
/// exist; nothing here accepts a key it was not given as a `&'static str`.
#[derive(Debug, Clone, PartialEq)]
pub enum Attribute {
    Number(i64),
    Word(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub name: &'static str,
    pub at: SystemTime,
    pub attributes: Vec<(&'static str, Attribute)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent: Option<[u8; 8]>,
    pub name: String,
    pub start: SystemTime,
    pub end: SystemTime,
    pub attributes: Vec<(&'static str, Attribute)>,
    pub events: Vec<Event>,
    pub error: bool,
}

pub struct Resource {
    pub service: String,
}

const SCOPE: &str = "marfa-cli";

/// SPAN_KIND_INTERNAL.
const KIND_INTERNAL: u8 = 1;
/// STATUS_CODE_ERROR.
const STATUS_ERROR: u8 = 2;

fn nanos(time: SystemTime) -> String {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos())
        .to_string()
}

fn attributes(list: &[(&'static str, Attribute)]) -> Value {
    list.iter()
        .map(|(key, value)| {
            let value = match value {
                Attribute::Number(number) => json!({ "intValue": number.to_string() }),
                Attribute::Word(word) => json!({ "stringValue": word }),
            };
            json!({ "key": key, "value": value })
        })
        .collect()
}

fn span(span: &Finished) -> Value {
    let mut out = json!({
        "traceId": hex::encode(span.trace_id),
        "spanId": hex::encode(span.span_id),
        "name": span.name,
        "kind": KIND_INTERNAL,
        "startTimeUnixNano": nanos(span.start),
        "endTimeUnixNano": nanos(span.end.max(span.start)),
        "attributes": attributes(&span.attributes),
        "events": span.events.iter().map(|event| json!({
            "timeUnixNano": nanos(event.at),
            "name": event.name,
            "attributes": attributes(&event.attributes),
        })).collect::<Vec<_>>(),
    });
    if let Some(parent) = span.parent {
        out["parentSpanId"] = hex::encode(parent).into();
    }
    if span.error {
        out["status"] = json!({ "code": STATUS_ERROR });
    }
    out
}

pub fn request(resource: &Resource, spans: &[Finished]) -> Vec<u8> {
    let body = json!({
        "resourceSpans": [{
            "resource": { "attributes": [
                { "key": "service.name", "value": { "stringValue": resource.service } },
                { "key": "service.version", "value": { "stringValue": env!("CARGO_PKG_VERSION") } },
            ] },
            "scopeSpans": [{
                "scope": { "name": SCOPE, "version": env!("CARGO_PKG_VERSION") },
                "spans": spans.iter().map(span).collect::<Vec<_>>(),
            }],
        }],
    });
    serde_json::to_vec(&body).expect("a JSON value serializes")
}

/// The longest a connection may take to open, so that an address nobody
/// answers at costs less than the whole budget.
const CONNECT_LIMIT: Duration = Duration::from_secs(1);

pub struct Poster {
    agent: ureq::Agent,
    url: String,
    headers: Vec<(String, String)>,
}

impl Poster {
    pub fn new(settings: &Settings) -> Poster {
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        // The credential a header carries goes to the address named and
        // nowhere else, so no redirect is followed.
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .timeout_global(Some(settings.timeout))
            .timeout_connect(Some(settings.timeout.min(CONNECT_LIMIT)))
            .user_agent(concat!("marfa/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Poster {
            agent,
            url: settings.url.clone(),
            headers: settings.headers.clone(),
        }
    }

    /// Whatever goes wrong, the run is over for this batch and nothing is
    /// said: a collector's trouble is not the command's.
    pub fn post(&self, body: &[u8]) {
        let mut request = self
            .agent
            .post(&self.url)
            .header("Content-Type", "application/json");
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let _ = request.send(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn sample() -> Vec<Finished> {
        vec![
            Finished {
                trace_id: [0xab; 16],
                span_id: [0x01; 8],
                parent: None,
                name: "marfa items create".into(),
                start: at(10),
                end: at(12),
                attributes: vec![("exit_code", Attribute::Number(3))],
                events: vec![Event {
                    name: "error",
                    at: at(11),
                    attributes: vec![
                        ("code", Attribute::Word("network".into())),
                        ("exit_code", Attribute::Number(3)),
                    ],
                }],
                error: true,
            },
            Finished {
                trace_id: [0xab; 16],
                span_id: [0x02; 8],
                parent: Some([0x01; 8]),
                name: "drain".into(),
                start: at(10),
                end: at(11),
                attributes: vec![("outcome", Attribute::Word("ok".into()))],
                events: Vec::new(),
                error: false,
            },
        ]
    }

    #[test]
    fn a_request_has_the_shape_the_stub_collector_reads() {
        let body: Value = serde_json::from_slice(&request(
            &Resource {
                service: "marfa-cli".into(),
            },
            &sample(),
        ))
        .unwrap();
        let resource = &body["resourceSpans"][0];
        assert_eq!(
            resource["resource"]["attributes"][0],
            json!({ "key": "service.name", "value": { "stringValue": "marfa-cli" } })
        );
        let spans = &resource["scopeSpans"][0]["spans"];
        let root = &spans[0];
        assert_eq!(root["traceId"], "ab".repeat(16));
        assert_eq!(root["spanId"], "01".repeat(8));
        assert!(root.get("parentSpanId").is_none());
        assert_eq!(root["name"], "marfa items create");
        assert_eq!(root["startTimeUnixNano"], "10000000000");
        assert_eq!(root["endTimeUnixNano"], "12000000000");
        assert_eq!(root["status"], json!({ "code": 2 }));
        assert_eq!(
            root["attributes"],
            json!([{ "key": "exit_code", "value": { "intValue": "3" } }])
        );
        assert_eq!(
            root["events"][0],
            json!({
                "timeUnixNano": "11000000000",
                "name": "error",
                "attributes": [
                    { "key": "code", "value": { "stringValue": "network" } },
                    { "key": "exit_code", "value": { "intValue": "3" } },
                ],
            })
        );
        let child = &spans[1];
        assert_eq!(child["parentSpanId"], "01".repeat(8));
        assert_eq!(child["traceId"], root["traceId"]);
        assert!(child.get("status").is_none());
        assert_eq!(
            child["attributes"],
            json!([{ "key": "outcome", "value": { "stringValue": "ok" } }])
        );
    }

    #[test]
    fn a_span_never_ends_before_it_starts() {
        let mut spans = sample();
        spans[0].end = at(1);
        let body: Value = serde_json::from_slice(&request(
            &Resource {
                service: "x".into(),
            },
            &spans,
        ))
        .unwrap();
        assert_eq!(
            body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["endTimeUnixNano"],
            "10000000000"
        );
    }

    #[test]
    fn text_in_a_value_is_escaped_not_spliced() {
        let mut spans = sample();
        spans[1].attributes = vec![("outcome", Attribute::Word("a\"b\\c\n".into()))];
        let text = String::from_utf8(request(
            &Resource {
                service: "x".into(),
            },
            &spans,
        ))
        .unwrap();
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            body["resourceSpans"][0]["scopeSpans"][0]["spans"][1]["attributes"][0]["value"]["stringValue"],
            "a\"b\\c\n"
        );
    }
}
