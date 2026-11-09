//! `POST /restore`: an archive's body read as it arrives, under the idle limit and no size cap.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, HttpBody};
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use http_body_util::BodyExt;

use super::answer::{Answer, Stopped, json_answer, refusal_answer};
use super::body::linger;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal};
use crate::settings::registry::MAX_REQUEST_BYTES;

const PATH: &str = "/restore";
const EARLY_DRAIN: Duration = Duration::from_secs(2);

/// A body this door reads itself, whose size no cap holds in check.
pub fn is_restore(request: &Request) -> bool {
    request.method() == Method::POST && request.uri().path() == PATH
}

/// How far the door read the body before it answered.
#[derive(Default)]
struct Read {
    begun: bool,
    ended: bool,
}

/// Before a refusal made ahead of the body, reads and drops what a client already sending has
/// in flight: at most one request's worth, for at most `EARLY_DRAIN`. A client that asked to
/// wait for `100 Continue` has sent nothing, and reading would invite it to send.
async fn drain_early(app: &App, parts: &Parts, body: &mut Body) {
    let waits = parts
        .headers
        .get(header::EXPECT)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"100-continue"));
    if waits {
        return;
    }
    let most = app.settings.live().get(MAX_REQUEST_BYTES);
    let until = tokio::time::Instant::now() + EARLY_DRAIN;
    let mut taken: u64 = 0;
    while !body.is_end_stream() && taken <= most {
        match tokio::time::timeout_at(until, body.frame()).await {
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    taken = taken.saturating_add(data.len() as u64);
                }
            }
            _ => return,
        }
    }
}

/// A refusal made before the body is read is answered at once, and the connection ends with it.
fn closing(refusal: &Refusal) -> Response {
    let mut response = refusal_answer(refusal);
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

pub async fn restore(
    State(app): State<Arc<App>>,
    caller: Result<Caller, Stopped>,
    request: Request,
) -> Answer {
    let (parts, mut body) = request.into_parts();
    let idle = app.upload_idle();
    let mut read = Read::default();
    let answer = receive(&app, caller, &parts, &mut body, idle, &mut read).await;
    match answer {
        Err(Stopped::Refused(refusal)) if !read.ended && read.begun => {
            linger(&mut body, idle).await;
            Err(Stopped::Refused(refusal))
        }
        Err(Stopped::Refused(refusal)) if !read.ended => {
            drain_early(&app, &parts, &mut body).await;
            Ok(closing(&refusal))
        }
        answer => answer,
    }
}

async fn receive(
    app: &Arc<App>,
    caller: Result<Caller, Stopped>,
    parts: &Parts,
    body: &mut Body,
    idle: Duration,
    read: &mut Read,
) -> Answer {
    let caller = caller?;
    caller.require_local()?;
    let started_at = app.clock.stamp();
    caller.require_recent(&started_at)?;
    query::only(&parts.uri, &[])?;
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if body.is_end_stream() || declared == Some(0) {
        read.ended = true;
        return Err(Refusal::validation("The body is empty; send an archive.")
            .with_detail("field", "body")
            .into());
    }
    let mut receiving = app.begin_restore(declared).await?;
    read.begun = true;
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => {
                read.ended = true;
                receiving.abandon().await;
                return Err(Refusal::new(
                    Code::RequestTimeout,
                    "The body stopped arriving; the restore was ended and nothing was written.",
                )
                .into());
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => {
                receiving.abandon().await;
                return Err(Stopped::ClientClosed);
            }
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    receiving.push(data).await?;
                }
            }
        }
    }
    read.ended = true;
    let received = receiving.finish().await?;
    let answer = app.restore(&caller, started_at, received).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}
