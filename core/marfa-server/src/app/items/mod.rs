//! Every write goes through [`write::apply`]; only `rows` holds the SQL of the item tables.

mod archived;
pub mod bulk;
pub mod expiry;
mod index;
mod plan;
mod read;
pub mod restored;
mod rows;
pub mod sweep;
pub mod thinning;
pub mod write;

use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::conflict::ItemFields;
use marfa_rules::{display, names};
use rusqlite::Transaction;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::access::Caller;
use super::catalog::Catalog;
use super::connectors::ReadOnly;
use super::edges::{self, Reach};
use super::refusal::{Code, Refusal, Result};

pub(crate) use archived::{Archived, archived};
pub(crate) use plan::require_version;
pub use read::{
    Caption, Detail, Listing, Many, Selector, bin, bin_selection, bulk_get, captions, detail,
    extension, extensions, history, lookup, metadata, summaries, tag_counts, titles, trash_preview,
};
pub(crate) use read::{
    Reader, listed, listed_rows, position_at, position_cursor, readable_tags, reading,
    reading_under,
};
pub(crate) use write::settle_late_part;

const UNTITLED: &str = "Untitled";

#[derive(Clone, Debug)]
pub enum Keys {
    Links(Vec<String>),
    Natural {
        source: String,
        source_ids: Vec<String>,
    },
}

fn check_keys(catalog: &Catalog, type_id: &str, keys: Option<&Keys>) -> Result<()> {
    if !catalog.rules.known(type_id) {
        return Err(
            Refusal::new(Code::UnknownType, format!("Unknown type: {type_id}"))
                .with_detail("type", type_id),
        );
    }
    if matches!(keys, Some(Keys::Links(_))) && catalog.link_field(type_id).is_none() {
        return Err(Refusal::validation(format!(
            "Type \"{type_id}\" names no link_field, so its rows hold no links"
        ))
        .with_detail("field", "links")
        .with_detail("type", type_id));
    }
    Ok(())
}

/// `properties` is stored JSON text, passed through unparsed.
#[derive(Clone, Debug)]
pub struct Item {
    seq: i64,
    pub id: String,
    pub type_id: String,
    pub state: String,
    pub tier: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub properties: String,
    pub version: i64,
    pub schema_version: i64,
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub trashed_at: Option<String>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    link: Option<String>,
    trashed_by: Option<Writer>,
    mark: Option<Mark>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    with: String,
    /// That row's type, which decides who may read its id on this row.
    with_type: String,
    hosts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Writer {
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub id: String,
    pub item_id: String,
    pub version: i64,
    pub properties: String,
    pub type_id: String,
    pub tier: Option<String>,
    pub occurred_at: String,
    pub source_id: Option<String>,
    pub writer: Option<Writer>,
    pub created_at: String,
}

#[derive(Clone, Copy)]
enum Marks<'a> {
    To(&'a Caller),
    Logged,
}

fn with_blocks(mut item: String, blocks: &str) -> String {
    item.pop();
    item.push_str(",\"edges\":");
    item.push_str(blocks);
    item.push('}');
    item
}

#[derive(Serialize)]
struct ItemHead<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    type_id: &'a str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<&'a str>,
    created_at: &'a str,
    updated_at: &'a str,
    occurred_at: &'a str,
    source: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<&'a str>,
    version: i64,
    schema_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_longitude: Option<f64>,
    trashed_at: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trashed_by_cascade: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trashed_with: Option<&'a str>,
    /// Kept in the event log so a frame can name `trashed_with` only to a
    /// key that may read that row's type; a frame never carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    trashed_with_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_only: Option<bool>,
}

#[derive(Serialize)]
struct SnapshotHead<'a> {
    id: &'a str,
    item_id: &'a str,
    version: i64,
    #[serde(rename = "type")]
    type_id: &'a str,
    tier: Option<&'a str>,
    occurred_at: &'a str,
    source_id: Option<&'a str>,
    writer: Option<&'a Writer>,
    created_at: &'a str,
}

pub(crate) fn with_properties(head: &impl Serialize, properties: &str) -> Result<String> {
    let printed = marfa_rules::number::to_vec(head)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("an item did not print"))?;
    let open = printed
        .strip_suffix('}')
        .ok_or_else(|| Refusal::internal("an item did not print as an object"))?;
    Ok(format!("{open},\"properties\":{properties}}}"))
}

pub(crate) fn parsed(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(Refusal::internal("stored properties do not read")),
    }
}

impl Item {
    fn head(&self, read_only: Option<bool>, shown: Marks) -> ItemHead<'_> {
        let mark = self.mark.as_ref();
        let named = mark.filter(|mark| match shown {
            Marks::To(caller) => caller.may_read_type(&mark.with_type),
            Marks::Logged => true,
        });
        ItemHead {
            id: &self.id,
            type_id: &self.type_id,
            state: &self.state,
            tier: self.tier.as_deref(),
            created_at: &self.created_at,
            updated_at: &self.updated_at,
            occurred_at: &self.occurred_at,
            source: &self.source,
            source_id: self.source_id.as_deref(),
            version: self.version,
            schema_version: self.schema_version,
            capture_latitude: self.capture_latitude,
            capture_longitude: self.capture_longitude,
            trashed_at: self.trashed_at.as_deref(),
            trashed_by_cascade: mark.map(|_| true),
            trashed_with: named.map(|mark| mark.with.as_str()),
            trashed_with_type: named
                .filter(|_| matches!(shown, Marks::Logged))
                .map(|mark| mark.with_type.as_str()),
            read_only,
        }
    }

    pub fn answered(&self, read_only: &ReadOnly, caller: &Caller) -> Result<String> {
        let read_only = read_only.of(&self.source, &self.type_id);
        with_properties(
            &self.head(Some(read_only), Marks::To(caller)),
            &self.properties,
        )
    }

    pub(crate) fn hydrated(
        &self,
        tx: &Transaction<'_>,
        read_only: &ReadOnly,
        caller: &Caller,
        catalog: &Catalog,
    ) -> Result<String> {
        let blocks = edges::hydrate(tx, caller, catalog, &self.id, Reach::Outbound)?;
        Ok(with_blocks(self.answered(read_only, caller)?, &blocks.text))
    }

    /// A frame adds `read_only` when it is sent.
    fn logged(&self) -> Result<String> {
        with_properties(&self.head(None, Marks::Logged), &self.properties)
    }

    fn state_named(&self) -> Result<Value> {
        Ok(json!({
            "id": self.id,
            "version": self.version,
            "properties": Value::Object(parsed(&self.properties)?),
            "type": self.type_id,
            "tier": self.tier,
            "occurred_at": self.occurred_at,
            "source_id": self.source_id,
        }))
    }

    fn fields(&self) -> ItemFields {
        ItemFields {
            tier: self.tier.clone(),
            occurred_at: Some(self.occurred_at.clone()),
            source_id: self.source_id.clone(),
        }
    }
}

impl Snapshot {
    fn answered(&self) -> Result<String> {
        let head = SnapshotHead {
            id: &self.id,
            item_id: &self.item_id,
            version: self.version,
            type_id: &self.type_id,
            tier: self.tier.as_deref(),
            occurred_at: &self.occurred_at,
            source_id: self.source_id.as_deref(),
            writer: self.writer.as_ref(),
            created_at: &self.created_at,
        };
        with_properties(&head, &self.properties)
    }

    fn state_named(&self) -> Result<Value> {
        Ok(json!({
            "id": self.item_id,
            "version": self.version,
            "properties": Value::Object(parsed(&self.properties)?),
            "type": self.type_id,
            "tier": self.tier,
            "occurred_at": self.occurred_at,
            "source_id": self.source_id,
        }))
    }

    fn fields(&self) -> ItemFields {
        ItemFields {
            tier: self.tier.clone(),
            occurred_at: Some(self.occurred_at.clone()),
            source_id: self.source_id.clone(),
        }
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::ItemNotFound, "Item not found")
}

/// The row `id` names when it is of `type_id` and the caller may read that type.
pub(crate) fn readable_of(
    tx: &Transaction<'_>,
    caller: &Caller,
    id: &str,
    type_id: &str,
) -> Result<Item> {
    rows::by_id(tx, id)?
        .filter(|row| {
            row.type_id == type_id && row.state != "trashed" && caller.may_read_type(type_id)
        })
        .ok_or_else(not_found)
}

/// Rows of one type and state, newest first, after the position a page ended at.
pub(crate) fn newest_of(
    tx: &Transaction<'_>,
    type_id: &str,
    state: &str,
    after: Option<(&str, &str)>,
    limit: i64,
) -> Result<Vec<Item>> {
    rows::newest_of(tx, type_id, state, after, limit)
}

fn link_in<'a>(field: &str, properties: &'a Map<String, Value>) -> Option<&'a str> {
    properties
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn name_of(tx: &Transaction<'_>, catalog: &Catalog, row: &Item) -> Result<String> {
    let shown = shown_of(tx, catalog, row, &|_| true)?;
    Ok(shown.name.unwrap_or_else(|| UNTITLED.to_string()))
}

/// An item's name and preview; a part is named after its oldest host of a readable type.
pub(crate) fn shown_of(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    row: &Item,
    readable: &dyn Fn(&str) -> bool,
) -> Result<display::ItemDisplay> {
    let rules = &catalog.rules;
    let properties = parsed(&row.properties)?;
    let untitled = display::title_name(&properties, rules.title_field(&row.type_id)).is_none();
    let host = if untitled {
        edges::naming_host(tx, catalog, &row.id, readable)?
    } else {
        None
    };
    Ok(match host {
        Some(host) => {
            let held = parsed(&host.properties).unwrap_or_default();
            let host_name = rules
                .display(&host.type_id, &held)
                .name
                .unwrap_or_else(|| UNTITLED.to_string());
            display::part_display(
                &properties,
                rules.body_field(&row.type_id),
                &host.label,
                &host_name,
            )
        }
        None => rules.display(&row.type_id, &properties),
    })
}

fn summary_of(tx: &Transaction<'_>, catalog: &Catalog, row: &Item) -> Result<Value> {
    Ok(json!({
        "id": row.id,
        "type": row.type_id,
        "version": row.version,
        "name": name_of(tx, catalog, row)?,
        "source": row.source,
        "created_at": row.created_at,
    }))
}

pub(crate) fn is_system(type_id: &str) -> bool {
    type_id.split('.').next() == Some("system")
}

fn title_key(rules: &Rules, type_id: &str, properties: &Map<String, Value>) -> Option<String> {
    if is_system(type_id) {
        return None;
    }
    properties
        .get(rules.title_property(type_id))
        .and_then(Value::as_str)
        .and_then(names::title_key)
}

fn metadata_text(
    tx: &Transaction<'_>,
    item: &Item,
    shown: impl Fn(&str) -> bool,
) -> Result<String> {
    let tags = rows::tags(tx, item.seq)?;
    let head = marfa_rules::number::to_vec(&json!({ "item_id": item.id, "tags": tags }))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| Refusal::internal("metadata did not print"))?;
    let open = head
        .strip_suffix('}')
        .ok_or_else(|| Refusal::internal("metadata did not print as an object"))?;
    Ok(format!(
        "{open},\"extensions\":{}}}",
        extensions_text(tx, item, shown)?
    ))
}

fn extensions_text(
    tx: &Transaction<'_>,
    item: &Item,
    shown: impl Fn(&str) -> bool,
) -> Result<String> {
    let entries: Vec<String> = rows::extensions(tx, item.seq)?
        .into_iter()
        .filter(|(namespace, _)| shown(namespace))
        .map(|(namespace, data)| format!("{}:{data}", Value::from(namespace)))
        .collect();
    Ok(format!("{{{}}}", entries.join(",")))
}

fn metadata_for(tx: &Transaction<'_>, item: &Item, caller: &Caller) -> Result<String> {
    metadata_text(tx, item, |namespace| caller.may_read_extension(namespace))
}

pub(crate) fn row(tx: &Transaction<'_>, id: &str) -> Result<Option<Item>> {
    rows::by_id(tx, id)
}

pub fn type_of(tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
    Ok(rows::by_id(tx, id)?.map(|row| row.type_id))
}

pub fn mark_type(tx: &Transaction<'_>, id: &str) -> Result<Option<String>> {
    Ok(rows::by_id(tx, id)?.and_then(|row| row.mark.map(|mark| mark.with_type)))
}

pub fn count_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<i64> {
    rows::count_of_type(tx, type_id)
}

pub fn held_names(tx: &Transaction<'_>, types: &[String], names: &[String]) -> Result<Vec<String>> {
    if types.is_empty() {
        return Ok(Vec::new());
    }
    rows::held_names(tx, types, names)
}

pub fn reindex_changed(tx: &Transaction<'_>, before: &Rules, after: &Rules) -> Result<()> {
    index::queue_changed(tx, before, after)?;
    index::reindex_page(tx, after, index::REINDEX_PAGE)?;
    Ok(())
}

pub fn reindex_page(tx: &Transaction<'_>, rules: &Rules) -> Result<bool> {
    index::reindex_page(tx, rules, index::REINDEX_PAGE)
}

pub fn rekey_changed(
    tx: &Transaction<'_>,
    before: &Rules,
    after: &Rules,
    types: &[String],
) -> Result<()> {
    for type_id in types {
        if before.title_property(type_id) == after.title_property(type_id) {
            continue;
        }
        for (seq, properties) in rows::of_type(tx, type_id)? {
            let key = title_key(after, type_id, &parsed(&properties)?);
            rows::set_title_key(tx, seq, key.as_deref())?;
        }
    }
    Ok(())
}

/// A tombstone recorded a value of the old field, which says nothing about the new one.
pub fn relink_changed(
    tx: &Transaction<'_>,
    before: &Catalog,
    after: &Catalog,
    types: &[String],
) -> Result<()> {
    for type_id in types {
        let field = after.link_field(type_id);
        if before.link_field(type_id) == field {
            continue;
        }
        rows::drop_link_tombstones(tx, type_id)?;
        rows::clear_links(tx, type_id)?;
        let Some(field) = field else {
            continue;
        };
        for (seq, properties) in rows::of_type(tx, type_id)? {
            let properties = parsed(&properties)?;
            let Some(link) = link_in(field, &properties) else {
                continue;
            };
            if rows::set_link(tx, seq, link)? {
                return Err(Refusal::new(
                    Code::LinkTaken,
                    format!("Two items of type \"{type_id}\" hold one value in {field}."),
                )
                .with_detail("type", type_id.as_str())
                .with_detail("field", field));
            }
        }
    }
    Ok(())
}

pub fn drop_tombstones(tx: &Transaction<'_>, type_id: &str) -> Result<()> {
    rows::drop_tombstones(tx, type_id)
}
