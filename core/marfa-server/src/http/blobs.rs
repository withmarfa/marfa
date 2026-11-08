//! The blob doors: an upload streamed to disk, and a download streamed from it.

use std::os::unix::fs::FileExt;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use http_body::{Frame, SizeHint};
use http_body_util::BodyExt;
use serde_json::json;
use tokio::sync::mpsc;

use super::answer::{Answer, Stopped, json_answer, refusal_answer};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::range::{self, Slice};
use crate::app::blobs::{DEFAULT_TYPE, Found, Hash, link};
use crate::app::refusal::{Code, Refusal};
use crate::app::types::missing_field;

const CHUNK: u64 = 256 * 1024;
const QUEUED: usize = 2;
const SANDBOX: &str = "sandbox; default-src 'none'";
const POLICY: &str = "all";

/// A body the server streams to a store, whose size no cap holds in check.
pub fn is_upload(request: &Request) -> bool {
    request.method() == axum::http::Method::POST && request.uri().path() == "/blobs"
}

fn media_type(headers: &HeaderMap) -> Result<String, Refusal> {
    let sent = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split([';', ',']).next())
        .map_or("", str::trim);
    if sent.eq_ignore_ascii_case("multipart/form-data") {
        return Err(Refusal::validation(
            "Send the raw bytes as the body; multipart/form-data is not taken.",
        )
        .with_detail("field", "content-type"));
    }
    Ok(if sent.is_empty() { DEFAULT_TYPE } else { sent }.to_string())
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

pub async fn upload(State(app): State<Arc<App>>, caller: Caller, request: Request) -> Answer {
    app.check_upload(&caller).await?;
    query::only(request.uri(), &[])?;
    let (parts, mut body) = request.into_parts();
    let mime_type = media_type(&parts.headers)?;
    let declared = declared_length(&parts.headers);
    if body.is_end_stream() || declared == Some(0) {
        return Err(empty().into());
    }
    let mut intake = app.begin_upload(declared, mime_type).await?;
    let idle = app.upload_idle();
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => {
                return Err(Refusal::new(
                    Code::RequestTimeout,
                    "The body stopped arriving; the upload was ended.",
                )
                .into());
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => return Err(Stopped::ClientClosed),
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    intake.push(data).await?;
                }
            }
        }
    }
    let blob = app.finish_upload(&caller, intake).await?;
    Ok(json_answer(
        StatusCode::CREATED,
        &json!({
            "hash": blob.hash.as_str(),
            "mime_type": blob.mime_type,
            "size_bytes": blob.size_bytes,
        }),
    ))
}

fn empty() -> Refusal {
    Refusal::validation("The body is empty; send the bytes to keep.").with_detail("field", "body")
}

fn header_of(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(DEFAULT_TYPE))
}

/// Streams a window of a file, one chunk ahead of a reader that must keep reading.
struct Reading {
    chunks: mpsc::Receiver<std::io::Result<Bytes>>,
    stalled: Arc<AtomicBool>,
    length: u64,
}

impl HttpBody for Reading {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        if self.stalled.load(Ordering::Acquire) {
            let error = std::io::Error::new(std::io::ErrorKind::TimedOut, "the read stalled");
            return Poll::Ready(Some(Err(error)));
        }
        self.chunks
            .poll_recv(context)
            .map(|next| next.map(|chunk| chunk.map(Frame::data)))
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.length)
    }
}

fn stream(file: std::fs::File, first: u64, length: u64, idle: Duration) -> Body {
    let (send, chunks) = mpsc::channel(QUEUED);
    let stalled = Arc::new(AtomicBool::new(false));
    let flag = stalled.clone();
    let file = Arc::new(file);
    tokio::spawn(async move {
        let (mut at, mut left) = (first, length);
        while left > 0 {
            let want = usize::try_from(left.min(CHUNK)).unwrap_or(CHUNK as usize);
            let reader = file.clone();
            let read = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0; want];
                let count = reader.read_at(&mut buffer, at)?;
                buffer.truncate(count);
                Ok::<_, std::io::Error>(buffer)
            })
            .await;
            let chunk = match read {
                Ok(Ok(buffer)) if !buffer.is_empty() => Ok(buffer),
                Ok(Ok(_)) => Err(std::io::ErrorKind::UnexpectedEof.into()),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(std::io::Error::other(error)),
            };
            let outcome = chunk.map(Bytes::from);
            let count = outcome.as_ref().map_or(0, |bytes| bytes.len() as u64);
            let failed = outcome.is_err();
            match tokio::time::timeout(idle, send.send(outcome)).await {
                Ok(Ok(())) if !failed => {}
                Ok(_) => return,
                Err(_) => {
                    flag.store(true, Ordering::Release);
                    return;
                }
            }
            at += count;
            left -= count;
        }
    });
    Body::new(Reading {
        chunks,
        stalled,
        length,
    })
}

fn unsatisfiable(size: u64) -> Response {
    let refusal = Refusal::new(
        Code::RangeNotSatisfiable,
        "The range starts past the end of the blob or ends before it starts.",
    )
    .with_detail("size_bytes", size);
    let mut response = refusal_answer(&refusal);
    response
        .headers_mut()
        .insert(header::CONTENT_RANGE, header_of(&format!("bytes */{size}")));
    response
}

async fn serve(app: &App, found: Found, range: Option<&str>, head: bool) -> Answer {
    let size = found.blob.size_bytes;
    let slice = range::of(range, size);
    if slice == Slice::Unsatisfiable {
        return Ok(unsatisfiable(size));
    }
    let file = app.bytes_of(&found).await?;
    let (status, first, length) = match slice {
        Slice::Part { first, last } => (StatusCode::PARTIAL_CONTENT, first, last - first + 1),
        _ => (StatusCode::OK, 0, size),
    };
    let body = if head || length == 0 {
        Body::empty()
    } else {
        stream(file, first, length, app.blob_read_idle())
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let hex = found.blob.hash.hex();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header_of(&found.blob.mime_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::ETAG,
        header_of(&format!("\"{}\"", found.blob.hash.as_str())),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        header_of(&format!("attachment; filename=\"{hex}\"")),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Slice::Part { first, last } = slice {
        headers.insert(
            header::CONTENT_RANGE,
            header_of(&format!("bytes {first}-{last}/{size}")),
        );
    }
    Ok(response)
}

fn range_of(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
}

async fn read(
    app: &App,
    caller: &Caller,
    uri: &Uri,
    headers: &HeaderMap,
    hash: &str,
    head: bool,
) -> Answer {
    caller.require_blob_reach()?;
    query::only(uri, &[])?;
    let found = app.find_blob(caller, &Hash::parse(hash)?).await?;
    serve(app, found, range_of(headers), head).await
}

pub async fn download(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Answer {
    read(&app, &caller, &uri, &headers, &hash, false).await
}

pub async fn head(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Answer {
    read(&app, &caller, &uri, &headers, &hash, true).await
}

pub async fn url(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    Path(hash): Path<String>,
) -> Answer {
    caller.require_blob_reach()?;
    query::only(&uri, &["ttl"])?;
    let ttl = query::pairs(&uri)?
        .into_iter()
        .find(|(key, _)| key == "ttl")
        .map(|(_, value)| value);
    let ttl = link::ttl_seconds(ttl.as_deref())?;
    let link = app.mint_link(&caller, &Hash::parse(&hash)?, ttl).await?;
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "url": link.url, "expires_in": link.expires_in }),
    ))
}

pub async fn copies(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    Path(hash): Path<String>,
) -> Answer {
    caller.require_blob_reach()?;
    query::only(&uri, &[])?;
    let copies = app.blob_copies(&caller, &Hash::parse(&hash)?).await?;
    let data: Vec<_> = copies
        .iter()
        .map(|copy| {
            json!({
                "store_id": copy.store_id,
                "kind": copy.kind,
                "policy": POLICY,
                "detached": copy.detached,
                "recorded_at": copy.recorded_at,
                "verified_at": copy.verified_at,
            })
        })
        .collect();
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null }),
    ))
}

pub async fn stores(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    let (stores, min_copies) = app.blob_stores(&caller).await?;
    query::only(&uri, &[])?;
    let data: Vec<_> = stores
        .iter()
        .map(|store| {
            json!({
                "id": store.id,
                "kind": store.kind,
                "locator": store.locator,
                "policy": POLICY,
                "attached_at": store.attached_at,
                "detached_at": store.detached_at,
            })
        })
        .collect();
    Ok(json_answer(
        StatusCode::OK,
        &json!({ "data": data, "next_cursor": null, "min_copies": min_copies }),
    ))
}

async fn fetched(app: &App, uri: &Uri, headers: &HeaderMap, hash: &str, head: bool) -> Answer {
    query::only(uri, &["expires", "signature"])?;
    let pairs = query::pairs(uri)?;
    let value = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let Some(expires) = value("expires") else {
        return Err(missing_field("expires").into());
    };
    let Some(signature) = value("signature") else {
        return Err(missing_field("signature").into());
    };
    let hash = Hash::parse(hash)?;
    let found = app.find_linked(&hash, expires, signature).await?;
    serve(app, found, range_of(headers), head).await
}

pub async fn fetch(
    State(app): State<Arc<App>>,
    uri: Uri,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Answer {
    fetched(&app, &uri, &headers, &hash, false).await
}

pub async fn fetch_head(
    State(app): State<Arc<App>>,
    uri: Uri,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Answer {
    fetched(&app, &uri, &headers, &hash, true).await
}
