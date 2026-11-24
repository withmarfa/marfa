//! Row reads share their item's access check and snapshot.

use std::sync::Arc;

use marfa_rules::filter::Expression;
use marfa_rules::filter::sql::{self, Adding};
use rusqlite::Transaction;
use rusqlite::types::Value as Bound;
use serde_json::{Map, Value, json};

use super::keys::{self, Standing};
use super::lifecycle;
use super::sort_key::{NO_KEY, Sorted};
use super::store::{self, Held};
use super::{Sight, Table, not_found_row, table_of, tables_of_host};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::{self, Snapshot};
use crate::app::faults::{FAIL_TABLE_ROWS_PAGE, FAIL_TABLE_ROWS_SCAN};
use crate::app::housekeeping;
use crate::app::items::{self, Reader, reading};
use crate::app::query::{Position, Secret, Sql, readable_types};
use crate::app::refusal::{Refusal, Result};
use crate::db::Write;

const FIRST_PAGE: i64 = 100;
pub const MAX_PAGE: i64 = 1000;
const ROWS_SCOPE: &str = "rows";
/// Marks the order in which a value written as an item's id has no key.
const ITEM_IDS_UNKEYED: &str = "item-ids-unkeyed";
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

/// Filters and totals treat values withheld from this reader as absent.
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

    /// The value of a column of a kind in `KEYED_KINDS` as its sort key, and nothing for a value of another kind or a column whose name cannot be written into the SQL.
    fn typed(&self, column: &str, kind: &str) -> Sql {
        if !marfa_rules::schema::order_column_inlinable(column) {
            return Sql::new("NULL");
        }
        let order = Sorted {
            column: column.to_string(),
            kind: kind.to_string(),
        };
        self.masked(column, &Sql::new(&order.value_key_sql("r.body")))
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

pub(crate) fn row_counts(read: &Reader<'_, '_>, ids: &[String], name: &str) -> Result<Vec<i64>> {
    ids.iter()
        .map(|id| {
            let Some(host) = items::host_read(read, id)? else {
                return Ok(0);
            };
            if !tables_of_host(&read.catalog, &host)?
                .iter()
                .any(|table| table.name == name)
            {
                return Ok(0);
            }
            Ok(store::summaries(read.tx, host.seq)?
                .into_iter()
                .find(|summary| summary.table == name)
                .map_or(0, |summary| summary.row_count))
        })
        .collect()
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

/// A value written as an item's id has no key, whoever reads it.
enum Key {
    Id,
    Updated,
    /// A requested column that can be read by scanning or from kept keys.
    Column(Sorted),
    /// Every row ties, so row IDs stay ascending in either direction.
    Unkeyed(Sorted),
    /// The column the table names as its `order`, whose key is stored with each row.
    Order(Sorted),
}

impl Key {
    /// With no `sort`, the table's own `order` column, or `id` for a table that names none.
    fn of(sort: Option<&str>, table: &Table) -> Result<Key> {
        match sort {
            None => Ok(table.kept.order.clone().map_or(Key::Id, Key::Order)),
            Some("id") => Ok(Key::Id),
            Some("updated_at") => Ok(Key::Updated),
            Some(sort) => match sort.strip_prefix("values.") {
                Some(column)
                    if let Some(order) =
                        table.kept.order.as_ref().filter(|o| o.column == column) =>
                {
                    Ok(Key::Order(order.clone()))
                }
                Some(column) if let Some(definition) = table.columns.get(column) => {
                    let sorted = Sorted {
                        column: column.to_string(),
                        kind: definition
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    };
                    let unkeyed = sorted.kind == marfa_rules::schema::ITEM_KIND
                        || !marfa_rules::schema::order_column_inlinable(column);
                    Ok(match unkeyed {
                        true => Key::Unkeyed(sorted),
                        false => Key::Column(sorted),
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
            Key::Column(sorted) | Key::Unkeyed(sorted) | Key::Order(sorted) => {
                format!("values.{}", sorted.column)
            }
        }
    }

    /// The kind of value a cursor's position holds, which a cursor cannot outlive a change to.
    fn kind(&self) -> Option<String> {
        match self {
            Key::Id | Key::Updated => None,
            Key::Column(sorted) | Key::Unkeyed(sorted) => Some(sorted.kind.clone()),
            Key::Order(order) => Some(order.signature()),
        }
    }

    /// Cursors answered when a value written as an item's id sorted by that id lack this.
    fn rule(&self) -> Option<&'static str> {
        matches!(self, Key::Column(_) | Key::Unkeyed(_)).then_some(ITEM_IDS_UNKEYED)
    }

    fn expression(&self) -> Sql {
        match self {
            Key::Id | Key::Unkeyed(_) => Sql::new("NULL"),
            Key::Updated => Sql::new("r.updated_at"),
            Key::Column(sorted) | Key::Order(sorted)
                if marfa_rules::schema::order_column_inlinable(&sorted.column) =>
            {
                Sql::new(&sorted.key_sql("r.body", "r.refs"))
            }
            Key::Column(_) | Key::Order(_) => Sql::new("NULL"),
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
        (Key::Unkeyed(_), _) => {
            sql.push(" AND r.id > ");
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
        (Key::Column(_) | Key::Order(_), value) => {
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
        Key::Unkeyed(_) => sql.push(" ORDER BY r.id ASC"),
        Key::Updated => sql.push(&format!(" ORDER BY k {direction}, r.id ASC")),
        Key::Column(_) | Key::Order(_) => {
            sql.push(&format!(" ORDER BY k {direction} NULLS LAST, r.id ASC"));
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
    let mut scope = vec![
        json!(ROWS_SCOPE),
        json!(item),
        json!(table),
        json!(asked.filter),
        json!(key.label()),
        json!(asked.descending),
        json!(key.kind()),
    ];
    scope.extend(key.rule().map(|rule| json!(rule)));
    Value::Array(scope).to_string()
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
    sql.append(&key.expression());
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

fn scanned_page(asked: &Selected<'_>, key: &Key, limit: i64) -> Result<Sql> {
    let mut sql =
        Sql::new("SELECT * FROM (SELECT r.id, r.updated_at, json(r.body), json(r.refs), ");
    sql.append(&key.expression());
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
    Ok(sql)
}

/// The key the server keeps for the rows a page sorts by.
enum Kept<'a> {
    /// The table's `order`, in `table_rows.ord`.
    Order,
    /// Another column, in `table_row_keys`.
    Column(&'a str),
}

impl Kept<'_> {
    /// The rows with their kept key, read in `index` where it is named.
    fn rows(
        &self,
        asked: &Selected<'_>,
        index: Option<&str>,
    ) -> Result<(Sql, &'static str, &'static str)> {
        let (mut sql, key, id) = match self {
            Kept::Order => {
                let mut sql = Sql::new(
                    " FROM table_rows r INDEXED BY table_rows_ordered WHERE r.table_seq = ",
                );
                sql.bind(asked.seq);
                (sql, "r.ord", "r.id")
            }
            Kept::Column(name) => {
                let indexed = index.map_or(String::new(), |index| format!("INDEXED BY {index} "));
                let mut sql = Sql::new(&format!(
                    " FROM table_row_keys k {indexed}CROSS JOIN table_rows r \
                     ON r.table_seq = k.table_seq AND r.id = k.id WHERE k.table_seq = "
                ));
                sql.bind(asked.seq);
                sql.push(" AND k.name = ");
                sql.bind(name.to_string());
                (sql, "k.key", "k.id")
            }
        };
        if let Some(expression) = asked.filter {
            conditions(&mut sql, expression, asked.withholding)?;
        }
        Ok((sql, key, id))
    }

    /// The rows that share the key `value` and follow `after` by id.
    fn tied(
        &self,
        asked: &Selected<'_>,
        value: &Bound,
        after: Option<&str>,
        limit: i64,
    ) -> Result<Sql> {
        let (rows, key, id) = self.rows(asked, None)?;
        let mut sql = Sql::new(&format!(
            "SELECT r.id, r.updated_at, json(r.body), json(r.refs), {key}"
        ));
        sql.append(&rows);
        sql.push(&format!(" AND {key} = "));
        sql.bind(value.clone());
        if let Some(after) = after {
            sql.push(&format!(" AND {id} > "));
            sql.bind(after.to_string());
        }
        sql.push(&format!(" ORDER BY {id} ASC LIMIT "));
        sql.bind(limit);
        Ok(sql)
    }

    /// The rows with a key beyond `value` in the page's direction, or every row with a key.
    fn beyond(&self, asked: &Selected<'_>, value: Option<&Bound>, limit: i64) -> Result<Sql> {
        let index = asked.descending.then_some("table_row_keys_descending");
        let (rows, key, id) = self.rows(asked, index)?;
        let mut sql = Sql::new(&format!(
            "SELECT r.id, r.updated_at, json(r.body), json(r.refs), {key}"
        ));
        sql.append(&rows);
        match (asked.descending, value) {
            (true, Some(value)) => {
                sql.push(&format!(" AND {key} < "));
                sql.bind(value.clone());
            }
            (false, Some(value)) => {
                sql.push(&format!(" AND {key} > "));
                sql.bind(value.clone());
                sql.push(&format!(" AND {key} < {NO_KEY}"));
            }
            (_, None) => sql.push(&format!(" AND {key} < {NO_KEY}")),
        }
        let direction = if asked.descending { "DESC" } else { "ASC" };
        sql.push(&format!(" ORDER BY {key} {direction}, {id} ASC LIMIT "));
        sql.bind(limit);
        Ok(sql)
    }
}

/// Separate ranges let a cursor seek past earlier ties in either direction.
fn keyed_page(
    tx: &Transaction<'_>,
    asked: &Selected<'_>,
    kept: &Kept<'_>,
    limit: i64,
) -> Result<Vec<(Held, Bound)>> {
    let after = asked
        .position
        .map(|at| (at.keys.first().cloned().unwrap_or(Bound::Null), at));
    let mut found = match &after {
        Some((value, at)) if *value != Bound::Null => {
            store::page(tx, &kept.tied(asked, value, Some(&at.id), limit)?)?
        }
        _ => Vec::new(),
    };
    let left = limit - found.len() as i64;
    if left > 0 && !matches!(after, Some((Bound::Null, _))) {
        let value = after.as_ref().map(|(value, _)| value);
        found.extend(store::page(tx, &kept.beyond(asked, value, left)?)?);
    }
    let left = limit - found.len() as i64;
    if left > 0 {
        let at = match &after {
            Some((Bound::Null, at)) => Some(at.id.as_str()),
            _ => None,
        };
        let none = Bound::Blob(Vec::new());
        found.extend(
            store::page(tx, &kept.tied(asked, &none, at, left)?)?
                .into_iter()
                .map(|(row, _)| (row, Bound::Null)),
        );
    }
    Ok(found)
}

/// A table and column a page found unkept and may ask the server to keep.
type Unkept = (i64, Sorted);

fn answered_page(
    read: &Reader<'_, '_>,
    item_id: &str,
    table: &str,
    asked: &Page,
) -> Result<(String, Option<Unkept>)> {
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
        .map(|at| resumed(read, seq, &key, &scope, at))
        .transpose()?;
    let mut unkept = None;
    let kept = match (&key, seq) {
        (Key::Order(order), Some(seq))
            if store::ordered_by(read.tx, seq)? == Some(order.signature()) =>
        {
            Some(Kept::Order)
        }
        (Key::Column(sorted), Some(seq)) if table.kept.keyed.holds(sorted) => {
            match keys::standing(read.tx, seq, sorted)? {
                Standing::Ready => Some(Kept::Column(&sorted.column)),
                Standing::Absent if keys::addable(read.tx, seq, sorted)? => {
                    unkept = Some((seq, sorted.clone()));
                    None
                }
                _ => None,
            }
        }
        _ => None,
    };
    let selected = Selected {
        seq,
        filter: filter.as_ref(),
        withholding: &withholding,
        position: position.as_ref(),
        descending: asked.descending,
    };
    let mut found = match &kept {
        Some(kept) => keyed_page(read.tx, &selected, kept, limit + 1)?,
        None if read.faults().fail(FAIL_TABLE_ROWS_SCAN, Some(&table.name)) => {
            return Err(Refusal::internal("the scan of a page of rows failed"));
        }
        None => store::page(read.tx, &scanned_page(&selected, &key, limit + 1)?)?,
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
    Ok((
        printed(&json!({ "data": data, "next_cursor": next }))?,
        unkept,
    ))
}

pub async fn page(
    app: &Arc<App>,
    caller: &Caller,
    item_id: String,
    table: String,
    asked: Page,
) -> Result<String> {
    let (page, unkept) = reading(app, caller, move |read| {
        answered_page(read, &item_id, &table, &asked)
    })
    .await?;
    if let Some((seq, sorted)) = unkept {
        let app = app.clone();
        tokio::spawn(async move { keep_sort_keys(&app, seq, sorted).await });
    }
    Ok(page)
}

/// Registration is optional because a later page can still scan, so no read waits for it.
async fn keep_sort_keys(app: &App, seq: i64, sorted: Sorted) {
    let cache = app.catalog_handle();
    let at = app.clock.stamp();
    let added = app
        .db
        .write(Write::own(), move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            let keyable = lifecycle::keyable(&catalog, tx, seq)?;
            if !keys::add(tx, seq, &keyable, &sorted)? {
                return Ok(());
            }
            housekeeping::bring_forward(tx, lifecycle::CLEANUP_JOB, &at)
        })
        .await;
    if let Err(refusal) = added {
        tracing::warn!(
            code = refusal.code.wire(),
            "Keys for a sort of rows were not added"
        );
    }
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
        |sql| sql.append(&withholding.typed(column, &adding.kind)),
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

    /// The corpus's rows as the server holds them, with each item column's value in `refs`.
    fn held(corpus: &Value) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        let columns = corpus["table"]["columns"].as_object().unwrap();
        for row in corpus["table"]["rows"].as_array().unwrap() {
            let refs: Map<String, Value> = row["body"]
                .as_object()
                .unwrap()
                .iter()
                .filter(|(column, _)| columns[*column]["type"] == "item")
                .map(|(column, value)| (column.clone(), value.clone()))
                .collect();
            db.execute(
                "INSERT INTO table_rows (table_seq, id, updated_at, batch, refs, body) \
                 VALUES (1, ?1, '2026-01-01T00:00:00Z', 0, jsonb(?2), jsonb(?3))",
                params![
                    row["id"].as_str().unwrap(),
                    super::super::refs_text(&refs),
                    row["body"].to_string()
                ],
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

    #[test]
    fn the_rows_are_sorted_by_each_column_as_the_working_copy_sorts_them_scanned_or_kept() {
        let corpus: Value = serde_json::from_str(CORPUS).unwrap();
        let columns = corpus["table"]["columns"].as_object().unwrap();
        let mut db = held(&corpus);
        let tx = db.transaction().unwrap();
        for (column, definition) in columns {
            tx.execute(
                "INSERT INTO table_sort_indexes (table_seq, name, kind) VALUES (1, ?1, ?2)",
                rusqlite::params![column, definition["type"].as_str().unwrap()],
            )
            .unwrap();
        }
        while keys::fill_page(&tx, 2).unwrap().is_some() {}
        for case in corpus["table"]["sorts"].as_array().unwrap() {
            let column = case["by"].as_str().unwrap();
            let kind = columns[column]["type"].as_str().unwrap();
            let key = Key::Column(Sorted {
                column: column.to_string(),
                kind: kind.to_string(),
            })
            .expression();
            for (direction, ids) in [("ASC", &case["ascending"]), ("DESC", &case["descending"])] {
                let ways = [
                    format!(
                        "SELECT r.id FROM table_rows r WHERE r.table_seq = 1 \
                         ORDER BY ({0}) {direction} NULLS LAST, r.id ASC",
                        key.text
                    ),
                    format!(
                        "SELECT id FROM table_rows WHERE table_seq = 1 AND id NOT IN \
                         (SELECT id FROM table_row_keys WHERE table_seq = 1 AND name = '{column}') \
                         UNION ALL SELECT id FROM (SELECT id FROM table_row_keys \
                         WHERE table_seq = 1 AND name = '{column}' \
                         ORDER BY key = X'', CASE WHEN key = X'' THEN NULL ELSE key END \
                         {direction}, id ASC)"
                    ),
                ];
                for way in ways {
                    let found: Vec<String> = tx
                        .prepare(&way)
                        .unwrap()
                        .query_map(params_from_iter(key.values.iter()), |row| row.get(0))
                        .unwrap()
                        .collect::<std::result::Result<_, _>>()
                        .unwrap();
                    assert_eq!(json!(found), *ids, "{column} {direction}: {way}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use rusqlite::StatementStatus;
    use rusqlite::params_from_iter;

    use super::*;

    fn every() -> Withholding {
        Withholding {
            every: true,
            readable: None,
        }
    }

    fn a(kind: &str) -> Sorted {
        Sorted {
            column: "a".into(),
            kind: kind.into(),
        }
    }

    /// The rows the SQL answers and the VM steps it took.
    fn run(tx: &Transaction<'_>, sql: &Sql) -> (Vec<String>, i32) {
        let mut statement = tx.prepare(&sql.text).unwrap();
        let ids = statement
            .query_map(params_from_iter(sql.values.iter()), |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        (ids, statement.get_status(StatementStatus::VmStep))
    }

    fn plan(tx: &Transaction<'_>, sql: &Sql) -> String {
        let mut statement = tx
            .prepare(&format!("EXPLAIN QUERY PLAN {}", sql.text))
            .unwrap();
        statement
            .query_map(params_from_iter(sql.values.iter()), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("; ")
    }

    #[test]
    fn a_column_cursor_answered_before_item_ids_sorted_as_no_value_is_refused() {
        let secret = Secret(vec![7; 32]);
        let position = Position {
            keys: vec![Bound::Text("b".into()), Bound::Null],
            id: "r1".into(),
        };
        for (sort, key) in [
            ("values.a", Key::Column(a("string"))),
            ("values.a", Key::Unkeyed(a("item"))),
        ] {
            let asked = Page {
                sort: Some(sort.into()),
                ..Page::default()
            };
            let kind = key.kind();
            let earlier = json!(["rows", "item", "lines", null, sort, false, kind]).to_string();
            let now = scope("item", "lines", &asked, &key);
            let issued = secret.issue(&now, &position.payload()).unwrap();
            assert!(opened(&secret, &now, &issued).is_ok());
            let old = secret.issue(&earlier, &position.payload()).unwrap();
            let refused = opened(&secret, &now, &old).unwrap_err();
            assert_eq!(refused.code.wire(), "validation_error");
            assert_eq!(refused.details.unwrap()["field"], "cursor");
        }
        let earlier = json!(["rows", "item", "lines", null, "id", false, null]).to_string();
        let old = secret.issue(&earlier, &position.payload()).unwrap();
        let now = scope("item", "lines", &Page::default(), &Key::Id);
        assert!(opened(&secret, &now, &old).is_ok());
    }

    #[test]
    fn an_item_column_sort_reads_rows_in_id_order_in_either_direction_with_no_sort() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        db.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30) \
             INSERT INTO table_rows (table_seq, id, updated_at, batch, body) \
             SELECT 1, printf('%03d', i), '', 0, jsonb(json_object('a', printf('%03d', 31 - i))) \
             FROM n",
            [],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        let key = Key::Unkeyed(a("item"));
        let withholding = every();
        let ids = |from: u32, to: u32| (from..=to).map(|n| format!("{n:03}")).collect::<Vec<_>>();
        for descending in [false, true] {
            let mut asked = Selected {
                seq: Some(1),
                filter: None,
                withholding: &withholding,
                position: None,
                descending,
            };
            let first = scanned_page(&asked, &key, 10).unwrap();
            assert!(
                !plan(&tx, &first).contains("B-TREE"),
                "{}",
                plan(&tx, &first)
            );
            assert_eq!(run(&tx, &first).0, ids(1, 10));
            let at = Position {
                keys: vec![Bound::Null, Bound::Null],
                id: "010".into(),
            };
            asked.position = Some(&at);
            let next = scanned_page(&asked, &key, 10).unwrap();
            assert!(!plan(&tx, &next).contains("B-TREE"), "{}", plan(&tx, &next));
            assert_eq!(run(&tx, &next).0, ids(11, 20));
        }
    }

    #[test]
    fn a_kept_page_reads_only_the_rows_it_answers_however_many_keys_tie() {
        let rows = 20_000;
        let mut db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        db.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) \
             INSERT INTO table_rows (table_seq, id, updated_at, batch, body) \
             SELECT 1, printf('%06d', i), '', 0, \
             jsonb(json_object('a', CASE WHEN i % 1000 = 0 THEN i / 1000 ELSE 7 END)) FROM n",
            [rows],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        for kind in ["number", "boolean", "enum"] {
            tx.execute("DELETE FROM table_row_keys", []).unwrap();
            tx.execute("DELETE FROM table_sort_indexes", []).unwrap();
            if kind != "number" {
                tx.execute(
                    "UPDATE table_rows SET body = jsonb_set(body, '$.a', \
                     CASE WHEN json_extract(body, '$.a') = 7 THEN json(?1) ELSE json(?2) END)",
                    match kind {
                        "boolean" => ["true", "false"],
                        _ => ["\"m\"", "\"a\""],
                    },
                )
                .unwrap();
            }
            tx.execute(
                "INSERT INTO table_sort_indexes (table_seq, name, kind) VALUES (1, 'a', ?1)",
                [kind],
            )
            .unwrap();
            while keys::fill_page(&tx, 5_000).unwrap().is_some() {}
            let withholding = every();
            let kept = Kept::Column("a");
            for descending in [false, true] {
                let mut asked = Selected {
                    seq: Some(1),
                    filter: None,
                    withholding: &withholding,
                    position: None,
                    descending,
                };
                let first = kept.beyond(&asked, None, 51).unwrap();
                let (_, steps) = run(&tx, &first);
                assert!(steps < 2_000, "{kind} first page {descending}: {steps}");
                let value: Bound = tx
                    .query_row(
                        "SELECT key FROM table_row_keys WHERE table_seq = 1 AND id = '000001'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let at = Position {
                    keys: vec![value.clone(), Bound::Null],
                    id: format!("{:06}", rows * 8 / 10 + 1),
                };
                asked.position = Some(&at);
                let tied = kept.tied(&asked, &value, Some(&at.id), 51).unwrap();
                let (found, steps) = run(&tx, &tied);
                assert!(steps < 2_000, "{kind} deep tie {descending}: {steps}");
                assert_eq!(found.len(), 51);
                assert!(found.windows(2).all(|pair| pair[0] < pair[1]));
                let beyond = kept.beyond(&asked, Some(&value), 51).unwrap();
                let (_, steps) = run(&tx, &beyond);
                assert!(steps < 2_000, "{kind} deep beyond {descending}: {steps}");
                for sql in [first, tied, beyond] {
                    let plan = plan(&tx, &sql);
                    assert!(!plan.contains("B-TREE") && !plan.contains("SCAN"), "{plan}");
                }
                let page = keyed_page(&tx, &asked, &kept, 51).unwrap();
                let ids: Vec<&str> = page.iter().map(|(row, _)| row.id.as_str()).collect();
                assert_eq!(ids, found.iter().map(String::as_str).collect::<Vec<_>>());
            }
        }
    }
}
