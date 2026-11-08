//! The one thread that writes. Jobs run first come first served, each in its
//! own `BEGIN IMMEDIATE` transaction.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rusqlite::ffi;
use rusqlite::{Connection, ErrorCode, Transaction, TransactionBehavior};
use tokio::sync::{mpsc, oneshot, watch};

use super::Write;
use crate::app::faults::{FAIL_AUDIT, FAIL_COMMIT, FAIL_COMMIT_ACK, FAIL_COMMIT_FULL, Faults};
use crate::app::refusal::{Code, Refusal, Result};

const QUEUE_DEPTH: usize = 1024;
/// A write always gets this long to reach an idle writer, so a budget of zero
/// refuses only what meets a lock.
const QUEUE_FLOOR: Duration = Duration::from_millis(250);
const CHECKPOINT_WAIT: Duration = Duration::from_secs(1);

const QUEUED: u8 = 0;
const RUNNING: u8 = 1;
const ABANDONED: u8 = 2;

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

enum Message {
    Run(Job),
    Stop(oneshot::Sender<()>),
}

/// A write queued behind a long job keeps waiting while it hears from it.
#[derive(Clone)]
pub struct Pulse {
    origin: Instant,
    beat: Arc<AtomicU64>,
}

impl Pulse {
    fn new() -> Pulse {
        Pulse {
            origin: Instant::now(),
            beat: Arc::default(),
        }
    }

    pub fn tick(&self) {
        let beat = self.origin.elapsed().as_millis();
        self.beat
            .store(u64::try_from(beat).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    fn last(&self) -> Instant {
        self.origin + Duration::from_millis(self.beat.load(Ordering::Relaxed))
    }
}

pub struct Writer {
    queue: mpsc::Sender<Message>,
    faults: Arc<Faults>,
    pulse: Pulse,
    commits: watch::Sender<u64>,
}

fn contention() -> Refusal {
    Refusal::new(Code::WriteContention, "The database is busy; try again.")
}

fn sqlite_failure(code: std::ffi::c_int) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(code), None)
}

/// A commit that failed may have landed, so a refusal for a full volume
/// cannot promise that nothing was kept.
fn commit_refused(error: rusqlite::Error) -> Refusal {
    let full = error.sqlite_error_code() == Some(ErrorCode::DiskFull);
    let refusal = Refusal {
        commit_failed: true,
        ..Refusal::from(error)
    };
    if full {
        refusal.with_detail("write_outcome", "unknown")
    } else {
        refusal
    }
}

fn finish<T>(
    tx: Transaction<'_>,
    value: T,
    write: Write,
    faults: &Faults,
    commits: &watch::Sender<u64>,
) -> Result<T> {
    let action = write.action;
    if action.is_some() {
        if faults.fail(FAIL_AUDIT, action) {
            return Err(sqlite_failure(ffi::SQLITE_IOERR).into());
        }
        if faults.fail(FAIL_COMMIT, action) {
            return Err(commit_refused(sqlite_failure(ffi::SQLITE_IOERR)));
        }
        if faults.fail(FAIL_COMMIT_FULL, action) {
            return Err(commit_refused(sqlite_failure(ffi::SQLITE_FULL)));
        }
    }
    tx.commit().map_err(commit_refused)?;
    commits.send_modify(|count| *count += 1);
    if action.is_some() && faults.fail(FAIL_COMMIT_ACK, action) {
        tracing::error!(sqlite_code = "SQLITE_IOERR", "Database operation failed");
    }
    Ok(value)
}

fn run_transaction<T>(
    conn: &mut Connection,
    write: Write,
    deadline: Instant,
    faults: &Faults,
    commits: &watch::Sender<u64>,
    job: impl FnOnce(&Transaction<'_>) -> Result<T>,
) -> Result<T> {
    conn.busy_timeout(deadline.saturating_duration_since(Instant::now()))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match catch_unwind(AssertUnwindSafe(|| job(&tx))) {
        Ok(Ok(value)) => finish(tx, value, write, faults, commits),
        Ok(Err(refusal)) => Err(refusal),
        Err(_) => Err(Refusal::panicked("a write job panicked")),
    }
}

/// A transaction that survives its rollback would swallow the next job.
fn ensure_closed(conn: &Connection) {
    if !conn.is_autocommit() && conn.execute_batch("ROLLBACK").is_err() {
        tracing::error!("Database operation failed");
    }
}

fn checkpoint_and_close(conn: Connection) {
    let settled = conn
        .busy_timeout(CHECKPOINT_WAIT)
        .and_then(|()| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)"));
    if let Err(error) = settled {
        tracing::warn!(error = %error, "The database log was not moved into its file");
    }
    if let Err((_, error)) = conn.close() {
        tracing::error!(error = %error, "The database did not close cleanly");
    }
}

fn run_thread(mut conn: Connection, mut queue: mpsc::Receiver<Message>) {
    while let Some(message) = queue.blocking_recv() {
        match message {
            Message::Run(job) => {
                job(&mut conn);
                ensure_closed(&conn);
            }
            Message::Stop(done) => {
                checkpoint_and_close(conn);
                let _ = done.send(());
                return;
            }
        }
    }
    checkpoint_and_close(conn);
}

impl Writer {
    pub fn start(conn: Connection, faults: Arc<Faults>) -> std::io::Result<Writer> {
        let (commits, _) = watch::channel(0);
        let (queue, receiver) = mpsc::channel(QUEUE_DEPTH);
        std::thread::Builder::new()
            .name("marfa-writer".into())
            .spawn(move || run_thread(conn, receiver))?;
        Ok(Writer {
            queue,
            faults,
            pulse: Pulse::new(),
            commits,
        })
    }

    /// Raised after every commit, once its rows can be read; a reader that takes the value
    /// before it reads sees every commit that follows.
    pub fn commits(&self) -> watch::Receiver<u64> {
        self.commits.subscribe()
    }

    pub fn pulse(&self) -> Pulse {
        self.pulse.clone()
    }

    /// A wait past `budget` before the job starts withdraws it, so a caller told to try again
    /// can be sure it never ran, unless the queue is held by a job whose [`Pulse`] beats within
    /// the budget. A started job always finishes, whether or not anyone reads its answer.
    pub async fn submit<T, F>(&self, write: Write, budget: Duration, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let started = Instant::now();
        let deadline = started + budget;
        let mut wait = started + budget.max(QUEUE_FLOOR);
        let ticket = Arc::new(AtomicU8::new(QUEUED));
        let (answer, mut answered) = oneshot::channel();
        let faults = self.faults.clone();
        let commits = self.commits.clone();
        let claim = ticket.clone();
        let run: Job = Box::new(move |conn| {
            if claim
                .compare_exchange(QUEUED, RUNNING, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let _ = answer.send(run_transaction(
                    conn, write, deadline, &faults, &commits, job,
                ));
            }
        });
        let send = self.queue.send(Message::Run(run));
        tokio::pin!(send);
        loop {
            match tokio::time::timeout_at(wait.into(), &mut send).await {
                Ok(Ok(())) => break,
                Ok(Err(_)) => return Err(Refusal::internal("the writer has stopped")),
                Err(_) => match self.waiting_on(budget) {
                    Some(later) => wait = later,
                    None => return Err(contention()),
                },
            }
        }
        let lost = |_| Refusal::internal("the writer has stopped");
        loop {
            match tokio::time::timeout_at(wait.into(), &mut answered).await {
                Ok(result) => return result.map_err(lost)?,
                Err(_) => {
                    if let Some(later) = self.waiting_on(budget) {
                        wait = later;
                        continue;
                    }
                    let withdrawn = ticket
                        .compare_exchange(QUEUED, ABANDONED, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok();
                    return if withdrawn {
                        Err(contention())
                    } else {
                        answered.await.map_err(lost)?
                    };
                }
            }
        }
    }

    fn waiting_on(&self, budget: Duration) -> Option<Instant> {
        let until = self.pulse.last() + budget.max(QUEUE_FLOOR);
        (until > Instant::now()).then_some(until)
    }

    pub async fn stop(&self) {
        let (done, stopped) = oneshot::channel();
        if self.queue.send(Message::Stop(done)).await.is_ok() {
            let _ = stopped.await;
        }
    }
}
