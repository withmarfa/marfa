use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::json;
use tokio::sync::watch;

use super::super::attention::faults::Place;
use super::super::clock::Stamp;
use super::super::refusal::{Code, Refusal, Result};
use super::super::{App, restore_running};
use super::jobs::JOBS;
use super::schedule::{self, Finish, Wanted};
use super::{Active, Ended, Job, Report, Run};
use crate::db::Write;
use crate::telemetry::{Fault, Finished, caught};

/// How long after a pass that failed the next one waits.
const RETRY: Duration = Duration::from_secs(1);
const RECORD_RETRY_FIRST: Duration = Duration::from_millis(100);
const RECORD_RETRY_MOST: Duration = Duration::from_secs(5);
/// The longest a held job waits before it looks at the clock again.
const HELD_LOOKS_AGAIN_MS: u64 = 3_600_000;
const HELD: &str = "held";
const CLOCK_AHEAD: &str = "clock_ahead";

pub fn wanted(app: &App) -> Vec<Wanted> {
    JOBS.iter()
        .filter(|job| job.runs_here(app))
        .map(|job| Wanted {
            name: job.name,
            interval_ms: i64::try_from(job.interval.ms(job.name, app)).unwrap_or(i64::MAX),
            first_run_ms: i64::try_from(job.first_run_ms).unwrap_or(i64::MAX),
            wakes_on_files: job.wakes_on_files,
        })
        .collect()
}

/// The wait until the next look, or `None` when this pass changed the table and the next look
/// should come at once.
async fn pass(app: &Arc<App>) -> Result<Option<Duration>> {
    let rows = app.db.read(schedule::rows).await?;
    let wanted = wanted(app);
    let now = app.clock.now_ms();
    let steps = schedule::plan(&rows, &wanted, now);
    if steps.is_empty() {
        let longest = app.settings.start.tuning.housekeeping_poll;
        return Ok(Some(
            schedule::next_due(&rows, &wanted, now).map_or(longest, |ms| {
                Duration::from_millis(u64::try_from(ms).unwrap_or(0)).min(longest)
            }),
        ));
    }
    let clock = app.clock.clone();
    let written = app
        .db
        .write(Write::own(), move |tx| {
            let started = clock.stamp();
            Ok((schedule::apply(tx, &steps, Some(&started))?, started))
        })
        .await;
    let (claimed, started) = match written {
        Ok(claimed) => claimed,
        Err(refused) => {
            if app.db.writes_held().is_none() {
                run_without_claim(app);
            }
            return Err(refused);
        }
    };
    for name in claimed {
        if let Some(job) = JOBS.iter().find(|job| job.name == name) {
            let active = app.housekeeping.active();
            tokio::spawn(supervise(app.clone(), job, started.clone(), active));
        }
    }
    Ok(None)
}

/// Sleeps until `left` has passed or something that can change when a job is due has happened:
/// a commit that moved a schedule, a changed setting, a moved clock, or a stop.
async fn rest(
    app: &App,
    stopping: &mut watch::Receiver<bool>,
    moves: &mut watch::Receiver<u64>,
    left: Duration,
) {
    tokio::select! {
        () = tokio::time::sleep(left) => {}
        () = app.housekeeping.wake.notified() => {}
        _ = moves.changed() => {}
        _ = stopping.wait_for(|stopping| *stopping) => {}
    }
}

/// Wakes the scheduler after a write that changed when a job is due or which jobs run.
async fn watch_schedule(app: &App) {
    let wake = app.housekeeping.wake.clone();
    let mut before: Option<String> = None;
    app.db
        .watch_writes(Box::new(move |conn| match schedule::signature(conn) {
            Ok(now) => {
                if before.as_ref().is_some_and(|before| *before != now) {
                    wake.notify_one();
                }
                before = Some(now);
            }
            Err(error) => {
                tracing::warn!(%error, "The housekeeping schedule could not be checked after a write");
                wake.notify_one();
            }
        }))
        .await;
}

/// Starts the scheduler. It counts as work in progress, so a stop waits for a pass that is
/// under way, and a claim is never left with nothing to run it. It reads the table when it
/// starts and again only when a job is due, the table or a setting it reads has changed, the
/// clock has moved, or the longest wait, `housekeeping_poll`, has passed.
pub fn start(app: Arc<App>) {
    let active = app.housekeeping.active();
    tokio::spawn(async move {
        let _active = active;
        let mut stopping = app.housekeeping.stopping.subscribe();
        let mut moves = app.clock.moves();
        watch_schedule(&app).await;
        let longest = app.settings.start.tuning.housekeeping_poll;
        while !*stopping.borrow() {
            if app.db.writes_held().is_some() {
                tracing::info!("Housekeeping waits until the restore ends");
                tokio::select! {
                    () = while_restoring(&app) => {}
                    () = app.db.writes_released() => {}
                    _ = stopping.wait_for(|stopping| *stopping) => {}
                }
                continue;
            }
            // A wake that is already here is answered by the read this pass makes.
            let _ = app.housekeeping.wake.notified().now_or_never();
            moves.borrow_and_update();
            let left = match caught(pass(&app)).await {
                Ok(Ok(Some(left))) => left,
                Ok(Ok(None)) => continue,
                Ok(Err(refused)) => {
                    if app.db.writes_held().is_none() {
                        tracing::warn!(error = %refused, "A housekeeping pass did not finish");
                    }
                    RETRY.min(longest)
                }
                Err(fault) => {
                    report(&app, "scheduler", &fault);
                    RETRY.min(longest)
                }
            };
            rest(&app, &mut stopping, &mut moves, left).await;
        }
    });
}

/// Runs the jobs that write nothing while a restore holds writes, recording no run.
async fn while_restoring(app: &Arc<App>) {
    let rows = app.db.read(schedule::rows).await.unwrap_or_else(|error| {
        tracing::warn!(%error, "The housekeeping schedule could not be read during a restore");
        Vec::new()
    });
    let now = app.clock.now_ms();
    let mut due: Vec<(&'static Job, i64)> = JOBS
        .iter()
        .filter(|job| !job.statements && job.runs_here(app))
        .map(|job| {
            let at = rows
                .iter()
                .find(|row| row.name == job.name)
                .and_then(|row| Stamp::parsed(&row.next_run_at))
                .map_or(now, Stamp::ms);
            (job, at)
        })
        .collect();
    loop {
        let now = app.clock.now_ms();
        for (job, at) in &mut due {
            if *at > now {
                continue;
            }
            run_unclaimed(app, job).await;
            let interval = i64::try_from(job.interval.ms(job.name, app)).unwrap_or(i64::MAX);
            *at = app.clock.now_ms().saturating_add(interval);
        }
        let Some(next) = due.iter().map(|(_, at)| *at).min() else {
            return std::future::pending().await;
        };
        let left = u64::try_from(next.saturating_sub(app.clock.now_ms())).unwrap_or(0);
        tokio::time::sleep(Duration::from_millis(left)).await;
    }
}

/// Runs a job once with no claim and records nothing, so a run that ends late or fails leaves
/// no trace in the schedule.
async fn run_unclaimed(app: &Arc<App>, job: &'static Job) {
    let run = Run {
        job: job.name,
        given_up: Arc::new(AtomicBool::new(false)),
        stopping: app.housekeeping.stopping.subscribe(),
        kept_unread: Arc::new(AtomicI64::new(0)),
    };
    let given_up = run.given_up.clone();
    let deadline = app.faults.deadline(job.name).unwrap_or(job.deadline);
    let mut cut = app.housekeeping.cut.subscribe();
    let body = tokio::spawn(perform(app.clone(), job, run));
    tokio::select! {
        ended = tokio::time::timeout(deadline, body) => match ended {
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(failed))) => {
                tracing::warn!(job = job.name, error = %failed.message, "A housekeeping run without its claim failed");
            }
            Ok(Err(_)) => {
                tracing::warn!(job = job.name, "A housekeeping run's task without its claim ended early");
            }
            Err(_) => {
                given_up.store(true, Ordering::Release);
                tracing::warn!(job = job.name, "A housekeeping run without its claim did not finish in time");
            }
        },
        _ = cut.wait_for(|cut| *cut) => given_up.store(true, Ordering::Release),
    }
}

/// While writes fail, a job that only reads and handles a failed write itself still runs, so
/// what it finds is not left until someone looks. One run at a time, and the next waits for the
/// job's interval, however often the scheduler tries again.
fn run_without_claim(app: &Arc<App>) {
    for job in JOBS
        .iter()
        .filter(|job| job.unclaimed && job.runs_here(app))
    {
        start_unclaimed(app, job);
    }
}

fn start_unclaimed(app: &Arc<App>, job: &'static Job) {
    let Some(turn) = app
        .housekeeping
        .unclaimed
        .begin(job.name, app.clock.now_ms())
    else {
        return;
    };
    let active = app.housekeeping.active();
    let app = app.clone();
    tokio::spawn(async move {
        let _active = active;
        run_unclaimed(&app, job).await;
        let interval = i64::try_from(job.interval.ms(job.name, &app)).unwrap_or(i64::MAX);
        turn.next_not_before(app.clock.now_ms().saturating_add(interval));
    });
}

struct Failed {
    message: String,
    fault: Option<Arc<Fault>>,
    /// The database was busy, which a restore makes it for as long as it runs.
    busy: bool,
}

impl From<Refusal> for Failed {
    fn from(refused: Refusal) -> Failed {
        let fault = refused.fault.clone();
        Failed {
            message: fault
                .as_ref()
                .map_or_else(|| refused.to_string(), |fault| fault.message.clone()),
            fault,
            busy: refused.code == Code::WriteContention,
        }
    }
}

impl From<Arc<Fault>> for Failed {
    fn from(fault: Arc<Fault>) -> Failed {
        Failed {
            message: fault.message.clone(),
            fault: Some(fault),
            busy: false,
        }
    }
}

fn failing_statement() -> Refusal {
    rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR), None)
        .into()
}

/// The job itself, on a task of its own, which a run past its deadline leaves
/// running. What it then finishes with goes nowhere.
async fn perform(
    app: Arc<App>,
    job: &'static Job,
    run: Run,
) -> std::result::Result<Report, Failed> {
    app.faults.hold_job(job.name).await;
    if job.statements && app.faults.fail_job(job.name) {
        return Err(failing_statement().into());
    }
    let given_up = run.given_up.clone();
    let done = match caught((job.run)(app, run)).await {
        Ok(done) => done.map_err(Failed::from),
        Err(fault) => Err(fault.into()),
    };
    if given_up.load(Ordering::Acquire) {
        tracing::warn!(job = job.name, "A run past its deadline has ended");
    }
    done
}

fn report(app: &Arc<App>, name: &str, fault: &Arc<Fault>) {
    let timestamp = app.clock.stamp();
    let live = app.settings.live();
    app.report_fault(
        Place::Job(name),
        None,
        &Finished {
            request_id: &uuid::Uuid::now_v7().to_string(),
            method: "HOUSEKEEPING",
            path: name,
            route: None,
            transport: "internal",
            status: 500,
            error_code: Some(Code::InternalError.wire()),
            fault: Some(fault),
            settings: &live,
            timestamp: &timestamp,
        },
    );
}

/// Records a run. A busy database must not lose the record, so this goes on
/// trying until a stop gives up on it, which leaves the next start to clear it.
async fn record(app: &Arc<App>, job: &'static Job, ended: &Ended, again: bool) {
    let mut cut = app.housekeeping.cut.subscribe();
    let held = ended.outcome == HELD;
    let mut wait = RECORD_RETRY_FIRST;
    let result = ended.result.as_ref().map(ToString::to_string);
    loop {
        let name = job.name;
        let started_at = ended.started_at.clone();
        let finished_at = ended.finished_at.clone();
        let outcome = ended.outcome;
        let error = ended.error.clone();
        let result = result.clone();
        let interval = job.interval;
        let live = app.clone();
        let written = app
            .db
            .write(Write::own(), move |tx| {
                let mut interval_ms = interval.ms(name, &live);
                if held {
                    interval_ms = interval_ms.min(HELD_LOOKS_AGAIN_MS);
                }
                schedule::finish(
                    tx,
                    &Finish {
                        name,
                        started_at: &started_at,
                        finished_at: &finished_at,
                        interval_ms: i64::try_from(interval_ms).unwrap_or(i64::MAX),
                        again,
                        outcome,
                        error: error.as_deref(),
                        result: result.as_deref(),
                    },
                )
            })
            .await;
        let Err(refused) = written else {
            return;
        };
        if app.db.writes_held().is_some() {
            tokio::select! {
                () = app.db.writes_released() => continue,
                _ = cut.wait_for(|cut| *cut) => return,
            }
        }
        if job.unclaimed {
            // The claim stays marked as running until this record is written, so the job
            // would not start again while writes fail.
            let interval = i64::try_from(job.interval.ms(job.name, app)).unwrap_or(i64::MAX);
            let finished = Stamp::parsed(&ended.finished_at).map_or(app.clock.now_ms(), Stamp::ms);
            app.housekeeping
                .unclaimed
                .not_before(job.name, finished.saturating_add(interval));
            start_unclaimed(app, job);
        }
        tracing::warn!(job = job.name, error = %refused, "A housekeeping run is not yet recorded");
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = cut.wait_for(|cut| *cut) => return,
        }
        wait = (wait * 2).min(RECORD_RETRY_MOST);
    }
}

enum Ending {
    Finished(std::result::Result<Report, Failed>),
    Late(Duration),
    Cut,
}

/// A stop that outruns the run leaves its claim for the next start to clear.
pub async fn supervise(
    app: Arc<App>,
    job: &'static Job,
    started_at: String,
    active: Active,
) -> Result<Ended> {
    let _active = active;
    if job.deletes && app.clock.judging().is_none() {
        let held = Ended {
            name: job.name,
            started_at,
            finished_at: app.clock.stamp(),
            outcome: HELD,
            result: Some(json!({ "held": CLOCK_AHEAD })),
            error: None,
            kept_unread: 0,
        };
        record(&app, job, &held, false).await;
        app.housekeeping.wake.notify_one();
        return Ok(held);
    }
    let given_up = Arc::new(AtomicBool::new(false));
    let kept_unread = Arc::new(AtomicI64::new(0));
    let deadline = app.faults.deadline(job.name).unwrap_or(job.deadline);
    let run = Run {
        job: job.name,
        given_up: given_up.clone(),
        stopping: app.housekeeping.stopping.subscribe(),
        kept_unread: kept_unread.clone(),
    };
    let mut body = tokio::spawn(perform(app.clone(), job, run));
    let mut cut = app.housekeeping.cut.subscribe();
    let ending = tokio::select! {
        biased;
        joined = &mut body => Ending::Finished(joined.unwrap_or_else(|_| {
            Err(Arc::new(Fault::internal("a housekeeping run's task ended early")).into())
        })),
        () = tokio::time::sleep(deadline) => Ending::Late(deadline),
        _ = cut.wait_for(|cut| *cut) => Ending::Cut,
    };
    let (result, failure, again) = match ending {
        Ending::Finished(Ok(report)) => (
            Some(report.result),
            report.failure.map(|message| Failed {
                message,
                fault: None,
                busy: false,
            }),
            report.again,
        ),
        Ending::Finished(Err(failed)) => (None, Some(failed), false),
        Ending::Late(deadline) => {
            given_up.store(true, Ordering::Release);
            let failed = Failed {
                message: format!(
                    "The run did not finish within {} ms and was given up on.",
                    deadline.as_millis()
                ),
                fault: Some(Arc::new(Fault::internal(
                    "a housekeeping run did not finish in time",
                ))),
                busy: false,
            };
            (None, Some(failed), false)
        }
        Ending::Cut => {
            return Err(Refusal::new(
                Code::WriteContention,
                format!(
                    "{} was stopped with the server, and runs again at its next start",
                    job.name
                ),
            ));
        }
    };
    // A restore holding the writer is the restore at work, not a fault in the job.
    let restoring =
        failure.as_ref().is_some_and(|failed| failed.busy) && app.db.writes_held().is_some();
    let ended = if restoring {
        tracing::info!(
            job = job.name,
            "A housekeeping run met a restore and runs again once it ends"
        );
        Ended {
            name: job.name,
            started_at,
            finished_at: app.clock.stamp(),
            outcome: HELD,
            result: Some(json!({ "held": restore_running::REASON })),
            error: None,
            kept_unread: kept_unread.load(Ordering::Relaxed),
        }
    } else {
        Ended {
            name: job.name,
            started_at,
            finished_at: app.clock.stamp(),
            outcome: if failure.is_some() {
                "failed"
            } else {
                "succeeded"
            },
            result,
            error: failure.as_ref().map(|failed| failed.message.clone()),
            kept_unread: kept_unread.load(Ordering::Relaxed),
        }
    };
    record(&app, job, &ended, again || restoring).await;
    if let Some(failed) = failure.as_ref().filter(|_| !restoring) {
        tracing::error!(error = %failed.message, "Housekeeping {} error", job.name);
        if let Some(fault) = &failed.fault {
            report(&app, job.name, fault);
        }
    }
    app.housekeeping.wake.notify_one();
    Ok(ended)
}

#[cfg(test)]
mod tests {
    use super::super::Unclaimed;
    use super::*;
    use crate::settings::{Environment, Settings};

    const CHECK: &str = "attention-check";

    async fn started() -> (tempfile::TempDir, Arc<App>) {
        started_with("").await
    }

    async fn started_with(tuning: &str) -> (tempfile::TempDir, Arc<App>) {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_TEST_TUNING", tuning),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        (dir, App::start(settings).await.unwrap())
    }

    /// Moves the clock until the check, which first runs a minute after start, is due.
    fn make_check_due(app: &Arc<App>) {
        app.clock.jump(10 * 60_000).unwrap();
    }

    /// Waits until no unclaimed run of the check is under way, and says when the next may start.
    async fn next_run_ms(app: &Arc<App>) -> i64 {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Some(turn) = app.housekeeping.unclaimed.begin(CHECK, i64::MAX) {
                    drop(turn);
                    let states = app.housekeeping.unclaimed.states();
                    return states[CHECK].next_ms;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the unclaimed run ended")
    }

    #[tokio::test]
    async fn a_panic_in_a_run_is_caught_and_the_next_goes_on() {
        crate::telemetry::install_panic_hook();
        let fault: std::result::Result<(), _> = caught(async {
            tokio::task::yield_now().await;
            panic!("the run's own words");
        })
        .await;
        assert!(fault.is_err());
        assert_eq!(caught(async { 1 }).await.ok(), Some(1));
    }

    #[test]
    fn an_unclaimed_job_has_one_run_at_a_time_and_waits_for_its_next_turn() {
        let held = Arc::new(Unclaimed::default());
        let turn = held.begin(CHECK, 100).expect("the first run starts");
        assert!(held.begin(CHECK, 100).is_none(), "a second run at once");
        assert!(held.begin(CHECK, i64::MAX).is_none(), "however late it is");
        turn.next_not_before(5_100);
        drop(turn);
        assert!(held.begin(CHECK, 5_099).is_none(), "before its interval");
        assert!(held.begin(CHECK, 5_100).is_some(), "at its interval");
    }

    #[test]
    fn a_run_that_ends_without_saying_when_the_next_may_start_does_not_hold_the_job_for_good() {
        let held = Arc::new(Unclaimed::default());
        drop(held.begin(CHECK, 0).unwrap());
        assert!(held.begin(CHECK, 0).is_some());
    }

    #[tokio::test]
    async fn a_pass_that_cannot_write_runs_the_attention_check_once_and_then_waits_its_interval() {
        let (_dir, app) = started().await;
        app.faults
            .set("hold:housekeeping:attention-check", None)
            .unwrap();
        app.faults.set("refuse:write", None).unwrap();
        make_check_due(&app);
        for _ in 0..5 {
            assert!(pass(&app).await.is_err(), "the claim cannot be written");
        }
        assert!(
            app.housekeeping.unclaimed.begin(CHECK, i64::MAX).is_none(),
            "the one run is still under way, however many passes tried"
        );

        app.faults.clear(Some("hold:housekeeping:attention-check"));
        let next = next_run_ms(&app).await;
        let interval = JOBS
            .iter()
            .find(|job| job.name == CHECK)
            .map(|job| i64::try_from(job.interval.ms(CHECK, &app)).unwrap())
            .unwrap();
        assert!(next >= app.clock.now_ms() + interval - 5_000);
        for _ in 0..5 {
            assert!(pass(&app).await.is_err());
        }
        assert!(
            app.housekeeping
                .unclaimed
                .begin(CHECK, app.clock.now_ms())
                .is_none(),
            "passes inside the interval start no run"
        );
    }

    #[tokio::test]
    async fn a_run_that_cannot_be_recorded_does_not_stop_the_check_while_writes_fail() {
        let (_dir, app) = started_with("interval.attention-check=1500").await;
        let job = JOBS.iter().find(|job| job.name == CHECK).unwrap();
        app.faults.set("refuse:write", None).unwrap();
        let claimed = tokio::spawn(supervise(
            app.clone(),
            job,
            app.clock.stamp(),
            app.housekeeping.active(),
        ));
        tokio::time::timeout(Duration::from_secs(20), async {
            while app.housekeeping.unclaimed.states().get(CHECK).is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the run that could not be recorded paced the check");
        app.faults
            .set("hold:housekeeping:attention-check", None)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !app.housekeeping.unclaimed.states()[CHECK].running {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the check ran again while its last run could not be recorded");
        app.faults.clear(Some("hold:housekeeping:attention-check"));
        claimed.abort();
    }

    #[tokio::test]
    async fn a_pass_that_cannot_write_during_a_restore_runs_nothing() {
        let (_dir, app) = started().await;
        // A hold refuses a caller's writes and lets the scheduler's own through, so the claim
        // fails only because writes also fail.
        app.faults.set("refuse:write", None).unwrap();
        let _holding = app
            .db
            .hold_writes(Refusal::new(
                Code::WriteContention,
                "a restore holds writes",
            ))
            .unwrap();
        make_check_due(&app);
        assert!(pass(&app).await.is_err());
        assert!(
            app.housekeeping.unclaimed.begin(CHECK, i64::MAX).is_some(),
            "no run started"
        );
    }

    #[tokio::test]
    async fn a_pass_that_can_write_claims_the_check_and_starts_no_unclaimed_run() {
        let (_dir, app) = started().await;
        make_check_due(&app);
        assert!(pass(&app).await.is_ok());
        assert!(app.housekeeping.unclaimed.begin(CHECK, i64::MAX).is_some());
    }
}
