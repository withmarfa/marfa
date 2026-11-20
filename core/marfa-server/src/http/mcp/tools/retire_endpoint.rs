//! `marfa_retire_endpoint`: previews retiring a connector's inbound endpoint, then retires it on a
//! single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::stale;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::inbound::Retiring;
use crate::app::mcp::confirm;
use crate::app::mcp::connector::{self, Confirmed};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::Outcome;

pub const NAME: &str = connector::RETIRE_TOOL;

const PREVIEW_NEXT: &str = "Nothing has been retired. Retiring cannot be undone: the endpoint's address stops taking deliveries for good. Show the person and ask them; only if they agree, call marfa_retire_endpoint again with these ids and confirm.";
const KEPT: &str = "Deliveries the endpoint already took stay, and the connector still reads them.";
const ALREADY_RETIRED: &str = "This endpoint is already retired. There is nothing to confirm.";
const RETIRED_NEXT: &str = "Retired. The endpoint's address takes no more deliveries.";
const REPEATED_NEXT: &str =
    "This confirmation already retired this endpoint. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for this endpoint. This call retired nothing. Preview again to get a new confirmation.";
const CHANGED: &str =
    "What the preview showed has changed. This call retired nothing; here is a new preview.";
const CHANGED_GONE: &str =
    "What the preview showed has changed. This call retired nothing. Preview again.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Retire a connector's inbound endpoint",
        description: "Use to retire an inbound endpoint, so its address takes no more deliveries. Deliveries it already took stay. The first call only previews; show the person and ask. Only if they agree, call again with the same ids and confirm. A confirmation works once, for this credential only. This cannot be undone: a retired endpoint never takes deliveries again, and a sender needs a new endpoint.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The connector's ID." },
                "endpoint_id": { "type": "string", "minLength": 1, "description": "The endpoint's ID." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the same ids. Leave out to preview." },
            },
            "required": ["id", "endpoint_id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "endpoint": { "type": "object" },
                "unhandled_deliveries": { "type": "integer",
                    "description": "Deliveries the endpoint took that are not yet handled; they stay." },
                "kept": { "type": "string" },
                "already_retired": { "type": "boolean" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "retired": { "type": "boolean" },
                "already_done": { "type": "boolean" },
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

fn preview_body(
    app: &App,
    caller: &Caller,
    (connector_id, endpoint_id): (&str, &str),
    retiring: Retiring,
) -> Result<Map<String, Value>, Refusal> {
    let mut body = Map::new();
    body.insert("endpoint".into(), retiring.endpoint.clone());
    body.insert("unhandled_deliveries".into(), retiring.unhandled.into());
    body.insert("kept".into(), KEPT.into());
    if !retiring.live {
        body.insert("already_retired".into(), true.into());
        body.insert("next".into(), ALREADY_RETIRED.into());
        return Ok(body);
    }
    let token = connector::retiring_token(app, caller, connector_id, endpoint_id, &retiring)?;
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

async fn preview(
    app: &App,
    caller: &Caller,
    connector_id: &str,
    endpoint_id: &str,
) -> Result<Map<String, Value>, Refusal> {
    let retiring = connector::retiring(
        app,
        caller,
        connector_id.to_string(),
        endpoint_id.to_string(),
    )
    .await?;
    preview_body(app, caller, (connector_id, endpoint_id), retiring)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let connector_id = text(&arguments, "id").unwrap_or_default();
    let endpoint_id = text(&arguments, "endpoint_id").unwrap_or_default();
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(
            preview(app, caller, &connector_id, &endpoint_id).await?,
        ));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let confirmed = connector::retire_confirmed(
        app,
        caller,
        connector_id.clone(),
        endpoint_id.clone(),
        bound,
    )
    .await?;
    match confirmed {
        Confirmed::Done { .. } => Ok(json!({ "retired": true, "next": RETIRED_NEXT })),
        Confirmed::Repeated { .. } => Ok(json!({
            "retired": true,
            "already_done": true,
            "next": REPEATED_NEXT,
        })),
        Confirmed::Stale => Err(stale(STALE, None)),
        Confirmed::Changed => {
            match connector::read_now(preview(app, caller, &connector_id, &endpoint_id).await)? {
                Some(body) => Err(stale(CHANGED, Some(body))),
                None => Err(stale(CHANGED_GONE, None)),
            }
        }
    }
}
