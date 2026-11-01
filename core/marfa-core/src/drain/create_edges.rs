//! The edges a create was drawn with that its answer leaves out, read from
//! the item's edge listing as the create settles
//! (`device/create-edges-read-rest`). Until that read brings the server's
//! edge, the copy shows the edge under the id it made for it, which the
//! server never holds, so an edit or delete of it waits
//! (`device/edge-write-waits-projected`).

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use super::{Unreadable, names_no_row, unreadable};
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{Draft, QueuedWrite, projected_edge_id};
use crate::wire::{WireEdge, WireItem};
use crate::{Core, Result};
use crate::{reach, store, telemetry};

const OWED: &str = "create_edges/";

/// Given to an edit or delete of a shown edge that a whole read of the
/// item's edges did not bring (`device/create-edges-unread-refused`).
const NOT_READ: &str = "a whole read of the item's edges brought no edge this key can read in place of the one the create was shown with";

/// One edge type of a create's answer that a read still owes: from `cursor`
/// where the answer's block was cut, from the start where it carried none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Owed {
    edge_type: String,
    cursor: Option<String>,
    /// The targets the create named that the answer did not show an edge to.
    targets: Vec<String>,
}

fn key(item: &str) -> String {
    format!("{OWED}{item}")
}

/// In the transaction that settles `row`, the create answered with `item`:
/// records what a read of the item's edges still owes. The answer carries
/// one page of each type (`edges/hydrate-cap`), none for a type a source
/// filter leaves out (`edges/read-source-filter`), and none at all for a
/// repeat answered as acknowledged.
pub(super) fn owe(conn: &rusqlite::Connection, row: &QueuedWrite, item: &WireItem) -> Result<()> {
    let draft = Draft::from_payload(&store::payload_of(conn, &row.id)?)?;
    let mut owed: BTreeMap<String, Owed> = BTreeMap::new();
    for (edge_type, target) in draft.edge_pairs() {
        let cursor = match item.edges.as_ref().and_then(|edges| edges.get(&edge_type)) {
            None => None,
            Some(block) if block.data.iter().any(|edge| edge.target_id == target) => continue,
            // A whole block without the target says the server made none.
            Some(block) => match &block.next_cursor {
                None => continue,
                Some(cursor) => Some(cursor.clone()),
            },
        };
        owed.entry(edge_type.clone())
            .or_insert_with(|| Owed {
                edge_type,
                cursor,
                targets: Vec::new(),
            })
            .targets
            .push(target);
    }
    if owed.is_empty() {
        return store::meta_delete(conn, &key(&item.id));
    }
    let owed: Vec<Owed> = owed.into_values().collect();
    store::meta_set(conn, &key(&item.id), &serde_json::to_string(&owed)?)
}

/// Reads what [`owe`] recorded for `item` and takes the edges it brings. A
/// read the environment stops leaves the record for the next drain.
pub(super) fn read(core: &Core, item: &str) -> Result<()> {
    let (recorded, context) = {
        let conn = core.conn()?;
        (
            store::meta_get(&conn, &key(item))?,
            reach::Context::capture(&conn)?,
        )
    };
    let Some(recorded) = recorded else {
        return Ok(());
    };
    let owed: Vec<Owed> = serde_json::from_str(&recorded)?;
    let http = context.http(core.http()?);
    let mut read = Vec::with_capacity(owed.len());
    for block in &owed {
        match listing(&http, item, block) {
            Ok(edges) => read.push(edges),
            // The item is gone, or no longer one this key may read: neither
            // holds an edge the copy can name.
            Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => read.push(Vec::new()),
            Err(error) if names_no_row(&error) => read.push(Vec::new()),
            Err(error) => return Err(context.failed(core, error)?),
        }
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    context.check(&tx)?;
    // Taken by another drain since it was read.
    if store::meta_get(&tx, &key(item))?.as_deref() != Some(recorded.as_str()) {
        return Ok(());
    }
    for (block, edges) in owed.iter().zip(&read) {
        for edge in edges {
            store::take_server_edge(&tx, edge)?;
        }
        for target in &block.targets {
            if edges
                .iter()
                .any(|edge| edge.edge_type == block.edge_type && edge.target_id == *target)
            {
                continue;
            }
            let shown = projected_edge_id(item, &block.edge_type, target);
            store::forget_edge(&tx, &shown)?;
            store::refuse_edge_writes(&tx, &shown, NOT_READ)?;
        }
    }
    store::meta_delete(&tx, &key(item))?;
    tx.commit()?;
    Ok(())
}

/// Every read a record still owes, tried before the queue is sent. One the
/// environment stops ends the pass, as a read-back does.
pub(super) fn read_all(core: &Core, stop: &AtomicBool) -> Result<Option<Unreadable>> {
    let items = store::meta_keys(&*core.conn()?, OWED)?;
    for owed in items {
        crate::catch_up::refuse_if_stopped(stop)?;
        let item = &owed[OWED.len()..];
        match read(core, item) {
            Ok(()) => {}
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                return Ok(unreadable(&error).or_else(|| {
                    Some(Unreadable {
                        reason: error.to_string(),
                        retry_after_seconds: None,
                    })
                }));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

/// The listing of `block`'s type from `item`, from its cursor to the end.
fn listing(http: &Http, item: &str, block: &Owed) -> Result<Vec<WireEdge>> {
    let mut edges = Vec::new();
    let mut cursor = block.cursor.clone();
    let mut seen = HashSet::new();
    loop {
        let page = http.item_edges_page(item, &block.edge_type, cursor.as_deref())?;
        edges.extend(page.data);
        match page.next_cursor {
            None => return Ok(edges),
            // A repeated cursor would loop forever.
            Some(next) if !seen.insert(next.clone()) => return Err(reach::invalid()),
            Some(next) => cursor = Some(next),
        }
    }
}
