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
    /// The values' length as the row write prints them, which the summary counts.
    pub bytes: i64,
}

pub(super) fn printed_len(values: &Map<String, Value>) -> i64 {
    serde_json::to_string(values).map_or(0, |text| text.len() as i64)
}

fn values_of(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(values)) => Ok(values),
        _ => Err(Refusal::internal("a stored row does not read")),
    }
}

fn held_of(row: &Row<'_>) -> rusqlite::Result<(String, String, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
}

fn held((id, updated_at, text): (String, String, String)) -> Result<Held> {
    let values = values_of(&text)?;
    Ok(Held {
        bytes: printed_len(&values),
        values,
        id,
        updated_at,
    })
}

pub(super) fn row(tx: &Transaction<'_>, seq: i64, table: &str, id: &str) -> Result<Option<Held>> {
    tx.prepare_cached(
        "SELECT id, updated_at, json(body) FROM table_rows \
         WHERE item_seq = ?1 AND table_name = ?2 AND id = ?3",
    )?
    .query_row(params![seq, table, id], held_of)
    .optional()?
    .map(held)
    .transpose()
}

pub(super) fn put(
    tx: &Transaction<'_>,
    seq: i64,
    table: &str,
    id: &str,
    at: &str,
    text: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_rows (item_seq, table_name, id, updated_at, body) \
         VALUES (?1, ?2, ?3, ?4, jsonb(?5)) \
         ON CONFLICT (item_seq, table_name, id) DO UPDATE SET updated_at = ?4, body = jsonb(?5)",
    )?
    .execute(params![seq, table, id, at, text])?;
    Ok(())
}

/// The bytes the removed row held, or `None` where there was none.
pub(super) fn delete(tx: &Transaction<'_>, seq: i64, table: &str, id: &str) -> Result<Option<i64>> {
    let removed: Option<String> = tx
        .prepare_cached(
            "DELETE FROM table_rows WHERE item_seq = ?1 AND table_name = ?2 AND id = ?3 \
             RETURNING json(body)",
        )?
        .query_row(params![seq, table, id], |row| row.get(0))
        .optional()?;
    removed
        .map(|text| Ok(printed_len(&values_of(&text)?)))
        .transpose()
}

/// SQLite checks the inserted row before the conflict, so it never holds a negative change.
pub(super) fn summarize(
    tx: &Transaction<'_>,
    seq: i64,
    table: &str,
    count: i64,
    bytes: i64,
    batch: &str,
    at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO table_summaries (item_seq, table_name, row_count, bytes, last_batch, changed_at) \
         VALUES (?1, ?2, MAX(?3, 0), MAX(?4, 0), ?5, ?6) \
         ON CONFLICT (item_seq, table_name) DO UPDATE SET row_count = row_count + ?3, \
         bytes = bytes + ?4, last_batch = ?5, changed_at = ?6",
    )?
    .execute(params![seq, table, count, bytes, batch, at])?;
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

/// The rows `filter` selects, in the order `order` gives, as a page query asks.
pub(super) fn page(tx: &Transaction<'_>, sql: &Sql) -> Result<Vec<(Held, Bound)>> {
    let mut statement = tx.prepare(&sql.text)?;
    let found = statement.query_map(params_from_iter(sql.values.iter()), |row| {
        Ok((held_of(row)?, row.get::<_, Bound>(3)?))
    })?;
    found
        .map(|row| {
            let (held_row, key) = row?;
            Ok((held(held_row)?, key))
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
        "SELECT EXISTS (SELECT 1 FROM items i JOIN table_rows r ON r.item_seq = i.seq \
         AND r.table_name = ?2 WHERE i.type = ?1 AND json_type(r.body, ?3) IS NOT NULL \
         AND json_type(r.body, ?3) <> 'null')",
        params![type_id, table, format!("$.{column}")],
        |row| row.get(0),
    )?)
}

/// Forgets a purged item's summaries and leaves its rows for `table-row-cleanup`.
pub(super) fn doom(tx: &Transaction<'_>, seq: i64) -> Result<bool> {
    tx.prepare_cached("DELETE FROM table_summaries WHERE item_seq = ?1")?
        .execute([seq])?;
    let held: bool = tx
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM table_rows WHERE item_seq = ?1)")?
        .query_row([seq], |row| row.get(0))?;
    if held {
        tx.prepare_cached("INSERT OR IGNORE INTO table_rows_purging (item_seq) VALUES (?1)")?
            .execute([seq])?;
    }
    Ok(held)
}

/// Removes up to `limit` rows of one purged item; `None` once no purged item has rows left.
pub(super) fn remove_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<i64>> {
    let Some(seq) = tx
        .prepare_cached("SELECT item_seq FROM table_rows_purging ORDER BY item_seq LIMIT 1")?
        .query_row([], |row| row.get::<_, i64>(0))
        .optional()?
    else {
        return Ok(None);
    };
    let removed = tx
        .prepare_cached(
            "DELETE FROM table_rows WHERE item_seq = ?1 AND (table_name, id) IN \
             (SELECT table_name, id FROM table_rows WHERE item_seq = ?1 LIMIT ?2)",
        )?
        .execute(params![seq, limit])? as i64;
    if removed < limit {
        tx.prepare_cached("DELETE FROM table_rows_purging WHERE item_seq = ?1")?
            .execute([seq])?;
    }
    Ok(Some(removed))
}
