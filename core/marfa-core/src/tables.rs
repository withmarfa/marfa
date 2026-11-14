//! Table choices, fills, events, and reads in a working copy.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use marfa_rules::catalog::Catalog;
use marfa_rules::filter::Expression;
use marfa_rules::filter::sql::{self, Adding, Bind, Sink};
use marfa_rules::query::property_sort_expression;
use rusqlite::types::Value as Bound;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CoreError;
use crate::http::Http;
use crate::reach::Context;
use crate::wire::RowsEvent;
use crate::{Core, Result};

pub(crate) const ROWS_CHANGED: &str = "rows.changed";
pub const ROW_CAP: i64 = 100_000;
pub const BYTE_CAP: i64 = 67_108_864;
const FILL_PAGE: &str = "1000";
const FIRST_PAGE: i64 = 100;
const MAX_PAGE: i64 = 1000;
/// The server's most conditions in one filter.
const OR_TERMS: usize = 10;
/// Held rows a read by id range may pass over: far cheaper than another request.
const SPAN_GAP: i64 = 100;
const REREAD_PAGE: i64 = 1000;

const OWED: &str = "owed";
const FILLING: &str = "filling";
pub(crate) const WHOLE: &str = "whole";
const ONLINE: &str = "online";

/// What one pass over the tables not yet whole did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct FillReport {
    /// Tables the pass left whole.
    pub whole: u64,
    /// Tables the pass found past the cap, which are read from the server.
    pub online: u64,
    /// Tables the pass left still to fill, the failed among them.
    pub unfilled: u64,
    pub pages: u64,
    pub rows: u64,
    /// Tables whose read failed, each left to the next pass.
    pub failed: u64,
    /// The last of them, and why.
    pub failure: Option<String>,
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

/// The tables every item of the type has: those it declares and, from
/// `core.table` down, the one each item keeps.
fn type_tables(conn: &Connection, catalog: &Catalog, type_id: &str) -> Result<Vec<String>> {
    let mut names: Vec<String> = match crate::catalog::item_type(conn, type_id) {
        Ok(resolved) => resolved.tables.into_iter().map(|(name, _)| name).collect(),
        Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => Vec::new(),
        Err(error) => return Err(error),
    };
    if catalog.keeps_own_table(type_id) {
        names.push(marfa_rules::schema::OWN_TABLE.to_string());
    }
    Ok(names)
}

/// An item's tables, with their columns: its type's and, from `core.table`
/// down, its own from its `columns`.
pub(crate) fn of_item(conn: &Connection, item: &str) -> Result<Map<String, Value>> {
    let (type_id, properties): (String, String) = conn.query_row(
        "SELECT type, properties FROM items WHERE id = ?1",
        [item],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let properties = match serde_json::from_str(&properties)? {
        Value::Object(properties) => properties,
        _ => Map::new(),
    };
    crate::catalog::item_tables(conn, &type_id, &properties)
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
    let declared = type_tables(conn, catalog, type_id)?;
    let mut tables: Vec<String> = named
        .into_iter()
        .filter(|table| declared.contains(table))
        .cloned()
        .collect();
    tables.sort();
    tables.dedup();
    Ok(tables)
}

fn drop_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    crate::row_writes::forget_table(conn, item, table)?;
    for sql in [
        "DELETE FROM table_rows WHERE item_id = ?1 AND name = ?2",
        "DELETE FROM rows_reread WHERE item_id = ?1 AND name = ?2",
        "DELETE FROM item_tables WHERE item_id = ?1 AND name = ?2",
    ] {
        conn.execute(sql, params![item, table])?;
    }
    Ok(())
}

fn owe_table(conn: &Connection, item: &str, table: &str) -> Result<()> {
    empty_rows(conn, item, table)?;
    set_state(conn, item, table, OWED, None)
}

fn empty_rows(conn: &Connection, item: &str, table: &str) -> Result<()> {
    crate::row_writes::forget_table(conn, item, table)?;
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

pub(crate) fn delete_row(conn: &Connection, item: &str, table: &str, id: &str) -> Result<bool> {
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
    Ok(held.is_some())
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
    crate::row_writes::forget_item(conn, item)?;
    for sql in [
        "DELETE FROM table_rows WHERE item_id = ?1",
        "DELETE FROM rows_reread WHERE item_id = ?1",
        "DELETE FROM item_tables WHERE item_id = ?1",
    ] {
        conn.execute(sql, [item])?;
    }
    Ok(())
}

/// Owes every table again, for a copy that missed events.
pub(crate) fn owe_again(conn: &Connection) -> Result<()> {
    crate::row_writes::forget_all(conn)?;
    conn.execute_batch(
        "DELETE FROM table_rows;
         DELETE FROM rows_reread;
         UPDATE item_tables SET state = 'owed', cursor = NULL, rows = 0, bytes = 0
          WHERE state <> 'owed' OR cursor IS NOT NULL OR rows <> 0;",
    )?;
    Ok(())
}

/// Only the holder of the stream may call this: a purge it is taking keeps
/// its re-read here.
pub(crate) fn forget_reread(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM rows_reread", [])?;
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
            .query_row(
                "SELECT 1 FROM item_tables UNION ALL SELECT 1 FROM rows_reread LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if holds {
            crate::row_writes::forget_all(conn)?;
            conn.execute_batch(
                "DELETE FROM table_rows; DELETE FROM rows_reread; DELETE FROM item_tables;",
            )?;
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
        "DELETE FROM rows_reread WHERE NOT EXISTS (
           SELECT 1 FROM item_tables t
            WHERE t.item_id = rows_reread.item_id AND t.name = rows_reread.name)",
        [],
    )?;
    conn.execute(
        "DELETE FROM rows_beneath WHERE NOT EXISTS (
           SELECT 1 FROM item_tables t
            WHERE t.item_id = rows_beneath.item_id AND t.name = rows_beneath.name)",
        [],
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
        .map(|(id, _)| type_tables(conn, &catalog, id))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .any(|tables| tables.iter().any(|name| name == table));
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

pub(crate) fn state(conn: &Connection, item: &str, table: &str) -> Result<Option<String>> {
    Ok(state_of(conn, item, table)?.map(|(state, _)| state))
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

pub(crate) fn hold_row(
    conn: &Connection,
    item: &str,
    table: &str,
    id: &str,
    values: &Map<String, Value>,
    withheld: &[String],
    updated_at: &str,
) -> Result<bool> {
    let mut values = values.clone();
    for column in withheld {
        values.remove(column);
    }
    let withheld = (!withheld.is_empty())
        .then(|| serde_json::to_string(withheld))
        .transpose()?;
    let targets: Vec<String> = values
        .values()
        .filter_map(Value::as_str)
        .filter(|text| marfa_rules::validation::id("value", text).is_ok())
        .map(str::to_string)
        .collect();
    let body = printed(&Value::Object(values))?;
    let held: Option<(String, Option<String>, String)> = conn
        .prepare_cached(
            "SELECT body, withheld, updated_at FROM table_rows
              WHERE item_id = ?1 AND name = ?2 AND id = ?3",
        )?
        .query_row(params![item, table, id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    if held.as_ref().is_some_and(|(was, was_withheld, was_at)| {
        *was == body && *was_withheld == withheld && was_at == updated_at
    }) {
        return Ok(false);
    }
    let before = held.map(|(was, _, _)| was.len() as i64);
    conn.prepare_cached(
        "INSERT INTO table_rows (item_id, name, id, body, withheld, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (item_id, name, id) DO UPDATE SET
           body = excluded.body, withheld = excluded.withheld, updated_at = excluded.updated_at",
    )?
    .execute(params![item, table, id, body, withheld, updated_at])?;
    conn.prepare_cached(
        "UPDATE item_tables SET rows = rows + ?3, bytes = bytes + ?4 WHERE item_id = ?1 AND name = ?2",
    )?
    .execute(params![
        item,
        table,
        i64::from(before.is_none()),
        body.len() as i64 - before.unwrap_or(0)
    ])?;
    if before.is_some() {
        conn.prepare_cached(
            "DELETE FROM row_refs WHERE item_id = ?1 AND name = ?2 AND row_id = ?3",
        )?
        .execute(params![item, table, id])?;
    }
    let mut named = conn.prepare_cached(
        "INSERT OR IGNORE INTO row_refs (item_id, name, row_id, target) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for target in &targets {
        named.execute(params![item, table, id, target])?;
    }
    Ok(true)
}

fn hold_answered(conn: &Connection, item: &str, table: &str, row: &Value) -> Result<bool> {
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
    crate::row_writes::unjudge(conn, item, table, Some(id))?;
    crate::row_writes::take_server_row(conn, item, table, id, Some((values, &withheld, updated_at)))
}

/// A row a read found gone.
fn read_gone(conn: &Connection, item: &str, table: &str, id: &str) -> Result<bool> {
    crate::row_writes::unjudge(conn, item, table, Some(id))?;
    crate::row_writes::take_server_row(conn, item, table, id, None)
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

pub(crate) fn past_cap(conn: &Connection, item: &str, table: &str) -> Result<bool> {
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

/// A table the copy holds whole, with the row writes still laid over it.
fn become_whole(conn: &Connection, item: &str, table: &str) -> Result<()> {
    set_state(conn, item, table, WHOLE, None)?;
    crate::row_writes::unjudge(conn, item, table, None)?;
    crate::row_writes::lay_table(conn, item, table)?;
    past_cap(conn, item, table)?;
    Ok(())
}

fn is_refused_cursor(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation { code, .. } if code == "validation_error")
}

/// The server's certified answer that the item or the table is not there to read.
fn is_gone(error: &CoreError) -> bool {
    matches!(error, CoreError::NotFound { code, .. }
        if code == "item_not_found" || code == "table_not_found")
}

struct Owed {
    item: String,
    table: String,
    state: String,
    cursor: Option<String>,
}

fn next_owed(
    conn: &Connection,
    waiting: &impl Fn(&(String, String)) -> bool,
) -> Result<Option<Owed>> {
    let mut query = conn.prepare_cached(
        "SELECT t.item_id, t.name, t.state, t.cursor FROM item_tables t JOIN items i ON i.id = t.item_id
          WHERE t.state IN ('owed', 'filling') AND i.state <> 'trashed'
          ORDER BY t.item_id, t.name",
    )?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let key: (String, String) = (row.get(0)?, row.get(1)?);
        if waiting(&key) {
            continue;
        }
        return Ok(Some(Owed {
            item: key.0,
            table: key.1,
            state: row.get(2)?,
            cursor: row.get(3)?,
        }));
    }
    Ok(None)
}

/// An answer about the one table, which leaves the others to fill.
fn fails_one_table(error: &CoreError) -> bool {
    matches!(
        error,
        CoreError::Server { .. }
            | CoreError::NotFound { .. }
            | CoreError::Forbidden { .. }
            | CoreError::Validation { .. }
            | CoreError::UnknownType { .. }
            | CoreError::Decoding(_)
    )
}

pub(crate) enum Step {
    Done,
    Moved,
    Failed(String),
}

/// The wait before a table whose read failed is read again, doubling with
/// each failure in a row (`device/table-fill-failed-again`).
pub(crate) const RETRY_FIRST: Duration = Duration::from_secs(30);
pub(crate) const RETRY_MOST: Duration = Duration::from_secs(10 * 60);

struct Retry {
    wait: Duration,
    due: Instant,
}

/// One pass over the tables not yet whole, in which a table whose read fails
/// is not asked for again until its wait has passed.
#[derive(Default)]
pub(crate) struct Pass {
    failed: HashMap<(String, String), Retry>,
    report: FillReport,
}

impl Pass {
    /// Whether a table is owed that may be read now. Forgets the failures
    /// whose wait has passed when none of them is still owed.
    pub(crate) fn owes(&mut self, conn: &Connection, now: Instant) -> Result<bool> {
        let owes = next_owed(conn, &|key| self.waiting(key, now))?.is_some();
        if !owes {
            self.failed.retain(|_, retry| retry.due > now);
        }
        Ok(owes)
    }

    pub(crate) fn retry_due(&self, now: Instant) -> bool {
        self.failed.values().any(|retry| retry.due <= now)
    }

    fn waiting(&self, key: &(String, String), now: Instant) -> bool {
        self.failed.get(key).is_some_and(|retry| retry.due > now)
    }

    pub(crate) fn step(
        &mut self,
        core: &Core,
        context: &Context,
        now: Instant,
        stop: &AtomicBool,
    ) -> Result<Step> {
        let Some(owed) = next_owed(&*core.conn()?, &|key| self.waiting(key, now))? else {
            self.failed.retain(|_, retry| retry.due > now);
            return Ok(Step::Done);
        };
        let key = (owed.item.clone(), owed.table.clone());
        match advance(core, context, &owed, &mut self.report, stop) {
            Ok(()) => {
                self.failed.remove(&key);
                Ok(Step::Moved)
            }
            Err(error) if fails_one_table(&error) => {
                let failure = format!("the table {} of {}: {error}", owed.table, owed.item);
                self.report.failure = Some(failure.clone());
                let wait = match self.failed.get(&key) {
                    Some(retry) => (retry.wait * 2).min(RETRY_MOST),
                    None => {
                        self.report.failed += 1;
                        RETRY_FIRST
                    }
                };
                self.failed.insert(
                    key,
                    Retry {
                        wait,
                        due: now.checked_add(wait).unwrap_or(now),
                    },
                );
                #[cfg(debug_assertions)]
                crate::fault::hold(|| "table-fill-failed");
                Ok(Step::Failed(failure))
            }
            Err(error) => Err(error),
        }
    }
}

/// A write may run more than once, so `report` counts only what committed.
fn advance(
    core: &Core,
    context: &Context,
    owed: &Owed,
    report: &mut FillReport,
    stop: &AtomicBool,
) -> Result<()> {
    let Owed {
        item,
        table,
        state,
        cursor,
    } = owed;
    let (item, table) = (item.as_str(), table.as_str());
    let http = context.http(core.http()?);
    let still = |conn: &Connection| -> Result<bool> {
        Ok(state_of(conn, item, table)? == Some((state.clone(), cursor.clone())))
    };
    let write = |change: &dyn Fn(&Connection) -> Result<()>| {
        crate::busy::transaction(core, context, stop, |tx| {
            if still(tx)? {
                change(tx)?;
            }
            Ok(())
        })
    };
    let gone = || write(&|tx| drop_table(tx, item, table));
    if state == OWED && !crate::store::untaken_creates_for_item(&*core.conn()?, item)?.is_empty() {
        let moved = crate::busy::transaction(core, context, stop, |tx| {
            if !still(tx)? {
                return Ok(false);
            }
            empty_rows(tx, item, table)?;
            become_whole(tx, item, table)?;
            Ok(true)
        })?;
        if moved {
            report.whole += 1;
        }
        return Ok(());
    }
    if state == OWED {
        let listed = match http.item_tables(item) {
            Err(error) if is_gone(&error) => return gone(),
            other => other?,
        };
        let summary = listed
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .iter()
            .find(|summary| summary.get("name").and_then(Value::as_str) == Some(table));
        let Some(summary) = summary else {
            return gone();
        };
        let count = summary
            .get("row_count")
            .and_then(Value::as_i64)
            .ok_or_else(invalid)?;
        let bytes = summary
            .get("bytes")
            .and_then(Value::as_i64)
            .ok_or_else(invalid)?;
        let next = if count > ROW_CAP || bytes > BYTE_CAP {
            ONLINE
        } else if count == 0 {
            WHOLE
        } else {
            FILLING
        };
        let moved = crate::busy::transaction(core, context, stop, |tx| {
            if !still(tx)? {
                return Ok(false);
            }
            empty_rows(tx, item, table)?;
            match next {
                WHOLE => become_whole(tx, item, table)?,
                _ => set_state(tx, item, table, next, None)?,
            }
            Ok(true)
        })?;
        if moved {
            match next {
                ONLINE => report.online += 1,
                WHOLE => report.whole += 1,
                _ => {}
            }
        }
        return Ok(());
    }
    let mut params = vec![("limit", FILL_PAGE)];
    if let Some(cursor) = cursor {
        params.push(("cursor", cursor.as_str()));
    }
    let page = match http.table_rows(item, table, &params) {
        Err(error) if cursor.is_some() && is_refused_cursor(&error) => {
            return write(&|tx| owe_table(tx, item, table));
        }
        Err(error) if is_gone(&error) => return gone(),
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
    let held = crate::busy::transaction(core, context, stop, |tx| {
        if !still(tx)? {
            return Ok(None);
        }
        #[cfg(debug_assertions)]
        crate::fault::gate("gate-table-page");
        for row in rows {
            hold_answered(tx, item, table, row)?;
        }
        Ok(Some(if past_cap(tx, item, table)? {
            ONLINE
        } else if let Some(next) = &next {
            set_state(tx, item, table, FILLING, Some(next))?;
            FILLING
        } else {
            become_whole(tx, item, table)?;
            WHOLE
        }))
    })?;
    if let Some(held) = held {
        report.pages += 1;
        report.rows += rows.len() as u64;
        match held {
            ONLINE => report.online += 1,
            WHOLE => report.whole += 1,
            _ => {}
        }
    }
    Ok(())
}

// The caller holds the stream, excluding events between a page's read and write.
pub(crate) fn fill(core: &Core, context: &Context, stop: &AtomicBool) -> Result<FillReport> {
    let filled = || -> Result<FillReport> {
        crate::busy::transaction(core, context, stop, reconcile_all)?;
        let mut pass = Pass::default();
        loop {
            crate::catch_up::refuse_if_stopped(stop)?;
            if matches!(
                pass.step(core, context, crate::clock::now(), stop)?,
                Step::Done
            ) {
                break;
            }
        }
        pass.report.unfilled = core
            .conn()?
            .query_row(
                "SELECT COUNT(*) FROM item_tables WHERE state IN ('owed', 'filling')",
                [],
                |row| row.get::<_, i64>(0),
            )?
            .max(0) as u64;
        Ok(pass.report)
    };
    filled().map_err(|error| context.failed(core, error).unwrap_or_else(|error| error))
}

/// What the server holds of rows the device asked for by id.
pub(crate) enum Named {
    Rows(HashMap<String, Value>),
    Gone,
    /// The server answered the read with an error about this table.
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
enum Read {
    Span(String, String),
    Ids(Vec<String>),
}

/// Reads ids close together in the copy as one id range, and the rest by id,
/// so the cost follows the ids asked, not the rows between them.
fn plan(ids: &[String], gap: &mut dyn FnMut(&str, &str) -> Result<i64>) -> Result<Vec<Read>> {
    let mut reads = Vec::new();
    let mut singles = Vec::new();
    let mut start = 0;
    for end in 1..=ids.len() {
        if end < ids.len() && gap(&ids[end - 1], &ids[end])? <= SPAN_GAP {
            continue;
        }
        if end - start > 1 {
            reads.push(Read::Span(ids[start].clone(), ids[end - 1].clone()));
        } else {
            singles.push(ids[start].clone());
        }
        start = end;
    }
    reads.extend(singles.chunks(OR_TERMS).map(|ids| Read::Ids(ids.to_vec())));
    Ok(reads)
}

fn filter_of(read: &Read) -> Result<String> {
    let quoted = |id: &str| serde_json::to_string(id).map_err(CoreError::from);
    Ok(match read {
        Read::Span(first, last) => {
            format!("id gte {} AND id lte {}", quoted(first)?, quoted(last)?)
        }
        Read::Ids(ids) => ids
            .iter()
            .map(|id| Ok(format!("id eq {}", quoted(id)?)))
            .collect::<Result<Vec<_>>>()?
            .join(" OR "),
    })
}

/// Hands `found` each asked row the server holds; false where the server
/// certifies the item or the table gone.
fn read_named(
    core: &Core,
    http: &Http,
    item: &str,
    table: &str,
    ids: &[String],
    found: &mut dyn FnMut(String, Value),
) -> Result<bool> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let reads = {
        let conn = core.conn()?;
        let mut between = conn.prepare_cached(
            "SELECT COUNT(*) FROM (SELECT 1 FROM table_rows
              WHERE item_id = ?1 AND name = ?2 AND id > ?3 AND id < ?4 LIMIT ?5)",
        )?;
        plan(&ids, &mut |after, before| {
            Ok(
                between.query_row(params![item, table, after, before, SPAN_GAP + 1], |row| {
                    row.get(0)
                })?,
            )
        })?
    };
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    for read in &reads {
        let filter = filter_of(read)?;
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("limit", FILL_PAGE), ("filter", filter.as_str())];
            if let Some(cursor) = &cursor {
                params.push(("cursor", cursor.as_str()));
            }
            let page = match http.table_rows(item, table, &params) {
                Err(error) if is_gone(&error) => return Ok(false),
                other => other?,
            };
            let Some(Value::Array(rows)) = page.get("data") else {
                return Err(invalid());
            };
            for row in rows {
                let id = row.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
                if wanted.contains(id) {
                    found(id.to_string(), row.clone());
                }
            }
            match page.get("next_cursor") {
                Some(Value::String(next)) => cursor = Some(next.clone()),
                _ => break,
            }
        }
    }
    Ok(true)
}

fn holds_rows(conn: &Connection, item: &str, table: &str) -> Result<bool> {
    Ok(matches!(state_of(conn, item, table)?,
        Some((state, _)) if state == FILLING || state == WHOLE))
}

/// Returns None when the event needs no row read.
pub(crate) fn rows_to_read(
    core: &Core,
    context: &Context,
    event: &RowsEvent,
) -> Result<Option<Named>> {
    if event.values_included || !holds_rows(&*core.conn()?, &event.item.id, &event.table)? {
        return Ok(None);
    }
    let ids: Vec<String> = event
        .rows
        .iter()
        .filter(|row| !row.deleted)
        .map(|row| row.id.clone())
        .collect();
    let mut rows = HashMap::new();
    let read = read_named(
        core,
        &context.http(core.http()?),
        &event.item.id,
        &event.table,
        &ids,
        &mut |id, row| {
            rows.insert(id, row);
        },
    );
    Ok(Some(match read {
        Ok(true) => Named::Rows(rows),
        Ok(false) => Named::Gone,
        Err(error) if fails_one_table(&error) => Named::Failed,
        Err(error) => return Err(error),
    }))
}

/// The tables a purge's re-read found gone or could not read; the rows it
/// read wait in `rows_reread`.
pub(crate) struct Reread {
    gone: Vec<(String, String)>,
    failed: Vec<(String, String)>,
}

/// The server withholds a purged item's id from a key that may not read every
/// type, so the held rows naming `target` are read again, a page at a time,
/// into `rows_reread`.
pub(crate) fn reread_naming(
    core: &Core,
    context: &Context,
    target: &str,
    stop: &AtomicBool,
) -> Result<Reread> {
    crate::busy::transaction(core, context, stop, forget_reread)?;
    let mut gone: Vec<(String, String)> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    let mut decided: HashSet<(String, String)> = HashSet::new();
    let mut after = (String::new(), String::new(), String::new());
    let mut http = None;
    loop {
        let named: Vec<(String, String, String)> = {
            let conn = core.conn()?;
            let mut query = conn.prepare_cached(
                "SELECT r.item_id, r.name, r.row_id FROM row_refs r
                   JOIN item_tables t ON t.item_id = r.item_id AND t.name = r.name
                  WHERE r.target = ?1 AND r.item_id <> ?1 AND t.state IN ('filling', 'whole')
                    AND (r.item_id, r.name, r.row_id) > (?2, ?3, ?4)
                  ORDER BY r.item_id, r.name, r.row_id LIMIT ?5",
            )?;
            query
                .query_map(
                    params![target, after.0, after.1, after.2, REREAD_PAGE],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?
                .collect::<rusqlite::Result<_>>()?
        };
        let Some(last) = named.last().cloned() else {
            break;
        };
        let http = match &http {
            Some(http) => http,
            None => http.insert(context.http(core.http()?)),
        };
        let mut tables: Vec<(String, String, Vec<String>)> = Vec::new();
        for (item, table, id) in named {
            match tables.last_mut() {
                Some((at, name, ids)) if *at == item && *name == table => ids.push(id),
                _ => tables.push((item, table, vec![id])),
            }
        }
        for (item, table, ids) in tables {
            if decided.contains(&(item.clone(), table.clone())) {
                continue;
            }
            let mut rows = HashMap::new();
            let read = read_named(core, http, &item, &table, &ids, &mut |id, row| {
                rows.insert(id, row);
            });
            match read {
                Ok(true) => {}
                Ok(false) => {
                    decided.insert((item.clone(), table.clone()));
                    gone.push((item, table));
                    continue;
                }
                Err(error) if fails_one_table(&error) => {
                    decided.insert((item.clone(), table.clone()));
                    failed.push((item, table));
                    continue;
                }
                Err(error) => return Err(error),
            }
            crate::busy::transaction(core, context, stop, |tx| {
                let mut staged = tx.prepare_cached(
                    "INSERT OR REPLACE INTO rows_reread (item_id, name, id, answer) VALUES (?1, ?2, ?3, ?4)",
                )?;
                for id in &ids {
                    let answer = rows.get(id).map(Value::to_string);
                    staged.execute(params![item, table, id, answer])?;
                }
                Ok(())
            })?;
        }
        after = last;
    }
    Ok(Reread { gone, failed })
}

/// Applies a purge's re-read in the purge event's transaction, answering the
/// tables it changed.
pub(crate) fn take_reread(conn: &Connection, reread: &Reread) -> Result<Vec<(String, String)>> {
    let mut changed: Vec<(String, String)> = Vec::new();
    for (item, table) in &reread.gone {
        if holds_rows(conn, item, table)? {
            drop_table(conn, item, table)?;
            changed.push((item.clone(), table.clone()));
        }
    }
    // Rows it holds may name the purged item as a key may no longer read it.
    for (item, table) in &reread.failed {
        if holds_rows(conn, item, table)? {
            owe_table(conn, item, table)?;
            changed.push((item.clone(), table.clone()));
        }
    }
    let staged: Vec<(String, String)> = {
        let mut query = conn.prepare("SELECT DISTINCT item_id, name FROM rows_reread")?;
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut read = conn.prepare(
        "SELECT id, answer FROM rows_reread WHERE item_id = ?1 AND name = ?2 ORDER BY id",
    )?;
    for (item, table) in staged {
        if !holds_rows(conn, &item, &table)? {
            continue;
        }
        let mut moved = false;
        let mut rows = read.query(params![item, table])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            moved |= match row.get::<_, Option<String>>(1)? {
                Some(answer) => {
                    hold_answered(conn, &item, &table, &serde_json::from_str(&answer)?)?
                }
                None => read_gone(conn, &item, &table, &id)?,
            };
        }
        if past_cap(conn, &item, &table)? || moved {
            changed.push((item, table));
        }
    }
    drop(read);
    forget_reread(conn)?;
    Ok(changed)
}

/// Applies `rows.changed` in the transaction that moves the cursor past it.
pub(crate) fn apply(conn: &Connection, event: &RowsEvent, read: Option<&Named>) -> Result<bool> {
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
    let read = match read {
        Some(Named::Gone) => {
            drop_table(conn, item, table)?;
            return Ok(true);
        }
        Some(Named::Failed) => {
            owe_table(conn, item, table)?;
            return Ok(true);
        }
        Some(Named::Rows(read)) => Some(read),
        None => None,
    };
    for row in &event.rows {
        if row.deleted {
            crate::row_writes::take_server_row(conn, item, table, &row.id, None)?;
            continue;
        }
        if event.values_included {
            let values = row.values.as_ref().ok_or_else(invalid)?;
            crate::row_writes::take_server_row(
                conn,
                item,
                table,
                &row.id,
                Some((values, &row.withheld, &event.last_activity_at)),
            )?;
            continue;
        }
        let Some(read) = read else {
            // Owed or online when the rows were read, so they were not.
            owe_table(conn, item, table)?;
            return Ok(true);
        };
        match read.get(&row.id) {
            Some(answered) => hold_answered(conn, item, table, answered)?,
            None => read_gone(conn, item, table, &row.id)?,
        };
    }
    crate::row_writes::applied_batch(conn, item, table, &event.batch)?;
    past_cap(conn, item, table)?;
    Ok(true)
}

fn local_table(conn: &Connection, item: &str, table: &str) -> Result<Option<Map<String, Value>>> {
    let state: Option<String> = conn
        .query_row(
            "SELECT t.state FROM item_tables t JOIN items i ON i.id = t.item_id
              WHERE t.item_id = ?1 AND t.name = ?2 AND i.state <> 'trashed'",
            params![item, table],
            |row| row.get(0),
        )
        .optional()?;
    if state.as_deref() != Some(WHOLE) {
        return Ok(None);
    }
    let tables = match of_item(conn, item) {
        Ok(tables) => tables,
        Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(tables.get(table).and_then(Value::as_object).cloned())
}

fn marked(mut answer: Value, held: bool) -> Value {
    if let Some(object) = answer.as_object_mut() {
        object.insert("held".into(), held.into());
    }
    answer
}

fn refused(field: &str, message: impl Into<String>) -> CoreError {
    CoreError::Validation {
        server: None,
        code: "validation_error".into(),
        message: format!("{field}: {}", message.into()),
        details: None,
    }
}

fn columns(definition: &Map<String, Value>) -> Map<String, Value> {
    definition
        .get("columns")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn expression(filter: &str, columns: &Map<String, Value>) -> Result<Expression> {
    sql::table_filter(filter, |name| columns.contains_key(name))
        .map_err(|error| refused("filter", error.message))
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
    /// A column named in `sort`, with the type the table declares for it.
    Column {
        name: String,
        kind: String,
    },
    /// The table's `order` column, read by the key the server keeps for it.
    Order {
        column: String,
        kind: String,
    },
}

impl Key {
    /// With no `sort`, the table's own `order` column, or `id` for a table that names none.
    fn of(sort: Option<&str>, definition: &Map<String, Value>) -> Result<Key> {
        let columns = columns(definition);
        let order = marfa_rules::schema::order_of(definition)
            .filter(|(column, _)| marfa_rules::schema::order_column_inlinable(column));
        let ordered = |column: &str| {
            order
                .clone()
                .filter(|(named, _)| named == column)
                .map(|(column, kind)| Key::Order { column, kind })
        };
        match sort {
            None => Ok(order.map_or(Key::Id, |(column, kind)| Key::Order { column, kind })),
            Some("id") => Ok(Key::Id),
            Some("updated_at") => Ok(Key::Updated),
            Some(sort) => match sort.strip_prefix("values.") {
                Some(column) if let Some(key) = ordered(column) => Ok(key),
                Some(column) if let Some(definition) = columns.get(column) => Ok(Key::Column {
                    name: column.into(),
                    kind: definition
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                }),
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
            Key::Column { name, kind }
                if marfa_rules::schema::ORDER_KINDS.contains(&kind.as_str())
                    && marfa_rules::schema::order_column_inlinable(name) =>
            {
                marfa_rules::schema::order_value_key_sql(kind, name, "r.body")
            }
            Key::Column { name, .. } => {
                let text = property_sort_expression("r.body", "?");
                values.extend(std::iter::repeat_n(
                    Value::String(format!("$.{name}")),
                    text.matches('?').count(),
                ));
                text
            }
            Key::Order { column, kind } => {
                marfa_rules::schema::order_value_key_sql(kind, column, "r.body")
            }
        }
    }

    /// What the key is called in a `sort`, which a cursor is tied to.
    fn label(&self) -> String {
        match self {
            Key::Id => "id".to_string(),
            Key::Updated => "updated_at".to_string(),
            Key::Column { name: column, .. } | Key::Order { column, .. } => {
                format!("values.{column}")
            }
        }
    }

    /// The type of value a cursor's position holds, which a cursor cannot outlive a change to.
    fn kind(&self) -> Option<String> {
        match self {
            Key::Id | Key::Updated => None,
            Key::Column { kind, .. } => Some(kind.clone()),
            Key::Order { column, kind } => Some(format!("{kind}:{column}")),
        }
    }
}

const SCOPE_BYTES: usize = 8;

fn scope(
    item: &str,
    table: &str,
    asked: &RowsAsked,
    key: &Key,
    descending: bool,
) -> [u8; SCOPE_BYTES] {
    let named = json!([
        item,
        table,
        asked.filter,
        key.label(),
        descending,
        key.kind()
    ]);
    let mut scope = [0; SCOPE_BYTES];
    scope.copy_from_slice(&Sha256::digest(named.to_string().as_bytes())[..SCOPE_BYTES]);
    scope
}

/// The scope, the row id (a UUID as 16 bytes) and the sort key as JSON, in URL-safe base64.
fn cursor_of(scope: &[u8; SCOPE_BYTES], key: &Value, id: &str) -> String {
    let mut bytes = scope.to_vec();
    match Uuid::parse_str(id) {
        Ok(uuid) if uuid.hyphenated().to_string() == id => {
            bytes.push(UUID_ID);
            bytes.extend_from_slice(uuid.as_bytes());
        }
        _ => {
            bytes.push(TEXT_ID);
            bytes.extend_from_slice(&(id.len() as u32).to_be_bytes());
            bytes.extend_from_slice(id.as_bytes());
        }
    }
    bytes.extend_from_slice(key.to_string().as_bytes());
    format!("{CURSOR_LEAD}{}", BASE64_URL_SAFE_NO_PAD.encode(bytes))
}

/// Every cursor starts with this letter, so a command line never reads one as a flag.
const CURSOR_LEAD: &str = "c";

const UUID_ID: u8 = 0;
const TEXT_ID: u8 = 1;

fn opened(scope: &[u8; SCOPE_BYTES], cursor: &str) -> Result<(Value, String)> {
    let refused = || refused("cursor", "the cursor does not belong to this listing");
    let bytes = cursor
        .strip_prefix(CURSOR_LEAD)
        .ok_or_else(refused)
        .and_then(|body| BASE64_URL_SAFE_NO_PAD.decode(body).map_err(|_| refused()))?;
    let rest = bytes
        .strip_prefix(scope.as_slice())
        .and_then(|rest| rest.split_first())
        .ok_or_else(refused)?;
    let (id, key) = match rest {
        (&UUID_ID, rest) => {
            let (id, key) = rest.split_at_checked(16).ok_or_else(refused)?;
            (
                Uuid::from_slice(id).map_err(|_| refused())?.to_string(),
                key,
            )
        }
        (&TEXT_ID, rest) => {
            let (length, rest) = rest.split_at_checked(4).ok_or_else(refused)?;
            let length = u32::from_be_bytes(length.try_into().map_err(|_| refused())?);
            let (id, key) = rest
                .split_at_checked(usize::try_from(length).map_err(|_| refused())?)
                .ok_or_else(refused)?;
            (String::from_utf8(id.to_vec()).map_err(|_| refused())?, key)
        }
        _ => return Err(refused()),
    };
    let key = serde_json::from_slice::<Value>(key).map_err(|_| refused())?;
    Ok((key, id))
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
    let key = Key::of(asked.sort.as_deref(), definition)?;
    let scope = scope(item, table, asked, &key, descending);
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
            (Key::Column { .. } | Key::Order { .. }, at) => {
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
        Key::Column { .. } | Key::Order { .. } => {
            format!(" ORDER BY k IS NULL, k {direction}, r.id ASC")
        }
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

fn aggregate(adding: &Adding, values: &mut Vec<Value>) -> String {
    let column = |out: &mut crate::filter::Compiled, function: &str| {
        out.push(&format!("{function}(r.body, "));
        out.bind(Bind::Text(format!("$.{}", adding.name)));
        out.push(")");
    };
    let mut out = crate::filter::Compiled::default();
    sql::total(
        &mut out,
        adding,
        |out| column(out, "json_extract"),
        |out| {
            out.push("CASE WHEN ");
            column(out, "json_type");
            out.push(" IN ('integer', 'real') THEN ");
            column(out, "json_extract");
            out.push(" END");
        },
    );
    values.extend(out.values);
    out.text
}

fn total_value(kind: &str, way: &str, bound: &Bound) -> Value {
    match bound {
        Bound::Integer(count) => json!(count),
        Bound::Real(value) => match sql::whole_total(kind, way, *value) {
            Some(whole) => json!(whole),
            None => json!(value),
        },
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
    let adding = sql::adding(&columns);
    let mut values: Vec<Value> = Vec::new();
    let mut sql = "SELECT COUNT(*)".to_string();
    for adding in &adding {
        sql.push_str(", ");
        sql.push_str(&aggregate(adding, &mut values));
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
    for Adding { name, kind, way } in &adding {
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
    core.lay_rows()?;
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
    core.lay_rows()?;
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
                    server: None,
                    code: "row_not_found".into(),
                    message: format!("the table {table} holds no row {row}"),
                }),
            };
        }
    }
    Ok(marked(core.http()?.table_row(item, table, row)?, false))
}

pub(crate) fn totals(core: &Core, item: &str, table: &str, filter: Option<&str>) -> Result<Value> {
    core.lay_rows()?;
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

#[cfg(test)]
mod tests {
    use super::{
        OR_TERMS, Read, RowsAsked, SPAN_GAP, cursor_of, filter_of, opened, page_from_copy, plan,
        totals_from_copy,
    };
    use crate::CoreError;
    use serde_json::{Map, Value, json};
    use sha2::Digest;

    #[test]
    fn a_row_cursor_is_short_and_comes_back_only_to_its_own_listing() {
        let here = [1u8; 8];
        let uuid = "01a1d293-bf77-7182-a4e4-208fb2fb741f";
        let cursor = cursor_of(&here, &json!(null), uuid);
        assert!(cursor.len() < 60, "{cursor}");
        assert_eq!(opened(&here, &cursor).unwrap(), (json!(null), uuid.into()));
        let key = json!("Coffee, \u{e9}");
        let other_id = cursor_of(&here, &key, "row 7");
        assert_eq!(opened(&here, &other_id).unwrap(), (key, "row 7".into()));
        let number = cursor_of(&here, &json!(12.5), "r");
        assert_eq!(opened(&here, &number).unwrap(), (json!(12.5), "r".into()));
        assert!(opened(&[2u8; 8], &cursor).is_err());
        for bad in ["", "abc", "!!!!", &cursor[..cursor.len() - 3], &cursor[1..]] {
            assert!(opened(&here, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_row_cursor_never_starts_with_a_hyphen() {
        let mut bare_hyphens = 0;
        for at in 0..2000u32 {
            let scope: [u8; 8] = sha2::Sha256::digest(at.to_be_bytes())[..8]
                .try_into()
                .unwrap();
            let cursor = cursor_of(&scope, &json!(at), "row");
            assert!(cursor.starts_with('c'), "{cursor}");
            assert!(opened(&scope, &cursor).is_ok());
            bare_hyphens += usize::from(cursor[1..].starts_with('-'));
        }
        assert!(
            bare_hyphens > 0,
            "without the lead letter some would start with a hyphen"
        );
    }

    fn ids(count: usize) -> Vec<String> {
        (0..count).map(|at| format!("{at:04}")).collect()
    }

    #[test]
    fn reads_ids_far_apart_by_id_and_ids_close_together_as_one_range() {
        let far = plan(&ids(2), &mut |_, _| Ok(99_998)).unwrap();
        assert_eq!(far, vec![Read::Ids(ids(2))]);
        let close = plan(&ids(500), &mut |_, _| Ok(SPAN_GAP)).unwrap();
        assert_eq!(close, vec![Read::Span("0000".into(), "0499".into())]);
        let scattered = plan(&ids(25), &mut |_, _| Ok(SPAN_GAP + 1)).unwrap();
        assert_eq!(scattered.len(), 25_usize.div_ceil(OR_TERMS));
        assert!(plan(&[], &mut |_, _| unreachable!()).unwrap().is_empty());
        let mixed = ["a", "b", "c", "x"].map(String::from);
        let read = plan(&mixed, &mut |_, before| {
            Ok(if before == "x" { 500 } else { 0 })
        })
        .unwrap();
        assert_eq!(
            read,
            vec![
                Read::Span("a".into(), "c".into()),
                Read::Ids(vec!["x".into()])
            ]
        );
        assert_eq!(
            filter_of(&Read::Ids(vec!["a".into(), "b".into()])).unwrap(),
            r#"id eq "a" OR id eq "b""#
        );
    }

    #[test]
    fn a_reread_left_behind_goes_with_an_expiry_a_refill_and_a_table_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::open(dir.path().join("core.sqlite"), None).unwrap();
        let mut conn = core.conn().unwrap();
        let stage = |conn: &rusqlite::Connection| {
            conn.execute(
                "INSERT INTO rows_reread (item_id, name, id, answer) VALUES ('i', 't', 'r', NULL)",
                [],
            )
            .unwrap();
        };
        let left = |conn: &rusqlite::Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM rows_reread", [], |row| row.get(0))
                .unwrap()
        };
        stage(&conn);
        assert_eq!(left(&conn), 1);
        crate::reach::expire(&conn).unwrap();
        assert_eq!(left(&conn), 0, "an expired copy kept a purge's re-read");
        stage(&conn);
        crate::store::start_refill(&conn).unwrap();
        assert_eq!(left(&conn), 0, "a refill in place kept a purge's re-read");
        stage(&conn);
        super::let_go(&mut conn, "core.note", "t").unwrap();
        assert_eq!(
            left(&conn),
            0,
            "letting go of a table kept a purge's re-read"
        );
    }

    fn copy_with(rows: &[(&str, Value)]) -> (tempfile::TempDir, crate::Core) {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::Core::open(dir.path().join("core.sqlite"), None).unwrap();
        {
            let conn = core.conn().unwrap();
            for (id, body) in rows {
                conn.execute(
                    "INSERT INTO table_rows (item_id, name, id, body, updated_at)
                     VALUES ('i', 't', ?, ?, '2026-01-01T00:00:00Z')",
                    rusqlite::params![id, body.to_string()],
                )
                .unwrap();
            }
        }
        (dir, core)
    }

    const CORPUS: &str = include_str!("../../marfa-rules/src/filter/parity.json");

    #[test]
    fn the_row_filters_and_totals_both_sides_share_answer_what_the_server_answers() {
        let corpus: Value = serde_json::from_str(CORPUS).unwrap();
        let rows: Vec<(&str, Value)> = corpus["table"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| (row["id"].as_str().unwrap(), row["body"].clone()))
            .collect();
        let (_dir, core) = copy_with(&rows);
        let conn = core.conn().unwrap();
        let definition = json!({ "columns": corpus["table"]["columns"] })
            .as_object()
            .unwrap()
            .clone();
        for case in corpus["table"]["filters"].as_array().unwrap() {
            let mut asked = asked(None, 100, None);
            asked.filter = case["filter"].as_str().map(str::to_string);
            let page = page_from_copy(&conn, "i", "t", &definition, &asked).unwrap();
            assert_eq!(json!(ids_of(&page)), case["ids"], "{}", case["filter"]);
        }
        for case in corpus["table"]["totals"].as_array().unwrap() {
            let totals =
                totals_from_copy(&conn, "i", "t", &definition, case["filter"].as_str()).unwrap();
            assert_eq!(totals, case["answer"], "{}", case["filter"]);
        }
    }

    fn table(order: Option<&str>, kind: &str) -> Map<String, Value> {
        let mut definition = json!({ "columns": { "at": { "type": kind } } });
        if let Some(order) = order {
            definition["order"] = json!(order);
        }
        definition.as_object().unwrap().clone()
    }

    fn asked(sort: Option<&str>, limit: i64, cursor: Option<String>) -> RowsAsked {
        RowsAsked {
            limit: Some(limit),
            cursor,
            filter: None,
            sort: sort.map(str::to_string),
            direction: None,
        }
    }

    fn read(core: &crate::Core, definition: &Map<String, Value>, asked: &RowsAsked) -> Value {
        let conn = core.conn().unwrap();
        page_from_copy(&conn, "i", "t", definition, asked).unwrap()
    }

    fn ids_of(page: &Value) -> Vec<String> {
        page["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn mixed_offsets() -> Vec<(&'static str, Value)> {
        vec![
            ("a", json!({ "at": "2026-01-01T10:00:00+05:00" })),
            ("b", json!({ "at": "2026-01-01T06:00:00Z" })),
            ("c", json!({ "at": "2026-01-01T03:00:00-04:00" })),
            ("d", json!({ "at": "2026-01-01T04:00:00+00:00" })),
        ]
    }

    #[test]
    fn a_cursor_dies_when_the_type_of_its_order_column_changes() {
        let (_dir, core) = copy_with(&mixed_offsets());
        let ordered = table(Some("at"), "datetime");
        let first = read(&core, &ordered, &asked(None, 2, None));
        let cursor = first["next_cursor"].as_str().unwrap().to_string();
        let conn = core.conn().unwrap();
        let retyped = table(Some("at"), "string");
        let error = page_from_copy(&conn, "i", "t", &retyped, &asked(None, 2, Some(cursor)))
            .expect_err("a cursor outlived a change to the type of its order column");
        assert!(error.to_string().contains("cursor"), "{error}");
    }

    #[test]
    fn a_cursor_of_a_named_column_dies_when_the_type_of_the_column_changes() {
        let (_dir, core) = copy_with(&mixed_offsets());
        let first = read(
            &core,
            &table(None, "datetime"),
            &asked(Some("values.at"), 2, None),
        );
        let cursor = first["next_cursor"].as_str().unwrap().to_string();
        let conn = core.conn().unwrap();
        let error = page_from_copy(
            &conn,
            "i",
            "t",
            &table(None, "string"),
            &asked(Some("values.at"), 2, Some(cursor)),
        )
        .expect_err("a cursor outlived a change to the type of its column");
        assert!(error.to_string().contains("cursor"), "{error}");
    }

    #[test]
    fn a_datetime_column_that_is_not_the_order_sorts_by_instant_across_offsets() {
        let (_dir, core) = copy_with(&mixed_offsets());
        let page = read(
            &core,
            &table(None, "datetime"),
            &asked(Some("values.at"), 10, None),
        );
        assert_eq!(ids_of(&page), ["d", "a", "b", "c"]);
        let text = read(
            &core,
            &table(None, "string"),
            &asked(Some("values.at"), 10, None),
        );
        assert_eq!(ids_of(&text), ["c", "d", "b", "a"]);
    }

    #[test]
    fn number_and_integer_columns_sort_numerically() {
        let rows = vec![
            ("a", json!({ "at": 10 })),
            ("b", json!({ "at": 9 })),
            ("c", json!({ "at": 100 })),
            ("d", json!({ "at": 2.5 })),
            ("e", json!({})),
        ];
        let (_dir, core) = copy_with(&rows);
        for kind in ["number", "integer"] {
            let page = read(
                &core,
                &table(None, kind),
                &asked(Some("values.at"), 10, None),
            );
            assert_eq!(ids_of(&page), ["d", "b", "a", "c", "e"], "{kind}");
        }
    }
    #[test]
    fn a_read_the_server_would_refuse_is_a_validation_naming_what_it_refuses() {
        let (_dir, core) = copy_with(&mixed_offsets());
        let definition = table(None, "datetime");
        let conn = core.conn().unwrap();
        let mut direction = asked(None, 10, None);
        direction.direction = Some("sideways".into());
        let mut filter = asked(None, 10, None);
        filter.filter = Some("values.nothing eq 1".into());
        for (what, named) in [
            (asked(Some("values.nothing"), 10, None), "sort"),
            (asked(None, 10, Some("nonsense".into())), "cursor"),
            (asked(None, 1001, None), "limit"),
            (asked(None, 0, None), "limit"),
            (direction, "direction"),
            (filter, "filter"),
        ] {
            let refused = page_from_copy(&conn, "i", "t", &definition, &what).unwrap_err();
            assert!(
                matches!(&refused, CoreError::Validation { code, server: None, .. }
                    if code == "validation_error"),
                "{named}: {refused:?}"
            );
            assert!(refused.to_string().contains(named), "{refused}");
        }
    }
}
