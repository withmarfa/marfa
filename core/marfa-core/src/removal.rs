use crate::model::Subject;
use crate::{Core, Result, reach, store};

impl Core {
    /// Sends a purge the server announces as `item.purged`, and once it is
    /// accepted takes the row out and keeps it out until that event is read
    /// (`device/deleted-stays-gone`).
    pub(crate) fn purge_sent<T>(&self, id: &str, send: impl FnOnce() -> Result<T>) -> Result<()> {
        let generation = {
            let conn = self.conn()?;
            store::removal_sent(&conn, Subject::Item, id)?;
            reach::generation(&conn)?
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
