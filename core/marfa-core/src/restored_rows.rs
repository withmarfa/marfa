//! Table rows a server restored to an earlier point has lost: the receipts of
//! the row writes it took, the rows set aside with the copy, and the writes
//! that put back what it lacks once a table is filled whole again
//! (`device/expire-rows-lost` and `device/restored-rows-kept`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::http::Http;
use crate::model::QueuedWrite;
use crate::row_writes::{self, Op};
use crate::store::{self, Cached, restored::RECEIPTS_KEPT_MILLIS};
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
/// server's time `at`. A change lets go of a removal of the same row kept
/// before it, and is not kept where the batch's event came first.
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
        if !removal {
            conn.prepare_cached(
                "DELETE FROM row_receipts
                  WHERE item_id = ?1 AND name = ?2 AND id = ?3 AND removal = 1",
            )?
            .execute(params![item, table, id])?;
            if seen {
                continue;
            }
        }
        conn.prepare_cached(
            "INSERT INTO row_receipts
               (write_id, item_id, name, id, batch, at, removal, answered_at, seen, held)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
             ON CONFLICT (write_id, id) DO UPDATE SET
               batch = excluded.batch, at = excluded.at, removal = excluded.removal,
               answered_at = excluded.answered_at, seen = excluded.seen, held = 0",
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
/// is let go, and a removal kept as seen.
pub(crate) fn seen_by(conn: &Connection, batch: &str) -> Result<()> {
    conn.prepare_cached("DELETE FROM row_receipts WHERE batch = ?1 AND removal = 0")?
        .execute([batch])?;
    conn.prepare_cached("UPDATE row_receipts SET seen = 1 WHERE batch = ?1 AND removal = 1")?
        .execute([batch])?;
    Ok(())
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
            conn.prepare_cached("DELETE FROM row_receipts WHERE item_id = ?1 AND name = ?2")?
                .execute(params![item, table])?;
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

/// Marks the table for comparison. The first mark also marks every receipt
/// of the table answered so far as answered before it.
fn mark(conn: &Connection, item: &str, table: &str) -> Result<()> {
    let first = conn
        .prepare_cached("INSERT OR IGNORE INTO held_tables (item_id, name) VALUES (?1, ?2)")?
        .execute(params![item, table])?
        > 0;
    if first {
        conn.prepare_cached("UPDATE row_receipts SET held = 1 WHERE item_id = ?1 AND name = ?2")?
            .execute(params![item, table])?;
    }
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
        mark(conn, &item, &table)?;
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

/// `hold_copy` for the rows the receipts no event has shown name, before a
/// hydration of the same instance for another reason
/// (`device/restored-checked-before-clear`). Each table they name is owed
/// again, so a hydration in place still fills it from the server.
pub(crate) fn hold_unseen(conn: &Connection) -> Result<()> {
    let named: Vec<(String, String, String, bool)> = conn
        .prepare(
            "SELECT DISTINCT item_id, name, id, removal FROM row_receipts
              WHERE seen = 0 AND answered_at >= ?1",
        )?
        .query_map([floor()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut owed = BTreeSet::new();
    for (item, table, id, removal) in named {
        let Some(rows) = holdable(conn, &item, &table)? else {
            continue;
        };
        mark(conn, &item, &table)?;
        if rows && !removal {
            hold_row(conn, &item, &table, &id)?;
        }
        owed.insert((item, table));
    }
    for (item, table) in owed {
        crate::tables::owe_table(conn, &item, &table)?;
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
/// removal (`device/restored-rows-kept`). Nothing is kept of a row this
/// device wrote since the rows were set aside.
pub(crate) fn keep_lost(conn: &Connection, item: &str, table: &str) -> Result<()> {
    let marked = conn
        .query_row_cached(
            "SELECT 1 FROM held_tables WHERE item_id = ?1 AND name = ?2",
            params![item, table],
            |_| Ok(()),
        )
        .optional()?;
    if marked.is_none() {
        return Ok(());
    }
    // Written since by this device, and taken.
    let since = "EXISTS (SELECT 1 FROM row_receipts s
                          WHERE s.item_id = ?1 AND s.name = ?2 AND s.id = {row} AND s.held = 0)";
    let mut ops = Vec::new();
    let mut set_aside: HashSet<String> = HashSet::new();
    {
        let mut query = conn.prepare_cached(&format!(
            "SELECT h.id, h.body, h.withheld, h.updated_at, r.body, r.withheld, r.updated_at,
                    {}
               FROM held_rows h
               LEFT JOIN table_rows r ON r.item_id = h.item_id AND r.name = h.name AND r.id = h.id
              WHERE h.item_id = ?1 AND h.name = ?2
              ORDER BY h.id",
            since.replace("{row}", "h.id")
        ))?;
        let rows = query.query_map(params![item, table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })?;
        for row in rows {
            let (id, body, withheld, at, server, server_withheld, server_at, written) = row?;
            set_aside.insert(id.clone());
            if written {
                continue;
            }
            let values = parsed(Some(&body));
            let held = (&values, &parsed(withheld.as_deref()), at.as_str());
            let server_values = parsed(server.as_deref());
            let server_withheld = parsed(server_withheld.as_deref());
            let server = server_at
                .as_deref()
                .filter(|_| server.is_some())
                .map(|at| (&server_values, &server_withheld, at));
            if behind(held, server) {
                let Value::Object(values) = values else {
                    continue;
                };
                ops.push(Op::Put { id, values });
            }
        }
    }
    {
        let mut query = conn.prepare_cached(&format!(
            "SELECT k.id, MAX(k.at), r.updated_at FROM row_receipts k
               JOIN table_rows r ON r.item_id = k.item_id AND r.name = k.name AND r.id = k.id
              WHERE k.item_id = ?1 AND k.name = ?2 AND k.removal = 1 AND k.held = 1
                AND k.answered_at >= ?3 AND NOT ({})
              GROUP BY k.id
              ORDER BY k.id",
            since.replace("{row}", "k.id")
        ))?;
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
        seen_by(&conn, "batch").unwrap();
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
    fn a_row_this_device_wrote_since_the_rows_were_set_aside_is_not_kept() {
        let conn = copy();
        row(&conn, "written", 1, TEN);
        row(&conn, "lost", 2, TEN);
        hold_copy(&conn).unwrap();
        receipt(&conn, "written", LATER, false, false);
        filled(&conn, &[]);
        keep_lost(&conn, "item", "steps").unwrap();
        assert_eq!(kept(&conn)[0].3, json!([put("lost", 2)]));
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

    /// With `MARFA_RESTORED_ROWS_BENCH` set to a row count, prints how long
    /// each step takes at that size; run it in a release build:
    ///
    /// ```sh
    /// MARFA_RESTORED_ROWS_BENCH=100000 cargo nextest run --release -p marfa-core restored_rows_bench --no-capture
    /// ```
    #[test]
    fn restored_rows_bench_times_the_comparison() {
        let rows: usize = std::env::var("MARFA_RESTORED_ROWS_BENCH")
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
}
