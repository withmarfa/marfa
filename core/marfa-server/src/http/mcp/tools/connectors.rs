//! `marfa_connectors` and `marfa_make_endpoint`: the connectors, their runs and inbound endpoints, and making an endpoint.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::connectors::Window;
use crate::app::inbound::{self, NewEndpoint};
use crate::app::{App, connectors};
use crate::http::mcp::results::{
    ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list, fitted_page, json_length,
};

pub const LIST_NAME: &str = "marfa_connectors";
pub const ENDPOINT_NAME: &str = "marfa_make_endpoint";

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

pub fn endpoint_definition() -> Definition {
    Definition {
        name: ENDPOINT_NAME,
        title: "Make an inbound endpoint for a connector",
        description: "Use to make an inbound endpoint that delivers to a connector. The answer holds the endpoint's address once: the address is what lets a sender deliver, so give it only to the sender.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The connector." },
                "label": { "type": "string", "minLength": 1, "description": "A name for the endpoint." },
                "duplicate_header": { "type": "string", "minLength": 1,
                    "description": "The header that names a delivery, so a repeat is dropped." },
            },
            "required": ["id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "endpoint": { "type": "object" },
            },
            "required": ["endpoint"],
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
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
    let cursor = text(&arguments, "runs_cursor");
    let room =
        ANSWER_BUDGET_CHARS.saturating_sub(json_length(&connector) + json_length(&endpoints) + 500);
    let page = fitted_page(limit, room, |limit| {
        let (id, cursor) = (id.clone(), cursor.clone());
        async move {
            let window = Window::open(
                app,
                format!("connector-runs:{id}"),
                limit,
                cursor.as_deref(),
            )?;
            Ok(connectors::runs(app, caller, id, window).await?)
        }
    })
    .await?;
    let mut answer = Map::new();
    answer.insert("connector".into(), connector);
    answer.insert("endpoints".into(), endpoints["data"].clone());
    answer.insert("runs".into(), page["data"].clone());
    answer.insert("runs_next_cursor".into(), page["next_cursor"].clone());
    Ok(Value::Object(answer))
}

pub async fn make_endpoint(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
) -> Outcome {
    caller.require(Permission::ConnectorsManage)?;
    let id = text(&arguments, "id").unwrap_or_default();
    let body: Map<String, Value> = arguments
        .into_iter()
        .filter(|(name, _)| name == "label" || name == "duplicate_header")
        .collect();
    let request = NewEndpoint::parse(&body)?;
    let made = inbound::create_endpoint(app, caller, id, request).await?;
    Ok(json!({ "endpoint": made }))
}
