//! Row retention across item purges and schema changes.

use std::collections::BTreeSet;
use std::sync::Arc;

use marfa_rules::schema::OWN_TABLE;
use rusqlite::Transaction;
use serde_json::{Value, json};

use super::store;
use super::tables_of;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::housekeeping::{self, Report, Run};
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Write;

pub const CLEANUP_JOB: &str = "table-row-cleanup";
/// About 2 ms of the writer on the reference machine, so other writes wait little behind a page.
const CLEANUP_PAGE: i64 = 1_000;

/// A purged item's rows go to `table-row-cleanup`, which removes them a page at a time.
pub fn doom(tx: &Transaction<'_>, seq: i64, at: &str) -> Result<()> {
    if store::doom(tx, seq)? {
        housekeeping::bring_forward(tx, CLEANUP_JOB, at)?;
    }
    Ok(())
}

pub async fn cleanup(app: Arc<App>, run: Run) -> Result<Report> {
    let (mut removed, mut pages) = (0_i64, 0_i64);
    loop {
        let page = app
            .db
            .write(Write::own(), |tx| store::remove_page(tx, CLEANUP_PAGE))
            .await?;
        let Some(taken) = page else {
            return Ok(Report::done(json!({ "removed": removed, "pages": pages })));
        };
        removed += taken;
        pages += 1;
        if !run.go_on().await {
            return Ok(Report {
                result: json!({ "removed": removed, "pages": pages }),
                again: true,
            });
        }
    }
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
    let mut declared: Vec<String> = tables_of(catalog, to)
        .into_iter()
        .map(|table| table.name)
        .collect();
    if catalog.rules.keeps_own_table(to) {
        declared.push(OWN_TABLE.to_string());
    }
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

/// Names referring columns as `<type>.<table>.<column>`, and those an item of `core.table` declares as
/// `<item>.table.<column>`, or `<type>.table.<column>` where the caller may not read the item's type.
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
        .filter(|id| catalog.rules.keeps_own_table(id))
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
