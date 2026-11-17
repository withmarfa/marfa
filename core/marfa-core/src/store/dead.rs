//! The effects of dead writes, which later answers are judged against.

use super::laying::{cleared, replaces_properties};
use super::meta::{meta_get, meta_set};
use super::queue::read_writes;
use super::verdicts::read_of;
use crate::error::CoreError;
use crate::model::{QueuedWrite, WriteKind};
use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::HashSet;

pub(super) type EditField = (bool, String);

#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(super) struct DeadEffect {
    pub(super) attempt: String,
    pub(super) excluded_attempts: HashSet<String>,
    pub(super) fields: HashSet<EditField>,
    pub(super) whole: bool,
}

pub(super) fn effect_key(id: &str) -> String {
    format!("dead_effect/{id}")
}

pub(super) fn dead_effect(conn: &Connection, row: &QueuedWrite) -> Result<DeadEffect, CoreError> {
    let saved: DeadEffect = meta_get(conn, &effect_key(&row.id))?
        .map(|json| serde_json::from_str(&json))
        .transpose()?
        .unwrap_or_default();
    Ok(if saved.attempt == row.idempotency_key {
        saved
    } else {
        DeadEffect {
            attempt: row.idempotency_key.clone(),
            ..DeadEffect::default()
        }
    })
}

pub(super) fn edit_fields(
    conn: &Connection,
    row: &QueuedWrite,
) -> Result<HashSet<EditField>, CoreError> {
    let mut fields = HashSet::new();
    if let Some(body) = row.body.as_object() {
        for (key, value) in body {
            if matches!(key.as_str(), "version" | "properties_mode" | "retype") {
                continue;
            }
            if key == "clear_properties" {
                fields.extend(cleared(&row.body).map(|key| (true, key.to_string())));
            } else if key == "properties"
                && let Some(properties) = value.as_object()
            {
                fields.extend(
                    properties
                        .iter()
                        .filter(|(_, value)| {
                            row.kind == WriteKind::UpdateEdge
                                || !value.is_null()
                                || replaces_properties(&row.body)
                        })
                        .map(|(key, _)| (true, key.clone())),
                );
            } else {
                fields.insert((false, key.clone()));
            }
        }
    }
    if replaces_properties(&row.body)
        && let Some(read) = read_of(conn, &row.id)?
    {
        let read: Value = serde_json::from_str(&read)?;
        if let Some(properties) = read.get("properties").and_then(Value::as_object) {
            fields.extend(properties.keys().map(|key| (true, key.clone())));
        }
    }
    Ok(fields)
}

pub(super) fn is_tag_write(row: &QueuedWrite) -> bool {
    matches!(
        row.kind,
        WriteKind::AddTag | WriteKind::RemoveTag | WriteKind::ReplaceTags
    )
}

/// The tags a write names, each once, in the order it names them.
pub(super) fn tag_targets(row: &QueuedWrite) -> Vec<String> {
    let named: Vec<String> = if row.kind == WriteKind::RemoveTag {
        row.tag.iter().cloned().collect()
    } else {
        row.body
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tag| tag.as_str().map(str::to_string))
            .collect()
    };
    let mut targets: Vec<String> = Vec::with_capacity(named.len());
    for tag in named {
        if !targets.contains(&tag) {
            targets.push(tag);
        }
    }
    targets
}

pub(super) fn tag_field(tag: &str) -> EditField {
    (false, format!("tag/{tag}"))
}

pub(super) fn same_tag_subject(a: &QueuedWrite, b: &QueuedWrite) -> bool {
    is_tag_write(a) && is_tag_write(b) && a.item_id.is_some() && a.item_id == b.item_id
}

pub(super) fn supersedes_dead(later: &QueuedWrite, dead: &QueuedWrite) -> bool {
    match (dead.kind, later.kind) {
        (WriteKind::AddTag | WriteKind::RemoveTag, WriteKind::AddTag | WriteKind::RemoveTag) => {
            dead.item_id.is_some()
                && dead.item_id == later.item_id
                && dead.tag.is_some()
                && dead.tag == later.tag
        }
        (
            WriteKind::DeleteItem | WriteKind::RestoreItem | WriteKind::TransitionItem,
            WriteKind::DeleteItem | WriteKind::RestoreItem | WriteKind::TransitionItem,
        ) => dead.item_id.is_some() && dead.item_id == later.item_id,
        (WriteKind::CreateEdge | WriteKind::UpdateEdge, WriteKind::DeleteEdge)
        | (WriteKind::DeleteEdge, WriteKind::CreateEdge) => {
            dead.edge_id.is_some() && dead.edge_id == later.edge_id
        }
        (WriteKind::UploadBlob, WriteKind::UploadBlob) => {
            dead.blob.is_some() && dead.blob == later.blob
        }
        _ => {
            dead.kind == later.kind
                && dead.subject_id().is_some()
                && dead.subject_id() == later.subject_id()
                && dead.namespace == later.namespace
                && dead.body == later.body
        }
    }
}

pub(super) fn learn_dead_effects(
    conn: &Connection,
    accepted: &QueuedWrite,
) -> Result<(), CoreError> {
    let older = read_writes(
        conn,
        "WHERE verdict = 'dead' AND seq < (SELECT seq FROM queue WHERE id = ?1)
          AND (item_id = ?2 OR edge_id = ?3 OR blob = ?4)",
        params![
            accepted.id,
            accepted.item_id,
            accepted.edge_id,
            accepted.blob
        ],
    )?;
    for dead in older {
        let mut effect = dead_effect(conn, &dead)?;
        if effect.excluded_attempts.contains(&accepted.idempotency_key) {
            continue;
        }
        if same_tag_subject(&dead, accepted) {
            if accepted.kind == WriteKind::ReplaceTags {
                effect.whole = true;
            } else {
                let original = tag_targets(&dead);
                let covered = tag_targets(accepted);
                effect.fields.extend(
                    covered
                        .iter()
                        .filter(|tag| {
                            dead.kind == WriteKind::ReplaceTags || original.contains(*tag)
                        })
                        .map(|tag| tag_field(tag)),
                );
                if original.is_empty()
                    && dead.kind != WriteKind::ReplaceTags
                    && dead.kind == accepted.kind
                    && dead.body == accepted.body
                {
                    effect.whole = true;
                }
            }
        } else if matches!(dead.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge)
            && dead.kind == accepted.kind
            && match dead.kind {
                WriteKind::UpdateItem => dead.item_id.is_some() && dead.item_id == accepted.item_id,
                _ => dead.edge_id.is_some() && dead.edge_id == accepted.edge_id,
            }
        {
            let original = edit_fields(conn, &dead)?;
            let covered = edit_fields(conn, accepted)?;
            effect.fields.extend(
                original
                    .iter()
                    .filter(|field| {
                        covered.contains(*field) || (field.0 && replaces_properties(&accepted.body))
                    })
                    .cloned(),
            );
            if original.is_empty() && dead.body == accepted.body {
                effect.whole = true;
            }
        } else if supersedes_dead(accepted, &dead) {
            effect.whole = true;
        }
        if effect.whole || !effect.fields.is_empty() {
            meta_set(
                conn,
                &effect_key(&dead.id),
                &serde_json::to_string(&effect)?,
            )?;
        }
    }
    Ok(())
}

pub(super) fn remaining_dead_fields(
    conn: &Connection,
    row: &QueuedWrite,
) -> Result<Option<HashSet<EditField>>, CoreError> {
    let effect = dead_effect(conn, row)?;
    if effect.whole {
        return Ok(Some(HashSet::new()));
    }
    if is_tag_write(row) && row.kind != WriteKind::ReplaceTags {
        let mut fields: HashSet<EditField> =
            tag_targets(row).iter().map(|tag| tag_field(tag)).collect();
        if fields.is_empty() {
            return Ok(None);
        }
        fields.retain(|field| !effect.fields.contains(field));
        return Ok(Some(fields));
    }
    if matches!(row.kind, WriteKind::UpdateItem | WriteKind::UpdateEdge) {
        let mut fields = edit_fields(conn, row)?;
        // An unrecognised or empty request remains held until an explicit
        // accepted equivalent settles it.
        if fields.is_empty() {
            return Ok(None);
        }
        fields.retain(|field| !effect.fields.contains(field));
        Ok(Some(fields))
    } else {
        Ok(None)
    }
}
