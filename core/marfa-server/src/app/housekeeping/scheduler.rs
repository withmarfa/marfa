use std::future::{Future, poll_fn};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::task::Poll;
use std::time::Duration;

use futures_util::FutureExt;
use tokio::sync::watch;

use super::super::App;
use super::super::refusal::{Code, Refusal, Result};
use super::jobs::JOBS;
use super::schedule::{self, Finish, Wanted};
use super::{Active, Ended, Job, Report, Run};
use crate::db::Write;
use crate::settings::registry::ERROR_REPORTING_ENABLED;
use crate::telemetry::{Fault, Finished};

/// How long after a pass that failed the next one waits.
const RETRY: Duration = Duration::from_secs(1);
const RECORD_RETRY_FIRST: Duration = Duration::from_millis(100);
const RECORD_RETRY_MOST: Duration = Duration::from_secs(5);

pub fn wanted(app: &App) -> Vec<Wanted> {
    JOBS.iter()
        .filter(|job| job.runs_here(app))
        .map(|job| Wanted {
            name: job.name,
            interval_ms: i64::try_from(job.interval.ms(job.name, app)).unwrap_or(i64::MAX),
            first_run_ms: i64::try_from(job.first_run_ms).unwrap_or(i64::MAX),
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
    let (claimed, started) = app
        .db
        .write(Write::own(), move |tx| {
            let started = clock.stamp();
            Ok((schedule::apply(tx, &steps, Some(&started))?, started))
        })
        .await?;
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
            // A wake that is already here is answered by the read this pass makes.
            let _ = app.housekeeping.wake.notified().now_or_never();
            moves.borrow_and_update();
            let left = match caught(pass(&app)).await {
                Ok(Ok(Some(left))) => left,
                Ok(Ok(None)) => continue,
                Ok(Err(refused)) => {
                    tracing::warn!(error = %refused, "A housekeeping pass did not finish");
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

/// Polls `future` so that a panic in it is caught on the thread the panic hook
/// noted it on, and the task goes on.
async fn caught<F: Future>(future: F) -> std::result::Result<F::Output, Arc<Fault>> {
    let mut future = pin!(future);
    poll_fn(
        |context| match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(context))) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(Err(Arc::new(Fault::panicked(
                "a housekeeping run panicked",
            )))),
        },
    )
    .await
}

struct Failed {
    message: String,
    fault: Option<Arc<Fault>>,
}

impl From<Refusal> for Failed {
    fn from(refused: Refusal) -> Failed {
        let fault = refused.fault.clone();
        Failed {
            message: fault
                .as_ref()
                .map_or_else(|| refused.to_string(), |fault| fault.message.clone()),
            fault,
        }
    }
}

impl From<Arc<Fault>> for Failed {
    fn from(fault: Arc<Fault>) -> Failed {
        Failed {
            message: fault.message.clone(),
            fault: Some(fault),
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

fn report(app: &App, name: &str, fault: &Arc<Fault>) {
    let timestamp = app.clock.stamp();
    app.telemetry.finish(
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
            reporting: app.settings.live().get(ERROR_REPORTING_ENABLED),
            timestamp: &timestamp,
        },
    );
}

/// Records a run. A busy database must not lose the record, so this goes on
/// trying until a stop gives up on it, which leaves the next start to clear it.
async fn record(app: &Arc<App>, job: &Job, ended: &Ended, again: bool) {
    let mut cut = app.housekeeping.cut.subscribe();
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
                let interval_ms = interval.ms(name, &live);
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
    let ended = Ended {
        name: job.name,
        started_at,
        finished_at: app.clock.stamp(),
        outcome: if failure.is_some() { "error" } else { "ok" },
        result,
        error: failure.as_ref().map(|failed| failed.message.clone()),
        kept_unread: kept_unread.load(Ordering::Relaxed),
    };
    record(&app, job, &ended, again).await;
    if let Some(failed) = &failure {
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
    use super::*;

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
}
