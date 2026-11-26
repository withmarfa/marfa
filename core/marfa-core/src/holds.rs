//! What a copy keeps whole: pinned items and held tables.

use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use serde_json::Value;

use crate::files::unpin_held;
use crate::streams::{Mover, StreamClaim};
use crate::{
    Core, CoreError, FillReport, Handle, HeldTables, NEVER_STOPPED, QueuedWrite, Result, RowsAsked,
    TableHold, WriteKind, busy, drain, http, hydrate, reach, row_writes, store, tables,
};

impl Core {
    /// Refused where neither the server nor the copy holds `id`, and
    /// `NotFound` with `trashed` where the server holds it in the bin. Answers
    /// whether it was pinned already.
    pub fn pin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        let (added, context) = {
            let conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
            let added = store::pin(&conn, id)?;
            (added, reach::Context::capture(&conn)?)
        };
        let mut trashed = false;
        let mut gone = None;
        let own_create = |conn: &Connection| -> Result<bool> {
            Ok(store::waiting_writes_for_item(conn, id)?
                .iter()
                .any(|row| row.kind == WriteKind::CreateItem)
                && store::item_held(conn, id)?)
        };
        let held = hydrate::read_with_edges_answered(&context.http(http), id).and_then(|read| {
            let (read, answer) = match read {
                crate::http::ByIdRead::Row(read) => (Some(read), None),
                crate::http::ByIdRead::Absent(answer) => (None, answer),
            };
            gone = answer;
            // A read by id answers a row in the bin as one that is gone, and
            // the slice may hold such a row.
            if read.is_none() && !own_create(&*self.conn()?)? {
                trashed = context.http(http).trashed_item(id)?.is_some();
            }
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let held = match &read {
                Some((row, edges)) => {
                    let catalog = crate::catalog::load(&tx)?;
                    hydrate::hold_row(&tx, &catalog, row, edges)?;
                    true
                }
                None if own_create(&tx)? => true,
                None => {
                    if !trashed {
                        store::evict_item(&tx, id, &store::whole_edge_types(&tx)?)?;
                    }
                    false
                }
            };
            tx.commit()?;
            Ok(held)
        });
        if !matches!(held, Ok(true)) && added {
            let conn = self.conn()?;
            if context.check(&conn).is_ok() {
                store::unpin(&conn, id)?;
            }
        }
        match held.map_err(|error| context.failed(self, error).unwrap_or_else(|error| error))? {
            true => Ok(!added),
            false if trashed => Err(CoreError::NotFound {
                server: gone,
                code: "trashed".into(),
                message: format!("{id} is in the bin; restore it to pin it"),
            }),
            false => Err(CoreError::NotFound {
                server: gone,
                code: "not_found".into(),
                message: format!("the server holds no item {id} to pin"),
            }),
        }
    }

    /// `pin` for many rows the copy does not hold, reading each hundred with
    /// one request. Answers each id in the order given with whether the pin
    /// took, or why it failed. A row the server holds none of, or leaves out
    /// as the key may not read it, is `Ok(false)` and stays unpinned: the
    /// callers here treat `pin`'s `NotFound` and `Forbidden` alike, and a row
    /// the copy does not hold has nothing to let go or keep.
    ///
    /// A failure of one page is its ids' own and a later page is still read,
    /// a 5xx among them, unless it would end a pass (`Canceled`, offline, rate
    /// limited, or what ends a drain, an expired copy among it): the rest are
    /// answered with that error, unread. A row the
    /// copy holds is the caller's to filter out, since a read by id answers a
    /// row in the bin as gone and this does not ask the bin.
    pub(crate) fn pin_many(&self, ids: &[String]) -> Vec<(String, Result<bool>)> {
        debug_assert!(
            self.conn().is_ok_and(|conn| {
                ids.iter()
                    .all(|id| !store::item_held(&conn, id).unwrap_or(false))
            }),
            "pin_many is for rows the copy does not hold"
        );
        let mut answered = Vec::with_capacity(ids.len());
        let mut ended: Option<CoreError> = None;
        for page in ids.chunks(http::BULK_GET_LIMIT) {
            let read = match &ended {
                Some(error) => Err(error.clone()),
                None => self.pin_page(page),
            };
            match read {
                Ok(held) => answered.extend(page.iter().cloned().zip(held.into_iter().map(Ok))),
                Err(error) => {
                    if ended.is_none() && pin_pass_ends(&error) {
                        ended = Some(error.clone());
                    }
                    answered.extend(page.iter().map(|id| (id.clone(), Err(error.clone()))));
                }
            }
        }
        answered
    }

    pub(crate) fn pin_page(&self, ids: &[String]) -> Result<Vec<bool>> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        let (added, context) = {
            let mut conn = self.conn()?;
            store::refuse_unless_hydrated(&conn)?;
            let tx = conn.transaction()?;
            let mut added = Vec::with_capacity(ids.len());
            for id in ids {
                added.push(store::pin(&tx, id)?);
            }
            let context = reach::Context::capture(&tx)?;
            tx.commit()?;
            (added, context)
        };
        let read = (|| -> Result<Vec<bool>> {
            let http = context.http(http);
            let rows = http.items_by_id(ids)?;
            let mut whole = std::collections::HashMap::new();
            for row in rows {
                let mut edges = Vec::new();
                for (edge_type, block) in row.item.edges.iter().flatten() {
                    edges.extend(block.data.iter().cloned());
                    edges.extend(hydrate::fetch_overflow(
                        &http,
                        &NEVER_STOPPED,
                        &row.item.id,
                        edge_type,
                        block,
                    )?);
                }
                whole.insert(row.item.id.clone(), (row, edges));
            }
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let catalog = crate::catalog::load(&tx)?;
            let mut held = Vec::with_capacity(ids.len());
            for id in ids {
                held.push(match whole.get(id) {
                    Some((row, edges)) => {
                        hydrate::hold_row(&tx, &catalog, row, edges)?;
                        true
                    }
                    None => false,
                });
            }
            tx.commit()?;
            Ok(held)
        })();
        let mut unpin_failed: Option<CoreError> = None;
        {
            let conn = self.conn()?;
            if context.check(&conn).is_ok() {
                for (at, id) in ids.iter().enumerate() {
                    if added[at]
                        && !matches!(&read, Ok(held) if held[at])
                        && let Err(error) = store::unpin(&conn, id)
                    {
                        unpin_failed.get_or_insert(error);
                    }
                }
            }
        }
        match read {
            Ok(held) => match unpin_failed {
                Some(error) => Err(error),
                None => Ok(held),
            },
            Err(error) => Err(context.failed(self, error).unwrap_or_else(|error| error)),
        }
    }

    /// A row the slice does not take leaves the copy, unless writes to it
    /// still wait. Answers whether it was pinned.
    pub fn unpin(&self, id: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let pinned = unpin_held(&tx, id)?;
        tx.commit()?;
        Ok(pinned)
    }

    /// Chooses matching tables and fills them while it holds the stream,
    /// leaving them to the call that holds or takes it.
    pub fn hold_table(&self, type_id: &str, table: &str) -> Result<TableHold> {
        self.hold_table_until(type_id, table, &NEVER_STOPPED)
    }

    pub fn hold_table_until(
        &self,
        type_id: &str,
        table: &str,
        stop: &AtomicBool,
    ) -> Result<TableHold> {
        self.lock.refuse_unless_writer()?;
        let was_held = busy::retrying(&self.conn, stop, || {
            tables::choose(&mut *self.conn()?, type_id, table)
        })?;
        self.tables_chosen.fetch_add(1, Ordering::SeqCst);
        let fill = match self.try_claim_stream(Mover::Fill) {
            Ok(streaming) => self.fill_from(streaming, stop, true)?,
            Err(_) => None,
        };
        Ok(TableHold {
            type_id: type_id.into(),
            table: table.into(),
            was_held,
            fill,
        })
    }

    /// Releases a choice, retaining tables held by other choices.
    pub fn let_go_table(&self, type_id: &str, table: &str) -> Result<bool> {
        self.lock.refuse_unless_writer()?;
        busy::retrying(&self.conn, &NEVER_STOPPED, || {
            tables::let_go(&mut *self.conn()?, type_id, table)
        })
    }

    pub fn held_tables(&self) -> Result<HeldTables> {
        tables::held(&*self.conn()?)
    }

    /// Fills tables that are owed or still filling while it holds the stream.
    pub fn fill_tables(&self, stop: &AtomicBool) -> Result<FillReport> {
        self.lock.refuse_unless_writer()?;
        let streaming = self.claim_stream(Mover::Fill, stop)?;
        Ok(self.fill_from(streaming, stop, false)?.unwrap_or_default())
    }

    /// Fills under `streaming`, then again while a choice made after a pass's
    /// last look finds the stream free. `None` where a hold's stream was taken
    /// before its first pass, or its copy is not hydrated.
    fn fill_from<'a>(
        &'a self,
        mut streaming: StreamClaim<'a>,
        stop: &AtomicBool,
        hold: bool,
    ) -> Result<Option<FillReport>> {
        let mut fill: Option<FillReport> = None;
        loop {
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "table-hold-filling");
            let seen = self.tables_chosen.load(Ordering::SeqCst);
            if hold && (!streaming.held() || !store::hydration_complete(&*self.conn()?)?) {
                break;
            }
            let context = reach::Context::capture(&*self.conn()?)?;
            let report = tables::fill(self, &context, stop, Some(&streaming))?;
            let kept = streaming.held();
            match &mut fill {
                Some(before) => before.absorb(report),
                None => fill = Some(report),
            }
            if !kept {
                break;
            }
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "table-hold-filled");
            drop(streaming);
            if self.tables_chosen.load(Ordering::SeqCst) == seen {
                break;
            }
            match self.try_claim_stream(Mover::Fill) {
                Ok(again) => streaming = again,
                Err(_) => break,
            }
        }
        Ok(fill)
    }

    /// Fills what a hold chose after `seen` once the stream is free, as the
    /// hold found it taken.
    pub(crate) fn fill_chosen_since(
        &self,
        seen: u64,
        stop: &AtomicBool,
    ) -> Result<Option<FillReport>> {
        if self.tables_chosen.load(Ordering::SeqCst) == seen {
            return Ok(None);
        }
        match self.try_claim_stream(Mover::Fill) {
            Ok(streaming) => self.fill_from(streaming, stop, true),
            Err(_) => Ok(None),
        }
    }

    pub(crate) fn tables_chosen(&self) -> u64 {
        self.tables_chosen.load(Ordering::SeqCst)
    }

    /// Reads rows from the copy when held whole, marking the answer with `held`.
    pub fn table_rows(&self, item: &str, table: &str, asked: &RowsAsked) -> Result<Value> {
        tables::rows(self, item, table, asked)
    }

    pub fn table_row(&self, item: &str, table: &str, row: &str) -> Result<Value> {
        tables::row(self, item, table, row)
    }

    pub fn table_totals(&self, item: &str, table: &str, filter: Option<&str>) -> Result<Value> {
        tables::totals(self, item, table, filter)
    }

    /// Laid over the table where the copy holds it whole.
    pub fn write_rows(&self, item: &str, table: &str, operations: &[Value]) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        row_writes::write(&mut *self.conn()?, item, table, operations)
    }

    /// Changes no held row until its `rows.changed` arrives.
    pub fn undo_rows(&self, item: &str, table: &str, batch: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        row_writes::undo(&mut *self.conn()?, item, table, batch)
    }

    pub(crate) fn lay_rows(&self) -> Result<()> {
        if self.lock.handle() == Handle::Reader {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        row_writes::flush(&tx)?;
        tx.commit()?;
        Ok(())
    }
}

/// Whether a failed page of `pin_many` would fail every page after it. A
/// server's 5xx fails only its own page, so later pages are still read.
pub(crate) fn pin_pass_ends(error: &CoreError) -> bool {
    match error {
        CoreError::RenewalFailed(cause) => pin_pass_ends(cause),
        CoreError::Server { status, .. } if (500..=599).contains(status) => false,
        _ => {
            drain::ends_the_drain(error)
                || matches!(error, CoreError::Canceled | CoreError::NoServer)
                || error.is_environmental()
        }
    }
}
