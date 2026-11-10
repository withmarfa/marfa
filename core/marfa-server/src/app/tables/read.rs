//! Reading rows is reading their item: each read finds the item as `GET /items/{id}` does, in
//! the snapshot it answers from.

use std::collections::HashMap;

use marfa_rules::filter::{Expression, Term, parse_rows, system_literal};
use marfa_rules::query::property_sort_expression;
use rusqlite::Transaction;
use rusqlite::types::Value as Bound;
use serde_json::{Map, Value, json};

use super::store::{self, Held};
use super::{Table, not_found_row, table_of, tables_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::{self, Reader, reading};
use crate::app::query::{Position, Secret, Sql, compared, property};
use crate::app::refusal::{Refusal, Result};

const FIRST_PAGE: i64 = 100;
pub const MAX_PAGE: i64 = 1000;
const ROWS_SCOPE: &str = "rows";

/// What a page of rows asks for.
#[derive(Debug, Default)]
pub struct Page {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub filter: Option<String>,
    pub sort: Option<String>,
    pub descending: bool,
}

fn invalid(field: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    Refusal::validation(message.clone())
        .with_detail("field", field)
        .with_detail("errors", json!([{ "path": field, "message": message }]))
}

/// Each row's item columns, shown to a reader that may read the item they name.
struct Shown<'a> {
    tx: &'a Transaction<'a>,
    caller: &'a Caller,
    table: &'a Table,
    seen: HashMap<String, bool>,
}

impl Shown<'_> {
    fn readable(&mut self, id: &str) -> Result<bool> {
        if let Some(known) = self.seen.get(id) {
            return Ok(*known);
        }
        let readable = items::type_of(self.tx, id)?
            .is_some_and(|type_id| self.caller.may_read_type(&type_id));
        self.seen.insert(id.to_string(), readable);
        Ok(readable)
    }

    fn row(&mut self, held: Held) -> Result<Value> {
        let mut values = held.values;
        let mut withheld = Vec::new();
        let columns: Vec<String> = self.table.item_columns().map(str::to_string).collect();
        for column in columns {
            let Some(id) = values.get(&column).and_then(Value::as_str).map(str::to_string) else {
                continue;
            };
            if !self.readable(&id)? {
                values.remove(&column);
                withheld.push(column);
            }
        }
        let mut row = json!({ "id": held.id, "values": values, "updated_at": held.updated_at });
        if !withheld.is_empty() {
            row["withheld"] = json!(withheld);
        }
        Ok(row)
    }
}

fn printed(value: &Value) -> Result<String> {
    marfa_rules::number::to_vec(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("an answer did not print"))
}

/// `GET /items/{id}/tables`.
pub async fn list(app: &App, caller: &Caller, item_id: String) -> Result<String> {
    reading(app, caller, move |read| {
        let host = items::readable_host(read, &item_id)?;
        let held = store::summaries(read.tx, host.seq)?;
        let data: Vec<Value> = tables_of(&read.catalog, &host.type_id)
            .into_iter()
            .map(|table| match held.iter().find(|summary| summary.table == table.name) {
                Some(summary) => json!({
                    "name": table.name,
                    "label": table.label,
                    "row_count": summary.row_count,
                    "bytes": summary.bytes,
                    "last_batch": summary.last_batch,
                    "changed_at": summary.changed_at,
                }),
                None => json!({
                    "name": table.name,
                    "label": table.label,
                    "row_count": 0,
                    "bytes": 0,
                    "last_batch": null,
                    "changed_at": null,
                }),
            })
            .collect();
        printed(&json!({ "data": data, "next_cursor": null }))
    })
    .await
}

fn expression(filter: &str, table: &Table) -> Result<Expression> {
    let expression = parse_rows(filter).map_err(|error| invalid("filter", error.message))?;
    for condition in &expression.conditions {
        if let Term::Property { name, .. } = &condition.term
            && !table.columns.contains_key(name)
        {
            return Err(invalid(
                "filter",
                format!("The table declares no column \"{name}\"."),
            ));
        }
    }
    Ok(expression)
}

fn conditions(sql: &mut Sql, expression: &Expression) -> Result<()> {
    sql.push(" AND (");
    for (at, condition) in expression.conditions.iter().enumerate() {
        if at > 0 {
            sql.push(if expression.any { " OR " } else { " AND " });
        }
        sql.push("(");
        match &condition.term {
            Term::Property { name, op } => property(sql, "r.body", name, *op, &condition.value),
            Term::System { column, compare } => {
                let value = system_literal(column, *compare, &condition.value)
                    .map_err(|error| invalid("filter", error.message))?;
                compared(sql, &Sql::new(&format!("r.{column}")), *compare, &value);
            }
            _ => return Err(invalid("filter", "A row filter names columns, id and updated_at.")),
        }
        sql.push(")");
    }
    sql.push(")");
    Ok(())
}

fn selection(host_seq: i64, table: &Table, filter: Option<&Expression>) -> Result<Sql> {
    let mut sql = Sql::new(" FROM table_rows r WHERE r.item_seq = ");
    sql.bind(host_seq);
    sql.push(" AND r.table_name = ");
    sql.bind(table.name.clone());
    if let Some(expression) = filter {
        conditions(&mut sql, expression)?;
    }
    Ok(sql)
}

/// The sort key a page orders by, after which ties go by id ascending.
enum Key {
    Id,
    Updated,
    Column(String),
}

impl Key {
    fn of(sort: Option<&str>, table: &Table) -> Result<Key> {
        match sort {
            None | Some("id") => Ok(Key::Id),
            Some("updated_at") => Ok(Key::Updated),
            Some(sort) => match sort.strip_prefix("values.") {
                Some(column) if table.columns.contains_key(column) => {
                    Ok(Key::Column(column.to_string()))
                }
                _ => Err(invalid(
                    "sort",
                    "sort is id, updated_at or values.<column> of a column the table declares.",
                )),
            },
        }
    }

    fn expression(&self) -> Sql {
        match self {
            Key::Id => Sql::new("NULL"),
            Key::Updated => Sql::new("r.updated_at"),
            Key::Column(column) => {
                let text = property_sort_expression("r.body", "?");
                let mut sql = Sql::new(&text);
                sql.values = vec![Bound::Text(format!("$.{column}")); text.matches('?').count()];
                sql
            }
        }
    }
}

fn position_after(sql: &mut Sql, key: &Key, descending: bool, at: &Position) {
    let id = at.id.clone();
    let after = if descending { "<" } else { ">" };
    let value = at.keys.first().cloned().unwrap_or(Bound::Null);
    match (key, value) {
        (Key::Id, _) => {
            sql.push(&format!(" AND r.id {after} "));
            sql.bind(id);
        }
        (_, Bound::Null) => {
            sql.push(" AND k IS NULL AND r.id > ");
            sql.bind(id);
        }
        (key, value) => {
            sql.push(" AND (");
            if matches!(key, Key::Column(_)) {
                sql.push("k IS NULL OR ");
            }
            sql.push(&format!("k {after} "));
            sql.bind(value.clone());
            sql.push(" OR (k = ");
            sql.bind(value);
            sql.push(" AND r.id > ");
            sql.bind(id);
            sql.push("))");
        }
    }
}

fn order_by(sql: &mut Sql, key: &Key, descending: bool) {
    let direction = if descending { "DESC" } else { "ASC" };
    match key {
        Key::Id => sql.push(&format!(" ORDER BY r.id {direction}")),
        Key::Updated => sql.push(&format!(" ORDER BY k {direction}, r.id ASC")),
        Key::Column(_) => sql.push(&format!(" ORDER BY k IS NULL, k {direction}, r.id ASC")),
    }
}

fn limit_of(limit: Option<i64>) -> Result<i64> {
    match limit {
        None => Ok(FIRST_PAGE),
        Some(limit) if (1..=MAX_PAGE).contains(&limit) => Ok(limit),
        Some(_) => Err(invalid(
            "limit",
            format!("limit is a whole number from 1 to {MAX_PAGE}."),
        )),
    }
}

fn scope(item: &str, table: &str, asked: &Page) -> String {
    json!([
        ROWS_SCOPE,
        item,
        table,
        asked.filter,
        asked.sort.as_deref().unwrap_or("id"),
        asked.descending
    ])
    .to_string()
}

fn opened(cursors: &Secret, scope: &str, cursor: &str) -> Result<Position> {
    let refused = || invalid("cursor", "The cursor does not belong to this listing.");
    let payload = cursors.open(scope, cursor).map_err(|_| refused())?;
    Position::from_payload(&payload, 1).map_err(|_| refused())
}

fn answered_page(read: &Reader<'_, '_>, item_id: &str, table: &str, asked: &Page) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host.type_id, table)?;
    let limit = limit_of(asked.limit)?;
    let filter = asked.filter.as_deref().map(|text| expression(text, &table)).transpose()?;
    let key = Key::of(asked.sort.as_deref(), &table)?;
    let scope = scope(&host.id, &table.name, asked);
    let position = asked
        .cursor
        .as_deref()
        .map(|cursor| opened(&read.cursors, &scope, cursor))
        .transpose()?;
    let mut sql = Sql::new("SELECT * FROM (SELECT r.id, r.updated_at, json(r.body), ");
    sql.append(&key.expression());
    sql.push(" AS k");
    sql.append(&selection(host.seq, &table, filter.as_ref())?);
    sql.push(") r WHERE 1 = 1");
    if let Some(position) = &position {
        position_after(&mut sql, &key, asked.descending, position);
    }
    order_by(&mut sql, &key, asked.descending);
    sql.push(" LIMIT ");
    sql.bind(limit + 1);
    let mut found = store::page(read.tx, &sql)?;
    let more = found.len() as i64 > limit;
    found.truncate(limit as usize);
    let next = match found.last().filter(|_| more) {
        Some((row, key)) => {
            let position = Position {
                keys: vec![key.clone()],
                id: row.id.clone(),
            };
            Value::String(read.cursors.issue(&scope, &position.payload())?)
        }
        None => Value::Null,
    };
    let mut shown = Shown {
        tx: read.tx,
        caller: &read.caller,
        table: &table,
        seen: HashMap::new(),
    };
    let data = found
        .into_iter()
        .map(|(row, _)| shown.row(row))
        .collect::<Result<Vec<_>>>()?;
    printed(&json!({ "data": data, "next_cursor": next }))
}

/// `GET /items/{id}/tables/{table}/rows`.
pub async fn page(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    asked: Page,
) -> Result<String> {
    reading(app, caller, move |read| answered_page(read, &item_id, &table, &asked)).await
}

/// `GET /items/{id}/tables/{table}/rows/{row}`. An id that is no row's answers as one the table does not hold.
pub async fn get(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    row_id: String,
) -> Result<String> {
    reading(app, caller, move |read| {
        let host = items::readable_host(read, &item_id)?;
        let table = table_of(&read.catalog, &host.type_id, &table)?;
        let held = store::row(read.tx, host.seq, &table.name, &row_id)?.ok_or_else(not_found_row)?;
        let mut shown = Shown {
            tx: read.tx,
            caller: &read.caller,
            table: &table,
            seen: HashMap::new(),
        };
        printed(&shown.row(held)?)
    })
    .await
}

fn numeric(column: &str) -> String {
    format!(
        "CASE WHEN json_type(r.body, '$.{column}') IN ('integer', 'real') \
         THEN json_extract(r.body, '$.{column}') END"
    )
}

/// A total's SQL over the selected rows, all of them in one pass. A `datetime` compares by its
/// instant, which it answers in UTC.
fn aggregate(kind: &str, way: &str, column: &str) -> String {
    let held = format!("json_extract(r.body, '$.{column}')");
    match (way, kind) {
        ("count", _) => format!("COUNT({held})"),
        ("sum", _) => format!("TOTAL({})", numeric(column)),
        ("average", _) => format!("AVG({})", numeric(column)),
        ("min" | "max", "date") => format!("{}({held})", way.to_uppercase()),
        ("min" | "max", "datetime") => format!(
            "strftime('%Y-%m-%dT%H:%M:%fZ', {}(julianday({held})))",
            way.to_uppercase()
        ),
        _ => format!("{}({})", way.to_uppercase(), numeric(column)),
    }
}

fn number(value: f64, integer: bool) -> Value {
    if integer && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn total_value(kind: &str, way: &str, bound: &Bound) -> Value {
    let integer = kind == "integer" || way == "count";
    match bound {
        Bound::Integer(count) => json!(count),
        Bound::Real(value) => number(*value, integer),
        Bound::Text(text) => json!(text),
        Bound::Null | Bound::Blob(_) => Value::Null,
    }
}

fn answered_totals(read: &Reader<'_, '_>, item_id: &str, table: &str, filter: Option<&str>) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host.type_id, table)?;
    let filter = filter.map(|text| expression(text, &table)).transpose()?;
    let selected = selection(host.seq, &table, filter.as_ref())?;
    let adding: Vec<(String, String, String)> = table
        .columns
        .iter()
        .filter_map(|(name, definition)| {
            let way = definition.get("adds_up")?.as_str()?;
            let kind = definition.get("type")?.as_str()?;
            marfa_rules::catalog::api_name(name).then(|| (name.clone(), kind.to_string(), way.to_string()))
        })
        .collect();
    let mut sql = Sql::new("SELECT COUNT(*)");
    for (name, kind, way) in &adding {
        sql.push(", ");
        sql.push(&aggregate(kind, way, name));
    }
    sql.append(&selected);
    let mut found = store::single(read.tx, &sql)?.into_iter();
    let row_count = found.next().unwrap_or(Bound::Integer(0));
    let mut totals = Map::new();
    for (name, kind, way) in &adding {
        let bound = found.next().unwrap_or(Bound::Null);
        totals.insert(name.clone(), json!({ way: total_value(kind, way, &bound) }));
    }
    printed(&json!({
        "row_count": total_value("integer", "count", &row_count),
        "totals": totals,
    }))
}

/// `GET /items/{id}/tables/{table}/totals`.
pub async fn totals(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    filter: Option<String>,
) -> Result<String> {
    reading(app, caller, move |read| {
        answered_totals(read, &item_id, &table, filter.as_deref())
    })
    .await
}
