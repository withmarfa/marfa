//! Table rows a server restored to an earlier point has lost: the receipts of
//! the row writes it took, the rows set aside with the copy, and the writes
//! that put back what it lacks once a table is filled whole again
//! (`device/expire-rows-lost` and `device/restored-rows-kept`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::http::Http;
use crate::model::{BlockedReason, QueuedWrite, Verdict, WriteKind};
use crate::row_writes::{self, Op};
use crate::store::{self, Cached, restored::RECEIPTS_KEPT_MILLIS};
use crate::wire::RowsEvent;
use crate::{Core, CoreError, Result};

fn floor() -> i64 {
    store::now_millis().saturating_sub(RECEIPTS_KEPT_MILLIS)
}

/// Whether the copy applied the batch's event before its answer came.
pub(crate) fn batch_seen(conn: &Connection, batch: &str) -> Result<bool> {
    Ok(conn
        .query_row_cached("SELECT 1 FROM rows_seen WHERE batch = ?1", [batch], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

/// Keeps a receipt of each row `write` changed or removed in `batch`, at the
/// server's time `at`. Each lets go of the receipts of the same row kept
/// before it that it supersedes: a change those of removals, a removal those
/// of changes. A change is not kept where the batch's event came first.
pub(crate) fn keep_receipts(
    conn: &Connection,
    write: &QueuedWrite,
    batch: &str,
    at: &str,
    results: &[Value],
    seen: bool,
) -> Result<()> {
    let (Some(item), Some(table)) = (write.item_id.as_deref(), write.table.as_deref()) else {
        return Ok(());
    };
    let now = store::now_millis();
    conn.prepare_cached("DELETE FROM row_receipts WHERE answered_at < ?1")?
        .execute([now.saturating_sub(RECEIPTS_KEPT_MILLIS)])?;
    for result in results {
        let Some(id) = result.get("id").and_then(Value::as_str) else {
            continue;
        };
        let removal = match result.get("outcome").and_then(Value::as_str) {
            Some("deleted") => true,
            Some("created" | "replaced" | "patched") => false,
            _ => continue,
        };
        conn.prepare_cached(
            "DELETE FROM row_receipts
              WHERE item_id = ?1 AND name = ?2 AND id = ?3 AND removal = ?4 AND write_id <> ?5",
        )?
        .execute(params![item, table, id, !removal, write.id])?;
        if seen && !removal {
            continue;
        }
        conn.prepare_cached(
            "INSERT INTO row_receipts
               (write_id, item_id, name, id, batch, at, removal, answered_at, seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (write_id, id) DO UPDATE SET
               batch = excluded.batch, at = excluded.at, removal = excluded.removal,
               answered_at = excluded.answered_at, seen = excluded.seen",
        )?
        .execute(params![
            write.id, item, table, id, batch, at, removal, now, seen
        ])?;
    }
    // The server's time, which a row set aside with the write laid on keeps.
    conn.prepare_cached("UPDATE rows_laid SET at = ?2 WHERE batch = ?1")?
        .execute(params![batch, at])?;
    Ok(())
}

/// The batch's own event shows the server holds what it changed: a change
/// is let go, and a removal kept as seen. An event that names no receipt may
/// come before its answer, so it is kept as seen while a row write to the
/// table awaits one, whatever the copy holds of the table. A row the event
/// removes is not kept from the rows set aside: another writer removed it.
pub(crate) fn seen_by(conn: &Connection, event: &RowsEvent) -> Result<()> {
    let (item, table, batch) = (event.item.id.as_str(), event.table.as_str(), &event.batch);
    let changes = conn
        .prepare_cached("DELETE FROM row_receipts WHERE batch = ?1 AND removal = 0")?
        .execute([batch])?;
    let removals = conn
        .prepare_cached("UPDATE row_receipts SET seen = 1 WHERE batch = ?1 AND removal = 1")?
        .execute([batch])?;
    if changes + removals == 0 {
        row_writes::seen_first(conn, item, table, batch)?;
    }
    for row in event.rows.iter().filter(|row| row.deleted) {
        conn.prepare_cached("DELETE FROM held_rows WHERE item_id = ?1 AND name = ?2 AND id = ?3")?
            .execute(params![item, table, row.id])?;
    }
    Ok(())
}

/// Whether the table's rows are set aside to be compared, and if so whether
/// a found restore set them aside.
fn marked(conn: &Connection, item: &str, table: &str) -> Result<Option<bool>> {
    Ok(conn
        .query_row_cached(
            "SELECT restored FROM held_tables WHERE item_id = ?1 AND name = ?2",
            params![item, table],
            |row| row.get(0),
        )
        .optional()?)
}

/// Lays what the server took of `write` on the rows set aside of its table,
/// so the comparison judges them as the server last answered them: each
/// operation at the server's time `at` where it changed the row, and at the
/// row's own time where it did not. A put the server held already lets the
/// row go, as the server holds it. With no `results`, the operations are laid
/// on the rows set aside only. An undo answers no values, so each row it
/// changed is let go.
pub(crate) fn fold(
    conn: &Connection,
    write: &QueuedWrite,
    at: Option<&str>,
    results: &[Value],
) -> Result<()> {
    let (Some(item), Some(table)) = (write.item_id.as_deref(), write.table.as_deref()) else {
        return Ok(());
    };
    if marked(conn, item, table)?.is_none() {
        return Ok(());
    }
    let held = |id: &str| -> Result<Option<row_writes::RowText>> {
        Ok(conn
            .query_row_cached(
                "SELECT body, withheld, updated_at FROM held_rows
                  WHERE item_id = ?1 AND name = ?2 AND id = ?3",
                params![item, table, id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?)
    };
    let set = |id: &str, row: Option<row_writes::RowText>| -> Result<()> {
        match row {
            Some((body, withheld, updated_at)) => conn
                .prepare_cached(
                    "INSERT INTO held_rows (item_id, name, id, body, withheld, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (item_id, name, id) DO UPDATE SET
                       body = excluded.body, withheld = excluded.withheld,
                       updated_at = excluded.updated_at",
                )?
                .execute(params![item, table, id, body, withheld, updated_at])?,
            None => conn
                .prepare_cached(
                    "DELETE FROM held_rows WHERE item_id = ?1 AND name = ?2 AND id = ?3",
                )?
                .execute(params![item, table, id])?,
        };
        Ok(())
    };
    if write.kind == WriteKind::UndoRows {
        for result in results {
            let outcome = result.get("outcome").and_then(Value::as_str);
            if let Some(id) = result.get("id").and_then(Value::as_str)
                && outcome != Some("unchanged")
            {
                set(id, None)?;
            }
        }
        return Ok(());
    }
    let ops = row_writes::queued_ops(&write.body)?;
    if results.is_empty() {
        let ids: BTreeSet<&str> = ops.iter().map(Op::id).collect();
        for id in ids {
            if let Some(row) = held(id)? {
                set(id, row_writes::laid_on(Some(row), &ops, id, None)?)?;
            }
        }
        return Ok(());
    }
    for (op, result) in ops.iter().zip(results) {
        let id = op.id();
        let row = match (op, result.get("outcome").and_then(Value::as_str)) {
            (Op::Put { .. }, Some("unchanged")) => None,
            (_, Some("created" | "replaced" | "patched" | "deleted")) => {
                row_writes::laid_on(held(id)?, std::slice::from_ref(op), id, at)?
            }
            _ => row_writes::laid_on(held(id)?, std::slice::from_ref(op), id, None)?,
        };
        set(id, row)?;
    }
    Ok(())
}

/// Whether `write` is a row write not yet sent to a table whose rows are set
/// aside, which waits until they are compared, so the kept writes go ahead
/// of it (`device/restored-rows-held`). Until a fill lists the item and its
/// tables again the copy has no record of either, and the next fill lets go
/// of a table it no longer holds (`let_go_unheld`).
pub(crate) fn holds_back(conn: &Connection, write: &QueuedWrite) -> Result<bool> {
    if !write.kind.rows() {
        return Ok(false);
    }
    let (Some(item), Some(table)) = (write.item_id.as_deref(), write.table.as_deref()) else {
        return Ok(false);
    };
    let held = conn
        .query_row_cached(
            "SELECT 1 FROM held_tables h
              WHERE h.item_id = ?1 AND h.name = ?2
                AND NOT EXISTS (
                  SELECT 1 FROM items i WHERE i.id = h.item_id AND i.state = 'trashed')
                AND NOT EXISTS (
                  SELECT 1 FROM item_tables t
                   WHERE t.item_id = h.item_id AND t.name = h.name AND t.state = 'online')",
            params![item, table],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(held && store::unsent(conn, &write.id)?)
}

/// A new predecessor still goes first after release clears its reason.
pub(crate) fn kept_ahead(
    conn: &Connection,
    write: &QueuedWrite,
    read: impl Fn(&str) -> bool,
) -> Result<bool> {
    if !write.kind.rows() {
        return Ok(false);
    }
    let mut query = conn.prepare_cached(
        "SELECT k.id, k.verdict, k.reason FROM queue w JOIN queue k
           ON k.item_id = w.item_id AND k.row_table = w.row_table AND k.seq < w.seq
        WHERE w.id = ?1 AND w.sent = 0 AND k.sent = 0 AND k.kind IN (?2, ?3)
          AND (k.verdict IS NULL OR k.verdict IN (?4, ?5))",
    )?;
    let ahead = query.query_map(
        params![
            write.id,
            WriteKind::WriteRows.as_str(),
            WriteKind::UndoRows.as_str(),
            Verdict::Blocked.as_str(),
            Verdict::Dead.as_str(),
        ],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    )?;
    for ahead in ahead {
        let (id, verdict, reason) = ahead?;
        let kept = verdict.as_deref() == Some(Verdict::Blocked.as_str())
            && reason.as_deref() == Some(BlockedReason::ServerRestored.as_str());
        if kept || !read(&id) {
            return Ok(true);
        }
    }
    Ok(false)
}

struct Unseen {
    id: String,
    at: String,
    removal: bool,
}

/// Whether `server` is a time before `at`. A time that does not read orders
/// nothing, so it is never taken as a loss.
fn earlier(server: &str, at: &str) -> bool {
    match (marfa_rules::time::read(server), marfa_rules::time::read(at)) {
        (Ok(server), Ok(at)) => server < at,
        _ => false,
    }
}

/// A page that does not read as rows is about this read alone.
fn off_shape() -> CoreError {
    CoreError::Decoding("a page of table rows".into())
}

/// Reads the rows each receipt no event has shown names, for those answered
/// before `before`, and answers whether the server has lost one: a change
/// whose row it lacks or holds at an earlier time, or a removal whose row it
/// holds from before it (`device/expire-rows-lost`). A table whose read says
/// nothing of it has its receipts let go.
pub(crate) fn lost(core: &Core, http: &Http, stop: &AtomicBool, before: i64) -> Result<bool> {
    let mut tables: BTreeMap<(String, String), Vec<Unseen>> = BTreeMap::new();
    {
        let conn = core.conn()?;
        let mut query = conn.prepare_cached(
            "SELECT item_id, name, id, at, removal FROM row_receipts
              WHERE seen = 0 AND answered_at >= ?1 AND answered_at < ?2
              ORDER BY item_id, name",
        )?;
        let rows = query.query_map(params![floor(), before], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                Unseen {
                    id: row.get(2)?,
                    at: row.get(3)?,
                    removal: row.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (item, table, unseen) = row?;
            tables.entry((item, table)).or_default().push(unseen);
        }
    }
    for ((item, table), unseen) in tables {
        crate::catch_up::refuse_if_stopped(stop)?;
        let ids: Vec<String> = unseen.iter().map(|receipt| receipt.id.clone()).collect();
        let mut held: HashMap<String, Option<String>> = HashMap::new();
        let read = crate::tables::read_named_or(
            core,
            http,
            &item,
            &table,
            &ids,
            off_shape,
            &mut |id, row| {
                let at = row
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                held.insert(id, at);
            },
        );
        let conn = core.conn()?;
        let Some(read) = crate::restored::heard(read)? else {
            conn.prepare_cached(
                "DELETE FROM row_receipts WHERE item_id = ?1 AND name = ?2 AND answered_at < ?3",
            )?
            .execute(params![item, table, before])?;
            continue;
        };
        let gone = !read;
        for receipt in &unseen {
            let server = held.get(&receipt.id);
            let lost = match (receipt.removal, server) {
                (false, None) => true,
                (false, Some(at)) => at.as_deref().is_some_and(|at| earlier(at, &receipt.at)),
                (true, Some(Some(at))) => !gone && earlier(at, &receipt.at),
                (true, _) => false,
            };
            if lost {
                return Ok(true);
            }
        }
        conn.prepare_cached(
            "DELETE FROM row_receipts
              WHERE item_id = ?1 AND name = ?2 AND removal = 0 AND seen = 0 AND answered_at < ?3",
        )?
        .execute(params![item, table, before])?;
        conn.prepare_cached(
            "UPDATE row_receipts SET seen = 1
              WHERE item_id = ?1 AND name = ?2 AND removal = 1 AND seen = 0 AND answered_at < ?3",
        )?
        .execute(params![item, table, before])?;
    }
    Ok(false)
}

/// Lets go of the receipts of changes, whose rows are set aside, and keeps
/// every removal as seen.
pub(crate) fn forget_changes(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM row_receipts WHERE removal = 0", [])?;
    conn.execute("UPDATE row_receipts SET seen = 1 WHERE seen = 0", [])?;
    Ok(())
}

pub(crate) fn forget(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM row_receipts", [])?;
    release(conn)
}

pub(crate) fn release(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM held_rows; DELETE FROM held_tables;")?;
    Ok(())
}

fn mark(conn: &Connection, item: &str, table: &str, restored: bool) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO held_tables (item_id, name, restored) VALUES (?1, ?2, ?3)
         ON CONFLICT (item_id, name) DO UPDATE SET restored = MAX(restored, excluded.restored)",
    )?
    .execute(params![item, table, restored])?;
    Ok(())
}

fn hold_row(conn: &Connection, item: &str, table: &str, id: &str) -> Result<()> {
    if let Some((body, withheld, updated_at)) = row_writes::answered(conn, item, table, id)? {
        conn.prepare_cached(
            "INSERT OR IGNORE INTO held_rows (item_id, name, id, body, withheld, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?
        .execute(params![item, table, id, body, withheld, updated_at])?;
    }
    Ok(())
}

/// The tables `hold_copy` and `hold_unseen` may set aside: those of an item
/// no create waits for, which a key may write rows of, and not past the cap.
fn holdable(conn: &Connection, item: &str, table: &str) -> Result<Option<bool>> {
    let state: Option<String> = conn
        .query_row_cached(
            "SELECT t.state FROM item_tables t JOIN items i ON i.id = t.item_id
              WHERE t.item_id = ?1 AND t.name = ?2 AND t.state <> 'online'
                AND i.read_only = 0 AND i.type NOT LIKE 'system.%'",
            params![item, table],
            |row| row.get(0),
        )
        .optional()?;
    let Some(state) = state else {
        return Ok(None);
    };
    if !store::untaken_creates_for_item(conn, item)?.is_empty() {
        return Ok(None);
    }
    Ok(Some(state == "filling" || state == "whole"))
}

/// Sets aside each row of every table the copy holds, as the server last
/// answered it, and marks for comparison each table held or named by a
/// removal this device made (`device/restored-rows-kept`). A row already set
/// aside stays as it was first set aside.
pub(crate) fn hold_copy(conn: &Connection) -> Result<()> {
    let tables: Vec<(String, String)> = conn
        .prepare(
            "SELECT item_id, name FROM item_tables WHERE state IN ('filling', 'whole')
             UNION
             SELECT r.item_id, r.name FROM row_receipts r
               JOIN item_tables t ON t.item_id = r.item_id AND t.name = r.name
              WHERE r.removal = 1 AND r.answered_at >= ?1",
        )?
        .query_map([floor()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (item, table) in tables {
        let Some(rows) = holdable(conn, &item, &table)? else {
            continue;
        };
        mark(conn, &item, &table, true)?;
        if !rows {
            continue;
        }
        for id in row_writes::laid_or_beneath(conn, &item, &table)? {
            hold_row(conn, &item, &table, &id)?;
        }
        conn.prepare_cached(
            "INSERT OR IGNORE INTO held_rows (item_id, name, id, body, withheld, updated_at)
             SELECT r.item_id, r.name, r.id, r.body, r.withheld, r.updated_at FROM table_rows r
              WHERE r.item_id = ?1 AND r.name = ?2
                AND NOT EXISTS (SELECT 1 FROM rows_laid l
                                 WHERE l.item_id = r.item_id AND l.name = r.name AND l.id = r.id)
                AND NOT EXISTS (SELECT 1 FROM rows_beneath b
                                 WHERE b.item_id = r.item_id AND b.name = r.name AND b.id = r.id)",
        )?
        .execute(params![item, table])?;
    }
    Ok(())
}

/// `hold_copy` for the rows the receipts no event has shown name, of the one
/// table `only` names or of every table, so a clear of the copy's rows keeps
/// what the server may have lost of them (`device/restored-checked-before-clear`).
pub(crate) fn hold_named(conn: &Connection, only: Option<(&str, &str)>) -> Result<()> {
    let named: Vec<(String, String, String, bool)> = conn
        .prepare_cached(
            "SELECT DISTINCT item_id, name, id, removal FROM row_receipts
              WHERE seen = 0 AND answered_at >= ?1
                AND (?2 IS NULL OR (item_id = ?2 AND name = ?3))",
        )?
        .query_map(
            params![floor(), only.map(|only| only.0), only.map(|only| only.1)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?
        .collect::<rusqlite::Result<_>>()?;
    for (item, table, id, removal) in named {
        let Some(rows) = holdable(conn, &item, &table)? else {
            continue;
        };
        mark(conn, &item, &table, false)?;
        if rows && !removal {
            hold_row(conn, &item, &table, &id)?;
        }
    }
    Ok(())
}

/// Before a hydration of the same instance for another reason, owes again
/// each table the receipts no event has shown name, which sets their rows
/// aside, so a hydration in place still fills it from the server.
pub(crate) fn hold_unseen(conn: &Connection) -> Result<()> {
    let named: Vec<(String, String)> = conn
        .prepare(
            "SELECT DISTINCT item_id, name FROM row_receipts
              WHERE seen = 0 AND answered_at >= ?1",
        )?
        .query_map([floor()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (item, table) in named {
        if holdable(conn, &item, &table)?.is_some() {
            crate::tables::owe_table(conn, &item, &table)?;
        }
    }
    Ok(())
}

/// Lets go of what is set aside of a table the copy no longer holds, or holds
/// past the cap, which is never compared.
pub(crate) fn let_go_unheld(conn: &Connection) -> Result<()> {
    for table in ["held_rows", "held_tables"] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE NOT EXISTS (
                   SELECT 1 FROM item_tables t
                    WHERE t.item_id = {table}.item_id AND t.name = {table}.name
                      AND t.state <> 'online')"
            ),
            [],
        )?;
    }
    Ok(())
}

/// Whether a row the server holds as `server` lacks the row set aside as
/// `held`, each as `(values, withheld, updated_at)`. A row the server holds
/// at a later time was moved on by another writer. One at the same time is
/// the same row only with the same values: rows carry no version.
fn behind(held: (&Value, &Value, &str), server: Option<(&Value, &Value, &str)>) -> bool {
    let Some((values, withheld, at)) = server else {
        return true;
    };
    let (held_values, held_withheld, held_at) = held;
    if at == held_at {
        return values != held_values || withheld != held_withheld;
    }
    !matches!(
        (marfa_rules::time::read(at), marfa_rules::time::read(held_at)),
        (Ok(server), Ok(held)) if server > held
    )
}

fn parsed(text: Option<&str>) -> Value {
    text.and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(Value::Null)
}

/// For a table just filled whole from the server's rows alone, before the
/// writes waiting on it are laid over them: queues, blocked, a put of each
/// row set aside that the server lacks or holds behind it, and a delete of
/// each row this device removed that the server holds from before the
/// removal (`device/restored-rows-kept`). Where a restore was found, a row a
/// write sent with no answer yet names is judged with that write laid on, by
/// its values alone: the server may hold the write already, at a time of its
/// own. Where only receipts were checked, the row set aside is the copy's own
/// and may lack another writer's change the server holds at the same time,
/// so each row is judged by its time alone, as `lost` judges it.
pub(crate) fn keep_lost(conn: &Connection, item: &str, table: &str) -> Result<()> {
    let Some(restored) = marked(conn, item, table)? else {
        return Ok(());
    };
    let mut ops = Vec::new();
    let mut set_aside: HashSet<String> = HashSet::new();
    {
        let mut query = conn.prepare_cached(
            "SELECT h.id, h.body, h.withheld, h.updated_at, r.body, r.withheld, r.updated_at
               FROM held_rows h
               LEFT JOIN table_rows r ON r.item_id = h.item_id AND r.name = h.name AND r.id = h.id
              WHERE h.item_id = ?1 AND h.name = ?2
              ORDER BY h.id",
        )?;
        let rows = query.query_map(params![item, table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ),
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        for row in rows {
            let (id, held, server, server_withheld, server_at) = row?;
            set_aside.insert(id.clone());
            let unanswered = row_writes::unanswered_ops(conn, item, table, &id)?;
            let in_flight = !unanswered.is_empty();
            let held = if in_flight {
                row_writes::laid_on(Some(held), &unanswered, &id, None)?
            } else {
                Some(held)
            };
            let Some((body, withheld, at)) = held else {
                continue;
            };
            let values = parsed(Some(&body));
            let withheld = parsed(withheld.as_deref());
            let server_values = parsed(server.as_deref());
            let server_withheld = parsed(server_withheld.as_deref());
            let server_at = server_at.as_deref().filter(|_| server.is_some());
            let lost = match server_at {
                _ if !restored => server_at.is_none_or(|server_at| earlier(server_at, &at)),
                Some(_) if in_flight => values != server_values || withheld != server_withheld,
                server_at => behind(
                    (&values, &withheld, at.as_str()),
                    server_at.map(|at| (&server_values, &server_withheld, at)),
                ),
            };
            if lost {
                let Value::Object(values) = values else {
                    continue;
                };
                ops.push(Op::Put { id, values });
            }
        }
    }
    {
        let mut query = conn.prepare_cached(
            "SELECT k.id, MAX(k.at), r.updated_at FROM row_receipts k
               JOIN table_rows r ON r.item_id = k.item_id AND r.name = k.name AND r.id = k.id
              WHERE k.item_id = ?1 AND k.name = ?2 AND k.removal = 1 AND k.answered_at >= ?3
              GROUP BY k.id
              ORDER BY k.id",
        )?;
        let rows = query.query_map(params![item, table, floor()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, removed_at, server_at) = row?;
            if !set_aside.contains(&id) && earlier(&server_at, &removed_at) {
                ops.push(Op::Delete { id });
            }
        }
    }
    row_writes::keep(conn, item, table, &ops)?;
    for statement in [
        "DELETE FROM held_rows WHERE item_id = ?1 AND name = ?2",
        "DELETE FROM held_tables WHERE item_id = ?1 AND name = ?2",
    ] {
        conn.prepare_cached(statement)?
            .execute(params![item, table])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BEFORE: &str = "2026-11-19T09:00:00.000Z";
    const TEN: &str = "2026-11-19T10:00:00.000Z";
    const LATER: &str = "2026-11-19T11:00:00.000Z";

    fn copy() -> Connection {
        let conn = store::testing::conn();
        store::upsert_item(
            &conn,
            &store::testing::note("item", "T", "", BEFORE),
            None,
            &marfa_rules::catalog::Indexing::default(),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
            [],
        )
        .unwrap();
        conn
    }

    fn row(conn: &Connection, id: &str, count: i64, at: &str) {
        let values = json!({ "count": count });
        crate::tables::hold_row(
            conn,
            "item",
            "steps",
            id,
            values.as_object().unwrap(),
            &[],
            &serde_json::Map::new(),
            at,
        )
        .unwrap();
    }

    /// What a fill from the server alone leaves before the table is whole.
    fn filled(conn: &Connection, rows: &[(&str, i64, &str)]) {
        conn.execute("DELETE FROM table_rows", []).unwrap();
        for (id, count, at) in rows {
            row(conn, id, *count, at);
        }
    }

    fn receipt(conn: &Connection, id: &str, at: &str, removal: bool, seen: bool) {
        conn.execute(
            "INSERT INTO row_receipts (write_id, item_id, name, id, batch, at, removal, answered_at, seen)
             VALUES ('w-' || ?1, 'item', 'steps', ?1, 'b-' || ?1, ?2, ?3, ?4, ?5)",
            params![id, at, removal, store::now_millis(), seen],
        )
        .unwrap();
    }

    fn waiting(conn: &Connection, id: &str, seq: i64, follows: Option<&str>, row: &str) {
        conn.execute(
            "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at, follows)
             VALUES (?1, ?2, 'write_rows', 'item', 'steps', ?2, '{\"operations\":[]}', 0, 'at', ?3)",
            params![seq, id, follows],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
             VALUES (?1, ?2, 'item', 'steps', ?3, '[]', 'at')",
            params![id, seq, row],
        )
        .unwrap();
    }

    /// Each kept write as its verdict, reason, what it follows and its operations.
    fn kept(conn: &Connection) -> Vec<(String, Option<String>, Option<String>, Value)> {
        conn.prepare(
            "SELECT verdict, reason, follows, payload FROM queue
              WHERE reason = 'server_restored' ORDER BY seq",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .map(|row| {
            let (verdict, reason, follows, payload) = row.unwrap();
            let payload: Value = serde_json::from_str(&payload).unwrap();
            (verdict, reason, follows, payload["operations"].clone())
        })
        .collect()
    }

    fn put(id: &str, count: i64) -> Value {
        json!({ "op": "put", "id": id, "values": { "count": count } })
    }

    /// A row id a queued write may name.
    const R: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f70";

    fn noted(count: i64) -> Value {
        json!([{ "op": "put", "id": R, "values": { "count": count, "note": "later" } }])
    }

    fn patch_note() -> Value {
        json!([{ "op": "patch", "id": R, "values": { "note": "later" } }])
    }

    /// A row write of `ops`, laid over the copy as one waiting on its answer is.
    fn queued(conn: &Connection, id: &str, seq: i64, ops: Value, sent: bool) -> QueuedWrite {
        conn.execute(
            "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at)
             VALUES (?1, ?2, 'write_rows', 'item', 'steps', ?2, ?3, ?4, 'at')",
            params![seq, id, json!({ "operations": ops }).to_string(), sent],
        )
        .unwrap();
        for op in ops.as_array().unwrap() {
            conn.execute(
                "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
                 VALUES (?1, ?2, 'item', 'steps', ?3, ?4, 'at')",
                params![id, seq, op["id"].as_str().unwrap(), json!([op]).to_string()],
            )
            .unwrap();
        }
        store::queued_write(conn, id).unwrap().unwrap()
    }

    /// What the server holds of a row once the table is filled again.
    fn server_row(conn: &Connection, id: &str, values: Value, at: &str) {
        crate::tables::hold_row(
            conn,
            "item",
            "steps",
            id,
            values.as_object().unwrap(),
            &[],
            &serde_json::Map::new(),
            at,
        )
        .unwrap();
    }

    fn rows_event(batch: &str, rows: Value) -> crate::wire::EventPayload {
        crate::wire::EventPayload {
            event_type: "rows.changed".into(),
            rows: Some(
                serde_json::from_value(json!({
                    "item": { "id": "item" },
                    "table": "steps",
                    "batch": batch,
                    "last_activity_at": LATER,
                    "rows": rows,
                }))
                .unwrap(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn a_write_the_server_took_while_its_table_waited_to_be_compared_is_laid_on_the_rows_set_aside()
    {
        let conn = copy();
        row(&conn, R, 1, TEN);
        hold_copy(&conn).unwrap();
        // Sent before the rows were set aside, and taken by the restored
        // server, which held the row as it was before the backup.
        let write = queued(&conn, "w", 1, patch_note(), true);
        let results = [json!({ "id": R, "outcome": "patched" })];
        keep_receipts(&conn, &write, "batch", LATER, &results, false).unwrap();
        fold(&conn, &write, Some(LATER), &results).unwrap();
        conn.execute_batch(
            "UPDATE queue SET verdict = 'accepted'; DELETE FROM rows_laid WHERE write_id = 'w';",
        )
        .unwrap();
        // Restored again before the table was filled whole.
        hold_copy(&conn).unwrap();

        conn.execute("DELETE FROM table_rows", []).unwrap();
        server_row(&conn, R, json!({ "count": 0, "note": "later" }), LATER);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn).first().map(|kept| kept.3.clone()),
            Some(noted(1)),
            "the values the restored server lost in the row's other columns were not kept"
        );
    }

    #[test]
    fn a_write_sent_and_unanswered_when_its_table_is_compared_is_laid_on_the_row_kept() {
        for (label, server, at) in [
            ("not yet taken", json!({ "count": 0 }), BEFORE),
            (
                "taken by the restored server",
                json!({ "count": 0, "note": "later" }),
                LATER,
            ),
        ] {
            let conn = copy();
            row(&conn, R, 1, TEN);
            queued(&conn, "w", 1, patch_note(), true);
            hold_copy(&conn).unwrap();
            conn.execute("DELETE FROM table_rows", []).unwrap();
            server_row(&conn, R, server, at);
            keep_lost(&conn, "item", "steps").unwrap();
            assert_eq!(
                kept(&conn).first().map(|kept| kept.3.clone()),
                Some(noted(1)),
                "{label}"
            );
        }
    }

    #[test]
    fn rows_unseen_receipts_name_are_set_aside_before_an_expiry_clears_the_copy() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        receipt(&conn, "a", TEN, false, false);
        crate::reach::expire(&conn).unwrap();
        hold_unseen(&conn).unwrap();
        filled(&conn, &[("a", 0, BEFORE)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn).first().map(|kept| kept.3.clone()),
            Some(json!([put("a", 1)]))
        );
    }

    #[test]
    fn a_row_set_aside_where_no_restore_was_found_is_judged_by_its_time_alone() {
        // The copy's row is its own patch laid on a row that missed another
        // writer's change to another column, which the server holds at the
        // patch's time.
        let mine = json!({ "count": 2, "note": "mine" });
        let theirs = json!({ "count": 2, "note": "theirs" });
        for how in ["an expiry", "a check before a hydration"] {
            let conn = copy();
            server_row(&conn, "a", mine.clone(), LATER);
            receipt(&conn, "a", LATER, false, false);
            match how {
                "an expiry" => crate::reach::expire(&conn).unwrap(),
                _ => hold_unseen(&conn).unwrap(),
            }
            conn.execute("DELETE FROM table_rows", []).unwrap();
            server_row(&conn, "a", theirs.clone(), LATER);
            keep_lost(&conn, "item", "steps").unwrap();
            assert_eq!(kept(&conn), Vec::new(), "{how}");
        }

        // The witness: rows a found restore set aside are judged by their
        // values too, so the column the restored server lost is kept.
        let conn = copy();
        server_row(&conn, "a", mine.clone(), LATER);
        receipt(&conn, "a", LATER, false, false);
        hold_copy(&conn).unwrap();
        crate::reach::expire(&conn).unwrap();
        conn.execute("DELETE FROM table_rows", []).unwrap();
        server_row(&conn, "a", theirs, LATER);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn).first().map(|kept| kept.3.clone()),
            Some(json!([{ "op": "put", "id": "a", "values": mine }]))
        );
    }

    #[test]
    fn a_row_write_stays_held_while_a_hydration_has_cleared_its_item_until_it_is_trashed() {
        let conn = copy();
        waiting(&conn, "w", 1, None, "a");
        let holds = |conn: &Connection| {
            let write = store::queued_write(conn, "w").unwrap().unwrap();
            holds_back(conn, &write).unwrap()
        };
        mark(&conn, "item", "steps", false).unwrap();
        conn.execute_batch("DELETE FROM item_tables; DELETE FROM items;")
            .unwrap();
        assert!(holds(&conn), "the copy holds no item");
        store::upsert_item(
            &conn,
            &store::testing::note("item", "T", "", BEFORE),
            None,
            &marfa_rules::catalog::Indexing::default(),
        )
        .unwrap();
        assert!(holds(&conn), "the item came back");
        conn.execute("UPDATE items SET state = 'trashed'", [])
            .unwrap();
        assert!(!holds(&conn), "an item in the bin has no rows to compare");
    }

    #[test]
    fn a_removal_lets_go_of_the_changes_to_its_row_kept_before_it() {
        let conn = copy();
        let made = queued(&conn, "made", 1, json!([put(R, 1)]), true);
        let created = [json!({ "id": R, "outcome": "created" })];
        keep_receipts(&conn, &made, "one", TEN, &created, false).unwrap();
        let removed = queued(
            &conn,
            "removed",
            2,
            json!([{ "op": "delete", "id": R }]),
            true,
        );
        let deleted = [json!({ "id": R, "outcome": "deleted" })];
        keep_receipts(&conn, &removed, "two", LATER, &deleted, false).unwrap();
        let receipts: Vec<(String, bool)> = conn
            .prepare("SELECT write_id, removal FROM row_receipts ORDER BY write_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(receipts, vec![("removed".into(), true)]);
    }

    #[test]
    fn an_event_that_comes_before_its_answer_is_seen_whatever_the_copy_holds_of_its_table() {
        for state in ["online", "owed", "filling", "whole", "not held"] {
            let conn = copy();
            match state {
                "not held" => conn.execute("DELETE FROM item_tables", []).unwrap(),
                _ => conn
                    .execute("UPDATE item_tables SET state = ?1", [state])
                    .unwrap(),
            };
            let write = queued(&conn, "w", 1, json!([put(R, 1)]), true);
            let event = rows_event("early", json!([{ "id": R, "values": { "count": 1 } }]));
            store::restored::receipts_seen(&conn, "rows.changed", &event).unwrap();
            let seen = batch_seen(&conn, "early").unwrap();
            let created = [json!({ "id": R, "outcome": "created" })];
            keep_receipts(&conn, &write, "early", LATER, &created, seen).unwrap();
            let left: i64 = conn
                .query_row("SELECT COUNT(*) FROM row_receipts", [], |row| row.get(0))
                .unwrap();
            assert_eq!(left, 0, "{state}");
        }

        // The witness: with no row write waiting on its answer, an event is
        // another writer's, and nothing is taken as seen.
        let conn = copy();
        conn.execute("UPDATE item_tables SET state = 'online'", [])
            .unwrap();
        let event = rows_event("theirs", json!([{ "id": "a", "values": { "count": 1 } }]));
        store::restored::receipts_seen(&conn, "rows.changed", &event).unwrap();
        assert!(!batch_seen(&conn, "theirs").unwrap());
    }

    #[test]
    fn a_row_another_writer_removes_after_the_rows_were_set_aside_is_not_kept() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        row(&conn, "b", 2, TEN);
        hold_copy(&conn).unwrap();
        conn.execute("UPDATE item_tables SET state = 'owed'", [])
            .unwrap();
        let event = rows_event("theirs", json!([{ "id": "a", "deleted": true }]));
        store::restored::receipts_seen(&conn, "rows.changed", &event).unwrap();
        filled(&conn, &[]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn).first().map(|kept| kept.3.clone()),
            Some(json!([put("b", 2)]))
        );
    }

    #[test]
    fn a_write_taken_while_its_table_fills_is_laid_on_the_rows_set_aside() {
        let conn = copy();
        conn.execute("UPDATE item_tables SET state = 'filling'", [])
            .unwrap();
        row(&conn, R, 1, TEN);
        let write = queued(&conn, "w", 1, patch_note(), true);
        let results = [json!({ "id": R, "outcome": "patched" })];
        row_writes::taken(
            &conn,
            "item",
            "steps",
            Some("batch"),
            &[row_writes::Taken {
                write: &write,
                results: &results,
            }],
        )
        .unwrap();
        keep_receipts(&conn, &write, "batch", LATER, &results, false).unwrap();
        conn.execute("UPDATE queue SET verdict = 'accepted'", [])
            .unwrap();
        hold_copy(&conn).unwrap();
        conn.execute("DELETE FROM table_rows", []).unwrap();
        server_row(&conn, R, json!({ "count": 0 }), BEFORE);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn).first().map(|kept| kept.3.clone()),
            Some(noted(1))
        );
    }

    #[test]
    fn a_read_that_says_nothing_lets_go_only_of_the_receipts_answered_before_it() {
        use crate::scripted::{Scripted, refusal};
        let server = Scripted::start();
        let core = crate::stop_tests::copy(&server);
        let now = store::now_millis();
        {
            let conn = core.conn().unwrap();
            store::upsert_item(
                &conn,
                &store::testing::note("item", "T", "", BEFORE),
                None,
                &marfa_rules::catalog::Indexing::default(),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
                [],
            )
            .unwrap();
            for (id, answered) in [("early", now - 1_000), ("late", now + 1_000)] {
                conn.execute(
                    "INSERT INTO row_receipts (write_id, item_id, name, id, batch, at, removal, answered_at)
                     VALUES (?1, 'item', 'steps', ?1, ?1, ?2, 0, ?3)",
                    params![id, TEN, answered],
                )
                .unwrap();
            }
        }
        server.on(
            "/items/item/tables/steps/rows",
            vec![refusal(400, "validation_failed")],
        );
        let stop = AtomicBool::new(false);
        assert!(!lost(&core, core.http().unwrap(), &stop, now).unwrap());
        let left: Vec<String> = core
            .conn()
            .unwrap()
            .prepare("SELECT id FROM row_receipts")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(left, vec!["late".to_string()]);
    }

    #[test]
    fn a_row_write_to_a_table_waiting_to_be_compared_is_held_back_until_it_is() {
        use crate::scripted::{Scripted, certified, json as answer};
        let path = "/items/item/tables/steps/rows";
        // Unmarked first: the witness that the same write is sent.
        for marked in [false, true] {
            let server = Scripted::start();
            let core = crate::stop_tests::copy(&server);
            {
                let conn = core.conn().unwrap();
                store::upsert_item(
                    &conn,
                    &store::testing::note("item", "T", "", BEFORE),
                    None,
                    &marfa_rules::catalog::Indexing::default(),
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'owed')",
                    [],
                )
                .unwrap();
                if marked {
                    mark(&conn, "item", "steps", false).unwrap();
                }
                queued(&conn, "w", 1, json!([put(R, 1)]), false);
            }
            server.on(
                path,
                vec![certified(answer(
                    200,
                    &json!({
                        "batch": "019a5b1e-9c33-7e5f-8a6b-7c8d9e0f1a2b",
                        "last_activity_at": LATER,
                        "results": [{ "id": R, "outcome": "created" }],
                    })
                    .to_string(),
                ))],
            );
            let report = core.drain().unwrap();
            assert_eq!(
                server.seen(path).len(),
                usize::from(!marked),
                "marked {marked}: {report:?}"
            );
            let write = store::queued_write(&core.conn().unwrap(), "w")
                .unwrap()
                .unwrap();
            if marked {
                assert_eq!(
                    (write.verdict, write.reason.as_deref()),
                    (
                        Some(crate::model::Verdict::Blocked),
                        Some(crate::model::AWAITING_DEPENDENCY)
                    )
                );
            }
        }
    }

    #[test]
    fn a_row_is_behind_where_the_server_lacks_it_or_holds_it_earlier_or_otherwise_at_its_time() {
        let one = json!({ "count": 1 });
        let two = json!({ "count": 2 });
        let none = Value::Null;
        let held = (&one, &none, TEN);
        assert!(!behind(held, Some((&one, &none, TEN))));
        assert!(!behind(held, Some((&two, &none, LATER))));
        assert!(behind(held, None));
        assert!(behind(held, Some((&two, &none, BEFORE))));
        // Rows carry no version: at the same time only the same values are
        // the same row.
        assert!(behind(held, Some((&two, &none, TEN))));
        assert!(behind(held, Some((&one, &json!(["ref"]), TEN))));
        assert!(behind(held, Some((&one, &none, "not a time"))));
    }

    #[test]
    fn a_receipt_is_kept_for_each_row_changed_or_removed_until_its_own_event_shows_it() {
        let conn = copy();
        waiting(&conn, "write", 1, None, "a");
        let write = store::queued_write(&conn, "write").unwrap().unwrap();
        let results = [
            json!({ "id": "a", "outcome": "created" }),
            json!({ "id": "b", "outcome": "deleted" }),
            json!({ "id": "c", "outcome": "unchanged" }),
            json!({ "id": "d", "outcome": "absent" }),
        ];
        keep_receipts(&conn, &write, "batch", TEN, &results, false).unwrap();
        let receipts = |conn: &Connection| -> Vec<(String, bool, bool)> {
            conn.prepare("SELECT id, removal, seen FROM row_receipts ORDER BY id")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(
            receipts(&conn),
            vec![("a".into(), false, false), ("b".into(), true, false)]
        );
        let event: RowsEvent = serde_json::from_value(json!({
            "item": { "id": "item" },
            "table": "steps",
            "batch": "batch",
            "last_activity_at": TEN,
            "rows": [],
        }))
        .unwrap();
        seen_by(&conn, &event).unwrap();
        assert_eq!(receipts(&conn), vec![("b".into(), true, true)]);

        // A row written again lets go of its removal.
        keep_receipts(
            &conn,
            &write,
            "again",
            LATER,
            &[json!({ "id": "b", "outcome": "created" })],
            false,
        )
        .unwrap();
        assert_eq!(receipts(&conn), vec![("b".into(), false, false)]);

        // An answer that comes after its batch's event keeps no change.
        conn.execute("DELETE FROM row_receipts", []).unwrap();
        keep_receipts(&conn, &write, "late", LATER, &results, true).unwrap();
        assert_eq!(receipts(&conn), vec![("b".into(), true, true)]);
    }

    #[test]
    fn a_read_of_the_rows_that_says_nothing_sets_their_receipts_aside() {
        use crate::scripted::{Scripted, certified, json as answer, refusal};
        let cases = [
            (
                "a page of no rows",
                certified(answer(200, r#"{"data":[]}"#)),
                true,
            ),
            (
                "a page that is no rows",
                certified(answer(200, r#"{"rows":"none"}"#)),
                false,
            ),
            (
                "400 validation_failed",
                refusal(400, "validation_failed"),
                false,
            ),
        ];
        for (name, read, expected) in cases {
            let server = Scripted::start();
            let core = crate::stop_tests::copy(&server);
            {
                let conn = core.conn().unwrap();
                store::upsert_item(
                    &conn,
                    &store::testing::note("item", "T", "", BEFORE),
                    None,
                    &marfa_rules::catalog::Indexing::default(),
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
                    [],
                )
                .unwrap();
                receipt(&conn, "a", TEN, false, false);
            }
            let path = "/items/item/tables/steps/rows";
            server.on(path, vec![read]);
            let stop = AtomicBool::new(false);
            let http = core.http().unwrap();
            assert_eq!(
                lost(&core, http, &stop, i64::MAX).unwrap(),
                expected,
                "{name}"
            );
            assert_eq!(server.seen(path).len(), 1, "{name}");
            if !expected {
                assert!(!lost(&core, http, &stop, i64::MAX).unwrap(), "{name}");
                assert_eq!(server.seen(path).len(), 1, "{name} was read again");
            }
        }
    }

    #[test]
    fn a_table_filled_again_keeps_each_row_the_server_lost_and_nothing_it_holds() {
        let conn = copy();
        for (id, count) in [("same", 1), ("behind", 2), ("gone", 3), ("moved", 4)] {
            row(&conn, id, count, TEN);
        }
        receipt(&conn, "removed", TEN, true, true);
        receipt(&conn, "made-again", TEN, true, true);
        hold_copy(&conn).unwrap();

        filled(
            &conn,
            &[
                ("same", 1, TEN),
                ("behind", 0, BEFORE),
                ("moved", 5, LATER),
                ("removed", 6, BEFORE),
                ("made-again", 7, LATER),
            ],
        );
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(
            kept(&conn),
            vec![(
                "blocked".into(),
                Some("server_restored".into()),
                None,
                json!([
                    put("behind", 2),
                    put("gone", 3),
                    { "op": "delete", "id": "removed" },
                ])
            )]
        );
        let left: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM held_rows) + (SELECT COUNT(*) FROM held_tables)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn rows_set_aside_outlast_an_interrupted_fill_and_a_second_hold_and_are_kept_once_whole() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        row(&conn, "b", 2, TEN);
        hold_copy(&conn).unwrap();
        let held = |conn: &Connection| -> Vec<(String, String)> {
            conn.prepare("SELECT id, body FROM held_rows ORDER BY id")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let first = held(&conn);
        assert_eq!(first.len(), 2);

        // A fill that read one page of the server's rows, then stopped.
        filled(&conn, &[("a", 0, BEFORE)]);
        conn.execute("UPDATE item_tables SET state = 'filling'", [])
            .unwrap();
        let_go_unheld(&conn).unwrap();
        hold_copy(&conn).unwrap();
        assert_eq!(held(&conn), first);
        assert!(kept(&conn).is_empty());

        filled(&conn, &[("a", 0, BEFORE)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn)[0].3, json!([put("a", 1), put("b", 2)]));
    }

    #[test]
    fn a_table_the_server_holds_whole_keeps_nothing() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        row(&conn, "b", 2, TEN);
        hold_copy(&conn).unwrap();
        filled(&conn, &[("a", 1, TEN), ("b", 2, TEN)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert!(kept(&conn).is_empty());

        // The witness: the same table with one row lost keeps it.
        row(&conn, "c", 3, TEN);
        hold_copy(&conn).unwrap();
        filled(&conn, &[("a", 1, TEN), ("b", 2, TEN)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn).len(), 1);
    }

    #[test]
    fn a_row_this_device_wrote_since_the_rows_were_set_aside_is_kept_as_the_server_took_it() {
        let conn = copy();
        row(&conn, R, 1, TEN);
        row(&conn, "lost", 2, TEN);
        hold_copy(&conn).unwrap();
        let write = queued(&conn, "w", 1, json!([put(R, 5)]), true);
        let results = [json!({ "id": R, "outcome": "replaced" })];
        fold(&conn, &write, Some(LATER), &results).unwrap();
        conn.execute_batch("UPDATE queue SET verdict = 'accepted'; DELETE FROM rows_laid;")
            .unwrap();
        filled(&conn, &[(R, 5, LATER)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn)[0].3, json!([put("lost", 2)]));

        // The witness: the server that lost the write is put back to it.
        let conn = copy();
        row(&conn, R, 1, TEN);
        hold_copy(&conn).unwrap();
        let write = queued(&conn, "w", 1, json!([put(R, 5)]), true);
        fold(&conn, &write, Some(LATER), &results).unwrap();
        conn.execute_batch("UPDATE queue SET verdict = 'accepted'; DELETE FROM rows_laid;")
            .unwrap();
        filled(&conn, &[(R, 1, TEN)]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn)[0].3, json!([put(R, 5)]));
    }

    #[test]
    fn a_hold_of_the_unseen_rows_owes_their_table_again_so_it_is_compared() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        receipt(&conn, "a", TEN, false, false);
        hold_unseen(&conn).unwrap();
        let state: String = conn
            .query_row("SELECT state FROM item_tables", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "owed");
        filled(&conn, &[]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn)[0].3, json!([put("a", 1)]));
    }

    #[test]
    fn a_table_of_an_item_a_create_waits_for_or_past_its_cap_is_not_set_aside() {
        let conn = copy();
        row(&conn, "a", 1, TEN);
        conn.execute("UPDATE item_tables SET state = 'online'", [])
            .unwrap();
        hold_copy(&conn).unwrap();
        let held = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM held_rows", [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(held(&conn), 0);
        // The witness: the same table held whole is set aside.
        conn.execute("UPDATE item_tables SET state = 'whole'", [])
            .unwrap();
        hold_copy(&conn).unwrap();
        assert_eq!(held(&conn), 1);

        // Past the cap after the hold, it is let go at the next fill.
        conn.execute("UPDATE item_tables SET state = 'online'", [])
            .unwrap();
        let_go_unheld(&conn).unwrap();
        assert_eq!(held(&conn), 0);
    }

    #[test]
    fn kept_rows_go_ahead_of_the_writes_waiting_on_the_table_and_withdrawing_them_refuses_none() {
        let conn = copy();
        waiting(&conn, "first", 10, None, "a");
        waiting(&conn, "second", 11, Some("first"), "a");
        let ids = row_writes::keep(
            &conn,
            "item",
            "steps",
            &[Op::Put {
                id: "a".into(),
                values: json!({ "count": 1 }).as_object().unwrap().clone(),
            }],
        )
        .unwrap();
        let [kept_id] = ids.as_slice() else {
            panic!("{ids:?}")
        };
        let follows = |id: &str| -> Option<String> {
            store::queued_write(&conn, id).unwrap().unwrap().follows
        };
        assert_eq!(follows("first").as_deref(), Some(kept_id.as_str()));
        assert_eq!(follows("second").as_deref(), Some("first"));
        let laid: i64 = conn
            .query_row(
                "SELECT seq FROM rows_laid WHERE write_id = ?1",
                [kept_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(laid < 10, "laid beneath the waiting writes at {laid}");

        let kept_write = store::queued_write(&conn, kept_id).unwrap().unwrap();
        let held = store::held_for(&conn, kept_id).unwrap();
        assert!(held.is_empty(), "{held:?}");
        store::withdraw(&conn, &kept_write, &held).unwrap();
        for id in ["first", "second"] {
            let write = store::queued_write(&conn, id).unwrap().unwrap();
            assert_eq!(write.verdict, None, "{id}");
        }
    }

    /// With `MARFA_TEST_RESTORED_ROWS_BENCH` set to a row count, prints how long
    /// each step takes at that size; run it in a release build:
    ///
    /// ```sh
    /// MARFA_TEST_RESTORED_ROWS_BENCH=100000 cargo nextest run --release -p marfa-core restored_rows_bench --no-capture
    /// ```
    #[test]
    fn restored_rows_bench_times_the_comparison() {
        let rows: usize = std::env::var("MARFA_TEST_RESTORED_ROWS_BENCH")
            .ok()
            .and_then(|rows| rows.parse().ok())
            .unwrap_or(1_000);
        let conn = copy();
        let tx = conn.unchecked_transaction().unwrap();
        for at in 0..rows {
            row(&tx, &format!("row-{at:06}"), at as i64, TEN);
        }
        tx.commit().unwrap();
        let timed = |label: &str, step: &dyn Fn(&Connection)| {
            let tx = conn.unchecked_transaction().unwrap();
            let started = std::time::Instant::now();
            step(&tx);
            let took = started.elapsed();
            tx.commit().unwrap();
            println!(
                "{rows:>7} rows  {label:<52} {:>9.1} ms",
                took.as_secs_f64() * 1000.0
            );
        };
        timed("lay the queue and judge the cap", &|tx| {
            row_writes::lay_table(tx, "item", "steps").unwrap();
            crate::tables::past_cap(tx, "item", "steps").unwrap();
        });
        timed("compare, nothing set aside", &|tx| {
            keep_lost(tx, "item", "steps").unwrap();
        });
        timed("set aside every row", &|tx| hold_copy(tx).unwrap());
        timed("compare every row, the server holds them all", &|tx| {
            keep_lost(tx, "item", "steps").unwrap();
        });
        assert!(kept(&conn).is_empty());
        hold_copy(&conn).unwrap();
        conn.execute("DELETE FROM table_rows", []).unwrap();
        timed("compare every row, the server holds none", &|tx| {
            keep_lost(tx, "item", "steps").unwrap();
        });
        assert_eq!(
            kept(&conn).len(),
            rows.div_ceil(marfa_rules::rows::MAX_OPERATIONS)
        );
    }

    #[test]
    fn kept_rows_beyond_one_request_are_split_in_order() {
        let conn = copy();
        let most = marfa_rules::rows::MAX_OPERATIONS;
        let ops: Vec<Op> = (0..=most)
            .map(|at| Op::Delete {
                id: format!("row-{at:05}"),
            })
            .collect();
        let ids = row_writes::keep(&conn, "item", "steps", &ops).unwrap();
        assert_eq!(ids.len(), 2);
        let written = kept(&conn);
        assert_eq!(written[0].3.as_array().unwrap().len(), most);
        assert_eq!(written[1].2.as_deref(), Some(ids[0].as_str()));
    }

    #[test]
    fn kept_rows_take_the_places_in_the_queue_of_the_unsent_row_writes_to_their_table() {
        let conn = copy();
        waiting(&conn, "first", 1, None, "a");
        waiting(&conn, "second", 2, Some("first"), "a");
        let ids =
            row_writes::keep(&conn, "item", "steps", &[Op::Delete { id: "b".into() }]).unwrap();
        let order: Vec<(String, Option<String>)> = conn
            .prepare("SELECT id, follows FROM queue ORDER BY seq")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            order,
            vec![
                (ids[0].clone(), None),
                ("first".into(), Some(ids[0].clone())),
                ("second".into(), Some("first".into())),
            ]
        );
    }

    #[test]
    fn an_unsent_row_write_waits_while_its_table_is_set_aside_and_not_yet_compared() {
        let conn = copy();
        waiting(&conn, "w", 1, None, "a");
        let holds = |conn: &Connection| {
            let write = store::queued_write(conn, "w").unwrap().unwrap();
            holds_back(conn, &write).unwrap()
        };
        assert!(!holds(&conn), "a table not set aside holds nothing back");
        mark(&conn, "item", "steps", false).unwrap();
        assert!(holds(&conn));
        // After a hydration clears the copy, before a fill lists the table.
        conn.execute("DELETE FROM item_tables", []).unwrap();
        assert!(holds(&conn));
        conn.execute(
            "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'online')",
            [],
        )
        .unwrap();
        assert!(!holds(&conn), "a table held past its cap is never compared");
        conn.execute("UPDATE item_tables SET state = 'filling'", [])
            .unwrap();
        assert!(holds(&conn));
        conn.execute("UPDATE queue SET sent = 1", []).unwrap();
        assert!(!holds(&conn), "a sent write is laid on the rows instead");
    }
}
