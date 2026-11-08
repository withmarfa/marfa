//! The owner's profile and picture, for the owner and for a key or an app that may change it.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::json;

use super::answer::{Answer, Stopped, json_answer};
use super::blobs::{SANDBOX, header_of, stream};
use super::body::JsonBody;
use super::query;
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::auth::Visit;
use crate::app::auth::owner::{self, Owner, PROFILE_FIELDS, ProfileUpdate};
use crate::app::auth::picture::{Door, MAX_BYTES};
use crate::app::refusal::{Code, Refusal};

const OWNER_PICTURE: &str = "/owner/picture";
const PROFILE_PICTURE: &str = "/profile/picture";

/// A picture's body is read by its own door, under its own cap.
pub fn is_picture(request: &Request) -> bool {
    let path = request.uri().path();
    request.method() == axum::http::Method::PUT
        && (path == OWNER_PICTURE || path == PROFILE_PICTURE)
}

/// A body the general cap and deadline leave to the door that reads it.
pub fn reads_own_body(request: &Request) -> bool {
    super::blobs::is_upload(request) || is_picture(request)
}

fn too_large() -> Refusal {
    Refusal::new(
        Code::RequestTooLarge,
        format!("A picture is at most {MAX_BYTES} bytes."),
    )
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

/// Reads the body up to the cap, and answers as soon as it passes it, with the rest unread.
async fn arrived(
    body: &mut Body,
    declared: Option<usize>,
    idle: Duration,
) -> Result<Vec<u8>, Stopped> {
    if declared > Some(MAX_BYTES) {
        return Err(too_large().into());
    }
    let mut bytes = Vec::new();
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => {
                return Err(Refusal::new(
                    Code::RequestTimeout,
                    "The body stopped arriving; the upload was ended.",
                )
                .into());
            }
            Ok(None) => return Ok(bytes),
            Ok(Some(Err(_))) => return Err(Stopped::ClientClosed),
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    if bytes.len().saturating_add(data.len()) > MAX_BYTES {
                        return Err(too_large().into());
                    }
                    bytes.extend_from_slice(&data);
                }
            }
        }
    }
}

async fn put(
    app: &App,
    caller: &Caller,
    visit: Visit,
    request: Request,
    door: Door,
) -> Result<Owner, Stopped> {
    app.admit_picture(caller, door)?;
    query::only(request.uri(), &[])?;
    let (parts, mut body) = request.into_parts();
    let bytes = arrived(
        &mut body,
        declared_length(&parts.headers),
        app.upload_idle(),
    )
    .await?;
    Ok(app.put_picture(caller, door, bytes, visit).await?)
}

pub async fn put_owner(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    request: Request,
) -> Answer {
    let owner = put(&app, &caller, visit, request, Door::Owner).await?;
    Ok(json_answer(
        StatusCode::OK,
        &owner.to_json(app.addresses().sign_in().origin()),
    ))
}

pub async fn put_profile(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    request: Request,
) -> Answer {
    put(&app, &caller, visit, request, Door::Profile).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

pub async fn read_own(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &[])?;
    let profile = owner::read_profile(&app, &caller).await?;
    Ok(json_answer(StatusCode::OK, &profile))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    visit: Visit,
    body: JsonBody,
) -> Answer {
    let body = body.object(&PROFILE_FIELDS).await?;
    let change = ProfileUpdate::from_body(&body)?;
    owner::update_profile(&app, &caller, change, visit).await?;
    Ok(json_answer(StatusCode::OK, &json!({ "ok": true })))
}

fn names(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag)
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    uri: Uri,
    headers: HeaderMap,
) -> Answer {
    caller.require_profile("avatar", Level::Read)?;
    query::only(&uri, &[])?;
    let Some((picture, found)) = app.owner_picture().await? else {
        return Err(Refusal::new(Code::NotFound, "The owner has no picture.").into());
    };
    let etag = format!("\"{}\"", picture.hash.hex());
    let size = found.blob.size_bytes;
    let unchanged = names(&headers, &etag);
    let body = if unchanged {
        Body::empty()
    } else {
        stream(app.bytes_of(&found).await?, 0, size, app.blob_read_idle())
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::ETAG, header_of(&etag));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"picture\""),
    );
    if unchanged {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
    } else {
        headers.insert(header::CONTENT_TYPE, header_of(&picture.mime_type));
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    }
    Ok(response)
}
