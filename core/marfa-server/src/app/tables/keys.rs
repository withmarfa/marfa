//! Sort keys for table columns requested by readers.

use rusqlite::types::Value as Bound;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value};

use super::sort_key::Sorted;
use crate::app::items::sort_keys;
pub(crate) use crate::app::items::sort_keys::Standing;
use crate::app::refusal::{Refusal, Result};

/// Small tables avoid the write cost of keeping sort keys.
pub(super) const MIN_ROWS: i64 = sort_keys::MIN_ITEMS;

/// Each pair adds a key per row and work on every write to its table.
pub(super) const MAX_PAIRS: i64 = sort_keys::MAX_PAIRS;

/// The declared order already has an index, and item references have no sort value.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Keyed(Vec<Sorted>);

impl Keyed {
    pub(crate) fn of(columns: &Map<String, Value>, order: Option<&Sorted>) -> Keyed {
        let mut keyed: Vec<Sorted> = columns
            .iter()
            .filter(|(name, _)| marfa_rules::schema::order_column_inlinable(name))
            .filter(|(name, _)| order.is_none_or(|order| &order.column != *name))
            .filter_map(|(name, definition)| {
                let kind = definition.get("type").and_then(Value::as_str)?;
                (kind != marfa_rules::schema::ITEM_KIND).then(|| Sorted {
                    column: name.clone(),
                    kind: kind.to_string(),
                })
            })
            .collect();
        keyed.sort_by(|a, b| a.column.cmp(&b.column));
        Keyed(keyed)
    }

    pub(crate) fn holds(&self, sorted: &Sorted) -> bool {
        self.0.contains(sorted)
    }
}

pub(super) fn kept(tx: &Transaction<'_>, table: i64) -> Result<Vec<Sorted>> {
    Ok(tx
        .prepare_cached("SELECT name, kind FROM table_sort_indexes WHERE table_seq = ?1")?
        .query_map([table], |row| {
            Ok(Sorted {
                column: row.get(0)?,
                kind: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub(super) fn standing(tx: &Transaction<'_>, table: i64, sorted: &Sorted) -> Result<Standing> {
    let held: Option<(String, bool)> = tx
        .prepare_cached(
            "SELECT kind, ready FROM table_sort_indexes WHERE table_seq = ?1 AND name = ?2",
        )?
        .query_row(params![table, sorted.column], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    Ok(match held {
        None => Standing::Absent,
        Some((kind, true)) if kind == sorted.kind => Standing::Ready,
        Some(_) => Standing::Filling,
    })
}

fn large(tx: &Transaction<'_>, table: i64) -> Result<bool> {
    let rows: Option<i64> = tx
        .prepare_cached("SELECT row_count FROM table_summaries WHERE seq = ?1")?
        .query_row([table], |row| row.get(0))
        .optional()?;
    Ok(rows.is_some_and(|rows| rows >= MIN_ROWS))
}

fn dropping(tx: &Transaction<'_>, table: i64, column: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM table_sort_indexes_dropping \
             WHERE table_seq = ?1 AND name = ?2)",
        )?
        .query_row(params![table, column], |row| row.get(0))?)
}

fn room(tx: &Transaction<'_>) -> Result<bool> {
    let held: i64 = tx
        .prepare_cached("SELECT count(*) FROM table_sort_indexes")?
        .query_row([], |row| row.get(0))?;
    Ok(held < MAX_PAIRS)
}

pub(super) fn addable(tx: &Transaction<'_>, table: i64, sorted: &Sorted) -> Result<bool> {
    Ok(large(tx, table)? && !dropping(tx, table, &sorted.column)? && room(tx)?)
}

/// Recheck the table in the writer's transaction because its definition may have changed.
pub(super) fn add(
    tx: &Transaction<'_>,
    table: i64,
    keyed: &Keyed,
    sorted: &Sorted,
) -> Result<bool> {
    if !keyed.holds(sorted) || standing(tx, table, sorted)? != Standing::Absent {
        return Ok(false);
    }
    if !addable(tx, table, sorted)? {
        return Ok(false);
    }
    tx.prepare_cached(
        "INSERT INTO table_sort_indexes (table_seq, name, kind) VALUES (?1, ?2, ?3)",
    )?
    .execute(params![table, sorted.column, sorted.kind])?;
    Ok(true)
}

/// Readers stop using a dropped pair before cleanup starts removing its keys.
pub(super) fn drop_unkept(tx: &Transaction<'_>, table: i64, keyed: &Keyed) -> Result<bool> {
    let mut dropped = false;
    for sorted in kept(tx, table)? {
        if keyed.holds(&sorted) {
            continue;
        }
        tx.prepare_cached("DELETE FROM table_sort_indexes WHERE table_seq = ?1 AND name = ?2")?
            .execute(params![table, sorted.column])?;
        tx.prepare_cached(
            "INSERT OR IGNORE INTO table_sort_indexes_dropping (table_seq, name) VALUES (?1, ?2)",
        )?
        .execute(params![table, sorted.column])?;
        dropped = true;
    }
    Ok(dropped)
}

pub(super) struct Keeping {
    pub table_seq: i64,
    pub table: String,
}

fn keepings(tx: &Transaction<'_>, filter: &str, key: &dyn rusqlite::ToSql) -> Result<Vec<Keeping>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT s.seq, s.table_name FROM table_summaries s WHERE {filter} \
         AND EXISTS (SELECT 1 FROM table_sort_indexes k WHERE k.table_seq = s.seq)"
    ))?;
    let found = statement.query_map([key], |row| {
        Ok(Keeping {
            table_seq: row.get(0)?,
            table: row.get(1)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn keepings_of_item(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Keeping>> {
    keepings(tx, "s.item_seq = ?1", &seq)
}

pub(super) fn keepings_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<Keeping>> {
    keepings(
        tx,
        "s.item_seq IN (SELECT seq FROM items WHERE type = ?1)",
        &type_id,
    )
}

/// Stops keeping every pair of a purged item's tables, whose keys go with its rows.
pub(super) fn forget_tables_of(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    for kept in ["table_sort_indexes", "table_sort_indexes_dropping"] {
        tx.prepare_cached(&format!(
            "DELETE FROM {kept} WHERE table_seq IN \
             (SELECT seq FROM table_summaries WHERE item_seq = ?1)"
        ))?
        .execute([seq])?;
    }
    Ok(())
}

pub(super) fn keep(tx: &Transaction<'_>, table: i64, id: &str, kept: &[Sorted]) -> Result<()> {
    if kept.is_empty() {
        return Ok(());
    }
    let mut held: Vec<(String, Bound)> = tx
        .prepare_cached("SELECT name, key FROM table_row_keys WHERE table_seq = ?1 AND id = ?2")?
        .query_map(params![table, id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let keys: Vec<String> = kept
        .iter()
        .map(|sorted| sorted.stored_key_sql("body", "refs"))
        .collect();
    let wanted: Vec<Bound> = tx
        .prepare_cached(&format!(
            "SELECT {} FROM table_rows WHERE table_seq = ?1 AND id = ?2",
            keys.join(", ")
        ))?
        .query_row(params![table, id], |row| {
            (0..kept.len()).map(|at| row.get(at)).collect()
        })
        .optional()?
        .ok_or_else(|| Refusal::internal("a written row did not read"))?;
    let mut inserted = Vec::new();
    for (sorted, key) in kept.iter().zip(wanted) {
        match held.iter().position(|(name, _)| *name == sorted.column) {
            Some(at) if held[at].1 == key => {
                held.swap_remove(at);
            }
            _ => inserted.push((&sorted.column, key)),
        }
    }
    // SQLite's key equals 1 and 1.0 where Rust does not, so the old key goes first.
    let mut delete = tx.prepare_cached(
        "DELETE FROM table_row_keys WHERE table_seq = ?1 AND name = ?2 AND key = ?3 AND id = ?4",
    )?;
    for (name, key) in held {
        delete.execute(params![table, name, key, id])?;
    }
    let mut insert = tx.prepare_cached(
        "INSERT INTO table_row_keys (table_seq, name, key, id) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (name, key) in inserted {
        insert.execute(params![table, name, key, id])?;
    }
    Ok(())
}

/// Cleanup owns any remaining keys of dropped pairs.
pub(super) fn forget(tx: &Transaction<'_>, table: i64, id: &str, kept: &[Sorted]) -> Result<()> {
    if kept.is_empty() {
        return Ok(());
    }
    tx.prepare_cached("DELETE FROM table_row_keys WHERE table_seq = ?1 AND id = ?2")?
        .execute(params![table, id])?;
    Ok(())
}

pub(super) fn remove_keys(tx: &Transaction<'_>, table: i64, limit: i64) -> Result<i64> {
    Ok(tx
        .prepare_cached(
            "DELETE FROM table_row_keys WHERE (table_seq, name, key, id) IN \
             (SELECT table_seq, name, key, id FROM table_row_keys WHERE table_seq = ?1 LIMIT ?2)",
        )?
        .execute(params![table, limit])? as i64)
}

pub(super) enum Filled {
    Removed(i64),
    Keyed(i64),
}

fn drop_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<i64>> {
    let pair: Option<(i64, String)> = tx
        .prepare_cached("SELECT table_seq, name FROM table_sort_indexes_dropping LIMIT 1")?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((table, name)) = pair else {
        return Ok(None);
    };
    let removed = tx
        .prepare_cached(
            "DELETE FROM table_row_keys WHERE (table_seq, name, key, id) IN \
             (SELECT table_seq, name, key, id FROM table_row_keys \
             WHERE table_seq = ?1 AND name = ?2 LIMIT ?3)",
        )?
        .execute(params![table, name, limit])? as i64;
    if removed < limit {
        tx.prepare_cached(
            "DELETE FROM table_sort_indexes_dropping WHERE table_seq = ?1 AND name = ?2",
        )?
        .execute(params![table, name])?;
    }
    Ok(Some(removed))
}

/// Writes may already have keyed rows ahead of the fill cursor.
pub(super) fn fill_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<Filled>> {
    if let Some(removed) = drop_page(tx, limit)? {
        return Ok(Some(Filled::Removed(removed)));
    }
    let pair: Option<(i64, String, String, String)> = tx
        .prepare_cached(
            "SELECT table_seq, name, kind, filled_after FROM table_sort_indexes \
             WHERE ready = 0 LIMIT 1",
        )?
        .query_row([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .optional()?;
    let Some((table, column, kind, after)) = pair else {
        return Ok(None);
    };
    let (taken, last): (i64, Option<String>) = tx
        .prepare_cached(
            "SELECT count(*), max(id) FROM (SELECT id FROM table_rows \
             WHERE table_seq = ?1 AND id > ?2 ORDER BY id LIMIT ?3)",
        )?
        .query_row(params![table, after, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    if let Some(through) = &last {
        let sorted = Sorted { column, kind };
        let keyed = tx
            .prepare_cached(&format!(
                "INSERT OR IGNORE INTO table_row_keys (table_seq, name, key, id) \
                 SELECT ?1, ?4, {}, id FROM table_rows WHERE table_seq = ?1 AND id > ?2 AND id <= ?3",
                sorted.stored_key_sql("body", "refs")
            ))?
            .execute(params![table, after, through, sorted.column])? as i64;
        tx.prepare_cached(
            "UPDATE table_sort_indexes SET filled_after = ?3 WHERE table_seq = ?1 AND name = ?2",
        )?
        .execute(params![table, sorted.column, through])?;
        if taken == limit {
            return Ok(Some(Filled::Keyed(keyed)));
        }
        return ready(tx, table, &sorted.column).map(|()| Some(Filled::Keyed(keyed)));
    }
    ready(tx, table, &column).map(|()| Some(Filled::Keyed(0)))
}

fn ready(tx: &Transaction<'_>, table: i64, column: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE table_sort_indexes SET ready = 1 WHERE table_seq = ?1 AND name = ?2",
    )?
    .execute(params![table, column])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::*;

    fn db(tables: &[(i64, i64)]) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        for &(seq, rows) in tables {
            db.execute(
                "INSERT INTO table_summaries (seq, item_seq, table_name, row_count, bytes, \
                 last_batch, changed_at) VALUES (?1, ?1, 'lines', ?2, 0, '', '')",
                params![seq, rows],
            )
            .unwrap();
            db.execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) \
                 INSERT INTO table_rows (table_seq, id, updated_at, batch, body) \
                 SELECT ?1, printf('%06d', i), '', 0, jsonb(json_object('a', ?2 - i)) FROM n",
                params![seq, rows],
            )
            .unwrap();
        }
        db
    }

    fn a(kind: &str) -> Sorted {
        Sorted {
            column: "a".into(),
            kind: kind.into(),
        }
    }

    fn keyed(kind: &str) -> Keyed {
        Keyed::of(
            json!({ "a": { "type": kind }, "who": { "type": "item" } })
                .as_object()
                .unwrap(),
            None,
        )
    }

    fn count(tx: &Transaction<'_>, sql: &str) -> i64 {
        tx.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn drain(tx: &Transaction<'_>, limit: i64) -> Vec<i64> {
        let mut pages = Vec::new();
        while let Some(page) = fill_page(tx, limit).unwrap() {
            pages.push(match page {
                Filled::Removed(keys) => -keys,
                Filled::Keyed(rows) => rows,
            });
        }
        pages
    }

    #[test]
    fn only_a_declared_column_of_a_large_table_gains_a_pair() {
        let mut db = db(&[(1, MIN_ROWS), (2, MIN_ROWS - 1)]);
        let tx = db.transaction().unwrap();
        let number = keyed("number");
        let who = Sorted {
            column: "who".into(),
            kind: "item".into(),
        };
        assert!(!number.holds(&who));
        assert!(!add(&tx, 1, &number, &who).unwrap());
        assert!(!add(&tx, 1, &number, &a("string")).unwrap());
        assert!(!add(&tx, 2, &number, &a("number")).unwrap());
        assert!(!add(&tx, 3, &number, &a("number")).unwrap());
        assert!(add(&tx, 1, &number, &a("number")).unwrap());
        assert!(!add(&tx, 1, &number, &a("number")).unwrap());
        assert_eq!(standing(&tx, 1, &a("number")).unwrap(), Standing::Filling);
    }

    #[test]
    fn the_cap_holds_across_tables() {
        let mut db = db(&[]);
        let tx = db.transaction().unwrap();
        for seq in 1..=MAX_PAIRS + 1 {
            tx.execute(
                "INSERT INTO table_summaries (seq, item_seq, table_name, row_count, bytes, \
                 last_batch, changed_at) VALUES (?1, ?1, 'lines', ?2, 0, '', '')",
                params![seq, MIN_ROWS],
            )
            .unwrap();
        }
        for seq in 1..=MAX_PAIRS {
            assert!(add(&tx, seq, &keyed("number"), &a("number")).unwrap());
        }
        assert!(!add(&tx, MAX_PAIRS + 1, &keyed("number"), &a("number")).unwrap());
        assert!(drop_unkept(&tx, 1, &Keyed::default()).unwrap());
        assert!(add(&tx, MAX_PAIRS + 1, &keyed("number"), &a("number")).unwrap());
    }

    #[test]
    fn the_walk_keys_every_row_once_in_bounded_pages_beside_the_rows_writes_keyed() {
        let rows = 2_505;
        let mut db = db(&[(1, rows)]);
        let tx = db.transaction().unwrap();
        tx.execute(
            "UPDATE table_summaries SET row_count = ?1 WHERE seq = 1",
            [MIN_ROWS],
        )
        .unwrap();
        assert!(add(&tx, 1, &keyed("number"), &a("number")).unwrap());
        let kept = kept(&tx, 1).unwrap();
        assert!(fill_page(&tx, 1_000).unwrap().is_some());
        // A write behind the walk and one ahead of it, as `Batch` keys them.
        for id in ["000010", "002000"] {
            tx.execute(
                "UPDATE table_rows SET body = jsonb('{\"a\": -1}') WHERE table_seq = 1 AND id = ?1",
                [id],
            )
            .unwrap();
            keep(&tx, 1, id, &kept).unwrap();
        }
        tx.execute(
            "DELETE FROM table_rows WHERE table_seq = 1 AND id = '002001'",
            [],
        )
        .unwrap();
        forget(&tx, 1, "002001", &kept).unwrap();
        // Pages report the keys they wrote: `002000` was keyed by its own write.
        assert_eq!(drain(&tx, 1_000), [999, 504]);
        assert_eq!(standing(&tx, 1, &a("number")).unwrap(), Standing::Ready);
        assert_eq!(count(&tx, "SELECT count(*) FROM table_row_keys"), rows - 1);
        let wrong = count(
            &tx,
            "SELECT count(*) FROM table_row_keys k JOIN table_rows r USING (table_seq, id) \
             WHERE k.key IS NOT json_extract(r.body, '$.a')",
        );
        assert_eq!(wrong, 0);
    }

    #[test]
    fn a_retyped_or_removed_column_drops_its_pair_and_its_keys_in_pages() {
        let mut db = db(&[(1, MIN_ROWS), (2, MIN_ROWS)]);
        let tx = db.transaction().unwrap();
        assert!(add(&tx, 1, &keyed("number"), &a("number")).unwrap());
        assert!(add(&tx, 2, &keyed("number"), &a("number")).unwrap());
        drain(&tx, 5_000);
        assert_eq!(
            count(&tx, "SELECT count(*) FROM table_row_keys"),
            2 * MIN_ROWS
        );

        assert!(!drop_unkept(&tx, 1, &keyed("number")).unwrap());
        assert!(drop_unkept(&tx, 1, &keyed("string")).unwrap());
        assert_eq!(standing(&tx, 1, &a("string")).unwrap(), Standing::Absent);
        assert!(!add(&tx, 1, &keyed("string"), &a("string")).unwrap());
        assert_eq!(drain(&tx, 5_000), [-5_000, -5_000, -5_000, -5_000, 0]);
        assert_eq!(
            count(
                &tx,
                "SELECT count(*) FROM table_row_keys WHERE table_seq = 1"
            ),
            0
        );
        assert_eq!(
            count(
                &tx,
                "SELECT count(*) FROM table_row_keys WHERE table_seq = 2"
            ),
            MIN_ROWS
        );
        assert!(add(&tx, 1, &keyed("string"), &a("string")).unwrap());
    }

    #[test]
    fn a_key_sqlite_holds_equal_to_the_old_one_replaces_it() {
        let mut db = db(&[(1, MIN_ROWS)]);
        let tx = db.transaction().unwrap();
        assert!(add(&tx, 1, &keyed("number"), &a("number")).unwrap());
        drain(&tx, 5_000);
        let kept = kept(&tx, 1).unwrap();
        let id = format!("{:06}", MIN_ROWS - 1);
        for body in ["{\"a\": 1.0}", "{\"a\": 1}", "{\"a\": -0.5}"] {
            tx.execute(
                "UPDATE table_rows SET body = jsonb(?2) WHERE table_seq = 1 AND id = ?1",
                params![id, body],
            )
            .unwrap();
            keep(&tx, 1, &id, &kept).unwrap();
            let held: Vec<Bound> = tx
                .prepare("SELECT key FROM table_row_keys WHERE table_seq = 1 AND id = ?1")
                .unwrap()
                .query_map([&id], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let wanted: Bound = tx
                .query_row("SELECT json_extract(jsonb(?1), '$.a')", [body], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(held, [wanted], "{body}");
        }
        let first: String = tx
            .query_row(
                "SELECT id FROM table_row_keys WHERE table_seq = 1 ORDER BY key, id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first, id);
    }

    #[test]
    fn a_table_that_shrinks_keeps_its_pair_and_its_keys_true() {
        let mut db = db(&[(1, MIN_ROWS)]);
        let tx = db.transaction().unwrap();
        assert!(add(&tx, 1, &keyed("number"), &a("number")).unwrap());
        drain(&tx, 5_000);
        let kept = kept(&tx, 1).unwrap();
        for n in 1..=10 {
            let id = format!("{n:06}");
            tx.execute(
                "DELETE FROM table_rows WHERE table_seq = 1 AND id = ?1",
                [&id],
            )
            .unwrap();
            forget(&tx, 1, &id, &kept).unwrap();
        }
        tx.execute(
            "UPDATE table_summaries SET row_count = row_count - 10 WHERE seq = 1",
            [],
        )
        .unwrap();
        assert_eq!(standing(&tx, 1, &a("number")).unwrap(), Standing::Ready);
        assert_eq!(
            count(&tx, "SELECT count(*) FROM table_row_keys"),
            MIN_ROWS - 10
        );
    }
}
