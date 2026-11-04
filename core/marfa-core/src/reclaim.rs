//! Giving the pages a copy has freed back to the disk.
//!
//! SQLite keeps a page that a delete frees in the file for the next insert, so
//! a copy whose rows left (an eviction after the slice narrowed, a bin
//! emptied) stays as large as it ever was. Only `VACUUM` writes the file
//! again without them. It rewrites the whole store, so it runs only where the
//! file is mostly free pages, and the decision reads two pragmas.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::Connection;

use crate::lock::Handle;
use crate::{Core, CoreError, Mover, store, streaming_of};

/// The fewest free pages that are worth a rewrite: 4 MiB at SQLite's default
/// page size of 4 KiB.
pub(crate) const MIN_FREE_PAGES: i64 = 1024;

/// The share of the file's pages that must be free, as numerator and
/// denominator: a rewrite of a file that is mostly live frees little and
/// costs the most.
pub(crate) const MIN_FREE_SHARE: (i64, i64) = (1, 2);

/// How long after a `VACUUM` was refused for want of the store (a reader or
/// another statement held it) before the next try.
pub(crate) const RETRY_AFTER_BUSY: Duration = Duration::from_secs(30);

/// How long after a `VACUUM` failed (a full disk, say) before the next try,
/// so a failure that stands is not met again at every pass.
pub(crate) const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(15 * 60);

#[cfg(test)]
type RewriteHook = Box<dyn Fn(&Connection)>;

#[cfg(test)]
thread_local! {
    /// Runs on the connection just before the rewrite starts, so a test can
    /// arm a failure that the preliminary reads do not meet.
    pub(crate) static TEST_BEFORE_REWRITE: std::cell::RefCell<Option<RewriteHook>> =
        const { std::cell::RefCell::new(None) };
}

/// What `Core::reclaim_space` did.
#[derive(Debug)]
pub(crate) enum Reclaim {
    /// The rule is false: too little is free to be worth a rewrite.
    Nothing,
    /// The rule holds and the store was not rewritten now: the copy is not a
    /// writer, is hydrating or catching up, is held by another statement or
    /// reader, is waiting out a refusal, or the caller is stopping. A later
    /// round tries again.
    Skipped,
    /// The store was rewritten without its free pages. Sizes are in bytes, as
    /// the pragmas count them; the file has shrunk too: the log was checkpointed
    /// before this is reported.
    Reclaimed { from: u64, to: u64 },
    /// The rewrite failed and left the store as it was.
    Failed(CoreError),
}

/// Whether the rule holds: at least `MIN_FREE_PAGES` free and at least
/// `MIN_FREE_SHARE` of all pages. Two pragma reads.
pub(crate) fn due(conn: &Connection) -> Result<bool, CoreError> {
    let (pages, free) = pages(conn)?;
    let (numerator, denominator) = MIN_FREE_SHARE;
    Ok(free >= MIN_FREE_PAGES
        && free.saturating_mul(denominator) >= pages.saturating_mul(numerator))
}

fn pages(conn: &Connection) -> Result<(i64, i64), CoreError> {
    let pages = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let free = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    Ok((pages, free))
}

fn bytes(conn: &Connection) -> Result<u64, CoreError> {
    let (pages, _) = pages(conn)?;
    let size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    Ok(u64::try_from(pages).unwrap_or(0) * u64::try_from(size).unwrap_or(0))
}

/// The connection's usual wait for a lock, which `without_waiting` restores.
const CONNECTION_WAIT: Duration = Duration::from_secs(5);

/// Runs `work` with the connection refusing to wait for a lock, and gives it
/// its wait back after, whether `work` succeeded or not.
fn without_waiting<T>(
    conn: &Connection,
    work: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    conn.busy_timeout(Duration::ZERO)?;
    let result = work();
    let restored = conn.busy_timeout(CONNECTION_WAIT);
    let value = result?;
    restored?;
    Ok(value)
}

/// Moves the log into the file and truncates it. `true` only when all of it
/// went: a reader that holds an older view stops the checkpoint short, which
/// SQLite reports in the result row (`busy`, then the log's pages and the
/// pages checkpointed) and not as an error.
fn checkpointed(conn: &Connection) -> Result<bool, CoreError> {
    match conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        Ok((blocked, log, done)) => Ok(blocked == 0 && log == done),
        Err(error) if busy(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

impl Core {
    /// Rewrites the store without its free pages where `due` says it is worth
    /// it. It never waits and never fails its caller: whatever stands in the
    /// way is a `Skipped`, or a `Failed` that the caller may tell, and a try
    /// that was refused is not made again before `RETRY_AFTER_BUSY` or
    /// `RETRY_AFTER_FAILURE` has passed.
    ///
    /// Judged from the store's state alone, so a copy that let its rows go
    /// before this ran is reclaimed too. The writer's role is what lets it
    /// rewrite the file, and a hydration (which a refill is) or a catch-up
    /// owns the store until it ends.
    pub(crate) fn reclaim_space(&self, stopping: &AtomicBool) -> Reclaim {
        if self.handle() != Handle::Writer || stopping.load(Ordering::SeqCst) {
            return Reclaim::Skipped;
        }
        if self.reclaim_held_until.lock().map_or(true, |until| {
            until.is_some_and(|at| crate::clock::now() < at)
        }) {
            return Reclaim::Skipped;
        }
        if matches!(
            streaming_of(&self.streaming).holder,
            Some(Mover::Hydration | Mover::CatchUp)
        ) {
            return Reclaim::Skipped;
        }
        // Not `conn()`, which waits: a step of the follow that holds the
        // connection is not held up by this.
        let Ok(conn) = self.conn.try_lock() else {
            return Reclaim::Skipped;
        };
        match self.reclaim_in(&conn) {
            Ok(reclaim) => reclaim,
            Err(error) => {
                self.hold_off(RETRY_AFTER_FAILURE);
                Reclaim::Failed(error)
            }
        }
    }

    fn reclaim_in(&self, conn: &Connection) -> Result<Reclaim, CoreError> {
        let owed = self.reclaim_pending.lock().map_or(None, |owed| *owed);
        if owed.is_none() && !due(conn)? {
            return Ok(Reclaim::Nothing);
        }
        // `VACUUM` is refused inside a transaction, and a store whose
        // hydration has not finished is the hydration's to change.
        if !conn.is_autocommit() || !store::hydration_complete(conn)? {
            return Ok(Reclaim::Skipped);
        }
        let from = match owed {
            Some(from) => from,
            None => bytes(conn)?,
        };
        // A reader of the store, or a statement of this process, is a try for
        // later: waiting, in the rewrite or in the checkpoint, would hold up
        // the watch and everything else that waits for the connection.
        let finished = without_waiting(conn, || {
            if owed.is_none() {
                #[cfg(test)]
                TEST_BEFORE_REWRITE.with(|hook| {
                    if let Some(hook) = hook.borrow().as_ref() {
                        hook(conn);
                    }
                });
                if let Err(error) = conn.execute_batch("VACUUM") {
                    return if busy(&error) {
                        Ok(None)
                    } else {
                        Err(error.into())
                    };
                }
                self.owe_checkpoint(Some(from));
            }
            checkpointed(conn).map(Some)
        })?;
        // `None`: the rewrite was refused for want of the store. `Some(false)`:
        // the rewrite is in the log, and a reader that still holds an older
        // view keeps the checkpoint from finishing. The file has not shrunk,
        // so nothing is reported; the checkpoint stays owed, whether or not
        // pages are free, and a later round makes it.
        if finished != Some(true) {
            self.hold_off(RETRY_AFTER_BUSY);
            return Ok(Reclaim::Skipped);
        }
        self.owe_checkpoint(None);
        Ok(Reclaim::Reclaimed {
            from,
            to: bytes(conn)?,
        })
    }

    /// Records, or clears, a checkpoint that a rewrite is still owed, with
    /// the size the store had before it. Kept in memory: a restart finds a
    /// log that SQLite's own checkpoints (the automatic one, and the one the
    /// last connection makes on closing) bring into the file, so only the
    /// wait for that is lost.
    fn owe_checkpoint(&self, from: Option<u64>) {
        if let Ok(mut owed) = self.reclaim_pending.lock() {
            *owed = from;
        }
    }

    fn hold_off(&self, wait: Duration) {
        if let Ok(mut until) = self.reclaim_held_until.lock() {
            *until = Some(crate::clock::now() + wait);
        }
    }
}
