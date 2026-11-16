use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::control;
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

/// A stand-in for GitHub: answers every request with the reply it holds and counts them.
struct Feed {
    port: u16,
    hits: Arc<AtomicUsize>,
    reply: Arc<Mutex<(u16, String)>>,
}

impl Feed {
    fn start(status: u16, body: String) -> Feed {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let reply = Arc::new(Mutex::new((status, body)));
        let (counted, held) = (hits.clone(), reply.clone());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut head = [0u8; 2048];
                let _ = stream.read(&mut head);
                let (status, body) = held.lock().unwrap().clone();
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        Feed { port, hits, reply }
    }

    fn address(&self) -> String {
        format!("http://127.0.0.1:{}/latest", self.port)
    }

    fn says(&self, status: u16, body: String) {
        *self.reply.lock().unwrap() = (status, body);
    }

    fn asked(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn release(version: &str) -> String {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => "darwin-arm64",
        (_, "aarch64") => "linux-aarch64",
        _ => "linux-x86_64",
    };
    json!({
        "tag_name": format!("v{version}"),
        "draft": false,
        "prerelease": false,
        "published_at": "2026-11-16T09:30:00Z",
        "assets": [
            { "name": format!("marfa-{version}-{platform}.tar.gz"), "browser_download_url": "http://127.0.0.1:9/a", "size": 10 },
            { "name": format!("marfa-{version}-checksums.txt"), "browser_download_url": "http://127.0.0.1:9/s", "size": 10 },
        ],
    })
    .to_string()
}

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            control: control(app.clone()),
            app,
            _dir: dir,
        }
    }

    async fn local(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.control.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn point_at(&self, feed: &Feed) {
        self.app
            .faults
            .set("release-feed", Some(&feed.address()))
            .unwrap();
    }

    async fn check(&self) -> Value {
        let (status, run) = self
            .local(Method::POST, "/housekeeping/release-check/run", json!({}))
            .await;
        assert_eq!(status, StatusCode::OK, "{run}");
        assert_eq!(run["outcome"], "succeeded", "a failed check is no failed run: {run}");
        run
    }

    async fn update(&self) -> Value {
        let (status, update) = self.local(Method::GET, "/update", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{update}");
        update
    }
}

#[tokio::test]
async fn a_found_release_is_read_as_available_with_the_step_a_server_that_cannot_swap_names() {
    let feed = Feed::start(200, release("0.0.75"));
    let instance = Instance::start().await;
    instance.point_at(&feed);
    instance.check().await;
    assert_eq!(feed.asked(), 1, "the witness: the check asked");

    let update = instance.update().await;
    assert_eq!(update["version"], "0.0.0");
    assert_eq!(update["latest"]["version"], "0.0.75");
    assert_eq!(update["latest"]["published_at"], "2026-11-16T09:30:00.000Z");
    assert_eq!(update["available"], true);
    assert_eq!(update["method"], "manual");
    assert!(update["step"].as_str().unwrap().contains("0.0.75"), "{update}");
    assert!(update["checked_at"].is_string());
    assert_eq!(update["check_error"], Value::Null);
    assert_eq!(update["progress"]["state"], "idle");
}

#[tokio::test]
async fn a_server_that_cannot_swap_refuses_an_update_with_the_step_and_changes_nothing() {
    let feed = Feed::start(200, release("0.0.75"));
    let instance = Instance::start().await;
    let (status, refused) = instance.local(Method::POST, "/update", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "update_not_ready");

    instance.point_at(&feed);
    instance.check().await;
    let (status, refused) = instance.local(Method::POST, "/update", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "update_unavailable");
    assert!(
        refused["error"]["details"]["step"]
            .as_str()
            .unwrap()
            .contains("0.0.75")
    );
    assert_eq!(instance.update().await["progress"]["state"], "idle");
    assert_eq!(instance.update().await["last"], Value::Null);
}

#[tokio::test]
async fn a_release_that_is_not_newer_is_not_available_and_not_offered() {
    let feed = Feed::start(200, release("0.0.0"));
    let instance = Instance::start().await;
    instance.point_at(&feed);
    instance.check().await;
    let update = instance.update().await;
    assert_eq!(update["latest"]["version"], "0.0.0");
    assert_eq!(update["available"], false);
    assert_eq!(update["step"], Value::Null);
    let (status, refused) = instance.local(Method::POST, "/update", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "update_not_ready");
}

#[tokio::test]
async fn a_failed_check_keeps_the_last_release_found_and_says_why() {
    let feed = Feed::start(200, release("0.0.75"));
    let instance = Instance::start().await;
    instance.point_at(&feed);
    instance.check().await;
    let found_at = instance.update().await["checked_at"].clone();

    let prerelease = json!({ "prerelease": true });
    let mut draft: Value = serde_json::from_str(&release("0.0.99")).unwrap();
    draft.as_object_mut().unwrap().extend(prerelease.as_object().unwrap().clone());
    for (status, body) in [
        (500, "boom".to_string()),
        (403, "rate limited".to_string()),
        (200, "<html>not json</html>".to_string()),
        (200, draft.to_string()),
        (200, "[]".to_string()),
    ] {
        feed.says(status, body.clone());
        instance.check().await;
        let update = instance.update().await;
        assert_eq!(update["latest"]["version"], "0.0.75", "{status} {body}");
        assert_eq!(update["checked_at"], found_at);
        assert!(update["check_error"]["message"].is_string(), "{status} {body}: {update}");
        assert_eq!(update["available"], true);
    }

    feed.says(200, release("0.0.80"));
    instance.check().await;
    let update = instance.update().await;
    assert_eq!(update["latest"]["version"], "0.0.80");
    assert_eq!(update["check_error"], Value::Null);
}

#[tokio::test]
async fn an_absent_github_leaves_the_last_release_and_never_fails_a_request() {
    let feed = Feed::start(200, release("0.0.75"));
    let instance = Instance::start().await;
    instance.point_at(&feed);
    instance.check().await;
    instance
        .app
        .faults
        .set("release-feed", Some("http://127.0.0.1:9/latest"))
        .unwrap();
    instance.check().await;
    let update = instance.update().await;
    assert_eq!(update["latest"]["version"], "0.0.75");
    assert!(update["check_error"]["message"].is_string());
}

#[tokio::test]
async fn a_server_with_test_hooks_asks_nobody_until_a_fault_names_an_address() {
    let instance = Instance::start().await;
    instance.check().await;
    let update = instance.update().await;
    assert_eq!(update["latest"], Value::Null);
    assert_eq!(update["checked_at"], Value::Null);
    assert_eq!(update["available"], false);

    let feed = Feed::start(200, release("0.0.75"));
    instance.point_at(&feed);
    instance.check().await;
    assert_eq!(feed.asked(), 1, "the witness: the same job asks once an address is named");
}

#[tokio::test]
async fn turning_the_check_off_makes_no_request_and_reports_no_release() {
    let feed = Feed::start(200, release("0.0.75"));
    let instance = Instance::start().await;
    instance.point_at(&feed);
    instance.check().await;
    assert_eq!(feed.asked(), 1, "the witness: the check asked while on");

    let (status, config) = instance
        .local(Method::PATCH, "/config", json!({ "update_check_enabled": false }))
        .await;
    assert_eq!(status, StatusCode::OK, "{config}");
    let (status, _) = instance
        .local(Method::POST, "/housekeeping/release-check/run", json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the job is not run while off");
    let (_, listing) = instance.local(Method::GET, "/housekeeping", Value::Null).await;
    assert!(
        listing["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|job| job["name"] != "release-check")
    );
    let update = instance.update().await;
    assert_eq!(update["check_enabled"], false);
    assert_eq!(update["latest"], Value::Null);
    assert_eq!(update["available"], false);
    let (status, refused) = instance.local(Method::POST, "/update", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(feed.asked(), 1, "no request was made while the check was off");

    instance
        .local(Method::PATCH, "/config", json!({ "update_check_enabled": true }))
        .await;
    instance.check().await;
    assert_eq!(feed.asked(), 2);
}
