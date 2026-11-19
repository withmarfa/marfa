//! `marfa_files`: where a file's copies are kept.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::Hash;
use crate::http::mcp::results::Outcome;

pub const NAME: &str = "marfa_files";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Where a file's copies are kept",
        description: "Use to see each copy the instance keeps of one file, by its hash: the store holding it, its kind, and when it was last verified. marfa_health lists the stores.",
        input: json!({
            "type": "object",
            "properties": {
                "hash": { "type": "string", "minLength": 1, "description": "The file's content hash." },
            },
            "required": ["hash"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "copies": { "type": "array", "items": { "type": "object" } },
            },
            "required": ["copies"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require_blob_reach()?;
    let hash = Hash::parse(&text(&arguments, "hash").unwrap_or_default())?;
    let copies = app.blob_copies(caller, &hash).await?;
    let listed: Vec<Value> = copies
        .iter()
        .map(|copy| {
            json!({
                "store_id": copy.store_id,
                "kind": copy.kind,
                "detached": copy.detached,
                "recorded_at": copy.recorded_at,
                "verified_at": copy.verified_at,
            })
        })
        .collect();
    Ok(json!({ "copies": listed }))
}
