//! Address-authorized receipts, checked again in the storage transaction.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use sha2::{Digest, Sha256};

use super::super::App;
use super::super::faults::FAIL_INBOUND_RECEIPT;
use super::super::refusal::{Code, Refusal, Result};
use super::store;
use crate::app::clock::Stamp;
use crate::db::{Write, io_refusal};
use crate::settings::Snapshot;
use crate::settings::registry::{
    INBOUND_BACKLOG_BYTES, INBOUND_BACKLOG_DELIVERIES, INBOUND_MAX_BYTES, INBOUND_RETAINED_BYTES,
    INBOUND_RETAINED_DELIVERIES,
};

const RETRY_AFTER_SECONDS: i64 = 60;

#[derive(Debug, Default)]
struct Held {
    total: u64,
    by_source: HashMap<String, u64>,
}

/// The bytes of the requests arriving now, across every endpoint and by source.
#[derive(Clone, Debug, Default)]
pub struct InFlight(Arc<Mutex<Held>>);

impl InFlight {
    pub fn reservation(&self, source: &str) -> Reservation {
        Reservation {
            held: self.0.clone(),
            source: source.to_string(),
            mine: 0,
        }
    }
}

/// What stopped a request from holding more bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Full {
    Instance,
    Source,
}

impl Full {
    pub fn refusal(self) -> Refusal {
        unavailable(match self {
            Full::Instance => "The instance is holding all it will.",
            Full::Source => "The connector is holding all it may.",
        })
    }
}

/// What one request holds of the bytes in flight, given back when it is dropped.
#[derive(Debug)]
pub struct Reservation {
    held: Arc<Mutex<Held>>,
    source: String,
    mine: u64,
}

impl Reservation {
    /// Takes `more` bytes unless that would pass `limit` across all requests, or half of it for this source.
    pub fn take(&mut self, more: u64, limit: u64) -> std::result::Result<(), Full> {
        self.take_up_to(more, more, limit).map(drop)
    }

    /// Takes `want` bytes, or the most that fits when that is at least `need`, and returns how many it took.
    pub fn take_up_to(
        &mut self,
        need: u64,
        want: u64,
        limit: u64,
    ) -> std::result::Result<u64, Full> {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        let own = held.by_source.get(&self.source).copied().unwrap_or(0);
        let room_source = (limit / 2)
            .checked_sub(own)
            .filter(|room| *room >= need)
            .ok_or(Full::Source)?;
        let room_total = limit
            .checked_sub(held.total)
            .filter(|room| *room >= need)
            .ok_or(Full::Instance)?;
        let more = want.min(room_source).min(room_total).max(need);
        held.total += more;
        held.by_source.insert(self.source.clone(), own + more);
        self.mine += more;
        Ok(more)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        held.total = held.total.saturating_sub(self.mine);
        if let Some(own) = held.by_source.get_mut(&self.source) {
            *own = own.saturating_sub(self.mine);
            if *own == 0 {
                held.by_source.remove(&self.source);
            }
        }
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
    pub source: String,
}

/// What a request has told the server before its body is read.
pub struct Arrival {
    /// The body's length, when the sender declared one.
    pub declared: Option<u64>,
    /// The charge of its headers and query.
    pub head: i64,
}

fn over(held: i64, more: i64, limit: u64) -> bool {
    u64::try_from(held.saturating_add(more)).unwrap_or(u64::MAX) > limit
}

fn backlog_room(tally: &store::Tally, live: &Snapshot) -> Result<()> {
    if over(tally.pending, 1, live.get(INBOUND_BACKLOG_DELIVERIES)) {
        return Err(unavailable("The connector's backlog is full."));
    }
    Ok(())
}

fn room_for(tally: &store::Tally, size: i64, charge: i64, live: &Snapshot) -> Result<()> {
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
    Ok(())
}

/// Oversized declarations reach the caller's 413 after only the backlog count check.
pub async fn admit(app: &App, token: &str, arrival: Arrival) -> Result<Place> {
    let token_hash = super::hash_token(token);
    let looked = token_hash.clone();
    let clock = app.clock.clone();
    let live = app.settings.live();
    app.db
        .read(move |tx| {
            let at = clock.stamp();
            let (target, expires_at) = store::target(tx, &looked)?.ok_or_else(not_found)?;
            if lapsed(expires_at.as_deref(), &at)? {
                return Err(not_found());
            }
            let tally = store::tally(tx, &target.source)?;
            backlog_room(&tally, &live)?;
            if arrival
                .declared
                .is_none_or(|declared| declared <= live.get(INBOUND_MAX_BYTES))
            {
                let size = arrival
                    .declared
                    .map_or(0, |declared| i64::try_from(declared).unwrap_or(i64::MAX));
                room_for(&tally, size, arrival.head.saturating_add(size), &live)?;
            }
            Ok(Place {
                token_hash: looked,
                connector_id: target.connector_id,
                source: target.source,
            })
        })
        .await
}

fn lapsed(expires_at: Option<&str>, at: &str) -> Result<bool> {
    match expires_at {
        None => Ok(false),
        Some(expires_at) => Ok(Stamp::read(expires_at)?.ms() <= Stamp::read(at)?.ms()),
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

/// What a request's headers and query hold against its registration's limits, without its body.
pub fn head_charge<'a>(query: &str, headers: impl Iterator<Item = (&'a str, usize)>) -> i64 {
    headers
        .map(|(name, value)| width(name).saturating_add(i64::try_from(value).unwrap_or(i64::MAX)))
        .fold(width(query), i64::saturating_add)
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
    let headers = serde_json::to_string(&sent.headers)
        .map_err(|_| Refusal::internal("headers did not print"))?;
    let head = head_charge(
        &sent.query,
        sent.headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.len())),
    );
    let size = i64::try_from(sent.body.len()).unwrap_or(i64::MAX);
    let charge = head.saturating_add(size);
    let (body, sha256, reservation) = tokio::task::spawn_blocking(move || {
        let sha256 = hex::encode(Sha256::digest(&sent.body));
        (sent.body, sha256, reservation)
    })
    .await
    .map_err(|_| Refusal::internal("a body did not hash"))?;
    let (query, sent_headers) = (sent.query, sent.headers);
    app.db
        .write(Write::caller("inbound.receive"), move |tx| {
            let _held = reservation;
            let at = clock.stamp();
            let (target, expires_at) =
                store::target(tx, &place.token_hash)?.ok_or_else(not_found)?;
            if target.connector_id != place.connector_id || lapsed(expires_at.as_deref(), &at)? {
                return Err(not_found());
            }
            let tally = store::tally(tx, &target.source)?;
            backlog_room(&tally, &live)?;
            room_for(&tally, size, charge, &live)?;
            let dedupe_key = target.duplicate_header.as_deref().and_then(|wanted| {
                sent_headers
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
                    query: &query,
                    headers: &headers,
                    size,
                    sha256: &sha256,
                    dedupe_key,
                    charge,
                },
            )?;
            if faults.fail(FAIL_INBOUND_RECEIPT, None) {
                return Err(io_refusal());
            }
            store::insert_body(tx, seq, &body)?;
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
        let mut first = flight.reservation("a");
        let mut second = flight.reservation("b");
        assert_eq!(first.take(4, 8), Ok(()));
        assert_eq!(second.take(3, 8), Ok(()));
        assert_eq!(second.take(2, 8), Err(Full::Source));
        assert_eq!(flight.reservation("c").take(2, 8), Err(Full::Instance));
        drop(first);
        assert_eq!(second.take(1, 8), Ok(()));
        drop(second);
        assert_eq!(flight.reservation("c").take(4, 8), Ok(()));
    }

    #[test]
    fn a_source_holds_at_most_half_the_bytes_in_flight_across_its_requests() {
        let flight = InFlight::default();
        let mut first = flight.reservation("a");
        let mut second = flight.reservation("a");
        assert_eq!(first.take(3, 8), Ok(()));
        assert_eq!(second.take(2, 8), Err(Full::Source));
        assert_eq!(second.take(1, 8), Ok(()));
        assert_eq!(flight.reservation("b").take(4, 8), Ok(()));
    }

    #[test]
    fn a_charge_is_the_stored_bytes_of_body_query_and_headers() {
        let headers = [("x-a", 2), ("x-a", 0)];
        assert_eq!(head_charge("a=1", headers.into_iter()), 3 + (3 + 2) + 3);
    }
}
