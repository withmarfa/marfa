//! `marfa_update_server`: previews updating the server to the newest release found, then starts
//! it on a single-use confirmation bound to that release.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::stale;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::mcp::confirm;
use crate::app::mcp::instance::{self, Stopped};
use crate::app::refusal::Refusal;
use crate::app::updates::{self, Started};
use crate::http::mcp::results::Outcome;

pub const NAME: &str = instance::UPDATE_TOOL;

const WHAT_HAPPENS: &str = "The server downloads the release and checks it, then restarts on it: every connection drops, this one included, until it is up again. The release running now is kept, and comes back if the new one does not start.";
const NO_BACKUP: &str =
    "No backup is taken first. To take one, call marfa_take_backup before you confirm.";
const PREVIEW_NEXT: &str = "Nothing has started. Show the person what happens and ask them; only if they agree, call marfa_update_server again with this confirm.";
const STARTED_NEXT: &str = "The update has started. The connection drops while the server restarts; reconnect, then read marfa_health to see the release it runs.";
const REPEATED_NEXT: &str =
    "This confirmation already started the update. This call started nothing more.";
const STALE: &str = "This confirmation does not hold for this credential, or it expired. This call started nothing. Preview again to get a new confirmation.";
const CHANGED: &str = "A newer release than the preview named has been found. This call started nothing; here is a new preview.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Update the server",
        description: "Use to update the server to the newest release found. The first call only previews: it names the release, says what happens and gives a confirm token. Show the person and ask; only if they agree, call again with the confirm. A confirmation works once, for this credential only, and only for the release it named. The server restarts, and every connection drops. Refused, with the step to take on its host, where the server cannot update itself.",
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
                "release": { "type": "string", "description": "The release the server runs now." },
                "to": { "type": "string", "description": "The release the update moves to." },
                "what_happens": { "type": "string" },
                "backup": { "type": "string" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "started": { "type": "boolean" },
                "already_done": { "type": "boolean" },
                "update": { "type": "object" },
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

async fn preview(app: &App, caller: &Caller) -> Result<Map<String, Value>, Refusal> {
    let to = updates::offer(app).await?;
    let token = instance::update_token(app, caller, &to)?;
    let mut body = Map::new();
    body.insert("release".into(), updates::running(app).into());
    body.insert("to".into(), to.into());
    body.insert("what_happens".into(), WHAT_HAPPENS.into());
    body.insert("backup".into(), NO_BACKUP.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), PREVIEW_NEXT.into());
    Ok(body)
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::InstanceMaintain)?;
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(preview(app, caller).await?));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    match instance::update_confirmed(app, caller, bound).await? {
        Started::Running(update) => Ok(json!({
            "started": true,
            "update": update,
            "next": STARTED_NEXT,
        })),
        Started::Stopped(Stopped::Repeated) => Ok(json!({
            "started": true,
            "already_done": true,
            "update": updates::status(app).await?,
            "next": REPEATED_NEXT,
        })),
        Started::Stopped(Stopped::Stale) => Err(stale(STALE, None)),
        Started::Stopped(Stopped::Changed) => {
            Err(stale(CHANGED, Some(preview(app, caller).await?)))
        }
    }
}
