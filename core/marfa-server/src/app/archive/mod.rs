//! Exports: NDJSON lines read a page at a time, and the archive a restore reads, selected in
//! one snapshot and checked with the restore's checks before its first byte.

pub mod checks;
mod lines;
mod send;
mod spool;
mod tar;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io;
use std::sync::Arc;

use bytes::Bytes;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::App;
use super::access::{Caller, Permission};
use super::blobs::carry::{self, Carried, Copy};
use super::blobs::{Hash, references};
use super::faults::{FAIL_EXPORT_READ, HOLD_EXPORT_PAGE};
use super::items::{self, Archived, Reader, reading};
use super::query::{self, Ask};
use super::refusal::{Code, Refusal, Result};
use super::{connectors, edges, sources, stored, webhooks};
use crate::db::io_refusal;
use crate::settings::registry::{self, ADDRESSES, SIGN_IN_ADDRESS};
use spool::{Lines, Spooled};

pub const FORMAT: &str = "marfa-archive-v0";
pub const VERSION: u64 = 0;
const PAGE: i64 = 500;
const EDGE_PAGE: i64 = 1000;
const QUEUED: usize = 4;

/// An export's body: chunks, and an error in place of the end where it was cut short.
pub type Body = mpsc::Receiver<io::Result<Bytes>>;

/// What the items of one segment need of the credential that sends them.
#[derive(Clone, Debug, Default)]
struct ItemNeed {
    /// Each row's type and source.
    rows: BTreeSet<(String, String)>,
    namespaces: BTreeSet<String>,
    /// The types of the snapshots carried, and of the rows a cascade mark names.
    types: BTreeSet<String>,
}

/// The edge types of one segment's edges, each with its source's type.
#[derive(Clone, Debug, Default)]
struct EdgeNeed(BTreeSet<(String, String)>);

/// An archive ready to send: its manifest, its spooled line files, and the blobs it carries
/// with the store each was found whole in.
struct Prepared {
    created_at: String,
    manifest: Vec<u8>,
    instance: Spooled<()>,
    items: Spooled<ItemNeed>,
    edges: Spooled<EdgeNeed>,
    blobs: Vec<(Carried, String)>,
}

/// What the selection's snapshot gave: the line files, the blobs the rows name, and the counts.
struct Selected {
    instance: Spooled<()>,
    items: Spooled<ItemNeed>,
    edges: Spooled<EdgeNeed>,
    counts: Map<String, Value>,
    listed: Vec<Carried>,
    missing: BTreeMap<String, Value>,
}

fn written(error: io::Error) -> Refusal {
    Refusal::internal(&format!("an export's spool was not written: {error}"))
}

fn print(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|_| Refusal::internal("an export line did not print"))
}

fn line_value(line: &str) -> Result<Value> {
    serde_json::from_str(line).map_err(|_| Refusal::internal("an export line did not read back"))
}

/// Whether the credential `read` stands on reads every part of `row` the line shows.
fn reads_row(read: &Reader<'_, '_>, row: &Archived) -> bool {
    let caller = &read.caller;
    caller.may_read_type(&row.type_id)
        && caller.lists(&read.catalog.rules, &row.type_id, &row.source)
        && row
            .namespaces
            .iter()
            .all(|name| caller.may_read_extension(name))
        && row
            .snapshot_types
            .iter()
            .chain(row.mark_type.iter())
            .all(|type_id| caller.may_read_type(type_id))
}

fn unrestorable(refused: &checks::Refused) -> Refusal {
    Refusal::new(
        Code::ExportRowsUnrestorable,
        format!(
            "No archive was sent, because a restore would refuse or skip a row this instance \
             holds: {} Correct the row or its type, then export again.",
            refused.refusal.message
        ),
    )
    .with_detail("row", refused.row())
}

impl App {
    /// Selects, checks and spools the archive, then hands its bytes to a task that sends them.
    /// Every refusal comes before the first byte.
    pub async fn export_archive(
        self: &Arc<App>,
        caller: &Caller,
        ask: Ask,
        files: bool,
    ) -> Result<(Body, String)> {
        let prepared = self.prepare_archive(caller, ask, files).await?;
        let created = prepared.created_at.clone();
        self.audit_export(caller, "archive").await?;
        let (sender, body) = mpsc::channel(QUEUED);
        let (app, caller) = (self.clone(), caller.clone());
        tokio::spawn(async move { send::archive(app, caller, prepared, sender).await });
        Ok((body, created))
    }

    async fn audit_export(&self, caller: &Caller, format: &'static str) -> Result<()> {
        self.write(caller, "export.run", move |unit| {
            unit.audit_set("export", Some(json!({ "format": format })))
        })
        .await
    }

    async fn prepare_archive(&self, caller: &Caller, ask: Ask, files: bool) -> Result<Prepared> {
        let created_at = self.clock.stamp();
        let scratch = [
            self.scratch().await?,
            self.scratch().await?,
            self.scratch().await?,
        ];
        let selected = reading(self, caller, move |read| select(read, &ask, scratch)).await?;
        let copies = if files {
            self.whole_copies(&selected.listed).await?
        } else {
            selected.listed.iter().map(|_| Copy::Missing).collect()
        };
        let mut missing = selected.missing;
        let mut listed = Map::new();
        let mut blobs = Vec::new();
        for (carried, copy) in selected.listed.into_iter().zip(copies) {
            let entry = json!({
                "mime_type": carried.blob.mime_type,
                "size_bytes": carried.blob.size_bytes,
            });
            let hash = carried.blob.hash.as_str().to_string();
            match copy {
                Copy::Whole(store) => {
                    listed.insert(hash, entry);
                    blobs.push((carried, store));
                }
                Copy::Missing => {
                    missing.insert(hash, entry);
                }
            }
        }
        let mut manifest = Map::new();
        manifest.insert("version".into(), VERSION.into());
        manifest.insert("format".into(), FORMAT.into());
        manifest.insert("created_at".into(), created_at.clone().into());
        manifest.insert("instance_id".into(), self.instance_id.clone().into());
        manifest.insert("item_count".into(), selected.items.lines.into());
        manifest.insert("edge_count".into(), selected.edges.lines.into());
        manifest.insert("blob_count".into(), blobs.len().into());
        manifest.extend(selected.counts);
        manifest.insert("blobs".into(), Value::Object(listed));
        manifest.insert(
            "missing_blobs".into(),
            Value::Object(missing.into_iter().collect()),
        );
        reading(self, caller, |_| Ok(())).await?;
        Ok(Prepared {
            created_at,
            manifest: print(&Value::Object(manifest))?.into_bytes(),
            instance: selected.instance,
            items: selected.items,
            edges: selected.edges,
            blobs,
        })
    }
}

/// Reads the whole selection in the one snapshot `read` holds, checking each row as a restore
/// would and writing the line files.
fn select(
    read: &Reader<'_, '_>,
    ask: &Ask,
    [instance, items, edges]: [crate::app::blobs::Scratch; 3],
) -> Result<Selected> {
    let mut items: Lines<ItemNeed> = Lines::new(items).map_err(written)?;
    let mut edges: Lines<EdgeNeed> = Lines::new(edges).map_err(written)?;
    let mut instance: Lines<()> = Lines::new(instance).map_err(written)?;
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
    let mut carried_ids: HashSet<String> = HashSet::new();
    let mut carried_sources: BTreeSet<String> = BTreeSet::new();
    let mut digests: BTreeSet<String> = BTreeSet::new();
    let mut file_refs: BTreeSet<String> = BTreeSet::new();
    let mut selected: Vec<i64> = Vec::new();
    let mut after = 0;
    loop {
        read.faults().hold_blocking(HOLD_EXPORT_PAGE);
        if read.faults().fail(FAIL_EXPORT_READ, None) {
            return Err(io_refusal());
        }
        let seqs = query::selected(read, ask, after, PAGE)?;
        let Some(last) = seqs.last() else {
            break;
        };
        after = *last;
        let rows = items::archived(read.tx, caller, catalog, &read.read_only, &seqs, true)?;
        for row in rows {
            let line = line_value(&row.line)?;
            checks::item(catalog, &line, items.lines as usize + 1)
                .map_err(|refused| unrestorable(&refused))?;
            items
                .push(&row.line, |need| {
                    need.rows.insert((row.type_id.clone(), row.source.clone()));
                    need.namespaces.extend(row.namespaces.iter().cloned());
                    need.types.extend(row.snapshot_types.iter().cloned());
                    need.types.extend(row.mark_type.iter().cloned());
                })
                .map_err(written)?;
            if agreed.contains(row.id.as_str()) {
                carried_ids.insert(row.id.clone());
            }
            carried_sources.insert(row.source);
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
            let line = line_value(&text)?;
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
            checks::edge(catalog, &line, edges.lines as usize + 1, ends)
                .map_err(|refused| unrestorable(&refused))?;
            edges
                .push(&text, |need| {
                    need.0
                        .insert((edge.edge_type.clone(), source.type_id.clone()));
                })
                .map_err(written)?;
            digests.extend(references::digests(&items::parsed(&edge.properties)?));
        }
    }
    let mut listed = Vec::new();
    let mut missing = BTreeMap::new();
    for digest in digests.union(&file_refs) {
        let Ok(hash) = Hash::parse(digest) else {
            continue;
        };
        match carry::carried(read.tx, caller, &hash)? {
            Some(carried) => listed.push(carried),
            None if file_refs.contains(digest) => {
                missing.insert(
                    digest.clone(),
                    json!({ "mime_type": null, "size_bytes": null }),
                );
            }
            None => {}
        }
    }
    let mut counts = Map::new();
    let mut count = |name: &str, lines: &mut Lines<()>, values: Vec<String>| -> Result<()> {
        counts.insert(name.into(), values.len().into());
        for value in values {
            lines.push(&value, |_| ()).map_err(written)?;
        }
        Ok(())
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
            types.push(print(&json!({
                "type": definition,
                "provenance": crate::app::catalog::provenance_json(Some(provenance)),
            }))?);
        }
        if let Some(icon) = catalog.types.icon_of(id) {
            icons.push(print(
                &json!({ "type_icon": { "type_id": id, "icon": icon } }),
            )?);
        }
    }
    count("type_count", &mut instance, types)?;
    let edge_types = catalog
        .edge_types
        .iter()
        .map(|definition| print(&json!({ "edge_type": definition })))
        .collect::<Result<_>>()?;
    count("edge_type_count", &mut instance, edge_types)?;
    count("type_icon_count", &mut instance, icons)?;
    let direct = matches!(caller, Caller::Owner(_) | Caller::Local(_));
    let named = sources::named(read.tx)?
        .into_iter()
        .filter(|named| direct || carried_sources.contains(&named.source))
        .map(|named| {
            print(&json!({ "source": {
                "source": named.source,
                "name": named.name,
                "mark": named.mark,
            } }))
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
            settings.push(print(
                &json!({ "setting": { "key": key, "value": value } }),
            )?);
        }
    }
    count("setting_count", &mut instance, settings)?;
    let documents = states
        .into_iter()
        .map(|(source, state)| {
            print(&json!({ "connector_state": { "source": source, "state": state } }))
        })
        .collect::<Result<_>>()?;
    count("connector_state_count", &mut instance, documents)?;
    let kept = agreements
        .into_iter()
        .filter(|(_, held)| carried_ids.contains(&held.item_id))
        .map(|(source, held)| {
            print(&json!({ "connector_agreement": {
                "source": source,
                "item_id": held.item_id,
                "waiting": held.waiting,
                "record": held.record,
            } }))
        })
        .collect::<Result<_>>()?;
    count("connector_agreement_count", &mut instance, kept)?;
    let hooks = webhooks::archived(read.tx, caller)?
        .into_iter()
        .map(|hook| {
            print(&json!({ "webhook": {
                "id": hook.id,
                "url": hook.url,
                "events": hook.events,
                "type_filter": hook.type_filter,
                "active": hook.active,
            } }))
        })
        .collect::<Result<_>>()?;
    count("webhook_count", &mut instance, hooks)?;
    Ok(Selected {
        instance: instance.finish().map_err(written)?,
        items: items.finish().map_err(written)?,
        edges: edges.finish().map_err(written)?,
        counts,
        listed,
        missing,
    })
}
