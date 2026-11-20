//! The queue of unsent writes: draining it, releasing, withdrawing and
//! discarding what it holds, and forgetting what the server answered.

use std::sync::MutexGuard;
use std::sync::atomic::AtomicBool;

#[cfg(debug_assertions)]
use crate::fault;
use crate::{
    BlockedReason, Core, CoreError, DrainReport, NEVER_STOPPED, QueuedWrite, Result, WriteKind,
    body, catch_up, drain, hydrate, row_writes, store,
};

impl Core {
    /// Answerable without a hydration, unlike the reads: a caller must be
    /// able to learn what is outstanding before it can hydrate.
    pub fn queue(&self) -> Result<Vec<QueuedWrite>> {
        let conn = self.conn()?;
        store::queued_writes(&conn)
    }

    /// The refused creates whose move onto the row their natural key names
    /// waits for a read that finds it, each with the id of that row. Each
    /// still holds the writes that depend on it, whatever its verdict says,
    /// until it is discarded.
    pub fn pending_landings(&self) -> Result<std::collections::HashMap<String, String>> {
        store::pending_landings(&*self.conn()?)
    }

    /// One pass: every sendable row is attempted once, until the server
    /// cannot be reached. A drain called while another runs on this store
    /// waits for it to end, then sends only what is still unanswered.
    pub fn drain(&self) -> Result<DrainReport> {
        self.drain_until(&NEVER_STOPPED)
    }

    /// Ended with `Canceled` soon after `stop` is raised, without waiting on a
    /// request in flight: a write stays queued as sent and the next drain sends
    /// it again under its key, or by its content for an upload; a read-back
    /// stays owed for the next drain. An answer that arrives after the stop is
    /// dropped. Answers already recorded remain in the queue.
    pub fn drain_until(&self, stop: &AtomicBool) -> Result<DrainReport> {
        let _one = self.wait_to_drain(stop)?;
        let report = drain::drain(self, stop)?;
        if report.answered > 0 {
            self.watch.drained();
        }
        Ok(report)
    }

    /// Waits as `drain_until` does, then drains only where work is left for
    /// a drain: whatever held the queue meanwhile may have done it. `None`
    /// where none is left.
    pub(crate) fn drain_what_remains(&self, stop: &AtomicBool) -> Option<Result<DrainReport>> {
        #[cfg(debug_assertions)]
        fault::hold(|| "recovery-drain-asked");
        let _one = match self.wait_to_drain(stop) {
            Ok(one) => one,
            Err(error) => return Some(Err(error)),
        };
        match drain::would_send(self) {
            Ok(false) => {
                self.owe_drain(false);
                #[cfg(debug_assertions)]
                fault::hold(|| "recovery-drain-found-none");
                None
            }
            Ok(true) => Some(drain::drain(self, stop)),
            Err(error) => Some(Err(error)),
        }
    }

    fn wait_to_drain(&self, stop: &AtomicBool) -> Result<MutexGuard<'_, ()>> {
        loop {
            catch_up::refuse_if_stopped(stop)?;
            match self.draining.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    return Ok(poisoned.into_inner());
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    #[cfg(debug_assertions)]
                    fault::hold(|| "drain-waiting");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
    }

    pub(crate) fn one_drain(&self) -> MutexGuard<'_, ()> {
        // Holds nothing a panic could leave half-written: the queue is in the
        // store.
        self.draining
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A drain that ends in an error keeps what it settled before it.
    pub(crate) fn drain_held(
        &self,
        _one: &MutexGuard<'_, ()>,
    ) -> std::result::Result<DrainReport, drain::Cut> {
        drain::drain_keeping(self, &NEVER_STOPPED)
    }

    /// Under the write's own idempotency key, or for a row write its batch's,
    /// with every write of the batch, unless blocked `key_spent`,
    /// `conflict_unresolved` or `ancestor_unavailable`, which go under a fresh
    /// one. Answers `false` for a row that is not
    /// blocked, dead or refused without being sent, for one held behind
    /// another write, and for one refused because what it waited for was
    /// withdrawn. A write held `record_unread`, or a row write whose batch
    /// holds one, where the copy is not built from the instance its set-aside
    /// recorded, has each such write held `instance_changed` instead,
    /// answering `false`.
    pub fn release(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let released = store::release(&tx, id)?;
        if released {
            hydrate::lay_queue_over(
                &tx,
                &crate::catalog::load(&tx)?,
                &store::whole_edge_types(&tx)?,
                self.credential().as_deref(),
            )?;
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(released)
    }

    pub fn release_reason(&self, reason: BlockedReason) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        let ids: Vec<String> = store::queued_writes(&conn)?
            .into_iter()
            .filter(|row| row.blocked_reason() == Some(reason))
            .map(|row| row.id)
            .collect();
        drop(conn);
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // A write released or held with its batch is passed over, so no
        // batch is both held for the instance and released by one call.
        for id in &ids {
            if store::queued_write(&tx, id)?.is_some_and(|row| row.blocked_reason() == Some(reason))
            {
                store::release(&tx, id)?;
            }
        }
        let mut released = 0;
        for id in &ids {
            if store::queued_write(&tx, id)?.is_some_and(|row| row.blocked_reason().is_none()) {
                released += 1;
            }
        }
        if released > 0 {
            hydrate::lay_queue_over(
                &tx,
                &crate::catalog::load(&tx)?,
                &store::whole_edge_types(&tx)?,
                self.credential().as_deref(),
            )?;
        }
        row_writes::flush(&tx)?;
        // One transaction: a release part-way through would leave some rows
        // on a fresh key and some on a spent one.
        tx.commit()?;
        Ok(released)
    }

    /// Reads every affected row back before changing the queue or copy.
    pub fn withdraw(&self, id: &str) -> Result<Vec<String>> {
        self.lock.refuse_unless_writer()?;
        if store::queued_write(&*self.conn()?, id)?.is_none() {
            return Err(CoreError::NotFound {
                server: None,
                code: "queued_write_not_found".into(),
                message: format!("{id} is not a write this queue holds"),
            });
        }
        let batch = row_writes::batch_of(&*self.conn()?, id)?;
        let mut taken = Vec::with_capacity(batch.len());
        for write in &batch {
            let Some(row) = store::queued_write(&*self.conn()?, write)? else {
                return Ok(Vec::new());
            };
            if !row.withdrawable() {
                return Ok(Vec::new());
            }
            let held = store::held_for(&*self.conn()?, write)?;
            let mut reads = vec![drain::read_back(self, &row)?];
            for dependant in &held {
                reads.push(drain::read_back(self, dependant)?);
            }
            taken.push((row, held, reads));
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // Another thread may have released or answered a row while the
        // reads were out.
        if row_writes::batch_of(&tx, id)? != batch {
            return Ok(Vec::new());
        }
        for (row, held, _) in &taken {
            if store::queued_write(&tx, &row.id)?.as_ref() != Some(row)
                || store::held_for(&tx, &row.id)? != *held
            {
                return Ok(Vec::new());
            }
        }
        for (row, held, reads) in taken.iter().rev() {
            drain::withdraw_read_backs(&tx, row, held, reads)?;
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(batch)
    }

    /// `withdraw` for a write the device made on its own, which no one is
    /// asked about: it alone leaves the queue, and every write that waited
    /// on it goes on as if it had never been queued, never refused for it.
    /// The row is read back first; the check that it is still as read and
    /// its taking out are one transaction.
    pub(crate) fn withdraw_alone(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let Some(row) = store::queued_write(&*self.conn()?, id)? else {
            return Ok(false);
        };
        if !row.withdrawable() {
            return Ok(false);
        }
        let read = drain::read_back(self, &row)?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        if store::queued_write(&tx, id)?.as_ref() != Some(&row) {
            return Ok(false);
        }
        store::stop_waiting_on(&tx, id)?;
        drain::withdraw_read_backs(&tx, &row, &[], &[read])?;
        if let Some(item) = row.item_id.as_deref() {
            store::refollow(&tx, item, id)?;
        }
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(true)
    }

    pub(crate) fn rebase_on_held(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let Some(row) = store::queued_write(&tx, id)? else {
            return Ok(false);
        };
        if row.kind != WriteKind::UpdateItem
            || row.blocked_reason() != Some(BlockedReason::AncestorUnavailable)
        {
            return Ok(false);
        }
        let Some(held) = row
            .item_id
            .as_deref()
            .map(|item| store::item_by_id(&tx, item))
            .transpose()?
            .flatten()
        else {
            return Ok(false);
        };
        if row.base_version.is_none_or(|base| base >= held.version) {
            return Ok(false);
        }
        // With its base gone, nothing tells a property it left out from one
        // added since, so it goes as a merge and clears only what it names.
        store::merge_properties(&tx, id)?;
        store::move_edit(&tx, id, held.version, None)?;
        store::release(&tx, id)?;
        hydrate::lay_queue_over(
            &tx,
            &crate::catalog::load(&tx)?,
            &store::whole_edge_types(&tx)?,
            self.credential().as_deref(),
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Only terminal verdicts go: a `blocked` or a `dead` row is one a
    /// caller may still release, and a refused write that carried content
    /// stays until it is discarded.
    pub fn forget_answered(&self) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        // Read before the answers it reads go.
        body::rule::after_answers(&mut conn)?;
        store::forget_answered(&conn)
    }

    /// `forget_answered`, for the named writes alone, under the same rules:
    /// every other answered write stays, so an app that has read only some
    /// answers forgets only those. An id that names no write, or one not
    /// answered, is ignored.
    pub fn forget_answered_ids(&self, ids: &[String]) -> Result<usize> {
        self.lock.refuse_unless_writer()?;
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn()?;
        body::rule::after_answers_of(&mut conn, Some(ids))?;
        store::forget_answered_ids(&conn, ids)
    }

    /// Clears what `forget_answered` clears and returns each write it took,
    /// as `queue` read it, in one transaction under the connection's lock:
    /// two callers taking at once never both get one write, and none leaves
    /// the queue unreturned.
    pub fn take_answered(&self) -> Result<Vec<QueuedWrite>> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let before = store::queued_writes(&tx)?;
        #[cfg(debug_assertions)]
        fault::hold(|| "answered-taking");
        body::rule::after_answers_in(&tx, None)?;
        store::forget_answered(&tx)?;
        let left = store::queued_ids(&tx)?;
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(before
            .into_iter()
            .filter(|write| !left.contains(&write.id))
            .collect())
    }

    /// A name the server could not resolve can wait for the next pass.
    pub(crate) fn settle_bodies(&self, stop: &AtomicBool) -> Result<()> {
        match body::rule::settle(self, stop) {
            Err(
                error @ (CoreError::StorageFull(_)
                | CoreError::Store(_)
                | CoreError::Fault(_)
                | CoreError::CopyExpired { .. }
                | CoreError::Canceled),
            ) => Err(error),
            Err(incomplete @ CoreError::StreamIncomplete { .. }) => {
                if crate::reach::expired(&*self.conn()?)? {
                    Err(CoreError::expired(
                        "the copy was expired while the server's instance was being confirmed",
                    ))
                } else {
                    Err(incomplete)
                }
            }
            _ => Ok(()),
        }
    }

    /// Takes a refused write out of the queue, with what it carried. Answers
    /// `false` for a row that is not refused, or one a write still waits on,
    /// unless it is a create refused onto a row no read has found: the writes
    /// waiting on that one are refused unsent. A create's discard first waits
    /// for a drain already running to end.
    pub fn discard(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        // Only a create's discard refuses other writes, and a running drain
        // can make any create one whose landing waits for a read, so each
        // waits for the drain to end. The kind is all that cannot change.
        let create = store::queued_write(&*self.conn()?, id)?
            .is_some_and(|row| row.kind == WriteKind::CreateItem);
        let _one = create.then(|| self.one_drain());
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let discarded = store::discard(&tx, id)?;
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(discarded)
    }
}
