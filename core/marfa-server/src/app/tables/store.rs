//! Row storage, its order keys and paged cleanup.

use rusqlite::types::Value as Bound;
use rusqlite::{OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

use super::order::Order;
use crate::app::clock::{Stamp, Unread};
use crate::app::query::Sql;
use crate::app::refusal::{Refusal, Result};

pub(super) const UNREAD: Unread<'static> = Unread {
    table: "row_batches",
    time: "at",
    scope: "1",
};

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

pub(super) struct Written<'a> {
    pub table: i64,
    pub id: &'a str,
    pub at: &'a str,
    pub batch: i64,
    pub body: &'a str,
    pub refs: Option<&'a str>,
    pub order: Option<&'a Order>,
}

pub(super) fn put(tx: &Transaction<'_>, row: &Written<'_>) -> Result<()> {
    tx.prepare_cached(&format!(
        "INSERT INTO table_rows (table_seq, id, updated_at, batch, ord, refs, body) \
         VALUES (?1, ?2, ?3, ?4, {}, jsonb(?5), jsonb(?6)) \
         ON CONFLICT (table_seq, id) DO UPDATE SET updated_at = ?3, batch = ?4, \
         ord = excluded.ord, refs = excluded.refs, body = excluded.body",
        key_of(row.order, "?6", "?5")
    ))?
    .execute(params![
        row.table, row.id, row.at, row.batch, row.refs, row.body
    ])?;
    Ok(())
}

pub(super) fn delete(tx: &Transaction<'_>, table: i64, id: &str) -> Result<Option<i64>> {
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

pub(super) fn marker(tx: &Transaction<'_>, table: i64, id: &str) -> Result<Option<i64>> {
    Ok(tx
        .prepare_cached("SELECT batch FROM table_rows WHERE table_seq = ?1 AND id = ?2")?
        .query_row(params![table, id], |row| row.get(0))
        .optional()?)
}

pub(super) fn set_marker(tx: &Transaction<'_>, table: i64, id: &str, mark: i64) -> Result<()> {
    tx.prepare_cached("UPDATE table_rows SET batch = ?3 WHERE table_seq = ?1 AND id = ?2")?
        .execute(params![table, id, mark])?;
    Ok(())
}

pub(super) fn open_batch(
    tx: &Transaction<'_>,
    table: i64,
    id: &str,
    at: &str,
    undoes: Option<&str>,
) -> Result<i64> {
    Ok(tx
        .prepare_cached(
            "INSERT INTO row_batches (id, table_seq, at, rows, undoes) VALUES (?1, ?2, ?3, 0, ?4) \
             RETURNING seq",
        )?
        .query_row(params![id, table, at, undoes], |row| row.get(0))?)
}

pub(super) fn close_batch(tx: &Transaction<'_>, batch: i64, rows: i64) -> Result<()> {
    tx.prepare_cached("UPDATE row_batches SET rows = ?2 WHERE seq = ?1")?
        .execute(params![batch, rows])?;
    Ok(())
}

/// Call once per row, before its first change in the batch.
pub(super) fn log_before(
    tx: &Transaction<'_>,
    batch: i64,
    table: i64,
    id: &str,
    held: bool,
    after: i64,
) -> Result<()> {
    if held {
        tx.prepare_cached(
            "INSERT INTO row_changes (batch, id, before_batch, after_batch, refs, body) \
             SELECT ?1, id, batch, ?4, refs, body FROM table_rows \
             WHERE table_seq = ?2 AND id = ?3",
        )?
        .execute(params![batch, table, id, after])?;
    } else {
        tx.prepare_cached(
            "INSERT INTO row_changes (batch, id, before_batch, after_batch, refs, body) \
             VALUES (?1, ?2, NULL, ?3, NULL, NULL)",
        )?
        .execute(params![batch, id, after])?;
    }
    Ok(())
}

pub(super) fn log_removed(tx: &Transaction<'_>, batch: i64, id: &str) -> Result<()> {
    tx.prepare_cached("UPDATE row_changes SET after_batch = NULL WHERE batch = ?1 AND id = ?2")?
        .execute(params![batch, id])?;
    Ok(())
}

/// Records the item ids a batch left in a row it kept.
pub(super) fn log_after_refs(tx: &Transaction<'_>, batch: i64, id: &str, refs: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE row_changes SET after_refs = jsonb(?3) WHERE batch = ?1 AND id = ?2",
    )?
    .execute(params![batch, id, refs])?;
    Ok(())
}

pub(super) struct Logged {
    pub seq: i64,
    pub id: String,
    pub at: String,
    pub rows: i64,
    pub undoes: Option<String>,
}

fn logged_of(row: &Row<'_>) -> rusqlite::Result<Logged> {
    Ok(Logged {
        seq: row.get(0)?,
        id: row.get(1)?,
        at: row.get(2)?,
        rows: row.get(3)?,
        undoes: row.get(4)?,
    })
}

pub(super) fn batch(tx: &Transaction<'_>, table: i64, id: &str) -> Result<Option<Logged>> {
    Ok(tx
        .prepare_cached(
            "SELECT seq, id, at, rows, undoes FROM row_batches WHERE id = ?1 AND table_seq = ?2",
        )?
        .query_row(params![id, table], logged_of)
        .optional()?)
}

pub(super) fn batches(
    tx: &Transaction<'_>,
    table: i64,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Logged>> {
    let mut statement = tx.prepare_cached(
        "SELECT seq, id, at, rows, undoes FROM row_batches \
         WHERE table_seq = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
    )?;
    let found =
        statement.query_map(params![table, before.unwrap_or(i64::MAX), limit], logged_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// A row as a batch found it.
pub(super) struct Before {
    pub batch: i64,
    pub values: Map<String, Value>,
    pub refs: Map<String, Value>,
}

/// A row a batch changed.
pub(super) struct Change {
    pub id: String,
    /// `None` where the batch created the row.
    pub before: Option<Before>,
    /// The mark the batch left on the row, `None` where it removed the row.
    pub after: Option<i64>,
    /// Each value the batch left written as an item's id, by column.
    pub after_refs: Map<String, Value>,
}

fn refs_of(refs: Option<&str>) -> Result<Map<String, Value>> {
    Ok(refs.map(object_of).transpose()?.unwrap_or_default())
}

pub(super) fn changes(tx: &Transaction<'_>, batch: i64) -> Result<Vec<Change>> {
    let mut statement = tx.prepare_cached(
        "SELECT id, before_batch, after_batch, json(body), json(refs), json(after_refs) \
         FROM row_changes WHERE batch = ?1 ORDER BY id",
    )?;
    let found = statement.query_map([batch], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    found
        .map(|row| {
            let (id, before_batch, after, body, refs, after_refs) = row?;
            let before = match (before_batch, body) {
                (Some(batch), Some(body)) => Some(Before {
                    batch,
                    values: object_of(&body)?,
                    refs: refs_of(refs.as_deref())?,
                }),
                (None, None) => None,
                _ => return Err(Refusal::internal("a logged row change does not read")),
            };
            Ok(Change {
                id,
                before,
                after,
                after_refs: refs_of(after_refs.as_deref())?,
            })
        })
        .collect()
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

/// A table holding rows, with its item, in the order an archive carries them.
pub(super) struct Carried {
    pub table_seq: i64,
    pub item_seq: i64,
    pub item_id: String,
    pub type_id: String,
    pub source: String,
    pub table: String,
}

/// Each table holding a row, ordered by its item's id and then its name, as one statement reads them.
pub(super) fn carried_tables(
    tx: &Transaction<'_>,
    mut each: impl FnMut(Carried) -> Result<()>,
) -> Result<()> {
    let mut statement = tx.prepare(
        "SELECT s.seq, i.seq, i.id, i.type, i.source, s.table_name FROM items i \
         JOIN table_summaries s ON s.item_seq = i.seq WHERE s.row_count > 0 \
         ORDER BY i.id, s.table_name",
    )?;
    let mut found = statement.query([])?;
    while let Some(row) = found.next()? {
        each(Carried {
            table_seq: row.get(0)?,
            item_seq: row.get(1)?,
            item_id: row.get(2)?,
            type_id: row.get(3)?,
            source: row.get(4)?,
            table: row.get(5)?,
        })?;
    }
    Ok(())
}

pub(super) fn rows_after(
    tx: &Transaction<'_>,
    table: i64,
    after: &str,
    limit: i64,
) -> Result<Vec<Held>> {
    let mut statement = tx.prepare_cached(
        "SELECT id, updated_at, json(body), json(refs) FROM table_rows \
         WHERE table_seq = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
    )?;
    let found = statement.query_map(params![table, after, limit], stored_of)?;
    found.map(|row| held(row?)).collect()
}

/// The mark of a row no logged batch left: `row_batches` numbers its batches from 1.
pub(super) const UNLOGGED: i64 = 0;

pub(super) fn insert(tx: &Transaction<'_>, row: &Written<'_>) -> Result<()> {
    tx.prepare_cached(&format!(
        "INSERT INTO table_rows (table_seq, id, updated_at, batch, ord, refs, body) \
         VALUES (?1, ?2, ?3, ?4, {}, jsonb(?5), jsonb(?6))",
        key_of(row.order, "?6", "?5")
    ))?
    .execute(params![
        row.table, row.id, row.at, row.batch, row.refs, row.body
    ])?;
    Ok(())
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

/// Forgets a purged item's summaries and leaves its rows and their log for `table-row-cleanup`.
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
             AND (EXISTS (SELECT 1 FROM table_rows r WHERE r.table_seq = s.seq) \
             OR EXISTS (SELECT 1 FROM row_batches b WHERE b.table_seq = s.seq))",
        )?
        .execute([seq])?
        > 0;
    tx.prepare_cached("DELETE FROM table_summaries WHERE item_seq = ?1")?
        .execute([seq])?;
    Ok(held)
}

#[derive(Default)]
pub(super) struct Removed {
    pub rows: i64,
    pub batches: i64,
    pub changes: i64,
}

pub(super) fn remove_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<Removed>> {
    let Some(table) = tx
        .prepare_cached("SELECT table_seq FROM table_rows_purging ORDER BY table_seq LIMIT 1")?
        .query_row([], |row| row.get::<_, i64>(0))
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = tx.prepare_cached(
        "SELECT seq, rows FROM row_batches WHERE table_seq = ?1 ORDER BY seq LIMIT ?2",
    )?;
    let oldest = statement
        .query_map(params![table, limit], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut through = None;
    let mut taken = 0;
    for (seq, rows) in oldest {
        if through.is_some() && taken + rows > limit {
            break;
        }
        through = Some(seq);
        taken += rows;
    }
    if let Some(through) = through {
        // A batch goes only once its last change has, so no page leaves a change without it.
        let changes = tx
            .prepare_cached(
                "DELETE FROM row_changes WHERE (batch, id) IN (SELECT c.batch, c.id \
                 FROM row_batches b JOIN row_changes c ON c.batch = b.seq \
                 WHERE b.table_seq = ?1 AND b.seq <= ?2 LIMIT ?3)",
            )?
            .execute(params![table, through, limit])? as i64;
        if changes == limit {
            return Ok(Some(Removed {
                changes,
                ..Removed::default()
            }));
        }
        let batches = tx
            .prepare_cached("DELETE FROM row_batches WHERE table_seq = ?1 AND seq <= ?2")?
            .execute(params![table, through])? as i64;
        return Ok(Some(Removed {
            batches,
            changes,
            rows: 0,
        }));
    }
    let rows = tx
        .prepare_cached(
            "DELETE FROM table_rows WHERE table_seq = ?1 AND id IN \
             (SELECT id FROM table_rows WHERE table_seq = ?1 LIMIT ?2)",
        )?
        .execute(params![table, limit])? as i64;
    if rows < limit {
        tx.prepare_cached("DELETE FROM table_rows_purging WHERE table_seq = ?1")?
            .execute([table])?;
    }
    Ok(Some(Removed {
        rows,
        ..Removed::default()
    }))
}

/// Changes below the oldest batch left, whose batch is therefore gone.
pub(super) fn orphan_page(tx: &Transaction<'_>, limit: i64) -> Result<Option<Removed>> {
    let changes = tx
        .prepare_cached(
            "DELETE FROM row_changes WHERE (batch, id) IN (SELECT batch, id FROM row_changes \
             WHERE batch < coalesce((SELECT min(seq) FROM row_batches), 9223372036854775807) \
             ORDER BY batch, id LIMIT ?1)",
        )?
        .execute([limit])? as i64;
    Ok((changes > 0).then_some(Removed {
        changes,
        ..Removed::default()
    }))
}

/// Removes the oldest batches made before `cutoff`, with their changes, about `limit` changes at
/// a time. A batch whose time does not read stops the page, so it and every later batch stay.
pub(super) fn expire_page(
    tx: &Transaction<'_>,
    cutoff: &str,
    limit: i64,
) -> Result<Option<Removed>> {
    let mut statement =
        tx.prepare_cached("SELECT seq, at, rows FROM row_batches ORDER BY seq LIMIT ?1")?;
    let oldest = statement
        .query_map([limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut through = None;
    let mut taken = 0;
    for (seq, at, rows) in oldest {
        // A time that reads is in the one stored form, so it compares as text.
        if Stamp::parsed(&at).is_none() || at.as_str() >= cutoff {
            break;
        }
        if through.is_some() && taken + rows > limit {
            break;
        }
        through = Some(seq);
        taken += rows;
    }
    let Some(through) = through else {
        return Ok(None);
    };
    let changes = tx
        .prepare_cached("DELETE FROM row_changes WHERE batch <= ?1")?
        .execute([through])? as i64;
    let batches = tx
        .prepare_cached("DELETE FROM row_batches WHERE seq <= ?1")?
        .execute([through])? as i64;
    Ok(Some(Removed {
        batches,
        changes,
        rows: 0,
    }))
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

fn key_of(order: Option<&Order>, body: &str, refs: &str) -> String {
    order.map_or_else(
        || "NULL".to_string(),
        |order| order.stored_key_sql(body, refs),
    )
}

pub(super) fn reorder_whole(tx: &Transaction<'_>, table: i64, order: Option<&Order>) -> Result<()> {
    tx.execute(
        &format!(
            "UPDATE table_rows SET ord = {} WHERE table_seq = ?1",
            key_of(order, "body", "refs")
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
        key_of(order.as_ref(), "body", "refs")
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

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "2000-01-01T00:00:00.000Z";
    const CUTOFF: &str = "2001-01-01T00:00:00.000Z";

    fn orphans(tx: &Transaction<'_>) -> i64 {
        tx.query_row(
            "SELECT count(*) FROM row_changes c \
             WHERE NOT EXISTS (SELECT 1 FROM row_batches b WHERE b.seq = c.batch)",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn logged(batches: &[(i64, i64, i64)]) -> rusqlite::Connection {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        for &(table, batch, rows) in batches {
            db.execute(
                "INSERT INTO row_batches (seq, id, table_seq, at, rows) VALUES (?1, ?1, ?2, ?3, ?4)",
                params![batch, table, OLD, rows],
            )
            .unwrap();
            for row in 0..rows {
                db.execute(
                    "INSERT INTO row_changes (batch, id, after_batch) VALUES (?1, ?2, ?1)",
                    params![batch, format!("{row}")],
                )
                .unwrap();
            }
        }
        db
    }

    fn count(tx: &Transaction<'_>, sql: &str) -> i64 {
        tx.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn every_page_of_expiry_takes_a_batch_with_all_its_changes() {
        let mut db = logged(&[
            (1, 1, 600),
            (1, 2, 600),
            (1, 3, 900),
            (1, 4, 50),
            (1, 5, 50),
        ]);
        let tx = db.transaction().unwrap();
        // A kill lands between pages, so each page must leave no change without its batch.
        let mut pages = Vec::new();
        while let Some(page) = expire_page(&tx, CUTOFF, 1_000).unwrap() {
            assert_eq!(orphans(&tx), 0);
            pages.push((page.batches, page.changes));
        }
        assert_eq!(pages, [(1, 600), (1, 600), (3, 1_000)]);
        assert_eq!(
            orphan_page(&tx, 1_000).unwrap().map(|page| page.changes),
            None
        );
    }

    #[test]
    fn every_page_of_a_purge_leaves_each_change_its_batch_and_ends_with_the_whole_log() {
        let mut db = logged(&[
            (1, 1, 600),
            (1, 2, 2_500),
            (2, 3, 10),
            (1, 4, 50),
            (1, 5, 50),
        ]);
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO table_rows_purging (table_seq) VALUES (1)", [])
            .unwrap();
        let mut pages = Vec::new();
        while let Some(page) = remove_page(&tx, 1_000).unwrap() {
            assert_eq!(orphans(&tx), 0);
            pages.push((page.batches, page.changes));
        }
        assert_eq!(
            pages,
            [(1, 600), (0, 1_000), (0, 1_000), (1, 500), (2, 100), (0, 0)]
        );
        assert_eq!(
            count(&tx, "SELECT count(*) FROM row_batches WHERE table_seq = 1"),
            0
        );
        assert_eq!(
            count(&tx, "SELECT count(*) FROM row_changes WHERE batch = 3"),
            10
        );
        assert_eq!(count(&tx, "SELECT count(*) FROM row_changes"), 10);
    }
}
