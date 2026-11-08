//! An S3-compatible object store in the test process, path style, that keeps objects in
//! memory and can be told to answer every request `404`, to send a body slowly, to carry out
//! a deletion late, or to reach another bucket.

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
use tokio::sync::{Notify, oneshot};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Every request answers `404`, as a deleted bucket or a misrouted proxy does.
    AllNotFound,
    /// A body is sent in this many pieces, one a second.
    Trickle(u64),
    /// The next marker read answers as normal, and every request after it `404`.
    NotFoundAfterMarker,
}

#[derive(Default)]
struct Held {
    objects: HashMap<String, Vec<u8>>,
    /// The bucket the endpoint reaches after `swap_buckets`.
    other: HashMap<String, Vec<u8>>,
    mode: Option<Mode>,
    refused: Vec<String>,
    requests: Vec<(Method, String)>,
    /// The next deletion waits for this, and lands even if its request is given up.
    late_delete: Option<Arc<Notify>>,
    landed: usize,
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

/// The keys a bulk `POST /<bucket>?delete` names, as the paths their objects are kept at.
fn named_for_deletion(bucket: &str, body: &[u8]) -> Vec<(String, String)> {
    String::from_utf8_lossy(body)
        .split("<Key>")
        .skip(1)
        .filter_map(|part| part.split_once("</Key>"))
        .map(|(key, _)| (key.to_string(), format!("{bucket}/{key}")))
        .collect()
}

fn deletion_answer(named: &[(String, String)]) -> Response {
    let deleted: String = named
        .iter()
        .map(|(key, _)| format!("<Deleted><Key>{key}</Key></Deleted>"))
        .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/xml")
        .body(Body::from(format!(
            "<DeleteResult>{deleted}</DeleteResult>"
        )))
        .unwrap()
}

async fn answer(State(held): State<Arc<Mutex<Held>>>, request: Request) -> Response {
    let key = request.uri().path().to_string();
    let (method, headers) = (request.method().clone(), request.headers().clone());
    if method == Method::POST && request.uri().query() == Some("delete") {
        let body = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap();
        return delete(held, named_for_deletion(&key, &body)).await;
    }
    let (mode, refused) = {
        let mut held = held.lock().unwrap();
        held.requests.push((method.clone(), key.clone()));
        let mode = held.mode.unwrap_or(Mode::Normal);
        if mode == Mode::NotFoundAfterMarker && key.ends_with("/.marfa-store") {
            held.mode = Some(Mode::AllNotFound);
        }
        let refused = held.refused.iter().any(|prefix| key.starts_with(prefix));
        (mode, refused)
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

/// Removes the named objects, or, with a late deletion armed, leaves that to a task of its own
/// that carries it out once released, whether or not this request is still waiting.
async fn delete(held: Arc<Mutex<Held>>, named: Vec<(String, String)>) -> Response {
    let (mode, late) = {
        let mut held = held.lock().unwrap();
        for (_, path) in &named {
            held.requests.push((Method::DELETE, path.clone()));
        }
        (held.mode.unwrap_or(Mode::Normal), held.late_delete.take())
    };
    if mode == Mode::AllNotFound {
        return not_found();
    }
    let Some(release) = late else {
        let mut held = held.lock().unwrap();
        for (_, path) in &named {
            held.objects.remove(path);
        }
        return deletion_answer(&named);
    };
    let (landed, answered) = oneshot::channel();
    let paths: Vec<String> = named.iter().map(|(_, path)| path.clone()).collect();
    tokio::spawn(async move {
        release.notified().await;
        let mut held = held.lock().unwrap();
        for path in &paths {
            held.objects.remove(path);
        }
        held.landed += 1;
        let _ = landed.send(());
    });
    let _ = answered.await;
    deletion_answer(&named)
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

    /// Refuses with `403` every write of an object whose key starts with `prefix`.
    pub fn refuse_writes(&self, prefix: &str) {
        self.held.lock().unwrap().refused.push(prefix.to_string());
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

    /// The keys of the objects whose key starts with `prefix`.
    pub fn objects_under(&self, prefix: &str) -> Vec<String> {
        let held = self.held.lock().unwrap();
        let mut keys: Vec<String> = held
            .objects
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// Holds the next deletion until the answer is released, and carries it out then whether
    /// or not its request is still waiting.
    pub fn delay_next_delete(&self) -> Arc<Notify> {
        let release = Arc::new(Notify::new());
        self.held.lock().unwrap().late_delete = Some(release.clone());
        release
    }

    /// Makes the endpoint reach the other bucket, as a changed endpoint or proxy does.
    pub fn swap_buckets(&self) {
        let held = &mut *self.held.lock().unwrap();
        std::mem::swap(&mut held.objects, &mut held.other);
    }

    /// How many deletions held by `delay_next_delete` have been carried out.
    pub fn late_deletes_landed(&self) -> usize {
        self.held.lock().unwrap().landed
    }
}
