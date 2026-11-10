//! Row storage and paged cleanup.

use rusqlite::types::Value as Bound;
use rusqlite::{OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

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
    batch: &str,
    at: &str,
) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO table_summaries (item_seq, table_name, row_count, bytes, last_batch, changed_at) \
         VALUES (?1, ?2, 0, 0, ?3, ?4) ON CONFLICT (item_seq, table_name) DO NOTHING",
    )?
    .execute(params![seq, table, batch, at])?;
    table_seq(tx, seq, table)?.ok_or_else(|| Refusal::internal("a table summary did not land"))
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

pub(super) fn put(
    tx: &Transaction<'_>,
    table: i64,
    id: &str,
    at: &str,
    body: &str,
    refs: Option<&str>,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_rows (table_seq, id, updated_at, refs, body) \
         VALUES (?1, ?2, ?3, jsonb(?4), jsonb(?5)) \
         ON CONFLICT (table_seq, id) DO UPDATE SET updated_at = ?3, refs = jsonb(?4), body = jsonb(?5)",
    )?
    .execute(params![table, id, at, refs, body])?;
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

/// The tables of item `seq` that hold a row.
pub(super) fn held_tables(tx: &Transaction<'_>, seq: i64) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT table_name FROM table_summaries WHERE item_seq = ?1 AND row_count > 0 \
         ORDER BY table_name",
    )?;
    let found = statement.query_map([seq], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// The tables that hold a row of an item of `type_id`.
pub(super) fn held_tables_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT DISTINCT s.table_name FROM table_summaries s JOIN items i ON i.seq = s.item_seq \
         WHERE i.type = ?1 AND s.row_count > 0 ORDER BY s.table_name",
    )?;
    let found = statement.query_map([type_id], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// Whether a row of an item of `type_id` in `table` holds a value for `column`.
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
