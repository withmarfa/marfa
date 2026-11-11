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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Whether the commit reaches stable storage before it returns.
    pub sync: bool,
}

impl Write {
    pub const fn caller(action: &'static str) -> Write {
        Write {
            action: Some(action),
            for_caller: true,
            sync: true,
        }
    }

    pub const fn server(action: &'static str) -> Write {
        Write {
            action: Some(action),
            for_caller: false,
            sync: true,
        }
    }

    pub const fn own() -> Write {
        Write {
            action: None,
            for_caller: false,
            sync: true,
        }
    }

    /// For a commit that confirms nothing, and that a power cut can lose only with every synced
    /// commit after it, since a sync covers every earlier frame of the log.
    pub const fn unsynced(self) -> Write {
        Write {
            sync: false,
            ..self
        }
    }
}

pub struct Db {
    readers: reader::Pool,
    writer: writer::Writer,
    faults: Arc<Faults>,
    budget: Duration,
    /// A statement has met pages SQLite cannot read; nothing clears it but a restart.
    damaged: AtomicBool,
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
            damaged: AtomicBool::new(false),
        })
    }

    /// Whether the file has answered a statement with damage since the server started.
    pub fn damaged(&self) -> bool {
        self.damaged.load(Ordering::Relaxed)
    }

    fn answered(&self, refusal: Refusal) -> Refusal {
        if matches!(
            refusal.database_code(),
            Some("SQLITE_CORRUPT" | "SQLITE_NOTADB")
        ) {
            self.damaged.store(true, Ordering::Relaxed);
        }
        if refusal.code == Code::WriteContention {
            refusal.with_detail("budget_ms", self.budget.as_millis() as u64)
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
            .map_err(|refusal| self.answered(refusal))
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
            .map_err(|refusal| self.answered(refusal))
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
        if write.action.is_some() {
            self.faults.hold(HOLD_WRITE, write.action).await;
        }
        if self.faults.refusing(REFUSE_WRITE) {
            return Err(io_refusal());
        }
        if !self.wait_out_lock().await {
            return Err(self.answered(Refusal::new(
                Code::WriteContention,
                "The database is busy; try again.",
            )));
        }
        if write.for_caller && self.faults.fail(FAIL_LOCK, None) {
            return Err(self.answered(Refusal::new(
                Code::WriteContention,
                "The database is busy; try again.",
            )));
        }
        self.writer
            .submit(write, self.budget, job)
            .await
            .map_err(|refusal| self.answered(refusal))
    }

    /// Waits as for a lock another connection holds, until it is let go or the write wait is spent.
    async fn wait_out_lock(&self) -> bool {
        if !self.faults.refusing(REFUSE_WRITE_LOCK) {
            return true;
        }
        let deadline = tokio::time::Instant::now() + self.budget;
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

    /// The settings each connection runs with, for a test to read.
    #[cfg(feature = "test-hooks")]
    pub async fn connection_settings(&self) -> Result<serde_json::Value> {
        const NAMES: [&str; 5] = [
            "journal_mode",
            "synchronous",
            "fullfsync",
            "checkpoint_fullfsync",
            "foreign_keys",
        ];
        fn look(conn: &rusqlite::Connection) -> serde_json::Value {
            let found: serde_json::Map<String, serde_json::Value> = NAMES
                .iter()
                .map(|name| {
                    let value = conn
                        .pragma_query_value(None, name, |row| {
                            row.get::<_, rusqlite::types::Value>(0)
                        })
                        .ok()
                        .map_or(serde_json::Value::Null, |value| match value {
                            rusqlite::types::Value::Integer(number) => number.into(),
                            rusqlite::types::Value::Text(text) => text.into(),
                            _ => serde_json::Value::Null,
                        });
                    (name.to_string(), value)
                })
                .collect();
            found.into()
        }
        let writer = self.write(Write::own(), |tx| Ok(look(tx))).await?;
        let readers = self.readers.each(look).await?;
        Ok(serde_json::json!({ "writer": writer, "readers": readers }))
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
