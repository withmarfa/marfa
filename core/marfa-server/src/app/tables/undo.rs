//! An undo is a batch that puts back the rows another batch changed, as the log holds them.

use std::collections::BTreeSet;

use serde_json::json;

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
    /// With the mark to hand the row back to, where the undone batch still marks it.
    Unchanged(Option<i64>),
    Remove,
    PutBack(Before),
}

fn as_before(held: Option<&Held>, before: Option<&Before>) -> bool {
    match (held, before) {
        (None, None) => true,
        (Some(held), Some(before)) => held.values == before.values && held.refs == before.refs,
        _ => false,
    }
}

impl Batch<'_, '_> {
    /// Refuses before any comparison, so the answer never turns on a withheld value. A row the
    /// batch created is removed or left by whether it is there, which compares no value.
    fn refuse_withheld_undo(&mut self, change: &Change, held: Option<&Held>) -> Result<()> {
        let Some(before) = &change.before else {
            return Ok(());
        };
        let unit = self.unit;
        let mut withheld = BTreeSet::new();
        for refs in [
            Some(&before.refs),
            Some(&change.after_refs),
            held.map(|held| &held.refs),
        ]
        .into_iter()
        .flatten()
        {
            withheld.extend(self.sight.withheld(unit.tx(), &unit.caller, refs)?);
        }
        match withheld.first() {
            Some(column) => Err(Refusal::new(
                Code::Forbidden,
                format!(
                    "The column \"{column}\" of row {} holds or held an item this key may not read, so the key may not undo the batch.",
                    change.id
                ),
            )
            .with_detail("row", change.id.as_str())
            .with_detail("column", column.as_str())),
            None => Ok(()),
        }
    }

    fn plan(
        &self,
        table: i64,
        change: Change,
        held: Option<Held>,
    ) -> Result<Option<(String, Option<Held>, Step)>> {
        let tx = self.unit.tx();
        if as_before(held.as_ref(), change.before.as_ref()) {
            // A batch that left a row as it found it still marks it until undone.
            let restore = match (&change.before, change.after) {
                (Some(before), Some(mark))
                    if store::marker(tx, table, &change.id)? == Some(mark) =>
                {
                    Some(before.batch)
                }
                _ => None,
            };
            return Ok(Some((change.id, held, Step::Unchanged(restore))));
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
        let table = table_of(&catalog, &host, &table)?;
        let mut undoing = Batch::new(unit, &catalog, &host, &table, Some(batch.clone()))?;
        let seq = undoing.table_seq.ok_or_else(not_found_batch)?;
        let undone = store::batch(unit.tx(), seq, &batch)?.ok_or_else(not_found_batch)?;
        let mut found = Vec::new();
        for change in store::changes(unit.tx(), undone.seq)? {
            let held = store::row(unit.tx(), Some(seq), &change.id)?;
            undoing.refuse_withheld_undo(&change, held.as_ref())?;
            found.push((change, held));
        }
        let mut steps = Vec::new();
        let mut later = Vec::new();
        for (change, held) in found {
            let id = change.id.clone();
            match undoing.plan(seq, change, held)? {
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
        let mut results = Vec::with_capacity(steps.len());
        for (id, held, step) in steps {
            let outcome = match step {
                Step::Unchanged(restore) => {
                    if let Some(mark) = restore {
                        store::set_marker(unit.tx(), seq, &id, mark)?;
                    }
                    "unchanged"
                }
                Step::Remove => {
                    undoing.remove_row(&id)?;
                    "deleted"
                }
                Step::PutBack(before) => {
                    let outcome = if held.is_some() {
                        "replaced"
                    } else {
                        "created"
                    };
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
