//! `marfa_health`: how the instance is doing and what its connectors report.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::Definition;
use crate::app::access::{Caller, Permission};
use crate::app::refusal::Refusal;
use crate::app::{App, connectors, health, housekeeping};
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
        description: "Use to check this Marfa: whether it is serving and each component's state, and each connector's last run and problems.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "health": { "type": "object", "properties": { "status": { "type": "string" } },
                    "required": ["status"] },
                "connectors": { "type": "array", "items": { "type": "object" } },
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

pub async fn run(app: &Arc<App>, caller: &Caller) -> Outcome {
    let report = health::check(app).await;
    let reads_errors = caller.holds(Permission::InstanceRead);
    let mut health = report.to_json(reads_errors);
    if reads_errors {
        health["housekeeping"] = housekeeping::attention(app).await;
    }
    // A read that is refused leaves the others standing: a down instance is when health matters most.
    let mut unreadable: Vec<Value> = Vec::new();
    let mut listed: Vec<Value> = Vec::new();
    match connectors::list(app, caller).await {
        Ok(answer) => {
            if let Some(data) = answer.get("data").and_then(Value::as_array) {
                listed = data.iter().map(connector_state).collect();
            }
        }
        Err(refusal) => unreadable.push(unread("connectors", &refusal)),
    }
    let room = ANSWER_BUDGET_CHARS
        .saturating_sub(json_length(&json!({ "health": health, "unread": unreadable })) + 200);
    let (kept, left_out) = fit_list(listed, room);
    let mut answer = Map::new();
    answer.insert("health".into(), health);
    if unreadable.is_empty() {
        answer.insert("connectors".into(), Value::Array(kept));
        if left_out > 0 {
            answer.insert("connectors_left_out".into(), true.into());
        }
    } else {
        answer.insert("unread".into(), Value::Array(unreadable));
    }
    Ok(Value::Object(answer))
}
