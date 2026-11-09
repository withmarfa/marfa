//! What an export carries of an item, read inside the export's snapshot.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Transaction;
use serde_json::{Map, Value};

use super::{Item, Marks, Writer, metadata_for, parsed, rows, with_properties};
use crate::app::access::Caller;
use crate::app::blobs::references::{self, Row};
use crate::app::catalog::Catalog;
use crate::app::connectors::ReadOnly;
use crate::app::refusal::{Refusal, Result};

const FILE_TYPE: &str = "core.file";
const BLOB_REF: &str = "blob_ref";

/// One item as an export writes it, and what the export checks and collects of it.
pub struct Archived {
    pub id: String,
    pub type_id: String,
    pub source: String,
    /// The line, `{"item":…,"metadata":…}` and, in an archive, its history and lending.
    pub line: String,
    pub snapshot_types: BTreeSet<String>,
    pub namespaces: BTreeSet<String>,
    /// The type of the row a cascade mark names, where the line shows the mark.
    pub mark_type: Option<String>,
    /// Every digest the line names: in the properties, the extensions and the history.
    pub digests: BTreeSet<String>,
    /// The whole hashes a file's `blob_ref` names, now or in the history.
    pub file_refs: BTreeSet<String>,
}

/// With history and lending when written as an archive, not as an NDJSON export.
pub fn archived(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    read_only: &ReadOnly,
    seqs: &[i64],
    with_history: bool,
) -> Result<Vec<Archived>> {
    rows::by_seqs(tx, seqs)?
        .iter()
        .map(|row| one(tx, caller, catalog, read_only, row, with_history))
        .collect()
}

fn print(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|_| Refusal::internal("an export line did not print"))
}

fn file_ref(catalog: &Catalog, type_id: &str, properties: &Map<String, Value>) -> Option<String> {
    if !catalog.rules.matches(FILE_TYPE, type_id) {
        return None;
    }
    properties
        .get(BLOB_REF)
        .and_then(Value::as_str)
        .filter(|text| crate::app::blobs::Hash::parse(text).is_ok())
        .map(str::to_string)
}

fn lending(held: BTreeMap<String, bool>) -> Vec<String> {
    held.into_iter()
        .filter_map(|(hash, lends)| lends.then_some(hash))
        .collect()
}

fn one(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    read_only: &ReadOnly,
    row: &Item,
    with_history: bool,
) -> Result<Archived> {
    let metadata = metadata_for(tx, row, caller)?;
    let extensions: Vec<(String, String)> = rows::extensions(tx, row.seq)?
        .into_iter()
        .filter(|(namespace, _)| caller.may_read_extension(namespace))
        .collect();
    let namespaces: BTreeSet<String> = extensions.iter().map(|(name, _)| name.clone()).collect();
    let properties = parsed(&row.properties)?;
    let mut digests = references::digests(&properties);
    let mut file_refs: BTreeSet<String> = file_ref(catalog, &row.type_id, &properties)
        .into_iter()
        .collect();
    let mark_type = row
        .mark
        .as_ref()
        .filter(|mark| caller.may_read_type(&mark.with_type))
        .map(|mark| mark.with_type.clone());
    let mut snapshot_types = BTreeSet::new();
    let line = if with_history {
        for (_, data) in &extensions {
            digests.extend(references::digests(&parsed(data)?));
        }
        let mut versions = Vec::new();
        for snapshot in rows::snapshots_below(tx, row.seq, row.version)? {
            if !caller.may_read_type(&snapshot.type_id) {
                continue;
            }
            let held = parsed(&snapshot.properties)?;
            digests.extend(references::digests(&held));
            file_refs.extend(file_ref(catalog, &snapshot.type_id, &held));
            snapshot_types.insert(snapshot.type_id.clone());
            versions.push(snapshot.answered()?);
        }
        let (writer, restored_at) = rows::writer_and_restored(tx, row.seq)?;
        let lending_blobs = lending(references::held(tx, Row::Item(row.seq))?);
        let mut lending_extensions = BTreeMap::new();
        for namespace in &namespaces {
            let lent = lending(references::held(tx, Row::Extension(row.seq, namespace))?);
            if !lent.is_empty() {
                lending_extensions.insert(namespace.clone(), lent);
            }
        }
        let item = with_properties(&row.head(None, Marks::To(caller)), &row.properties)?;
        let trashed_by: Option<&Writer> = row.trashed_by.as_ref();
        format!(
            "{{\"item\":{item},\"metadata\":{metadata},\"versions\":[{}],\"writer\":{},\
             \"restored_at\":{},\"trashed_by\":{},\"lending_blobs\":{},\"lending_extensions\":{}}}",
            versions.join(","),
            print(&writer)?,
            print(&restored_at)?,
            print(&trashed_by)?,
            print(&lending_blobs)?,
            print(&lending_extensions)?,
        )
    } else {
        format!(
            "{{\"item\":{},\"metadata\":{metadata}}}",
            row.answered(read_only, caller)?
        )
    };
    Ok(Archived {
        id: row.id.clone(),
        type_id: row.type_id.clone(),
        source: row.source.clone(),
        line,
        snapshot_types,
        namespaces,
        mark_type,
        digests,
        file_refs,
    })
}
