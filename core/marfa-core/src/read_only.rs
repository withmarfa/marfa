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
//! it (`device/read-only-refresh`). What that costs grows with how many of
//! those the copy holds, never with its rows.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use crate::catch_up::ask_unless_stopped;
use crate::error::CoreError;
use crate::http::{BULK_GET_LIMIT, Http};
use crate::reach::Context;
use crate::{Core, Result, store, telemetry};

/// Where `every` has gone by since the copy last did, holds its rows to what
/// the server answers now, and answers how many rows changed.
pub(crate) fn refresh(
    core: &Core,
    context: &Context,
    http: &Http,
    stop: &AtomicBool,
    every: Duration,
) -> Result<u64> {
    let samples = {
        let conn = core.conn()?;
        context.same_copy(&conn)?;
        if !store::read_only_owed(&conn, every)? {
            return Ok(0);
        }
        store::read_only_samples(&conn)?
    };
    let http = context.http(http);
    let mut answers = Vec::new();
    for ids in samples.chunks(BULK_GET_LIMIT) {
        let ids = ids.to_vec();
        answers.extend(ask_unless_stopped(stop, &http, move |http| {
            http.read_only_of(&ids)
        })?);
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    context.same_copy(&tx)?;
    let changed = store::hold_read_only(&tx, &answers)?;
    store::mark_read_only_read(&tx)?;
    tx.commit()?;
    Ok(changed)
}

/// What a failed `refresh` leaves the sync that ran it: nothing, since the flag
/// is advice and the next one asks again. Only a server saying the copy has
/// expired goes on, as it would from any read under the reach.
pub(crate) fn contained(error: CoreError) -> Result<u64> {
    if matches!(error, CoreError::CopyExpired { .. }) {
        return Err(error);
    }
    if !matches!(error, CoreError::Canceled) && !crate::folder::copy_changed(&error) {
        telemetry::degraded!(&error);
    }
    Ok(0)
}
