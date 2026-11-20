//! What the server tells a receiver about an unhandled fault, where its settings say, and that
//! a slow or silent receiver changes nothing for a request.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

/// The path, the head and the body of each request, and when its connection was accepted.
type Received = Arc<Mutex<Vec<(String, String, String, Instant)>>>;

fn receiver(silent: bool) -> (String, Received) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let received: Received = Arc::default();
    let sink = received.clone();
    thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming().map_while(Result::ok) {
            if silent {
                held.push(stream);
                continue;
            }
            let accepted = Instant::now();
            let sink = sink.clone();
            thread::spawn(move || answer(stream, &sink, accepted));
        }
    });
    (address, received)
}

fn answer(mut stream: TcpStream, sink: &Received, accepted: Instant) {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, length) = loop {
        let Ok(read) = stream.read(&mut chunk) else {
            return;
        };
        if read == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            break (at + 4, length);
        }
    };
    while bytes.len() < head_end + length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => bytes.extend_from_slice(&chunk[..read]),
        }
    }
    let head = String::from_utf8_lossy(&bytes[..head_end]).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    let body = String::from_utf8_lossy(&bytes[head_end..head_end + length]).into_owned();
    sink.lock().unwrap().push((path, head, body, accepted));
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\
          Connection: close\r\n\r\n{}",
    );
}

const EVENTS: &str = "/i/v1/analytics/events";

/// How long a stop waits for an exception report: the first stack resolution in a large debug
/// binary can be slow under load. The stop returns as soon as the report is sent.
const REPORT_BUDGET: Duration = Duration::from_secs(20);

fn posted(received: &Received, prefix: &str) -> Vec<Value> {
    received
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, ..)| path.starts_with(prefix))
        .map(|(_, _, body, _)| serde_json::from_str(body).unwrap())
        .collect()
}

/// Each request's headers, keyed by their lowercase names.
fn heads(received: &Received, prefix: &str) -> Vec<Vec<(String, String)>> {
    received
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, ..)| path.starts_with(prefix))
        .map(|(_, head, ..)| {
            head.lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
                .collect()
        })
        .collect()
}

fn exceptions(received: &Received) -> Vec<Value> {
    posted(received, EVENTS)
        .iter()
        .flat_map(|body| body["batch"].as_array().unwrap().clone())
        .collect()
}

fn ids(events: &[Value], field: &str) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            let found = event.get(field).or_else(|| event["properties"].get(field));
            found
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

struct Instance {
    dir: TempDir,
    app: Arc<App>,
    public: Router,
    key: String,
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn request(method: Method, path: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

impl Instance {
    async fn start(pairs: &[(&str, &str)]) -> (Instance, marfa_server::telemetry::Guard) {
        Instance::start_as(true, pairs).await
    }

    /// With `hooks` off the server is the one an owner runs: no setting is seeded from a
    /// variable, so only a stored setting can say where anything is sent.
    async fn start_as(
        hooks: bool,
        pairs: &[(&str, &str)],
    ) -> (Instance, marfa_server::telemetry::Guard) {
        // Log records reach the exporter through the process's one subscriber.
        marfa_server::log::init();
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let mut all = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        if hooks {
            all.push(("MARFA_TEST_HOOKS", "true"));
        }
        all.extend_from_slice(pairs);
        let environment = Environment::from_pairs(&all);
        let app = App::start(Settings::read(environment).unwrap())
            .await
            .unwrap();
        let guard = app.telemetry.start(&app.instance_id, &app.settings);
        let control = control(app.clone());
        let (_, minted) = send(
            &control,
            request(
                Method::POST,
                "/keys",
                None,
                json!({ "label": "t", "source": "t", "permissions": [], "type_permissions": { "*": "write" } }),
            ),
        )
        .await;
        let key = minted["key"].as_str().unwrap().to_string();
        let instance = Instance {
            dir,
            public: public(app.clone()),
            app,
            key,
        };
        (instance, guard)
    }

    async fn write_note(&self, request_id: &str) -> StatusCode {
        let mut call = request(
            Method::POST,
            "/items",
            Some(&self.key),
            json!({ "type": "core.note", "properties": { "body": "x" } }),
        );
        call.headers_mut()
            .insert("x-request-id", request_id.parse().unwrap());
        send(&self.public, call).await.0
    }

    /// Makes the next write fail inside the database by renaming a table it reaches.
    fn break_writes(&self) {
        let db = rusqlite::Connection::open(self.dir.path().join("marfa.db")).unwrap();
        db.execute_batch("ALTER TABLE event_log RENAME TO event_log_gone")
            .unwrap();
    }

    fn mend_writes(&self) {
        let db = rusqlite::Connection::open(self.dir.path().join("marfa.db")).unwrap();
        db.execute_batch("ALTER TABLE event_log_gone RENAME TO event_log")
            .unwrap();
    }

    /// A write under `request_id` that ends in an unhandled fault.
    async fn fail_note(&self, request_id: &str) {
        self.break_writes();
        assert_eq!(
            self.write_note(request_id).await,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        self.mend_writes();
    }

    /// A write through the private local door, as `marfa config set` makes one.
    async fn configure(&self, body: Value) -> (StatusCode, Value) {
        send(
            &control(self.app.clone()),
            request(Method::PATCH, "/config", None, body),
        )
        .await
    }

    async fn configure_as(&self, request_id: &str, body: Value) -> StatusCode {
        let mut call = request(Method::PATCH, "/config", None, body);
        call.headers_mut()
            .insert("x-request-id", request_id.parse().unwrap());
        send(&control(self.app.clone()), call).await.0
    }
}

/// The seeds of an OTLP collector at `host`, which a fault reaches with no PostHog setting.
fn settings(host: &str, other: &[(&'static str, String)]) -> Vec<(String, String)> {
    let mut pairs = vec![
        (
            "MARFA_OTEL_EXPORTER_OTLP_ENDPOINT".to_string(),
            host.to_string(),
        ),
        ("MARFA_OTEL_SAMPLE_RATIO".to_string(), "0".to_string()),
        // The receiver listens on loopback.
        (
            "MARFA_ALLOW_PRIVATE_ADDRESSES".to_string(),
            "true".to_string(),
        ),
    ];
    pairs.extend(other.iter().map(|(k, v)| (k.to_string(), v.clone())));
    pairs
}

fn borrowed(pairs: &[(String, String)]) -> Vec<(&str, &str)> {
    pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

/// The PostHog seeds, which a booted server reads in place of the settings' defaults.
fn posthog(host: &str) -> [(&'static str, String); 2] {
    [
        ("MARFA_POSTHOG_HOST", host.to_string()),
        ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_test".to_string()),
    ]
}

#[tokio::test]
async fn a_fault_after_the_posthog_settings_are_written_is_one_exception_sent_as_capture_v1() {
    let (host, received) = receiver(false);
    let pairs = settings(&host, &[]);
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    assert_eq!(instance.write_note("landed").await, StatusCode::CREATED);
    instance.break_writes();
    assert_eq!(
        instance.write_note("before").await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    instance.mend_writes();
    let (status, answer) = instance
        .configure(json!({ "posthog_host": host, "posthog_project_token": "phc_test" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    instance.break_writes();
    assert_eq!(
        instance.write_note("the-fault").await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    guard.stop(REPORT_BUDGET);

    let events = exceptions(&received);
    assert_eq!(ids(&events, "request_id"), ["the-fault"], "{events:?}");

    let heads = heads(&received, EVENTS);
    assert_eq!(heads.len(), 1);
    let header = |name: &str| {
        heads[0]
            .iter()
            .find(|(held, _)| held == name)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };
    assert_eq!(header("authorization"), "Bearer phc_test");
    assert_eq!(header("content-type"), "application/json");
    assert!(header("user-agent").starts_with("marfa-server/"));
    assert!(header("posthog-sdk-info").starts_with("marfa-server/"));
    assert_eq!(header("posthog-attempt"), "1");
    assert!(uuid::Uuid::parse_str(&header("posthog-request-id")).is_ok());
    assert!(header("posthog-request-timestamp").ends_with('Z'));

    let body = &posted(&received, EVENTS)[0];
    assert!(body.get("api_key").is_none(), "{body}");
    assert!(
        body["created_at"]
            .as_str()
            .is_some_and(|at| at.ends_with('Z'))
    );
    let event = &events[0];
    assert_eq!(event["event"], "$exception");
    assert!(uuid::Uuid::parse_str(event["uuid"].as_str().unwrap()).is_ok());
    assert!(event["distinct_id"].as_str().is_some());
    assert!(event["timestamp"].as_str().is_some());
    assert_eq!(event["options"]["process_person_profile"], false);
    let properties = &event["properties"];
    assert_eq!(properties["error_code"], "internal_error");
    assert_eq!(properties["service.instance.id"], instance.app.instance_id);
    assert_eq!(properties["service.version"], env!("CARGO_PKG_VERSION"));
    assert!(properties.get("deployment.environment").is_none());
    assert_eq!(properties["$trace_id"].as_str().map(str::len), Some(32));
    assert_eq!(properties["$span_id"].as_str().map(str::len), Some(16));
    let exception = &event["properties"]["$exception_list"][0];
    assert_eq!(exception["type"], "DatabaseFailure");
    assert_eq!(
        exception["value"],
        "Database operation failed (SQLITE_ERROR)"
    );
    let frames = exception["stacktrace"]["frames"].as_array().unwrap();
    if std::env::var_os("PRINT_FRAMES").is_some() {
        for frame in frames {
            eprintln!("FRAME {frame}");
        }
    }
    assert!(
        frames.iter().any(|frame| frame["in_app"] == true),
        "{frames:?}"
    );
    let reported = event.to_string();
    for forbidden in ["event_log", "no such table", "INSERT", "phc_test"] {
        assert!(!reported.contains(forbidden), "{forbidden} in {reported}");
    }
}

#[tokio::test]
async fn a_posthog_host_that_leads_to_this_machine_is_sent_nothing_until_private_addresses_are_allowed()
 {
    let (host, received) = receiver(false);
    let by_name = host.replace("127.0.0.1", "localhost");
    for allowed in ["false", "true"] {
        let mut pairs: Vec<(String, String)> = posthog(&by_name)
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect();
        pairs.push((
            "MARFA_ALLOW_PRIVATE_ADDRESSES".to_string(),
            allowed.to_string(),
        ));
        let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
        instance.break_writes();
        instance.write_note(&format!("allowed-{allowed}")).await;
        guard.stop(REPORT_BUDGET);
    }
    assert_eq!(ids(&exceptions(&received), "request_id"), ["allowed-true"]);
}

#[tokio::test]
async fn a_trace_with_an_error_is_exported_when_the_ratio_keeps_none() {
    let (host, received) = receiver(false);
    let pairs = settings(&host, &[]);
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    assert_eq!(instance.write_note("landed").await, StatusCode::CREATED);
    instance.break_writes();
    instance.write_note("the-fault").await;
    guard.stop(Duration::from_secs(5));

    let traces = posted(&received, "/v1/traces");
    let spans: Vec<&Value> = traces
        .iter()
        .flat_map(|batch| batch["resourceSpans"].as_array().unwrap())
        .flat_map(|resource| resource["scopeSpans"].as_array().unwrap())
        .flat_map(|scope| scope["spans"].as_array().unwrap())
        .collect();
    assert_eq!(spans.len(), 1, "{spans:?}");
    assert!(spans[0].to_string().contains("the-fault"));
}

#[tokio::test]
async fn the_preference_is_read_for_each_fault() {
    let (host, received) = receiver(false);
    let pairs = settings(&host, &posthog(&host));
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    instance.break_writes();

    let store = |value: &str| {
        instance
            .app
            .settings
            .apply_stored(&[("error_reporting_enabled".to_string(), value.to_string())]);
    };
    store("false");
    instance.write_note("while-off").await;
    store("true");
    instance.write_note("while-on").await;
    guard.stop(REPORT_BUDGET);

    assert_eq!(ids(&exceptions(&received), "request_id"), ["while-on"]);
}

#[tokio::test]
async fn a_receiver_that_never_answers_changes_nothing_for_a_request() {
    let (host, _) = receiver(true);
    let pairs = settings(&host, &posthog(&host));
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    instance.break_writes();

    let started = Instant::now();
    for number in 0..600 {
        assert_eq!(
            instance.write_note(&format!("storm-{number}")).await,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );

    // Retiring an exporter stuck on the silent receiver holds up no write.
    let (other, _) = receiver(true);
    let swapping = Instant::now();
    let (status, answer) = instance
        .configure(json!({ "otel_exporter_otlp_endpoint": other }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(
        swapping.elapsed() < Duration::from_millis(500),
        "{:?}",
        swapping.elapsed()
    );

    let stopping = Instant::now();
    guard.stop(Duration::from_secs(1));
    assert!(
        stopping.elapsed() < Duration::from_millis(2500),
        "{:?}",
        stopping.elapsed()
    );
}

/// Each trace or log post's request ids among `ids`, with the header `name` it carried.
fn sent_with(received: &Received, prefix: &str, ids: &[&str], name: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for (path, head, body, _) in received.lock().unwrap().iter() {
        if !path.starts_with(prefix) {
            continue;
        }
        let carried = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(held, _)| held.trim().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default();
        for id in ids {
            if body.contains(&format!("\"{id}\"")) {
                found.push((id.to_string(), carried.clone()));
            }
        }
    }
    found.sort();
    found
}

fn pair(id: &str, header: &str) -> (String, String) {
    (id.to_string(), header.to_string())
}

/// The moment after which a request counts as late.
fn mark() -> Instant {
    Instant::now()
}

/// What the receiver took on connections accepted after `from`: a post already past the
/// exporter's halt check may still arrive after a change is answered, and the statement allows it.
fn since(received: &Received, from: Instant) -> Received {
    let late = received
        .lock()
        .unwrap()
        .iter()
        .filter(|(.., accepted)| *accepted > from)
        .cloned()
        .collect();
    Arc::new(Mutex::new(late))
}

#[tokio::test]
async fn a_change_to_the_endpoint_headers_or_switch_is_followed_with_no_restart_and_drops_what_was_queued()
 {
    let (host, received) = receiver(false);
    let (instance, guard) = Instance::start(&[
        ("MARFA_OTEL_SAMPLE_RATIO", "1"),
        ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true"),
    ])
    .await;
    instance.write_note("unset").await;
    let (status, answer) = instance
        .configure(json!({
            "otel_exporter_otlp_endpoint": host,
            "otel_exporter_otlp_headers": "authorization=Bearer%20one",
        }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    instance.write_note("queued").await;
    instance
        .configure(json!({ "telemetry_enabled": false }))
        .await;
    // Counted once the change is answered: a batch may leave on its own before it.
    let switched = mark();
    instance.write_note("switched-off").await;
    instance
        .configure(json!({ "telemetry_enabled": true }))
        .await;
    instance.write_note("first").await;
    // A span that starts before the change ends into the exporter the change built.
    let swapped = instance
        .configure_as(
            "swap",
            json!({ "otel_exporter_otlp_headers": "authorization=Bearer%20two" }),
        )
        .await;
    assert_eq!(swapped, StatusCode::OK);
    let changed = mark();
    instance.write_note("second").await;
    let (status, answer) = instance
        .configure(json!({ "trash_retention_days": 7 }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    guard.stop(Duration::from_secs(10));

    for prefix in ["/v1/traces", "/v1/logs"] {
        // The witness: records queued across a change of another setting are sent.
        assert_eq!(
            sent_with(&received, prefix, &["swap", "second"], "authorization"),
            [pair("second", "Bearer two"), pair("swap", "Bearer two")],
            "{prefix}"
        );
        assert_eq!(
            sent_with(
                &since(&received, switched),
                prefix,
                &["queued"],
                "authorization"
            ),
            [],
            "{prefix}"
        );
        assert_eq!(
            sent_with(
                &since(&received, changed),
                prefix,
                &["first"],
                "authorization"
            ),
            [],
            "{prefix}"
        );
        assert!(
            sent_with(&received, prefix, &["queued", "first"], "authorization")
                .iter()
                .all(|(_, carried)| carried == "Bearer one"),
            "{prefix}"
        );
        assert_eq!(
            sent_with(
                &received,
                prefix,
                &["unset", "switched-off"],
                "authorization"
            ),
            [],
            "{prefix}"
        );
    }
}

#[tokio::test]
async fn a_report_queued_before_reporting_is_switched_off_or_moved_is_dropped() {
    let (host, received) = receiver(false);
    let (other, moved) = receiver(false);
    let mut pairs = posthog(&host).to_vec();
    pairs.push(("MARFA_ALLOW_PRIVATE_ADDRESSES", "true".to_string()));
    let pairs: Vec<(String, String)> = pairs
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect();
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;

    instance.fail_note("queued").await;
    instance
        .configure(json!({ "telemetry_enabled": false }))
        .await;
    let switched = mark();
    instance
        .configure(json!({ "telemetry_enabled": true }))
        .await;
    instance.fail_note("before-the-move").await;
    let (status, answer) = instance.configure(json!({ "posthog_host": other })).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let changed = mark();
    instance.fail_note("kept").await;
    let (status, answer) = instance
        .configure(json!({ "trash_retention_days": 7 }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    guard.stop(REPORT_BUDGET);

    // The witness: a report queued across a change of another setting is sent.
    assert_eq!(ids(&exceptions(&moved), "request_id"), ["kept"]);
    let late = ids(&exceptions(&since(&received, switched)), "request_id");
    assert!(!late.contains(&"queued".to_string()), "{late:?}");
    let late = ids(&exceptions(&since(&received, changed)), "request_id");
    assert!(!late.contains(&"before-the-move".to_string()), "{late:?}");
}

#[tokio::test]
async fn an_endpoint_that_is_not_public_is_refused_and_sent_nothing_until_allowed() {
    let (host, received) = receiver(false);
    let (instance, guard) = Instance::start(&[("MARFA_OTEL_SAMPLE_RATIO", "1")]).await;
    let (status, answer) = instance
        .configure(json!({ "otel_exporter_otlp_endpoint": host }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
    assert!(!answer.to_string().contains(&host), "{answer}");
    // A name that leads to this machine is taken, and judged again as each export is sent.
    let by_name = host.replace("127.0.0.1", "localhost");
    let (status, answer) = instance
        .configure(json!({ "otel_exporter_otlp_endpoint": by_name }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    instance.write_note("private-refused").await;
    instance
        .configure(json!({ "allow_private_addresses": true }))
        .await;
    instance.write_note("private-allowed").await;
    guard.stop(Duration::from_secs(10));
    assert_eq!(
        sent_with(
            &received,
            "/v1/traces",
            &["private-refused", "private-allowed"],
            "host"
        )
        .into_iter()
        .map(|(id, _)| id)
        .collect::<Vec<_>>(),
        ["private-allowed"]
    );
}

#[tokio::test]
async fn a_signal_endpoint_needs_the_base_and_a_bad_value_is_refused_without_being_shown() {
    let (instance, guard) = Instance::start(&[("MARFA_ALLOW_PRIVATE_ADDRESSES", "true")]).await;
    let refused = |answer: &Value| answer.to_string();
    let (status, answer) = instance
        .configure(json!({ "otel_exporter_otlp_traces_endpoint": "http://127.0.0.1:9/in" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        refused(&answer).contains("otel_exporter_otlp_traces_endpoint"),
        "{answer}"
    );
    assert!(
        refused(&answer).contains("needs otel_exporter_otlp_endpoint"),
        "{answer}"
    );
    let (status, _) = instance
        .configure(json!({
            "otel_exporter_otlp_endpoint": "http://127.0.0.1:9",
            "otel_exporter_otlp_traces_endpoint": "http://127.0.0.1:9/in",
        }))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, answer) = instance
        .configure(json!({ "otel_exporter_otlp_endpoint": null }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        refused(&answer).contains("cannot be removed while"),
        "{answer}"
    );
    for (key, value) in [
        ("otel_exporter_otlp_endpoint", json!("ftp://secret-host/x")),
        ("otel_exporter_otlp_endpoint", json!("secret-host:4318")),
        (
            "otel_exporter_otlp_headers",
            json!("authorization=secret%zz"),
        ),
        (
            "otel_exporter_otlp_headers",
            json!("secret-without-a-value"),
        ),
        ("otel_resource_attributes", json!("team")),
        ("otel_sample_ratio", json!(1.0001)),
        ("otel_sample_ratio", json!(-0.5)),
        ("otel_sample_ratio", json!("0.5")),
    ] {
        let (status, answer) = instance.configure(json!({ key: value })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{key} {value}: {answer}");
        assert!(refused(&answer).contains(key), "{answer}");
        assert!(!refused(&answer).contains("secret"), "{answer}");
    }
    let (status, answer) = instance
        .configure(json!({ "otel_sample_ratio": 0.25, "otel_resource_attributes": "team=a%20b" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["otel_sample_ratio"], 0.25);
    assert_eq!(answer["otel_resource_attributes"], "team=a%20b");
    assert!(
        answer.get("otel_exporter_otlp_endpoint").is_none(),
        "{answer}"
    );
    guard.stop(Duration::from_secs(1));
}

/// The OpenTelemetry crates read some standard variables of their own; the server's settings
/// must win over every one. Runs its own runtime, since the variables are set before any thread
/// starts.
#[test]
fn a_platform_variable_never_overrides_the_stored_settings() {
    let (host, received) = receiver(false);
    let (planted_host, planted) = receiver(false);
    let planted_variables = [
        ("OTEL_EXPORTER_OTLP_ENDPOINT", planted_host.as_str()),
        ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", planted_host.as_str()),
        (
            "OTEL_EXPORTER_OTLP_HEADERS",
            "authorization=planted,content-type=application/x-planted",
        ),
        (
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
            "x-planted=traces,content-type=application/x-planted",
        ),
        (
            "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
            "x-planted=logs,content-type=application/x-planted",
        ),
        ("OTEL_EXPORTER_OTLP_TIMEOUT", "1"),
        ("OTEL_TRACES_SAMPLER", "always_off"),
        ("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "0"),
        ("OTEL_BSP_SCHEDULE_DELAY", "600000"),
        ("OTEL_BLRP_SCHEDULE_DELAY", "600000"),
        ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", planted_host.as_str()),
        (
            "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
            "x-planted=metrics,authorization=planted",
        ),
        ("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta"),
        ("OTEL_METRIC_EXPORT_INTERVAL", "50"),
        ("OTEL_METRIC_EXPORT_TIMEOUT", "1"),
        ("OTEL_METRICS_EXEMPLAR_FILTER", "always_on"),
        ("OTEL_SDK_DISABLED", "true"),
        ("OTEL_SERVICE_NAME", "planted"),
        ("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=planted"),
    ];
    for (name, value) in planted_variables {
        // SAFETY: no other thread runs yet; the receivers' threads read no environment.
        unsafe { std::env::set_var(name, value) };
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (instance, guard) = Instance::start(&[
            ("MARFA_OTEL_SAMPLE_RATIO", "1"),
            ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true"),
        ])
        .await;
        instance
            .configure(json!({
                "otel_exporter_otlp_endpoint": host,
                "otel_exporter_otlp_headers": "authorization=stored",
            }))
            .await;
        instance.write_note("planted-around").await;
        // The batch delays are the server's own: both arrive long before the planted ones.
        let arrived = |prefix: &str| {
            !sent_with(&received, prefix, &["planted-around"], "authorization").is_empty()
        };
        let waiting = Instant::now();
        while !(arrived("/v1/traces") && arrived("/v1/logs")) {
            assert!(
                waiting.elapsed() < Duration::from_secs(20),
                "nothing arrived"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // A planted interval of 50 ms would have sent a collection by now.
        assert!(posted(&received, "/v1/metrics").is_empty());
        guard.stop(Duration::from_secs(5));
    });

    for prefix in ["/v1/traces", "/v1/logs"] {
        assert_eq!(
            sent_with(&received, prefix, &["planted-around"], "authorization"),
            [pair("planted-around", "stored")],
            "{prefix}"
        );
        assert_eq!(
            sent_with(&received, prefix, &["planted-around"], "content-type"),
            [pair("planted-around", "application/json")],
            "{prefix}"
        );
        assert!(
            sent_with(&received, prefix, &["planted-around"], "x-planted")
                .iter()
                .all(|(_, value)| value.is_empty())
        );
    }
    // The witness: the stop sends what was collected, as the stored settings say.
    let sent = posted(&received, "/v1/metrics");
    assert!(!sent.is_empty());
    for head in heads(&received, "/v1/metrics") {
        let held = |name: &str| {
            head.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(held("authorization"), Some("stored"));
        assert_eq!(held("x-planted"), None);
    }
    for metric in metrics_of(&received) {
        let data = metric
            .get("histogram")
            .or_else(|| metric.get("sum"))
            .unwrap();
        assert_eq!(data["aggregationTemporality"], 2, "{metric}");
    }
    let everything: String = received
        .lock()
        .unwrap()
        .iter()
        .map(|(_, head, body, _)| format!("{head}{body}"))
        .collect();
    assert!(!everything.contains("planted\""), "{everything}");
    assert!(!everything.contains("deployment.environment"));
    assert!(everything.contains("marfa.request_id"));
    assert!(planted.lock().unwrap().is_empty());
}

/// The metrics called `name`.
fn named<'a>(all: &'a [Value], name: &str) -> Vec<&'a Value> {
    all.iter().filter(|metric| metric["name"] == name).collect()
}

/// The path of each request the receiver has taken.
fn paths(received: &Received) -> Vec<String> {
    received
        .lock()
        .unwrap()
        .iter()
        .map(|(path, ..)| path.clone())
        .collect()
}

/// Every metric of every `/v1/metrics` post.
fn metrics_of(received: &Received) -> Vec<Value> {
    posted(received, "/v1/metrics")
        .iter()
        .flat_map(|batch| batch["resourceMetrics"].as_array().unwrap().clone())
        .flat_map(|resource| resource["scopeMetrics"].as_array().unwrap().clone())
        .flat_map(|scope| scope["metrics"].as_array().unwrap().clone())
        .collect()
}

fn attribute(point: &Value, key: &str) -> Option<String> {
    point["attributes"]
        .as_array()?
        .iter()
        .find(|found| found["key"] == key)
        .map(|found| {
            let value = &found["value"];
            value["stringValue"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value["intValue"].to_string().trim_matches('"').to_string())
        })
}

fn count_of(point: &Value) -> u64 {
    match &point["count"] {
        Value::String(text) => text.parse().unwrap(),
        other => other.as_u64().unwrap(),
    }
}

async fn ask(router: &Router, path: &str, token: Option<&str>) -> StatusCode {
    let mut call = Request::builder().method(Method::GET).uri(path);
    if let Some(token) = token {
        call = call.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    router
        .clone()
        .oneshot(call.body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn requests_and_memory_reach_the_base_endpoint_as_two_metrics_when_the_server_stops() {
    let (host, received) = receiver(false);
    let pairs = settings(&host, &[]);
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    let key = instance.key.clone();
    let id = uuid::Uuid::now_v7();
    for _ in 0..3 {
        assert_eq!(
            ask(&instance.public, &format!("/items/{id}"), Some(&key)).await,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    assert_eq!(
        ask(&instance.public, &format!("/no/such/{id}"), None).await,
        StatusCode::NOT_FOUND
    );
    // A refused request to the stream is recorded; the stream that follows is not.
    assert_eq!(
        ask(&instance.public, "/events", None).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        ask(&instance.public, "/events", Some(&key)).await,
        StatusCode::OK
    );
    assert!(posted(&received, "/v1/metrics").is_empty());
    guard.stop(Duration::from_secs(5));

    let all = metrics_of(&received);
    let duration = named(&all, "http.server.request.duration");
    assert!(!duration.is_empty(), "{all:?}");
    let mut points = Vec::new();
    for metric in &duration {
        assert_eq!(metric["unit"], "s");
        assert_eq!(metric["histogram"]["aggregationTemporality"], 2);
        points.extend(metric["histogram"]["dataPoints"].as_array().unwrap());
    }
    let by = |route: Option<&str>, status: &str| -> u64 {
        points
            .iter()
            .filter(|point| {
                attribute(point, "http.route").as_deref() == route
                    && attribute(point, "http.response.status_code").as_deref() == Some(status)
            })
            .map(|point| count_of(point))
            .sum()
    };
    for point in &points {
        assert_eq!(
            point["explicitBounds"],
            json!([
                0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0
            ])
        );
        let keys: Vec<&str> = point["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|found| found["key"].as_str().unwrap())
            .collect();
        assert!(
            keys.iter().all(|key| [
                "http.request.method",
                "http.route",
                "http.response.status_code"
            ]
            .contains(key)),
            "{keys:?}"
        );
        assert!(!point.to_string().contains(&id.to_string()));
    }
    // The witness: the other requests are counted, so the stream's is left out, not lost.
    assert_eq!(by(Some("/items/{id}"), "404"), 3);
    assert_eq!(by(Some("/health"), "200"), 1);
    assert_eq!(by(None, "404"), 1);
    assert_eq!(by(Some("/events"), "401"), 1);
    assert_eq!(by(Some("/events"), "200"), 0);

    let memory = named(&all, "process.memory.usage");
    assert!(!memory.is_empty());
    for metric in memory {
        assert_eq!(metric["unit"], "By");
        assert_eq!(metric["sum"]["isMonotonic"], false);
        assert_eq!(metric["sum"]["aggregationTemporality"], 2);
        for point in metric["sum"]["dataPoints"].as_array().unwrap() {
            assert!(
                point["asInt"]
                    .to_string()
                    .trim_matches('"')
                    .parse::<i64>()
                    .unwrap()
                    > 1_000_000
            );
        }
    }

    for batch in posted(&received, "/v1/metrics") {
        let resource = &batch["resourceMetrics"][0]["resource"];
        assert_eq!(
            attribute(resource, "service.instance.id").as_deref(),
            Some(instance.app.instance_id.as_str())
        );
        assert_eq!(
            attribute(resource, "service.version").as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            attribute(resource, "service.name").as_deref(),
            Some("marfa-server")
        );
    }
}

#[tokio::test]
async fn no_metric_is_sent_while_the_switch_is_off_or_the_endpoint_is_unset() {
    let (host, received) = receiver(false);
    let off = settings(&host, &[("MARFA_TELEMETRY_ENABLED", "false".to_string())]);
    let (instance, guard) = Instance::start(&borrowed(&off)).await;
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    guard.stop(Duration::from_secs(5));
    assert_eq!(paths(&received), Vec::<String>::new(), "switch off");

    // A stored value removed falls back to the seed, so the endpoint is stored, not seeded.
    let (instance, guard) = Instance::start(&[("MARFA_ALLOW_PRIVATE_ADDRESSES", "true")]).await;
    instance
        .configure(json!({ "otel_exporter_otlp_endpoint": host }))
        .await;
    instance
        .configure(json!({ "otel_exporter_otlp_endpoint": null }))
        .await;
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    guard.stop(Duration::from_secs(5));
    assert_eq!(paths(&received), Vec::<String>::new(), "endpoint unset");

    // The witness: the same requests, with the endpoint and the switch as they were, are sent.
    let on = settings(&host, &[]);
    let (instance, guard) = Instance::start(&borrowed(&on)).await;
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    guard.stop(Duration::from_secs(5));
    assert!(!posted(&received, "/v1/metrics").is_empty());
}

#[tokio::test]
async fn the_metrics_endpoint_and_headers_are_used_beside_the_base_and_a_change_replaces_them() {
    let (host, received) = receiver(false);
    let (own_host, own) = receiver(false);
    let pairs = settings(
        &host,
        &[
            (
                "MARFA_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                format!("{own_host}/v1/metrics"),
            ),
            (
                "MARFA_OTEL_EXPORTER_OTLP_METRICS_HEADERS",
                "x-team=one".to_string(),
            ),
        ],
    );
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    instance
        .configure(json!({ "otel_exporter_otlp_metrics_headers": "x-team=two" }))
        .await;
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    guard.stop(Duration::from_secs(5));

    // The replaced exporter sends nothing more, so every post carries the new header.
    let heads = heads(&own, "/v1/metrics");
    assert!(!heads.is_empty());
    for head in heads {
        let team = head.iter().find(|(name, _)| name == "x-team");
        assert_eq!(team.map(|(_, value)| value.as_str()), Some("two"));
    }
    assert!(posted(&received, "/v1/metrics").is_empty());
}

/// Every name a shell or a platform could carry from an older release or a vendor's own
/// convention, all pointing at `host`.
fn planted(host: &str) -> Vec<(&'static str, String)> {
    vec![
        ("OTEL_EXPORTER_OTLP_ENDPOINT", host.to_string()),
        (
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            format!("{host}/v1/traces"),
        ),
        (
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            format!("{host}/v1/logs"),
        ),
        (
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            format!("{host}/v1/metrics"),
        ),
        ("OTEL_TRACES_SAMPLER", "always_on".to_string()),
        ("MARFA_OTEL_EXPORTER_OTLP_ENDPOINT", host.to_string()),
        ("MARFA_OTEL_SAMPLE_RATIO", "1".to_string()),
        ("MARFA_POSTHOG_HOST", host.to_string()),
        ("MARFA_POSTHOG_PROJECT_TOKEN", "phc_planted".to_string()),
        ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true".to_string()),
    ]
}

/// Ordinary requests, a fault and a stop, which exports once: everything a server does that
/// could reach a receiver.
async fn drive(instance: &Instance, guard: marfa_server::telemetry::Guard, name: &str) {
    assert_eq!(instance.write_note(name).await, StatusCode::CREATED);
    assert_eq!(ask(&instance.public, "/health", None).await, StatusCode::OK);
    instance.fail_note(&format!("{name}-fault")).await;
    guard.stop(REPORT_BUDGET);
}

/// A server nobody has configured sends nothing, whatever its environment names. Runs its own
/// runtime, since the variables are set before any thread starts.
#[test]
fn a_server_nobody_configured_sends_nothing_and_the_same_server_configured_sends_everything() {
    let (host, received) = receiver(false);
    let variables = planted(&host);
    for (name, value) in &variables {
        if name.starts_with("OTEL_") {
            // SAFETY: no other thread runs yet; the receiver's threads read no environment.
            unsafe { std::env::set_var(name, value) };
        }
    }
    let seeded: Vec<(&str, &str)> = variables
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (instance, guard) = Instance::start_as(false, &seeded).await;
        drive(&instance, guard, "unconfigured").await;
        assert_eq!(paths(&received), Vec::<String>::new(), "nothing was set");

        // The witness: the same server, run the same way, sends once its settings say where.
        let (instance, guard) = Instance::start_as(false, &seeded).await;
        let (status, answer) = instance
            .configure(json!({
                "allow_private_addresses": true,
                "otel_exporter_otlp_endpoint": host,
                "otel_sample_ratio": 1.0,
                "posthog_host": host,
                "posthog_project_token": "phc_test",
            }))
            .await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        drive(&instance, guard, "configured").await;
    });
    for prefix in ["/v1/traces", "/v1/logs", "/v1/metrics", EVENTS] {
        assert!(
            !posted(&received, prefix).is_empty(),
            "{prefix} in {:?}",
            paths(&received)
        );
    }
    let sent = received.lock().unwrap();
    let before: Vec<&String> = sent
        .iter()
        .map(|(_, _, body, _)| body)
        .filter(|body| body.contains("unconfigured"))
        .collect();
    assert!(before.is_empty(), "the first server sent {before:?}");
}
