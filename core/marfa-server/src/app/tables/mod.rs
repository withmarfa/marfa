//! Row writes share one transaction per batch.

pub mod archive;
mod events;
mod lifecycle;
mod read;
mod store;
mod undo;

use std::collections::{HashMap, HashSet};

use marfa_rules::validation;
use rusqlite::Transaction;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::App;
use super::access::Caller;
use super::catalog::{self, Catalog, Snapshot};
use super::items::{self, Host};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use store::Held;

pub use events::{ROWS_CHANGED, judged as judged_event};
pub use lifecycle::{
    cleanup, constraining_columns, doom, held_in_use, refuse_moving_type, refuse_undeclared,
};
pub use read::{Page, batches, get, list, page, totals};
pub use undo::undo;

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
fn refuse_wide(index: usize, values: &Map<String, Value>) -> Result<()> {
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
    Ok(())
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

/// Which values written as an item's id a caller may see: an id no item holds only by a caller
/// that may read every type.
pub(crate) struct Sight {
    every: bool,
    seen: HashMap<String, bool>,
}

impl Sight {
    pub(crate) fn of(caller: &Caller) -> Sight {
        Sight {
            every: caller.may_read_every_type(),
            seen: HashMap::new(),
        }
    }

    fn sees(&mut self, tx: &Transaction<'_>, caller: &Caller, id: &str) -> Result<bool> {
        if self.every {
            return Ok(true);
        }
        if let Some(known) = self.seen.get(id) {
            return Ok(*known);
        }
        let sees = items::type_of(tx, id)?.is_some_and(|type_id| caller.may_read_type(&type_id));
        self.seen.insert(id.to_string(), sees);
        Ok(sees)
    }

    /// The columns of `refs` whose value the caller may not see.
    pub(crate) fn withheld(
        &mut self,
        tx: &Transaction<'_>,
        caller: &Caller,
        refs: &Map<String, Value>,
    ) -> Result<Vec<String>> {
        let mut withheld = Vec::new();
        for (column, id) in refs {
            let Some(id) = id.as_str() else {
                return Err(Refusal::internal("a stored row does not read"));
            };
            if !self.sees(tx, caller, id)? {
                withheld.push(column.clone());
            }
        }
        Ok(withheld)
    }
}

pub(crate) fn refs_text(refs: &Map<String, Value>) -> Option<String> {
    (!refs.is_empty()).then(|| Value::Object(refs.clone()).to_string())
}

struct Batch<'a, 'c> {
    unit: &'a Unit<'a, 'c>,
    catalog: &'a Catalog,
    host: &'a Host,
    table: &'a Table,
    /// The table's key, `None` until the table first holds a row.
    table_seq: Option<i64>,
    batch_id: String,
    undoes: Option<String>,
    /// The batch's seq in the log, `None` until it first changes a row.
    batch_seq: Option<i64>,
    /// Capture each row only before its first change in the batch.
    logged: HashSet<String>,
    /// The type of each item a value names, or `None` where no item holds the id.
    referenced: HashMap<String, Option<String>>,
    sight: Sight,
    changed: Vec<(String, Changed)>,
    count: i64,
    bytes: i64,
}

impl Batch<'_, '_> {
    /// Refuses a put or patch naming a column whose value the writing key may not see, and
    /// answers those columns.
    fn refuse_withheld(
        &mut self,
        index: usize,
        held: &Held,
        named: &Map<String, Value>,
    ) -> Result<Vec<String>> {
        let withheld = self
            .sight
            .withheld(self.unit.tx(), &self.unit.caller, &held.refs)?;
        match withheld.iter().find(|column| named.contains_key(column.as_str())) {
            Some(column) => Err(Refusal::new(
                Code::Forbidden,
                format!(
                    "The column \"{column}\" names an item this key may not read, so the key may not write it."
                ),
            )
            .with_detail("operation", index)
            .with_detail("column", column.as_str())),
            None => Ok(withheld),
        }
    }

    fn refuse_values(
        &self,
        index: usize,
        values: &Map<String, Value>,
        complete: bool,
        kept: &[String],
    ) -> Result<()> {
        validation::row_values(&self.table.columns, values, complete, kept).map_err(|error| {
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

    /// An item column names an item the writing key reads, of an admitted type, and outside the
    /// bin unless the row already holds that id in the column.
    fn refuse_references(
        &mut self,
        index: usize,
        values: &Map<String, Value>,
        held: Option<&Map<String, Value>>,
    ) -> Result<()> {
        let tx = self.unit.tx();
        for column in self.table.item_columns() {
            let Some(id) = values.get(column).and_then(Value::as_str) else {
                continue;
            };
            let unchanged = held
                .and_then(|refs| refs.get(column))
                .and_then(Value::as_str)
                == Some(id);
            let found = if unchanged {
                items::type_of(tx, id)?.filter(|type_id| self.unit.caller.may_read_type(type_id))
            } else {
                match self.referenced.get(id) {
                    Some(known) => known.clone(),
                    None => items::live_type_of(tx, id)?
                        .filter(|type_id| self.unit.caller.may_read_type(type_id)),
                }
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
            if !unchanged {
                self.referenced.insert(id.to_string(), Some(type_id));
            }
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

    fn begin(&mut self, id: &str, held: bool, mark: Option<i64>) -> Result<(i64, i64)> {
        let table = self.table_seq()?;
        let unit = self.unit;
        let batch = match self.batch_seq {
            Some(batch) => batch,
            None => {
                let batch = store::open_batch(
                    unit.tx(),
                    table,
                    &self.batch_id,
                    &unit.at,
                    self.undoes.as_deref(),
                )?;
                self.batch_seq = Some(batch);
                batch
            }
        };
        if self.logged.insert(id.to_string()) {
            store::log_before(unit.tx(), batch, table, id, held, mark.unwrap_or(batch))?;
        }
        Ok((table, batch))
    }

    fn store_row(
        &mut self,
        id: &str,
        held: Option<i64>,
        values: Map<String, Value>,
        refs: Map<String, Value>,
        mark: Option<i64>,
    ) -> Result<()> {
        let (table, own) = self.begin(id, held.is_some(), mark)?;
        let batch = mark.unwrap_or(own);
        let unit = self.unit;
        let body = Value::Object(values.clone()).to_string();
        store::put(
            unit.tx(),
            &store::Written {
                table,
                id,
                at: &unit.at,
                batch,
                body: &body,
                refs: refs_text(&refs).as_deref(),
            },
        )?;
        let printed = store::printed_len(&values);
        match held {
            Some(bytes) => self.bytes += printed - bytes,
            None => {
                self.count += 1;
                self.bytes += printed;
            }
        }
        self.note(id, Changed::Held { values, refs });
        Ok(())
    }

    fn remove_row(&mut self, id: &str) -> Result<bool> {
        let unit = self.unit;
        let Some(table) = self.table_seq else {
            return Ok(false);
        };
        if store::marker(unit.tx(), table, id)?.is_none() {
            return Ok(false);
        }
        self.begin(id, true, None)?;
        let bytes = store::delete(unit.tx(), table, id)?
            .ok_or_else(|| Refusal::internal("a held row did not delete"))?;
        self.count -= 1;
        self.bytes -= bytes;
        self.note(id, Changed::Deleted);
        Ok(true)
    }

    fn land(&mut self, index: usize, op: Op) -> Result<(String, Outcome)> {
        let tx = self.unit.tx();
        match op {
            Op::Put { id, values: sent } => {
                let id = id.unwrap_or_else(|| Uuid::now_v7().to_string());
                let held = store::row(tx, self.table_seq, &id)?;
                let kept = match &held {
                    Some(held) => self.refuse_withheld(index, held, &sent)?,
                    None => Vec::new(),
                };
                self.refuse_references(index, &sent, held.as_ref().map(|held| &held.refs))?;
                self.refuse_values(index, &sent, true, &kept)?;
                let mut refs = Map::new();
                self.mark_refs(&mut refs, &sent);
                let mut values = sent;
                values.retain(|_, value| !value.is_null());
                if let Some(held) = &held {
                    for column in &kept {
                        if let Some(value) = held.values.get(column) {
                            values.insert(column.clone(), value.clone());
                        }
                        if let Some(target) = held.refs.get(column) {
                            refs.insert(column.clone(), target.clone());
                        }
                    }
                }
                refuse_wide(index, &values)?;
                if held.as_ref().is_some_and(|held| held.values == values) {
                    return Ok((id, Outcome::Unchanged));
                }
                let held = held.map(|held| held.bytes);
                self.store_row(&id, held, values, refs, None)?;
                let outcome = match held {
                    Some(_) => Outcome::Replaced,
                    None => Outcome::Created,
                };
                Ok((id, outcome))
            }
            Op::Patch { id, values } => {
                let Some(held) = store::row(tx, self.table_seq, &id)? else {
                    return Err(not_found_row()
                        .with_detail("operation", index)
                        .with_detail("id", id.as_str()));
                };
                self.refuse_withheld(index, &held, &values)?;
                self.refuse_references(index, &values, Some(&held.refs))?;
                self.refuse_values(index, &values, false, &[])?;
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
                refuse_wide(index, &next)?;
                self.store_row(&id, Some(held.bytes), next, refs, None)?;
                Ok((id, Outcome::Patched))
            }
            Op::Delete { id } => match self.remove_row(&id)? {
                true => Ok((id, Outcome::Deleted)),
                false => Ok((id, Outcome::Absent)),
            },
        }
    }

    fn settle(mut self, host: &Host) -> Result<Option<String>> {
        self.name_referenced()?;
        let unit = self.unit;
        let (Some(table), Some(batch), false) =
            (self.table_seq, self.batch_seq, self.changed.is_empty())
        else {
            return Ok(None);
        };
        let tx = unit.tx();
        store::close_batch(tx, batch, self.changed.len() as i64)?;
        for (id, change) in &self.changed {
            match change {
                Changed::Deleted => store::log_removed(tx, batch, id)?,
                Changed::Held { refs, .. } => {
                    if let Some(refs) = refs_text(refs) {
                        store::log_after_refs(tx, batch, id, &refs)?;
                    }
                }
            }
        }
        let at = unit.at.as_str();
        store::summarize(tx, table, self.count, self.bytes, &self.batch_id, at)?;
        // The item's own write moves the backup counter, once for the batch.
        items::mark_activity(tx, host.seq, at)?;
        events::announce(
            unit,
            &events::Announced {
                host,
                table: &self.table.name,
                batch: &self.batch_id,
                undoes: self.undoes.as_deref(),
                at,
                changed: &self.changed,
                referenced: &self.referenced,
                ids_only: false,
            },
        )?;
        let mut audited = json!({
            "table": self.table.name,
            "batch": self.batch_id,
            "rows": self.changed.len(),
        });
        if let Some(undoes) = &self.undoes {
            audited["undoes"] = json!(undoes);
        }
        unit.audit("item", &host.id, Some(audited))?;
        Ok(Some(at.to_string()))
    }
}

impl<'a, 'c> Batch<'a, 'c> {
    fn new(
        unit: &'a Unit<'a, 'c>,
        catalog: &'a Catalog,
        host: &'a Host,
        table: &'a Table,
        undoes: Option<String>,
    ) -> Result<Batch<'a, 'c>> {
        Ok(Batch {
            unit,
            catalog,
            host,
            table,
            table_seq: store::table_seq(unit.tx(), host.seq, &table.name)?,
            batch_id: Uuid::now_v7().to_string(),
            undoes,
            batch_seq: None,
            logged: HashSet::new(),
            referenced: HashMap::new(),
            sight: Sight::of(&unit.caller),
            changed: Vec::new(),
            count: 0,
            bytes: 0,
        })
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
        let mut batch = Batch::new(unit, &catalog, &host, &table, None)?;
        let mut results = Vec::with_capacity(ops.len());
        for (index, op) in ops.into_iter().enumerate() {
            let (id, outcome) = batch.land(index, op)?;
            results.push(json!({ "id": id, "outcome": outcome.word() }));
        }
        let batch_id = batch.batch_id.clone();
        let answer = match batch.settle(&host)? {
            Some(at) => json!({ "batch": batch_id, "last_activity_at": at, "results": results }),
            None => json!({
                "batch": null,
                "last_activity_at": host.last_activity_at,
                "results": results,
            }),
        };
        Ok(answer.to_string())
    })
    .await
}
