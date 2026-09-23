//! One store, one writer (`device.md` 3).
//!
//! A second opener gets a handle that reads and refuses every write, and says
//! which it is. Two writers on one file would each hold a queue the other
//! cannot see, and each would drain it: the same write sent twice under two
//! idempotency keys, which is the one thing `queue-and-verdicts.md` 3 exists
//! to prevent.
//!
//! **The lock is an exclusive transaction on a database of its own**, a file
//! beside the store. SQLite takes the lock in the kernel and the kernel drops
//! it when the process ends, however it ends, so there is no stale lock to
//! reap and no pid to check against a process the system may have recycled. A
//! flag in a table would need both.
//!
//! It is a separate file rather than the store itself because the store is
//! read in WAL mode by both handles at once, which is the point: a reader
//! reads while the writer writes, and only writing is exclusive.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::CoreError;

/// Which handle this process holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    /// The one handle that may write.
    Writer,
    /// A second opener: reads answer, writes are refused.
    Reader,
}

/// The writer's claim on a store, held for as long as the value lives.
pub struct WriterLock {
    /// Dropped with the value, which is what releases the lock. Held rather
    /// than read, and behind a `Mutex` because a `Connection` is not `Sync`
    /// and the bindings hand a `Core` across threads.
    _claim: Mutex<Option<Connection>>,
    handle: Handle,
}

impl WriterLock {
    /// Claims the writer handle for `store`, or reports that another process
    /// holds it.
    ///
    /// An in-memory store has no path to put a lock file beside and no second
    /// process that could open it, so it is always the writer.
    pub fn claim(store: Option<&Path>) -> Result<WriterLock, CoreError> {
        let Some(store) = store else {
            return Ok(WriterLock {
                _claim: Mutex::new(None),
                handle: Handle::Writer,
            });
        };
        let path = store.with_extension("writer-lock");
        let claim = Connection::open(&path)?;
        // Zero, deliberately. Waiting would turn a second opener into a
        // process that hangs rather than one that is told it may only read,
        // and `device.md` 3 is about being told.
        claim.busy_timeout(std::time::Duration::from_millis(0))?;
        match claim.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) => Ok(WriterLock {
                _claim: Mutex::new(Some(claim)),
                handle: Handle::Writer,
            }),
            Err(error) if is_busy(&error) => Ok(WriterLock {
                _claim: Mutex::new(None),
                handle: Handle::Reader,
            }),
            Err(error) => Err(error.into()),
        }
    }

    /// The handle of a store opened to read: it never touches the lock
    /// file, so it can neither take the writer role nor keep it from anyone.
    pub fn reader() -> WriterLock {
        WriterLock {
            _claim: Mutex::new(None),
            handle: Handle::Reader,
        }
    }

    pub fn handle(&self) -> Handle {
        self.handle
    }

    /// Refuses a write from a reading handle, naming which handle this is.
    pub fn refuse_unless_writer(&self) -> Result<(), CoreError> {
        match self.handle {
            Handle::Writer => Ok(()),
            Handle::Reader => Err(CoreError::ReadingHandle),
        }
    }
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_opener_gets_a_reading_handle() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("core.sqlite");

        let first = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(first.handle(), Handle::Writer);
        assert!(first.refuse_unless_writer().is_ok());

        // The same store, claimed again while the first claim is live. This
        // is one process rather than two, which is what makes it a test: the
        // lock is held in the kernel against the file, so a second claim from
        // anywhere sees it.
        let second = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(second.handle(), Handle::Reader);
        assert_eq!(second.refuse_unless_writer(), Err(CoreError::ReadingHandle));

        // And the claim goes with the value, so the next opener is the
        // writer. Without this the lock would be a one-way door and a
        // process that had merely finished would lock the store forever.
        drop(first);
        drop(second);
        let third = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(third.handle(), Handle::Writer);
    }
}
