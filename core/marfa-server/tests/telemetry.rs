//! What the server tells a receiver about an unhandled fault, and that a slow or silent
//! receiver changes nothing for a request.

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

type Received = Arc<Mutex<Vec<(String, String)>>>;

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
    sink.lock().unwrap().push((path, body));
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\
          Connection: close\r\n\r\n{}",
    );
}

fn posted(received: &Received, prefix: &str) -> Vec<Value> {
    received
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _)| path.starts_with(prefix))
        .map(|(_, body)| serde_json::from_str(body).unwrap())
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
        let guard = app.telemetry.start(&telemetry, &app.instance_id);
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
}

fn settings(host: &str, other: &[(&'static str, String)]) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("MARFA_POSTHOG_HOST".to_string(), host.to_string()),
        ("MARFA_POSTHOG_PROJECT_TOKEN".to_string(), "phc_test".into()),
        (
            "MARFA_ERROR_WEBHOOK_URL".to_string(),
            format!("{host}/errors"),
        ),
        ("OTEL_EXPORTER_OTLP_ENDPOINT".to_string(), host.to_string()),
        ("MARFA_OTEL_SAMPLE_RATIO".to_string(), "0".to_string()),
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

#[tokio::test]
async fn one_fault_is_one_exception_with_its_message_and_frames_and_one_notice() {
    let (host, received) = receiver(false);
    let pairs = settings(&host, &[]);
    let (instance, guard) = Instance::start(&borrowed(&pairs)).await;
    assert_eq!(instance.write_note("landed").await, StatusCode::CREATED);
    instance.break_writes();
    assert_eq!(
        instance.write_note("the-fault").await,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    guard.stop(Duration::from_secs(5));

    let batches = posted(&received, "/batch");
    let events: Vec<&Value> = batches
        .iter()
        .flat_map(|batch| batch["batch"].as_array().unwrap())
        .collect();
    assert_eq!(events.len(), 1, "{events:?}");
    let event = events[0];
    assert_eq!(event["event"], "$exception");
    assert_eq!(event["properties"]["request_id"], "the-fault");
    assert_eq!(event["properties"]["error_code"], "internal_error");
    assert_eq!(
        event["properties"]["service.instance.id"],
        instance.app.instance_id
    );
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
    for forbidden in ["event_log", "no such table", "INSERT"] {
        assert!(!reported.contains(forbidden), "{forbidden} in {reported}");
    }

    let notices = posted(&received, "/errors");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0]["request_id"], "the-fault");
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
    let pairs = settings(&host, &[]);
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

    let ids: Vec<String> = posted(&received, "/errors")
        .iter()
        .map(|notice| notice["request_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, ["while-on"]);
}

#[tokio::test]
async fn a_receiver_that_never_answers_changes_nothing_for_a_request() {
    let (host, _) = receiver(true);
    let pairs = settings(&host, &[]);
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
