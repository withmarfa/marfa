//! A folder takes out of its queue the answered writes it has recorded what
//! it needs from, so what each drain reads stays the size of what is still to
//! be answered or kept, not of every write the folder has sent
//! (`folders/clears-recorded-answers`).

use std::collections::HashSet;

use rusqlite::Connection;

use super::{Folder, relink};
use crate::{Result, store};

impl Folder {
    /// Clears the answered writes, as a drain begins, where the queue holds
    /// one the clearing could take. An answered write leaving the queue
    /// changes nothing a pull reads, so a quiet folder stays quiet. Answers
    /// how many writes left the queue.
    pub(super) fn clear_answered_if_due(&self) -> Result<usize> {
        if store::holds_clearable_answers(&*self.core.conn()?)? {
            self.clear_answered()
        } else {
            Ok(0)
        }
    }

    /// Clears the answered writes as `store::forget_answered` does, but for
    /// each whose answer the folder has yet to record. Clears nothing until
    /// the server's origin is the copy's, as a drain changes nothing before
    /// it is (`device/origin-unconfirmed-keeps-copy`). Answers how many
    /// writes left the queue.
    pub(super) fn clear_answered(&self) -> Result<usize> {
        self.core.lock.refuse_unless_writer()?;
        if !self
            .core
            .http()
            .is_ok_and(crate::http::Http::origin_admitted)
        {
            return Ok(0);
        }
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
    /// file's record still waits on, and each a link rewrite has yet to
    /// settle. `None` where a file's record cannot be read, which may name
    /// any write. What else reads an answer is kept by `forget_answered`'s
    /// own rules: a give-way reads refused edge creates, which carry content,
    /// and blocked writes; the body rule has read every answer it follows
    /// before this, in the same transaction, and a waiting link edge depends
    /// on the body write it was read from.
    fn unrecorded(&self, conn: &Connection) -> Result<Option<HashSet<String>>> {
        let Ok(mut kept) = store::awaited_by_files(conn) else {
            return Ok(None);
        };
        kept.extend(relink::unsettled(conn)?);
        Ok(Some(kept))
    }
}
