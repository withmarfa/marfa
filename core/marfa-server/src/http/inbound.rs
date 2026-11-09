use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
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
use crate::app::faults::HOLD_INBOUND_RESERVED;
use crate::app::inbound::{self, Arrival, Full, Listing, Mark, NewEndpoint, Reservation, Sent};
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

/// The first growth of a buffer for a body of no declared length, in bytes.
const FIRST_GROWTH: usize = 4096;
/// The most a buffer grows by in one step, so what it holds past what it needs stays bounded.
const LAST_GROWTH: usize = 1 << 20;

/// A body gathered into one buffer, whatever frames it arrives in.
struct Gathered {
    bytes: Vec<u8>,
    /// What the reservation holds for the buffer's capacity, when no length was declared.
    charged: usize,
    /// Whether the buffer was made whole for a declared length, and the reservation already holds it.
    sized: bool,
}

impl Gathered {
    fn new(declared: Option<u64>) -> Gathered {
        match declared.and_then(|length| usize::try_from(length).ok()) {
            Some(length) => Gathered {
                bytes: Vec::with_capacity(length),
                charged: 0,
                sized: true,
            },
            None => Gathered {
                bytes: Vec::new(),
                charged: 0,
                sized: false,
            },
        }
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Adds a frame, first taking from `reservation` the growth of the buffer's capacity it needs.
    fn push(
        &mut self,
        data: &[u8],
        reservation: &mut Reservation,
        flight: u64,
        limit: u64,
    ) -> Result<(), Full> {
        let needed = self.bytes.len().saturating_add(data.len());
        if !self.sized && needed > self.charged {
            let step = self.charged.clamp(FIRST_GROWTH, LAST_GROWTH);
            let ceiling = usize::try_from(limit).unwrap_or(usize::MAX);
            let target = needed
                .max(self.charged.saturating_add(step))
                .min(ceiling.max(needed));
            // A step that does not fit takes the most that does, so the next frame fits it or is refused.
            let taken = reservation.take_up_to(
                (needed - self.charged) as u64,
                (target - self.charged) as u64,
                flight,
            )?;
            let target = self.charged + taken as usize;
            self.bytes.reserve_exact(target - self.bytes.len());
            self.charged = target;
        }
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
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
    app.faults.hold(HOLD_INBOUND_RESERVED, None).await;
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
        if declared.is_some_and(|declared| bytes.len() as u64 + more > declared) {
            return refused(&Refusal::validation("The body did not arrive whole."));
        }
        if let Err(full) = bytes.push(&data, &mut reservation, flight, limit) {
            return refused(&full.refusal());
        }
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
    use crate::app::inbound::InFlight;

    #[test]
    fn a_declared_length_makes_the_buffer_once_and_takes_nothing_more() {
        let flight = InFlight::default();
        let mut reservation = flight.reservation("a");
        let mut sized = Gathered::new(Some(6));
        assert_eq!(sized.push(b"abc", &mut reservation, 0, 6), Ok(()));
        assert_eq!(sized.push(b"def", &mut reservation, 0, 6), Ok(()));
        let joined = sized.finish();
        assert_eq!((joined.as_slice(), joined.capacity()), (&b"abcdef"[..], 6));
    }

    #[test]
    fn many_tiny_frames_are_charged_by_the_capacity_that_holds_them() {
        let limit = 4 << 20;
        let flight = InFlight::default();
        let mut reservation = flight.reservation("a");
        let mut chunked = Gathered::new(None);
        for _ in 0..limit {
            assert_eq!(
                chunked.push(&[7], &mut reservation, 8 * limit as u64, limit as u64),
                Ok(())
            );
        }
        assert_eq!(chunked.len(), limit);
        assert_eq!(chunked.charged, chunked.bytes.capacity());
        assert!(chunked.charged <= 2 * chunked.len());
        // The source holds the capacity, no less: what is left of its half is all another request of it may take.
        let (flight_limit, rest) = (6 * limit as u64, 3 * limit as u64 - chunked.charged as u64);
        let mut other = flight.reservation("a");
        assert_eq!(other.take(rest, flight_limit), Ok(()));
        assert_eq!(other.take(1, flight_limit), Err(Full::Source));
        let joined = chunked.finish();
        assert!(joined.iter().all(|byte| *byte == 7));
    }

    #[test]
    fn a_growth_that_passes_the_bound_is_refused_before_the_buffer_grows() {
        let flight = InFlight::default();
        let mut reservation = flight.reservation("a");
        let mut chunked = Gathered::new(None);
        // A source may hold half of 16384, which two growths of 4096 and 4096 fill.
        for _ in 0..8192 {
            assert_eq!(chunked.push(&[1], &mut reservation, 16384, 1 << 20), Ok(()));
        }
        assert_eq!(chunked.charged, 8192);
        assert_eq!(
            chunked.push(&[1], &mut reservation, 16384, 1 << 20),
            Err(Full::Source)
        );
        assert_eq!((chunked.len(), chunked.bytes.capacity()), (8192, 8192));
    }

    #[test]
    fn a_step_that_does_not_fit_takes_what_does_and_does_not_grow_again_per_frame() {
        let flight = InFlight::default();
        let mut reservation = flight.reservation("a");
        let mut chunked = Gathered::new(None);
        // A source may hold half of 12000, which a second step of 4096 would pass from 4097 bytes.
        let (mut capacity, mut changes) = (chunked.bytes.capacity(), 0);
        for _ in 0..5000 {
            assert_eq!(chunked.push(&[1], &mut reservation, 12000, 1 << 20), Ok(()));
            if chunked.bytes.capacity() != capacity {
                capacity = chunked.bytes.capacity();
                changes += 1;
            }
            assert_eq!(chunked.charged, chunked.bytes.capacity());
        }
        assert_eq!(chunked.len(), 5000);
        assert!(changes <= 3, "the buffer changed capacity {changes} times");
        // The rest of the source's half is held, and no byte past it is.
        for _ in 5000..6000 {
            assert_eq!(chunked.push(&[1], &mut reservation, 12000, 1 << 20), Ok(()));
        }
        assert_eq!(
            chunked.push(&[1], &mut reservation, 12000, 1 << 20),
            Err(Full::Source)
        );
    }
}
