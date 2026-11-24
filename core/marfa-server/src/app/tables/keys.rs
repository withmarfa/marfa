//! `table_row_keys`: each row's sort key by each column but `order`, kept by every row write.

use rusqlite::types::Value as Bound;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value};

use super::sort_key::Sorted;
use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Keyed(Vec<Sorted>);

impl Keyed {
    /// Every column but `order` and the `item` columns, whose values all sort as none.
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

    pub(crate) fn signature(&self) -> String {
        self.0
            .iter()
            .map(Sorted::signature)
            .collect::<Vec<_>>()
            .join(",")
    }

    pub(crate) fn holds(&self, column: &str) -> bool {
        self.0.iter().any(|sorted| sorted.column == column)
    }

    fn width(&self) -> i64 {
        self.0.len().max(1) as i64
    }
}

/// The rows one page of a rebuild takes, so it writes about `limit` keys.
pub(super) fn rows_per_page(keyed: &Keyed, limit: i64) -> i64 {
    (limit / keyed.width()).max(1)
}

pub(super) fn cost(keyed: &Keyed, rows: i64) -> i64 {
    rows.saturating_mul(keyed.width())
}

pub(super) fn keep(tx: &Transaction<'_>, table: i64, id: &str, keyed: &Keyed) -> Result<()> {
    let mut held: Vec<(String, Bound)> = tx
        .prepare_cached("SELECT name, key FROM table_row_keys WHERE table_seq = ?1 AND id = ?2")?
        .query_map(params![table, id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let wanted: Vec<Bound> = match keyed.0.is_empty() {
        true => Vec::new(),
        false => {
            let keys: Vec<String> = keyed
                .0
                .iter()
                .map(|sorted| sorted.stored_key_sql("body", "refs"))
                .collect();
            tx.prepare_cached(&format!(
                "SELECT {} FROM table_rows WHERE table_seq = ?1 AND id = ?2",
                keys.join(", ")
            ))?
            .query_row(params![table, id], |row| {
                (0..keyed.0.len()).map(|at| row.get(at)).collect()
            })
            .optional()?
            .ok_or_else(|| Refusal::internal("a written row did not read"))?
        }
    };
    let mut insert = tx.prepare_cached(
        "INSERT INTO table_row_keys (table_seq, name, key, id) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (sorted, key) in keyed.0.iter().zip(wanted) {
        match held.iter().position(|(name, _)| *name == sorted.column) {
            Some(at) if held[at].1 == key => {
                held.swap_remove(at);
            }
            _ => {
                insert.execute(params![table, sorted.column, key, id])?;
            }
        }
    }
    let mut delete = tx.prepare_cached(
        "DELETE FROM table_row_keys WHERE table_seq = ?1 AND name = ?2 AND key = ?3 AND id = ?4",
    )?;
    for (name, key) in held {
        delete.execute(params![table, name, key, id])?;
    }
    Ok(())
}

pub(super) fn forget(tx: &Transaction<'_>, table: i64, id: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM table_row_keys WHERE table_seq = ?1 AND id = ?2")?
        .execute(params![table, id])?;
    Ok(())
}

pub(super) struct Keying {
    pub table_seq: i64,
    pub table: String,
    pub row_count: i64,
    pub keyed_by: Option<String>,
    pub rebuilding: bool,
}

fn keyings(tx: &Transaction<'_>, filter: &str, key: &dyn rusqlite::ToSql) -> Result<Vec<Keying>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT s.seq, s.table_name, s.row_count, s.keyed_by, q.table_seq IS NOT NULL \
         FROM table_summaries s LEFT JOIN table_rows_rekeying q ON q.table_seq = s.seq \
         WHERE {filter}"
    ))?;
    let found = statement.query_map([key], |row| {
        Ok(Keying {
            table_seq: row.get(0)?,
            table: row.get(1)?,
            row_count: row.get(2)?,
            keyed_by: row.get(3)?,
            rebuilding: row.get(4)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn keyings_of_item(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Keying>> {
    keyings(tx, "s.item_seq = ?1", &seq)
}

pub(super) fn keyings_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<Keying>> {
    keyings(
        tx,
        "s.item_seq IN (SELECT seq FROM items WHERE type = ?1)",
        &type_id,
    )
}

/// None while a rebuild is under way.
pub(super) fn keyed_by(tx: &Transaction<'_>, table: i64) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT keyed_by FROM table_summaries WHERE seq = ?1")?
        .query_row([table], |row| row.get(0))
        .optional()?
        .flatten())
}

fn rekey_rows(
    tx: &Transaction<'_>,
    table: i64,
    keyed: &Keyed,
    after: &str,
    limit: i64,
) -> Result<(i64, Option<String>)> {
    let (taken, last): (i64, Option<String>) = tx
        .prepare_cached(
            "SELECT count(*), max(id) FROM (SELECT id FROM table_rows \
             WHERE table_seq = ?1 AND id > ?2 ORDER BY id LIMIT ?3)",
        )?
        .query_row(params![table, after, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let Some(through) = last.clone() else {
        return Ok((0, None));
    };
    tx.prepare_cached("DELETE FROM table_row_keys WHERE table_seq = ?1 AND id > ?2 AND id <= ?3")?
        .execute(params![table, after, through])?;
    for sorted in &keyed.0 {
        tx.prepare_cached(&format!(
            "INSERT INTO table_row_keys (table_seq, name, key, id) \
             SELECT ?1, ?4, {}, id FROM table_rows WHERE table_seq = ?1 AND id > ?2 AND id <= ?3",
            sorted.stored_key_sql("body", "refs")
        ))?
        .execute(params![table, after, through, sorted.column])?;
    }
    Ok((taken, last))
}

fn settled_as(tx: &Transaction<'_>, table: i64, signature: Option<&str>) -> Result<()> {
    tx.prepare_cached("UPDATE table_summaries SET keyed_by = ?2 WHERE seq = ?1")?
        .execute(params![table, signature])?;
    Ok(())
}

pub(super) fn rekey_whole(tx: &Transaction<'_>, table: i64, keyed: &Keyed) -> Result<()> {
    let page = rows_per_page(keyed, super::lifecycle::CLEANUP_PAGE);
    let mut after = String::new();
    loop {
        let (taken, last) = rekey_rows(tx, table, keyed, &after, page)?;
        match last {
            Some(last) if taken == page => after = last,
            _ => break,
        }
    }
    tx.prepare_cached("DELETE FROM table_rows_rekeying WHERE table_seq = ?1")?
        .execute([table])?;
    settled_as(tx, table, Some(&keyed.signature()))
}

/// Sorted reads scan until `table-row-cleanup` has rebuilt the keys.
pub(super) fn rekey_later(tx: &Transaction<'_>, table: i64) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_rows_rekeying (table_seq, after_id) VALUES (?1, NULL) \
         ON CONFLICT (table_seq) DO UPDATE SET after_id = NULL",
    )?
    .execute([table])?;
    settled_as(tx, table, None)
}

pub(super) struct Rekeying {
    pub table_seq: i64,
    pub table: String,
    pub type_id: String,
    pub properties: String,
    pub after: String,
}

pub(super) fn next_rekeying(tx: &Transaction<'_>) -> Result<Option<Rekeying>> {
    Ok(tx
        .prepare_cached(
            "SELECT q.table_seq, s.table_name, i.type, json(i.properties), q.after_id \
             FROM table_rows_rekeying q JOIN table_summaries s ON s.seq = q.table_seq \
             JOIN items i ON i.seq = s.item_seq ORDER BY q.table_seq LIMIT 1",
        )?
        .query_row([], |row| {
            Ok(Rekeying {
                table_seq: row.get(0)?,
                table: row.get(1)?,
                type_id: row.get(2)?,
                properties: row.get(3)?,
                after: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })
        .optional()?)
}

pub(super) fn rekey_page(
    tx: &Transaction<'_>,
    next: &Rekeying,
    keyed: &Keyed,
    limit: i64,
) -> Result<i64> {
    let page = rows_per_page(keyed, limit);
    let (taken, last) = rekey_rows(tx, next.table_seq, keyed, &next.after, page)?;
    match last {
        Some(last) if taken == page => {
            tx.prepare_cached("UPDATE table_rows_rekeying SET after_id = ?2 WHERE table_seq = ?1")?
                .execute(params![next.table_seq, last])?;
        }
        _ => {
            tx.prepare_cached("DELETE FROM table_rows_rekeying WHERE table_seq = ?1")?
                .execute([next.table_seq])?;
            settled_as(tx, next.table_seq, Some(&keyed.signature()))?;
        }
    }
    Ok(taken)
}

pub(super) fn remove_keys(tx: &Transaction<'_>, table: i64, limit: i64) -> Result<i64> {
    Ok(tx
        .prepare_cached(
            "DELETE FROM table_row_keys WHERE (table_seq, name, key, id) IN \
             (SELECT table_seq, name, key, id FROM table_row_keys WHERE table_seq = ?1 LIMIT ?2)",
        )?
        .execute(params![table, limit])? as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate::{self, MIGRATIONS};

    #[test]
    fn an_upgraded_database_rekeys_every_table_in_pages_of_about_the_limit() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        let before = &MIGRATIONS[..MIGRATIONS.len() - 1];
        migrate::complete(&mut db, before).unwrap();
        db.execute_batch(
            "INSERT INTO items (seq, id, type, state, tier, source, version, schema_version, \
             occurred_at, created_at, updated_at, last_activity_at, properties) \
             VALUES (1, 'i', 'user.t', 'active', 'feed', 's', 1, 0, 't', 't', 't', 't', jsonb('{}')); \
             INSERT INTO table_summaries (seq, item_seq, table_name, row_count, bytes, last_batch, changed_at) \
             VALUES (7, 1, 'lines', 30, 0, '', '')",
        )
        .unwrap();
        for n in 0..30 {
            db.execute(
                "INSERT INTO table_rows (table_seq, id, updated_at, batch, body) \
                 VALUES (7, ?1, '', 0, jsonb(?2))",
                params![
                    format!("{n:03}"),
                    format!(r#"{{"a": {n}, "b": "t{}"}}"#, 30 - n)
                ],
            )
            .unwrap();
        }
        migrate::upgrade(&mut db, MIGRATIONS, before.len() as u32).unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(keyed_by(&tx, 7).unwrap(), None);
        let columns: Map<String, Value> = serde_json::from_str(
            r#"{"a": {"type": "number"}, "b": {"type": "string"}, "c": {"type": "item"}}"#,
        )
        .unwrap();
        let keyed = Keyed::of(&columns, None);
        let mut pages = Vec::new();
        while let Some(next) = next_rekeying(&tx).unwrap() {
            assert_eq!(next.table_seq, 7);
            pages.push(rekey_page(&tx, &next, &keyed, 20).unwrap());
        }
        assert_eq!(pages, [10, 10, 10, 0]);
        assert_eq!(
            keyed_by(&tx, 7).unwrap().as_deref(),
            Some("number:a,string:b")
        );
        let held: i64 = tx
            .query_row(
                "SELECT count(*) FROM table_row_keys WHERE table_seq = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(held, 60);
        let first: String = tx
            .query_row(
                "SELECT id FROM table_row_keys WHERE table_seq = 7 AND name = 'b' ORDER BY key, id",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first, "029");
    }
}
