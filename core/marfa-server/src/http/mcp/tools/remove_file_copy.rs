//! `marfa_remove_file_copy`: previews removing one store's copy of a file, then removes it on a
//! single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::{CHANGED, CHANGED_GONE, changed_unpreviewable, stale};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::Hash;
use crate::app::blobs::removal::{self, Bytes, Dropped, Removal, Shown};
use crate::app::mcp::confirm;
use crate::app::mcp::guard::{self, Guard, Halt};
use crate::app::refusal::{Code, Refusal};
use crate::http::mcp::results::Outcome;

pub const NAME: &str = "marfa_remove_file_copy";

const PREVIEW_NEXT: &str = "Nothing has been removed. Show the person which copy would be removed and what happens to its bytes, and ask them; only if they agree, call marfa_remove_file_copy again with this hash, store_id and confirm.";
const DELETED_NEXT: &str = "Removed. The store's copy of this file and its bytes are gone.";
const QUEUED_NEXT: &str = "Removed. The instance no longer counts this copy, and its bytes are queued for deletion from the store on a later run.";
const KEPT_NEXT: &str = "Removed. The instance no longer counts this copy. The server did not write its bytes, so they stay in the store.";
const REPEATED: &str = "This confirmation already removed this copy. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for this copy. This call changed nothing. Preview again to get a new confirmation.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Remove a copy of a file",
        description: "Use to remove one store's copy of a file, by the file's hash and the store's ID, as marfa_files lists them. The instance keeps the copies it needs: it refuses a removal that would leave fewer than it keeps. The first call only previews; show the person and ask. Only if they agree, call again with the same hash and store_id and confirm. A confirmation works once, for this credential only. This cannot be undone.",
        input: json!({
            "type": "object",
            "properties": {
                "hash": { "type": "string", "minLength": 1, "description": "The file's content hash." },
                "store_id": { "type": "string", "minLength": 1, "description": "The ID of the store whose copy to remove." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the same hash and store_id. Leave out to preview." },
            },
            "required": ["hash", "store_id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "file": { "type": "object", "properties": {
                    "hash": { "type": "string" },
                    "size_bytes": { "type": "integer" },
                } },
                "copy": { "type": "object", "description": "The copy that would be removed." },
                "other_copies": { "type": "array", "items": { "type": "object" },
                    "description": "The copies that stay." },
                "min_copies": { "type": "integer", "description": "How many copies the instance keeps." },
                "bytes": { "type": "string", "enum": ["deleted", "queued", "kept"],
                    "description": "What becomes of the copy's bytes: deleted from the store, queued for deletion, or kept because the server did not write them." },
                "recorded": { "type": "boolean",
                    "description": "Whether the store holds a copy of the file again." },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "removed": { "type": "boolean" },
                "already_done": { "type": "boolean" },
                "next": { "type": "string" },
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

fn shown(copy: &Shown) -> Value {
    json!({
        "store_id": copy.store_id,
        "kind": copy.kind,
        "written": copy.written,
        "recorded_at": copy.recorded_at,
        "verified_at": copy.verified_at,
    })
}

fn word(bytes: Bytes) -> &'static str {
    match bytes {
        Bytes::Deleted => "deleted",
        Bytes::Queued => "queued",
        Bytes::Kept => "kept",
    }
}

fn body(
    app: &App,
    caller: &Caller,
    hash: &Hash,
    store_id: &str,
    removal: Removal,
) -> Result<Map<String, Value>, Refusal> {
    let target = removal::target(hash, store_id);
    let token = guard::issue(
        &app.mcp.signer,
        NAME,
        caller,
        &target,
        &removal.digest,
        app.clock.now_ms(),
    )?;
    let bytes = if removal.copy.written {
        Bytes::Deleted
    } else {
        Bytes::Kept
    };
    let mut body = Map::new();
    body.insert(
        "file".into(),
        json!({ "hash": hash.as_str(), "size_bytes": removal.size_bytes }),
    );
    body.insert("copy".into(), shown(&removal.copy));
    body.insert("bytes".into(), word(bytes).into());
    body.insert(
        "other_copies".into(),
        removal.others.iter().map(shown).collect(),
    );
    body.insert("min_copies".into(), removal.min_copies.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

async fn preview(
    app: &App,
    caller: &Caller,
    hash: &Hash,
    store_id: &str,
) -> Result<Map<String, Value>, Refusal> {
    let removal = app.copy_removal(caller, hash, store_id).await?;
    body(app, caller, hash, store_id, removal)
}

fn gone(refused: &Refusal) -> bool {
    matches!(refused.code, Code::BlobNotFound | Code::BlobCopyNotFound)
}

/// What a confirmation that changed nothing answers.
async fn halted(
    app: &Arc<App>,
    caller: &Caller,
    hash: &Hash,
    store_id: &str,
    halt: Halt,
) -> Outcome {
    match halt {
        Halt::Stale => Err(stale(STALE, None)),
        Halt::Repeated { total } => {
            let now = app.copy_now(hash, store_id).await?;
            let mut answer = Map::new();
            answer.insert("removed".into(), true.into());
            answer.insert("already_done".into(), true.into());
            answer.insert("recorded".into(), now.recorded.into());
            let bytes = if total == 0 {
                Some(Bytes::Kept)
            } else if now.waiting {
                Some(Bytes::Queued)
            } else if now.attached && !now.recorded {
                Some(Bytes::Deleted)
            } else {
                None
            };
            if let Some(bytes) = bytes {
                answer.insert("bytes".into(), word(bytes).into());
            }
            answer.insert("next".into(), REPEATED.into());
            Ok(Value::Object(answer))
        }
        Halt::Changed => match preview(app, caller, hash, store_id).await {
            Ok(body) => Err(stale(CHANGED, Some(body))),
            Err(refused) if gone(&refused) => Err(stale(CHANGED_GONE, None)),
            Err(refused) => Err(changed_unpreviewable(refused)),
        },
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let hash = Hash::parse(&text(&arguments, "hash").unwrap_or_default())?;
    let store_id = text(&arguments, "store_id").unwrap_or_default();
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(preview(app, caller, &hash, &store_id).await?));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let target = removal::target(&hash, &store_id);
    let guard = Guard::new(NAME, app.mcp.signer.clone(), caller, target, bound);
    if let Some(halt) = app.peek_removal(&guard, &hash, &store_id).await? {
        return halted(app, caller, &hash, &store_id, halt).await;
    }
    match app
        .drop_copy(caller, &hash, &store_id, Some(guard.clone()))
        .await
    {
        Ok(Dropped::Removed(bytes)) => Ok(json!({
            "removed": true,
            "bytes": word(bytes),
            "next": match bytes {
                Bytes::Deleted => DELETED_NEXT,
                Bytes::Queued => QUEUED_NEXT,
                Bytes::Kept => KEPT_NEXT,
            },
        })),
        Ok(Dropped::Halted(halt)) => halted(app, caller, &hash, &store_id, halt).await,
        Err(refused) if gone(&refused) => {
            // Another call may have spent this token on the copy since the first look.
            let halt = app.peek_removal(&guard, &hash, &store_id).await?;
            halted(app, caller, &hash, &store_id, halt.unwrap_or(Halt::Changed)).await
        }
        Err(refused) => Err(refused.into()),
    }
}
