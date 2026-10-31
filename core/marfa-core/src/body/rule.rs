//! A body written through a working copy, read as the edges it names: a
//! `references` edge for each link and for each embed of a file. An embed
//! shows a file and attaches nothing: whether the file is part of the item
//! is its `attached-to` edge, which a body neither makes nor takes away. A
//! folder reads its own files and keeps its own record, so the edges its
//! sync makes do not come through here.

use std::cell::OnceCell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use super::embed::{FILE_TYPE, blob_ref_of, bytes_of, file_like, is_note, joined, read_as};
use super::resolve::{Names, Others, Paths, Resolved, Resolver, is_id, resolve_reference};
use super::text::{self, Embed, Typed};
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::folder::fields;
use crate::model::{Edge, EdgeDraft, Item, Verdict, WriteKind};
use crate::names::{folded, name_of, same};
use crate::wire::{WireEdge, WireItem};
use crate::{Core, Result, store};

pub(crate) const LINK_EDGE: &str = "references";
pub(crate) const ATTACHMENT_EDGE: &str = "attached-to";
const PLACEMENT_EDGE: &str = "in-folder";

/// The paths a working copy knows items' files by: their placements in
/// folders, which every machine reads alike. An item in the bin answers to
/// no path, as it answers to no title. A placement whose stored
/// properties are not JSON names no path: SQLite raises on such text, so each
/// JSON function is behind `json_valid` in a `CASE`, which SQLite evaluates in
/// order where it promises no order for `AND`.
pub(crate) struct Placements;

impl Paths for Placements {
    fn every(&self, conn: &Connection) -> Result<Vec<(String, String)>> {
        let mut statement = conn.prepare(
            "SELECT json_extract(edges.properties, '$.path'), edges.source_id FROM edges
               JOIN items ON items.id = edges.source_id
              WHERE edges.edge_type = ?1 AND items.state IN ('active', 'archived')
                AND CASE WHEN json_valid(edges.properties) THEN json_type(edges.properties, '$.path') END = 'text'",
        )?;
        let rows = statement.query_map([PLACEMENT_EDGE], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn of(&self, conn: &Connection, id: &str) -> Result<Vec<String>> {
        let mut statement = conn.prepare_cached(
            "SELECT json_extract(edges.properties, '$.path') FROM edges
               JOIN items ON items.id = edges.source_id
              WHERE edges.edge_type = ?1 AND edges.source_id = ?2
                AND items.state IN ('active', 'archived')
                AND CASE WHEN json_valid(edges.properties) THEN json_type(edges.properties, '$.path') END = 'text'
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

/// Whether a link names one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// Saving the link in the item's body would make its edge to `item`.
    Bound,
    /// More than one item the copy holds answers to it.
    Ambiguous,
    /// No item, or one the copy cannot tell is the only one, since it holds a
    /// slice: the server's lookup decides.
    Unresolved,
}

/// The items a link could name, from the copy alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkCandidates {
    /// The link's text between its brackets, as asked.
    pub target: String,
    pub state: LinkState,
    /// The item it names, where `state` is `bound`.
    pub item: Option<String>,
    /// Every item outside the bin the copy holds that answers to the link's
    /// name, by id, title or file path, without regard to case or Unicode
    /// form; and the bound item.
    pub candidates: Vec<String>,
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

/// The file items `host` already references, a link or an embed's edge, that
/// the copy holds outside the bin and `attached` does not list.
fn referenced_files(
    conn: &Connection,
    catalog: &Catalog,
    host: &str,
    attached: &[Candidate],
) -> Result<Vec<Candidate>> {
    let mut found: Vec<Candidate> = Vec::new();
    for other in references_of(conn, host)? {
        if attached.iter().chain(&found).any(|held| held.id == other) {
            continue;
        }
        if !store::in_bin(conn, &other)?
            && let Some(item) = store::item_by_id(conn, &other)?
            && catalog.matches(FILE_TYPE, &item.r#type)
            && bytes_of(&item, catalog).is_some()
        {
            found.push(candidate(conn, catalog, &item)?);
        }
    }
    Ok(found)
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

/// How a body's embeds are read against the copy: its attachments first,
/// then the files it already references, the held file items loaded only for
/// an embed neither answers.
/// `files` may be shared by the bodies of many hosts read against one
/// catalog.
struct Embeds<'c> {
    conn: &'c Connection,
    catalog: &'c Catalog,
    host_paths: Vec<String>,
    attachments: Vec<Candidate>,
    referenced: Vec<Candidate>,
    files: &'c OnceCell<Vec<Candidate>>,
}

impl<'c> Embeds<'c> {
    fn of(
        conn: &'c Connection,
        catalog: &'c Catalog,
        files: &'c OnceCell<Vec<Candidate>>,
        host: &str,
    ) -> Result<Embeds<'c>> {
        let attachments = attachments(conn, catalog, host)?;
        Ok(Embeds {
            conn,
            catalog,
            host_paths: Placements.of(conn, host)?,
            referenced: referenced_files(conn, catalog, host, &attachments)?,
            attachments,
            files,
        })
    }

    /// The file the host's own edges say an embed names: an attachment, or
    /// else a file the host references.
    fn held(&self, name: &str, by_name: bool) -> Pick {
        match pick(&self.attachments, &self.host_paths, name, by_name) {
            Pick::None => pick(&self.referenced, &self.host_paths, name, by_name),
            picked => picked,
        }
    }

    fn files(&self) -> Result<&[Candidate]> {
        if self.files.get().is_none() {
            let _ = self.files.set(held_files(self.conn, self.catalog)?);
        }
        Ok(self.files.get().expect("set above"))
    }

    /// `None` for an embed of a note, which is text. Otherwise the file
    /// item the host's edges say, or what the copy alone can say of it.
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
        let resolved = match self.held(name, by_name) {
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

/// Which body a link is read as part of, which decides how far the row
/// recorded for its exact text counts.
#[derive(Clone, Copy)]
enum Reading<'a> {
    /// The body the rows were recorded for, read to learn which edges its
    /// links stand for: a row names the link's item before anything else.
    Previous,
    /// A body written since, whose links the rows may still describe. A row
    /// answers only a link the body it was recorded for also carried, and an
    /// id only when the row names that id. `None` is a body the rows were
    /// recorded for, which carries every one of them.
    Written(Option<&'a [String]>),
}

/// What a link names, from the copy alone. A body already written reads in
/// this order: an id the copy holds; the item the link's edge was made to,
/// while that edge stands, for a link that body kept; an item the host already
/// references, by its title or path; else it waits for the server, which alone
/// can say a name names one item. A name that already names a referenced item
/// keeps naming it, so its alias or heading is held only to the other
/// references.
fn link_offline(
    conn: &Connection,
    host: &str,
    typed: &Typed,
    references: &Others,
    recorded: &Recorded,
    reading: Reading,
) -> Result<Resolved> {
    if typed.name.is_empty() {
        return Ok(Resolved::Unmatched);
    }
    let found = |id| Resolved::Found { id, r#type: None };
    let by_id = is_id(&typed.name);
    let made = || made_to(conn, recorded, Kind::Link, host, &typed.raw);
    if matches!(reading, Reading::Previous)
        && let Some(id) = made()?
    {
        return Ok(found(id));
    }
    if by_id && let Some(item) = store::item_by_id(conn, &typed.name)? {
        return Ok(Resolved::Found {
            id: item.id,
            r#type: Some(item.r#type),
        });
    }
    if let Reading::Written(kept) = reading
        && kept.is_none_or(|kept| kept.contains(&typed.raw))
        && let Some(id) = made()?
        && (!by_id || id == typed.name)
    {
        return Ok(found(id));
    }
    let Some(named) = references.named(conn, &typed.name)? else {
        return Ok(Resolved::Waiting);
    };
    let Resolved::Found { id, .. } = &named else {
        return Ok(named);
    };
    if typed.raw != typed.name && !by_id {
        match references.named(conn, &typed.raw)? {
            Some(Resolved::Found { id: whole, .. }) if whole != *id => {
                return Ok(Resolved::Ambiguous);
            }
            Some(Resolved::Ambiguous) => return Ok(Resolved::Ambiguous),
            _ => {}
        }
    }
    Ok(named)
}

fn references_of(conn: &Connection, host: &str) -> Result<Vec<String>> {
    Ok(store::edges_from(conn, host)?
        .into_iter()
        .filter(|edge| edge.edge_type == LINK_EDGE)
        .map(|edge| edge.target_id)
        .collect())
}

/// The `references` edge from the item to `other` that a link or an embed
/// of it stands for, as the copy holds it.
fn held_edges(conn: &Connection, host: &str, other: &str) -> Result<Vec<Edge>> {
    Ok(store::edges_from(conn, host)?
        .into_iter()
        .filter(|edge| edge.edge_type == LINK_EDGE && edge.target_id == other)
        .collect())
}

fn draft(host: &str, other: &str) -> EdgeDraft {
    EdgeDraft {
        source_id: host.to_string(),
        target_id: other.to_string(),
        edge_type: LINK_EDGE.into(),
        ..Default::default()
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
    let mut statement = conn.prepare_cached(&format!(
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
/// stands and the item is out of the bin: renaming the item does not make the
/// body's link name nothing, and the server's lookup names no item in the bin.
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
    if store::in_bin(conn, &other)? {
        return Ok(None);
    }
    Ok((!held_edges(conn, host, &other)?.is_empty()).then_some(other))
}

/// `resolved`, or the item the name was made to where it is not found.
fn or_made_to(
    conn: &Connection,
    recorded: &Recorded,
    kind: Kind,
    host: &str,
    text: &str,
    resolved: Resolved,
) -> Result<Resolved> {
    if matches!(resolved, Resolved::Found { .. }) {
        return Ok(resolved);
    }
    Ok(match made_to(conn, recorded, kind, host, text)? {
        Some(id) => Resolved::Found { id, r#type: None },
        None => resolved,
    })
}

/// A body's links and embeds as the copy alone reads them: each resolved
/// one with its item, and each it cannot resolve.
#[derive(Default)]
struct Read {
    found: Vec<(Kind, String, String)>,
    unresolved: Vec<(Kind, String, Resolved)>,
}

impl Read {
    /// Each item the body's links and embeds name, once, with the kind of
    /// the first to name it: a link and an embed of one item stand for one
    /// `references` edge.
    fn targets(&self) -> Vec<(Kind, String)> {
        let mut targets: Vec<(Kind, String)> = Vec::new();
        for (kind, _, other) in &self.found {
            if !targets.iter().any(|(_, held)| held == other) {
                targets.push((*kind, other.clone()));
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
    reading: Reading,
) -> Result<Read> {
    read_against(conn, catalog, host, body, recorded, reading, Others::load)
}

type LoadOthers = fn(&Connection, &Catalog, &dyn Paths, &[String]) -> Result<Others>;

/// `read_offline`, with the referenced items' names read by `load`.
fn read_against(
    conn: &Connection,
    catalog: &Catalog,
    host: &str,
    body: &str,
    recorded: &Recorded,
    reading: Reading,
    load: LoadOthers,
) -> Result<Read> {
    let mut read = Read::default();
    if body.is_empty() {
        return Ok(read);
    }
    let references = load(conn, catalog, &Placements, &references_of(conn, host)?)?;
    for raw in text::links(body) {
        let resolved = match link_offline(
            conn,
            host,
            &Typed::new(&raw),
            &references,
            recorded,
            reading,
        )? {
            Resolved::Found { id, .. } => Some(id),
            other => {
                read.unresolved.push((Kind::Link, raw.clone(), other));
                None
            }
        };
        if let Some(id) = resolved.filter(|id| id != host) {
            read.found.push((Kind::Link, raw, id));
        }
    }
    let embeds = text::embeds(body);
    if !embeds.is_empty() {
        let files = OnceCell::new();
        let reader = Embeds::of(conn, catalog, &files, host)?;
        for embed in &embeds {
            let raw = embed.raw().to_string();
            match reader.offline(embed)? {
                None => {}
                Some((_, resolved)) => {
                    match or_made_to(conn, recorded, Kind::Embed, host, &raw, resolved)? {
                        Resolved::Found { id, .. } => read.found.push((Kind::Embed, raw, id)),
                        other => read.unresolved.push((Kind::Embed, raw, other)),
                    }
                }
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
    let kept = text::links(old);
    let had = read_offline(conn, catalog, host, old, &recorded, Reading::Previous)?;
    let now = read_offline(
        conn,
        catalog,
        host,
        new,
        &recorded,
        Reading::Written(Some(&kept)),
    )?;
    let waits: Vec<String> = unanswered(conn, Some(write))?.into_iter().collect();
    let (had, now_targets) = (had.targets(), now.targets());
    for (kind, other) in &now_targets {
        if held_edges(conn, host, other)?.is_empty() {
            let queued = crate::queue_edge(conn, &draft(host, other), &waits)?;
            remember_edge(
                conn,
                &queued.id,
                host,
                *kind,
                other,
                waits.first().map(String::as_str),
            )?;
        }
    }
    for (kind, other) in &had {
        if now_targets.iter().any(|(_, kept)| kept == other) {
            continue;
        }
        for edge in held_edges(conn, host, other)? {
            let queued = crate::queue_edge_delete(conn, &edge, &waits)?;
            remember_edge(
                conn,
                &queued.id,
                host,
                *kind,
                other,
                waits.first().map(String::as_str),
            )?;
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

/// Defers reading the body a write leaves on `host`, which held `old`, until
/// its answer, for an edit based on an earlier version and for any write a
/// copy that is not whole takes. The copy cannot say what the first changed
/// of the body, only what the server's row holds once it lands; and the
/// second would queue edge writes a copy that is not whole takes none of,
/// against names the rows still to arrive may answer. A write is answered
/// only once the copy is whole.
pub(crate) fn derive_on_answer(
    conn: &Connection,
    host: &str,
    old: &str,
    write: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO body_checks (write_id, item_id, body) VALUES (?1, ?2, ?3)",
        params![write, host, old],
    )?;
    Ok(())
}

/// The items whose bodies link to `id` or embed it, or may: the sources of
/// its `references` edges, and the items it is attached to, whose embeds read
/// their attachments first.
fn linking(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT source_id FROM edges WHERE edge_type = ?1 AND target_id = ?3 AND source_id <> ?3
         UNION
         SELECT target_id FROM edges WHERE edge_type = ?2 AND source_id = ?3 AND target_id <> ?3",
    )?;
    let rows = statement.query_map(params![LINK_EDGE, ATTACHMENT_EDGE, id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records, for each of `hosts`, the item each link and embed in its body
/// that has no row names now, where the edge to that item stands. A body
/// another device wrote reaches the copy with its edges but no word of which
/// link made which, and this is the last moment the copy can still tell.
fn record_unrecorded(conn: &Connection, catalog: &Catalog, hosts: &[String]) -> Result<()> {
    for host in hosts {
        match record_host(conn, catalog, host) {
            // A row whose stored properties cannot be read, the host's or one
            // its reading reaches, leaves that body unrecorded and fails no
            // landing or hydration.
            Err(error) if store::unreadable(&error) => {}
            other => other?,
        }
    }
    Ok(())
}

fn record_host(conn: &Connection, catalog: &Catalog, host: &str) -> Result<()> {
    let Some(item) = store::item_by_id(conn, host)? else {
        return Ok(());
    };
    let held = recorded(conn, host)?;
    let body = body_of(catalog, &item);
    let embeds = text::embeds(body);
    let texts = text::links(body)
        .into_iter()
        .map(|raw| (Kind::Link, raw))
        .chain(
            embeds
                .iter()
                .map(|embed| (Kind::Embed, embed.raw().to_string())),
        );
    let mut open: Vec<(Kind, String)> = Vec::new();
    for (kind, text) in texts {
        if !answered(conn, &held, kind, host, &text)? {
            open.push((kind, text));
        }
    }
    if open.is_empty() {
        return Ok(());
    }
    // Read as held: before a hydration the copy may be one that cannot be
    // kept current, and what it holds is still the last word on its names.
    let read = read_against(
        conn,
        catalog,
        host,
        body,
        &Recorded::new(),
        Reading::Previous,
        Others::held,
    )?;
    for (kind, text, other) in read.found {
        if !open.contains(&(kind, text.clone())) || held_edges(conn, host, &other)?.is_empty() {
            return Ok(());
        }
        // The write that left the body carrying the text still did, so a
        // row this copy wrote keeps it.
        let write_id = held
            .get(&(kind.as_str(), text.clone()))
            .and_then(|row| row.write_id.clone());
        put_row(
            conn,
            &Row {
                item_id: host.to_string(),
                kind,
                text,
                state: "resolved".into(),
                other_id: Some(other),
                reason: None,
                held: None,
                write_id,
            },
        )?;
    }
    Ok(())
}

/// Whether a link or embed's row still answers for it: it names an item the
/// edge to which stands, or it says the server refused the edge, which stays
/// the answer until the refused write is discarded (`device/body-name-refused`).
/// Any other row, a name the server has not settled or one whose edge has
/// gone, is replaced by what the copy reads now.
fn answered(
    conn: &Connection,
    held: &Recorded,
    kind: Kind,
    host: &str,
    text: &str,
) -> Result<bool> {
    Ok(match held.get(&(kind.as_str(), text.to_string())) {
        Some(row) if row.state == "refused" => true,
        Some(row) if row.state == "resolved" => made_to(conn, held, kind, host, text)?.is_some(),
        _ => false,
    })
}

/// Called before the copy writes `id`'s row, whoever wrote it: `next` is
/// the row it is about to hold, `None` for a change of state or the row
/// leaving the copy. A change of what names the item (its type, state or
/// title), or of whether it holds bytes, which makes a file item one an
/// embed can name, can take away the name a link or embed was read by, so
/// what the links to it name is recorded first.
pub(crate) fn item_changing(conn: &Connection, id: &str, next: Option<&WireItem>) -> Result<()> {
    if !linked(conn, id)? || !recording(conn)? {
        return Ok(());
    }
    let mut catalog = None;
    if let Some(next) = next {
        let held: Option<(String, String, String)> = conn
            .query_row(
                "SELECT type, state, properties FROM items WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((r#type, state, properties)) = held else {
            return Ok(());
        };
        if r#type == next.r#type && state == next.state {
            // Stored text that is not one object names nothing the copy can
            // read, so the write is taken as changing the item's names.
            let properties = match serde_json::from_str(&properties) {
                Ok(Value::Object(properties)) => properties,
                _ => serde_json::Map::new(),
            };
            if properties == next.properties {
                return Ok(());
            }
            let loaded = Catalog::load(conn)?;
            let title = fields::title_field(&loaded, &r#type);
            if properties.get(title) == next.properties.get(title)
                && blob_ref_of(&loaded, &r#type, &properties).is_some()
                    == blob_ref_of(&loaded, &r#type, &next.properties).is_some()
            {
                return Ok(());
            }
            catalog = Some(loaded);
        }
    }
    let catalog = match catalog {
        Some(catalog) => catalog,
        None => Catalog::load(conn)?,
    };
    record_unrecorded(conn, &catalog, &linking(conn, id)?)
}

/// Whether any body links to `id` or embeds it, or may (`linking`).
fn linked(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM edges WHERE edge_type = ?1 AND target_id = ?3 AND source_id <> ?3)
             OR EXISTS (SELECT 1 FROM edges WHERE edge_type = ?2 AND source_id = ?3 AND target_id <> ?3)",
        )?
        .query_row(params![LINK_EDGE, ATTACHMENT_EDGE, id], |row| row.get(0))?)
}

/// Called before a hydration clears the slice: it lands every row as the
/// server holds it now, so a rename the copy has not heard of would land
/// with no record of which link made which edge. The rows outlast the
/// clearing.
pub(crate) fn before_rebuild(conn: &Connection) -> Result<()> {
    let hosts: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT source_id FROM edges WHERE edge_type = ?1
             UNION
             SELECT target_id FROM edges WHERE edge_type = ?2",
        )?;
        let rows = statement.query_map(params![LINK_EDGE, ATTACHMENT_EDGE], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if hosts.is_empty() {
        return Ok(());
    }
    record_unrecorded(conn, &Catalog::load(conn)?, &hosts)
}

/// Called before the copy writes an edge, whoever wrote it. An edge from a
/// body to an item it did not reference before can make a link's name answer
/// two of the items it references, a new attachment can do the same for an
/// embed, and a placement that moves changes the path its item is named by,
/// so what the affected links and embeds name is recorded first.
pub(crate) fn edge_changing(conn: &Connection, edge: &WireEdge) -> Result<()> {
    let (host, other) = match edge.edge_type.as_str() {
        LINK_EDGE => (&edge.source_id, &edge.target_id),
        ATTACHMENT_EDGE => (&edge.target_id, &edge.source_id),
        PLACEMENT_EDGE => {
            let held = store::edge_by_id_with(
                conn,
                &edge.id,
                &mut store::Unreadable::Keep(Default::default()),
            )?;
            let mut moved = vec![edge.source_id.as_str()];
            if let Some(held) = &held {
                if held.source_id == edge.source_id
                    && held.properties.get("path") == edge.properties.get("path")
                {
                    return Ok(());
                }
                if held.source_id != edge.source_id {
                    moved.push(&held.source_id);
                }
            }
            for item in moved {
                item_changing(conn, item, None)?;
            }
            return Ok(());
        }
        _ => return Ok(()),
    };
    if !recording(conn)? || edge_held(conn, &edge.edge_type, &edge.source_id, &edge.target_id)? {
        return Ok(());
    }
    // A link and an embed alike stand for a `references` edge, so with none
    // yet no link or embed of the body has an edge to be recorded against.
    let any = conn
        .query_row(
            "SELECT 1 FROM edges WHERE source_id = ?1 AND edge_type = ?2 LIMIT 1",
            params![host, LINK_EDGE],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !any || other == host {
        return Ok(());
    }
    record_unrecorded(conn, &Catalog::load(conn)?, std::slice::from_ref(host))
}

fn edge_held(conn: &Connection, edge_type: &str, source: &str, target: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM edges WHERE edge_type = ?1 AND source_id = ?2 AND target_id = ?3 LIMIT 1",
            params![edge_type, source, target],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Called before the copy takes an edge out, whoever took it: a placement
/// that goes takes its path with it.
pub(crate) fn edge_leaving(conn: &Connection, id: &str) -> Result<()> {
    match store::edge_by_id_with(conn, id, &mut store::Unreadable::Keep(Default::default()))? {
        Some(held) if held.edge_type == PLACEMENT_EDGE => {
            item_changing(conn, &held.source_id, None)
        }
        _ => Ok(()),
    }
}

/// Whether the copy records what links name before a change: always but
/// part way through a hydration, which lands every row as the server holds
/// it now, so nothing it lands takes away a name the copy could still read
/// by. A copy that cannot be kept current still records, since a read-back
/// can land a rename on it and the next hydration reads what it holds.
fn recording(conn: &Connection) -> Result<bool> {
    store::hydration_complete(conn)
}

/// Whether a server row landing on `id` can leave rows its body no longer
/// carries: the copy holds rows for it, and no edit read on its answer
/// (`body_checks`) still needs them to read the body it was made against.
pub(crate) fn drops_on_landing(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM body_names WHERE item_id = ?1)
                AND NOT EXISTS (SELECT 1 FROM body_checks WHERE item_id = ?1)",
        )?
        .query_row([id], |row| row.get(0))?)
}

/// Once a server row has landed on `id` with no write of this copy's laid
/// over it, drops the row of each link and embed text the landed body does
/// not carry. A link another device took out and put back is then read
/// afresh, not by what the link taken out named.
pub(crate) fn landed(conn: &Connection, catalog: &Catalog, id: &str) -> Result<()> {
    let Some(item) = store::item_by_id(conn, id)? else {
        return Ok(());
    };
    let body = body_of(catalog, &item);
    let links = text::links(body);
    let embeds = text::embeds(body);
    for row in rows_of(conn, id)? {
        let carried = match row.kind {
            Kind::Link => links.contains(&row.text),
            Kind::Embed => embeds.iter().any(|embed| embed.raw() == row.text),
        };
        if !carried {
            forget_row(conn, &row)?;
        }
    }
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

/// Set once the copy has read every body it holds under the rule that an
/// embed is a `references` edge.
const REDERIVED: &str = "body_embeds_references";

/// Notes that the copy's rows changed while a name waits that the server
/// answered naming nothing or more than one item, so the next pass counts
/// again what the copy holds of it.
pub(crate) fn rows_changed(conn: &Connection) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR IGNORE INTO meta (key, value)
         SELECT ?1, '1' WHERE EXISTS (
           SELECT 1 FROM body_names WHERE state IN ('missing', 'ambiguous'))",
    )?
    .execute([RECHECK])?;
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
        if !is_id(text) {
            let conn = core.conn()?;
            if let Some(resolved) = references.named(&conn, text)? {
                return Ok(resolved);
            }
        }
        resolver.resolve(text)
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
        let files = OnceCell::new();
        let reader = Embeds::of(&conn, catalog, &files, host)?;
        let Some((name, by_name)) = read_as(embed) else {
            return Ok(None);
        };
        let local = match reader.held(name, by_name) {
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
    // what the name names offline.
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
        if held_edges(&tx, &row.item_id, &found)?.is_empty() {
            let waits: Vec<String> = unanswered(&tx, row.write_id.as_deref())?
                .into_iter()
                .collect();
            let queued = crate::queue_edge(&tx, &draft(&row.item_id, &found), &waits)?;
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

fn releasable_pins(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT item_id FROM body_pins WHERE NOT EXISTS (
           SELECT 1 FROM edges
            WHERE (edge_type = ?1 AND target_id = body_pins.item_id)
               OR (edge_type = ?2 AND source_id = body_pins.item_id))",
    )?;
    let rows = statement.query_map([LINK_EDGE, ATTACHMENT_EDGE], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Lets go of each row the rule pinned that no `references` edge reaches and
/// no `attached-to` edge leaves, whoever made the edge.
fn release_pins(conn: &Connection) -> Result<()> {
    for id in releasable_pins(conn)? {
        conn.execute("DELETE FROM body_pins WHERE item_id = ?1", [&id])?;
        crate::unpin_held(conn, &id)?;
    }
    Ok(())
}

/// Durable inputs that can make `after_answers` change the copy, even after
/// every queued write and read-back has been settled.
pub(crate) fn has_answer_work(conn: &Connection) -> Result<bool> {
    let tracked: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM body_edges) OR EXISTS (SELECT 1 FROM body_checks)",
        [],
        |row| row.get(0),
    )?;
    Ok(tracked || !releasable_pins(conn)?.is_empty() || rederive_due(conn)?)
}

/// Whether the copy is still to read its bodies once under the rule that an
/// embed is a `references` edge (`device/body-embed-rederived`), and can: it
/// holds a body that embeds something, and is whole, since a copy that is
/// not takes no edge write. A folder's store keeps its own record and has
/// nothing to read.
fn rederive_due(conn: &Connection) -> Result<bool> {
    if store::meta_get(conn, REDERIVED)?.is_some()
        || store::meta_get(conn, crate::folder::settings_file::META_FOLDER)?.is_some()
        || store::refuse_unless_whole(conn).is_err()
    {
        return Ok(false);
    }
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM items
                         WHERE state IN ('active', 'archived') AND instr(properties, '![') > 0)",
        [],
        |row| row.get(0),
    )?)
}

/// Reads, once, every body the copy holds that embeds something, and queues
/// the `references` edge of each embed of a file that has none. An embed
/// once made the file's `attached-to` edge, which stays: whether the file is
/// part of the item is no longer the body's to say. Nothing is taken out.
/// Each create is tracked as a body's, so where another device made the same
/// edge first the server's duplicate refusal settles it as one edge.
fn rederive(conn: &Connection) -> Result<()> {
    if !rederive_due(conn)? {
        return Ok(());
    }
    let catalog = Catalog::load(conn)?;
    let ids: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT id FROM items
              WHERE state IN ('active', 'archived') AND instr(properties, '![') > 0
              ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for host in ids {
        match rederive_host(conn, &catalog, &host) {
            // A row whose stored properties cannot be read, the host's or one
            // its reading reaches, keeps the edges it has.
            Err(error) if store::unreadable(&error) => {}
            other => other?,
        }
    }
    store::meta_set(conn, REDERIVED, "1")
}

fn rederive_host(conn: &Connection, catalog: &Catalog, host: &str) -> Result<()> {
    let Some(item) = store::item_by_id(conn, host)? else {
        return Ok(());
    };
    let body = body_of(catalog, &item);
    if text::embeds(body).is_empty() {
        return Ok(());
    }
    let read = read_offline(
        conn,
        catalog,
        host,
        body,
        &recorded(conn, host)?,
        Reading::Previous,
    )?;
    for (kind, other) in read.targets() {
        if kind == Kind::Embed && held_edges(conn, host, &other)?.is_empty() {
            let queued = crate::queue_edge(conn, &draft(host, &other), &[])?;
            remember_edge(conn, &queued.id, host, kind, &other, None)?;
        }
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
    after_answers_of(conn, None)
}

/// `after_answers`, reading every answer but taking out of the queue only the
/// writes named: an edge create left by a refusal that was not named stays
/// where it is, read again by the next call that names it or names none.
pub(crate) fn after_answers_of(conn: &mut Connection, named: Option<&[String]>) -> Result<()> {
    let tx = conn.transaction()?;
    after_answers_in(&tx, named)?;
    tx.commit()?;
    Ok(())
}

/// `after_answers_of`, inside a transaction the caller holds.
pub(crate) fn after_answers_in(tx: &Connection, named: Option<&[String]>) -> Result<()> {
    rederive(tx)?;
    let made: Vec<(String, String, String)> = {
        let mut statement = tx.prepare("SELECT write_id, item_id, other_id FROM body_edges")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (write, host, other) in made {
        let row = store::queued_write(tx, &write)?;
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
                    named.is_none_or(|named| named.contains(&write)) && store::discard(tx, &write)?
                } else {
                    let reason = row
                        .refusal
                        .as_ref()
                        .and_then(|refusal| refusal.message.clone())
                        .or_else(|| row.reason.clone())
                        .unwrap_or_else(|| "refused".into());
                    refuse_names_of(tx, &host, &other, &reason)?;
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
    let catalog = Catalog::load(tx)?;
    for (write, host, old) in checks {
        match store::queued_write(tx, &write)?.and_then(|row| row.verdict) {
            Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => {
                // A body that lost is not the item's, and the one kept is its
                // writer's to read.
                if !lost_on_body(tx, &write)?
                    && let Some(item) = store::item_by_id(tx, &host)?
                {
                    let latest = latest_body_write(tx, &host)?.unwrap_or(write.clone());
                    derive(tx, &catalog, &old, &item, &latest)?;
                }
            }
            Some(Verdict::Refused) => {}
            None if store::queued_write(tx, &write)?.is_none() => {}
            _ => continue,
        }
        tx.execute("DELETE FROM body_checks WHERE write_id = ?1", [&write])?;
    }
    release_pins(tx)?;
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

/// Every link and embed in the host's body that reads as `other` takes the
/// refusal of the edge it asked for, which stands for all of them.
fn refuse_names_of(conn: &Connection, host: &str, other: &str, reason: &str) -> Result<()> {
    for row in rows_of(conn, host)? {
        if row.other_id.as_deref() == Some(other) {
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

/// What each of `targets` names from the copy alone: in the body of `host`
/// where one is given, by the rules that body's edges are read by, so a link
/// answers as saving it there would bind it.
pub(crate) fn candidates(
    conn: &Connection,
    host: Option<&str>,
    targets: &[String],
) -> Result<Vec<LinkCandidates>> {
    let catalog = Catalog::load(conn)?;
    let host = match host {
        Some(id) => Some(
            store::item_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            })?,
        ),
        None => None,
    };
    let held = match &host {
        Some(item) => Some((
            recorded(conn, &item.id)?,
            Others::load(conn, &catalog, &Placements, &references_of(conn, &item.id)?)?,
            text::links(body_of(&catalog, item)),
        )),
        None => None,
    };
    let names = Names::load(conn, &catalog, &Placements)?;
    let mut answers = Vec::with_capacity(targets.len());
    for target in targets {
        let typed = Typed::new(target);
        let mut candidates: Vec<String> = Vec::new();
        let mut add = |ids: &mut dyn Iterator<Item = String>| {
            for id in ids {
                if !candidates.contains(&id) {
                    candidates.push(id);
                }
            }
        };
        let by_id = is_id(&typed.name);
        if by_id {
            add(&mut store::item_by_id(conn, &typed.name)?
                .map(|item| item.id)
                .into_iter());
        } else if !typed.name.is_empty() {
            add(&mut names.of(&typed.name).into_iter().flatten().cloned());
            if typed.raw != typed.name {
                add(&mut names.of(&typed.raw).into_iter().flatten().cloned());
            }
        }
        let resolved = match (&host, &held) {
            (Some(item), Some((recorded, references, kept))) => link_offline(
                conn,
                &item.id,
                &typed,
                references,
                recorded,
                Reading::Written(Some(kept)),
            )?,
            _ if by_id && !candidates.is_empty() => Resolved::Found {
                id: candidates[0].clone(),
                r#type: None,
            },
            _ => Resolved::Waiting,
        };
        let (state, item) = match resolved {
            Resolved::Found { id, .. } => {
                if !candidates.contains(&id) {
                    candidates.insert(0, id.clone());
                }
                (LinkState::Bound, Some(id))
            }
            Resolved::Ambiguous => (LinkState::Ambiguous, None),
            _ if candidates.len() > 1 => (LinkState::Ambiguous, None),
            _ => (LinkState::Unresolved, None),
        };
        answers.push(LinkCandidates {
            target: typed.raw,
            state,
            item,
            candidates,
        });
    }
    Ok(answers)
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
    Bodies::new(conn, &catalog).read(&item)
}

/// Reads the links of many bodies against one catalog, loading the file
/// items an embed may name at most once for all of them.
pub(crate) struct Bodies<'c> {
    conn: &'c Connection,
    catalog: &'c Catalog,
    files: OnceCell<Vec<Candidate>>,
}

impl<'c> Bodies<'c> {
    pub(crate) fn new(conn: &'c Connection, catalog: &'c Catalog) -> Bodies<'c> {
        Bodies {
            conn,
            catalog,
            files: OnceCell::new(),
        }
    }

    /// `read` for an item already read from the copy.
    pub(crate) fn read(&self, item: &Item) -> Result<BodyLinks> {
        read_body(self.conn, self.catalog, &self.files, item)
    }
}

fn read_body(
    conn: &Connection,
    catalog: &Catalog,
    files: &OnceCell<Vec<Candidate>>,
    item: &Item,
) -> Result<BodyLinks> {
    let id = item.id.as_str();
    let body = body_of(catalog, item);
    let mut links = BodyLinks::default();
    let names = text::links(body);
    let embeds = text::embeds(body);
    if names.is_empty() && embeds.is_empty() {
        return Ok(links);
    }
    let recorded = recorded(conn, id)?;
    let target = |kind: Kind, text: &str, resolved: Resolved| -> BodyTarget {
        let row = recorded.get(&(kind.as_str(), text.to_string()));
        // An edge the server refused leaves the copy as it was, so only the
        // record says the name names nothing yet.
        if let Some(row) = row.filter(|row| row.state == "refused") {
            return target_of(&row.state, row.reason.clone());
        }
        if let Resolved::Found { id, .. } = resolved {
            return BodyTarget::Item { id };
        }
        match row {
            Some(row) => target_of(&row.state, row.reason.clone()),
            None => match resolved {
                Resolved::Ambiguous => BodyTarget::Ambiguous,
                Resolved::Unmatched => BodyTarget::Missing,
                _ => BodyTarget::Pending,
            },
        }
    };
    if !names.is_empty() {
        let references = Others::load(conn, catalog, &Placements, &references_of(conn, id)?)?;
        for raw in names {
            let typed = Typed::new(&raw);
            let resolved = link_offline(
                conn,
                id,
                &typed,
                &references,
                &recorded,
                Reading::Written(None),
            )?;
            links.links.push(BodyName {
                text: text::render_link(&raw),
                target: target(Kind::Link, &raw, resolved),
                name: typed.name,
            });
        }
    }
    if !embeds.is_empty() {
        let reader = Embeds::of(conn, catalog, files, id)?;
        for embed in embeds {
            let Some((name, resolved)) = reader.offline(&embed)? else {
                continue;
            };
            let resolved = or_made_to(conn, &recorded, Kind::Embed, id, embed.raw(), resolved)?;
            links.embeds.push(BodyName {
                text: embed.raw().to_string(),
                target: target(Kind::Embed, embed.raw(), resolved),
                name,
            });
        }
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
    let files = OnceCell::new();
    let reader = Embeds::of(conn, &catalog, &files, host)?;
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

    #[test]
    fn a_placement_whose_stored_text_is_not_json_fails_no_path_read() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let conn = core.conn().unwrap();
        for (id, source, path) in [("sound", "a", Some("x.md")), ("torn", "b", Some("y.md"))] {
            let item = crate::store::testing::note(source, source, "", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &item, Some(&[]), &Catalog::empty()).unwrap();
            let mut edge = crate::store::testing::wire_edge(id, source, "folder", PLACEMENT_EDGE);
            edge.properties = props(serde_json::json!({ "path": path }));
            crate::store::put_server_edge(&conn, &edge).unwrap();
        }
        conn.execute(
            "UPDATE edges SET properties = '{\"path\":' WHERE id = 'torn'",
            [],
        )
        .unwrap();
        // The witness: SQLite raises `malformed JSON` on that text, whatever
        // the other rows hold.
        assert!(
            conn.query_row(
                "SELECT json_type(properties, '$.path') FROM edges WHERE id = 'torn'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .is_err()
        );
        assert_eq!(
            Placements.every(&conn).unwrap(),
            [("x.md".to_string(), "a".to_string())]
        );
        assert_eq!(Placements.of(&conn, "a").unwrap(), ["x.md"]);
        assert!(Placements.of(&conn, "b").unwrap().is_empty());
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

    /// A host whose body carries `link` to a note called "Plan", which is then
    /// renamed, and a second note now called "Plan".
    fn plan_renamed_and_taken(core: &Core, link: &str) -> (String, String, String) {
        let plan = note(core, "Plan", "");
        let host = note(core, "Host", "");
        core.create_edge(&EdgeDraft {
            source_id: host.clone(),
            target_id: plan.clone(),
            edge_type: LINK_EDGE.into(),
            ..Default::default()
        })
        .unwrap();
        edit(
            core,
            &host,
            serde_json::json!({ "body": format!("see [[{link}]]") }),
        );
        edit(core, &plan, serde_json::json!({ "title": "Plan v2" }));
        let taker = note(core, "Plan", "");
        (host, plan, taker)
    }

    fn deletes(core: &Core) -> Vec<(String, String)> {
        edge_writes(core)
            .into_iter()
            .filter(|(kind, ..)| *kind == WriteKind::DeleteEdge)
            .map(|(_, source, target)| (source, target))
            .collect()
    }

    #[test]
    fn a_link_keeps_its_item_when_a_new_link_names_another_that_takes_its_old_title() {
        for link in ["Plan", "Plan#Heading", "Plan|alias"] {
            for added in ["{taker}", "{taker}|Plan"] {
                let dir = tempfile::tempdir().unwrap();
                let core = copy(&dir);
                let (host, plan, taker) = plan_renamed_and_taken(&core, link);
                let added = added.replace("{taker}", &taker);
                edit(
                    &core,
                    &host,
                    serde_json::json!({ "body": format!("[[{link}]] [[{added}]]") }),
                );
                assert_eq!(
                    targets(&core.body_links(&host).unwrap().links),
                    vec![
                        BodyTarget::Item { id: plan.clone() },
                        BodyTarget::Item { id: taker.clone() },
                    ],
                    "[[{link}]] with [[{added}]] answered the old link with the new item"
                );
                let other = note(&core, "Other", "");
                edit(
                    &core,
                    &host,
                    serde_json::json!({ "body": format!("[[{link}]] [[{added}]] [[{other}]]") }),
                );
                assert_eq!(deletes(&core), vec![], "[[{link}]] with [[{added}]]");
                assert_eq!(
                    targets(&core.body_links(&host).unwrap().links),
                    vec![
                        BodyTarget::Item { id: plan },
                        BodyTarget::Item { id: taker },
                        BodyTarget::Item { id: other },
                    ]
                );
            }
        }
    }

    #[test]
    fn taking_out_a_link_beside_one_to_a_renamed_item_deletes_that_link_s_edge() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan, taker) = plan_renamed_and_taken(&core, "Plan");
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[Plan]] [[{taker}]]") }),
        );
        edit(&core, &host, serde_json::json!({ "body": "[[Plan]]" }));
        assert_eq!(
            deletes(&core),
            vec![(host.clone(), taker.clone())],
            "taking out the link to the new item kept its edge"
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: plan.clone() }]
        );
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{taker}]]") }),
        );
        assert_eq!(
            deletes(&core).pop(),
            Some((host, plan)),
            "taking out the link to the renamed item kept its edge"
        );
    }

    #[test]
    fn a_name_nothing_recorded_waits_for_the_server_however_items_are_titled() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (_, _, _) = plan_renamed_and_taken(&core, "Plan");
        let fresh = note(&core, "Fresh", "[[Plan]]");
        assert_eq!(
            targets(&core.body_links(&fresh).unwrap().links),
            vec![BodyTarget::Pending]
        );
        assert!(
            edge_writes(&core)
                .iter()
                .all(|(kind, source, _)| *kind != WriteKind::CreateEdge || *source != fresh)
        );
    }

    #[test]
    fn a_link_by_id_names_that_item_whatever_a_referenced_item_is_titled() {
        for added in ["{id}", "{id}|title"] {
            let dir = tempfile::tempdir().unwrap();
            let core = copy(&dir);
            let target = note(&core, "Target", "");
            let titled = note(&core, &target, "");
            let host = note(&core, "Host", &format!("[[{titled}]]"));
            let added = added.replace("{id}", &target);
            edit(
                &core,
                &host,
                serde_json::json!({ "body": format!("[[{titled}]] [[{added}]]") }),
            );
            assert_eq!(
                targets(&core.body_links(&host).unwrap().links),
                vec![
                    BodyTarget::Item { id: titled.clone() },
                    BodyTarget::Item { id: target.clone() },
                ],
                "[[{added}]] named the item titled with the id"
            );
            let created: Vec<String> = edge_writes(&core)
                .into_iter()
                .filter(|(kind, source, _)| *kind == WriteKind::CreateEdge && *source == host)
                .map(|(.., target)| target)
                .collect();
            assert_eq!(created, vec![titled, target]);
        }
    }

    #[test]
    fn an_id_the_copy_does_not_hold_waits_for_the_server_whatever_a_referenced_item_is_titled() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let absent = uuid::Uuid::now_v7().to_string();
        let titled = note(&core, &absent, "");
        let host = note(&core, "Host", &format!("[[{titled}]]"));
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{titled}]] [[{absent}]]") }),
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: titled.clone() }, BodyTarget::Pending]
        );
        assert_eq!(
            edge_writes(&core)
                .into_iter()
                .filter(|(kind, source, _)| *kind == WriteKind::CreateEdge && *source == host)
                .map(|(.., target)| target)
                .collect::<Vec<_>>(),
            vec![titled]
        );
    }

    /// Lands `body` on the item as the server's row, as another device's
    /// write does: no link of it is read or recorded here.
    fn land_remote_body(core: &Core, host: &str, body: &str) {
        land_remote(core, host, serde_json::json!({ "body": body }));
    }

    /// Lands `properties` over the item's as the server's row.
    fn land_remote(core: &Core, id: &str, properties: Value) {
        let conn = core.conn().unwrap();
        let mut item = store::item_by_id(&conn, id).unwrap().unwrap();
        item.properties.extend(props(properties));
        item.version += 1;
        let wire: crate::wire::WireItem =
            serde_json::from_value(serde_json::to_value(&item).unwrap()).unwrap();
        store::put_server_item(&conn, &wire, None, &crate::catalog::Catalog::empty()).unwrap();
    }

    /// Lands an edge as the server's, as another device's write does.
    fn land_remote_edge(core: &Core, edge: crate::wire::WireEdge) {
        store::put_server_edge(&core.conn().unwrap(), &edge).unwrap();
    }

    fn link_edge(source: &str, target: &str) -> crate::wire::WireEdge {
        store::testing::wire_edge(&uuid::Uuid::now_v7().to_string(), source, target, LINK_EDGE)
    }

    /// Takes every write out of the queue, so the rows stand as the server's
    /// and nothing of this copy's waits on them.
    fn as_the_server_s(core: &Core) {
        core.conn()
            .unwrap()
            .execute("DELETE FROM queue", [])
            .unwrap();
    }

    fn recorded_texts(core: &Core, host: &str) -> Vec<String> {
        let mut texts: Vec<String> = rows_of(&core.conn().unwrap(), host)
            .unwrap()
            .into_iter()
            .map(|row| row.text)
            .collect();
        texts.sort();
        texts
    }

    fn creates_from(core: &Core, host: &str) -> Vec<String> {
        edge_writes(core)
            .into_iter()
            .filter(|(kind, source, _)| *kind == WriteKind::CreateEdge && source == host)
            .map(|(.., target)| target)
            .collect()
    }

    /// A host whose body `[[Plan]]` and edge to "Plan" landed from another
    /// device, so this copy has recorded nothing of the link.
    fn plan_from_another_device(core: &Core, body: &str) -> (String, String) {
        let plan = note(core, "Plan", "");
        let host = note(core, "Reader", "");
        as_the_server_s(core);
        land_remote_body(core, &host, body);
        land_remote_edge(core, link_edge(&host, &plan));
        assert_eq!(
            recorded_texts(core, &host),
            Vec::<String>::new(),
            "a link another device wrote was recorded as it landed"
        );
        (host, plan)
    }

    #[test]
    fn a_link_from_another_device_keeps_its_item_after_a_rename() {
        for rename_here in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let core = copy(&dir);
            let (host, plan) = plan_from_another_device(&core, "see [[Plan]]");
            if rename_here {
                edit(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
            } else {
                land_remote(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
            }
            assert_eq!(
                targets(&core.body_links(&host).unwrap().links),
                vec![BodyTarget::Item { id: plan.clone() }],
                "renamed here: {rename_here}"
            );
            let taker = note(&core, "Plan", "");
            edit(
                &core,
                &host,
                serde_json::json!({ "body": format!("[[Plan]] [[{taker}]]") }),
            );
            assert_eq!(
                targets(&core.body_links(&host).unwrap().links),
                vec![
                    BodyTarget::Item { id: plan.clone() },
                    BodyTarget::Item { id: taker.clone() },
                ],
                "renamed here: {rename_here}"
            );
            assert_eq!(creates_from(&core, &host), vec![taker]);
            assert_eq!(deletes(&core), vec![]);
            assert!(!waiting(&core.conn().unwrap()).unwrap(), "a name waits");
        }
    }

    #[test]
    fn a_link_from_another_device_keeps_its_item_however_untidily_it_is_spelled() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let cafe = note(&core, "Caf\u{e9} Plan", "");
        let host = note(&core, "Reader", "");
        as_the_server_s(&core);
        land_remote_body(
            &core,
            &host,
            "[[ caf\u{e9} plan ]] [[CAFE\u{301} PLAN|shown]]",
        );
        land_remote_edge(&core, link_edge(&host, &cafe));
        edit(&core, &cafe, serde_json::json!({ "title": "Elsewhere" }));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![
                BodyTarget::Item { id: cafe.clone() },
                BodyTarget::Item { id: cafe },
            ]
        );
    }

    #[test]
    fn a_link_from_another_device_keeps_its_item_when_a_new_link_names_another_of_its_title() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[Plan]]");
        let other = note(&core, "Plan", "");
        as_the_server_s(&core);
        land_remote_body(&core, &host, &format!("[[Plan]] [[{other}]]"));
        land_remote_edge(&core, link_edge(&host, &other));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![
                BodyTarget::Item { id: plan },
                BodyTarget::Item { id: other },
            ]
        );
    }

    #[test]
    fn a_link_by_path_from_another_device_keeps_its_item_when_its_file_moves() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[notes/Plan]]");
        let placed = |version: i64, path: &str| {
            let mut edge = store::testing::wire_edge("placed", &plan, "folder", PLACEMENT_EDGE);
            edge.properties.insert("path".into(), path.into());
            edge.version = version;
            edge.updated_at = format!("2026-01-0{version}T00:00:00Z");
            edge
        };
        land_remote_edge(&core, placed(1, "notes/Plan.md"));
        land_remote(&core, &plan, serde_json::json!({ "title": "Elsewhere" }));
        land_remote_edge(&core, placed(2, "notes/Plan v2.md"));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: plan }]
        );
    }

    #[test]
    fn an_embed_from_another_device_keeps_its_file_after_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "");
        let photo = dir.path().join("photo.png");
        std::fs::write(&photo, b"not really a png").unwrap();
        let file = core
            .attach(&host, &photo, &Attachment::default())
            .unwrap()
            .item
            .item_id
            .unwrap();
        as_the_server_s(&core);
        land_remote_body(&core, &host, "![[photo.png]]");
        land_remote_edge(&core, link_edge(&host, &file));
        edit(&core, &file, serde_json::json!({ "title": "renamed.png" }));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().embeds),
            vec![BodyTarget::Item { id: file }]
        );
    }

    #[test]
    fn a_link_another_device_takes_out_and_puts_back_is_read_afresh() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan, taker) = plan_renamed_and_taken(&core, "Plan");
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[Plan]] [[{plan}]]") }),
        );
        as_the_server_s(&core);
        land_remote_body(&core, &host, &format!("[[{plan}]]"));
        assert_eq!(recorded_texts(&core, &host), vec![plan.clone()]);
        land_remote_body(&core, &host, &format!("[[Plan]] [[{plan}]]"));
        land_remote_edge(&core, link_edge(&host, &taker));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![
                BodyTarget::Item { id: taker },
                BodyTarget::Item { id: plan },
            ],
            "a link put back elsewhere was answered by the one taken out"
        );
    }

    #[test]
    fn a_server_row_under_a_waiting_write_leaves_the_rows_of_this_copy_s_body() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "[[Nobody]]");
        land_remote_body(&core, &host, "no link");
        assert_eq!(
            recorded_texts(&core, &host),
            vec!["Nobody".to_string()],
            "a server row landing under a waiting write dropped its body's name"
        );
        as_the_server_s(&core);
        land_remote_body(&core, &host, "still no link");
        assert_eq!(recorded_texts(&core, &host), Vec::<String>::new());
    }

    #[test]
    fn an_older_edit_that_takes_out_a_link_to_a_renamed_item_deletes_its_edge_once_answered() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan, _) = plan_renamed_and_taken(&core, "Plan");
        as_the_server_s(&core);
        // The copy holds a later version than the one the edit was read at.
        core.conn()
            .unwrap()
            .execute("UPDATE items SET version = 2 WHERE id = ?1", [&host])
            .unwrap();
        let queued = core
            .update_item_as_read(
                &host,
                &Edit {
                    properties: props(serde_json::json!({ "body": "no link" })),
                    base_version: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        core.conn()
            .unwrap()
            .execute(
                "UPDATE queue SET verdict = 'accepted' WHERE id = ?1",
                [&queued.id],
            )
            .unwrap();
        land_remote_body(&core, &host, "no link");
        after_answers(&mut core.conn().unwrap()).unwrap();
        assert_eq!(
            deletes(&core),
            vec![(host, plan)],
            "the edit's answer was read without the row of the link it took out"
        );
    }

    /// Lands a note as the server's row, as another device's create does.
    fn remote_note(core: &Core, id: &str, title: &str) {
        store::put_server_item(
            &core.conn().unwrap(),
            &store::testing::note(id, title, "", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &Catalog::empty(),
        )
        .unwrap();
    }

    #[test]
    fn a_rename_records_a_link_whose_row_no_longer_answers() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let gone = note(&core, "Plan", "");
        let host = note(&core, "Host", "");
        core.create_edge(&draft(&host, &gone)).unwrap();
        edit(&core, &host, serde_json::json!({ "body": "see [[Plan]]" }));
        assert_eq!(recorded_texts(&core, &host), vec!["Plan".to_string()]);
        as_the_server_s(&core);
        store::purge_item(&core.conn().unwrap(), &gone).unwrap();
        // Another device makes a new "Plan" and links the body to it.
        remote_note(&core, "plan-a", "Plan");
        land_remote_edge(&core, link_edge(&host, "plan-a"));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item {
                id: "plan-a".into()
            }]
        );
        land_remote(&core, "plan-a", serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item {
                id: "plan-a".into()
            }],
            "a row whose edge had gone stood in for a record of the rename"
        );
    }

    #[test]
    fn a_rename_records_a_link_this_copy_left_unresolved_once_another_device_links_it() {
        for state in ["pending", "missing", "ambiguous", "unanswered"] {
            let dir = tempfile::tempdir().unwrap();
            let core = copy(&dir);
            let host = note(&core, "Host", "[[Plan]]");
            as_the_server_s(&core);
            core.conn()
                .unwrap()
                .execute("UPDATE body_names SET state = ?1", [state])
                .unwrap();
            remote_note(&core, "plan-a", "Plan");
            land_remote_edge(&core, link_edge(&host, "plan-a"));
            land_remote(&core, "plan-a", serde_json::json!({ "title": "Plan v2" }));
            assert_eq!(
                targets(&core.body_links(&host).unwrap().links),
                vec![BodyTarget::Item {
                    id: "plan-a".into()
                }],
                "a {state} row stood in for a record of the rename"
            );
        }
    }

    #[test]
    fn a_rename_leaves_a_refused_link_refused() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "[[Plan]]");
        as_the_server_s(&core);
        core.conn()
            .unwrap()
            .execute(
                "UPDATE body_names SET state = 'refused', reason = 'not allowed'",
                [],
            )
            .unwrap();
        remote_note(&core, "plan-a", "Plan");
        land_remote_edge(&core, link_edge(&host, "plan-a"));
        land_remote(&core, "plan-a", serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Refused {
                reason: "not allowed".into()
            }]
        );
    }

    #[test]
    fn a_second_attachment_gaining_bytes_leaves_an_embed_naming_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let host = note(&core, "Host", "");
        let photo = dir.path().join("photo.png");
        std::fs::write(&photo, b"not really a png").unwrap();
        let file = core
            .attach(&host, &photo, &Attachment::default())
            .unwrap()
            .item
            .item_id
            .unwrap();
        as_the_server_s(&core);
        let blob = core.get(&file).unwrap().unwrap().properties["blob_ref"].clone();
        let mut second =
            store::testing::wire_item("second", "core.file", "active", "2026-01-01T00:00:00Z", {
                serde_json::json!({ "title": "photo.png" })
            });
        store::put_server_item(&core.conn().unwrap(), &second, Some(&[]), &Catalog::empty())
            .unwrap();
        let mut attached = store::testing::wire_edge("attached", "second", &host, ATTACHMENT_EDGE);
        attached.version = 1;
        land_remote_edge(&core, attached);
        land_remote_body(&core, &host, "![[photo.png]]");
        land_remote_edge(&core, link_edge(&host, &file));
        second.properties.insert("blob_ref".into(), blob);
        second.version = 2;
        second.updated_at = "2026-01-02T00:00:00Z".into();
        store::put_server_item(&core.conn().unwrap(), &second, Some(&[]), &Catalog::empty())
            .unwrap();
        assert_eq!(
            targets(&core.body_links(&host).unwrap().embeds),
            vec![BodyTarget::Item { id: file }],
            "a second file of the embed's name gaining bytes left nothing recorded"
        );
    }

    /// A second host linking `plan`, whose stored properties are torn.
    fn torn_host(core: &Core, plan: &str) {
        remote_note(core, "torn", "Torn");
        land_remote_edge(core, link_edge("torn", plan));
        let conn = core.conn().unwrap();
        conn.execute(
            "UPDATE items SET properties = '{\"body\":' WHERE id = 'torn'",
            [],
        )
        .unwrap();
        // The witness: a refusing read of the row fails.
        assert!(store::item_by_id(&conn, "torn").is_err());
    }

    #[test]
    fn a_body_whose_row_cannot_be_read_fails_no_rename_of_an_item_it_links() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[Plan]]");
        torn_host(&core, &plan);
        land_remote(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(recorded_texts(&core, &host), vec!["Plan".to_string()]);
    }

    #[test]
    fn a_body_whose_row_cannot_be_read_fails_no_hydration() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[Plan]]");
        torn_host(&core, &plan);
        before_rebuild(&core.conn().unwrap()).unwrap();
        assert_eq!(recorded_texts(&core, &host), vec!["Plan".to_string()]);
    }

    #[test]
    fn a_linked_item_whose_row_cannot_be_read_fails_no_landing() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (_, plan) = plan_from_another_device(&core, "[[Plan]]");
        core.conn()
            .unwrap()
            .execute("UPDATE items SET properties = '[1]' WHERE id = ?1", [&plan])
            .unwrap();
        let mut renamed = store::testing::note(&plan, "Plan v2", "", "2026-01-02T00:00:00Z");
        renamed.version = 5;
        store::put_server_item(
            &core.conn().unwrap(),
            &renamed,
            Some(&[]),
            &Catalog::empty(),
        )
        .unwrap();
    }

    #[test]
    fn a_copy_that_cannot_be_kept_current_still_records_before_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[Plan]]");
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            assert!(!store::hydrated(&conn).unwrap() && !store::never_synced(&conn).unwrap());
        }
        land_remote(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(recorded_texts(&core, &host), vec!["Plan".to_string()]);
    }

    #[test]
    fn an_edit_to_a_linked_item_s_own_body_records_nothing_and_a_rename_does() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "[[Plan]]");
        edit(&core, &plan, serde_json::json!({ "body": "edited" }));
        land_remote(
            &core,
            &plan,
            serde_json::json!({ "body": "edited elsewhere" }),
        );
        assert_eq!(
            recorded_texts(&core, &host),
            Vec::<String>::new(),
            "an edit that names the item no differently recorded the links to it"
        );
        edit(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(recorded_texts(&core, &host), vec!["Plan".to_string()]);
    }

    #[test]
    fn a_hydration_keeps_what_a_link_from_another_device_named_before_its_item_was_renamed() {
        use crate::scripted::{self, Scripted, Then};
        let server = Scripted::start();
        let core = crate::stop_tests::copy(&server);
        let edge = link_edge("reader", "plan");
        {
            let conn = core.conn().unwrap();
            let catalog = Catalog::empty();
            store::put_server_item(
                &conn,
                &store::testing::note("plan", "Plan", "", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &catalog,
            )
            .unwrap();
            store::put_server_item(
                &conn,
                &store::testing::note("reader", "Reader", "[[Plan]]", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &catalog,
            )
            .unwrap();
            store::put_server_edge(&conn, &edge).unwrap();
            // The cursor has gone, so the copy can only hydrate again.
            store::meta_delete(&conn, store::META_EVENT_CURSOR).unwrap();
        }
        let row = |id: &str, title: &str, body: &str, version: i64, edges: Value| {
            serde_json::json!({
                "item": {
                    "id": id, "type": "core.note", "state": "active", "tier": "library",
                    "properties": { "title": title, "body": body },
                    "version": version, "schema_version": 1, "source": "test",
                    "occurred_at": "2026-01-01T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": format!("2026-01-0{version}T00:00:00Z"),
                    "edges": edges,
                },
                "metadata": { "item_id": id, "tags": [], "extensions": {} },
                "listed": true,
            })
        };
        let wire_edge = serde_json::json!({
            "id": edge.id, "source_id": "reader", "target_id": "plan",
            "edge_type": LINK_EDGE, "properties": {}, "version": 1,
            "created_at": edge.created_at, "updated_at": edge.updated_at,
        });
        let page = serde_json::json!({
            "data": [
                row("plan", "Plan v2", "", 2, serde_json::json!({})),
                row(
                    "reader",
                    "Reader",
                    "[[Plan]]",
                    1,
                    serde_json::json!({ LINK_EDGE: { "data": [wire_edge], "next_cursor": null } }),
                ),
            ],
            "next_cursor": null,
        });
        server.on(
            "/items",
            vec![scripted::certified(scripted::json(200, &page.to_string()))],
        );
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                scripted::stream(
                    vec![
                        scripted::copy_marker("stream_cursor", "10"),
                        scripted::copy_marker("stream_live", "11"),
                    ],
                    Then::End,
                ),
            ],
        );
        core.hydrate_until(
            &["core.note".into()],
            crate::SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            store::item_by_id(&core.conn().unwrap(), "plan")
                .unwrap()
                .unwrap()
                .properties["title"],
            "Plan v2",
            "the hydration did not land the rename, so the answer below proves nothing"
        );
        assert_eq!(
            targets(&core.body_links("reader").unwrap().links),
            vec![BodyTarget::Item { id: "plan".into() }]
        );
    }

    #[test]
    fn a_spelling_the_previous_body_did_not_carry_never_uses_a_recorded_row() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan, taker) = plan_renamed_and_taken(&core, "Plan");
        core.create_edge(&draft(&host, &taker)).unwrap();
        core.conn()
            .unwrap()
            .execute("DELETE FROM queue", [])
            .unwrap();
        land_remote_body(&core, &host, &format!("[[{plan}]] [[{taker}]]"));
        after_answers(&mut core.conn().unwrap()).unwrap();
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[Plan]] [[{taker}]]") }),
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![
                BodyTarget::Item { id: taker.clone() },
                BodyTarget::Item { id: taker }
            ],
            "a typed spelling was answered by a row from a body that no longer carries it"
        );
        assert_eq!(deletes(&core), vec![(host, plan)]);
    }

    #[test]
    fn taking_out_a_link_deletes_the_edge_its_recorded_row_names_whatever_an_id_now_reads() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let absent = uuid::Uuid::now_v7().to_string();
        let titled = note(&core, &absent, "");
        let host = note(&core, "Host", "");
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{absent}]]") }),
        );
        core.create_edge(&draft(&host, &titled)).unwrap();
        put_row(
            &core.conn().unwrap(),
            &Row {
                item_id: host.clone(),
                kind: Kind::Link,
                text: absent.clone(),
                state: "resolved".into(),
                other_id: Some(titled.clone()),
                reason: None,
                held: None,
                write_id: None,
            },
        )
        .unwrap();
        core.create_item(&Draft {
            id: Some(absent.clone()),
            r#type: "core.note".into(),
            properties: props(serde_json::json!({ "title": "Target", "body": "" })),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: absent }],
            "a row naming another item answered an id the copy holds"
        );
        edit(&core, &host, serde_json::json!({ "body": "" }));
        assert_eq!(deletes(&core), vec![(host, titled)]);
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
            let old = body_of(&Catalog::load(&conn).unwrap(), &before).to_string();
            derive_on_answer(&conn, &host, &old, &write.id).unwrap();
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
            // A drain talks to a server only under a hydration's reach.
            store::meta_set(&conn, store::META_EVENT_CURSOR, "1").unwrap();
            store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
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
            edge_writes(&core)[before..],
            [(WriteKind::CreateEdge, host.clone(), files[1].clone())],
            "two embeds of one file made other than its one reference"
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
            (WriteKind::DeleteEdge, host.clone(), files[1].clone()),
            "taking the embed out left its reference"
        );
        assert_eq!(
            held_in(&core, &host, ATTACHMENT_EDGE).len(),
            3,
            "taking an embed out took an attachment away"
        );
    }

    /// The targets of `host`'s edges of `edge_type`, and the sources of the
    /// edges of that type to it, as the copy holds them.
    fn held_out(core: &Core, host: &str, edge_type: &str) -> Vec<String> {
        core.edges_from(host)
            .unwrap()
            .into_iter()
            .filter(|edge| edge.edge_type == edge_type)
            .map(|edge| edge.target_id)
            .collect()
    }

    fn held_in(core: &Core, host: &str, edge_type: &str) -> Vec<String> {
        core.edges_to(host)
            .unwrap()
            .into_iter()
            .filter(|edge| edge.edge_type == edge_type)
            .map(|edge| edge.source_id)
            .collect()
    }

    /// A host with `photo.png` attached to it, as an attach makes it.
    fn host_with_attachment(core: &Core, dir: &tempfile::TempDir) -> (String, String) {
        let host = note(core, "Host", "");
        let photo = dir.path().join("photo.png");
        std::fs::write(&photo, b"not really a png").unwrap();
        let file = core
            .attach(&host, &photo, &Attachment::default())
            .unwrap()
            .item
            .item_id
            .unwrap();
        (host, file)
    }

    #[test]
    fn an_embed_by_name_or_by_path_is_a_references_edge_and_attaches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = host_with_attachment(&core, &dir);
        let attaches = edge_writes(&core).len();
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![[photo.png]]" }),
        );
        assert_eq!(
            edge_writes(&core)[attaches..],
            [(WriteKind::CreateEdge, host.clone(), file.clone())],
            "the embed queued no edge from the item to the file"
        );
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file.clone()]);
        assert_eq!(held_in(&core, &host, ATTACHMENT_EDGE), [file.clone()]);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![](photo.png)" }),
        );
        assert_eq!(
            edge_writes(&core).len(),
            attaches + 1,
            "the same file embedded by its path churned its edge"
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().embeds),
            vec![BodyTarget::Item { id: file }]
        );
    }

    #[test]
    fn taking_an_embed_out_takes_its_reference_and_leaves_the_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = host_with_attachment(&core, &dir);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![[photo.png]]" }),
        );
        // The witness: the embed made its reference.
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file.clone()]);
        edit(&core, &host, serde_json::json!({ "body": "text alone" }));
        assert_eq!(
            edge_writes(&core).pop().unwrap(),
            (WriteKind::DeleteEdge, host.clone(), file.clone()),
            "taking the embed out did not take its reference"
        );
        assert!(held_out(&core, &host, LINK_EDGE).is_empty());
        assert_eq!(
            held_in(&core, &host, ATTACHMENT_EDGE),
            [file],
            "taking the embed out took the attachment"
        );
    }

    #[test]
    fn taking_the_attachment_away_leaves_the_embed_s_reference() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = host_with_attachment(&core, &dir);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![[photo.png]]" }),
        );
        let attachment = core
            .edges_to(&host)
            .unwrap()
            .into_iter()
            .find(|edge| edge.edge_type == ATTACHMENT_EDGE)
            .unwrap();
        core.delete_edge(&attachment.id).unwrap();
        assert!(held_in(&core, &host, ATTACHMENT_EDGE).is_empty());
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file.clone()]);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "![[photo.png]] and more" }),
        );
        assert_eq!(
            held_out(&core, &host, LINK_EDGE),
            [file.clone()],
            "an edit elsewhere in the body took the embed's reference"
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().embeds),
            vec![BodyTarget::Item { id: file }],
            "an embed of a file the item references and has not attached names nothing"
        );
    }

    #[test]
    fn taking_out_an_embed_keeps_the_reference_a_link_to_the_same_file_makes() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = host_with_attachment(&core, &dir);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("![[photo.png]] [[{file}]]") }),
        );
        let made = edge_writes(&core).len();
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file.clone()]);
        edit(
            &core,
            &host,
            serde_json::json!({ "body": format!("[[{file}]]") }),
        );
        assert_eq!(
            edge_writes(&core).len(),
            made,
            "taking the embed out took the edge the link still makes"
        );
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file]);
    }

    /// A host whose body embeds a file attached to it, as the earlier rule
    /// left it: the attachment and no reference.
    fn embedded_by_the_earlier_rule(core: &Core, dir: &tempfile::TempDir) -> (String, String) {
        let (host, file) = host_with_attachment(core, dir);
        as_the_server_s(core);
        land_remote_body(core, &host, "![[photo.png]]");
        assert!(held_out(core, &host, LINK_EDGE).is_empty());
        (host, file)
    }

    #[test]
    fn a_copy_reads_its_bodies_once_and_adds_each_embed_s_reference() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = embedded_by_the_earlier_rule(&core, &dir);
        core.conn()
            .unwrap()
            .execute("DELETE FROM meta WHERE key = ?1", [REDERIVED])
            .unwrap();
        assert!(has_answer_work(&core.conn().unwrap()).unwrap());
        after_answers(&mut core.conn().unwrap()).unwrap();
        assert_eq!(
            edge_writes(&core),
            [(WriteKind::CreateEdge, host.clone(), file.clone())],
            "the embed's reference was not added"
        );
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file.clone()]);
        assert_eq!(
            held_in(&core, &host, ATTACHMENT_EDGE),
            [file.clone()],
            "the attachment went"
        );
        assert_eq!(
            targets(&core.body_links(&host).unwrap().embeds),
            vec![BodyTarget::Item { id: file }]
        );
        as_the_server_s(&core);
        core.conn()
            .unwrap()
            .execute("DELETE FROM edges WHERE edge_type = ?1", [LINK_EDGE])
            .unwrap();
        after_answers(&mut core.conn().unwrap()).unwrap();
        assert!(edge_writes(&core).is_empty(), "the bodies were read again");
        assert!(!has_answer_work(&core.conn().unwrap()).unwrap());
    }

    #[test]
    fn a_copy_that_holds_an_embed_s_reference_adds_none() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, file) = embedded_by_the_earlier_rule(&core, &dir);
        land_remote_edge(&core, link_edge(&host, &file));
        core.conn()
            .unwrap()
            .execute("DELETE FROM meta WHERE key = ?1", [REDERIVED])
            .unwrap();
        after_answers(&mut core.conn().unwrap()).unwrap();
        assert!(edge_writes(&core).is_empty());
        assert_eq!(held_out(&core, &host, LINK_EDGE), [file]);
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

    fn candidates_of(core: &Core, host: Option<&str>, target: &str) -> LinkCandidates {
        core.link_candidates(host, &[target.to_string()])
            .unwrap()
            .pop()
            .unwrap()
    }

    fn listed(answer: &LinkCandidates) -> Vec<String> {
        let mut ids = answer.candidates.clone();
        ids.sort();
        ids
    }

    #[test]
    fn link_candidates_fold_case_and_unicode_form_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let cafe = note(&core, "Caf\u{e9}", "");
        for target in ["CAFE\u{301}", "  caf\u{e9}  ", "Caf\u{e9}#Menu|lunch"] {
            let answer = candidates_of(&core, None, target);
            assert_eq!(answer.candidates, std::slice::from_ref(&cafe), "{target:?}");
            assert_eq!(
                answer.state,
                LinkState::Unresolved,
                "a name one held item answers to was bound, though the copy holds a slice"
            );
        }
        for target in ["Cafe", "Ca f\u{e9}", "Caf\u{e9}s"] {
            assert!(
                candidates_of(&core, None, target).candidates.is_empty(),
                "{target:?} answered to Caf\u{e9}, but names fold only case and Unicode form"
            );
        }
    }

    #[test]
    fn link_candidates_list_every_item_a_name_answers_to() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let one = note(&core, "Plan", "");
        let two = note(&core, "PLAN", "");
        let answer = candidates_of(&core, None, "plan");
        assert_eq!(answer.state, LinkState::Ambiguous);
        let mut both = vec![one.clone(), two.clone()];
        both.sort();
        assert_eq!(listed(&answer), both);
        assert_eq!(answer.item, None);

        let c = note(&core, "C", "");
        let sharp = note(&core, "C#", "");
        let answer = candidates_of(&core, None, "C#");
        assert_eq!(
            answer.state,
            LinkState::Ambiguous,
            "a heading reading chose an item where the whole text names another"
        );
        let mut both = vec![c, sharp];
        both.sort();
        assert_eq!(listed(&answer), both);
    }

    #[test]
    fn link_candidates_leave_out_an_item_in_the_bin_by_title_or_path() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let gone = note(&core, "Gone", "");
        let filed = note(&core, "Something else", "");
        let conn = core.conn().unwrap();
        let mut placement =
            crate::store::testing::wire_edge("placed", &filed, "folder", PLACEMENT_EDGE);
        placement.properties = props(serde_json::json!({ "path": "notes/Filed.md" }));
        crate::store::put_server_edge(&conn, &placement).unwrap();
        drop(conn);
        // The witness: both answer while they are out of the bin.
        assert_eq!(
            candidates_of(&core, None, "Gone").candidates,
            std::slice::from_ref(&gone)
        );
        assert_eq!(
            candidates_of(&core, None, "notes/filed").candidates,
            std::slice::from_ref(&filed)
        );
        core.delete_item(&gone).unwrap();
        core.delete_item(&filed).unwrap();
        for target in ["Gone", "notes/filed", "Filed.md"] {
            let answer = candidates_of(&core, None, target);
            assert!(
                answer.candidates.is_empty(),
                "{target:?} answered to an item in the bin"
            );
            assert_eq!(answer.state, LinkState::Unresolved);
        }
    }

    #[test]
    fn a_link_recorded_as_naming_an_item_never_binds_it_once_it_is_in_the_bin() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let (host, plan) = plan_from_another_device(&core, "see [[Plan]]");
        edit(&core, &plan, serde_json::json!({ "title": "Plan v2" }));
        assert_eq!(
            recorded_texts(&core, &host),
            ["Plan"],
            "the rename recorded no row, so this does not test a recorded row"
        );
        // The witness: the recorded row binds the link while Plan is out of the bin.
        let answer = candidates_of(&core, Some(&host), "Plan");
        assert_eq!(
            (answer.state, answer.item.as_deref()),
            (LinkState::Bound, Some(plan.as_str()))
        );
        core.delete_item(&plan).unwrap();
        assert!(store::in_bin(&core.conn().unwrap(), &plan).unwrap());
        let answer = candidates_of(&core, Some(&host), "Plan");
        assert_eq!(
            answer.state,
            LinkState::Unresolved,
            "a link was bound to an item in the bin"
        );
        assert!(
            !answer.candidates.contains(&plan),
            "an item in the bin was a candidate"
        );
        assert_ne!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: plan.clone() }],
            "the body's link read as naming an item in the bin"
        );
        edit(
            &core,
            &host,
            serde_json::json!({ "body": "see [[Plan]] again" }),
        );
        assert_ne!(
            targets(&core.body_links(&host).unwrap().links),
            vec![BodyTarget::Item { id: plan.clone() }],
            "saving the body bound its link to an item in the bin"
        );
        let id_link = candidates_of(&core, Some(&host), &plan);
        assert!(
            id_link.state != LinkState::Bound && id_link.candidates.is_empty(),
            "a link by the id of a referenced item in the bin was bound"
        );
    }

    #[test]
    fn link_candidates_bind_an_id_the_copy_holds_and_nothing_it_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let target = note(&core, "Target", "");
        let titled = note(&core, &target, "");
        let answer = candidates_of(&core, None, &format!("{target}|Shown"));
        assert_eq!(answer.state, LinkState::Bound);
        assert_eq!(answer.item.as_deref(), Some(target.as_str()));
        assert_eq!(
            answer.candidates,
            std::slice::from_ref(&target),
            "an item titled with an id answered to it"
        );
        assert!(!answer.candidates.contains(&titled));

        let elsewhere = "01a10ed5-92a0-73e0-96d2-32cc12d86082";
        let answer = candidates_of(&core, None, elsewhere);
        assert_eq!(
            (answer.state, answer.candidates.len()),
            (LinkState::Unresolved, 0),
            "an item outside the copy's slice was answered offline"
        );
    }

    #[test]
    fn link_candidates_in_a_body_answer_as_saving_the_link_would_bind_it() {
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&dir);
        let kept = note(&core, "Plan", "");
        let other = note(&core, "plan", "");
        let host = note(&core, "Host", "see [[Plan]]");
        // Without the host's edge the name answers to two items.
        assert_eq!(
            candidates_of(&core, Some(&host), "Plan").state,
            LinkState::Ambiguous
        );
        let conn = core.conn().unwrap();
        crate::store::put_server_edge(
            &conn,
            &crate::store::testing::wire_edge("linked", &host, &kept, LINK_EDGE),
        )
        .unwrap();
        drop(conn);
        let answer = candidates_of(&core, Some(&host), "Plan");
        assert_eq!(
            (answer.state, answer.item.as_deref()),
            (LinkState::Bound, Some(kept.as_str())),
            "a link the body's edge already names was not answered with that item"
        );
        let mut both = vec![kept.clone(), other.clone()];
        both.sort();
        assert_eq!(listed(&answer), both);
        let read = core.body_links(&host).unwrap();
        assert_eq!(read.links[0].target, BodyTarget::Item { id: kept.clone() });

        // Without a host the same name is ambiguous.
        assert_eq!(
            candidates_of(&core, None, "Plan").state,
            LinkState::Ambiguous
        );
        assert!(matches!(
            core.link_candidates(Some("not-held"), &["Plan".into()]),
            Err(CoreError::NotFound { .. })
        ));
    }
}
