use std::io::BufReader;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery};
use crate::model::{Draft, EdgeDraft, HydrateReport, Subject, Tier, WriteKind};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{EventPayload, WireEdge, WireEdgeBlock, WireItemWithMetadata};
use crate::{Core, Result};

const HEAD_ATTEMPTS: usize = 3;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);

/// Fills the copy with the declared slice, read after a head read so the
/// snapshot has a resume point from before its first page: its types at its
/// tier, every edge of `edge_types` the key reads, and the pinned rows, each
/// read again (`device.md` 1).
///
/// The copy is cleared once the head read and the catalog are in, before
/// the first page. A head read or a catalog on another contract is refused
/// before anything is cleared. A page on another contract is refused after
/// it: the copy holds only the pages read before that one, so a
/// re-hydration refused on its first page leaves it empty, and it refuses
/// reads with `hydration_incomplete` until a hydration completes. Nothing
/// the refused page carried is applied (`device.md` 42).
pub(crate) fn hydrate(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: Tier,
    edge_types: &[String],
) -> Result<HydrateReport> {
    let types = declared_types(types)?;
    let edge_types = declared_edge_types(edge_types)?;
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
                let indexing = catalog.indexing(&row.item.r#type);
                store::upsert_item(&tx, &row.item, Some(&row.metadata.tags), &indexing)?;
                for block in row.item.edges.iter().flat_map(|blocks| blocks.values()) {
                    for edge in &block.data {
                        store::upsert_edge(&tx, edge)?;
                    }
                }
            }
            for edge in &overflow {
                store::upsert_edge(&tx, edge)?;
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

    for edge_type in &edge_types {
        let mut page_cursor: Option<String> = None;
        loop {
            let page = http.edges_page(edge_type, page_cursor.as_deref())?;
            pages += 1;
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            for edge in &page.data {
                store::upsert_edge(&tx, edge)?;
            }
            tx.commit()?;
            // Rows the key cannot read leave a page short or empty, not last.
            let Some(next) = page.next_cursor else {
                break;
            };
            if page_cursor.as_deref() == Some(next.as_str()) {
                return Err(CoreError::Decoding(
                    "the server kept answering with the same cursor while reporting more edges"
                        .into(),
                ));
            }
            page_cursor = Some(next);
        }
    }

    // Read after the pages, so a pin made while they were read is kept too.
    let pinned = store::pins(&*core.conn()?)?;
    for id in pinned {
        if store::item_held(&*core.conn()?, &id)? {
            continue;
        }
        // A pinned row the server does not hold stays pinned and holds
        // nothing until an event brings it.
        let Some((row, edges)) = read_with_edges(http, &id)? else {
            continue;
        };
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::upsert_item(
            &tx,
            &row.item,
            Some(&row.metadata.tags),
            &catalog.indexing(&row.item.r#type),
        )?;
        for edge in &edges {
            store::upsert_edge(&tx, edge)?;
        }
        tx.commit()?;
    }

    let (items, edges) = {
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
        store::meta_set(
            &tx,
            store::META_SLICE_EDGE_TYPES,
            &serde_json::to_string(&edge_types)?,
        )?;
        store::meta_set(&tx, store::META_EVENT_CURSOR, &cursor)?;
        store::meta_delete(&tx, store::META_HYDRATE_STATE)?;
        let counts = (store::count(&tx, "items")?, store::count(&tx, "edges")?);
        tx.commit()?;
        counts
    };

    Ok(HydrateReport {
        types,
        tier,
        edge_types,
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
                let draft = Draft::from_payload(&store::payload_of(conn, &row.id)?)?;
                let Some(id) = row.item_id.clone() else {
                    return Err(CoreError::Store(format!(
                        "the queued create {} names no item, so its row cannot be held",
                        row.id
                    )));
                };
                if !store::item_held(conn, &id)? {
                    let mut wire = draft.wire(&id);
                    if draft.occurred_at.is_none() {
                        wire.occurred_at.clone_from(&row.queued_at);
                        wire.created_at.clone_from(&row.queued_at);
                        wire.updated_at.clone_from(&row.queued_at);
                    }
                    store::upsert_item(conn, &wire, Some(&[]), &catalog.indexing(&draft.r#type))?;
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
        store::lay_waiting_writes_over(conn, id, &|laid| catalog.indexing(laid))?;
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

/// Edge types to hold whole, each named once. A comma is refused because the
/// listing reads one as a list of types.
fn declared_edge_types(edge_types: &[String]) -> Result<Vec<String>> {
    let mut declared: Vec<String> = Vec::new();
    for raw in edge_types {
        let name = raw.trim();
        if name.is_empty()
            || name == "*"
            || name.contains(char::is_whitespace)
            || name.contains(',')
        {
            return Err(CoreError::Invalid(format!(
                "not an edge type to hold whole: {raw:?}"
            )));
        }
        if !declared.iter().any(|seen| seen == name) {
            declared.push(name.to_string());
        }
    }
    Ok(declared)
}

/// One row by id with every edge it draws, overflow included, read outside
/// any transaction. `None` where the server holds no such row.
pub(crate) fn read_with_edges(
    http: &Http,
    id: &str,
) -> Result<Option<(WireItemWithMetadata, Vec<WireEdge>)>> {
    let Some(read) = http.item_with_edges(id)? else {
        return Ok(None);
    };
    let mut edges = Vec::new();
    for (edge_type, block) in read.item.edges.iter().flatten() {
        edges.extend(block.data.iter().cloned());
        edges.extend(fetch_overflow(http, id, edge_type, block)?);
    }
    Ok(Some((read, edges)))
}

/// Writes a row read by id and its edges, waiting writes laid back over them;
/// one held at a later version came from an event since the read, and stays.
pub(crate) fn hold_row(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    row: &WireItemWithMetadata,
    edges: &[WireEdge],
) -> Result<()> {
    if !store::holds_newer(conn, Subject::Item, &row.item.id, row.item.version)? {
        let indexing = catalog.indexing(&row.item.r#type);
        store::upsert_item(conn, &row.item, Some(&row.metadata.tags), &indexing)?;
        store::lay_waiting_writes_over(conn, &row.item.id, &|laid| catalog.indexing(laid))?;
    }
    for edge in edges {
        if !store::holds_newer(conn, Subject::Edge, &edge.id, edge.version)? {
            store::upsert_edge(conn, edge)?;
            store::lay_waiting_edge_writes_over(conn, &edge.id)?;
        }
    }
    Ok(())
}

/// The edges an inline block could not carry, fetched before any write so no
/// transaction waits on the network.
pub(crate) fn fetch_overflow(
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
        let reader = http.open_events(None, HEAD_READ_TIMEOUT)?;
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
