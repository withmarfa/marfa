//! A folder's pattern lists are judged before the write queues, so a slow or refused list holds up no other write.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    control: Router,
    public: Router,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        Instance {
            _dir: dir,
            control: control(app.clone()),
            public: public(app.clone()),
            app,
        }
    }

    async fn send(doors: &Router, builder: axum::http::request::Builder, body: Value) -> Reply {
        let request = builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = doors.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    async fn key(&self) -> String {
        let body = json!({
            "label": "folders",
            "source": "folders",
            "type_permissions": { "*": "write", "system.folder": "write" },
        });
        let request = Request::builder().method(Method::POST).uri("/keys");
        let minted = Instance::send(&self.control, request, body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn post(&self, key: &str, path: &str, body: Value) -> Reply {
        let request = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {key}"));
        Instance::send(&self.public, request, body).await
    }
}

/// Valid lists at the bound: the most text, in classes that cost the most to compile.
fn heaviest() -> Vec<String> {
    let line = |n: usize| {
        let mut line = String::new();
        while line.chars().count() < 200 {
            line.push_str(&format!("[a-zA-Z0-9À-ÿ]{n:04}"));
        }
        line.chars().take(200).collect()
    };
    (0..30).map(line).collect()
}

fn folder(title: &str, include: &[String]) -> Value {
    json!({ "title": title, "include": include })
}

#[tokio::test]
async fn a_refused_list_is_answered_while_the_writer_is_busy() {
    let instance = Instance::start().await;
    let key = instance.key().await;
    let (release, held) = std::sync::mpsc::channel::<()>();
    let app = instance.app.clone();
    let busy = tokio::spawn(async move {
        app.db
            .write(Write::own(), move |_| {
                held.recv().ok();
                Ok(())
            })
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let too_big = vec!["?".repeat(500); 12];
    for (include, why) in [
        (vec!["{a,b".to_string()], "a line that is no pattern"),
        (too_big, "a list that compiles past the bound"),
        (vec!["a".repeat(1_000); 7], "a list with too much text"),
    ] {
        let answered = tokio::time::timeout(
            Duration::from_secs(5),
            instance.post(&key, "/folders", folder("refused", &include)),
        )
        .await
        .unwrap_or_else(|_| panic!("{why} waited for the writer"));
        assert_eq!(
            answered.status,
            StatusCode::BAD_REQUEST,
            "{why}: {}",
            answered.text
        );
        assert_eq!(
            answered.body["error"]["details"]["errors"][0]["path"], "include",
            "{why}: {}",
            answered.text
        );
    }

    let valid = instance.post(&key, "/folders", folder("valid", &[]));
    let waits = tokio::time::timeout(Duration::from_millis(300), valid).await;
    assert!(waits.is_err(), "a valid write does queue for the writer");
    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_folder_write_with_lists_at_the_bound_does_not_hold_up_another_write() {
    let instance = Instance::start().await;
    let key = instance.key().await;
    let lists = heaviest();
    let compile = (0..3)
        .map(|_| {
            let started = Instant::now();
            marfa_rules::folder::check_patterns(&lists, &[]).unwrap();
            started.elapsed()
        })
        .min()
        .unwrap();

    let writes: Vec<_> = (0..4)
        .map(|n| {
            let (door, key, lists) = (instance.app.clone(), key.clone(), lists.clone());
            let router = public(door);
            tokio::spawn(async move {
                let request = Request::builder()
                    .method(Method::POST)
                    .uri("/folders")
                    .header(header::AUTHORIZATION, format!("Bearer {key}"));
                Instance::send(&router, request, folder(&format!("heavy {n}"), &lists)).await
            })
        })
        .collect();

    let mut longest = Duration::ZERO;
    let mut last = Instant::now();
    while writes.iter().any(|write| !write.is_finished()) {
        instance
            .app
            .db
            .write(Write::own(), |_| Ok(()))
            .await
            .unwrap();
        longest = longest.max(last.elapsed());
        last = Instant::now();
        tokio::time::sleep(Duration::from_millis(1)).await;
        last = last.max(Instant::now());
    }
    for write in writes {
        let done = write.await.unwrap();
        assert_eq!(done.status, StatusCode::CREATED, "{}", done.text);
    }
    assert!(
        longest < compile,
        "an unrelated write waited {longest:?}, and compiling the lists takes {compile:?}"
    );
}
