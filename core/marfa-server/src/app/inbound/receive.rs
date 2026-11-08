//! Address-authorized receipts, checked again in the storage transaction.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use super::super::App;
use super::super::auth;
use super::super::faults::FAIL_INBOUND_RECEIPT;
use super::super::refusal::{Code, Refusal, Result};
use super::store;
use crate::db::{Write, io_refusal};
use crate::settings::registry::{
    INBOUND_BACKLOG_BYTES, INBOUND_BACKLOG_DELIVERIES, INBOUND_RETAINED_BYTES,
    INBOUND_RETAINED_DELIVERIES,
};

const RETRY_AFTER_SECONDS: i64 = 60;

/// The bytes of the bodies arriving now, across every endpoint.
#[derive(Clone, Debug, Default)]
pub struct InFlight(Arc<AtomicU64>);

impl InFlight {
    pub fn reservation(&self) -> Reservation {
        Reservation {
            total: self.0.clone(),
            held: 0,
        }
    }
}

/// What one body holds of the bytes in flight, given back when it is dropped.
#[derive(Debug)]
pub struct Reservation {
    total: Arc<AtomicU64>,
    held: u64,
}

impl Reservation {
    /// Takes `more` bytes unless that would pass `limit` across all bodies.
    pub fn take(&mut self, more: u64, limit: u64) -> bool {
        let taken = self
            .total
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |total| {
                total.checked_add(more).filter(|sum| *sum <= limit)
            })
            .is_ok();
        if taken {
            self.held += more;
        }
        taken
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.total.fetch_sub(self.held, Ordering::AcqRel);
    }
}

pub fn unavailable(message: &'static str) -> Refusal {
    Refusal::new(Code::InboundUnavailable, message).with_detail("retry_after", RETRY_AFTER_SECONDS)
}

fn not_found() -> Refusal {
    Refusal::new(Code::NotFound, "Not found")
}

/// An endpoint that answers, and the registration that held it when a body began to arrive.
#[derive(Debug, Clone)]
pub struct Place {
    token_hash: String,
    connector_id: String,
}

/// Checks the address before exposing capacity refusals.
pub async fn admit(app: &App, token: &str) -> Result<Place> {
    let token_hash = super::hash_token(token);
    let looked = token_hash.clone();
    let clock = app.clock.clone();
    let backlog = app.settings.live().get(INBOUND_BACKLOG_DELIVERIES);
    app.db
        .read(move |tx| {
            let at = clock.stamp();
            let (target, expires_at) = store::target(tx, &looked)?.ok_or_else(not_found)?;
            if lapsed(expires_at.as_deref(), &at)? {
                return Err(not_found());
            }
            let pending = store::pending(tx, &target.source)?;
            if u64::try_from(pending).unwrap_or(u64::MAX) >= backlog {
                return Err(unavailable("The connector's backlog is full."));
            }
            Ok(Place {
                token_hash: looked,
                connector_id: target.connector_id,
            })
        })
        .await
}

fn lapsed(expires_at: Option<&str>, at: &str) -> Result<bool> {
    match expires_at {
        None => Ok(false),
        Some(expires_at) => Ok(auth::millis_of(expires_at)? <= auth::millis_of(at)?),
    }
}

/// What a sender sent: the query as written, every header, and the body.
pub struct Sent {
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The id of the stored delivery.
pub struct Landed(pub String);

fn width(text: &str) -> i64 {
    i64::try_from(text.len()).unwrap_or(i64::MAX)
}

/// What a delivery holds against its registration's retained limits.
fn charge(sent: &Sent) -> i64 {
    let headers: i64 = sent
        .headers
        .iter()
        .map(|(name, value)| width(name).saturating_add(width(value)))
        .fold(0, i64::saturating_add);
    i64::try_from(sent.body.len())
        .unwrap_or(i64::MAX)
        .saturating_add(width(&sent.query))
        .saturating_add(headers)
}

/// Rechecks authority and capacity in the write, which holds the body's reservation until it ends.
pub async fn receive(
    app: &App,
    place: Place,
    sent: Sent,
    reservation: Reservation,
) -> Result<Landed> {
    let live = app.settings.live();
    let clock = app.clock.clone();
    let faults = app.faults.clone();
    let id = uuid::Uuid::now_v7().to_string();
    app.db
        .write(Write::caller("inbound.receive"), move |tx| {
            let _held = reservation;
            let at = clock.stamp();
            let (target, expires_at) =
                store::target(tx, &place.token_hash)?.ok_or_else(not_found)?;
            if target.connector_id != place.connector_id || lapsed(expires_at.as_deref(), &at)? {
                return Err(not_found());
            }
            let size = i64::try_from(sent.body.len()).unwrap_or(i64::MAX);
            let charge = charge(&sent);
            let tally = store::tally(tx, &target.source)?;
            let over = |held: i64, more: i64, limit: u64| {
                u64::try_from(held.saturating_add(more)).unwrap_or(u64::MAX) > limit
            };
            if over(tally.pending, 1, live.get(INBOUND_BACKLOG_DELIVERIES)) {
                return Err(unavailable("The connector's backlog is full."));
            }
            if over(tally.pending_bytes, size, live.get(INBOUND_BACKLOG_BYTES)) {
                return Err(unavailable("The connector's backlog of bytes is full."));
            }
            if over(tally.retained, 1, live.get(INBOUND_RETAINED_DELIVERIES))
                || over(
                    tally.retained_bytes,
                    charge,
                    live.get(INBOUND_RETAINED_BYTES),
                )
            {
                return Err(unavailable(
                    "The connector holds as many deliveries as it may keep.",
                ));
            }
            let dedupe_key = target.duplicate_header.as_deref().and_then(|wanted| {
                sent.headers
                    .iter()
                    .find(|(name, _)| name == wanted)
                    .map(|(_, value)| value.as_str())
            });
            if faults.fail(FAIL_INBOUND_RECEIPT, None) {
                return Err(io_refusal());
            }
            let seq = store::insert_delivery(
                tx,
                &store::Receipt {
                    id: &id,
                    endpoint_id: &target.endpoint_id,
                    source: &target.source,
                    at: &at,
                    query: &sent.query,
                    headers: &sent.headers,
                    size,
                    sha256: &hex::encode(Sha256::digest(&sent.body)),
                    dedupe_key,
                    charge,
                },
            )?;
            if faults.fail(FAIL_INBOUND_RECEIPT, None) {
                return Err(io_refusal());
            }
            store::insert_body(tx, seq, &sent.body)?;
            Ok(Landed(id))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_share_the_bytes_in_flight_and_give_them_back_when_they_end() {
        let flight = InFlight::default();
        let mut first = flight.reservation();
        let mut second = flight.reservation();
        assert!(first.take(6, 8));
        assert!(!second.take(3, 8));
        assert!(second.take(2, 8));
        assert!(!first.take(1, 8));
        drop(first);
        assert!(second.take(6, 8));
        drop(second);
        assert!(flight.reservation().take(8, 8));
    }

    #[test]
    fn a_charge_is_the_stored_bytes_of_body_query_and_headers() {
        let sent = Sent {
            query: "a=1".into(),
            headers: vec![("x-a".into(), "bc".into()), ("x-a".into(), "".into())],
            body: vec![0; 10],
        };
        assert_eq!(charge(&sent), 10 + 3 + (3 + 2) + 3);
    }
}
