//! Logged item types let each recipient withhold references outside its reach.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::Changed;
use crate::app::access::Caller;
use crate::app::events::Event;
use crate::app::items::Host;
use crate::app::refusal::{Refusal, Result};
use crate::app::unit::Unit;

pub const ROWS_CHANGED: &str = "rows.changed";

/// Past this many bytes of values an event carries row ids alone.
pub(super) const VALUES_CAP: usize = 65_536;
/// Kept in the log beside a row's values; a frame never carries it.
const ITEM_TYPES: &str = "item_types";

pub(super) struct Announced<'a> {
    pub host: &'a Host,
    pub table: &'a str,
    pub batch: &'a str,
    pub at: &'a str,
    pub changed: &'a [(String, Changed)],
    pub referenced: &'a HashMap<String, Option<String>>,
    /// Whether the batch's values passed the cap before they were all held.
    pub ids_only: bool,
}

fn logged_rows(announced: &Announced<'_>) -> (Vec<Value>, bool) {
    let mut bytes = 0;
    for (_, change) in announced.changed {
        if let Changed::Held { values, .. } = change {
            bytes += serde_json::to_vec(values).map_or(usize::MAX, |text| text.len());
        }
    }
    let included = !announced.ids_only && bytes <= VALUES_CAP;
    let rows = announced
        .changed
        .iter()
        .map(|(id, change)| match change {
            Changed::Deleted => json!({ "id": id, "deleted": true }),
            Changed::Held { .. } if !included => json!({ "id": id }),
            Changed::Held { values, refs } => {
                let mut row = Map::new();
                row.insert("id".into(), id.clone().into());
                row.insert("values".into(), Value::Object(values.clone()));
                let named: Map<String, Value> = refs
                    .iter()
                    .filter_map(|(column, target)| {
                        // An item no longer held reads as no type.
                        let type_id = announced
                            .referenced
                            .get(target.as_str()?)
                            .cloned()
                            .flatten();
                        Some((column.clone(), type_id.map_or(Value::Null, Value::String)))
                    })
                    .collect();
                if !named.is_empty() {
                    row.insert(ITEM_TYPES.into(), Value::Object(named));
                }
                Value::Object(row)
            }
        })
        .collect();
    (rows, included)
}

pub(super) fn announce(unit: &Unit<'_, '_>, announced: &Announced<'_>) -> Result<()> {
    let host = announced.host;
    let (rows, included) = logged_rows(announced);
    let mut payload = json!({
        "item": { "id": host.id, "type": host.type_id, "source": host.source },
        "table": announced.table,
        "batch": announced.batch,
        "last_activity_at": announced.at,
        "rows": rows,
    });
    if !included && let Some(object) = payload.as_object_mut() {
        object.insert("values_included".into(), false.into());
    }
    let printed = marfa_rules::number::to_vec(&payload)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("a rows event did not print"))?;
    unit.announce(&Event {
        event_type: ROWS_CHANGED,
        item_id: &host.id,
        type_id: &host.type_id,
        source: &host.source,
        payload: printed,
    })
}

/// The event as `caller` may read it, or `None` where it does not read as a rows event.
pub fn judged(caller: &Caller, mut body: Map<String, Value>) -> Option<Map<String, Value>> {
    body.get("item")?.get("type")?.as_str()?;
    body.get("table")?.as_str()?;
    let Some(Value::Array(rows)) = body.get_mut("rows") else {
        return None;
    };
    for row in rows {
        let row = row.as_object_mut()?;
        row.get("id")?.as_str()?;
        let named = match row.remove(ITEM_TYPES) {
            None => continue,
            Some(Value::Object(named)) => named,
            Some(_) => return None,
        };
        let mut withheld = Vec::new();
        if let Some(Value::Object(values)) = row.get_mut("values") {
            for (column, type_id) in named {
                let sees = match type_id.as_str() {
                    Some(type_id) => caller.may_read_type(type_id),
                    None => caller.may_read_every_type(),
                };
                if !sees {
                    values.remove(&column);
                    withheld.push(Value::String(column));
                }
            }
        }
        if !withheld.is_empty() {
            row.insert("withheld".into(), Value::Array(withheld));
        }
    }
    Some(body)
}
