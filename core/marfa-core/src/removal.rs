use rusqlite::TransactionBehavior;

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
