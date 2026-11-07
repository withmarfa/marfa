//! Keeps the `read_only` the copy holds to the server's.
//!
//! The server works `read_only` out as it answers a row, from the row's
//! `source` and `type` and the connector registrations and keys as they stand
//! (`items/read-only-current`). A registration or a key that changes moves no
//! row and sends no event, so the event stream never brings the change, and a
//! row no event names keeps the value it was held with. A copy made before it
//! held `read_only` has the same gap on every row.
//!
//! So a copy asks, every so often, what the server answers for one row of each
//! source and type it holds, and holds every row of that source and type to
//! it (`device/read-only-refresh`, `device/read-only-hold`). What it asks the
//! server grows with how many of those the copy holds, never with its rows;
//! finding them reads the `items_read_only` index, whose length is the copy's
//! rows.
//!
//! An answer can move every row of a copy, and the first look after an upgrade
//! moves every read-only one, so a look moves them a page at a time and a read
//! of the copy gets through between two pages. The look counts as made only
//! after the last page: one that fails, is stopped or dies midway leaves the
//! copy owing a look, and that look finishes the rows left.

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use rusqlite::Connection;

use crate::catch_up::{Pace, ask_unless_stopped, refuse_if_stopped};
use crate::error::CoreError;
use crate::http::{BULK_GET_LIMIT, Http};
use crate::reach::Context;
use crate::store::ReadOnlyKnown;
use crate::{Core, Result, store, telemetry};

/// The most rows of a source and type a look asks of, where the server leaves
/// the ones before out of its answer (`device/read-only-omitted`).
const ROWS_ASKED: usize = 3;

/// How long a look leaves the copy between two pages. The lock on the copy is
/// not fair, so one taken again at once could go on shutting a read out.
const BETWEEN_PAGES: Duration = Duration::from_millis(1);

/// Where `pace.read_only_every` has gone by since the copy last did, holds its
/// rows to what the server answers now, adding the rows it changed to `held`,
/// which stands however the look ends. `http` is the one the sync runs under
/// its reach.
pub(crate) fn refresh(
    core: &Core,
    context: &Context,
    http: &Http,
    stop: &AtomicBool,
    pace: &Pace,
    held: &mut u64,
) -> Result<()> {
    {
        let conn = core.conn()?;
        context.same_copy(&conn)?;
        if !store::read_only_owed(&conn, pace.read_only_every)? {
            return Ok(());
        }
    }
    let known = ask(core, context, http, stop)?;
    hold(core, context, stop, pace.read_only_page, &known, held)?;
    in_a_page(core, context, stop, store::mark_read_only_read)
}

/// What the server answers for each source and type the copy holds. A row it
/// leaves out says nothing of the others, so a source and type it has not
/// answered for is asked of again, with its next row. A row answered without
/// the field has been answered for: the server does not send it, and asking
/// again would learn nothing.
pub(crate) fn ask(
    core: &Core,
    context: &Context,
    http: &Http,
    stop: &AtomicBool,
) -> Result<ReadOnlyKnown> {
    let mut answered = HashSet::new();
    let mut known = ReadOnlyKnown::new();
    for skip in 0..ROWS_ASKED {
        let samples = {
            let conn = core.conn()?;
            context.same_copy(&conn)?;
            store::read_only_samples(&conn, skip)?
        };
        let (groups, ids): (Vec<_>, Vec<_>) = samples
            .into_iter()
            .map(|sample| ((sample.source, sample.r#type), sample.id))
            .filter(|(group, _)| !answered.contains(group))
            .unzip();
        for ids in ids.chunks(BULK_GET_LIMIT) {
            let ids = ids.to_vec();
            let answers = ask_unless_stopped(stop, http, move |http| http.read_only_of(&ids))?;
            for answer in answers {
                let group = (answer.source, answer.r#type);
                if let Some(read_only) = answer.read_only {
                    known.insert(group.clone(), read_only);
                }
                answered.insert(group);
            }
        }
        if groups.iter().all(|group| answered.contains(group)) {
            break;
        }
    }
    Ok(known)
}

/// Holds every row of each source and type in `known` to it, `page` rows to a
/// transaction, adding the rows it changed to `held`.
pub(crate) fn hold(
    core: &Core,
    context: &Context,
    stop: &AtomicBool,
    page: usize,
    known: &ReadOnlyKnown,
    held: &mut u64,
) -> Result<()> {
    for ((source, r#type), read_only) in known {
        let mut after = 0;
        loop {
            let (changed, last) = in_a_page(core, context, stop, |conn| {
                store::hold_read_only_page(conn, (source, r#type), *read_only, after, page)
            })?;
            *held += changed;
            let Some(last) = last else { break };
            after = last;
            between_pages(source)?;
        }
    }
    let mut after = String::new();
    loop {
        let (changed, last) = in_a_page(core, context, stop, |conn| {
            store::hold_read_only_beneath(conn, known, &after, page)
        })?;
        *held += changed;
        let Some(last) = last else { return Ok(()) };
        after = last;
        between_pages("beneath")?;
    }
}

/// A write of its own, so the copy's lock is let go as it ends.
fn in_a_page<T>(
    core: &Core,
    context: &Context,
    stop: &AtomicBool,
    write: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    refuse_if_stopped(stop)?;
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    context.same_copy(&tx)?;
    let done = write(&tx)?;
    tx.commit()?;
    Ok(done)
}

/// `of` names what the page held, for a test to stop at one look's pages.
fn between_pages(of: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    {
        let point = || format!("read-only-page:{of}");
        crate::fault::hold(point);
        if crate::fault::fails(point) {
            return Err(CoreError::Fault(format!("{} failed", point())));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = of;
    std::thread::sleep(BETWEEN_PAGES);
    Ok(())
}

/// What a failed `refresh` leaves the sync that ran it: nothing, since the flag
/// is advice and the next one asks again. Only a server saying the copy has
/// expired goes on, as it would from any read under the reach.
pub(crate) fn contained(error: CoreError) -> Result<()> {
    if matches!(error, CoreError::CopyExpired { .. }) {
        return Err(error);
    }
    if !matches!(error, CoreError::Canceled) && !crate::folder::copy_changed(&error) {
        telemetry::degraded!(&error);
    }
    Ok(())
}
