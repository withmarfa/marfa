//! One attempt at a delivery: judged again for its credential as it stands, sent once along
//! the checked path, and recorded unless the delivery was settled while it was out.

use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use rusqlite::Transaction;
use serde_json::Value;
use sha2::Sha256;
use url::Url;

use super::store::{self, Recorded, Status};
use super::{CANCEL_CREDENTIAL, CANCEL_TURNED_OFF, CANCEL_UNREADABLE, CANCEL_UNSELECTED, selects};
use crate::app::App;
use crate::app::access::standing_maker;
use crate::app::catalog::{self, Catalog};
use super::schedule::UNFILTERED;
use crate::app::events::{Head, Judge, Judged};
use crate::app::faults::HOLD_WEBHOOK_RESPONSE;
use crate::app::outbound::{self, Outcome, Outgoing, Reach};
use crate::app::refusal::{Refusal, Result};
use crate::db::Write;

pub const ATTEMPT_BOUND: Duration = Duration::from_secs(10);
/// The waits after each failed attempt of a cycle, in seconds; a cycle is one more attempt.
const WAITS_S: [i64; 7] = [1, 5, 25, 125, 625, 3_125, 15_625];
const HINT_CAP_MS: i64 = 5 * 60 * 1_000;

pub const UNREACHABLE: &str = "The receiver could not be reached.";
pub const TIMED_OUT: &str = "The receiver did not answer in time.";
pub const REDIRECTED: &str = "The receiver answered with a redirect, which is not followed.";
pub const NOT_PUBLIC: &str = "The receiver's address is not public.";

struct Ready {
    url: String,
    secret: String,
    event_type: String,
    body: serde_json::Map<String, Value>,
    cycle_attempt: i64,
    delivery_id: String,
    event_id: i64,
}

enum Prepared {
    Gone,
    Cancel(&'static str),
    Send(Box<Ready>),
}

fn prepare(tx: &Transaction<'_>, catalog: &Catalog, seq: i64, at: &str) -> Result<Prepared> {
    let Some((delivery, payload)) = store::pending(tx, seq)? else {
        return Ok(Prepared::Gone);
    };
    let Some(subscription) = store::by_id(tx, &delivery.webhook_id, None)? else {
        return Ok(Prepared::Gone);
    };
    if !subscription.active {
        return Ok(Prepared::Cancel(CANCEL_TURNED_OFF));
    }
    if !selects(&subscription, &catalog.rules, &delivery.event_type, &delivery.type_id) {
        return Ok(Prepared::Cancel(CANCEL_UNSELECTED));
    }
    let Some(caller) = standing_maker(tx, &subscription.maker, at)? else {
        return Ok(Prepared::Cancel(CANCEL_CREDENTIAL));
    };
    let head = Head {
        id: delivery.event_id,
        event_type: &delivery.event_type,
        type_id: &delivery.type_id,
        source: &delivery.source,
    };
    let judge = Judge {
        tx,
        caller: &caller,
        rules: &catalog.rules,
        filter: &UNFILTERED,
    };
    let Some(kind) = judge.wants(&head) else {
        return Ok(Prepared::Cancel(super::CANCEL_UNREAD));
    };
    let body = match judge.judged(&head, kind, &payload)? {
        Judged::Shown(body) => body,
        Judged::Withheld => return Ok(Prepared::Cancel(super::CANCEL_UNREAD)),
        Judged::Unreadable => return Ok(Prepared::Cancel(CANCEL_UNREADABLE)),
    };
    Ok(Prepared::Send(Box::new(Ready {
        url: subscription.url,
        secret: subscription.secret,
        event_type: delivery.event_type,
        body,
        cycle_attempt: delivery.cycle_attempt,
        delivery_id: delivery.id,
        event_id: delivery.event_id,
    })))
}

fn signature(secret: &str, t: i64, body: &[u8]) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| Refusal::internal("a webhook secret was refused"))?;
    mac.update(t.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Ok(format!("t={t},v1={}", hex::encode(mac.finalize().into_bytes())))
}

/// A hint is whole seconds or an HTTP date, read against the server's clock.
fn hint_ms(value: &str, now_ms: i64) -> Option<i64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(i64::try_from(seconds).unwrap_or(i64::MAX).saturating_mul(1_000));
    }
    let date = httpdate::parse_http_date(value).ok()?;
    let now = UNIX_EPOCH + Duration::from_millis(u64::try_from(now_ms).unwrap_or(0));
    Some(
        date.duration_since(now)
            .map_or(0, |ahead| i64::try_from(ahead.as_millis()).unwrap_or(i64::MAX)),
    )
}

#[derive(Debug, PartialEq, Eq)]
pub struct Settled {
    pub status: Status,
    pub status_code: Option<u16>,
    pub error: Option<String>,
    pub due_at: i64,
}

/// What an outcome leaves on a delivery at the attempt `cycle_attempt` of its cycle, counted from 0.
pub fn settle(outcome: &Attempted, cycle_attempt: i64, now_ms: i64) -> Settled {
    let given_up = |status_code, error: &str| Settled {
        status: Status::DeadLetter,
        status_code,
        error: Some(error.to_string()),
        due_at: now_ms,
    };
    let retried = |status_code, error: String, hint: Option<i64>| {
        let Some(wait_s) = usize::try_from(cycle_attempt)
            .ok()
            .and_then(|index| WAITS_S.get(index))
        else {
            return Settled {
                status: Status::DeadLetter,
                status_code,
                error: Some(error),
                due_at: now_ms,
            };
        };
        let wait = (wait_s * 1_000).max(hint.map_or(0, |hint| hint.min(HINT_CAP_MS)));
        Settled {
            status: Status::Pending,
            status_code,
            error: Some(error),
            due_at: now_ms.saturating_add(wait),
        }
    };
    match outcome {
        Attempted::NotPublic => given_up(None, NOT_PUBLIC),
        Attempted::Sent(Outcome::Unreachable) => retried(None, UNREACHABLE.to_string(), None),
        Attempted::Sent(Outcome::TimedOut) => retried(None, TIMED_OUT.to_string(), None),
        Attempted::Sent(Outcome::Answered {
            status,
            retry_after,
        }) => {
            let code = Some(*status);
            match status {
                200..=299 => Settled {
                    status: Status::Success,
                    status_code: code,
                    error: None,
                    due_at: now_ms,
                },
                300..=399 => given_up(code, REDIRECTED),
                408 | 429 | 500.. | 100..=199 => retried(
                    code,
                    format!("HTTP {status}"),
                    retry_after.as_deref().and_then(|hint| hint_ms(hint, now_ms)),
                ),
                _ => given_up(code, &format!("HTTP {status}")),
            }
        }
    }
}

pub enum Attempted {
    NotPublic,
    Sent(Outcome),
}

async fn write(app: &App, job: impl FnOnce(&Transaction<'_>) -> Result<()> + Send + 'static) -> Result<()> {
    app.db.write(Write::own(), job).await
}

/// Answers once the delivery's outcome is recorded, or once there is nothing to send.
pub async fn attempt(app: Arc<App>, seq: i64) -> Result<()> {
    let at = app.clock.stamp();
    let cache = app.catalog_handle();
    let ready = app
        .db
        .read(move |tx| {
            let catalog = catalog::current(&cache, tx, catalog::Snapshot::Committed)?;
            prepare(tx, &catalog, seq, &at)
        })
        .await?;
    let ready = match ready {
        Prepared::Gone => return Ok(()),
        Prepared::Cancel(reason) => {
            let at = app.clock.stamp();
            return write(&app, move |tx| store::cancel(tx, seq, reason, &at)).await;
        }
        Prepared::Send(ready) => ready,
    };
    let attempted = send(&app, &ready).await?;
    app.faults.hold(HOLD_WEBHOOK_RESPONSE, None).await;
    let now_ms = app.clock.now_ms();
    let settled = settle(&attempted, ready.cycle_attempt, now_ms);
    let at = app.clock.stamp();
    write(&app, move |tx| {
        store::record(
            tx,
            seq,
            &Recorded {
                status: settled.status,
                status_code: settled.status_code,
                error: settled.error.as_deref(),
                due_at: settled.due_at,
            },
            &at,
        )
    })
    .await
}

async fn send(app: &App, ready: &Ready) -> Result<Attempted> {
    let Ok(url) = Url::parse(&ready.url) else {
        return Ok(Attempted::Sent(Outcome::Unreachable));
    };
    let private_allowed = app.settings.start.webhook_private_addresses;
    let targets = match outbound::reach(&app.faults, &url, private_allowed).await {
        Reach::Targets(targets) => targets,
        Reach::Unresolved => return Ok(Attempted::Sent(Outcome::Unreachable)),
        Reach::NotPublic => return Ok(Attempted::NotPublic),
    };
    let now_ms = app.clock.now_ms();
    let mut body = ready.body.clone();
    body.insert("event_id".into(), ready.event_id.to_string().into());
    body.insert("delivery_id".into(), ready.delivery_id.clone().into());
    body.insert("delivered_at".into(), app.clock.stamp().into());
    let printed = marfa_rules::js::to_vec(&Value::Object(body))
        .map_err(|_| Refusal::internal("a webhook delivery did not print"))?;
    let signed = signature(&ready.secret, now_ms.div_euclid(1_000), &printed)?;
    let headers = [
        ("x-marfa-signature", signed),
        ("x-marfa-event-type", ready.event_type.clone()),
    ];
    let outgoing = Outgoing {
        headers: &headers,
        body: String::from_utf8_lossy(&printed).into_owned(),
    };
    Ok(Attempted::Sent(
        outbound::post(&url, &targets, outgoing, ATTEMPT_BOUND).await,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(status: u16, retry_after: Option<&str>) -> Attempted {
        Attempted::Sent(Outcome::Answered {
            status,
            retry_after: retry_after.map(str::to_string),
        })
    }

    #[test]
    fn retries_on_its_schedule_and_gives_up_at_the_eighth_attempt() {
        let mut waits = Vec::new();
        for attempt in 0..8 {
            let settled = settle(&answered(503, None), attempt, 0);
            if settled.status == Status::Pending {
                waits.push(settled.due_at / 1_000);
            } else {
                assert_eq!(attempt, 7);
                assert_eq!(settled.status, Status::DeadLetter);
                assert_eq!(settled.error.as_deref(), Some("HTTP 503"));
            }
        }
        assert_eq!(waits, [1, 5, 25, 125, 625, 3_125, 15_625]);
    }

    #[test]
    fn gives_up_at_once_on_a_refusal_or_a_redirect() {
        for status in [400, 401, 404, 410, 422] {
            let settled = settle(&answered(status, None), 0, 0);
            assert_eq!(settled.status, Status::DeadLetter, "{status}");
            assert_eq!(settled.error, Some(format!("HTTP {status}")));
        }
        for status in [301, 302, 307, 308] {
            let settled = settle(&answered(status, None), 0, 0);
            assert_eq!(settled.status, Status::DeadLetter);
            assert_eq!(settled.status_code, Some(status));
            assert_eq!(settled.error.as_deref(), Some(REDIRECTED));
        }
        for status in [408, 429, 500, 502] {
            assert_eq!(settle(&answered(status, None), 0, 0).status, Status::Pending);
        }
        let not_public = settle(&Attempted::NotPublic, 0, 0);
        assert_eq!(not_public.status, Status::DeadLetter);
        assert_eq!(not_public.status_code, None);
    }

    #[test]
    fn waits_the_longer_of_its_own_wait_and_a_capped_hint() {
        assert_eq!(settle(&answered(429, Some("3")), 0, 0).due_at, 3_000);
        assert_eq!(settle(&answered(429, Some("2")), 1, 0).due_at, 5_000);
        assert_eq!(settle(&answered(429, Some("100000")), 0, 0).due_at, 300_000);
        assert_eq!(settle(&answered(429, Some("100000")), 4, 0).due_at, 625_000);
        assert_eq!(settle(&answered(429, Some("soon")), 0, 0).due_at, 1_000);
        let now_ms = 1_700_000_000_000;
        let later = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_millis(1_700_000_040_000));
        assert_eq!(settle(&answered(503, Some(&later)), 0, now_ms).due_at, now_ms + 40_000);
        let earlier = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_millis(1_600_000_000_000));
        assert_eq!(settle(&answered(503, Some(&earlier)), 0, now_ms).due_at, now_ms + 1_000);
    }

    #[test]
    fn records_no_address_in_an_error() {
        for outcome in [Outcome::Unreachable, Outcome::TimedOut] {
            let settled = settle(&Attempted::Sent(outcome), 0, 0);
            assert!(settled.error.is_some_and(|error| !error.contains("127.") && !error.contains(':')));
        }
    }

    #[test]
    fn signs_the_time_and_the_body() {
        let signed = signature("secret", 1_700_000_000, b"{}").unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(b"1700000000.{}");
        let expected = hex::encode(mac.finalize().into_bytes());
        assert_eq!(signed, format!("t=1700000000,v1={expected}"));
    }
}
