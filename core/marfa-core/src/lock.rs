//! The writer lock is an exclusive transaction on a database file of its own
//! beside the store. The kernel drops it when the process ends, however it
//! ends, so there is no stale lock to reap and no recycled pid to check. It is
//! not the store itself because both handles read the store in WAL mode.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::CoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Writer,
    Reader,
}

pub struct WriterLock {
    /// Dropping it releases the lock. Behind a `Mutex` because a `Connection`
    /// is not `Sync` and the bindings hand a `Core` across threads.
    _claim: Mutex<Option<Connection>>,
    handle: Handle,
}

impl WriterLock {
    /// An in-memory store (`None`) is always the writer.
    pub fn claim(store: Option<&Path>) -> Result<WriterLock, CoreError> {
        let Some(store) = store else {
            return Ok(WriterLock {
                _claim: Mutex::new(None),
                handle: Handle::Writer,
            });
        };
        let path = store.with_extension("writer-lock");
        let claim = Connection::open(&path)?;
        // Zero: waiting would make a second opener hang instead of being told
        // it may only read.
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

    /// Never touches the lock file, so it cannot keep the writer role from
    /// anyone.
    pub fn reader() -> WriterLock {
        WriterLock {
            _claim: Mutex::new(None),
            handle: Handle::Reader,
        }
    }

    pub fn handle(&self) -> Handle {
        self.handle
    }

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

        let second = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(second.handle(), Handle::Reader);
        assert_eq!(second.refuse_unless_writer(), Err(CoreError::ReadingHandle));

        drop(first);
        drop(second);
        let third = WriterLock::claim(Some(&store)).unwrap();
        assert_eq!(third.handle(), Handle::Writer);
    }
}
