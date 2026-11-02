//! A folder takes out of its queue the answered writes it has recorded what
//! it needs from, so what each drain reads stays the size of what is still to
//! be answered or kept, not of every write the folder has sent
//! (`folders/clears-recorded-answers`).

use std::collections::HashSet;

use rusqlite::Connection;

use super::{Folder, relink};
use crate::{Result, store};

impl Folder {
    /// Clears the answered writes as `store::forget_answered` does, but for
    /// each whose answer the folder has yet to record. Run as a drain
    /// begins, so the answers of the drain before it stay in the queue until
    /// then. Answers how many writes left the queue.
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
