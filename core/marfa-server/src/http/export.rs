//! `GET /export`: NDJSON lines, or the archive a restore reads.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes, HttpBody};
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use http_body::Frame;

use super::answer::Answer;
use super::blobs::header_of;
use super::items::invalid_field;
use super::listing::{Params, states_of, types_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::archive;
use crate::app::query::{Ask, States};
use crate::app::refusal::Result;

const EXPORT_QUERY: [&str; 7] = [
    "type",
    "state",
    "source",
    "occurred_after",
    "occurred_before",
    "format",
    "files",
];
/// Every state but the bin, which is the one thing a copy leaves behind unless asked.
const KEPT_STATES: [&str; 3] = ["active", "archived", "revoked"];

/// An export's chunks as they come; an error in place of the end cuts the response short.
struct Streamed(archive::Body);

impl HttpBody for Streamed {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, std::io::Error>>> {
        self.0
            .poll_chunk(context)
            .map(|next| next.map(|chunk| chunk.map(Frame::data)))
    }
}

fn ask_of(params: &Params) -> Result<Ask> {
    let kept = States::Named(KEPT_STATES.iter().map(ToString::to_string).collect());
    Ok(Ask {
        types: params.one("type")?.map_or(Ok(Vec::new()), types_of)?,
        system: true,
        states: params.one("state")?.map_or(Ok(kept), states_of)?,
        source: params.one("source")?.map(str::to_string),
        occurred_after: params.time("occurred_after")?,
        occurred_before: params.time("occurred_before")?,
        ..Ask::default()
    })
}

fn streamed(body: archive::Body, content_type: &'static str) -> Response {
    let mut response = Response::new(Body::new(Streamed(body)));
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

pub async fn export(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_reach()?;
    let params = Params::read(&uri, &EXPORT_QUERY, false)?;
    let archive = match params.one("format")? {
        None | Some("ndjson") => false,
        Some("archive") => true,
        Some(_) => return Err(invalid_field("format", "format is ndjson or archive.").into()),
    };
    let files = match params.one("files")? {
        None | Some("true") => true,
        Some("false") => false,
        Some(_) => return Err(invalid_field("files", "files is true or false.").into()),
    };
    let ask = ask_of(&params)?;
    if !archive {
        let body = app.export_lines(&caller, ask).await?;
        return Ok(streamed(body, "application/x-ndjson"));
    }
    let (body, created_at) = app.export_archive(&caller, ask, files).await?;
    let date = created_at.at().format("%Y-%m-%d");
    let mut response = streamed(body, "application/x-tar");
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header_of(&format!("attachment; filename=\"marfa-export-{date}.tar\"")),
    );
    Ok(response)
}
