use std::io::BufReader;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery};
use crate::model::{HydrateReport, Tier};
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
                    for edge in &block.edges {
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
            if !page.has_more {
                break;
            }
            page_cursor = page.cursor.clone();
            if page_cursor.is_none() {
                return Err(CoreError::Decoding(
                    "the server said has_more without a cursor".into(),
                ));
            }
        }
    }

    let items = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
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
    let mut has_more = block.has_more;
    let mut cursor = block.next_cursor.clone();
    while has_more {
        let Some(page_cursor) = cursor.as_deref() else {
            return Err(CoreError::Decoding(
                "the server said has_more without a cursor".into(),
            ));
        };
        let page = http.item_edges_page(item_id, edge_type, Some(page_cursor))?;
        edges.extend(page.data);
        has_more = page.has_more;
        cursor = page.cursor;
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
