//! An item written as its archive line holds it; a digest lends only where the line says.

use std::collections::{BTreeSet, HashMap, HashSet};

use marfa_rules::{number, time, validation};
use rusqlite::Transaction;
use serde_json::{Map, Value};

use super::rows::{self, NewRow, Restoring};
use super::{Mark, Writer, index, link_in, title_key};
use crate::app::blobs::references::{self, Row};
use crate::app::catalog::Catalog;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;

const RESTORED: &str = "restored:";
const APP_SOURCE: &str = "oauth:";
const CONNECTION: &str = "system.connection";

/// What a restore did with one item line.
#[derive(Debug, PartialEq, Eq)]
pub enum Restored {
    /// Written as the row of this sequence number, which the item's versions are written under.
    Written(i64),
    /// The instance holds the line's id, natural key or link already, and keeps its own row.
    Duplicate,
}

/// The code a restored row of `source` is kept under: an app's source keeps no authority.
pub fn restored_source(source: &str) -> String {
    let named = source.trim_start().to_ascii_lowercase();
    if named.starts_with(APP_SOURCE) {
        format!("{RESTORED}{source}")
    } else {
        source.to_string()
    }
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn instant(value: Option<&Value>, field: &str) -> Result<Option<String>> {
    match value.and_then(Value::as_str) {
        None => Ok(None),
        Some(text) => time::rfc3339(text, field)
            .map(Some)
            .map_err(|_| Refusal::internal("a checked archive date does not read")),
    }
}

fn required_instant(item: &Map<String, Value>, field: &str) -> Result<String> {
    instant(item.get(field), field)?
        .ok_or_else(|| Refusal::internal(&format!("a checked item has no {field}")))
}

fn writer_of(value: Option<&Value>) -> Option<Writer> {
    let writer = value?.as_object()?;
    Some(Writer {
        kind: text(writer, "kind")?.to_string(),
        id: text(writer, "id")?.to_string(),
        name: text(writer, "name")?.to_string(),
    })
}

/// The digests a line says lent; a list of anything else lends nothing.
fn lending(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|listed| {
            listed
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The snapshot ids of `ids` that the instance's history already holds.
pub fn held_snapshots(
    tx: &Transaction<'_>,
    ids: impl Iterator<Item = String>,
) -> Result<HashSet<String>> {
    rows::snapshot_ids(tx, ids)
}

/// The cascade mark a line holds: the item its trash was keyed to, with that item's type, which
/// the instance's own row gives where it holds one and `archived_types` gives otherwise.
fn mark_of(
    tx: &Transaction<'_>,
    item: &Map<String, Value>,
    archived_types: &HashMap<String, String>,
) -> Result<Option<Mark>> {
    let Some(with) = text(item, "trashed_with") else {
        return Ok(None);
    };
    let with_type = match rows::by_id(tx, with)? {
        Some(held) => held.type_id,
        None => archived_types
            .get(with)
            .cloned()
            .ok_or_else(|| Refusal::internal("a checked mark names an item the archive lacks"))?,
    };
    Ok(Some(Mark {
        with: with.to_string(),
        with_type,
        hosts: false,
    }))
}

/// Writes the item an archive line holds, already judged by the archive's row checks, unless
/// the instance holds its id, natural key or link. `archived_types` holds the type of each item
/// a cascade mark in the archive names.
pub fn restore(
    unit: &Unit<'_, '_>,
    catalog: &Catalog,
    line: &Value,
    archived_types: &HashMap<String, String>,
) -> Result<Restored> {
    let tx = unit.tx();
    let item = line
        .get("item")
        .and_then(Value::as_object)
        .ok_or_else(|| Refusal::internal("a checked item line holds no item"))?;
    let type_id =
        text(item, "type").ok_or_else(|| Refusal::internal("a checked item has no type"))?;
    let id = text(item, "id").ok_or_else(|| Refusal::internal("a checked item has no id"))?;
    refuse_extensions(line, id)?;
    let source = restored_source(text(item, "source").unwrap_or(unit.caller.own_source()));
    let source_id = text(item, "source_id");
    let mut properties = item
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| Refusal::internal("a checked item has no properties"))?;
    if rows::by_id(tx, id)?.is_some() {
        return Ok(Restored::Duplicate);
    }
    if let Some(source_id) = source_id
        && rows::by_natural_key(tx, &source, source_id)?.is_some()
    {
        return Ok(Restored::Duplicate);
    }
    let link = match catalog.link_field(type_id) {
        Some(field) => link_in(field, &properties).map(str::to_string),
        None => None,
    };
    if let Some(link) = &link
        && rows::link_holder(tx, type_id, link)?.is_some()
    {
        return Ok(Restored::Duplicate);
    }
    super::write::refuse_undeclared(&unit.caller, catalog, type_id, &properties, Some(id))?;
    if type_id == CONNECTION && text(&properties, "kind") == Some("app") {
        properties.insert("status".into(), "revoked".into());
    }
    let lent = lending(line.get("lending_blobs"));
    super::write::stamp_file_size(catalog, type_id, &mut properties, |hash| {
        if lent.contains(hash.as_str()) {
            crate::app::blobs::stored_size(tx, hash)
        } else {
            Ok(None)
        }
    })?;
    let created_at = required_instant(item, "created_at")?;
    let updated_at = required_instant(item, "updated_at")?;
    let last_activity_at = Some(required_instant(item, "last_activity_at")?)
        .filter(|at| *at > updated_at)
        .unwrap_or_else(|| updated_at.clone());
    let occurred_at = required_instant(item, "occurred_at")?;
    let trashed_at = instant(item.get("trashed_at"), "trashed_at")?;
    let restored_at = instant(line.get("restored_at"), "restored_at")?;
    let state =
        text(item, "state").ok_or_else(|| Refusal::internal("a checked item has no state"))?;
    let schema_version = item
        .get("schema_version")
        .and_then(Value::as_i64)
        .filter(|held| *held >= 0)
        .unwrap_or_else(|| {
            catalog
                .types
                .get(type_id)
                .and_then(|definition| definition.get("version"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        });
    let writer = writer_of(line.get("writer"));
    let trashed_by = writer_of(line.get("trashed_by"));
    let mark = mark_of(tx, item, archived_types)?;
    let key = title_key(&catalog.rules, type_id, &properties);
    let row = rows::insert_restored(
        tx,
        &NewRow {
            id,
            type_id,
            state,
            tier: Some(text(item, "tier").unwrap_or("library")),
            source: &source,
            source_id,
            properties: &number::object(&properties),
            title_key: key.as_deref(),
            schema_version,
            occurred_at: &occurred_at,
            at: &created_at,
            trashed_at: trashed_at.as_deref(),
            trashed_by: trashed_by.as_ref(),
            link: link.as_deref(),
            capture_latitude: item.get("capture_latitude").and_then(Value::as_f64),
            capture_longitude: item.get("capture_longitude").and_then(Value::as_f64),
            writer: writer.as_ref(),
        },
        &Restoring {
            version: item
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| Refusal::internal("a checked item has no version"))?,
            updated_at: &updated_at,
            last_activity_at: &last_activity_at,
            restored_at: restored_at.as_deref(),
            mark: mark.as_ref(),
        },
    )?;
    references::archived(&properties, &lent).apply(tx, Row::Item(row.seq))?;
    let metadata = line.get("metadata").and_then(Value::as_object);
    if let Some(tags) = metadata
        .and_then(|held| held.get("tags"))
        .and_then(Value::as_array)
    {
        let mut seen = HashSet::new();
        let tags: Vec<String> = tags
            .iter()
            .filter_map(Value::as_str)
            .filter(|tag| seen.insert(*tag))
            .map(str::to_string)
            .collect();
        rows::set_tags(tx, row.seq, &tags)?;
    }
    let lent_extensions = line.get("lending_extensions").and_then(Value::as_object);
    if let Some(extensions) = metadata
        .and_then(|held| held.get("extensions"))
        .and_then(Value::as_object)
    {
        for (namespace, data) in extensions {
            let Some(data) = data.as_object().filter(|_| !namespace.is_empty()) else {
                continue;
            };
            let lent = lending(lent_extensions.and_then(|held| held.get(namespace)));
            rows::put_extension(tx, row.seq, namespace, &number::object(data))?;
            references::archived(data, &lent).apply(tx, Row::Extension(row.seq, namespace))?;
        }
    }
    let item =
        rows::by_seq(tx, row.seq)?.ok_or_else(|| Refusal::internal("a restored row is gone"))?;
    super::write::announce(unit, "item.created", &item)?;
    Ok(Restored::Written(row.seq))
}

/// Refuses an archive whose item holds an extension that a write refuses, even for an item the
/// instance already holds.
fn refuse_extensions(line: &Value, id: &str) -> Result<()> {
    let held = line
        .pointer("/metadata/extensions")
        .and_then(Value::as_object)
        .into_iter()
        .flatten();
    for (namespace, data) in held {
        let Some(data) = data.as_object() else {
            continue;
        };
        if validation::extension_reserved(namespace)
            || validation::extension_too_long(&number::object(data))
        {
            return Err(Refusal::validation(format!(
                "Item {id} carries an extension in \"{namespace}\" that a write would refuse: a reserved namespace, or data over 100 KB."
            ))
            .with_detail("item_id", id)
            .with_detail("namespace", namespace.as_str()));
        }
    }
    Ok(())
}

/// Requires a checked snapshot; an existing snapshot ID refuses the restore.
pub fn restore_version(
    tx: &Transaction<'_>,
    seq: i64,
    snapshot: &Value,
    held: &HashSet<String>,
) -> Result<()> {
    let snapshot = snapshot
        .as_object()
        .ok_or_else(|| Refusal::internal("a checked snapshot is no object"))?;
    let id =
        text(snapshot, "id").ok_or_else(|| Refusal::internal("a checked snapshot has no id"))?;
    if held.contains(id) {
        return Err(Refusal::new(
            Code::Conflict,
            format!(
                "The archive holds snapshot {id}, which this instance's history already holds."
            ),
        )
        .with_detail("snapshot_id", id));
    }
    let version = snapshot
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| Refusal::internal("a checked snapshot has no version"))?;
    let properties = snapshot
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let occurred_at = instant(snapshot.get("occurred_at"), "occurred_at")?
        .ok_or_else(|| Refusal::internal("a checked snapshot has no occurred_at"))?;
    let created_at = instant(snapshot.get("created_at"), "created_at")?
        .ok_or_else(|| Refusal::internal("a checked snapshot has no created_at"))?;
    rows::insert_snapshot(
        tx,
        &rows::NewSnapshot {
            item_seq: seq,
            version,
            id,
            properties: &number::object(&properties),
            type_id: text(snapshot, "type").unwrap_or_default(),
            tier: text(snapshot, "tier"),
            occurred_at: &occurred_at,
            source_id: text(snapshot, "source_id"),
            writer: writer_of(snapshot.get("writer")).as_ref(),
            created_at: &created_at,
        },
    )?;
    references::archived(&properties, &BTreeSet::new()).apply(tx, Row::Version(seq, version))
}

/// Brings the search index up to the rows written so far.
pub fn settle(tx: &Transaction<'_>, catalog: &Catalog) -> Result<()> {
    index::settle(tx, &catalog.rules)
}
