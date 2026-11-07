//! The jobs the server runs on itself. `jobs::JOBS` lists them, one entry each;
//! the `housekeeping_jobs` table holds when each is next due and what its last
//! run did; `scheduler` claims what is due and runs it.
//!
//! A run belongs to the server. It runs as [`Caller::Server`], on a task of its
//! own, so nothing about a request that asked for it can stop it.

mod cleanups;
mod heartbeat;
mod jobs;
mod schedule;
mod scheduler;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use super::App;
use super::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::Setting;

pub use cleanups::drain;
use jobs::JOBS;

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;

/// How long a stop leaves a run it has given up on to answer, before the stop's
/// own wait ends.
const CUT_BEFORE_END: Duration = Duration::from_secs(1);
/// What a health answer waits for the table, as its probes wait for theirs.
const ATTENTION_WAIT: Duration = Duration::from_secs(2);

type Body = fn(Arc<App>, Run) -> Pin<Box<dyn Future<Output = Result<Report>> + Send>>;

/// One housekeeping job.
pub struct Job {
    pub name: &'static str,
    interval: Setting<u64>,
    /// How long after a fresh start its first run comes, within its interval.
    first_run_ms: u64,
    deadline: Duration,
    /// A machine setting that leaves this job out of the instance altogether.
    switch: Option<fn(&App) -> bool>,
    /// Whether a run reaches the database, which `fail:housekeeping:<job>` needs.
    statements: bool,
    run: Body,
}

impl Job {
    const fn new(
        name: &'static str,
        interval: Setting<u64>,
        first_run_ms: u64,
        deadline: Duration,
        run: Body,
    ) -> Job {
        Job {
            name,
            interval,
            first_run_ms,
            deadline,
            switch: None,
            statements: true,
            run,
        }
    }

    const fn switched_by(mut self, switch: fn(&App) -> bool) -> Job {
        self.switch = Some(switch);
        self
    }

    const fn without_statements(mut self) -> Job {
        self.statements = false;
        self
    }

    fn runs_here(&self, app: &App) -> bool {
        self.switch.is_none_or(|on| on(app))
    }
}

/// What a run finished with.
#[derive(Debug)]
pub struct Report {
    pub result: Value,
    /// Work is left that should not wait for the interval.
    pub again: bool,
}

impl Report {
    pub fn done(result: Value) -> Report {
        Report {
            result,
            again: false,
        }
    }
}

/// What a job asks of the run it is in.
pub struct Run {
    given_up: Arc<AtomicBool>,
    stopping: watch::Receiver<bool>,
}

impl Run {
    /// Asked between two batches. Gives the runtime a turn, and answers false
    /// once the run should end with what it has done: the server is stopping,
    /// or the run has outlived its deadline.
    pub async fn go_on(&self) -> bool {
        tokio::task::yield_now().await;
        !self.given_up.load(Ordering::Acquire) && !*self.stopping.borrow()
    }

    /// Finishes once the server is stopping.
    pub async fn stopped(&self) {
        let _ = self.stopping.clone().wait_for(|stopping| *stopping).await;
    }
}

/// A run that counts as work in progress until this drops.
struct Active(watch::Sender<usize>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.send_modify(|running| *running -= 1);
    }
}

/// What the scheduler shares with the rest of the server.
#[derive(Debug)]
pub struct Housekeeping {
    wake: Notify,
    stopping: watch::Sender<bool>,
    /// A stop has run out of patience: what is still running is left behind.
    cut: watch::Sender<bool>,
    running: watch::Sender<usize>,
}

impl Default for Housekeeping {
    fn default() -> Housekeeping {
        Housekeeping {
            wake: Notify::new(),
            stopping: watch::Sender::new(false),
            cut: watch::Sender::new(false),
            running: watch::Sender::new(0),
        }
    }
}

impl Housekeeping {
    fn active(&self) -> Active {
        self.running.send_modify(|running| *running += 1);
        Active(self.running.clone())
    }

    /// Starts no more runs, and tells those running to end at their next batch.
    pub fn stop(&self) {
        self.stopping.send_replace(true);
    }

    /// Waits for runs to end, for no longer than `budget`. A run that has not
    /// ended by a moment before then is left where it stands, so that a request
    /// waiting on it can answer inside the stop's wait. Its schedule is
    /// untouched, so it runs again at the next start.
    pub async fn settle(&self, budget: Duration) {
        let mut running = self.running.subscribe();
        let patience = budget.saturating_sub(CUT_BEFORE_END);
        let idle = tokio::time::timeout(patience, running.wait_for(|count| *count == 0));
        if idle.await.is_err() {
            tracing::warn!("A housekeeping run outlived the stop's wait");
            self.cut.send_replace(true);
            let idle = running.wait_for(|count| *count == 0);
            let _ = tokio::time::timeout(CUT_BEFORE_END / 2, idle).await;
        }
    }
}

/// Whether this build has a job of this name, whatever this instance's
/// machine settings say of it.
pub fn is_job(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name)
}

pub fn runs_statements(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name && job.statements)
}

/// The instant a retention keeps records from, or `None` while it is zero and
/// keeps everything. Read as a job is about to delete, so a change takes effect
/// at the next batch.
pub fn cutoff(app: &App, retention: Setting<u64>, unit_ms: i64) -> Option<String> {
    let kept = app.settings.live().get(retention);
    (kept > 0).then(|| ago(app, i64::try_from(kept).unwrap_or(i64::MAX), unit_ms))
}

/// The instant `amount` units back. A span past what a date can hold gives the
/// earliest date, which nothing is older than.
pub fn ago(app: &App, amount: i64, unit_ms: i64) -> String {
    app.clock.stamp_ago(amount.saturating_mul(unit_ms))
}

/// Clears what the last process left unfinished and enters the jobs this build
/// runs. It moves no `next_run_at` later.
pub async fn prepare(app: &Arc<App>) -> Result<()> {
    let wanted = scheduler::wanted(app);
    let clock = app.clock.clone();
    let cleared = app
        .db
        .write(Write::own(), move |tx| {
            let cleared = schedule::clear_unfinished(tx)?;
            let rows = schedule::rows(tx)?;
            let steps = schedule::plan(&rows, &wanted, clock.now_ms());
            schedule::apply(tx, &steps, None)?;
            Ok(cleared)
        })
        .await?;
    if cleared > 0 {
        tracing::warn!(
            cleared,
            "Housekeeping runs the last process left unfinished"
        );
    }
    Ok(())
}

/// Starts the scheduler, which ends when `Housekeeping::stop` is called.
pub fn start(app: &Arc<App>) {
    scheduler::start(app.clone());
}

/// One job as the listing answers it.
fn listed(app: &App, job: &Job, row: &schedule::Row) -> Value {
    json!({
        "name": job.name,
        "interval_ms": app.settings.live().get(job.interval),
        "next_run_at": schedule::readable(&row.next_run_at).then_some(&row.next_run_at),
        "running_since": row.running_since,
        "last_started_at": row.last_started_at,
        "last_finished_at": row.last_finished_at,
        "last_outcome": row.last_outcome,
        "last_error": row.last_error,
        "last_result": row.last_result.as_deref().and_then(|text| {
            serde_json::from_str::<Value>(text).ok()
        }),
    })
}

/// Every job this instance runs. A row of a job it does not run stays out of
/// the answer, and stays in the table.
pub async fn list(app: &App) -> Result<Vec<Value>> {
    let rows = app.db.read(schedule::rows).await?;
    Ok(JOBS
        .iter()
        .filter(|job| job.runs_here(app))
        .filter_map(|job| {
            let row = rows.iter().find(|row| row.name == job.name)?;
            Some(listed(app, job, row))
        })
        .collect())
}

/// What a finished run answers.
#[derive(Debug)]
pub struct Ended {
    pub name: &'static str,
    pub started_at: String,
    pub finished_at: String,
    pub outcome: &'static str,
    pub result: Option<Value>,
    pub error: Option<String>,
}

impl Ended {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "outcome": self.outcome,
            "result": self.result,
            "error": self.error,
        })
    }
}

/// Runs a job now and answers how it ended. The claim and the run are on a task
/// of their own, so a caller who goes away leaves neither half done.
pub async fn run_now(app: &Arc<App>, name: &str) -> Result<Ended> {
    let job = JOBS
        .iter()
        .find(|job| job.name == name && job.runs_here(app))
        .ok_or_else(|| {
            Refusal::new(
                Code::HousekeepingJobNotFound,
                format!("This instance runs no housekeeping job named {name}"),
            )
        })?;
    let app = app.clone();
    tokio::spawn(async move {
        let active = app.housekeeping.active();
        let clock = app.clock.clone();
        let claimed = app
            .db
            .write(Write::own(), move |tx| {
                let at = clock.stamp();
                Ok(schedule::claim(tx, job.name, None, &at)?.then_some(at))
            })
            .await?;
        let started_at = claimed.ok_or_else(|| {
            Refusal::new(
                Code::HousekeepingJobRunning,
                format!("{} is in the middle of a run", job.name),
            )
        })?;
        scheduler::supervise(app, job, started_at, active).await
    })
    .await
    .map_err(|_| Refusal::internal("a housekeeping run's task ended early"))?
}

/// What `/health` adds for a caller who may read why: each job whose last run
/// failed, and each stored setting that no longer reads.
pub async fn attention(app: &App) -> Value {
    let failed = tokio::time::timeout(ATTENTION_WAIT, app.db.read(schedule::rows))
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .map(|rows| {
            rows.iter()
                .filter(|row| row.last_outcome.as_deref() == Some("error"))
                .filter(|row| {
                    JOBS.iter()
                        .any(|job| job.name == row.name && job.runs_here(app))
                })
                .map(|row| {
                    json!({
                        "name": row.name,
                        "at": row.last_finished_at,
                        "error": row.last_error,
                    })
                })
                .collect::<Vec<Value>>()
        });
    json!({
        "failed": failed,
        "unreadable_settings": app.settings.live().unreadable(),
    })
}
