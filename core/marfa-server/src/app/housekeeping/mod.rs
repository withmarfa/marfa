//! The jobs the server runs on itself. A run belongs to the server: it runs as `Caller::Server`
//! on a task of its own, so nothing about a request that asked for it can stop it.

mod cleanups;
mod heartbeat;
mod jobs;
mod schedule;
mod scheduler;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use super::clock::Stamp;
use super::refusal::{Code, Refusal, Result};
use super::{App, config, stored};
use crate::db::Write;
use crate::settings::registry::{Setting, Snapshot};

pub use cleanups::drain;
use jobs::JOBS;

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;

const CUT_BEFORE_END: Duration = Duration::from_secs(1);
const ATTENTION_WAIT: Duration = Duration::from_secs(2);

type Body = fn(Arc<App>, Run) -> Pin<Box<dyn Future<Output = Result<Report>> + Send>>;

#[derive(Clone, Copy)]
enum Interval {
    Stored(Setting<u64>),
    Fixed(u64),
}

impl Interval {
    fn ms(self, live: &Snapshot) -> u64 {
        match self {
            Interval::Stored(setting) => live.get(setting),
            Interval::Fixed(ms) => ms,
        }
    }
}

pub struct Job {
    pub name: &'static str,
    interval: Interval,
    first_run_ms: u64,
    deadline: Duration,
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
        Job::paced(
            name,
            Interval::Stored(interval),
            first_run_ms,
            deadline,
            run,
        )
    }

    const fn fixed(
        name: &'static str,
        interval_ms: u64,
        first_run_ms: u64,
        deadline: Duration,
        run: Body,
    ) -> Job {
        Job::paced(
            name,
            Interval::Fixed(interval_ms),
            first_run_ms,
            deadline,
            run,
        )
    }

    const fn paced(
        name: &'static str,
        interval: Interval,
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

#[derive(Debug)]
pub struct Report {
    pub result: Value,
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

pub struct Run {
    pub job: &'static str,
    given_up: Arc<AtomicBool>,
    stopping: watch::Receiver<bool>,
    kept_unread: Arc<AtomicI64>,
}

impl Run {
    /// Notes rows a stage kept because the time it judges them by does not read.
    pub fn kept_unread(&self, count: i64) {
        self.kept_unread.fetch_add(count, Ordering::Relaxed);
    }

    /// Asked between two batches. Answers false once the run should end with what it has done:
    /// the server is stopping, or the run has outlived its deadline.
    pub async fn go_on(&self) -> bool {
        tokio::task::yield_now().await;
        !self.given_up.load(Ordering::Acquire) && !*self.stopping.borrow()
    }

    pub async fn stopped(&self) {
        let _ = self.stopping.clone().wait_for(|stopping| *stopping).await;
    }
}

struct Active(watch::Sender<usize>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.send_modify(|running| *running -= 1);
    }
}

#[derive(Debug)]
pub struct Housekeeping {
    wake: Notify,
    stopping: watch::Sender<bool>,
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

    pub fn stop(&self) {
        self.stopping.send_replace(true);
    }

    /// A run that has not ended by a moment before `budget` is left where it stands, so that a request
    /// waiting on it can answer inside the stop's wait. Its schedule is untouched, so it runs again at the next start.
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

/// Brings a job's next run forward to `at`, in the write that gives it work.
pub fn bring_forward(tx: &rusqlite::Transaction<'_>, name: &str, at: &str) -> Result<()> {
    schedule::bring_forward(tx, name, at)
}

/// Lets the scheduler look again now, after a write brought a run forward.
pub fn wake(app: &App) {
    app.housekeeping.wake.notify_one();
}

pub fn is_job(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name)
}

pub fn runs_statements(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name && job.statements)
}

/// The instant a retention keeps records from, or `None` while it is zero and keeps everything.
/// Read from `tx`, since the live settings lag a change the writer has committed.
pub fn cutoff(
    tx: &rusqlite::Transaction<'_>,
    app: &App,
    retention: Setting<u64>,
    unit_ms: i64,
) -> Result<Option<String>> {
    let kept = stored::deciding(tx, &app.settings.seeds(), retention)?;
    if kept == 0 {
        return Ok(None);
    }
    Ok(ago(app, i64::try_from(kept).unwrap_or(i64::MAX), unit_ms))
}

/// `None` once no stored time can be that early.
pub fn ago(app: &App, amount: i64, unit_ms: i64) -> Option<String> {
    app.clock
        .instant()
        .earlier_by(amount.saturating_mul(unit_ms))
        .map(Stamp::text)
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

pub fn start(app: &Arc<App>) {
    scheduler::start(app.clone());
}

fn listed(app: &App, job: &Job, row: &schedule::Row) -> Value {
    json!({
        "name": job.name,
        "interval_ms": job.interval.ms(&app.settings.live()),
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

#[derive(Debug)]
pub struct Ended {
    pub name: &'static str,
    pub started_at: String,
    pub finished_at: String,
    pub outcome: &'static str,
    pub result: Option<Value>,
    pub error: Option<String>,
    /// Rows the run kept because the time it judges them by does not read.
    pub kept_unread: i64,
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

/// The claim and the run are one task, so a caller who goes away leaves neither half done.
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

/// Jobs this instance runs whose last run failed.
fn failed_in(app: &App, rows: Vec<schedule::Row>) -> Vec<schedule::Row> {
    rows.into_iter()
        .filter(|row| row.last_outcome.as_deref() == Some("error"))
        .filter(|row| {
            JOBS.iter()
                .any(|job| job.name == row.name && job.runs_here(app))
        })
        .collect()
}

/// Every job whose last run failed, read in one snapshot.
pub async fn failed(app: &App) -> Result<Vec<(String, Option<String>)>> {
    let rows = app.db.read(schedule::rows).await?;
    Ok(failed_in(app, rows)
        .into_iter()
        .map(|row| (row.name, row.last_error))
        .collect())
}

pub async fn attention(app: &App) -> Value {
    let read = app
        .db
        .read(|tx| Ok((schedule::rows(tx)?, config::levers_unreadable(tx)?)));
    let (rows, levers_unreadable) = tokio::time::timeout(ATTENTION_WAIT, read)
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .unzip();
    let failed = rows.map(|rows| {
        failed_in(app, rows)
            .into_iter()
            .map(|row| {
                json!({
                    "name": row.name,
                    "at": row.last_finished_at,
                    "error": row.last_error,
                })
            })
            .collect::<Vec<Value>>()
    });
    let mut unreadable = app.settings.live().unreadable().to_vec();
    if levers_unreadable == Some(true) {
        unreadable.push(config::ENFORCEMENT_ROW);
    }
    json!({
        "failed": failed,
        "unreadable_settings": unreadable,
    })
}
