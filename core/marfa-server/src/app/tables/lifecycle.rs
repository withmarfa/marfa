//! Row retention, order keys and the row index across item purges and schema changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use marfa_rules::schema::{
    OWN_COLUMNS, OWN_TABLE, Registry, item_table_changes, judge_item_columns, keeps_own_table,
};
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::order::Order;
use super::search::{self, Indexing, Searched};
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
    reindexed: i64,
    pages: i64,
}

impl Tally {
    fn add(&mut self, page: &Page) {
        match page {
            Page::Removed(removed) => {
                self.rows += removed.rows;
                self.batches += removed.batches;
                self.changes += removed.changes;
            }
            Page::Reordered(rows) => self.reordered += rows,
            Page::Reindexed(rows) => self.reindexed += rows,
        }
        self.pages += 1;
    }

    fn report(&self, again: bool) -> Report {
        Report {
            result: json!({
                "removed": self.rows,
                "batches_removed": self.batches,
                "changes_removed": self.changes,
                "reordered": self.reordered,
                "reindexed": self.reindexed,
                "pages": self.pages,
            }),
            again,
            failure: None,
        }
    }
}

enum Page {
    Removed(store::Removed),
    Reordered(i64),
    Reindexed(i64),
}

#[derive(Clone, Copy)]
enum Stage {
    Purged,
    Reordered,
    Reindexed,
    Orphaned,
    Expired,
}

pub async fn cleanup(app: Arc<App>, run: Run) -> Result<Report> {
    let mut tally = Tally::default();
    for stage in [
        Stage::Purged,
        Stage::Reordered,
        Stage::Reindexed,
        Stage::Orphaned,
        Stage::Expired,
    ] {
        loop {
            let live = app.clone();
            let page = app
                .db
                .write(Write::own(), move |tx| {
                    Ok(match stage {
                        Stage::Purged => store::remove_page(tx, CLEANUP_PAGE)?.map(Page::Removed),
                        Stage::Reordered => {
                            store::reorder_page(tx, CLEANUP_PAGE)?.map(Page::Reordered)
                        }
                        Stage::Reindexed => {
                            search::reindex_page(tx, CLEANUP_PAGE)?.map(Page::Reindexed)
                        }
                        Stage::Orphaned => store::orphan_page(tx, CLEANUP_PAGE)?.map(Page::Removed),
                        Stage::Expired => {
                            match cutoff(tx, &live, ROW_LOG_RETENTION_DAYS, DAY_MS)? {
                                Some(before) => store::expire_page(tx, &before, CLEANUP_PAGE)?
                                    .map(Page::Removed),
                                None => None,
                            }
                        }
                    })
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

type Declared = BTreeMap<String, (Option<Order>, Searched)>;

/// What each table of an item of `type_id` holding `properties` keeps: its order and the columns
/// it is searched by. An item's own table keeps no order.
fn declared(catalog: &Catalog, type_id: &str, properties: &Map<String, Value>) -> Result<Declared> {
    if !catalog.types.contains(type_id) {
        return Ok(BTreeMap::new());
    }
    Ok(item_tables(&catalog.types, type_id, properties)?
        .into_iter()
        .map(|table| (table.name, (table.order, table.searched)))
        .collect())
}

// The inline budget spans every table affected by the change.
fn settle_order(
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

fn settle_index(
    tx: &Transaction<'_>,
    held: &Indexing,
    searched: &Searched,
    at: &str,
    rewritten: &mut i64,
) -> Result<()> {
    let wanted = searched.signature();
    let settled = match &held.rebuilding {
        Some(target) => *target == wanted,
        None => held.searched_by.as_deref() == Some(wanted.as_str()),
    };
    if settled {
        return Ok(());
    }
    if *rewritten + held.row_count <= CLEANUP_PAGE {
        *rewritten += held.row_count;
        return search::reindex_whole(tx, held.table_seq, searched);
    }
    search::reindex_later(tx, held.table_seq, searched)?;
    housekeeping::bring_forward(tx, CLEANUP_JOB, at)
}

#[derive(Default)]
struct Rewritten {
    ordered: i64,
    indexed: i64,
}

fn settle(
    tx: &Transaction<'_>,
    declared: &BTreeMap<String, (Option<Order>, Searched)>,
    orderings: Vec<Ordering>,
    indexings: Vec<Indexing>,
    at: &str,
    rewritten: &mut Rewritten,
) -> Result<()> {
    let none = (None, Searched::default());
    for held in orderings {
        let (order, _) = declared.get(&held.table).unwrap_or(&none);
        settle_order(tx, &held, order.as_ref(), at, &mut rewritten.ordered)?;
    }
    for held in indexings {
        let (_, searched) = declared.get(&held.table).unwrap_or(&none);
        settle_index(tx, &held, searched, at, &mut rewritten.indexed)?;
    }
    Ok(())
}

pub fn rekey_types(
    tx: &Transaction<'_>,
    before: &Catalog,
    after: &Catalog,
    types: &[String],
    at: &str,
) -> Result<()> {
    let mut rewritten = Rewritten::default();
    let none = Map::new();
    for type_id in types {
        if keeps_own_table(&before.types, type_id) || keeps_own_table(&after.types, type_id) {
            for (seq, properties) in store::holders_of_type(tx, type_id)? {
                let properties = parsed(&properties)?;
                let wanted = declared(after, type_id, &properties)?;
                if declared(before, type_id, &properties)? == wanted {
                    continue;
                }
                let orderings = store::orderings_of_item(tx, seq)?;
                let indexings = search::indexings_of_item(tx, seq)?;
                settle(tx, &wanted, orderings, indexings, at, &mut rewritten)?;
            }
            continue;
        }
        let wanted = declared(after, type_id, &none)?;
        if declared(before, type_id, &none)? == wanted {
            continue;
        }
        let orderings = store::orderings_of_type(tx, type_id)?;
        let indexings = search::indexings_of_type(tx, type_id)?;
        settle(tx, &wanted, orderings, indexings, at, &mut rewritten)?;
    }
    Ok(())
}

pub fn rekey_item(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    seq: i64,
    type_id: &str,
    properties: &Map<String, Value>,
    at: &str,
) -> Result<()> {
    let wanted = declared(catalog, type_id, properties)?;
    let orderings = store::orderings_of_item(tx, seq)?;
    let indexings = search::indexings_of_item(tx, seq)?;
    settle(
        tx,
        &wanted,
        orderings,
        indexings,
        at,
        &mut Rewritten::default(),
    )
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
