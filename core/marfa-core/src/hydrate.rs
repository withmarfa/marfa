use std::io::BufReader;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery, Registration};
use crate::model::{Draft, EdgeDraft, HydrateReport, SliceTier, UnregisteredType, WriteKind};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{WireCatalog, WireEdge, WireEdgeBlock, WireItemWithMetadata};
use crate::{Core, Result};

const HEAD_ATTEMPTS: usize = 3;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn hydrate(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    every_type: bool,
    stop: &AtomicBool,
) -> Result<HydrateReport> {
    let previous = crate::read_view::Context::capture_build(&*core.conn()?).ok();
    let result = hydrate_inner(core, http, types, tier, edge_types, every_type, stop);
    let result = result.map_err(|error| match previous {
        Some(context) => context.failed(core, error).unwrap_or_else(|error| error),
        None => error,
    });
    crate::catch_up::unless_stopped(result, stop)
}

fn hydrate_inner(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    every_type: bool,
    stop: &AtomicBool,
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

    // Nothing is cleared until the copy is about to be replaced, so a stop
    // raised before then leaves it as it was.
    crate::catch_up::refuse_if_stopped(stop)?;
    let (mut instance, mut cursor, mut fence) = read_head(http, stop)?;
    let mut view = http.for_view(&fence);
    crate::catch_up::refuse_if_stopped(stop)?;
    let (mut catalog_rows, registered_types, unregistered_types, registered_any) =
        register_declared(core, &view, view.catalog()?, stop)?;
    if registered_any {
        // A registration changes what the instance's read view certifies, so
        // the head and the catalog read before it are of a view that has gone.
        (instance, cursor, fence) = read_head(http, stop)?;
        view = http.for_view(&fence);
        catalog_rows = view.catalog()?;
    }
    let http = &view;
    {
        let mut conn = core.conn()?;
        if store::hydrated(&conn)?
            && (store::meta_get(&conn, crate::read_view::FENCE)?.as_deref() != Some(&fence)
                || store::meta_get(&conn, store::META_INSTANCE_ID)?.as_deref() != Some(&instance))
        {
            let tx = conn.transaction()?;
            crate::read_view::expire(&tx)?;
            tx.commit()?;
        }
    }
    refuse_unreadable(http, &types, tier, &catalog_rows)?;
    refuse_unheld(&catalog_rows, &types, &edge_types)?;
    crate::catch_up::refuse_if_stopped(stop)?;
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        crate::read_view::advance_generation(&tx)?;
        store::meta_set(&tx, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS)?;
        store::meta_set(&tx, store::META_EVENT_CURSOR, &cursor)?;
        store::meta_set(&tx, crate::read_view::FENCE, &fence)?;
        store::meta_set(&tx, store::META_INSTANCE_ID, &instance)?;
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
        store::clear_slice(&tx)?;
        store::replace_catalog(&tx, &catalog_rows)?;
        tx.commit()?;
    }
    let context = crate::read_view::Context::capture_build(&*core.conn()?)?;
    let result = (|| {
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
            let mut seen = std::collections::HashSet::new();
            loop {
                crate::catch_up::refuse_if_stopped(stop)?;
                let page = http.items_page(&ItemsQuery {
                    r#type: declared,
                    tier: listed_tier(declared, tier),
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
                context.check(&tx)?;
                for row in &page.data {
                    crate::read_view::set_listed(
                        &tx,
                        &row.item.id,
                        row.listed.ok_or_else(crate::read_view::invalid)?,
                    )?;
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
                if !seen.insert(next.clone()) {
                    return Err(crate::read_view::invalid());
                }
                page_cursor = next;
            }
        }

        for edge_type in &edge_types {
            let mut page_cursor: Option<String> = None;
            let mut seen = std::collections::HashSet::new();
            loop {
                crate::catch_up::refuse_if_stopped(stop)?;
                let page = http.edges_page(edge_type, page_cursor.as_deref())?;
                pages += 1;
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                context.check(&tx)?;
                for edge in &page.data {
                    store::put_server_edge(&tx, edge)?;
                }
                tx.commit()?;
                // Rows the key cannot read leave a page short or empty, not last.
                let Some(next) = page.next_cursor else {
                    break;
                };
                if !seen.insert(next.clone()) {
                    return Err(crate::read_view::invalid());
                }
                page_cursor = Some(next);
            }
        }

        let pinned = store::pins(&*core.conn()?)?;
        for id in pinned {
            crate::catch_up::refuse_if_stopped(stop)?;
            if store::item_held(&*core.conn()?, &id)? {
                continue;
            }
            let Some((row, edges)) = read_with_edges(http, &id)? else {
                continue;
            };
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            crate::read_view::set_listed(
                &tx,
                &row.item.id,
                row.listed.ok_or_else(crate::read_view::invalid)?,
            )?;
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

        let replay = crate::catch_up::replay_build(core, http, &context, core.catch_up_idle, stop)?;
        let cursor = replay.cursor;
        let (items, edges) = {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let catalog = Catalog::load(&tx)?;
            lay_queue_over(&tx, &catalog, &edge_types)?;
            store::meta_delete(&tx, store::META_HYDRATE_STATE)?;
            let counts = (store::count(&tx, "items")?, store::count(&tx, "edges")?);
            tx.commit()?;
            counts
        };

        Ok(HydrateReport {
            types: types.clone(),
            tier,
            edge_types: edge_types.clone(),
            items,
            edges,
            pages,
            cursor,
            registered_types: registered_types.clone(),
            unregistered_types: unregistered_types.clone(),
        })
    })();
    result.map_err(|error| context.failed(core, error).unwrap_or_else(|error| error))
}

/// The queue survives a hydration and the copy does not, so without this a
/// create still waiting is a row a local read no longer finds, and an edit
/// still waiting reads as undone.
pub(crate) fn lay_queue_over(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    whole: &[String],
) -> Result<()> {
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
                    // A keyed create sent with no tier lands on the row its
                    // key names, at that row's tier.
                    if draft.tier.is_none()
                        && let (Some(source), Some(source_id)) = (&draft.source, &draft.source_id)
                        && let Some(held) = store::item_under_key(conn, source, source_id)?
                    {
                        wire.tier = held.tier.map(|tier| tier.as_str().into());
                    }
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

/// Registers on the instance the types the app declared that it does not
/// hold, parents before their children, and says whether any registration
/// changed what the instance holds, which leaves the catalog and the head the
/// caller read stale. A key that may not register is no reason to refuse the
/// hydration: what it queued waits for the server's verdict like any write.
fn register_declared(
    core: &Core,
    http: &Http,
    catalog: WireCatalog,
    stop: &AtomicBool,
) -> Result<(WireCatalog, Vec<String>, Vec<UnregisteredType>, bool)> {
    let mut missing: Vec<(String, String)> = {
        let conn = core.conn()?;
        store::declared_type_rows(&conn)?
    };
    missing.retain(|(id, _)| !catalog.types.iter().any(|held| &held.id == id));
    let mut registered = Vec::new();
    let mut refused: Vec<UnregisteredType> = Vec::new();
    let mut taken = false;
    while !missing.is_empty() {
        crate::catch_up::refuse_if_stopped(stop)?;
        // A type whose parent is still to come waits for it. Only parents
        // that name each other leave none to go, and then the first goes and
        // the server answers it.
        let next = missing
            .iter()
            .position(|(_, json)| {
                let parent = serde_json::from_str::<serde_json::Value>(json)
                    .ok()
                    .and_then(|row| row.get("parent")?.as_str().map(str::to_string));
                parent.is_none_or(|parent| !missing.iter().any(|(id, _)| *id == parent))
            })
            .unwrap_or(0);
        let (id, json) = missing.remove(next);
        match http.register_type(&json)? {
            Registration::Registered => {
                registered.push(id);
                taken = true;
            }
            Registration::Held => taken = true,
            Registration::Refused { code, message } => {
                refused.push(UnregisteredType { id, code, message })
            }
        }
    }
    Ok((catalog, registered, refused, taken))
}

/// What a type is, said where a name is refused for breaking the grammar.
pub(crate) const GRAMMAR: &str = "a type is two or more lowercase dotted segments, each a letter followed by letters, digits, hyphens and underscores, at most 128 characters, with exactly three under `app.` and none under a root Marfa reserves";

/// The server's type pattern grammar (`types/id-grammar` and
/// `types/id-reserved-scope-root`): a type identifier, or a namespace under
/// `.*`. The bare `*` is no pattern here; each caller says what it means.
pub(crate) fn type_pattern(name: &str) -> Result<bool> {
    let segment = |part: &str| {
        let mut characters = part.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
            && characters.all(|rest| {
                rest.is_ascii_lowercase() || rest.is_ascii_digit() || rest == '-' || rest == '_'
            })
    };
    if name.len() > 128 {
        return Ok(false);
    }
    // A wildcard's root is a namespace, held to the segments alone.
    if let Some(root) = name.strip_suffix(".*") {
        return Ok(!root.is_empty() && root.split('.').all(segment));
    }
    let segments: Vec<&str> = name.split('.').collect();
    if segments.len() < 2 || !segments.iter().all(|part| segment(part)) {
        return Ok(false);
    }
    Ok(match segments[0] {
        "app" => segments.len() == 3,
        "core" | "system" | "user" | "marfa" => true,
        root => !crate::builtin::reserved_type_roots()?
            .iter()
            .any(|reserved| reserved == root),
    })
}

/// A `system.*` type is listed at both tiers, as the slice takes it
/// (`store::slice_takes`).
fn listed_tier(declared: Option<&str>, tier: SliceTier) -> SliceTier {
    match declared {
        Some(declared) if store::is_system(declared) => SliceTier::All,
        _ => tier,
    }
}

fn declared_types(types: &[String]) -> Result<Vec<String>> {
    let mut declared = Vec::new();
    for raw in types {
        let name = raw.trim();
        if !type_pattern(name)? {
            return Err(CoreError::Invalid(format!(
                "not a type to declare: {raw:?}; {GRAMMAR}, or a namespace under .*"
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

/// The listing refuses a type the credential cannot read `403
/// type_not_permitted`, but only once the copy has been cleared, so it is
/// refused here first, whatever the credential. A key's own map says which
/// types it reads. A credential that is not a key cannot read its own map, so
/// the first page of each named type is asked for instead and the listing's
/// refusal is taken as the answer. A wildcard may match nothing, so it is
/// taken as declared.
///
/// A named type is readable when the credential reads it or any type under
/// it, because the server serves a named type's readable descendants and
/// refuses it only when nothing it selects is readable.
fn refuse_unreadable(
    http: &Http,
    types: &[String],
    tier: SliceTier,
    catalog: &WireCatalog,
) -> Result<()> {
    let named: Vec<&str> = types
        .iter()
        .map(String::as_str)
        .filter(|name| *name != store::EVERY_TYPE && !name.ends_with(".*"))
        .collect();
    if named.is_empty() {
        return Ok(());
    }
    let unreadable: Vec<&str> = match http.current_key()? {
        Some(key) => named
            .into_iter()
            .filter(|name| !reads_under(&key, name, catalog))
            .collect(),
        None => {
            let mut refused = Vec::new();
            for name in named {
                let probe = http.items_page(&ItemsQuery {
                    r#type: Some(name),
                    tier: listed_tier(Some(name), tier),
                    cursor: None,
                });
                match probe {
                    Err(CoreError::Forbidden { code, .. }) if code == "type_not_permitted" => {
                        refused.push(name);
                    }
                    Err(error) => return Err(error),
                    Ok(_) => {}
                }
            }
            refused
        }
    };
    if unreadable.is_empty() {
        return Ok(());
    }
    Err(CoreError::Forbidden {
        code: "type_not_permitted".into(),
        message: format!(
            "this credential cannot read {}, nor any type under it, so a slice naming it would hold none of it: hydrate with a credential that reads it, or leave it out",
            unreadable.join(", ")
        ),
    })
}

/// Whether the key reads `name` or a type the catalog places under it, by
/// its name or by a declared parent.
fn reads_under(key: &serde_json::Value, name: &str, catalog: &WireCatalog) -> bool {
    use crate::folder::placement::reads;
    reads(key, name)
        || catalog.types.iter().any(|candidate| {
            candidate.id != name && under(catalog, &candidate.id, name) && reads(key, &candidate.id)
        })
}

fn under(catalog: &WireCatalog, id: &str, root: &str) -> bool {
    if id.starts_with(&format!("{root}.")) {
        return true;
    }
    let mut current = id;
    for _ in 0..64 {
        let Some(parent) = catalog
            .types
            .iter()
            .find(|entry| entry.id == current)
            .and_then(|entry| entry.parent.as_deref())
        else {
            return false;
        };
        if parent == root {
            return true;
        }
        current = parent;
    }
    false
}

/// Checked against the catalog just read, before the copy is cleared: the
/// listing refuses a type nobody registered only once the copy is gone.
fn refuse_unheld(catalog: &WireCatalog, types: &[String], edge_types: &[String]) -> Result<()> {
    if let Some(unheld) = types.iter().find(|name| {
        *name != store::EVERY_TYPE
            && !name.ends_with(".*")
            && !catalog.types.iter().any(|held| &held.id == *name)
    }) {
        return Err(CoreError::UnknownType {
            message: format!(
                "the server holds no type {unheld}, so a slice naming it would hold none of it: register it, or leave it out"
            ),
        });
    }
    if let Some(unheld) = edge_types.iter().find(|name| {
        !catalog
            .edge_types
            .iter()
            .any(|held| held.get("id").and_then(|id| id.as_str()) == Some(name.as_str()))
    }) {
        return Err(CoreError::UnknownType {
            message: format!(
                "the server holds no edge type {unheld}, so a slice holding it whole would hold none of it: register it, or leave it out"
            ),
        });
    }
    Ok(())
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
    crate::read_view::set_listed(
        conn,
        &row.item.id,
        row.listed.ok_or_else(crate::read_view::invalid)?,
    )?;
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
    let mut seen = std::collections::HashSet::new();
    while let Some(asked_for) = cursor {
        if !seen.insert(asked_for.clone()) {
            return Err(crate::read_view::invalid());
        }
        let page = http.item_edges_page(item_id, edge_type, Some(&asked_for))?;
        edges.extend(page.data);
        // A repeated cursor would loop forever.
        if page.next_cursor.as_deref() == Some(asked_for.as_str()) {
            return Err(crate::read_view::invalid());
        }
        cursor = page.next_cursor;
    }
    Ok(edges)
}

/// Read before the first page so the snapshot has a resume point from before
/// it.
fn read_head(http: &Http, stop: &AtomicBool) -> Result<(String, String, String)> {
    for _ in 0..HEAD_ATTEMPTS {
        crate::catch_up::refuse_if_stopped(stop)?;
        let reader = crate::catch_up::read_unless_stopped(stop, http, |http| {
            http.open_events(None, HEAD_READ_TIMEOUT)
        })?;
        let mut frames = Frames::new(BufReader::new(reader));
        loop {
            crate::catch_up::refuse_if_stopped(stop)?;
            let frame = frames.next_frame();
            crate::catch_up::refuse_if_stopped(stop)?;
            match frame {
                Ok(Some(Frame::Comment(_))) => continue,
                Ok(Some(Frame::Event { id, name, data })) => {
                    let payload =
                        crate::read_view::event_payload(name.as_deref(), id.as_deref(), &data)?;
                    if id.is_some() || name.as_deref() != Some(payload.event_type.as_str()) {
                        return Err(crate::read_view::invalid());
                    }
                    if payload.event_type == "stream_incomplete" {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    if payload.event_type == "read_view_changed" {
                        return Err(CoreError::CopyExpired {
                            reason: "read_view_changed".into(),
                        });
                    }
                    if payload.event_type != "stream_cursor" {
                        return Err(crate::read_view::invalid());
                    }
                    let cursor = payload.cursor.ok_or_else(crate::read_view::invalid)?;
                    let instance = payload
                        .instance_id
                        .filter(|s| !s.is_empty())
                        .ok_or_else(crate::read_view::invalid)?;
                    let fence = payload
                        .read_view
                        .filter(|s| crate::read_view::valid_fence(s))
                        .ok_or_else(crate::read_view::invalid)?;
                    crate::read_view::cursor(&cursor).ok_or_else(crate::read_view::invalid)?;
                    return Ok((instance, cursor, fence));
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    Err(CoreError::StreamIncomplete {
        reason: "replay_failed".into(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use crate::scripted::{self, Scripted};
    use crate::stop_tests::copy;
    use crate::{CoreError, SliceTier, store};

    /// A credential that is not a key cannot read its own map, so the device
    /// cannot tell before listing whether it may read a type. The listing's
    /// refusal has to arrive before the copy is cleared, or the old slice,
    /// its declaration and the queue are gone and the copy stays empty.
    #[test]
    fn a_type_a_non_key_credential_may_not_read_is_refused_before_anything_is_cleared() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/types",
            vec![scripted::certified(scripted::types(&[
                ("core.note", None),
                ("core.bookmark", None),
            ]))],
        );
        server.on(
            "/keys/current",
            vec![scripted::certified(scripted::refusal(403, "forbidden"))],
        );
        server.on(
            "/items",
            vec![
                scripted::certified(scripted::json(200, r#"{"data":[],"next_cursor":null}"#)),
                scripted::certified(scripted::refusal(403, "type_not_permitted")),
            ],
        );
        core.create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::from_value(serde_json::json!({
                "title": "queued before hydration",
                "body": "keep this save"
            }))
            .unwrap(),
            ..Default::default()
        })
        .unwrap();
        let queue = core.queue().unwrap();
        let before = core.status().unwrap();

        let refused = core
            .hydrate_until(
                &["core.note".into(), "core.bookmark".into()],
                SliceTier::Library,
                &[],
                &AtomicBool::new(false),
            )
            .unwrap_err();
        match refused {
            CoreError::Forbidden { code, message } => {
                assert_eq!(code, "type_not_permitted");
                assert!(message.contains("core.bookmark"), "{message}");
                assert!(!message.contains("core.note,"), "{message}");
            }
            other => panic!("expected the listing's refusal, got {other:?}"),
        }

        assert_eq!(core.queue().unwrap(), queue, "the queue was touched");
        let after = core.status().unwrap();
        assert_eq!(after.slice_types, before.slice_types);
        assert_eq!(after.hydration, before.hydration);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::meta_get(&conn, store::META_HYDRATE_STATE).unwrap(),
            None,
            "the copy was left mid-hydration"
        );
        assert_eq!(
            store::meta_get(&conn, store::META_SLICE_TYPES)
                .unwrap()
                .as_deref(),
            Some("[\"core.note\"]"),
            "the slice declaration was overwritten"
        );
    }

    /// The server serves a named type's readable descendants, so a key that
    /// reads only a type under the one declared is not refused for it.
    #[test]
    fn a_key_that_reads_only_a_descendant_of_a_declared_type_hydrates_it() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/types",
            vec![scripted::certified(scripted::types(&[
                ("core.note", None),
                ("core.entity", None),
                ("core.entity.person", Some("core.entity")),
                ("acme.contact", Some("core.entity")),
            ]))],
        );
        for readable in ["core.entity.person", "acme.contact"] {
            server.on(
                "/keys/current",
                vec![scripted::certified(scripted::json(
                    200,
                    &format!(
                        r#"{{"type_permissions":{{"core.note":"read","{readable}":"read"}}}}"#
                    ),
                ))],
            );
            server.on(
                "/items",
                vec![scripted::certified(scripted::json(
                    200,
                    r#"{"data":[],"next_cursor":null}"#,
                ))],
            );
            let listed = server.seen("/items").len();
            let hydrated = core.hydrate_until(
                &["core.note".into(), "core.entity".into()],
                SliceTier::Library,
                &[],
                &AtomicBool::new(false),
            );
            // Past the refusal: what the scripted stream does after that is
            // not this test's subject, the listing being asked is.
            assert!(
                !matches!(hydrated, Err(CoreError::Forbidden { .. })),
                "{readable}: {hydrated:?}"
            );
            assert!(
                server.seen("/items").len() > listed,
                "{readable}: no page was asked for"
            );
        }

        server.on(
            "/keys/current",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        match core.hydrate_until(
            &["core.note".into(), "core.entity".into()],
            SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        ) {
            Err(CoreError::Forbidden { code, message }) => {
                assert_eq!(code, "type_not_permitted");
                assert!(message.contains("core.entity"), "{message}");
                assert!(!message.contains("core.note,"), "{message}");
            }
            other => panic!("a key reading nothing under the type was not refused: {other:?}"),
        }
    }
}
