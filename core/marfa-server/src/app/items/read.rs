//! Each read runs in one transaction: it authorizes and hydrates from the same snapshot, so
//! nothing it answers is newer than what it judged.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Days, SecondsFormat, Utc};
use marfa_rules::names;
use rusqlite::Transaction;
use serde_json::{Value, json};

use super::plan::{self, Act, Asked, Gate};
use super::rows::Position;
use super::{
    Item, Keys, check_keys, extensions_text, metadata_for, name_of, not_found, rows, summary_of,
    with_blocks,
};
use crate::app::App;
use crate::app::access::reach::Demand;
use crate::app::access::{Caller, Level};
use crate::app::catalog::{self, Catalog, Snapshot};
use crate::app::edges::{self, Reach};
use crate::app::faults::{Faults, HOLD_READ_HYDRATION, HOLD_READ_SNAPSHOT};
use crate::app::refusal::{Refusal, Result};
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
    read_in(app, caller, demand, held, job).await
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
    read_in(app, caller, demand, false, job).await
}

async fn read_in<T, F>(
    app: &App,
    caller: &Caller,
    demand: Option<Demand>,
    held: bool,
    job: F,
) -> Result<T>
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
            if let Some(demand) = &demand {
                demand.verify(tx, &caller)?;
                if held {
                    faults.hold_blocking(HOLD_READ_SNAPSHOT);
                }
            }
            let catalog = catalog::current(&cache, tx, Snapshot::Committed)?;
            job(&Reader {
                tx,
                caller,
                catalog,
                faults: &faults,
                certified: demand.is_some(),
            })
        })
        .await
}

impl Reader<'_, '_> {
    /// Whether the item belongs to the inventory the credential's source filter leaves it.
    fn lists(&self, row: &Item) -> bool {
        self.caller
            .lists(&self.catalog.rules, &row.type_id, &row.source)
    }

    fn row(&self, id: &str) -> Result<Item> {
        self.caller.require_reach()?;
        rows::by_id(self.tx, id)?
            .filter(|row| row.state != "trashed" && self.caller.may_read_type(&row.type_id))
            .ok_or_else(not_found)
    }

    pub(crate) fn hydrating(&self) {
        self.faults.hold_blocking(HOLD_READ_HYDRATION);
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
            Some(snapshot) => Value::from(cursor_of(snapshot.version)).to_string(),
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

fn cursor_of(version: i64) -> String {
    hex::encode(format!("versions\0{version}"))
}

fn version_at(cursor: &str) -> Result<i64> {
    let refused = || Refusal::validation("The cursor does not belong to this listing.");
    let text = hex::decode(cursor)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(refused)?;
    text.strip_prefix("versions\0")
        .and_then(|version| version.parse().ok())
        .ok_or_else(refused)
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
            .filter(|row| row.state != "trashed" && !super::is_system(&row.type_id))
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
            format!(",\"listed\":{}", read.lists(&row))
        } else {
            String::new()
        };
        held.push(format!(
            "{{\"item\":{},\"metadata\":{}{listed}}}",
            row.answered(read.tx, &read.caller)?,
            metadata_for(read.tx, &row, &read.caller)?
        ));
    }
    Ok(format!(
        ",\"neighbors\":[{}],\"neighbors_omitted\":{omitted},\"neighbors_truncated\":{truncated}",
        held.join(",")
    ))
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
        let outbound = edges::hydrate(
            read.tx,
            &read.caller,
            &read.catalog,
            &row.id,
            Reach::Outbound,
        )?;
        let mut far_ends = outbound.far_ends;
        let backrefs = if include.backrefs {
            let inbound = edges::hydrate(
                read.tx,
                &read.caller,
                &read.catalog,
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
            format!(",\"listed\":{}", read.lists(&row))
        } else {
            String::new()
        };
        Ok(format!(
            "{{\"item\":{},\"metadata\":{}{listed}{versions}{backrefs}{neighbors}}}",
            with_blocks(row.answered(read.tx, &read.caller)?, &outbound.text),
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
            Some(cursor) => version_at(cursor)?,
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
            let mut text = if include.edges {
                row.hydrated(read.tx, &read.caller, &read.catalog)?
            } else {
                row.answered(read.tx, &read.caller)?
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
                .map(|row| read.lists(row).to_string())
                .collect();
            format!("{also},\"listed\":[{}]", listed.join(","))
        } else {
            also
        };
        Ok(format!("{{\"items\":[{}]{also}}}", items.join(",")))
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
                row.hydrated(read.tx, &read.caller, &read.catalog)?
            } else {
                row.answered(read.tx, &read.caller)?
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

/// The tags on active items the caller may read, most used first, then by name.
pub(crate) fn readable_tags(read: &Reader<'_, '_>) -> Result<Vec<(String, i64)>> {
    let rules = &read.catalog.rules;
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for (tag, type_id, source, count) in rows::active_tags(read.tx)? {
        if read.caller.may_read_type(&type_id) && read.caller.lists(rules, &type_id, &source) {
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

pub(crate) fn position_cursor(scope: &str, position: &Position) -> String {
    hex::encode(format!("{scope}\0{}\0{}", position.0, position.1))
}

pub(crate) fn position_at(cursor: &str, scope: &str) -> Result<Position> {
    let refused = || Refusal::validation("The cursor does not belong to this listing.");
    let text = hex::decode(cursor)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(refused)?;
    let (at, id) = text
        .strip_prefix(scope)
        .and_then(|rest| rest.strip_prefix('\0'))
        .and_then(|rest| rest.split_once('\0'))
        .ok_or_else(refused)?;
    Ok((at.to_string(), id.to_string()))
}

fn batch_size(limit: i64, passes_over: bool) -> i64 {
    if passes_over { WALK_BATCH } else { limit + 1 }
}

impl Reader<'_, '_> {
    /// A name exists only once worked out from the row, so a search walks the rows.
    fn named_page(&self, listing: Listing, trashed: bool) -> Result<(Vec<Item>, Option<String>)> {
        let q = listing.q.trim().to_lowercase();
        let scope = json!(["summaries", listing.type_id, q, trashed]).to_string();
        let mut after = listing
            .cursor
            .as_deref()
            .map(|cursor| position_at(cursor, &scope))
            .transpose()?;
        let batch_size = batch_size(
            listing.limit,
            !q.is_empty() || self.caller.filters_sources(),
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
                if self
                    .caller
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
        let next = page
            .last()
            .filter(|_| more)
            .map(|row| position_cursor(&scope, &(row.created_at.clone(), row.id.clone())));
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

fn eligible_at(trashed_at: Option<&str>, retention_days: u64) -> Option<String> {
    if retention_days == 0 {
        return None;
    }
    let trashed_at = DateTime::parse_from_rfc3339(trashed_at?).ok()?;
    let eligible = trashed_at
        .with_timezone(&Utc)
        .checked_add_days(Days::new(retention_days))?;
    Some(eligible.to_rfc3339_opts(SecondsFormat::Millis, true))
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
                    json!(eligible_at(row.trashed_at.as_deref(), retention_days));
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

#[derive(Clone, Debug)]
pub enum Selector {
    Keys(Keys),
    Ids(Vec<String>),
}

impl Reader<'_, '_> {
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
        check_keys(&read.catalog, &type_id, keys)?;
        let readable = read.caller.may_read_type(&type_id);
        if !readable
            && !read
                .catalog
                .rules
                .descendants(&type_id)
                .any(|below| read.caller.may_read_type(below))
        {
            read.caller.require_type(&type_id, Level::Read)?;
        }
        let found = read.found_by(&type_id, &selector)?;
        read.hydrating();
        let mut data = Vec::with_capacity(found.len());
        let mut seen = HashSet::new();
        for row in found {
            if super::is_system(&row.type_id)
                || !read.caller.may_read_type(&row.type_id)
                || !seen.insert(row.id.clone())
            {
                continue;
            }
            data.push(if edges {
                row.hydrated(read.tx, &read.caller, &read.catalog)?
            } else {
                row.answered(read.tx, &read.caller)?
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
