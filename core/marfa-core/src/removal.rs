use rusqlite::TransactionBehavior;

use crate::model::Subject;
use crate::{Core, Result, reach, store, telemetry};

pub(crate) struct HeldRemoving<'a> {
    core: &'a Core,
    ids: Vec<String>,
}

impl Drop for HeldRemoving<'_> {
    fn drop(&mut self) {
        let conn = self
            .core
            .conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Err(error) = store::release_removing(&conn, &self.ids) {
            telemetry::degraded!(&error);
        }
    }
}

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
    /// Lets go of `ids`, which `store::hold_removing` held in a transaction
    /// that has committed, once what it answers is dropped. Taken only with
    /// the connection free, since the drop locks it.
    pub(crate) fn removing_held(&self, ids: Vec<String>) -> HeldRemoving<'_> {
        HeldRemoving { core: self, ids }
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
