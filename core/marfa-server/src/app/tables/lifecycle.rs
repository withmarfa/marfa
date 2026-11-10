//! Row retention and order keys across item purges and schema changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::order::Order;
use super::store::{self, Ordering};
use super::tables_of;
use crate::app::App;
use crate::app::catalog::Catalog;
use crate::app::housekeeping::{self, Report, Run};
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

pub const CLEANUP_JOB: &str = "table-row-cleanup";
/// About 2 ms of the writer on the reference machine, so other writes wait little behind a page.
pub(super) const CLEANUP_PAGE: i64 = 1_000;

pub fn doom(tx: &Transaction<'_>, seq: i64, at: &str) -> Result<()> {
    if store::doom(tx, seq)? {
        housekeeping::bring_forward(tx, CLEANUP_JOB, at)?;
    }
    Ok(())
}

/// Removes purged items' rows, then writes the order keys of tables whose order changed.
pub async fn cleanup(app: Arc<App>, run: Run) -> Result<Report> {
    let (mut removed, mut reordered, mut pages) = (0_i64, 0_i64, 0_i64);
    let result = |removed, reordered, pages| json!({ "removed": removed, "reordered": reordered, "pages": pages });
    loop {
        let page = app
            .db
            .write(Write::own(), |tx| {
                Ok(match store::remove_page(tx, CLEANUP_PAGE)? {
                    Some(taken) => Some((taken, 0)),
                    None => store::reorder_page(tx, CLEANUP_PAGE)?.map(|taken| (0, taken)),
                })
            })
            .await?;
        let Some((taken, keyed)) = page else {
            return Ok(Report::done(result(removed, reordered, pages)));
        };
        removed += taken;
        reordered += keyed;
        pages += 1;
        if !run.go_on().await {
            return Ok(Report {
                result: result(removed, reordered, pages),
                again: true,
            });
        }
    }
}

fn orders(catalog: &Catalog, type_id: &str) -> BTreeMap<String, Option<Order>> {
    tables_of(catalog, type_id)
        .into_iter()
        .map(|table| (table.name, table.order))
        .collect()
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
        let declared = orders(after, type_id);
        if orders(before, type_id) == declared {
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
    let declared = orders(catalog, type_id);
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
