//! Row retention across item purges and schema changes.

use std::collections::BTreeSet;
use std::sync::Arc;

use marfa_rules::schema::{
    OWN_COLUMNS, OWN_TABLE, Registry, item_table_changes, judge_item_columns, keeps_own_table,
};
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::{store, tables_by_name};
use crate::app::App;
use crate::app::access::{Caller, Permission};
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
