//! Updates items in steps guarded by the preceding step's version.

use std::sync::Arc;

use chrono::DateTime;
use serde_json::{Map, Value, json};

use super::{Definition, item_id, parsed, text, texts};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::edges::write::{Create, Delete, Op};
use crate::app::edges::{ItemListing, Reach};
use crate::app::items::write::{self, Change, Settle};
use crate::app::items::{self, Detail};
use crate::app::refusal::{Code, Refusal};
use crate::http::items::{tags_of, update_from};
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_update";

/// How many pages of an item's history a stale answer reads for its base.
const HISTORY_PAGES: usize = 10;
const HISTORY_PAGE_SIZE: i64 = 200;
const EDGE_PAGE_SIZE: i64 = 500;

pub fn definition() -> Definition {
    let edge = json!({
        "type": "object",
        "properties": {
            "edge_type": { "type": "string", "minLength": 1 },
            "target_id": { "type": "string", "minLength": 1 },
        },
        "required": ["edge_type", "target_id"],
        "additionalProperties": false,
    });
    Definition {
        name: NAME,
        title: "Change an item",
        description: "Use to change an item's fields, tags or edges, archive it, or restore it from the trash. Send the version you read with marfa_get; if the item changed since, nothing is written and you get it as it is now and which of your fields changed.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The item's ID." },
                "version": { "type": "integer", "minimum": 1,
                    "description": "The version you last read." },
                "properties": { "type": "object",
                    "description": "Fields to set. Fields you leave out keep their values, unless properties_mode is `replace`." },
                "properties_mode": { "type": "string", "enum": ["merge", "replace"],
                    "description": "`replace` makes properties all the item's fields; `merge` by default." },
                "clear_properties": { "type": "array", "items": { "type": "string" },
                    "description": "Fields to remove; not also in properties." },
                "tier": { "type": "string", "enum": ["library", "feed"] },
                "occurred_at": { "type": "string", "description": "The item's own time (RFC 3339)." },
                "add_tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "remove_tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "add_edges": { "type": "array", "items": edge, "description": "Edges to add from this item." },
                "remove_edges": { "type": "array", "items": edge, "description": "Edges to remove from this item." },
                "state": { "type": "string", "enum": ["active", "archived"],
                    "description": "`archived` archives the item; `active` brings it back from the archive or the trash. An item in the trash takes no other change until restored." },
            },
            "required": ["id", "version"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "version": { "type": "integer" },
                "state": { "type": "string" },
                "applied": { "type": "array", "items": { "type": "string" } },
            },
            "required": ["id", "version", "state", "applied"],
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        }),
        meta: None,
    }
}

struct EdgeRef {
    edge_type: String,
    target_id: String,
}

fn edge_refs(arguments: &Map<String, Value>, name: &str) -> Result<Vec<EdgeRef>, Stop> {
    let mut refs = Vec::new();
    for entry in arguments
        .get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let (Some(edge_type), Some(target_id)) = (
            entry.get("edge_type").and_then(Value::as_str),
            entry.get("target_id").and_then(Value::as_str),
        ) else {
            continue;
        };
        item_id(target_id)?;
        refs.push(EdgeRef {
            edge_type: edge_type.to_string(),
            target_id: target_id.to_string(),
        });
    }
    Ok(refs)
}

fn version_and_state(done: &write::Done) -> Result<(i64, String), Stop> {
    let body = parsed(&done.body)?;
    let item = body.get("item").unwrap_or(&Value::Null);
    let version = item.get("version").and_then(Value::as_i64);
    let state = item.get("state").and_then(Value::as_str);
    match (version, state) {
        (Some(version), Some(state)) => Ok((version, state.to_string())),
        _ => Err(Stop::refused(Refusal::internal(
            "an item write answered no item",
        ))),
    }
}

/// What a stale or colliding write carries, kept for the agent to decide on.
fn conflict_extra(mut stop: Stop) -> Stop {
    let kept: Vec<(String, Value)> = stop
        .refusal
        .as_ref()
        .and_then(|refusal| refusal.members.as_ref())
        .map(|members| {
            ["current", "conflicting_fields"]
                .into_iter()
                .filter_map(|name| {
                    members
                        .get(name)
                        .map(|value| (name.to_string(), value.clone()))
                })
                .collect()
        })
        .unwrap_or_default();
    for (name, value) in kept {
        stop.error.insert(name, value);
    }
    stop
}

/// The item as it was at `version`, from its history.
async fn snapshot_at(app: &Arc<App>, caller: &Caller, id: &str, version: i64) -> Option<Value> {
    let mut cursor: Option<String> = None;
    for _ in 0..HISTORY_PAGES {
        let page = items::history(
            app,
            caller,
            id.to_string(),
            HISTORY_PAGE_SIZE,
            cursor.clone(),
        )
        .await
        .ok()?;
        let page: Value = serde_json::from_str(&page).ok()?;
        let versions = page.get("data")?.as_array()?;
        if let Some(found) = versions
            .iter()
            .find(|entry| entry.get("version").and_then(Value::as_i64) == Some(version))
        {
            return Some(found.clone());
        }
        if versions
            .iter()
            .any(|entry| entry.get("version").and_then(Value::as_i64) > Some(version))
        {
            return None;
        }
        cursor = page
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        cursor.as_ref()?;
    }
    None
}

fn same_time(a: Option<&str>, b: Option<&str>) -> bool {
    if a == b {
        return true;
    }
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    match (
        DateTime::parse_from_rfc3339(a),
        DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Reports fields both sides changed, including fields removed by replacement.
fn conflicting_fields(
    arguments: &Map<String, Value>,
    base: &Value,
    current: &Value,
) -> Vec<String> {
    let empty = Map::new();
    let before = base
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let now = current
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let sent = arguments
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut changed: std::collections::BTreeSet<String> = sent
        .iter()
        .filter(|(key, value)| before.get(*key) != Some(*value))
        .map(|(key, _)| key.clone())
        .collect();
    if arguments.get("properties_mode").and_then(Value::as_str) == Some("replace") {
        changed.extend(
            before
                .keys()
                .filter(|key| !sent.contains_key(*key))
                .cloned(),
        );
    }
    for key in texts(arguments, "clear_properties") {
        if before.contains_key(&key) {
            changed.insert(key);
        }
    }
    let mut fields: Vec<String> = changed
        .into_iter()
        .filter(|key| now.get(key) != before.get(key))
        .collect();
    let tier = |value: &Value| {
        value
            .get("tier")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    if let Some(sent_tier) = text(arguments, "tier")
        && Some(&sent_tier) != tier(base).as_ref()
        && tier(current) != tier(base)
    {
        fields.push("tier".into());
    }
    let occurred = |value: &Value| {
        value
            .get("occurred_at")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    if let Some(sent_at) = text(arguments, "occurred_at")
        && !same_time(Some(&sent_at), occurred(base).as_deref())
        && !same_time(occurred(current).as_deref(), occurred(base).as_deref())
    {
        fields.push("occurred_at".into());
    }
    fields.sort();
    fields
}

/// Reports the current item and overlapping changes for a stale version.
async fn stale_answer(
    app: &Arc<App>,
    caller: &Caller,
    arguments: &Map<String, Value>,
    current: &Value,
    version: i64,
) -> Stop {
    let now = current
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let id = current
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stop = Stop::coded(
        "version_conflict",
        format!("The item is at version {now}, not {version}. Nothing was changed."),
    )
    .with(
        "hint",
        "Read the item again with marfa_get, decide whether your change still applies, and send the version you read.",
    )
    .with("current", current.clone());
    match snapshot_at(app, caller, id, version).await {
        None => stop.with(
            "note",
            format!(
                "Marfa holds no snapshot of version {version} that this credential can read, so which fields changed since is not known."
            ),
        ),
        Some(base) => stop.with("conflicting_fields", json!(conflicting_fields(arguments, &base, current))),
    }
}

/// The edge of the item's `edge_type` to `target_id`, from its outgoing edges.
async fn find_edge(
    app: &Arc<App>,
    caller: &Caller,
    id: &str,
    edge_type: &str,
    target_id: &str,
) -> Result<Option<String>, Refusal> {
    let mut cursor: Option<String> = None;
    loop {
        let page = items_edges(app, caller, id, edge_type, cursor.clone()).await?;
        if let Some(found) = page
            .get("data")
            .and_then(Value::as_array)
            .and_then(|data| {
                data.iter()
                    .find(|edge| edge.get("target_id").and_then(Value::as_str) == Some(target_id))
            })
            .and_then(|edge| edge.get("id").and_then(Value::as_str))
        {
            return Ok(Some(found.to_string()));
        }
        cursor = page
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            return Ok(None);
        }
    }
}

async fn items_edges(
    app: &Arc<App>,
    caller: &Caller,
    id: &str,
    edge_type: &str,
    cursor: Option<String>,
) -> Result<Value, Refusal> {
    let listing = ItemListing {
        edge_types: vec![edge_type.to_string()],
        cursor,
        limit: EDGE_PAGE_SIZE,
    };
    let text =
        crate::app::edges::of_item(app, caller, id.to_string(), Reach::Outbound, listing).await?;
    serde_json::from_str(&text).map_err(|_| Refusal::internal("an edge listing did not read"))
}

/// Whether the call asks only to bring the item back to `active`.
fn restore_only(arguments: &Map<String, Value>) -> bool {
    arguments.get("state").and_then(Value::as_str) == Some("active")
        && arguments
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "version" | "state"))
}

pub async fn run(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
    exact: Result<(), Refusal>,
) -> Outcome {
    let id = text(&arguments, "id").unwrap_or_default();
    item_id(&id)?;
    let Some(version) = arguments.get("version").and_then(Value::as_i64) else {
        return Err(Stop::invalid("version must be a whole number."));
    };
    let add_edges = edge_refs(&arguments, "add_edges")?;
    let remove_edges = edge_refs(&arguments, "remove_edges")?;
    let add_tags = texts(&arguments, "add_tags");
    let remove_tags = texts(&arguments, "remove_tags");
    let wanted_state = text(&arguments, "state");

    let read = items::detail(app, caller, id.clone(), Detail::default()).await;
    let current = match read {
        Ok(text) => parsed(&text)?.get("item").cloned().unwrap_or(Value::Null),
        // Trashed items cannot be read by ID; restoration checks their retained version.
        Err(refusal) if refusal.code == Code::ItemNotFound && restore_only(&arguments) => {
            let change = Change::Transition {
                id: id.clone(),
                state: "active".to_string(),
                version: Some(version),
            };
            let done = write::run(app, caller, None, change)
                .await
                .map_err(|refusal| conflict_extra(Stop::refused(refusal)))?;
            let (version, state) = version_and_state(&done)?;
            return Ok(json!({
                "id": id,
                "version": version,
                "state": state,
                "applied": ["state active"],
            }));
        }
        Err(refusal) => return Err(Stop::refused(refusal)),
    };
    if current.get("version").and_then(Value::as_i64) != Some(version) {
        return Err(stale_answer(app, caller, &arguments, &current, version).await);
    }
    let mut state = current
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut version = version;
    let mut applied: Vec<String> = Vec::new();

    let stop_at = |step: String, applied: &[String], refusal: Refusal| {
        let mut stop = conflict_extra(Stop::refused(refusal))
            .with("failed_step", step)
            .with("applied", json!(applied))
            .wrote(!applied.is_empty());
        if !applied.is_empty() {
            stop = stop.with(
                "note",
                "The steps in applied were written before this one failed.",
            );
        }
        stop
    };

    let patching = arguments.contains_key("properties")
        || !texts(&arguments, "clear_properties").is_empty()
        || arguments.contains_key("tier")
        || arguments.contains_key("occurred_at");
    if patching {
        let mut sent = Map::new();
        sent.insert("version".into(), version.into());
        sent.insert("version_match".into(), "exact".into());
        for name in ["properties", "properties_mode", "tier", "occurred_at"] {
            if let Some(value) = arguments.get(name) {
                sent.insert(name.into(), value.clone());
            }
        }
        let cleared = texts(&arguments, "clear_properties");
        if !cleared.is_empty() {
            sent.insert("clear_properties".into(), json!(cleared));
        }
        let update = update_from(id.clone(), Settle::Refuse, sent, || exact)
            .map_err(|refusal| stop_at("properties".into(), &applied, refusal))?;
        let done = write::run(app, caller, None, Change::Update(Box::new(update)))
            .await
            .map_err(|refusal| stop_at("properties".into(), &applied, refusal))?;
        (version, state) = version_and_state(&done)?;
        applied.push("properties".into());
    }

    for edge in &add_edges {
        let step = format!("add_edge {}", edge.edge_type);
        let op = Op::Create(Create {
            id: None,
            source_id: id.clone(),
            target_id: edge.target_id.clone(),
            edge_type: edge.edge_type.clone(),
            properties: Map::new(),
            source_version: Some(version),
        });
        crate::app::edges::write::run(app, caller, None, op)
            .await
            .map_err(|refusal| stop_at(step, &applied, refusal))?;
        applied.push(format!("add_edge {} {}", edge.edge_type, edge.target_id));
    }

    for edge in &remove_edges {
        let step = format!("remove_edge {}", edge.edge_type);
        let found = find_edge(app, caller, &id, &edge.edge_type, &edge.target_id)
            .await
            .map_err(|refusal| stop_at(step.clone(), &applied, refusal))?;
        let Some(edge_id) = found else {
            return Err(stop_at(
                step,
                &applied,
                Refusal::new(
                    Code::EdgeNotFound,
                    format!(
                        "The item has no {} edge to {}.",
                        edge.edge_type, edge.target_id
                    ),
                ),
            ));
        };
        let op = Op::Delete(Delete {
            id: edge_id,
            source_version: Some(version),
        });
        crate::app::edges::write::run(app, caller, None, op)
            .await
            .map_err(|refusal| stop_at(step, &applied, refusal))?;
        applied.push(format!("remove_edge {} {}", edge.edge_type, edge.target_id));
    }

    if let Some(wanted) = wanted_state.filter(|wanted| *wanted != state) {
        let step = format!("state {wanted}");
        let change = Change::Transition {
            id: id.clone(),
            state: wanted.clone(),
            version: Some(version),
        };
        let done = write::run(app, caller, None, change)
            .await
            .map_err(|refusal| stop_at(step, &applied, refusal))?;
        (version, state) = version_and_state(&done)?;
        applied.push(format!("state {wanted}"));
    }

    if !add_tags.is_empty() {
        let tags = tags_of(&json!(add_tags))
            .map_err(|refusal| stop_at("add_tags".into(), &applied, refusal))?;
        let change = Change::AddTags {
            id: id.clone(),
            tags,
            version: Some(version),
        };
        write::run(app, caller, None, change)
            .await
            .map_err(|refusal| stop_at("add_tags".into(), &applied, refusal))?;
        applied.push("add_tags".into());
    }
    for tag in remove_tags {
        let step = format!("remove_tag {tag}");
        let change = Change::RemoveTag {
            id: id.clone(),
            tag: tag.clone(),
            version: Some(version),
        };
        write::run(app, caller, None, change)
            .await
            .map_err(|refusal| stop_at(step, &applied, refusal))?;
        applied.push(format!("remove_tag {tag}"));
    }

    if applied.is_empty() {
        return Err(Stop::invalid(
            "Nothing to change: name at least one change.",
        ));
    }
    Ok(json!({ "id": id, "version": version, "state": state, "applied": applied }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn only_a_field_both_sides_changed_conflicts() {
        let base = json!({ "properties": { "title": "a", "body": "b", "keep": 1 } });
        let current = json!({ "properties": { "title": "changed", "body": "b", "keep": 1 } });
        let sent = arguments(json!({ "properties": { "title": "mine", "body": "b2", "keep": 1 } }));
        assert_eq!(conflicting_fields(&sent, &base, &current), vec!["title"]);
    }

    #[test]
    fn replace_and_clear_count_the_fields_they_remove() {
        let base = json!({ "properties": { "a": 1, "b": 2, "c": 3 } });
        let current = json!({ "properties": { "a": 9, "b": 8, "c": 3 } });
        let sent = arguments(json!({
            "properties": { "c": 3 },
            "properties_mode": "replace",
            "clear_properties": ["b"],
        }));
        assert_eq!(conflicting_fields(&sent, &base, &current), vec!["a", "b"]);
    }

    #[test]
    fn a_time_written_another_way_is_the_same_time() {
        assert!(same_time(
            Some("2026-01-01T00:00:00Z"),
            Some("2026-01-01T01:00:00+01:00")
        ));
        assert!(!same_time(Some("2026-01-01T00:00:00Z"), None));
    }

    #[test]
    fn only_a_bare_state_active_is_a_restore() {
        assert!(restore_only(&arguments(
            json!({ "id": "x", "version": 1, "state": "active" })
        )));
        assert!(!restore_only(&arguments(
            json!({ "id": "x", "version": 1, "state": "active", "add_tags": ["a"] })
        )));
        assert!(!restore_only(&arguments(
            json!({ "id": "x", "version": 1 })
        )));
    }
}
