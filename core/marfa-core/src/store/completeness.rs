//! What the copy holds of its slice, and whether a read or a write may rely on it.

use super::marks::pinned;
use super::meta::{
    META_EVENT_CURSOR, META_HYDRATE_STATE, META_INSTANCE_ID, META_REFILL, META_SLICE_QUERY,
    META_SLICE_TIER, META_SLICE_TYPES, meta_get,
};
use super::reach::waiting_write_names;
use super::reads::items_by_ids;
use super::rows::{evict_item, whole_edge_types};
use crate::error::CoreError;
use crate::model::{Completeness, SliceTier, Tier};
use rusqlite::Connection;

pub const HYDRATE_IN_PROGRESS: &str = "in_progress";

/// Says nothing about whether a hydration has ever run: a fresh store has no
/// in-progress marker either.
pub fn hydration_complete(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_HYDRATE_STATE)?.as_deref() != Some(HYDRATE_IN_PROGRESS))
}

/// False where the event cursor has gone: catch-up deletes it when the log
/// has aged past it, and such a store cannot be kept current.
pub fn hydrated(conn: &Connection) -> Result<bool, CoreError> {
    if !hydration_complete(conn)? {
        return Ok(false);
    }
    let Some(cursor) = meta_get(conn, META_EVENT_CURSOR)? else {
        return Ok(false);
    };
    if !keeps_current(conn, &cursor)? {
        return Ok(false);
    }
    holds_slice(conn)
}

/// Whether the copy holds a slice it can no longer keep current.
pub fn lapsed(conn: &Connection) -> Result<bool, CoreError> {
    let Some(cursor) = meta_get(conn, META_EVENT_CURSOR)? else {
        return Ok(false);
    };
    Ok(!keeps_current(conn, &cursor)? && hydration_complete(conn)? && holds_slice(conn)?)
}

/// Whether the event cursor `cursor`, the fence and the instance the copy holds are ones it can keep current from.
fn keeps_current(conn: &Connection, cursor: &str) -> Result<bool, CoreError> {
    Ok(crate::reach::cursor(cursor).is_some()
        && meta_get(conn, crate::reach::FENCE)?.is_some_and(|f| crate::reach::valid_fence(&f))
        && meta_get(conn, META_INSTANCE_ID)?.is_some_and(|instance| !instance.is_empty()))
}

pub fn holds_slice(conn: &Connection) -> Result<bool, CoreError> {
    Ok(slice(conn)?.is_some_and(|(types, _)| !types.is_empty()))
}

/// Pinned rows count, even in a copy that has never hydrated.
pub fn slice_holds(
    conn: &Connection,
    catalog: &marfa_rules::catalog::Catalog,
    item: &crate::wire::WireItem,
) -> Result<bool, CoreError> {
    if pinned(conn, &item.id)? {
        return Ok(true);
    }
    let Some((types, tier)) = slice(conn)? else {
        return Ok(false);
    };
    Ok(crate::reach::listed(conn, &item.id)?
        && slice_takes(
            catalog,
            &types,
            tier,
            &item.r#type,
            Tier::parse_wire(item.tier.as_deref())?,
        ))
}

pub use marfa_rules::folder::declares_type;

pub use marfa_rules::query::EVERY_TYPE;

/// `EVERY_TYPE` takes what a bare server listing answers, which leaves out
/// hidden types. A `system.*` row named by type is taken at either tier: the
/// server stamps one a tier that says nothing about it, and a copy of the
/// feed still needs the folders it shows.
pub fn slice_takes(
    catalog: &marfa_rules::catalog::Catalog,
    types: &[String],
    tier: SliceTier,
    row_type: &str,
    row_tier: Option<Tier>,
) -> bool {
    let system = is_system(row_type);
    types.iter().any(|declared| {
        if declared == EVERY_TYPE {
            !is_hidden(row_type) && tier.takes(row_tier)
        } else {
            marfa_rules::folder::takes_type(catalog, declared, row_type)
                && (system || tier.takes(row_tier))
        }
    })
}

pub(crate) use marfa_rules::folder::{is_hidden, is_system};

pub fn slice_query(conn: &Connection) -> Result<Option<crate::slice::SliceQuery>, CoreError> {
    match meta_get(conn, META_SLICE_QUERY)? {
        Some(json) => serde_json::from_str(&json).map(Some).map_err(|error| {
            CoreError::Store(format!(
                "the store holds a slice query this build does not read: {error}"
            ))
        }),
        None => Ok(None),
    }
}

/// Whether the copy keeps the row it holds under `id`, judged on the row as
/// held: pinned, named by a write still waiting (`waiting_write_names`), or
/// listed and taken by the slice's types, tier and query. One rule for every
/// path that takes a server row, so the copy holds the same rows whichever
/// brought them.
pub fn keeps_held(
    conn: &Connection,
    catalog: &marfa_rules::catalog::Catalog,
    id: &str,
) -> Result<bool, CoreError> {
    if pinned(conn, id)? || waiting_write_names(conn, id)? {
        return Ok(true);
    }
    let Some((types, tier)) = slice(conn)? else {
        return Ok(false);
    };
    if !crate::reach::listed(conn, id)? {
        return Ok(false);
    }
    let Some(held) = items_by_ids(conn, &[id.to_string()])?.pop() else {
        return Ok(false);
    };
    if !slice_takes(catalog, &types, tier, &held.r#type, held.tier) {
        return Ok(false);
    }
    match slice_query(conn)? {
        Some(query) => crate::slice::judge_held(
            conn,
            catalog,
            &query,
            crate::slice::Reading::Holds,
            crate::slice::Scope::default(),
            id,
        ),
        None => Ok(true),
    }
}

/// Evicts the row held under `id` where the copy does not keep it
/// (`keeps_held`). Whether it did.
pub fn let_go_unless_kept(
    conn: &Connection,
    catalog: &marfa_rules::catalog::Catalog,
    id: &str,
) -> Result<bool, CoreError> {
    if keeps_held(conn, catalog, id)? {
        return Ok(false);
    }
    evict_item(conn, id, &whole_edge_types(conn)?)?;
    Ok(true)
}

/// The ids of the rows the copy holds of a hidden type.
pub fn hidden_item_ids(conn: &Connection) -> Result<Vec<String>, CoreError> {
    Ok(conn
        .prepare_cached("SELECT id FROM items WHERE type GLOB 'system.*' OR type GLOB 'app.*'")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn slice(conn: &Connection) -> Result<Option<(Vec<String>, SliceTier)>, CoreError> {
    let Some(tier) = meta_get(conn, META_SLICE_TIER)? else {
        return Ok(None);
    };
    let Some(types) = meta_get(conn, META_SLICE_TYPES)? else {
        return Ok(None);
    };
    Ok(Some((serde_json::from_str(&types)?, slice_tier(&tier)?)))
}

/// A value this build does not read is the store's fault, not the caller's.
pub fn slice_tier(stored: &str) -> Result<SliceTier, CoreError> {
    stored.parse().map_err(|_| {
        CoreError::Store(format!(
            "the store holds a slice tier this build does not read: {stored:?}"
        ))
    })
}

pub fn refuse_unless_hydrated(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// A copy that has never reached a server: no hydration has declared a slice.
/// It keeps what its app saves, which a hydration later sends.
pub fn never_synced(conn: &Connection) -> Result<bool, CoreError> {
    Ok(hydration_complete(conn)? && !holds_slice(conn)?)
}

/// For what a copy can do on its own but answer a list, a search or a read by
/// id (`read_completeness`): queue writes, follow edges, run a folder's pass. A
/// copy part way through a hydration, or one whose cursor has gone, is refused,
/// since what it holds is a piece of a copy or a copy that cannot be kept
/// current.
pub fn refuse_unless_usable(conn: &Connection) -> Result<(), CoreError> {
    if hydrated(conn)? || never_synced(conn)? {
        Ok(())
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// For a local list, search or read by id: a whole copy answers complete; one
/// whose cursor aged out answers the rows it held, as stale, until a hydration
/// fills it again in place; one a hydration has started and not completed
/// answers from the rows that have arrived, as partial. Any other expired copy
/// is refused.
pub fn read_completeness(conn: &Connection) -> Result<Completeness, CoreError> {
    if hydrated(conn)? || never_synced(conn)? {
        Ok(Completeness::Complete)
    } else if refilling(conn)? {
        Ok(Completeness::Stale)
    } else if !hydration_complete(conn)? {
        Ok(Completeness::Partial)
    } else {
        Err(CoreError::HydrationIncomplete)
    }
}

/// The instance and reach a copy whose cursor aged out was built under, which
/// a hydration under the same ones fills again in place, and the cursor it
/// held then.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Refill {
    pub instance: String,
    pub reach: String,
    /// A head behind it is a server restored to an earlier point, which may
    /// never have held the versions the copy holds.
    pub cursor: String,
}

pub fn refill(conn: &Connection) -> Result<Option<Refill>, CoreError> {
    Ok(meta_get(conn, META_REFILL)?.and_then(|json| serde_json::from_str(&json).ok()))
}

pub fn refilling(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_REFILL)?.is_some())
}

/// For a write queued against the copy: a whole copy, one waiting to be filled
/// again in place or being filled so, and one a hydration has started and not
/// completed all take one, sent once the copy is whole again. What the
/// write is to be queued against is told by `refuse_unless_held`.
pub fn refuse_unless_writable(conn: &Connection) -> Result<Completeness, CoreError> {
    read_completeness(conn)
}

/// For an edge write: a copy that is not whole takes none. A page still to
/// arrive can bring the server's edge, at another version or between other
/// ends, beneath a write queued against the edge the copy shows, and leave
/// that write to run against an edge nobody saw.
pub fn refuse_unless_whole(conn: &Connection) -> Result<(), CoreError> {
    refuse_unless_held(refuse_unless_writable(conn)?)
}

/// A row or an edge a copy that is not whole does not hold may be one the
/// server holds and has not yet brought, so a write to it is refused rather
/// than answered not found.
pub fn refuse_unless_held(completeness: Completeness) -> Result<(), CoreError> {
    match completeness {
        Completeness::Complete => Ok(()),
        Completeness::Stale | Completeness::Partial => Err(CoreError::HydrationIncomplete),
    }
}

/// Runs a local read under one snapshot, refused as `refuse_unless_usable`
/// refuses on that snapshot, so a hydration another handle commits between
/// the check and the read cannot slip in.
pub fn read_usable<T>(
    conn: &mut Connection,
    read: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let tx = conn.transaction()?;
    refuse_unless_usable(&tx)?;
    let answer = read(&tx)?;
    tx.commit()?;
    Ok(answer)
}

/// Runs a local read under one snapshot with the completeness it is marked
/// with, so a hydration another handle commits between the two cannot pair a
/// mark with rows from another state.
pub fn read_marked<T>(
    conn: &mut Connection,
    read: impl FnOnce(&Connection, Completeness) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let tx = conn.transaction()?;
    let completeness = read_completeness(&tx)?;
    let answer = read(&tx, completeness)?;
    tx.commit()?;
    Ok(answer)
}

/// A row a partial copy does not hold may still be arriving, so its absence
/// is refused rather than answered. A stale copy answers what it holds.
pub fn held_or_refused<T>(
    found: Option<T>,
    completeness: Completeness,
) -> Result<Option<T>, CoreError> {
    match (found, completeness) {
        (None, Completeness::Partial) => Err(CoreError::HydrationIncomplete),
        (found, _) => Ok(found),
    }
}
