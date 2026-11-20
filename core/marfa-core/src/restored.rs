//! A server restored to an earlier point: told from the event the copy last
//! took and the receipts of the writes the server took from it, and answered
//! by the writes that put back what the copy held that the server has lost
//! (`device/expire-last-event-other`, `device/expire-write-lost` and
//! `device/restored-kept`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use rusqlite::Connection;

use crate::catch_up::{RESTORED, ask_unless_stopped};
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{
    BlockedReason, Draft, Edge, EdgeDraft, EdgeEdit, Edit, Item, ItemState, Subject, Verdict,
    WriteKind,
};
use crate::store::{self, Stamp, restored::Receipt};
use crate::wire::{EventPayload, WireEdge, WireItemWithMetadata};
use crate::{Core, Result};
use marfa_rules::catalog::Catalog;

/// Where a stream opens and what its first events say of the log: a copy
/// that keeps an anchor asks from the event before it, so the event it last
/// took comes again and is compared with what it took.
pub(crate) struct Opening {
    cursor: u64,
    anchor: Option<(u64, String)>,
    settled: bool,
    /// When the stream was asked for, on the store's clock: a receipt
    /// answered before it is one the stream had the chance to show.
    opened: i64,
    checked: bool,
}

/// What a frame means for the copy, read before anything else is.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Heard {
    Take,
    /// An event the copy took already, which a stream opened at its anchor
    /// carries again.
    Again,
    /// The log holds another event where the copy's anchor was.
    Went(String),
    /// The log no longer holds the anchor, though it still holds the cursor:
    /// the stream is asked again from the cursor.
    AgedOut,
}

impl Opening {
    /// A fill's own replay is not `anchored`: it compares what the copy set
    /// aside with the server instead, and asks from its cursor alone.
    pub(crate) fn read(conn: &Connection, cursor: &str, anchored: bool) -> Result<Self> {
        let cursor = crate::reach::cursor(cursor).ok_or_else(crate::reach::invalid)?;
        let anchor =
            store::restored::anchor(conn)?.filter(|(id, _)| anchored && (1..=cursor).contains(id));
        Ok(Self {
            cursor,
            settled: anchor.is_none(),
            anchor,
            opened: store::now_millis(),
            checked: false,
        })
    }

    /// An opening with no anchor whose receipts are read already.
    #[cfg(test)]
    pub(crate) fn unanchored() -> Self {
        Self {
            cursor: 0,
            anchor: None,
            settled: true,
            opened: 0,
            checked: true,
        }
    }

    /// The position the stream is asked from.
    pub(crate) fn from(&self) -> String {
        match &self.anchor {
            Some((id, _)) => (id - 1).to_string(),
            None => self.cursor.to_string(),
        }
    }

    pub(crate) fn heard(&mut self, kind: &str, id: Option<&str>, payload: &EventPayload) -> Heard {
        let Some((anchor, print)) = &self.anchor else {
            return match id.and_then(crate::reach::cursor) {
                Some(at) if at <= self.cursor => Heard::Again,
                _ => Heard::Take,
            };
        };
        if !self.settled && kind == "catchup_too_old" {
            let oldest = payload
                .min_retained_id
                .as_deref()
                .and_then(|oldest| oldest.parse::<u64>().ok());
            return if oldest.is_some_and(|oldest| oldest <= self.cursor.saturating_add(1)) {
                Heard::AgedOut
            } else {
                Heard::Take
            };
        }
        let Some(at) = id.and_then(crate::reach::cursor) else {
            if kind == "stream_live" {
                self.settled = true;
            }
            return Heard::Take;
        };
        if !self.settled && at >= *anchor {
            self.settled = true;
            if at == *anchor && store::restored::event_print(kind, payload) != *print {
                return Heard::Went(format!(
                    "the server's event log holds another event at {at}, the last this copy took, {RESTORED}"
                ));
            }
        }
        if at <= self.cursor {
            Heard::Again
        } else {
            Heard::Take
        }
    }
}

/// Lets the stream be asked again from the cursor alone.
pub(crate) fn forget_anchor(core: &Core) -> Result<()> {
    store::restored::forget_anchor(&*core.conn()?)
}

const LOST_WRITE: &str = "the server no longer holds a write it took from this copy";

/// Reads each receipt the stream did not show the server holds, once a
/// stream opened after it has reached the head, and ends the copy where the
/// server has lost one. Every receipt of a row whose read says nothing of it
/// (`heard`) is let go. Asked once for each stream.
pub(crate) fn went_back(
    core: &Core,
    http: &Http,
    stop: &AtomicBool,
    opening: &mut Opening,
) -> Result<()> {
    if std::mem::replace(&mut opening.checked, true) {
        return Ok(());
    }
    let receipts = store::restored::unseen_receipts(&*core.conn()?, opening.opened)?;
    let mut set_aside: HashSet<(Subject, String)> = HashSet::new();
    for receipt in receipts {
        if set_aside.contains(&(receipt.subject, receipt.id.clone())) {
            continue;
        }
        match judged(http, stop, &receipt)? {
            Some(true) => return Err(CoreError::expired(format!("{LOST_WRITE}, {RESTORED}"))),
            Some(false) => store::restored::receipt_confirmed(&*core.conn()?, &receipt)?,
            None => {
                store::restored::set_aside(&*core.conn()?, receipt.subject, &receipt.id)?;
                set_aside.insert((receipt.subject, receipt.id));
            }
        }
    }
    if crate::restored_rows::lost(core, http, stop, opening.opened)? {
        return Err(CoreError::expired(format!("{LOST_WRITE}, {RESTORED}")));
    }
    Ok(())
}

/// Whether the server has lost what `receipt` says it took, or `None` where
/// the read of its row said nothing of it (`heard`).
fn judged(http: &Http, stop: &AtomicBool, receipt: &Receipt) -> Result<Option<bool>> {
    heard(match receipt.subject {
        Subject::Item => read_item(http, stop, &receipt.id).map(|row| {
            item_lost(
                receipt,
                row.map(|row| {
                    let trashed = row.item.state == ItemState::Trashed.as_str();
                    (
                        Stamp {
                            version: row.item.version,
                            updated_at: row.item.updated_at,
                        },
                        trashed,
                    )
                }),
            )
        }),
        Subject::Edge => read_edge(http, stop, &receipt.id).map(|edge| {
            edge_lost(
                receipt,
                edge.map(|edge| Stamp {
                    version: edge.version,
                    updated_at: edge.updated_at,
                }),
            )
        }),
    })
}

/// What a read of one row answered, or `None` where the answer was about
/// that row alone and said nothing of it: a body that does not read, or a
/// refusal of the read itself (`device/expire-write-unreadable`).
pub(crate) fn heard<T>(read: Result<T>) -> Result<Option<T>> {
    match read {
        Ok(read) => Ok(Some(read)),
        Err(error) if says_nothing(&error) => {
            crate::telemetry::degraded!(&error);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// An answer about the row read rather than about the server, the copy or
/// the credential, which no later read of the same row would answer
/// otherwise. A read answers `404` as no row (`Http::read_whole_with`).
fn says_nothing(error: &CoreError) -> bool {
    match error {
        CoreError::Decoding(_)
        | CoreError::Validation { .. }
        | CoreError::Forbidden { .. }
        | CoreError::UnknownType { .. } => true,
        CoreError::Server { .. } => !error.is_environmental(),
        _ => false,
    }
}

/// Whether the server's item, its stamp and whether it is in the bin, lacks
/// what `receipt` says it took: a change at a version and time the server's
/// row is not at or past. A removal is lost only where the item stands out
/// of the bin and was not moved there since the removal, by version or by
/// time.
fn item_lost(receipt: &Receipt, held: Option<(Stamp, bool)>) -> bool {
    match (receipt.removal, held) {
        (false, None) => true,
        (false, Some((server, _))) => receipt
            .stamp()
            .is_some_and(|taken| taken.later_than(&server)),
        (true, Some((server, false))) => receipt
            .stamp()
            .is_none_or(|removed| !server.later_than(&removed)),
        (true, _) => false,
    }
}

/// `item_lost` for an edge. An edge removal leaves nothing behind it, so any
/// row the server holds lacks it.
fn edge_lost(receipt: &Receipt, held: Option<Stamp>) -> bool {
    match (receipt.removal, held) {
        (false, None) => true,
        (false, Some(server)) => receipt
            .stamp()
            .is_some_and(|taken| taken.later_than(&server)),
        (true, held) => held.is_some(),
    }
}

fn read_item(http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<WireItemWithMetadata>> {
    let id = id.to_string();
    let read = ask_unless_stopped(stop, http, move |http| {
        http.read_whole_with(
            &["items", &id],
            &[("include", "metadata"), ("state", "any")],
        )
    })?;
    Ok(read.map(serde_json::from_value).transpose()?)
}

fn read_edge(http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<WireEdge>> {
    let id = id.to_string();
    ask_unless_stopped(stop, http, move |http| http.edge(&id))
}

/// What a row the copy held is to the row the server holds now.
#[derive(Debug, PartialEq, Eq)]
enum Against {
    /// The server holds it as the copy did.
    Same,
    /// Another writer has moved it on since the copy held it.
    Later,
    Gone,
    Behind,
}

/// A row the server holds at a later version and time than the copy held
/// moved on through another writer, as did one at the same version with a
/// later time and the same fields, since a write that keeps the version
/// (tags, a move to or from the bin, a state) changes no field. Anything
/// else at another version or time is behind what the copy held.
fn against(held: (i64, &str), server: Option<(i64, &str)>, same_fields: bool) -> Against {
    let Some((version, updated_at)) = server else {
        return Against::Gone;
    };
    let (held_version, held_at) = held;
    if version == held_version && updated_at == held_at {
        return Against::Same;
    }
    let later = match (
        marfa_rules::time::read(updated_at),
        marfa_rules::time::read(held_at),
    ) {
        (Ok(server), Ok(held)) => server > held,
        _ => false,
    };
    if later && (version > held_version || version == held_version && same_fields) {
        Against::Later
    } else {
        Against::Behind
    }
}

fn same_item_fields(held: &Item, server: &Item) -> bool {
    held.properties == server.properties
        && held.r#type == server.r#type
        && held.tier == server.tier
        && held.occurred_at == server.occurred_at
        && held.source_id == server.source_id
}

fn same_edge_fields(held: &Edge, server: &Edge) -> bool {
    held.properties == server.properties
        && held.from_id == server.from_id
        && held.to_id == server.to_id
}

enum LostItem {
    Create(Item),
    Update { held: Item, server: Box<Item> },
    Remove(Item),
}

enum LostEdge {
    Create(Edge),
    Update { held: Edge, server: Box<Edge> },
    Remove(Edge),
}

/// What the copy held that the server it was filled from lacks, read once
/// the copy is filled and before anything is put back.
pub(crate) struct Lost {
    items: Vec<LostItem>,
    edges: Vec<LostEdge>,
    /// The bytes a kept row names that the cache holds, with their type.
    uploads: Vec<(String, String)>,
    /// Rows the fill refused as older than the copy's that the server holds
    /// as the copy does or later, which the copy takes.
    taken_items: Vec<Item>,
    taken_edges: Vec<Edge>,
}

/// The server's row the filled copy holds: the one beneath any writes
/// waiting on it. `None` where only a waiting create holds it, where the
/// copy holds no row, where a refill in place has not brought the row it
/// still holds from before, or where the fill kept that row over an earlier
/// one the server gave.
fn filled_item(conn: &Connection, id: &str) -> Result<Option<Item>> {
    if !store::untaken_creates_for_item(conn, id)?.is_empty()
        || store::refused_older(conn, Subject::Item, id)?
        || (store::refilling(conn)? && !crate::reach::answered(conn, id)?)
    {
        return Ok(None);
    }
    Ok(match store::beneath_item(conn, id)? {
        Some(item) => Some(item),
        None => store::items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop(),
    })
}

fn filled_edge(conn: &Connection, id: &str) -> Result<Option<Edge>> {
    if !store::untaken_create_for_edge(conn, id)?.is_empty()
        || store::refused_older(conn, Subject::Edge, id)?
        || (store::refilling(conn)? && !store::refill_brought_edge(conn, id)?)
    {
        return Ok(None);
    }
    Ok(match store::beneath_edge(conn, id)? {
        Some(edge) => Some(edge),
        None => store::edge_by_id(conn, id)?,
    })
}

fn server_item(core: &Core, http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<Item>> {
    if let Some(item) = filled_item(&*core.conn()?, id)? {
        return Ok(Some(item));
    }
    read_server_item(http, stop, id)
}

fn read_server_item(http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<Item>> {
    match read_item(http, stop, id)? {
        Some(row) => Ok(Some(Item::from_wire(row.item, row.metadata.tags)?)),
        None => Ok(None),
    }
}

fn server_edge(core: &Core, http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<Edge>> {
    if let Some(edge) = filled_edge(&*core.conn()?, id)? {
        return Ok(Some(edge));
    }
    read_server_edge(http, stop, id)
}

fn read_server_edge(http: &Http, stop: &AtomicBool, id: &str) -> Result<Option<Edge>> {
    Ok(read_edge(http, stop, id)?.map(|edge| Edge {
        id: edge.id,
        from_id: edge.from_id,
        to_id: edge.to_id,
        edge_type: edge.edge_type,
        properties: edge.properties,
        version: edge.version,
        created_at: edge.created_at,
        updated_at: edge.updated_at,
    }))
}

/// The copy's own row of an item the fill refused as older, as `hold_copy`
/// would set it aside: `None` where it holds none, a create of it waits, or
/// the row is read only or `system.*`.
fn copy_item(conn: &Connection, id: &str) -> Result<Option<Item>> {
    if !store::untaken_creates_for_item(conn, id)?.is_empty() {
        return Ok(None);
    }
    let Some(held) = store::items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop() else {
        return Ok(None);
    };
    if held.read_only || held.r#type.starts_with("system.") {
        return Ok(None);
    }
    Ok(Some(store::beneath_item(conn, id)?.unwrap_or(held)))
}

/// `copy_item` for an edge.
fn copy_edge(conn: &Connection, id: &str) -> Result<Option<Edge>> {
    let Some(held) = store::edge_by_id(conn, id)? else {
        return Ok(None);
    };
    if !store::untaken_create_for_edge(conn, id)?.is_empty()
        || !store::untaken_creates_for_item(conn, &held.from_id)?.is_empty()
        || !store::untaken_creates_for_item(conn, &held.to_id)?.is_empty()
    {
        return Ok(None);
    }
    Ok(Some(store::beneath_edge(conn, id)?.unwrap_or(held)))
}

fn item_against(held: &Item, server: Option<&Item>) -> Against {
    against(
        (held.version, &held.updated_at),
        server.map(|server| (server.version, server.updated_at.as_str())),
        server.is_some_and(|server| same_item_fields(held, server)),
    )
}

fn edge_against(held: &Edge, server: Option<&Edge>) -> Against {
    against(
        (held.version, &held.updated_at),
        server.map(|server| (server.version, server.updated_at.as_str())),
        server.is_some_and(|server| same_edge_fields(held, server)),
    )
}

/// What the server lost of an item the copy holds, by `against`, where no
/// create could make `held` again in the bin or `revoked`.
fn lost_item(lost: &mut Lost, held: Item, server: Option<Item>) {
    match (item_against(&held, server.as_ref()), server) {
        (Against::Gone, _) if matches!(held.state, ItemState::Active | ItemState::Archived) => {
            lost.items.push(LostItem::Create(held));
        }
        (Against::Behind, Some(server)) => lost.items.push(LostItem::Update {
            held,
            server: Box::new(server),
        }),
        _ => {}
    }
}

fn lost_edge(lost: &mut Lost, held: Edge, server: Option<Edge>) {
    match (edge_against(&held, server.as_ref()), server) {
        (Against::Gone, _) => lost.edges.push(LostEdge::Create(held)),
        (Against::Behind, Some(server)) => lost.edges.push(LostEdge::Update {
            held,
            server: Box::new(server),
        }),
        _ => {}
    }
}

/// Compares the rows set aside with the filled copy, reading the server for
/// a row the copy does not hold; each row the fill refused as older with the
/// server; and the removals the receipts keep with the server: every one
/// after a restore, otherwise those no event has shown. A row whose read
/// says nothing of it (`heard`) is set aside: nothing of it is kept, and no
/// later comparison reads it. `None` where no restore was found, no
/// hydration set rows aside to compare and the fill refused no row.
pub(crate) fn compare(core: &Core, http: &Http, stop: &AtomicBool) -> Result<Option<Lost>> {
    let (held_items, held_edges, removals, restored) = {
        let conn = core.conn()?;
        if !store::restored::comparing(&conn)? {
            return Ok(None);
        }
        let (items, edges) = store::restored::held_back(&conn)?;
        (
            items,
            edges,
            store::restored::removal_receipts(&conn)?,
            store::restored::restore_held(&conn)?,
        )
    };
    let mut lost = Lost {
        items: Vec::new(),
        edges: Vec::new(),
        uploads: Vec::new(),
        taken_items: Vec::new(),
        taken_edges: Vec::new(),
    };
    let unheard = |subject: Subject, id: &str| -> Result<()> {
        store::restored::set_aside(&*core.conn()?, subject, id)
    };
    let mut named: HashSet<(Subject, String)> = HashSet::new();
    for held in held_items {
        named.insert((Subject::Item, held.id.clone()));
        if !store::untaken_creates_for_item(&*core.conn()?, &held.id)?.is_empty() {
            continue;
        }
        let Some(server) = heard(server_item(core, http, stop, &held.id))? else {
            unheard(Subject::Item, &held.id)?;
            continue;
        };
        match (item_against(&held, server.as_ref()), server) {
            (Against::Same, Some(server)) if kept_tags(&held) != kept_tags(&server) => {
                lost.items.push(LostItem::Update {
                    held,
                    server: Box::new(server),
                });
            }
            (Against::Later, Some(server))
                if store::refused_older(&*core.conn()?, Subject::Item, &held.id)? =>
            {
                lost.taken_items.push(server);
            }
            (Against::Same | Against::Later, _) => {}
            (_, server) => lost_item(&mut lost, held, server),
        }
    }
    for held in held_edges {
        named.insert((Subject::Edge, held.id.clone()));
        if !store::untaken_create_for_edge(&*core.conn()?, &held.id)?.is_empty() {
            continue;
        }
        let Some(server) = heard(server_edge(core, http, stop, &held.id))? else {
            unheard(Subject::Edge, &held.id)?;
            continue;
        };
        match (edge_against(&held, server.as_ref()), server) {
            (Against::Later, Some(server))
                if store::refused_older(&*core.conn()?, Subject::Edge, &held.id)? =>
            {
                lost.taken_edges.push(server);
            }
            (Against::Same | Against::Later, _) => {}
            (_, server) => lost_edge(&mut lost, held, server),
        }
    }
    // A row the fill refused as older than the copy's is judged by the
    // copy's own row, set aside or not: the stream may have shown the write
    // that made it before the server went back.
    let refused = store::refused_older_rows(&*core.conn()?)?;
    for (subject, id) in refused {
        if !named.insert((subject, id.clone())) {
            continue;
        }
        match subject {
            Subject::Item => {
                let Some(held) = copy_item(&*core.conn()?, &id)? else {
                    continue;
                };
                let Some(server) = heard(read_server_item(http, stop, &id))? else {
                    unheard(Subject::Item, &id)?;
                    continue;
                };
                match (item_against(&held, server.as_ref()), server) {
                    (Against::Same | Against::Later, Some(server)) => {
                        lost.taken_items.push(server);
                    }
                    (_, server) => lost_item(&mut lost, held, server),
                }
            }
            Subject::Edge => {
                let Some(held) = copy_edge(&*core.conn()?, &id)? else {
                    continue;
                };
                let Some(server) = heard(read_server_edge(http, stop, &id))? else {
                    unheard(Subject::Edge, &id)?;
                    continue;
                };
                match (edge_against(&held, server.as_ref()), server) {
                    (Against::Same | Against::Later, Some(server)) => {
                        lost.taken_edges.push(server);
                    }
                    (_, server) => lost_edge(&mut lost, held, server),
                }
            }
        }
    }
    // A row the server lost shows a restore, so every removal is read, as
    // after one found by the stream.
    let went_back = restored || !lost.items.is_empty() || !lost.edges.is_empty();
    for receipt in removals {
        if (receipt.seen && !went_back) || !named.insert((receipt.subject, receipt.id.clone())) {
            continue;
        }
        match receipt.subject {
            Subject::Item => {
                let Some(server) = heard(server_item(core, http, stop, &receipt.id))? else {
                    unheard(Subject::Item, &receipt.id)?;
                    continue;
                };
                let Some(server) = server else { continue };
                let at = Stamp {
                    version: server.version,
                    updated_at: server.updated_at.clone(),
                };
                if item_lost(&receipt, Some((at, server.state == ItemState::Trashed)))
                    && !removal_waits(&*core.conn()?, &server.id, WriteKind::DeleteItem)?
                {
                    lost.items.push(LostItem::Remove(server));
                }
            }
            Subject::Edge => {
                let Some(server) = heard(server_edge(core, http, stop, &receipt.id))? else {
                    unheard(Subject::Edge, &receipt.id)?;
                    continue;
                };
                let Some(server) = server else { continue };
                if !removal_waits(&*core.conn()?, &server.id, WriteKind::DeleteEdge)? {
                    lost.edges.push(LostEdge::Remove(server));
                }
            }
        }
    }
    let catalog = crate::catalog::load(&*core.conn()?)?;
    let cache = core.cache().ok();
    for item in &lost.items {
        let (LostItem::Create(held) | LostItem::Update { held, .. }) = item else {
            continue;
        };
        let Some(hash) = crate::body::embed::blob_ref_of(&catalog, &held.r#type, &held.properties)
        else {
            continue;
        };
        if let LostItem::Update { server, .. } = item
            && crate::body::embed::blob_ref_of(&catalog, &server.r#type, &server.properties)
                == Some(hash)
        {
            continue;
        }
        if cache.is_some_and(|cache| cache.held(hash).is_ok_and(|held| held.is_some()))
            && !lost.uploads.iter().any(|(kept, _)| kept == hash)
        {
            let mime_type = held
                .properties
                .get("mime_type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("application/octet-stream");
            lost.uploads.push((hash.to_string(), mime_type.to_string()));
        }
    }
    Ok(Some(lost))
}

fn kept_tags(item: &Item) -> Vec<&str> {
    let mut tags: Vec<&str> = item.tags.iter().map(String::as_str).collect();
    tags.sort_unstable();
    tags.dedup();
    tags
}

fn removal_waits(conn: &Connection, id: &str, kind: WriteKind) -> Result<bool> {
    let waiting = match kind {
        WriteKind::DeleteEdge => store::waiting_writes(conn)?
            .into_iter()
            .filter(|row| row.edge_id.as_deref() == Some(id))
            .collect(),
        _ => store::waiting_writes_for_item(conn, id)?,
    };
    Ok(waiting.iter().any(|row| {
        row.kind == kind
            || (kind == WriteKind::DeleteItem
                && row.kind == WriteKind::TransitionItem
                && row.body.get("state").and_then(serde_json::Value::as_str)
                    == Some(ItemState::Trashed.as_str()))
    }))
}

/// Queues what `lost` names, each write blocked `server_restored`, in the
/// transaction that completes the fill and before the queue is laid over
/// the copy. A write already waiting on an item put back waits on its
/// create. Lets go of the rows set aside and the receipts of changes.
pub(crate) fn keep(tx: &Connection, catalog: &Catalog, lost: Option<Lost>) -> Result<()> {
    let Some(lost) = lost else {
        // The copy is filled from the server: what a change receipt named is
        // there, or went with the rows the fill cleared.
        store::forget_refused_older(tx)?;
        return store::restored::forget_change_receipts(tx);
    };
    for item in &lost.taken_items {
        store::take_server_item(tx, &item.as_wire(), Some(&item.tags), catalog)?;
    }
    for edge in &lost.taken_edges {
        store::take_server_edge(tx, &edge.as_wire())?;
    }
    let mut kept: Vec<String> = Vec::new();
    let mut uploads: HashMap<String, String> = HashMap::new();
    for (hash, mime_type) in &lost.uploads {
        let upload = crate::files::queue_upload(tx, hash, mime_type)?;
        uploads.insert(hash.clone(), upload.id.clone());
        kept.push(upload.id);
    }
    let bytes_of = |item: &Item| -> Vec<String> {
        crate::body::embed::blob_ref_of(catalog, &item.r#type, &item.properties)
            .and_then(|hash| uploads.get(hash))
            .cloned()
            .into_iter()
            .collect()
    };
    let mut created: HashMap<String, String> = HashMap::new();
    for item in &lost.items {
        match item {
            LostItem::Create(held) => {
                let create = keep_create(tx, catalog, held, &bytes_of(held), &mut kept)?;
                created.insert(held.id.clone(), create);
            }
            LostItem::Update { held, server } => {
                keep_update(tx, catalog, held, server, &bytes_of(held), &mut kept)?;
            }
            LostItem::Remove(server) => {
                show_item(tx, catalog, server)?;
                kept.push(queue_state(tx, server, ItemState::Trashed)?);
            }
        }
    }
    let mut edge_created: HashMap<String, String> = HashMap::new();
    for edge in &lost.edges {
        match edge {
            LostEdge::Create(held) => {
                let create = keep_edge_create(tx, held)?;
                edge_created.insert(held.id.clone(), create.clone());
                kept.push(create);
            }
            LostEdge::Update { held, server } => {
                if let Some(id) = keep_edge_update(tx, held, server)? {
                    kept.push(id);
                }
            }
            LostEdge::Remove(server) => {
                show_edge(tx, server)?;
                kept.push(crate::edge_writes::queue_edge_delete(tx, server, &[])?.id);
            }
        }
    }
    // A write already waiting on a row the server no longer holds, or refused
    // because the server did not hold it, is sent only once the create that
    // puts the row back is answered.
    let kept_ids: HashSet<String> = kept.iter().cloned().collect();
    for row in store::queued_writes(tx)? {
        if kept_ids.contains(&row.id) {
            continue;
        }
        let waiting = matches!(row.verdict, None | Some(Verdict::Blocked | Verdict::Dead));
        let refused_missing = row.verdict == Some(Verdict::Refused)
            && !row.kind.rows()
            && matches!(
                row.reason.as_deref(),
                Some("item_not_found" | "edge_not_found")
            );
        if !waiting && !refused_missing {
            continue;
        }
        let creates: Vec<&String> = [&row.item_id, &row.to_id]
            .into_iter()
            .flatten()
            .filter_map(|named| created.get(named))
            .chain(row.edge_id.as_ref().and_then(|edge| edge_created.get(edge)))
            .collect();
        if creates.is_empty() {
            continue;
        }
        let mut depends_on = row.depends_on.clone();
        for create in creates {
            if !depends_on.contains(create) {
                depends_on.push(create.clone());
            }
        }
        if depends_on != row.depends_on {
            store::restored::wait_on(tx, &row.id, &depends_on)?;
        }
        if row.kind.rows() {
            continue;
        }
        // The server holds nothing the write could have changed, so a key
        // it went under answers nothing the write is owed.
        store::restored::send_afresh(tx, &row.id)?;
        let over_create = match row.kind {
            WriteKind::UpdateItem | WriteKind::DeleteItem => row
                .item_id
                .as_ref()
                .is_some_and(|item| created.contains_key(item)),
            WriteKind::UpdateEdge => row
                .edge_id
                .as_ref()
                .is_some_and(|edge| edge_created.contains_key(edge)),
            _ => false,
        };
        if over_create && row.base_version.is_some() {
            // A create makes version 1.
            store::rebase(tx, &row.id, 1)?;
        }
        if refused_missing {
            kept.push(row.id);
        }
    }
    for id in &kept {
        store::record_verdict(
            tx,
            id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::ServerRestored.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
    }
    store::restored::release_held_back(tx)?;
    store::forget_refused_older(tx)?;
    store::restored::forget_change_receipts(tx)
}

/// Puts `item` as the server holds it where the copy holds no row, or holds
/// one the fill kept over the server's earlier row, and pins it where the
/// slice does not declare it.
fn show_item(tx: &Connection, catalog: &Catalog, item: &Item) -> Result<()> {
    if !store::item_held(tx, &item.id)? {
        store::upsert_item(
            tx,
            &item.as_wire(),
            Some(&item.tags),
            &catalog.indexing(&item.r#type),
        )?;
    } else if store::refused_older(tx, Subject::Item, &item.id)? {
        store::place_server_item(tx, &item.as_wire(), Some(&item.tags), catalog)?;
    }
    crate::write::pin_unless_declared(tx, catalog, &item.r#type, item.tier, &item.id)
}

/// `show_item` for an edge, which is never pinned.
fn show_edge(tx: &Connection, edge: &Edge) -> Result<()> {
    if store::edge_by_id(tx, &edge.id)?.is_none() {
        store::upsert_edge(tx, &edge.as_wire())?;
    } else if store::refused_older(tx, Subject::Edge, &edge.id)? {
        store::place_server_edge(tx, &edge.as_wire())?;
    }
    Ok(())
}

fn enqueue(
    tx: &Connection,
    kind: WriteKind,
    subject: &Item,
    base_version: Option<i64>,
    payload: &str,
    depends_on: &[String],
) -> Result<String> {
    Ok(store::enqueue(
        tx,
        &store::NewWrite {
            kind,
            item_id: Some(&subject.id),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version,
            payload,
            depends_on,
        },
    )?
    .id)
}

fn keep_create(
    tx: &Connection,
    catalog: &Catalog,
    held: &Item,
    bytes: &[String],
    kept: &mut Vec<String>,
) -> Result<String> {
    let draft = Draft {
        r#type: held.r#type.clone(),
        id: Some(held.id.clone()),
        properties: held.properties.clone(),
        tags: Vec::new(),
        tier: held.tier,
        state: (held.state == ItemState::Archived).then_some(ItemState::Archived),
        source: None,
        source_id: held.source_id.clone(),
        occurred_at: Some(held.occurred_at.clone()),
        capture_latitude: held.capture_latitude,
        capture_longitude: held.capture_longitude,
        edges: Default::default(),
        base_version: None,
    };
    let payload = draft.payload(&held.id)?;
    // At version 0, as every row a waiting create shows (`Draft::wire`).
    let mut row = held.as_wire();
    row.version = 0;
    store::upsert_item(tx, &row, Some(&held.tags), &catalog.indexing(&held.r#type))?;
    crate::write::pin_unless_declared(tx, catalog, &held.r#type, held.tier, &held.id)?;
    let create = enqueue(tx, WriteKind::CreateItem, held, None, &payload, bytes)?;
    // The create goes first: a write already waiting on the item is made to
    // wait on it, and a create that followed that write would wait forever.
    store::restored::follow_nothing(tx, &create)?;
    kept.push(create.clone());
    if !held.tags.is_empty() {
        // The create carries no tags, so the row it makes holds none.
        kept.push(queue_tags(tx, held, &[], std::slice::from_ref(&create))?);
    }
    Ok(create)
}

fn keep_update(
    tx: &Connection,
    catalog: &Catalog,
    held: &Item,
    server: &Item,
    bytes: &[String],
    kept: &mut Vec<String>,
) -> Result<()> {
    show_item(tx, catalog, server)?;
    let edit = Edit {
        properties: held.properties.clone(),
        base_version: Some(server.version),
        source_id: held
            .source_id
            .clone()
            .filter(|key| server.source_id.as_ref() != Some(key)),
        r#type: (held.r#type != server.r#type).then(|| held.r#type.clone()),
        tier: held.tier.filter(|tier| server.tier != Some(*tier)),
        occurred_at: (held.occurred_at != server.occurred_at).then(|| held.occurred_at.clone()),
        clear_occurred_at: false,
        replace_properties: true,
        clear_properties: Vec::new(),
    };
    let changed = edit.properties != server.properties
        || edit.source_id.is_some()
        || edit.r#type.is_some()
        || edit.tier.is_some()
        || edit.occurred_at.is_some();
    if changed {
        store::hold_beneath_item(tx, &held.id)?;
        kept.push(enqueue(
            tx,
            WriteKind::UpdateItem,
            held,
            Some(server.version),
            &edit.payload(server.version)?,
            bytes,
        )?);
    }
    if kept_tags(held) != kept_tags(server) {
        kept.push(queue_tags(tx, held, &server.tags, &[])?);
    }
    if held.state != server.state
        && held.state != ItemState::Revoked
        && server.state != ItemState::Revoked
    {
        kept.push(queue_state(tx, server, held.state)?);
    }
    Ok(())
}

/// `read` are the tags the server held when the copy was compared with it:
/// the replace is refused if another writer has changed them by the time a
/// person releases it.
fn queue_tags(
    tx: &Connection,
    held: &Item,
    read: &[String],
    depends_on: &[String],
) -> Result<String> {
    let payload = crate::model::TagsWrite {
        tags: held.tags.clone(),
    }
    .payload(read)?;
    store::hold_beneath_item(tx, &held.id)?;
    store::replace_tags(tx, &held.id, &held.tags)?;
    store::reindex_item(tx, &held.id)?;
    enqueue(tx, WriteKind::ReplaceTags, held, None, &payload, depends_on)
}

/// Moves the row the server holds as `server` to `state`, as `delete_item`,
/// `restore_item` and `transition_item` do.
fn queue_state(tx: &Connection, server: &Item, state: ItemState) -> Result<String> {
    let (kind, payload, base_version) = match (server.state, state) {
        (_, ItemState::Trashed) => (
            WriteKind::DeleteItem,
            serde_json::json!({ "version": server.version }).to_string(),
            Some(server.version),
        ),
        (ItemState::Trashed, _) if state == ItemState::Active => {
            (WriteKind::RestoreItem, "{}".to_string(), None)
        }
        _ => (
            WriteKind::TransitionItem,
            serde_json::json!({ "state": state.as_str() }).to_string(),
            None,
        ),
    };
    let depends_on = store::untaken_creates_for_item(tx, &server.id)?;
    store::hold_beneath_item(tx, &server.id)?;
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind,
            item_id: Some(&server.id),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version,
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    store::set_item_state(tx, &server.id, state, &queued.queued_at)?;
    if kind == WriteKind::DeleteItem {
        store::record_read(tx, &queued.id, &serde_json::to_value(server)?)?;
    }
    Ok(queued.id)
}

fn keep_edge_create(tx: &Connection, held: &Edge) -> Result<String> {
    let draft = EdgeDraft {
        from_id: held.from_id.clone(),
        to_id: held.to_id.clone(),
        edge_type: held.edge_type.clone(),
        properties: held.properties.clone(),
        id: Some(held.id.clone()),
    };
    let payload = draft.payload(&held.id)?;
    let mut depends_on: Vec<String> = Vec::new();
    for end in [&held.from_id, &held.to_id] {
        for create in store::untaken_creates_for_item(tx, end)? {
            if !depends_on.contains(&create) {
                depends_on.push(create);
            }
        }
    }
    let mut row = held.as_wire();
    row.version = 0;
    store::upsert_edge(tx, &row)?;
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::CreateEdge,
            item_id: Some(&held.from_id),
            to_id: Some(&held.to_id),
            edge_id: Some(&held.id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    store::restored::follow_nothing(tx, &queued.id)?;
    Ok(queued.id)
}

fn keep_edge_update(tx: &Connection, held: &Edge, server: &Edge) -> Result<Option<String>> {
    let edit = EdgeEdit {
        properties: held.properties.clone(),
        base_version: Some(server.version),
        from_id: (held.from_id != server.from_id).then(|| held.from_id.clone()),
        to_id: (held.to_id != server.to_id).then(|| held.to_id.clone()),
    };
    if edit.properties == server.properties && edit.from_id.is_none() && edit.to_id.is_none() {
        if store::refused_older(tx, Subject::Edge, &server.id)? {
            store::place_server_edge(tx, &server.as_wire())?;
        }
        return Ok(None);
    }
    show_edge(tx, server)?;
    let mut depends_on = store::untaken_create_for_edge(tx, &server.id)?;
    for end in [&edit.from_id, &edit.to_id].into_iter().flatten() {
        for create in store::untaken_creates_for_item(tx, end)? {
            if !depends_on.contains(&create) {
                depends_on.push(create);
            }
        }
    }
    store::hold_beneath_edge(tx, &server.id)?;
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::UpdateEdge,
            item_id: Some(&server.from_id),
            to_id: Some(&server.to_id),
            edge_id: Some(&server.id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: Some(server.version),
            payload: &edit.payload(server.version)?,
            depends_on: &depends_on,
        },
    )?;
    Ok(Some(queued.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEN: &str = "2026-11-19T10:00:00.000Z";
    const PAST_TEN: &str = "2026-11-19T10:05:00.000Z";

    fn receipt(removal: bool, version: Option<i64>, at: Option<&str>) -> Receipt {
        Receipt {
            write_id: "w".into(),
            subject: Subject::Item,
            id: "i".into(),
            version,
            updated_at: at.map(str::to_string),
            removal,
            answered_at: 0,
            seen: false,
        }
    }

    fn at(version: i64, at: &str) -> Stamp {
        Stamp {
            version,
            updated_at: at.into(),
        }
    }

    #[test]
    fn a_change_is_lost_where_the_server_lacks_its_row_or_holds_an_earlier_stamp() {
        let taken = receipt(false, Some(3), Some(PAST_TEN));
        assert!(item_lost(&taken, None));
        assert!(item_lost(&taken, Some((at(2, PAST_TEN), false))));
        // A write that keeps the version, such as a tag write, is lost at
        // its version with an earlier time.
        assert!(item_lost(&taken, Some((at(3, TEN), false))));
        assert!(!item_lost(&taken, Some((at(3, PAST_TEN), false))));
        assert!(!item_lost(&taken, Some((at(4, TEN), true))));
        assert!(edge_lost(&taken, None));
        assert!(edge_lost(&taken, Some(at(2, PAST_TEN))));
        assert!(!edge_lost(&taken, Some(at(3, PAST_TEN))));
        // A row found missing names no version: only its absence is a loss.
        let missing = receipt(false, None, None);
        assert!(item_lost(&missing, None));
        assert!(!item_lost(&missing, Some((at(1, TEN), false))));
        assert!(!edge_lost(&missing, Some(at(1, TEN))));
    }

    #[test]
    fn a_removal_is_lost_only_where_the_row_stands_again_as_it_was_removed_over() {
        let removed = receipt(true, Some(3), Some(TEN));
        assert!(item_lost(&removed, Some((at(3, TEN), false))));
        assert!(item_lost(
            &removed,
            Some((at(3, "2026-11-19T09:00:00.000Z"), false))
        ));
        assert!(item_lost(&removed, Some((at(2, PAST_TEN), false))));
        // Taken out of the bin after the removal, at the version a move to
        // the bin keeps.
        assert!(!item_lost(&removed, Some((at(3, PAST_TEN), false))));
        assert!(!item_lost(&removed, Some((at(4, TEN), false))));
        assert!(!item_lost(&removed, Some((at(3, TEN), true))));
        assert!(!item_lost(&removed, None));
        // A removal whose event the stream never showed has no time to
        // order by, and the version decides.
        let unseen = receipt(true, Some(3), None);
        assert!(item_lost(&unseen, Some((at(3, PAST_TEN), false))));
        let edge = receipt(true, None, None);
        assert!(edge_lost(&edge, Some(at(1, TEN))));
        assert!(!edge_lost(&edge, None));
    }

    #[test]
    fn a_row_moved_on_by_another_writer_is_later_and_one_behind_is_not() {
        let held = (3, TEN);
        assert_eq!(against(held, Some((3, TEN)), false), Against::Same);
        assert_eq!(
            against(held, Some((4, "2026-11-19T10:00:01.000Z")), false),
            Against::Later
        );
        assert_eq!(
            against(held, Some((2, "2026-11-19T09:00:00.000Z")), true),
            Against::Behind
        );
        // Another writer's tags or state keep the version and every field.
        assert_eq!(against(held, Some((3, PAST_TEN)), true), Against::Later);
        // A restored server that took a write since can reach the same
        // version with other content, and a later version made earlier.
        assert_eq!(against(held, Some((3, PAST_TEN)), false), Against::Behind);
        assert_eq!(
            against(held, Some((4, "2026-11-19T09:00:00.000Z")), true),
            Against::Behind
        );
        assert_eq!(
            against(held, Some((3, "not a time")), true),
            Against::Behind
        );
        assert_eq!(against(held, None, true), Against::Gone);
    }

    #[test]
    fn a_read_that_answers_about_its_row_alone_says_nothing_of_a_loss() {
        let server = |status: u16| CoreError::Server {
            status,
            code: "x".into(),
            message: String::new(),
            details: None,
            request_id: None,
        };
        assert!(says_nothing(&CoreError::Decoding("x".into())));
        assert!(says_nothing(&CoreError::Forbidden {
            code: "forbidden".into(),
            message: String::new(),
            server: None,
        }));
        assert!(says_nothing(&server(409)));
        // The witness: the server, the network or the credential failing
        // still ends the catch-up.
        assert!(!says_nothing(&server(503)));
        assert!(!says_nothing(&CoreError::Network("x".into())));
        assert!(!says_nothing(&CoreError::Unauthorized {
            code: "unauthorized".into(),
            message: String::new(),
            server: None,
        }));
    }

    fn payload(item: Option<(&str, i64, &str)>) -> EventPayload {
        let mut body = serde_json::json!({ "event_type": "item.updated" });
        if let Some((id, version, at)) = item {
            body["item"] = serde_json::json!({
                "id": id, "type": "note", "properties": {}, "state": "active",
                "version": version, "schema_version": 1, "source": "s",
                "occurred_at": at, "created_at": at, "updated_at": at,
            });
        }
        serde_json::from_value(body).unwrap()
    }

    fn anchored(cursor: u64, anchor: u64, print: &str) -> Opening {
        Opening {
            cursor,
            anchor: Some((anchor, print.into())),
            settled: false,
            opened: 0,
            checked: false,
        }
    }

    #[test]
    fn a_stream_opened_at_the_anchor_skips_what_the_copy_took_and_tells_another_event_apart() {
        let at = "2026-11-19T10:00:00.000Z";
        let taken = payload(Some(("a", 2, at)));
        let print = store::restored::event_print("item.updated", &taken);
        let mut same = anchored(7, 7, &print);
        assert_eq!(same.from(), "6");
        assert_eq!(
            same.heard("stream_cursor", None, &payload(None)),
            Heard::Take
        );
        assert_eq!(same.heard("item.updated", Some("7"), &taken), Heard::Again);
        assert_eq!(
            same.heard("item.updated", Some("8"), &payload(Some(("b", 1, at)))),
            Heard::Take
        );

        let mut other = anchored(7, 7, &print);
        assert!(matches!(
            other.heard("item.updated", Some("7"), &payload(Some(("b", 1, at)))),
            Heard::Went(reason) if crate::catch_up::divergence(&reason)
                == Some(crate::model::HydrateRestart::HeadPastLog)
        ));

        // A first event past the anchor is no evidence either way, and
        // events up to the cursor were taken already.
        let mut lagging = anchored(9, 7, &print);
        assert_eq!(
            lagging.heard("item.updated", Some("8"), &payload(Some(("b", 1, at)))),
            Heard::Again
        );
        assert_eq!(
            lagging.heard("item.updated", Some("10"), &payload(Some(("b", 2, at)))),
            Heard::Take
        );

        // An event before the anchor, which a stream asked from the anchor
        // should not carry, leaves the anchor still to compare.
        let mut early = anchored(7, 7, &print);
        assert_eq!(
            early.heard("item.updated", Some("6"), &payload(Some(("b", 1, at)))),
            Heard::Again
        );
        assert!(matches!(
            early.heard("item.updated", Some("7"), &payload(Some(("b", 1, at)))),
            Heard::Went(_)
        ));
    }

    #[test]
    fn a_fill_asks_from_its_cursor_though_the_copy_keeps_an_anchor() {
        let conn = store::testing::conn();
        store::restored::set_anchor(&conn, "7", "x").unwrap();
        assert_eq!(Opening::read(&conn, "7", true).unwrap().from(), "6");
        let mut filling = Opening::read(&conn, "7", false).unwrap();
        assert_eq!(filling.from(), "7");
        assert_eq!(
            filling.heard("item.updated", Some("8"), &payload(None)),
            Heard::Take
        );
    }

    #[test]
    fn a_stream_with_no_anchor_takes_nothing_at_or_before_its_cursor_again() {
        let conn = store::testing::conn();
        let mut opening = Opening::read(&conn, "10", true).unwrap();
        assert_eq!(opening.from(), "10");
        assert_eq!(
            opening.heard("item.updated", Some("10"), &payload(None)),
            Heard::Again
        );
        assert_eq!(
            opening.heard("item.updated", Some("9"), &payload(None)),
            Heard::Again
        );
        assert_eq!(
            opening.heard("item.updated", Some("11"), &payload(None)),
            Heard::Take
        );
        assert_eq!(
            opening.heard("stream_cursor", None, &payload(None)),
            Heard::Take
        );
    }

    #[test]
    fn an_anchor_the_log_let_go_of_while_it_holds_the_cursor_asks_again_from_the_cursor() {
        let mut opening = anchored(7, 5, "x");
        let mut marker = payload(None);
        marker.min_retained_id = Some("8".into());
        assert_eq!(
            opening.heard("catchup_too_old", None, &marker),
            Heard::AgedOut
        );
        marker.min_retained_id = Some("9".into());
        let mut opening = anchored(7, 5, "x");
        assert_eq!(opening.heard("catchup_too_old", None, &marker), Heard::Take);
    }
}
