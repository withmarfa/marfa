//! Rows as an archive carries them, read in one snapshot and written by a restore.

use std::collections::{BTreeSet, HashMap};

use rusqlite::Transaction;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::events::{self, Announced};
use super::store::{self, Held};
use super::{Changed, MAX_OPERATIONS, Sight, refs_text};
use crate::app::archive::checks::RowKey;
use crate::app::items::{self, Host, Reader};
use crate::app::refusal::{Refusal, Result};
use crate::app::unit::Unit;

const PAGE: i64 = 1000;

/// One row line, and what it needs of the credential that sends it.
pub(crate) struct ArchivedRow {
    pub line: Value,
    /// The type and source of the row's item.
    pub host: (String, String),
    /// The types of the items the values it carries in `refs` name.
    pub types: BTreeSet<String>,
    /// Whether it carries the id of an item no longer held.
    pub unheld: bool,
}

/// The type of each item a row's value names, `None` where no item holds the id.
#[derive(Default)]
struct Types(HashMap<String, Option<String>>);

impl Types {
    fn of(&mut self, tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
        if let Some(known) = self.0.get(id) {
            return Ok(known.clone());
        }
        let found = items::type_of(tx, id)?;
        self.0.insert(id.to_string(), found.clone());
        Ok(found)
    }
}

/// Each row of each carried item, in the order `tables/archive-rows-order` states, as the
/// reader may read it.
pub(crate) fn archived(
    read: &Reader<'_, '_>,
    carried: impl Fn(i64) -> bool,
    mut each: impl FnMut(ArchivedRow) -> Result<()>,
) -> Result<()> {
    let tx = read.tx;
    let caller = &read.caller;
    let mut sight = Sight::of(caller);
    let mut types = Types::default();
    store::carried_tables(tx, |table| {
        if !carried(table.item_seq) {
            return Ok(());
        }
        let mut after = String::new();
        loop {
            let page = store::rows_after(tx, table.table_seq, &after, PAGE)?;
            let Some(last) = page.last() else {
                return Ok(());
            };
            after = last.id.clone();
            for Held {
                id,
                updated_at,
                mut values,
                mut refs,
                ..
            } in page
            {
                for column in sight.withheld(tx, caller, &refs)? {
                    values.remove(&column);
                    refs.remove(&column);
                }
                let mut row = ArchivedRow {
                    line: Value::Null,
                    host: (table.type_id.clone(), table.source.clone()),
                    types: BTreeSet::new(),
                    unheld: false,
                };
                let mut marked: Vec<&String> = refs.keys().collect();
                marked.sort();
                for target in refs.values().filter_map(Value::as_str) {
                    match types.of(tx, target)? {
                        Some(type_id) => {
                            row.types.insert(type_id);
                        }
                        None => row.unheld = true,
                    }
                }
                let mut line = json!({
                    "item_id": table.item_id,
                    "table": table.table,
                    "id": id,
                    "values": values,
                    "updated_at": updated_at,
                });
                if !marked.is_empty() {
                    line["refs"] = json!(marked);
                }
                row.line = line;
                each(row)?;
            }
        }
    })
}

/// One table's rows as a restore writes them, announced a batch at a time.
struct Run {
    host: Host,
    table: String,
    table_seq: i64,
    batch: String,
    /// The batch last announced, which the table's summary names.
    announced: Option<String>,
    changed: Vec<(String, Changed)>,
    /// The bytes of values `changed` holds, until it passes the event's cap.
    held: usize,
    over: bool,
    count: i64,
    bytes: i64,
    changed_at: String,
}

/// Writes the rows of a restore's archive, line by line in the archive's order.
pub(crate) struct Restoring<'a, 'u, 'c> {
    unit: &'a Unit<'u, 'c>,
    run: Option<Run>,
    types: Types,
    pub imported: usize,
    pub skipped: usize,
}

impl<'a, 'u, 'c> Restoring<'a, 'u, 'c> {
    pub fn new(unit: &'a Unit<'u, 'c>) -> Self {
        Restoring {
            unit,
            run: None,
            types: Types::default(),
            imported: 0,
            skipped: 0,
        }
    }

    /// Writes a checked line whose item this restore `written`, and counts the rest as skipped.
    pub fn row(&mut self, line: &Value, key: RowKey, written: bool) -> Result<()> {
        if !written {
            self.skipped += 1;
            return Ok(());
        }
        let tx = self.unit.tx();
        let same = self
            .run
            .as_ref()
            .is_some_and(|run| run.host.id == key.item_id && run.table == key.table);
        if !same {
            self.close()?;
            let host = items::host_of(tx, &key.item_id)?
                .ok_or_else(|| Refusal::internal("a restored row's item is gone"))?;
            let batch = Uuid::now_v7().to_string();
            let table_seq = store::open(tx, host.seq, &key.table, &batch, &self.unit.at)?;
            self.run = Some(Run {
                host,
                table: key.table.clone(),
                table_seq,
                batch,
                announced: None,
                changed: Vec::new(),
                held: 0,
                over: false,
                count: 0,
                bytes: 0,
                changed_at: String::new(),
            });
        }
        let run = self
            .run
            .as_mut()
            .ok_or_else(|| Refusal::internal("a restore's table was lost"))?;
        let values = line
            .get("values")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| Refusal::internal("a checked row holds no values"))?;
        let updated_at = line
            .get("updated_at")
            .and_then(Value::as_str)
            .map(|text| marfa_rules::time::rfc3339(text, "updated_at"))
            .transpose()
            .map_err(|_| Refusal::internal("a checked row's updated_at does not read"))?
            .ok_or_else(|| Refusal::internal("a checked row has no updated_at"))?;
        let mut refs = Map::new();
        for column in line
            .get("refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(target) = values.get(column) {
                refs.insert(column.to_string(), target.clone());
            }
        }
        let body = Value::Object(values.clone()).to_string();
        store::insert(
            tx,
            run.table_seq,
            &key.id,
            &updated_at,
            &body,
            refs_text(&refs).as_deref(),
        )?;
        run.count += 1;
        run.bytes += body.len() as i64;
        if updated_at > run.changed_at {
            run.changed_at = updated_at;
        }
        run.held += body.len();
        if run.held > events::VALUES_CAP && !run.over {
            run.over = true;
            for (_, change) in &mut run.changed {
                *change = Changed::Held {
                    values: Map::new(),
                    refs: Map::new(),
                };
            }
        }
        let change = match run.over {
            true => Changed::Held {
                values: Map::new(),
                refs: Map::new(),
            },
            false => Changed::Held { values, refs },
        };
        run.changed.push((key.id, change));
        self.imported += 1;
        if run.changed.len() == MAX_OPERATIONS {
            self.announce()?;
        }
        Ok(())
    }

    /// Announces the open batch of the current table and starts the next.
    fn announce(&mut self) -> Result<()> {
        let tx = self.unit.tx();
        let Some(run) = self.run.as_mut() else {
            return Ok(());
        };
        if run.changed.is_empty() {
            return Ok(());
        }
        let mut referenced = HashMap::new();
        for (_, change) in &run.changed {
            if let Changed::Held { refs, .. } = change {
                for id in refs.values().filter_map(Value::as_str) {
                    referenced.insert(id.to_string(), self.types.of(tx, id)?);
                }
            }
        }
        events::announce(
            self.unit,
            &Announced {
                host: &run.host,
                table: &run.table,
                batch: &run.batch,
                at: &run.host.last_activity_at,
                changed: &run.changed,
                referenced: &referenced,
                ids_only: run.over,
            },
        )?;
        run.changed.clear();
        run.held = 0;
        run.over = false;
        let next = Uuid::now_v7().to_string();
        run.announced = Some(std::mem::replace(&mut run.batch, next));
        Ok(())
    }

    /// Ends the current table: its last batch announced and its summary written.
    fn close(&mut self) -> Result<()> {
        self.announce()?;
        let Some(run) = self.run.take() else {
            return Ok(());
        };
        let batch = run
            .announced
            .ok_or_else(|| Refusal::internal("a restored table announced no batch"))?;
        store::summarize(
            self.unit.tx(),
            run.table_seq,
            run.count,
            run.bytes,
            &batch,
            &run.changed_at,
        )
    }

    pub fn finish(mut self) -> Result<(usize, usize)> {
        self.close()?;
        Ok((self.imported, self.skipped))
    }
}
