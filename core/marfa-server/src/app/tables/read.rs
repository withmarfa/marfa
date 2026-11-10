//! Row reads share their item's access check and snapshot.

use marfa_rules::filter::{Expression, Term, parse_rows, system_literal};
use marfa_rules::query::property_sort_expression;
use rusqlite::Transaction;
use rusqlite::types::Value as Bound;
use serde_json::{Map, Value, json};

use super::store::{self, Held};
use super::{Sight, Table, not_found_row, table_of, tables_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::{self, Reader, reading};
use crate::app::query::{Position, Secret, Sql, compared, held_property, readable_types};
use crate::app::refusal::{Refusal, Result};

const FIRST_PAGE: i64 = 100;
pub const MAX_PAGE: i64 = 1000;
const ROWS_SCOPE: &str = "rows";
/// A sort key longer than this many bytes rides in a cursor as a tag, and its row is read again.
const KEY_BYTES: usize = 128;

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

/// Each row as the reader may see it.
struct Shown<'a> {
    tx: &'a Transaction<'a>,
    caller: &'a Caller,
    sight: Sight,
}

impl<'a> Shown<'a> {
    fn of(read: &'a Reader<'_, '_>) -> Shown<'a> {
        Shown {
            tx: read.tx,
            caller: &read.caller,
            sight: Sight::of(&read.caller),
        }
    }

    fn row(&mut self, held: Held) -> Result<Value> {
        let mut values = held.values;
        let withheld = self.sight.withheld(self.tx, self.caller, &held.refs)?;
        for column in &withheld {
            values.remove(column);
        }
        let mut row = json!({ "id": held.id, "values": values, "updated_at": held.updated_at });
        if !withheld.is_empty() {
            row["withheld"] = json!(withheld);
        }
        Ok(row)
    }
}

/// The SQL a row read selects, sorts and totals by, which reads a withheld value as absent.
struct Withholding {
    /// Whether the reader may read every type, which shows it an id no item holds.
    every: bool,
    /// The types the reader may read, or `None` for every type an item holds.
    readable: Option<Vec<String>>,
}

impl Withholding {
    fn of(read: &Reader<'_, '_>) -> Result<Withholding> {
        let every = read.caller.may_read_every_type();
        Ok(Withholding {
            every,
            readable: match every {
                true => None,
                false => readable_types(read.tx, &read.caller)?,
            },
        })
    }

    fn hidden(&self, column: &str) -> Sql {
        if self.every {
            return Sql::new("0");
        }
        let path = format!("$.{column}");
        let mut sql = Sql::new("(r.refs IS NOT NULL AND json_extract(r.refs, ");
        sql.bind(path.clone());
        sql.push(") IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items x WHERE x.id = json_extract(r.refs, ");
        sql.bind(path);
        sql.push(")");
        if let Some(types) = &self.readable {
            sql.push(" AND x.type IN (");
            sql.list(types);
            sql.push(")");
        }
        sql.push("))");
        sql
    }

    fn masked(&self, column: &str, shown: &Sql) -> Sql {
        let mut sql = Sql::new("CASE WHEN ");
        sql.append(&self.hidden(column));
        sql.push(" THEN NULL ELSE ");
        sql.append(shown);
        sql.push(" END");
        sql
    }

    fn on_body(function: &str, column: &str) -> Sql {
        let mut sql = Sql::new(&format!("{function}(r.body, "));
        sql.bind(format!("$.{column}"));
        sql.push(")");
        sql
    }

    fn held(&self, column: &str) -> Sql {
        self.masked(column, &Self::on_body("json_extract", column))
    }

    fn kind(&self, column: &str) -> Sql {
        self.masked(column, &Self::on_body("json_type", column))
    }

    fn sort_key(&self, column: &str) -> Sql {
        let text = property_sort_expression("r.body", "?");
        let mut shown = Sql::new(&text);
        shown.values = vec![Bound::Text(format!("$.{column}")); text.matches('?').count()];
        self.masked(column, &shown)
    }

    /// A number the column holds, and nothing for any other kind of value.
    fn number(&self, column: &str) -> Sql {
        let mut sql = Sql::new("CASE WHEN ");
        sql.append(&self.hidden(column));
        sql.push(" THEN NULL WHEN ");
        sql.append(&Self::on_body("json_type", column));
        sql.push(" IN ('integer', 'real') THEN ");
        sql.append(&Self::on_body("json_extract", column));
        sql.push(" END");
        sql
    }
}

fn printed(value: &Value) -> Result<String> {
    marfa_rules::number::to_vec(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("an answer did not print"))
}

pub async fn list(app: &App, caller: &Caller, item_id: String) -> Result<String> {
    reading(app, caller, move |read| {
        let host = items::readable_host(read, &item_id)?;
        let held = store::summaries(read.tx, host.seq)?;
        let data: Vec<Value> = tables_of(&read.catalog, &host.type_id)
            .into_iter()
            .map(
                |table| match held.iter().find(|summary| summary.table == table.name) {
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
                },
            )
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

fn conditions(sql: &mut Sql, expression: &Expression, withholding: &Withholding) -> Result<()> {
    sql.push(" AND (");
    for (at, condition) in expression.conditions.iter().enumerate() {
        if at > 0 {
            sql.push(if expression.any { " OR " } else { " AND " });
        }
        sql.push("(");
        match &condition.term {
            Term::Property { name, op } => held_property(
                sql,
                &withholding.held(name),
                &withholding.kind(name),
                *op,
                &condition.value,
            ),
            Term::System { column, compare } => {
                let value = system_literal(column, *compare, &condition.value)
                    .map_err(|error| invalid("filter", error.message))?;
                compared(sql, &Sql::new(&format!("r.{column}")), *compare, &value);
            }
            _ => {
                return Err(invalid(
                    "filter",
                    "A row filter names columns, id and updated_at.",
                ));
            }
        }
        sql.push(")");
    }
    sql.push(")");
    Ok(())
}

/// `by_updated` names the index, which the planner passes by for a descending page.
fn selection(
    table: Option<i64>,
    filter: Option<&Expression>,
    withholding: &Withholding,
    by_updated: bool,
) -> Result<Sql> {
    let mut sql = Sql::new(if by_updated {
        " FROM table_rows r INDEXED BY table_rows_updated WHERE r.table_seq = "
    } else {
        " FROM table_rows r WHERE r.table_seq = "
    });
    sql.bind(table);
    if let Some(expression) = filter {
        conditions(&mut sql, expression, withholding)?;
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

    fn expression(&self, withholding: &Withholding) -> Sql {
        match self {
            Key::Id => Sql::new("NULL"),
            Key::Updated => Sql::new("r.updated_at"),
            Key::Column(column) => withholding.sort_key(column),
        }
    }
}

/// For `updated_at`, the bound comes first so the index serves the range.
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
        (Key::Updated, value) => {
            sql.push(&format!(" AND k {after}= "));
            sql.bind(value.clone());
            sql.push(&format!(" AND (k {after} "));
            sql.bind(value);
            sql.push(" OR r.id > ");
            sql.bind(id);
            sql.push(")");
        }
        (Key::Column(_), value) => {
            sql.push(&format!(" AND (k IS NULL OR k {after} "));
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
    Position::from_payload(&payload, 2).map_err(|_| refused())
}

fn tag_of(cursors: &Secret, scope: &str, key: &Bound) -> Result<String> {
    let text = match key {
        Bound::Null | Bound::Blob(_) => "n".to_string(),
        Bound::Integer(number) => format!("i{number}"),
        Bound::Real(number) => format!("r{}", number.to_bits()),
        Bound::Text(text) => format!("t{text}"),
    };
    cursors.keyed(scope, &text)
}

/// A cursor holds the last row's id and its sort key, or for a long text key the key's tag.
fn issued(cursors: &Secret, scope: &str, id: &str, key: &Bound) -> Result<String> {
    let keys = match key {
        Bound::Text(text) if text.len() > KEY_BYTES => {
            vec![Bound::Null, Bound::Text(tag_of(cursors, scope, key)?)]
        }
        key => vec![key.clone(), Bound::Null],
    };
    let position = Position {
        keys,
        id: id.to_string(),
    };
    cursors.issue(scope, &position.payload())
}

/// A position that holds a tag takes its sort key from its row as it is now, if the row still has that key.
fn resumed(
    read: &Reader<'_, '_>,
    table: Option<i64>,
    key: &Key,
    withholding: &Withholding,
    scope: &str,
    position: Position,
) -> Result<Position> {
    let Some(Bound::Text(tag)) = position.keys.get(1) else {
        return Ok(position);
    };
    let moved = || {
        invalid(
            "cursor",
            "The row this cursor follows has changed or been removed. List again from the start.",
        )
    };
    let table = table.ok_or_else(moved)?;
    let mut sql = Sql::new("SELECT ");
    sql.append(&key.expression(withholding));
    sql.push(" FROM table_rows r WHERE r.table_seq = ");
    sql.bind(table);
    sql.push(" AND r.id = ");
    sql.bind(position.id.clone());
    let current = store::single(read.tx, &sql)?
        .into_iter()
        .next()
        .ok_or_else(moved)?;
    if &tag_of(&read.cursors, scope, &current)? != tag {
        return Err(moved());
    }
    Ok(Position {
        keys: vec![current],
        id: position.id,
    })
}

fn answered_page(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    asked: &Page,
) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host.type_id, table)?;
    let limit = limit_of(asked.limit)?;
    let filter = asked
        .filter
        .as_deref()
        .map(|text| expression(text, &table))
        .transpose()?;
    let key = Key::of(asked.sort.as_deref(), &table)?;
    let scope = scope(&host.id, &table.name, asked);
    let position = asked
        .cursor
        .as_deref()
        .map(|cursor| opened(&read.cursors, &scope, cursor))
        .transpose()?;
    let withholding = Withholding::of(read)?;
    let seq = store::table_seq(read.tx, host.seq, &table.name)?;
    let position = position
        .map(|at| resumed(read, seq, &key, &withholding, &scope, at))
        .transpose()?;
    let mut sql =
        Sql::new("SELECT * FROM (SELECT r.id, r.updated_at, json(r.body), json(r.refs), ");
    sql.append(&key.expression(&withholding));
    sql.push(" AS k");
    sql.append(&selection(
        seq,
        filter.as_ref(),
        &withholding,
        matches!(key, Key::Updated),
    )?);
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
        Some((row, key)) => Value::String(issued(&read.cursors, &scope, &row.id, key)?),
        None => Value::Null,
    };
    let mut shown = Shown::of(read);
    let data = found
        .into_iter()
        .map(|(row, _)| shown.row(row))
        .collect::<Result<Vec<_>>>()?;
    printed(&json!({ "data": data, "next_cursor": next }))
}

pub async fn page(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    asked: Page,
) -> Result<String> {
    reading(app, caller, move |read| {
        answered_page(read, &item_id, &table, &asked)
    })
    .await
}

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
        let seq = store::table_seq(read.tx, host.seq, &table.name)?;
        let held = store::row(read.tx, seq, &row_id)?.ok_or_else(not_found_row)?;
        printed(&Shown::of(read).row(held)?)
    })
    .await
}

/// Datetimes compare by instant and return UTC.
fn aggregate(withholding: &Withholding, kind: &str, way: &str, column: &str) -> Sql {
    let mut sql = Sql::new("");
    let mut wrapped = |open: &str, inner: Sql, close: &str| {
        sql.push(open);
        sql.append(&inner);
        sql.push(close);
    };
    match (way, kind) {
        ("count", _) => wrapped("COUNT(", withholding.held(column), ")"),
        ("sum", _) => wrapped("TOTAL(", withholding.number(column), ")"),
        ("average", _) => wrapped("AVG(", withholding.number(column), ")"),
        ("min", "date") => wrapped("MIN(", withholding.held(column), ")"),
        ("max", "date") => wrapped("MAX(", withholding.held(column), ")"),
        ("min", "datetime") => wrapped(
            "strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday(",
            withholding.held(column),
            ")))",
        ),
        ("max", "datetime") => wrapped(
            "strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(",
            withholding.held(column),
            ")))",
        ),
        ("min", _) => wrapped("MIN(", withholding.number(column), ")"),
        _ => wrapped("MAX(", withholding.number(column), ")"),
    }
    sql
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

fn answered_totals(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    filter: Option<&str>,
) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host.type_id, table)?;
    let filter = filter.map(|text| expression(text, &table)).transpose()?;
    let withholding = Withholding::of(read)?;
    let seq = store::table_seq(read.tx, host.seq, &table.name)?;
    let selected = selection(seq, filter.as_ref(), &withholding, false)?;
    let adding: Vec<(String, String, String)> = table
        .columns
        .iter()
        .filter_map(|(name, definition)| {
            let way = definition.get("adds_up")?.as_str()?;
            let kind = definition.get("type")?.as_str()?;
            marfa_rules::catalog::api_name(name)
                .then(|| (name.clone(), kind.to_string(), way.to_string()))
        })
        .collect();
    let mut sql = Sql::new("SELECT COUNT(*)");
    for (name, kind, way) in &adding {
        sql.push(", ");
        sql.append(&aggregate(&withholding, kind, way, name));
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
