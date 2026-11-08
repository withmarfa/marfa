//! Jobs that remove what has aged out of a log, one bounded write at a time, so a request
//! is never held behind a whole run.

use std::future::Future;
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::json;

use super::super::access::Caller;
use super::super::auth::limits;
use super::super::keys::reap;
use super::super::refusal::Result;
use super::super::{App, audit, events, idempotency, webhooks};
use super::{DAY_MS, HOUR_MS, Report, Run, cutoff};
use crate::db::Write;
use crate::settings::registry::{
    AUDIT_RETENTION_DAYS, EVENT_LOG_RETENTION_HOURS, RATE_LIMIT_WINDOW_MS, Setting,
};

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
        expire(&app, AUDIT_RETENTION_DAYS, DAY_MS, webhooks::expire_deliveries)
    })
    .await?;
    Ok(Report {
        result: json!({ "deleted": deleted, "deliveries": deliveries }),
        again: !(entries_done && deliveries_done),
    })
}

async fn ended_windows(app: &Arc<App>) -> Result<i64> {
    let now_ms = app.clock.now_ms();
    app.db
        .write(Write::own(), move |tx| {
            limits::remove_expired(tx, now_ms, BATCH)
        })
        .await
}

pub async fn rate_limit(app: Arc<App>, run: Run) -> Result<Report> {
    let window_ms = app.settings.live().get(RATE_LIMIT_WINDOW_MS);
    let swept = app.key_limit.sweep(app.clock.now_ms(), window_ms);
    let (deleted, done) = drain(&run, BATCH, || ended_windows(&app)).await?;
    Ok(Report {
        result: json!({ "deleted": i64::try_from(swept).unwrap_or(i64::MAX) + deleted }),
        again: !done,
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

pub async fn revoked_keys(app: Arc<App>, run: Run) -> Result<Report> {
    let (deleted, done) = drain(&run, BATCH, || reap_batch(&app)).await?;
    Ok(Report {
        result: json!({ "deleted": deleted }),
        again: !done,
    })
}
