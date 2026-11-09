//! `marfa_move_items`: previews a type move, starts it on a single-use confirmation, and follows its job.

use std::sync::Arc;

use marfa_rules::validation;
use serde_json::{Map, Value, json};

use super::{Definition, item_id, parsed, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::ruled;
use crate::app::jobs;
use crate::app::mcp::confirm;
use crate::app::mcp::moving::{self, Confirmed, Fresh, Preview};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const NAME: &str = "marfa_move_items";

const IDS_SHOWN: usize = 50;

const STARTED_NEXT: &str =
    "The move has started. Call marfa_move_items with job_id to see how it is going.";
const JOB_NEXT: &str = "Call again with job_id until status is completed or failed.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Move items to another type",
        description: "Use to move every item of one type to another, such as after making a better type. The first call previews what would move; call again with the same arguments and confirm to start it. A confirmation works once. With job_id, returns how the move is going.",
        input: json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "minLength": 1,
                    "description": "The type to move items out of." },
                "to": { "type": "string", "minLength": 1,
                    "description": "The type to move them to." },
                "properties": { "type": "object",
                    "description": "Properties to merge into every item as it moves, such as a field the new type requires. null removes one." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview. Leave out to preview." },
                "job_id": { "type": "string", "minLength": 1,
                    "description": "A started move's job ID, to see how it is going." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "from": { "type": "string" },
                "to": { "type": "string" },
                "matched": { "type": "integer" },
                "ids": { "type": "array", "items": { "type": "string" } },
                "settings": { "type": "array", "items": { "type": "object" } },
                "grants": { "type": "array", "items": { "type": "object" } },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "job": {
                    "type": "object",
                    "properties": { "id": { "type": "string" }, "status": { "type": "string" } },
                    "required": ["id", "status"],
                },
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

/// What the move would take, with a token that confirms exactly it.
fn preview_body(
    app: &App,
    caller: &Caller,
    preview: &Preview,
) -> Result<Map<String, Value>, Refusal> {
    let token = moving::token_for(app, caller, preview)?;
    let field = |name: &str| preview.body.get(name).cloned().unwrap_or(Value::Null);
    let ids = match preview.body.get("ids") {
        Some(Value::Array(ids)) => ids.clone(),
        _ => Vec::new(),
    };
    let more = ids.len() > IDS_SHOWN;
    let mut body = Map::new();
    for name in ["from", "to", "matched"] {
        body.insert(name.into(), field(name));
    }
    body.insert(
        "ids".into(),
        Value::Array(ids.into_iter().take(IDS_SHOWN).collect()),
    );
    for name in ["settings", "grants"] {
        body.insert(name.into(), field(name));
    }
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert(
        "next".into(),
        format!(
            "Nothing has moved. {} items would move{}. Show the person, and call again with the same arguments and confirm to move them.",
            field("matched"),
            if more {
                format!("; the first {IDS_SHOWN} are listed")
            } else {
                String::new()
            }
        )
        .into(),
    );
    Ok(body)
}

fn stale(body: Map<String, Value>, expired: bool) -> Stop {
    let mut stop = Stop::coded(
        "confirmation_stale",
        if expired {
            "The confirmation expired. Nothing has moved; here is a new preview."
        } else {
            "What the preview showed changed, or the confirmation is not this preview's, or it was already used. Nothing has moved; here is a new preview."
        },
    );
    for (name, value) in body {
        stop.error.insert(name, value);
    }
    stop
}

/// A job's answer, with its result's error list cut to the budget.
fn job_answer(job: &Value, next: &str) -> Value {
    let mut summary = Map::new();
    for name in [
        "id",
        "status",
        "matched",
        "processed",
        "succeeded",
        "errored",
        "error",
        "result",
    ] {
        if let Some(value) = job.get(name) {
            summary.insert(name.into(), value.clone());
        }
    }
    if let Some(Value::Object(result)) = summary.get_mut("result")
        && let Some(Value::Array(errors)) = result.remove("errors")
    {
        let (kept, left_out) = fit_list(errors, ANSWER_BUDGET_CHARS / 2);
        result.insert("errors".into(), Value::Array(kept));
        if left_out > 0 {
            result.insert("errors_left_out".into(), left_out.into());
        }
    }
    json!({ "job": summary, "next": next })
}

pub async fn run(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
    exact: Result<(), Refusal>,
) -> Outcome {
    if let Some(id) = text(&arguments, "job_id") {
        item_id(&id)?;
        return Ok(job_answer(&jobs::read(app, caller, id).await?, JOB_NEXT));
    }
    let (Some(from), Some(to)) = (text(&arguments, "from"), text(&arguments, "to")) else {
        return Err(Stop::invalid("Name from and to, or a job_id."));
    };
    let properties = match arguments.get("properties") {
        Some(Value::Object(properties)) => {
            exact?;
            validation::property_names(properties).map_err(ruled)?;
            Some(properties.clone())
        }
        _ => None,
    };
    let Some(token) = text(&arguments, "confirm") else {
        let fresh = moving::preview(app, caller, &from, &to, properties.as_ref()).await?;
        return Ok(Value::Object(preview_body(app, caller, &fresh)?));
    };
    match moving::confirmed(app, caller, &from, &to, properties.clone(), &token).await? {
        Confirmed::Started(job) => Ok(job_answer(&parsed(&job)?, STARTED_NEXT)),
        Confirmed::Stale => {
            let body = match moving::fresh(app, caller, &from, &to, properties.as_ref()).await? {
                Fresh::Open(fresh) => preview_body(app, caller, &fresh)?,
                Fresh::Blocked(mut body) => {
                    body.insert(
                        "next".into(),
                        "Nothing has moved, and the move can't start while these settings name the type. Change each setting listed, then call again without confirm.".into(),
                    );
                    body
                }
            };
            Err(stale(body, confirm::is_expired(&token, app.clock.now_ms())))
        }
    }
}
