//! `marfa_maintain`: running a housekeeping job now, and cancelling a bulk job.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::refusal::Refusal;
use crate::app::{App, housekeeping, jobs};
use crate::http::housekeeping::well_formed;
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_maintain";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Run housekeeping or cancel a bulk job",
        description: "Use to run one housekeeping job now, by the name marfa_health lists, or to cancel a bulk job that is still running, by its id. Updating the server and confirming the clock are not offered here.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["run_housekeeping", "cancel_job"] },
                "name": { "type": "string", "minLength": 1,
                    "description": "The housekeeping job to run. Only to run one." },
                "id": { "type": "string", "minLength": 1,
                    "description": "The bulk job to cancel. Only to cancel one." },
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "ended": { "type": "object" },
                "job": { "type": "object" },
            },
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": true,
        }),
        meta: None,
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::InstanceMaintain)?;
    if text(&arguments, "action").as_deref() == Some("cancel_job") {
        let Some(id) = text(&arguments, "id") else {
            return Err(Stop::coded(
                "missing_required_field",
                "Name the job with id (id).",
            ));
        };
        return Ok(json!({ "job": jobs::cancel(app, caller, id).await? }));
    }
    let Some(name) = text(&arguments, "name") else {
        return Err(Stop::coded(
            "missing_required_field",
            "Name the job with name (name).",
        ));
    };
    if !well_formed(&name) {
        return Err(Stop::refused(
            Refusal::validation(format!("\"{name}\" is not a housekeeping job's name"))
                .with_detail("field", "name"),
        ));
    }
    let ended = housekeeping::run_now(app, caller, &name).await?;
    Ok(json!({ "ended": ended.to_json() }))
}
