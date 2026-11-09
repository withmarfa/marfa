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
    FAIL_JOB_ROW, HOLD_JOB_BETWEEN_CHUNKS, HOLD_JOB_CLAIMED, HOLD_JOB_IN_CHUNK,
};
use crate::app::items::write::apply_row;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types;
use crate::app::unit::Unit;
use crate::db::io_refusal;

const CHUNK: i64 = 100;
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
    /// A fault the job could not even record: it is tried again at the next wake.
    Stalled,
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

async fn run(app: &Arc<App>) {
    let mut stalled = false;
    loop {
        if app.jobs.stopping() {
            return;
        }
        let woken = app.jobs.wake.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        let next = if stalled {
            None
        } else {
            match app.db.read(store::next_open).await {
                Ok(next) => next,
                Err(_) if app.jobs.stopping() => return,
                Err(refusal) => {
                    tracing::error!(code = refusal.code.wire(), "Bulk-action jobs could not be read");
                    None
                }
            }
        };
        match next {
            Some(id) => match run_job(app, &id).await {
                Ran::Done => {}
                Ran::Stalled => stalled = true,
                Ran::Stopped => return,
            },
            None => {
                woken.await;
                stalled = false;
            }
        }
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
        Err(refusal) => return stalled(&refusal),
    }
    app.faults.hold(HOLD_JOB_CLAIMED, None).await;
    loop {
        if app.jobs.closed() {
            return Ran::Stopped;
        }
        let offset = match checkpoint(app, id).await {
            Ok(Some(offset)) => offset,
            Ok(None) => return Ran::Done,
            Err(_) if app.jobs.stopping() => return Ran::Stopped,
            Err(refusal) => return stalled(&refusal),
        };
        let written = patiently(app, || chunk(app, id)).await;
        let next = match written {
            Ok(next) => next,
            Err(_) if app.jobs.stopping() => return Ran::Stopped,
            Err(refusal) => match patiently(app, || lost_chunk(app, id, offset, &refusal)).await {
                Ok(next) => next,
                Err(_) if app.jobs.stopping() => return Ran::Stopped,
                Err(refusal) => return stalled(&refusal),
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
    if app.jobs.closed() {
        return Ran::Stopped;
    }
    match patiently(app, || finish(app, id)).await {
        Ok(()) => Ran::Done,
        Err(_) if app.jobs.stopping() => Ran::Stopped,
        Err(refusal) => stalled(&refusal),
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

fn stalled(refusal: &Refusal) -> Ran {
    tracing::error!(
        code = refusal.code.wire(),
        sqlite_code = refusal.database_code(),
        "A bulk-action job could not go on; it is tried again when the next job is queued"
    );
    Ran::Stalled
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

fn error_entry(id: &str, refusal: &Refusal) -> Value {
    let message = match refusal.database_code() {
        Some(code) => format!("Database operation failed ({code})"),
        None => refusal.message.to_string(),
    };
    let mut entry = json!({ "id": id, "code": refusal.code.wire(), "message": message });
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

fn record_chunk(
    unit: &Unit<'_, '_>,
    job: &Job,
    to: i64,
    tally: &Tally,
) -> Result<Chunk> {
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
        let ids = store::slice(tx, &id, job.processed, CHUNK)?;
        if ids.is_empty() {
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
            for item in &ids {
                if store::noted(tx, &id, Note::Carried, item)? {
                    tally.changed(tx, &id, item)?;
                    continue;
                }
                if faults.fail(FAIL_JOB_ROW, None) {
                    return Err(io_refusal());
                }
                tx.execute_batch(SAVEPOINT)?;
                match apply_row(held, &catalog, &read_only, item, &act) {
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
        let to = job.processed + ids.len() as i64;
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
        let ids = store::slice(tx, &id, job.processed, CHUNK)?;
        let mut tally = Tally {
            succeeded: job.succeeded,
            errored: job.errored,
        };
        for item in &ids {
            tally.refused(tx, &id, &error_entry(item, &cause))?;
        }
        let held = unit.for_holder(caller, true);
        record_chunk(&held, &job, job.processed + ids.len() as i64, &tally)
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
        store::end(tx, &id, COMPLETED, &unit.at, None, Some(&Value::Object(result)))?;
        Ok(())
    })
    .await
}
