//! Row reads share their item's access check and snapshot.

use marfa_rules::filter::Expression;
use marfa_rules::filter::sql::{self, Adding};
use marfa_rules::query::property_sort_expression;
use rusqlite::Transaction;
use rusqlite::types::Value as Bound;
use serde_json::{Map, Value, json};

use super::order::{NO_KEY, Order};
use super::store::{self, Held};
use super::{Sight, Table, not_found_row, table_of, tables_of_host};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::faults::FAIL_TABLE_ROWS_PAGE;
use crate::app::items::{self, Reader, reading};
use crate::app::query::{Position, Secret, Sql, readable_types};
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

    fn sort_key(&self, column: &str, kind: &str) -> Sql {
        if marfa_rules::schema::ORDER_KINDS.contains(&kind) {
            let order = Order {
                column: column.to_string(),
                kind: kind.to_string(),
            };
            return self.masked(column, &Sql::new(&order.value_key_sql("r.body")));
        }
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
        let data: Vec<Value> = tables_of_host(&read.catalog, &host)?
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
    sql::table_filter(filter, |name| table.columns.contains_key(name))
        .map_err(|error| invalid("filter", error.message))
}

fn conditions(sql: &mut Sql, expression: &Expression, withholding: &Withholding) -> Result<()> {
    sql.push(" AND ");
    sql::row_filter(
        sql,
        expression,
        |sql, column| sql.append(&withholding.held(column)),
        |sql, column| sql.append(&withholding.kind(column)),
    )
    .map_err(|error| invalid("filter", error.message))
}

/// The planner passes by an index a descending page could use unless it is named.
fn selection(
    table: Option<i64>,
    filter: Option<&Expression>,
    withholding: &Withholding,
    index: Option<&str>,
) -> Result<Sql> {
    let mut sql = Sql::new(" FROM table_rows r ");
    if let Some(index) = index {
        sql.push(&format!("INDEXED BY {index} "));
    }
    sql.push("WHERE r.table_seq = ");
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
    Column {
        name: String,
        kind: String,
    },
    /// The column the table names as its `order`, whose key is stored with each row.
    Order(Order),
}

impl Key {
    /// With no `sort`, the table's own `order` column, or `id` for a table that names none.
    fn of(sort: Option<&str>, table: &Table) -> Result<Key> {
        match sort {
            None => Ok(table.order.clone().map_or(Key::Id, Key::Order)),
            Some("id") => Ok(Key::Id),
            Some("updated_at") => Ok(Key::Updated),
            Some(sort) => match sort.strip_prefix("values.") {
                Some(column)
                    if let Some(order) = table.order.as_ref().filter(|o| o.column == column) =>
                {
                    Ok(Key::Order(order.clone()))
                }
                Some(column) if let Some(definition) = table.columns.get(column) => {
                    Ok(Key::Column {
                        name: column.to_string(),
                        kind: definition
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                }
                _ => Err(invalid(
                    "sort",
                    "sort is id, updated_at or values.<column> of a column the table declares.",
                )),
            },
        }
    }

    /// What the key is called in a `sort`, which a cursor is tied to.
    fn label(&self) -> String {
        match self {
            Key::Id => "id".to_string(),
            Key::Updated => "updated_at".to_string(),
            Key::Column { name, .. } => format!("values.{name}"),
            Key::Order(order) => format!("values.{}", order.column),
        }
    }

    /// The kind of value a cursor's position holds, which a cursor cannot outlive a change to.
    fn kind(&self) -> Option<String> {
        match self {
            Key::Id | Key::Updated => None,
            Key::Column { kind, .. } => Some(kind.clone()),
            Key::Order(order) => Some(order.signature()),
        }
    }

    fn expression(&self, withholding: &Withholding) -> Sql {
        match self {
            Key::Id => Sql::new("NULL"),
            Key::Updated => Sql::new("r.updated_at"),
            Key::Column { name, kind } => withholding.sort_key(name, kind),
            Key::Order(order) => Sql::new(&order.key_sql("r.body", "r.refs")),
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
        (Key::Column { .. } | Key::Order(_), value) => {
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
        Key::Column { .. } | Key::Order(_) => {
            sql.push(&format!(" ORDER BY k IS NULL, k {direction}, r.id ASC"));
        }
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

fn scope(item: &str, table: &str, asked: &Page, key: &Key) -> String {
    json!([
        ROWS_SCOPE,
        item,
        table,
        asked.filter,
        key.label(),
        asked.descending,
        key.kind()
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
    cursors.key_tag(scope, &text)
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

struct Selected<'a> {
    seq: Option<i64>,
    filter: Option<&'a Expression>,
    withholding: &'a Withholding,
    position: Option<&'a Position>,
    descending: bool,
}

fn scanned_page(
    read: &Reader<'_, '_>,
    asked: &Selected<'_>,
    key: &Key,
    limit: i64,
) -> Result<Vec<(Held, Bound)>> {
    let mut sql =
        Sql::new("SELECT * FROM (SELECT r.id, r.updated_at, json(r.body), json(r.refs), ");
    sql.append(&key.expression(asked.withholding));
    sql.push(" AS k");
    let index = matches!(key, Key::Updated).then_some("table_rows_updated");
    sql.append(&selection(
        asked.seq,
        asked.filter,
        asked.withholding,
        index,
    )?);
    sql.push(") r WHERE 1 = 1");
    if let Some(position) = asked.position {
        position_after(&mut sql, key, asked.descending, position);
    }
    order_by(&mut sql, key, asked.descending);
    sql.push(" LIMIT ");
    sql.bind(limit);
    store::page(read.tx, &sql)
}

/// A page by the stored order keys, in the order [`scanned_page`] gives.
fn keyed_page(
    read: &Reader<'_, '_>,
    asked: &Selected<'_>,
    limit: i64,
) -> Result<Vec<(Held, Bound)>> {
    let index = Some("table_rows_ordered");
    let after = asked
        .position
        .map(|at| (at.keys.first().cloned().unwrap_or(Bound::Null), at));
    let mut found = Vec::new();
    if !matches!(after, Some((Bound::Null, _))) {
        let mut sql = Sql::new("SELECT r.id, r.updated_at, json(r.body), json(r.refs), r.ord");
        sql.append(&selection(
            asked.seq,
            asked.filter,
            asked.withholding,
            index,
        )?);
        let (direction, beyond) = match asked.descending {
            true => ("DESC", "<"),
            false => ("ASC", ">"),
        };
        // The planner bounds the range by one upper bound only, so a cursor's bound replaces this.
        if !(asked.descending && after.is_some()) {
            sql.push(&format!(" AND r.ord < {NO_KEY}"));
        }
        if let Some((value, at)) = &after {
            sql.push(&format!(" AND r.ord {beyond}= "));
            sql.bind(value.clone());
            sql.push(&format!(" AND (r.ord {beyond} "));
            sql.bind(value.clone());
            sql.push(" OR r.id > ");
            sql.bind(at.id.clone());
            sql.push(")");
        }
        sql.push(&format!(" ORDER BY r.ord {direction}, r.id ASC LIMIT "));
        sql.bind(limit);
        found = store::page(read.tx, &sql)?;
    }
    let left = limit - found.len() as i64;
    if left > 0 {
        let mut sql = Sql::new("SELECT r.id, r.updated_at, json(r.body), json(r.refs), NULL");
        sql.append(&selection(
            asked.seq,
            asked.filter,
            asked.withholding,
            index,
        )?);
        sql.push(&format!(" AND r.ord = {NO_KEY}"));
        if let Some((Bound::Null, at)) = &after {
            sql.push(" AND r.id > ");
            sql.bind(at.id.clone());
        }
        sql.push(" ORDER BY r.id ASC LIMIT ");
        sql.bind(left);
        found.extend(store::page(read.tx, &sql)?);
    }
    Ok(found)
}

fn answered_page(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    asked: &Page,
) -> Result<String> {
    if read.faults().fail(FAIL_TABLE_ROWS_PAGE, Some(table)) {
        return Err(Refusal::internal("the read of a page of rows failed"));
    }
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host, table)?;
    let limit = limit_of(asked.limit)?;
    let filter = asked
        .filter
        .as_deref()
        .map(|text| expression(text, &table))
        .transpose()?;
    let key = Key::of(asked.sort.as_deref(), &table)?;
    let scope = scope(&host.id, &table.name, asked, &key);
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
    let keyed = match (&key, seq) {
        (Key::Order(order), Some(seq)) => {
            store::ordered_by(read.tx, seq)? == Some(order.signature())
        }
        _ => false,
    };
    let selected = Selected {
        seq,
        filter: filter.as_ref(),
        withholding: &withholding,
        position: position.as_ref(),
        descending: asked.descending,
    };
    let mut found = match keyed {
        true => keyed_page(read, &selected, limit + 1)?,
        false => scanned_page(read, &selected, &key, limit + 1)?,
    };
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
        let table = table_of(&read.catalog, &host, &table)?;
        let seq = store::table_seq(read.tx, host.seq, &table.name)?;
        let held = store::row(read.tx, seq, &row_id)?.ok_or_else(not_found_row)?;
        printed(&Shown::of(read).row(held)?)
    })
    .await
}

fn aggregate(withholding: &Withholding, adding: &Adding) -> Sql {
    let mut out = Sql::new("");
    let column = &adding.name;
    sql::total(
        &mut out,
        adding,
        |sql| sql.append(&withholding.held(column)),
        |sql| sql.append(&withholding.number(column)),
    );
    out
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

fn answered_totals(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    filter: Option<&str>,
) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host, table)?;
    let filter = filter.map(|text| expression(text, &table)).transpose()?;
    let withholding = Withholding::of(read)?;
    let seq = store::table_seq(read.tx, host.seq, &table.name)?;
    let selected = selection(seq, filter.as_ref(), &withholding, None)?;
    let adding = sql::adding(&table.columns);
    let mut sql = Sql::new("SELECT COUNT(*)");
    for adding in &adding {
        sql.push(", ");
        sql.append(&aggregate(&withholding, adding));
    }
    sql.append(&selected);
    let mut found = store::single(read.tx, &sql)?.into_iter();
    let row_count = found.next().unwrap_or(Bound::Integer(0));
    let mut totals = Map::new();
    for Adding { name, kind, way } in &adding {
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

const BATCHES_SCOPE: &str = "row-batches";

fn answered_batches(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<String> {
    let host = items::readable_host(read, item_id)?;
    let table = table_of(&read.catalog, &host, table)?;
    let limit = limit_of(limit)?;
    let scope = json!([BATCHES_SCOPE, host.id, table.name]).to_string();
    let before = cursor
        .map(|cursor| {
            read.cursors
                .open_at(&scope, cursor)
                .ok()
                .and_then(|(seq, _)| seq.parse::<i64>().ok())
                .ok_or_else(|| invalid("cursor", "The cursor does not belong to this listing."))
        })
        .transpose()?;
    let found = match store::table_seq(read.tx, host.seq, &table.name)? {
        Some(seq) => store::batches(read.tx, seq, before, limit + 1)?,
        None => Vec::new(),
    };
    let more = found.len() as i64 > limit;
    let shown = &found[..found.len().min(limit as usize)];
    let next = match shown.last().filter(|_| more) {
        Some(last) => Value::String(read.cursors.issue_at(
            &scope,
            &last.seq.to_string(),
            &last.id,
        )?),
        None => Value::Null,
    };
    let data: Vec<Value> = shown
        .iter()
        .map(|batch| {
            json!({ "id": batch.id, "at": batch.at, "rows": batch.rows, "undoes": batch.undoes })
        })
        .collect();
    printed(&json!({ "data": data, "next_cursor": next }))
}

pub async fn batches(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<String> {
    reading(app, caller, move |read| {
        answered_batches(read, &item_id, &table, limit, cursor.as_deref())
    })
    .await
}

#[cfg(test)]
mod parity {
    use rusqlite::{Connection, params, params_from_iter};
    use serde_json::{Map, Value, json};

    use super::*;

    const CORPUS: &str = include_str!("../../../../marfa-rules/src/filter/parity.json");

    fn held(corpus: &Value) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
            .unwrap();
        for row in corpus["table"]["rows"].as_array().unwrap() {
            db.execute(
                "INSERT INTO table_rows (table_seq, id, updated_at, batch, body) \
                 VALUES (1, ?1, '2026-01-01T00:00:00Z', 0, jsonb(?2))",
                params![row["id"].as_str().unwrap(), row["body"].to_string()],
            )
            .unwrap();
        }
        db
    }

    fn readable() -> Withholding {
        Withholding {
            every: true,
            readable: None,
        }
    }

    #[test]
    fn the_row_filters_and_totals_both_sides_share_answer_what_the_working_copy_answers() {
        let corpus: Value = serde_json::from_str(CORPUS).unwrap();
        let columns: Map<String, Value> = corpus["table"]["columns"].as_object().unwrap().clone();
        let db = held(&corpus);
        for case in corpus["table"]["filters"].as_array().unwrap() {
            let text = case["filter"].as_str().unwrap();
            let filter = sql::table_filter(text, |name| columns.contains_key(name)).unwrap();
            let selected = selection(Some(1), Some(&filter), &readable(), None).unwrap();
            let mut statement = db
                .prepare(&format!("SELECT r.id{} ORDER BY r.id", selected.text))
                .unwrap();
            let ids: Vec<String> = statement
                .query_map(params_from_iter(selected.values.iter()), |row| row.get(0))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            assert_eq!(json!(ids), case["ids"], "{text}");
        }
        for case in corpus["table"]["totals"].as_array().unwrap() {
            let filter = case["filter"]
                .as_str()
                .map(|text| sql::table_filter(text, |name| columns.contains_key(name)).unwrap());
            let selected = selection(Some(1), filter.as_ref(), &readable(), None).unwrap();
            let adding = sql::adding(&columns);
            let mut query = Sql::new("SELECT COUNT(*)");
            for adding in &adding {
                query.push(", ");
                query.append(&aggregate(&readable(), adding));
            }
            query.append(&selected);
            let found = store::single(&db.unchecked_transaction().unwrap(), &query).unwrap();
            let mut found = found.into_iter();
            let mut totals = Map::new();
            let row_count = total_value("integer", "count", &found.next().unwrap());
            for Adding { name, kind, way } in &adding {
                let bound = found.next().unwrap();
                totals.insert(name.clone(), json!({ way: total_value(kind, way, &bound) }));
            }
            let answer = json!({ "row_count": row_count, "totals": totals });
            assert_eq!(answer, case["answer"], "{}", case["filter"]);
        }
    }
}
