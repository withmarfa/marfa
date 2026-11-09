//! `marfa_sources` and `marfa_name_source`: the names and marks sources are shown by.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::sources::{self, Change};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_sources";
pub const NAME_NAME: &str = "marfa_name_source";

const ROOM: usize = ANSWER_BUDGET_CHARS - 200;

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List sources",
        description: "Use to name where items came from: each source code's name and mark (an icon ID). With source, reads one.",
        input: json!({
            "type": "object",
            "properties": {
                "source": { "type": "string", "minLength": 1,
                    "description": "A source code, such as `github`." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "sources": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["sources"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn name_definition() -> Definition {
    Definition {
        name: NAME_NAME,
        title: "Name a source",
        description: "Use to set the name and mark a source is shown by: your own, one you claim, or any with keys.manage. null clears a field.",
        input: json!({
            "type": "object",
            "properties": {
                "source": { "type": "string", "minLength": 1,
                    "description": "A source code, such as `github`." },
                "name": { "type": ["string", "null"], "description": "Such as `GitHub`." },
                "mark": { "type": ["string", "null"],
                    "description": "An icon ID, such as `simple-icons:github`." },
            },
            "required": ["source"],
            "additionalProperties": false,
        }),
        output: json!({ "type": "object" }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        }),
        meta: None,
    }
}

pub async fn list(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    if let Some(code) = text(&arguments, "source") {
        sources::check_code(&code)?;
        return Ok(json!({ "sources": [sources::read(app, caller, code).await?] }));
    }
    let (kept, left_out) = fit_list(sources::list(app, caller).await?, ROOM);
    let mut answer = Map::new();
    answer.insert("sources".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

pub async fn name(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let code = text(&arguments, "source").unwrap_or_default();
    sources::check_code(&code)?;
    caller.require_may_name(&code)?;
    let mut sent = Map::new();
    for field in ["name", "mark"] {
        if let Some(value) = arguments.get(field) {
            sent.insert(field.into(), value.clone());
        }
    }
    if sent.is_empty() {
        return Err(Stop::coded(
            "missing_required_field",
            "Send a name, a mark or both.",
        ));
    }
    let change = Change::from_body(&sent)?;
    Ok(sources::update(app, caller, code, change).await?)
}
