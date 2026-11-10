//! Table choices, fills, events, and reads in a working copy.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use marfa_rules::catalog::Catalog;
use marfa_rules::filter::{Expression, Term, parse_rows};
use marfa_rules::query::property_sort_expression;
use rusqlite::types::Value as Bound;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::CoreError;
use crate::http::Http;
use crate::wire::RowsEvent;
use crate::{Core, Result};

pub(crate) const ROWS_CHANGED: &str = "rows.changed";
pub const ROW_CAP: i64 = 100_000;
pub const BYTE_CAP: i64 = 67_108_864;
const FILL_PAGE: &str = "1000";
const FIRST_PAGE: i64 = 100;
const MAX_PAGE: i64 = 1000;

const OWED: &str = "owed";
const FILLING: &str = "filling";
const WHOLE: &str = "whole";
const ONLINE: &str = "online";

/// What one pass over the tables not yet whole did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct FillReport {
    /// Tables the pass left whole.
    pub whole: u64,
    /// Tables the pass found past the cap, which are read from the server.
    pub online: u64,
    /// Tables the pass left still to fill.
    pub unfilled: u64,
    pub pages: u64,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TableChoice {
    #[serde(rename = "type")]
    pub type_id: String,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeldTable {
    pub item: String,
    pub table: String,
    /// `owed`, `filling`, `whole` or `online`.
    pub state: String,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeldTables {
    pub choices: Vec<TableChoice>,
    pub tables: Vec<HeldTable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TableHold {
    #[serde(rename = "type")]
    pub type_id: String,
    pub table: String,
    pub was_held: bool,
    /// `None` where another call held the stream, whose fill takes it.
    pub fill: Option<FillReport>,
}

/// A read of a table's rows, as `GET /items/{id}/tables/{table}/rows` takes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowsAsked {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub direction: Option<String>,
}

fn choices(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut query = conn.prepare("SELECT type, name FROM table_choices ORDER BY type, name")?;
    let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn names(pattern: &str, type_id: &str, catalog: &Catalog) -> bool {
    if pattern == marfa_rules::query::EVERY_TYPE {
        !marfa_rules::folder::is_system(type_id)
    } else {
        catalog.matches(pattern, type_id)
    }
}

fn declared(conn: &Connection, type_id: &str) -> Result<Map<String, Value>> {
    match crate::catalog::item_type(conn, type_id) {
        Ok(resolved) => Ok(resolved.tables),
        Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => Ok(Map::new()),
        Err(error) => Err(error),
    }
}

fn wanted(
    conn: &Connection,
    catalog: &Catalog,
    chosen: &[(String, String)],
    type_id: &str,
) -> Result<Vec<String>> {
    let named: Vec<&String> = chosen
        .iter()
        .filter(|(pattern, _)| names(pattern, type_id, catalog))
        .map(|(_, table)| table)
        .collect();
    if named.is_empty() {
        return Ok(Vec::new());
    }
    let declared = declared(conn, type_id)?;
    let mut tables: Vec<String> = named
        .into_iter()
        .filter(|table| declared.contains_key(table.as_str()))
        .cloned()
        .collect();
    tables.sort();
    tables.dedup();
    Ok(tables)
}

fn drop_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM table_rows WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    conn.execute(
        "DELETE FROM item_tables WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    Ok(())
}

fn empty_rows(conn: &Connection, item: &str, table: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM table_rows WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    conn.execute(
        "UPDATE item_tables SET rows = 0, bytes = 0 WHERE item_id = ?1 AND name = ?2",
        params![item, table],
    )?;
    Ok(())
}

fn delete_row(conn: &Connection, item: &str, table: &str, id: &str) -> Result<()> {
    let held: Option<i64> = conn
        .query_row(
            "DELETE FROM table_rows WHERE item_id = ?1 AND name = ?2 AND id = ?3
             RETURNING length(CAST(body AS BLOB))",
            params![item, table, id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(bytes) = held {
        conn.execute(
            "UPDATE item_tables SET rows = rows - 1, bytes = bytes - ?3 WHERE item_id = ?1 AND name = ?2",
            params![item, table, bytes],
        )?;
    }
    Ok(())
}

fn set_state(
    conn: &Connection,
    item: &str,
    table: &str,
    state: &str,
    cursor: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE item_tables SET state = ?3, cursor = ?4 WHERE item_id = ?1 AND name = ?2",
        params![item, table, state, cursor],
    )?;
    Ok(())
}

pub(crate) fn drop_item(conn: &Connection, item: &str) -> Result<()> {
    conn.execute("DELETE FROM table_rows WHERE item_id = ?1", [item])?;
    conn.execute("DELETE FROM item_tables WHERE item_id = ?1", [item])?;
    Ok(())
}

// A stream gap invalidates every held row and page cursor.
pub(crate) fn owe_again(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM table_rows;
         UPDATE item_tables SET state = 'owed', cursor = NULL, rows = 0, bytes = 0
          WHERE state <> 'owed' OR cursor IS NOT NULL OR rows <> 0;",
    )?;
    Ok(())
}

pub(crate) fn reconcile_item(conn: &Connection, item: &str) -> Result<()> {
    let chosen = choices(conn)?;
    let type_id: Option<String> = conn
        .query_row("SELECT type FROM items WHERE id = ?1", [item], |row| {
            row.get(0)
        })
        .optional()?;
    let held = held_names(conn, item)?;
    if chosen.is_empty() && held.is_empty() {
        return Ok(());
    }
    let wanted = match type_id {
        Some(type_id) => wanted(conn, &crate::catalog::load(conn)?, &chosen, &type_id)?,
        None => Vec::new(),
    };
    for table in held.iter().filter(|table| !wanted.contains(table)) {
        drop_table(conn, item, table)?;
    }
    for table in wanted.iter().filter(|table| !held.contains(table)) {
        conn.execute(
            "INSERT INTO item_tables (item_id, name, state) VALUES (?1, ?2, 'owed')",
            params![item, table],
        )?;
    }
    Ok(())
}

fn held_names(conn: &Connection, item: &str) -> Result<Vec<String>> {
    let mut query = conn.prepare("SELECT name FROM item_tables WHERE item_id = ?1")?;
    let rows = query.query_map([item], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn reconcile_all(conn: &Connection) -> Result<()> {
    let chosen = choices(conn)?;
    if chosen.is_empty() {
        let holds = conn
            .query_row("SELECT 1 FROM item_tables LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_some();
        if holds {
            conn.execute_batch("DELETE FROM table_rows; DELETE FROM item_tables;")?;
        }
        return Ok(());
    }
    let catalog = crate::catalog::load(conn)?;
    let types: Vec<String> = {
        let mut query = conn.prepare("SELECT DISTINCT type FROM items")?;
        let rows = query.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut pairs: Vec<String> = Vec::new();
    for type_id in &types {
        for table in wanted(conn, &catalog, &chosen, type_id)? {
            pairs.push(type_id.clone());
            pairs.push(table);
        }
    }
    let wanted_sql = if pairs.is_empty() {
        "SELECT NULL AS type, NULL AS name WHERE 0".to_string()
    } else {
        let values = vec!["(?, ?)"; pairs.len() / 2].join(", ");
        format!("SELECT column1 AS type, column2 AS name FROM (VALUES {values})")
    };
    conn.execute(
        &format!(
            "DELETE FROM table_rows WHERE NOT EXISTS (
               SELECT 1 FROM items i JOIN ({wanted_sql}) w ON w.type = i.type
                WHERE i.id = table_rows.item_id AND w.name = table_rows.name)"
        ),
        params_from_iter(pairs.iter()),
    )?;
    conn.execute(
        &format!(
            "DELETE FROM item_tables WHERE NOT EXISTS (
               SELECT 1 FROM items i JOIN ({wanted_sql}) w ON w.type = i.type
                WHERE i.id = item_tables.item_id AND w.name = item_tables.name)"
        ),
        params_from_iter(pairs.iter()),
    )?;
    conn.execute(
        &format!(
            "INSERT INTO item_tables (item_id, name, state)
             SELECT i.id, w.name, 'owed' FROM items i JOIN ({wanted_sql}) w ON w.type = i.type
              WHERE NOT EXISTS (SELECT 1 FROM item_tables t WHERE t.item_id = i.id AND t.name = w.name)"
        ),
        params_from_iter(pairs.iter()),
    )?;
    Ok(())
}

pub(crate) fn choose(conn: &mut Connection, type_id: &str, table: &str) -> Result<bool> {
    let catalog = crate::catalog::load(conn)?;
    let held = crate::store::type_rows(conn)?;
    let declares = held
        .iter()
        .filter(|(id, _)| names(type_id, id, &catalog))
        .map(|(id, _)| declared(conn, id))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .any(|tables| tables.contains_key(table));
    if !declares {
        return Err(CoreError::Invalid(format!(
            "no type the copy holds under {type_id} declares a table {table}"
        )));
    }
    let tx = conn.transaction()?;
    let added = tx.execute(
        "INSERT OR IGNORE INTO table_choices (type, name) VALUES (?1, ?2)",
        params![type_id, table],
    )? > 0;
    reconcile_all(&tx)?;
    tx.commit()?;
    Ok(!added)
}

pub(crate) fn let_go(conn: &mut Connection, type_id: &str, table: &str) -> Result<bool> {
    let tx = conn.transaction()?;
    let removed = tx.execute(
        "DELETE FROM table_choices WHERE type = ?1 AND name = ?2",
        params![type_id, table],
    )? > 0;
    reconcile_all(&tx)?;
    tx.commit()?;
    Ok(removed)
}

pub(crate) fn held(conn: &Connection) -> Result<HeldTables> {
    let choices = choices(conn)?
        .into_iter()
        .map(|(type_id, table)| TableChoice { type_id, table })
        .collect();
    let mut query =
        conn.prepare("SELECT item_id, name, state, rows FROM item_tables ORDER BY item_id, name")?;
    let tables = query
        .query_map([], |row| {
            Ok(HeldTable {
                item: row.get(0)?,
                table: row.get(1)?,
                state: row.get(2)?,
                rows: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(HeldTables { choices, tables })
}

pub(crate) fn owes(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM item_tables t JOIN items i ON i.id = t.item_id
              WHERE t.state IN ('owed', 'filling') AND i.state <> 'trashed' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn state_of(
    conn: &Connection,
    item: &str,
    table: &str,
) -> Result<Option<(String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT state, cursor FROM item_tables WHERE item_id = ?1 AND name = ?2",
            params![item, table],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn printed(value: &Value) -> Result<String> {
    marfa_rules::number::to_vec(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| CoreError::Store("a row's values did not print".into()))
}

fn invalid() -> CoreError {
    crate::reach::invalid()
}

fn hold_row(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
    values: &Map<String, Value>,
    withheld: &[String],
    updated_at: &str,
) -> Result<()> {
    let mut values = values.clone();
    for column in withheld {
        values.remove(column);
    }
    let withheld = (!withheld.is_empty())
        .then(|| serde_json::to_string(withheld))
        .transpose()?;
    let body = printed(&Value::Object(values))?;
    let before: Option<i64> = conn
        .query_row(
            "SELECT length(CAST(body AS BLOB)) FROM table_rows
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
            params![item, table, id],
            |row| row.get(0),
        )
        .optional()?;
    conn.execute(
        "INSERT INTO table_rows (item_id, name, id, body, withheld, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (item_id, name, id) DO UPDATE SET
           body = excluded.body, withheld = excluded.withheld, updated_at = excluded.updated_at",
        params![item, table, id, body, withheld, updated_at],
    )?;
    conn.execute(
        "UPDATE item_tables SET rows = rows + ?3, bytes = bytes + ?4 WHERE item_id = ?1 AND name = ?2",
        params![
            item,
            table,
            i64::from(before.is_none()),
            body.len() as i64 - before.unwrap_or(0)
        ],
    )?;
    Ok(())
}

fn hold_answered(conn: &Connection, item: &str, table: &str, row: &Value) -> Result<String> {
    let id = row.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    let values = row
        .get("values")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let updated_at = row
        .get("updated_at")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let withheld = withheld_of(row)?;
    hold_row(conn, item, table, id, values, &withheld, updated_at)?;
    Ok(id.to_string())
}

fn withheld_of(row: &Value) -> Result<Vec<String>> {
    match row.get("withheld") {
        None => Ok(Vec::new()),
        Some(Value::Array(columns)) => columns
            .iter()
            .map(|column| column.as_str().map(str::to_string).ok_or_else(invalid))
            .collect(),
        Some(_) => Err(invalid()),
    }
}

fn past_cap(conn: &Connection, item: &str, table: &str) -> Result<bool> {
    let (rows, bytes): (i64, i64) = conn.query_row(
        "SELECT rows, bytes FROM item_tables WHERE item_id = ?1 AND name = ?2",
        params![item, table],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if rows > ROW_CAP || bytes > BYTE_CAP {
        empty_rows(conn, item, table)?;
        set_state(conn, item, table, ONLINE, None)?;
        return Ok(true);
    }
    Ok(false)
}

fn is_refused_cursor(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation { code, .. } if code == "validation_error")
}

fn is_gone(error: &CoreError) -> bool {
    matches!(error, CoreError::NotFound { .. })
}

struct Owed {
    item: String,
    table: String,
    state: String,
    cursor: Option<String>,
}

fn next_owed(conn: &Connection, tried: &HashSet<(String, String)>) -> Result<Option<Owed>> {
    let mut query = conn.prepare(
        "SELECT t.item_id, t.name, t.state, t.cursor FROM item_tables t JOIN items i ON i.id = t.item_id
          WHERE t.state IN ('owed', 'filling') AND i.state <> 'trashed'
          ORDER BY t.item_id, t.name",
    )?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let key: (String, String) = (row.get(0)?, row.get(1)?);
        if !tried.contains(&key) {
            return Ok(Some(Owed {
                item: key.0,
                table: key.1,
                state: row.get(2)?,
                cursor: row.get(3)?,
            }));
        }
    }
    Ok(None)
}

/// Returns false when this pass has no table left to try.
fn step(
    core: &Core,
    http: &Http,
    tried: &mut HashSet<(String, String)>,
    report: &mut FillReport,
) -> Result<bool> {
    let Some(Owed {
        item,
        table,
        state,
        cursor,
    }) = next_owed(&*core.conn()?, tried)?
    else {
        return Ok(false);
    };
    let still = |conn: &Connection| -> Result<bool> {
        Ok(state_of(conn, &item, &table)? == Some((state.clone(), cursor.clone())))
    };
    if state == OWED {
        let listed = match http.item_tables(&item) {
            Err(error) if is_gone(&error) => {
                tried.insert((item, table));
                return Ok(true);
            }
            other => other?,
        };
        let summary = listed
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .iter()
            .find(|summary| summary.get("name").and_then(Value::as_str) == Some(table.as_str()));
        let Some(summary) = summary else {
            tried.insert((item, table));
            return Ok(true);
        };
        let count = summary
            .get("row_count")
            .and_then(Value::as_i64)
            .ok_or_else(invalid)?;
        let bytes = summary
            .get("bytes")
            .and_then(Value::as_i64)
            .ok_or_else(invalid)?;
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        if still(&tx)? {
            let next = if count > ROW_CAP || bytes > BYTE_CAP {
                report.online += 1;
                ONLINE
            } else if count == 0 {
                report.whole += 1;
                WHOLE
            } else {
                FILLING
            };
            empty_rows(&tx, &item, &table)?;
            set_state(&tx, &item, &table, next, None)?;
            if next != FILLING {
                tried.insert((item, table));
            }
        }
        tx.commit()?;
        return Ok(true);
    }
    let mut params = vec![("limit", FILL_PAGE)];
    if let Some(cursor) = &cursor {
        params.push(("cursor", cursor.as_str()));
    }
    let page = match http.table_rows(&item, &table, &params) {
        Err(error) if cursor.is_some() && is_refused_cursor(&error) => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            if still(&tx)? {
                empty_rows(&tx, &item, &table)?;
                set_state(&tx, &item, &table, OWED, None)?;
            }
            tx.commit()?;
            return Ok(true);
        }
        Err(error) if is_gone(&error) => {
            tried.insert((item, table));
            return Ok(true);
        }
        other => other?,
    };
    let rows = page
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let next = match page.get("next_cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(next)) => Some(next.clone()),
        Some(_) => return Err(invalid()),
    };
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    if still(&tx)? {
        for row in rows {
            hold_answered(&tx, &item, &table, row)?;
        }
        report.pages += 1;
        report.rows += rows.len() as u64;
        if past_cap(&tx, &item, &table)? {
            report.online += 1;
            tried.insert((item.clone(), table.clone()));
        } else if let Some(next) = &next {
            set_state(&tx, &item, &table, FILLING, Some(next))?;
        } else {
            set_state(&tx, &item, &table, WHOLE, None)?;
            report.whole += 1;
            tried.insert((item.clone(), table.clone()));
        }
    }
    tx.commit()?;
    Ok(true)
}

// The caller holds the stream, excluding events between a page's read and write.
pub(crate) fn fill(core: &Core, stop: &AtomicBool) -> Result<FillReport> {
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        reconcile_all(&tx)?;
        tx.commit()?;
    }
    let http = core.http()?;
    let mut tried = HashSet::new();
    let mut report = FillReport::default();
    loop {
        crate::catch_up::refuse_if_stopped(stop)?;
        if !step(core, http, &mut tried, &mut report)? {
            break;
        }
    }
    report.unfilled = core
        .conn()?
        .query_row(
            "SELECT COUNT(*) FROM item_tables WHERE state IN ('owed', 'filling')",
            [],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64;
    Ok(report)
}

pub(crate) fn fill_step(core: &Core, tried: &mut HashSet<(String, String)>) -> Result<bool> {
    step(core, core.http()?, tried, &mut FillReport::default())
}

/// Returns None when the event needs no row read.
pub(crate) fn rows_to_read(
    core: &Core,
    event: &RowsEvent,
) -> Result<Option<HashMap<String, Value>>> {
    if event.values_included {
        return Ok(None);
    }
    let state = state_of(&*core.conn()?, &event.item.id, &event.table)?;
    if !matches!(state, Some((ref state, _)) if state == FILLING || state == WHOLE) {
        return Ok(None);
    }
    let http = core.http()?;
    let mut ids: Vec<&str> = event
        .rows
        .iter()
        .filter(|row| !row.deleted)
        .map(|row| row.id.as_str())
        .collect();
    ids.sort_unstable();
    let mut found = HashMap::new();
    let (Some(first), Some(last)) = (ids.first(), ids.last()) else {
        return Ok(Some(found));
    };
    let quoted = |id: &str| serde_json::to_string(id).map_err(CoreError::from);
    let filter = format!("id gte {} AND id lte {}", quoted(first)?, quoted(last)?);
    let wanted: HashSet<&str> = ids.iter().copied().collect();
    let mut cursor: Option<String> = None;
    loop {
        let mut params = vec![("limit", FILL_PAGE), ("filter", filter.as_str())];
        if let Some(cursor) = &cursor {
            params.push(("cursor", cursor.as_str()));
        }
        let page = http.table_rows(&event.item.id, &event.table, &params)?;
        for row in page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            let id = row.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
            if wanted.contains(id) {
                found.insert(id.to_string(), row.clone());
            }
        }
        match page.get("next_cursor") {
            Some(Value::String(next)) => cursor = Some(next.clone()),
            _ => break,
        }
    }
    Ok(Some(found))
}

/// Applies `rows.changed` in the transaction that moves the cursor past it.
pub(crate) fn apply(
    conn: &Connection,
    event: &RowsEvent,
    read: Option<&HashMap<String, Value>>,
) -> Result<bool> {
    let item = event.item.id.as_str();
    let table = event.table.as_str();
    let Some((state, _)) = state_of(conn, item, table)? else {
        return Ok(false);
    };
    match state.as_str() {
        ONLINE => {
            if event.rows.iter().any(|row| row.deleted) {
                set_state(conn, item, table, OWED, None)?;
            }
            return Ok(false);
        }
        FILLING | WHOLE => {}
        _ => return Ok(false),
    }
    for row in &event.rows {
        if row.deleted {
            delete_row(conn, item, table, &row.id)?;
            continue;
        }
        if event.values_included {
            let values = row.values.as_ref().ok_or_else(invalid)?;
            hold_row(
                conn,
                item,
                table,
                &row.id,
                values,
                &row.withheld,
                &event.last_activity_at,
            )?;
            continue;
        }
        let Some(read) = read else {
            // The table filled between the read and now: read it whole again.
            empty_rows(conn, item, table)?;
            set_state(conn, item, table, OWED, None)?;
            return Ok(true);
        };
        match read.get(&row.id) {
            Some(answered) => {
                hold_answered(conn, item, table, answered)?;
            }
            None => delete_row(conn, item, table, &row.id)?,
        }
    }
    past_cap(conn, item, table)?;
    Ok(true)
}

fn local_table(conn: &Connection, item: &str, table: &str) -> Result<Option<Map<String, Value>>> {
    let held: Option<(String, String)> = conn
        .query_row(
            "SELECT t.state, i.type FROM item_tables t JOIN items i ON i.id = t.item_id
              WHERE t.item_id = ?1 AND t.name = ?2 AND i.state <> 'trashed'",
            params![item, table],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((state, type_id)) = held else {
        return Ok(None);
    };
    if state != WHOLE {
        return Ok(None);
    }
    Ok(declared(conn, &type_id)?
        .get(table)
        .and_then(Value::as_object)
        .cloned())
}

fn marked(mut answer: Value, held: bool) -> Value {
    if let Some(object) = answer.as_object_mut() {
        object.insert("held".into(), held.into());
    }
    answer
}

fn refused(field: &str, message: impl Into<String>) -> CoreError {
    CoreError::Invalid(format!("{field}: {}", message.into()))
}

fn columns(definition: &Map<String, Value>) -> Map<String, Value> {
    definition
        .get("columns")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn expression(filter: &str, columns: &Map<String, Value>) -> Result<Expression> {
    let expression = parse_rows(filter).map_err(|error| refused("filter", error.message))?;
    for condition in &expression.conditions {
        if let Term::Property { name, .. } = &condition.term
            && !columns.contains_key(name)
        {
            return Err(refused(
                "filter",
                format!("the table declares no column \"{name}\""),
            ));
        }
    }
    Ok(expression)
}

fn bound_json(value: &Value) -> Bound {
    match value {
        Value::Null => Bound::Null,
        Value::Bool(flag) => Bound::Integer(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map(Bound::Integer)
            .or_else(|| number.as_f64().map(Bound::Real))
            .unwrap_or(Bound::Null),
        Value::String(text) => Bound::Text(text.clone()),
        other => Bound::Text(other.to_string()),
    }
}

fn json_of(bound: &Bound) -> Value {
    match bound {
        Bound::Null | Bound::Blob(_) => Value::Null,
        Bound::Integer(whole) => json!(whole),
        Bound::Real(real) => json!(real),
        Bound::Text(text) => json!(text),
    }
}

enum Key {
    Id,
    Updated,
    Column(String),
}

impl Key {
    fn of(sort: Option<&str>, columns: &Map<String, Value>) -> Result<Key> {
        match sort {
            None | Some("id") => Ok(Key::Id),
            Some("updated_at") => Ok(Key::Updated),
            Some(sort) => match sort.strip_prefix("values.") {
                Some(column) if columns.contains_key(column) => Ok(Key::Column(column.into())),
                _ => Err(refused(
                    "sort",
                    "sort is id, updated_at or values.<column> of a column the table declares",
                )),
            },
        }
    }

    fn expression(&self, values: &mut Vec<Value>) -> String {
        match self {
            Key::Id => "NULL".into(),
            Key::Updated => "r.updated_at".into(),
            Key::Column(column) => {
                let text = property_sort_expression("r.body", "?");
                values.extend(std::iter::repeat_n(
                    Value::String(format!("$.{column}")),
                    text.matches('?').count(),
                ));
                text
            }
        }
    }
}

fn scope(item: &str, table: &str, asked: &RowsAsked, descending: bool) -> String {
    let named = json!([
        item,
        table,
        asked.filter,
        asked.sort.as_deref().unwrap_or("id"),
        descending
    ]);
    hex::encode(&Sha256::digest(named.to_string().as_bytes())[..16])
}

fn cursor_of(scope: &str, key: &Value, id: &str) -> String {
    hex::encode(json!([scope, key, id]).to_string())
}

fn opened(scope: &str, cursor: &str) -> Result<(Value, String)> {
    let refused = || refused("cursor", "the cursor does not belong to this listing");
    let bytes = hex::decode(cursor).map_err(|_| refused())?;
    let Ok(Value::Array(parts)) = serde_json::from_slice::<Value>(&bytes) else {
        return Err(refused());
    };
    match parts.as_slice() {
        [Value::String(held), key, Value::String(id)] if held == scope => {
            Ok((key.clone(), id.clone()))
        }
        _ => Err(refused()),
    }
}

fn shown(id: String, body: &str, withheld: Option<String>, updated_at: String) -> Result<Value> {
    let values: Value = serde_json::from_str(body)?;
    let mut row = json!({ "id": id, "values": values, "updated_at": updated_at });
    if let Some(withheld) = withheld {
        row["withheld"] = serde_json::from_str(&withheld)?;
    }
    Ok(row)
}

fn page_from_copy(
    conn: &Connection,
    item: &str,
    table: &str,
    definition: &Map<String, Value>,
    asked: &RowsAsked,
) -> Result<Value> {
    let columns = columns(definition);
    let limit = match asked.limit {
        None => FIRST_PAGE,
        Some(limit) if (1..=MAX_PAGE).contains(&limit) => limit,
        Some(_) => {
            return Err(refused(
                "limit",
                format!("limit is a whole number from 1 to {MAX_PAGE}"),
            ));
        }
    };
    let descending = match asked.direction.as_deref() {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(_) => return Err(refused("direction", "direction is asc or desc")),
    };
    let filter = asked
        .filter
        .as_deref()
        .map(|filter| expression(filter, &columns))
        .transpose()?;
    let key = Key::of(asked.sort.as_deref(), &columns)?;
    let scope = scope(item, table, asked, descending);
    let position = asked
        .cursor
        .as_deref()
        .map(|cursor| opened(&scope, cursor))
        .transpose()?;
    let mut values: Vec<Value> = Vec::new();
    let key_sql = key.expression(&mut values);
    let mut sql = format!(
        "SELECT * FROM (SELECT r.id, r.body, r.withheld, r.updated_at, {key_sql} AS k
           FROM table_rows r WHERE r.item_id = ? AND r.name = ?"
    );
    values.push(Value::String(item.into()));
    values.push(Value::String(table.into()));
    if let Some(expression) = &filter {
        sql.push_str(" AND ");
        sql.push_str(&crate::filter::row_clause(expression, &mut values)?);
    }
    sql.push_str(") r WHERE 1 = 1");
    let after = if descending { "<" } else { ">" };
    if let Some((at, id)) = &position {
        match (&key, at) {
            (Key::Id, _) => {
                sql.push_str(&format!(" AND r.id {after} ?"));
                values.push(Value::String(id.clone()));
            }
            (_, Value::Null) => {
                sql.push_str(" AND k IS NULL AND r.id > ?");
                values.push(Value::String(id.clone()));
            }
            (Key::Updated, at) => {
                sql.push_str(&format!(" AND (k {after} ? OR (k = ? AND r.id > ?))"));
                values.extend([at.clone(), at.clone(), Value::String(id.clone())]);
            }
            (Key::Column(_), at) => {
                sql.push_str(&format!(
                    " AND (k IS NULL OR k {after} ? OR (k = ? AND r.id > ?))"
                ));
                values.extend([at.clone(), at.clone(), Value::String(id.clone())]);
            }
        }
    }
    let direction = if descending { "DESC" } else { "ASC" };
    sql.push_str(&match key {
        Key::Id => format!(" ORDER BY r.id {direction}"),
        Key::Updated => format!(" ORDER BY k {direction}, r.id ASC"),
        Key::Column(_) => format!(" ORDER BY k IS NULL, k {direction}, r.id ASC"),
    });
    sql.push_str(" LIMIT ?");
    values.push(json!(limit + 1));
    let mut query = conn.prepare(&sql)?;
    let bound: Vec<Bound> = values.iter().map(bound_json).collect();
    let mut found: Vec<(Value, Bound)> = query
        .query_map(params_from_iter(bound.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Bound>(4)?,
            ))
        })?
        .map(|row| {
            let (id, body, withheld, updated_at, key) = row?;
            Ok((shown(id, &body, withheld, updated_at)?, key))
        })
        .collect::<Result<_>>()?;
    let more = found.len() as i64 > limit;
    found.truncate(limit as usize);
    let next = match found.last().filter(|_| more) {
        Some((row, key)) => Value::String(cursor_of(
            &scope,
            &json_of(key),
            row.get("id").and_then(Value::as_str).unwrap_or_default(),
        )),
        None => Value::Null,
    };
    let data: Vec<Value> = found.into_iter().map(|(row, _)| row).collect();
    Ok(json!({ "data": data, "next_cursor": next }))
}

fn aggregate(kind: &str, way: &str, column: &str, values: &mut Vec<Value>) -> String {
    let path = Value::String(format!("$.{column}"));
    let held = |values: &mut Vec<Value>| {
        values.push(path.clone());
        "json_extract(r.body, ?)".to_string()
    };
    let number = |values: &mut Vec<Value>| {
        values.extend([path.clone(), path.clone()]);
        "CASE WHEN json_type(r.body, ?) IN ('integer', 'real') THEN json_extract(r.body, ?) END"
            .to_string()
    };
    match (way, kind) {
        ("count", _) => format!("COUNT({})", held(values)),
        ("sum", _) => format!("TOTAL({})", number(values)),
        ("average", _) => format!("AVG({})", number(values)),
        ("min", "date") => format!("MIN({})", held(values)),
        ("max", "date") => format!("MAX({})", held(values)),
        ("min", "datetime") => format!(
            "strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday({})))",
            held(values)
        ),
        ("max", "datetime") => format!(
            "strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday({})))",
            held(values)
        ),
        ("min", _) => format!("MIN({})", number(values)),
        _ => format!("MAX({})", number(values)),
    }
}

fn total_value(kind: &str, way: &str, bound: &Bound) -> Value {
    let integer = kind == "integer" || way == "count";
    match bound {
        Bound::Integer(count) => json!(count),
        Bound::Real(value)
            if integer && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 =>
        {
            json!(*value as i64)
        }
        Bound::Real(value) => json!(value),
        Bound::Text(text) => json!(text),
        Bound::Null | Bound::Blob(_) => Value::Null,
    }
}

fn totals_from_copy(
    conn: &Connection,
    item: &str,
    table: &str,
    definition: &Map<String, Value>,
    filter: Option<&str>,
) -> Result<Value> {
    let columns = columns(definition);
    let filter = filter
        .map(|filter| expression(filter, &columns))
        .transpose()?;
    let adding: Vec<(String, String, String)> = columns
        .iter()
        .filter_map(|(name, definition)| {
            let way = definition.get("adds_up")?.as_str()?;
            let kind = definition.get("type")?.as_str()?;
            marfa_rules::catalog::api_name(name)
                .then(|| (name.clone(), kind.to_string(), way.to_string()))
        })
        .collect();
    let mut values: Vec<Value> = Vec::new();
    let mut sql = "SELECT COUNT(*)".to_string();
    for (name, kind, way) in &adding {
        sql.push_str(", ");
        sql.push_str(&aggregate(kind, way, name, &mut values));
    }
    sql.push_str(" FROM table_rows r WHERE r.item_id = ? AND r.name = ?");
    values.push(Value::String(item.into()));
    values.push(Value::String(table.into()));
    if let Some(expression) = &filter {
        sql.push_str(" AND ");
        sql.push_str(&crate::filter::row_clause(expression, &mut values)?);
    }
    let bound: Vec<Bound> = values.iter().map(bound_json).collect();
    let found: Vec<Bound> = conn.query_row(&sql, params_from_iter(bound.iter()), |row| {
        (0..=adding.len())
            .map(|at| row.get::<_, Bound>(at))
            .collect()
    })?;
    let mut found = found.into_iter();
    let row_count = found.next().unwrap_or(Bound::Integer(0));
    let mut totals = Map::new();
    for (name, kind, way) in &adding {
        let bound = found.next().unwrap_or(Bound::Null);
        totals.insert(
            name.clone(),
            json!({ way.as_str(): total_value(kind, way, &bound) }),
        );
    }
    Ok(json!({
        "row_count": total_value("integer", "count", &row_count),
        "totals": totals,
    }))
}

pub(crate) fn rows(core: &Core, item: &str, table: &str, asked: &RowsAsked) -> Result<Value> {
    {
        let conn = core.conn()?;
        if let Some(definition) = local_table(&conn, item, table)? {
            return Ok(marked(
                page_from_copy(&conn, item, table, &definition, asked)?,
                true,
            ));
        }
    }
    let mut params: Vec<(&str, &str)> = Vec::new();
    let limit = asked.limit.map(|limit| limit.to_string());
    for (name, value) in [
        ("limit", limit.as_deref()),
        ("cursor", asked.cursor.as_deref()),
        ("filter", asked.filter.as_deref()),
        ("sort", asked.sort.as_deref()),
        ("direction", asked.direction.as_deref()),
    ] {
        if let Some(value) = value {
            params.push((name, value));
        }
    }
    Ok(marked(
        core.http()?.table_rows(item, table, &params)?,
        false,
    ))
}

pub(crate) fn row(core: &Core, item: &str, table: &str, row: &str) -> Result<Value> {
    {
        let conn = core.conn()?;
        if local_table(&conn, item, table)?.is_some() {
            let held: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT body, withheld, updated_at FROM table_rows
                      WHERE item_id = ?1 AND name = ?2 AND id = ?3",
                    params![item, table, row],
                    |found| Ok((found.get(0)?, found.get(1)?, found.get(2)?)),
                )
                .optional()?;
            return match held {
                Some((body, withheld, updated_at)) => Ok(marked(
                    shown(row.into(), &body, withheld, updated_at)?,
                    true,
                )),
                None => Err(CoreError::NotFound {
                    code: "row_not_found".into(),
                    message: format!("the table {table} holds no row {row}"),
                }),
            };
        }
    }
    Ok(marked(core.http()?.table_row(item, table, row)?, false))
}

pub(crate) fn totals(core: &Core, item: &str, table: &str, filter: Option<&str>) -> Result<Value> {
    {
        let conn = core.conn()?;
        if let Some(definition) = local_table(&conn, item, table)? {
            return Ok(marked(
                totals_from_copy(&conn, item, table, &definition, filter)?,
                true,
            ));
        }
    }
    let params: Vec<(&str, &str)> = filter
        .map(|filter| ("filter", filter))
        .into_iter()
        .collect();
    Ok(marked(
        core.http()?.table_totals(item, table, &params)?,
        false,
    ))
}
