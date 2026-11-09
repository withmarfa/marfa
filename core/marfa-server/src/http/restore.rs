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
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal};

const PATH: &str = "/restore";

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

/// Reads and drops the rest of a refused body, so a client still sending reaches the answer.
async fn linger(body: &mut Body, idle: Duration) {
    while !body.is_end_stream() {
        match tokio::time::timeout(idle, body.frame()).await {
            Ok(Some(Ok(_))) => {}
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
        Err(Stopped::Refused(refusal)) if !read.ended => Ok(closing(&refusal)),
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
    caller.require_direct()?;
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
