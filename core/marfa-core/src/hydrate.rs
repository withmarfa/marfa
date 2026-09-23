use std::io::BufReader;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery};
use crate::model::{Draft, EdgeDraft, HydrateReport, Tier, WriteKind};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{EventPayload, WireEdge, WireEdgeBlock};
use crate::{Core, Result};

const HEAD_ATTEMPTS: usize = 3;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn hydrate(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: Tier,
) -> Result<HydrateReport> {
    let types = declared_types(types)?;
    {
        let conn = core.conn()?;
        if let Some(expected) = store::meta_get(&conn, store::META_SERVER_ORIGIN)?
            && expected != http.origin()
        {
            return Err(CoreError::WrongServer {
                expected,
                got: http.origin(),
            });
        }
    }

    let cursor = read_head(http)?;
    let catalog_rows = http.types()?;

    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::meta_set(&tx, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS)?;
        store::meta_delete(&tx, store::META_EVENT_CURSOR)?;
        store::clear_slice(&tx)?;
        store::replace_types(&tx, &catalog_rows)?;
        tx.commit()?;
    }
    let catalog = {
        let conn = core.conn()?;
        Catalog::load(&conn)?
    };

    let mut edges = 0u64;
    let mut pages = 0u64;
    for declared in &types {
        let mut page_cursor: Option<String> = None;
        loop {
            let page = http.items_page(&ItemsQuery {
                r#type: declared,
                tier,
                cursor: page_cursor.as_deref(),
            })?;
            pages += 1;
            let mut overflow: Vec<WireEdge> = Vec::new();
            for row in &page.data {
                if let Some(blocks) = &row.item.edges {
                    for (edge_type, block) in blocks {
                        overflow.extend(fetch_overflow(http, &row.item.id, edge_type, block)?);
                    }
                }
            }
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            for row in &page.data {
                let title_field = catalog.title_field(&row.item.r#type);
                store::upsert_item(&tx, &row.item, Some(&row.metadata.tags), title_field)?;
                for block in row.item.edges.iter().flat_map(|blocks| blocks.values()) {
                    for edge in &block.data {
                        store::upsert_edge(&tx, edge)?;
                        edges += 1;
                    }
                }
            }
            for edge in &overflow {
                store::upsert_edge(&tx, edge)?;
                edges += 1;
            }
            tx.commit()?;
            let Some(next) = page.next_cursor.clone() else {
                break;
            };
            // A cursor that does not move is a server saying there is more
            // and handing back the same place to look. Without this a
            // hydration spins forever before the store is usable at all,
            // which is worse than the same shape in a drain: there is no
            // copy to fall back on and nothing has been written yet.
            let next = Some(next);
            if next == page_cursor {
                return Err(CoreError::Decoding(
                    "the server kept answering with the same cursor while reporting more items"
                        .into(),
                ));
            }
            page_cursor = next;
        }
    }

    let items = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        lay_queue_over(&tx, &catalog)?;
        store::meta_set(&tx, store::META_SERVER_ORIGIN, &http.origin())?;
        store::meta_set(
            &tx,
            store::META_SLICE_TYPES,
            &serde_json::to_string(&types)?,
        )?;
        store::meta_set(&tx, store::META_SLICE_TIER, tier.as_str())?;
        store::meta_set(&tx, store::META_EVENT_CURSOR, &cursor)?;
        store::meta_delete(&tx, store::META_HYDRATE_STATE)?;
        let items = store::count(&tx, "items")?;
        tx.commit()?;
        items
    };

    Ok(HydrateReport {
        types,
        tier,
        items,
        edges,
        pages,
        cursor,
    })
}

/// Puts the writes still waiting back into the copy a hydration has just
/// refilled (`queue-and-verdicts.md` 30, 35).
///
/// The queue survives a hydration and the copy does not, so without this a
/// create still waiting is a row a local read no longer finds, and an edit
/// still waiting reads as undone, while the queue goes on sending both.
fn lay_queue_over(conn: &rusqlite::Connection, catalog: &Catalog) -> Result<()> {
    let waiting = store::waiting_writes(conn)?;
    let mut items: Vec<&str> = Vec::new();
    let mut edges: Vec<&str> = Vec::new();
    for row in &waiting {
        match row.kind {
            WriteKind::CreateItem => {
                let (id, draft) = Draft::from_payload(&store::payload_of(conn, &row.id)?)?;
                if !store::item_held(conn, &id)? {
                    let mut wire = draft.wire(&id);
                    if draft.occurred_at.is_none() {
                        wire.occurred_at.clone_from(&row.queued_at);
                        wire.created_at.clone_from(&row.queued_at);
                        wire.updated_at.clone_from(&row.queued_at);
                    }
                    store::upsert_item(conn, &wire, Some(&[]), catalog.title_field(&draft.r#type))?;
                }
            }
            WriteKind::CreateEdge => {
                let (id, draft) = EdgeDraft::from_payload(&store::payload_of(conn, &row.id)?)?;
                if store::edge_by_id(conn, &id)?.is_none() {
                    let mut wire = draft.wire(&id);
                    wire.created_at.clone_from(&row.queued_at);
                    wire.updated_at.clone_from(&row.queued_at);
                    store::upsert_edge(conn, &wire)?;
                }
            }
            _ => {}
        }
        if let Some(id) = row.edge_id.as_deref() {
            if !edges.contains(&id) {
                edges.push(id);
            }
        } else if let Some(id) = row.item_id.as_deref()
            && !items.contains(&id)
        {
            items.push(id);
        }
    }
    for id in items {
        let Some(held) = store::item_by_id(conn, id)? else {
            continue;
        };
        store::lay_waiting_writes_over(conn, id, catalog.title_field(&held.r#type))?;
    }
    for id in edges {
        store::lay_waiting_edge_writes_over(conn, id)?;
    }
    Ok(())
}

fn declared_types(types: &[String]) -> Result<Vec<String>> {
    let mut declared = Vec::new();
    for raw in types {
        let name = raw.trim();
        if name.is_empty() || name == "*" || name.contains(char::is_whitespace) {
            return Err(CoreError::Invalid(format!(
                "not a type to declare: {raw:?}"
            )));
        }
        if !declared.iter().any(|seen| seen == name) {
            declared.push(name.to_string());
        }
    }
    if declared.is_empty() {
        return Err(CoreError::Invalid("declare at least one type".into()));
    }
    Ok(declared)
}

/// The edges an inline block could not carry, fetched before any write so no
/// transaction waits on the network.
fn fetch_overflow(
    http: &Http,
    item_id: &str,
    edge_type: &str,
    block: &WireEdgeBlock,
) -> Result<Vec<WireEdge>> {
    let mut edges = Vec::new();
    let mut cursor = block.next_cursor.clone();
    while let Some(asked_for) = cursor {
        let page = http.item_edges_page(item_id, edge_type, Some(&asked_for))?;
        edges.extend(page.data);
        // Same reason as the item pages above: a repeated cursor is an
        // unbounded loop, and this one runs per item of the slice.
        if page.next_cursor.as_deref() == Some(asked_for.as_str()) {
            return Err(CoreError::Decoding(
                "the server kept answering with the same cursor while reporting more edges".into(),
            ));
        }
        cursor = page.next_cursor;
    }
    Ok(edges)
}

/// The event log's head at this moment, so the snapshot about to be taken has
/// a resume point from before its first page.
fn read_head(http: &Http) -> Result<String> {
    for _ in 0..HEAD_ATTEMPTS {
        let reader = http.open_events(None, &[], HEAD_READ_TIMEOUT)?;
        let mut frames = Frames::new(BufReader::new(reader));
        loop {
            match frames.next_frame() {
                Ok(Some(Frame::Comment(_))) => continue,
                Ok(Some(Frame::Event { name, data, .. })) => {
                    if name.as_deref() == Some("stream_cursor")
                        && let Ok(payload) = serde_json::from_str::<EventPayload>(&data)
                        && let Some(cursor) = payload.cursor
                    {
                        return Ok(cursor);
                    }
                    break;
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    Err(CoreError::NoCursor)
}
