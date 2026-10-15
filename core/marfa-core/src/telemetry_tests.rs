//! What the core records through `tracing` once the `telemetry` feature is
//! on and a host has installed a subscriber. The subscriber here stands in
//! for a host's exporter: it keeps every span, field and event it is given.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

use crate::scripted::{self, Scripted};
use crate::stop_tests::{copy, copy_keyed, holding_a_catalog, note};
use crate::{Core, CoreError, Draft, SearchFilters, Server};

#[derive(Debug, Clone)]
struct SpanLog {
    name: String,
    fields: BTreeMap<String, String>,
    references: usize,
}

#[derive(Debug, Clone)]
struct EventLog {
    level: Level,
    target: String,
    fields: BTreeMap<String, String>,
    /// The span the event was recorded inside.
    within: Option<String>,
}

#[derive(Default)]
struct Log {
    spans: Vec<SpanLog>,
    events: Vec<EventLog>,
    entered: Vec<usize>,
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Log>>);

struct Fields<'a>(&'a mut BTreeMap<String, String>);

impl Visit for Fields<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), format!("{value:?}"));
    }
}

impl Subscriber for Recorder {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, attributes: &Attributes<'_>) -> Id {
        let mut log = self.0.lock().unwrap();
        let mut fields = BTreeMap::new();
        attributes.record(&mut Fields(&mut fields));
        log.spans.push(SpanLog {
            name: attributes.metadata().name().into(),
            fields,
            references: 1,
        });
        Id::from_u64(log.spans.len() as u64)
    }

    fn record(&self, id: &Id, values: &Record<'_>) {
        let mut log = self.0.lock().unwrap();
        let span = &mut log.spans[id.into_u64() as usize - 1];
        values.record(&mut Fields(&mut span.fields));
    }

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut log = self.0.lock().unwrap();
        let mut fields = BTreeMap::new();
        event.record(&mut Fields(&mut fields));
        let within = log.entered.last().map(|at| log.spans[*at].name.clone());
        log.events.push(EventLog {
            level: *event.metadata().level(),
            target: event.metadata().target().into(),
            fields,
            within,
        });
    }

    fn enter(&self, id: &Id) {
        self.0
            .lock()
            .unwrap()
            .entered
            .push(id.into_u64() as usize - 1);
    }

    fn exit(&self, _: &Id) {
        self.0.lock().unwrap().entered.pop();
    }

    fn clone_span(&self, id: &Id) -> Id {
        self.0.lock().unwrap().spans[id.into_u64() as usize - 1].references += 1;
        id.clone()
    }

    fn try_close(&self, id: Id) -> bool {
        let mut log = self.0.lock().unwrap();
        let span = &mut log.spans[id.into_u64() as usize - 1];
        span.references -= 1;
        span.references == 0
    }
}

impl Recorder {
    fn log(&self) -> Log {
        let log = self.0.lock().unwrap();
        Log {
            spans: log.spans.clone(),
            events: log.events.clone(),
            entered: Vec::new(),
        }
    }
}

/// Everything `run` records on this thread.
fn recorded<T>(run: impl FnOnce() -> T) -> (T, Log) {
    let recorder = Recorder::default();
    let result = tracing::subscriber::with_default(recorder.clone(), run);
    (result, recorder.log())
}

impl Log {
    fn spans(&self, name: &str) -> Vec<&SpanLog> {
        self.spans.iter().filter(|span| span.name == name).collect()
    }

    fn one(&self, name: &str) -> &SpanLog {
        let found = self.spans(name);
        assert_eq!(found.len(), 1, "expected one `{name}` span in {self:#?}");
        found[0]
    }

    fn events_within(&self, name: &str) -> Vec<&EventLog> {
        self.events
            .iter()
            .filter(|event| event.within.as_deref() == Some(name))
            .collect()
    }

    /// Every span left open and every span still entered.
    fn open_spans(&self) -> Vec<&str> {
        self.spans
            .iter()
            .filter(|span| span.references > 0)
            .map(|span| span.name.as_str())
            .collect()
    }

    /// Every name and value anything was recorded under.
    fn text(&self) -> Vec<String> {
        let mut text = Vec::new();
        for span in &self.spans {
            text.push(span.name.clone());
            text.extend(span.fields.iter().flat_map(|(k, v)| [k.clone(), v.clone()]));
        }
        for event in &self.events {
            text.push(event.level.to_string());
            text.push(event.target.clone());
            text.extend(
                event
                    .fields
                    .iter()
                    .flat_map(|(k, v)| [k.clone(), v.clone()]),
            );
        }
        text
    }
}

impl std::fmt::Debug for Log {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Log")
            .field("spans", &self.spans)
            .field("events", &self.events)
            .finish()
    }
}

fn error_events(log: &Log) -> Vec<&EventLog> {
    log.events
        .iter()
        .filter(|event| event.level == Level::ERROR)
        .collect()
}

/// A copy with one item queued and a server that takes it.
fn copy_with_a_write(server: &Scripted, draft: &Draft, key: &str) -> (Arc<Core>, String) {
    let core = copy_keyed(server, key);
    holding_a_catalog(&core);
    let created = core.create_item(draft).unwrap();
    let id = created.item_id.clone().unwrap();
    let item = serde_json::from_str::<serde_json::Value>(&scripted::item_payload(
        "item.created",
        &id,
        "core.note",
        1,
    ))
    .unwrap()["item"]
        .clone();
    let receipt = serde_json::json!({ "item": item }).to_string();
    let current =
        serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true }).to_string();
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(
        &format!("/items/{id}"),
        vec![scripted::certified(scripted::json(200, &current))],
    );
    (core, id)
}

/// A server whose log has nothing past the copy's cursor.
fn at_the_head(server: &Scripted) {
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::connected(),
                scripted::copy_marker("stream_cursor", "10"),
                scripted::copy_marker("stream_live", "10"),
            ],
            scripted::Then::End,
        )],
    );
}

#[test]
fn a_drain_that_fails_records_an_error_event_with_its_code() {
    let server = Scripted::start();
    let core = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: "k".into(),
    }))
    .unwrap();
    core.create_item(&note(None)).unwrap();

    let (result, log) = recorded(|| core.drain());

    assert_eq!(result, Err(CoreError::NoCursor));
    let drain = log.one("drain");
    assert_eq!(drain.fields["outcome"], "error");
    let errors = error_events(&log);
    assert_eq!(errors.len(), 1, "{log:?}");
    assert_eq!(errors[0].fields["code"], "no_cursor");
    assert_eq!(errors[0].within.as_deref(), Some("drain"));
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_drain_that_succeeds_records_a_span_with_its_counts_and_no_error() {
    let server = Scripted::start();
    let (core, _) = copy_with_a_write(&server, &note(None), "k");

    let (result, log) = recorded(|| core.drain());

    let report = result.unwrap();
    assert_eq!(report.answered, 1, "{report:?}");
    let drain = log.one("drain");
    assert_eq!(drain.fields["outcome"], "ok");
    assert_eq!(drain.fields["answered"], "1");
    assert_eq!(drain.fields["undelivered"], "0");
    let write = log.one("write");
    assert_eq!(write.fields["kind"], "create_item");
    assert_eq!(write.fields["status"], "201");
    assert!(error_events(&log).is_empty(), "{log:?}");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_drain_whose_server_cannot_be_reached_ends_its_span_and_records_the_code() {
    let server = Scripted::start();
    let (core, _) = copy_with_a_write(&server, &note(None), "k");
    server.on("/", vec![scripted::refusal(503, "unavailable")]);

    let (result, log) = recorded(|| core.drain());

    let report = result.unwrap();
    assert!(report.unavailable.is_some(), "{report:?}");
    assert_eq!(
        server.seen("/items").len(),
        0,
        "a write went to a server that could not say which instance it was"
    );
    let drain = log.one("drain");
    assert_eq!(drain.fields["outcome"], "unavailable");
    assert_eq!(drain.fields["undelivered"], "1");
    let warnings: Vec<_> = log
        .events
        .iter()
        .filter(|event| event.level == Level::WARN)
        .collect();
    assert_eq!(warnings.len(), 1, "{log:?}");
    assert_eq!(warnings[0].fields["code"], "server");
    assert_eq!(warnings[0].within.as_deref(), Some("drain"));
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_write_the_network_cuts_off_records_its_code_inside_the_write_span() {
    let server = Scripted::start();
    let (core, _) = copy_with_a_write(&server, &note(None), "k");
    server.on(
        "/items",
        vec![scripted::stream(vec![], scripted::Then::Break)],
    );

    let (result, log) = recorded(|| core.drain());

    assert!(result.unwrap().unavailable.is_some());
    let write = log.one("write");
    assert_eq!(write.fields["kind"], "create_item");
    assert!(!write.fields.contains_key("status"));
    let inside = log.events_within("write");
    assert_eq!(inside.len(), 1, "{log:?}");
    assert_eq!(inside[0].fields["code"], "network");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_catch_up_records_a_span_and_a_failed_one_records_its_code() {
    let server = Scripted::start();
    let core = copy(&server);
    at_the_head(&server);
    let (result, log) = recorded(|| core.catch_up());
    let report = result.unwrap();
    let span = log.one("catch_up");
    assert_eq!(span.fields["outcome"], "ok");
    assert_eq!(span.fields["applied"], report.applied.to_string());
    assert_eq!(error_events(&log).len(), 0);
    assert_eq!(log.open_spans(), Vec::<&str>::new());

    let (failed, log) = recorded(|| {
        Core::open_in_memory(Some(Server {
            url: server.url(),
            key: "k".into(),
        }))
        .unwrap()
        .catch_up()
    });
    assert_eq!(failed.unwrap_err(), CoreError::NoCursor);
    assert_eq!(log.one("catch_up").fields["outcome"], "error");
    let errors = error_events(&log);
    assert_eq!(errors.len(), 1, "{log:?}");
    assert_eq!(errors[0].fields["code"], "no_cursor");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_search_records_its_hit_count_and_a_refused_one_its_code() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    core.create_item(&note(None)).unwrap();
    let filters = SearchFilters::default();

    let (hits, log) = recorded(|| core.search("b", &filters, 10));
    let hits = hits.unwrap();
    assert_eq!(hits.len(), 1);
    let span = log.one("search");
    assert_eq!(span.fields["outcome"], "ok");
    assert_eq!(span.fields["hits"], "1");

    let (shown, log) = recorded(|| core.search_shown("b", &filters, 10));
    assert_eq!(shown.unwrap().len(), 1);
    assert_eq!(log.one("search").fields["hits"], "1");

    let bad = SearchFilters {
        filter: Some("(".into()),
        ..SearchFilters::default()
    };
    let (refused, log) = recorded(|| core.search("b", &bad, 10));
    let code = refused.unwrap_err().code();
    assert_eq!(log.one("search").fields["outcome"], "error");
    let errors = error_events(&log);
    assert_eq!(errors.len(), 1, "{log:?}");
    assert_eq!(errors[0].fields["code"], code);
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

fn warnings(log: &Log) -> Vec<&EventLog> {
    log.events
        .iter()
        .filter(|event| event.level == Level::WARN)
        .collect()
}

#[test]
fn a_write_error_that_ends_the_drain_is_recorded_once() {
    let server = Scripted::start();
    let (core, _) = copy_with_a_write(&server, &note(None), "k");
    server.on(
        "/items",
        vec![scripted::Answer::Json {
            status: 302,
            body: String::new(),
            headers: vec![("Location".into(), "http://127.0.0.1:1/".into())],
        }],
    );

    let (result, log) = recorded(|| core.drain());

    assert_eq!(result.unwrap_err().code(), "redirect");
    let errors = error_events(&log);
    assert_eq!(errors.len(), 1, "{log:?}");
    assert_eq!(errors[0].fields["code"], "redirect");
    assert_eq!(errors[0].within.as_deref(), Some("drain"));
    assert_eq!(
        warnings(&log).len(),
        0,
        "a request the drain did not carry on past was recorded as left for the next pass: {log:?}"
    );
    assert_eq!(log.one("write").fields["outcome"], "error");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

/// A create the server refuses, whose read-back the server cannot answer.
fn copy_with_a_refused_write(server: &Scripted) -> Arc<Core> {
    let (core, id) = copy_with_a_write(server, &note(None), "k");
    server.on("/items", vec![scripted::refusal(400, "validation_error")]);
    server.on(
        &format!("/items/{id}"),
        vec![scripted::refusal(503, "unavailable")],
    );
    core
}

#[test]
fn a_read_back_that_fails_after_a_refusal_records_a_warning_with_its_code() {
    let server = Scripted::start();
    let core = copy_with_a_refused_write(&server);

    let (result, log) = recorded(|| core.drain());

    let report = result.unwrap();
    assert!(report.unavailable.is_some(), "{report:?}");
    assert_eq!(log.one("drain").fields["outcome"], "unavailable");
    let warned = warnings(&log);
    assert_eq!(warned.len(), 1, "{log:?}");
    assert_eq!(warned[0].fields["code"], "server");
    assert_eq!(warned[0].within.as_deref(), Some("drain"));
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn an_owed_read_back_that_fails_again_records_a_warning_with_its_code() {
    let server = Scripted::start();
    let core = copy_with_a_refused_write(&server);
    core.drain().unwrap();

    let (result, log) = recorded(|| core.drain());

    let report = result.unwrap();
    assert!(report.unavailable.is_some(), "{report:?}");
    assert_eq!(log.one("drain").fields["outcome"], "unavailable");
    let warned = warnings(&log);
    assert_eq!(warned.len(), 1, "{log:?}");
    assert_eq!(warned[0].fields["code"], "server");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

#[test]
fn a_read_back_that_fails_after_an_accepted_write_records_a_warning_with_its_code() {
    let server = Scripted::start();
    let (core, id) = copy_with_a_write(&server, &note(None), "k");
    server.on(
        &format!("/items/{id}"),
        vec![scripted::refusal(503, "unavailable")],
    );

    let (result, log) = recorded(|| core.drain());

    assert!(result.unwrap().unavailable.is_some());
    let warned = warnings(&log);
    assert_eq!(warned.len(), 1, "{log:?}");
    assert_eq!(warned[0].fields["code"], "server");
    assert_eq!(log.open_spans(), Vec::<&str>::new());
}

const SECRETS: [&str; 8] = [
    "zq_secret_title",
    "zq_secret_body",
    "zq_secret_tag",
    "zq_secret_source",
    "zq_secret_source_id",
    "zq_secret_key",
    "zq_secret_query",
    "zq_secret_message",
];

#[test]
fn no_content_key_or_credential_reaches_a_span_or_an_event() {
    let server = Scripted::start();
    let draft = Draft {
        r#type: "core.note".into(),
        properties: serde_json::json!({
            "title": SECRETS[0],
            "body": format!("{} {}", SECRETS[1], SECRETS[6]),
        })
        .as_object()
        .unwrap()
        .clone(),
        tags: vec![SECRETS[2].into()],
        source: Some(SECRETS[3].into()),
        source_id: Some(SECRETS[4].into()),
        ..Default::default()
    };
    let (core, id) = copy_with_a_write(&server, &draft, SECRETS[5]);
    server.on(
        &format!("/items/{id}"),
        vec![scripted::json(
            503,
            &format!(
                r#"{{"error":{{"code":"unavailable","message":"{}"}}}}"#,
                SECRETS[7]
            ),
        )],
    );
    at_the_head(&server);
    server.on(
        "/items/lookup",
        vec![scripted::json(200, r#"{"data":[],"tombstones":[]}"#)],
    );
    let filters = SearchFilters::default();
    let bad = SearchFilters {
        filter: Some(format!("{} eq 1", SECRETS[0])),
        ..SearchFilters::default()
    };
    let never_hydrated = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: SECRETS[5].into(),
    }))
    .unwrap();
    never_hydrated.create_item(&draft).unwrap();

    let (outcomes, log) = recorded(|| {
        let found = core.search(SECRETS[6], &filters, 10).unwrap();
        let refused_search = core.search(SECRETS[6], &bad, 10).unwrap_err();
        let drained = core.drain().unwrap();
        let refused_drain = never_hydrated.drain().unwrap_err();
        let caught_up = core.catch_up();
        (found, refused_search, drained, refused_drain, caught_up)
    });
    let (found, refused_search, drained, refused_drain, caught_up) = outcomes;

    // The witness: each operation ran, took the secrets in, and was
    // recorded, so a log without them is not a log of nothing.
    assert!(drained.answered >= 1, "{drained:?}");
    assert!(caught_up.is_ok());
    assert_eq!(refused_drain, CoreError::NoCursor);
    assert_eq!(found.len(), 1);
    assert_eq!(refused_search.code(), "validation");
    for name in ["search", "drain", "write", "catch_up"] {
        assert!(!log.spans(name).is_empty(), "no `{name}` span in {log:?}");
    }
    assert!(!error_events(&log).is_empty());
    assert!(
        drained
            .unavailable
            .as_deref()
            .is_some_and(|why| why.contains(SECRETS[7])),
        "the failed read-back did not carry its message into the core: {drained:?}"
    );
    assert!(
        !warnings(&log).is_empty(),
        "the failed read-back recorded no warning, so the test cannot show one is clean"
    );
    let sent = server.seen("/items");
    let body = String::from_utf8(sent[0].body.clone()).unwrap();
    for secret in &SECRETS[..2] {
        assert!(body.contains(secret), "the write did not carry {secret}");
    }
    assert!(
        sent[0]
            .authorization
            .as_deref()
            .is_some_and(|value| value.contains(SECRETS[5])),
        "the write did not carry the key"
    );
    let witness = recorded(|| tracing::info!(title = SECRETS[0], "witness")).1;
    assert!(witness.text().iter().any(|text| text.contains(SECRETS[0])));

    let text = log.text();
    assert!(text.iter().any(|text| text == "drain"));
    for secret in SECRETS {
        assert!(
            !text.iter().any(|text| text.contains(secret)),
            "{secret} reached a span or an event: {log:?}"
        );
    }
}
