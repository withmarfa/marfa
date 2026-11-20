//! `marfa_adopt_backup_folder`: previews adopting the backup folder as a new store, then adopts
//! it on a single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::{CHANGED, stale};
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::backups::adopt::{self, Adopted, Adopting, Adoption, Marker};
use crate::app::mcp::confirm;
use crate::app::mcp::guard::{self, Guard, Halt};
use crate::app::refusal::Refusal;
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, fit_list};

pub const NAME: &str = "marfa_adopt_backup_folder";

const ROOM: usize = ANSWER_BUDGET_CHARS - 4_000;

const PREVIEW_NEXT: &str = "Nothing has been adopted. Adopting takes the folder there now as a new store and forgets the old store's backups and file copies; it cannot be undone. Show the person what would be forgotten and ask them; only if they agree, call marfa_adopt_backup_folder again with confirm.";
const CLEARS: &str = "The record of the last backup is cleared too, so the instance shows no backup until the next one.";
const ADOPTED_NEXT: &str = "Adopted. The folder holds the new store's marker, and backups and file copies go to it from now on.";
const CHANGED_WHILE: &str = "Adopted, but the folder changed while it was adopted, or could not be read again after. The old store's backups and file copies were forgotten, and the new store's marker is in files_folder. Check with the person that this is the folder they meant.";
const MARKER_FAILED: &str = "Adopted, but the folder could not take the new store's marker, so backups and file copies cannot go to it yet. The old store's backups and file copies were forgotten. Make the folder writable, then adopt it again.";
const UNANSWERED: &str = "Adopted, but the folder did not answer when it was given the new store's marker. The old store's backups and file copies were forgotten. Backups wait until the folder answers.";
const REPEATED: &str =
    "This confirmation already adopted the backup folder. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for the backup folder. This call changed nothing. Preview again to get a new confirmation.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Adopt the backup folder",
        description: "Use when the backup folder's disk was replaced or emptied, and backups fail because it no longer holds this instance's files. Adopting takes the folder there now as a new store and forgets the old store's backups and file copies. The first call only previews; show the person and ask. Only if they agree, call again with confirm. A confirmation works once, for this credential only. This cannot be undone.",
        input: json!({
            "type": "object",
            "properties": {
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview. Leave out to preview." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "folder": { "type": "string", "description": "The backup folder." },
                "files_folder": { "type": "string",
                    "description": "The folder inside it that holds this instance's files and the store's marker." },
                "replaces_store_id": { "type": "string" },
                "forgets": { "type": "object", "properties": {
                    "backups": { "type": "array", "items": { "type": "string" } },
                    "backups_left_out": { "type": "integer" },
                    "found_backups": { "type": "array", "items": { "type": "string" },
                        "description": "Backups the instance found in the folder without having recorded them." },
                    "found_backups_left_out": { "type": "integer" },
                    "file_copies": { "type": "integer" },
                } },
                "last_backup": { "type": ["object", "null"],
                    "description": "The record of the last backup, which adopting clears." },
                "clears": { "type": "string" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "adopted": { "type": "boolean" },
                "store_id": { "type": "string" },
                "replaced_store_id": { "type": "string" },
                "backups_forgotten": { "type": "integer" },
                "copies_forgotten": { "type": "integer" },
                "marked": { "type": ["boolean", "null"],
                    "description": "Whether the folder holds the store's marker, or null where it did not answer." },
                "marker_error": { "type": "string" },
                "folder_changed": { "type": "boolean" },
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

fn named(names: Vec<String>, room: usize) -> (Vec<Value>, usize) {
    fit_list(names.into_iter().map(Value::from).collect(), room)
}

fn body(app: &App, caller: &Caller, adoption: Adoption) -> Result<Map<String, Value>, Refusal> {
    let forgets = adoption.forgets;
    let token = guard::issue(
        &app.mcp.signer,
        NAME,
        caller,
        &adopt::target(),
        &forgets.digest,
        app.clock.now_ms(),
    )?;
    let (backups, backups_left_out) = named(forgets.backups, ROOM / 2);
    let (found, found_left_out) = named(forgets.found_backups, ROOM / 2);
    let mut listed = Map::new();
    listed.insert("backups".into(), Value::Array(backups));
    if backups_left_out > 0 {
        listed.insert("backups_left_out".into(), backups_left_out.into());
    }
    listed.insert("found_backups".into(), Value::Array(found));
    if found_left_out > 0 {
        listed.insert("found_backups_left_out".into(), found_left_out.into());
    }
    listed.insert("file_copies".into(), forgets.copies.into());
    let mut body = Map::new();
    body.insert("folder".into(), adoption.folder.into());
    body.insert("files_folder".into(), adoption.files_folder.into());
    body.insert("replaces_store_id".into(), forgets.replaced_store_id.into());
    body.insert("forgets".into(), Value::Object(listed));
    body.insert(
        "last_backup".into(),
        match (forgets.last_backup, forgets.last_backup_at) {
            (None, None) => Value::Null,
            (name, at) => json!({ "name": name, "at": at }),
        },
    );
    body.insert("clears".into(), CLEARS.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

async fn preview(app: &Arc<App>, caller: &Caller) -> Result<Map<String, Value>, Refusal> {
    let adoption = app.backup_folder_adoption(caller).await?;
    body(app, caller, adoption)
}

async fn halted(app: &Arc<App>, caller: &Caller, halt: Halt) -> Outcome {
    match halt {
        Halt::Stale => Err(stale(STALE, None)),
        Halt::Repeated { .. } => {
            let mut answer = Map::new();
            answer.insert("adopted".into(), true.into());
            answer.insert("already_done".into(), true.into());
            if let Some(now) = app.backup_folder_now().await {
                answer.insert("store_id".into(), now.store_id.into());
                answer.insert("marked".into(), now.marked.into());
            }
            answer.insert("next".into(), REPEATED.into());
            Ok(Value::Object(answer))
        }
        Halt::Changed => Err(stale(CHANGED, Some(preview(app, caller).await?))),
    }
}

fn answer(adopted: Adopted) -> Value {
    let (marked, error, next) = match adopted.marker {
        Marker::Written if adopted.folder_changed == Some(true) => {
            (Some(true), None, CHANGED_WHILE)
        }
        Marker::Written => (Some(true), None, ADOPTED_NEXT),
        Marker::Failed(error) => (Some(false), Some(error), MARKER_FAILED),
        Marker::Unanswered => (None, None, UNANSWERED),
    };
    let mut answer = Map::new();
    answer.insert("adopted".into(), true.into());
    answer.insert("store_id".into(), adopted.store_id.into());
    answer.insert("replaced_store_id".into(), adopted.replaced_store_id.into());
    answer.insert("backups_forgotten".into(), adopted.backups.into());
    answer.insert("copies_forgotten".into(), adopted.copies.into());
    answer.insert("folder".into(), adopted.folder.into());
    answer.insert("files_folder".into(), adopted.files_folder.into());
    answer.insert("marked".into(), marked.into());
    if let Some(error) = error {
        answer.insert("marker_error".into(), error.into());
    }
    if let Some(changed) = adopted.folder_changed {
        answer.insert("folder_changed".into(), changed.into());
    }
    answer.insert("next".into(), next.into());
    Value::Object(answer)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(preview(app, caller).await?));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let guard = Guard::new(NAME, app.mcp.signer.clone(), caller, adopt::target(), bound);
    if let Some(halt) = app.peek_adoption(&guard).await? {
        return halted(app, caller, halt).await;
    }
    match app.adopt_folder(caller, Some(guard)).await? {
        Adopting::Done(adopted) => Ok(answer(adopted)),
        Adopting::Halted(halt) => halted(app, caller, halt).await,
    }
}
