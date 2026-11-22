//! Each read runs in one transaction: it authorizes and hydrates from the same snapshot, so
//! nothing it answers is newer than what it judged.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use marfa_rules::names;
use rusqlite::Transaction;
use serde_json::{Value, json};

use super::plan::{self, Act, Asked, Gate};
use super::{
    Door, Item, Keys, check_links, extension_documents_text, extension_text, extensions_text,
    metadata_for, name_of, not_found, rows, summary_of, with_blocks,
};
use crate::app::App;
use crate::app::access::reach::Demand;
use crate::app::access::{Caller, Level, Permission};
use crate::app::catalog::{self, Catalog, Snapshot};
use crate::app::clock::Stamp;
use crate::app::connectors::{ReadOnly, read_only};
use crate::app::edges::{self, Reach};
use crate::app::faults::{Faults, HOLD_READ_HYDRATION, HOLD_READ_SNAPSHOT};
use crate::app::housekeeping::DAY_MS;
use crate::app::query::{Secret, States, bad_cursor, judge_type};
use crate::app::refusal::{Code, Result};
use crate::settings::registry::TRASH_RETENTION_DAYS;

const TITLES_PER_NAME: i64 = 20;
const FIRST_PAGE: i64 = 50;
const MAX_TAKES: usize = 100;
const MAX_NEIGHBORS: usize = 100;
const WALK_BATCH: i64 = 200;

pub(crate) struct Reader<'a, 'c> {
    pub tx: &'a Transaction<'c>,
    pub caller: Caller,
    pub catalog: Arc<Catalog>,
    pub read_only: ReadOnly,
    /// What every listing signs its cursor with.
    pub cursors: Secret,
    faults: &'a Faults,
    /// The read answers a request that presented a reach, which it found current.
    certified: bool,
}

/// Reads in one snapshot, holding the request's reach, if it presented one, to that snapshot.
pub(crate) async fn reading<T, F>(app: &App, caller: &Caller, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Reader<'_, '_>) -> Result<T> + Send + 'static,
{
    let demand = Demand::pending();
    let held = demand.is_some();
    read_in(app, caller, demand, held, false, job).await
}

/// Reads in one snapshot behind other work, for the server's own long reads.
pub(crate) async fn reading_background<T, F>(app: &App, caller: &Caller, job: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Reader<'_, '_>) -> Result<T> + Send + 'static,
{
    read_in(app, caller, None, false, true, job).await
}

/// Reads in one snapshot, holding the reach a copy stream announced to that snapshot.
pub(crate) async fn reading_under<T, F>(
    app: &App,
    caller: &Caller,
    demand: Option<Demand>,
    job: F,
) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Reader<'_, '_>) -> Result<T> + Send + 'static,
{
    read_in(app, caller, demand, false, false, job).await
}

async fn read_in<T, F>(
    app: &App,
    caller: &Caller,
    demand: Option<Demand>,
    held: bool,
    background: bool,
    job: F,
) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Reader<'_, '_>) -> Result<T> + Send + 'static,
{
    let caller = caller.clone();
    let cache = app.catalog_handle();
    let marked = app.read_only_handle();
    let clock = app.clock.clone();
    let faults = app.faults.clone();
    let cursors = app.cursor_secret.clone();
    let read = move |tx: &rusqlite::Transaction<'_>| {
        let at = clock.stamp();
        let caller = caller.current(tx, &at)?;
        if let Some(demand) = &demand {
            demand.verify(tx, &caller)?;
            if held {
                faults.hold_blocking(HOLD_READ_SNAPSHOT);
            }
        }
        let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
        let read_only = read_only::current(&marked, tx, &at, Snapshot::Committed)?;
        job(&Reader {
            tx,
            caller,
            catalog,
            read_only,
            cursors,
            faults: &faults,
            certified: demand.is_some(),
        })
    };
    if background {
        app.db.read_background(read).await
    } else {
        app.db.read(read).await
    }
}

impl<'a, 'c> Reader<'a, 'c> {
    /// Whether the item belongs to the inventory the credential's source filter leaves it.
    fn lists(&self, row: &Item) -> Result<bool> {
        Ok(self
            .caller
            .levers()?
            .lists(&self.catalog.rules, &row.type_id, &row.source))
    }

    pub(super) fn row(&self, id: &str) -> Result<Item> {
        self.row_in(id, None, &Door::Read)
    }

    /// The item when its state is one `states` names, or not in the bin where it names none.
    fn row_in(&self, id: &str, states: Option<&States>, door: &Door) -> Result<Item> {
        self.caller.require_reach()?;
        let row = rows::by_id(self.tx, id)?
            .filter(|row| self.caller.may_read_item(&row.type_id, &row.source))
            .ok_or_else(not_found)?;
        let reached = match states {
            None => row.state != "trashed",
            Some(States::Every) => true,
            Some(States::Named(named)) => named.contains(&row.state),
        };
        if reached {
            Ok(row)
        } else if row.state == "trashed" {
            Err(door.in_the_bin())
        } else {
            Err(not_found())
        }
    }

    pub(crate) fn hydrating(&self) {
        self.faults.hold_blocking(HOLD_READ_HYDRATION);
    }

    /// The same snapshot, read as `caller` reads it.
    pub(crate) fn as_caller(&self, caller: Caller) -> Reader<'a, 'c> {
        Reader {
            tx: self.tx,
            caller,
            catalog: self.catalog.clone(),
            read_only: self.read_only.clone(),
            cursors: self.cursors.clone(),
            faults: self.faults,
            certified: false,
        }
    }

    pub(crate) fn faults(&self) -> &Faults {
        self.faults
    }

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
            Some(snapshot) => Value::from(
                self.cursors
                    .issue(VERSIONS, &Value::from(snapshot.version))?,
            )
            .to_string(),
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

/// One item's history continues on another's, as both order by version alone.
const VERSIONS: &str = "versions";

fn version_at(cursors: &Secret, cursor: &str) -> Result<i64> {
    cursors
        .open(VERSIONS, cursor)?
        .as_i64()
        .filter(|version| *version >= 0)
        .ok_or_else(bad_cursor)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Detail {
    pub versions: bool,
    pub backrefs: bool,
    pub neighbors: bool,
}

fn neighbors_of(read: &Reader<'_, '_>, far_ends: &[String]) -> Result<String> {
    let mut held = Vec::new();
    let mut truncated = false;
    let mut omitted = 0;
    for id in far_ends {
        let Some(row) = rows::by_id(read.tx, id)?
            .filter(|row| row.state != "trashed" && !super::is_hidden(&row.type_id))
        else {
            continue;
        };
        if !read.caller.may_read_type(&row.type_id) {
            omitted += 1;
            continue;
        }
        if held.len() == MAX_NEIGHBORS {
            truncated = true;
            continue;
        }
        let listed = if read.certified {
            format!(",\"listed\":{}", read.lists(&row)?)
        } else {
            String::new()
        };
        held.push(format!(
            "{{\"item\":{},\"metadata\":{}{listed}}}",
            row.answered(&read.read_only, &read.caller)?,
            metadata_for(read.tx, &row, &read.caller)?
        ));
    }
    Ok(format!(
        ",\"neighbors\":[{}],\"neighbors_omitted\":{omitted},\"neighbors_truncated\":{truncated}",
        held.join(",")
    ))
}

pub async fn detail(
    app: &App,
    caller: &Caller,
    id: String,
    include: Detail,
    door: Door,
) -> Result<String> {
    reading(app, caller, move |read| {
        let states = match &door {
            Door::Get(states) => states.as_ref(),
            _ => None,
        };
        let row = read.row_in(&id, states, &door)?;
        read.hydrating();
        let versions = if include.versions {
            format!(",\"versions\":{}", read.history_page(&row, 0, FIRST_PAGE)?)
        } else {
            String::new()
        };
        let outbound = edges::hydrate(
            read.tx,
            &read.caller,
            &read.catalog,
            &read.cursors,
            &row.id,
            Reach::Outbound,
        )?;
        let mut far_ends = outbound.far_ends;
        let backrefs = if include.backrefs {
            let inbound = edges::hydrate(
                read.tx,
                &read.caller,
                &read.catalog,
                &read.cursors,
                &row.id,
                Reach::Inbound,
            )?;
            for id in inbound.far_ends {
                if !far_ends.contains(&id) {
                    far_ends.push(id);
                }
            }
            format!(",\"backrefs\":{}", inbound.text)
        } else {
            String::new()
        };
        let neighbors = if include.neighbors {
            neighbors_of(read, &far_ends)?
        } else {
            String::new()
        };
        let listed = if read.certified {
            format!(",\"listed\":{}", read.lists(&row)?)
        } else {
            String::new()
        };
        Ok(format!(
            "{{\"item\":{},\"metadata\":{}{listed}{versions}{backrefs}{neighbors}}}",
            with_blocks(row.answered(&read.read_only, &read.caller)?, &outbound.text),
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
        read.hydrating();
        let after = match cursor.as_deref() {
            Some(cursor) => version_at(&read.cursors, cursor)?,
            None => 0,
        };
        read.history_page(&row, after, limit)
    })
    .await
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Many {
    pub metadata: bool,
    pub extensions: bool,
    pub edges: bool,
    pub hidden: bool,
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
                || (!include.hidden && super::is_hidden(&row.type_id))
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
            let mut text = if include.edges {
                row.hydrated(
                    read.tx,
                    &read.read_only,
                    &read.caller,
                    &read.catalog,
                    &read.cursors,
                )?
            } else {
                row.answered(&read.read_only, &read.caller)?
            };
            text.pop();
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
        let also = if read.certified {
            let listed: Vec<String> = visible
                .iter()
                .map(|row| read.lists(row).map(|listed| listed.to_string()))
                .collect::<Result<_>>()?;
            format!("{also},\"listed\":[{}]", listed.join(","))
        } else {
            also
        };
        Ok(format!("{{\"data\":[{}]{also}}}", items.join(",")))
    })
    .await
}

pub(crate) fn listed_rows(
    read: &Reader<'_, '_>,
    seqs: &[i64],
    include: &Many,
) -> Result<Vec<(String, Option<String>)>> {
    rows::by_seqs(read.tx, seqs)?
        .iter()
        .map(|row| {
            let mut text = if include.edges {
                row.hydrated(
                    read.tx,
                    &read.read_only,
                    &read.caller,
                    &read.catalog,
                    &read.cursors,
                )?
            } else {
                row.answered(&read.read_only, &read.caller)?
            };
            if include.extensions {
                let held =
                    extensions_text(read.tx, row, |name| read.caller.may_read_extension(name))?;
                text.pop();
                text.push_str(&format!(",\"extensions\":{held}}}"));
            }
            let metadata = include
                .metadata
                .then(|| metadata_for(read.tx, row, &read.caller))
                .transpose()?;
            Ok((text, metadata))
        })
        .collect()
}

pub(crate) fn listed(read: &Reader<'_, '_>, seqs: &[i64], include: &Many) -> Result<Vec<String>> {
    Ok(listed_rows(read, seqs, include)?
        .into_iter()
        .map(|(item, metadata)| match metadata {
            Some(metadata) if read.certified => {
                format!("{{\"item\":{item},\"metadata\":{metadata},\"listed\":true}}")
            }
            Some(metadata) => format!("{{\"item\":{item},\"metadata\":{metadata}}}"),
            None => item,
        })
        .collect())
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
                        if super::is_hidden(&row.type_id)
                            || !read.caller.may_read_type(&row.type_id)
                            || !read
                                .caller
                                .levers()?
                                .lists(rules, &row.type_id, &row.source)
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
        Ok(serde_json::json!({ "data": results }).to_string())
    })
    .await
}

/// An item's name and a short preview, as the caller may see them.
#[derive(Clone, Debug)]
pub struct Caption {
    pub name: String,
    pub preview: Option<String>,
}

/// Captions and host-derived names include only types the caller may read.
pub async fn captions(
    app: &App,
    caller: &Caller,
    ids: Vec<String>,
) -> Result<HashMap<String, Caption>> {
    reading(app, caller, move |read| {
        let mut found = HashMap::new();
        for id in ids {
            let Some(row) = rows::by_id(read.tx, &id)? else {
                continue;
            };
            if super::is_hidden(&row.type_id) || !read.caller.may_read_type(&row.type_id) {
                continue;
            }
            let shown = super::shown_of(read.tx, &read.catalog, &row, &|type_id| {
                read.caller.may_read_type(type_id)
            })?;
            found.insert(
                id,
                Caption {
                    name: shown.name.unwrap_or_else(|| super::UNTITLED.to_string()),
                    preview: shown.preview,
                },
            );
        }
        Ok(found)
    })
    .await
}

/// The tags on active items the caller may read, most used first, then by name.
pub(crate) fn readable_tags(read: &Reader<'_, '_>) -> Result<Vec<(String, i64)>> {
    let rules = &read.catalog.rules;
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for (tag, type_id, source, count) in rows::active_tags(read.tx)? {
        if !super::is_hidden(&type_id)
            && read.caller.may_read_type(&type_id)
            && read.caller.levers()?.lists(rules, &type_id, &source)
        {
            *counts.entry(tag).or_default() += count;
        }
    }
    let mut listed: Vec<(String, i64)> = counts.into_iter().collect();
    listed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(listed)
}

pub async fn tag_counts(app: &App, caller: &Caller) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        let data: Vec<Value> = readable_tags(read)?
            .into_iter()
            .map(|(tag, count)| serde_json::json!({ "tag": tag, "count": count }))
            .collect();
        Ok(serde_json::json!({ "data": data, "next_cursor": null }).to_string())
    })
    .await
}

pub async fn extensions(app: &App, caller: &Caller, id: String) -> Result<String> {
    reading(app, caller, move |read| {
        let row = read.row(&id)?;
        read.hydrating();
        extension_documents_text(read.tx, &row, |name| read.caller.may_read_extension(name))
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
        Ok(extension_text(&namespace, data.as_deref()))
    })
    .await
}

pub async fn trash_preview(app: &App, caller: &Caller, ids: Vec<String>) -> Result<String> {
    reading(app, caller, move |read| {
        let gate = Gate {
            tx: read.tx,
            caller: &read.caller,
            catalog: &read.catalog,
            claim: None,
            server_own: false,
        };
        let asked: Vec<Asked> = ids
            .into_iter()
            .map(|id| Asked { id, version: None })
            .collect();
        let plan = plan::plan(&gate, Act::Bin, &asked)?;
        let shown: HashMap<&str, &Item> = plan
            .moving
            .iter()
            .map(|moving| &moving.item)
            .filter(|item| read.caller.may_read_type(&item.type_id))
            .map(|item| (item.id.as_str(), item))
            .collect();
        let items: Vec<Value> = plan
            .named
            .iter()
            .map(|item| {
                let beneath: Vec<&Item> = plan
                    .beneath
                    .get(&item.id)
                    .into_iter()
                    .flatten()
                    .filter_map(|id| shown.get(id.as_str()).copied())
                    .collect();
                let mut entry = json!({
                    "id": item.id,
                    "type": item.type_id,
                    "version": item.version,
                    "takes": beneath
                        .iter()
                        .take(MAX_TAKES)
                        .map(|row| json!({ "id": row.id, "type": row.type_id, "version": row.version }))
                        .collect::<Vec<Value>>(),
                    "count": beneath.len() + 1,
                });
                if beneath.len() > MAX_TAKES {
                    entry["truncated"] = Value::Bool(true);
                }
                entry
            })
            .collect();
        Ok(json!({ "items": items, "count": shown.len(), "digest": plan.digest }).to_string())
    })
    .await
}

#[derive(Clone, Debug)]
pub struct Listing {
    pub type_id: Option<String>,
    pub q: String,
    pub limit: i64,
    pub cursor: Option<String>,
}

fn batch_size(limit: i64, passes_over: bool) -> i64 {
    if passes_over { WALK_BATCH } else { limit + 1 }
}

impl<'a, 'c> Reader<'a, 'c> {
    /// A name exists only once worked out from the row, so a search walks the rows.
    fn named_page(&self, listing: Listing, trashed: bool) -> Result<(Vec<Item>, Option<String>)> {
        let q = listing.q.trim().to_lowercase();
        let scope = json!(["summaries", listing.type_id, q, trashed]).to_string();
        let mut after = listing
            .cursor
            .as_deref()
            .map(|cursor| self.cursors.open_at(&scope, cursor))
            .transpose()?;
        // The bin lists what the caller may purge, which takes write on the type.
        let (selects, every): (fn(&Caller, &str) -> bool, bool) = if trashed {
            (Caller::may_write_type, self.caller.may_write_every_type())
        } else {
            (Caller::may_read_type, self.caller.may_read_every_type())
        };
        let batch_size = batch_size(
            listing.limit,
            !q.is_empty() || self.caller.levers()?.filters_sources() || !every,
        );
        let mut page = Vec::new();
        'filling: loop {
            let batch = rows::newest(
                self.tx,
                trashed,
                listing.type_id.as_deref(),
                after.as_ref(),
                batch_size,
            )?;
            let last = batch.len() < batch_size as usize;
            after = batch
                .last()
                .map(|row| (row.created_at.clone(), row.id.clone()));
            for row in batch {
                if selects(&self.caller, &row.type_id)
                    && self
                        .caller
                        .levers()?
                        .lists(&self.catalog.rules, &row.type_id, &row.source)
                    && (q.is_empty()
                        || name_of(self.tx, &self.catalog, &row)?
                            .to_lowercase()
                            .contains(&q))
                {
                    page.push(row);
                    if page.len() as i64 > listing.limit {
                        break 'filling;
                    }
                }
            }
            if last {
                break;
            }
        }
        let more = page.len() as i64 > listing.limit;
        page.truncate(listing.limit as usize);
        let next = match page.last().filter(|_| more) {
            Some(row) => Some(self.cursors.issue_at(&scope, &row.created_at, &row.id)?),
            None => None,
        };
        Ok((page, next))
    }
}

pub async fn summaries(app: &App, caller: &Caller, listing: Listing) -> Result<String> {
    reading(app, caller, move |read| {
        let (page, next) = read.named_page(listing, false)?;
        let data = page
            .iter()
            .map(|row| summary_of(read.tx, &read.catalog, row))
            .collect::<Result<Vec<Value>>>()?;
        Ok(json!({ "data": data, "next_cursor": next }).to_string())
    })
    .await
}

fn eligible_at(trashed_at: Option<&str>, retention_days: u64) -> Result<Option<String>> {
    let (Some(trashed_at), true) = (trashed_at, retention_days > 0) else {
        return Ok(None);
    };
    let kept = i64::try_from(retention_days)
        .unwrap_or(i64::MAX)
        .saturating_mul(DAY_MS);
    Ok(Some(Stamp::read(trashed_at)?.plus_ms(kept)?.text()))
}

pub async fn bin(app: &App, caller: &Caller, listing: Listing) -> Result<String> {
    let retention_days = app.settings.live().get(TRASH_RETENTION_DAYS);
    reading(app, caller, move |read| {
        let (page, next) = read.named_page(listing, true)?;
        let data = page
            .iter()
            .map(|row| {
                let mut summary = summary_of(read.tx, &read.catalog, row)?;
                summary["trashed_at"] = json!(row.trashed_at);
                summary["trashed_by"] = json!(row.trashed_by);
                summary["eligible_for_deletion_at"] =
                    json!(eligible_at(row.trashed_at.as_deref(), retention_days)?);
                Ok(summary)
            })
            .collect::<Result<Vec<Value>>>()?;
        Ok(
            json!({ "data": data, "next_cursor": next, "retention_days": retention_days })
                .to_string(),
        )
    })
    .await
}

pub async fn bin_selection(
    app: &App,
    caller: &Caller,
    listing: Listing,
) -> Result<(Vec<(String, i64)>, Option<String>)> {
    reading(app, caller, move |read| {
        let (page, next) = read.named_page(listing, true)?;
        let selected = page.into_iter().map(|row| (row.id, row.version)).collect();
        Ok((selected, next))
    })
    .await
}

/// How many items the bin lists to the caller.
pub async fn bin_total(app: &App, caller: &Caller) -> Result<i64> {
    reading(app, caller, move |read| {
        let levers = read.caller.levers()?;
        let rules = &read.catalog.rules;
        Ok(rows::binned_counts(read.tx)?
            .into_iter()
            .filter(|(type_id, source, _)| {
                read.caller.may_write_type(type_id) && levers.lists(rules, type_id, source)
            })
            .map(|(_, _, count)| count)
            .sum())
    })
    .await
}

/// The rows an owner chose to purge: by id, or one page of the bin.
#[derive(Clone, Debug)]
pub enum Choosing {
    Ids(Vec<String>),
    Page { cursor: Option<String>, limit: i64 },
}

/// An item a purge takes, as the caller may see it.
#[derive(Clone, Debug)]
pub struct Going {
    pub id: String,
    pub type_id: String,
    pub name: String,
    pub version: i64,
}

/// What the items the caller may see hold, which goes with them.
#[derive(Clone, Debug, Default)]
pub struct GoesWith {
    pub versions: i64,
    pub tags: i64,
    pub extensions: i64,
    pub table_rows: i64,
    pub connector_agreements: i64,
}

/// The walk [`write::purge_chosen`](super::write::purge_chosen) takes; `digest` covers hidden rows.
#[derive(Clone, Debug)]
pub struct PurgePreview {
    pub ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub items: Vec<Going>,
    pub hidden_items: usize,
    pub edges: usize,
    pub hidden_edges: usize,
    pub goes_with: GoesWith,
    pub digest: String,
}

pub async fn purge_preview(app: &App, caller: &Caller, choosing: Choosing) -> Result<PurgePreview> {
    reading(app, caller, move |read| {
        read.caller.require(Permission::ItemsPurge)?;
        let gate = Gate {
            tx: read.tx,
            caller: &read.caller,
            catalog: &read.catalog,
            claim: None,
            server_own: false,
        };
        let page = |cursor: Option<String>, limit: i64| -> Result<(Vec<String>, Option<String>)> {
            let listing = Listing {
                type_id: None,
                q: String::new(),
                limit,
                cursor,
            };
            let (page, next) = read.named_page(listing, true)?;
            Ok((page.into_iter().map(|row| row.id).collect(), next))
        };
        let (ids, next_cursor, plan) = match choosing {
            Choosing::Ids(asked) => {
                let mut seen = HashSet::new();
                let ids: Vec<String> = asked
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect();
                let plan = plan::chosen(&gate, &ids)?;
                (ids, None, plan)
            }
            Choosing::Page { cursor, limit } => {
                let (ids, next) = page(cursor.clone(), limit)?;
                match plan::chosen(&gate, &ids) {
                    Ok(plan) => (ids, next, plan),
                    Err(refusal) if refusal.code == Code::BulkCapExceeded => {
                        let fits = plan::fitting(&gate, &ids)?;
                        let (ids, next) = page(cursor, fits as i64)?;
                        let plan = plan::chosen(&gate, &ids)?;
                        (ids, next, plan)
                    }
                    Err(refusal) => return Err(refusal),
                }
            }
        };
        let (digest, holdings) = plan::walk_held(read.tx, &plan.purging)?;
        let levers = read.caller.levers()?;
        let rules = &read.catalog.rules;
        let shows = |row: &Item| {
            !super::is_system(&row.type_id)
                && read.caller.may_read_type(&row.type_id)
                && levers.lists(rules, &row.type_id, &row.source)
        };
        let readable = |type_id: &str| read.caller.may_read_type(type_id);
        let mut preview = PurgePreview {
            ids,
            next_cursor,
            items: Vec::new(),
            hidden_items: 0,
            edges: 0,
            hidden_edges: 0,
            goes_with: GoesWith::default(),
            digest,
        };
        for (going, holding) in plan.purging.iter().zip(&holdings) {
            let item = &going.item;
            if shows(item) {
                let shown = super::shown_of(read.tx, &read.catalog, item, &readable)?;
                preview.items.push(Going {
                    id: item.id.clone(),
                    type_id: item.type_id.clone(),
                    name: shown.name.unwrap_or_else(|| super::UNTITLED.to_string()),
                    version: item.version,
                });
                let held = &mut preview.goes_with;
                held.versions += holding.versions;
                held.tags += holding.tags;
                held.extensions += holding.extensions;
                held.table_rows += holding.table_rows;
                held.connector_agreements += holding.agreements;
            } else {
                preview.hidden_items += 1;
            }
            for (edge, source) in &going.edges {
                let target_shows = if edge.to_id == item.id {
                    shows(item)
                } else {
                    rows::by_id(read.tx, &edge.to_id)?.is_some_and(|row| shows(&row))
                };
                if shows(source)
                    && target_shows
                    && read.caller.may_read_edge(&edge.edge_type, &source.type_id)
                {
                    preview.edges += 1;
                } else {
                    preview.hidden_edges += 1;
                }
            }
        }
        Ok(preview)
    })
    .await
}

#[derive(Clone, Debug)]
pub enum Selector {
    Keys(Keys),
    Ids(Vec<String>),
}

impl<'a, 'c> Reader<'a, 'c> {
    fn found_by(&self, type_id: &str, selector: &Selector) -> Result<Vec<Item>> {
        let mut found = Vec::new();
        match selector {
            Selector::Keys(Keys::Links(links)) => {
                for link in links {
                    found.extend(rows::by_link(self.tx, type_id, link)?);
                }
            }
            Selector::Keys(Keys::Natural { source, source_ids }) => {
                for source_id in source_ids {
                    found.extend(rows::by_natural_key(self.tx, source, source_id)?);
                }
            }
            Selector::Ids(ids) => {
                for id in ids {
                    found.extend(rows::by_id(self.tx, id)?);
                }
            }
        }
        Ok(found)
    }
}

pub async fn lookup(
    app: &App,
    caller: &Caller,
    type_id: String,
    selector: Selector,
    edges: bool,
) -> Result<String> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        let keys = match &selector {
            Selector::Keys(keys) => Some(keys),
            Selector::Ids(_) => None,
        };
        if read.caller.maps_onto(&type_id) {
            marfa_rules::query::refuse_unknown_type(&read.catalog.rules, Some(&type_id))
                .map_err(crate::app::items::write::ruled)?;
        } else {
            judge_type(read, &type_id)?;
        }
        check_links(&read.catalog, &type_id, keys)?;
        let readable = read.caller.may_read_type(&type_id);
        let found = read.found_by(&type_id, &selector)?;
        read.hydrating();
        let mut data = Vec::with_capacity(found.len());
        let mut seen = HashSet::new();
        for row in found {
            if super::is_hidden(&row.type_id)
                || !read.caller.may_read_item(&row.type_id, &row.source)
                || !seen.insert(row.id.clone())
            {
                continue;
            }
            data.push(if edges {
                row.hydrated(
                    read.tx,
                    &read.read_only,
                    &read.caller,
                    &read.catalog,
                    &read.cursors,
                )?
            } else {
                row.answered(&read.read_only, &read.caller)?
            });
        }
        let tombstones = match keys.filter(|_| readable) {
            Some(keys) => rows::tombstones(read.tx, &type_id, keys)?,
            None => Vec::new(),
        };
        Ok(format!(
            "{{\"data\":[{}],\"tombstones\":{}}}",
            data.join(","),
            json!(tombstones)
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_that_can_pass_over_rows_reads_a_whole_batch_at_a_time() {
        assert_eq!(batch_size(10, false), 11);
        assert_eq!(batch_size(10, true), WALK_BATCH);
    }
}
