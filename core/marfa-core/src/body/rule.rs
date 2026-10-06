//! A body written through a working copy, read as the edges it names: a
//! `references` edge for each link, and a file item's `attached-to` edge for
//! each embed of a file. A folder reads its own files and keeps its own
//! record, so its sync does not come through here.

use std::cell::OnceCell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use super::embed::{FILE_TYPE, bytes_of, file_like, is_note, joined, read_as};
use super::resolve::{Others, Paths, Resolved, Resolver, is_id, resolve_reference};
use super::text::{self, Embed, Typed};
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::folder::fields;
use crate::model::{Edge, EdgeDraft, Item, Verdict, WriteKind};
use crate::names::{folded, name_of, same};
use crate::{Core, Result, store};

pub(crate) const LINK_EDGE: &str = "references";
pub(crate) const ATTACHMENT_EDGE: &str = "attached-to";
const PLACEMENT_EDGE: &str = "in-folder";

/// The paths a working copy knows items' files by: their placements in
/// folders, which every machine reads alike.
pub(crate) struct Placements;

impl Paths for Placements {
    fn every(&self, conn: &Connection) -> Result<Vec<(String, String)>> {
        let mut statement = conn.prepare(
            "SELECT json_extract(properties, '$.path'), source_id FROM edges
              WHERE edge_type = ?1 AND json_type(properties, '$.path') = 'text'",
        )?;
        let rows = statement.query_map([PLACEMENT_EDGE], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn of(&self, conn: &Connection, id: &str) -> Result<Vec<String>> {
        let mut statement = conn.prepare(
            "SELECT json_extract(properties, '$.path') FROM edges
              WHERE edge_type = ?1 AND source_id = ?2 AND json_type(properties, '$.path') = 'text'
              ORDER BY 1",
        )?;
        let rows = statement.query_map(params![PLACEMENT_EDGE, id], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// What a link or an embed in a body names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BodyTarget {
    /// The item it names: for an embed, the file item with the bytes.
    Item {
        id: String,
    },
    /// Not yet looked up on the server, which a name must be to be known to
    /// name one item alone.
    Pending,
    Missing,
    Ambiguous,
    /// The edge's write, or the server's lookup, was refused.
    Refused {
        reason: String,
    },
}

/// One link or embed, as typed in the body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BodyName {
    /// As it appears in the body: `[[Note|shown]]`, `![[photo.png]]`.
    pub text: String,
    /// What it is read as: before any `|` or `#`, an embed's path or name.
    pub name: String,
    pub target: BodyTarget,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BodyLinks {
    pub links: Vec<BodyName>,
    /// Embeds of files; an embed of a note is text.
    pub embeds: Vec<BodyName>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Link,
    Embed,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Link => "link",
            Kind::Embed => "embed",
        }
    }

    fn parse(text: &str) -> Kind {
        if text == "embed" {
            Kind::Embed
        } else {
            Kind::Link
        }
    }
}

pub(crate) fn body_of<'a>(catalog: &Catalog, item: &'a Item) -> &'a str {
    item.properties
        .get(fields::body_field(catalog, &item.r#type))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A file item and the names an embed may call it by, folded: its title,
/// and the file name of each placement.
struct Candidate {
    id: String,
    paths: Vec<String>,
    names: Vec<String>,
}

fn candidate(conn: &Connection, catalog: &Catalog, item: &Item) -> Result<Candidate> {
    let paths = Placements.of(conn, &item.id)?;
    let mut names: Vec<String> = paths.iter().map(|path| folded(name_of(path))).collect();
    if let Some(title) = item
        .properties
        .get(fields::title_field(catalog, &item.r#type))
        .and_then(Value::as_str)
    {
        names.push(folded(title.trim()));
    }
    Ok(Candidate {
        id: item.id.clone(),
        paths,
        names,
    })
}

/// The file items attached to `host` that the copy holds, outside the bin.
fn attachments(conn: &Connection, catalog: &Catalog, host: &str) -> Result<Vec<Candidate>> {
    let mut found: Vec<Candidate> = Vec::new();
    for edge in store::edges_to(conn, host)? {
        if edge.edge_type != ATTACHMENT_EDGE || found.iter().any(|held| held.id == edge.source_id) {
            continue;
        }
        if let Some(item) = store::item_by_id(conn, &edge.source_id)?
            && bytes_of(&item, catalog).is_some()
        {
            found.push(candidate(conn, catalog, &item)?);
        }
    }
    Ok(found)
}

/// Every file item the copy holds outside the bin.
fn held_files(conn: &Connection, catalog: &Catalog) -> Result<Vec<Candidate>> {
    let ids: Vec<String> = {
        let mut statement =
            conn.prepare("SELECT id, type FROM items WHERE state IN ('active', 'archived')")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(_, r#type)| catalog.matches(FILE_TYPE, r#type))
            .map(|(id, _)| id)
            .collect()
    };
    let mut found = Vec::new();
    for item in store::items_by_ids(conn, &ids)? {
        if bytes_of(&item, catalog).is_some() {
            found.push(candidate(conn, catalog, &item)?);
        }
    }
    Ok(found)
}

enum Pick {
    One(String),
    Many,
    None,
}

/// The candidate an embed names: by a path, the one placed where the path
/// leads from where the host is placed; else, as by a name, the one whose
/// title or file name is the embed's file name, as a folder's pull reads it.
fn pick(candidates: &[Candidate], host_paths: &[String], name: &str, by_name: bool) -> Pick {
    let one = |found: Vec<&Candidate>| match found.as_slice() {
        [] => Pick::None,
        [one] => Pick::One(one.id.clone()),
        _ => Pick::Many,
    };
    if !by_name {
        for host in host_paths {
            if let Some(at) = joined(host, name) {
                let placed: Vec<&Candidate> = candidates
                    .iter()
                    .filter(|held| held.paths.iter().any(|path| same(path, &at)))
                    .collect();
                if !placed.is_empty() {
                    return one(placed);
                }
            }
        }
    }
    let wanted = folded(name_of(name.trim()));
    one(candidates
        .iter()
        .filter(|held| held.names.contains(&wanted))
        .collect())
}

/// How a body's embeds are read against the copy, the held file items
/// loaded only for an embed its attachments do not answer.
struct Embeds<'c> {
    conn: &'c Connection,
    catalog: &'c Catalog,
    host_paths: Vec<String>,
    attachments: Vec<Candidate>,
    files: OnceCell<Vec<Candidate>>,
}

impl<'c> Embeds<'c> {
    fn of(conn: &'c Connection, catalog: &'c Catalog, host: &str) -> Result<Embeds<'c>> {
        Ok(Embeds {
            conn,
            catalog,
            host_paths: Placements.of(conn, host)?,
            attachments: attachments(conn, catalog, host)?,
            files: OnceCell::new(),
        })
    }

    fn files(&self) -> Result<&[Candidate]> {
        if self.files.get().is_none() {
            let _ = self.files.set(held_files(self.conn, self.catalog)?);
        }
        Ok(self.files.get().expect("set above"))
    }

    /// `None` for an embed of a note, which is text. Otherwise the file
    /// item an attachment says, or what the copy alone can say of it.
    fn offline(&self, embed: &Embed) -> Result<Option<(String, Resolved)>> {
        let Some((name, by_name)) = read_as(embed) else {
            return Ok(match embed {
                Embed::Spaced { path, .. } if file_like(path) => {
                    Some((path.clone(), Resolved::Unmatched))
                }
                _ => None,
            });
        };
        if is_note(name) {
            return Ok(None);
        }
        let resolved = match pick(&self.attachments, &self.host_paths, name, by_name) {
            Pick::One(id) => Resolved::Found { id, r#type: None },
            Pick::Many => Resolved::Ambiguous,
            Pick::None => match pick(self.files()?, &self.host_paths, name, by_name) {
                Pick::Many => Resolved::Ambiguous,
                Pick::One(_) => Resolved::Waiting,
                Pick::None if file_like(name) => Resolved::Waiting,
                Pick::None => return Ok(None),
            },
        };
        Ok(Some((name.to_string(), resolved)))
    }
}

/// What a link names, from the copy alone: an edge the item already has to
/// an item it answers to, or a held id. A name that already names an edge's
/// item keeps naming it, so its alias or heading is held only to the other
/// edges; anything else waits for the server, which alone can say a name
/// names one item.
fn link_offline(conn: &Connection, typed: &Typed, references: &Others) -> Result<Resolved> {
    let existing = |text: &str| references.named(conn, text);
    if typed.name.is_empty() {
        return Ok(Resolved::Unmatched);
    }
    if let Some(found) = existing(&typed.name)? {
        let Resolved::Found { id, .. } = &found else {
            return Ok(found);
        };
        if typed.raw != typed.name {
            match existing(&typed.raw)? {
                Some(Resolved::Found { id: whole, .. }) if whole != *id => {
                    return Ok(Resolved::Ambiguous);
                }
                Some(Resolved::Ambiguous) => return Ok(Resolved::Ambiguous),
                _ => {}
            }
        }
        return Ok(found);
    }
    if is_id(&typed.name)
        && let Some(item) = store::item_by_id(conn, &typed.name)?
    {
        return Ok(Resolved::Found {
            id: item.id,
            r#type: Some(item.r#type),
        });
    }
    Ok(Resolved::Waiting)
}

fn references_of(conn: &Connection, host: &str) -> Result<Vec<String>> {
    Ok(store::edges_from(conn, host)?
        .into_iter()
        .filter(|edge| edge.edge_type == LINK_EDGE)
        .map(|edge| edge.target_id)
        .collect())
}

/// The edge of `kind` between the item and `other`, as the copy holds it.
fn held_edges(conn: &Connection, kind: Kind, host: &str, other: &str) -> Result<Vec<Edge>> {
    Ok(match kind {
        Kind::Link => store::edges_from(conn, host)?
            .into_iter()
            .filter(|edge| edge.edge_type == LINK_EDGE && edge.target_id == other)
            .collect(),
        Kind::Embed => store::edges_to(conn, host)?
            .into_iter()
            .filter(|edge| edge.edge_type == ATTACHMENT_EDGE && edge.source_id == other)
            .collect(),
    })
}

fn draft(kind: Kind, host: &str, other: &str) -> EdgeDraft {
    match kind {
        Kind::Link => EdgeDraft {
            source_id: host.to_string(),
            target_id: other.to_string(),
            edge_type: LINK_EDGE.into(),
            ..Default::default()
        },
        Kind::Embed => EdgeDraft {
            source_id: other.to_string(),
            target_id: host.to_string(),
            edge_type: ATTACHMENT_EDGE.into(),
            ..Default::default()
        },
    }
}

/// Where a drain refuses an edge the body made because the body's write lost
/// to another device's: the edge is not the item's, and goes unsent.
const LOST: &str = "the body it was read from was kept as a conflicted copy, not on the item";

/// What the rule records of one link or embed in an item's body: the item it
/// resolved to, or why it names none yet.
#[derive(Debug, Clone)]
struct Row {
    item_id: String,
    kind: Kind,
    text: String,
    state: String,
    other_id: Option<String>,
    reason: Option<String>,
    /// How many items the copy held that the name names when the server
    /// last answered it.
    held: Option<i64>,
    write_id: Option<String>,
}

const ROW_COLUMNS: &str = "item_id, kind, text, state, other_id, reason, held, write_id";

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        item_id: row.get(0)?,
        kind: Kind::parse(&row.get::<_, String>(1)?),
        text: row.get(2)?,
        state: row.get(3)?,
        other_id: row.get(4)?,
        reason: row.get(5)?,
        held: row.get(6)?,
        write_id: row.get(7)?,
    })
}

fn rows_of(conn: &Connection, host: &str) -> Result<Vec<Row>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM body_names WHERE item_id = ?1"
    ))?;
    let rows = statement.query_map([host], row_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn put_row(conn: &Connection, row: &Row) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO body_names ({ROW_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ),
        params![
            row.item_id,
            row.kind.as_str(),
            row.text,
            row.state,
            row.other_id,
            row.reason,
            row.held,
            row.write_id
        ],
    )?;
    Ok(())
}

/// Whether the row still stands as it was read, so a write made meanwhile,
/// which replaces the item's rows, is never written over.
fn unchanged(conn: &Connection, row: &Row) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM body_names WHERE item_id = ?1 AND kind = ?2 AND text = ?3
               AND state = ?4 AND write_id IS ?5",
            params![
                row.item_id,
                row.kind.as_str(),
                row.text,
                row.state,
                row.write_id
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn forget_row(conn: &Connection, row: &Row) -> Result<()> {
    conn.execute(
        "DELETE FROM body_names WHERE item_id = ?1 AND kind = ?2 AND text = ?3",
        params![row.item_id, row.kind.as_str(), row.text],
    )?;
    Ok(())
}

fn state_of(resolved: &Resolved) -> (&'static str, Option<String>) {
    match resolved {
        Resolved::Found { .. } | Resolved::Waiting => ("pending", None),
        Resolved::Unmatched => ("missing", None),
        Resolved::Ambiguous => ("ambiguous", None),
        Resolved::Unanswered(why) => ("unanswered", Some(why.clone())),
    }
}

type Recorded = BTreeMap<(&'static str, String), Row>;

fn recorded(conn: &Connection, host: &str) -> Result<Recorded> {
    Ok(rows_of(conn, host)?
        .into_iter()
        .map(|row| ((row.kind.as_str(), row.text.clone()), row))
        .collect())
}

/// The item a name was resolved to when its edge was made, while that edge
/// stands: renaming the item does not make the body's link name nothing.
fn made_to(
    conn: &Connection,
    recorded: &Recorded,
    kind: Kind,
    host: &str,
    text: &str,
) -> Result<Option<String>> {
    let Some(other) = recorded
        .get(&(kind.as_str(), text.to_string()))
        .filter(|row| row.state == "resolved")
        .and_then(|row| row.other_id.clone())
    else {
        return Ok(None);
    };
    Ok((!held_edges(conn, kind, host, &other)?.is_empty()).then_some(other))
}

/// A body's links and embeds as the copy alone reads them: each resolved
/// one with its item, and each it cannot resolve.
#[derive(Default)]
struct Read {
    found: Vec<(Kind, String, String)>,
    unresolved: Vec<(Kind, String, Resolved)>,
}

impl Read {
    fn targets(&self, kind: Kind) -> Vec<String> {
        let mut targets: Vec<String> = Vec::new();
        for (of, _, other) in &self.found {
            if *of == kind && !targets.contains(other) {
                targets.push(other.clone());
            }
        }
        targets
    }
}

fn read_offline(
    conn: &Connection,
    catalog: &Catalog,
    host: &str,
    body: &str,
    recorded: &Recorded,
) -> Result<Read> {
    let mut read = Read::default();
    if body.is_empty() {
        return Ok(read);
    }
    let references = Others::load(conn, catalog, &Placements, &references_of(conn, host)?)?;
    for raw in text::links(body) {
        let resolved = match link_offline(conn, &Typed::new(&raw), &references)? {
            Resolved::Found { id, .. } => Some(id),
            other => match made_to(conn, recorded, Kind::Link, host, &raw)? {
                Some(id) => Some(id),
                None => {
                    read.unresolved.push((Kind::Link, raw.clone(), other));
                    None
                }
            },
        };
        if let Some(id) = resolved.filter(|id| id != host) {
            read.found.push((Kind::Link, raw, id));
        }
    }
    let embeds = text::embeds(body);
    if !embeds.is_empty() {
        let reader = Embeds::of(conn, catalog, host)?;
        for embed in &embeds {
            let raw = embed.raw().to_string();
            match reader.offline(embed)? {
                None => {}
                Some((_, Resolved::Found { id, .. })) => read.found.push((Kind::Embed, raw, id)),
                Some((_, other)) => match made_to(conn, recorded, Kind::Embed, host, &raw)? {
                    Some(id) => read.found.push((Kind::Embed, raw, id)),
                    None => read.unresolved.push((Kind::Embed, raw, other)),
                },
            }
        }
    }
    Ok(read)
}

fn remember_edge(
    conn: &Connection,
    write: &str,
    host: &str,
    kind: Kind,
    other: &str,
    body_write: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO body_edges (write_id, item_id, kind, other_id, body_write)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![write, host, kind.as_str(), other, body_write],
    )?;
    Ok(())
}

/// Queues what the body `after` holds changes of the edges the body `old`
/// named, each edge write waiting on `write` while it is unanswered, so an
/// edge never lands for a body the server refused.
pub(crate) fn derive(
    conn: &Connection,
    catalog: &Catalog,
    old: &str,
    after: &Item,
    write: &str,
) -> Result<()> {
    let new = body_of(catalog, after);
    if old == new {
        return Ok(());
    }
    let host = after.id.as_str();
    let recorded = recorded(conn, host)?;
    let had = read_offline(conn, catalog, host, old, &recorded)?;
    let now = read_offline(conn, catalog, host, new, &recorded)?;
    let waits: Vec<String> = unanswered(conn, Some(write))?.into_iter().collect();
    for kind in [Kind::Link, Kind::Embed] {
        let (had, now) = (had.targets(kind), now.targets(kind));
        for other in &now {
            if held_edges(conn, kind, host, other)?.is_empty() {
                let queued = crate::queue_edge(conn, &draft(kind, host, other), &waits)?;
                remember_edge(
                    conn,
                    &queued.id,
                    host,
                    kind,
                    other,
                    waits.first().map(String::as_str),
                )?;
            }
        }
        for other in had.iter().filter(|other| !now.contains(other)) {
            for edge in held_edges(conn, kind, host, other)? {
                let queued = crate::queue_edge_delete(conn, &edge, &waits)?;
                remember_edge(
                    conn,
                    &queued.id,
                    host,
                    kind,
                    other,
                    waits.first().map(String::as_str),
                )?;
            }
        }
    }
    release_pins(conn)?;
    conn.execute("DELETE FROM body_names WHERE item_id = ?1", [host])?;
    for (kind, text, other) in &now.found {
        put_row(
            conn,
            &Row {
                item_id: host.to_string(),
                kind: *kind,
                text: text.clone(),
                state: "resolved".into(),
                other_id: Some(other.clone()),
                reason: None,
                held: None,
                write_id: Some(write.to_string()),
            },
        )?;
    }
    for (kind, text, resolved) in &now.unresolved {
        // A name the body carried before keeps what the server said of it,
        // so a dangling link costs no lookup at every save.
        let kept = recorded.get(&(kind.as_str(), text.clone())).filter(|row| {
            matches!(
                row.state.as_str(),
                "missing" | "ambiguous" | "unanswered" | "refused"
            )
        });
        let (state, reason, held) = match kept {
            Some(row) => (row.state.clone(), row.reason.clone(), row.held),
            None => {
                let (state, reason) = state_of(resolved);
                (state.to_string(), reason, None)
            }
        };
        put_row(
            conn,
            &Row {
                item_id: host.to_string(),
                kind: *kind,
                text: text.clone(),
                state,
                other_id: None,
                reason,
                held,
                write_id: Some(write.to_string()),
            },
        )?;
    }
    Ok(())
}

/// Defers reading the body an edit based on an earlier version leaves until
/// its answer: the copy cannot say what such an edit changed of the body,
/// only what the server's row holds once it lands.
pub(crate) fn derive_on_answer(
    conn: &Connection,
    catalog: &Catalog,
    before: &Item,
    write: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO body_checks (write_id, item_id, body) VALUES (?1, ?2, ?3)",
        params![write, before.id, body_of(catalog, before)],
    )?;
    Ok(())
}

/// The write, where it is still to be answered, so what it carries has not
/// landed and an edge made from it waits on it.
fn unanswered(conn: &Connection, write: Option<&str>) -> Result<Option<String>> {
    let Some(write) = write else {
        return Ok(None);
    };
    Ok(store::queued_write(conn, write)?
        .filter(|row| {
            !matches!(
                row.verdict,
                Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted | Verdict::Refused)
            )
        })
        .map(|row| row.id))
}

const RECHECK: &str = "body_recheck";

/// Notes that the copy's rows changed while a name waits that the server
/// answered naming nothing or more than one item, so the next pass counts
/// again what the copy holds of it.
pub(crate) fn rows_changed(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value)
         SELECT ?1, '1' WHERE EXISTS (
           SELECT 1 FROM body_names WHERE state IN ('missing', 'ambiguous'))",
        [RECHECK],
    )?;
    Ok(())
}

/// Whether a body written here carries a name worth asking about now: one
/// the server has not answered, or one it answered where the copy's rows
/// have changed since, which is all a pass asks the server about.
pub(crate) fn waiting(conn: &Connection) -> Result<bool> {
    let recheck = store::meta_get(conn, RECHECK)?.is_some();
    Ok(conn
        .query_row(
            "SELECT 1 FROM body_names
              WHERE state IN ('pending', 'unanswered')
                 OR (?1 AND state IN ('missing', 'ambiguous'))
              LIMIT 1",
            [recheck],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Looks again at every name a body written here carries and no edge says
/// yet: one the server has not been asked about or did not answer, and one
/// it answered naming nothing or more than one item where the copy now holds
/// a different number of items it names. A name the body no longer carries
/// stops waiting. A failure leaves the names to the next pass, which a
/// drain does not wait for.
pub(crate) fn settle(core: &Core, stop: &AtomicBool) -> Result<()> {
    let rows: Vec<Row> = {
        let conn = core.conn()?;
        if store::refuse_unless_usable(&conn).is_err() || !waiting(&conn)? {
            return Ok(());
        }
        let recheck = store::meta_get(&conn, RECHECK)?.is_some();
        // Cleared before the names are counted, so a row that changes while
        // the pass runs is counted at the next.
        store::meta_delete(&conn, RECHECK)?;
        let mut statement = conn.prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM body_names
              WHERE state IN ('pending', 'unanswered')
                 OR (?1 AND state IN ('missing', 'ambiguous'))
              ORDER BY item_id, kind, text"
        ))?;
        let rows = statement.query_map([recheck], row_of)?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let catalog = Catalog::load(&*core.conn()?)?;
    let mut resolver = Resolver::new(core, &catalog, &Placements);
    let mut by_item: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in rows {
        by_item.entry(row.item_id.clone()).or_default().push(row);
    }
    for (host, rows) in by_item {
        let item = core.get(&host)?;
        let Some(item) = item else {
            core.conn()?
                .execute("DELETE FROM body_names WHERE item_id = ?1", [&host])?;
            continue;
        };
        let body = body_of(&catalog, &item).to_string();
        let links = text::links(&body);
        let embeds = text::embeds(&body);
        for row in rows {
            if stop.load(Ordering::Relaxed) {
                rows_changed(&*core.conn()?)?;
                return Ok(());
            }
            let carried = match row.kind {
                Kind::Link => links.contains(&row.text),
                Kind::Embed => embeds.iter().any(|embed| embed.raw() == row.text),
            };
            if !carried {
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                if unchanged(&tx, &row)? {
                    forget_row(&tx, &row)?;
                }
                tx.commit()?;
                continue;
            }
            let asked = match row.kind {
                Kind::Link => link_online(core, &catalog, &mut resolver, &host, &row)?,
                Kind::Embed => {
                    let Some(embed) = embeds.iter().find(|embed| embed.raw() == row.text) else {
                        continue;
                    };
                    embed_online(core, &catalog, &mut resolver, &host, embed, &row)?
                }
            };
            if let Some((resolved, held)) = asked {
                settle_one(core, &row, resolved, held)?;
            }
        }
    }
    Ok(())
}

/// A name the server answered is asked again only where the copy now holds
/// a different number of items it names.
fn worth_asking(row: &Row, held: i64) -> bool {
    !matches!(row.state.as_str(), "missing" | "ambiguous") || row.held != Some(held)
}

fn link_online(
    core: &Core,
    catalog: &Catalog,
    resolver: &mut Resolver<'_>,
    host: &str,
    row: &Row,
) -> Result<Option<(Resolved, i64)>> {
    let typed = Typed::new(&row.text);
    let held = if is_id(&typed.name) {
        i64::from(core.get(&typed.name)?.is_some())
    } else {
        i64::try_from(resolver.held_named(&typed.name)?).unwrap_or(i64::MAX)
    };
    if !worth_asking(row, held) {
        return Ok(None);
    }
    let references = {
        let conn = core.conn()?;
        Others::load(&conn, catalog, &Placements, &references_of(&conn, host)?)?
    };
    let resolved = resolve_reference(&typed, |text| {
        let existing = {
            let conn = core.conn()?;
            references.named(&conn, text)?
        };
        match existing {
            Some(resolved) => Ok(resolved),
            None => resolver.resolve(text),
        }
    })?;
    Ok(Some((resolved, held)))
}

fn embed_online(
    core: &Core,
    catalog: &Catalog,
    resolver: &mut Resolver<'_>,
    host: &str,
    embed: &Embed,
    row: &Row,
) -> Result<Option<(Resolved, i64)>> {
    let (local, name) = {
        let conn = core.conn()?;
        let reader = Embeds::of(&conn, catalog, host)?;
        let Some((name, by_name)) = read_as(embed) else {
            return Ok(None);
        };
        let local = match pick(&reader.attachments, &reader.host_paths, name, by_name) {
            Pick::One(id) => return Ok(Some((Resolved::Found { id, r#type: None }, 1))),
            Pick::Many => return Ok(Some((Resolved::Ambiguous, 2))),
            Pick::None => match pick(reader.files()?, &reader.host_paths, name, by_name) {
                Pick::One(id) => vec![id],
                Pick::Many => return Ok(Some((Resolved::Ambiguous, 2))),
                Pick::None => Vec::new(),
            },
        };
        (local, name.to_string())
    };
    let held = i64::try_from(local.len()).unwrap_or(i64::MAX);
    if !worth_asking(row, held) {
        return Ok(None);
    }
    Ok(Some((
        resolver.file_named(name_of(name.trim()), &local)?,
        held,
    )))
}

fn settle_one(core: &Core, row: &Row, resolved: Resolved, held: i64) -> Result<()> {
    let found = match resolved {
        Resolved::Found { id, .. } => id,
        Resolved::Waiting => return Ok(()),
        other => {
            let (state, reason) = state_of(&other);
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            if unchanged(&tx, row)? {
                put_row(
                    &tx,
                    &Row {
                        state: state.into(),
                        reason,
                        held: Some(held),
                        ..row.clone()
                    },
                )?;
            }
            tx.commit()?;
            return Ok(());
        }
    };
    if found == row.item_id {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        if unchanged(&tx, row)? {
            forget_row(&tx, row)?;
        }
        tx.commit()?;
        return Ok(());
    }
    // Pinned, as a folder pins the other end of a line, so the copy can say
    // what the name names offline; and the file item's own row is where an
    // `attached-to` edge starts, which a copy holds only from a held row.
    if core.get(&found)?.is_none() {
        match core.pin(&found) {
            Ok(false) => {
                core.conn()?.execute(
                    "INSERT OR IGNORE INTO body_pins (item_id) VALUES (?1)",
                    [&found],
                )?;
            }
            Ok(true) => {}
            // Left pending, for the next pass.
            Err(_) => return Ok(()),
        }
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    if unchanged(&tx, row)? {
        if held_edges(&tx, row.kind, &row.item_id, &found)?.is_empty() {
            let waits: Vec<String> = unanswered(&tx, row.write_id.as_deref())?
                .into_iter()
                .collect();
            let queued = crate::queue_edge(&tx, &draft(row.kind, &row.item_id, &found), &waits)?;
            remember_edge(
                &tx,
                &queued.id,
                &row.item_id,
                row.kind,
                &found,
                waits.first().map(String::as_str),
            )?;
        }
        put_row(
            &tx,
            &Row {
                state: "resolved".into(),
                other_id: Some(found),
                reason: None,
                held: None,
                ..row.clone()
            },
        )?;
    }
    release_pins(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Lets go of each row the rule pinned that no `references` edge reaches and
/// no `attached-to` edge leaves, whoever made the edge.
fn release_pins(conn: &Connection) -> Result<()> {
    let pinned: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT item_id FROM body_pins WHERE NOT EXISTS (
               SELECT 1 FROM edges
                WHERE (edge_type = ?1 AND target_id = body_pins.item_id)
                   OR (edge_type = ?2 AND source_id = body_pins.item_id))",
        )?;
        let rows = statement.query_map([LINK_EDGE, ATTACHMENT_EDGE], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for id in pinned {
        conn.execute("DELETE FROM body_pins WHERE item_id = ?1", [&id])?;
        crate::unpin_held(conn, &id)?;
    }
    Ok(())
}

/// Why a body's edge write must not go, where the body's write it was made
/// from came back conflicted on the body: the server kept another body on
/// the item, and this one on a conflicted copy.
pub(crate) fn lost_body(
    conn: &Connection,
    row: &crate::model::QueuedWrite,
) -> Result<Option<String>> {
    let body_write: Option<String> = conn
        .query_row(
            "SELECT body_write FROM body_edges WHERE write_id = ?1",
            [&row.id],
            |found| found.get(0),
        )
        .optional()?
        .flatten();
    let Some(body_write) = body_write else {
        return Ok(None);
    };
    Ok(lost_on_body(conn, &body_write)?.then(|| LOST.to_string()))
}

/// Whether the write came back conflicted on the item's body.
fn lost_on_body(conn: &Connection, write: &str) -> Result<bool> {
    let Some(written) = store::queued_write(conn, write)? else {
        return Ok(false);
    };
    let Some(crate::model::Outcome::Conflicted { fields, .. }) = written.outcome()? else {
        return Ok(false);
    };
    let Some(item) = written
        .item_id
        .as_deref()
        .map(|id| store::item_by_id(conn, id))
        .transpose()?
        .flatten()
    else {
        return Ok(false);
    };
    let catalog = Catalog::load(conn)?;
    let body = fields::body_field(&catalog, &item.r#type);
    Ok(fields.iter().any(|field| field == body))
}

/// Reads back what the queue answered of the writes the rule follows: an
/// edge create refused because the edge exists is done, the edge standing as
/// one, and leaves the queue, as does an edge a lost body made; any other
/// refusal is recorded against the names that asked for the edge; and an
/// edit read on its answer is read now. Run at each drain, before and
/// after its pass, and before answered writes are forgotten, so a pass that
/// stopped part way is read at the next.
pub(crate) fn after_answers(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    let made: Vec<(String, String, String, String)> = {
        let mut statement =
            tx.prepare("SELECT write_id, item_id, kind, other_id FROM body_edges")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (write, host, kind, other) in made {
        let row = store::queued_write(&tx, &write)?;
        let done = match row.as_ref().and_then(|row| row.verdict) {
            None if row.is_none() => true,
            Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => true,
            Some(Verdict::Refused) => {
                let row = row.as_ref().expect("a verdict is a row's");
                let duplicate = row.kind == WriteKind::CreateEdge
                    && row
                        .answer
                        .as_deref()
                        .is_some_and(crate::folder::placement::is_duplicate);
                if duplicate || row.reason.as_deref() == Some(LOST) {
                    // Refused while a write still waits on it, a delete of the
                    // same edge say, it goes once that one is answered.
                    store::discard(&tx, &write)?
                } else {
                    let reason = row
                        .refusal
                        .as_ref()
                        .and_then(|refusal| refusal.message.clone())
                        .or_else(|| row.reason.clone())
                        .unwrap_or_else(|| "refused".into());
                    refuse_names_of(&tx, &host, Kind::parse(&kind), &other, &reason)?;
                    true
                }
            }
            _ => false,
        };
        if done {
            tx.execute("DELETE FROM body_edges WHERE write_id = ?1", [&write])?;
        }
    }
    let checks: Vec<(String, String, String)> = {
        let mut statement = tx.prepare("SELECT write_id, item_id, body FROM body_checks")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let catalog = Catalog::load(&tx)?;
    for (write, host, old) in checks {
        match store::queued_write(&tx, &write)?.and_then(|row| row.verdict) {
            Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => {
                // A body that lost is not the item's, and the one kept is its
                // writer's to read.
                if !lost_on_body(&tx, &write)?
                    && let Some(item) = store::item_by_id(&tx, &host)?
                {
                    let latest = latest_body_write(&tx, &host)?.unwrap_or(write.clone());
                    derive(&tx, &catalog, &old, &item, &latest)?;
                }
            }
            Some(Verdict::Refused) => {}
            None if store::queued_write(&tx, &write)?.is_none() => {}
            _ => continue,
        }
        tx.execute("DELETE FROM body_checks WHERE write_id = ?1", [&write])?;
    }
    release_pins(&tx)?;
    tx.commit()?;
    Ok(())
}

/// The item's newest write that can change its body and is still to be
/// answered, which what the copy shows of the body now waits on.
fn latest_body_write(conn: &Connection, host: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM queue
              WHERE item_id = ?1 AND kind IN (?2, ?3)
                AND (verdict IS NULL OR verdict IN (?4, ?5))
              ORDER BY seq DESC LIMIT 1",
            params![
                host,
                WriteKind::CreateItem.as_str(),
                WriteKind::UpdateItem.as_str(),
                Verdict::Blocked.as_str(),
                Verdict::Dead.as_str()
            ],
            |row| row.get(0),
        )
        .optional()?)
}

/// Every name in the host's body that reads as `other` takes the refusal of
/// the edge it asked for.
fn refuse_names_of(
    conn: &Connection,
    host: &str,
    kind: Kind,
    other: &str,
    reason: &str,
) -> Result<()> {
    for row in rows_of(conn, host)? {
        if row.kind == kind && row.other_id.as_deref() == Some(other) {
            put_row(
                conn,
                &Row {
                    state: "refused".into(),
                    other_id: None,
                    reason: Some(reason.to_string()),
                    ..row
                },
            )?;
        }
    }
    Ok(())
}

/// Each link and embed of a file in an item's body, with the item it names
/// or why it names none, from the copy alone.
pub(crate) fn read(conn: &Connection, id: &str) -> Result<BodyLinks> {
    let Some(item) = store::item_by_id(conn, id)? else {
        return Err(CoreError::NotFound {
            code: "item_not_found".into(),
            message: format!("{id} is not a row this copy holds"),
        });
    };
    let catalog = Catalog::load(conn)?;
    let body = body_of(&catalog, &item);
    let mut links = BodyLinks::default();
    if body.is_empty() {
        return Ok(links);
    }
    let recorded = recorded(conn, id)?;
    let target = |kind: Kind, text: &str, resolved: Resolved| -> Result<BodyTarget> {
        let row = recorded.get(&(kind.as_str(), text.to_string()));
        // An edge the server refused leaves the copy as it was, so only the
        // record says the name names nothing yet.
        if let Some(row) = row.filter(|row| row.state == "refused") {
            return Ok(target_of(&row.state, row.reason.clone()));
        }
        if let Resolved::Found { id, .. } = resolved {
            return Ok(BodyTarget::Item { id });
        }
        if let Some(other) = made_to(conn, &recorded, kind, &item.id, text)? {
            return Ok(BodyTarget::Item { id: other });
        }
        Ok(match row {
            Some(row) => target_of(&row.state, row.reason.clone()),
            None => match resolved {
                Resolved::Ambiguous => BodyTarget::Ambiguous,
                Resolved::Unmatched => BodyTarget::Missing,
                _ => BodyTarget::Pending,
            },
        })
    };
    let references = Others::load(conn, &catalog, &Placements, &references_of(conn, id)?)?;
    for raw in text::links(body) {
        let typed = Typed::new(&raw);
        let resolved = link_offline(conn, &typed, &references)?;
        links.links.push(BodyName {
            text: text::render_link(&raw),
            target: target(Kind::Link, &raw, resolved)?,
            name: typed.name,
        });
    }
    let reader = Embeds::of(conn, &catalog, id)?;
    for embed in text::embeds(body) {
        let Some((name, resolved)) = reader.offline(&embed)? else {
            continue;
        };
        links.embeds.push(BodyName {
            text: embed.raw().to_string(),
            target: target(Kind::Embed, embed.raw(), resolved)?,
            name,
        });
    }
    Ok(links)
}

fn target_of(state: &str, reason: Option<String>) -> BodyTarget {
    match state {
        "missing" => BodyTarget::Missing,
        "ambiguous" => BodyTarget::Ambiguous,
        "refused" | "unanswered" => BodyTarget::Refused {
            reason: reason.unwrap_or_else(|| "refused".into()),
        },
        _ => BodyTarget::Pending,
    }
}

/// A title an embed by name can carry: Obsidian takes what comes before a
/// `|` or a `#` as the name, and a name with a document's extension is a
/// note's, shown as text.
fn embeddable(title: &str) -> bool {
    let title = title.trim();
    !title.is_empty() && !title.contains(['[', ']', '|', '#', '^', '\n', '\r']) && !is_note(title)
}

/// The text that embeds `file`, an attachment of `host`, in `host`'s body:
/// `![[title]]`, where that names it alone among the host's attachments,
/// which an embed is read against first.
pub(crate) fn embed_text(conn: &Connection, host: &str, file: &str) -> Result<String> {
    let catalog = Catalog::load(conn)?;
    if store::item_by_id(conn, host)?.is_none() {
        return Err(CoreError::NotFound {
            code: "item_not_found".into(),
            message: format!("{host} is not a row this copy holds"),
        });
    }
    let Some(item) = store::item_by_id(conn, file)? else {
        return Err(CoreError::NotFound {
            code: "item_not_found".into(),
            message: format!("{file} is not a row this copy holds"),
        });
    };
    if bytes_of(&item, &catalog).is_none() {
        return Err(CoreError::Invalid(format!(
            "{file} is not a file item, so there are no bytes to embed; link to it as [[{file}]] instead"
        )));
    }
    let reader = Embeds::of(conn, &catalog, host)?;
    if !reader.attachments.iter().any(|held| held.id == file) {
        return Err(CoreError::Invalid(format!(
            "{file} is not attached to {host}; attach it first, so its embed names it among the item's attachments"
        )));
    }
    let title = item
        .properties
        .get(fields::title_field(&catalog, &item.r#type))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !embeddable(&title) {
        return Err(CoreError::Invalid(format!(
            "{file} is titled {title:?}, which an embed cannot name: give it a title with no [ ] | # or ^ that is not a note's name"
        )));
    }
    match pick(&reader.attachments, &[], &title, true) {
        Pick::One(id) if id == file => Ok(format!("![[{title}]]")),
        _ => Err(CoreError::Invalid(format!(
            "another attachment of {host} is also called {title:?}, so ![[{title}]] would not name {file} alone; give it a title of its own"
        ))),
    }
}

/// `title`, or the first of `stem 2.ext`, `stem 3.ext` that no attachment of
/// `host` is called, so an embed of it names it alone.
pub(crate) fn unique_title(
    conn: &Connection,
    catalog: &Catalog,
    host: &str,
    title: &str,
) -> Result<String> {
    let taken: Vec<String> = attachments(conn, catalog, host)?
        .into_iter()
        .flat_map(|held| held.names)
        .collect();
    if !taken.contains(&folded(title)) {
        return Ok(title.to_string());
    }
    let (stem, extension) = match title.rfind('.') {
        Some(at) if at > 0 => title.split_at(at),
        _ => (title, ""),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem} {n}{extension}");
        if !taken.contains(&folded(&candidate)) {
            return Ok(candidate);
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Attachment, Draft, Edit};

    fn copy(dir: &tempfile::TempDir) -> Core {
        Core::open(dir.path().join("copy.db"), None).unwrap()
    }

    fn props(value: Value) -> serde_json::Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn note(core: &Core, title: &str, body: &str) -> String {
        core.create_item(&Draft {
            r#type: "core.note".into(),
            properties: props(serde_json::json!({ "title": title, "body": body })),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap()
    }

    fn edit(core: &Core, id: &str, properties: Value) -> crate::model::QueuedWrite {
        let version = core.get(id).unwrap().unwrap().version;
        core.update_item(
            id,
            &Edit {
                properties: props(properties),
                base_version: Some(version),
                ..Default::default()
            },
        )
        .unwrap()
    }

    /// The edge writes queued, as kind, source, target and type.
    fn edge_writes(core: &Core) -> Vec<(WriteKind, String, String)> {
        core.queue()
            .unwrap()
            .into_iter()
            .filter(|row| matches!(row.kind, WriteKind::CreateEdge | WriteKind::DeleteEdge))
            .map(|row| {
                (
                    row.kind,
                    row.item_id.unwrap_or_default(),
                    row.target_id.unwrap_or_default(),
                )
            })
            .collect()
    }

    fn targets(names: &[BodyName]) -> Vec<BodyTarget> {
        names.iter().map(|name| name.target.clone()).collect()
    }

    #[test]
    fn a_link_by_id_is_a_references_edge_that_waits_on_the_write() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let created = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: props(serde_json::json!({
                    "title": "Host", "body": format!("see [[{target}]] and [[{target}|again]]")
                })),
                ..Default::default()
            })
            .unwrap();
        let host = created.item_id.clone().unwrap();
        let edge = core
            .queue()
            .unwrap()
            .into_iter()
            .find(|row| row.kind == WriteKind::CreateEdge)
            .expect("the link queued no edge");
        assert_eq!(edge.item_id.as_deref(), Some(host.as_str()));
        assert_eq!(edge.target_id.as_deref(), Some(target.as_str()));
        assert!(edge.depends_on.contains(&created.id));
        assert_eq!(edge_writes(&core).len(), 1, "one target is one edge");
        let held = core.edges_from(&host).unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].edge_type, LINK_EDGE);
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![
                BodyTarget::Item { id: target.clone() },
                BodyTarget::Item { id: target },
            ]
        );
    }

    #[test]
    fn a_link_by_title_waits_for_the_server_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        note(&core, "Target", "");
        let host = note(&core, "Host", "[[Target]] and [[Nobody]]");
        assert!(edge_writes(&core).is_empty());
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Pending, BodyTarget::Pending]
        );
        assert_eq!(
            core.get(&host).unwrap().unwrap().properties["body"],
            "[[Target]] and [[Nobody]]",
            "the body is saved as typed"
        );
        // With no server to ask, a settle changes nothing.
        settle(&core, &AtomicBool::new(false)).unwrap();
        assert!(edge_writes(&core).is_empty());
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Pending, BodyTarget::Pending]
        );
    }

    #[test]
    fn an_edit_that_leaves_the_body_queues_no_edge_write() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let host = note(&core, "Host", &format!("[[{target}]]"));
        assert_eq!(edge_writes(&core).len(), 1);
        edit(&core, &host, serde_json::json!({ "title": "Renamed" }));
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{target}]]") }),
        );
        assert_eq!(
            edge_writes(&core).len(),
            1,
            "an unchanged body churned edges"
        );
    }

    #[test]
    fn taking_a_link_out_deletes_its_edge_and_no_other() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let gone = note(&core, "Gone", "");
        let kept = note(&core, "Kept", "");
        let elsewhere = note(&core, "Elsewhere", "");
        let host = note(&core, "Host", &format!("[[{gone}]] [[{kept}]]"));
        for (target, edge_type) in [(&gone, "about"), (&elsewhere, LINK_EDGE)] {
            core.create_edge(&EdgeDraft {
                source_id: host.clone(),
                target_id: target.clone(),
                edge_type: edge_type.into(),
                ..Default::default()
            })
            .unwrap();
        }
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("only [[{kept}]]") }),
        );
        let deletes: Vec<_> = edge_writes(&core)
            .into_iter()
            .filter(|(kind, ..)| *kind == WriteKind::DeleteEdge)
            .collect();
        assert_eq!(
            deletes,
            vec![(WriteKind::DeleteEdge, host.clone(), gone.clone())]
        );
        let mut left: Vec<(String, String)> = core
            .edges_from(&host)
            .unwrap()
            .into_iter()
            .map(|edge| (edge.edge_type, edge.target_id))
            .collect();
        left.sort();
        let mut expected = vec![
            ("about".to_string(), gone),
            (LINK_EDGE.to_string(), kept),
            (LINK_EDGE.to_string(), elsewhere),
        ];
        expected.sort();
        assert_eq!(left, expected);
    }

    #[test]
    fn a_link_in_code_or_a_comment_or_to_itself_is_no_edge() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let host = note(
            &core,
            "Host",
            &format!(
                "`[[{target}]]`\n```\n[[{target}]]\n```\n%% [[{target}]] %%\n<!-- [[{target}]] -->"
            ),
        );
        assert!(edge_writes(&core).is_empty());
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{host}]]") }),
        );
        assert!(
            edge_writes(&core).is_empty(),
            "a link to itself made an edge"
        );
    }

    #[test]
    fn a_retype_reads_the_body_where_the_new_type_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let host = note(&core, "Host", &format!("[[{target}]]"));
        let version = core.get(&host).unwrap().unwrap().version;
        core.update_item(
            &host,
            &Edit {
                properties: props(serde_json::json!({
                    "title": "Host", "description": format!("[[{target}]]")
                })),
                base_version: Some(version),
                r#type: Some("core.event".into()),
                replace_properties: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            edge_writes(&core).len(),
            1,
            "a body moved by a retype churned its edge"
        );
        edit(
            &core,
            &host,
            serde_json::json!({ "description": "no link" }),
        );
        assert_eq!(
            edge_writes(&core).last().map(|write| write.0),
            Some(WriteKind::DeleteEdge),
            "the event's description is its body"
        );
    }

    #[test]
    fn a_renamed_item_s_link_still_takes_its_edge_when_taken_out() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let plan = note(&core, "Plan", "");
        let host = note(&core, "Host", "");
        core.create_edge(&EdgeDraft {
            source_id: host.clone(),
            target_id: plan.clone(),
            edge_type: LINK_EDGE.into(),
            ..Default::default()
        })
        .unwrap();
        edit(&core, &host, serde_json::json!({ "body": "see [[Plan]]" }));
        edit(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: plan.clone() }],
            "a rename made a link with an edge read as naming nothing"
        );
        edit(&core, &host, serde_json::json!({ "body": "no link" }));
        assert_eq!(
            edge_writes(&core).pop(),
            Some((WriteKind::DeleteEdge, host, plan)),
            "taking out a link to a renamed item left its edge"
        );
    }

    #[test]
    fn an_edit_based_on_an_earlier_version_is_read_once_it_is_answered() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let host = note(&core, "Host", "");
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{target}]]") }),
        );
        let writes = edge_writes(&core).len();
        let version = core.get(&host).unwrap().unwrap().version;
        assert_eq!(version, 0, "a create not yet answered holds version 0");
        // An edit naming an earlier version than the copy holds stands for one
        // made in an editor opened before the copy caught up.
        {
            let conn = core.conn().unwrap();
            conn.execute("UPDATE items SET version = 2 WHERE id = ?1", [&host])
                .unwrap();
        }
        let queued = core
            .update_item_as_read(
                &host,
                &Edit {
                    properties: props(serde_json::json!({ "body": "" })),
                    base_version: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            edge_writes(&core).len(),
            writes,
            "an edit the server merges was read against the copy's newer body"
        );
        let deferred: i64 = core
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM body_checks WHERE write_id = ?1",
                [&queued.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deferred, 1);
    }

    #[test]
    fn an_edit_read_on_its_answer_takes_out_only_what_the_landed_body_drops() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let kept = note(&core, "Kept", "");
        let dropped = note(&core, "Dropped", "");
        let host = note(&core, "Host", &format!("[[{kept}]] [[{dropped}]]"));
        let write = edit(&core, &host, serde_json::json!({ "title": "Host" }));
        {
            let conn = core.conn().unwrap();
            let before = store::item_by_id(&conn, &host).unwrap().unwrap();
            derive_on_answer(&conn, &Catalog::load(&conn).unwrap(), &before, &write.id).unwrap();
            // The server took the edit, and its row keeps one link of the two.
            conn.execute(
                "UPDATE queue SET verdict = 'accepted' WHERE id = ?1",
                [&write.id],
            )
            .unwrap();
            conn.execute(
                "UPDATE items SET properties = json_set(properties, '$.body', ?2) WHERE id = ?1",
                params![host, format!("[[{kept}]]")],
            )
            .unwrap();
        }
        after_answers(&mut core.conn().unwrap()).unwrap();
        let deletes: Vec<_> = edge_writes(&core)
            .into_iter()
            .filter(|(kind, ..)| *kind == WriteKind::DeleteEdge)
            .collect();
        assert_eq!(deletes, vec![(WriteKind::DeleteEdge, host, dropped)]);
        let left: i64 = core
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM body_checks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0, "an answered edit stayed to be read");
    }

    #[test]
    fn a_drain_with_only_answered_names_asks_no_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        let host = {
            let core = copy(&dir);
            note(&core, "Host", "[[Nobody]]")
        };
        let server = crate::scripted::Scripted::start();
        let core = Core::open(
            &path,
            Some(crate::Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            conn.execute("DELETE FROM queue", []).unwrap();
            conn.execute(
                "UPDATE body_names SET state = 'missing', held = 0 WHERE item_id = ?1",
                [&host],
            )
            .unwrap();
            store::meta_delete(&conn, RECHECK).unwrap();
            // A drain talks to a server only under a hydration's read view.
            store::meta_set(&conn, store::META_EVENT_CURSOR, "1").unwrap();
            store::meta_set(&conn, crate::read_view::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        let asked = || server.seen("/").len() + server.seen("/items").len();
        core.drain().unwrap();
        assert_eq!(
            asked(),
            0,
            "a name the server answered sent an empty pass to the server"
        );
        core.conn()
            .unwrap()
            .execute("UPDATE body_names SET state = 'pending'", [])
            .unwrap();
        core.drain().unwrap();
        assert!(
            asked() > 0,
            "a name never asked about did not reach for the server, so the pass above proves nothing"
        );
    }

    #[test]
    fn a_folder_reads_its_own_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        core.write_create(
            &Draft {
                r#type: "core.note".into(),
                properties: props(
                    serde_json::json!({ "title": "File", "body": format!("[[{target}]]") }),
                ),
                ..Default::default()
            },
            crate::Body::Folder,
        )
        .unwrap();
        assert!(edge_writes(&core).is_empty());
    }

    #[test]
    fn an_attached_file_embeds_by_the_text_the_attach_answers() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "");
        let photo = dir.path().join("photo.png");
        std::fs::write(&photo, b"not really a png").unwrap();
        let first = core.attach(&host, &photo, &Attachment::default()).unwrap();
        assert_eq!(first.embed.as_deref(), Some("![[photo.png]]"));
        let second = core.attach(&host, &photo, &Attachment::default()).unwrap();
        assert_eq!(
            second.embed.as_deref(),
            Some("![[photo 2.png]]"),
            "a second file under one name would make its embed name two"
        );
        let given = core
            .attach(
                &host,
                &photo,
                &Attachment {
                    title: Some("photo.png".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(given.embed, None, "a title the caller chose was changed");
        let files: Vec<String> = [&first, &second]
            .iter()
            .map(|attached| attached.item.item_id.clone().unwrap())
            .collect();
        let before = edge_writes(&core).len();
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![[photo 2.png]] and ![](photo%202.png)" }),
        );
        assert_eq!(
            edge_writes(&core).len(),
            before,
            "the embed made a second edge"
        );
        let embeds = core.body_links(&host).unwrap().embeds;
        assert_eq!(
            targets(&embeds),
            vec![
                BodyTarget::Item {
                    id: files[1].clone()
                },
                BodyTarget::Item {
                    id: files[1].clone()
                },
            ]
        );
        edit(&core, &host, serde_json::json!({ "body": "text alone" }));
        let deleted = edge_writes(&core).pop().unwrap();
        assert_eq!(
            deleted,
            (WriteKind::DeleteEdge, files[1].clone(), host.clone()),
            "taking the embed out left its edge"
        );
        assert!(
            core.edges_to(&host)
                .unwrap()
                .iter()
                .any(|edge| edge.source_id == files[0]),
            "an attachment no body embedded was removed"
        );
    }

    #[test]
    fn an_embed_of_a_note_is_text_and_one_of_an_unknown_file_waits() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(
            &core,
            "Host",
            "![[A note]] ![[plan.md]] ![[clip.mp4]] ![](raw x.png)",
        );
        let embeds = core.body_links(&host).unwrap().embeds;
        let read: Vec<(&str, BodyTarget)> = embeds
            .iter()
            .map(|embed| (embed.text.as_str(), embed.target.clone()))
            .collect();
        assert_eq!(
            read,
            vec![
                ("![[clip.mp4]]", BodyTarget::Pending),
                ("![](raw x.png)", BodyTarget::Missing),
            ]
        );
    }

    #[test]
    fn an_embed_text_names_its_file_alone_or_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "");
        let file = dir.path().join("scan.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let attached = core.attach(&host, &file, &Attachment::default()).unwrap();
        let id = attached.item.item_id.unwrap();
        assert_eq!(core.embed_text(&host, &id).unwrap(), "![[scan.pdf]]");
        assert!(
            core.embed_text(&host, &host).is_err(),
            "a note is no file to embed"
        );
    }

    #[test]
    fn a_path_reads_from_where_the_host_is_placed_and_else_by_its_name() {
        let held = |id: &str, paths: &[&str], title: &str| Candidate {
            id: id.into(),
            paths: paths.iter().map(|path| path.to_string()).collect(),
            names: paths
                .iter()
                .map(|path| folded(name_of(path)))
                .chain([folded(title)])
                .collect(),
        };
        let files = [
            held("a", &["notes/img/pic.png"], "pic.png"),
            held("b", &["other/pic.png"], "pic.png"),
        ];
        let host = ["notes/day.md".to_string()];
        assert!(matches!(pick(&files, &host, "img/pic.png", false), Pick::One(id) if id == "a"));
        assert!(
            matches!(pick(&files, &host, "../other/pic.png", false), Pick::One(id) if id == "b")
        );
        assert!(matches!(
            pick(&files, &[], "img/pic.png", false),
            Pick::Many
        ));
        assert!(matches!(pick(&files, &host, "PIC.png", true), Pick::Many));
        assert!(matches!(pick(&files[..1], &[], "Pic.PNG", true), Pick::One(id) if id == "a"));
        assert!(matches!(pick(&files, &host, "none.png", true), Pick::None));
    }

    #[test]
    fn a_title_an_embed_cannot_carry_is_not_embeddable() {
        for title in ["photo.png", "Scan 2", "clip.mov"] {
            assert!(embeddable(title), "{title}");
        }
        for title in ["", "a|b.png", "a#b.png", "a[1].png", "notes.md", "plan.txt"] {
            assert!(!embeddable(title), "{title}");
        }
    }
}
