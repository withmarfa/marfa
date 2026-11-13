//! Reads a restore's body as it arrives, keeping in memory only the ids cross-row checks need.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::sync::Arc;

use flate2::write::GzDecoder;
use marfa_rules::schema::{Obj, icon_issue};
use serde_json::{Map, Value, json};

use super::untar::{NotTar, Part, Reader};
use crate::app::archive::{
    BLOBS, EDGES, ENTRIES, FILES, FORMAT, INSTANCE, ITEMS, MANIFEST, ROWS, VERSION, VERSIONS,
    checks,
};
use crate::app::blobs::Hash;
use crate::app::blobs::restore::{Arriving, Named, Sealed, Spool};
use crate::app::catalog::Catalog;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{edge_types, sources, stored, types};

fn invalid(message: impl Into<String>) -> Refusal {
    Refusal::validation(message.into())
}

fn registered_twice(field: &str, id: &str) -> Refusal {
    invalid(format!("The archive registers {id} more than once.")).with_detail(field, id)
}

fn damaged_schema(message: impl Into<String>) -> Refusal {
    Refusal::new(Code::InvalidSchema, message.into())
}

/// The 128 bits of an id in its lowercase hyphenated form; the row checks refuse every other.
fn bits(id: &str) -> Option<u128> {
    uuid::Uuid::parse_str(id)
        .ok()
        .filter(|held| held.hyphenated().to_string() == id)
        .map(|held| held.as_u128())
}

fn too_long(file: LineFile, row: usize, cap: usize) -> Refusal {
    invalid(format!(
        "Line {row} of {} holds more than {cap} bytes, more than a restore reads.",
        file.name()
    ))
    .with_detail("entry", file.name())
    .with_detail("line", row)
}

/// Snapshot ids, each kept as its 128 bits.
#[derive(Default)]
pub struct Ids(HashSet<u128>);

impl Ids {
    /// Whether `id` was not held before.
    fn insert(&mut self, id: &str) -> bool {
        bits(id).is_none_or(|held| self.0.insert(held))
    }

    pub fn contains(&self, id: &str) -> bool {
        bits(id).is_some_and(|held| self.0.contains(&held))
    }

    /// Each id, in its lowercase hyphenated form.
    pub fn each(&self) -> impl Iterator<Item = String> + '_ {
        self.0
            .iter()
            .map(|held| uuid::Uuid::from_u128(*held).hyphenated().to_string())
    }
}

/// What a `files.ndjson.gz` line says of a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Carried,
    NotCarried,
    /// No store gave the file whole when the backup was taken.
    Lost,
}

#[derive(Debug)]
pub struct Listed {
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub state: State,
}

/// What the manifest counts, and each file `files.ndjson.gz` names, by hash.
#[derive(Debug, Default)]
pub struct Manifest {
    pub files: BTreeMap<String, Listed>,
    /// The lines it counts in each line file but `instance.ndjson.gz`, in the order of `COUNTED`.
    pub counts: [u64; COUNTED.len()],
    /// The lines it counts of each kind in `instance.ndjson.gz`, in the order of `KINDS`.
    pub instance_counts: [u64; KINDS.len()],
    /// The `blobs/` entries it says the archive carries.
    pub blob_count: u64,
}

impl Manifest {
    /// The files the instance that wrote the archive held and had not lost.
    pub fn held_files(&self) -> HashSet<String> {
        self.files
            .iter()
            .filter(|(_, listed)| match listed.state {
                State::Carried => true,
                State::NotCarried => listed.size_bytes.is_some(),
                State::Lost => false,
            })
            .map(|(hash, _)| hash.clone())
            .collect()
    }
}

/// The manifest field that counts the lines of each line file but `instance.ndjson.gz`.
const COUNTED: [(&str, &str); 5] = [
    ("file_count", FILES),
    ("item_count", ITEMS),
    ("version_count", VERSIONS),
    ("edge_count", EDGES),
    ("row_count", ROWS),
];

/// What `instance.ndjson.gz` registers and sets; the agreements stay in the spool.
#[derive(Default)]
pub struct Registrations {
    pub types: Vec<types::write::Archived>,
    pub edge_types: Vec<Obj>,
    /// Each type's icon, or `None` for one outside the pinned sets.
    pub icons: Vec<(String, Option<String>)>,
    pub sources: Vec<sources::Archived>,
    pub settings: Vec<(String, String)>,
    /// Names of settings this instance does not have, which the restore leaves out.
    pub dropped_settings: Vec<String>,
    pub states: Vec<(String, Map<String, Value>)>,
}

/// A body read to its end and checked, ready for the restore's write.
pub struct Received {
    pub manifest: Manifest,
    pub registrations: Registrations,
    /// The line files, in the order of `LineFile`.
    pub spools: [crate::app::blobs::Scratch; LINE_FILES.len()],
    pub snapshots: Ids,
    pub carried: Vec<(Sealed, String)>,
    /// Each entry the restore did not read, by name, in the order the archive holds them.
    pub skipped: Vec<String>,
}

impl Received {
    /// The blobs the manifest names that no entry carried with bytes hashing to the name.
    pub fn absent(&self) -> Vec<Named> {
        let carried: HashSet<&str> = self
            .carried
            .iter()
            .map(|(sealed, _)| sealed.hash.as_str())
            .collect();
        self.manifest
            .files
            .iter()
            .filter(|(hash, _)| !carried.contains(hash.as_str()))
            .filter_map(|(hash, listed)| {
                Some(Named {
                    hash: Hash::parse(hash).ok()?,
                    mime_type: listed.mime_type.clone(),
                    size_bytes: listed.size_bytes,
                })
            })
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineFile {
    Files,
    Instance,
    Items,
    Versions,
    Edges,
    Rows,
}

/// The line files, in the order the archive holds them after its manifest.
pub const LINE_FILES: [LineFile; 6] = [
    LineFile::Files,
    LineFile::Instance,
    LineFile::Items,
    LineFile::Versions,
    LineFile::Edges,
    LineFile::Rows,
];

impl LineFile {
    fn name(self) -> &'static str {
        match self {
            LineFile::Files => FILES,
            LineFile::Instance => INSTANCE,
            LineFile::Items => ITEMS,
            LineFile::Versions => VERSIONS,
            LineFile::Edges => EDGES,
            LineFile::Rows => ROWS,
        }
    }

    pub fn slot(self) -> usize {
        self as usize
    }
}

/// What the line checks keep of an item the archive holds.
struct HeldItem {
    type_index: u32,
    line: usize,
    version: i64,
}

/// What the line checks carry from one line to the next and from file to file.
struct Rows {
    committed: Arc<Catalog>,
    cap: usize,
    /// The most one line may hold.
    line_cap: usize,
    catalog: Option<Catalog>,
    registrations: Registrations,
    files: BTreeMap<String, Listed>,
    icon_types: HashSet<String>,
    items_held: HashMap<u128, HeldItem>,
    type_ids: HashSet<String>,
    edge_type_ids: HashSet<String>,
    setting_keys: HashSet<String>,
    type_names: Vec<String>,
    snapshots: Ids,
    /// The lines read of each line file, in the order of `LineFile`.
    read: [usize; LINE_FILES.len()],
    kinds: [u64; KINDS.len()],
    /// The place of the last row line read, which the next must come after.
    last_row: Option<checks::RowKey>,
    /// The item line and version of the last version line read, which the next must come after.
    last_version: Option<(usize, i64)>,
}

/// Each kind of `instance.ndjson.gz` line, with the manifest field that counts it.
const KINDS: [(&str, &str); 7] = [
    ("type", "type_count"),
    ("edge_type", "edge_type_count"),
    ("type_icon", "type_icon_count"),
    ("source", "source_count"),
    ("setting", "setting_count"),
    ("connector_state", "connector_state_count"),
    ("connector_agreement", "connector_agreement_count"),
];

fn kind_of(line: &Value) -> Option<usize> {
    let object = line.as_object()?;
    KINDS
        .iter()
        .position(|(kind, _)| object.contains_key(*kind))
}

impl Rows {
    fn line(&mut self, file: LineFile, text: &[u8]) -> Result<()> {
        let row = self.counted(file);
        *row += 1;
        let row = *row;
        if text.len() > self.line_cap {
            return Err(too_long(file, row, self.line_cap));
        }
        if let Some(pointer) = marfa_rules::json_text::ill_formed_at(text) {
            let named = named_by(file, text);
            let refusal = invalid(format!(
                "{} on line {row} of {} holds text at {pointer} with a surrogate escape that has no partner.",
                named.as_ref().map_or_else(|| "A line".to_string(), |(kind, id)| format!("{kind} {id}")),
                file.name()
            ))
            .with_detail("entry", file.name())
            .with_detail("line", row)
            .with_detail("pointer", pointer);
            return Err(match named {
                Some((kind, id)) => {
                    refusal.with_detail(&format!("{}_id", kind.to_ascii_lowercase()), id)
                }
                None => refusal,
            });
        }
        let line: Value = serde_json::from_slice(text).map_err(|_| {
            invalid(format!("Line {row} of {} is not JSON.", file.name()))
                .with_detail("entry", file.name())
                .with_detail("line", row)
        })?;
        match file {
            LineFile::Files => self.file_line(&line, row),
            LineFile::Instance => self.instance_line(&line, row),
            LineFile::Items => self.item_line(&line, row),
            LineFile::Versions => self.version_line(&line, row),
            LineFile::Edges => self.edge_line(&line, row),
            LineFile::Rows => self.row_line(&line, row),
        }
    }

    fn counted(&mut self, file: LineFile) -> &mut usize {
        &mut self.read[file.slot()]
    }

    fn file_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let wrong = |field: &str, expected: &str| {
            invalid(format!(
                "Line {row} of {FILES}: {field} must be {expected}."
            ))
            .with_detail("entry", FILES)
            .with_detail("line", row)
            .with_detail("field", field)
        };
        let Some(object) = line.as_object() else {
            return Err(invalid(format!("Line {row} of {FILES} must be an object."))
                .with_detail("entry", FILES)
                .with_detail("line", row));
        };
        let Some(hash) = object
            .get("hash")
            .and_then(Value::as_str)
            .filter(|hash| Hash::parse(hash).is_ok())
        else {
            return Err(wrong("hash", "a sha256: hash"));
        };
        let state = match object.get("state").and_then(Value::as_str) {
            Some("carried") => State::Carried,
            Some("not_carried") => State::NotCarried,
            Some("lost") => State::Lost,
            _ => return Err(wrong("state", "carried, not_carried or lost")),
        };
        let mime_type = match object.get("mime_type") {
            Some(Value::String(mime)) => Some(served_type(mime)),
            Some(Value::Null) if state != State::Carried => None,
            _ => {
                return Err(wrong(
                    "mime_type",
                    "a string, or null for a file not carried",
                ));
            }
        };
        let size_bytes = match object.get("size_bytes") {
            Some(Value::Null) if state != State::Carried => None,
            Some(size) if size.as_u64().is_some() => size.as_u64(),
            _ => {
                return Err(wrong(
                    "size_bytes",
                    "a non-negative integer, or null for a file not carried",
                ));
            }
        };
        let listed = Listed {
            mime_type,
            size_bytes,
            state,
        };
        if self.files.insert(hash.to_string(), listed).is_some() {
            return Err(invalid(format!("{FILES} names {hash} more than once."))
                .with_detail("entry", FILES)
                .with_detail("hash", hash));
        }
        Ok(())
    }

    fn version_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let named = |refusal: Refusal| refusal.with_detail("entry", VERSIONS);
        let key = checks::version(self.cap, line, row).map_err(|refused| named(refused.refusal))?;
        let refused = |message: String, field: &str| {
            named(invalid(message))
                .with_detail("line", row)
                .with_detail("item_id", key.item_id.as_str())
                .with_detail("field", field)
        };
        let Some(item) = bits(&key.item_id).and_then(|id| self.items_held.get(&id)) else {
            return Err(refused(
                format!(
                    "Version {} on line {row} of {VERSIONS} names item {}, which the archive does not hold.",
                    key.version, key.item_id
                ),
                "item_id",
            ));
        };
        if key.version >= item.version {
            return Err(refused(
                format!(
                    "Version {} on line {row} of {VERSIONS} is not below the version of item {}, {}.",
                    key.version, key.item_id, item.version
                ),
                "version",
            ));
        }
        let place = (item.line, key.version);
        if self.last_version.is_some_and(|last| last >= place) {
            return Err(refused(
                format!(
                    "Version {} of item {} on line {row} of {VERSIONS} does not come after the line before it, in the order of the items and then of their versions.",
                    key.version, key.item_id
                ),
                "version",
            ));
        }
        self.last_version = Some(place);
        if !self.snapshots.insert(&key.id) {
            return Err(refused(
                format!(
                    "Version {} of item {} on line {row} of {VERSIONS} has the id {}, which another version in the archive has.",
                    key.version, key.item_id, key.id
                ),
                "id",
            ));
        }
        Ok(())
    }

    fn row_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let key = checks::row(line, row).map_err(|refused| refused.refusal)?;
        let held = bits(&key.item_id).is_some_and(|id| self.items_held.contains_key(&id));
        if !held {
            return Err(invalid(format!(
                "Row {} on line {row} of {ROWS} names item {}, which the archive does not hold.",
                key.id, key.item_id
            ))
            .with_detail("line", row)
            .with_detail("row_id", key.id.as_str())
            .with_detail("item_id", key.item_id.as_str())
            .with_detail("field", "item_id"));
        }
        if self.last_row.as_ref().is_some_and(|last| *last >= key) {
            return Err(invalid(format!(
                "Row {} on line {row} of {ROWS} does not come after the line before it in order of item_id, table and id.",
                key.id
            ))
            .with_detail("line", row)
            .with_detail("row_id", key.id.as_str())
            .with_detail("item_id", key.item_id.as_str()));
        }
        self.last_row = Some(key);
        Ok(())
    }

    fn instance_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let at = kind_of(line).ok_or_else(|| {
            invalid(format!(
                "Line {row} of {INSTANCE} names none of type, edge_type, type_icon, source, setting, connector_state or connector_agreement."
            ))
        })?;
        self.kinds[at] += 1;
        let kind = KINDS[at].0;
        let body = &line[kind];
        let registrations = &mut self.registrations;
        match kind {
            "type" => {
                if line
                    .pointer("/provenance/origin")
                    .and_then(Value::as_str)
                    .is_some_and(|origin| origin == "platform")
                {
                    return Err(Refusal::new(
                        Code::Forbidden,
                        "The archive claims a type is platform-shipped, which no archive can restore.",
                    ));
                }
                if let Some(id) = body.get("id").and_then(Value::as_str)
                    && !self.type_ids.insert(id.to_string())
                {
                    return Err(registered_twice("type_id", id));
                }
                registrations.types.push(types::write::Archived {
                    definition: body.clone(),
                    created_by: line
                        .pointer("/provenance/created_by")
                        .filter(|by| by.is_object())
                        .cloned(),
                });
            }
            "edge_type" => {
                let definition = body.as_object().ok_or_else(|| {
                    invalid(format!(
                        "Line {row} of {INSTANCE} holds an edge type that is not an object."
                    ))
                })?;
                if let Some(id) = definition.get("id").and_then(Value::as_str)
                    && !self.edge_type_ids.insert(id.to_string())
                {
                    return Err(registered_twice("edge_type", id));
                }
                registrations.edge_types.push(definition.clone());
            }
            "type_icon" => {
                let type_id = body
                    .get("type_id")
                    .and_then(Value::as_str)
                    .filter(|id| marfa_rules::grammar::type_id(id).unwrap_or(false))
                    .ok_or_else(|| {
                        damaged_schema("The archive carries a type icon with an invalid type identifier.")
                            .with_detail("errors", json!([{ "path": "type_icon.type_id", "message": "Not a type identifier." }]))
                    })?;
                let icon = body
                    .get("icon")
                    .filter(|icon| icon.is_string())
                    .ok_or_else(|| {
                        damaged_schema(format!(
                            "The archive carries an icon for {type_id} that is not a string."
                        ))
                        .with_detail(
                            "errors",
                            json!([{ "path": "type_icon.icon", "message": "Not a string." }]),
                        )
                    })?;
                if !self.icon_types.insert(type_id.to_string()) {
                    return Err(invalid(format!(
                        "The archive carries more than one icon for {type_id}."
                    )));
                }
                let drawn = icon_issue(Some(icon), "type_icon.icon")
                    .is_none()
                    .then(|| icon.as_str().unwrap_or_default().to_string());
                registrations.icons.push((type_id.to_string(), drawn));
            }
            "source" => registrations.sources.push(sources::archived(
                body,
                crate::app::items::restored::restored_source,
            )?),
            "setting" => {
                let (key, text) = stored::archived(body)?;
                if !self.setting_keys.insert(key.clone()) {
                    return Err(invalid(format!(
                        "The archive carries more than one value for setting {key}."
                    ))
                    .with_detail("key", key.as_str()));
                }
                match text {
                    Some(text) => registrations.settings.push((key, text)),
                    None => registrations.dropped_settings.push(key),
                }
            }
            "connector_state" => {
                let source = body.get("source").and_then(Value::as_str);
                let state = body.get("state").and_then(Value::as_object);
                let (Some(source), Some(state)) = (source, state) else {
                    return Err(invalid(format!(
                        "Line {row} of {INSTANCE} holds a connector state with no source or no state object."
                    )));
                };
                registrations
                    .states
                    .push((source.to_string(), state.clone()));
            }
            _ => {
                let held = body.get("source").is_some_and(Value::is_string)
                    && body.get("item_id").is_some_and(Value::is_string)
                    && body.get("waiting").is_some_and(Value::is_boolean)
                    && body.get("record").is_some_and(Value::is_object);
                if !held {
                    return Err(invalid(format!(
                        "Line {row} of {INSTANCE} holds a connector agreement without a source, item_id, waiting and record."
                    )));
                }
            }
        }
        Ok(())
    }

    /// The catalog rows are judged against: the instance's, with the archive's registrations.
    fn begin_rows(&mut self) -> Result<()> {
        let types = types::write::plan_restored(&self.committed, &self.registrations.types)?;
        let edges = edge_types::plan_restored(&self.committed, &self.registrations.edge_types)?;
        let conflicting: Vec<String> = types
            .conflicts
            .iter()
            .chain(&edges.conflicts)
            .cloned()
            .collect();
        if !conflicting.is_empty() {
            return Err(super::conflicting(conflicting));
        }
        let catalog = self
            .committed
            .with_registered(&types.rows(), &edges.rows())?;
        for (type_id, _) in &self.registrations.icons {
            if !catalog.holds(type_id) && !catalog.types.contains(type_id) {
                return Err(damaged_schema(format!(
                    "The archive carries an icon for {type_id}, which neither the archive nor this instance registers."
                )));
            }
        }
        self.catalog = Some(catalog);
        Ok(())
    }

    fn type_index(&mut self, type_id: &str) -> u32 {
        match self.type_names.iter().position(|held| held == type_id) {
            Some(at) => at as u32,
            None => {
                self.type_names.push(type_id.to_string());
                (self.type_names.len() - 1) as u32
            }
        }
    }

    fn item_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let Some(catalog) = &self.catalog else {
            return Ok(());
        };
        checks::item(catalog, self.cap, line, row).map_err(|refused| refused.refusal)?;
        let item = &line["item"];
        let id = item.get("id").and_then(Value::as_str);
        let version = item.get("version").and_then(Value::as_i64).unwrap_or(0);
        if let (Some(held), Some(type_id)) =
            (id.and_then(bits), item.get("type").and_then(Value::as_str))
        {
            let type_index = self.type_index(type_id);
            self.items_held.insert(
                held,
                HeldItem {
                    type_index,
                    line: row,
                    version,
                },
            );
        }
        Ok(())
    }

    fn edge_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let Some(catalog) = &self.catalog else {
            return Ok(());
        };
        let (names, items) = (&self.type_names, &self.items_held);
        let ends = |id: &str| {
            let held = items.get(&bits(id)?)?;
            Some(checks::End {
                type_id: names.get(held.type_index as usize)?.as_str(),
            })
        };
        match checks::edge(catalog, self.cap, line, row, ends) {
            Ok(()) => Ok(()),
            Err(refused) if refused.skip.is_some() => Ok(()),
            Err(refused) => Err(refused.refusal),
        }
    }
}

/// The line with each unpaired surrogate escape read as U+FFFD, so the row it holds can be named.
fn mended(text: &[u8]) -> Vec<u8> {
    let surrogate = |at: usize| -> Option<u16> {
        let hex = text.get(at + 2..at + 6)?;
        let code = u16::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
        (text.get(at..at + 2) == Some(b"\\u") && (0xD800..=0xDFFF).contains(&code)).then_some(code)
    };
    let mut out = Vec::with_capacity(text.len());
    let (mut at, mut in_string) = (0, false);
    while at < text.len() {
        let byte = text[at];
        if !in_string {
            in_string = byte == b'"';
            out.push(byte);
            at += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = false;
                out.push(byte);
                at += 1;
            }
            b'\\' => match surrogate(at) {
                Some(high)
                    if (0xD800..0xDC00).contains(&high)
                        && surrogate(at + 6).is_some_and(|low| low >= 0xDC00) =>
                {
                    out.extend_from_slice(&text[at..at + 12]);
                    at += 12;
                }
                Some(_) => {
                    out.extend_from_slice(b"\\ufffd");
                    at += 6;
                }
                None => {
                    out.extend_from_slice(&text[at..(at + 2).min(text.len())]);
                    at += 2;
                }
            },
            _ => {
                out.push(byte);
                at += 1;
            }
        }
    }
    out
}

/// What row a line holds, by kind and id, where its text reads once mended.
fn named_by(file: LineFile, text: &[u8]) -> Option<(&'static str, String)> {
    let line: Value = serde_json::from_slice(&mended(text)).ok()?;
    let named = |pointer: &str| {
        line.pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match file {
        LineFile::Files => None,
        LineFile::Versions => Some(("Item", named("/item_id")?)),
        LineFile::Items => Some(("Item", named("/item/id")?)),
        LineFile::Edges => Some(("Edge", named("/edge/id")?)),
        LineFile::Rows => Some(("Row", named("/id")?)),
        LineFile::Instance => named("/type/id")
            .or_else(|| named("/edge_type/id"))
            .or_else(|| named("/type_icon/type_id"))
            .map(|id| ("Type", id)),
    }
}

/// Splits decompressed bytes into lines and checks each as it completes.
struct Splitter {
    file: LineFile,
    rows: Rows,
    pending: Vec<u8>,
    failed: Option<Refusal>,
}

impl Splitter {
    fn take(&mut self, line: &[u8]) -> io::Result<()> {
        if line.is_empty() {
            return Ok(());
        }
        self.rows.line(self.file, line).map_err(|refusal| {
            self.failed = Some(refusal);
            io::Error::other("a line was refused")
        })
    }
}

impl Write for Splitter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            if self.pending.is_empty() {
                self.take(&rest[..at])?;
            } else {
                self.pending.extend_from_slice(&rest[..at]);
                let line = std::mem::take(&mut self.pending);
                self.take(&line)?;
            }
            rest = &rest[at + 1..];
        }
        if self.pending.len() + rest.len() > self.rows.line_cap {
            let row = *self.rows.counted(self.file) + 1;
            self.failed = Some(too_long(self.file, row, self.rows.line_cap));
            return Err(io::Error::other("a line is too long"));
        }
        self.pending.extend_from_slice(rest);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

enum Entry {
    None,
    Skip,
    Manifest(Vec<u8>),
    Lines {
        decoder: Box<GzDecoder<Splitter>>,
        spool: BufWriter<File>,
    },
    Blob {
        name: String,
        hash: Option<Hash>,
        mime_type: String,
        arriving: Box<Arriving>,
    },
}

/// The body read so far.
pub struct Intake {
    spool: Spool,
    tar: Reader,
    entry: Entry,
    started: bool,
    seen: BTreeSet<String>,
    stage: usize,
    disorder: Option<String>,
    manifest: Option<Manifest>,
    rows: Option<Rows>,
    spools: [Option<crate::app::blobs::Scratch>; LINE_FILES.len()],
    carried: Vec<(Sealed, String)>,
    blob_entries: u64,
    skipped: Vec<String>,
}

fn not_tar(_: NotTar) -> Refusal {
    invalid("The body is not an archive: it does not read as a tar.")
}

fn not_gzip(file: LineFile) -> Refusal {
    invalid(format!(
        "{} is not a gzip stream, or its compressed stream breaks partway.",
        file.name()
    ))
    .with_detail("entry", file.name())
}

impl Intake {
    /// Opens the line spools at once, so the body is spooled from its first part. `cap` is the
    /// bulk body limit, and `line_cap` the most one line may hold.
    pub fn new(
        spool: Spool,
        committed: Arc<Catalog>,
        cap: usize,
        line_cap: usize,
    ) -> Result<Intake> {
        let mut spools = [None, None, None, None, None, None];
        for held in &mut spools {
            *held = Some(spool.scratch()?);
        }
        Ok(Intake {
            spool,
            tar: Reader::default(),
            entry: Entry::None,
            started: false,
            seen: BTreeSet::new(),
            stage: 0,
            disorder: None,
            manifest: None,
            rows: Some(Rows {
                committed,
                cap,
                line_cap,
                catalog: None,
                registrations: Registrations::default(),
                files: BTreeMap::new(),
                icon_types: HashSet::new(),
                items_held: HashMap::new(),
                type_ids: HashSet::new(),
                edge_type_ids: HashSet::new(),
                setting_keys: HashSet::new(),
                type_names: Vec::new(),
                snapshots: Ids::default(),
                read: [0; LINE_FILES.len()],
                kinds: [0; KINDS.len()],
                last_row: None,
                last_version: None,
            }),
            spools,
            carried: Vec::new(),
            blob_entries: 0,
            skipped: Vec::new(),
        })
    }

    /// Reads one part of the body. It blocks.
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if !bytes.is_empty() {
            self.started = true;
        }
        let mut tar = std::mem::take(&mut self.tar);
        let fed = tar.feed(bytes, |part| self.part(part), not_tar);
        self.tar = tar;
        fed
    }

    fn part(&mut self, part: Part<'_>) -> Result<()> {
        match part {
            Part::Begins { name, .. } => self.begin(name),
            Part::Bytes(bytes) => self.bytes(bytes),
            Part::Ends => self.end(),
            Part::Closed => Ok(()),
        }
    }

    fn out_of_order(&mut self, name: &str) {
        self.disorder.get_or_insert_with(|| name.to_string());
        self.entry = Entry::Skip;
    }

    fn begin(&mut self, name: String) -> Result<()> {
        let tracked = ENTRIES.contains(&name.as_str()) || name.starts_with(BLOBS);
        if tracked && !self.seen.insert(name.clone()) {
            return Err(
                invalid(format!("The archive carries {name} more than once."))
                    .with_detail("entry", name),
            );
        }
        if let Some(rank) = ENTRIES.iter().position(|held| *held == name) {
            if rank != self.stage || self.disorder.is_some() {
                self.out_of_order(&name);
                return Ok(());
            }
            self.stage += 1;
            if rank == 0 {
                self.entry = Entry::Manifest(Vec::new());
                return Ok(());
            }
            let file = LINE_FILES[rank - 1];
            let mut rows = self
                .rows
                .take()
                .ok_or_else(|| Refusal::internal("a restore's row checks were lost"))?;
            if file == LineFile::Items {
                rows.begin_rows()?;
            }
            let scratch = self.spools[file.slot()]
                .as_mut()
                .ok_or_else(|| Refusal::internal("a restore's spool was lost"))?;
            let spool = BufWriter::new(scratch.file().try_clone().map_err(spooled)?);
            self.entry = Entry::Lines {
                decoder: Box::new(GzDecoder::new(Splitter {
                    file,
                    rows,
                    pending: Vec::new(),
                    failed: None,
                })),
                spool,
            };
            return Ok(());
        }
        if let Some(rest) = name.strip_prefix(BLOBS) {
            self.blob_entries += 1;
            let listed = self
                .rows
                .as_ref()
                .and_then(|rows| rows.files.get(rest))
                .filter(|listed| listed.state == State::Carried)
                .and_then(|listed| listed.mime_type.clone());
            match (Hash::parse(rest).ok(), listed) {
                (Some(hash), Some(mime_type)) => {
                    self.entry = Entry::Blob {
                        name: name.clone(),
                        hash: Some(hash),
                        mime_type,
                        arriving: Box::new(self.spool.stage()?),
                    };
                }
                _ => {
                    self.skipped.push(name);
                    self.entry = Entry::Skip;
                }
            }
            return Ok(());
        }
        self.skipped.push(name);
        self.entry = Entry::Skip;
        Ok(())
    }

    fn bytes(&mut self, bytes: &[u8]) -> Result<()> {
        match &mut self.entry {
            Entry::None | Entry::Skip => Ok(()),
            Entry::Manifest(held) => {
                let cap = self.rows.as_ref().map_or(0, |rows| rows.line_cap);
                if held.len() + bytes.len() > cap {
                    return Err(invalid(format!(
                        "{MANIFEST} holds more than {cap} bytes, more than a restore reads."
                    ))
                    .with_detail("entry", MANIFEST));
                }
                held.extend_from_slice(bytes);
                Ok(())
            }
            Entry::Lines { decoder, spool } => {
                self.spool.room(bytes.len() as u64)?;
                spool.write_all(bytes).map_err(spooled)?;
                if decoder.write_all(bytes).is_err() {
                    let file = decoder.get_ref().file;
                    return Err(decoder
                        .get_mut()
                        .failed
                        .take()
                        .unwrap_or_else(|| not_gzip(file)));
                }
                Ok(())
            }
            Entry::Blob { arriving, .. } => arriving.append(&self.spool, bytes),
        }
    }

    fn end(&mut self) -> Result<()> {
        match std::mem::replace(&mut self.entry, Entry::None) {
            Entry::None | Entry::Skip => Ok(()),
            Entry::Manifest(held) => {
                self.manifest = Some(manifest(&held)?);
                Ok(())
            }
            Entry::Lines { decoder, mut spool } => {
                spool.flush().map_err(spooled)?;
                let mut decoder = *decoder;
                if decoder.try_finish().is_err() {
                    let file = decoder.get_ref().file;
                    return Err(decoder
                        .get_mut()
                        .failed
                        .take()
                        .unwrap_or_else(|| not_gzip(file)));
                }
                let mut splitter = decoder
                    .finish()
                    .map_err(|_| Refusal::internal("a line file did not finish"))?;
                let last = std::mem::take(&mut splitter.pending);
                if splitter.take(&last).is_err() {
                    return Err(splitter
                        .failed
                        .take()
                        .unwrap_or_else(|| Refusal::internal("a line was refused")));
                }
                self.rows = Some(splitter.rows);
                Ok(())
            }
            Entry::Blob {
                name,
                hash,
                mime_type,
                arriving,
            } => {
                let sealed = arriving.seal()?;
                if Some(&sealed.hash) == hash.as_ref() {
                    self.carried.push((sealed, mime_type));
                } else {
                    tracing::warn!(entry = %name, "An archive's blob entry does not hash to its name");
                }
                Ok(())
            }
        }
    }

    /// Checks the body read whole, and answers what the restore writes.
    pub fn finish(mut self) -> Result<Received> {
        if !self.started {
            return Err(invalid("The body is empty; send an archive.").with_detail("field", "body"));
        }
        if !self.tar.closed() && !self.tar.between() {
            return Err(invalid("The archive ends partway through an entry."));
        }
        let lacking: Vec<&str> = ENTRIES
            .iter()
            .copied()
            .filter(|name| !self.seen.contains(*name))
            .collect();
        if !lacking.is_empty() {
            return Err(invalid(format!(
                "The archive lacks {}, which every archive carries.",
                lacking.join(", ")
            ))
            .with_detail("entries", lacking));
        }
        if let Some(name) = self.disorder.take() {
            return Err(invalid(format!(
                "The archive carries {name} out of order: an archive holds {} in that order.",
                ENTRIES.join(", ")
            ))
            .with_detail("entry", name));
        }
        let rows = self
            .rows
            .take()
            .ok_or_else(|| Refusal::internal("a restore's row checks were lost"))?;
        let mut manifest = self.manifest.take().unwrap_or_default();
        let held = [
            rows.read[LineFile::Files.slot()],
            rows.read[LineFile::Items.slot()],
            rows.read[LineFile::Versions.slot()],
            rows.read[LineFile::Edges.slot()],
            rows.read[LineFile::Rows.slot()],
        ];
        for (((count, file), lines), counted) in COUNTED.into_iter().zip(held).zip(manifest.counts)
        {
            if lines as u64 != counted {
                return Err(invalid(format!(
                    "{MANIFEST} counts {counted} in {count}, and {file} holds {lines} lines."
                ))
                .with_detail("field", count));
            }
        }
        for (((_, count), lines), counted) in
            KINDS.iter().zip(rows.kinds).zip(manifest.instance_counts)
        {
            if lines != counted {
                return Err(invalid(format!(
                    "{MANIFEST} counts {counted} in {count}, and {INSTANCE} holds {lines} of them."
                ))
                .with_detail("field", *count));
            }
        }
        if self.blob_entries != manifest.blob_count {
            return Err(invalid(format!(
                "{MANIFEST} counts {} in blob_count, and the archive carries {} blobs/ entries.",
                manifest.blob_count, self.blob_entries
            ))
            .with_detail("field", "blob_count"));
        }
        let [
            Some(files),
            Some(instance),
            Some(items),
            Some(versions),
            Some(edges),
            Some(row_lines),
        ] = std::mem::take(&mut self.spools)
        else {
            return Err(Refusal::internal("a restore's spool was lost"));
        };
        manifest.files = rows.files;
        Ok(Received {
            manifest,
            registrations: rows.registrations,
            spools: [files, instance, items, versions, edges, row_lines],
            snapshots: rows.snapshots,
            carried: std::mem::take(&mut self.carried),
            skipped: std::mem::take(&mut self.skipped),
        })
    }
}

fn spooled(error: io::Error) -> Refusal {
    crate::app::blobs::restore::unwritten(error)
}

/// A type that is not printable ASCII becomes no named type, as an upload naming none does.
fn served_type(mime: &str) -> String {
    if !mime.is_empty() && mime.bytes().all(|byte| (0x20..0x7f).contains(&byte)) {
        mime.to_string()
    } else {
        crate::app::blobs::DEFAULT_TYPE.to_string()
    }
}

/// Reads and checks the manifest: an archive of a version this build reads, and its counts.
fn manifest(bytes: &[u8]) -> Result<Manifest> {
    if let Some(pointer) = marfa_rules::json_text::ill_formed_at(bytes) {
        return Err(invalid(format!(
            "{MANIFEST} holds text at {pointer} with a surrogate escape that has no partner."
        ))
        .with_detail("entry", MANIFEST)
        .with_detail("pointer", pointer));
    }
    let Ok(Value::Object(held)) = serde_json::from_slice::<Value>(bytes) else {
        return Err(
            invalid(format!("{MANIFEST} is not a JSON object.")).with_detail("entry", MANIFEST)
        );
    };
    let written_by = held.get("written_by").and_then(Value::as_str);
    let writer = written_by.unwrap_or("a build that does not say");
    match held.get("format") {
        None => {
            return Err(invalid(format!(
                "This archive was written by {writer}, before Marfa 0.1, and this build cannot read it."
            ))
            .with_detail("entry", MANIFEST)
            .with_detail("written_by", written_by));
        }
        Some(format) if format.as_str() != Some(FORMAT) => {
            return Err(invalid(format!(
                "{MANIFEST} names the format {format}, and this build reads only {FORMAT} archives."
            ))
            .with_detail("entry", MANIFEST)
            .with_detail("field", "format"));
        }
        Some(_) => {}
    }
    match held.get("version").and_then(Value::as_u64) {
        Some(version) if version > VERSION => Err(invalid(format!(
            "The archive is at version {version}, written by {writer}; this build reads archives up to version {VERSION}."
        ))
        .with_detail("entry", MANIFEST)
        .with_detail("version", version)
        .with_detail("written_by", written_by)),
        Some(1) => first(&held),
        _ => Err(invalid(format!(
            "{MANIFEST} is missing or mistypes version, a whole number from 1 to {VERSION}."
        ))
        .with_detail("entry", MANIFEST)
        .with_detail(
            "errors",
            json!([{ "path": "version", "message": "Must be a whole number from 1." }]),
        )),
    }
}

/// Reads the counts a manifest of archive version 1 holds.
fn first(held: &Map<String, Value>) -> Result<Manifest> {
    let mut errors = Vec::new();
    let mut wrong =
        |path: String, message: &str| errors.push(json!({ "path": path, "message": message }));
    if !held.get("written_by").is_some_and(Value::is_string) {
        wrong("written_by".into(), "Must be a string.");
    }
    let mut manifest = Manifest::default();
    for (at, (count, _)) in COUNTED.iter().enumerate() {
        match held.get(*count).and_then(Value::as_u64) {
            Some(counted) => manifest.counts[at] = counted,
            None => wrong((*count).into(), "Must be a non-negative integer."),
        }
    }
    for (at, (_, count)) in KINDS.iter().enumerate() {
        match held.get(*count).and_then(Value::as_u64) {
            Some(counted) => manifest.instance_counts[at] = counted,
            None => wrong((*count).into(), "Must be a non-negative integer."),
        }
    }
    match held.get("blob_count").and_then(Value::as_u64) {
        Some(counted) => manifest.blob_count = counted,
        None => wrong("blob_count".into(), "Must be a non-negative integer."),
    }
    if !errors.is_empty() {
        let named: Vec<String> = errors
            .iter()
            .filter_map(|error| error["path"].as_str().map(str::to_string))
            .collect();
        return Err(invalid(format!(
            "{MANIFEST} is missing or mistypes {}.",
            named.join(", ")
        ))
        .with_detail("entry", MANIFEST)
        .with_detail("errors", errors));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unpaired_surrogate_is_mended_and_a_pair_is_kept() {
        let line = br#"{"item":{"id":"a","b":"x\ud83d y","c":"\ud83d\ude00","d":"\\ud83d"}}"#;
        let mended = String::from_utf8(mended(line)).unwrap();
        assert!(mended.contains(r#""x\ufffd y""#), "{mended}");
        assert!(mended.contains(r#""\ud83d\ude00""#), "{mended}");
        assert!(mended.contains(r#""\\ud83d""#), "{mended}");
        assert_eq!(
            named_by(LineFile::Items, line),
            Some(("Item", "a".to_string()))
        );
    }

    const COUNTS: &str = r#""file_count":0,"item_count":0,"version_count":0,"edge_count":0,"row_count":0,"blob_count":0,"type_count":0,"edge_type_count":0,"type_icon_count":0,"source_count":0,"setting_count":0,"connector_state_count":0,"connector_agreement_count":0"#;

    #[test]
    fn a_manifest_with_no_format_is_refused_as_written_before_0_1() {
        let refused = manifest(br#"{"version":1,"written_by":"marfa-server 0.0.70","blobs":{}}"#)
            .unwrap_err();
        assert_eq!(
            refused.message,
            "This archive was written by marfa-server 0.0.70, before Marfa 0.1, and this build cannot read it."
        );
        let refused = manifest(br#"{"version":1}"#).unwrap_err();
        assert!(refused.message.contains("a build that does not say"));
        let other = manifest(br#"{"format":"tar","version":1}"#).unwrap_err();
        assert_eq!(other.details.unwrap()["field"], "format");
    }

    #[test]
    fn a_manifest_at_a_later_version_is_refused_and_one_at_none_is_mistyped() {
        let text = r#"{"format":"marfa-archive","version":2,"written_by":"marfa-server 9.0.0"}"#;
        let refused = manifest(text.as_bytes()).unwrap_err();
        assert!(
            refused.message.contains("up to version 1"),
            "{}",
            refused.message
        );
        let details = refused.details.unwrap();
        assert_eq!(details["version"], 2);
        assert_eq!(details["written_by"], "marfa-server 9.0.0");
        for version in ["0", "1.5", "\"1\"", "null"] {
            let text = format!(r#"{{"format":"marfa-archive","version":{version}}}"#);
            let refused = manifest(text.as_bytes()).unwrap_err();
            assert_eq!(refused.details.unwrap()["errors"][0]["path"], "version");
        }
    }

    #[test]
    fn a_manifest_lacking_a_field_it_relies_on_is_refused_naming_each() {
        let bare = manifest(br#"{"format":"marfa-archive","version":1}"#).unwrap_err();
        let message = bare.message.to_string();
        for field in [
            "written_by",
            "file_count",
            "version_count",
            "setting_count",
            "blob_count",
        ] {
            assert!(message.contains(field), "{message}");
        }
        let whole =
            format!(r#"{{"format":"marfa-archive","version":1,"written_by":"x",{COUNTS}}}"#);
        assert!(manifest(whole.as_bytes()).is_ok());
    }

    #[test]
    fn a_type_no_header_carries_is_kept_as_bytes_of_no_named_type() {
        assert_eq!(served_type("text/plain"), "text/plain");
        assert_eq!(
            served_type("text/caf\u{e9}"),
            crate::app::blobs::DEFAULT_TYPE
        );
        assert_eq!(served_type(""), crate::app::blobs::DEFAULT_TYPE);
    }

    #[test]
    fn ids_hold_lowercase_uuids_and_find_no_other_id() {
        let mut ids = Ids::default();
        assert!(ids.insert("01a1bdba-8640-72ba-b7d6-9e27d94e7540"));
        assert!(!ids.insert("01a1bdba-8640-72ba-b7d6-9e27d94e7540"));
        assert!(ids.contains("01a1bdba-8640-72ba-b7d6-9e27d94e7540"));
        assert!(!ids.contains("not-a-uuid"));
        assert!(!ids.contains("01A1BDBA-8640-72BA-B7D6-9E27D94E7540"));
        assert_eq!(
            ids.each().collect::<Vec<_>>(),
            ["01a1bdba-8640-72ba-b7d6-9e27d94e7540"]
        );
    }
}
