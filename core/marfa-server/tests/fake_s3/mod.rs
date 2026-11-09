//! An in-memory S3 fixture with controllable failures, delays, and bucket switching.

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
    /// Every answer leaves out the objects' `x-amz-meta-` headers, as some proxies do.
    StripMetadata,
    /// The next write lands, then the endpoint reaches the other bucket.
    SwapAfterPut,
    /// The next `HEAD` that finds its object answers, then the endpoint reaches the other bucket.
    SwapAfterHead,
    /// Every request answers `404`, as a deleted bucket or a misrouted proxy does.
    AllNotFound,
    /// A body is sent in this many pieces, one a second.
    Trickle(u64),
    /// The next this many marker reads answer as normal, and every request after them `404`.
    NotFoundAfterMarkers(u32),
}

/// A multipart upload begun and not yet completed or aborted.
#[derive(Clone, Debug, Default)]
struct Upload {
    key: String,
    metadata: Vec<(String, String)>,
    parts: std::collections::BTreeMap<u32, Vec<u8>>,
}

/// An object's bytes and the `x-amz-meta-` headers it was written with.
#[derive(Clone, Debug, Default)]
pub struct Object {
    bytes: Vec<u8>,
    metadata: Vec<(String, String)>,
}

#[derive(Default)]
struct Held {
    objects: HashMap<String, Object>,
    /// The bucket the endpoint reaches after `swap_buckets`.
    other: HashMap<String, Object>,
    mode: Option<Mode>,
    refused: Vec<String>,
    requests: Vec<(Method, String)>,
    /// The next deletion waits for this, and lands even if its request is given up.
    late_delete: Option<Arc<Notify>>,
    /// The next marker read says so on the sender and waits for the receiver.
    marker_held: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    landed: usize,
    /// The next write under this prefix is answered as refused and kept in `late` until landed.
    late_next: Option<String>,
    late: Vec<(String, Object)>,
    /// The next this many listings leave out every object whose key starts with the prefix.
    omitted: Option<(String, u32)>,
    uploads: HashMap<String, Upload>,
    next_upload: u64,
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

fn metadata_of(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| name.as_str().starts_with("x-amz-meta-"))
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect()
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then_some(value)
    })
}

fn xml(body: String) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/xml")
        .body(Body::from(body))
        .unwrap()
}

/// Begins, fills, completes and aborts multipart uploads, as S3 does.
async fn multipart(
    held: Arc<Mutex<Held>>,
    method: &Method,
    key: &str,
    query: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Option<Response> {
    if *method == Method::POST && query_value(query, "uploads").is_some() {
        let mut held = held.lock().unwrap();
        held.next_upload += 1;
        let id = format!("upload-{}", held.next_upload);
        let upload = Upload {
            key: key.to_string(),
            metadata: metadata_of(headers),
            ..Upload::default()
        };
        held.uploads.insert(id.clone(), upload);
        return Some(xml(format!(
            "<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>{key}</Key>\
             <UploadId>{id}</UploadId></InitiateMultipartUploadResult>"
        )));
    }
    let id = query_value(query, "uploadId")?.to_string();
    match *method {
        Method::PUT => {
            let number: u32 = query_value(query, "partNumber")?.parse().ok()?;
            let mut held = held.lock().unwrap();
            let upload = held.uploads.get_mut(&id)?;
            upload.parts.insert(number, body.to_vec());
            Some(
                Response::builder()
                    .header(header::ETAG, format!("\"part-{number}\""))
                    .body(Body::empty())
                    .unwrap(),
            )
        }
        Method::POST => {
            let mut held = held.lock().unwrap();
            let upload = held.uploads.remove(&id)?;
            let bytes = upload.parts.into_values().flatten().collect();
            let object = Object {
                bytes,
                metadata: upload.metadata,
            };
            held.objects.insert(upload.key, object);
            Some(xml(format!(
                "<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>{key}</Key>\
                 <ETag>\"e\"</ETag></CompleteMultipartUploadResult>"
            )))
        }
        Method::DELETE => {
            held.lock().unwrap().uploads.remove(&id);
            Some(
                Response::builder()
                    .status(StatusCode::NO_CONTENT)
                    .body(Body::empty())
                    .unwrap(),
            )
        }
        _ => None,
    }
}

/// The prefix of a `ListObjectsV2` request, percent-decoded.
fn listed_prefix(query: &str) -> Option<String> {
    let pairs: Vec<(&str, &str)> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .collect();
    pairs
        .iter()
        .find(|(name, value)| *name == "list-type" && *value == "2")?;
    let raw = pairs
        .iter()
        .find(|(name, _)| *name == "prefix")
        .map_or("", |(_, value)| *value);
    percent_decoded(raw, true)
}

/// `raw` with its percent escapes decoded, and `+` read as a space in a query.
fn percent_decoded(raw: &str, in_query: bool) -> Option<String> {
    let mut decoded = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(byte) = bytes.next() {
        match byte {
            b'%' => {
                let hex: String = bytes.by_ref().take(2).map(char::from).collect();
                decoded.push(u8::from_str_radix(&hex, 16).ok()?);
            }
            b'+' if in_query => decoded.push(b' '),
            byte => decoded.push(byte),
        }
    }
    String::from_utf8(decoded).ok()
}

/// Every object of `bucket` under `prefix`, in one page, but for those `omitted` leaves out.
fn listing(held: &mut Held, bucket: &str, prefix: &str) -> Response {
    let under = format!("{bucket}/{prefix}");
    let left_out = match held.omitted.take() {
        Some((left_out, times)) => {
            if times > 1 {
                held.omitted = Some((left_out.clone(), times - 1));
            }
            Some(left_out)
        }
        None => None,
    };
    let mut keys: Vec<(&String, &Object)> = held
        .objects
        .iter()
        .filter(|(key, _)| key.starts_with(&under))
        .filter(|(key, _)| left_out.as_ref().is_none_or(|out| !key.starts_with(out)))
        .collect();
    keys.sort_by(|a, b| a.0.cmp(b.0));
    let contents: String = keys
        .iter()
        .map(|(key, object)| {
            format!(
                "<Contents><Key>{}</Key><LastModified>2026-11-02T10:00:00.000Z</LastModified>\
                 <ETag>\"e\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                &key[bucket.len() + 1..],
                object.bytes.len()
            )
        })
        .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/xml")
        .body(Body::from(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>{}</Name>\
             <Prefix>{prefix}</Prefix><KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys>\
             <IsTruncated>false</IsTruncated>{contents}</ListBucketResult>",
            bucket.trim_start_matches('/'),
            keys.len()
        )))
        .unwrap()
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
    let path = request.uri().path();
    let key = percent_decoded(path, false).unwrap_or_else(|| path.to_string());
    let pause = key
        .ends_with("/.marfa-store")
        .then(|| held.lock().unwrap().marker_held.take())
        .flatten();
    if let Some((began, release)) = pause {
        let _ = began.send(());
        let _ = release.await;
    }
    let (method, headers) = (request.method().clone(), request.headers().clone());
    let query = request.uri().query().unwrap_or("").to_string();
    if query_value(&query, "uploads").is_some() || query_value(&query, "uploadId").is_some() {
        held.lock()
            .unwrap()
            .requests
            .push((method.clone(), key.clone()));
        let body = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap();
        return multipart(held, &method, &key, &query, &headers, body)
            .await
            .unwrap_or_else(not_found);
    }
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
        if let Mode::NotFoundAfterMarkers(left) = mode
            && key.ends_with("/.marfa-store")
        {
            held.mode = Some(match left {
                0 | 1 => Mode::AllNotFound,
                left => Mode::NotFoundAfterMarkers(left - 1),
            });
        }
        let refused = held.refused.iter().any(|prefix| key.starts_with(prefix));
        (mode, refused)
    };
    if mode == Mode::AllNotFound {
        return not_found();
    }
    let late = method == Method::PUT && {
        let mut held = held.lock().unwrap();
        let armed = held
            .late_next
            .as_ref()
            .is_some_and(|prefix| key.starts_with(prefix));
        if armed {
            held.late_next = None;
        }
        armed
    };
    if late {
        let body = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap();
        let object = Object {
            bytes: body.to_vec(),
            metadata: metadata_of(&headers),
        };
        held.lock().unwrap().late.push((key, object));
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("<Error><Code>AccessDenied</Code></Error>"))
            .unwrap();
    }
    if refused && method == Method::PUT {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("<Error><Code>AccessDenied</Code></Error>"))
            .unwrap();
    }
    if method == Method::GET
        && let Some(prefix) = listed_prefix(request.uri().query().unwrap_or(""))
    {
        return listing(&mut held.lock().unwrap(), &key, &prefix);
    }
    match method {
        Method::PUT => {
            let body = axum::body::to_bytes(request.into_body(), usize::MAX)
                .await
                .unwrap();
            let metadata = headers
                .iter()
                .filter(|(name, _)| name.as_str().starts_with("x-amz-meta-"))
                .filter_map(|(name, value)| {
                    Some((name.to_string(), value.to_str().ok()?.to_string()))
                })
                .collect();
            let mut held = held.lock().unwrap();
            let object = Object {
                bytes: body.to_vec(),
                metadata,
            };
            held.objects.insert(key, object);
            if mode == Mode::SwapAfterPut {
                let held = &mut *held;
                std::mem::swap(&mut held.objects, &mut held.other);
                held.mode = Some(Mode::Normal);
            }
            Response::builder()
                .header(header::ETAG, "\"e\"")
                .body(Body::empty())
                .unwrap()
        }
        Method::GET | Method::HEAD => {
            let Some(object) = held.lock().unwrap().objects.get(&key).cloned() else {
                return not_found();
            };
            let Object {
                bytes: object,
                metadata,
            } = object;
            let size = object.len();
            let mut builder = Response::builder()
                .header(header::ETAG, "\"e\"")
                .header(header::LAST_MODIFIED, LAST_MODIFIED);
            for (name, value) in metadata {
                if mode != Mode::StripMetadata {
                    builder = builder.header(name, value);
                }
            }
            if method == Method::HEAD {
                if mode == Mode::SwapAfterHead {
                    let held = &mut *held.lock().unwrap();
                    std::mem::swap(&mut held.objects, &mut held.other);
                    held.mode = Some(Mode::Normal);
                }
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

    /// Holds the next marker read until released, and answers when it arrives.
    pub fn hold_marker(&self) -> (oneshot::Sender<()>, oneshot::Receiver<()>) {
        let (release, released) = oneshot::channel();
        let (began, arrived) = oneshot::channel();
        self.held.lock().unwrap().marker_held = Some((began, released));
        (release, arrived)
    }

    pub fn object(&self, key: &str) -> Option<Vec<u8>> {
        let held = self.held.lock().unwrap();
        held.objects.get(key).map(|object| object.bytes.clone())
    }

    /// The object at `key` as the store holds it, metadata included.
    pub fn stored(&self, key: &str) -> Option<Object> {
        self.held.lock().unwrap().objects.get(key).cloned()
    }

    pub fn restore(&self, key: &str, object: Object) {
        self.held
            .lock()
            .unwrap()
            .objects
            .insert(key.to_string(), object);
    }

    /// Puts bytes at `key` with no metadata, as a write the server did not make.
    pub fn put_object(&self, key: &str, bytes: &[u8]) {
        self.restore(
            key,
            Object {
                bytes: bytes.to_vec(),
                metadata: Vec::new(),
            },
        );
    }

    /// Refuses with `403` every write of an object whose key starts with `prefix`.
    pub fn refuse_writes(&self, prefix: &str) {
        self.held.lock().unwrap().refused.push(prefix.to_string());
    }

    /// Takes every write again after `refuse_writes`.
    pub fn allow_writes(&self) {
        self.held.lock().unwrap().refused.clear();
    }

    /// Answers the next write under `prefix` as refused but keeps it until `land_late_writes`.
    pub fn late_write(&self, prefix: &str) {
        self.held.lock().unwrap().late_next = Some(prefix.to_string());
    }

    /// Commits every write `late_write` kept.
    pub fn land_late_writes(&self) {
        let held = &mut *self.held.lock().unwrap();
        for (key, object) in held.late.drain(..) {
            held.objects.insert(key, object);
        }
    }

    /// The keys of the writes `late_write` kept and has not committed.
    pub fn late_keys(&self) -> Vec<String> {
        let held = self.held.lock().unwrap();
        held.late.iter().map(|(key, _)| key.clone()).collect()
    }

    /// Leaves every object whose key starts with `prefix` out of the next `times` listings.
    pub fn omit_from_listings(&self, prefix: &str, times: u32) {
        self.held.lock().unwrap().omitted = Some((prefix.to_string(), times));
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

    /// The keys of the multipart uploads begun and neither completed nor aborted.
    pub fn unfinished_uploads(&self) -> Vec<String> {
        let held = self.held.lock().unwrap();
        let mut keys: Vec<String> = held
            .uploads
            .values()
            .map(|upload| upload.key.clone())
            .collect();
        keys.sort();
        keys
    }

    /// How many deletions held by `delay_next_delete` have been carried out.
    pub fn late_deletes_landed(&self) -> usize {
        self.held.lock().unwrap().landed
    }
}
