//! Bulk actions and type moves: work that outlasts a request, run by one worker in chunks. Each
//! chunk is one transaction that writes its rows through the items' write function and moves the
//! job's checkpoint, so a job a stop or a crash cuts off resumes at its next row.

mod store;
mod worker;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, watch};
use uuid::Uuid;

use super::App;
use super::access::Caller;
use super::faults::HOLD_JOB_SELECTED;
use super::housekeeping::{DAY_MS, Report, Run};
use super::idempotency::{self, Claim, Need};
use super::items::write::RowAct;
use super::query::{self, Ask};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use crate::db::Write;

pub use store::{CANCELED, COMPLETED, FAILED};
pub use worker::start;

/// Finished jobs are read for a week, then removed.
const KEPT_DAYS: i64 = 7;
const GC_BATCH: i64 = 500;
/// A job lists at most this many of the items it changed and refused.
pub const LISTED: i64 = 100;
const CUT_BEFORE_END: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    Transition {
        state: String,
    },
    Purge,
    UpdateTags {
        add: Vec<String>,
        remove: Vec<String>,
    },
    UpdateTier {
        tier: String,
    },
    UpdateProperties {
        patch: Map<String, Value>,
    },
    UpdateOccurredAt {
        occurred_at: String,
    },
    TypeMove {
        from: String,
        to: String,
        properties: Option<Map<String, Value>>,
    },
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::Transition { .. } => "transition",
            Action::Purge => "purge",
            Action::UpdateTags { .. } => "update_tags",
            Action::UpdateTier { .. } => "update_tier",
            Action::UpdateProperties { .. } => "update_properties",
            Action::UpdateOccurredAt { .. } => "update_occurred_at",
            Action::TypeMove { .. } => "type_move",
        }
    }

    fn row(&self) -> RowAct {
        match self {
            Action::Transition { state } => RowAct::Transition(state.clone()),
            Action::Purge => RowAct::Purge,
            Action::UpdateTags { add, remove } => RowAct::Tags {
                add: add.clone(),
                remove: remove.clone(),
            },
            Action::UpdateTier { tier } => RowAct::Tier(tier.clone()),
            Action::UpdateProperties { patch } => RowAct::Properties(patch.clone()),
            Action::UpdateOccurredAt { occurred_at } => RowAct::OccurredAt(occurred_at.clone()),
            Action::TypeMove { to, properties, .. } => RowAct::Retype {
                to: to.clone(),
                properties: properties.clone(),
            },
        }
    }

    pub fn purges(&self) -> bool {
        matches!(self, Action::Purge)
    }
}

/// What a job was queued to do, kept unchanged from the request that queued it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Queued {
    #[serde(flatten)]
    pub action: Action,
    pub fanout: bool,
}

/// A bulk action as its request asks for it.
#[derive(Debug)]
pub struct Asked {
    pub action: Action,
    pub ask: Ask,
    pub cap: i64,
    pub expected: Option<Vec<String>>,
    pub dry_run: bool,
    pub fanout: bool,
}

/// The worker's state, shared with the doors that wake it and the stop that waits for it.
#[derive(Debug)]
pub struct Jobs {
    wake: Notify,
    stopping: AtomicBool,
    closed: AtomicBool,
    running: watch::Sender<bool>,
}

impl Default for Jobs {
    fn default() -> Jobs {
        Jobs {
            wake: Notify::new(),
            stopping: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            running: watch::Sender::new(false),
        }
    }
}

impl Jobs {
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// The worker finishes the job it holds and takes no other.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// A job still running a moment before `budget` is left at its checkpoint for the next start.
    pub async fn settle(&self, budget: Duration) {
        let mut running = self.running.subscribe();
        let patience = budget.saturating_sub(CUT_BEFORE_END);
        let idle = tokio::time::timeout(patience, running.wait_for(|running| !*running));
        if idle.await.is_err() {
            tracing::warn!("A bulk-action job outlived the stop's wait; it resumes at the next start");
            self.closed.store(true, Ordering::Release);
            let idle = running.wait_for(|running| !*running);
            let _ = tokio::time::timeout(CUT_BEFORE_END / 2, idle).await;
        }
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::BulkJobNotFound, "No bulk-action job has this ID.")
}

/// The job as its doors answer it.
fn answer(job: &store::Job) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(job.id));
    out.insert("action".into(), json!(job.queued.action.name()));
    out.insert("status".into(), json!(job.status));
    out.insert("matched".into(), json!(job.matched));
    out.insert("processed".into(), json!(job.processed));
    out.insert("succeeded".into(), json!(job.succeeded));
    out.insert("errored".into(), json!(job.errored));
    for (name, value) in [
        ("started_at", &job.started_at),
        ("finished_at", &job.finished_at),
        ("error", &job.error),
    ] {
        if let Some(value) = value {
            out.insert(name.into(), json!(value));
        }
    }
    if let Some(result) = &job.result {
        out.insert("result".into(), result.clone());
    }
    Value::Object(out)
}

/// What a job did so far, from its counters and the rows it noted.
fn gathered(tx: &rusqlite::Transaction<'_>, job: &store::Job) -> Result<Map<String, Value>> {
    let mut result = Map::new();
    result.insert("action".into(), json!(job.queued.action.name()));
    result.insert("matched".into(), json!(job.matched));
    result.insert("succeeded".into(), json!(job.succeeded));
    result.insert("errored".into(), json!(job.errored));
    result.insert("dry_run".into(), json!(false));
    if (1..=LISTED).contains(&job.succeeded) {
        let ids: Vec<String> = store::notes(tx, &job.id, store::Note::Changed)?
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        result.insert("ids".into(), json!(ids));
    }
    let errors = store::notes(tx, &job.id, store::Note::Error)?
        .into_iter()
        .map(|(_, body)| {
            body.as_deref()
                .and_then(|text| serde_json::from_str(text).ok())
                .ok_or_else(|| Refusal::internal("a job's error did not read"))
        })
        .collect::<Result<Vec<Value>>>()?;
    if !errors.is_empty() {
        result.insert("errors".into(), Value::Array(errors));
    }
    if job.queued.action.purges() {
        let blobs = store::count_notes(tx, &job.id, store::Note::Blob)?;
        result.insert("blob_hashes_referenced".into(), json!(blobs));
    }
    Ok(result)
}

fn dry_answer(action: &Action, ids: &[String]) -> Value {
    json!({
        "action": action.name(),
        "matched": ids.len(),
        "succeeded": 0,
        "errored": 0,
        "dry_run": true,
        "ids": ids,
    })
}

fn over_cap(cap: i64) -> Refusal {
    Refusal::new(
        Code::BulkCapExceeded,
        format!("More than {cap} items match. Narrow the filter, or raise max_items up to 50,000."),
    )
    .with_detail("cap", cap)
}

fn selection_moved() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "The source filter changed while the items were selected. Repeat the request.",
    )
}

/// Queues a job, or answers a dry run, for `POST /items/bulk-actions`.
pub async fn queue(
    app: &App,
    caller: &Caller,
    asked: Asked,
    claim: Option<Claim>,
) -> Result<(u16, String)> {
    let Asked {
        action,
        ask,
        cap,
        expected,
        dry_run,
        fanout,
    } = asked;
    let purge = action.purges();
    let (ids, form) = super::items::reading(app, caller, move |read| {
        read.caller.require_reach()?;
        if purge {
            read.caller.require(super::access::Permission::ItemsPurge)?;
        }
        let ids = query::matched(read, &ask, cap, expected.as_deref())?;
        if ids.len() as i64 > cap {
            return Err(over_cap(cap));
        }
        Ok((ids, read.caller.source_filter_form()))
    })
    .await?;
    if dry_run {
        return Ok((200, dry_answer(&action, &ids).to_string()));
    }
    app.faults.hold(HOLD_JOB_SELECTED, None).await;
    let queued = Queued { action, fanout };
    let answered = app
        .write(caller, "items.bulk_action", move |unit| {
            if purge {
                unit.caller
                    .require(super::access::Permission::ItemsPurge)?;
            }
            if unit.caller.source_filter_form() != form {
                return Err(selection_moved());
            }
            let body = enqueue(unit, &queued, &ids)?;
            if let Some(claim) = &claim {
                claim.note(if purge { Need::Purge } else { Need::Reach });
                idempotency::complete(unit, claim, 202, body.as_bytes())?;
            }
            Ok(body)
        })
        .await?;
    app.jobs.wake();
    Ok((202, answered))
}

/// Writes a job and the items it will take, in the caller's transaction.
pub(crate) fn enqueue(unit: &Unit<'_, '_>, queued: &Queued, ids: &[String]) -> Result<String> {
    let holder = unit.caller.job_holder()?;
    let id = Uuid::now_v7().to_string();
    let tx = unit.tx();
    store::insert(tx, &id, queued, &holder, ids, &unit.at)?;
    unit.audit(
        "items.bulk_action",
        &id,
        Some(json!({
            "sub_action": queued.action.name(),
            "matched": ids.len(),
            "job_id": id,
        })),
    )?;
    let job = store::by_id(tx, &id)?.ok_or_else(not_found)?;
    Ok(answer(&job).to_string())
}

pub async fn read(app: &App, caller: &Caller, id: String) -> Result<Value> {
    let caller = caller.clone();
    let clock = app.clock.clone();
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &clock.stamp())?;
            let job = store::by_id(tx, &id)?.ok_or_else(not_found)?;
            caller.require_job_read(&job.holder)?;
            Ok(answer(&job))
        })
        .await
}

pub async fn cancel(app: &App, caller: &Caller, id: String) -> Result<Value> {
    let answered = app
        .write(caller, "items.bulk_action.cancel", move |unit| {
            let tx = unit.tx();
            let job = store::by_id(tx, &id)?.ok_or_else(not_found)?;
            unit.caller.require_job_cancel(&job.holder)?;
            if !job.is_open() {
                return Ok(answer(&job));
            }
            store::end(tx, &id, CANCELED, &unit.at, None, None)?;
            unit.audit("items.bulk_action", &id, None)?;
            let job = store::by_id(tx, &id)?.ok_or_else(not_found)?;
            Ok(answer(&job))
        })
        .await?;
    app.jobs.wake();
    Ok(answered)
}

/// The `bulk-action-gc` housekeeping job.
pub async fn gc(app: Arc<App>, run: Run) -> Result<Report> {
    let (removed, done) = super::housekeeping::drain(&run, GC_BATCH, || {
        let before = super::housekeeping::ago(&app, KEPT_DAYS, DAY_MS);
        app.db.write(Write::own(), move |tx| {
            store::remove_ended(tx, &before, GC_BATCH)
        })
    })
    .await?;
    Ok(Report {
        result: json!({ "removed": removed }),
        again: !done,
    })
}
