//! Row retention, order keys and the row index across item purges and schema changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::order::Order;
use super::search::{self, Indexing, Searched};
use super::store::{self, Ordering};
use super::tables_of;
use crate::app::App;
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

fn declared(catalog: &Catalog, type_id: &str) -> BTreeMap<String, (Option<Order>, Searched)> {
    tables_of(catalog, type_id)
        .into_iter()
        .map(|table| (table.name, (table.order, table.searched)))
        .collect()
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
    for type_id in types {
        let wanted = declared(after, type_id);
        if declared(before, type_id) == wanted {
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
    at: &str,
) -> Result<()> {
    let wanted = declared(catalog, type_id);
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

fn undeclared(catalog: &Catalog, to: &str, held: Vec<String>) -> Vec<String> {
    let declared: Vec<String> = tables_of(catalog, to)
        .into_iter()
        .map(|table| table.name)
        .collect();
    held.into_iter()
        .filter(|name| !declared.contains(name))
        .collect()
}

pub fn refuse_undeclared(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    seq: i64,
    to: &str,
) -> Result<()> {
    let left = undeclared(catalog, to, store::held_tables(tx, seq)?);
    if left.is_empty() {
        Ok(())
    } else {
        Err(blocked(left))
    }
}

pub fn refuse_moving_type(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    from: &str,
    to: &str,
) -> Result<()> {
    let left = undeclared(catalog, to, store::held_tables_of_type(tx, from)?);
    if left.is_empty() {
        Ok(())
    } else {
        Err(blocked(left))
    }
}

/// Names held data as `<table>` or `<table>.<column>`.
pub fn held_in_use(
    tx: &Transaction<'_>,
    before: &Catalog,
    after: &marfa_rules::schema::Registry,
    family: &[String],
) -> Result<Vec<String>> {
    let mut found = BTreeSet::new();
    for type_id in family {
        let kept = after_tables(after, type_id);
        let held = store::held_tables_of_type(tx, type_id)?;
        for table in tables_of(before, type_id) {
            if !held.contains(&table.name) {
                continue;
            }
            let Some(next) = kept
                .get(&table.name)
                .and_then(|t| t.get("columns"))
                .and_then(Value::as_object)
            else {
                found.insert(table.name.clone());
                continue;
            };
            for (column, definition) in &table.columns {
                let same = next
                    .get(column)
                    .is_some_and(|now| now.get("type") == definition.get("type"));
                if !same && store::column_held(tx, type_id, &table.name, column)? {
                    found.insert(format!("{}.{column}", table.name));
                }
            }
        }
    }
    Ok(found.into_iter().collect())
}

fn after_tables(
    registry: &marfa_rules::schema::Registry,
    type_id: &str,
) -> serde_json::Map<String, Value> {
    marfa_rules::schema::resolve(registry, type_id, true)
        .ok()
        .flatten()
        .and_then(|resolved| resolved.get("tables").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// Names referring columns as `<type>.<table>.<column>`.
pub fn constraining_columns(catalog: &Catalog, type_id: &str) -> Vec<String> {
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
    found.sort();
    found
}
