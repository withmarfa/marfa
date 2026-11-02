//! A folder takes out of its queue the answered writes it has recorded what
//! it needs from, so what each drain reads stays the size of what is still to
//! be answered or kept, not of every write the folder has sent
//! (`folders/clears-recorded-answers`).

use std::collections::HashSet;

use rusqlite::Connection;

use super::{Folder, relink};
use crate::{Result, store};

/// A drain with nothing to send clears only once more answered writes than
/// this have gathered. Each write taken out marks the copy changed, which the
/// next pass reads again, so a few answers wait for the next drain that
/// sends something and a quiet folder stays quiet.
const QUIET_CLEARS_AT: i64 = 100;

#[cfg(test)]
thread_local! {
    /// `QUIET_CLEARS_AT` for the tests on this thread, where set.
    pub(super) static QUIET_CLEARS_AT_HERE: std::cell::Cell<Option<i64>> =
        const { std::cell::Cell::new(None) };
}

impl Folder {
    /// Clears the answered writes, as a drain begins, where the drain has a
    /// write to send or more than `QUIET_CLEARS_AT` answered writes are in
    /// the queue. Answers how many writes left the queue.
    pub(super) fn clear_answered_if_due(&self) -> Result<usize> {
        let (waiting, answered): (bool, i64) = self.core.conn()?.query_row(
            "SELECT EXISTS (SELECT 1 FROM queue WHERE verdict IS NULL),
                    (SELECT count(*) FROM queue WHERE verdict IS NOT NULL)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        #[cfg(test)]
        let at = QUIET_CLEARS_AT_HERE
            .with(std::cell::Cell::get)
            .unwrap_or(QUIET_CLEARS_AT);
        #[cfg(not(test))]
        let at = QUIET_CLEARS_AT;
        if waiting || answered > at {
            self.clear_answered()
        } else {
            Ok(0)
        }
    }

    /// Clears the answered writes as `store::forget_answered` does, but for
    /// each whose answer the folder has yet to record. Answers how many
    /// writes left the queue.
    pub(super) fn clear_answered(&self) -> Result<usize> {
        self.core.lock.refuse_unless_writer()?;
        let mut conn = self.core.conn()?;
        let tx = conn.transaction()?;
        crate::body::rule::after_answers_in(&tx, None)?;
        let Some(kept) = self.unrecorded(&tx)? else {
            return Ok(0);
        };
        let cleared = store::forget_answered_except(&tx, &kept)?;
        tx.commit()?;
        Ok(cleared)
    }

    /// The writes whose answer the folder has yet to record, by id: each a
    /// file's record still waits on, each a link rewrite has yet to settle,
    /// each the body rule has yet to read, and each a placement has yet to
    /// give way on. `None` where a file's record cannot be read, which may
    /// name any write.
    fn unrecorded(&self, conn: &Connection) -> Result<Option<HashSet<String>>> {
        let Ok(mut kept) = store::awaited_by_files(conn) else {
            return Ok(None);
        };
        kept.extend(relink::unsettled(conn)?);
        kept.extend(crate::body::rule::awaited_writes(conn)?);
        kept.extend(self.awaiting_give_way(conn)?);
        Ok(Some(kept))
    }
}
