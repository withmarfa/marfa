use std::io::BufReader;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery};
use crate::model::{Draft, EdgeDraft, HydrateReport, Tier, WriteKind};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{EventPayload, WireEdge, WireEdgeBlock, WireItemWithMetadata};
use crate::{Core, Result};

const HEAD_ATTEMPTS: usize = 3;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn hydrate(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: Tier,
    edge_types: &[String],
    every_type: bool,
) -> Result<HydrateReport> {
    let types = if every_type && types.is_empty() {
        vec![store::EVERY_TYPE.to_string()]
    } else {
        declared_types(types)?
    };
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
    let catalog_rows = http.catalog()?;
    refuse_unreadable(http, &types)?;

    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::meta_set(&tx, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS)?;
        store::meta_delete(&tx, store::META_EVENT_CURSOR)?;
        store::clear_slice(&tx)?;
        store::replace_catalog(&tx, &catalog_rows)?;
        tx.commit()?;
    }
    let catalog = {
        let conn = core.conn()?;
        Catalog::load(&conn)?
    };

    let mut pages = 0u64;
    let listings: Vec<Option<&str>> = types
        .iter()
        .map(|declared| (declared != store::EVERY_TYPE).then_some(declared.as_str()))
        .collect();
    for declared in listings {
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
                store::put_server_item(&tx, &row.item, Some(&row.metadata.tags), &indexing)?;
                for block in row.item.edges.iter().flat_map(|blocks| blocks.values()) {
                    for edge in &block.data {
                        store::put_server_edge(&tx, edge)?;
                    }
                }
            }
            for edge in &overflow {
                store::put_server_edge(&tx, edge)?;
            }
            tx.commit()?;
            let Some(next) = page.next_cursor.clone() else {
                break;
            };
            // A server can report more while handing back the same cursor;
            // without this check a hydration spins forever.
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
                store::put_server_edge(&tx, edge)?;
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

    let pinned = store::pins(&*core.conn()?)?;
    for id in pinned {
        if store::item_held(&*core.conn()?, &id)? {
            continue;
        }
        let Some((row, edges)) = read_with_edges(http, &id)? else {
            continue;
        };
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        store::put_server_item(
            &tx,
            &row.item,
            Some(&row.metadata.tags),
            &catalog.indexing(&row.item.r#type),
        )?;
        for edge in &edges {
            store::put_server_edge(&tx, edge)?;
        }
        tx.commit()?;
    }

    let (items, edges) = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        lay_queue_over(&tx, &catalog, &edge_types)?;
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

/// The queue survives a hydration and the copy does not, so without this a
/// create still waiting is a row a local read no longer finds, and an edit
/// still waiting reads as undone.
fn lay_queue_over(conn: &rusqlite::Connection, catalog: &Catalog, whole: &[String]) -> Result<()> {
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
                if store::edge_by_id(conn, &id)?.is_none()
                    && store::takes_edge(conn, &draft.source_id, &draft.edge_type, whole)?
                {
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

/// The listing answers a type the key cannot read as one with no rows, so
/// the slice would hold none of it and say nothing. A wildcard may match
/// nothing, and a credential that is not a key cannot read its own map, so
/// both are taken as declared.
fn refuse_unreadable(http: &Http, types: &[String]) -> Result<()> {
    let named: Vec<&str> = types
        .iter()
        .map(String::as_str)
        .filter(|name| *name != store::EVERY_TYPE && !name.ends_with(".*"))
        .collect();
    if named.is_empty() {
        return Ok(());
    }
    let Some(key) = http.current_key()? else {
        return Ok(());
    };
    let unreadable: Vec<&str> = named
        .into_iter()
        .filter(|name| !crate::folder::placement::reads(&key, name))
        .collect();
    if unreadable.is_empty() {
        return Ok(());
    }
    Err(CoreError::Forbidden {
        code: "type_not_permitted".into(),
        message: format!(
            "this key cannot read {}, so a slice naming it would hold none of it: hydrate with a key that reads it, or leave it out",
            unreadable.join(", ")
        ),
    })
}

/// A comma is refused because the listing reads one as a list of types.
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

/// A row held at a later stamp came from an event since the read, and
/// stays.
pub(crate) fn hold_row(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    row: &WireItemWithMetadata,
    edges: &[WireEdge],
) -> Result<()> {
    let indexing = catalog.indexing(&row.item.r#type);
    if store::put_server_item(conn, &row.item, Some(&row.metadata.tags), &indexing)? {
        store::lay_waiting_writes_over(conn, &row.item.id, &|laid| catalog.indexing(laid))?;
    }
    for edge in edges {
        if store::put_server_edge(conn, edge)? {
            store::lay_waiting_edge_writes_over(conn, &edge.id)?;
        }
    }
    Ok(())
}

/// Fetched before any write so no transaction waits on the network.
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
        // A repeated cursor would loop forever.
        if page.next_cursor.as_deref() == Some(asked_for.as_str()) {
            return Err(CoreError::Decoding(
                "the server kept answering with the same cursor while reporting more edges".into(),
            ));
        }
        cursor = page.next_cursor;
    }
    Ok(edges)
}

/// Read before the first page so the snapshot has a resume point from before
/// it.
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
