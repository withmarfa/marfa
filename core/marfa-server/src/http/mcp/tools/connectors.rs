//! `marfa_connectors` and `marfa_manage_connector`: the connectors, their runs and inbound endpoints, and removing them.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Shown, confirm_property};
use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::connectors::Window;
use crate::app::inbound::{self, NewEndpoint};
use crate::app::mcp::confirm::Confirmed;
use crate::app::{App, connectors};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_connectors";
pub const MANAGE_NAME: &str = "marfa_manage_connector";

const RUNS_PAGE: i64 = 20;
const MOST_RUNS: i64 = 200;

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List connectors, their runs and their endpoints",
        description: "Use to see the connectors registered with this instance. With id, shows that connector, its runs newest first and the inbound endpoints that deliver to it; pass runs_cursor to read older runs. marfa_health shows each connector's last run and problems.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "One connector to read." },
                "runs_limit": { "type": "integer", "minimum": 1, "maximum": MOST_RUNS,
                    "description": format!("How many runs, {RUNS_PAGE} when left out. Only with id.") },
                "runs_cursor": { "type": "string", "minLength": 1,
                    "description": "Where to continue reading runs: the runs_next_cursor of the last answer. Only with id." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "connectors": { "type": "array", "items": { "type": "object" } },
                "connector": { "type": "object" },
                "runs": { "type": "array", "items": { "type": "object" } },
                "runs_next_cursor": { "type": ["string", "null"] },
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
        description: "Use to remove a connector, clear what it remembers between runs, make an inbound endpoint for it, or retire one. Removing, clearing and retiring first preview: show the person, and call again with the same arguments and confirm. A confirmation works once, and only while what it previewed is unchanged. Making an endpoint returns its address once.",
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
    let Some(id) = text(&arguments, "id") else {
        if arguments.contains_key("runs_limit") || arguments.contains_key("runs_cursor") {
            return Err(Stop::invalid("runs_limit and runs_cursor go with id."));
        }
        let listed = connectors::list(app, caller).await?;
        let data = listed["data"].as_array().cloned().unwrap_or_default();
        let (kept, left_out) = fit_list(data, ANSWER_BUDGET_CHARS - 200);
        let mut answer = Map::new();
        answer.insert("connectors".into(), Value::Array(kept));
        if left_out > 0 {
            answer.insert("left_out".into(), left_out.into());
        }
        return Ok(Value::Object(answer));
    };
    let connector = connectors::read(app, caller, id.clone()).await?;
    let endpoints = inbound::list_endpoints(app, caller, id.clone()).await?;
    let limit = arguments
        .get("runs_limit")
        .and_then(Value::as_i64)
        .unwrap_or(RUNS_PAGE);
    let window = Window::open(
        app,
        format!("connector-runs:{id}"),
        limit,
        text(&arguments, "runs_cursor").as_deref(),
    )?;
    let page = connectors::runs(app, caller, id, window).await?;
    let runs = page["data"].as_array().cloned().unwrap_or_default();
    let (kept, left_out) = fit_list(runs, ANSWER_BUDGET_CHARS / 2);
    let mut answer = Map::new();
    answer.insert("connector".into(), connector);
    answer.insert("endpoints".into(), endpoints["data"].clone());
    answer.insert("runs".into(), Value::Array(kept));
    if left_out == 0 {
        answer.insert("runs_next_cursor".into(), page["next_cursor"].clone());
    } else {
        answer.insert("runs_next_cursor".into(), Value::Null);
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

fn shown<'a>(arguments: &'a Map<String, Value>, state: String, effect: &str) -> Shown<'a> {
    Shown {
        tool: MANAGE_NAME,
        arguments,
        state,
        preview: json!({
            "action": arguments.get("action"),
            "connector": arguments.get("id"),
            "endpoint": arguments.get("endpoint_id"),
            "effect": effect,
        }),
        what: "what the connector loses",
    }
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
        Some("retire_endpoint") => retire(app, caller, &arguments, id).await,
        Some("clear_state") => {
            let effect = "What the connector remembers between runs is cleared.";
            let state = connectors::confirm_state(app, caller, id.clone(), true).await?;
            let Some(confirming) = confirmed::confirming(app, caller, MANAGE_NAME, &arguments)
            else {
                return confirmed::preview(app, caller, shown(&arguments, state, effect));
            };
            match connectors::clear_state_confirmed(app, caller, id.clone(), confirming).await? {
                Confirmed::Done(()) => Ok(json!({ "cleared": id })),
                Confirmed::Stale => {
                    let state = connectors::confirm_state(app, caller, id, true).await?;
                    Err(confirmed::stale(
                        app,
                        caller,
                        shown(&arguments, state, effect),
                    ))
                }
            }
        }
        _ => {
            let effect = "The connector's registration is removed.";
            let state = connectors::confirm_state(app, caller, id.clone(), false).await?;
            let Some(confirming) = confirmed::confirming(app, caller, MANAGE_NAME, &arguments)
            else {
                return confirmed::preview(app, caller, shown(&arguments, state, effect));
            };
            match connectors::remove_confirmed(app, caller, id.clone(), confirming).await? {
                Confirmed::Done(()) => Ok(json!({ "deleted": id })),
                Confirmed::Stale => {
                    let state = connectors::confirm_state(app, caller, id, false).await?;
                    Err(confirmed::stale(
                        app,
                        caller,
                        shown(&arguments, state, effect),
                    ))
                }
            }
        }
    }
}

async fn retire(
    app: &Arc<App>,
    caller: &Caller,
    arguments: &Map<String, Value>,
    id: String,
) -> Outcome {
    let Some(endpoint_id) = text(arguments, "endpoint_id") else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the endpoint with endpoint_id (endpoint_id).",
        ));
    };
    let effect = "The endpoint stops accepting deliveries.";
    let state = inbound::retire_state(app, caller, id.clone(), endpoint_id.clone()).await?;
    let Some(confirming) = confirmed::confirming(app, caller, MANAGE_NAME, arguments) else {
        return confirmed::preview(app, caller, shown(arguments, state, effect));
    };
    let retired = inbound::retire_endpoint_confirmed(
        app,
        caller,
        id.clone(),
        endpoint_id.clone(),
        confirming,
    );
    match retired.await? {
        Confirmed::Done(retired) => Ok(json!({ "retired": retired })),
        Confirmed::Stale => {
            let state = inbound::retire_state(app, caller, id, endpoint_id).await?;
            Err(confirmed::stale(
                app,
                caller,
                shown(arguments, state, effect),
            ))
        }
    }
}
