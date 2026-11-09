//! Reads a restore's body as it arrives, on a blocking thread: the manifest first, then the
//! line files, each line checked against the registrations already read and the line files
//! kept in the disk store's `tmp` as received, then the blob entries, staged and hashed.
//! What it keeps in memory is what checks across rows need: ids, never whole files.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::sync::Arc;

use flate2::write::GzDecoder;
use marfa_rules::schema::{Obj, icon_issue};
use serde_json::{Map, Value, json};

use super::untar::{NotTar, Part, Reader};
use crate::app::archive::{FORMAT, VERSION, checks};
use crate::app::blobs::Hash;
use crate::app::blobs::restore::{Arriving, Named, Sealed, Spool};
use crate::app::catalog::Catalog;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::{edge_types, sources, stored, types};

/// The most a manifest, or one line of a line file, may hold.
pub const TEXT_CAP: usize = 64 * 1024 * 1024;
const MANIFEST: &str = "manifest.json";
const INSTANCE: &str = "instance.ndjson.gz";
const ITEMS: &str = "items.ndjson.gz";
const EDGES: &str = "edges.ndjson.gz";
const BLOBS: &str = "blobs/";
const ENTRIES: [&str; 4] = [MANIFEST, INSTANCE, ITEMS, EDGES];

fn invalid(message: impl Into<String>) -> Refusal {
    Refusal::validation(message.into())
}

fn damaged_schema(message: impl Into<String>) -> Refusal {
    Refusal::new(Code::InvalidSchema, message.into())
}

/// Item and snapshot ids, a UUID kept as its 128 bits.
#[derive(Default)]
pub struct Ids {
    uuids: HashSet<u128>,
    other: HashSet<String>,
}

impl Ids {
    fn insert(&mut self, id: &str) -> bool {
        match uuid::Uuid::parse_str(id) {
            Ok(held) if held.hyphenated().to_string() == id => self.uuids.insert(held.as_u128()),
            _ => self.other.insert(id.to_string()),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        match uuid::Uuid::parse_str(id) {
            Ok(held) if held.hyphenated().to_string() == id => self.uuids.contains(&held.as_u128()),
            _ => self.other.contains(id),
        }
    }
}

/// The manifest's blobs, by hash: those carried and those it says the archive lacks.
#[derive(Debug, Default)]
pub struct Manifest {
    pub blobs: BTreeMap<String, (String, u64)>,
    pub missing: BTreeMap<String, (Option<String>, Option<u64>)>,
}

/// What `instance.ndjson.gz` registers and sets, read whole except the agreements, which
/// stay in the spool.
#[derive(Default)]
pub struct Registrations {
    pub types: Vec<types::write::Archived>,
    pub edge_types: Vec<Obj>,
    /// Each type's icon, or `None` for one outside the pinned sets.
    pub icons: Vec<(String, Option<String>)>,
    pub sources: Vec<sources::Archived>,
    pub settings: Vec<(String, String)>,
    pub states: Vec<(String, Map<String, Value>)>,
}

/// A body read to its end and checked, ready for the restore's write.
pub struct Received {
    pub manifest: Manifest,
    pub registrations: Registrations,
    pub spools: [crate::app::blobs::Scratch; 3],
    pub snapshots: Ids,
    pub carried: Vec<(Sealed, String)>,
}

impl Received {
    /// The blobs the manifest names that no entry carried with bytes hashing to the name.
    pub fn absent(&self) -> Vec<Named> {
        let carried: HashSet<&str> = self
            .carried
            .iter()
            .map(|(sealed, _)| sealed.hash.as_str())
            .collect();
        let listed = self
            .manifest
            .blobs
            .iter()
            .map(|(hash, (mime, size))| (hash, Some(mime.clone()), Some(*size)));
        let lacking = self
            .manifest
            .missing
            .iter()
            .map(|(hash, (mime, size))| (hash, mime.clone(), *size));
        let mut seen = HashSet::new();
        listed
            .chain(lacking)
            .filter(|(hash, _, _)| !carried.contains(hash.as_str()) && seen.insert(hash.as_str()))
            .filter_map(|(hash, mime_type, size_bytes)| {
                Some(Named {
                    hash: Hash::parse(hash).ok()?,
                    mime_type,
                    size_bytes,
                })
            })
            .collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LineFile {
    Instance,
    Items,
    Edges,
}

impl LineFile {
    fn name(self) -> &'static str {
        match self {
            LineFile::Instance => INSTANCE,
            LineFile::Items => ITEMS,
            LineFile::Edges => EDGES,
        }
    }

    fn slot(self) -> usize {
        self as usize
    }
}

/// What the line checks carry from one line to the next and from file to file.
struct Rows {
    committed: Arc<Catalog>,
    catalog: Option<Catalog>,
    registrations: Registrations,
    icon_types: HashSet<String>,
    item_types: HashMap<u128, u32>,
    other_items: HashMap<String, u32>,
    type_names: Vec<String>,
    snapshots: Ids,
    items: usize,
    edges: usize,
    instance: usize,
}

fn kind_of(line: &Value) -> Option<&'static str> {
    let object = line.as_object()?;
    [
        "type",
        "edge_type",
        "type_icon",
        "source",
        "setting",
        "connector_state",
        "connector_agreement",
    ]
    .into_iter()
    .find(|kind| object.contains_key(*kind))
}

impl Rows {
    fn line(&mut self, file: LineFile, text: &[u8]) -> Result<()> {
        let row = match file {
            LineFile::Instance => &mut self.instance,
            LineFile::Items => &mut self.items,
            LineFile::Edges => &mut self.edges,
        };
        *row += 1;
        let row = *row;
        if text.len() > TEXT_CAP {
            return Err(invalid(format!(
                "Line {row} of {} holds more than {TEXT_CAP} bytes, more than a restore reads.",
                file.name()
            ))
            .with_detail("entry", file.name()));
        }
        if let Some(pointer) = marfa_rules::json_text::ill_formed_at(text) {
            let named = named_by(file, text);
            let refusal = invalid(format!(
                "{} on line {row} of {} holds text at {pointer} with a surrogate escape that has no partner.",
                named.as_ref().map_or_else(|| "A line".to_string(), |(kind, id)| format!("{kind} {id}")),
                file.name()
            ))
            .with_detail("entry", file.name())
            .with_detail("row", row)
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
                .with_detail("row", row)
        })?;
        match file {
            LineFile::Instance => self.instance_line(&line, row),
            LineFile::Items => self.item_line(&line, row),
            LineFile::Edges => self.edge_line(&line, row),
        }
    }

    fn instance_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let kind = kind_of(line).ok_or_else(|| {
            invalid(format!(
                "Line {row} of {INSTANCE} names none of type, edge_type, type_icon, source, setting, connector_state or connector_agreement."
            ))
        })?;
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
            "setting" => registrations.settings.push(stored::archived(body)?),
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
        match checks::item(catalog, line, row) {
            Ok(()) => {}
            Err(refused) if refused.skip.is_some() => return Ok(()),
            Err(refused) => return Err(refused.refusal),
        }
        let item = &line["item"];
        let id = item.get("id").and_then(Value::as_str);
        if let Some(Value::Array(versions)) = line.get("versions") {
            for (index, snapshot) in versions.iter().enumerate() {
                let held = snapshot
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !self.snapshots.insert(held) {
                    let field = format!("versions.{index}.id");
                    return Err(invalid(format!(
                        "Item {} on line {row} of the archive: {field} must be unique in the archive.",
                        id.unwrap_or("with no id")
                    ))
                    .with_detail("row", row)
                    .with_detail("item_id", id)
                    .with_detail("field", field));
                }
            }
        }
        if let (Some(id), Some(type_id)) = (id, item.get("type").and_then(Value::as_str)) {
            let index = self.type_index(type_id);
            match uuid::Uuid::parse_str(id) {
                Ok(held) => {
                    self.item_types.insert(held.as_u128(), index);
                }
                Err(_) => {
                    self.other_items.insert(id.to_string(), index);
                }
            }
        }
        Ok(())
    }

    fn edge_line(&mut self, line: &Value, row: usize) -> Result<()> {
        let Some(catalog) = &self.catalog else {
            return Ok(());
        };
        let names = &self.type_names;
        let (uuids, other) = (&self.item_types, &self.other_items);
        let ends = |id: &str| {
            let index = match uuid::Uuid::parse_str(id) {
                Ok(held) => uuids.get(&held.as_u128()),
                Err(_) => other.get(id),
            }?;
            Some(checks::End {
                type_id: names.get(*index as usize)?.as_str(),
            })
        };
        match checks::edge(catalog, line, row, ends) {
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
        LineFile::Items => Some(("Item", named("/item/id")?)),
        LineFile::Edges => Some(("Edge", named("/edge/id")?)),
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
        if self.pending.len() + rest.len() > TEXT_CAP {
            let row = match self.file {
                LineFile::Instance => self.rows.instance,
                LineFile::Items => self.rows.items,
                LineFile::Edges => self.rows.edges,
            } + 1;
            self.failed = Some(
                invalid(format!(
                    "Line {row} of {} holds more than {TEXT_CAP} bytes, more than a restore reads.",
                    self.file.name()
                ))
                .with_detail("entry", self.file.name()),
            );
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
    spools: [Option<crate::app::blobs::Scratch>; 3],
    carried: Vec<(Sealed, String)>,
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
    /// Opens the three line spools at once, so the body is spooled from its first part.
    pub fn new(spool: Spool, committed: Arc<Catalog>) -> Result<Intake> {
        let spools = [
            Some(spool.scratch()?),
            Some(spool.scratch()?),
            Some(spool.scratch()?),
        ];
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
                catalog: None,
                registrations: Registrations::default(),
                icon_types: HashSet::new(),
                item_types: HashMap::new(),
                other_items: HashMap::new(),
                type_names: Vec::new(),
                snapshots: Ids::default(),
                items: 0,
                edges: 0,
                instance: 0,
            }),
            spools,
            carried: Vec::new(),
        })
    }

    /// Whether any byte has arrived.
    pub fn started(&self) -> bool {
        self.started
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
            let file = [LineFile::Instance, LineFile::Items, LineFile::Edges][rank - 1];
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
            let listed = self
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.blobs.get(rest))
                .map(|(mime, _)| mime.clone());
            match (Hash::parse(rest).ok(), listed) {
                (Some(hash), Some(mime_type)) => {
                    self.entry = Entry::Blob {
                        name: name.clone(),
                        hash: Some(hash),
                        mime_type,
                        arriving: Box::new(self.spool.stage()?),
                    };
                }
                _ => self.entry = Entry::Skip,
            }
            return Ok(());
        }
        self.entry = Entry::Skip;
        Ok(())
    }

    fn bytes(&mut self, bytes: &[u8]) -> Result<()> {
        match &mut self.entry {
            Entry::None | Entry::Skip => Ok(()),
            Entry::Manifest(held) => {
                if held.len() + bytes.len() > TEXT_CAP {
                    return Err(invalid(format!(
                        "{MANIFEST} holds more than {TEXT_CAP} bytes, more than a restore reads."
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
        let [Some(instance), Some(items), Some(edges)] = std::mem::take(&mut self.spools) else {
            return Err(Refusal::internal("a restore's spool was lost"));
        };
        Ok(Received {
            manifest: self.manifest.take().unwrap_or_default(),
            registrations: rows.registrations,
            spools: [instance, items, edges],
            snapshots: rows.snapshots,
            carried: std::mem::take(&mut self.carried),
        })
    }
}

fn spooled(error: io::Error) -> Refusal {
    crate::app::blobs::restore::unwritten(error)
}

/// A blob's type as a response header can carry it: one that is not printable ASCII is kept
/// as bytes of no named type, as an upload that names none is.
fn served_type(mime: &str) -> String {
    if !mime.is_empty() && mime.bytes().all(|byte| (0x20..0x7f).contains(&byte)) {
        mime.to_string()
    } else {
        crate::app::blobs::DEFAULT_TYPE.to_string()
    }
}

/// Reads and checks the manifest: a version this build reads, and the blobs it names.
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
    if let Some(version) = held
        .get("version")
        .filter(|version| version.is_number() && version.as_u64() != Some(VERSION))
    {
        return Err(invalid(format!(
            "The archive is at version {version}; an archive at a version other than {VERSION} is read only by the build that wrote it."
        )));
    }
    let mut errors = Vec::new();
    let mut wrong =
        |path: String, message: &str| errors.push(json!({ "path": path, "message": message }));
    if held.get("version").and_then(Value::as_u64) != Some(VERSION) {
        wrong("version".into(), "Must be a number.");
    }
    if held.get("format").and_then(Value::as_str) != Some(FORMAT) {
        wrong("format".into(), "Must be marfa-archive-v0.");
    }
    let mut manifest = Manifest::default();
    match held.get("blobs") {
        Some(Value::Object(blobs)) => {
            for (hash, entry) in blobs {
                let mime = entry.get("mime_type").and_then(Value::as_str);
                let size = entry.get("size_bytes").and_then(Value::as_u64);
                if mime.is_none() {
                    wrong(format!("blobs.{hash}.mime_type"), "Must be a string.");
                }
                if size.is_none() {
                    wrong(
                        format!("blobs.{hash}.size_bytes"),
                        "Must be a non-negative integer.",
                    );
                }
                if let (Some(mime), Some(size)) = (mime, size) {
                    manifest
                        .blobs
                        .insert(hash.clone(), (served_type(mime), size));
                }
            }
        }
        _ => wrong("blobs".into(), "Must be an object."),
    }
    match held.get("missing_blobs") {
        None => {}
        Some(Value::Object(lacking)) => {
            for (hash, entry) in lacking {
                let mime = entry.get("mime_type");
                let size = entry.get("size_bytes");
                let mime_ok = mime.is_some_and(|mime| mime.is_null() || mime.is_string());
                let size_ok = size.is_some_and(|size| size.is_null() || size.as_u64().is_some());
                if !mime_ok {
                    wrong(
                        format!("missing_blobs.{hash}.mime_type"),
                        "Must be a string or null.",
                    );
                }
                if !size_ok {
                    wrong(
                        format!("missing_blobs.{hash}.size_bytes"),
                        "Must be a non-negative integer or null.",
                    );
                }
                if mime_ok && size_ok {
                    manifest.missing.insert(
                        hash.clone(),
                        (
                            mime.and_then(Value::as_str).map(served_type),
                            size.and_then(Value::as_u64),
                        ),
                    );
                }
            }
        }
        Some(_) => wrong("missing_blobs".into(), "Must be an object."),
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

    #[test]
    fn a_manifest_at_another_version_is_refused_for_its_version_alone() {
        let refused = manifest(br#"{"version":1,"blobs":[]}"#).unwrap_err();
        assert!(
            refused
                .message
                .contains("read only by the build that wrote it")
        );
        let refused = manifest(br#"{"version":0,"format":"marfa-archive-v0","blobs":{"h":{"mime_type":null,"size_bytes":-1}}}"#).unwrap_err();
        let paths: Vec<String> = refused.details.unwrap()["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| error["path"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(paths, ["blobs.h.mime_type", "blobs.h.size_bytes"]);
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
    fn ids_tell_uuids_and_other_ids_apart_without_keeping_text() {
        let mut ids = Ids::default();
        assert!(ids.insert("01a1bdba-8640-72ba-b7d6-9e27d94e7540"));
        assert!(!ids.insert("01a1bdba-8640-72ba-b7d6-9e27d94e7540"));
        assert!(ids.insert("not-a-uuid"));
        assert!(ids.contains("not-a-uuid"));
        assert!(!ids.contains("01A1BDBA-8640-72BA-B7D6-9E27D94E7540"));
    }
}
