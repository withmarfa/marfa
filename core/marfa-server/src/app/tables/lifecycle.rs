//! Row retention and order keys across item purges and schema changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use marfa_rules::schema::{
    OWN_COLUMNS, OWN_TABLE, Registry, item_table_changes, judge_item_columns, keeps_own_table,
};
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::order::Order;
use super::store::{self, Ordering};
use super::{item_tables, tables_by_name};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::catalog::Catalog;
use crate::app::housekeeping::{self, DAY_MS, Report, Run, cutoff, report_kept};
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;
use crate::settings::registry::ROW_LOG_RETENTION_DAYS;

pub const CLEANUP_JOB: &str = "table-row-cleanup";
/// About 2 ms of the writer on the reference machine, so other writes wait little behind a page.
pub(super) const CLEANUP_PAGE: i64 = 1_000;

pub fn doom(tx: &Transaction<'_>, seq: i64, at: &str) -> Result<()> {
    if store::doom(tx, seq)? {
        housekeeping::bring_forward(tx, CLEANUP_JOB, at)?;
    }
    Ok(())
}

#[derive(Default)]
struct Tally {
    rows: i64,
    batches: i64,
    changes: i64,
    reordered: i64,
    pages: i64,
}

impl Tally {
    fn add(&mut self, (page, reordered): &(store::Removed, i64)) {
        self.rows += page.rows;
        self.batches += page.batches;
        self.changes += page.changes;
        self.reordered += reordered;
        self.pages += 1;
    }

    fn report(&self, again: bool) -> Report {
        Report {
            result: json!({
                "removed": self.rows,
                "batches_removed": self.batches,
                "changes_removed": self.changes,
                "reordered": self.reordered,
                "pages": self.pages,
            }),
            again,
        }
    }
}

#[derive(Clone, Copy)]
enum Stage {
    Purged,
    Reordered,
    Orphaned,
    Expired,
}

pub async fn cleanup(app: Arc<App>, run: Run) -> Result<Report> {
    let mut tally = Tally::default();
    for stage in [
        Stage::Purged,
        Stage::Reordered,
        Stage::Orphaned,
        Stage::Expired,
    ] {
        loop {
            let live = app.clone();
            let page = app
                .db
                .write(Write::own(), move |tx| {
                    let removed = match stage {
                        Stage::Purged => store::remove_page(tx, CLEANUP_PAGE)?,
                        Stage::Reordered => {
                            return Ok(store::reorder_page(tx, CLEANUP_PAGE)?
                                .map(|keyed| (store::Removed::default(), keyed)));
                        }
                        Stage::Orphaned => store::orphan_page(tx, CLEANUP_PAGE)?,
                        Stage::Expired => {
                            match cutoff(tx, &live, ROW_LOG_RETENTION_DAYS, DAY_MS)? {
                                Some(before) => store::expire_page(tx, &before, CLEANUP_PAGE)?,
                                None => None,
                            }
                        }
                    };
                    Ok(removed.map(|removed| (removed, 0)))
                })
                .await?;
            let Some(page) = page else {
                break;
            };
            tally.add(&page);
            if !run.go_on().await {
                return Ok(tally.report(true));
            }
        }
    }
    report_kept(&app, &run, ROW_LOG_RETENTION_DAYS, DAY_MS, &store::UNREAD).await?;
    Ok(tally.report(false))
}

/// The order each table a type declares keeps; an item's own table keeps none.
fn orders(catalog: &Catalog, type_id: &str) -> Result<BTreeMap<String, Option<Order>>> {
    if !catalog.types.contains(type_id) {
        return Ok(BTreeMap::new());
    }
    Ok(item_tables(&catalog.types, type_id, &Map::new())?
        .into_iter()
        .map(|table| (table.name, table.order))
        .collect())
}

/// Rewrites a table's keys now while the change has rewritten at most one page of rows in all, and
/// leaves the rest to `table-row-cleanup`. `rewritten` is the rows rewritten so far.
fn settle(
    tx: &Transaction<'_>,
    held: &Ordering,
    order: Option<&Order>,
    at: &str,
    rewritten: &mut i64,
) -> Result<()> {
    let wanted = order.map(Order::signature);
    let settled = match &held.rebuilding {
        Some(target) => *target == wanted,
        None => held.ordered_by == wanted,
    };
    if settled {
        return Ok(());
    }
    if *rewritten + held.row_count <= CLEANUP_PAGE {
        *rewritten += held.row_count;
        return store::reorder_whole(tx, held.table_seq, order);
    }
    store::reorder_later(tx, held.table_seq, order)?;
    housekeeping::bring_forward(tx, CLEANUP_JOB, at)
}

pub fn reorder_types(
    tx: &Transaction<'_>,
    before: &Catalog,
    after: &Catalog,
    types: &[String],
    at: &str,
) -> Result<()> {
    let mut rewritten = 0;
    for type_id in types {
        let declared = orders(after, type_id)?;
        if orders(before, type_id)? == declared {
            continue;
        }
        for held in store::orderings_of_type(tx, type_id)? {
            let order = declared.get(&held.table).cloned().flatten();
            settle(tx, &held, order.as_ref(), at, &mut rewritten)?;
        }
    }
    Ok(())
}

pub fn reorder_item(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    seq: i64,
    type_id: &str,
    at: &str,
) -> Result<()> {
    let declared = orders(catalog, type_id)?;
    let mut rewritten = 0;
    for held in store::orderings_of_item(tx, seq)? {
        let order = declared.get(&held.table).cloned().flatten();
        settle(tx, &held, order.as_ref(), at, &mut rewritten)?;
    }
    Ok(())
}

fn blocked(tables: Vec<String>) -> Refusal {
    Refusal::new(
        Code::TypeMoveBlocked,
        format!(
            "The target type does not declare {}, which items hold rows in. Declare them on the target first.",
            tables.join(", ")
        ),
    )
    .with_detail("tables", tables)
}

fn parsed(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(properties)) => Ok(properties),
        _ => Err(Refusal::internal("a stored item's properties do not read")),
    }
}

pub type Shape<'a> = (&'a str, &'a Map<String, Value>);

pub fn judge_item_change(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    caller: &Caller,
    seq: i64,
    (was_type, was): Shape<'_>,
    (is_type, is): Shape<'_>,
) -> Result<()> {
    let moved = was_type != is_type;
    if !moved && !keeps_own_table(&catalog.types, is_type) {
        return Ok(());
    }
    let before = tables_by_name(&catalog.types, was_type, was)?;
    let after = tables_by_name(&catalog.types, is_type, is)?;
    if moved {
        let left: Vec<String> = store::held_tables(tx, seq)?
            .into_iter()
            .filter(|name| !after.contains_key(name))
            .collect();
        if !left.is_empty() {
            return Err(blocked(left));
        }
    }
    if caller.holds(Permission::SchemaWrite) {
        return Ok(());
    }
    let changes = item_table_changes(&before, &after, keeps_own_table(&catalog.types, is_type));
    if changes.is_empty() {
        return Ok(());
    }
    Err(Refusal::new(
        Code::Forbidden,
        format!(
            "Changing {} requires schema.write. A credential without it may add optional columns and change a column's label and description.",
            changes.join(", ")
        ),
    )
    .with_detail("required_scope", Permission::SchemaWrite.word())
    .with_detail("changes", changes))
}

pub fn refuse_moving_type(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    from: &str,
    to: &str,
) -> Result<()> {
    let mut left = BTreeSet::new();
    for (seq, properties) in store::holders_of_type(tx, from)? {
        let after = tables_by_name(&catalog.types, to, &parsed(&properties)?)?;
        left.extend(
            store::held_tables(tx, seq)?
                .into_iter()
                .filter(|name| !after.contains_key(name)),
        );
    }
    if left.is_empty() {
        Ok(())
    } else {
        Err(blocked(left.into_iter().collect()))
    }
}

fn lost(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    held: &[String],
    column_held: &mut dyn FnMut(&str, &str) -> Result<bool>,
    found: &mut BTreeSet<String>,
) -> Result<()> {
    for (name, table) in before {
        if !held.contains(name) {
            continue;
        }
        let Some(next) = after
            .get(name)
            .and_then(|table| table.get("columns"))
            .and_then(Value::as_object)
        else {
            found.insert(name.clone());
            continue;
        };
        for (column, definition) in table
            .get("columns")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let same = next
                .get(column)
                .is_some_and(|now| now.get("type") == definition.get("type"));
            if !same && column_held(name, column)? {
                found.insert(format!("{name}.{column}"));
            }
        }
    }
    Ok(())
}

/// Names held data as `<table>` or `<table>.<column>`.
pub fn held_in_use(
    tx: &Transaction<'_>,
    before: &Registry,
    after: &Registry,
    family: &[String],
) -> Result<Vec<String>> {
    let mut found = BTreeSet::new();
    let none = Map::new();
    for type_id in family {
        if keeps_own_table(before, type_id) || keeps_own_table(after, type_id) {
            for (seq, properties) in store::holders_of_type(tx, type_id)? {
                let properties = parsed(&properties)?;
                lost(
                    &tables_by_name(before, type_id, &properties)?,
                    &tables_by_name(after, type_id, &properties)?,
                    &store::held_tables(tx, seq)?,
                    &mut |table, column| store::item_column_held(tx, seq, table, column),
                    &mut found,
                )?;
            }
        } else {
            lost(
                &tables_by_name(before, type_id, &none)?,
                &tables_by_name(after, type_id, &none)?,
                &store::held_tables_of_type(tx, type_id)?,
                &mut |table, column| store::column_held(tx, type_id, table, column),
                &mut found,
            )?;
        }
    }
    Ok(found.into_iter().collect())
}

/// Counts, by type, the items `after` first places under `core.table` whose `columns` a table cannot take.
pub fn unkept_columns(
    tx: &Transaction<'_>,
    before: &Registry,
    after: &Registry,
    family: &[String],
) -> Result<Vec<(String, usize)>> {
    let mut found = Vec::new();
    for type_id in family {
        if keeps_own_table(before, type_id) || !keeps_own_table(after, type_id) {
            continue;
        }
        let mut refused = 0;
        for (_, properties) in store::naming_columns(tx, type_id)? {
            let columns = parsed(&properties)?.remove(OWN_COLUMNS);
            if judge_item_columns(columns.as_ref(), &|_| true).is_err() {
                refused += 1;
            }
        }
        if refused > 0 {
            found.push((type_id.clone(), refused));
        }
    }
    Ok(found)
}

/// Hidden holders are named by type, never by item ID.
pub fn constraining_columns(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    caller: &Caller,
    type_id: &str,
) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for (owner, definition) in catalog.types.rows() {
        if owner == type_id {
            continue;
        }
        let Some(Value::Object(tables)) = definition.get("tables") else {
            continue;
        };
        for (table, declared) in tables {
            let Some(Value::Object(columns)) = declared.get("columns") else {
                continue;
            };
            for (column, definition) in columns {
                let names = definition
                    .get("type_constraints")
                    .and_then(Value::as_array)
                    .is_some_and(|admits| {
                        admits.iter().any(|admit| admit.as_str() == Some(type_id))
                    });
                if names {
                    found.push(format!("{owner}.{table}.{column}"));
                }
            }
        }
    }
    let keepers: Vec<&str> = catalog
        .types
        .ids()
        .into_iter()
        .filter(|id| keeps_own_table(&catalog.types, id))
        .collect();
    for (id, item_type, column) in store::own_columns_naming(tx, &keepers, type_id)? {
        let holder = if caller.may_read_type(&item_type) {
            id
        } else {
            item_type
        };
        found.push(format!("{holder}.{OWN_TABLE}.{column}"));
    }
    found.sort();
    Ok(found)
}
