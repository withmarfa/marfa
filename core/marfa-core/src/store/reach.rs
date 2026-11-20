//! The slice's reach: clearing it, settling what lies beneath it and filling it again.

use super::completeness::{hydration_complete, let_go_unless_kept, refilling, slice_query};
use super::marks::item_held;
use super::meta::{META_REFILL, meta_delete, meta_delete_under, meta_get, meta_set};
use super::queue::edge_write_waits;
use super::rows::{WAITING, evict_item, forget_edge, whole_edge_types};
use crate::error::CoreError;
use crate::model::Subject;
use rusqlite::Connection;
use std::collections::HashSet;

pub fn clear_slice(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "DELETE FROM tags;
         DELETE FROM edges;
         DELETE FROM items;
         DELETE FROM items_fts;
         DELETE FROM beneath;
         DELETE FROM beneath_reach;
         DELETE FROM table_rows;
         DELETE FROM item_tables;
         DELETE FROM rows_reread;",
    )?;
    forget_marks_of_the_walk(conn)
}

/// Counts the changes to the `parent-of` edges since the last settle of the
/// slice's `beneath`; the triggers on `edges` add to it.
pub(crate) const META_BENEATH_SETTLE: &str = "beneath_settle";

/// Set where the next settle of `beneath` judges every row the copy holds,
/// not only those whose place under the root changed: a hydration holds what
/// its listings brought, which the reach it ends with may not match.
pub(crate) const META_BENEATH_WHOLE: &str = "beneath_settle_whole";

/// Owes the slice's `beneath` a whole settle, or forgets one owed where the
/// slice has no `beneath`. The reach the copy held stays until that settle
/// replaces it, so a row is judged by it while a refill lists.
pub(crate) fn owe_whole_settle(conn: &Connection) -> Result<(), CoreError> {
    if slice_query(conn)?.is_some_and(|query| query.beneath.is_some()) {
        bump_beneath_settle(conn)?;
        meta_set(conn, META_BENEATH_WHOLE, "true")
    } else {
        conn.execute("DELETE FROM beneath_reach", [])?;
        meta_delete(conn, META_BENEATH_SETTLE)?;
        meta_delete(conn, META_BENEATH_WHOLE)
    }
}

/// The ids the last settle of `beneath` reached (`beneath_reach`).
pub(crate) fn beneath_reach(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare("SELECT id FROM beneath_reach")?;
    let ids = statement.query_map([], |row| row.get(0))?;
    Ok(ids.collect::<Result<_, _>>()?)
}

pub(crate) fn enter_beneath_reach(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    let mut statement =
        conn.prepare_cached("INSERT OR IGNORE INTO beneath_reach (id) VALUES (?1)")?;
    for id in ids {
        statement.execute([id])?;
    }
    Ok(())
}

pub(crate) fn leave_beneath_reach(conn: &Connection, ids: &[String]) -> Result<(), CoreError> {
    let mut statement = conn.prepare_cached("DELETE FROM beneath_reach WHERE id = ?1")?;
    for id in ids {
        statement.execute([id])?;
    }
    Ok(())
}

/// Every id the copy holds a row under.
pub(crate) fn item_ids(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare("SELECT id FROM items")?;
    let ids = statement.query_map([], |row| row.get(0))?;
    Ok(ids.collect::<Result<_, _>>()?)
}

fn bump_beneath_settle(conn: &Connection) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, '1')
           ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
        [META_BENEATH_SETTLE],
    )?;
    Ok(())
}

/// A condition on `edges` that the `parent-of` edges a walk of `beneath`
/// follows meet. While a refill runs, an edge it has not brought may be gone
/// from the server and leaves at its sweep, so only those it brought and
/// those a waiting write of this device's names are followed.
pub(crate) fn beneath_edges(conn: &Connection) -> Result<&'static str, CoreError> {
    Ok(if refilling(conn)? {
        "(EXISTS (SELECT 1 FROM meta WHERE meta.key = 'edge_brought/' || edges.id)
          OR edges.id IN (SELECT edge_id FROM queue
                           WHERE edge_id IS NOT NULL
                             AND (verdict IS NULL OR verdict IN ('blocked', 'dead'))))"
    } else {
        "1"
    })
}

pub(super) fn edge_brought(id: &str) -> String {
    format!("{EDGE_BROUGHT}{id}")
}

const EDGE_BROUGHT: &str = "edge_brought/";

/// Whether the refill under way has brought the edge `id` again.
pub fn refill_brought_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(meta_get(conn, &edge_brought(id))?.is_some())
}

const REFUSED_OLDER: &str = "refused_older/";

fn refused_older_key(subject: Subject, id: &str) -> String {
    let subject = match subject {
        Subject::Item => "item",
        Subject::Edge => "edge",
    };
    format!("{REFUSED_OLDER}{subject}/{id}")
}

/// Keeps, while a hydration runs, that the server gave `id` at a point
/// earlier than the row the copy holds, which the copy kept: that row is then
/// not the server's to compare with (`crate::restored::compare`).
pub(crate) fn note_refused_older(
    conn: &Connection,
    subject: Subject,
    id: &str,
) -> Result<(), CoreError> {
    if hydration_complete(conn)? && !refilling(conn)? {
        return Ok(());
    }
    meta_set(conn, &refused_older_key(subject, id), "true")
}

/// Whether the hydration under way kept the copy's row of `id` over an
/// earlier one the server gave.
pub fn refused_older(conn: &Connection, subject: Subject, id: &str) -> Result<bool, CoreError> {
    Ok(meta_get(conn, &refused_older_key(subject, id))?.is_some())
}

/// Every row the hydration under way kept over an earlier one the server
/// gave.
pub(crate) fn refused_older_rows(conn: &Connection) -> Result<Vec<(Subject, String)>, CoreError> {
    Ok(super::meta::meta_under(conn, REFUSED_OLDER)?
        .into_iter()
        .filter_map(|(key, _)| match key.split_once('/') {
            Some(("item", id)) => Some((Subject::Item, id.to_string())),
            Some(("edge", id)) => Some((Subject::Edge, id.to_string())),
            _ => None,
        })
        .collect())
}

pub(crate) fn forget_refused_older(conn: &Connection) -> Result<(), CoreError> {
    meta_delete_under(conn, REFUSED_OLDER)
}

fn forget_marks_of_the_walk(conn: &Connection) -> Result<(), CoreError> {
    for prefix in [
        "item_listed/",
        crate::reach::UNLISTED_BEFORE,
        "item_early/",
        EDGE_BROUGHT,
        super::write_state::MADE,
        REFUSED_OLDER,
    ] {
        meta_delete_under(conn, prefix)?;
    }
    Ok(())
}

/// The start of a hydration that fills the copy again in place: nothing has
/// been brought yet, so every row and edge the copy holds is one the sweep at
/// its end takes out unless the walk or the replay brings it again.
pub fn start_refill(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch("DELETE FROM rows_reread;")?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value)
         SELECT ?2 || substr(key, length(?1) + 1), 'false' FROM meta
          WHERE key >= ?1 AND key < ?3 AND value = 'false'",
        rusqlite::params![
            "item_listed/",
            crate::reach::UNLISTED_BEFORE,
            super::meta::prefix_end("item_listed/")
        ],
    )?;
    meta_delete_under(conn, "item_listed/")?;
    meta_delete_under(conn, "item_early/")?;
    meta_delete_under(conn, EDGE_BROUGHT)?;
    forget_refused_older(conn)
}

/// The ids a waiting write names: as its item or its to item, or as an end
/// of the edge it writes, whether the ends it was queued with, those a move
/// in its payload names or those of the edge the copy shows. The one rule a
/// copy keeps rows by for its waiting writes, whatever lets rows go.
fn named_by_waiting() -> String {
    format!(
        "SELECT id FROM (
         SELECT item_id AS id FROM queue WHERE {WAITING}
         UNION SELECT to_id FROM queue WHERE {WAITING}
         UNION SELECT json_extract(payload, '$.from_id') FROM queue
                WHERE {WAITING} AND edge_id IS NOT NULL AND json_valid(payload)
         UNION SELECT json_extract(payload, '$.to_id') FROM queue
                WHERE {WAITING} AND edge_id IS NOT NULL AND json_valid(payload)
         UNION SELECT edges.from_id FROM edges JOIN queue ON queue.edge_id = edges.id
                WHERE {WAITING}
         UNION SELECT edges.to_id FROM edges JOIN queue ON queue.edge_id = edges.id
                WHERE {WAITING}
         ) WHERE id IS NOT NULL"
    )
}

fn named_by_waiting_writes(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(&named_by_waiting())?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<HashSet<String>, _>>()?)
}

/// Whether a waiting write names the row `id` (`named_by_waiting`).
pub fn waiting_write_names(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM ({}) AS named WHERE named.id = ?1)",
            named_by_waiting()
        ),
        [id],
        |row| row.get(0),
    )?)
}

/// The ids the edge write `id` names as an end, as `named_by_waiting` reads
/// them for one row. Empty for an item write.
pub(super) fn edge_write_ends(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT queue.item_id, queue.to_id,
                CASE WHEN json_valid(queue.payload) THEN json_extract(queue.payload, '$.from_id') END,
                CASE WHEN json_valid(queue.payload) THEN json_extract(queue.payload, '$.to_id') END,
                edges.from_id, edges.to_id
           FROM queue LEFT JOIN edges ON edges.id = queue.edge_id
          WHERE queue.id = ?1 AND queue.edge_id IS NOT NULL",
    )?;
    let mut ends = Vec::new();
    let mut rows = statement.query([id])?;
    while let Some(row) = rows.next()? {
        for column in 0..6 {
            if let Some(end) = row.get::<_, Option<String>>(column)?
                && !ends.contains(&end)
            {
                ends.push(end);
            }
        }
    }
    Ok(ends)
}

/// Judges again by the slice's query each held row in `ends` once the edge
/// write naming it no longer waits, so a row kept only as its end leaves
/// (`keeps_held`).
pub(super) fn let_go_of_ends(conn: &Connection, ends: &[String]) -> Result<(), CoreError> {
    if ends.is_empty() || slice_query(conn)?.is_none() {
        return Ok(());
    }
    let catalog = crate::catalog::load(conn)?;
    for end in ends {
        if item_held(conn, end)? {
            let_go_unless_kept(conn, &catalog, end)?;
        }
    }
    Ok(())
}

/// The end of a hydration that filled the copy again in place, after its walk
/// and its replay: takes out each row neither brought, but for a pinned row
/// and one a waiting write names as its item or as an end of an edge, then
/// each such edge but one a waiting write names. Answers the rows and the
/// edges it took out.
pub fn sweep_refill(conn: &Connection) -> Result<(u64, u64), CoreError> {
    let unbrought = |sql: &str| -> Result<Vec<String>, CoreError> {
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<String>, _>>()?)
    };
    let whole = whole_edge_types(conn)?;
    let named = named_by_waiting_writes(conn)?;
    let mut items = 0;
    for id in unbrought(
        "SELECT id FROM items
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'item_listed/' || items.id)
            AND NOT EXISTS (SELECT 1 FROM pins WHERE pins.item_id = items.id)
          ORDER BY id",
    )? {
        if !named.contains(&id) && evict_item(conn, &id, &whole)? {
            items += 1;
        }
    }
    let mut edges = 0;
    for id in unbrought(
        "SELECT id FROM edges
          WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'edge_brought/' || edges.id)
          ORDER BY id",
    )? {
        if !edge_write_waits(conn, &id)? && forget_edge(conn, &id)? {
            edges += 1;
        }
    }
    meta_delete_under(conn, EDGE_BROUGHT)?;
    meta_delete(conn, META_REFILL)?;
    Ok((items, edges))
}
