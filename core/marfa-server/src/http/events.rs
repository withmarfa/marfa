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
use super::conditional;
use super::items::invalid_field;
use super::listening;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::access::reach::Judge;
use crate::app::events::{self, Filter, Opening};
use crate::app::faults::HOLD_STREAM_OPEN;
use crate::app::refusal::{Code, Refusal, Result};
use crate::settings::registry::SSE_MAX_VIEWERS;

const DECLARED: [&str; 2] = ["type", "edges"];
const COPY_DECLARED: [&str; 2] = ["edges", "copy"];

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

/// The value a copy stream's query names for `name`, when it names it exactly once.
fn once<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let mut named = pairs.iter().filter(|(key, _)| key == name);
    match (named.next(), named.next()) {
        (Some((_, value)), None) => Some(value),
        _ => None,
    }
}

/// What a copy stream resumes from: a cursor and the reach it was read under, both or neither.
fn copy_resume(uri: &Uri, headers: &HeaderMap) -> Result<Option<(i64, String)>> {
    query::only(uri, &COPY_DECLARED)?;
    let pairs = query::pairs(uri)?;
    if once(&pairs, "edges") != Some("all") {
        return Err(invalid_field("edges", "A copy stream takes edges=all."));
    }
    if once(&pairs, "copy") != Some("1") {
        return Err(invalid_field("copy", "copy is 1."));
    }
    let cursor = match headers.contains_key("last-event-id") {
        false => None,
        true => Some(cursor_of(headers)?.ok_or_else(malformed)?),
    };
    let reach = match headers.contains_key(conditional::REACH_HEADER) {
        false => None,
        true => Some(
            conditional::proof_of(headers)
                .ok_or_else(|| {
                    invalid_field(
                        "X-Marfa-Reach",
                        "X-Marfa-Reach takes one value of 64 lowercase hexadecimal characters.",
                    )
                })?
                .to_string(),
        ),
    };
    match (cursor, reach) {
        (None, None) => Ok(None),
        (Some(cursor), Some(reach)) => Ok(Some((cursor, reach))),
        _ => Err(Refusal::validation(
            "Last-Event-ID and X-Marfa-Reach resume a copy stream together.",
        )),
    }
}

/// A stale reach takes precedence over a valid request's type denial.
async fn copy(
    app: Arc<App>,
    caller: Caller,
    hangup: Option<Extension<listening::Hangup>>,
    uri: Uri,
    headers: HeaderMap,
) -> Answer {
    let resume = match copy_resume(&uri, &headers) {
        Ok(resume) => resume,
        Err(refusal) => {
            caller.require_reach()?;
            return Err(refusal.into());
        }
    };
    if let Some((_, asked)) = &resume {
        let judge = Judge::of(&app);
        let (caller, asked) = (caller.clone(), asked.clone());
        let clock = app.clock.clone();
        app.db
            .read(move |tx| {
                let caller = caller.current(tx, &clock.stamp())?;
                judge.require(tx, &caller, &asked)
            })
            .await?;
    }
    caller.require_reach()?;
    app.faults.hold(HOLD_STREAM_OPEN, None).await;
    let viewer = app
        .viewers
        .admit(app.settings.live().get(SSE_MAX_VIEWERS))
        .ok_or_else(at_capacity)?;
    let (resume, reach) = match resume {
        Some((cursor, reach)) => (Some(cursor), Some(reach)),
        None => (None, None),
    };
    let feed = events::open(
        app,
        caller,
        Opening {
            filter: Filter {
                types: Vec::new(),
                edges: true,
                copy: true,
            },
            resume,
            reach,
        },
        viewer,
        hangup.map(|Extension(hangup)| events::Hangup {
            close: Box::new({
                let hangup = hangup.clone();
                move || hangup.now()
            }),
            closed: Box::pin(hangup.closed()),
        }),
    );
    Ok(streaming(feed))
}

fn streaming(feed: mpsc::Receiver<Bytes>) -> Response {
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
    response
}

pub async fn open(
    State(app): State<Arc<App>>,
    caller: Caller,
    hangup: Option<Extension<listening::Hangup>>,
    uri: Uri,
    headers: HeaderMap,
) -> Answer {
    if query::pairs(&uri).is_ok_and(|pairs| pairs.iter().any(|(name, _)| name == "copy")) {
        return copy(app, caller, hangup, uri, headers).await;
    }
    caller.require_reach()?;
    app.faults.hold(HOLD_STREAM_OPEN, None).await;
    if headers.contains_key(conditional::REACH_HEADER) {
        return Err(Refusal::validation(
            "X-Marfa-Reach belongs to the copy stream, GET /events?edges=all&copy=1.",
        )
        .into());
    }
    query::only(&uri, &DECLARED)?;
    let types = types_of(&uri)?;
    events::judge_types(&app, &caller, types.clone()).await?;
    let filter = Filter {
        types,
        edges: edges_of(&uri)?,
        copy: false,
    };
    let resume = cursor_of(&headers)?;
    let viewer = app
        .viewers
        .admit(app.settings.live().get(SSE_MAX_VIEWERS))
        .ok_or_else(at_capacity)?;
    let feed = events::open(
        app,
        caller,
        Opening {
            filter,
            resume,
            reach: None,
        },
        viewer,
        hangup.map(|Extension(hangup)| -> events::Hangup { Box::new(move || hangup.now()) }),
    );
    Ok(streaming(feed))
}
