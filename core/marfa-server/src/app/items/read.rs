//! Reads of items. Each runs in one read transaction: it authorizes against
//! the caller and the row as that transaction sees them, and hydrates from the
//! same snapshot, so nothing it answers is newer than what it judged.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use marfa_rules::names;
use rusqlite::Transaction;
use serde_json::Value;

use super::{Item, extensions_text, metadata_for, rows};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::catalog::{self, Catalog, Snapshot};
use crate::app::faults::{Faults, HOLD_READ_HYDRATION};
use crate::app::refusal::{Code, Refusal, Result};

const TITLES_PER_NAME: i64 = 20;
const FIRST_PAGE: i64 = 50;

/// One read: its transaction, and its caller as that transaction holds it.
struct Reader<'a, 'c> {
    tx: &'a Transaction<'c>,
    caller: Caller,
    catalog: Arc<Catalog>,
    faults: &'a Faults,
}

async fn reading<T, F>(app: &App, caller: &Caller, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Reader<'_, '_>) -> Result<T> + Send + 'static,
{
    let caller = caller.clone();
    let cache = app.catalog_handle();
    let clock = app.clock.clone();
    let faults = app.faults.clone();
    app.db
        .read(move |tx| {
            let caller = caller.current(tx, &clock.stamp())?;
            let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
            job(&Reader {
                tx,
                caller,
                catalog,
                faults: &faults,
            })
        })
        .await
}

fn not_found() -> Refusal {
    Refusal::new(Code::ItemNotFound, "Item not found")
}

impl Reader<'_, '_> {
    /// The row a read names, which reads as missing where it is gone,
    /// unreadable or in the bin.
    fn row(&self, id: &str) -> Result<Item> {
        self.caller.require_reach()?;
        let row = rows::by_id(self.tx, id)?
            .filter(|row| self.caller.may_read_type(&row.type_id))
            .ok_or_else(not_found)?;
        if row.state == "trashed" {
            return Err(not_found().with_detail("trashed", true));
        }
        Ok(row)
    }

    fn hydrating(&self) {
        self.faults.hold_blocking(HOLD_READ_HYDRATION);
    }

    /// One page of `row`'s history after `after`, filled past the snapshots
    /// the caller may not read.
    fn history_page(&self, row: &Item, after: i64, limit: i64) -> Result<String> {
        let mut page = Vec::new();
        let mut at = after;
        'filling: loop {
            let batch = rows::snapshots_after(self.tx, row.seq, at, limit + 1)?;
            let Some(last) = batch.last().map(|snapshot| snapshot.version) else {
                break;
            };
            for snapshot in batch {
                if self.caller.may_read_type(&snapshot.type_id) {
                    page.push(snapshot);
                    if page.len() as i64 > limit {
                        break 'filling;
                    }
                }
            }
            at = last;
        }
        let more = page.len() as i64 > limit;
        page.truncate(limit as usize);
        let next = match page.last().filter(|_| more) {
            Some(snapshot) => Value::from(cursor_of(&row.id, snapshot.version)).to_string(),
            None => "null".to_string(),
        };
        let data: Vec<String> = page
            .iter()
            .map(|snapshot| snapshot.answered())
            .collect::<Result<_>>()?;
        Ok(format!(
            "{{\"data\":[{}],\"next_cursor\":{next}}}",
            data.join(",")
        ))
    }
}

fn cursor_of(item_id: &str, version: i64) -> String {
    hex::encode(format!("versions\0{item_id}\0{version}"))
}

fn version_at(item_id: &str, cursor: &str) -> Result<i64> {
    let refused = || Refusal::validation("The cursor does not belong to this listing.");
    let text = hex::decode(cursor)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(refused)?;
    let mut parts = text.split('\0');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("versions"), Some(id), Some(version), None) if id == item_id => {
            version.parse().map_err(|_| refused())
        }
        _ => Err(refused()),
    }
}

/// What `GET /items/{id}` adds to the item.
#[derive(Clone, Copy, Debug, Default)]
pub struct Detail {
    pub versions: bool,
}

pub async fn detail(app: &App, caller: &Caller, id: String, include: Detail) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        read.hydrating();
        let versions = if include.versions {
            format!(",\"versions\":{}", read.history_page(&row, 0, FIRST_PAGE)?)
        } else {
            String::new()
        };
        Ok(format!(
            "{{\"item\":{},\"metadata\":{}{versions}}}",
            row.answered(read.tx)?,
            metadata_for(read.tx, &row, &read.caller)?
        ))
    })
    .await
}

pub async fn history(
    app: &App,
    caller: &Caller,
    id: String,
    limit: i64,
    cursor: Option<String>,
) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        let after = match cursor.as_deref() {
            Some(cursor) => version_at(&id, cursor)?,
            None => 0,
        };
        read.history_page(&row, after, limit)
    })
    .await
}

/// What `POST /items/bulk-get` asks for beside the items.
#[derive(Clone, Copy, Debug, Default)]
pub struct Many {
    pub metadata: bool,
    pub extensions: bool,
    pub edges: bool,
    pub system: bool,
}

pub async fn bulk_get(
    app: &App,
    caller: &Caller,
    ids: Vec<String>,
    include: Many,
) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        let mut seen = HashSet::new();
        let mut visible = Vec::new();
        for id in &ids {
            if !seen.insert(id.as_str()) {
                continue;
            }
            let Some(row) = rows::by_id(read.tx, id)? else {
                continue;
            };
            if row.state == "trashed"
                || (!include.system && super::is_system(&row.type_id))
                || !read.caller.may_read_type(&row.type_id)
            {
                continue;
            }
            visible.push(row);
        }
        read.hydrating();
        let mut items = Vec::with_capacity(visible.len());
        let mut metadata = Vec::new();
        for row in &visible {
            let mut text = row.answered(read.tx)?;
            text.pop();
            if include.edges {
                text.push_str(",\"edges\":{}");
            }
            if include.extensions {
                let held =
                    extensions_text(read.tx, row, |name| read.caller.may_read_extension(name))?;
                text.push_str(&format!(",\"extensions\":{held}"));
            }
            text.push('}');
            items.push(text);
            if include.metadata {
                metadata.push(metadata_for(read.tx, row, &read.caller)?);
            }
        }
        let also = if include.metadata {
            format!(",\"metadata\":[{}]", metadata.join(","))
        } else {
            String::new()
        };
        Ok(format!("{{\"items\":[{}]{also}}}", items.join(",")))
    })
    .await
}

pub async fn titles(app: &App, caller: &Caller, names: Vec<String>) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        let rules = &read.catalog.rules;
        let mut results = Vec::with_capacity(names.len());
        for name in names {
            let mut found = Vec::new();
            let mut more = false;
            if let Some(key) = names::title_key(&name) {
                let mut after = String::new();
                'walking: loop {
                    let batch = rows::titled(read.tx, &key, &after, TITLES_PER_NAME + 1)?;
                    let Some(last) = batch.last().map(|row| row.id.clone()) else {
                        break;
                    };
                    for row in batch {
                        if super::is_system(&row.type_id)
                            || !read.caller.may_read_type(&row.type_id)
                            || !read.caller.lists(rules, &row.type_id, &row.source)
                        {
                            continue;
                        }
                        if found.len() as i64 == TITLES_PER_NAME {
                            more = true;
                            break 'walking;
                        }
                        let properties = super::parsed(&row.properties)?;
                        found.push(serde_json::json!({
                            "id": row.id,
                            "type": row.type_id,
                            "title": properties.get(rules.title_property(&row.type_id)),
                            "has_blob": row.has_blob,
                        }));
                    }
                    after = last;
                }
            }
            results.push(serde_json::json!({ "name": name, "items": found, "more": more }));
        }
        Ok(serde_json::json!({ "results": results }).to_string())
    })
    .await
}

pub async fn tag_counts(app: &App, caller: &Caller) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        let rules = &read.catalog.rules;
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        for (tag, type_id, source, count) in rows::active_tags(read.tx)? {
            if read.caller.may_read_type(&type_id) && read.caller.lists(rules, &type_id, &source) {
                *counts.entry(tag).or_default() += count;
            }
        }
        let mut listed: Vec<(String, i64)> = counts.into_iter().collect();
        listed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let data: Vec<Value> = listed
            .into_iter()
            .map(|(tag, count)| serde_json::json!({ "tag": tag, "count": count }))
            .collect();
        Ok(serde_json::json!({ "data": data, "next_cursor": null }).to_string())
    })
    .await
}

pub async fn metadata(app: &App, caller: &Caller, id: String) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        read.hydrating();
        Ok(format!(
            "{{\"metadata\":{}}}",
            metadata_for(read.tx, &row, &read.caller)?
        ))
    })
    .await
}

pub async fn extensions(app: &App, caller: &Caller, id: String) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        read.hydrating();
        let held = extensions_text(read.tx, &row, |name| read.caller.may_read_extension(name))?;
        Ok(format!("{{\"extensions\":{held}}}"))
    })
    .await
}

pub async fn extension(
    app: &App,
    caller: &Caller,
    id: String,
    namespace: String,
) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        read.caller.require_extension(&namespace, Level::Read)?;
        read.hydrating();
        let data = rows::extension(read.tx, row.seq, &namespace)?;
        Ok(format!(
            "{{\"namespace\":{},\"data\":{}}}",
            Value::from(namespace),
            data.as_deref().unwrap_or("null")
        ))
    })
    .await
}
