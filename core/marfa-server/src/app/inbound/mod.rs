//! Source-owned endpoints and deliveries, bound to the current registration.

mod cleanup;
mod receive;
mod request;
mod store;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::Transaction;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::App;
use super::access::Caller;
use super::auth;
use super::connectors::{self, Registration, Window};
use super::keys;
use super::refusal::{Code, Refusal, Result};
pub use cleanup::delivery_cleanup;
pub use receive::{
    Arrival, Full, InFlight, Landed, Place, Reservation, Sent, admit, head_charge, receive,
};
pub use request::{Mark, NewEndpoint, state_of};
use store::{Delivery, Endpoint};

const LIVE_ENDPOINTS: i64 = 10;
const TOKEN_BYTES: usize = 32;
pub const PREFIX: &str = "/inbound/";

pub(crate) fn bind(tx: &Transaction<'_>, source: &str, connector_id: &str) -> Result<()> {
    store::bind(tx, source, connector_id)
}

fn endpoint_not_found() -> Refusal {
    Refusal::new(Code::EndpointNotFound, "Endpoint not found")
}

fn delivery_not_found() -> Refusal {
    Refusal::new(Code::DeliveryNotFound, "Delivery not found")
}

fn address_of(endpoint: &Endpoint, token: Option<&str>) -> String {
    match token {
        Some(token) => format!("{PREFIX}{token}"),
        None => format!("{PREFIX}****{}", endpoint.token_last4),
    }
}

fn endpoint_json(endpoint: &Endpoint, connector_id: &str, token: Option<&str>) -> Value {
    json!({
        "id": endpoint.id,
        "connector_id": connector_id,
        "label": endpoint.label,
        "duplicate_header": endpoint.duplicate_header,
        "path": address_of(endpoint, token),
        "created_at": endpoint.created_at,
        "retired_at": endpoint.retired_at,
    })
}

/// Whether the key still opens the registration's address.
fn key_stands(tx: &Transaction<'_>, key_id: &str, at: &str) -> Result<bool> {
    let Some(key) = keys::unrevoked_by_id(tx, key_id)? else {
        return Ok(false);
    };
    match key.expires_at.as_deref() {
        None => Ok(true),
        Some(expires_at) => Ok(auth::millis_of(expires_at)? > auth::millis_of(at)?),
    }
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn last_four(token: &str) -> String {
    let characters: Vec<char> = token.chars().collect();
    characters[characters.len().saturating_sub(4)..]
        .iter()
        .collect()
}

pub async fn create_endpoint(
    app: &App,
    caller: &Caller,
    connector_id: String,
    request: NewEndpoint,
) -> Result<Value> {
    app.write(caller, "inbound_endpoint.create", move |unit| {
        let tx = unit.tx();
        let registration = connectors::find(tx, &connector_id)?;
        unit.caller
            .require_connector_key_or_manager(&registration.key_id)?;
        request.checked()?;
        let standing = key_stands(tx, &registration.key_id, &unit.at)?
            && store::holds(tx, &registration.source, &registration.id)?;
        if !standing {
            return Err(Refusal::new(
                Code::Conflict,
                "The registration's key is revoked or has expired, or a newer registration holds its source.",
            )
            .with_detail("key_id", registration.key_id.as_str()));
        }
        if store::live_endpoints(tx, &registration.source)? >= LIVE_ENDPOINTS {
            return Err(Refusal::new(
                Code::Conflict,
                "A connector holds at most 10 live inbound endpoints.",
            ));
        }
        let token = new_token()?;
        let id = uuid::Uuid::now_v7().to_string();
        store::insert_endpoint(
            tx,
            &store::Fresh {
                id: &id,
                source: &registration.source,
                token_hash: &hash_token(&token),
                token_last4: &last_four(&token),
                label: request.label.as_deref(),
                duplicate_header: request.duplicate_header.as_deref(),
                at: &unit.at,
            },
        )?;
        unit.audit(
            "inbound_endpoint",
            &id,
            Some(json!({
                "connector_id": registration.id,
                "label": request.label,
                "duplicate_header": request.duplicate_header,
            })),
        )?;
        let endpoint = store::endpoint_of(tx, &registration.source, &id)?
            .ok_or_else(|| Refusal::internal("a new endpoint did not read back"))?;
        Ok(endpoint_json(&endpoint, &registration.id, Some(&token)))
    })
    .await
}

/// The registration, when this caller may see its endpoints.
fn manageable(tx: &Transaction<'_>, caller: &Caller, id: &str) -> Result<Registration> {
    let registration = connectors::find(tx, id)?;
    caller.require_connector_key_or_manager(&registration.key_id)?;
    Ok(registration)
}

pub async fn list_endpoints(app: &App, caller: &Caller, connector_id: String) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, _| {
        let registration = manageable(tx, caller, &connector_id)?;
        let held = if store::holds(tx, &registration.source, &registration.id)? {
            store::endpoints(tx, &registration.source)?
        } else {
            Vec::new()
        };
        let data: Vec<Value> = held
            .iter()
            .map(|endpoint| endpoint_json(endpoint, &registration.id, None))
            .collect();
        Ok(json!({ "data": data, "next_cursor": null }))
    })
    .await
}

pub async fn retire_endpoint(
    app: &App,
    caller: &Caller,
    connector_id: String,
    endpoint_id: String,
) -> Result<Value> {
    app.write(caller, "inbound_endpoint.retire", move |unit| {
        let tx = unit.tx();
        let registration = manageable(tx, &unit.caller, &connector_id)?;
        let held = store::holds(tx, &registration.source, &registration.id)?;
        let endpoint = store::endpoint_of(tx, &registration.source, &endpoint_id)?
            .filter(|_| held)
            .ok_or_else(endpoint_not_found)?;
        if endpoint.retired_at.is_some() {
            return Ok(endpoint_json(&endpoint, &registration.id, None));
        }
        store::retire(tx, &endpoint.id, &unit.at)?;
        unit.audit(
            "inbound_endpoint",
            &endpoint.id,
            Some(json!({ "connector_id": registration.id })),
        )?;
        let retired = Endpoint {
            retired_at: Some(unit.at.clone()),
            ..endpoint
        };
        Ok(endpoint_json(&retired, &registration.id, None))
    })
    .await
}

/// The registration whose deliveries only its own key reads.
fn own_deliveries(tx: &Transaction<'_>, caller: &Caller, id: &str) -> Result<Registration> {
    let registration = connectors::find(tx, id)?;
    caller.require_own_connector_key(&registration.key_id)?;
    Ok(registration)
}

fn delivery_json(tx: &Transaction<'_>, delivery: &Delivery) -> Result<Value> {
    let original = match delivery.dedupe_key.as_deref() {
        Some(key) => store::original(tx, &delivery.endpoint_id, key)?
            .filter(|(id, _)| *id != delivery.id)
            .map(|(id, outcome)| json!({ "id": id, "outcome": outcome })),
        None => None,
    };
    Ok(json!({
        "id": delivery.id,
        "endpoint_id": delivery.endpoint_id,
        "received_at": delivery.received_at,
        "method": delivery.method,
        "query": delivery.query,
        "headers": delivery.headers,
        "size": delivery.size,
        "sha256": delivery.sha256,
        "duplicate_of": original,
        "handled_at": delivery.handled_at,
        "outcome": delivery.outcome,
    }))
}

pub struct Listing {
    pub handled: Option<bool>,
    pub endpoint_id: Option<String>,
}

pub async fn list_deliveries(
    app: &App,
    caller: &Caller,
    connector_id: String,
    listing: Listing,
    window: Window,
) -> Result<Value> {
    let secret = app.cursor_secret.clone();
    connectors::reading(app, caller, move |tx, caller, _| {
        let registration = own_deliveries(tx, caller, &connector_id)?;
        if !store::holds(tx, &registration.source, &registration.id)? {
            return Ok(json!({ "data": [], "next_cursor": null }));
        }
        let after = match &window.after {
            Some((received, seq)) => Some((
                received.as_str(),
                seq.parse::<i64>().map_err(|_| super::query::bad_cursor())?,
            )),
            None => None,
        };
        let mut page = store::deliveries_page(
            tx,
            &registration.source,
            listing.handled,
            listing.endpoint_id.as_deref(),
            after,
            window.limit + 1,
        )?;
        let more = page.len() as i64 > window.limit;
        page.truncate(usize::try_from(window.limit).unwrap_or(usize::MAX));
        let next = match page.last().filter(|_| more) {
            Some(last) => Some(window.next(&secret, &last.received_at, &last.seq.to_string())?),
            None => None,
        };
        let data = page
            .iter()
            .map(|delivery| delivery_json(tx, delivery))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({ "data": data, "next_cursor": next }))
    })
    .await
}

pub async fn delivery_body(
    app: &App,
    caller: &Caller,
    connector_id: String,
    delivery_id: String,
) -> Result<Vec<u8>> {
    connectors::reading(app, caller, move |tx, caller, _| {
        let registration = own_deliveries(tx, caller, &connector_id)?;
        let held = store::holds(tx, &registration.source, &registration.id)?;
        store::body(tx, &registration.source, &delivery_id)?
            .filter(|_| held)
            .ok_or_else(delivery_not_found)
    })
    .await
}

pub async fn mark_handled(
    app: &App,
    caller: &Caller,
    connector_id: String,
    request: Mark,
) -> Result<Value> {
    app.write(caller, "inbound_delivery.handled", move |unit| {
        let tx = unit.tx();
        let registration = own_deliveries(tx, &unit.caller, &connector_id)?;
        request.checked()?;
        let held = store::holds(tx, &registration.source, &registration.id)?;
        let mut named = Vec::with_capacity(request.ids.len());
        for id in &request.ids {
            let delivery = store::delivery_of(tx, &registration.source, id)?
                .filter(|_| held)
                .ok_or_else(delivery_not_found)?;
            named.push(delivery);
        }
        for delivery in named.iter_mut().filter(|d| d.handled_at.is_none()) {
            store::mark(tx, &delivery.id, &unit.at, request.outcome)?;
            delivery.handled_at = Some(unit.at.clone());
            delivery.outcome = Some(request.outcome.to_string());
        }
        let data = named
            .iter()
            .map(|delivery| delivery_json(tx, delivery))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({ "data": data }))
    })
    .await
}

fn unescaped(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let escaped = (bytes[at] == b'%')
            .then(|| bytes.get(at + 1..at + 3))
            .flatten()
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where the address credential starts in `path`, read in any case or escaping.
fn address_in(path: &str) -> Option<(String, usize)> {
    let decoded = unescaped(path);
    let start = decoded.to_ascii_lowercase().find(PREFIX)?;
    Some((decoded, start))
}

/// Whether `path` is a receiving address, in any case or escaping.
pub fn is_address(path: &str) -> bool {
    address_in(path).is_some()
}

/// Redacts address credentials regardless of case or URL escaping.
pub fn loggable(path: &str) -> String {
    let Some((decoded, start)) = address_in(path) else {
        return path.to_string();
    };
    let tail = last_four(&decoded[start + PREFIX.len()..]);
    format!("{}{PREFIX}****{tail}", &decoded[..start])
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

    #[test]
    fn an_address_is_logged_by_its_last_four_characters_in_any_spelling() {
        let expected = "/inbound/****DEFG";
        assert_eq!(loggable(&format!("/inbound/{TOKEN}")), expected);
        assert_eq!(loggable(&format!("/INBOUND/{TOKEN}")), expected);
        assert_eq!(loggable(&format!("/%69nbound/{TOKEN}")), expected);
        assert_eq!(loggable(&format!("/inbound%2F{TOKEN}")), expected);
        assert_eq!(
            loggable("/connectors/abc/endpoints"),
            "/connectors/abc/endpoints"
        );
        assert!(is_address(&format!("/%49NBOUND/{TOKEN}")));
        assert!(!is_address("/connectors/abc/endpoints"));
    }

    #[test]
    fn a_token_is_forty_three_characters_of_base64url() {
        let token = new_token().unwrap();
        assert_eq!(token.len(), 43);
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        );
        assert_eq!(hash_token(&token).len(), 64);
        assert_eq!(last_four(&token), token[39..]);
    }
}
