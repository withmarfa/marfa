//! [`plan`] alone judges a move to the bin or a purge, inside the transaction that acts on it, so a
//! preview and the write after it cannot disagree.

use std::collections::{HashMap, HashSet, VecDeque};

use marfa_rules::edges::{self as graph, Closure, Graph, Link, OnDelete};
use rusqlite::Transaction;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::write::stale_bare;
use super::{Door, Item, Mark, is_system, not_found, parsed, rows};
use crate::app::access::{Caller, Level, Permission};
use crate::app::catalog::Catalog;
use crate::app::edges::write::touching;
use crate::app::edges::{Edge, Store};
use crate::app::idempotency::{Claim, Need};
use crate::app::refusal::{Code, Refusal, Result};

pub(super) struct Gate<'a, 'c> {
    pub tx: &'a Transaction<'c>,
    pub caller: &'a Caller,
    pub catalog: &'a Catalog,
    pub claim: Option<&'a Claim>,
    pub server_own: bool,
}

fn reserved(type_id: &str) -> Refusal {
    Refusal::new(
        Code::TypeNotPermitted,
        format!("Items of type \"{type_id}\" are not written through this door."),
    )
}

pub(super) fn invalid_transition(from: &str, to: &str) -> Refusal {
    Refusal::new(
        Code::InvalidTransition,
        format!("An item cannot move from {from} to {to}."),
    )
}

/// The graph a trash, a restore and a purge walk. A plugin's connector key's walk carries no item
/// the key could not write itself through the same door, nor anything it reaches only through one.
struct Carried<'g, 'a, 'c> {
    gate: &'g Gate<'a, 'c>,
}

impl Carried<'_, '_, '_> {
    fn kept(&self, links: Vec<Link>, carried: impl Fn(&Link) -> Option<&str>) -> Result<Vec<Link>> {
        let mut kept = Vec::with_capacity(links.len());
        for link in links {
            match carried(&link) {
                Some(id) if !self.gate.carries(id)? => {}
                _ => kept.push(link),
            }
        }
        Ok(kept)
    }
}

impl Graph for Carried<'_, '_, '_> {
    type Error = Refusal;

    fn outbound(&self, id: &str) -> Result<Vec<Link>> {
        let store = self.gate.store();
        self.kept(store.outbound(id)?, |link| {
            (store.on_delete(&link.edge_type) == OnDelete::Cascade).then_some(link.to.as_str())
        })
    }

    fn inbound(&self, id: &str) -> Result<Vec<Link>> {
        let store = self.gate.store();
        self.kept(store.inbound(id)?, |link| {
            (store.on_delete(&link.edge_type) == OnDelete::WithHosts).then_some(link.from.as_str())
        })
    }

    fn triple(
        &self,
        from: &str,
        to: &str,
        edge_type: &str,
        except: Option<&str>,
    ) -> Result<Option<String>> {
        self.gate.store().triple(from, to, edge_type, except)
    }

    fn in_bin(&self, id: &str) -> Result<bool> {
        self.gate.store().in_bin(id)
    }

    fn holds(&self, id: &str) -> Result<bool> {
        self.gate.store().holds(id)
    }

    fn on_delete(&self, edge_type: &str) -> OnDelete {
        self.gate.store().on_delete(edge_type)
    }
}

impl<'c> Gate<'_, 'c> {
    fn store(&self) -> Store<'_, 'c> {
        Store {
            tx: self.tx,
            catalog: self.catalog,
        }
    }

    fn carried(&self) -> Carried<'_, '_, 'c> {
        Carried { gate: self }
    }

    /// Whether a walk may carry the item `id`: for a plugin's connector key, only one it could
    /// write itself, decided on the state this write commits.
    fn carries(&self, id: &str) -> Result<bool> {
        if !self.caller.is_plugin_connector() {
            return Ok(true);
        }
        Ok(rows::by_id(self.tx, id)?.is_none_or(|row| {
            !is_system(&row.type_id)
                && self.caller.may_read_item(&row.type_id, &row.source)
                && self
                    .caller
                    .require_item_type(&row.type_id, &row.source, Level::Write)
                    .is_ok()
        }))
    }

    pub fn note(&self, need: Need) {
        if let Some(claim) = self.claim {
            claim.note(need);
        }
    }

    /// No caller may write a `system.*` type through an item door: only the server's own writes
    /// reach those.
    pub fn type_gate(&self, type_id: &str) -> Result<()> {
        self.type_gate_under(type_id, None)
    }

    /// The gate for an item of `type_id` under `source`, where the write knows it.
    pub fn type_gate_under(&self, type_id: &str, source: Option<&str>) -> Result<()> {
        self.type_map_gate(type_id, source)?;
        if is_system(type_id) && !self.server_own {
            return Err(reserved(type_id));
        }
        Ok(())
    }

    fn type_map_gate(&self, type_id: &str, source: Option<&str>) -> Result<()> {
        self.note(Need::Reach);
        self.caller.require_reach()?;
        self.note(Need::Type {
            name: type_id.to_string(),
            write: true,
            under: source.map(str::to_string),
        });
        match source {
            Some(source) => self.caller.require_item_type(type_id, source, Level::Write),
            None => self.caller.require_type(type_id, Level::Write),
        }
    }

    pub fn row_gate(&self, row: &Item) -> Result<()> {
        self.note_write(row);
        self.type_gate_under(&row.type_id, Some(&row.source))
    }

    fn note_write(&self, row: &Item) {
        self.note(Need::Item {
            id: row.id.clone(),
            type_id: row.type_id.clone(),
            write: true,
        });
    }

    pub fn readable_row(&self, id: &str) -> Result<Item> {
        self.note(Need::Reach);
        self.caller.require_reach()?;
        rows::by_id(self.tx, id)?
            .filter(|row| self.caller.may_read_item(&row.type_id, &row.source))
            .ok_or_else(not_found)
    }

    /// The row as the owner's bin and history doors see it.
    pub fn owner_row(&self, id: &str) -> Result<Item> {
        let levers = self.caller.levers()?;
        rows::by_id(self.tx, id)?
            .filter(|row| !is_system(&row.type_id))
            .filter(|row| self.caller.may_read_type(&row.type_id))
            .filter(|row| levers.lists(&self.catalog.rules, &row.type_id, &row.source))
            .ok_or_else(not_found)
    }

    pub fn writable_row(&self, id: &str) -> Result<Item> {
        let row = self.readable_row(id)?;
        if row.state == "trashed" {
            self.note(Need::Item {
                id: row.id.clone(),
                type_id: row.type_id.clone(),
                write: false,
            });
            return Err(Door::Write.in_the_bin());
        }
        self.row_gate(&row)?;
        Ok(row)
    }

    fn binnable(&self, asked: &Asked) -> Result<Item> {
        let row = self.writable_row(&asked.id)?;
        require_version(&row, asked.version)?;
        Ok(row)
    }

    /// A `system.*` row leaves by revocation instead of the bin, and only the server's own write
    /// takes it from there.
    fn purgeable(&self, asked: &Asked) -> Result<Item> {
        self.note(Need::Purge);
        self.caller.require(Permission::ItemsPurge)?;
        let row = self.readable_row(&asked.id)?;
        self.note_write(&row);
        self.type_map_gate(&row.type_id, Some(&row.source))?;
        let binned = row.state == "trashed" || (self.server_own && row.state == "revoked");
        if !binned && is_system(&row.type_id) {
            return Err(reserved(&row.type_id));
        }
        require_version(&row, asked.version)?;
        if !binned {
            return Err(invalid_transition(&row.state, "purged"));
        }
        Ok(row)
    }
}

pub(crate) fn require_version(row: &Item, named: Option<i64>) -> Result<()> {
    match named {
        Some(named) if named != row.version => Err(stale_bare(row, named)?),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Act {
    Bin,
    Purge,
}

pub(super) struct Asked {
    pub id: String,
    pub version: Option<i64>,
}

pub(super) struct Moving {
    pub item: Item,
    pub state: &'static str,
    pub mark: Option<Mark>,
}

/// Each edge with its from item as it stood, since the from item can go in the same purge.
pub(super) struct Purging {
    pub item: Item,
    pub edges: Vec<(Edge, Item)>,
}

/// The rows named stand in the order named; what moves stands leaves first, each group's root last.
pub(super) struct Plan {
    pub named: Vec<Item>,
    pub moving: Vec<Moving>,
    pub purging: Vec<Purging>,
    pub beneath: HashMap<String, Vec<String>>,
    pub digest: String,
}

fn digest_of<'a>(items: impl Iterator<Item = &'a Item>) -> String {
    let mut counted: Vec<(&str, i64)> =
        items.map(|item| (item.id.as_str(), item.version)).collect();
    counted.sort_unstable();
    let mut digest = Sha256::new();
    for (id, version) in counted {
        digest.update(format!("{id}\0{version}\n").as_bytes());
    }
    hex::encode(digest.finalize())
}

fn out_of_bin(tx: &Transaction<'_>, closure: &Closure) -> Result<Vec<Item>> {
    let mut rows_moved = Vec::with_capacity(closure.ordered.len());
    for id in &closure.ordered {
        if let Some(row) = rows::by_id(tx, id)?
            && !matches!(row.state.as_str(), "trashed" | "revoked")
        {
            rows_moved.push(row);
        }
    }
    Ok(rows_moved)
}

/// How a row leaves for the bin: a `system.*` row by revocation, unmarked.
fn moving(item: Item, mark: Option<Mark>) -> Moving {
    if is_system(&item.type_id) {
        return Moving {
            item,
            state: "revoked",
            mark: None,
        };
    }
    Moving {
        item,
        state: "trashed",
        mark,
    }
}

fn readable_ends(gate: &Gate<'_, '_>, link: &Link) -> Result<Option<(String, String)>> {
    let (source, target) = (
        super::type_of(gate.tx, &link.from)?,
        super::type_of(gate.tx, &link.to)?,
    );
    Ok(source.zip(target).filter(|(source, target)| {
        gate.caller.may_read_edge(&link.edge_type, source) && gate.caller.may_read_type(target)
    }))
}

fn blocked(gate: &Gate<'_, '_>, root: &str, held: &[Link]) -> Result<Refusal> {
    let mut named = Vec::new();
    for link in held {
        if let Some((source, target)) = readable_ends(gate, link)? {
            gate.note(Need::BlockingEnd {
                id: link.from.clone(),
                type_id: source,
            });
            gate.note(Need::BlockingEnd {
                id: link.to.clone(),
                type_id: target,
            });
            named.push(json!({
                "id": link.id,
                "edge_type": link.edge_type,
                "from_id": link.from,
                "to_id": link.to,
            }));
        }
    }
    let message = if named.is_empty() {
        format!("Cannot delete item {root}: blocked by an edge with cascade_on_delete=block")
    } else {
        format!(
            "Cannot delete item {root}: blocked by {} edge(s) with cascade_on_delete=block",
            named.len()
        )
    };
    Ok(Refusal::new(Code::EdgeConstraintViolation, message)
        .with_detail("root_item_id", root)
        .with_detail("blocking_edges", Value::Array(named)))
}

fn held_connection(row: &Item) -> Result<Option<String>> {
    if row.type_id != "system.connection" {
        return Ok(None);
    }
    let properties = parsed(&row.properties)?;
    if properties.get("status").and_then(Value::as_str) == Some("revoked") {
        return Ok(None);
    }
    let id = &row.id;
    Ok(Some(
        if properties.get("kind").and_then(Value::as_str) == Some("app") {
            format!(
                "Grant {id} is still live. Revoke it first with DELETE /owner/sign-ins/{id}, \
                 which drops the app's tokens and its stored consent. Removing the row here \
                 would leave both behind with nothing listing them."
            )
        } else {
            format!(
                "Connection {id} has no recognized kind and is not revoked; nothing knows what \
                 credentials hang off it, so it stays. A row in this shape was not written \
                 through a validating door and is an administrative repair, not a delete."
            )
        },
    ))
}

fn require_free(
    gate: &Gate<'_, '_>,
    moved: &[Item],
    root_of: impl Fn(&Link) -> String,
) -> Result<()> {
    let ids: Vec<String> = moved.iter().map(|row| row.id.clone()).collect();
    let held = graph::blocking(&gate.store(), &ids)?;
    if let Some(first) = held.first() {
        return Err(blocked(gate, &root_of(first), &held)?);
    }
    for row in moved {
        if let Some(reason) = held_connection(row)? {
            return Err(Refusal::validation(
                if gate.caller.may_read_type(&row.type_id) {
                    reason
                } else {
                    "A row this delete would take with it cannot be removed here, so nothing was \
                     removed."
                        .to_string()
                },
            ));
        }
    }
    Ok(())
}

fn binned(gate: &Gate<'_, '_>, asked: &[Asked]) -> Result<Plan> {
    let named = asked
        .iter()
        .map(|row| gate.binnable(row))
        .collect::<Result<Vec<Item>>>()?;
    let ids: Vec<String> = named.iter().map(|row| row.id.clone()).collect();
    let closure = graph::closure(&gate.carried(), &ids)?;
    let moved = out_of_bin(gate.tx, &closure)?;
    let first_named = || ids.first().cloned().unwrap_or_default();
    require_free(gate, &moved, |link| {
        closure
            .root_of
            .get(&link.from)
            .or_else(|| closure.root_of.get(&link.to))
            .cloned()
            .unwrap_or_else(first_named)
    })?;
    let types: HashMap<&str, &str> = named
        .iter()
        .map(|row| (row.id.as_str(), row.type_id.as_str()))
        .collect();
    let mark_of = |row: &Item| {
        let root = closure.root_of.get(&row.id)?;
        (*root != row.id).then(|| Mark {
            with: root.clone(),
            with_type: types
                .get(root.as_str())
                .copied()
                .unwrap_or_default()
                .to_string(),
            hosts: closure.with_hosts.contains(&row.id),
        })
    };
    let digest = digest_of(
        moved
            .iter()
            .filter(|row| gate.caller.may_read_type(&row.type_id)),
    );
    let moving = moved
        .into_iter()
        .map(|row| {
            let mark = mark_of(&row);
            moving(row, mark)
        })
        .collect();
    Ok(Plan {
        named,
        moving,
        purging: Vec::new(),
        beneath: closure.beneath,
        digest,
    })
}

fn with_hosts(gate: &Gate<'_, '_>, edge_type: &str) -> bool {
    gate.store().on_delete(edge_type) == OnDelete::WithHosts
}

fn goes_with_hosts(gate: &Gate<'_, '_>, part: &Item, going: &HashSet<String>) -> Result<bool> {
    let went = part.state == "trashed" && part.mark.as_ref().is_some_and(|mark| mark.hosts);
    if !went {
        return Ok(false);
    }
    Ok(gate
        .store()
        .outbound(&part.id)?
        .iter()
        .filter(|link| with_hosts(gate, &link.edge_type))
        .all(|link| going.contains(&link.to)))
}

/// The most items one purge of chosen rows takes, since it takes them all in one write.
const CHOSEN_CAP: usize = 1_000;

fn over_cap(message: &'static str) -> Refusal {
    Refusal::new(Code::BulkCapExceeded, message).with_detail("cap", CHOSEN_CAP)
}

/// Each edge stands with the first row of the walk that touches it.
fn purge_walk(gate: &Gate<'_, '_>, named: &[Item], cap: usize) -> Result<Vec<Purging>> {
    let mut going: HashSet<String> = named.iter().map(|row| row.id.clone()).collect();
    let too_many = || {
        over_cap(
            "Purging these takes more than 1,000 items, counting the parts that go with them. \
             Name fewer ids, or name some of the parts on their own first.",
        )
    };
    if going.len() > cap {
        return Err(too_many());
    }
    let mut waiting: VecDeque<Item> = named.iter().cloned().collect();
    let mut taken = HashSet::new();
    let mut purging = Vec::new();
    while let Some(item) = waiting.pop_front() {
        let mut edges = Vec::new();
        let mut held = touching(gate.tx, &item.id)?;
        held.sort_by(|left, right| left.id.cmp(&right.id));
        for edge in held {
            if taken.insert(edge.id.clone()) {
                let source = rows::by_id(gate.tx, &edge.from_id)?
                    .ok_or_else(|| Refusal::internal("an edge outlived its source"))?;
                edges.push((edge, source));
            }
        }
        for link in gate.carried().inbound(&item.id)? {
            if with_hosts(gate, &link.edge_type)
                && !going.contains(&link.from)
                && let Some(part) = rows::by_id(gate.tx, &link.from)?
                && goes_with_hosts(gate, &part, &going)?
            {
                going.insert(part.id.clone());
                if going.len() > cap {
                    return Err(too_many());
                }
                waiting.push_back(part);
            }
        }
        purging.push(Purging { item, edges });
    }
    Ok(purging)
}

pub(super) fn walked_purge(gate: &Gate<'_, '_>, row: Item) -> Result<Vec<Purging>> {
    purge_walk(gate, &[row], usize::MAX)
}

fn purged(gate: &Gate<'_, '_>, asked: &[Asked], cap: usize) -> Result<Plan> {
    let named = asked
        .iter()
        .map(|row| gate.purgeable(row))
        .collect::<Result<Vec<Item>>>()?;
    let purging = purge_walk(gate, &named, cap)?;
    Ok(Plan {
        digest: digest_of(named.iter()),
        named,
        moving: Vec::new(),
        purging,
        beneath: HashMap::new(),
    })
}

/// One walk from every chosen row at once, so a part two chosen hosts share goes with them.
pub(super) fn chosen(gate: &Gate<'_, '_>, ids: &[String]) -> Result<Plan> {
    gate.caller.require(Permission::ItemsPurge)?;
    let mut seen = HashSet::new();
    let mut asked = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id.as_str()) {
            gate.owner_row(id)?;
            asked.push(Asked {
                id: id.clone(),
                version: None,
            });
        }
    }
    purged(gate, &asked, CHOSEN_CAP)
}

/// How many of the first `ids`, which together are over [`CHOSEN_CAP`], one chosen purge can
/// take, refused when the first alone is over it. The search holds because the walk only grows
/// as ids are added.
pub(super) fn fitting(gate: &Gate<'_, '_>, ids: &[String]) -> Result<usize> {
    let (mut fits, mut over) = (0, ids.len());
    while over - fits > 1 {
        let tried = usize::midpoint(fits, over);
        match chosen(gate, &ids[..tried]) {
            Ok(_) => fits = tried,
            Err(refusal) if refusal.code == Code::BulkCapExceeded => over = tried,
            Err(refusal) => return Err(refusal),
        }
    }
    if fits == 0 && !ids.is_empty() {
        return Err(over_cap(
            "The next item in the trash takes more than 1,000 items, counting the parts that go \
             with it. Name some of its parts on their own first.",
        ));
    }
    Ok(fits)
}

/// What an item holds beside its row that its purge deletes, read once for both the preview's
/// counts and the token.
pub(super) struct Held {
    pub versions: i64,
    pub tags: i64,
    pub extensions: i64,
    pub table_rows: i64,
    pub agreements: i64,
    digest: [u8; 32],
}

/// Each part and each list is length-prefixed, so no two holdings feed the same bytes.
fn feed(digest: &mut Sha256, part: &[u8]) {
    counted(digest, part.len());
    digest.update(part);
}

fn counted(digest: &mut Sha256, count: usize) {
    digest.update((count as u64).to_le_bytes());
}

/// Content only: a time a running system rewrites would make a token stale for nothing.
fn held(tx: &Transaction<'_>, item: &Item) -> Result<Held> {
    let holding = rows::holding(tx, item.seq)?;
    let tables = crate::app::tables::hosted(tx, item.seq)?;
    let agreements = crate::app::connectors::agreements_on(tx, &item.id)?;
    let mut digest = Sha256::new();
    counted(&mut digest, holding.tags.len());
    for tag in &holding.tags {
        feed(&mut digest, tag.as_bytes());
    }
    counted(&mut digest, holding.extensions.len());
    for (namespace, data) in &holding.extensions {
        feed(&mut digest, namespace.as_bytes());
        feed(&mut digest, data);
    }
    counted(&mut digest, tables.len());
    for table in &tables {
        feed(&mut digest, &table.key.to_le_bytes());
        feed(&mut digest, table.name.as_bytes());
        feed(&mut digest, &table.rows.to_le_bytes());
        feed(&mut digest, table.last_batch.as_bytes());
    }
    counted(&mut digest, agreements.len());
    for (source, waiting, record) in &agreements {
        feed(&mut digest, source.as_bytes());
        feed(&mut digest, &[u8::from(*waiting)]);
        feed(&mut digest, record.as_bytes());
    }
    Ok(Held {
        versions: holding.versions,
        tags: holding.tags.len() as i64,
        extensions: holding.extensions.len() as i64,
        table_rows: tables.iter().map(|table| table.rows).sum(),
        agreements: agreements.len() as i64,
        digest: digest.finalize().into(),
    })
}

/// Every item and edge the walk takes, at the version it stands at, and what each item holds,
/// with each item's holding in walk order.
pub(super) fn walk_held(tx: &Transaction<'_>, purging: &[Purging]) -> Result<(String, Vec<Held>)> {
    let holdings = purging
        .iter()
        .map(|going| held(tx, &going.item))
        .collect::<Result<Vec<Held>>>()?;
    let mut taken: Vec<(char, &str, i64, Option<&[u8; 32]>)> = Vec::new();
    for (going, holding) in purging.iter().zip(&holdings) {
        taken.push((
            'i',
            going.item.id.as_str(),
            going.item.version,
            Some(&holding.digest),
        ));
        for (edge, _) in &going.edges {
            taken.push(('e', edge.id.as_str(), edge.version, None));
        }
    }
    taken.sort_unstable();
    let mut digest = Sha256::new();
    for (kind, id, version, holds) in taken {
        let holds = holds.map(hex::encode).unwrap_or_default();
        digest.update(format!("{kind}\0{id}\0{version}\0{holds}\n").as_bytes());
    }
    Ok((hex::encode(digest.finalize()), holdings))
}

pub(super) fn plan(gate: &Gate<'_, '_>, act: Act, asked: &[Asked]) -> Result<Plan> {
    match act {
        Act::Bin => binned(gate, asked),
        Act::Purge => purged(gate, asked, usize::MAX),
    }
}

pub(super) struct Returning {
    pub item: Item,
    pub with: String,
    pub with_type: String,
}

/// A part comes back through its host instead.
fn beneath_marked(gate: &Gate<'_, '_>, row: &Item, mark: &Mark) -> Result<Vec<Item>> {
    let mut found = Vec::new();
    for id in graph::cascade_reach(&gate.carried(), &row.id)? {
        if let Some(below) = rows::by_id(gate.tx, &id)?
            && below.state == "trashed"
            && below
                .mark
                .as_ref()
                .is_some_and(|held| held.with == mark.with && !held.hosts)
        {
            found.push(below);
        }
    }
    Ok(found)
}

/// Rows that went on their own carry no mark of this trash, so they stay.
pub(super) fn returning(gate: &Gate<'_, '_>, row: &Item) -> Result<Vec<Returning>> {
    let named = |item: Item| Returning {
        item,
        with: row.id.clone(),
        with_type: row.type_id.clone(),
    };
    let taken = match &row.mark {
        Some(mark) => beneath_marked(gate, row, mark)?,
        None => {
            let reached: Option<HashSet<String>> = if gate.caller.is_plugin_connector() {
                Some(
                    graph::cascade_reach(&gate.carried(), &row.id)?
                        .into_iter()
                        .collect(),
                )
            } else {
                None
            };
            rows::marked_with(gate.tx, &row.id)?
                .into_iter()
                .filter(|item| item.mark.as_ref().is_some_and(|mark| !mark.hosts))
                .filter(|item| {
                    reached
                        .as_ref()
                        .is_none_or(|reached| reached.contains(&item.id))
                })
                .collect()
        }
    };
    let mut seen: HashSet<String> = HashSet::from([row.id.clone()]);
    let mut back = Vec::new();
    for item in taken {
        if seen.insert(item.id.clone()) {
            back.push(named(item));
        }
    }
    let mut host = row.clone();
    let mut next = 0;
    loop {
        for link in gate.carried().inbound(&host.id)? {
            if !with_hosts(gate, &link.edge_type) || seen.contains(&link.from) {
                continue;
            }
            let Some(part) = rows::by_id(gate.tx, &link.from)? else {
                continue;
            };
            let Some(mark) = part.mark.clone().filter(|mark| mark.hosts) else {
                continue;
            };
            if part.state != "trashed" {
                continue;
            }
            seen.insert(part.id.clone());
            let below = beneath_marked(gate, &part, &mark)?;
            back.push(Returning {
                item: part,
                with: host.id.clone(),
                with_type: host.type_id.clone(),
            });
            for item in below {
                if seen.insert(item.id.clone()) {
                    back.push(named(item));
                }
            }
        }
        let Some(following) = back.get(next) else {
            return Ok(back);
        };
        host = following.item.clone();
        next += 1;
    }
}

pub(super) fn late_part(gate: &Gate<'_, '_>, source: &Item, host: &Item) -> Result<Vec<Moving>> {
    let store = gate.store();
    if host.state != "trashed" || matches!(source.state.as_str(), "trashed" | "revoked") {
        return Ok(Vec::new());
    }
    for link in store.outbound(&source.id)? {
        if with_hosts(gate, &link.edge_type) && !store.in_bin(&link.to)? {
            return Ok(Vec::new());
        }
    }
    let closure = graph::closure(&gate.carried(), std::slice::from_ref(&source.id))?;
    let moved = out_of_bin(gate.tx, &closure)?;
    require_free(gate, &moved, |_| source.id.clone())?;
    Ok(moved
        .into_iter()
        .map(|row| {
            let mark = Mark {
                with: host.id.clone(),
                with_type: host.type_id.clone(),
                hosts: row.id == source.id || closure.with_hosts.contains(&row.id),
            };
            moving(row, Some(mark))
        })
        .collect())
}
