//! The read a write owes after its answer, and what the copy does with what it reads.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use super::address::Shape;
use super::pages;
use super::send::unavailable_by;
use super::settle::{land, move_edits_back, receipt_key, same_attempt, settle_success};
use crate::error::CoreError;
use crate::http::Answer;
use crate::model::{QueuedWrite, Subject, WriteKind};
use crate::telemetry;
use crate::wire::WireEdge;
use crate::{Core, Result};
use crate::{reach, store};

/// A read rather than a wait for catch-up: a refused write produces no
/// event. The verdict and debt survive a failed read; the refused overlay
/// is removed only after a fresh response passes the local context guard.
/// A contract mismatch, redirect, failed renewal or full store ends the pass.
/// Other unavailable reads return their reason and end the pass too.
pub(super) fn reconcile(
    core: &Core,
    row: &QueuedWrite,
    pass: &mut ReachChange,
) -> Result<Option<Unreadable>> {
    let Some(owed) = store::owed_of(&*core.conn()?, row)? else {
        return Ok(None);
    };
    match read_owed(core, &owed, Bin::Held, pass, false).and_then(|read| {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        check_read_back(&tx, &read)?;
        same_attempt(&tx, row)?;
        restore_settled_overlay(&tx, row, &read)?;
        move_edits_back(&tx, row)?;
        if matches!(read, ReadBack::Unread) {
            // The queue's side is done, so the receipt goes: only the read
            // stays owed, and a pass that came back to the receipt would
            // rebase the writes behind it a second time.
            store::meta_delete(&tx, &receipt_key(&row.id))?;
            tx.commit()?;
            return Ok(());
        }
        apply_read_back_unchecked(&tx, &read)?;
        store::settle_read_back(&tx, owed.subject, &owed.id)?;
        store::meta_delete(&tx, &receipt_key(&row.id))?;
        tx.commit()?;
        Ok(())
    }) {
        Err(
            error @ (CoreError::Redirected { .. }
            | CoreError::ContractMismatch { .. }
            | CoreError::RenewalFailed(_)
            | CoreError::StorageFull(_)
            | CoreError::CopyExpired { .. }
            | CoreError::StreamIncomplete { .. }),
        ) => Err(error),
        Err(error) => {
            let unread = unreadable(&error);
            if unread.is_some() {
                telemetry::degraded!(&error);
            }
            Ok(unread)
        }
        Ok(()) => Ok(None),
    }
}

pub(super) struct Unreadable {
    pub(super) reason: String,
    pub(super) limited: bool,
    pub(super) retry_after_seconds: Option<u64>,
}

pub(super) fn unreadable(error: &CoreError) -> Option<Unreadable> {
    Some(Unreadable {
        reason: unavailable_by(error)?,
        limited: error.is_limit_named(),
        retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
    })
}

/// Every read-back a refusal left owed, tried before anything is sent. One
/// that fails again stays owed, and one that cannot get through ends the
/// pass before anything is sent.
pub(super) fn read_owed_backs(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ReachChange,
) -> Result<Option<Unreadable>> {
    let pending = {
        let conn = core.conn()?;
        let mut owed: HashMap<String, String> = {
            store::meta_under(&conn, &receipt_key(""))?
                .into_iter()
                .collect()
        };
        let ids: Vec<String> = owed.keys().cloned().collect();
        store::queued_writes_named(&conn, &ids)?
            .into_iter()
            .filter_map(|row| owed.remove(&row.id).map(|shape| (row, shape)))
            .collect::<Vec<_>>()
    };
    // `land` reads these, and takes no row in the bin
    // (`queue-and-verdicts/landed-target-unreadable`).
    let landing: HashSet<String> = pending
        .iter()
        .filter_map(|(_, shape)| shape.strip_prefix("land:").map(str::to_owned))
        .collect();
    let (paged, pending): (Vec<_>, Vec<_>) = pending
        .into_iter()
        .partition(|(_, shape)| pages::owed_by_a_page(shape));
    if let Some(unread) = pages::settle_owed(core, stop, pass, &paged)? {
        return Ok(Some(unread));
    }
    for (row, shape) in pending {
        crate::catch_up::refuse_if_stopped(stop)?;
        if shape == "refused" {
            if let Some(unread) = reconcile(core, &row, pass)? {
                return Ok(Some(unread));
            }
            continue;
        }
        let answer = Answer {
            status: 200,
            code: String::new(),
            body: row.answer.clone().unwrap_or_default(),
            retry_after_seconds: None,
            replayed: true,
            contract_named: true,
        };
        let settled = if let Some(id) = shape.strip_prefix("land:") {
            land(
                core,
                &row,
                &Ok(answer),
                Shape::Plain,
                id,
                row.reason.clone().unwrap_or_default(),
                pass,
            )?
        } else {
            let shape = match shape.as_str() {
                "item" => Shape::Item,
                "edge" => Shape::Edge,
                _ => Shape::Plain,
            };
            settle_success(core, &row, &answer, shape, pass, false, None)?
        };
        if let Some(reason) = settled.unavailable {
            return Ok(Some(Unreadable {
                reason,
                limited: settled.limited,
                retry_after_seconds: settled.retry_after_seconds,
            }));
        }
    }
    let owed = store::owed_read_backs(&*core.conn()?)?;
    for entry in owed {
        crate::catch_up::refuse_if_stopped(stop)?;
        if entry.subject == Subject::Item && landing.contains(&entry.id) {
            continue;
        }
        match read_owed(core, &entry, Bin::Held, pass, false)
            .and_then(|read| apply_owed(core, &entry, &read))
        {
            Err(error) if ends_the_pass(&error) => return Err(error),
            Err(error) => {
                if let Some(unread) = unreadable(&error) {
                    telemetry::degraded!(&error);
                    return Ok(Some(unread));
                }
            }
            Ok(()) => {}
        }
    }
    Ok(None)
}

/// A failure of a read made before the queue is sent that no later read gets
/// past: the copy, the credential or the server it speaks to has changed.
/// Any other failure stays with the read it met.
pub(super) fn ends_the_pass(error: &CoreError) -> bool {
    matches!(
        error,
        CoreError::Redirected { .. }
            | CoreError::ContractMismatch { .. }
            | CoreError::RenewalFailed(_)
            | CoreError::SignedOut { .. }
            | CoreError::NoKeychain(_)
            | CoreError::StorageFull(_)
            | CoreError::CopyExpired { .. }
            | CoreError::StreamIncomplete { .. }
    )
}

pub(super) fn apply_owed(core: &Core, owed: &store::Owed, read: &ReadBack) -> Result<()> {
    if matches!(read, ReadBack::Unread) {
        return Ok(());
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    apply_read_back(&tx, read)?;
    store::settle_read_back(&tx, owed.subject, &owed.id)?;
    tx.commit()?;
    Ok(())
}

pub(crate) enum ReadBack {
    Nothing,
    /// Not asked for: the pass had seen the copy's reach change, so the
    /// server would refuse the read. The read stays owed.
    Unread,
    Item {
        context: reach::Context,
        id: String,
        held: Option<Box<crate::wire::WireItemWithMetadata>>,
        /// The copy's stamp before the read, so a row the read did not find
        /// is forgotten only where nothing has written it since.
        before: Option<store::Stamp>,
    },
    Edge {
        context: reach::Context,
        id: String,
        held: Option<Box<WireEdge>>,
        before: Option<store::Stamp>,
    },
}

/// Changes nothing; `apply_read_back` writes what it read.
pub(crate) fn read_back(core: &Core, row: &QueuedWrite) -> Result<ReadBack> {
    let owed = store::owed_of(&*core.conn()?, row)?;
    match owed {
        Some(owed) => read_owed(core, &owed, Bin::Held, &mut ReachChange::default(), false),
        None => Ok(ReadBack::Nothing),
    }
}

/// Whether an item read-back takes a row the server holds in the bin as
/// held, or as no row.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Bin {
    Held,
    NotFound,
}

pub(crate) fn read_back_trashed(core: &Core, id: &str) -> Result<ReadBack> {
    let (context, before) = {
        let conn = core.conn()?;
        (
            reach::Context::capture(&conn)?,
            store::stamp(&conn, Subject::Item, id)?,
        )
    };
    let held = match context.http(core.http()?).trashed_item(id) {
        Ok(found) => found,
        Err(CoreError::Forbidden { .. }) => None,
        Err(error) => return Err(context.failed(core, error)?),
    };
    Ok(ReadBack::Item {
        context,
        id: id.to_string(),
        held: held.map(Box::new),
        before,
    })
}

/// What a pass has learned from the answers it read: of the copy's reach,
/// and whether one left a write for another pass.
#[derive(Default)]
pub(super) struct ReachChange {
    /// The copy as it stood when the server first said its reach had
    /// changed under a source move or a retype, and the reason it gave.
    seen: Option<(
        reach::Context,
        String,
        Option<Box<crate::error::ServerAnswer>>,
    )>,
    /// Set when an answer queued a write of its own, which the pass read
    /// the queue too early to send.
    pub(super) follow_up: bool,
    /// The edge creates held back for the pass after this one.
    pub(super) deferred: usize,
    /// Set on the second pass of a drain, which holds nothing back.
    pub(super) later: bool,
}

impl ReachChange {
    pub(super) fn changed(&self) -> bool {
        self.seen.is_some()
    }

    /// Expires the copy the server said had changed, once, however many
    /// answers came after it. Answers the expiry to tell.
    pub(super) fn expire(self, core: &Core) -> Result<Option<CoreError>> {
        self.seen
            .map(|(context, reason, server)| {
                context
                    .expire(core, &reason)
                    .map(|expired| expired.told_by(server))
            })
            .transpose()
    }
}

/// Whether a write is one the server answers by changing the reach: a move
/// of an edge's from end (`reach/moves-edge-from`) or a retype
/// (`reach/moves-retype`). A write queued with an unchanged type carries no
/// `retype`, so only a real type change counts (`reach/keeps-same-type`).
/// Only one answered in the pass at hand is known to have changed it; a
/// receipt a pass finds from an earlier one is not.
pub(super) fn changes_reach(row: &QueuedWrite) -> bool {
    match row.kind {
        WriteKind::UpdateEdge => row.body.get("from_id").is_some(),
        WriteKind::UpdateItem => row.body.get("retype") == Some(&serde_json::Value::Bool(true)),
        _ => false,
    }
}

/// Reads the row an answer or a refusal owes the copy. Where the read meets a
/// changed reach and `reach_write` says the write was a move of an edge's
/// source or a retype, the pass notes it and goes on, and every read after it is left
/// unmade, since the server would refuse each the same way
/// (`queue-and-verdicts/edge-from-move-carries-on`); any other change ends
/// the pass here, with the copy expired.
pub(super) fn read_owed(
    core: &Core,
    owed: &store::Owed,
    bin: Bin,
    pass: &mut ReachChange,
    reach_write: bool,
) -> Result<ReadBack> {
    if pass.changed() {
        return Ok(ReadBack::Unread);
    }
    let (context, before) = {
        let conn = core.conn()?;
        (
            reach::Context::capture(&conn)?,
            store::stamp(&conn, owed.subject, &owed.id)?,
        )
    };
    match read_held(core, owed, bin, &context, before) {
        Err(CoreError::CopyExpired { reason, server })
            if reach_write && reason == "reach_changed" =>
        {
            pass.seen = Some((context, reason, server));
            Ok(ReadBack::Unread)
        }
        Err(error) => Err(context.failed(core, error)?),
        Ok(read) => Ok(read),
    }
}

fn read_held(
    core: &Core,
    owed: &store::Owed,
    bin: Bin,
    context: &reach::Context,
    before: Option<store::Stamp>,
) -> Result<ReadBack> {
    let http = context.http(core.http()?);
    if owed.subject == Subject::Edge {
        let held = match http.edge(&owed.id) {
            Ok(found) => found,
            Err(CoreError::Forbidden { .. }) => None,
            Err(error) if names_no_row(&error) => None,
            Err(error) => return Err(error),
        };
        return Ok(ReadBack::Edge {
            context: context.clone(),
            id: owed.id.clone(),
            held: held.map(Box::new),
            before,
        });
    }
    let held = match http.item(&owed.id) {
        Ok(Some(found)) => Some(found),
        // A read by id answers a row in the bin `404` as it answers a row
        // that is gone (`items/get-missing`), and the slice may hold such a
        // row. A landing takes no row in the bin
        // (`queue-and-verdicts/landed-target-unreadable`).
        Ok(None) if bin == Bin::Held => match http.trashed_item(&owed.id) {
            Ok(found) => found,
            Err(CoreError::Forbidden { .. }) => None,
            Err(error) => return Err(error),
        },
        Ok(None) | Err(CoreError::Forbidden { .. }) => None,
        Err(error) if names_no_row(&error) => None,
        Err(error) => return Err(error),
    };
    Ok(ReadBack::Item {
        context: context.clone(),
        id: owed.id.clone(),
        held: held.map(Box::new),
        before,
    })
}

/// The server refuses a read by an id it could never have given a row, which
/// says the row is not there as plainly as a `404`.
pub(super) fn names_no_row(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation { code, .. } if code == "invalid_id")
}

pub(crate) fn check_read_back(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    match read {
        ReadBack::Nothing | ReadBack::Unread => Ok(()),
        ReadBack::Item { context, .. } | ReadBack::Edge { context, .. } => context.check(conn),
    }
}

pub(crate) fn withdraw_read_backs(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    held: &[QueuedWrite],
    reads: &[ReadBack],
) -> Result<()> {
    for read in reads {
        check_read_back(conn, read)?;
    }
    store::withdraw(conn, row, held)?;
    for read in reads {
        apply_read_back_unchecked(conn, read)?;
    }
    Ok(())
}

pub(crate) fn apply_read_back(conn: &rusqlite::Connection, read: &ReadBack) -> Result<()> {
    check_read_back(conn, read)?;
    apply_read_back_unchecked(conn, read)
}

pub(super) fn restore_settled_overlay(
    conn: &rusqlite::Connection,
    row: &QueuedWrite,
    read: &ReadBack,
) -> Result<()> {
    if !matches!(row.kind, WriteKind::CreateItem | WriteKind::CreateEdge)
        && matches!(
            read,
            ReadBack::Item { held: Some(_), .. } | ReadBack::Edge { held: Some(_), .. }
        )
    {
        store::put_back(conn, row)?;
    }
    Ok(())
}

pub(super) fn apply_read_back_unchecked(
    conn: &rusqlite::Connection,
    read: &ReadBack,
) -> Result<()> {
    match read {
        ReadBack::Nothing | ReadBack::Unread => {}
        ReadBack::Edge {
            id,
            held: Some(edge),
            ..
        } => {
            if store::take_server_edge(conn, edge)? {
                store::let_go_of_untaken_edge(conn, id)?;
            }
        }
        ReadBack::Edge {
            id,
            held: None,
            before,
            ..
        } => {
            let now = store::stamp(conn, Subject::Edge, id)?;
            if now.is_none() || now == *before {
                store::forget_edge(conn, id)?;
            }
        }
        ReadBack::Item {
            held: Some(held), ..
        } => {
            let item = &held.item;
            let listed = held.listed.ok_or_else(reach::invalid)?;
            reach::set_listed(conn, &item.id, listed)?;
            if store::holds_later(
                conn,
                Subject::Item,
                &item.id,
                item.version,
                &item.updated_at,
            )? {
                store::settle_read_back(conn, Subject::Item, &item.id)?;
                return Ok(());
            }
            let catalog = crate::catalog::load(conn)?;
            let let_go = !store::slice_holds(conn, &catalog, item)?
                && !store::waiting_write_names(conn, &item.id)?;
            if let_go {
                store::evict_item(conn, &item.id, &store::whole_edge_types(conn)?)?;
                return Ok(());
            }
            // The query is judged on the row as taken, tags and all.
            if store::take_server_item(conn, item, Some(&held.metadata.tags), &catalog)? {
                store::let_go_unless_kept(conn, &catalog, &item.id)?;
            }
        }
        ReadBack::Item {
            id,
            held: None,
            before,
            ..
        } => {
            let now = store::stamp(conn, Subject::Item, id)?;
            if now.is_none() || now == *before {
                store::forget_item(conn, id)?;
            }
        }
    }
    Ok(())
}
