//! The only door to SQLite. Nothing outside this module holds a `Connection`;
//! everything reads through [`Db::read`] and writes through [`Db::write`].

pub mod migrate;
mod open;
mod reader;
mod schema;
#[cfg(test)]
mod tests;
pub mod volume;
mod writer;

use std::sync::Arc;
use std::time::Duration;

use rusqlite::Transaction;

pub use open::Options;

use crate::app::faults::{FAIL_LOCK, Faults, HOLD_WRITE};
use crate::app::refusal::{Code, Refusal, Result};
use crate::failure::Failure;

/// Who a write is for, which decides the faults that can reach it.
#[derive(Clone, Copy, Debug)]
pub struct Write {
    /// The audit action it records. The server's own bookkeeping has none.
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

    pub const fn own() -> Write {
        Write {
            action: None,
            for_caller: false,
        }
    }
}

pub struct Db {
    readers: reader::Pool,
    writer: writer::Writer,
    faults: Arc<Faults>,
    budget: Duration,
}

impl Db {
    /// Blocks while it judges and updates the file, so it runs before the
    /// server takes requests.
    pub fn open(options: &Options, faults: Arc<Faults>) -> std::result::Result<Db, Failure> {
        let opened = open::open(options)?;
        let writer = writer::Writer::start(opened.writer, faults.clone())
            .map_err(|error| Failure::start(format!("The writer did not start: {error}")))?;
        Ok(Db {
            readers: reader::Pool::new(opened.readers),
            writer,
            faults,
            budget: options.busy_budget,
        })
    }

    fn with_budget(&self, refusal: Refusal) -> Refusal {
        if refusal.code == Code::WriteContention {
            refusal.with_detail("budget_ms", self.budget.as_millis() as u64)
        } else {
            refusal
        }
    }

    /// Runs `job` inside one read transaction on a pooled connection.
    pub async fn read<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        self.readers
            .read(job)
            .await
            .map_err(|refusal| self.with_budget(refusal))
    }

    /// Runs `job` on the writer thread inside a transaction, which commits on
    /// `Ok` and rolls back on `Err` or a panic.
    pub async fn write<T, F>(&self, write: Write, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        if write.action.is_some() {
            self.faults.hold(HOLD_WRITE, write.action).await;
        }
        if write.for_caller && self.faults.fail(FAIL_LOCK, None) {
            return Err(self.with_budget(Refusal::new(
                Code::WriteContention,
                "The database is busy; try again.",
            )));
        }
        self.writer
            .submit(write, self.budget, job)
            .await
            .map_err(|refusal| self.with_budget(refusal))
    }

    /// Closes the readers, runs what is queued, checkpoints and closes.
    pub async fn close(&self) {
        self.readers.close().await;
        self.writer.stop().await;
    }
}
