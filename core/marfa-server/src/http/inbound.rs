use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::json;

use super::answer::{Answer, json_answer, refusal_answer};
use super::body::JsonBody;
use super::listing::{Params, whole_limit};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::connectors::Window;
use crate::app::inbound::{self, Arrival, Listing, Mark, NewEndpoint, Sent};
use crate::app::refusal::{Code, Refusal};
use crate::settings::registry::{
    INBOUND_IN_FLIGHT_BYTES, INBOUND_MAX_BYTES, INBOUND_READ_TIMEOUT_MS,
};

const PAGE: i64 = 50;
const MOST: i64 = 200;
/// What the proxy of a tailnet adds: who on it sent the request.
const PROXY_IDENTITY: &str = "tailscale-";

pub async fn create_endpoint(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = NewEndpoint::parse(&body.open_object().await?)?;
    let made = inbound::create_endpoint(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::CREATED, &made))
}

pub async fn list_endpoints(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let listed = inbound::list_endpoints(&app, &caller, id).await?;
    Ok(json_answer(StatusCode::OK, &listed))
}

pub async fn retire_endpoint(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path((id, endpoint_id)): Path<(String, String)>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let retired = inbound::retire_endpoint(&app, &caller, id, endpoint_id).await?;
    Ok(json_answer(StatusCode::OK, &retired))
}

pub async fn list_deliveries(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    let params = Params::read(&uri, &["state", "endpoint_id", "limit", "cursor"], false)?;
    let handled = inbound::state_of(params.one("state")?)?;
    let limit = whole_limit(&params, PAGE, MOST)?;
    let endpoint_id = params.one("endpoint_id")?.map(str::to_string);
    let scope = format!(
        "inbound-deliveries:{id}:{}:{}",
        handled.map_or("any", |handled| if handled { "handled" } else { "pending" }),
        endpoint_id.as_deref().unwrap_or("")
    );
    let window = Window::open(&app, scope, limit, params.one("cursor")?)?;
    let page = inbound::list_deliveries(
        &app,
        &caller,
        id,
        Listing {
            handled,
            endpoint_id,
        },
        window,
    )
    .await?;
    Ok(json_answer(StatusCode::OK, &page))
}

pub async fn delivery_body(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path((id, delivery_id)): Path<(String, String)>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let bytes = inbound::delivery_body(&app, &caller, id, delivery_id).await?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(response)
}

pub async fn mark_handled(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
    body: JsonBody,
) -> Answer {
    query::only(&uri, &[])?;
    let request = Mark::parse(&body.open_object().await?)?;
    let marked = inbound::mark_handled(&app, &caller, id, request).await?;
    Ok(json_answer(StatusCode::OK, &marked))
}

/// Whether the request is a sender's delivery, whose body the door reads for itself.
pub fn is_delivery(request: &Request) -> bool {
    request.method() == axum::http::Method::POST
        && request.uri().path().starts_with(inbound::PREFIX)
}

/// An answer sent while some of the body is unread, so the connection is not kept for the rest.
fn refused(refusal: &Refusal) -> Response {
    let mut response = refusal_answer(refusal);
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn too_large(limit: u64) -> Refusal {
    Refusal::new(
        Code::RequestTooLarge,
        format!("The body is larger than {limit} bytes."),
    )
}

fn declared_length(request: &Request) -> Option<u64> {
    request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

fn kept(name: &axum::http::HeaderName) -> bool {
    !name.as_str().starts_with(PROXY_IDENTITY)
}

/// What the request's headers and query hold, without copying them.
fn head_of(request: &Request) -> i64 {
    inbound::head_charge(
        request.uri().query().unwrap_or(""),
        request
            .headers()
            .iter()
            .filter(|(name, _)| kept(name))
            .map(|(name, value)| {
                (
                    name.as_str(),
                    String::from_utf8_lossy(value.as_bytes()).len(),
                )
            }),
    )
}

/// Excludes proxy identity headers while preserving each name's repeat order.
fn headers_of(request: &Request) -> Vec<(String, String)> {
    request
        .headers()
        .iter()
        .filter(|(name, _)| kept(name))
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// The frames of a body, joined once into one buffer.
enum Gathered {
    /// A declared length, whose buffer is made once and filled as the frames come.
    Sized(Vec<u8>),
    /// No length declared: the frames are kept and joined at the end.
    Framed(Vec<Bytes>, usize),
}

impl Gathered {
    fn new(declared: Option<u64>) -> Gathered {
        match declared.and_then(|length| usize::try_from(length).ok()) {
            Some(length) => Gathered::Sized(Vec::with_capacity(length)),
            None => Gathered::Framed(Vec::new(), 0),
        }
    }

    fn len(&self) -> usize {
        match self {
            Gathered::Sized(bytes) => bytes.len(),
            Gathered::Framed(_, len) => *len,
        }
    }

    fn push(&mut self, data: Bytes) {
        match self {
            Gathered::Sized(bytes) => bytes.extend_from_slice(&data),
            Gathered::Framed(frames, len) => {
                *len += data.len();
                frames.push(data);
            }
        }
    }

    fn finish(self) -> Vec<u8> {
        match self {
            Gathered::Sized(bytes) => bytes,
            Gathered::Framed(frames, len) => {
                let mut bytes = Vec::with_capacity(len);
                for frame in frames {
                    bytes.extend_from_slice(&frame);
                }
                bytes
            }
        }
    }
}

pub async fn receive(
    State(app): State<Arc<App>>,
    Path(token): Path<String>,
    request: Request,
) -> Response {
    let declared = declared_length(&request);
    let head = head_of(&request);
    let place = match inbound::admit(&app, &token, Arrival { declared, head }).await {
        Ok(place) => place,
        Err(refusal) => return refused(&refusal),
    };
    let live = app.settings.live();
    let (limit, flight) = (
        live.get(INBOUND_MAX_BYTES),
        live.get(INBOUND_IN_FLIGHT_BYTES),
    );
    if declared > Some(limit) {
        return refused(&too_large(limit));
    }
    let mut reservation = app.inbound.reservation(&place.source);
    // A declared length is held whole before the body is read, as it is the buffer made for it.
    let held = u64::try_from(head)
        .unwrap_or(0)
        .saturating_add(declared.unwrap_or(0));
    if let Err(full) = reservation.take(held, flight) {
        return refused(&full.refusal());
    }
    let query = request.uri().query().unwrap_or("").to_string();
    let headers = headers_of(&request);
    let deadline = tokio::time::sleep(Duration::from_millis(live.get(INBOUND_READ_TIMEOUT_MS)));
    tokio::pin!(deadline);
    let mut body = request.into_body();
    let mut bytes = Gathered::new(declared);
    loop {
        let frame = tokio::select! {
            frame = body.frame() => frame,
            () = &mut deadline => {
                return refused(&Refusal::new(
                    Code::RequestTimeout,
                    "The body did not arrive in the time allowed.",
                ));
            }
        };
        let data = match frame {
            None => break,
            Some(Err(_)) => {
                return refused(&Refusal::validation("The body did not arrive whole."));
            }
            Some(Ok(frame)) => match frame.into_data() {
                Ok(data) => data,
                Err(_) => continue,
            },
        };
        let more = data.len() as u64;
        if bytes.len() as u64 + more > limit {
            return refused(&too_large(limit));
        }
        match declared {
            Some(declared) if bytes.len() as u64 + more > declared => {
                return refused(&Refusal::validation("The body did not arrive whole."));
            }
            Some(_) => {}
            None => {
                if let Err(full) = reservation.take(more, flight) {
                    return refused(&full.refusal());
                }
            }
        }
        bytes.push(data);
    }
    let landed = inbound::receive(
        &app,
        place,
        Sent {
            query,
            headers,
            body: bytes.finish(),
        },
        reservation,
    )
    .await;
    match landed {
        Ok(inbound::Landed(id)) => json_answer(StatusCode::ACCEPTED, &json!({ "id": id })),
        Err(refusal) => refusal_answer(&refusal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_length_makes_the_buffer_once_and_frames_are_joined_once() {
        let mut sized = Gathered::new(Some(6));
        sized.push(Bytes::from_static(b"abc"));
        sized.push(Bytes::from_static(b"def"));
        let joined = sized.finish();
        assert_eq!((joined.as_slice(), joined.capacity()), (&b"abcdef"[..], 6));

        let mut framed = Gathered::new(None);
        framed.push(Bytes::from_static(b"abc"));
        framed.push(Bytes::from_static(b"de"));
        assert_eq!(framed.len(), 5);
        let joined = framed.finish();
        assert_eq!((joined.as_slice(), joined.capacity()), (&b"abcde"[..], 5));
    }
}
