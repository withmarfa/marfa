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

impl<'c> Gate<'_, 'c> {
    fn store(&self) -> Store<'_, 'c> {
        Store {
            tx: self.tx,
            catalog: self.catalog,
        }
    }

    pub fn note(&self, need: Need) {
        if let Some(claim) = self.claim {
            claim.note(need);
        }
    }

    /// No caller may write a `system.*` type through an item door: only the server's own writes
    /// reach those.
    pub fn type_gate(&self, type_id: &str) -> Result<()> {
        self.type_map_gate(type_id)?;
        if is_system(type_id) && !self.server_own {
            return Err(reserved(type_id));
        }
        Ok(())
    }

    fn type_map_gate(&self, type_id: &str) -> Result<()> {
        self.note(Need::Reach);
        self.caller.require_reach()?;
        self.note(Need::Type {
            name: type_id.to_string(),
            write: true,
        });
        self.caller.require_type(type_id, Level::Write)
    }

    pub fn row_gate(&self, row: &Item) -> Result<()> {
        self.note_write(row);
        self.type_gate(&row.type_id)
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
            .filter(|row| self.caller.may_read_type(&row.type_id))
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
        self.type_map_gate(&row.type_id)?;
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

/// Each edge with its source as it stood, since the source can go in the same purge.
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
        super::type_of(gate.tx, &link.source)?,
        super::type_of(gate.tx, &link.target)?,
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
                id: link.source.clone(),
                type_id: source,
            });
            gate.note(Need::BlockingEnd {
                id: link.target.clone(),
                type_id: target,
            });
            named.push(json!({
                "id": link.id,
                "edge_type": link.edge_type,
                "source_id": link.source,
                "target_id": link.target,
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
    let closure = graph::closure(&gate.store(), &ids)?;
    let moved = out_of_bin(gate.tx, &closure)?;
    let first_named = || ids.first().cloned().unwrap_or_default();
    require_free(gate, &moved, |link| {
        closure
            .root_of
            .get(&link.source)
            .or_else(|| closure.root_of.get(&link.target))
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
        .all(|link| going.contains(&link.target)))
}

/// Each edge stands with the first row of the walk that touches it.
fn purge_walk(gate: &Gate<'_, '_>, named: &[Item]) -> Result<Vec<Purging>> {
    let mut going: HashSet<String> = named.iter().map(|row| row.id.clone()).collect();
    let mut waiting: VecDeque<Item> = named.iter().cloned().collect();
    let mut taken = HashSet::new();
    let mut purging = Vec::new();
    while let Some(item) = waiting.pop_front() {
        let mut edges = Vec::new();
        let mut held = touching(gate.tx, &item.id)?;
        held.sort_by(|left, right| left.id.cmp(&right.id));
        for edge in held {
            if taken.insert(edge.id.clone()) {
                let source = rows::by_id(gate.tx, &edge.source_id)?
                    .ok_or_else(|| Refusal::internal("an edge outlived its source"))?;
                edges.push((edge, source));
            }
        }
        for link in gate.store().inbound(&item.id)? {
            if with_hosts(gate, &link.edge_type)
                && !going.contains(&link.source)
                && let Some(part) = rows::by_id(gate.tx, &link.source)?
                && goes_with_hosts(gate, &part, &going)?
            {
                going.insert(part.id.clone());
                waiting.push_back(part);
            }
        }
        purging.push(Purging { item, edges });
    }
    Ok(purging)
}

pub(super) fn walked_purge(gate: &Gate<'_, '_>, row: Item) -> Result<Vec<Purging>> {
    purge_walk(gate, &[row])
}

fn purged(gate: &Gate<'_, '_>, asked: &[Asked]) -> Result<Plan> {
    let named = asked
        .iter()
        .map(|row| gate.purgeable(row))
        .collect::<Result<Vec<Item>>>()?;
    let purging = purge_walk(gate, &named)?;
    Ok(Plan {
        digest: digest_of(named.iter()),
        named,
        moving: Vec::new(),
        purging,
        beneath: HashMap::new(),
    })
}

pub(super) fn plan(gate: &Gate<'_, '_>, act: Act, asked: &[Asked]) -> Result<Plan> {
    match act {
        Act::Bin => binned(gate, asked),
        Act::Purge => purged(gate, asked),
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
    for id in graph::cascade_reach(&gate.store(), &row.id)? {
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
        None => rows::marked_with(gate.tx, &row.id)?
            .into_iter()
            .filter(|item| item.mark.as_ref().is_some_and(|mark| !mark.hosts))
            .collect(),
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
        for link in gate.store().inbound(&host.id)? {
            if !with_hosts(gate, &link.edge_type) || seen.contains(&link.source) {
                continue;
            }
            let Some(part) = rows::by_id(gate.tx, &link.source)? else {
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
        if with_hosts(gate, &link.edge_type) && !store.in_bin(&link.target)? {
            return Ok(Vec::new());
        }
    }
    let closure = graph::closure(&store, std::slice::from_ref(&source.id))?;
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
