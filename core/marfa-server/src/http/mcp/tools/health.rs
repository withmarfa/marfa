//! `marfa_health`: how the instance is doing and what its connectors report.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::refusal::Refusal;
use crate::app::{App, attention, connectors, health, housekeeping, jobs, metrics, updates};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list, json_length};

pub const NAME: &str = "marfa_health";

const CONNECTOR_FIELDS: [&str; 7] = [
    "id",
    "name",
    "source",
    "last_heartbeat_at",
    "last_run",
    "problems",
    "hold_expires_at",
];

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "How this Marfa is doing",
        description: "Use to check this Marfa: whether it is serving and each component's state, and each connector's last run and problems. With instance.read it also shows what needs attention, the housekeeping jobs, the metrics, the file stores and unreferenced files, whether a newer server is available, and with job_id one bulk job. A part that cannot be read is named in unread, and the others still answer.",
        input: json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string", "minLength": 1,
                    "description": "A bulk job to read, with instance.read." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "health": { "type": "object", "properties": { "status": { "type": "string" } },
                    "required": ["status"] },
                "connectors": { "type": "array", "items": { "type": "object" } },
                "attention": { "type": "array", "items": { "type": "object" } },
                "housekeeping_jobs": { "type": "array", "items": { "type": "object" } },
                "metrics": { "type": "object" },
                "storage": { "type": "object",
                    "description": "The file stores, the fewest copies kept of a file, and the unreferenced files." },
                "update": { "type": "object",
                    "description": "Whether a newer server is available, as GET /update reads it." },
                "job": { "type": "object" },
                "connectors_left_out": { "type": "boolean",
                    "description": "`true` when there are more connectors than this answer holds." },
                "unread": { "type": "array", "items": { "type": "object",
                    "properties": {
                        "read": { "type": "string" },
                        "code": { "type": "string" },
                        "message": { "type": "string" },
                    },
                    "required": ["read", "code", "message"],
                }, "description": "Each part that could not be read, with the error." },
            },
            "required": ["health"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

fn unread(read: &str, refusal: &Refusal) -> Value {
    json!({ "read": read, "code": refusal.code.wire(), "message": refusal.message })
}

fn connector_state(connector: &Value) -> Value {
    let mut state = Map::new();
    for field in CONNECTOR_FIELDS {
        if let Some(value) = connector.get(field) {
            state.insert(field.into(), value.clone());
        }
    }
    Value::Object(state)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let report = health::check(app).await;
    let reads_errors = caller.holds(Permission::InstanceRead);
    let mut health = report.to_json(reads_errors);
    if reads_errors {
        health["housekeeping"] = housekeeping::attention(app).await;
    }
    // Each part stands on its own: a down instance is when health matters most.
    let mut unreadable: Vec<Value> = Vec::new();
    let listed = match connectors::list(app, caller).await {
        Ok(answer) => Some(
            answer
                .get("data")
                .and_then(Value::as_array)
                .map(|data| data.iter().map(connector_state).collect::<Vec<_>>())
                .unwrap_or_default(),
        ),
        Err(refusal) => {
            unreadable.push(unread("connectors", &refusal));
            None
        }
    };
    let mut answer = Map::new();
    if let Err(refusal) = caller.require(Permission::InstanceRead) {
        if arguments.contains_key("job_id") {
            unreadable.push(unread("job", &refusal));
        }
    } else {
        answer = instance_reads(app, caller, &arguments, &mut unreadable).await;
    }
    let room = ANSWER_BUDGET_CHARS.saturating_sub(
        json_length(&json!({ "health": health, "unread": unreadable, "more": answer })) + 200,
    );
    answer.insert("health".into(), health);
    if let Some(listed) = listed {
        let (kept, left_out) = fit_list(listed, room);
        answer.insert("connectors".into(), Value::Array(kept));
        if left_out > 0 {
            answer.insert("connectors_left_out".into(), true.into());
        }
    }
    if !unreadable.is_empty() {
        answer.insert("unread".into(), Value::Array(unreadable));
    }
    Ok(Value::Object(answer))
}

/// What `instance.read` opens beyond the health report. A read that is refused is named in `unread`.
async fn instance_reads(
    app: &Arc<App>,
    caller: &Caller,
    arguments: &Map<String, Value>,
    unreadable: &mut Vec<Value>,
) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert(
        "attention".into(),
        attention::read(app).await["data"].clone(),
    );
    match housekeeping::list(app).await {
        Ok(listed) => {
            extra.insert("housekeeping_jobs".into(), Value::Array(listed));
        }
        Err(refusal) => unreadable.push(unread("housekeeping_jobs", &refusal)),
    }
    match metrics::read(app).await {
        Ok(found) => {
            extra.insert("metrics".into(), found);
        }
        Err(refusal) => unreadable.push(unread("metrics", &refusal)),
    }
    match storage(app, caller).await {
        Ok(found) => {
            extra.insert("storage".into(), found);
        }
        Err(refusal) => unreadable.push(unread("storage", &refusal)),
    }
    match updates::status(app).await {
        Ok(status) => {
            extra.insert("update".into(), status);
        }
        Err(refusal) => unreadable.push(unread("update", &refusal)),
    }
    if let Some(id) = text(arguments, "job_id") {
        match jobs::read(app, caller, id).await {
            Ok(job) => {
                extra.insert("job".into(), job);
            }
            Err(refusal) => unreadable.push(unread("job", &refusal)),
        }
    }
    extra
}

async fn storage(app: &Arc<App>, caller: &Caller) -> Result<Value, Refusal> {
    let (stores, min_copies) = app.blob_stores(caller).await?;
    let orphans = app.blob_orphans(caller).await?;
    let stores: Vec<Value> = stores
        .iter()
        .map(|store| {
            json!({
                "id": store.id,
                "kind": store.kind,
                "locator": store.locator,
                "attached_at": store.attached_at,
                "detached_at": store.detached_at,
            })
        })
        .collect();
    let orphans: Vec<Value> = orphans
        .iter()
        .map(|orphan| {
            json!({
                "hash": orphan.blob.hash.as_str(),
                "mime_type": orphan.blob.mime_type,
                "size_bytes": orphan.blob.size_bytes,
                "reported_at": orphan.reported_at,
            })
        })
        .collect();
    let (orphans, left_out) = fit_list(orphans, ANSWER_BUDGET_CHARS / 4);
    let mut found = Map::new();
    found.insert("stores".into(), Value::Array(stores));
    found.insert("min_copies".into(), min_copies.into());
    found.insert("unreferenced".into(), Value::Array(orphans));
    if left_out > 0 {
        found.insert("unreferenced_left_out".into(), left_out.into());
    }
    Ok(Value::Object(found))
}
