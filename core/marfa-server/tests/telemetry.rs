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
use marfa_server::telemetry::Config;
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
        let mut problems = Vec::new();
        let telemetry = Config::read(&environment, &mut problems);
        assert!(problems.is_empty(), "{problems:?}");
        let app = App::start(Settings::read(environment).unwrap())
            .await
            .unwrap();
        let guard = app
            .telemetry
            .start(&telemetry, &app.instance_id, &app.settings.live());
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

    /// A write through the private local door, as `marfa config set` makes one.
    async fn configure(&self, body: Value) -> (StatusCode, Value) {
        send(
            &control(self.app.clone()),
            request(Method::PATCH, "/config", None, body),
        )
        .await
    }
}

/// An OTLP collector at `host`, which a fault reaches with no PostHog setting.
fn settings(host: &str, other: &[(&'static str, String)]) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("OTEL_EXPORTER_OTLP_ENDPOINT".to_string(), host.to_string()),
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

    let stopping = Instant::now();
    guard.stop(Duration::from_secs(1));
    assert!(
        stopping.elapsed() < Duration::from_millis(2500),
        "{:?}",
        stopping.elapsed()
    );
}
