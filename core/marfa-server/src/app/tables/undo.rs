//! An undo is a batch that puts back the rows another batch changed, as the log holds them.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::store::{self, Before, Change, Held};
use super::{Batch, table_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::catalog::{self, Snapshot};
use crate::app::items;
use crate::app::refusal::{Code, Refusal, Result};

pub(crate) fn not_found_batch() -> Refusal {
    Refusal::new(
        Code::BatchNotFound,
        "The table's change log holds no batch with this id.",
    )
}

enum Step {
    Unchanged,
    Remove,
    PutBack(Before),
}

/// Whether row `held` is as `before` holds it, by its values and the item ids it names.
fn as_before(held: Option<&Held>, before: Option<&Before>) -> bool {
    match (held, before) {
        (None, None) => true,
        (Some(held), Some(before)) => held.values == before.values && held.refs == before.refs,
        _ => false,
    }
}

/// The columns whose value or mark differs between the row held and the row put back.
fn changed_columns(
    held: Option<&Held>,
    values: &Map<String, Value>,
    refs: &Map<String, Value>,
) -> BTreeSet<String> {
    let empty = Map::new();
    let (now_values, now_refs) = held.map_or((&empty, &empty), |held| (&held.values, &held.refs));
    [now_values, now_refs, values, refs]
        .into_iter()
        .flat_map(|map| map.keys())
        .filter(|column| {
            now_values.get(*column) != values.get(*column)
                || now_refs.get(*column) != refs.get(*column)
        })
        .cloned()
        .collect()
}

impl Batch<'_, '_> {
    /// Refuses a put-back that would change a column whose value, now or put back, the key may
    /// not see.
    fn refuse_withheld_undo(
        &mut self,
        id: &str,
        held: Option<&Held>,
        values: &Map<String, Value>,
        refs: &Map<String, Value>,
    ) -> Result<()> {
        let unit = self.unit;
        let mut withheld = self.sight.withheld(unit.tx(), &unit.caller, refs)?;
        if let Some(held) = held {
            withheld.extend(self.sight.withheld(unit.tx(), &unit.caller, &held.refs)?);
        }
        let changed = changed_columns(held, values, refs);
        match withheld.iter().find(|column| changed.contains(column.as_str())) {
            Some(column) => Err(Refusal::new(
                Code::Forbidden,
                format!(
                    "The column \"{column}\" of row {id} names an item this key may not read, so the key may not undo its change."
                ),
            )
            .with_detail("row", id)
            .with_detail("column", column.as_str())),
            None => Ok(()),
        }
    }

    /// What the undo does to the row `change` logs, or `None` where it no longer stands as the
    /// batch left it.
    fn plan(&self, table: i64, change: Change) -> Result<Option<(String, Option<Held>, Step)>> {
        let tx = self.unit.tx();
        let held = store::row(tx, Some(table), &change.id)?;
        if as_before(held.as_ref(), change.before.as_ref()) {
            return Ok(Some((change.id, held, Step::Unchanged)));
        }
        let standing = match change.after {
            Some(mark) => held.is_some() && store::marker(tx, table, &change.id)? == Some(mark),
            None => held.is_none(),
        };
        if !standing {
            return Ok(None);
        }
        let step = match change.before {
            None => Step::Remove,
            Some(before) => Step::PutBack(before),
        };
        Ok(Some((change.id, held, step)))
    }
}

/// Undoes batch `batch` of an item's table as a new batch, in one transaction.
pub async fn undo(
    app: &App,
    caller: &Caller,
    item_id: String,
    table: String,
    batch: String,
) -> Result<String> {
    let cache = app.catalog_handle();
    app.write(caller, "rows.undo", move |unit| {
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let host = items::writable_host(unit, &catalog, &item_id)?;
        let table = table_of(&catalog, &host.type_id, &table)?;
        let mut undoing = Batch::new(unit, &catalog, &host, &table, Some(batch.clone()))?;
        let seq = undoing.table_seq.ok_or_else(not_found_batch)?;
        let undone = store::batch(unit.tx(), seq, &batch)?.ok_or_else(not_found_batch)?;
        let mut steps = Vec::new();
        let mut later = Vec::new();
        for change in store::changes(unit.tx(), undone.seq)? {
            let id = change.id.clone();
            match undoing.plan(seq, change)? {
                Some(step) => steps.push(step),
                None => later.push(id),
            }
        }
        if !later.is_empty() {
            return Err(Refusal::new(
                Code::UndoConflict,
                "A later batch changed rows this batch changed. Undo the later batches first.",
            )
            .with_detail("rows", later));
        }
        for (id, held, step) in &steps {
            if let Step::PutBack(before) = step {
                undoing.refuse_withheld_undo(id, held.as_ref(), &before.values, &before.refs)?;
            }
        }
        let mut results = Vec::with_capacity(steps.len());
        for (id, held, step) in steps {
            let outcome = match step {
                Step::Unchanged => "unchanged",
                Step::Remove => {
                    undoing.remove_row(&id)?;
                    "deleted"
                }
                Step::PutBack(before) => {
                    let outcome = if held.is_some() { "replaced" } else { "created" };
                    let held = held.map(|held| held.bytes);
                    let Before {
                        batch,
                        values,
                        refs,
                    } = before;
                    undoing.store_row(&id, held, values, refs, Some(batch))?;
                    outcome
                }
            };
            results.push(json!({ "id": id, "outcome": outcome }));
        }
        let undo_id = undoing.batch_id.clone();
        let answer = match undoing.settle(&host)? {
            Some(at) => json!({
                "batch": undo_id,
                "undoes": undone.id,
                "last_activity_at": at,
                "results": results,
            }),
            None => json!({
                "batch": null,
                "undoes": undone.id,
                "last_activity_at": host.last_activity_at,
                "results": results,
            }),
        };
        Ok(answer.to_string())
    })
    .await
}
