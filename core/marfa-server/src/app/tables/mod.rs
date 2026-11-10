//! Row writes share one transaction per batch.

mod events;
mod lifecycle;
mod read;
mod store;

use std::collections::HashMap;

use marfa_rules::validation;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::App;
use super::access::Caller;
use super::catalog::{self, Catalog, Snapshot};
use super::items::{self, Host};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;

pub use events::{ROWS_CHANGED, judged as judged_event};
pub use lifecycle::{
    cleanup, constraining_columns, doom, held_in_use, refuse_moving_type, refuse_undeclared,
};
pub use read::{Page, get, list, page, totals};

/// A batch of 1000 rows of 1 KB each holds the writer for about 10 ms on the reference machine.
pub const MAX_OPERATIONS: usize = 1000;
/// A row's values as JSON; a longer text belongs in a file item the row points at.
pub const MAX_ROW_BYTES: usize = 65_536;

#[derive(Debug)]
pub enum Op {
    Put {
        id: Option<String>,
        values: Map<String, Value>,
    },
    Patch {
        id: String,
        values: Map<String, Value>,
    },
    Delete {
        id: String,
    },
}

impl Op {
    fn values(&self) -> Option<&Map<String, Value>> {
        match self {
            Op::Put { values, .. } | Op::Patch { values, .. } => Some(values),
            Op::Delete { .. } => None,
        }
    }
}

fn refused_at(index: usize, path: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    let path = if path.is_empty() {
        format!("operations.{index}")
    } else {
        format!("operations.{index}.{path}")
    };
    Refusal::validation(format!("{path}: {message}"))
        .with_detail("operation", index)
        .with_detail("errors", json!([{ "path": path, "message": message }]))
}

fn whole_batch(message: &str) -> Refusal {
    Refusal::validation(message.to_string())
        .with_detail("field", "operations")
        .with_detail(
            "errors",
            json!([{ "path": "operations", "message": message }]),
        )
}

fn row_id(index: usize, value: Option<&Value>, required: bool) -> Result<Option<String>> {
    match value {
        None if required => Err(refused_at(
            index,
            "id",
            "This operation names the row by id.",
        )),
        None => Ok(None),
        Some(Value::String(id)) if validation::id("id", id).is_ok() => Ok(Some(id.clone())),
        Some(_) => Err(refused_at(
            index,
            "id",
            "A row id is a UUIDv7 in lowercase.",
        )),
    }
}

fn values_of(index: usize, value: Option<&Value>) -> Result<Map<String, Value>> {
    let Some(Value::Object(values)) = value else {
        return Err(refused_at(
            index,
            "values",
            "values is an object keyed by column.",
        ));
    };
    Ok(values.clone())
}

/// The row an operation leaves, as JSON, is at most [`MAX_ROW_BYTES`].
fn refuse_wide(index: usize, values: &Map<String, Value>) -> Result<i64> {
    let bytes = store::printed_len(values);
    if bytes > MAX_ROW_BYTES as i64 {
        return Err(refused_at(
            index,
            "values",
            format!(
                "A row holds at most {MAX_ROW_BYTES} bytes of values as JSON; this operation leaves {bytes}."
            ),
        ));
    }
    Ok(bytes)
}

const OP_FIELDS: [&str; 3] = ["op", "id", "values"];

pub fn operations(sent: Option<&Value>) -> Result<Vec<Op>> {
    let Some(Value::Array(sent)) = sent else {
        return Err(whole_batch("operations is a list of operations."));
    };
    if sent.is_empty() {
        return Err(whole_batch("operations names at least one operation."));
    }
    if sent.len() > MAX_OPERATIONS {
        return Err(whole_batch(&format!(
            "A batch holds at most {MAX_OPERATIONS} operations; this holds {}.",
            sent.len()
        )));
    }
    sent.iter()
        .enumerate()
        .map(|(index, entry)| {
            let Value::Object(entry) = entry else {
                return Err(whole_batch("Each operation is an object."));
            };
            if let Some(unknown) = entry.keys().find(|key| !OP_FIELDS.contains(&key.as_str())) {
                return Err(refused_at(
                    index,
                    unknown,
                    "An operation names op, id and values.",
                ));
            }
            match entry.get("op").and_then(Value::as_str) {
                Some("put") => Ok(Op::Put {
                    id: row_id(index, entry.get("id"), false)?,
                    values: values_of(index, entry.get("values"))?,
                }),
                Some("patch") => Ok(Op::Patch {
                    id: row_id(index, entry.get("id"), true)?.unwrap_or_default(),
                    values: values_of(index, entry.get("values"))?,
                }),
                Some("delete") if entry.contains_key("values") => {
                    Err(refused_at(index, "values", "A delete sends no values."))
                }
                Some("delete") => Ok(Op::Delete {
                    id: row_id(index, entry.get("id"), true)?.unwrap_or_default(),
                }),
                _ => Err(refused_at(index, "op", "op is put, patch or delete.")),
            }
        })
        .collect()
}

pub(crate) fn not_found_table(table: &str) -> Refusal {
    Refusal::new(
        Code::TableNotFound,
        format!("The item's type declares no table \"{table}\"."),
    )
    .with_detail("table", table)
}

pub(crate) fn not_found_row() -> Refusal {
    Refusal::new(Code::RowNotFound, "The table holds no row with this id.")
}

/// A table as the item's type declares it, inherited or its own, with its label and defaults.
pub(crate) struct Table {
    pub name: String,
    pub label: String,
    pub columns: Map<String, Value>,
}

impl Table {
    fn item_columns(&self) -> impl Iterator<Item = &str> {
        self.columns
            .iter()
            .filter(|(_, definition)| {
                definition.get("type").and_then(Value::as_str)
                    == Some(marfa_rules::schema::ITEM_KIND)
            })
            .map(|(name, _)| name.as_str())
    }
}

pub(crate) fn tables_of(catalog: &Catalog, type_id: &str) -> Vec<Table> {
    let Ok(Some(resolved)) = marfa_rules::schema::resolve(&catalog.types, type_id, false) else {
        return Vec::new();
    };
    let Some(Value::Object(tables)) = resolved.get("tables") else {
        return Vec::new();
    };
    let mut found: Vec<Table> = tables
        .iter()
        .filter_map(|(name, table)| {
            Some(Table {
                name: name.clone(),
                label: table.get("label")?.as_str()?.to_string(),
                columns: table.get("columns")?.as_object()?.clone(),
            })
        })
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

pub(crate) fn table_of(catalog: &Catalog, type_id: &str, name: &str) -> Result<Table> {
    tables_of(catalog, type_id)
        .into_iter()
        .find(|table| table.name == name)
        .ok_or_else(|| not_found_table(name))
}

#[derive(Clone, Copy)]
enum Outcome {
    Created,
    Replaced,
    Patched,
    Unchanged,
    Deleted,
    Absent,
}

impl Outcome {
    const fn word(self) -> &'static str {
        match self {
            Outcome::Created => "created",
            Outcome::Replaced => "replaced",
            Outcome::Patched => "patched",
            Outcome::Unchanged => "unchanged",
            Outcome::Deleted => "deleted",
            Outcome::Absent => "absent",
        }
    }
}

/// A row as a batch left it, for its event.
pub(crate) enum Changed {
    Held {
        values: Map<String, Value>,
        refs: Map<String, Value>,
    },
    Deleted,
}

fn refs_text(refs: &Map<String, Value>) -> Option<String> {
    (!refs.is_empty()).then(|| Value::Object(refs.clone()).to_string())
}

struct Batch<'a, 'c> {
    unit: &'a Unit<'a, 'c>,
    catalog: &'a Catalog,
    host: &'a Host,
    table: &'a Table,
    /// Started once the batch first creates a row in a table that has never held one.
    table_seq: Option<i64>,
    batch_id: String,
    /// Each item a value names, as the writing key may see it: its type, or none.
    referenced: HashMap<String, Option<String>>,
    changed: Vec<(String, Changed)>,
    count: i64,
    bytes: i64,
}

impl Batch<'_, '_> {
    fn refuse_values(
        &self,
        index: usize,
        values: &Map<String, Value>,
        complete: bool,
    ) -> Result<()> {
        validation::row_values(&self.table.columns, values, complete).map_err(|error| {
            match error.fields.first() {
                Some(field) => refused_at(
                    index,
                    &format!("values.{}", field.path),
                    field.message.clone(),
                ),
                None => refused_at(index, "values", error.message),
            }
        })
    }

    /// An item column names an item the writing key reads, outside the bin, of an admitted type.
    fn refuse_references(&mut self, index: usize, values: &Map<String, Value>) -> Result<()> {
        let tx = self.unit.tx();
        for column in self.table.item_columns() {
            let Some(id) = values.get(column).and_then(Value::as_str) else {
                continue;
            };
            let found = match self.referenced.get(id) {
                Some(known) => known.clone(),
                None => items::row(tx, id)?
                    .filter(|item| {
                        item.state != "trashed" && self.unit.caller.may_read_type(&item.type_id)
                    })
                    .map(|item| item.type_id),
            };
            let Some(type_id) = found else {
                return Err(refused_at(
                    index,
                    &format!("values.{column}"),
                    "No item this key may read, outside the bin, has this id.",
                ));
            };
            let admitted = self
                .table
                .columns
                .get(column)
                .and_then(|definition| definition.get("type_constraints"))
                .and_then(Value::as_array)
                .is_none_or(|admits| {
                    admits
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|admit| self.catalog.rules.matches(admit, &type_id))
                });
            if !admitted {
                return Err(refused_at(
                    index,
                    &format!("values.{column}"),
                    format!("The column does not take an item of type \"{type_id}\"."),
                ));
            }
            self.referenced.insert(id.to_string(), Some(type_id));
        }
        Ok(())
    }

    /// Sets in `refs` each value `values` writes to an item column, and clears the rest it names.
    fn mark_refs(&self, refs: &mut Map<String, Value>, values: &Map<String, Value>) {
        for (column, value) in values {
            refs.remove(column);
            let declared = self
                .table
                .item_columns()
                .any(|item_column| item_column == column);
            if declared && value.is_string() {
                refs.insert(column.clone(), value.clone());
            }
        }
    }

    /// The type of each item a changed row names, also through a column the batch left alone.
    fn name_referenced(&mut self) -> Result<()> {
        let tx = self.unit.tx();
        for (_, change) in &self.changed {
            let Changed::Held { refs, .. } = change else {
                continue;
            };
            for id in refs.values().filter_map(Value::as_str) {
                if !self.referenced.contains_key(id) {
                    self.referenced
                        .insert(id.to_string(), items::type_of(tx, id)?);
                }
            }
        }
        Ok(())
    }

    fn note(&mut self, id: &str, change: Changed) {
        match self.changed.iter_mut().find(|(held, _)| held == id) {
            Some((_, held)) => *held = change,
            None => self.changed.push((id.to_string(), change)),
        }
    }

    fn table_seq(&mut self) -> Result<i64> {
        if let Some(seq) = self.table_seq {
            return Ok(seq);
        }
        let seq = store::open(
            self.unit.tx(),
            self.host.seq,
            &self.table.name,
            &self.batch_id,
            &self.unit.at,
        )?;
        self.table_seq = Some(seq);
        Ok(seq)
    }

    fn land(&mut self, index: usize, op: Op) -> Result<(String, Outcome)> {
        if let Some(values) = op.values() {
            self.refuse_references(index, values)?;
        }
        let tx = self.unit.tx();
        match op {
            Op::Put { id, values: sent } => {
                self.refuse_values(index, &sent, true)?;
                let mut refs = Map::new();
                self.mark_refs(&mut refs, &sent);
                let mut values = sent;
                values.retain(|_, value| !value.is_null());
                let printed = refuse_wide(index, &values)?;
                let id = id.unwrap_or_else(|| Uuid::now_v7().to_string());
                let held = store::row(tx, self.table_seq, &id)?;
                if held.as_ref().is_some_and(|held| held.values == values) {
                    return Ok((id, Outcome::Unchanged));
                }
                let seq = self.table_seq()?;
                let body = Value::Object(values.clone()).to_string();
                store::put(
                    tx,
                    seq,
                    &id,
                    &self.unit.at,
                    &body,
                    refs_text(&refs).as_deref(),
                )?;
                let outcome = match &held {
                    Some(held) => {
                        self.bytes += printed - held.bytes;
                        Outcome::Replaced
                    }
                    None => {
                        self.count += 1;
                        self.bytes += printed;
                        Outcome::Created
                    }
                };
                self.note(&id, Changed::Held { values, refs });
                Ok((id, outcome))
            }
            Op::Patch { id, values } => {
                self.refuse_values(index, &values, false)?;
                let Some(held) = store::row(tx, self.table_seq, &id)? else {
                    return Err(not_found_row()
                        .with_detail("operation", index)
                        .with_detail("id", id.as_str()));
                };
                let mut refs = held.refs.clone();
                self.mark_refs(&mut refs, &values);
                let mut next = held.values.clone();
                for (column, value) in values {
                    if value.is_null() {
                        next.remove(&column);
                    } else {
                        next.insert(column, value);
                    }
                }
                if next == held.values {
                    return Ok((id, Outcome::Unchanged));
                }
                let printed = refuse_wide(index, &next)?;
                let seq = self.table_seq()?;
                let body = Value::Object(next.clone()).to_string();
                store::put(
                    tx,
                    seq,
                    &id,
                    &self.unit.at,
                    &body,
                    refs_text(&refs).as_deref(),
                )?;
                self.bytes += printed - held.bytes;
                self.note(&id, Changed::Held { values: next, refs });
                Ok((id, Outcome::Patched))
            }
            Op::Delete { id } => match store::delete(tx, self.table_seq, &id)? {
                Some(bytes) => {
                    self.count -= 1;
                    self.bytes -= bytes;
                    self.note(&id, Changed::Deleted);
                    Ok((id, Outcome::Deleted))
                }
                None => Ok((id, Outcome::Absent)),
            },
        }
    }
}

/// Access and changes share the batch's transaction.
pub async fn write(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    ops: Vec<Op>,
) -> Result<String> {
    let cache = app.catalog_handle();
    app.write(caller, "rows.write", move |unit| {
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let host = items::writable_host(unit, &catalog, &item_id)?;
        let table = table_of(&catalog, &host.type_id, &table)?;
        let mut batch = Batch {
            unit,
            catalog: &catalog,
            host: &host,
            table: &table,
            table_seq: store::table_seq(unit.tx(), host.seq, &table.name)?,
            batch_id: Uuid::now_v7().to_string(),
            referenced: HashMap::new(),
            changed: Vec::new(),
            count: 0,
            bytes: 0,
        };
        let mut results = Vec::with_capacity(ops.len());
        for (index, op) in ops.into_iter().enumerate() {
            let (id, outcome) = batch.land(index, op)?;
            results.push(json!({ "id": id, "outcome": outcome.word() }));
        }
        batch.name_referenced()?;
        let Batch {
            changed,
            count,
            bytes,
            referenced,
            table_seq,
            batch_id,
            ..
        } = batch;
        let (Some(seq), false) = (table_seq, changed.is_empty()) else {
            return Ok(json!({
                "batch": null,
                "last_activity_at": host.last_activity_at,
                "results": results,
            })
            .to_string());
        };
        let at = unit.at.as_str();
        store::summarize(unit.tx(), seq, count, bytes, &batch_id, at)?;
        // The item's own write moves the backup counter, once for the batch.
        items::mark_activity(unit.tx(), host.seq, at)?;
        events::announce(
            unit,
            &events::Announced {
                host: &host,
                table: &table,
                batch: &batch_id,
                at,
                changed: &changed,
                referenced: &referenced,
            },
        )?;
        unit.audit(
            "item",
            &host.id,
            Some(json!({ "table": table.name, "batch": batch_id, "rows": changed.len() })),
        )?;
        Ok(json!({
            "batch": batch_id,
            "last_activity_at": at,
            "results": results,
        })
        .to_string())
    })
    .await
}
