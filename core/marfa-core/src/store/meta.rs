//! The `meta` table's keys, the request limit, the copy's revision and the record of its changes.

use super::time::iso_at;
use crate::error::CoreError;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;

pub const META_SERVER_ORIGIN: &str = "server_origin";

pub const META_SLICE_TYPES: &str = "slice_types";

pub const META_SLICE_TIER: &str = "slice_tier";

pub const META_SLICE_EDGE_TYPES: &str = "slice_edge_types";

/// The slice's query past its types and tier, as JSON, and absent where the
/// slice holds every row of its types and tier.
pub const META_SLICE_QUERY: &str = "slice_query";

pub const META_EVENT_CURSOR: &str = "event_cursor";

/// The instance the copy was hydrated from, as the server's root names it.
pub const META_INSTANCE_ID: &str = "instance_id";

/// The largest request body the root last named, in bytes; absent where it
/// has named none (`queue-and-verdicts/request-limit-unknown`).
const META_REQUEST_LIMIT: &str = "request_limit";

/// Set where a write was refused for that limit, so a raised one is seen with
/// nothing to send: a drain or a folder's pass reads the root. It holds
/// `LIMIT_REFUSED` or `LIMIT_HELD`.
const META_LIMIT_HOLDS: &str = "limit_holds";

/// A write was refused for its size: the next read of the root ends it.
const LIMIT_REFUSED: &str = "refused";

/// A folder holds a file: it stays until a full pass finds none held, and the
/// root is read before each scan.
const LIMIT_HELD: &str = "held";

pub const META_HYDRATE_STATE: &str = "hydrate_state";

/// Set by a hydration from the server's count of its slice when it started,
/// and absent where the server did not answer one.
pub const META_ITEMS_EXPECTED: &str = "items_expected";

/// How many rows the listings of the hydration under way have brought, set
/// with each page so it reads against `META_ITEMS_EXPECTED`.
pub const META_ITEMS_LISTED: &str = "items_listed";

/// Where the hydration under way has reached: the listing it walks, the page
/// cursor it sends next and the pages it has read. Set with each page, so an
/// interrupted hydration carries on from the last page it committed.
pub const META_HYDRATE_RESUME: &str = "hydrate_resume";

/// Present while the copy is to be filled again in place: from the moment the
/// event log let its cursor go, under the instance and reach it was built
/// under (`Refill`), until a hydration has walked the slice again, replayed
/// the log and taken out what the walk did not bring. Any other expiry, and a
/// hydration that clears the copy, removes it.
pub const META_REFILL: &str = "refill";

/// Absent until a catalog is first held, which is how a copy that has never
/// held one is told from an instance with no types.
pub const META_CATALOG_VERSION: &str = "catalog_version";

/// Set while the catalog the copy holds is its own, the types Marfa ships and
/// the ones the app declared, and cleared by the first catalog a server gives.
pub const META_LOCAL_CATALOG: &str = "local_catalog";

/// Present while writes the server has not taken wait for a stream to be had
/// again: set when the server was lost or a drain left a write undelivered,
/// and cleared by a drain that left none or found no work.
pub const META_DRAIN_OWED: &str = "drain_owed";

/// Moved by the triggers in `schema.sql` when the copy changes, so a reader
/// can detect changes made by its own connection. Removing an answered
/// queue row does not move it because that row is no longer laid over the copy.
pub const META_COPY_REVISION: &str = "copy_revision";

/// Set once, when a writer first opens the store, so a cursor of
/// `Core::changes_since` taken from one store is told from another's at the
/// same path.
pub const META_STORE_ID: &str = "store_id";

/// The latest change of an edge `edge_changes` no longer records
/// (`prune_edge_changes`).
pub const META_EDGE_CHANGES_FLOOR: &str = "edge_changes_floor";

/// When the copy last finished a pull from the server without error, as the
/// clock gave it: set by a completed hydration or catch-up and by a follow at
/// the log's head, and removed by a hydration that clears the copy.
pub const META_SYNCED_AT: &str = "synced_at";

/// When the rows the copy holds were last held to the server's `read_only`,
/// in seconds since the epoch. Absent in a copy that has never been.
pub const META_READ_ONLY_READ: &str = "read_only_read_at";

/// How many of the latest changes `edge_changes` keeps whatever they name.
/// The writer, as it opens the store, lets go of older rows of edges the
/// copy no longer holds once there are more than twice this many.
pub const EDGE_CHANGES_KEPT: usize = 10_000;

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, CoreError> {
    Ok(conn
        .prepare_cached("SELECT value FROM meta WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), CoreError> {
    conn.prepare_cached(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

pub fn drain_owed(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_DRAIN_OWED)?.is_some())
}

pub fn set_drain_owed(conn: &Connection, owed: bool) -> Result<(), CoreError> {
    match (owed, drain_owed(conn)?) {
        (true, false) => meta_set(conn, META_DRAIN_OWED, "1"),
        (false, true) => meta_delete(conn, META_DRAIN_OWED),
        _ => Ok(()),
    }
}

/// SQLite sorts UTF-8 text bytewise and blobs after all text.
pub(crate) fn prefix_end(prefix: &str) -> rusqlite::types::Value {
    let mut end = prefix.to_string();
    while let Some(last) = end.pop() {
        if let Some(next) = (u32::from(last) + 1..=u32::from(char::MAX)).find_map(char::from_u32) {
            end.push(next);
            return end.into();
        }
    }
    rusqlite::types::Value::Blob(Vec::new())
}

/// Every key that starts with `prefix`, in order.
pub fn meta_keys(conn: &Connection, prefix: &str) -> Result<Vec<String>, CoreError> {
    let mut keys =
        conn.prepare_cached("SELECT key FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")?;
    let found = keys
        .query_map(params![prefix, prefix_end(prefix)], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(found)
}

/// Keys with `prefix` removed and their values, in key order.
pub fn meta_under(conn: &Connection, prefix: &str) -> Result<Vec<(String, String)>, CoreError> {
    let mut rows = conn.prepare_cached(
        "SELECT substr(key, length(?1) + 1), value FROM meta
          WHERE key >= ?1 AND key < ?2 ORDER BY key",
    )?;
    let found = rows
        .query_map(params![prefix, prefix_end(prefix)], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    Ok(found)
}

/// Deletes every key that starts with `prefix`.
pub fn meta_delete_under(conn: &Connection, prefix: &str) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM meta WHERE key >= ?1 AND key < ?2")?
        .execute(params![prefix, prefix_end(prefix)])?;
    Ok(())
}

/// What the root last said this server takes in one request. Fresh in a
/// drain once it has confirmed the instance, which reads the root.
pub fn request_limit(conn: &Connection) -> Result<Option<usize>, CoreError> {
    Ok(meta_get(conn, META_REQUEST_LIMIT)?.and_then(|limit| limit.parse().ok()))
}

/// `limit` is what the root said just now, so a refusal waiting on a read has it.
pub(crate) fn note_request_limit(conn: &Connection, limit: Option<usize>) -> Result<(), CoreError> {
    if limit_refused(conn)? {
        meta_delete(conn, META_LIMIT_HOLDS)?;
    }
    if request_limit(conn)? == limit {
        return Ok(());
    }
    match limit {
        Some(limit) => meta_set(conn, META_REQUEST_LIMIT, &limit.to_string()),
        None => meta_delete(conn, META_REQUEST_LIMIT),
    }
}

/// A folder's hold outranks a refusal: its scan reads the root anyway.
pub(crate) fn note_limit_refused(conn: &Connection) -> Result<(), CoreError> {
    if meta_get(conn, META_LIMIT_HOLDS)?.is_none() {
        meta_set(conn, META_LIMIT_HOLDS, LIMIT_REFUSED)?;
    }
    Ok(())
}

pub(crate) fn limit_refused(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_LIMIT_HOLDS)?.as_deref() == Some(LIMIT_REFUSED))
}

pub(crate) fn limit_marked(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_LIMIT_HOLDS)?.is_some())
}

pub(crate) fn note_limit_held(conn: &Connection, held: bool) -> Result<(), CoreError> {
    let now = meta_get(conn, META_LIMIT_HOLDS)?;
    if held && now.as_deref() != Some(LIMIT_HELD) {
        meta_set(conn, META_LIMIT_HOLDS, LIMIT_HELD)?;
    } else if !held && now.as_deref() == Some(LIMIT_HELD) {
        meta_delete(conn, META_LIMIT_HOLDS)?;
    }
    Ok(())
}

pub fn meta_delete(conn: &Connection, key: &str) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM meta WHERE key = ?1")?
        .execute([key])?;
    Ok(())
}

/// Zero for a store whose copy has never changed.
pub fn copy_revision(conn: &Connection) -> Result<u64, CoreError> {
    match meta_get(conn, META_COPY_REVISION)? {
        Some(value) => value
            .parse()
            .map_err(|_| CoreError::Store(format!("the copy's revision {value:?} is no number"))),
        None => Ok(0),
    }
}

/// A record of the copy's changes: one row an id, numbered by its latest
/// change.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Changes {
    /// `copy_changes`, where `''` stands for every item.
    Items,
    /// `edge_changes`.
    Edges,
}

impl Changes {
    fn table(self) -> (&'static str, &'static str) {
        match self {
            Changes::Items => ("copy_changes", "item_id"),
            Changes::Edges => ("edge_changes", "edge_id"),
        }
    }
}

/// The number of the latest change `of` holds, 0 for none.
pub(crate) fn last_change(conn: &Connection, of: Changes) -> Result<i64, CoreError> {
    let (table, _) = of.table();
    Ok(conn
        .prepare_cached(&format!("SELECT coalesce(max(seq), 0) FROM {table}"))?
        .query_row([], |row| row.get(0))?)
}

/// The ids changed after change `since`, or `None` where more than `most`
/// did or the types changed, which reaches every item.
pub(crate) fn changed_since(
    conn: &Connection,
    of: Changes,
    since: i64,
    most: usize,
) -> Result<Option<HashSet<String>>, CoreError> {
    let (table, column) = of.table();
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {column} FROM {table} WHERE seq > ?1 LIMIT ?2"
    ))?;
    let ids = statement
        .query_map(
            params![since, i64::try_from(most).unwrap_or(i64::MAX - 1) + 1],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<HashSet<String>>>()?;
    Ok((ids.len() <= most && !ids.contains("")).then_some(ids))
}

/// The number of the latest change to a held table, 0 for none.
pub(crate) fn last_table_change(conn: &Connection) -> Result<i64, CoreError> {
    Ok(conn
        .prepare_cached("SELECT coalesce(max(seq), 0) FROM table_changes")?
        .query_row([], |row| row.get(0))?)
}

/// Changed tables in name order, or `None` when their count exceeds `most`.
pub(crate) fn tables_changed_since(
    conn: &Connection,
    since: i64,
    most: usize,
) -> Result<Option<Vec<(String, String)>>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT item_id, name FROM table_changes WHERE seq > ?1 ORDER BY item_id, name LIMIT ?2",
    )?;
    let tables = statement
        .query_map(
            params![since, i64::try_from(most).unwrap_or(i64::MAX - 1) + 1],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((tables.len() <= most).then_some(tables))
}

/// The latest change of an edge the copy let go of from `edge_changes`, 0
/// for none: the removals up to it are no longer named.
pub(crate) fn edge_changes_floor(conn: &Connection) -> Result<i64, CoreError> {
    match meta_get(conn, META_EDGE_CHANGES_FLOOR)? {
        Some(value) => value.parse().map_err(|_| {
            CoreError::Store(format!("the edge changes' floor {value:?} is no number"))
        }),
        None => Ok(0),
    }
}

/// Where `edge_changes` holds more than twice `keep` rows of edges the copy
/// no longer holds, lets go of those older than its latest `keep` changes,
/// and raises the floor to the latest let go. The slack makes this run about
/// once in `keep` removals rather than on every open past the limit, since
/// each run reads every held edge's row. A held edge keeps its row, so the
/// table holds at most a row for each held edge and twice `keep` more. A
/// cursor at or past the floor loses nothing, and one before it has seen at
/// least `keep` changes since. The latest row always stays, since the
/// triggers number the next change from it. Only the writer calls this: it
/// writes, and a reading handle never does.
pub(crate) fn prune_edge_changes(conn: &Connection, keep: usize) -> Result<(), CoreError> {
    let keep = i64::try_from(keep.max(1)).unwrap_or(i64::MAX / 2);
    let removed = |conn: &Connection| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT (SELECT count(*) FROM edge_changes) - (SELECT count(*) FROM edges)",
            [],
            |row| row.get(0),
        )
    };
    if removed(conn)? <= keep * 2 {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    if removed(&tx)? <= keep * 2 {
        return Ok(());
    }
    let Some(oldest_kept) = tx
        .query_row(
            "SELECT seq FROM edge_changes ORDER BY seq DESC LIMIT 1 OFFSET ?1",
            [keep],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(());
    };
    let gone =
        "seq <= ?1 AND NOT EXISTS (SELECT 1 FROM edges WHERE edges.id = edge_changes.edge_id)";
    let floor: Option<i64> = tx.query_row(
        &format!("SELECT max(seq) FROM edge_changes WHERE {gone}"),
        [oldest_kept],
        |row| row.get(0),
    )?;
    if let Some(floor) = floor {
        tx.execute(&format!("DELETE FROM edge_changes WHERE {gone}"), [floor])?;
        meta_set(&tx, META_EDGE_CHANGES_FLOOR, &floor.to_string())?;
    }
    tx.commit()?;
    Ok(())
}

/// Records the clock's time as when the copy last finished a pull, even where
/// it is earlier than the time it replaces: a clock set back is still the
/// clock.
pub(crate) fn mark_synced(conn: &Connection) -> Result<(), CoreError> {
    meta_set(conn, META_SYNCED_AT, &iso_at(crate::clock::system_time()))
}
