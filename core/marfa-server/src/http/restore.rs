//! `POST /restore`: an archive's body read as it arrives, under the idle limit and no size cap.

use std::sync::Arc;

use axum::body::HttpBody;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use http_body_util::BodyExt;

use super::answer::{Answer, Stopped, json_answer};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::refusal::{Code, Refusal};

const PATH: &str = "/restore";

/// A body this door reads itself, whose size no cap holds in check.
pub fn is_restore(request: &Request) -> bool {
    request.method() == Method::POST && request.uri().path() == PATH
}

pub async fn restore(State(app): State<Arc<App>>, caller: Caller, request: Request) -> Answer {
    caller.require_direct()?;
    let started_at = app.clock.stamp();
    caller.require_recent(&started_at)?;
    query::only(request.uri(), &[])?;
    let (parts, mut body) = request.into_parts();
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if body.is_end_stream() || declared == Some(0) {
        return Err(Refusal::validation("The body is empty; send an archive.")
            .with_detail("field", "body")
            .into());
    }
    let mut receiving = app.begin_restore(declared).await?;
    let idle = app.upload_idle();
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => {
                return Err(Refusal::new(
                    Code::RequestTimeout,
                    "The body stopped arriving; the restore was ended and nothing was written.",
                )
                .into());
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => return Err(Stopped::ClientClosed),
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    receiving.push(data).await?;
                }
            }
        }
    }
    let received = receiving.finish().await?;
    let answer = app.restore(&caller, started_at, received).await?;
    Ok(json_answer(StatusCode::OK, &answer))
}
