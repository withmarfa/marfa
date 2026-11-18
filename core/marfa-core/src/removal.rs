use std::sync::MutexGuard;

use rusqlite::{Connection, TransactionBehavior};

use crate::model::Subject;
use crate::{Core, Result, reach, store};

impl Core {
    /// Sends a purge the server announces as `item.purged`, and once it is
    /// accepted takes the row out and keeps it out until that event is read
    /// (`device/deleted-stays-gone`).
    pub(crate) fn purge_sent<T>(&self, id: &str, send: impl FnOnce() -> Result<T>) -> Result<()> {
        // One transaction: a hydration starting between the two would take
        // the mark away and leave a generation the purge then trusts.
        let generation = {
            let mut conn = self.conn()?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            store::removal_sent(&tx, Subject::Item, id)?;
            let generation = reach::generation(&tx)?;
            tx.commit()?;
            generation
        };
        let sent = send();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // A hydration while the request was in flight may have replaced the
        // copy; the accepted write says nothing about that replacement.
        if sent.is_ok() && reach::generation(&tx)? == generation {
            store::purge_item(&tx, id)?;
            store::removal_accepted(&tx, Subject::Item, id)?;
        } else {
            store::removal_unsent(&tx, Subject::Item, id)?;
        }
        tx.commit()?;
        sent.map(|_| ())
    }
}

impl Core {
    /// Holds `ids` against new writes until what it answers is dropped.
    /// Taken with the connection held, so that no write is queued between
    /// the caller's check for waiting writes and the hold.
    pub(crate) fn hold_removing(
        &self,
        _checked: &MutexGuard<'_, Connection>,
        ids: Vec<String>,
        by: store::Removing,
    ) -> Result<store::HeldRemoving> {
        self.removing.hold(ids, by)
    }

    /// Refuses a write sent at once to `item` while a trash or a purge holds it.
    pub(crate) fn refuse_removing(&self, item: &str) -> Result<()> {
        self.removing.refuse(item)
    }

    /// Each write in `waiting`, with the way to clear it (or the write it waits on).
    pub(crate) fn exits_of(&self, waiting: &[crate::QueuedWrite]) -> Result<String> {
        let queue = store::queued_writes(&*self.conn()?)?;
        let mut blockers = crate::model::Blockers::new(&queue);
        Ok(waiting
            .iter()
            .map(|write| match blockers.of(write) {
                Some(blocker) => format!(
                    "{} ({}) waits on {} ({}): {}",
                    write.id,
                    write.kind,
                    blocker.id,
                    blocker.kind,
                    blocker.exits()
                ),
                None => format!("{} ({}): {}", write.id, write.kind, write.exits()),
            })
            .collect::<Vec<_>>()
            .join("; "))
    }
}
