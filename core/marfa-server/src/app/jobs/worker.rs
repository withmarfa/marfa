use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::store::{self, Job, Note};
use super::{Action, COMPLETED, FAILED, LISTED, gathered};
use crate::app::App;
use crate::app::access::{Caller, standing_holder};
use crate::app::catalog::{self, Snapshot};
use crate::app::faults::{
    FAIL_JOB_ROW, HOLD_JOB_BETWEEN_CHUNKS, HOLD_JOB_CLAIMED, HOLD_JOB_FINISHING, HOLD_JOB_IN_CHUNK,
};
use crate::app::items::write::apply_row;
use crate::app::items::{self, Selected};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types;
use crate::app::unit::Unit;
use crate::db::io_refusal;

const CHUNK: i64 = 100;
/// A chunk holds the writer while it runs, so it ends once its items weigh this many bytes.
const CHUNK_BYTES: i64 = 512 * 1024;
const TRIES: u32 = 5;
const FIRST_RETRY: Duration = Duration::from_millis(250);
const BUSY_PAUSE: Duration = Duration::from_millis(50);
const SAVEPOINT: &str = "SAVEPOINT job_row";
const RELEASE: &str = "RELEASE job_row";
const UNDO: &str = "ROLLBACK TO job_row; RELEASE job_row";

const NO_LONGER_AUTHENTICATES: &str = "The credential that queued this job no longer \
     authenticates, so the job wrote nothing further.";
const NO_LONGER_PURGES: &str = "The credential that queued this job no longer holds \
     items.purge, so the job purged nothing further.";

enum Ran {
    Done,
    /// A fault stopped the job at checkpoint `at`; it is tried again from there after a pause.
    Stalled {
        cause: Refusal,
        at: Option<i64>,
    },
    Stopped,
}

enum Chunk {
    More,
    Last,
    Ended,
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    app.jobs.running.send_replace(true);
    tokio::spawn(async move {
        run(&app).await;
        app.jobs.running.send_replace(false);
    });
}

/// The pause before try `tries + 1`, doubling from `FIRST_RETRY`.
fn backoff(tries: u32) -> Duration {
    FIRST_RETRY * 2u32.pow(tries.clamp(1, TRIES) - 1)
}

async fn run(app: &Arc<App>) {
    let mut stalled: Option<(String, Option<i64>, u32)> = None;
    let mut unread = 0;
    loop {
        if app.jobs.stopping() {
            return;
        }
        let woken = app.jobs.wake.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        let next = match app.db.read(store::next_open).await {
            Ok(next) => next,
            Err(_) if app.jobs.stopping() => return,
            Err(refusal) => {
                tracing::error!(
                    code = refusal.code.wire(),
                    "Bulk-action jobs could not be read"
                );
                unread += 1;
                if unread < TRIES {
                    pause(woken, backoff(unread)).await;
                } else {
                    woken.await;
                }
                continue;
            }
        };
        unread = 0;
        let Some(id) = next else {
            woken.await;
            continue;
        };
        match run_job(app, &id).await {
            Ran::Done => stalled = None,
            Ran::Stopped => return,
            Ran::Stalled { cause, at } => {
                let tries = match &stalled {
                    Some((held, was, tries)) if *held == id && *was == at => tries + 1,
                    _ => 1,
                };
                if tries >= TRIES {
                    match patiently(app, || give_up(app, &id, &cause)).await {
                        Ok(()) => {
                            stalled = None;
                            continue;
                        }
                        Err(_) if app.jobs.stopping() => return,
                        Err(refusal) => {
                            stalled_by(&refusal, at);
                        }
                    }
                }
                stalled = Some((id, at, tries));
                pause(woken, backoff(tries)).await;
            }
        }
    }
}

/// Waits out `pause`, or less if a door wakes the worker.
async fn pause(woken: std::pin::Pin<&mut tokio::sync::futures::Notified<'_>>, pause: Duration) {
    tokio::select! {
        () = woken => {}
        () = tokio::time::sleep(pause) => {}
    }
}

/// A write the writer could not take in time is tried again; any other refusal is the answer.
async fn patiently<T, F, W>(app: &App, mut attempt: F) -> Result<T>
where
    F: FnMut() -> W,
    W: Future<Output = Result<T>>,
{
    loop {
        match attempt().await {
            Err(refusal) if refusal.code == Code::WriteContention && !app.jobs.stopping() => {
                tokio::time::sleep(BUSY_PAUSE).await;
            }
            answered => return answered,
        }
    }
}

async fn run_job(app: &Arc<App>, id: &str) -> Ran {
    let claimed = patiently(app, || claim(app, id)).await;
    match claimed {
        Ok(true) => {}
        Ok(false) => return Ran::Done,
        Err(_) if app.jobs.stopping() => return Ran::Stopped,
        Err(refusal) => return stalled_by(&refusal, None),
    }
    app.faults.hold(HOLD_JOB_CLAIMED, None).await;
    let mut reached = None;
    loop {
        if app.jobs.closed() {
            return Ran::Stopped;
        }
        let offset = match checkpoint(app, id).await {
            Ok(Some(offset)) => offset,
            Ok(None) => return Ran::Done,
            Err(_) if app.jobs.stopping() => return Ran::Stopped,
            Err(refusal) => return stalled_by(&refusal, reached),
        };
        reached = Some(offset);
        let written = patiently(app, || chunk(app, id)).await;
        let next = match written {
            Ok(next) => next,
            Err(_) if app.jobs.stopping() => return Ran::Stopped,
            Err(refusal) => match patiently(app, || lost_chunk(app, id, offset, &refusal)).await {
                Ok(next) => next,
                Err(_) if app.jobs.stopping() => return Ran::Stopped,
                Err(refusal) => return stalled_by(&refusal, Some(offset)),
            },
        };
        match next {
            Chunk::More => {
                app.faults.hold(HOLD_JOB_BETWEEN_CHUNKS, None).await;
                tokio::task::yield_now().await;
            }
            Chunk::Last => break,
            Chunk::Ended => return Ran::Done,
        }
    }
    app.faults.hold(HOLD_JOB_FINISHING, None).await;
    if app.jobs.closed() {
        return Ran::Stopped;
    }
    match patiently(app, || finish(app, id)).await {
        Ok(()) => Ran::Done,
        Err(_) if app.jobs.stopping() => Ran::Stopped,
        Err(refusal) => stalled_by(&refusal, reached),
    }
}

async fn claim(app: &App, id: &str) -> Result<bool> {
    let id = id.to_string();
    app.write(&Caller::Server, "items.bulk_action.claim", move |unit| {
        store::claim(unit.tx(), &id, &unit.at)?;
        Ok(store::by_id(unit.tx(), &id)?.is_some_and(|job| job.status == store::RUNNING))
    })
    .await
}

fn stalled_by(refusal: &Refusal, at: Option<i64>) -> Ran {
    tracing::error!(
        code = refusal.code.wire(),
        sqlite_code = refusal.database_code(),
        "A bulk-action job could not go on; it is tried again from its checkpoint"
    );
    Ran::Stalled {
        cause: refusal.clone(),
        at,
    }
}

/// Ends a job that met a fault on every try, with what it had done.
async fn give_up(app: &App, id: &str, cause: &Refusal) -> Result<()> {
    let id = id.to_string();
    let reason = format!(
        "The job met a fault each time it was tried, so it wrote nothing further: {}.",
        cause_of(cause)
    );
    app.write(&Caller::Server, "items.bulk_action.fail", move |unit| {
        let tx = unit.tx();
        match store::by_id(tx, &id)?.filter(store::Job::is_open) {
            Some(job) => fail(tx, &job, &reason, &unit.at),
            None => Ok(()),
        }
    })
    .await
}

fn standing(unit: &Unit<'_, '_>, id: &str) -> Result<Option<(Job, Caller)>> {
    let tx = unit.tx();
    let Some(job) = store::by_id(tx, id)?.filter(|job| job.status == store::RUNNING) else {
        return Ok(None);
    };
    let reason = match standing_holder(tx, &job.holder, &unit.at)? {
        None => NO_LONGER_AUTHENTICATES,
        Some(caller) if job.queued.action.purges() && !caller.purges() => NO_LONGER_PURGES,
        Some(caller) => return Ok(Some((job, caller))),
    };
    fail(tx, &job, reason, &unit.at)?;
    Ok(None)
}

fn fail(tx: &Transaction<'_>, job: &Job, reason: &str, at: &str) -> Result<()> {
    let result = Value::Object(gathered(tx, job)?);
    store::end(tx, &job.id, FAILED, at, Some(reason), Some(&result))
}

fn cause_of(refusal: &Refusal) -> String {
    match refusal.database_code() {
        Some(code) => format!("Database operation failed ({code})"),
        None => refusal.message.to_string(),
    }
}

fn error_entry(id: &str, refusal: &Refusal) -> Value {
    let mut entry = json!({ "id": id, "code": refusal.code.wire(), "message": cause_of(refusal) });
    if let Some(details) = &refusal.details {
        entry["details"] = Value::Object((**details).clone());
    }
    entry
}

/// A refusal that is a verdict on the row, not a fault of the transaction.
fn refuses_row(refusal: &Refusal) -> bool {
    !refusal.commit_failed && refusal.code.status() < 500 && refusal.code != Code::Unauthorized
}

struct Tally {
    succeeded: i64,
    errored: i64,
}

impl Tally {
    fn changed(&mut self, tx: &Transaction<'_>, job: &str, item: &str) -> Result<()> {
        if self.succeeded <= LISTED {
            store::note(tx, job, Note::Changed, item, None)?;
        }
        self.succeeded += 1;
        Ok(())
    }

    fn refused(&mut self, tx: &Transaction<'_>, job: &str, entry: &Value) -> Result<()> {
        if self.errored < LISTED
            && let Some(item) = entry["id"].as_str()
        {
            store::note(tx, job, Note::Error, item, Some(&entry.to_string()))?;
        }
        self.errored += 1;
        Ok(())
    }
}

fn record_chunk(unit: &Unit<'_, '_>, job: &Job, to: i64, tally: &Tally) -> Result<Chunk> {
    store::advance(unit.tx(), &job.id, to, tally.succeeded, tally.errored)?;
    unit.audit_summary(
        "items.bulk_action.chunk",
        "items.bulk_action",
        &job.id,
        Some(json!({
            "sub_action": job.queued.action.name(),
            "from_offset": job.processed,
            "to_offset": to,
            "succeeded_total": tally.succeeded,
            "errored_total": tally.errored,
        })),
    )?;
    Ok(if to < job.matched {
        Chunk::More
    } else {
        Chunk::Last
    })
}

/// Only the worker moves a checkpoint, so this is where the next chunk starts.
async fn checkpoint(app: &App, id: &str) -> Result<Option<i64>> {
    let id = id.to_string();
    app.db
        .read(move |tx| Ok(store::by_id(tx, &id)?.map(|job| job.processed)))
        .await
}

async fn chunk(app: &App, id: &str) -> Result<Chunk> {
    let id = id.to_string();
    let cache = app.catalog_handle();
    let faults = app.faults.clone();
    let pulse = app.db.pulse();
    app.write(&Caller::Server, "items.bulk_action.chunk", move |unit| {
        let Some((job, caller)) = standing(unit, &id)? else {
            return Ok(Chunk::Ended);
        };
        let tx = unit.tx();
        let items = planned(tx, &job)?;
        if items.is_empty() {
            return Ok(Chunk::Last);
        }
        let held = unit.for_holder(caller, true);
        let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
        let read_only = held.read_only()?;
        let act = job.queued.action.row();
        let mut tally = Tally {
            succeeded: job.succeeded,
            errored: job.errored,
        };
        held.fanning(job.queued.fanout, |held| {
            for selected in &items {
                let item = selected.id.as_str();
                if store::noted(tx, &id, Note::Carried, item)? {
                    tally.changed(tx, &id, item)?;
                    continue;
                }
                if faults.fail(FAIL_JOB_ROW, None) {
                    return Err(io_refusal());
                }
                tx.execute_batch(SAVEPOINT)?;
                match apply_row(held, &catalog, &read_only, selected, &act) {
                    Ok(done) => {
                        tx.execute_batch(RELEASE)?;
                        for carried in &done.carried {
                            store::note(tx, &id, Note::Carried, carried, None)?;
                        }
                        for blob in &done.blobs {
                            store::note(tx, &id, Note::Blob, blob, None)?;
                        }
                        tally.changed(tx, &id, item)?;
                    }
                    Err(refusal) if refuses_row(&refusal) => {
                        tx.execute_batch(UNDO)?;
                        tally.refused(tx, &id, &error_entry(item, &refusal))?;
                    }
                    Err(refusal) => return Err(refusal),
                }
                pulse.tick();
            }
            Ok(())
        })?;
        let to = job.processed + items.len() as i64;
        let next = record_chunk(&held, &job, to, &tally)?;
        faults.hold_beating(HOLD_JOB_IN_CHUNK, &pulse);
        Ok(next)
    })
    .await
}

/// Check the checkpoint before recording a failed commit's rows as unwritten.
async fn lost_chunk(app: &App, id: &str, offset: i64, cause: &Refusal) -> Result<Chunk> {
    let id = id.to_string();
    let cause = cause.clone();
    app.write(&Caller::Server, "items.bulk_action.chunk", move |unit| {
        let Some((job, caller)) = standing(unit, &id)? else {
            return Ok(Chunk::Ended);
        };
        if job.processed != offset {
            return Ok(if job.processed < job.matched {
                Chunk::More
            } else {
                Chunk::Last
            });
        }
        let tx = unit.tx();
        let items = planned(tx, &job)?;
        let mut tally = Tally {
            succeeded: job.succeeded,
            errored: job.errored,
        };
        for item in &items {
            tally.refused(tx, &id, &error_entry(&item.id, &cause))?;
        }
        let held = unit.for_holder(caller, true);
        record_chunk(&held, &job, job.processed + items.len() as i64, &tally)
    })
    .await
}

async fn finish(app: &App, id: &str) -> Result<()> {
    let id = id.to_string();
    let cache = app.catalog_handle();
    app.write(&Caller::Server, "items.bulk_action.finish", move |unit| {
        let Some((job, caller)) = standing(unit, &id)? else {
            return Ok(());
        };
        let tx = unit.tx();
        let mut result = gathered(tx, &job)?;
        if let Action::TypeMove { from, to, .. } = &job.queued.action {
            let held = unit.for_holder(caller, false);
            types::finish_move(&held, &cache, from, to, &mut result)?;
        }
        store::end(
            tx,
            &id,
            COMPLETED,
            &unit.at,
            None,
            Some(&Value::Object(result)),
        )?;
        Ok(())
    })
    .await
}

/// The items the job's next chunk takes: up to `CHUNK`, ending once they weigh `CHUNK_BYTES`.
fn planned(tx: &Transaction<'_>, job: &Job) -> Result<Vec<Selected>> {
    let mut items = store::slice(tx, &job.id, job.processed, CHUNK)?;
    let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let weights = items::weights(tx, &ids, job.queued.action.purges())?;
    items.truncate(taken(&weights, CHUNK_BYTES));
    Ok(items)
}

/// How many of the items, in order, a chunk takes: always the first, then each that keeps the
/// chunk within `budget`.
fn taken(weights: &[i64], budget: i64) -> usize {
    let mut total = 0i64;
    weights
        .iter()
        .enumerate()
        .take_while(|(at, weight)| {
            total = total.saturating_add(**weight);
            *at == 0 || total <= budget
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::taken;

    #[test]
    fn a_chunk_ends_once_its_items_weigh_the_budget_and_always_takes_one() {
        assert_eq!(taken(&[], 10), 0);
        assert_eq!(taken(&[1, 2, 3], 10), 3);
        assert_eq!(taken(&[4, 4, 4], 10), 2);
        assert_eq!(taken(&[50, 1], 10), 1);
        assert_eq!(taken(&[1, 50, 1], 10), 1);
        assert_eq!(taken(&[i64::MAX, i64::MAX], 10), 1);
    }
}
