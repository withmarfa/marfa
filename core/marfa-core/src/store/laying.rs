//! Laying the writes still waiting over a row the server gave, and putting a refused write back.

use super::Cached;
use super::dead::{
    EditField, dead_effect, is_tag_write, remaining_dead_fields, tag_field, tag_targets,
};
use super::forget::forget_row;
use super::marks::{item_held, removal_unsent};
use super::queue::{
    current_edge_writes, current_item_writes, edge_write_waits, read_writes, row_writes_wait,
};
use super::reads::{Unreadable, edge_by_id_with, items_by_ids_with};
use super::rows::{delete_edge, forget_edge, let_go_of_untaken_edge, upsert_edge, upsert_item};
use super::stamps::{
    beneath_edge, beneath_item, drop_beneath, hold_beneath_edge, owe_read_back, owed_of,
    put_server_edge, put_server_item,
};
use super::verdicts::{Answered, payload_of, read_of, record_read, record_verdict};
use crate::error::CoreError;
use crate::model::{Item, ItemState, QueuedWrite, Subject, Tier, Verdict, WriteKind};
use crate::wire::{WireEdge, WireItem};
use marfa_rules::catalog::Indexing;
use rusqlite::{Connection, params};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Takes the server's row into the copy and, only where that wrote, lays the
/// writes still waiting over it, so the copy keeps showing them. A row refused
/// for a later one held leaves the writes laid over that one. Answers whether
/// the row went in. The contract is `queue-and-verdicts/waiting-over-answer`,
/// `queue-and-verdicts/waiting-over-event`, `device/pin-waiting-write` and
/// `device/catch-up-edge-own-write`.
pub fn take_server_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    catalog: &marfa_rules::catalog::Catalog,
) -> Result<bool, CoreError> {
    if !put_server_item(conn, item, tags, catalog)? {
        return Ok(false);
    }
    lay_waiting_writes_over(conn, &item.id, &|laid| catalog.indexing(laid))?;
    Ok(true)
}

/// `take_server_item` for an edge. The edge a create was shown with until
/// the server's came leaves, and each write waiting on it moves onto the
/// server's (`device/edge-write-waits-projected`).
pub fn take_server_edge(conn: &Connection, edge: &WireEdge) -> Result<bool, CoreError> {
    let shown = crate::model::projected_edge_id(&edge.from_id, &edge.edge_type, &edge.to_id);
    let moved = shown != edge.id && readdress_edge_writes(conn, &shown, &edge.id, true)?;
    let taken = put_server_edge(conn, edge)?;
    if shown != edge.id {
        forget_edge(conn, &shown)?;
    }
    if !taken && moved {
        hold_beneath_edge(conn, &edge.id)?;
    }
    if taken || moved {
        lay_waiting_edge_writes_over(conn, &edge.id)?;
    }
    Ok(taken)
}

/// Moves each unsent write naming the edge `from` onto `to`, answering
/// whether any moved. Where `to` is the server's edge, which a create made at
/// version 1, an edit based on the edge the create was shown with, at
/// version 0, is based on version 1.
pub fn readdress_edge_writes(
    conn: &Connection,
    from: &str,
    to: &str,
    made: bool,
) -> Result<bool, CoreError> {
    let waiting = read_writes(
        conn,
        "WHERE edge_id = ?1 AND sent = 0 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [from, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )?;
    for row in &waiting {
        let mut base = row.base_version;
        let mut payload = payload_of(conn, &row.id)?;
        if made && row.kind == WriteKind::UpdateEdge && base == Some(0) {
            base = Some(1);
            let mut body: Value = serde_json::from_str(&payload)?;
            body["version"] = Value::from(1);
            payload = body.to_string();
        }
        conn.execute_cached(
            "UPDATE queue SET edge_id = ?2, base_version = ?3, payload = ?4 WHERE id = ?1",
            params![row.id, to, base, payload],
        )?;
    }
    Ok(!waiting.is_empty())
}

/// Refuses, unsent, each write still waiting on the edge `id`, with `reason`.
pub fn refuse_edge_writes(conn: &Connection, id: &str, reason: &str) -> Result<(), CoreError> {
    let waiting = read_writes(
        conn,
        "WHERE edge_id = ?1 AND sent = 0 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [id, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )?;
    for row in waiting {
        record_verdict(
            conn,
            &row.id,
            &Answered {
                verdict: Verdict::Refused,
                reason: Some(reason),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
    }
    drop_beneath(conn, Subject::Edge, id)
}

/// Call after anything puts the server's row into the copy. The row is
/// indexed as the type it is laid over as, since a waiting retype moves it.
pub fn lay_waiting_writes_over(
    conn: &Connection,
    item_id: &str,
    indexing: &dyn Fn(&str) -> Indexing,
) -> Result<(), CoreError> {
    let waiting = current_item_writes(conn, item_id)?;
    if waiting.is_empty() {
        return Ok(());
    }
    // A row whose stored properties cannot be read has nothing to lay the
    // writes over; they stay queued, and a fresh copy from the server takes
    // them when it arrives. Failing here would fail a hydration or a catch-up
    // for one damaged row.
    let mut damaged = Unreadable::Keep(HashMap::new());
    let Some(mut item) = items_by_ids_with(
        conn,
        std::slice::from_ref(&item_id.to_string()),
        &mut damaged,
    )?
    .pop() else {
        return Ok(());
    };
    if damaged.why(item_id).is_some() {
        return Ok(());
    }
    let mut tags = item.tags.clone();
    for mut row in waiting {
        let mut read = read_of(conn, &row.id)?
            .map(|read| serde_json::from_str::<Value>(&read))
            .transpose()?;
        if row.verdict == Some(Verdict::Dead)
            && row.kind == WriteKind::UpdateItem
            && let Some(fields) = remaining_dead_fields(conn, &row)?
        {
            retain_edit_fields(&mut row.body, &fields);
            if let Some(read) = &mut read {
                retain_edit_fields(read, &fields);
            }
        }
        if row.verdict == Some(Verdict::Dead) && is_tag_write(&row) {
            let effect = dead_effect(conn, &row)?;
            let mut desired = tag_targets(&row);
            desired.retain(|tag| !effect.fields.contains(&tag_field(tag)));
            if row.kind == WriteKind::ReplaceTags {
                desired.extend(
                    tags.iter()
                        .filter(|tag| effect.fields.contains(&tag_field(tag)))
                        .cloned(),
                );
            }
            if matches!(row.kind, WriteKind::AddTag | WriteKind::ReplaceTags) {
                row.body["tags"] = serde_json::to_value(desired)?;
            }
        }
        lay_write(conn, &mut item, &mut tags, &row, read.as_ref())?;
    }
    upsert_item(conn, &item.as_wire(), Some(&tags), &indexing(&item.r#type))
}

fn retain_edit_fields(body: &mut Value, fields: &HashSet<EditField>) {
    if let Some(body) = body.as_object_mut() {
        body.retain(|key, _| {
            matches!(
                key.as_str(),
                "version" | "properties_mode" | "retype" | "properties" | "clear_properties"
            ) || fields.contains(&(false, key.clone()))
        });
        if let Some(properties) = body.get_mut("properties").and_then(Value::as_object_mut) {
            properties.retain(|key, _| fields.contains(&(true, key.clone())));
        }
        retain_cleared(body, |key| fields.contains(&(true, key.to_string())));
    }
}

/// The properties an item edit's body clears.
pub fn cleared(body: &Value) -> impl Iterator<Item = &str> {
    body.get("clear_properties")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// Keeps the cleared properties `keep` takes, and drops the field once it
/// names none: the server reads an empty list as no change.
fn retain_cleared(body: &mut Map<String, Value>, keep: impl Fn(&str) -> bool) {
    if let Some(Value::Array(names)) = body.get_mut("clear_properties") {
        names.retain(|name| name.as_str().is_some_and(&keep));
        if names.is_empty() {
            body.shift_remove("clear_properties");
        }
    }
}

fn lay_write(
    conn: &Connection,
    item: &mut Item,
    tags: &mut Vec<String>,
    row: &QueuedWrite,
    read: Option<&Value>,
) -> Result<(), CoreError> {
    let payload = &row.body;
    let named_tags = || -> Vec<String> {
        payload
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|tag| tag.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    match row.kind {
        WriteKind::CreateItem => {
            let draft = crate::model::Draft::from_payload(&serde_json::to_string(payload)?)?;
            item.properties.extend(draft.properties);
            item.r#type = draft.r#type;
            if let Some(tier) = draft.tier {
                item.tier = Some(tier);
            }
            if let Some(source) = draft.source {
                item.source = source;
            }
            if let Some(source_id) = draft.source_id {
                item.source_id = Some(source_id);
            }
            if let Some(occurred_at) = draft.occurred_at {
                item.occurred_at = marfa_rules::time::projected(&occurred_at);
            }
            if let Some(state) = draft.state {
                item.move_to(state, &row.queued_at);
            }
            if draft.capture_latitude.is_some() {
                item.capture_latitude = draft.capture_latitude;
            }
            if draft.capture_longitude.is_some() {
                item.capture_longitude = draft.capture_longitude;
            }
        }
        WriteKind::UpdateItem => {
            if let Some(Value::Object(properties)) = payload.get("properties") {
                // Only an edit that read the copy knows which properties it
                // cleared; one said to be read earlier is laid over.
                let read = match read {
                    Some(read) if replaces_properties(payload) => {
                        read.get("properties").and_then(Value::as_object).cloned()
                    }
                    _ => None,
                };
                if let Some(read) = read {
                    lay_changes(&mut item.properties, properties, &read);
                    // At the row's version the server takes it whole, in the
                    // order it sends; behind it, the server merges.
                    if row.base_version == Some(item.version) {
                        item.properties = in_sent_order(&item.properties, properties);
                    }
                } else {
                    let projected = if properties.values().any(Value::is_null) {
                        crate::catalog::load(conn)?.projected_properties(
                            payload
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or(&item.r#type),
                            properties,
                            replaces_properties(payload),
                        )
                    } else {
                        properties.clone()
                    };
                    item.properties.extend(projected);
                }
            }
            for name in cleared(payload) {
                item.properties.shift_remove(name);
            }
            if let Some(Value::String(key)) = payload.get("source_id") {
                item.source_id = Some(key.clone());
            }
            if payload.get("retype") == Some(&Value::Bool(true))
                && let Some(Value::String(r#type)) = payload.get("type")
            {
                item.r#type = r#type.clone();
            }
            if let Some(tier) = payload.get("tier").and_then(Value::as_str) {
                item.tier = Tier::parse_wire(Some(tier))?;
            }
            if let Some(occurred_at) = payload.get("occurred_at").and_then(Value::as_str) {
                item.occurred_at = marfa_rules::time::projected(occurred_at);
            }
        }
        WriteKind::TransitionItem => {
            if let Some(state) = payload.get("state").and_then(Value::as_str) {
                item.move_to(state.parse()?, &row.queued_at);
            }
        }
        WriteKind::DeleteItem => item.move_to(ItemState::Trashed, &row.queued_at),
        WriteKind::RestoreItem => item.move_to(ItemState::Active, &row.queued_at),
        WriteKind::AddTag => {
            for tag in named_tags() {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }
        WriteKind::RemoveTag => tags.retain(|tag| Some(tag) != row.tag.as_ref()),
        WriteKind::ReplaceTags => *tags = named_tags(),
        WriteKind::CreateEdge
        | WriteKind::UpdateEdge
        | WriteKind::DeleteEdge
        | WriteKind::WriteExtension
        | WriteKind::DeleteExtension
        | WriteKind::UploadBlob
        | WriteKind::WriteRows
        | WriteKind::UndoRows => {}
    }
    Ok(())
}

/// The one way a refusal is recorded, whoever refused: the verdict, and the
/// copy put back at once to what was beneath the write, so it stops showing
/// what the server did not take even while the server cannot be read. With
/// `owe`, the copy owes a read of the server's row, which every drain tries
/// until it lands; a read the caller has already made, or a row only this
/// device ever held, owes none.
pub fn record_refusal(
    conn: &Connection,
    row: &QueuedWrite,
    reason: &str,
    answer: Option<&str>,
    owe: bool,
) -> Result<(), CoreError> {
    let owed = if owe { owed_of(conn, row)? } else { None };
    record_verdict(
        conn,
        &row.id,
        &Answered {
            verdict: Verdict::Refused,
            reason: Some(reason),
            answer,
            conflicted_copy_id: None,
        },
    )?;
    put_back(conn, row)?;
    if let Some(owed) = owed {
        owe_read_back(conn, &owed)?;
    }
    Ok(())
}

/// Puts the copy back as it was beneath `row`, which no longer waits: the
/// server's row as last taken, with every write still waiting laid back
/// over it. A create's row was only ever this device's, so it goes; its pin
/// stays until a read says whether the server holds the id.
pub fn put_back(conn: &Connection, row: &QueuedWrite) -> Result<(), CoreError> {
    match row.kind.subject() {
        Some(Subject::Item) => {
            let Some(id) = row.item_id.as_deref() else {
                return Ok(());
            };
            if row.kind == WriteKind::CreateItem {
                return forget_row(conn, id);
            }
            let catalog = crate::catalog::load(conn)?;
            if let Some(held) = beneath_item(conn, id)?
                && item_held(conn, id)?
            {
                upsert_item(
                    conn,
                    &held.as_wire(),
                    Some(&held.tags),
                    &catalog.indexing(&held.r#type),
                )?;
            }
            lay_waiting_writes_over(conn, id, &|laid| catalog.indexing(laid))?;
            if !row_writes_wait(conn, id)? {
                drop_beneath(conn, Subject::Item, id)?;
            }
        }
        Some(Subject::Edge) => {
            let Some(id) = row.edge_id.as_deref() else {
                return Ok(());
            };
            if row.kind == WriteKind::CreateEdge {
                delete_edge(conn, id)?;
                drop_beneath(conn, Subject::Edge, id)?;
            } else {
                if let Some(held) = beneath_edge(conn, id)? {
                    upsert_edge(conn, &held.as_wire())?;
                }
                lay_waiting_edge_writes_over(conn, id)?;
                if !edge_write_waits(conn, id)? {
                    drop_beneath(conn, Subject::Edge, id)?;
                    removal_unsent(conn, Subject::Edge, id)?;
                }
                // Where the server moved it to a source the copy does not
                // hold while the refused write waited.
                let_go_of_untaken_edge(conn, id)?;
            }
        }
        None => {}
    }
    Ok(())
}

pub fn lay_waiting_edge_writes_over(conn: &Connection, edge_id: &str) -> Result<(), CoreError> {
    let waiting = current_edge_writes(conn, edge_id)?;
    // As for an item: a damaged edge is left as it is under its writes.
    let mut damaged = Unreadable::Keep(HashMap::new());
    let Some(mut edge) = edge_by_id_with(conn, edge_id, &mut damaged)? else {
        return Ok(());
    };
    if damaged.why(edge_id).is_some() {
        return Ok(());
    }
    for mut row in waiting {
        if row.verdict == Some(Verdict::Dead)
            && row.kind == WriteKind::UpdateEdge
            && let Some(fields) = remaining_dead_fields(conn, &row)?
        {
            retain_edit_fields(&mut row.body, &fields);
        }
        match row.kind {
            WriteKind::CreateEdge => {
                let (_, draft) =
                    crate::model::EdgeDraft::from_payload(&payload_of(conn, &row.id)?)?;
                edge.from_id = draft.from_id;
                edge.to_id = draft.to_id;
                edge.edge_type = draft.edge_type;
                edge.properties.extend(draft.properties);
            }
            WriteKind::UpdateEdge => {
                let payload = &row.body;
                if let Some(Value::Object(properties)) = payload.get("properties") {
                    for (key, value) in properties {
                        edge.properties.insert(key.clone(), value.clone());
                    }
                }
                if let Some(source) = payload.get("from_id").and_then(Value::as_str) {
                    edge.from_id = source.to_string();
                }
                if let Some(target) = payload.get("to_id").and_then(Value::as_str) {
                    edge.to_id = target.to_string();
                }
            }
            WriteKind::DeleteEdge => {
                delete_edge(conn, edge_id)?;
                return Ok(());
            }
            _ => {}
        }
    }
    upsert_edge(conn, &edge.as_wire())
}

/// Drops every property the edit carries unchanged from what it read: sent on
/// another version it would overwrite whatever another device wrote since.
/// An edit with no recorded read moves as it stands.
pub fn move_edit(
    conn: &Connection,
    id: &str,
    version: i64,
    onto: Option<&Map<String, Value>>,
) -> Result<(), CoreError> {
    if let Some(read) = read_of(conn, id)? {
        let read: Value = serde_json::from_str(&read)?;
        let mut body: Value = serde_json::from_str(&payload_of(conn, id)?)?;
        let whole = replaces_properties(&body);
        // A property it read no value for may have been written since by
        // another device, and on the new version the server would clear that.
        if let (Some(Value::Object(read)), Some(body)) =
            (read.get("properties"), body.as_object_mut())
        {
            retain_cleared(body, |key| read.get(key).is_some_and(|was| !was.is_null()));
        }
        if let (Some(Value::Object(read)), Some(Value::Object(properties))) =
            (read.get("properties").cloned(), body.get_mut("properties"))
        {
            if !whole {
                properties.retain(|key, value| read.get(key) != Some(value));
            } else if let Some(onto) = onto {
                // Dropping one would clear it, so whole properties move as the
                // answer's with what the edit changed laid over.
                let mut moved = onto.clone();
                lay_changes(&mut moved, properties, &read);
                *properties = in_sent_order(&moved, properties);
                // Made against the answer now, so a later move reads its
                // changes from there, not from what it first read.
                record_read(conn, id, &serde_json::json!({ "properties": onto }))?;
            }
        }
        conn.execute_cached(
            "UPDATE queue SET payload = ?2 WHERE id = ?1",
            params![id, body.to_string()],
        )?;
    }
    rebase(conn, id, version)
}

/// Lays what a whole-properties edit changed from what it read over a row's
/// properties: a value it changed, a property it left out cleared, and every
/// other the row's own.
fn lay_changes(row: &mut Map<String, Value>, sent: &Map<String, Value>, read: &Map<String, Value>) {
    for (key, was) in read {
        match sent.get(key) {
            Some(Value::Null) => {
                row.shift_remove(key);
            }
            Some(value) if value != was => {
                row.insert(key.clone(), value.clone());
            }
            Some(_) => {}
            None => {
                row.shift_remove(key);
            }
        }
    }
    for (key, value) in sent {
        if !read.contains_key(key) && !value.is_null() {
            row.insert(key.clone(), value.clone());
        }
    }
}

/// `row` with the properties `sent` names first, in the order sent, then the
/// rest as the row holds them: the order the server answers a whole edit
/// made at the row's version in (`items/property-order-replace`).
fn in_sent_order(row: &Map<String, Value>, sent: &Map<String, Value>) -> Map<String, Value> {
    let mut ordered: Map<String, Value> = sent
        .keys()
        .filter_map(|key| row.get(key).map(|value| (key.clone(), value.clone())))
        .collect();
    for (key, value) in row {
        if !ordered.contains_key(key) {
            ordered.insert(key.clone(), value.clone());
        }
    }
    ordered
}

pub fn replaces_properties(body: &Value) -> bool {
    body.get("properties_mode").and_then(Value::as_str) == Some("replace")
}

pub fn merge_properties(conn: &Connection, id: &str) -> Result<(), CoreError> {
    let mut body: Value = serde_json::from_str(&payload_of(conn, id)?)?;
    if let Some(body) = body.as_object_mut()
        && body.shift_remove("properties_mode").is_some()
    {
        conn.execute_cached(
            "UPDATE queue SET payload = ?2 WHERE id = ?1",
            params![id, Value::Object(body.clone()).to_string()],
        )?;
    }
    Ok(())
}

/// The payload and the column both move, so the queue reports what was sent.
pub fn rebase(conn: &Connection, id: &str, version: i64) -> Result<(), CoreError> {
    let mut payload: Value = serde_json::from_str(&payload_of(conn, id)?)?;
    if let Some(body) = payload.as_object_mut() {
        body.insert("version".into(), Value::from(version));
    }
    conn.execute_cached(
        "UPDATE queue SET payload = ?2, base_version = ?3 WHERE id = ?1",
        params![id, payload.to_string(), version],
    )?;
    Ok(())
}

/// For a write whose version is named in its query, so its body stays as it
/// was written.
pub fn rebase_column(conn: &Connection, id: &str, version: i64) -> Result<(), CoreError> {
    conn.execute_cached(
        "UPDATE queue SET base_version = ?2 WHERE id = ?1",
        params![id, version],
    )?;
    Ok(())
}

/// Only edits never sent: a sent body is fixed by the key it went under, and
/// a changed one is refused as that key reused.
pub fn edits_behind(
    conn: &Connection,
    answered: &QueuedWrite,
    subject: &str,
) -> Result<Vec<(String, Option<i64>)>, CoreError> {
    let Some(kind) = answered.kind.edit() else {
        return Ok(Vec::new());
    };
    unsent_writes_behind(conn, answered, subject, kind)
}

pub fn unsent_writes_behind(
    conn: &Connection,
    answered: &QueuedWrite,
    subject: &str,
    kind: WriteKind,
) -> Result<Vec<(String, Option<i64>)>, CoreError> {
    let Some(subject_kind) = kind.subject() else {
        return Ok(Vec::new());
    };
    let column = subject_kind.column();
    let mut statement = conn.prepare(&format!(
        "SELECT id, base_version FROM queue
          WHERE kind = ?1 AND {column} = ?2 AND sent = 0
            AND (verdict IS NULL OR verdict = ?3)
            AND seq > (SELECT seq FROM queue WHERE id = ?4)
          ORDER BY seq"
    ))?;
    let behind = statement
        .query_map(
            params![
                kind.as_str(),
                subject,
                Verdict::Blocked.as_str(),
                answered.id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<Result<_, _>>()?;
    Ok(behind)
}
