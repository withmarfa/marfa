//! Delivery creation and position advancement commit together to prevent duplicates.

use rusqlite::Transaction;

use super::selects;
use super::store::{self, Queued, Subscription};
use crate::app::access::{Caller, standing_maker};
use crate::app::catalog::Catalog;
use crate::app::connectors::ReadOnly;
use crate::app::events::fanout::{self, Logged};
use crate::app::events::{Filter, Judge, Judged};
use crate::app::faults::{Faults, HOLD_WEBHOOK_SCHEDULE_QUEUED};
use crate::app::refusal::Result;
use crate::db::Pulse;

/// Bounds each write transaction when crossing a backlog.
const PAGE: usize = 2_000;

/// A place the log cannot account for. Nothing past it is queued until it can.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gap {
    Missing,
    Ahead,
    Crossed,
}

impl Gap {
    pub fn describe(self) -> &'static str {
        match self {
            Gap::Missing => "The webhook sender's place in the event log is missing",
            Gap::Ahead => "The webhook sender's place in the event log is ahead of the log",
            Gap::Crossed => {
                "The event log lacks an event between the webhook sender's place and the log's newest event"
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Pass {
    Caught,
    More,
    Stuck { gap: Gap, at: Option<i64> },
}

pub struct Context<'a> {
    pub catalog: &'a Catalog,
    pub read_only: &'a ReadOnly,
    pub faults: &'a Faults,
    pub pulse: &'a Pulse,
    pub at: &'a str,
    pub now_ms: i64,
}

struct Entitled {
    subscription: Subscription,
    caller: Caller,
}

/// Subscription filters apply separately from the credential's access checks.
pub(super) const UNFILTERED: Filter = Filter {
    types: Vec::new(),
    edges: true,
    copy: false,
};

fn hidden(faults: &Faults, id: i64) -> bool {
    faults
        .hidden_events()
        .is_some_and(|(first, last)| (first..=last).contains(&id))
}

/// The newest id the log holds, as a `hide:event` fault leaves it.
fn newest(tx: &Transaction<'_>, faults: &Faults) -> Result<i64> {
    let newest = fanout::newest(tx)?;
    Ok(match faults.hidden_events() {
        Some((first, last)) if (first..=last).contains(&newest) => first.saturating_sub(1),
        _ => newest,
    })
}

fn hidden_between(faults: &Faults, after: i64, through: i64) -> i64 {
    faults.hidden_events().map_or(0, |(first, last)| {
        (last.min(through) - first.max(after + 1) + 1).max(0)
    })
}

/// Whether a pass has anything to do, read without taking the writer.
pub fn behind(tx: &Transaction<'_>, faults: &Faults) -> Result<bool> {
    if faults.hides_position() {
        return Ok(true);
    }
    Ok(match store::position(tx)? {
        None => true,
        Some(position) => position != newest(tx, faults)?,
    })
}

pub fn pass(tx: &Transaction<'_>, context: &Context<'_>) -> Result<Pass> {
    let faults = context.faults;
    let newest = newest(tx, faults)?;
    let position = if faults.hides_position() {
        None
    } else {
        store::position(tx)?
    };
    let Some(position) = position else {
        return Ok(Pass::Stuck {
            gap: Gap::Missing,
            at: None,
        });
    };
    if position > newest {
        return Ok(Pass::Stuck {
            gap: Gap::Ahead,
            at: Some(position),
        });
    }
    if position == newest {
        return Ok(Pass::Caught);
    }
    let entitled = entitled(tx, context.at)?;
    if entitled.is_empty() {
        let held =
            fanout::held_between(tx, position, newest)? - hidden_between(faults, position, newest);
        if held == newest - position {
            store::set_position(tx, newest)?;
            return Ok(Pass::Caught);
        }
    }
    let mut reached = position;
    let mut read = 0;
    let mut crossed = false;
    let mut queued = 0;
    fanout::walk(tx, position, PAGE, |logged| {
        read += 1;
        if hidden(faults, logged.id) {
            return Ok(true);
        }
        if logged.id != reached + 1 {
            crossed = true;
            return Ok(false);
        }
        reached = logged.id;
        if logged.fanout {
            queued += queue(tx, context, &entitled, logged)?;
        }
        Ok(true)
    })?;
    if reached > position {
        store::set_position(tx, reached)?;
    }
    if queued > 0 {
        faults.hold_beating(HOLD_WEBHOOK_SCHEDULE_QUEUED, context.pulse);
    }
    Ok(if crossed {
        Pass::Stuck {
            gap: Gap::Crossed,
            at: Some(reached),
        }
    } else if read == PAGE {
        Pass::More
    } else {
        Pass::Caught
    })
}

/// Active subscriptions whose credential stands and manages webhooks, judged once a pass.
fn entitled(tx: &Transaction<'_>, at: &str) -> Result<Vec<Entitled>> {
    let mut entitled = Vec::new();
    for subscription in store::active(tx)? {
        let Some(caller) = standing_maker(tx, &subscription.maker, at)? else {
            continue;
        };
        entitled.push(Entitled {
            subscription,
            caller,
        });
    }
    Ok(entitled)
}

fn queue(
    tx: &Transaction<'_>,
    context: &Context<'_>,
    entitled: &[Entitled],
    logged: &Logged<'_, '_>,
) -> Result<usize> {
    let head = logged.head();
    let mut payload: Option<String> = None;
    let mut queued = 0;
    for each in entitled {
        let subscription = &each.subscription;
        if logged.id <= subscription.starts_after
            || !selects(
                subscription,
                &context.catalog.rules,
                &logged.event_type,
                &logged.type_id,
            )
        {
            continue;
        }
        let judge = Judge {
            caller: &each.caller,
            rules: &context.catalog.rules,
            read_only: context.read_only,
            filter: &UNFILTERED,
        };
        let Some(kind) = judge.wants(&head) else {
            continue;
        };
        let payload = match &payload {
            Some(payload) => payload,
            None => payload.insert(logged.payload()?),
        };
        match judge.judged(&head, kind, payload)? {
            Judged::Shown(_) => {}
            Judged::Withheld => continue,
            Judged::Unreadable => {
                tracing::error!(
                    event_id = logged.id,
                    "A logged event does not read, and is sent to no webhook"
                );
                continue;
            }
        }
        let id = uuid::Uuid::now_v7().to_string();
        let added = store::queue(
            tx,
            &Queued {
                id: &id,
                webhook_id: &subscription.id,
                event_id: logged.id,
                event_type: &logged.event_type,
                type_id: &logged.type_id,
                source: &logged.source,
                payload,
                due_at: context.now_ms,
                at: context.at,
            },
        )?;
        queued += usize::from(added);
    }
    Ok(queued)
}
