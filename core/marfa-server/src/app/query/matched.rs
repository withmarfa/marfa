use rusqlite::Transaction;

use super::compile::{Ask, Sql, States, judge_terms, judge_type, selection};
use super::listing::page_sql;
use super::order::{Order, Sort};
use super::reach::Reach;
use crate::app::access::{Caller, Level};
use crate::app::catalog::Catalog;
use crate::app::items::Reader;
use crate::app::refusal::Result;

/// The items a bulk action's filter matches, in a listing's default order: only those the caller
/// may write, among `only` where it is named, and at most one more than `cap`. A type the catalog
/// lacks matches nothing.
pub(crate) fn matched(
    read: &Reader<'_, '_>,
    ask: &Ask,
    cap: i64,
    only: Option<&[String]>,
) -> Result<Vec<String>> {
    for entry in &ask.types {
        if read.catalog.rules.known(entry) {
            judge_type(read, entry)?;
        }
    }
    judge_terms(read, ask)?;
    let reach = Reach::of(read)?.narrowed(|type_id| writes(&read.caller, type_id));
    let order = Order::listing(&Sort::default(), ask);
    let mut selected = selection(&reach, ask, &read.catalog, order.walked())?;
    if let Some(only) = only {
        selected.push(" AND i.id IN (SELECT value FROM json_each(");
        selected.bind(serde_json::to_string(only).map_err(|_| {
            crate::app::refusal::Refusal::internal("a list of IDs did not print")
        })?);
        selected.push("))");
    }
    let sql = page_sql(&selected, ask, &order, None, cap);
    let width = order.width();
    let mut statement = read.tx.prepare(&sql.text)?;
    let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        row.get::<_, String>(width + 1)
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn writes(caller: &Caller, type_id: &str) -> bool {
    caller.require_type(type_id, Level::Write).is_ok()
}

fn of_type(type_id: &str) -> Ask {
    Ask {
        types: vec![type_id.to_string()],
        states: States::Every,
        ..Ask::default()
    }
}

/// Every item of exactly `type_id`, in any state, that the caller's source filter shows.
pub(crate) fn of_exact_type(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    type_id: &str,
) -> Result<Vec<String>> {
    let reach = Reach::within(tx, caller, catalog)?.narrowed(|held| held == type_id);
    let mut sql = Sql::new("SELECT i.id FROM items i WHERE ");
    sql.append(&selection(&reach, &of_type(type_id), catalog, false)?);
    sql.push(" ORDER BY i.seq");
    let mut statement = tx.prepare(&sql.text)?;
    let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// How many items of exactly `type_id` the caller's source filter shows.
pub(crate) fn count_of_exact_type(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    type_id: &str,
) -> Result<i64> {
    let reach = Reach::within(tx, caller, catalog)?.narrowed(|held| held == type_id);
    let mut sql = Sql::new("SELECT COUNT(*) FROM items i WHERE ");
    sql.append(&selection(&reach, &of_type(type_id), catalog, false)?);
    Ok(tx.query_row(&sql.text, rusqlite::params_from_iter(&sql.values), |row| {
        row.get(0)
    })?)
}
