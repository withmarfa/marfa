//! One pass per call: each sendable row is attempted once, and the pass ends
//! at the first failure of the environment. Going on would ask a server that
//! cannot answer once for every row, a connection timeout each.

use std::sync::atomic::AtomicBool;

use crate::error::CoreError;
use crate::http::{Http, INSTANCE_CHANGED};
use crate::model::{BlockedReason, QueuedWrite, Verdict, WriteKind};
use crate::telemetry;
use crate::{Core, Result, reach, store};

mod address;
mod classify;
mod create_edges;
mod pages;
mod read_back;
mod report;
mod rows;
mod send;
mod settle;
#[cfg(test)]
mod tests;

pub(crate) use address::ends_the_drain;
use read_back::ReachChange;
pub(crate) use read_back::{
    ReadBack, apply_read_back, read_back, read_back_trashed, withdraw_read_backs,
};
pub(crate) use report::Cut;
pub use report::{DrainReport, DrainVerdict};
use send::send_queue;

/// Judging needs the original read and a table that is still held whole.
fn judged(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<bool> {
    let (WriteKind::WriteRows, Some(item), Some(table)) =
        (row.kind, row.item_id.as_deref(), row.table.as_deref())
    else {
        return Ok(false);
    };
    Ok(store::read_of(conn, &row.id)?.is_some()
        && crate::tables::state(conn, item, table)?.as_deref() == Some(crate::tables::WHOLE))
}

/// Whether a drain now has work: a write with no verdict, one blocked for a
/// reason a drain clears itself, a read-back owed, a body whose names wait,
/// or a body's answers still to apply. A dead write, or one blocked until
/// something outside the queue changes, is no reason to drain.
pub(crate) fn would_send(core: &Core) -> Result<bool> {
    let conn = core.conn()?;
    let sendable = store::waiting_writes(&conn)?
        .iter()
        .any(|row| match row.verdict {
            None => true,
            Some(Verdict::Blocked) => {
                row.blocked_reason() == Some(BlockedReason::CredentialRefused)
                    || row.reason.as_deref() == Some(crate::model::AWAITING_DEPENDENCY)
            }
            Some(_) => false,
        });
    Ok(sendable
        || !store::owed_read_backs(&conn)?.is_empty()
        || crate::body::rule::waiting(&conn)?
        || crate::body::rule::has_answer_work(&conn)?)
}

pub fn drain(core: &Core, stop: &AtomicBool) -> Result<DrainReport> {
    drain_keeping(core, stop).map_err(|cut| cut.error)
}

/// `drain`, keeping what a drain that ends in an error settled before it.
pub(crate) fn drain_keeping(
    core: &Core,
    stop: &AtomicBool,
) -> std::result::Result<DrainReport, Cut> {
    let op = telemetry::operation!("drain", answered, held, undelivered, unsent, unmade);
    let result = drain_checked(core, stop);
    // A renewal whose callback found the connection held waits in memory;
    // written down here, it outlives a process that exits after the pass.
    // Lost, it costs the next drain one upload sent again.
    if let Ok(conn) = core.conn() {
        let _ = core.write_down_renewals(&conn);
    }
    if let Ok(report) = &result {
        core.owe_drain(report.undelivered > 0 || report.unavailable.is_some());
    }
    telemetry::ended!(op, result.as_ref().map_err(|cut| &cut.error), |report| {
        outcome = if report.stopped.is_some() {
            "credential_refused"
        } else if report.unavailable.is_some() {
            "unavailable"
        } else {
            "ok"
        },
        answered = report.answered,
        held = report.held,
        undelivered = report.undelivered,
        unsent = report.unsent,
        unmade = report.unmade,
    });
    result
}

fn drain_checked(core: &Core, stop: &AtomicBool) -> std::result::Result<DrainReport, Cut> {
    // The handle before the server, so a second opener with no server is
    // told the real reason it may not write.
    core.lock.refuse_unless_writer()?;
    // Whatever opened the store, a folder's queue holds only what its scan
    // read until the person agrees.
    if crate::folder::waiting(&*core.conn()?)? {
        return Err(crate::error::CoreError::FirstSyncWaiting.into());
    }
    // Each answer is read back under the copy's reach, so a copy without
    // one would send a write and then fail to settle it, on every pass.
    crate::catch_up::refuse_unless_current(&mut *core.conn()?)?;
    let result = drain_inner(core, stop);
    // An answer that came in is settled before a stop raised during its
    // request is honored, including for the last write in the queue.
    match crate::catch_up::refuse_if_stopped(stop) {
        Ok(()) => result,
        Err(error) => Err(Cut {
            error,
            settled: result.map_or_else(|cut| cut.settled, Box::new),
        }),
    }
}

fn drain_inner(core: &Core, stop: &AtomicBool) -> std::result::Result<DrainReport, Cut> {
    crate::catch_up::refuse_if_stopped(stop)?;
    // Queued writes and their natural-key lookups name the copy's instance
    // so a replacement refuses them even after the pass confirmed the origin.
    // Credential renewal uses the exempt authentication endpoints.
    let (http, generation) = crate::catch_up::naming_instance(core, core.http()?)?;
    let mut pass = ReachChange::default();
    let mut report = DrainReport::empty();
    let mut caught_up = false;
    let mut sent = send_queue(
        core,
        &http,
        generation,
        stop,
        &mut pass,
        &mut report,
        &mut caught_up,
    );
    // No host owes a drain for a write it was not told is waiting, so one an
    // answer queued goes out in this drain, as a pass of its own, as does an
    // edge create held back for the answers of its ends.
    if sent.is_ok()
        && (pass.follow_up || pass.deferred > 0)
        && !pass.changed()
        && report.has_nothing_left()
    {
        pass.follow_up = false;
        pass.deferred = 0;
        pass.later = true;
        let mut later = DrainReport::empty();
        sent = send_queue(
            core,
            &http,
            generation,
            stop,
            &mut pass,
            &mut later,
            &mut caught_up,
        );
        report.absorb(later);
    }
    // Held back for a pass that did not run, they still wait.
    report.undelivered += std::mem::take(&mut pass.deferred);
    let result = match sent {
        // From a request that settled nothing, a lookup among them: a write
        // the refusal answered expired the copy as it settled.
        Err(CoreError::CopyExpired { reason, server }) if reason == INSTANCE_CHANGED => {
            expire_for_another_instance(core, generation)
                .and(Err(CoreError::CopyExpired { reason, server }))
        }
        result => result,
    };
    // However the pass ended, a copy whose reach moved under it is
    // expired once, here. The pass's own error, if any, is the one told. So is
    // a report that has something to say a caller must act on (a wait, an
    // unavailable server, a credential stopped, a write left undelivered), and
    // the next call is refused `copy_expired`.
    let ended = match (result, pass.expire(core)) {
        (Err(error), _) | (Ok(()), Err(error)) => Some(error),
        (Ok(()), Ok(Some(expired))) if report.has_nothing_left() => Some(expired),
        (Ok(()), Ok(_)) => None,
    };
    match ended {
        Some(error) => Err(Cut {
            error,
            settled: Box::new(report),
        }),
        None => Ok(report),
    }
}

fn expire_for_another_instance(core: &Core, generation: u64) -> Result<()> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    if reach::generation(&tx)? == generation {
        crate::catch_up::expire_for_another_instance(&tx, generation, None)?;
    }
    tx.commit()?;
    Ok(())
}

/// Reads the root where a write was refused for its size, so a limit raised
/// since is seen with nothing to send. Nothing waits on this read, so a server
/// that does not answer fails nothing, and the next drain asks again.
fn read_limit_refused(core: &Core, http: &Http, stop: &AtomicBool) -> Result<()> {
    if !store::limit_refused(&*core.conn()?)? {
        return Ok(());
    }
    match crate::catch_up::refuse_another_instance_until(core, http, stop) {
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            Ok(())
        }
        other => other,
    }
}
