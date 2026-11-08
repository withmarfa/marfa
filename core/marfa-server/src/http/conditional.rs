//! A read that presents a reach. The reach is judged before the read is, certified on the answers
//! that tell the credential something about what it may read, and held to the read's own snapshot.

use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

use super::answer::{Page, refusal_answer};
use super::caller::identify;
use super::query;
use crate::app::App;
use crate::app::access::reach::{Demand, Judge};
use crate::app::access::unauthorized;
use crate::app::refusal::{Code, Refusal};

pub const REACH_HEADER: &str = "x-marfa-reach";
const EVENTS: &str = "/events";

/// Whether a path has the shape of a conditional read's, with any value for an identifier.
fn has_shape(method: &Method, path: &str) -> bool {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match *method {
        Method::GET => matches!(
            segments.as_slice(),
            ["items" | "edges"]
                | ["items" | "edges", _]
                | ["items", _, "edges"]
                | ["types" | "edge-types"]
                | ["keys", "current"]
        ),
        Method::POST => segments.as_slice() == ["items", "bulk-get"],
        _ => false,
    }
}

fn is_conditional(method: &Method, route: &str) -> bool {
    match *method {
        Method::GET => matches!(
            route,
            "/items"
                | "/items/{id}"
                | "/items/{id}/edges"
                | "/edges"
                | "/edges/{id}"
                | "/types"
                | "/edge-types"
                | "/keys/current"
        ),
        Method::POST => route == "/items/bulk-get",
        _ => false,
    }
}

/// The one value of the header, if it is exactly one 64-character lowercase hexadecimal value.
pub fn proof_of(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(REACH_HEADER).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    value.to_str().ok().filter(|text| well_formed(text))
}

pub fn well_formed(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn without_metadata(request: &Request) -> bool {
    let Ok(pairs) = query::pairs(request.uri()) else {
        return true;
    };
    !pairs
        .iter()
        .filter(|(name, _)| name == "include")
        .any(|(_, value)| value.split(',').any(|token| token.trim() == "metadata"))
}

fn untakable() -> Refusal {
    Refusal::validation("No operation at this path takes X-Marfa-Reach.")
}

/// A refusal or a missing thing that says what the credential may read is certified by the reach it
/// answered under, so that a device holding the reach can tell it from a fault.
fn certifies(route: &str, response: &Response) -> bool {
    let status = response.status();
    if status.is_success() {
        return true;
    }
    let Some(page) = response.extensions().get::<Page>() else {
        return false;
    };
    match (status, page.code) {
        (StatusCode::NOT_FOUND, Code::ItemNotFound | Code::EdgeNotFound) => true,
        (StatusCode::FORBIDDEN, Code::TypeNotPermitted | Code::EdgePermissionDenied) => true,
        (StatusCode::FORBIDDEN, Code::Forbidden) => route == "/keys/current",
        _ => false,
    }
}

pub async fn judged(
    State(app): State<Arc<App>>,
    matched: MatchedPath,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let route = matched.as_str().to_string();
    let reads = method == Method::GET || (method == Method::POST && route == "/items/bulk-get");
    if !reads || !request.headers().contains_key(REACH_HEADER) || route == EVENTS {
        return next.run(request).await;
    }
    if !has_shape(&method, request.uri().path()) {
        return refusal_answer(&untakable());
    }
    let (mut parts, body) = request.into_parts();
    let caller = match identify(&mut parts, &app).await {
        Ok(Some(caller)) => caller,
        Ok(None) => return refusal_answer(&unauthorized()),
        Err(refusal) => return refusal_answer(&refusal),
    };
    if !is_conditional(&method, &route) {
        return refusal_answer(&untakable());
    }
    let Some(asked) = proof_of(&parts.headers).map(str::to_string) else {
        return refusal_answer(&Refusal::validation(
            "X-Marfa-Reach takes one value of 64 lowercase hexadecimal characters.",
        ));
    };
    let request = Request::from_parts(parts, body);
    if route == "/items" && without_metadata(&request) {
        return refusal_answer(&Refusal::validation(
            "A read under X-Marfa-Reach takes include=metadata.",
        ));
    }
    let judge = Judge::of(&app);
    let clock = app.clock.clone();
    let proof = asked.clone();
    let held = {
        let judge = judge.clone();
        app.db
            .read(move |tx| {
                let caller = caller.current(tx, &clock.stamp())?;
                judge.require(tx, &caller, &proof)
            })
            .await
    };
    if let Err(refusal) = held {
        return refusal_answer(&refusal);
    }
    let demand = Demand::new(judge, asked.clone());
    let mut response = demand.within(next.run(request)).await;
    if certifies(&route, &response)
        && let Ok(value) = HeaderValue::from_str(&asked)
    {
        let headers = response.headers_mut();
        headers.insert(REACH_HEADER, value);
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
