//! `GET /events`: the refusals a request can meet, then a stream the server writes as the reader takes it.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use http_body::Frame;
use marfa_rules::query::type_entries;
use tokio::sync::mpsc;

use super::answer::Answer;
use super::items::invalid_field;
use super::listening;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::events::{self, Filter, Opening};
use crate::app::faults::HOLD_STREAM_OPEN;
use crate::app::refusal::{Code, Refusal, Result};
use crate::settings::registry::SSE_MAX_VIEWERS;

const DECLARED: [&str; 3] = ["type", "edges", "copy"];

struct Feed(mpsc::Receiver<Bytes>);

impl http_body::Body for Feed {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|piece| piece.map(|piece| Ok(Frame::data(piece))))
    }
}

/// The entries of `type`, counted and cleaned; each is judged for its grammar and its type as it is reached.
fn types_of(uri: &Uri) -> Result<Vec<String>> {
    let mut sent = Vec::new();
    for (name, value) in query::pairs(uri)? {
        if name == "type" {
            sent.extend(value.split(',').map(str::to_string));
        }
    }
    if sent.is_empty() {
        return Ok(sent);
    }
    type_entries(&sent)
        .map(|entries| entries.into_iter().map(str::to_string).collect())
        .map_err(|error| invalid_field("type", error.message))
}

fn edges_of(uri: &Uri) -> Result<bool> {
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "edges");
    match named.as_ref().map(|(_, value)| value.as_str()) {
        None | Some("all") => Ok(true),
        Some("none") => Ok(false),
        Some(_) => Err(Refusal::validation("edges must be all or none.")),
    }
}

fn cursor_of(headers: &HeaderMap) -> Result<Option<i64>> {
    let mut sent = headers.get_all("last-event-id").iter();
    let (Some(value), None) = (sent.next(), sent.next()) else {
        return match headers.contains_key("last-event-id") {
            true => Err(malformed()),
            false => Ok(None),
        };
    };
    let text = value.to_str().map_err(|_| malformed())?;
    if text.is_empty() {
        return Ok(None);
    }
    let plain =
        text.bytes().all(|byte| byte.is_ascii_digit()) && (text == "0" || !text.starts_with('0'));
    match plain.then(|| text.parse::<i64>().ok()).flatten() {
        Some(cursor) => Ok(Some(cursor)),
        None => Err(malformed()),
    }
}

fn malformed() -> Refusal {
    invalid_field(
        "Last-Event-ID",
        "Last-Event-ID is the id of an event: digits only, without a sign or leading zeros.",
    )
}

fn at_capacity() -> Refusal {
    Refusal::new(
        Code::StreamCapacityExhausted,
        "This instance serves as many event streams as it is set to. Ask again once one ends.",
    )
    .with_detail("reason", "viewer_cap")
}

pub async fn open(
    State(app): State<Arc<App>>,
    caller: Caller,
    hangup: Option<Extension<listening::Hangup>>,
    uri: Uri,
    headers: HeaderMap,
) -> Answer {
    caller.require_reach()?;
    app.faults.hold(HOLD_STREAM_OPEN, None).await;
    if headers.contains_key("x-marfa-reach") {
        return Err(Refusal::validation(
            "X-Marfa-Reach belongs to the copy stream, GET /events?edges=all&copy=1.",
        )
        .into());
    }
    query::only(&uri, &DECLARED)?;
    if query::pairs(&uri)?.iter().any(|(name, _)| name == "copy") {
        return Err(invalid_field("copy", "This server does not serve the copy stream.").into());
    }
    let types = types_of(&uri)?;
    events::judge_types(&app, &caller, types.clone()).await?;
    let filter = Filter {
        types,
        edges: edges_of(&uri)?,
    };
    let resume = cursor_of(&headers)?;
    let viewer = app
        .viewers
        .admit(app.settings.live().get(SSE_MAX_VIEWERS))
        .ok_or_else(at_capacity)?;
    let feed = events::open(
        app,
        caller,
        Opening { filter, resume },
        viewer,
        hangup.map(|Extension(hangup)| events::Hangup {
            close: Box::new({
                let hangup = hangup.clone();
                move || hangup.now()
            }),
            closed: Box::pin(hangup.closed()),
        }),
    );
    let mut response = Response::new(Body::new(Feed(feed)));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // A stream's end then closes its connection, which `Hangup::closed` sees.
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
