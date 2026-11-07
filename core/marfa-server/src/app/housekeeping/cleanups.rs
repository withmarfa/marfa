//! The jobs that remove what has aged out of a log, one bounded write at a time,
//! so that a request is never held behind a whole run.

use std::future::Future;
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::json;

use super::super::access::Caller;
use super::super::keys::reap;
use super::super::refusal::Result;
use super::super::{App, audit, events, idempotency};
use super::{DAY_MS, HOUR_MS, Report, Run, cutoff};
use crate::db::Write;
use crate::settings::registry::{
    AUDIT_RETENTION_DAYS, EVENT_LOG_RETENTION_HOURS, RATE_LIMIT_WINDOW_MS, Setting,
};

/// Rows one write removes.
const BATCH: i64 = 1_000;

/// Repeats `step`, which answers how many rows it took of a batch of `batch`,
/// until one takes less. Answers the rows taken, and whether it got to the end
/// rather than being told to stop between two batches.
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

/// One batch of a log the server keeps for itself, by the retention as it
/// stands when the write runs. Nothing is audited of this, so it is the
/// server's own write.
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

pub async fn event_log(app: Arc<App>, run: Run) -> Result<Report> {
    let (purged_records, records_done) = drain(&run, BATCH, || {
        expire(&app, EVENT_LOG_RETENTION_HOURS, HOUR_MS, idempotency::expire)
    })
    .await?;
    let (deleted, events_done) = drain(&run, BATCH, || {
        expire(&app, EVENT_LOG_RETENTION_HOURS, HOUR_MS, events::expire)
    })
    .await?;
    Ok(Report {
        result: json!({ "deleted": deleted, "purged_records": purged_records }),
        again: !(records_done && events_done),
    })
}

pub async fn audit(app: Arc<App>, run: Run) -> Result<Report> {
    let (deleted, done) = drain(&run, BATCH, || {
        expire(&app, AUDIT_RETENTION_DAYS, DAY_MS, audit::expire)
    })
    .await?;
    Ok(Report {
        result: json!({ "deleted": deleted }),
        again: !done,
    })
}

/// The only limiter so far is the one in memory that `/keys` shares.
pub async fn rate_limit(app: Arc<App>, _run: Run) -> Result<Report> {
    let window_ms = app.settings.live().get(RATE_LIMIT_WINDOW_MS);
    let deleted = app.key_limit.sweep(app.clock.now_ms(), window_ms);
    Ok(Report::done(json!({ "deleted": deleted })))
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
