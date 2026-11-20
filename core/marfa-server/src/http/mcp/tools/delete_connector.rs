//! `marfa_delete_connector`: previews deleting a connector's registration or clearing its state,
//! then does it on a single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::connectors::keep_types_that_fit;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::connectors::{Clearing, Deletion};
use crate::app::mcp::confirm;
use crate::app::mcp::connector::{self, Confirmed, Part};
use crate::app::refusal::{Code, Refusal};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list, json_length};

pub const NAME: &str = connector::DELETE_TOOL;

const ROOM: usize = ANSWER_BUDGET_CHARS - 4_000;

const DELETE_NEXT: &str = "Nothing has been deleted. Deleting cannot be undone. Show the person what would be deleted and ask them; only if they agree, call marfa_delete_connector again with this id and confirm.";
const COUNTED: &str = "Runs and handled deliveries are counted as they stand now. A running connector adds more, and the confirmation does not cover them: deleting removes every run and handled delivery there is when it happens.";
const KEPT_CURRENT: &str = "The source's state and agreements outlive the registration, so a connector that registers again for this source picks them up. Clear them with part \"state\".";
const KEPT_OLD: &str = "This is not the source's current registration, so it holds none of the source's inbound endpoints or deliveries, and they stay. The source's state and agreements stay too.";
const DELETED_NEXT: &str = "Deleted. The registration and its runs are gone, with everything the preview listed under goes_with.";
const DELETE_REPEATED: &str =
    "This confirmation already deleted this connector. This call changed nothing.";

const CLEAR_NEXT: &str = "Nothing has been cleared. Clearing cannot be undone. Show the person what would be cleared and ask them; only if they agree, call marfa_delete_connector again with this id, part \"state\" and confirm.";
const NOTHING_TO_CLEAR: &str = "This connector's source has no state or agreements to clear.";
const CLEARED_NEXT: &str =
    "Cleared. The connector starts its next run with no state and no agreements.";
const CLEAR_REPEATED: &str =
    "This confirmation already cleared this state. This call changed nothing.";

const STALE: &str = "This confirmation does not hold for this connector. This call changed nothing. Preview again to get a new confirmation.";
pub(super) const CHANGED: &str =
    "What the preview showed has changed. This call changed nothing; here is a new preview.";
pub(super) const CHANGED_GONE: &str =
    "What the preview showed has changed. This call changed nothing. Preview again.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Delete a connector or clear its state",
        description: "Use to delete a connector's registration, with its runs and, for the source's current registration, its inbound endpoints and deliveries. With part \"state\", clears the source's state, problems and agreements instead, so the connector starts over. The first call only previews; show the person and ask. Only if they agree, call again with the same id and part and confirm. A confirmation works once, for this credential only. This cannot be undone.",
        input: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "minLength": 1, "description": "The connector's ID." },
                "part": { "type": "string", "enum": ["registration", "state"],
                    "description": "What to remove: the registration, or the source's state and agreements. The registration when left out." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the same id and part. Leave out to preview." },
            },
            "required": ["id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "connector": { "type": "object", "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "description": { "type": ["string", "null"] },
                    "source": { "type": "string" },
                    "key_id": { "type": "string" },
                    "read_only_types": { "type": "array", "items": { "type": "string" },
                        "description": "The types whose items this registration holds read only. Deleting it ends that hold." },
                    "read_only_types_left_out": { "type": "integer",
                        "description": "Declared types beyond what the answer holds." },
                } },
                "current": { "type": "boolean",
                    "description": "Whether this is the source's current registration, which holds its inbound endpoints." },
                "goes_with": { "type": "object", "properties": {
                    "endpoints": { "type": "array", "items": { "type": "object" } },
                    "endpoints_left_out": { "type": "integer" },
                    "unhandled_deliveries": { "type": "integer" },
                    "handled_deliveries": { "type": "integer" },
                    "runs": { "type": "integer" },
                } },
                "stays": { "type": "object", "properties": {
                    "state": { "type": "boolean" },
                    "agreements": { "type": "integer" },
                } },
                "state": { "type": "boolean", "description": "Whether the source has state to clear." },
                "problems": { "type": "integer" },
                "agreements": { "type": "integer" },
                "waiting": { "type": "integer", "description": "Agreements waiting on a change." },
                "counts": { "type": "string" },
                "kept": { "type": "string" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "deleted": { "type": "boolean" },
                "runs": { "type": "integer", "description": "The runs that went with the registration." },
                "cleared": { "type": "boolean" },
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

fn deletion_body(
    app: &App,
    caller: &Caller,
    id: &str,
    deletion: Deletion,
) -> Result<Map<String, Value>, Refusal> {
    let token = connector::deletion_token(app, caller, id, &deletion)?;
    let mut summary = deletion.connector;
    keep_types_that_fit(&mut summary);
    let room = ROOM.saturating_sub(json_length(&summary));
    let mut body = Map::new();
    body.insert("connector".into(), summary);
    body.insert("current".into(), deletion.held.is_some().into());
    let mut goes_with = Map::new();
    if let Some(held) = deletion.held {
        let (endpoints, left_out) = fit_list(held.endpoints.clone(), room);
        goes_with.insert("endpoints".into(), Value::Array(endpoints));
        if left_out > 0 {
            goes_with.insert("endpoints_left_out".into(), left_out.into());
        }
        goes_with.insert("unhandled_deliveries".into(), held.unhandled().into());
        goes_with.insert("handled_deliveries".into(), held.handled.into());
        body.insert("kept".into(), KEPT_CURRENT.into());
    } else {
        body.insert("kept".into(), KEPT_OLD.into());
    }
    goes_with.insert("runs".into(), deletion.runs.into());
    body.insert("goes_with".into(), Value::Object(goes_with));
    body.insert(
        "stays".into(),
        json!({ "state": deletion.state_kept, "agreements": deletion.agreements_kept }),
    );
    body.insert("counts".into(), COUNTED.into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), DELETE_NEXT.into());
    Ok(body)
}

fn clearing_body(
    app: &App,
    caller: &Caller,
    id: &str,
    clearing: Clearing,
) -> Result<Map<String, Value>, Refusal> {
    let mut body = Map::new();
    body.insert("connector".into(), clearing.connector.clone());
    body.insert("state".into(), clearing.state.into());
    body.insert("problems".into(), clearing.problems.into());
    body.insert("agreements".into(), clearing.agreements.into());
    body.insert("waiting".into(), clearing.waiting.into());
    if !clearing.state && clearing.agreements == 0 {
        body.insert("next".into(), NOTHING_TO_CLEAR.into());
        return Ok(body);
    }
    let token = connector::clearing_token(app, caller, id, &clearing)?;
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), CLEAR_NEXT.into());
    Ok(body)
}

async fn preview(
    app: &App,
    caller: &Caller,
    id: &str,
    part: Part,
) -> Result<Map<String, Value>, Refusal> {
    Ok(match part {
        Part::Registration => {
            let deletion = connector::deletion(app, caller, id.to_string()).await?;
            deletion_body(app, caller, id, deletion)?
        }
        Part::State => {
            let clearing = connector::clearing(app, caller, id.to_string()).await?;
            clearing_body(app, caller, id, clearing)?
        }
    })
}

pub(super) fn stale(message: &str, body: Option<Map<String, Value>>) -> Stop {
    let mut stop = Stop::coded("confirmation_stale", message);
    for (name, value) in body.into_iter().flatten() {
        stop.error.insert(name, value);
    }
    stop
}

/// Whether a confirmed call stopped by `refused` answers the refusal itself: it is about the
/// caller or the server, or the outcome is unknown.
pub(super) fn stands(refused: &Refusal) -> bool {
    refused.commit_failed
        || matches!(
            refused.code,
            Code::Forbidden | Code::Unauthorized | Code::InternalError
        )
}

/// What a confirmed call stopped by `refused` answers: stale, saying why, with `preview` where
/// one could be made, unless the refusal [`stands`].
pub(super) fn refused_stale(refused: Refusal, preview: Option<Map<String, Value>>) -> Stop {
    if stands(&refused) {
        return refused.into();
    }
    let next = match preview {
        Some(_) => "This call changed nothing; here is a new preview.",
        None => "This call changed nothing.",
    };
    stale(&format!("{} {next}", refused.message), preview)
}

/// What a confirmation whose target changed answers where the new preview was refused.
pub(super) fn changed_unpreviewable(refused: Refusal) -> Stop {
    if stands(&refused) {
        return refused.into();
    }
    stale(
        &format!(
            "What the preview showed has changed, and it cannot be previewed again: {} This call \
             changed nothing.",
            refused.message
        ),
        None,
    )
}

fn part(arguments: &Map<String, Value>) -> Part {
    match text(arguments, "part").as_deref() {
        Some("state") => Part::State,
        _ => Part::Registration,
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let id = text(&arguments, "id").unwrap_or_default();
    let part = part(&arguments);
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(preview(app, caller, &id, part).await?));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let confirmed = match part {
        Part::Registration => connector::delete_confirmed(app, caller, id.clone(), bound).await?,
        Part::State => connector::clear_confirmed(app, caller, id.clone(), bound).await?,
    };
    match (confirmed, part) {
        (Confirmed::Done { total }, Part::Registration) => {
            Ok(json!({ "deleted": true, "runs": total, "next": DELETED_NEXT }))
        }
        (Confirmed::Repeated { total }, Part::Registration) => Ok(json!({
            "deleted": true,
            "runs": total,
            "already_done": true,
            "next": DELETE_REPEATED,
        })),
        (Confirmed::Done { total }, Part::State) => {
            Ok(json!({ "cleared": true, "agreements": total, "next": CLEARED_NEXT }))
        }
        (Confirmed::Repeated { total }, Part::State) => Ok(json!({
            "cleared": true,
            "agreements": total,
            "already_done": true,
            "next": CLEAR_REPEATED,
        })),
        (Confirmed::Stale, _) => Err(stale(STALE, None)),
        (Confirmed::Changed, _) => {
            match connector::read_now(preview(app, caller, &id, part).await)? {
                Some(body) => Err(stale(CHANGED, Some(body))),
                None => Err(stale(CHANGED_GONE, None)),
            }
        }
    }
}
