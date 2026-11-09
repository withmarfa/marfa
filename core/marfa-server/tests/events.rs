use std::io;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::serve::Listener;
use marfa_server::app::App;
use marfa_server::http::listening::{PUBLIC_HEADER_READ_TIMEOUT, Peer, Source};
use marfa_server::http::{control, public, serve};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use tower::ServiceExt;

/// Small, so a reader that stops reading leaves hyper blocked on its writes at once.
const PIPE_BYTES: usize = 8 * 1024;

struct Memory(mpsc::UnboundedReceiver<DuplexStream>);

impl Listener for Memory {
    type Io = DuplexStream;
    type Addr = Peer;

    async fn accept(&mut self) -> (DuplexStream, Peer) {
        match self.0.recv().await {
            Some(connection) => (connection, Peer(None)),
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Peer> {
        Ok(Peer(None))
    }
}

impl Source for Memory {
    fn peer(address: &Peer) -> Peer {
        *address
    }
}

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    connect: mpsc::UnboundedSender<DuplexStream>,
    stop: Option<oneshot::Sender<()>>,
    server: JoinHandle<io::Result<()>>,
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

fn request(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
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
        let public = public(app.clone());
        let (connect, incoming) = mpsc::unbounded_channel();
        let (stop, stopping) = oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            Memory(incoming),
            public.clone(),
            async move {
                let _ = stopping.await;
            },
            PUBLIC_HEADER_READ_TIMEOUT,
        ));
        Instance {
            _dir: dir,
            control: control(app.clone()),
            public,
            app,
            connect,
            stop: Some(stop),
            server,
        }
    }

    async fn key(&self) -> (String, String) {
        let body = json!({
            "label": "stream",
            "source": "stream",
            "permissions": [],
            "type_permissions": { "core.note": "write" },
        });
        let (status, minted) = send(
            &self.control,
            request(Method::POST, "/keys", None, Some(body)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        (
            minted["id"].as_str().unwrap().to_string(),
            minted["key"].as_str().unwrap().to_string(),
        )
    }

    async fn note(&self, token: &str, n: usize, bytes: usize) {
        let body = json!({
            "type": "core.note",
            "properties": { "body": format!("{n} {}", "x".repeat(bytes)) },
        });
        let (status, created) = send(
            &self.public,
            request(Method::POST, "/items", Some(token), Some(body)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
    }

    async fn revoke(&self, id: &str) {
        let path = format!("/keys/{id}");
        let (status, answer) =
            send(&self.control, request(Method::DELETE, &path, None, None)).await;
        assert!(status.is_success(), "{status} {answer}");
    }

    /// Opens `GET /events` on a connection of its own, and reads up to the first frame named `until`.
    async fn stream(
        &self,
        token: &str,
        cursor: Option<&str>,
        until: &str,
    ) -> (DuplexStream, String) {
        let (mut near, far) = duplex(PIPE_BYTES);
        self.connect.send(far).unwrap();
        let resume = cursor.map_or(String::new(), |cursor| {
            format!("Last-Event-ID: {cursor}\r\n")
        });
        let asked = format!(
            "GET /events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n{resume}\r\n"
        );
        near.write_all(asked.as_bytes()).await.unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0; 1024];
        while !String::from_utf8_lossy(&seen).contains(until) {
            let read = near.read(&mut buffer).await.unwrap();
            assert!(read > 0, "the stream closed before {until}");
            seen.extend_from_slice(&buffer[..read]);
        }
        (near, String::from_utf8_lossy(&seen).into_owned())
    }
}

/// What is left on the connection, and whether the connection closed before `wait` ran out.
async fn rest(near: &mut DuplexStream, wait: Duration) -> (String, bool) {
    let mut seen = Vec::new();
    let closed = timeout(wait, near.read_to_end(&mut seen)).await.is_ok();
    (String::from_utf8_lossy(&seen).into_owned(), closed)
}

/// Frames of one piece each, all taken by hyper with nothing queued behind them. Ten leave room
/// in hyper's write queue (about 400 KiB) for a closing frame; eleven fill it.
const UNSENT_NOTES: [usize; 2] = [10, 11];

async fn unsent(instance: &Instance, token: &str, notes: usize) {
    for n in 0..notes {
        instance.note(token, n, 40 * 1024).await;
    }
    sleep(Duration::from_millis(300)).await;
}

fn events(text: &str) -> usize {
    text.matches("\nevent: item.created\n").count()
}

#[tokio::test]
async fn a_key_revoked_while_a_page_is_handed_over_ends_the_stream_before_the_page_does() {
    let instance = Instance::start().await;
    let (id, token) = instance.key().await;
    const NOTES: usize = 30;
    for n in 0..NOTES {
        instance.note(&token, n, 30 * 1024).await;
    }
    let (mut near, before) = instance.stream(&token, Some("0"), "id: ").await;
    sleep(Duration::from_millis(300)).await;
    instance.revoke(&id).await;
    sleep(Duration::from_millis(300)).await;

    let (after, _) = rest(&mut near, Duration::from_secs(10)).await;
    let text = before + &after;
    assert!(
        text.contains("\"reason\":\"credential_ended\""),
        "the stream did not end with credential_ended"
    );
    assert!(
        events(&text) < NOTES,
        "the whole page was handed over after the key was revoked"
    );
    let ended = text.find("event: stream_incomplete").unwrap();
    assert!(!text[ended..].contains("id: "));
}

#[tokio::test]
async fn a_closing_frame_behind_unsent_bytes_does_not_keep_the_connection_open() {
    for notes in UNSENT_NOTES {
        let instance = Instance::start().await;
        let (id, token) = instance.key().await;
        let (mut near, _) = instance.stream(&token, None, "event: stream_live").await;
        unsent(&instance, &token, notes).await;
        instance.revoke(&id).await;
        sleep(Duration::from_secs(4)).await;

        let (text, closed) = rest(&mut near, Duration::from_secs(2)).await;
        assert!(closed, "{notes} notes: the connection stayed open");
        assert!(
            !text.ends_with("0\r\n\r\n"),
            "{notes} notes: the response was finished"
        );
        assert_eq!(instance.app.viewers.open(), 0);
    }
}

#[tokio::test]
async fn a_stop_behind_unsent_bytes_does_not_hold_the_server() {
    for notes in UNSENT_NOTES {
        let mut instance = Instance::start().await;
        let (_, token) = instance.key().await;
        let (_near, _) = instance.stream(&token, None, "event: stream_live").await;
        unsent(&instance, &token, notes).await;
        instance.app.begin_stop();
        instance.stop.take().unwrap().send(()).unwrap();
        timeout(Duration::from_secs(5), &mut instance.server)
            .await
            .unwrap_or_else(|_| panic!("{notes} notes: the stop waited on the reader"))
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn a_key_revoked_before_the_first_frame_ends_the_stream_before_any_frame_to_a_reader_that_keeps_reading()
 {
    let witness = Instance::start().await;
    let (_, token) = witness.key().await;
    let (_near, seen) = witness.stream(&token, None, "event: stream_live").await;
    assert!(seen.contains("event: stream_cursor"));

    let instance = Instance::start().await;
    let (id, token) = instance.key().await;
    instance.app.faults.set("hold:stream-head", None).unwrap();
    let (mut near, far) = duplex(PIPE_BYTES);
    instance.connect.send(far).unwrap();
    let asked = format!("GET /events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n\r\n");
    near.write_all(asked.as_bytes()).await.unwrap();
    timeout(Duration::from_secs(10), async {
        while !instance.app.faults.list().iter().any(|f| f.waiting > 0) {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the stream never reached its hold");
    instance.revoke(&id).await;
    instance.app.faults.clear(Some("hold:stream-head"));

    let (text, closed) = rest(&mut near, Duration::from_secs(10)).await;
    assert!(closed, "the connection stayed open");
    assert!(
        text.contains("\"reason\":\"credential_ended\""),
        "the stream did not end with credential_ended: {text}"
    );
    assert!(
        !text.contains("event: stream_cursor") && !text.contains("event: stream_live"),
        "a frame followed the revocation: {text}"
    );
}
