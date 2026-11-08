//! An S3-compatible object store in the test process, path style, that keeps objects in
//! memory and can be told to answer every request `404` or to send a body slowly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use futures_util::stream;
use tokio::net::TcpListener;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Every request answers `404`, as a deleted bucket or a misrouted proxy does.
    AllNotFound,
    /// A body is sent in this many pieces, one a second.
    Trickle(u64),
}

#[derive(Default)]
struct Held {
    objects: HashMap<String, Vec<u8>>,
    mode: Option<Mode>,
    refused: Vec<String>,
    requests: Vec<(Method, String)>,
}

#[derive(Clone)]
pub struct FakeS3 {
    pub endpoint: String,
    held: Arc<Mutex<Held>>,
}

const LAST_MODIFIED: &str = "Mon, 02 Nov 2026 10:00:00 GMT";

fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "application/xml")
        .body(Body::from(
            "<Error><Code>NoSuchKey</Code><Message>not found</Message></Error>",
        ))
        .unwrap()
}

fn range_of(headers: &HeaderMap, size: usize) -> Option<(usize, usize)> {
    let text = headers.get(header::RANGE)?.to_str().ok()?;
    let (first, last) = text.strip_prefix("bytes=")?.split_once('-')?;
    let first: usize = first.parse().ok()?;
    let last: usize = last.parse::<usize>().ok()?.min(size.saturating_sub(1));
    Some((first, last))
}

async fn answer(State(held): State<Arc<Mutex<Held>>>, request: Request) -> Response {
    let key = request.uri().path().to_string();
    let (method, headers) = (request.method().clone(), request.headers().clone());
    let (mode, refused) = {
        let mut held = held.lock().unwrap();
        held.requests.push((method.clone(), key.clone()));
        (
            held.mode.unwrap_or(Mode::Normal),
            held.refused.contains(&key),
        )
    };
    if mode == Mode::AllNotFound {
        return not_found();
    }
    if refused && method == Method::PUT {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("<Error><Code>AccessDenied</Code></Error>"))
            .unwrap();
    }
    match method {
        Method::PUT => {
            let body = axum::body::to_bytes(request.into_body(), usize::MAX)
                .await
                .unwrap();
            held.lock().unwrap().objects.insert(key, body.to_vec());
            Response::builder()
                .header(header::ETAG, "\"e\"")
                .body(Body::empty())
                .unwrap()
        }
        Method::DELETE => {
            held.lock().unwrap().objects.remove(&key);
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap()
        }
        Method::GET | Method::HEAD => {
            let Some(object) = held.lock().unwrap().objects.get(&key).cloned() else {
                return not_found();
            };
            let size = object.len();
            let builder = Response::builder()
                .header(header::ETAG, "\"e\"")
                .header(header::LAST_MODIFIED, LAST_MODIFIED);
            if method == Method::HEAD {
                return builder
                    .header(header::CONTENT_LENGTH, size)
                    .body(Body::empty())
                    .unwrap();
            }
            let (status, first, last) = match range_of(&headers, size) {
                Some((first, last)) => (StatusCode::PARTIAL_CONTENT, first, last),
                None => (StatusCode::OK, 0, size.saturating_sub(1)),
            };
            let bytes = Bytes::from(object[first..=last].to_vec());
            let mut builder = builder
                .status(status)
                .header(header::CONTENT_LENGTH, bytes.len());
            if status == StatusCode::PARTIAL_CONTENT {
                builder = builder.header(
                    header::CONTENT_RANGE,
                    format!("bytes {first}-{last}/{size}"),
                );
            }
            let body = match mode {
                Mode::Trickle(pieces) => {
                    let piece = bytes.len().div_ceil(pieces as usize).max(1);
                    let chunks: Vec<Bytes> =
                        bytes.chunks(piece).map(Bytes::copy_from_slice).collect();
                    Body::from_stream(stream::unfold(
                        chunks.into_iter(),
                        |mut chunks| async move {
                            let chunk = chunks.next()?;
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            Some((Ok::<_, std::io::Error>(chunk), chunks))
                        },
                    ))
                }
                _ => Body::from(bytes),
            };
            builder.body(body).unwrap()
        }
        _ => Response::builder()
            .status(StatusCode::NOT_IMPLEMENTED)
            .body(Body::empty())
            .unwrap(),
    }
}

impl FakeS3 {
    pub async fn start() -> FakeS3 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let held = Arc::new(Mutex::new(Held::default()));
        let router = Router::new().fallback(answer).with_state(held.clone());
        tokio::spawn(async move { axum::serve(listener, router).await });
        FakeS3 { endpoint, held }
    }

    /// The settings that name this store, in `bucket` under `prefix`.
    pub fn settings(&self, bucket: &str, prefix: &str) -> Vec<(String, String)> {
        [
            ("S3_BUCKET", bucket),
            ("S3_PREFIX", prefix),
            ("S3_ENDPOINT", self.endpoint.as_str()),
            ("S3_ACCESS_KEY_ID", "test-key"),
            ("S3_SECRET_ACCESS_KEY", "test-secret"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
    }

    pub fn set_mode(&self, mode: Mode) {
        self.held.lock().unwrap().mode = Some(mode);
    }

    pub fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.held.lock().unwrap().objects.get(key).cloned()
    }

    pub fn put_object(&self, key: &str, bytes: &[u8]) {
        let mut held = self.held.lock().unwrap();
        held.objects.insert(key.to_string(), bytes.to_vec());
    }

    /// Refuses every write of the object at `key` with `403`.
    pub fn refuse_writes(&self, key: &str) {
        self.held.lock().unwrap().refused.push(key.to_string());
    }

    /// How many requests of `method` reached the object at `key`.
    pub fn requests(&self, method: &Method, key: &str) -> usize {
        let held = self.held.lock().unwrap();
        held.requests
            .iter()
            .filter(|(sent, at)| sent == method && at == key)
            .count()
    }

    pub fn remove_object(&self, key: &str) {
        self.held.lock().unwrap().objects.remove(key);
    }
}
