//! Row storage, its order keys and paged cleanup.

use rusqlite::types::Value as Bound;
use rusqlite::{OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

use super::order::Order;
use crate::app::query::Sql;
use crate::app::refusal::{Refusal, Result};

pub(super) struct Held {
    pub id: String,
    pub updated_at: String,
    pub values: Map<String, Value>,
    /// Each value written as an item's id, by column.
    pub refs: Map<String, Value>,
    /// The values' length as the row write prints them, which the summary counts.
    pub bytes: i64,
}

pub(super) fn printed_len(values: &Map<String, Value>) -> i64 {
    serde_json::to_string(values).map_or(0, |text| text.len() as i64)
}

fn object_of(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(values)) => Ok(values),
        _ => Err(Refusal::internal("a stored row does not read")),
    }
}

type Stored = (String, String, String, Option<String>);

/// Reads `id, updated_at, json(body), json(refs)` from the start of a row.
fn stored_of(row: &Row<'_>) -> rusqlite::Result<Stored> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn held((id, updated_at, body, refs): Stored) -> Result<Held> {
    let values = object_of(&body)?;
    Ok(Held {
        bytes: printed_len(&values),
        values,
        refs: refs
            .as_deref()
            .map(object_of)
            .transpose()?
            .unwrap_or_default(),
        id,
        updated_at,
    })
}

/// The key of item `seq`'s table `table`, once it has held a row.
pub(super) fn table_seq(tx: &Transaction<'_>, seq: i64, table: &str) -> Result<Option<i64>> {
    Ok(tx
        .prepare_cached("SELECT seq FROM table_summaries WHERE item_seq = ?1 AND table_name = ?2")?
        .query_row(params![seq, table], |row| row.get(0))
        .optional()?)
}

/// The key of item `seq`'s table `table`, starting its summary where it has none.
pub(super) fn open(
    tx: &Transaction<'_>,
    seq: i64,
    table: &str,
    order: Option<&Order>,
    batch: &str,
    at: &str,
) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO table_summaries \
         (item_seq, table_name, row_count, bytes, last_batch, changed_at, ordered_by) \
         VALUES (?1, ?2, 0, 0, ?3, ?4, ?5) ON CONFLICT (item_seq, table_name) DO NOTHING",
    )?
    .execute(params![seq, table, batch, at, order.map(Order::signature)])?;
    table_seq(tx, seq, table)?.ok_or_else(|| Refusal::internal("a table summary did not land"))
}

/// The order every row of table `table` holds the key of, once none is being rebuilt.
pub(super) fn ordered_by(tx: &Transaction<'_>, table: i64) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT ordered_by FROM table_summaries WHERE seq = ?1")?
        .query_row([table], |row| row.get(0))
        .optional()?
        .flatten())
}

pub(super) fn row(tx: &Transaction<'_>, table: Option<i64>, id: &str) -> Result<Option<Held>> {
    let Some(table) = table else {
        return Ok(None);
    };
    tx.prepare_cached(
        "SELECT id, updated_at, json(body), json(refs) FROM table_rows \
         WHERE table_seq = ?1 AND id = ?2",
    )?
    .query_row(params![table, id], stored_of)
    .optional()?
    .map(held)
    .transpose()
}

pub(super) struct Put<'a> {
    pub table: i64,
    pub id: &'a str,
    pub at: &'a str,
    pub body: &'a str,
    pub refs: Option<&'a str>,
    pub order: Option<&'a Order>,
}

pub(super) fn put(tx: &Transaction<'_>, row: &Put<'_>) -> Result<()> {
    let key = row.order.map_or_else(
        || "NULL".to_string(),
        |order| order.stored_key_sql("?5", "?4"),
    );
    tx.prepare_cached(&format!(
        "INSERT INTO table_rows (table_seq, id, updated_at, ord, refs, body) \
         VALUES (?1, ?2, ?3, {key}, jsonb(?4), jsonb(?5)) \
         ON CONFLICT (table_seq, id) DO UPDATE SET updated_at = ?3, ord = excluded.ord, \
         refs = excluded.refs, body = excluded.body"
    ))?
    .execute(params![row.table, row.id, row.at, row.refs, row.body])?;
    Ok(())
}

/// The bytes the removed row held, or `None` where there was none.
pub(super) fn delete(tx: &Transaction<'_>, table: Option<i64>, id: &str) -> Result<Option<i64>> {
    let Some(table) = table else {
        return Ok(None);
    };
    let removed: Option<String> = tx
        .prepare_cached(
            "DELETE FROM table_rows WHERE table_seq = ?1 AND id = ?2 RETURNING json(body)",
        )?
        .query_row(params![table, id], |row| row.get(0))
        .optional()?;
    removed
        .map(|text| Ok(printed_len(&object_of(&text)?)))
        .transpose()
}

pub(super) fn summarize(
    tx: &Transaction<'_>,
    table: i64,
    count: i64,
    bytes: i64,
    batch: &str,
    at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "UPDATE table_summaries SET row_count = row_count + ?2, bytes = bytes + ?3, \
         last_batch = ?4, changed_at = ?5 WHERE seq = ?1",
    )?
    .execute(params![table, count, bytes, batch, at])?;
    Ok(())
}

pub(super) struct Summary {
    pub table: String,
    pub row_count: i64,
    pub bytes: i64,
    pub last_batch: String,
    pub changed_at: String,
}

pub(super) fn summaries(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Summary>> {
    let mut statement = tx.prepare_cached(
        "SELECT table_name, row_count, bytes, last_batch, changed_at FROM table_summaries \
         WHERE item_seq = ?1",
    )?;
    let found = statement.query_map([seq], |row| {
        Ok(Summary {
            table: row.get(0)?,
            row_count: row.get(1)?,
            bytes: row.get(2)?,
            last_batch: row.get(3)?,
            changed_at: row.get(4)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// Rows as a page query selects them, each with its sort key.
pub(super) fn page(tx: &Transaction<'_>, sql: &Sql) -> Result<Vec<(Held, Bound)>> {
    let mut statement = tx.prepare(&sql.text)?;
    let found = statement.query_map(params_from_iter(sql.values.iter()), |row| {
        Ok((stored_of(row)?, row.get::<_, Bound>(4)?))
    })?;
    found
        .map(|row| {
            let (stored, key) = row?;
            Ok((held(stored)?, key))
        })
        .collect()
}

pub(super) fn single(tx: &Transaction<'_>, sql: &Sql) -> Result<Vec<Bound>> {
    let mut statement = tx.prepare(&sql.text)?;
    let width = statement.column_count();
    let found = statement
        .query_row(params_from_iter(sql.values.iter()), |row| {
            (0..width).map(|at| row.get::<_, Bound>(at)).collect()
        })
        .optional()?;
    Ok(found.unwrap_or_default())
}

pub(super) fn held_tables(tx: &Transaction<'_>, seq: i64) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT table_name FROM table_summaries WHERE item_seq = ?1 AND row_count > 0 \
         ORDER BY table_name",
    )?;
    let found = statement.query_map([seq], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn held_tables_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT DISTINCT s.table_name FROM table_summaries s JOIN items i ON i.seq = s.item_seq \
         WHERE i.type = ?1 AND s.row_count > 0 ORDER BY s.table_name",
    )?;
    let found = statement.query_map([type_id], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn column_held(
    tx: &Transaction<'_>,
    type_id: &str,
    table: &str,
    column: &str,
) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM items i \
         JOIN table_summaries s ON s.item_seq = i.seq AND s.table_name = ?2 \
         JOIN table_rows r ON r.table_seq = s.seq \
         WHERE i.type = ?1 AND json_type(r.body, ?3) IS NOT NULL \
         AND json_type(r.body, ?3) <> 'null')",
        params![type_id, table, format!("$.{column}")],
        |row| row.get(0),
    )?)
}

/// Forgets a purged item's summaries and leaves its rows for `table-row-cleanup`.
pub(super) fn doom(tx: &Transaction<'_>, seq: i64) -> Result<bool> {
    tx.prepare_cached(
        "DELETE FROM table_rows_reordering WHERE table_seq IN \
         (SELECT seq FROM table_summaries WHERE item_seq = ?1)",
    )?
    .execute([seq])?;
    let held = tx
        .prepare_cached(
            "INSERT OR IGNORE INTO table_rows_purging (table_seq) \
             SELECT s.seq FROM table_summaries s WHERE s.item_seq = ?1 \
             AND EXISTS (SELECT 1 FROM table_rows r WHERE r.table_seq = s.seq)",
        )?
        .execute([seq])?
        > 0;
    tx.prepare_cached("DELETE FROM table_summaries WHERE item_seq = ?1")?
        .execute([seq])?;
    Ok(held)
}

/// Removes up to `limit` rows of one purged table; `None` once no purged table has rows left.
pub(super) fn remove_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<i64>> {
    let Some(table) = tx
        .prepare_cached("SELECT table_seq FROM table_rows_purging ORDER BY table_seq LIMIT 1")?
        .query_row([], |row| row.get::<_, i64>(0))
        .optional()?
    else {
        return Ok(None);
    };
    let removed = tx
        .prepare_cached(
            "DELETE FROM table_rows WHERE table_seq = ?1 AND id IN \
             (SELECT id FROM table_rows WHERE table_seq = ?1 LIMIT ?2)",
        )?
        .execute(params![table, limit])? as i64;
    if removed < limit {
        tx.prepare_cached("DELETE FROM table_rows_purging WHERE table_seq = ?1")?
            .execute([table])?;
    }
    Ok(Some(removed))
}

pub(super) struct Ordering {
    pub table_seq: i64,
    pub table: String,
    pub row_count: i64,
    pub ordered_by: Option<String>,
    /// The order a rebuild under way brings the keys to, `Some(None)` to clear them.
    pub rebuilding: Option<Option<String>>,
}

fn orderings(
    tx: &Transaction<'_>,
    filter: &str,
    key: &dyn rusqlite::ToSql,
) -> Result<Vec<Ordering>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT s.seq, s.table_name, s.row_count, s.ordered_by, q.table_seq IS NOT NULL, q.target \
         FROM table_summaries s LEFT JOIN table_rows_reordering q ON q.table_seq = s.seq \
         WHERE {filter}"
    ))?;
    let found = statement.query_map([key], |row| {
        Ok(Ordering {
            table_seq: row.get(0)?,
            table: row.get(1)?,
            row_count: row.get(2)?,
            ordered_by: row.get(3)?,
            rebuilding: match row.get::<_, bool>(4)? {
                true => Some(row.get(5)?),
                false => None,
            },
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn orderings_of_item(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Ordering>> {
    orderings(tx, "s.item_seq = ?1", &seq)
}

pub(super) fn orderings_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<Ordering>> {
    orderings(
        tx,
        "s.item_seq IN (SELECT seq FROM items WHERE type = ?1)",
        &type_id,
    )
}

fn key_of(order: Option<&Order>) -> String {
    order.map_or_else(
        || "NULL".to_string(),
        |order| order.stored_key_sql("body", "refs"),
    )
}

/// Writes every row's key for `order` at once and records it as the table's.
pub(super) fn reorder_whole(tx: &Transaction<'_>, table: i64, order: Option<&Order>) -> Result<()> {
    tx.execute(
        &format!(
            "UPDATE table_rows SET ord = {} WHERE table_seq = ?1",
            key_of(order)
        ),
        [table],
    )?;
    tx.prepare_cached("DELETE FROM table_rows_reordering WHERE table_seq = ?1")?
        .execute([table])?;
    tx.prepare_cached("UPDATE table_summaries SET ordered_by = ?2 WHERE seq = ?1")?
        .execute(params![table, order.map(Order::signature)])?;
    Ok(())
}

/// Leaves the table's keys to `table-row-cleanup`, which starts them over for `order`.
pub(super) fn reorder_later(tx: &Transaction<'_>, table: i64, order: Option<&Order>) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_rows_reordering (table_seq, target, after_id) VALUES (?1, ?2, NULL) \
         ON CONFLICT (table_seq) DO UPDATE SET target = ?2, after_id = NULL",
    )?
    .execute(params![table, order.map(Order::signature)])?;
    tx.prepare_cached("UPDATE table_summaries SET ordered_by = NULL WHERE seq = ?1")?
        .execute([table])?;
    Ok(())
}

/// Writes the keys of up to `limit` rows of one table being reordered; `None` once none is.
pub(super) fn reorder_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<i64>> {
    let Some((table, target, after)) = tx
        .prepare_cached(
            "SELECT table_seq, target, after_id FROM table_rows_reordering ORDER BY table_seq LIMIT 1",
        )?
        .query_row([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))
        })
        .optional()?
    else {
        return Ok(None);
    };
    let order = target.as_deref().and_then(Order::from_signature);
    let mut statement = tx.prepare(&format!(
        "UPDATE table_rows SET ord = {} WHERE table_seq = ?1 AND id IN \
         (SELECT id FROM table_rows WHERE table_seq = ?1 AND id > ?2 ORDER BY id LIMIT ?3) \
         RETURNING id",
        key_of(order.as_ref())
    ))?;
    let ids = statement
        .query_map(params![table, after.unwrap_or_default(), limit], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let taken = ids.len() as i64;
    match ids.into_iter().max() {
        Some(last) if taken == limit => {
            tx.prepare_cached(
                "UPDATE table_rows_reordering SET after_id = ?2 WHERE table_seq = ?1",
            )?
            .execute(params![table, last])?;
        }
        _ => {
            tx.prepare_cached("DELETE FROM table_rows_reordering WHERE table_seq = ?1")?
                .execute([table])?;
            tx.prepare_cached("UPDATE table_summaries SET ordered_by = ?2 WHERE seq = ?1")?
                .execute(params![table, target])?;
        }
    }
    Ok(Some(taken))
}
