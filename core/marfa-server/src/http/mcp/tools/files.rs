//! `marfa_files` and `marfa_drop_file_copy`: where a file's copies are kept, and removing one.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::confirmed::{self, Step, confirm_property};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::blobs::Hash;
use crate::http::mcp::results::{Outcome, Stop};

pub const LIST_NAME: &str = "marfa_files";
pub const DROP_NAME: &str = "marfa_drop_file_copy";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
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

pub fn drop_definition() -> Definition {
    Definition {
        name: DROP_NAME,
        title: "Remove one copy of a file",
        description: "Use to remove the copy of a file that one store holds. The file's other copies stay. It first previews: show the person, and call again with the same arguments and confirm. A confirmation holds only for the arguments it previewed.",
        input: json!({
            "type": "object",
            "properties": {
                "hash": { "type": "string", "minLength": 1, "description": "The file's content hash." },
                "store_id": { "type": "string", "minLength": 1, "description": "The store whose copy is removed." },
                "confirm": confirm_property(),
            },
            "required": ["hash", "store_id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "dropped": { "type": "object" },
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

pub async fn drop_copy(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::BlobsManage)?;
    let hash = text(&arguments, "hash").unwrap_or_default();
    let store = text(&arguments, "store_id").unwrap_or_default();
    let parsed = Hash::parse(&hash)?;
    caller.require_blob_reach()?;
    let covers = app
        .blob_copies(caller, &parsed)
        .await?
        .iter()
        .filter(|copy| copy.store_id == store)
        .map(|copy| format!("{}:{}", copy.recorded_at, copy.detached))
        .collect::<Vec<_>>()
        .join(",");
    let preview = json!({
        "action": "drop_copy",
        "hash": hash,
        "store_id": store,
        "effect": "This store's copy of the file is removed. The file's other copies stay.",
    });
    let step = confirmed::gate(
        app,
        caller,
        DROP_NAME,
        &arguments,
        &covers,
        preview,
        "which copy is removed",
    )?;
    if let Step::Preview(body) = step {
        return Ok(body);
    }
    app.drop_copy(caller, &parsed, &store)
        .await
        .map_err(Stop::refused)?;
    Ok(json!({ "dropped": { "hash": hash, "store_id": store } }))
}
