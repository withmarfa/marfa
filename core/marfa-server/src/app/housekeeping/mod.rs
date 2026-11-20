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

use super::access::{Caller, Permission};
use super::clock::{Clock, Confirmation, Stamp, Standing};
use super::refusal::{Code, Refusal, Result};
use super::{App, audit, config, provenance, stored};
use crate::db::{Db, Write};
use crate::settings::registry::Setting;

pub use cleanups::{drain, report_kept};
use jobs::JOBS;

/// The jobs whose interval the server fixes, which a test-hooks server may shorten.
pub fn job_names() -> Vec<&'static str> {
    JOBS.iter()
        .filter(|job| matches!(job.interval, Interval::Fixed(_)))
        .map(|job| job.name)
        .collect()
}

/// The name of every job, for the test that ties the baseline to them.
#[cfg(test)]
pub fn every_job_name() -> Vec<&'static str> {
    JOBS.iter().map(|job| job.name).collect()
}

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;

const CUT_BEFORE_END: Duration = Duration::from_secs(1);
const ATTENTION_WAIT: Duration = Duration::from_secs(2);

type Body = fn(Arc<App>, Run) -> Pin<Box<dyn Future<Output = Result<Report>> + Send>>;

#[derive(Clone, Copy)]
enum Interval {
    /// A setting the owner changes, in seconds.
    Stored(Setting<u64>),
    Fixed(u64),
}

impl Interval {
    fn ms(self, name: &str, app: &App) -> u64 {
        match self {
            Interval::Stored(setting) => app.settings.live().get(setting).saturating_mul(1_000),
            Interval::Fixed(ms) => app.settings.start.tuning.interval_ms(name, ms),
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
    /// Whether a run deletes by age, so that a clock far ahead of the trusted time holds it.
    deletes: bool,
    /// Whether a change to a file's record asks this job to run soon.
    wakes_on_files: bool,
    run: Body,
}

impl Job {
    const fn stored(
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

    const fn new(
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
            deletes: false,
            wakes_on_files: false,
            run,
        }
    }

    const fn switched_by(mut self, switch: fn(&App) -> bool) -> Job {
        self.switch = Some(switch);
        self
    }

    const fn deleting(mut self) -> Job {
        self.deletes = true;
        self
    }

    const fn waking_on_files(mut self) -> Job {
        self.wakes_on_files = true;
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
    /// Set when the run could not do its work: it is recorded as failed and keeps its result.
    pub failure: Option<String>,
}

impl Report {
    pub fn done(result: Value) -> Report {
        Report {
            result,
            again: false,
            failure: None,
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
    wake: Arc<Notify>,
    stopping: watch::Sender<bool>,
    cut: watch::Sender<bool>,
    running: watch::Sender<usize>,
}

impl Default for Housekeeping {
    fn default() -> Housekeeping {
        Housekeeping {
            wake: Arc::new(Notify::new()),
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

/// Lets the scheduler look again now, for a change in what it reads that no write to the job table
/// shows: a published setting.
pub fn wake(app: &App) {
    app.housekeeping.wake.notify_one();
}

pub fn is_job(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name)
}

pub fn runs_statements(name: &str) -> bool {
    JOBS.iter().any(|job| job.name == name && job.statements)
}

/// The instant a retention keeps records from, or `None`, keeping everything, while it is zero or clean-up holds.
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

/// `None` once no stored time can be that early, or while the clock holds clean-up.
pub fn ago(app: &App, amount: i64, unit_ms: i64) -> Option<String> {
    app.clock
        .judging()?
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
        "interval_seconds": job.interval.ms(job.name, app).div_ceil(1000),
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
/// `instance.maintain` is decided in the claim's write; once claimed, the run is the server's.
pub async fn run_now(app: &Arc<App>, caller: &Caller, name: &str) -> Result<Ended> {
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
    let claiming = {
        let (app, caller) = (app.clone(), caller.clone());
        provenance::carried(async move {
            app.write(&caller, "housekeeping.claim", move |unit| {
                unit.caller.require(Permission::InstanceMaintain)?;
                let at = unit.at.clone();
                Ok(schedule::claim(unit.tx(), job.name, None, &at)?.then_some(at))
            })
            .await
        })
    };
    tokio::spawn(async move {
        let active = app.housekeeping.active();
        let claimed = claiming.await?;
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
        .filter(|row| row.last_outcome.as_deref() == Some("failed"))
        .filter(|row| {
            JOBS.iter()
                .any(|job| job.name == row.name && job.runs_here(app))
        })
        .collect()
}

/// How the last run of a job ended.
pub struct LastRun {
    /// Why it failed; `None` when it did not fail.
    pub failure: Option<String>,
    pub result: Option<Value>,
}

/// The last run of `name`, if it has run.
pub fn last_run(tx: &rusqlite::Transaction<'_>, name: &str) -> Result<Option<LastRun>> {
    Ok(schedule::rows(tx)?
        .into_iter()
        .find(|row| row.name == name && row.last_outcome.is_some())
        .map(|row| LastRun {
            failure: (row.last_outcome.as_deref() == Some("failed"))
                .then(|| row.last_error.unwrap_or_default()),
            result: row
                .last_result
                .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
        }))
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
        "held": held(app.clock.standing()),
    })
}

/// Why the jobs that delete are held, or `null` while they are not.
pub fn held(standing: Standing) -> Value {
    match standing {
        Standing::Ahead {
            trusted,
            wall,
            ends,
        } => json!({
            "reason": "clock_ahead",
            "clock_at": wall,
            "trusted_at": trusted,
            "ends_at": ends,
        }),
        Standing::Agrees | Standing::Behind { .. } => Value::Null,
    }
}

pub const CLOCK_CONFIRMED: &str = "instance.clock.confirmed";

/// What a confirmation of the clock did, or why a gate stopped it.
pub enum ClockConfirmed<T> {
    Done(Stamp),
    Stopped(T),
}

/// The jobs a clock far ahead holds, which run once the clock is confirmed.
pub fn held_jobs(app: &App) -> Vec<&'static str> {
    JOBS.iter()
        .filter(|job| job.deletes && job.switch.is_none_or(|on| on(app)))
        .map(|job| job.name)
        .collect()
}

/// Takes the server's clock as right and lets the jobs a clock ahead held run now.
pub async fn confirm_clock(app: &App, caller: &Caller) -> Result<Stamp> {
    match confirm_clock_if(app, caller, |_, _| Ok(None::<()>)).await? {
        ClockConfirmed::Done(at) => Ok(at),
        ClockConfirmed::Stopped(()) => Err(Refusal::internal("an open gate stopped the clock")),
    }
}

/// Confirms the clock unless `gate`, judged in the confirming write on the hold as it stands,
/// stops it; anything the gate writes commits with the confirmation.
pub async fn confirm_clock_if<T, G>(
    app: &App,
    caller: &Caller,
    gate: G,
) -> Result<ClockConfirmed<T>>
where
    T: Send + 'static,
    G: FnOnce(&rusqlite::Transaction<'_>, Option<(Standing, Stamp)>) -> Result<Option<T>>
        + Send
        + 'static,
{
    let origin = provenance::current();
    let confirmed = confirm_on(&app.db, &app.clock, caller.clone(), origin, gate).await?;
    if let ClockConfirmed::Done(at) = &confirmed {
        tracing::info!(at = %at, "The owner confirmed the server's clock");
    }
    Ok(confirmed)
}

/// A deleting job reads the guard inside its own write, so the confirmation reaches the guard only
/// once its write has committed.
async fn confirm_on<T, G>(
    db: &Db,
    clock: &Arc<Clock>,
    caller: Caller,
    origin: provenance::Origin,
    gate: G,
) -> Result<ClockConfirmed<T>>
where
    T: Send + 'static,
    G: FnOnce(&rusqlite::Transaction<'_>, Option<(Standing, Stamp)>) -> Result<Option<T>>
        + Send
        + 'static,
{
    let inside = clock.clone();
    let written = db
        .write(Write::caller(CLOCK_CONFIRMED), move |tx| {
            let at = inside.stamp();
            let caller = caller.current(tx, &at)?;
            caller.require(Permission::InstanceMaintain)?;
            let hold = inside.hold();
            if let Some(stopped) = gate(tx, hold)? {
                return Ok(Err(stopped));
            }
            let confirmation = confirming(tx, &inside)?;
            audit::record_from(
                tx,
                &at,
                Some(&caller),
                origin.client_ip.as_deref(),
                audit::Entry {
                    action: CLOCK_CONFIRMED,
                    resource_type: "instance",
                    resource_id: None,
                    details: origin.mark(Some(json!({
                        "confirmed_at": confirmation.at(),
                        "held": hold.is_some(),
                    }))),
                },
            )?;
            Ok(Ok(confirmation))
        })
        .await;
    let confirmation = match written {
        Ok(Ok(confirmation)) => confirmation,
        Ok(Err(stopped)) => return Ok(ClockConfirmed::Stopped(stopped)),
        Err(error) => {
            clock.unstage();
            Err(error)?
        }
    };
    clock.confirmed(confirmation);
    Ok(ClockConfirmed::Done(confirmation.at()))
}

fn confirming(tx: &rusqlite::Transaction<'_>, clock: &Clock) -> Result<Confirmation> {
    let confirmation = clock.confirmation();
    for job in JOBS.iter().filter(|job| job.deletes) {
        schedule::bring_forward_held(tx, job.name, &confirmation.at().text())?;
    }
    clock.stage(confirmation);
    Ok(confirmation)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn open(_: &rusqlite::Transaction<'_>, _: Option<(Standing, Stamp)>) -> Result<Option<()>> {
        Ok(None)
    }
    use crate::db::Options;
    use crate::db::migrate::Migration;
    use crate::settings::DatabasePath;

    /// No `clock_trust` table, so every write fails as it commits.
    const NO_CLOCK_TABLE: &[Migration] = &[Migration {
        version: 1,
        sql: "CREATE TABLE housekeeping_jobs (name TEXT PRIMARY KEY, next_run_at TEXT, last_outcome TEXT) STRICT;",
    }];

    #[tokio::test]
    async fn a_confirmation_whose_write_fails_leaves_the_clock_as_it_was() {
        let options = Options {
            path: DatabasePath::Memory,
            write_wait: Duration::from_secs(5),
            readers: 1,
            migrations: NO_CLOCK_TABLE,
            reserve: 0,
            upgrade_marks: None,
        };
        let lock = crate::db::Lock::take(&options.path)
            .map_err(|failure| failure.message)
            .unwrap();
        let db = Db::open(&options, lock, Arc::default())
            .map_err(|failure| failure.message)
            .unwrap();
        let clock = Arc::new(Clock::new(0));
        clock.pause(true);
        let now = clock.instant().ms();
        clock.resume_from(Some(crate::app::clock::Kept {
            trusted_at: Stamp::from_ms(now - 180 * DAY_MS).unwrap(),
            held_ms: None,
        }));
        assert_eq!(
            clock.judging(),
            None,
            "the witness: a clock this far ahead holds"
        );
        db.keep_clock(clock.clone());

        assert!(
            confirm_on(&db, &clock, Caller::Server, Default::default(), open)
                .await
                .is_err()
        );
        assert_eq!(clock.judging(), None);
        assert!(matches!(clock.standing(), Standing::Ahead { .. }));
    }

    #[tokio::test]
    async fn a_confirmation_changes_nothing_a_clean_up_reads_until_its_write_commits() {
        let options = Options {
            path: DatabasePath::Memory,
            write_wait: Duration::from_secs(5),
            readers: 1,
            migrations: crate::db::migrate::MIGRATIONS,
            reserve: 0,
            upgrade_marks: None,
        };
        let lock = crate::db::Lock::take(&options.path)
            .map_err(|failure| failure.message)
            .unwrap();
        let db = Db::open(&options, lock, Arc::default())
            .map_err(|failure| failure.message)
            .unwrap();
        let clock = Arc::new(Clock::new(0));
        clock.pause(true);
        clock.now_ms();
        clock.jump(180 * DAY_MS).unwrap();
        db.keep_clock(clock.clone());
        assert_eq!(clock.judging(), None, "the witness: the clock holds");

        let inside = clock.clone();
        let seen = db
            .write(Write::own(), move |tx| {
                confirming(tx, &inside)?;
                Ok(inside.judging())
            })
            .await
            .unwrap();
        assert_eq!(seen, None, "read inside the confirming write");

        let ClockConfirmed::Done(confirmed) =
            confirm_on(&db, &clock, Caller::Server, Default::default(), open)
                .await
                .unwrap()
        else {
            panic!("an open gate stopped the confirmation");
        };
        assert_eq!(clock.judging(), Some(confirmed));
        let kept = db.read(crate::app::clock::kept).await.unwrap().unwrap();
        assert_eq!(kept.trusted_at, confirmed);
    }
}
