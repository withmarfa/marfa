//! Jobs that remove what has aged out of a log, one bounded write at a time, so a request
//! is never held behind a whole run.

use std::future::Future;
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::json;

use super::super::access::Caller;
use super::super::keys::reap;
use super::super::refusal::Result;
use super::super::{App, audit, events, idempotency, oauth, webhooks};
use super::{DAY_MS, HOUR_MS, Report, Run, cutoff};
use crate::db::Write;
use crate::settings::registry::{AUDIT_RETENTION_DAYS, EVENT_LOG_RETENTION_HOURS, Setting};

const BATCH: i64 = 1_000;

pub async fn drain<F, W>(run: &Run, batch: i64, mut step: F) -> Result<(i64, bool)>
where
    F: FnMut() -> W,
    W: Future<Output = Result<i64>>,
{
    let mut taken = 0;
    loop {
        let more = step().await?;
        taken += more;
        if more < batch {
            return Ok((taken, true));
        }
        if !run.go_on().await {
            return Ok((taken, false));
        }
    }
}

/// Nothing is audited of this, so it is the server's own write.
async fn expire(
    app: &Arc<App>,
    retention: Setting<u64>,
    unit_ms: i64,
    remove: fn(&Transaction<'_>, &str, i64) -> Result<i64>,
) -> Result<i64> {
    let live = app.clone();
    app.db
        .write(Write::own(), move |tx| {
            match cutoff(&live, retention, unit_ms) {
                Some(before) => remove(tx, &before, BATCH),
                None => Ok(0),
            }
        })
        .await
}

/// The log keeps what the webhook sender has not yet passed.
fn expire_events(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    events::expire(tx, before, limit, webhooks::scheduled_through(tx)?)
}

pub async fn event_log(app: Arc<App>, run: Run) -> Result<Report> {
    let (purged_records, records_done) = drain(&run, BATCH, || {
        expire(
            &app,
            EVENT_LOG_RETENTION_HOURS,
            HOUR_MS,
            idempotency::expire,
        )
    })
    .await?;
    let (deleted, events_done) = drain(&run, BATCH, || {
        expire(&app, EVENT_LOG_RETENTION_HOURS, HOUR_MS, expire_events)
    })
    .await?;
    Ok(Report {
        result: json!({ "deleted": deleted, "purged_records": purged_records }),
        again: !(records_done && events_done),
    })
}

pub async fn audit(app: Arc<App>, run: Run) -> Result<Report> {
    let (deleted, entries_done) = drain(&run, BATCH, || {
        expire(&app, AUDIT_RETENTION_DAYS, DAY_MS, audit::expire)
    })
    .await?;
    let (deliveries, deliveries_done) = drain(&run, BATCH, || {
        expire(
            &app,
            AUDIT_RETENTION_DAYS,
            DAY_MS,
            webhooks::expire_deliveries,
        )
    })
    .await?;
    Ok(Report {
        result: json!({ "deleted": deleted, "deliveries": deliveries }),
        again: !(entries_done && deliveries_done),
    })
}

async fn reap_batch(app: &Arc<App>) -> Result<i64> {
    let before = app.clock.stamp_ago(reap::KEPT_DAYS * DAY_MS);
    let seen = before.clone();
    if !app.db.read(move |tx| reap::any(tx, &seen)).await? {
        return Ok(0);
    }
    app.write(&Caller::Server, "keys.purged", move |unit| {
        let count = reap::remove(unit.tx(), &before, BATCH)?;
        if count > 0 {
            unit.audit_set("key", Some(json!({ "count": count, "cutoff": before })))?;
        }
        Ok(count)
    })
    .await
}

async fn revoked_keys(app: &Arc<App>, run: &Run) -> Result<(i64, bool)> {
    drain(run, BATCH, || reap_batch(app)).await
}

#[derive(Default)]
struct Tally {
    deleted: i64,
    retired: i64,
}

impl Tally {
    fn deleted(&mut self, (count, done): (i64, bool)) -> bool {
        self.deleted += count;
        done
    }

    fn retired(&mut self, (count, done): (i64, bool)) -> bool {
        self.retired += count;
        done
    }
}

/// Grants retire before the purge, and clients go only after the grants that kept them.
pub async fn credentials(app: Arc<App>, run: Run) -> Result<Report> {
    let mut tally = Tally::default();
    let done = tally.deleted(oauth::sweep::sweep_expired(&app, &run).await?)
        && tally.retired(oauth::sweep::retire_idle_grants(&app, &run).await?)
        && tally.deleted(oauth::sweep::purge_withdrawn_grants(&app, &run).await?)
        && tally.deleted(oauth::sweep::remove_idle_clients(&app, &run).await?)
        && tally.deleted(revoked_keys(&app, &run).await?);
    Ok(Report {
        result: json!({ "deleted": tally.deleted, "retired": tally.retired }),
        again: !done,
    })
}
