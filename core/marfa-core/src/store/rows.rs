//! Writing the rows the copy holds, and taking them out.

use super::Cached;
use super::attachments::{attachments_before, attachments_changed};
use super::index::{index_row, reindex_item};
use super::laying::{readdress_edge_writes, record_refusal};
use super::marks::{item_held, pinned, purged_key, unpin};
use super::meta::{META_SLICE_EDGE_TYPES, meta_get, meta_set};
use super::queue::{edge_write_waits, read_writes, refollow, waiting_writes};
use super::reads::edge_ends;
use super::stamps::{beneath_row, drop_beneath, keep_beneath_item, settle_read_back};
use super::verdicts::{Answered, payload_of, record_verdict};
use crate::error::CoreError;
use crate::model::{BlockedReason, ItemState, QueuedWrite, Subject, Verdict, WriteKind};
use crate::wire::{WireEdge, WireItem};
use marfa_rules::catalog::Indexing;
use marfa_rules::number;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::Value;

/// `tags` replaces the item's tags when given and leaves them alone when not.
pub fn upsert_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    indexing: &Indexing,
) -> Result<(), CoreError> {
    ItemState::from_str_checked(&item.state)?;
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, &item.id, Some(item))?;
    let before = attachments_before(conn, &[&item.id])?;
    conn.prepare_cached(
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id, occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude, trashed_at, read_only)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, state = excluded.state, tier = excluded.tier,
           version = excluded.version, schema_version = excluded.schema_version,
           source = excluded.source, source_id = excluded.source_id,
           occurred_at = excluded.occurred_at, created_at = excluded.created_at,
           updated_at = excluded.updated_at, properties = excluded.properties,
           capture_latitude = excluded.capture_latitude,
           capture_longitude = excluded.capture_longitude,
           trashed_at = excluded.trashed_at,
           read_only = excluded.read_only",
    )?
    .execute(params![
            item.id,
            item.r#type,
            item.state,
            item.tier,
            item.version,
            item.schema_version,
            item.source,
            item.source_id,
            item.occurred_at,
            item.created_at,
            item.updated_at,
            number::object(&item.properties),
            item.capture_latitude,
            item.capture_longitude,
            item.trashed_at,
            item.read_only,
    ])?;
    if let Some(tags) = tags {
        conn.prepare_cached("DELETE FROM tags WHERE item_id = ?1")?
            .execute([&item.id])?;
        let mut insert = conn.prepare_cached(
            "INSERT OR IGNORE INTO tags (item_id, tag, position) VALUES (?1, ?2, ?3)",
        )?;
        for (position, tag) in (0_i64..).zip(tags) {
            insert.execute(params![item.id, tag, position])?;
        }
    }
    let seq: i64 = conn
        .prepare_cached("SELECT seq FROM items WHERE id = ?1")?
        .query_row([&item.id], |row| row.get(0))?;
    index_row(conn, seq, &item.id, &item.state, &item.properties, indexing)?;
    attachments_changed(conn, &[&item.id], before)
}

/// Moves everything the copy says about the minted id `local` onto
/// `answered`, the id the server answered its create with: a create carrying
/// a natural key the server holds lands on that row.
pub fn adopt_answered_id(conn: &Connection, local: &str, answered: &str) -> Result<(), CoreError> {
    if local == answered {
        return Ok(());
    }
    let before = attachments_before(conn, &[local, answered])?;
    rename_shown_edges(conn, local, answered)?;
    conn.execute_cached(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [local],
    )?;
    conn.execute_cached("DELETE FROM tags WHERE item_id = ?1", [local])?;
    conn.execute_cached("DELETE FROM items WHERE id = ?1", [local])?;
    for statement in [
        "UPDATE edges SET from_id = ?2 WHERE from_id = ?1",
        "UPDATE edges SET to_id = ?2 WHERE to_id = ?1",
        "UPDATE queue SET item_id = ?2 WHERE item_id = ?1 AND
         (sent = 0 OR (kind = 'create_item' AND verdict IN ('accepted', 'merged', 'conflicted', 'refused')))",
        "UPDATE queue SET to_id = ?2 WHERE to_id = ?1 AND sent = 0",
        "UPDATE body_checks SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE body_edges SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE body_edges SET other_id = ?2 WHERE other_id = ?1",
        "UPDATE body_names SET other_id = ?2 WHERE other_id = ?1",
        "UPDATE folder_files SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE OR REPLACE folder_journal SET item_id = ?2 WHERE item_id = ?1",
        "UPDATE rows_laid SET item_id = ?2 WHERE item_id = ?1",
    ] {
        conn.execute(statement, params![local, answered])?;
    }
    crate::tables::drop_item(conn, local)?;
    // The names the create's body carries are the row's now; the landing
    // drops any its answered body does not carry.
    if conn.query_row_cached(
        "SELECT EXISTS (SELECT 1 FROM body_names WHERE item_id = ?1)",
        [local],
        |row| row.get(0),
    )? {
        conn.execute_cached("DELETE FROM body_names WHERE item_id = ?1", [answered])?;
        conn.execute_cached(
            "UPDATE body_names SET item_id = ?2 WHERE item_id = ?1",
            params![local, answered],
        )?;
    }
    let carried = pinned(conn, local)?;
    if conn.execute_cached(
        "UPDATE OR IGNORE pins SET item_id = ?2 WHERE item_id = ?1",
        params![local, answered],
    )? > 0
    {
        crate::reach::pins_changed(conn)?;
    }
    // Left where the server's row was pinned already.
    unpin(conn, local)?;
    // The create's pin is somebody's own on the row it lands on, so the
    // release of a pin the body rule or a folder line made there must not
    // take it.
    if carried {
        conn.execute_cached("DELETE FROM body_pins WHERE item_id = ?1", [answered])?;
        crate::folder::state::disown_edge_end(conn, answered)?;
    }
    drop_beneath(conn, Subject::Item, local)?;
    settle_read_back(conn, Subject::Item, local)?;
    // The writes just moved onto `answered` wait on the row as the copy
    // holds it now, which nothing has laid them over yet.
    if beneath_row(conn, Subject::Item, answered)?.is_none() {
        keep_beneath_item(conn, answered, None)?;
    }
    // Unsent blocked/dead work needs the same identity as its columns.
    // Once sent, both the request body and its addressed row keep their
    // original meaning under the original idempotency key.
    let mut edges = conn.prepare(
        "SELECT id, payload FROM queue WHERE kind IN ('create_edge', 'update_edge') AND sent = 0
         AND (verdict IS NULL OR verdict IN ('blocked', 'dead', 'refused'))",
    )?;
    let waiting: Vec<(String, String)> = edges
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, payload) in waiting {
        let mut body: Value = serde_json::from_str(&payload)?;
        let mut moved = false;
        for endpoint in ["from_id", "to_id"] {
            if body.get(endpoint).and_then(Value::as_str) == Some(local) {
                body[endpoint] = Value::String(answered.to_string());
                moved = true;
            }
        }
        if moved {
            conn.execute_cached(
                "UPDATE queue SET payload = ?2 WHERE id = ?1",
                params![id, body.to_string()],
            )?;
        }
    }
    // A create drawn to the minted row is drawn to `answered`.
    let creates = read_writes(
        conn,
        "WHERE kind = ?1 AND sent = 0 AND (verdict IS NULL OR verdict IN ('blocked', 'dead', 'refused'))",
        [WriteKind::CreateItem.as_str()],
    )?;
    for row in creates {
        let mut body: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
        let mut moved = false;
        if let Some(edges) = body.get_mut("edges").and_then(Value::as_object_mut) {
            for target in edges.values_mut().filter_map(Value::as_array_mut).flatten() {
                if target.as_str() == Some(local) {
                    *target = Value::String(answered.to_string());
                    moved = true;
                }
            }
        }
        if moved {
            conn.execute_cached(
                "UPDATE queue SET payload = ?2 WHERE id = ?1",
                params![row.id, body.to_string()],
            )?;
        }
    }
    attachments_changed(conn, &[local, answered], before)
}

/// An edge a waiting create is shown with is named by its ends
/// ([`crate::model::projected_edge_id`]), so where one end moves from `local`
/// to `answered` the edge takes the name of its new ends.
fn rename_shown_edges(conn: &Connection, local: &str, answered: &str) -> Result<(), CoreError> {
    let mut shown = conn.prepare(
        "SELECT id, from_id, to_id, edge_type FROM edges
          WHERE version = 0 AND (from_id = ?1 OR to_id = ?1)",
    )?;
    let ends: Vec<(String, String, String, String)> = shown
        .query_map([local], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    let moved = |end: &str| if end == local { answered } else { end }.to_string();
    for (id, source, target, edge_type) in ends {
        if id != crate::model::projected_edge_id(&source, &edge_type, &target) {
            continue;
        }
        let Some(edge) = edge_ends(conn, &id)? else {
            continue;
        };
        let mut wire = edge.as_wire();
        wire.from_id = moved(&source);
        wire.to_id = moved(&target);
        wire.id = crate::model::projected_edge_id(&wire.from_id, &edge_type, &wire.to_id);
        forget_edge(conn, &id)?;
        upsert_edge(conn, &wire)?;
        readdress_edge_writes(conn, &id, &wire.id, false)?;
    }
    // A delete already took its edge out of the copy, so the delete names it.
    let deletes = read_writes(
        conn,
        "WHERE kind = ?1 AND sent = 0 AND (item_id = ?2 OR to_id = ?2)",
        [WriteKind::DeleteEdge.as_str(), local],
    )?;
    for row in deletes {
        let (Some(id), Some(source), Some(target), Some(edge_type)) = (
            row.edge_id.as_deref(),
            row.item_id.as_deref(),
            row.to_id.as_deref(),
            row.body.get("edge_type").and_then(Value::as_str),
        ) else {
            continue;
        };
        if id != crate::model::projected_edge_id(source, edge_type, target) {
            continue;
        }
        let renamed = crate::model::projected_edge_id(&moved(source), edge_type, &moved(target));
        readdress_edge_writes(conn, id, &renamed, false)?;
    }
    Ok(())
}

/// Moves the copy onto `answered`, the held row a refused create's natural
/// key resolved, and returns the dependent writes it refused. Only writes
/// that add (a tag, an edge, an edge's end moved to it, an item drawn to it)
/// carry over: any other was made against this device's row and would act on
/// another device's.
pub fn land_on_held_row(
    conn: &Connection,
    create: &QueuedWrite,
    answered: &str,
) -> Result<Vec<(QueuedWrite, String)>, CoreError> {
    let Some(local) = create.item_id.as_deref() else {
        return Ok(Vec::new());
    };
    let mut refused = Vec::new();
    for row in waiting_writes(conn)? {
        if !row.depends_on.contains(&create.id) {
            continue;
        }
        let replaces = match row.kind {
            WriteKind::AddTag
            | WriteKind::CreateEdge
            | WriteKind::UpdateEdge
            | WriteKind::CreateItem
            | WriteKind::WriteRows => false,
            WriteKind::UpdateItem
            | WriteKind::DeleteItem
            | WriteKind::RestoreItem
            | WriteKind::TransitionItem
            | WriteKind::ReplaceTags
            | WriteKind::RemoveTag
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => true,
            // Not written against an item's create, so never one of its
            // dependants; refused all the same should one ever be.
            WriteKind::DeleteEdge | WriteKind::UploadBlob | WriteKind::UndoRows => true,
        };
        if replaces {
            let reason = format!(
                "the create it waited on was refused because {answered} already holds its natural key, \
                 and this {} was made against a row the server never made",
                row.kind
            );
            // Its row is the minted one, which goes below: there is nothing
            // of the server's to read back.
            record_refusal(conn, &row, &reason, None, false)?;
            refused.push((row, reason));
            continue;
        }
        let still: Vec<&String> = row
            .depends_on
            .iter()
            .filter(|held| **held != create.id)
            .collect();
        conn.execute_cached(
            "UPDATE queue SET depends_on = ?2 WHERE id = ?1",
            params![
                row.id,
                if still.is_empty() {
                    None
                } else {
                    Some(serde_json::to_string(&still)?)
                }
            ],
        )?;
    }
    adopt_answered_id(conn, local, answered)?;
    refollow(conn, answered, &create.id)?;
    Ok(refused)
}

/// Marks the files bound to `item_id` as holding bytes no row has, read at
/// `version`, unless an update later than `edit` is queued: the file then
/// holds that one's bytes and waits on its answer.
pub fn untake_latest_save(
    conn: &Connection,
    edit: &QueuedWrite,
    item_id: &str,
    version: i64,
) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE folder_files SET content_hash = ?2
          WHERE item_id = ?1
            AND NOT EXISTS (
              SELECT 1 FROM queue
               WHERE kind = ?3 AND item_id = ?1
                 AND seq > (SELECT seq FROM queue WHERE id = ?4)
            )",
        params![
            item_id,
            crate::folder::state::untaken_read_at(version),
            WriteKind::UpdateItem.as_str(),
            edit.id
        ],
    )?;
    Ok(())
}

/// Blocks every unanswered create naming `source` under `credential_refused`
/// and returns their ids: each carries the same credential and would be
/// refused the same way.
pub fn block_creates_naming(conn: &Connection, source: &str) -> Result<Vec<String>, CoreError> {
    let mut blocked = Vec::new();
    for row in read_writes(
        conn,
        "WHERE verdict IS NULL AND kind = ?1",
        [WriteKind::CreateItem.as_str()],
    )? {
        let payload: Value = serde_json::from_str(&payload_of(conn, &row.id)?)?;
        if payload.get("source").and_then(Value::as_str) != Some(source) {
            continue;
        }
        record_verdict(
            conn,
            &row.id,
            &Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::CredentialRefused.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
        blocked.push(row.id);
    }
    Ok(blocked)
}

/// A pinned row's purge is remembered, even past a later pin of the gone
/// row, so whatever pinned it can tell a purge from a row it can no longer
/// read; `forget_purged` lets it go.
pub fn purge_item(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    // Even an unheld row may be on its way in an outstanding door readback.
    crate::reach::purged(conn)?;
    let unpinned = unpin(conn, id)?;
    if unpinned {
        meta_set(conn, &purged_key(id), "true")?;
    }
    let removed = remove_item(conn, id, "from_id = ?1 OR to_id = ?1", &[])?;
    Ok(removed || unpinned)
}

/// Keeps the edges of a type in `whole`, edges drawn to the item, as a
/// hydration holds them, and an edge a waiting write names, with what is kept
/// beneath it, until that write is answered.
pub fn evict_item(conn: &Connection, id: &str, whole: &[String]) -> Result<bool, CoreError> {
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, id, None)?;
    let kept = vec!["?"; whole.len()].join(", ");
    let waits =
        format!("id NOT IN (SELECT edge_id FROM queue WHERE edge_id IS NOT NULL AND {WAITING})");
    let edges = if whole.is_empty() {
        format!("from_id = ?1 AND {waits}")
    } else {
        format!("from_id = ?1 AND edge_type NOT IN ({kept}) AND {waits}")
    };
    remove_item(conn, id, &edges, whole)
}

/// A queued write the server has yet to take: unanswered, blocked or dead,
/// as `waiting_writes` reads them.
pub(super) const WAITING: &str = "(verdict IS NULL OR verdict IN ('blocked', 'dead'))";

/// The one way a row leaves the copy, with the edges `edges` names (a
/// condition on `edges`, `?1` the row's id, then `kept`): what is kept
/// beneath them goes too. Read-back debt requires independent certified
/// settlement. Whether the copy changed: a purge of an
/// item already evicted still takes the edges held items drew to it.
pub(super) fn remove_item(
    conn: &Connection,
    id: &str,
    edges: &str,
    kept: &[String],
) -> Result<bool, CoreError> {
    let before = attachments_before(conn, &[id])?;
    crate::reach::forget_listed(conn, id)?;
    drop_beneath(conn, Subject::Item, id)?;
    conn.execute_cached(
        "DELETE FROM items_fts WHERE rowid IN (SELECT seq FROM items WHERE id = ?1)",
        [id],
    )?;
    conn.execute_cached("DELETE FROM tags WHERE item_id = ?1", [id])?;
    // An edge hidden behind this device's own waiting delete is in
    // `beneath` alone, and leaves with the row all the same. An edge still in
    // `edges` is matched by its ends there, which a waiting write may have
    // moved, never by the ones `beneath` recorded.
    let leaving: Vec<String> = conn
        .prepare(&format!(
            "SELECT id FROM (
               SELECT id, from_id, to_id, edge_type FROM edges
               UNION
               SELECT id, json_extract(row, '$.from_id') AS from_id,
                      json_extract(row, '$.to_id') AS to_id,
                      json_extract(row, '$.edge_type') AS edge_type
                 FROM beneath
                WHERE subject = 'edge' AND id NOT IN (SELECT id FROM edges)
             ) WHERE {edges}"
        ))?
        .query_map(
            params_from_iter(std::iter::once(id).chain(kept.iter().map(String::as_str))),
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let mut changed = false;
    for edge in leaving {
        changed |= forget_edge(conn, &edge)?;
    }
    let removed = conn.execute_cached("DELETE FROM items WHERE id = ?1", [id])? > 0;
    super::forget_made(conn, id)?;
    crate::tables::drop_item(conn, id)?;
    attachments_changed(conn, &[id], before)?;
    Ok(removed || changed)
}

pub fn whole_edge_types(conn: &Connection) -> Result<Vec<String>, CoreError> {
    match meta_get(conn, META_SLICE_EDGE_TYPES)? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(Vec::new()),
    }
}

pub fn takes_edge(
    conn: &Connection,
    from_id: &str,
    edge_type: &str,
    whole: &[String],
) -> Result<bool, CoreError> {
    Ok(whole.iter().any(|held| held == edge_type) || item_held(conn, from_id)?)
}

/// Keeps an edge a waiting write of this device's is laid over.
pub fn let_go_of_untaken_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    let Some(edge) = edge_ends(conn, id)? else {
        return Ok(false);
    };
    if takes_edge(
        conn,
        &edge.from_id,
        &edge.edge_type,
        &whole_edge_types(conn)?,
    )? || edge_write_waits(conn, id)?
    {
        return Ok(false);
    }
    forget_edge(conn, id)
}

pub fn upsert_edge(conn: &Connection, edge: &WireEdge) -> Result<(), CoreError> {
    crate::body::rule::edge_changing(conn, edge)?;
    let mut ends = edge_sources(conn, &edge.id)?;
    ends.push(edge.from_id.clone());
    let ends: Vec<&str> = ends.iter().map(String::as_str).collect();
    let before = attachments_before(conn, &ends)?;
    conn.prepare_cached(
        "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET
           from_id = excluded.from_id, to_id = excluded.to_id,
           edge_type = excluded.edge_type, properties = excluded.properties,
           version = excluded.version, created_at = excluded.created_at,
           updated_at = excluded.updated_at",
    )?
    .execute(params![
            edge.id,
            edge.from_id,
            edge.to_id,
            edge.edge_type,
            number::object(&edge.properties),
            edge.version,
            edge.created_at,
            edge.updated_at,
    ])?;
    attachments_changed(conn, &ends, before)
}

/// The from item of the edge `id` as the copy holds it, which a change to the
/// edge can make or end an attachment of.
fn edge_sources(conn: &Connection, id: &str) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare_cached("SELECT from_id FROM edges WHERE id = ?1")?;
    let found = statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(found)
}

/// Takes the edge out of what the copy shows and nothing else: for a write
/// of this device's laid over it. An edge leaving the copy goes by
/// `forget_edge`.
pub fn delete_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    crate::body::rule::edge_leaving(conn, id)?;
    let ends = edge_sources(conn, id)?;
    let ends: Vec<&str> = ends.iter().map(String::as_str).collect();
    let before = attachments_before(conn, &ends)?;
    let deleted = conn.execute_cached("DELETE FROM edges WHERE id = ?1", [id])? > 0;
    attachments_changed(conn, &ends, before)?;
    Ok(deleted)
}

/// The edge and its baseline leave together. Read-back debt requires its own
/// certified settlement, including when local unpinning removes this edge.
pub fn forget_edge(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    drop_beneath(conn, Subject::Edge, id)?;
    delete_edge(conn, id)
}

/// Each tag the item does not hold goes last, as the server places it.
pub fn add_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO tags (item_id, tag, position)
         SELECT ?1, ?2, coalesce(max(position) + 1, 0) FROM tags WHERE item_id = ?1",
    )?;
    for tag in tags {
        insert.execute(params![item_id, tag])?;
    }
    Ok(())
}

pub fn tag_count(conn: &Connection, item_id: &str) -> Result<usize, CoreError> {
    let count: i64 = conn.query_row_cached(
        "SELECT COUNT(*) FROM tags WHERE item_id = ?1",
        [item_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

pub fn remove_tag(conn: &Connection, item_id: &str, tag: &str) -> Result<(), CoreError> {
    conn.execute_cached(
        "DELETE FROM tags WHERE item_id = ?1 AND tag = ?2",
        params![item_id, tag],
    )?;
    Ok(())
}

pub fn replace_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), CoreError> {
    conn.execute_cached("DELETE FROM tags WHERE item_id = ?1", [item_id])?;
    add_tags(conn, item_id, tags)
}

/// The version and the time are the server's, untouched: a row the server
/// writes after this is ordered against them (`Stamp`).
/// `at` is when the move was made, recorded as `Item::move_to` records it,
/// which leaves `updated_at` as the server last sent it.
pub fn set_item_state(
    conn: &Connection,
    id: &str,
    state: ItemState,
    at: &str,
) -> Result<bool, CoreError> {
    crate::body::rule::rows_changed(conn)?;
    crate::body::rule::item_changing(conn, id, None)?;
    let before = attachments_before(conn, &[id])?;
    let changed = conn.execute_cached(
        "UPDATE items SET state = ?2,
           trashed_at = CASE
             WHEN ?2 = 'trashed' THEN CASE WHEN state = 'trashed' THEN trashed_at ELSE ?3 END
             WHEN state = 'trashed' THEN NULL
             ELSE trashed_at
           END
         WHERE id = ?1",
        params![id, state.as_str(), at],
    )?;
    attachments_changed(conn, &[id], before)?;
    if changed > 0 {
        // The index follows the state as `index_row` has it: a row in the bin
        // is out of it, and one that leaves the bin is in it again.
        reindex_item(conn, id)?;
    }
    Ok(changed > 0)
}
