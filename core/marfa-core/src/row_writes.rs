//! Row writes, queued as a table's door takes them and laid over a table held whole.

use crate::store::Cached;
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
    rows::refuse_inexact_values(index, values).map_err(refused)?;
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
    /// Each column written as an item's id, to that id.
    refs: Map<String, Value>,
    updated_at: String,
}

fn held_row(conn: &Connection, item: &str, table: &str, id: &str) -> Result<Option<Held>> {
    let row: Option<Stored> = conn
        .prepare_cached(
            "SELECT body, withheld, refs, updated_at FROM table_rows
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
        )?
        .query_row(params![item, table, id], |row| {
            Ok(Stored {
                body: Some(row.get(0)?),
                withheld: row.get(1)?,
                refs: row.get(2)?,
                updated_at: Some(row.get(3)?),
            })
        })
        .optional()?;
    row.map(unstored).transpose().map(Option::flatten)
}

fn read_held(
    body: &str,
    withheld: Option<&str>,
    refs: Option<&str>,
    updated_at: String,
) -> Result<Held> {
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
    let refs = match refs {
        Some(text) => serde_json::from_str(text)?,
        None => Map::new(),
    };
    Ok(Held {
        values,
        withheld,
        refs,
        updated_at,
    })
}

/// The columns of the table that hold an item's id, as the copy's catalog declares them; none where it declares no such table.
fn item_columns(conn: &Connection, item: &str, table: &str) -> Result<Vec<String>> {
    let held: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM items WHERE id = ?1)",
        [item],
        |row| row.get(0),
    )?;
    if !held {
        return Ok(Vec::new());
    }
    let columns = match columns_of(conn, item, table) {
        Ok(columns) => columns,
        Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    Ok(columns
        .iter()
        .filter(|(_, column)| {
            column.get("type").and_then(Value::as_str) == Some(marfa_rules::schema::ITEM_KIND)
        })
        .map(|(name, _)| name.clone())
        .collect())
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
        .query_row_cached(
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
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload.to_string(),
            depends_on: &depends_on,
        },
    )?;
    conn.execute_cached(
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
    let seq: i64 =
        tx.query_row_cached("SELECT seq FROM queue WHERE id = ?1", [&queued.id], |row| {
            row.get(0)
        })?;
    let ids = record_laid(&tx, &queued.id, seq, item, table, &ops, &queued.queued_at)?;
    if laid {
        for id in &ids {
            lay(&tx, item, table, id)?;
        }
        tables::past_cap(&tx, item, table)?;
    }
    tx.commit()?;
    Ok(queued)
}

/// Records the rows the row write `write_id` names, with the operations it
/// makes on each, for laying over each row while it waits.
pub(crate) fn record_laid(
    conn: &Connection,
    write_id: &str,
    seq: i64,
    item: &str,
    table: &str,
    ops: &[Op],
    at: &str,
) -> Result<BTreeSet<String>> {
    let mut named = conn.prepare_cached(
        "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let ids: BTreeSet<String> = ops.iter().map(|op| op.id().to_string()).collect();
    for id in &ids {
        let on_row: Vec<Value> = ops
            .iter()
            .filter(|op| op.id() == id)
            .map(Op::printed)
            .collect();
        named.execute(params![
            write_id,
            seq,
            item,
            table,
            id,
            Value::Array(on_row).to_string(),
            at
        ])?;
    }
    Ok(ids)
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

/// `row` with `ops` laid over it. As the server marks them, a value written to
/// one of `item_columns` that is text is an item's id, and any other write to
/// a column clears the mark; an operation that leaves the values as they were
/// leaves the row, its marks and its time alone.
fn apply(
    row: Option<Held>,
    ops: &[Op],
    id: &str,
    at: &str,
    item_columns: &[String],
) -> Option<Held> {
    let mark = |refs: &mut Map<String, Value>, column: &String, value: &Value| {
        refs.remove(column);
        if value.is_string() && item_columns.contains(column) {
            refs.insert(column.clone(), value.clone());
        }
    };
    let mut row = row;
    for op in ops.iter().filter(|op| op.id() == id) {
        row = match (op, row) {
            (Op::Put { values, .. }, before) => {
                let put: Map<String, Value> = values
                    .iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(column, value)| (column.clone(), value.clone()))
                    .collect();
                if before.as_ref().is_some_and(|before| before.values == put) {
                    before
                } else {
                    let mut refs = Map::new();
                    for (column, value) in values {
                        mark(&mut refs, column, value);
                    }
                    Some(Held {
                        values: put,
                        withheld: before.map(|before| before.withheld).unwrap_or_default(),
                        refs,
                        updated_at: at.to_string(),
                    })
                }
            }
            (Op::Patch { values, .. }, Some(before)) => {
                let mut after = before.clone();
                for (column, value) in values {
                    mark(&mut after.refs, column, value);
                    if value.is_null() {
                        after.values.remove(column);
                    } else {
                        after.values.insert(column.clone(), value.clone());
                    }
                }
                if after.values == before.values {
                    Some(before)
                } else {
                    after.updated_at = at.to_string();
                    Some(after)
                }
            }
            (Op::Patch { .. }, None) => None,
            (Op::Delete { .. }, _) => None,
        };
    }
    row
}

fn beneath(conn: &Connection, item: &str, table: &str, id: &str) -> Result<Option<Option<Held>>> {
    let row: Option<Stored> = conn
        .prepare_cached(
            "SELECT body, withheld, refs, updated_at FROM rows_beneath
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
        )?
        .query_row(params![item, table, id], |row| {
            Ok(Stored {
                body: row.get(0)?,
                withheld: row.get(1)?,
                refs: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .optional()?;
    row.map(unstored).transpose()
}

/// A row as its columns of text keep it. A body of `None` is a row that is not there.
struct Stored {
    body: Option<String>,
    withheld: Option<String>,
    refs: Option<String>,
    updated_at: Option<String>,
}

fn stored(row: Option<&Held>) -> Result<Stored> {
    Ok(match row {
        Some(row) => Stored {
            body: Some(Value::Object(row.values.clone()).to_string()),
            withheld: (!row.withheld.is_empty())
                .then(|| serde_json::to_string(&row.withheld))
                .transpose()?,
            refs: (!row.refs.is_empty()).then(|| Value::Object(row.refs.clone()).to_string()),
            updated_at: Some(row.updated_at.clone()),
        },
        None => Stored {
            body: None,
            withheld: None,
            refs: None,
            updated_at: None,
        },
    })
}

fn unstored(row: Stored) -> Result<Option<Held>> {
    row.body
        .map(|body| {
            read_held(
                &body,
                row.withheld.as_deref(),
                row.refs.as_deref(),
                row.updated_at.unwrap_or_default(),
            )
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
    let row = stored(row)?;
    conn.prepare_cached(
        "INSERT INTO rows_beneath (item_id, name, id, body, withheld, refs, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (item_id, name, id) DO UPDATE SET
           body = excluded.body, withheld = excluded.withheld, refs = excluded.refs,
           updated_at = excluded.updated_at",
    )?
    .execute(params![
        item,
        table,
        id,
        row.body,
        row.withheld,
        row.refs,
        row.updated_at
    ])?;
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
                tables::HeldRow {
                    values: &row.values,
                    withheld: &row.withheld,
                    refs: &row.refs,
                    updated_at: &row.updated_at,
                },
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
            conn.execute_cached(
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
    let item_columns = item_columns(conn, item, table)?;
    let shown = laid.iter().fold(under, |row, (_, ops, at)| {
        apply(row, ops, id, at, &item_columns)
    });
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

/// Where any write is laid over the row: the ids `answered` reads one by one.
pub(crate) fn laid_or_beneath(conn: &Connection, item: &str, table: &str) -> Result<Vec<String>> {
    let mut query = conn.prepare_cached(
        "SELECT id FROM rows_laid WHERE item_id = ?1 AND name = ?2
         UNION SELECT id FROM rows_beneath WHERE item_id = ?1 AND name = ?2",
    )?;
    let rows = query.query_map(params![item, table], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The row as the server last answered it, as `(body, withheld, updated_at)`:
/// beneath the writes laid over it, with each the server took laid back on at
/// its batch's time. `None` where the server holds none.
pub(crate) fn answered(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
) -> Result<Option<(String, Option<String>, String)>> {
    let under = match beneath(conn, item, table, id)? {
        Some(under) => under,
        None => held_row(conn, item, table, id)?,
    };
    let mut query = conn.prepare_cached(
        "SELECT ops, at FROM rows_laid
          WHERE item_id = ?1 AND name = ?2 AND id = ?3 AND batch IS NOT NULL
          ORDER BY seq",
    )?;
    let taken = query
        .query_map(params![item, table, id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut row = under;
    for (ops, at) in taken {
        let ops = queued_ops(&json!({ "operations": serde_json::from_str::<Value>(&ops)? }))?;
        row = apply(row, &ops, id, &at, &[]);
    }
    let row = stored(row.as_ref())?;
    Ok(row
        .body
        .map(|body| (body, row.withheld, row.updated_at.unwrap_or_default())))
}

/// A row as `(body, withheld, updated_at)`.
pub(crate) type RowText = (String, Option<String>, String);

/// `row` with the operations on it in `ops` laid over it at `at`, or at its
/// own time where `at` is `None`. `None` where they leave no row.
pub(crate) fn laid_on(
    row: Option<RowText>,
    ops: &[Op],
    id: &str,
    at: Option<&str>,
) -> Result<Option<RowText>> {
    let row = row
        .map(|(body, withheld, updated_at)| read_held(&body, withheld.as_deref(), None, updated_at))
        .transpose()?;
    let at = at
        .map(str::to_string)
        .or_else(|| row.as_ref().map(|row| row.updated_at.clone()))
        .unwrap_or_default();
    let row = stored(apply(row, ops, id, &at, &[]).as_ref())?;
    Ok(row
        .body
        .map(|body| (body, row.withheld, row.updated_at.unwrap_or_default())))
}

/// The operations on the row of the row writes sent with no answer
/// recorded, oldest first.
pub(crate) fn unanswered_ops(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
) -> Result<Vec<Op>> {
    let mut query = conn.prepare_cached(&format!(
        "SELECT l.ops FROM rows_laid l JOIN queue q ON q.id = l.write_id
          WHERE l.item_id = ?1 AND l.name = ?2 AND l.id = ?3 AND l.batch IS NULL
            AND {UNANSWERED}
          ORDER BY l.seq"
    ))?;
    let laid = query
        .query_map(params![item, table, id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ops = Vec::new();
    for laid in laid {
        ops.extend(queued_ops(
            &json!({ "operations": serde_json::from_str::<Value>(&laid)? }),
        )?);
    }
    Ok(ops)
}

/// The most a kept write carries, so the drain can join it to no other and
/// still send it whole.
const KEPT_BYTES: usize = crate::http::REQUEST_LIMIT / 2;

/// Queues `ops` on the table as writes blocked `server_restored`
/// (`device/restored-rows-kept`): sent before every row write to the table
/// not yet sent, and laid beneath them. A write that follows one only orders
/// behind it, so withdrawing a kept write refuses none of them.
pub(crate) fn keep(conn: &Connection, item: &str, table: &str, ops: &[Op]) -> Result<Vec<String>> {
    if ops.is_empty() {
        return Ok(Vec::new());
    }
    let mut chunks: Vec<Vec<Op>> = Vec::new();
    let mut bytes = 0;
    for op in ops {
        let size = op.printed().to_string().len();
        match chunks.last_mut() {
            Some(chunk) if chunk.len() < rows::MAX_OPERATIONS && bytes + size <= KEPT_BYTES => {
                chunk.push(op.clone());
                bytes += size;
            }
            _ => {
                chunks.push(vec![op.clone()]);
                bytes = size;
            }
        }
    }
    let waiting = format!(
        "kind IN ('{}', '{}') AND item_id = ?1 AND row_table = ?2
         AND (verdict IS NULL OR verdict IN ('{}', '{}'))",
        WriteKind::WriteRows.as_str(),
        WriteKind::UndoRows.as_str(),
        Verdict::Blocked.as_str(),
        Verdict::Dead.as_str(),
    );
    // A write already sent cannot be held back, so the kept ones follow it.
    let mut ahead: Option<String> = conn
        .query_row_cached(
            &format!("SELECT id FROM queue WHERE {waiting} AND sent = 1 ORDER BY seq DESC LIMIT 1"),
            params![item, table],
            |row| row.get(0),
        )
        .optional()?;
    let heads: Vec<String> = {
        let mut query = conn.prepare_cached(&format!(
            "SELECT id FROM queue AS w WHERE {waiting} AND sent = 0
               AND NOT EXISTS (SELECT 1 FROM queue AS a
                                WHERE a.id = w.follows AND a.sent = 0 AND a.item_id = w.item_id
                                  AND a.row_table = w.row_table AND a.kind IN ('{}', '{}')
                                  AND (a.verdict IS NULL OR a.verdict IN ('{}', '{}')))",
            WriteKind::WriteRows.as_str(),
            WriteKind::UndoRows.as_str(),
            Verdict::Blocked.as_str(),
            Verdict::Dead.as_str(),
        ))?;
        let rows = query.query_map(params![item, table], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let behind: Vec<String> = {
        let mut query = conn.prepare_cached(&format!(
            "SELECT id FROM queue WHERE {waiting} AND sent = 0 ORDER BY seq"
        ))?;
        let rows = query.query_map(params![item, table], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let lowest: Option<i64> = conn.query_row_cached(
        "SELECT MIN(seq) FROM rows_laid WHERE item_id = ?1 AND name = ?2",
        params![item, table],
        |row| row.get(0),
    )?;
    let depends_on = store::untaken_creates_for_item(conn, item)?;
    let count = chunks.len() as i64;
    let mut kept = Vec::with_capacity(chunks.len());
    for (at, chunk) in (0_i64..).zip(&chunks) {
        let payload = json!({ "operations": chunk.iter().map(Op::printed).collect::<Vec<_>>() });
        let queued = store::enqueue(
            conn,
            &store::NewWrite {
                kind: WriteKind::WriteRows,
                item_id: Some(item),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: &payload.to_string(),
                depends_on: &depends_on,
            },
        )?;
        conn.execute_cached(
            "UPDATE queue SET row_table = ?2, follows = ?3 WHERE id = ?1",
            params![queued.id, table, ahead],
        )?;
        let seq = match lowest {
            Some(lowest) => lowest - count + at,
            None => {
                conn.query_row_cached("SELECT seq FROM queue WHERE id = ?1", [&queued.id], |row| {
                    row.get(0)
                })?
            }
        };
        record_laid(conn, &queued.id, seq, item, table, chunk, &queued.queued_at)?;
        store::record_verdict(
            conn,
            &queued.id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(crate::model::BlockedReason::ServerRestored.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
        ahead = Some(queued.id.clone());
        kept.push(queued.id);
    }
    for head in heads {
        conn.execute_cached(
            "UPDATE queue SET follows = ?2 WHERE id = ?1",
            params![head, ahead],
        )?;
    }
    put_ahead(conn, &kept, &behind)?;
    Ok(kept)
}

/// Gives the kept writes the places in the queue of the unsent row writes to
/// their table, which move behind them, laid at their new places: a drain
/// walks the queue in `seq` order and sends the row writes behind one it
/// sends in the same request.
fn put_ahead(conn: &Connection, kept: &[String], behind: &[String]) -> Result<()> {
    if behind.is_empty() {
        return Ok(());
    }
    let order: Vec<&String> = kept.iter().chain(behind).collect();
    let mut places = Vec::with_capacity(order.len());
    for id in &order {
        let seq: i64 =
            conn.query_row_cached("SELECT seq FROM queue WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        places.push(seq);
    }
    places.sort_unstable();
    // Out of the way first, as `seq` is the key and every place is taken.
    for id in &order {
        conn.execute_cached("UPDATE queue SET seq = -seq WHERE id = ?1", [id])?;
    }
    for (at, (id, seq)) in order.iter().zip(places).enumerate() {
        conn.execute_cached("UPDATE queue SET seq = ?2 WHERE id = ?1", params![id, seq])?;
        // `clashes` reads a write's own operations by this place. The kept
        // writes stay laid beneath every write to the table.
        if at >= kept.len() {
            conn.execute_cached(
                "UPDATE rows_laid SET seq = ?2 WHERE write_id = ?1",
                params![id, seq],
            )?;
        }
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
    conn.execute_cached("DELETE FROM rows_dirty", [])?;
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

/// A row as the server answers it.
pub(crate) struct ServerRow<'a> {
    pub values: &'a Map<String, Value>,
    pub withheld: &'a [String],
    /// The columns written as item ids, which the server did not withhold.
    pub refs: &'a [String],
    pub updated_at: &'a str,
}

/// Beneath the writes laid over the row, where any are (`device/table-write-over-server`).
pub(crate) fn take_server_row(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
    row: Option<ServerRow<'_>>,
) -> Result<bool> {
    let named = conn
        .prepare_cached(
            "SELECT 1 FROM rows_laid WHERE item_id = ?1 AND name = ?2 AND id = ?3 LIMIT 1",
        )?
        .query_row(params![item, table, id], |_| Ok(()))
        .optional()?
        .is_some();
    if named && whole(conn, item, table)? {
        let row = row
            .map(|row| {
                let mut values = row.values.clone();
                for column in row.withheld {
                    values.remove(column);
                }
                Ok::<_, CoreError>(Held {
                    refs: tables::refs_of(&values, row.refs)?,
                    values,
                    withheld: row.withheld.to_vec(),
                    updated_at: row.updated_at.to_string(),
                })
            })
            .transpose()?;
        set_beneath(conn, item, table, id, row.as_ref())?;
        lay(conn, item, table, id)?;
        return Ok(true);
    }
    match row {
        Some(row) => {
            let refs = tables::refs_of(row.values, row.refs)?;
            tables::hold_row(
                conn,
                item,
                table,
                id,
                tables::HeldRow {
                    values: row.values,
                    withheld: row.withheld,
                    refs: &refs,
                    updated_at: row.updated_at,
                },
            )
        }
        None => tables::delete_row(conn, item, table, id),
    }
}

/// A fill after this reads the batches taken before it, so none is waited for.
pub(crate) fn forget_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    conn.execute_cached(
        "DELETE FROM rows_beneath WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    conn.execute_cached(
        "DELETE FROM rows_laid WHERE item_id = ?1 AND name = ?2 AND batch IS NOT NULL",
        params![item, table],
    )?;
    conn.execute_cached(
        "DELETE FROM rows_seen WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    conn.execute_cached(
        "DELETE FROM rows_seen_beneath WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    Ok(())
}

pub(crate) fn forget_item(conn: &Connection, item: &str) -> Result<()> {
    conn.execute_cached("DELETE FROM rows_beneath WHERE item_id = ?1", [item])?;
    conn.execute_cached(
        "DELETE FROM rows_laid WHERE item_id = ?1 AND batch IS NOT NULL",
        [item],
    )?;
    conn.execute_cached("DELETE FROM rows_seen WHERE item_id = ?1", [item])?;
    conn.execute_cached("DELETE FROM rows_seen_beneath WHERE item_id = ?1", [item])?;
    Ok(())
}

pub(crate) fn forget_all(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM rows_beneath; DELETE FROM rows_seen; DELETE FROM rows_seen_beneath;
         DELETE FROM rows_laid WHERE batch IS NOT NULL;",
    )?;
    Ok(())
}

/// Sent, with no answer recorded; the `queue_rows_seen_*` triggers test the same.
const UNANSWERED: &str = "q.sent = 1 AND (q.verdict IS NULL OR q.verdict IN ('blocked', 'dead'))";

/// Each up to `MAX_ROW_BYTES`; past it a row's oldest state goes, unjudged.
pub(crate) const ROW_STATES_KEPT: i64 = 8;

/// The answer may identify this event as the write's own batch.
pub(crate) fn before_batch<'a>(
    conn: &Connection,
    item: &str,
    table: &str,
    batch: &str,
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let known = conn
        .prepare_cached("SELECT 1 FROM rows_laid WHERE batch = ?1 LIMIT 1")?
        .query_row([batch], |_| Ok(()))
        .optional()?
        .is_some();
    if known || !whole(conn, item, table)? {
        return Ok(());
    }
    for id in ids {
        let sent = conn
            .prepare_cached(&format!(
                "SELECT 1 FROM rows_laid l JOIN queue q ON q.id = l.write_id
                  WHERE l.item_id = ?1 AND l.name = ?2 AND l.id = ?3 AND l.batch IS NULL
                    AND q.kind = ?4 AND {UNANSWERED}
                  LIMIT 1"
            ))?
            .query_row(
                params![item, table, id, WriteKind::WriteRows.as_str()],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !sent {
            continue;
        }
        let under = match beneath(conn, item, table, id)? {
            Some(under) => under,
            None => held_row(conn, item, table, id)?,
        };
        let under = stored(under.as_ref())?;
        let kept = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO rows_seen_beneath
                   (batch, id, item_id, name, body, withheld, updated_at, seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                   (SELECT COALESCE(MAX(seq), 0) + 1 FROM rows_seen_beneath
                     WHERE item_id = ?3 AND name = ?4 AND id = ?2))",
            )?
            .execute(params![
                batch,
                id,
                item,
                table,
                under.body,
                under.withheld,
                under.updated_at
            ])?;
        if kept > 0 {
            conn.prepare_cached(
                "DELETE FROM rows_seen_beneath
                  WHERE item_id = ?1 AND name = ?2 AND id = ?3
                    AND seq <= (SELECT MAX(seq) FROM rows_seen_beneath
                                 WHERE item_id = ?1 AND name = ?2 AND id = ?3) - ?4",
            )?
            .execute(params![item, table, id, ROW_STATES_KEPT])?;
        }
    }
    Ok(())
}

fn take_seen_beneath(conn: &Connection, batch: &str) -> Result<BTreeMap<String, Option<Held>>> {
    let mut query = conn.prepare_cached(
        "DELETE FROM rows_seen_beneath WHERE batch = ?1
         RETURNING id, body, withheld, updated_at",
    )?;
    let rows = query.query_map([batch], |row| {
        Ok((
            row.get::<_, String>(0)?,
            (row.get(1)?, row.get(2)?, row.get(3)?),
        ))
    })?;
    let mut kept = BTreeMap::new();
    for row in rows {
        let (id, (body, withheld, updated_at)) = row?;
        kept.insert(
            id,
            unstored(Stored {
                body,
                withheld,
                refs: None,
                updated_at,
            })?,
        );
    }
    Ok(kept)
}

/// Keeps `batch` as seen while a sent row write to the table awaits its
/// answer, which may be the batch's own.
pub(crate) fn seen_first(conn: &Connection, item: &str, table: &str, batch: &str) -> Result<()> {
    let waiting = conn
        .prepare_cached(&format!(
            "SELECT 1 FROM queue q WHERE q.kind = ?1 AND q.item_id = ?2 AND q.row_table = ?3
               AND {UNANSWERED} LIMIT 1"
        ))?
        .query_row(params![WriteKind::WriteRows.as_str(), item, table], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    if waiting {
        conn.execute_cached(
            "INSERT OR IGNORE INTO rows_seen (batch, item_id, name) VALUES (?1, ?2, ?3)",
            params![batch, item, table],
        )?;
    }
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
        return seen_first(conn, item, table, batch);
    }
    // A table still filling takes the server's rows as they come.
    if !whole(conn, item, table)? {
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
    let (key, spent): (String, Option<String>) = conn.query_row_cached(
        "SELECT idempotency_key, spent_keys FROM queue WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut keys: Vec<String> = match spent {
        Some(json) => serde_json::from_str(&json)?,
        None => Vec::new(),
    };
    keys.push(key);
    conn.execute_cached(
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
        .query_row_cached(
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
        conn.execute_cached(
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
                AND last_sent_seq IS NOT NULL AND (verdict IS NULL OR verdict IN (?4, ?5))",
        )?;
        let rows = query.query_map(
            params![
                item,
                table,
                WriteKind::WriteRows.as_str(),
                Verdict::Blocked.as_str(),
                Verdict::Dead.as_str()
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
        conn.execute_cached(
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
    let seen = match batch {
        Some(batch) => conn.execute_cached("DELETE FROM rows_seen WHERE batch = ?1", [batch])? > 0,
        None => false,
    };
    // Applied first, the batch's own event left beneath what the batch made.
    let replaced = match batch {
        Some(batch) if seen => Some(take_seen_beneath(conn, batch)?),
        _ => None,
    };
    let laid = whole(conn, item, table)?;
    // Kept until its event too, so rows set aside while the table fills hold it.
    let filling = tables::state(conn, item, table)?.as_deref() == Some(tables::FILLING);
    let item_columns = if laid {
        item_columns(conn, item, table)?
    } else {
        Vec::new()
    };
    let mut written = Vec::with_capacity(writes.len());
    let mut conflicts = Vec::with_capacity(writes.len());
    for taken in writes {
        let ops = queued_ops(&taken.write.body)?;
        conflicts.push(if laid {
            clashes(conn, item, table, taken.write, &ops, replaced.as_ref())?
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
            let waits = (laid || filling) && kept_whole && changed.contains(id) && !seen;
            if laid && kept_whole && !changed.contains(id) {
                let under = beneath(conn, item, table, id)?.flatten();
                let at = under.as_ref().map(|row| row.updated_at.clone());
                let left = apply(under, ops, id, &write.queued_at, &item_columns).map(|mut row| {
                    if let Some(at) = at {
                        row.updated_at = at;
                    }
                    row
                });
                set_beneath(conn, item, table, id, left.as_ref())?;
            }
            match (waits, batch) {
                (true, Some(batch)) => conn.execute_cached(
                    "UPDATE rows_laid SET batch = ?3 WHERE write_id = ?1 AND id = ?2",
                    params![write.id, id, batch],
                )?,
                _ => conn.execute_cached(
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

/// Null means no value; outer `None` means no operation sets the column.
fn sets<'a>(ops: &'a [Op], id: &str, column: &str) -> Option<Option<&'a Value>> {
    ops.iter()
        .rev()
        .filter(|op| op.id() == id)
        .find_map(|op| match op {
            Op::Delete { .. } => Some(None),
            Op::Put { values, .. } => Some(values.get(column).filter(|value| !value.is_null())),
            Op::Patch { values, .. } => values
                .get(column)
                .map(|value| (!value.is_null()).then_some(value)),
        })
}

/// Event-first answers are judged against the rows the batch replaced.
fn clashes(
    conn: &Connection,
    item: &str,
    table: &str,
    write: &QueuedWrite,
    ops: &[Op],
    replaced: Option<&BTreeMap<String, Option<Held>>>,
) -> Result<Vec<RowConflict>> {
    let Some(read) = store::read_of(conn, &write.id)?
        .and_then(|read| serde_json::from_str::<Value>(&read).ok())
        .and_then(|read| read.get("rows").and_then(Value::as_object).cloned())
    else {
        return Ok(Vec::new());
    };
    let seq: i64 =
        conn.query_row_cached("SELECT seq FROM queue WHERE id = ?1", [&write.id], |row| {
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
        let under = match replaced {
            None => beneath(conn, item, table, id)?.flatten(),
            Some(replaced) => match replaced.get(id) {
                Some(row) => row.clone(),
                None => continue,
            },
        };
        let before = laid_over(conn, item, table, id)?
            .into_iter()
            .filter(|(at, _, _)| *at < seq)
            .fold(under, |row, (_, ops, at)| apply(row, &ops, id, &at, &[]));
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
            if was != saw && sets(ops, id, column) != Some(was) {
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
            refs: Map::new(),
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
            &[],
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
            &[],
        )
        .unwrap();
        assert_eq!(put.values, values(json!({ "count": 3, "note": "a" })));
        assert_eq!(put.withheld, vec!["ref".to_string()]);
        assert_eq!(put.updated_at, "now");
    }

    #[test]
    fn a_write_marks_a_text_value_of_an_item_column_as_an_item_id_and_any_other_write_clears_it() {
        let id = "01a1b75e-2d9d-775a-930a-6b3d1207edae";
        let other = "019a0000-0000-7000-8000-000000000002";
        let item_columns = vec!["who".to_string(), "link".to_string()];
        let held = Held {
            values: values(json!({ "who": other, "link": other, "note": other })),
            withheld: Vec::new(),
            refs: values(json!({ "who": other, "link": other })),
            updated_at: "then".into(),
        };
        let patched = apply(
            Some(held),
            &[Op::Patch {
                id: id.into(),
                values: values(json!({ "who": "text", "link": 3, "note": other })),
            }],
            id,
            "now",
            &item_columns,
        )
        .unwrap();
        assert_eq!(
            patched.refs,
            values(json!({ "who": "text" })),
            "a text value of an item column is marked, a number clears the mark, a column that is not an item column is never marked"
        );
        let put = apply(
            Some(patched),
            &[Op::Put {
                id: id.into(),
                values: values(json!({ "link": other, "note": other })),
            }],
            id,
            "later",
            &item_columns,
        )
        .unwrap();
        assert_eq!(put.refs, values(json!({ "link": other })));
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
    fn a_whole_number_a_float_would_change_is_refused_naming_the_operation_and_the_column() {
        let columns = values(json!({
            "amount": { "type": "number" },
            "count": { "type": "integer" },
            "memo": { "type": "string" },
        }));
        for (sent, named, digits) in [
            (
                json!({ "amount": 9_007_199_254_740_993_i64 }),
                "operations.4.values.amount",
                "9007199254740993",
            ),
            (
                json!({ "amount": -9_007_199_254_740_993_i64 }),
                "operations.4.values.amount",
                "-9007199254740993",
            ),
            (
                json!({ "count": 18_446_744_073_709_551_615_u64 }),
                "operations.4.values.count",
                "18446744073709551615",
            ),
            (
                json!({ "memo": { "deep": [1, 1_152_921_504_606_846_976_i64] } }),
                "operations.4.values.memo.deep.1",
                "1152921504606846976",
            ),
        ] {
            let refused = judge_values(4, &columns, &values(sent), false, &[]).unwrap_err();
            assert!(
                matches!(&refused, CoreError::Validation { code, server: None, .. }
                    if code == "validation_error"),
                "{refused:?}"
            );
            let text = refused.to_string();
            assert!(text.contains(named), "{text}");
            assert!(
                text.contains(&format!("Must be a whole number that Marfa serves back with the same digits, not {digits}")),
                "{text}"
            );
        }
        // The witness: a whole number a float holds, a fraction and a large float are taken.
        for sent in [
            json!({ "amount": 9_007_199_254_740_992_i64 }),
            json!({ "amount": 1_152_921_504_606_847_000_u64 }),
            json!({ "amount": 1.5, "count": 9_007_199_254_740_991_i64 }),
            json!({ "amount": 1.234_567_890_123_456_8e29 }),
        ] {
            judge_values(0, &columns, &values(sent.clone()), false, &[]).unwrap_or_else(|error| {
                panic!("{sent}: {error}");
            });
        }
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
            let refused = judge_values(2, &columns, &values(sent), false, &[]).unwrap_err();
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

    fn kept(conn: &Connection) -> (Vec<String>, Vec<(String, String, i64)>) {
        let batches = conn
            .prepare("SELECT batch FROM rows_seen ORDER BY batch")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let states = conn
            .prepare("SELECT id, batch, seq FROM rows_seen_beneath ORDER BY id, seq")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        (batches, states)
    }

    fn sent_over(conn: &Connection, write: &str, seq: i64, row: &str) {
        conn.execute(
            "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at)
             VALUES (?1, ?2, 'write_rows', 'item', 'steps', ?2, '{}', 1, 'at')",
            params![seq, write],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
             VALUES (?1, ?2, 'item', 'steps', ?3, '[]', 'at')",
            params![write, seq, row],
        )
        .unwrap();
    }

    fn seen(conn: &Connection, batch: &str, row: &str) {
        before_batch(conn, "item", "steps", batch, [row]).unwrap();
        applied_batch(conn, "item", "steps", batch).unwrap();
    }

    #[test]
    fn a_write_moved_behind_kept_rows_still_finds_the_change_it_did_not_see() {
        const A: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f70";
        const B: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f71";
        // Unkept first: the witness that the same write conflicts.
        for kept in [false, true] {
            let conn = store::testing::conn();
            conn.execute(
                "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
                [],
            )
            .unwrap();
            // Another writer moved the count on after the person read it.
            let theirs = Held {
                values: values(json!({ "count": 5 })),
                withheld: Vec::new(),
                refs: Map::new(),
                updated_at: "2026-11-19T10:00:00.000Z".into(),
            };
            set_beneath(&conn, "item", "steps", A, Some(&theirs)).unwrap();
            let ops = json!([{ "op": "patch", "id": A, "values": { "count": 2 } }]);
            conn.execute(
                "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at, read)
                 VALUES (1, 'w', 'write_rows', 'item', 'steps', 'w', ?1, 0, 'at', ?2)",
                params![
                    json!({ "operations": ops }).to_string(),
                    json!({ "rows": { A: { "count": 1 } } }).to_string()
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
                 VALUES ('w', 1, 'item', 'steps', ?1, ?2, 'at')",
                [A, &ops.to_string()],
            )
            .unwrap();
            if kept {
                keep(&conn, "item", "steps", &[Op::Delete { id: B.into() }]).unwrap();
            }
            let write = store::queued_write(&conn, "w").unwrap().unwrap();
            let results = [json!({ "id": A, "outcome": "patched" })];
            let conflicts = taken(
                &conn,
                "item",
                "steps",
                None,
                &[Taken {
                    write: &write,
                    results: &results,
                }],
            )
            .unwrap();
            assert_eq!(
                conflicts,
                vec![vec![RowConflict {
                    row: A.into(),
                    column: "count".into(),
                }]],
                "kept {kept}"
            );
        }
    }

    #[test]
    fn a_write_the_server_leaves_unchanged_keeps_the_rows_marks_and_time() {
        const R: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f70";
        const X: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f71";
        // The column is no longer of type `item`, as after a forced type change.
        for (seq, ops) in [
            (1, json!([{ "op": "patch", "id": R, "values": { "link": X } }])),
            (
                2,
                json!([{ "op": "put", "id": R, "values": { "link": X, "count": 1 } }]),
            ),
        ] {
            let conn = store::testing::conn();
            conn.execute(
                "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
                [],
            )
            .unwrap();
            let held = Held {
                values: values(json!({ "link": X, "count": 1 })),
                withheld: Vec::new(),
                refs: values(json!({ "link": X })),
                updated_at: "2026-11-19T10:00:00.000Z".into(),
            };
            hold(&conn, "item", "steps", R, Some(&held)).unwrap();
            conn.execute(
                "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at)
                 VALUES (?1, 'w', 'write_rows', 'item', 'steps', 'w', ?2, 1, '2026-11-20T10:00:00.000Z')",
                params![seq, json!({ "operations": ops }).to_string()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
                 VALUES ('w', ?1, 'item', 'steps', ?2, ?3, '2026-11-20T10:00:00.000Z')",
                params![seq, R, ops.to_string()],
            )
            .unwrap();
            lay(&conn, "item", "steps", R).unwrap();
            assert_eq!(
                held_row(&conn, "item", "steps", R).unwrap().as_ref(),
                Some(&held),
                "{ops} while it waits"
            );
            let write = store::queued_write(&conn, "w").unwrap().unwrap();
            let results = [json!({ "id": R, "outcome": "unchanged" })];
            taken(
                &conn,
                "item",
                "steps",
                None,
                &[Taken {
                    write: &write,
                    results: &results,
                }],
            )
            .unwrap();
            assert_eq!(
                held_row(&conn, "item", "steps", R).unwrap().as_ref(),
                Some(&held),
                "{ops} once taken"
            );
            let named: Vec<String> = conn
                .prepare("SELECT target FROM row_refs WHERE row_id = ?1")
                .unwrap()
                .query_map([R], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(named, vec![X.to_string()], "{ops}");
        }
    }

    #[test]
    fn a_rows_kept_states_are_bounded_and_go_once_no_sent_write_waits_for_its_answer() {
        let conn = store::testing::conn();
        conn.execute(
            "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'whole')",
            [],
        )
        .unwrap();
        sent_over(&conn, "first", 1, "a");
        sent_over(&conn, "second", 2, "b");
        for batch in 0..=ROW_STATES_KEPT {
            seen(&conn, &format!("a{batch:02}"), "a");
        }
        seen(&conn, "b", "b");
        let (batches, states) = kept(&conn);
        assert_eq!(batches.len(), ROW_STATES_KEPT as usize + 2);
        let of_a: Vec<i64> = states
            .iter()
            .filter(|(row, _, _)| row == "a")
            .map(|(_, _, seq)| *seq)
            .collect();
        assert_eq!(of_a, (2..=ROW_STATES_KEPT + 1).collect::<Vec<_>>());

        for verdict in ["dead", "blocked"] {
            conn.execute(
                "UPDATE queue SET verdict = ?1 WHERE id = 'first'",
                [verdict],
            )
            .unwrap();
            assert_eq!(kept(&conn), (batches.clone(), states.clone()), "{verdict}");
        }
        conn.execute("UPDATE queue SET verdict = NULL WHERE id = 'first'", [])
            .unwrap();
        assert_eq!(kept(&conn), (batches.clone(), states.clone()));

        conn.execute(
            "UPDATE queue SET verdict = 'accepted' WHERE id = 'first'",
            [],
        )
        .unwrap();
        let (left, states) = kept(&conn);
        assert_eq!(left, batches, "the second write still waits on the table");
        assert_eq!(states, vec![("b".into(), "b".into(), 1)]);

        conn.execute("DELETE FROM queue WHERE id = 'second'", [])
            .unwrap();
        assert_eq!(kept(&conn), (Vec::new(), Vec::new()));

        sent_over(&conn, "third", 3, "c");
        seen(&conn, "c", "c");
        assert_eq!(kept(&conn).0, vec!["c".to_string()]);
        conn.execute("UPDATE queue SET sent = 0 WHERE id = 'third'", [])
            .unwrap();
        assert_eq!(kept(&conn), (Vec::new(), Vec::new()));
    }
}
