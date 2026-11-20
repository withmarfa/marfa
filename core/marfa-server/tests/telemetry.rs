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

/// The path, the head and the body of each request.
type Received = Arc<Mutex<Vec<(String, String, String)>>>;

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
            let sink = sink.clone();
            thread::spawn(move || answer(stream, &sink));
        }
    });
    (address, received)
}

fn answer(mut stream: TcpStream, sink: &Received) {
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
    sink.lock().unwrap().push((path, head, body));
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\
          Connection: close\r\n\r\n{}",
    );
}

const EVENTS: &str = "/i/v1/analytics/events";

fn posted(received: &Received, prefix: &str) -> Vec<Value> {
    received
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _, _)| path.starts_with(prefix))
        .map(|(_, _, body)| serde_json::from_str(body).unwrap())
        .collect()
}

/// Each request's headers, keyed by their lowercase names.
fn heads(received: &Received, prefix: &str) -> Vec<Vec<(String, String)>> {
    received
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _, _)| path.starts_with(prefix))
        .map(|(_, head, _)| {
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
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
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
    guard.stop(Duration::from_secs(5));

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
        guard.stop(Duration::from_secs(5));
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
    guard.stop(Duration::from_secs(5));

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
    for (path, head, body) in received.lock().unwrap().iter() {
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

/// How many requests the receiver has taken so far.
fn mark(received: &Received) -> usize {
    received.lock().unwrap().len()
}

/// What the receiver took from `from` on.
fn since(received: &Received, from: usize) -> Received {
    Arc::new(Mutex::new(received.lock().unwrap()[from..].to_vec()))
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
    let switched = mark(&received);
    instance
        .configure(json!({ "telemetry_enabled": false }))
        .await;
    instance.write_note("switched-off").await;
    instance
        .configure(json!({ "telemetry_enabled": true }))
        .await;
    instance.write_note("first").await;
    let changed = mark(&received);
    // A span that starts before the change ends into the exporter the change built.
    let swapped = instance
        .configure_as(
            "swap",
            json!({ "otel_exporter_otlp_headers": "authorization=Bearer%20two" }),
        )
        .await;
    assert_eq!(swapped, StatusCode::OK);
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
    let switched = mark(&received);
    instance
        .configure(json!({ "telemetry_enabled": false }))
        .await;
    instance
        .configure(json!({ "telemetry_enabled": true }))
        .await;
    instance.fail_note("before-the-move").await;
    let changed = mark(&received);
    let (status, answer) = instance.configure(json!({ "posthog_host": other })).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    instance.fail_note("kept").await;
    let (status, answer) = instance
        .configure(json!({ "trash_retention_days": 7 }))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    guard.stop(Duration::from_secs(5));

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
        ("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-planted=traces"),
        ("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "x-planted=logs"),
        ("OTEL_EXPORTER_OTLP_TIMEOUT", "1"),
        ("OTEL_TRACES_SAMPLER", "always_off"),
        ("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "0"),
        ("OTEL_BSP_SCHEDULE_DELAY", "600000"),
        ("OTEL_BLRP_SCHEDULE_DELAY", "600000"),
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
    let everything: String = received
        .lock()
        .unwrap()
        .iter()
        .map(|(_, head, body)| format!("{head}{body}"))
        .collect();
    assert!(!everything.contains("planted\""), "{everything}");
    assert!(!everything.contains("deployment.environment"));
    assert!(everything.contains("marfa.request_id"));
    assert!(planted.lock().unwrap().is_empty());
}
