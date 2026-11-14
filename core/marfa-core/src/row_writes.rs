//! Row writes, queued as a table's door takes them and laid over a table held whole.

use std::collections::{BTreeMap, BTreeSet};

use marfa_rules::rows;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::error::CoreError;
use crate::model::{QueuedWrite, RowConflict, Verdict, WriteKind};
use crate::{Result, store, tables};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Op {
    Put {
        id: String,
        values: Map<String, Value>,
    },
    Patch {
        id: String,
        values: Map<String, Value>,
    },
    Delete {
        id: String,
    },
}

impl Op {
    pub(crate) fn id(&self) -> &str {
        match self {
            Op::Put { id, .. } | Op::Patch { id, .. } | Op::Delete { id } => id,
        }
    }

    pub(crate) fn name(&self) -> &'static str {
        match self {
            Op::Put { .. } => "put",
            Op::Patch { .. } => "patch",
            Op::Delete { .. } => "delete",
        }
    }

    fn values(&self) -> Option<&Map<String, Value>> {
        match self {
            Op::Put { values, .. } | Op::Patch { values, .. } => Some(values),
            Op::Delete { .. } => None,
        }
    }

    fn printed(&self) -> Value {
        match self {
            Op::Put { id, values } => json!({ "op": "put", "id": id, "values": values }),
            Op::Patch { id, values } => json!({ "op": "patch", "id": id, "values": values }),
            Op::Delete { id } => json!({ "op": "delete", "id": id }),
        }
    }
}

fn refused(refused: rows::Refused) -> CoreError {
    CoreError::Validation {
        server: None,
        code: "validation_error".into(),
        message: refused.sentence(),
        details: None,
    }
}

fn refused_at(index: usize, path: &str, message: &str) -> CoreError {
    refused(rows::Refused::at(index, path, message))
}

/// An id-less `put` is given one here, so every send is the same batch.
fn operations(sent: &[Value]) -> Result<Vec<Op>> {
    Ok(rows::batch(sent, rows::MAX_OPERATIONS)
        .map_err(refused)?
        .into_iter()
        .map(|op| match op {
            rows::Op::Put { id, values } => Op::Put {
                id: id.unwrap_or_else(|| Uuid::now_v7().to_string()),
                values,
            },
            rows::Op::Patch { id, values } => Op::Patch { id, values },
            rows::Op::Delete { id } => Op::Delete { id },
        })
        .collect())
}

pub(crate) fn queued_ops(body: &Value) -> Result<Vec<Op>> {
    let sent = body
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Store("a queued row write holds no operations".into()))?;
    operations(sent).map_err(|error| {
        CoreError::Store(format!(
            "a queued row write holds a batch this build cannot read: {error}"
        ))
    })
}

fn judge_values(
    index: usize,
    columns: &Map<String, Value>,
    values: &Map<String, Value>,
    complete: bool,
    kept: &[String],
) -> Result<()> {
    marfa_rules::validation::row_values(columns, values, complete, kept).map_err(
        |error| match error.fields.first() {
            Some(field) => refused_at(index, &format!("values.{}", field.path), &field.message),
            None => refused_at(index, "values", &error.message),
        },
    )
}

/// What the copy knows of one row as the batch's operations leave it.
struct Known {
    /// `None` where the copy cannot tell.
    exists: Option<bool>,
    /// Withheld columns make these values a lower bound on the row's size.
    values: Option<Map<String, Value>>,
    /// The columns the server keeps a `put` from replacing, where the copy knows them.
    withheld: Option<Vec<String>>,
}

fn known_row(conn: &Connection, item: &str, table: &str, id: &str, laid: bool) -> Result<Known> {
    if !laid {
        return Ok(Known {
            exists: None,
            values: None,
            withheld: None,
        });
    }
    Ok(match held_row(conn, item, table, id)? {
        Some(held) => Known {
            exists: Some(true),
            values: Some(held.values),
            withheld: Some(held.withheld),
        },
        None => Known {
            exists: Some(false),
            values: Some(Map::new()),
            withheld: Some(Vec::new()),
        },
    })
}

fn judge_rows(
    conn: &Connection,
    item: &str,
    table: &str,
    columns: &Map<String, Value>,
    ops: &[Op],
    sent: &[Value],
    laid: bool,
) -> Result<()> {
    let item_columns: Vec<String> = columns
        .iter()
        .filter(|(_, column)| {
            column.get("type").and_then(Value::as_str) == Some(marfa_rules::schema::ITEM_KIND)
        })
        .map(|(name, _)| name.clone())
        .collect();
    let mut rows: BTreeMap<String, Known> = BTreeMap::new();
    for (index, op) in ops.iter().enumerate() {
        if !rows.contains_key(op.id()) {
            rows.insert(
                op.id().to_string(),
                known_row(conn, item, table, op.id(), laid)?,
            );
        }
        let row = rows.get_mut(op.id()).expect("the row was just noted");
        match op {
            Op::Put { values, .. } => {
                let fresh = sent[index].get("id").is_none();
                // A value in an item column may be one the row keeps from the key's sight.
                let kept = match (&row.withheld, fresh) {
                    (_, true) => Vec::new(),
                    (Some(withheld), false) => withheld.clone(),
                    (None, false) => item_columns.clone(),
                };
                judge_values(index, columns, values, true, &kept)?;
                let next: Map<String, Value> = values
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(column, value)| (column.clone(), value.clone()))
                    .collect();
                rows::refuse_wide(index, &next).map_err(refused)?;
                row.exists = Some(true);
                row.values = Some(next);
            }
            Op::Patch { values, .. } => match row.values.as_mut() {
                Some(held) if row.exists == Some(true) => {
                    for (column, value) in values {
                        if value.is_null() {
                            held.remove(column);
                        } else {
                            held.insert(column.clone(), value.clone());
                        }
                    }
                    rows::refuse_wide(index, held).map_err(refused)?;
                }
                _ => row.values = None,
            },
            Op::Delete { .. } => {
                row.exists = Some(false);
                row.values = None;
                row.withheld = Some(Vec::new());
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
struct Held {
    values: Map<String, Value>,
    withheld: Vec<String>,
    updated_at: String,
}

fn held_row(conn: &Connection, item: &str, table: &str, id: &str) -> Result<Option<Held>> {
    let row: Option<(String, Option<String>, String)> = conn
        .prepare_cached(
            "SELECT body, withheld, updated_at FROM table_rows
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
        )?
        .query_row(params![item, table, id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    row.map(|(body, withheld, updated_at)| read_held(&body, withheld.as_deref(), updated_at))
        .transpose()
}

fn read_held(body: &str, withheld: Option<&str>, updated_at: String) -> Result<Held> {
    let values = match serde_json::from_str(body)? {
        Value::Object(values) => values,
        _ => {
            return Err(CoreError::Store(
                "a held row's values are not an object".into(),
            ));
        }
    };
    let withheld = match withheld {
        Some(text) => serde_json::from_str(text)?,
        None => Vec::new(),
    };
    Ok(Held {
        values,
        withheld,
        updated_at,
    })
}

fn whole(conn: &Connection, item: &str, table: &str) -> Result<bool> {
    Ok(tables::state(conn, item, table)?.as_deref() == Some(tables::WHOLE))
}

fn columns_of(conn: &Connection, item: &str, table: &str) -> Result<Map<String, Value>> {
    let tables = tables::of_item(conn, item)?;
    let definition = tables.get(table).ok_or_else(|| CoreError::NotFound {
        server: None,
        code: "table_not_found".into(),
        message: format!("the type of {item} declares no table {table}"),
    })?;
    Ok(definition
        .get("columns")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default())
}

fn refuse_unheld(
    conn: &Connection,
    completeness: crate::model::Completeness,
    item: &str,
) -> Result<()> {
    if !store::item_held(conn, item)? {
        store::refuse_unless_held(completeness)?;
        return Err(CoreError::NotFound {
            server: None,
            code: "item_not_found".into(),
            message: format!("{item} is not an item this copy holds"),
        });
    }
    Ok(())
}

/// The row write this one follows (`queue-and-verdicts/follows-write-ahead`).
fn row_write_ahead(conn: &Connection, item: &str, table: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM queue
              WHERE item_id = ?1 AND row_table = ?2 AND kind IN (?3, ?4)
                AND (verdict IS NULL OR verdict NOT IN (?5, ?6))
              ORDER BY seq DESC LIMIT 1",
            params![
                item,
                table,
                WriteKind::WriteRows.as_str(),
                WriteKind::UndoRows.as_str(),
                Verdict::Accepted.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| row.get(0),
        )
        .optional()?)
}

fn enqueue(
    conn: &Connection,
    kind: WriteKind,
    item: &str,
    table: &str,
    payload: &Value,
    read: Option<&Value>,
) -> Result<QueuedWrite> {
    let depends_on = store::untaken_creates_for_item(conn, item)?;
    let follows = row_write_ahead(conn, item, table)?;
    let queued = store::enqueue(
        conn,
        &store::NewWrite {
            kind,
            item_id: Some(item),
            target_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload.to_string(),
            depends_on: &depends_on,
        },
    )?;
    conn.execute(
        "UPDATE queue SET row_table = ?2, follows = ?3, read = ?4 WHERE id = ?1",
        params![queued.id, table, follows, read.map(Value::to_string)],
    )?;
    store::queued_write(conn, &queued.id)?
        .ok_or_else(|| CoreError::Store("the queued write vanished".into()))
}

pub(crate) fn write(
    conn: &mut Connection,
    item: &str,
    table: &str,
    sent: &[Value],
) -> Result<QueuedWrite> {
    let completeness = store::refuse_unless_writable(conn)?;
    refuse_unheld(conn, completeness, item)?;
    let columns = columns_of(conn, item, table)?;
    let ops = operations(sent)?;
    for (index, op) in ops.iter().enumerate() {
        if let Some(values) = op.values() {
            judge_values(index, &columns, values, false, &[])?;
        }
    }
    let tx = conn.transaction()?;
    let laid = whole(&tx, item, table)?;
    let mut read = Map::new();
    if laid {
        for (index, op) in ops.iter().enumerate() {
            let shown = held_row(&tx, item, table, op.id())?;
            if let (Some(shown), Some(values)) = (&shown, op.values())
                && let Some(column) = shown
                    .withheld
                    .iter()
                    .find(|column| values.contains_key(*column))
            {
                return Err(CoreError::Forbidden {
                    server: None,
                    code: "forbidden".into(),
                    message: format!(
                        "operation {index} names the column {column}, whose value names an item this key may not read"
                    ),
                });
            }
            if !read.contains_key(op.id()) {
                read.insert(
                    op.id().to_string(),
                    shown.map_or(Value::Null, |shown| Value::Object(shown.values)),
                );
            }
        }
    }
    judge_rows(&tx, item, table, &columns, &ops, sent, laid)?;
    let payload = json!({ "operations": ops.iter().map(Op::printed).collect::<Vec<_>>() });
    let read = laid.then(|| json!({ "rows": read }));
    let queued = enqueue(
        &tx,
        WriteKind::WriteRows,
        item,
        table,
        &payload,
        read.as_ref(),
    )?;
    let seq: i64 = tx.query_row("SELECT seq FROM queue WHERE id = ?1", [&queued.id], |row| {
        row.get(0)
    })?;
    let mut named = tx.prepare_cached(
        "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let ids: BTreeSet<&str> = ops.iter().map(Op::id).collect();
    for id in &ids {
        let on_row: Vec<Value> = ops
            .iter()
            .filter(|op| op.id() == *id)
            .map(Op::printed)
            .collect();
        named.execute(params![
            queued.id,
            seq,
            item,
            table,
            id,
            Value::Array(on_row).to_string(),
            queued.queued_at
        ])?;
    }
    drop(named);
    if laid {
        for id in &ids {
            lay(&tx, item, table, id)?;
        }
        tables::past_cap(&tx, item, table)?;
    }
    tx.commit()?;
    Ok(queued)
}

pub(crate) fn undo(
    conn: &mut Connection,
    item: &str,
    table: &str,
    batch: &str,
) -> Result<QueuedWrite> {
    let completeness = store::refuse_unless_writable(conn)?;
    refuse_unheld(conn, completeness, item)?;
    columns_of(conn, item, table)?;
    if marfa_rules::validation::id("batch", batch).is_err() {
        return Err(CoreError::Invalid(format!("{batch} is not a batch id")));
    }
    let tx = conn.transaction()?;
    let queued = enqueue(
        &tx,
        WriteKind::UndoRows,
        item,
        table,
        &json!({ "batch": batch }),
        None,
    )?;
    tx.commit()?;
    Ok(queued)
}

/// Waiting, or taken with a batch whose `rows.changed` is not yet applied.
fn laid_over(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
) -> Result<Vec<(i64, Vec<Op>, String)>> {
    let mut query = conn.prepare_cached(
        "SELECT l.seq, l.ops, l.at FROM rows_laid l LEFT JOIN queue q ON q.id = l.write_id
          WHERE l.item_id = ?1 AND l.name = ?2 AND l.id = ?3
            AND (l.batch IS NOT NULL
                 OR (q.id IS NOT NULL AND (q.verdict IS NULL OR q.verdict = ?4)))
          ORDER BY l.seq",
    )?;
    let rows = query.query_map(params![item, table, id, Verdict::Blocked.as_str()], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut laid = Vec::new();
    for row in rows {
        let (seq, ops, at) = row?;
        let ops = queued_ops(&json!({ "operations": serde_json::from_str::<Value>(&ops)? }))?;
        laid.push((seq, ops, at));
    }
    Ok(laid)
}

fn apply(row: Option<Held>, ops: &[Op], id: &str, at: &str) -> Option<Held> {
    let mut row = row;
    for op in ops.iter().filter(|op| op.id() == id) {
        row = match (op, row) {
            (Op::Put { values, .. }, before) => Some(Held {
                values: values
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(column, value)| (column.clone(), value.clone()))
                    .collect(),
                withheld: before.map(|before| before.withheld).unwrap_or_default(),
                updated_at: at.to_string(),
            }),
            (Op::Patch { values, .. }, Some(mut before)) => {
                for (column, value) in values {
                    if value.is_null() {
                        before.values.remove(column);
                    } else {
                        before.values.insert(column.clone(), value.clone());
                    }
                }
                before.updated_at = at.to_string();
                Some(before)
            }
            (Op::Patch { .. }, None) => None,
            (Op::Delete { .. }, _) => None,
        };
    }
    row
}

fn beneath(conn: &Connection, item: &str, table: &str, id: &str) -> Result<Option<Option<Held>>> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .prepare_cached(
            "SELECT body, withheld, updated_at FROM rows_beneath
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
        )?
        .query_row(params![item, table, id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    row.map(|(body, withheld, updated_at)| match body {
        Some(body) => {
            read_held(&body, withheld.as_deref(), updated_at.unwrap_or_default()).map(Some)
        }
        None => Ok(None),
    })
    .transpose()
}

fn set_beneath(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
    row: Option<&Held>,
) -> Result<()> {
    let (body, withheld, updated_at) = match row {
        Some(row) => (
            Some(Value::Object(row.values.clone()).to_string()),
            (!row.withheld.is_empty())
                .then(|| serde_json::to_string(&row.withheld))
                .transpose()?,
            Some(row.updated_at.clone()),
        ),
        None => (None, None, None),
    };
    conn.prepare_cached(
        "INSERT INTO rows_beneath (item_id, name, id, body, withheld, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (item_id, name, id) DO UPDATE SET
           body = excluded.body, withheld = excluded.withheld, updated_at = excluded.updated_at",
    )?
    .execute(params![item, table, id, body, withheld, updated_at])?;
    Ok(())
}

fn hold(conn: &Connection, item: &str, table: &str, id: &str, row: Option<&Held>) -> Result<()> {
    match row {
        Some(row) => {
            tables::hold_row(
                conn,
                item,
                table,
                id,
                &row.values,
                &row.withheld,
                &row.updated_at,
            )?;
        }
        None => {
            tables::delete_row(conn, item, table, id)?;
        }
    }
    Ok(())
}

fn lay(conn: &Connection, item: &str, table: &str, id: &str) -> Result<()> {
    let laid = laid_over(conn, item, table, id)?;
    let under = beneath(conn, item, table, id)?;
    if laid.is_empty() {
        if let Some(under) = under {
            hold(conn, item, table, id, under.as_ref())?;
            conn.execute(
                "DELETE FROM rows_beneath WHERE item_id = ?1 AND name = ?2 AND id = ?3",
                params![item, table, id],
            )?;
        }
        return Ok(());
    }
    let under = match under {
        Some(under) => under,
        None => {
            let server = held_row(conn, item, table, id)?;
            set_beneath(conn, item, table, id, server.as_ref())?;
            server
        }
    };
    let shown = laid
        .iter()
        .fold(under, |row, (_, ops, at)| apply(row, ops, id, at));
    hold(conn, item, table, id, shown.as_ref())
}

fn laid_ids(conn: &Connection, item: &str, table: &str) -> Result<Vec<String>> {
    let mut query =
        conn.prepare_cached("SELECT DISTINCT id FROM rows_laid WHERE item_id = ?1 AND name = ?2")?;
    let rows = query.query_map(params![item, table], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// For a table that has just become whole, from rows the server alone gave.
pub(crate) fn lay_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    for id in laid_ids(conn, item, table)? {
        lay(conn, item, table, &id)?;
    }
    Ok(())
}

/// In a writer's transaction, after a row write's verdict changed.
pub(crate) fn flush(conn: &Connection) -> Result<()> {
    let dirty: Vec<(String, String, String)> = {
        let mut query = conn.prepare_cached("SELECT item_id, name, id FROM rows_dirty")?;
        let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if dirty.is_empty() {
        return Ok(());
    }
    conn.execute("DELETE FROM rows_dirty", [])?;
    let mut tables_laid = BTreeSet::new();
    for (item, table, id) in &dirty {
        if whole(conn, item, table)? {
            lay(conn, item, table, id)?;
            tables_laid.insert((item, table));
        }
    }
    for (item, table) in tables_laid {
        tables::past_cap(conn, item, table)?;
    }
    Ok(())
}

/// Beneath the writes laid over the row, where any are (`device/table-write-over-server`).
pub(crate) fn take_server_row(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
    row: Option<(&Map<String, Value>, &[String], &str)>,
) -> Result<bool> {
    let named = conn
        .prepare_cached(
            "SELECT 1 FROM rows_laid WHERE item_id = ?1 AND name = ?2 AND id = ?3 LIMIT 1",
        )?
        .query_row(params![item, table, id], |_| Ok(()))
        .optional()?
        .is_some();
    if named && whole(conn, item, table)? {
        let row = row.map(|(values, withheld, updated_at)| {
            let mut values = values.clone();
            for column in withheld {
                values.remove(column);
            }
            Held {
                values,
                withheld: withheld.to_vec(),
                updated_at: updated_at.to_string(),
            }
        });
        set_beneath(conn, item, table, id, row.as_ref())?;
        lay(conn, item, table, id)?;
        return Ok(true);
    }
    match row {
        Some((values, withheld, updated_at)) => {
            tables::hold_row(conn, item, table, id, values, withheld, updated_at)
        }
        None => tables::delete_row(conn, item, table, id),
    }
}

/// A fill after this reads the batches taken before it, so none is waited for.
pub(crate) fn forget_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM rows_beneath WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    conn.execute(
        "DELETE FROM rows_laid WHERE item_id = ?1 AND name = ?2 AND batch IS NOT NULL",
        params![item, table],
    )?;
    conn.execute(
        "DELETE FROM rows_seen WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    Ok(())
}

pub(crate) fn forget_item(conn: &Connection, item: &str) -> Result<()> {
    conn.execute("DELETE FROM rows_beneath WHERE item_id = ?1", [item])?;
    conn.execute(
        "DELETE FROM rows_laid WHERE item_id = ?1 AND batch IS NOT NULL",
        [item],
    )?;
    conn.execute("DELETE FROM rows_seen WHERE item_id = ?1", [item])?;
    Ok(())
}

pub(crate) fn forget_all(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM rows_beneath; DELETE FROM rows_seen;
         DELETE FROM rows_laid WHERE batch IS NOT NULL;",
    )?;
    Ok(())
}

/// A batch no laid write names is kept while a sent write awaits its answer.
pub(crate) fn applied_batch(conn: &Connection, item: &str, table: &str, batch: &str) -> Result<()> {
    let released: Vec<String> = {
        let mut query = conn.prepare_cached(
            "DELETE FROM rows_laid WHERE batch = ?1 AND item_id = ?2 AND name = ?3 RETURNING id",
        )?;
        let rows = query.query_map(params![batch, item, table], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if released.is_empty() {
        let waiting = conn
            .prepare_cached(
                "SELECT 1 FROM queue WHERE kind = ?1 AND item_id = ?2 AND row_table = ?3
                   AND sent = 1 AND verdict IS NULL LIMIT 1",
            )?
            .query_row(params![WriteKind::WriteRows.as_str(), item, table], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if waiting {
            conn.execute(
                "INSERT OR IGNORE INTO rows_seen (batch, item_id, name) VALUES (?1, ?2, ?3)",
                params![batch, item, table],
            )?;
        }
        return Ok(());
    }
    let ids: BTreeSet<String> = released.into_iter().collect();
    for id in ids {
        lay(conn, item, table, &id)?;
    }
    Ok(())
}

/// Kept so a late answer under the spent key is not read as the next one's.
pub(crate) fn spend_key(conn: &Connection, id: &str) -> Result<()> {
    let (key, spent): (String, Option<String>) = conn.query_row(
        "SELECT idempotency_key, spent_keys FROM queue WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut keys: Vec<String> = match spent {
        Some(json) => serde_json::from_str(&json)?,
        None => Vec::new(),
    };
    keys.push(key);
    conn.execute(
        "UPDATE queue SET spent_keys = ?2, idempotency_key = ?3 WHERE id = ?1",
        params![
            id,
            serde_json::to_string(&keys)?,
            Uuid::now_v7().to_string()
        ],
    )?;
    Ok(())
}

/// The ids of the writes sent in one request with `id`, the first first, or
/// `id` alone where it went in no batch with another.
pub(crate) fn batch_of(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let Some(lead) = conn
        .query_row(
            "SELECT COALESCE(batched_with, id) FROM queue WHERE id = ?1 AND kind = ?2",
            params![id, WriteKind::WriteRows.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(vec![id.to_string()]);
    };
    let mut query =
        conn.prepare_cached("SELECT id FROM queue WHERE batched_with = ?1 ORDER BY seq ASC")?;
    let members = query
        .query_map([&lead], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(std::iter::once(lead).chain(members).collect())
}

/// Every write sent in the request with `id` leaves its batch, unsent: only
/// for an answer that proves the server holding the copy's items took none of it.
pub(crate) fn leave_unsent(conn: &Connection, id: &str) -> Result<()> {
    for write in batch_of(conn, id)? {
        conn.execute(
            "UPDATE queue SET batched_with = NULL WHERE id = ?1",
            [&write],
        )?;
        store::mark_unsent(conn, &write)?;
    }
    Ok(())
}

/// A row the server answers once a write may have reached it can hold that
/// write already, so it says nothing of what the write replaced.
pub(crate) fn unjudge(conn: &Connection, item: &str, table: &str, row: Option<&str>) -> Result<()> {
    let judged: Vec<(String, String)> = {
        let mut query = conn.prepare_cached(
            "SELECT id, read FROM queue
              WHERE item_id = ?1 AND row_table = ?2 AND kind = ?3 AND read IS NOT NULL
                AND last_sent_seq IS NOT NULL AND (verdict IS NULL OR verdict = ?4)",
        )?;
        let rows = query.query_map(
            params![
                item,
                table,
                WriteKind::WriteRows.as_str(),
                Verdict::Blocked.as_str()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, read) in judged {
        let kept = match row {
            None => None,
            Some(row) => {
                let mut read: Value = serde_json::from_str(&read)?;
                let Some(rows) = read.get_mut("rows").and_then(Value::as_object_mut) else {
                    continue;
                };
                if rows.remove(row).is_none() {
                    continue;
                }
                let left = !rows.is_empty();
                left.then(|| read.to_string())
            }
        };
        conn.execute(
            "UPDATE queue SET read = ?2 WHERE id = ?1",
            params![id, kept],
        )?;
    }
    Ok(())
}

pub(crate) struct Taken<'a> {
    pub write: &'a QueuedWrite,
    pub results: &'a [Value],
}

/// `batch` is `None` where no row changed, `results` empty where no answer was kept.
pub(crate) fn taken(
    conn: &Connection,
    item: &str,
    table: &str,
    batch: Option<&str>,
    writes: &[Taken<'_>],
) -> Result<Vec<Vec<RowConflict>>> {
    // Applied first, the batch's own event left nothing beneath to judge by.
    let seen = match batch {
        Some(batch) => conn.execute("DELETE FROM rows_seen WHERE batch = ?1", [batch])? > 0,
        None => false,
    };
    let laid = whole(conn, item, table)?;
    let mut written = Vec::with_capacity(writes.len());
    let mut conflicts = Vec::with_capacity(writes.len());
    for taken in writes {
        let ops = queued_ops(&taken.write.body)?;
        conflicts.push(if laid && !seen {
            clashes(conn, item, table, taken.write, &ops)?
        } else {
            Vec::new()
        });
        written.push(ops);
    }
    let mut changed: BTreeSet<&str> = BTreeSet::new();
    for taken in writes {
        for result in taken.results {
            let outcome = result.get("outcome").and_then(Value::as_str);
            if !matches!(outcome, Some("unchanged" | "absent"))
                && let Some(id) = result.get("id").and_then(Value::as_str)
            {
                changed.insert(id);
            }
        }
    }
    let kept_whole = writes.iter().all(|taken| !taken.results.is_empty());
    for (taken, ops) in writes.iter().zip(&written) {
        let write = taken.write;
        let ids: BTreeSet<&str> = ops.iter().map(Op::id).collect();
        for id in ids {
            let waits = laid && kept_whole && changed.contains(id) && !seen;
            if laid && kept_whole && !changed.contains(id) {
                let under = beneath(conn, item, table, id)?.flatten();
                let at = under.as_ref().map(|row| row.updated_at.clone());
                let left = apply(under, ops, id, &write.queued_at).map(|mut row| {
                    if let Some(at) = at {
                        row.updated_at = at;
                    }
                    row
                });
                set_beneath(conn, item, table, id, left.as_ref())?;
            }
            match (waits, batch) {
                (true, Some(batch)) => conn.execute(
                    "UPDATE rows_laid SET batch = ?3 WHERE write_id = ?1 AND id = ?2",
                    params![write.id, id, batch],
                )?,
                _ => conn.execute(
                    "DELETE FROM rows_laid WHERE write_id = ?1 AND id = ?2",
                    params![write.id, id],
                )?,
            };
            if laid {
                lay(conn, item, table, id)?;
            }
        }
    }
    Ok(conflicts)
}

/// Where the server's value before `write` differs from what the copy showed it.
fn clashes(
    conn: &Connection,
    item: &str,
    table: &str,
    write: &QueuedWrite,
    ops: &[Op],
) -> Result<Vec<RowConflict>> {
    let Some(read) = store::read_of(conn, &write.id)?
        .and_then(|read| serde_json::from_str::<Value>(&read).ok())
        .and_then(|read| read.get("rows").and_then(Value::as_object).cloned())
    else {
        return Ok(Vec::new());
    };
    let seq: i64 = conn.query_row("SELECT seq FROM queue WHERE id = ?1", [&write.id], |row| {
        row.get(0)
    })?;
    let mut clashed = Vec::new();
    let mut judged = BTreeSet::new();
    for op in ops {
        let id = op.id();
        if !judged.insert(id) {
            continue;
        }
        let Some(shown) = read.get(id) else { continue };
        let shown = shown.as_object().cloned();
        let under = beneath(conn, item, table, id)?.flatten();
        let before = laid_over(conn, item, table, id)?
            .into_iter()
            .filter(|(at, _, _)| *at < seq)
            .fold(under, |row, (_, ops, at)| apply(row, &ops, id, &at));
        let server = before.as_ref().map(|row| &row.values);
        let mut columns: BTreeMap<&str, ()> = BTreeMap::new();
        for written in ops.iter().filter(|written| written.id() == id) {
            match written {
                Op::Patch { values, .. } => {
                    for column in values.keys() {
                        columns.insert(column, ());
                    }
                }
                Op::Put { .. } | Op::Delete { .. } => {
                    for held in [server, shown.as_ref()].into_iter().flatten() {
                        for column in held.keys() {
                            columns.insert(column, ());
                        }
                    }
                }
            }
        }
        let withheld = before
            .as_ref()
            .map(|row| row.withheld.clone())
            .unwrap_or_default();
        for column in columns.keys() {
            if withheld.iter().any(|held| held == column) {
                continue;
            }
            let was = server.and_then(|values| values.get(*column));
            let saw = shown.as_ref().and_then(|values| values.get(*column));
            if was != saw {
                clashed.push(RowConflict {
                    row: id.to_string(),
                    column: (*column).to_string(),
                });
            }
        }
    }
    Ok(clashed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_patch_of_a_row_gone_leaves_it_gone_and_a_put_keeps_what_is_withheld() {
        let id = "01a1b75e-2d9d-775a-930a-6b3d1207edae";
        let held = Held {
            values: values(json!({ "count": 1 })),
            withheld: vec!["ref".into()],
            updated_at: "then".into(),
        };
        let patched = apply(
            None,
            &[Op::Patch {
                id: id.into(),
                values: values(json!({ "count": 2 })),
            }],
            id,
            "now",
        );
        assert_eq!(patched, None);
        let put = apply(
            Some(held),
            &[
                Op::Put {
                    id: id.into(),
                    values: values(json!({ "count": 3, "note": null })),
                },
                Op::Patch {
                    id: id.into(),
                    values: values(json!({ "note": "a" })),
                },
            ],
            id,
            "now",
        )
        .unwrap();
        assert_eq!(put.values, values(json!({ "count": 3, "note": "a" })));
        assert_eq!(put.withheld, vec!["ref".to_string()]);
        assert_eq!(put.updated_at, "now");
    }

    #[test]
    fn a_put_naming_no_id_is_given_one_and_a_bad_operation_is_named() {
        let ops = operations(&[json!({ "op": "put", "values": {} })]).unwrap();
        assert!(marfa_rules::validation::id("id", ops[0].id()).is_ok());
        let refused = operations(&[
            json!({ "op": "put", "values": {} }),
            json!({ "op": "delete", "id": ops[0].id(), "values": {} }),
        ])
        .unwrap_err();
        assert!(
            refused.to_string().contains("operations.1.values"),
            "{refused}"
        );
    }
    #[test]
    fn a_batch_the_server_would_refuse_is_a_validation_naming_the_operation() {
        let id = "01a1b75e-2d9d-775a-930a-6b3d1207edae";
        let columns = values(json!({ "count": { "type": "integer" } }));
        let too_many = vec![json!({ "op": "put", "values": {} }); rows::MAX_OPERATIONS + 1];
        for (sent, named) in [
            (vec![], "operations"),
            (too_many, "operations"),
            (vec![json!({ "op": "move", "id": id })], "operations.0.op"),
            (
                vec![json!({ "op": "put", "id": "not-a-row" })],
                "operations.0.id",
            ),
            (
                vec![json!({ "op": "delete", "id": id, "values": {} })],
                "operations.0.values",
            ),
            (
                vec![json!({ "op": "put", "values": "count" })],
                "operations.0.values",
            ),
        ] {
            let refused = operations(&sent).unwrap_err();
            assert!(
                matches!(&refused, CoreError::Validation { code, server: None, .. }
                    if code == "validation_error"),
                "{refused:?}"
            );
            assert!(refused.to_string().contains(named), "{refused}");
        }
        for (sent, named) in [
            (json!({ "count": "many" }), "operations.2.values.count"),
            (json!({ "other": 1 }), "operations.2.values.other"),
        ] {
            let refused = judge_values(2, &columns, &values(sent)).unwrap_err();
            assert!(
                matches!(&refused, CoreError::Validation { code, server: None, .. }
                    if code == "validation_error"),
                "{refused:?}"
            );
            assert!(refused.to_string().contains(named), "{refused}");
        }
    }


    fn judged(columns: &Value, sent: Vec<Value>) -> Result<()> {
        let conn = Connection::open_in_memory().unwrap();
        let columns = values(columns.clone());
        let ops = operations(&sent).unwrap();
        judge_rows(&conn, "item", "table", &columns, &ops, &sent, false)
    }

    #[test]
    fn a_batch_keeps_what_the_copy_cannot_tell_of_a_rows_withheld_columns_across_its_operations() {
        let columns = json!({
            "count": { "type": "integer", "required": true },
            "ref": { "type": "item", "required": true },
        });
        let id = "01a1b75e-2d9d-775a-930a-6b3d1207edae";
        let other = "01a1b75e-2d9d-775a-930a-6b3d1207edaf";
        let put =
            |id: &str, count: i64| json!({ "op": "put", "id": id, "values": { "count": count } });
        // Neither put can tell whether the row keeps a reference the key cannot see.
        judged(&columns, vec![put(id, 1), put(id, 2)]).unwrap();
        judged(&columns, vec![put(id, 1), put(other, 1), put(id, 2)]).unwrap();
        judged(
            &columns,
            vec![
                put(id, 1),
                json!({ "op": "patch", "id": id, "values": { "count": 3 } }),
                put(id, 2),
            ],
        )
        .unwrap();
        // A delete leaves no row to keep one, so a put after it must carry the column.
        let after_delete = judged(
            &columns,
            vec![put(id, 1), json!({ "op": "delete", "id": id }), put(id, 2)],
        )
        .unwrap_err();
        assert!(
            after_delete.to_string().contains("operations.2.values.ref"),
            "{after_delete}"
        );
        // A row put under a fresh id is new, and keeps nothing.
        let fresh = judged(
            &columns,
            vec![put(id, 1), json!({ "op": "put", "values": { "count": 1 } })],
        )
        .unwrap_err();
        assert!(
            fresh.to_string().contains("operations.1.values.ref"),
            "{fresh}"
        );
    }

    #[test]
    fn a_copy_that_cannot_see_the_row_refuses_what_the_server_would_whatever_the_row_holds() {
        let columns = json!({
            "count": { "type": "integer", "required": true },
            "ref": { "type": "item", "required": true },
            "note": { "type": "string" },
        });
        let id = "01a1b75e-2d9d-775a-930a-6b3d1207edae";
        let missing = judged(
            &columns,
            vec![json!({ "op": "put", "id": id, "values": { "ref": id } })],
        )
        .unwrap_err();
        assert!(
            missing.to_string().contains("operations.0.values.count"),
            "{missing}"
        );
        assert!(matches!(
            &missing,
            CoreError::Validation { code, .. } if code == "validation_error"
        ));
        // A required item column may be one the row keeps, so only the server can say.
        judged(
            &columns,
            vec![json!({ "op": "put", "id": id, "values": { "count": 1 } })],
        )
        .unwrap();
        // A new row keeps nothing.
        let fresh = judged(
            &columns,
            vec![json!({ "op": "put", "values": { "count": 1 } })],
        )
        .unwrap_err();
        assert!(
            fresh.to_string().contains("operations.0.values.ref"),
            "{fresh}"
        );
        let wide = "x".repeat(rows::MAX_ROW_BYTES);
        let long = judged(
            &columns,
            vec![
                json!({ "op": "put", "id": id, "values": { "count": 1, "ref": id } }),
                json!({ "op": "put", "id": id, "values": { "count": 1, "ref": id, "note": wide } }),
            ],
        )
        .unwrap_err();
        assert!(long.to_string().contains("operations.1.values"), "{long}");
        // A patch of a row the copy does not hold is the server's to judge.
        judged(
            &columns,
            vec![json!({ "op": "patch", "id": id, "values": { "note": wide } })],
        )
        .unwrap();
        // A patch of a row this batch put is judged by what the put left.
        let grown = judged(
            &columns,
            vec![
                json!({ "op": "put", "id": id, "values": { "count": 1, "ref": id, "note": "x".repeat(rows::MAX_ROW_BYTES - 120) } }),
                json!({ "op": "patch", "id": id, "values": { "note": wide } }),
            ],
        )
        .unwrap_err();
        assert!(grown.to_string().contains("operations.1.values"), "{grown}");
    }
}
