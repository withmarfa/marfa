//! The only door to SQLite; nothing outside holds a `Connection`.

pub mod migrate;
mod open;
pub mod rank;
mod reader;
mod schema;
#[cfg(test)]
mod tests;
pub mod volume;
mod writer;

use std::sync::Arc;
use std::time::Duration;

use rusqlite::Transaction;
use tokio::sync::watch;

pub use open::Options;
pub use writer::Pulse;

use crate::app::faults::{
    FAIL_LOCK, Faults, HOLD_WRITE, REFUSE_READ, REFUSE_WRITE, REFUSE_WRITE_LOCK,
};
use crate::app::refusal::{Code, Refusal, Result};
use crate::failure::Failure;

/// The refusal a database that cannot be read or written gives.
pub fn io_refusal() -> Refusal {
    Refusal::from(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
        None,
    ))
}

#[derive(Clone, Copy, Debug)]
pub struct Write {
    pub action: Option<&'static str>,
    pub for_caller: bool,
}

impl Write {
    pub const fn caller(action: &'static str) -> Write {
        Write {
            action: Some(action),
            for_caller: true,
        }
    }

    pub const fn server(action: &'static str) -> Write {
        Write {
            action: Some(action),
            for_caller: false,
        }
    }

    pub const fn own() -> Write {
        Write {
            action: None,
            for_caller: false,
        }
    }
}

/// How long bookkeeping waits for a busy writer.
const BRIEF_WAIT: Duration = Duration::from_millis(100);

pub struct Db {
    readers: reader::Pool,
    writer: writer::Writer,
    faults: Arc<Faults>,
    budget: Duration,
}

impl Db {
    /// Blocks while it judges and updates the file, so it runs before the server takes requests.
    pub fn open(options: &Options, faults: Arc<Faults>) -> std::result::Result<Db, Failure> {
        let opened = open::open(options, &faults)?;
        let writer = writer::Writer::start(opened.writer, faults.clone())
            .map_err(|error| Failure::start(format!("The writer did not start: {error}")))?;
        Ok(Db {
            readers: reader::Pool::new(opened.readers),
            writer,
            faults,
            budget: options.write_wait,
        })
    }

    fn with_budget(&self, refusal: Refusal, budget: Duration) -> Refusal {
        if refusal.code == Code::WriteContention {
            refusal.with_detail("budget_ms", budget.as_millis() as u64)
        } else {
            refusal
        }
    }

    pub async fn read<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        if self.faults.refusing(REFUSE_READ) {
            return Err(io_refusal());
        }
        self.readers
            .read(job)
            .await
            .map_err(|refusal| self.with_budget(refusal, self.budget))
    }

    /// As `read`, behind other work: for a long read that no request waits on.
    pub async fn read_background<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        if self.faults.refusing(REFUSE_READ) {
            return Err(io_refusal());
        }
        self.readers
            .read_background(job)
            .await
            .map_err(|refusal| self.with_budget(refusal, self.budget))
    }

    /// Empties the log a large write grew, so it does not stay the size of that write.
    pub async fn empty_log(&self) {
        self.writer.empty_log().await;
    }

    /// Commits on `Ok` and rolls back on `Err` or a panic.
    pub async fn write<T, F>(&self, write: Write, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        self.write_within(self.budget, write, job).await
    }

    /// As `write`, for bookkeeping no request should wait on: a busy writer costs the write.
    pub async fn write_briefly<T, F>(&self, write: Write, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        self.write_within(self.budget.min(BRIEF_WAIT), write, job)
            .await
    }

    async fn write_within<T, F>(&self, budget: Duration, write: Write, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        if write.action.is_some() {
            self.faults.hold(HOLD_WRITE, write.action).await;
        }
        if self.faults.refusing(REFUSE_WRITE) {
            return Err(io_refusal());
        }
        if !self.wait_out_lock(budget).await {
            return Err(self.with_budget(
                Refusal::new(Code::WriteContention, "The database is busy; try again."),
                budget,
            ));
        }
        if write.for_caller && self.faults.fail(FAIL_LOCK, None) {
            return Err(self.with_budget(
                Refusal::new(Code::WriteContention, "The database is busy; try again."),
                budget,
            ));
        }
        self.writer
            .submit(write, budget, job)
            .await
            .map_err(|refusal| self.with_budget(refusal, budget))
    }

    /// Waits as for a lock another connection holds, until it is let go or the write wait is spent.
    async fn wait_out_lock(&self, budget: Duration) -> bool {
        if !self.faults.refusing(REFUSE_WRITE_LOCK) {
            return true;
        }
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            if !self.faults.is_refusing(REFUSE_WRITE_LOCK) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub fn commits(&self) -> watch::Receiver<u64> {
        self.writer.commits()
    }

    /// Beaten by a job that writes longer than the write wait, so writes queued behind it wait.
    pub fn pulse(&self) -> Pulse {
        self.writer.pulse()
    }

    pub async fn close(&self) {
        self.readers.close().await;
        self.writer.stop().await;
    }
}
