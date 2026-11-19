//! `marfa_connectors` and `marfa_manage_connector`: the connectors, their inbound endpoints, and removing them.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Step, confirm_property};
use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::inbound::{self, NewEndpoint};
use crate::app::{App, connectors};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_connectors";
pub const MANAGE_NAME: &str = "marfa_manage_connector";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List connectors and their endpoints",
        description: "Use to see the connectors registered with this instance. With id, shows that connector and the inbound endpoints that deliver to it. marfa_health shows each connector's last run and problems.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "One connector to read." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "connectors": { "type": "array", "items": { "type": "object" } },
                "connector": { "type": "object" },
                "endpoints": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn manage_definition() -> Definition {
    Definition {
        name: MANAGE_NAME,
        title: "Change or remove a connector",
        description: "Use to remove a connector, clear what it remembers between runs, make an inbound endpoint for it, or retire one. Removing, clearing and retiring first preview: show the person, and call again with the same arguments and confirm. A confirmation holds only for the arguments it previewed. Making an endpoint returns its address once.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string",
                    "enum": ["delete", "clear_state", "make_endpoint", "retire_endpoint"] },
                "id": { "type": "string", "minLength": 1, "description": "The connector." },
                "endpoint_id": { "type": "string", "minLength": 1,
                    "description": "The endpoint to retire." },
                "label": { "type": "string", "minLength": 1, "description": "A name for a new endpoint." },
                "duplicate_header": { "type": "string", "minLength": 1,
                    "description": "The header that names a delivery, so a repeat is dropped." },
                "confirm": confirm_property(),
            },
            "required": ["action", "id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "endpoint": { "type": "object" },
                "retired": { "type": "object" },
                "deleted": { "type": "string" },
                "cleared": { "type": "string" },
                "next": { "type": "string" },
            },
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

pub async fn list(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ConnectorsManage)?;
    if let Some(id) = text(&arguments, "id") {
        let connector = connectors::read(app, caller, id.clone()).await?;
        let endpoints = inbound::list_endpoints(app, caller, id).await?;
        return Ok(json!({ "connector": connector, "endpoints": endpoints["data"] }));
    }
    let listed = connectors::list(app, caller).await?;
    let data = listed["data"].as_array().cloned().unwrap_or_default();
    let (kept, left_out) = fit_list(data, ANSWER_BUDGET_CHARS - 200);
    let mut answer = Map::new();
    answer.insert("connectors".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

fn confirmed_step(
    app: &App,
    caller: &Caller,
    arguments: &Map<String, Value>,
    effect: &str,
) -> Result<Step, Stop> {
    let preview = json!({
        "action": arguments.get("action"),
        "connector": arguments.get("id"),
        "endpoint": arguments.get("endpoint_id"),
        "effect": effect,
    });
    confirmed::gate(
        app,
        caller,
        MANAGE_NAME,
        arguments,
        "",
        preview,
        "what the connector loses",
    )
}

pub async fn manage(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::ConnectorsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    match text(&arguments, "action").as_deref() {
        Some("make_endpoint") => {
            let body: Map<String, Value> = ["label", "duplicate_header"]
                .iter()
                .filter_map(|name| {
                    arguments
                        .get(*name)
                        .map(|v| ((*name).to_string(), v.clone()))
                })
                .collect();
            let request = NewEndpoint::parse(&body)?;
            let made = inbound::create_endpoint(app, caller, id, request).await?;
            Ok(json!({ "endpoint": made }))
        }
        Some("retire_endpoint") => {
            let Some(endpoint_id) = text(&arguments, "endpoint_id") else {
                return Err(Stop::coded(
                    "missing_required_field",
                    "Name the endpoint with endpoint_id (endpoint_id).",
                ));
            };
            let step = confirmed_step(
                app,
                caller,
                &arguments,
                "The endpoint stops accepting deliveries.",
            )?;
            if let Step::Preview(body) = step {
                return Ok(body);
            }
            let retired = inbound::retire_endpoint(app, caller, id, endpoint_id).await?;
            Ok(json!({ "retired": retired }))
        }
        Some("clear_state") => {
            let step = confirmed_step(
                app,
                caller,
                &arguments,
                "What the connector remembers between runs is cleared.",
            )?;
            if let Step::Preview(body) = step {
                return Ok(body);
            }
            connectors::clear_state(app, caller, id.clone()).await?;
            Ok(json!({ "cleared": id }))
        }
        _ => {
            let step = confirmed_step(
                app,
                caller,
                &arguments,
                "The connector's registration is removed.",
            )?;
            if let Step::Preview(body) = step {
                return Ok(body);
            }
            connectors::remove(app, caller, id.clone()).await?;
            Ok(json!({ "deleted": id }))
        }
    }
}
