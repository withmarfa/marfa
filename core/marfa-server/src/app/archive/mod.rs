//! Exports: NDJSON lines, and the archive a restore reads, selected in one snapshot.

pub mod checks;
mod lines;
pub mod restore;
mod send;
mod spool;
mod tar;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use super::App;
use super::access::{Caller, Permission};
use super::blobs::carry::{self, Carried, Copy};
use super::blobs::{Hash, Room, Scratch, references};
use super::clock::Stamp;
use super::faults::{ARCHIVE_LINE_LANE, FAIL_EXPORT_READ, HOLD_EXPORT_PAGE};
use super::items::{self, Archived, Reader, reading, reading_background};
use super::query::{self, Ask};
use super::refusal::{Code, Refusal, Result};
use super::{backups, connectors, edges, sources, stored, tables};
use crate::db::io_refusal;
use crate::settings::registry::{self, ADDRESSES, SIGN_IN_ADDRESS};
use spool::{Lines, Spooled};

pub const VERSION: u64 = 1;
/// What a manifest names itself, so a reader knows the archive for one before reading its version.
pub const FORMAT: &str = "marfa-archive";
/// The most a manifest, or one line of a line file, may hold.
pub const LINE_CAP: usize = 64 * 1024 * 1024;
/// The entries an archive holds, in the order it holds them, before its `blobs/` entries.
pub const ENTRIES: [&str; 7] = [MANIFEST, FILES, INSTANCE, ITEMS, VERSIONS, EDGES, ROWS];
pub const MANIFEST: &str = "manifest.json";
pub const FILES: &str = "files.ndjson.gz";
pub const INSTANCE: &str = "instance.ndjson.gz";
pub const ITEMS: &str = "items.ndjson.gz";
pub const VERSIONS: &str = "versions.ndjson.gz";
pub const EDGES: &str = "edges.ndjson.gz";
pub const ROWS: &str = "rows.ndjson.gz";
pub const BLOBS: &str = "blobs/";
const PAGE: i64 = 500;
const EDGE_PAGE: i64 = 1000;
const QUEUED: usize = 4;

/// An export's body. It ends cleanly only once the sender has said it finished.
pub struct Body {
    chunks: mpsc::Receiver<Bytes>,
    finished: Option<oneshot::Receiver<()>>,
}

/// The sending task's end of a `Body`.
struct Sender {
    chunks: mpsc::Sender<Bytes>,
    finished: oneshot::Sender<()>,
}

fn channel(queued: usize) -> (Sender, Body) {
    let (chunks, receiver) = mpsc::channel(queued);
    let (finished, told) = oneshot::channel();
    (
        Sender { chunks, finished },
        Body {
            chunks: receiver,
            finished: Some(told),
        },
    )
}

impl Sender {
    fn finish(self) {
        let _ = self.finished.send(());
    }
}

impl Body {
    pub fn poll_chunk(&mut self, context: &mut Context<'_>) -> Poll<Option<io::Result<Bytes>>> {
        if let Some(chunk) = std::task::ready!(self.chunks.poll_recv(context)) {
            return Poll::Ready(Some(Ok(chunk)));
        }
        let Some(finished) = self.finished.as_mut() else {
            return Poll::Ready(None);
        };
        let told = std::task::ready!(Pin::new(finished).poll(context));
        self.finished = None;
        match told {
            Ok(()) => Poll::Ready(None),
            Err(_) => Poll::Ready(Some(Err(io::Error::other("the export ended short")))),
        }
    }
}

/// What the items of one segment need of the credential that sends them.
#[derive(Clone, Debug, Default)]
struct ItemNeed {
    /// Each row's type and source.
    rows: BTreeSet<(String, String)>,
    namespaces: BTreeSet<String>,
    /// The types of the snapshots carried, and of the rows a cascade mark names.
    types: BTreeSet<String>,
}

/// What the instance lines of one segment need of the credential that sends them.
#[derive(Clone, Debug, Default)]
struct InstanceNeed {
    permissions: Vec<Permission>,
    /// For each source a line names, the types of the carried rows behind it.
    sources: BTreeMap<String, BTreeSet<String>>,
    /// The type and source of each row a line names.
    rows: BTreeSet<(String, String)>,
}

impl InstanceNeed {
    fn permission(&mut self, permission: Permission) {
        if !self.permissions.contains(&permission) {
            self.permissions.push(permission);
        }
    }
}

/// The edge types of one segment's edges, each with its source's type.
#[derive(Clone, Debug, Default)]
struct EdgeNeed(BTreeSet<(String, String)>);

/// What the rows of one segment need of the credential that sends them.
#[derive(Clone, Debug, Default)]
struct RowNeed {
    /// Each row's item's type and source.
    hosts: BTreeSet<(String, String)>,
    /// The types of the items the carried values name.
    types: BTreeSet<String>,
    /// Whether a carried value names an item no longer held.
    unheld: bool,
}

struct Prepared {
    created_at: Stamp,
    manifest: Vec<u8>,
    /// `None` for a backup until the files no store gave are known.
    files: Option<Spooled<()>>,
    instance: Spooled<InstanceNeed>,
    items: Spooled<ItemNeed>,
    versions: Spooled<ItemNeed>,
    edges: Spooled<EdgeNeed>,
    rows: Spooled<RowNeed>,
    blobs: Vec<(Carried, String)>,
}

/// One line of `files.ndjson.gz`.
#[derive(serde::Serialize)]
struct FileLine {
    hash: String,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    state: &'static str,
}

const CARRIED: &str = "carried";
const NOT_CARRIED: &str = "not_carried";
const LOST: &str = "lost";

/// A backup read from its snapshot and not yet sent.
pub struct Taken {
    pub created_at: Stamp,
    pub changes: i64,
    /// Each file its rows name that the registry held in its snapshot.
    pub files: Vec<String>,
    /// The files the backup store held a recorded copy of.
    pub in_store: Vec<String>,
    prepared: Prepared,
    /// The lines of `files.ndjson.gz`, in order of hash, before the lost files are known.
    listing: Vec<FileLine>,
    scratch: Scratch,
}

pub struct Backup {
    pub body: Body,
    /// How long the destination has to take it, which also bounds how long its sender waits.
    pub limit: std::time::Duration,
}

impl Taken {
    /// Sends the backup, its `files.ndjson.gz` naming as lost each file in `lost`.
    pub fn send(
        self,
        app: &Arc<App>,
        lost: &[String],
        check: std::time::Duration,
    ) -> Result<Backup> {
        let Taken {
            mut prepared,
            mut listing,
            scratch,
            ..
        } = self;
        let lost: HashSet<&str> = lost.iter().map(String::as_str).collect();
        let mut listed = 0u64;
        for line in &mut listing {
            if lost.contains(line.hash.as_str()) {
                line.state = LOST;
            }
            listed += print(line)?.len() as u64 + 1;
        }
        let entry = |size: u64| tar::BLOCK as u64 + size + tar::padding(size) as u64;
        let size = entry(prepared.manifest.len() as u64)
            + entry(listed + listed / 1000 + 1024)
            + entry(prepared.instance.size)
            + entry(prepared.items.size)
            + entry(prepared.versions.size)
            + entry(prepared.edges.size)
            + entry(prepared.rows.size)
            + tar::END.len() as u64;
        let limit = super::blobs::store::write_deadline(check, size);
        let (sender, body) = channel(QUEUED);
        let (app, room, cap) = (app.clone(), app.room(), app.archive_line_cap());
        tokio::spawn(async move {
            let spooled =
                tokio::task::spawn_blocking(move || spool_files(scratch, room, cap, &listing))
                    .await;
            match spooled {
                Ok(Ok(files)) => {
                    prepared.files = Some(files);
                    send::archive(app, Caller::Server, prepared, sender, limit).await;
                }
                Ok(Err(refusal)) => {
                    tracing::warn!(message = %refusal.message, "A backup's files were not spooled");
                }
                Err(_) => tracing::warn!("A backup's files were not spooled"),
            }
        });
        Ok(Backup { body, limit })
    }
}

/// Writes `files.ndjson.gz`. It blocks.
fn spool_files(
    scratch: Scratch,
    room: Room,
    cap: usize,
    listing: &[FileLine],
) -> Result<Spooled<()>> {
    let mut files: Lines<()> = Lines::new(scratch, room)?;
    for line in listing {
        let text = print(line)?;
        fits(FILES, files.lines + 1, &text, cap)?;
        files.push(&text, |_| ())?;
    }
    files.finish()
}

/// Refuses a line of `entry` that no restore would read; an item's or an edge's names it instead.
fn fits(entry: &str, line: u64, text: &str, cap: usize) -> Result<()> {
    if text.len() > cap {
        return Err(Refusal::internal(&format!(
            "line {line} of {entry} takes {} bytes, more than the {cap} a restore reads, so no \
             archive was written",
            text.len()
        )));
    }
    Ok(())
}

/// What a backup's snapshot gave beside its lines.
struct Snapshot {
    changes: i64,
    /// The files the backup store held a recorded copy of.
    in_store: Vec<String>,
    /// The files the registry held.
    files: Vec<String>,
}

/// What the selection's snapshot gave: the line files, the blobs the rows name, and the counts.
struct Selected {
    instance: Spooled<InstanceNeed>,
    items: Spooled<ItemNeed>,
    versions: Spooled<ItemNeed>,
    edges: Spooled<EdgeNeed>,
    rows: Spooled<RowNeed>,
    counts: Map<String, Value>,
    listed: Vec<Carried>,
    /// The files a carried `blob_ref` names that no blob record holds.
    missing: BTreeSet<String>,
    backup: Option<Snapshot>,
}

/// The build that writes an archive, as its manifest names it.
pub fn writer() -> String {
    format!("marfa-server {}", super::instance::VERSION)
}

fn print(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|_| Refusal::internal("an export line did not print"))
}

fn line_value(line: &str) -> Result<Value> {
    serde_json::from_str(line).map_err(|_| Refusal::internal("an export line did not read back"))
}

/// Whether the credential `read` stands on reads every part of `row` the line shows.
fn reads_row(read: &Reader<'_, '_>, row: &Archived) -> Result<bool> {
    let caller = &read.caller;
    Ok(caller.may_read_type(&row.type_id)
        && caller
            .levers()?
            .lists(&read.catalog.rules, &row.type_id, &row.source)
        && row
            .namespaces
            .iter()
            .all(|name| caller.may_read_extension(name))
        && row
            .mark_type
            .iter()
            .all(|type_id| caller.may_read_type(type_id)))
}

fn unrestorable(refused: &checks::Refused) -> Refusal {
    Refusal::new(
        Code::ExportEntryUnrestorable,
        format!(
            "No archive was sent, because a restore would refuse or skip an item or edge this \
             instance holds: {} Correct it or its type, then export again.",
            refused.refusal.message
        ),
    )
    .with_detail("entry", refused.entry())
}

impl App {
    /// The most one archive line may hold, which the writer and the reader both keep to.
    pub fn archive_line_cap(&self) -> usize {
        self.faults
            .limit(ARCHIVE_LINE_LANE)
            .and_then(|lowered| usize::try_from(lowered).ok())
            .map_or(LINE_CAP, |lowered| lowered.min(LINE_CAP))
    }

    /// Every refusal comes before the first byte.
    pub async fn export_archive(
        self: &Arc<App>,
        caller: &Caller,
        ask: Ask,
        files: bool,
    ) -> Result<(Body, Stamp)> {
        let (prepared, _) = self.prepare_archive(caller, ask, files, None).await?;
        let created = prepared.created_at;
        self.audit_export(caller, "archive").await?;
        let (sender, body) = channel(QUEUED);
        let (app, caller) = (self.clone(), caller.clone());
        let idle = self.blob_read_idle();
        tokio::spawn(async move { send::archive(app, caller, prepared, sender, idle).await });
        Ok((body, created))
    }

    /// Reads a row-only backup from one snapshot; nothing is sent until its lost files are known.
    pub async fn backup_archive(self: &Arc<App>, backup_store: &str) -> Result<Taken> {
        let ask = Ask {
            system: true,
            ..Ask::default()
        };
        let (prepared, snapshot) = self
            .prepare_archive(&Caller::Server, ask, false, Some(backup_store.to_string()))
            .await?;
        let Some((
            Snapshot {
                changes,
                files,
                in_store,
            },
            listing,
            scratch,
        )) = snapshot
        else {
            return Err(Refusal::internal("a backup's snapshot was not kept"));
        };
        Ok(Taken {
            created_at: prepared.created_at,
            changes,
            files,
            in_store,
            prepared,
            listing,
            scratch,
        })
    }

    async fn audit_export(&self, caller: &Caller, format: &'static str) -> Result<()> {
        self.write(caller, "export.run", move |unit| {
            unit.audit_set("export", Some(json!({ "format": format })))
        })
        .await
    }

    async fn prepare_archive(
        &self,
        caller: &Caller,
        ask: Ask,
        files: bool,
        backup_store: Option<String>,
    ) -> Result<(Prepared, Option<(Snapshot, Vec<FileLine>, Scratch)>)> {
        let created_at = self.clock.instant();
        let scratch = [
            self.scratch().await?,
            self.scratch().await?,
            self.scratch().await?,
            self.scratch().await?,
            self.scratch().await?,
        ];
        let files_scratch = self.scratch().await?;
        let room = self.room();
        let caps = Caps {
            bulk: self.bulk_cap(),
            line: self.archive_line_cap(),
        };
        let selected = match backup_store {
            None => {
                reading(self, caller, move |read| {
                    select(read, &ask, scratch, room, caps, None)
                })
                .await?
            }
            Some(backup_store) => {
                reading_background(self, caller, move |read| {
                    select(read, &ask, scratch, room, caps, Some(&backup_store))
                })
                .await?
            }
        };
        let copies = if files {
            self.whole_copies(&selected.listed).await?
        } else {
            selected.listed.iter().map(|_| Copy::Missing).collect()
        };
        let mut listing: BTreeMap<String, FileLine> = selected
            .missing
            .into_iter()
            .map(|hash| {
                let line = FileLine {
                    hash: hash.clone(),
                    mime_type: None,
                    size_bytes: None,
                    state: NOT_CARRIED,
                };
                (hash, line)
            })
            .collect();
        let mut blobs = Vec::new();
        for (carried, copy) in selected.listed.into_iter().zip(copies) {
            let hash = carried.blob.hash.as_str().to_string();
            let state = match copy {
                Copy::Whole(store) => {
                    blobs.push((carried.clone(), store));
                    CARRIED
                }
                Copy::Missing => NOT_CARRIED,
            };
            let line = FileLine {
                hash: hash.clone(),
                mime_type: Some(carried.blob.mime_type.clone()),
                size_bytes: Some(carried.blob.size_bytes),
                state,
            };
            listing.insert(hash, line);
        }
        let mut manifest = Map::new();
        manifest.insert("version".into(), VERSION.into());
        manifest.insert("format".into(), FORMAT.into());
        manifest.insert("written_by".into(), writer().into());
        manifest.insert("created_at".into(), created_at.text().into());
        manifest.insert("instance_id".into(), self.instance_id.clone().into());
        manifest.insert("file_count".into(), listing.len().into());
        manifest.insert("item_count".into(), selected.items.lines.into());
        manifest.insert("version_count".into(), selected.versions.lines.into());
        manifest.insert("edge_count".into(), selected.edges.lines.into());
        manifest.insert("row_count".into(), selected.rows.lines.into());
        manifest.insert("blob_count".into(), blobs.len().into());
        manifest.extend(selected.counts);
        let manifest = print(&Value::Object(manifest))?;
        fits(MANIFEST, 1, &manifest, caps.line)?;
        let listing: Vec<FileLine> = listing.into_values().collect();
        let (files, snapshot) = match selected.backup {
            None => {
                let room = self.room();
                let spooled = tokio::task::spawn_blocking(move || {
                    spool_files(files_scratch, room, caps.line, &listing)
                })
                .await
                .map_err(|_| Refusal::internal("an export's files were not spooled"))??;
                (Some(spooled), None)
            }
            Some(snapshot) => (None, Some((snapshot, listing, files_scratch))),
        };
        reading(self, caller, |_| Ok(())).await?;
        let prepared = Prepared {
            created_at,
            manifest: manifest.into_bytes(),
            files,
            instance: selected.instance,
            items: selected.items,
            versions: selected.versions,
            edges: selected.edges,
            rows: selected.rows,
            blobs,
        };
        Ok((prepared, snapshot))
    }
}

/// The bulk body limit the line checks hold properties to, and the most one line may hold.
#[derive(Clone, Copy)]
struct Caps {
    bulk: usize,
    line: usize,
}

/// Reads the whole selection in one snapshot, checking each row as a restore would.
fn select(
    read: &Reader<'_, '_>,
    ask: &Ask,
    [instance, items, versions, edges, rows]: [Scratch; 5],
    room: Room,
    caps: Caps,
    backup_store: Option<&str>,
) -> Result<Selected> {
    let Caps { bulk: cap, line } = caps;
    let mut items: Lines<ItemNeed> = Lines::new(items, room.clone())?;
    let mut versions: Lines<ItemNeed> = Lines::new(versions, room.clone())?;
    let mut edges: Lines<EdgeNeed> = Lines::new(edges, room.clone())?;
    let mut rows: Lines<RowNeed> = Lines::new(rows, room.clone())?;
    let mut instance: Lines<InstanceNeed> = Lines::new(instance, room)?;
    let caller = &read.caller;
    let catalog = &read.catalog;
    if let Some(type_id) = catalog.unreadable.first() {
        return Err(Refusal::internal(&format!(
            "the stored definition of type {type_id} does not read, so no archive holds it"
        )));
    }
    let manages_connectors = caller.holds(Permission::ConnectorsManage);
    let connectors::Archived { states, agreements } = if manages_connectors {
        connectors::archived(read.tx)?
    } else {
        connectors::Archived::default()
    };
    let agreed: HashSet<&str> = agreements
        .iter()
        .map(|(_, held)| held.item_id.as_str())
        .collect();
    let mut carried_ids: HashMap<String, (String, String)> = HashMap::new();
    let mut carried_sources: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut digests: BTreeSet<String> = BTreeSet::new();
    let mut file_refs: BTreeSet<String> = BTreeSet::new();
    let mut selected: Vec<i64> = Vec::new();
    let mut after = 0;
    loop {
        read.faults().hold_blocking(HOLD_EXPORT_PAGE);
        if read.faults().fail(FAIL_EXPORT_READ, None) {
            return Err(io_refusal());
        }
        let seqs: Vec<i64> = query::selected(read, ask, after, PAGE)?
            .into_iter()
            .map(|chosen| chosen.seq)
            .collect();
        let Some(last) = seqs.last() else {
            break;
        };
        after = *last;
        read.hydrating();
        let held = items::archived(read.tx, caller, catalog, &read.read_only, &seqs, true)?;
        for row in held {
            let value = line_value(&row.line)?;
            checks::item(catalog, cap, &value, items.lines as usize + 1)
                .map_err(|refused| unrestorable(&refused))?;
            if row.line.len() > line {
                let bytes = row.line.len();
                let refused =
                    checks::too_long(checks::Kind::Item, &row.id, &row.type_id, None, bytes, line);
                return Err(unrestorable(&refused));
            }
            items.push(&row.line, |need| {
                need.rows.insert((row.type_id.clone(), row.source.clone()));
                need.namespaces.extend(row.namespaces.iter().cloned());
                need.types.extend(row.mark_type.iter().cloned());
            })?;
            for version in items::versions(read.tx, caller, catalog, &row)? {
                let value = line_value(&version.line)?;
                checks::version(cap, &value, versions.lines as usize + 1)
                    .map_err(|refused| unrestorable(&refused))?;
                if version.line.len() > line {
                    let field = format!("versions.{}", version.version);
                    let refused = checks::too_long(
                        checks::Kind::Item,
                        &row.id,
                        &row.type_id,
                        Some(&field),
                        version.line.len(),
                        line,
                    );
                    return Err(unrestorable(&refused));
                }
                versions.push(&version.line, |need| {
                    need.rows.insert((row.type_id.clone(), row.source.clone()));
                    need.types.insert(version.type_id.clone());
                })?;
                digests.extend(version.digests);
                file_refs.extend(version.file_refs);
            }
            if agreed.contains(row.id.as_str()) {
                carried_ids.insert(row.id.clone(), (row.type_id.clone(), row.source.clone()));
            }
            carried_sources
                .entry(row.source)
                .or_default()
                .insert(row.type_id);
            digests.extend(row.digests);
            file_refs.extend(row.file_refs);
        }
        selected.extend(seqs);
    }
    let mut after = 0;
    loop {
        let page = edges::with_ends(read.tx, after, EDGE_PAGE)?;
        let Some(last) = page.last() else {
            break;
        };
        after = last.edge.seq();
        for edges::Ended {
            edge,
            source,
            target,
            lending,
        } in page
        {
            let both = selected.binary_search(&source.seq).is_ok()
                && selected.binary_search(&target.seq).is_ok();
            if !both || !caller.may_read_edge(&edge.edge_type, &source.type_id) {
                continue;
            }
            let text = format!(
                "{{\"edge\":{},\"lending_blobs\":{}}}",
                edge.answered()?,
                print(&lending)?
            );
            let value = line_value(&text)?;
            let ends = |id: &str| {
                if id == edge.source_id {
                    Some(checks::End {
                        type_id: &source.type_id,
                    })
                } else if id == edge.target_id {
                    Some(checks::End {
                        type_id: &target.type_id,
                    })
                } else {
                    None
                }
            };
            checks::edge(catalog, cap, &value, edges.lines as usize + 1, ends)
                .map_err(|refused| unrestorable(&refused))?;
            if text.len() > line {
                let refused = checks::too_long(
                    checks::Kind::Edge,
                    &edge.id,
                    &edge.edge_type,
                    None,
                    text.len(),
                    line,
                );
                return Err(unrestorable(&refused));
            }
            edges.push(&text, |need| {
                need.0
                    .insert((edge.edge_type.clone(), source.type_id.clone()));
            })?;
            digests.extend(references::digests(&items::parsed(&edge.properties)?));
        }
    }
    tables::archive::archived(
        read,
        |seq| selected.binary_search(&seq).is_ok(),
        |row| {
            checks::row(&row.line, rows.lines as usize + 1).map_err(|refused| {
                Refusal::internal(&format!(
                    "a stored row does not pass a restore's check: {}",
                    refused.refusal.message
                ))
            })?;
            let text = print(&row.line)?;
            fits(ROWS, rows.lines + 1, &text, line)?;
            rows.push(&text, |need| {
                need.hosts.insert(row.host);
                need.types.extend(row.types);
                need.unheld |= row.unheld;
            })
        },
    )?;
    let mut listed = Vec::new();
    let mut missing = BTreeSet::new();
    for digest in digests.union(&file_refs) {
        let Ok(hash) = Hash::parse(digest) else {
            continue;
        };
        match carry::carried(read.tx, caller, &hash)? {
            Some(carried) => listed.push(carried),
            None if file_refs.contains(digest) => {
                missing.insert(digest.clone());
            }
            None => {}
        }
    }
    let mut counts = Map::new();
    let mut count = |name: &str,
                     lines: &mut Lines<InstanceNeed>,
                     values: Vec<(String, InstanceNeed)>|
     -> Result<()> {
        counts.insert(name.into(), values.len().into());
        for (value, need) in values {
            fits(INSTANCE, lines.lines + 1, &value, line)?;
            lines.push(&value, |open| {
                for permission in need.permissions {
                    open.permission(permission);
                }
                for (source, types) in need.sources {
                    open.sources.entry(source).or_default().extend(types);
                }
                open.rows.extend(need.rows);
            })?;
        }
        Ok(())
    };
    let needing = |permission: Option<Permission>| {
        let mut need = InstanceNeed::default();
        need.permissions.extend(permission);
        need
    };
    let mut types = Vec::new();
    let mut icons = Vec::new();
    for id in catalog.types.ids() {
        if let Some(provenance) = catalog
            .provenance
            .get(id)
            .filter(|held| held.origin == "user")
            && let Some(definition) = catalog.types.get(id)
        {
            types.push((
                print(&json!({
                    "type": definition,
                    "provenance": crate::app::catalog::provenance_json(Some(provenance)),
                }))?,
                needing(None),
            ));
        }
        if let Some(icon) = catalog.types.icon_of(id) {
            icons.push((
                print(&json!({ "type_icon": { "type_id": id, "icon": icon } }))?,
                needing(None),
            ));
        }
    }
    count("type_count", &mut instance, types)?;
    let edge_types = catalog
        .edge_types
        .iter()
        .map(|definition| Ok((print(&json!({ "edge_type": definition }))?, needing(None))))
        .collect::<Result<_>>()?;
    count("edge_type_count", &mut instance, edge_types)?;
    count("type_icon_count", &mut instance, icons)?;
    let direct = matches!(caller, Caller::Server);
    let named = sources::named(read.tx)?
        .into_iter()
        .filter(|named| direct || carried_sources.contains_key(&named.source))
        .map(|named| {
            let mut need = needing(None);
            if !direct && let Some(types) = carried_sources.get(&named.source) {
                need.sources.insert(named.source.clone(), types.clone());
            }
            let line = print(&json!({ "source": {
                "source": named.source,
                "name": named.name,
                "mark": named.mark,
            } }))?;
            Ok((line, need))
        })
        .collect::<Result<_>>()?;
    count("source_count", &mut instance, named)?;
    let mut settings = Vec::new();
    if caller.holds(Permission::ConfigManage) {
        for (key, text) in stored::rows(read.tx)? {
            let Some(entry) = registry::entry(&key) else {
                continue;
            };
            if [ADDRESSES.entry.key, SIGN_IN_ADDRESS.entry.key].contains(&entry.key) {
                continue;
            }
            let value = entry.row_json(&text).map_err(|error| {
                Refusal::internal(&format!("the stored setting {key} does not read: {error}"))
            })?;
            settings.push((
                print(&json!({ "setting": { "key": key, "value": value } }))?,
                needing(Some(Permission::ConfigManage)),
            ));
        }
    }
    count("setting_count", &mut instance, settings)?;
    let documents = states
        .into_iter()
        .map(|(source, state)| {
            let line = print(&json!({ "connector_state": { "source": source, "state": state } }))?;
            Ok((line, needing(Some(Permission::ConnectorsManage))))
        })
        .collect::<Result<_>>()?;
    count("connector_state_count", &mut instance, documents)?;
    let kept = agreements
        .into_iter()
        .filter_map(|(source, held)| {
            let row = carried_ids.get(&held.item_id)?.clone();
            Some((source, held, row))
        })
        .map(|(source, held, row)| {
            let line = print(&json!({ "connector_agreement": {
                "source": source,
                "item_id": held.item_id,
                "waiting": held.waiting,
                "record": held.record,
            } }))?;
            let mut need = needing(Some(Permission::ConnectorsManage));
            need.rows.insert(row);
            Ok((line, need))
        })
        .collect::<Result<_>>()?;
    count("connector_agreement_count", &mut instance, kept)?;
    let backup = match backup_store {
        None => None,
        Some(backup_store) => {
            let named = listed
                .iter()
                .map(|carried| carried.blob.hash.as_str().to_string())
                .chain(missing.iter().cloned());
            let mut in_store = crate::app::blobs::held_in(read.tx, backup_store, named)?;
            in_store.sort();
            let files = listed
                .iter()
                .map(|carried| carried.blob.hash.as_str().to_string())
                .collect();
            Some(Snapshot {
                changes: backups::changes(read.tx)?,
                in_store,
                files,
            })
        }
    };
    Ok(Selected {
        instance: instance.finish()?,
        items: items.finish()?,
        versions: versions.finish()?,
        edges: edges.finish()?,
        rows: rows.finish()?,
        counts,
        listed,
        missing,
        backup,
    })
}
