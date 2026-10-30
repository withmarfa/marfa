//! Reads of many rows in one call, and the rows changed since an earlier
//! read, for an app that keeps what it shows in memory and rereads only what
//! changed.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{Connection, params_from_iter};
use serde::Serialize;

use crate::body::rule::Bodies;
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{Edge, Item, ItemState, Rows, Shown};
use crate::store::Changes;
use crate::{BodyLinks, Core, Result, store};

/// What changed in the copy since a cursor `Core::changes_since` gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopyChanges {
    /// Where the next call starts from.
    pub cursor: String,
    /// True where the changes cannot be named one by one, and the four lists
    /// are empty: the caller reads the whole copy again.
    pub everything: bool,
    /// Each changed item the copy holds, in the bin or out, by id.
    pub items: Vec<String>,
    /// Each changed item the copy no longer holds.
    pub removed_items: Vec<String>,
    /// Each changed edge the copy holds.
    pub edges: Vec<String>,
    /// Each changed edge the copy no longer holds.
    pub removed_edges: Vec<String>,
}

/// Where a cursor stands: the store it was taken from, and the latest
/// change of items and of edges it had seen.
struct Mark {
    store: String,
    items: i64,
    edges: i64,
}

impl Mark {
    fn render(&self) -> String {
        format!("{}.{}.{}", self.store, self.items, self.edges)
    }

    fn parse(cursor: &str) -> Result<Mark> {
        let refuse = || {
            CoreError::Invalid(format!(
                "{cursor:?} is not a cursor this copy's changes_since gave"
            ))
        };
        let mut parts = cursor.split('.');
        let (Some(store), Some(items), Some(edges), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(refuse());
        };
        let count = |text: &str| {
            text.parse::<i64>()
                .ok()
                .filter(|count| *count >= 0)
                .ok_or_else(refuse)
        };
        if store.is_empty() {
            return Err(refuse());
        }
        Ok(Mark {
            store: store.to_string(),
            items: count(items)?,
            edges: count(edges)?,
        })
    }
}

impl Core {
    /// `get_shown` for each id, under one snapshot: each item the copy
    /// holds, once each, in the order named. An id the copy does not hold is
    /// left out, and so is an item in the bin unless `include_bin`. Part way
    /// through a hydration the answer is marked `Partial`, since a row left
    /// out may be one still to arrive.
    pub fn get_items_shown(
        &self,
        ids: &[String],
        include_bin: bool,
    ) -> Result<Rows<(Item, Shown)>> {
        self.get_items_with(ids, include_bin, &mut store::Unreadable::Refuse)
    }

    /// `get_items_shown`, but a row whose stored properties cannot be read
    /// is answered with no properties, and its `Shown` says why, as
    /// `get_kept` answers it.
    pub fn get_items_kept(&self, ids: &[String], include_bin: bool) -> Result<Rows<(Item, Shown)>> {
        self.get_items_with(
            ids,
            include_bin,
            &mut store::Unreadable::Keep(HashMap::new()),
        )
    }

    fn get_items_with(
        &self,
        ids: &[String],
        include_bin: bool,
        unreadable: &mut store::Unreadable,
    ) -> Result<Rows<(Item, Shown)>> {
        store::read_marked(&mut *self.conn()?, |conn, completeness| {
            let items = store::items_by_ids_with(conn, ids, unreadable)?;
            let catalog = Catalog::load(conn)?;
            Ok(Rows {
                rows: items
                    .into_iter()
                    .filter(|item| include_bin || item.state != ItemState::Trashed)
                    .collect(),
                completeness,
            }
            .map(|item| {
                let shown = catalog.shown_unreadable(&item, unreadable);
                (item, shown)
            }))
        })
    }

    /// Each edge the copy holds of `ids`, once each, in the order named; an
    /// id it does not hold is left out. Refused `HydrationIncomplete` where
    /// the copy is not whole, as every read of edges is.
    pub fn get_edges(&self, ids: &[String]) -> Result<Vec<Edge>> {
        store::read_usable(&mut *self.conn()?, |conn| {
            store::edges_by_ids_with(conn, ids, &mut store::Unreadable::Refuse)
        })
    }

    /// `get_edges`, but an edge whose stored properties cannot be read
    /// stays in the answer with no properties, beside why.
    pub fn get_edges_kept(&self, ids: &[String]) -> Result<Vec<(Edge, Option<String>)>> {
        store::read_usable(&mut *self.conn()?, |conn| {
            let mut unreadable = store::Unreadable::Keep(HashMap::new());
            let edges = store::edges_by_ids_with(conn, ids, &mut unreadable)?;
            Ok(edges
                .into_iter()
                .map(|edge| {
                    let why = unreadable.why(&edge.id);
                    (edge, why)
                })
                .collect())
        })
    }

    /// The edge the copy holds by `id`, or `None`. Refused
    /// `HydrationIncomplete` where the copy is not whole, as every read of
    /// edges is.
    pub fn get_edge(&self, id: &str) -> Result<Option<Edge>> {
        store::read_usable(&mut *self.conn()?, |conn| store::edge_by_id(conn, id))
    }

    /// `get_edge`, but an edge whose stored properties cannot be read is
    /// answered with no properties, beside why.
    pub fn get_edge_kept(&self, id: &str) -> Result<Option<(Edge, Option<String>)>> {
        store::read_usable(&mut *self.conn()?, |conn| {
            let mut unreadable = store::Unreadable::Keep(HashMap::new());
            let edge = store::edge_by_id_with(conn, id, &mut unreadable)?;
            Ok(edge.map(|edge| {
                let why = unreadable.why(&edge.id);
                (edge, why)
            }))
        })
    }

    /// `body_links` for each id, read against one catalog under one
    /// snapshot: each item the copy holds outside the bin, by id. An id
    /// `body_links` would refuse, one the copy does not hold, one in the bin
    /// or one whose stored properties cannot be read, is left out, so one
    /// such item does not refuse the rest. Refused `HydrationIncomplete`
    /// where the copy is not whole, as `body_links` is.
    pub fn body_links_of(&self, ids: &[String]) -> Result<HashMap<String, BodyLinks>> {
        store::read_usable(&mut *self.conn()?, |conn| {
            let mut damaged = store::Unreadable::Keep(HashMap::new());
            let items = store::items_by_ids_with(conn, ids, &mut damaged)?;
            let catalog = Catalog::load(conn)?;
            let bodies = Bodies::new(conn, &catalog);
            let mut answer = HashMap::with_capacity(items.len());
            for item in items {
                if item.state == ItemState::Trashed || damaged.why(&item.id).is_some() {
                    continue;
                }
                match bodies.read(&item) {
                    Ok(links) => {
                        answer.insert(item.id, links);
                    }
                    Err(error) if store::unreadable(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(answer)
        })
    }

    /// The items and edges that changed since `cursor`, a cursor an earlier
    /// call gave, with the cursor to pass next. Without a cursor, or with
    /// one from another store, from beyond what this copy has recorded, from
    /// before a change to the types or from before the removed edges it
    /// keeps a record of (`store::EDGE_CHANGES_KEPT`), or where more than
    /// `most` items or `most` edges changed, the answer is `everything`.
    ///
    /// An item is named when its row, its tags, an edge at it, its pin or a
    /// write queued for it changed, so a name may change nothing the caller
    /// shows. An item whose body links read differently only because another
    /// item changed, such as a link that starts to resolve when its target
    /// arrives, is not named. A caller takes the cursor before it reads what
    /// it shows, so a change made between the two is named again rather than
    /// missed, and keeps its earlier cursor until the reread of what an
    /// answer names succeeds: a reread refused `HydrationIncomplete` is made
    /// again from the earlier cursor once the copy is whole. Refused
    /// `HydrationIncomplete` where the copy is not whole, as every read of
    /// edges is, since what it names could not all be reread.
    pub fn changes_since(&self, cursor: Option<&str>, most: u32) -> Result<CopyChanges> {
        let since = cursor.map(Mark::parse).transpose()?;
        store::read_usable(&mut *self.conn()?, |conn| {
            changes_in(conn, since, most as usize)
        })
    }
}

fn changes_in(conn: &Connection, since: Option<Mark>, most: usize) -> Result<CopyChanges> {
    let now = Mark {
        store: store::store_id(conn)?,
        items: store::last_change(conn, Changes::Items)?,
        edges: store::last_change(conn, Changes::Edges)?,
    };
    let everything = || CopyChanges {
        cursor: now.render(),
        everything: true,
        items: Vec::new(),
        removed_items: Vec::new(),
        edges: Vec::new(),
        removed_edges: Vec::new(),
    };
    let floor = store::edge_changes_floor(conn)?;
    let Some(since) = since.filter(|since| {
        since.store == now.store
            && since.items <= now.items
            && (floor..=now.edges).contains(&since.edges)
    }) else {
        return Ok(everything());
    };
    let Some(items) = store::changed_since(conn, Changes::Items, since.items, most)? else {
        return Ok(everything());
    };
    let Some(edges) = store::changed_since(conn, Changes::Edges, since.edges, most)? else {
        return Ok(everything());
    };
    let (items, removed_items) = split_held(conn, "items", items)?;
    let (edges, removed_edges) = split_held(conn, "edges", edges)?;
    Ok(CopyChanges {
        cursor: now.render(),
        everything: false,
        items,
        removed_items,
        edges,
        removed_edges,
    })
}

/// The ids `table` holds and those it does not, each sorted. `table` is a
/// literal, never a caller's text.
fn split_held(
    conn: &Connection,
    table: &'static str,
    ids: HashSet<String>,
) -> Result<(Vec<String>, Vec<String>)> {
    let ids: Vec<String> = ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let named: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut held: HashSet<String> = HashSet::new();
    for (placeholders, chunk) in store::in_lists(&named) {
        let sql = format!("SELECT id FROM {table} WHERE id IN ({placeholders})");
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(chunk), |row| row.get::<_, String>(0))?;
        for row in rows {
            held.insert(row?);
        }
    }
    Ok(ids.into_iter().partition(|id| held.contains(id)))
}
