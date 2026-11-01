//! The edges a create was drawn with that its answer leaves out, read from
//! the item's edge listing as the create settles
//! (`device/create-edges-read-rest`). Until that read brings the server's
//! edge, the copy shows the edge under the id it made for it, which the
//! server never holds, so an edit or delete of it waits while the read is
//! owed (`device/edge-write-waits-projected`).

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use super::{Unreadable, ends_the_pass, names_no_row, unreadable};
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{Draft, QueuedWrite, WriteKind, projected_edge_id};
use crate::wire::{WireEdge, WireItem};
use crate::{Core, Result};
use crate::{reach, store, telemetry};

const OWED: &str = "create_edges/";

/// Given to an edit or delete of a shown edge that a whole read of the
/// item's edges did not bring (`device/create-edges-unread-refused`).
const NOT_READ: &str = "a whole read of the item's edges brought no edge this key can read in place of the one the create was shown with";

/// Given to an edit or delete of a shown edge whose read the server refused
/// for the request itself or answered with something the contract does not
/// describe (`device/create-edges-read-failed`).
const READ_FAILED: &str = "the read of the item's edges failed, so the device holds no id of the server's for the edge the create was shown with";

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
    // `None` for a read that failed for good: asking again would fail the
    // same way.
    let mut read = Vec::with_capacity(owed.len());
    for block in &owed {
        match listing(&http, item, block) {
            Ok(edges) => read.push(Some(edges)),
            // The item is gone, or no longer one this key may read: neither
            // holds an edge the copy can name.
            Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => {
                read.push(Some(Vec::new()));
            }
            Err(error) if names_no_row(&error) => read.push(Some(Vec::new())),
            Err(error) if error.is_environmental() || ends_the_pass(&error) => {
                return Err(context.failed(core, error)?);
            }
            Err(error) => {
                telemetry::degraded!(&error);
                read.push(None);
            }
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
        let Some(edges) = edges else {
            for target in &block.targets {
                keep_unread(&tx, item, &block.edge_type, target)?;
            }
            continue;
        };
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

/// The edge `item` was shown with to `target`, whose read failed for good:
/// each write waiting on it is refused unsent, and the edge stays shown as
/// the create drew it, since the server made it.
fn keep_unread(
    conn: &rusqlite::Connection,
    item: &str,
    edge_type: &str,
    target: &str,
) -> Result<()> {
    let shown = projected_edge_id(item, edge_type, target);
    store::refuse_edge_writes(conn, &shown, READ_FAILED)?;
    let held = store::edges_from(conn, item)?
        .into_iter()
        .any(|edge| edge.id != shown && edge.edge_type == edge_type && edge.target_id == target);
    if held {
        return Ok(());
    }
    let at = store::now_iso();
    store::upsert_edge(
        conn,
        &WireEdge {
            id: shown,
            source_id: item.to_string(),
            target_id: target.to_string(),
            edge_type: edge_type.to_string(),
            properties: Default::default(),
            version: 0,
            created_at: at.clone(),
            updated_at: at,
        },
    )
}

/// Whether `row` is an edit or delete of an edge shown under an id the copy
/// made, whose read is still owed (`device/edge-write-waits-projected`). An
/// untaken create holds its edges' writes as a dependency instead.
pub(super) fn waits(conn: &rusqlite::Connection, row: &QueuedWrite) -> Result<bool> {
    if !matches!(row.kind, WriteKind::UpdateEdge | WriteKind::DeleteEdge) {
        return Ok(false);
    }
    let (Some(item), Some(edge)) = (row.item_id.as_deref(), row.edge_id.as_deref()) else {
        return Ok(false);
    };
    let Some(recorded) = store::meta_get(conn, &key(item))? else {
        return Ok(false);
    };
    let owed: Vec<Owed> = serde_json::from_str(&recorded)?;
    Ok(owed.iter().any(|block| {
        block
            .targets
            .iter()
            .any(|target| projected_edge_id(item, &block.edge_type, target) == edge)
    }))
}

/// Whether any read is still owed, which a drain does with nothing queued.
pub(super) fn any_owed(conn: &rusqlite::Connection) -> Result<bool> {
    Ok(!store::meta_keys(conn, OWED)?.is_empty())
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
            Some(next) if !seen.insert(next.clone()) => {
                return Err(CoreError::Decoding(
                    "the item's edge listing named a cursor it had already given".into(),
                ));
            }
            Some(next) => cursor = Some(next),
        }
    }
}
