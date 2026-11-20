//! `marfa_maintain`: running a housekeeping job now, cancelling a bulk job, and confirming the
//! server's clock on a single-use confirmation bound to the hold its preview showed.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::stale;
use super::{Definition, text};
use crate::app::access::{Caller, Permission};
use crate::app::clock::Standing;
use crate::app::housekeeping::ClockConfirmed;
use crate::app::mcp::confirm;
use crate::app::mcp::instance::{self, Stopped};
use crate::app::refusal::{Refusal, Result};
use crate::app::{App, housekeeping, jobs};
use crate::http::housekeeping::well_formed;
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = instance::CLOCK_TOOL;

const NOT_HELD: &str = "The server's clock is not far ahead of the time it last trusted, so clean-up is not held and there is nothing to confirm.";
const CLOCK_NEXT: &str = "Nothing has been confirmed. Ask the person what the time is now, and compare it with server_time. Confirming takes server_time as right: the jobs in held_jobs then run and remove what is old by that time, which cannot be undone. If server_time is wrong, the host's clock is set right instead and nothing is confirmed. If nobody confirms and the clock runs on without a jump, the hold ends by itself at hold_ends_at. Only if the person agrees server_time is right, call marfa_maintain again with action confirm_clock and this confirm.";
const CONFIRMED_NEXT: &str =
    "Confirmed. The server's time is now the trusted time, and the held jobs run.";
const REPEATED_NEXT: &str =
    "This confirmation already confirmed the clock. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for this credential, or it expired. This call confirmed nothing. Preview again to get a new confirmation.";
const CHANGED: &str = "The hold the preview showed has changed: the clock jumped, or the hold ended. This call confirmed nothing; here is a new preview.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Run housekeeping, cancel a bulk job or confirm the clock",
        description: "Use to run one housekeeping job now, by the name marfa_health lists, to cancel a bulk job that is still running, by its id, or to confirm the server's clock while clean-up is held because the clock is far ahead of the time it last trusted. Running the trash's job removes the trashed items the owner's retention policy makes eligible, and no other. Confirming the clock first previews: it shows the server's time and what then runs. Check the time with the person; only if they agree, call again with the confirm.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["run_housekeeping", "cancel_job", "confirm_clock"] },
                "name": { "type": "string", "minLength": 1,
                    "description": "The housekeeping job to run. Only to run one." },
                "id": { "type": "string", "minLength": 1,
                    "description": "The bulk job to cancel. Only to cancel one." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the clock's preview. Leave out to preview." },
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "ended": { "type": "object" },
                "job": { "type": "object" },
                "held": { "type": "boolean" },
                "server_time": { "type": "string" },
                "trusted_time": { "type": "string" },
                "gap_seconds": { "type": "integer" },
                "held_jobs": { "type": "array", "items": { "type": "string" } },
                "hold_ends_at": { "type": "string" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "confirmed_at": { "type": "string" },
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

fn clock_preview(app: &App, caller: &Caller) -> Result<Map<String, Value>> {
    let mut body = Map::new();
    let held = app.clock.hold().and_then(|(standing, from)| {
        instance::hold_digest(standing, from).map(|digest| (standing, digest))
    });
    let Some((
        Standing::Ahead {
            trusted,
            wall,
            ends,
        },
        digest,
    )) = held
    else {
        body.insert("held".into(), false.into());
        body.insert("next".into(), NOT_HELD.into());
        return Ok(body);
    };
    let token = instance::clock_token(app, caller, &digest)?;
    body.insert("held".into(), true.into());
    body.insert("server_time".into(), wall.text().into());
    body.insert("trusted_time".into(), trusted.text().into());
    body.insert(
        "gap_seconds".into(),
        ((wall.ms() - trusted.ms()) / 1_000).into(),
    );
    body.insert("held_jobs".into(), json!(housekeeping::held_jobs(app)));
    body.insert("hold_ends_at".into(), ends.text().into());
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), CLOCK_NEXT.into());
    Ok(body)
}

async fn confirm_clock(app: &Arc<App>, caller: &Caller, arguments: &Map<String, Value>) -> Outcome {
    let Some(token) = text(arguments, "confirm") else {
        return Ok(Value::Object(clock_preview(app, caller)?));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    match instance::clock_confirmed(app, caller, bound).await? {
        ClockConfirmed::Done(at) => Ok(json!({
            "confirmed_at": at.text(),
            "next": CONFIRMED_NEXT,
        })),
        ClockConfirmed::Stopped(Stopped::Repeated) => Ok(json!({
            "already_done": true,
            "next": REPEATED_NEXT,
        })),
        ClockConfirmed::Stopped(Stopped::Stale) => Err(stale(STALE, None)),
        ClockConfirmed::Stopped(Stopped::Changed) => {
            Err(stale(CHANGED, Some(clock_preview(app, caller)?)))
        }
    }
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require(Permission::InstanceMaintain)?;
    match text(&arguments, "action").as_deref() {
        Some("confirm_clock") => return confirm_clock(app, caller, &arguments).await,
        Some("cancel_job") => {
            let Some(id) = text(&arguments, "id") else {
                return Err(Stop::coded(
                    "missing_required_field",
                    "Name the job with id (id).",
                ));
            };
            return Ok(json!({ "job": jobs::cancel(app, caller, id).await? }));
        }
        _ => {}
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
