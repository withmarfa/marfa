//! `marfa_end_sign_in`: previews ending a browser sign-in, an app or a passkey, then ends it on a
//! single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::stale;
use super::revoke::NAME as REVOKE_KEY;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::mcp::connector::Confirmed;
use crate::app::mcp::sign_in::{self, AppEnding, Closing, Kind, Named};
use crate::app::mcp::{app_data, confirm};
use crate::app::oauth::grants::Ending;
use crate::app::refusal::{Code, Refusal};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list, json_length};

pub const NAME: &str = sign_in::TOOL;

const ROOM: usize = ANSWER_BUDGET_CHARS - 4_000;

const ASK: &str = "Show the person what would end and ask them; only if they agree, call marfa_end_sign_in again with the same kind, id, revoke_keys and remove_data, and confirm.";
const BROWSER_NEXT: &str =
    "Nothing has been ended. Ending this sign-in signs that browser out; it must sign in again.";
const APP_NEXT: &str = "Nothing has been ended. Ending this app ends its access at every MCP endpoint and the API, ends its token chains and deletes its webhooks with the events they have not delivered yet. To connect again, it must ask the owner to approve it again.";
const PASSKEY_NEXT: &str = "Nothing has been removed. Removing this passkey means it can no longer sign the owner in. This cannot be undone: the owner adds a new passkey from a browser.";
const OWN: &str = "This is the credential making this call. Ending it ends this connection at /mcp, /mcp/schema and /mcp/admin alike, so no call after the confirming one works until the app is connected again.";
const DATA_GOES: &str = "With remove_data, every item of the app's own data in every state, the trash included, and the types it registered are deleted for good, and only a backup taken before brings them back: run marfa_take_backup first if the person may want them. Items of other types that point at them keep their item and lose the link.";
const DATA_KEPT: &str =
    "The app's own data stays. To delete it with the app, preview again with remove_data.";
const KEYS_KEPT: &str =
    "The app's keys keep working. To revoke them with the app, preview again with revoke_keys.";
const UNBOUND: &str = "Token chains are counted as they stand now. The app refreshes them and is issued codes as it works, and events are queued for its webhooks as items change, so the confirmation does not cover them: ending the app ends every token chain and unredeemed code it has, and every delivery queued for its webhooks, when it happens.";
const KEY: &str = "This ID names a key. Revoke a key with marfa_revoke_key.";

const ENDED_BROWSER: &str = "Ended. That browser is signed out.";
const ENDED_APP: &str = "Ended. The app's access, token chains and webhooks are gone, with any keys and data the preview listed.";
const REMOVED_PASSKEY: &str = "Removed. The passkey no longer signs the owner in.";
const REPEATED: &str = "This confirmation already did this. This call changed nothing.";

const STALE: &str = "This confirmation does not hold for this sign-in or passkey. This call changed nothing. Preview again to get a new confirmation.";
const CHANGED: &str =
    "What the preview showed has changed. This call changed nothing; here is a new preview.";
const CHANGED_GONE: &str =
    "What the preview showed has changed. This call changed nothing. Preview again.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "End a sign-in, an app or a passkey",
        description: "Use to end a browser sign-in or an app, as marfa_sign_ins lists them, or to remove a passkey. Ending an app ends its access, token chains and webhooks; with revoke_keys, it also revokes the keys the app made, and with remove_data it deletes the app's own data for good. A key is revoked with marfa_revoke_key instead. The first call only previews; show the person and ask. Only if they agree, call again with the same kind, id, revoke_keys and remove_data, and confirm. A confirmation works once, for this credential only. This cannot be undone.",
        input: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["sign_in", "passkey"],
                    "description": "What id names: a sign-in, which is a browser or an app, or a passkey. A sign-in when left out." },
                "id": { "type": "string", "minLength": 1,
                    "description": "The sign-in or passkey, as marfa_sign_ins shows it. An app's ID is also its grant, as marfa_apps shows it." },
                "revoke_keys": { "type": "boolean",
                    "description": "For an app, also revoke every key it made. False when left out." },
                "remove_data": { "type": "boolean",
                    "description": "For an app, also delete for good the items and types of every vendor it holds. Needs items.purge, write on every type under those vendors and, while types are registered there, schema.write. Refused above 1,000 items: remove them first with marfa_app_data. False when left out." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the same kind, id, revoke_keys and remove_data. Leave out to preview." },
            },
            "required": ["id"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["browser", "app", "passkey"] },
                "sign_in": { "type": "object", "description": "The browser or app, as marfa_sign_ins lists it." },
                "passkey": { "type": "object", "description": "The passkey, as marfa_sign_ins lists it." },
                "scopes": { "type": "array", "items": { "type": "string" },
                    "description": "What the app was approved for." },
                "webhooks": { "type": "array", "items": { "type": "object" },
                    "description": "The app's webhooks, which are deleted with it." },
                "webhooks_left_out": { "type": "integer" },
                "keys": { "type": "array", "items": { "type": "object" },
                    "description": "With revoke_keys, the app's keys that are revoked with it." },
                "keys_left_out": { "type": "integer" },
                "keys_kept": { "type": "integer",
                    "description": "Without revoke_keys, the app's keys, which keep working." },
                "data": { "type": "array", "items": { "type": "object" },
                    "description": "With remove_data, each vendor the app holds, with its types and how many items each holds by state, which are deleted with it." },
                "token_chains": { "type": "integer" },
                "ends_this_connection": { "type": "boolean",
                    "description": "Whether ending the app ends the credential making this call." },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "ended": { "type": "boolean" },
                "revoked_keys": { "type": "integer" },
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

fn app_body(body: &mut Map<String, Value>, app: AppEnding) -> String {
    let scopes = json!(app.scopes);
    let room = ROOM.saturating_sub(json_length(&app.sign_in) + json_length(&scopes)) / 2;
    body.insert("sign_in".into(), app.sign_in);
    body.insert("scopes".into(), scopes);
    let (hooks, hooks_left) = fit_list(app.webhooks, room);
    body.insert("webhooks".into(), Value::Array(hooks));
    if hooks_left > 0 {
        body.insert("webhooks_left_out".into(), hooks_left.into());
    }
    let mut next = vec![APP_NEXT];
    match app.keys {
        Some(keys) => {
            let (keys, keys_left) = fit_list(keys, room);
            body.insert("keys".into(), Value::Array(keys));
            if keys_left > 0 {
                body.insert("keys_left_out".into(), keys_left.into());
            }
        }
        None => {
            body.insert("keys_kept".into(), app.keys_held.into());
            if app.keys_held > 0 {
                next.push(KEYS_KEPT);
            }
        }
    }
    match app.data {
        Some(data) => {
            body.insert("data".into(), Value::Array(data));
            next.push(DATA_GOES);
        }
        None => next.push(DATA_KEPT),
    }
    body.insert("token_chains".into(), app.token_chains.into());
    next.push(UNBOUND);
    body.insert("ends_this_connection".into(), app.ends_caller.into());
    if app.ends_caller {
        next.push(OWN);
    }
    next.join(" ")
}

fn key_refused() -> Stop {
    Stop::coded("validation_error", KEY).with("use_tool", REVOKE_KEY)
}

fn preview_body(
    app: &App,
    caller: &Caller,
    id: &str,
    asked: Ending,
    closing: Closing,
) -> Result<Map<String, Value>, Stop> {
    let Some(token) = sign_in::token(app, caller, id, asked, &closing)? else {
        return Err(key_refused());
    };
    let mut body = Map::new();
    let next = match closing {
        Closing::Browser { sign_in, .. } => {
            body.insert("kind".into(), Kind::Browser.word().into());
            body.insert("sign_in".into(), sign_in);
            BROWSER_NEXT.to_string()
        }
        Closing::App { app, .. } => {
            body.insert("kind".into(), Kind::App.word().into());
            app_body(&mut body, *app)
        }
        Closing::Passkey { passkey, .. } => {
            body.insert("kind".into(), Kind::Passkey.word().into());
            body.insert("passkey".into(), passkey);
            PASSKEY_NEXT.to_string()
        }
        Closing::Key => return Err(key_refused()),
    };
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    body.insert("next".into(), format!("{next} {ASK}").into());
    Ok(body)
}

async fn preview(
    app: &App,
    caller: &Caller,
    (named, id, asked): (Named, &str, Ending),
) -> Result<Map<String, Value>, Stop> {
    let closing = sign_in::preview(app, caller, named, id.to_string(), asked)
        .await
        .map_err(refused)?;
    preview_body(app, caller, id, asked, closing)
}

/// An app holding more than one removal takes is pointed at the tool that removes in pages.
fn refused(refusal: Refusal) -> Stop {
    let capped = refusal.code == Code::BulkCapExceeded;
    let stop = Stop::refused(refusal);
    if capped {
        stop.with("use_tool", app_data::TOOL)
    } else {
        stop
    }
}

fn done(kind: Kind, total: i64, repeated: bool) -> Value {
    let mut body = Map::new();
    body.insert("ended".into(), true.into());
    body.insert("kind".into(), kind.word().into());
    if kind == Kind::App {
        body.insert("revoked_keys".into(), total.into());
    }
    let next = match (repeated, kind) {
        (true, _) => REPEATED,
        (false, Kind::Browser) => ENDED_BROWSER,
        (false, Kind::App) => ENDED_APP,
        (false, Kind::Passkey) => REMOVED_PASSKEY,
    };
    if repeated {
        body.insert("already_done".into(), true.into());
    }
    body.insert("next".into(), next.into());
    Value::Object(body)
}

pub async fn run(
    app: &Arc<App>,
    caller: &Caller,
    arguments: Map<String, Value>,
    visit: Visit,
) -> Outcome {
    let id = text(&arguments, "id").unwrap_or_default();
    let named = match text(&arguments, "kind").as_deref() {
        Some("passkey") => Named::Passkey,
        _ => Named::SignIn,
    };
    let flag = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let asked = Ending {
        revoke_keys: flag("revoke_keys"),
        remove_data: flag("remove_data"),
    };
    let Some(token) = text(&arguments, "confirm") else {
        return Ok(Value::Object(
            preview(app, caller, (named, &id, asked)).await?,
        ));
    };
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let (kind, confirmed) =
        sign_in::end_confirmed(app, caller, (named, id.clone(), asked), bound, visit).await?;
    match (kind, confirmed) {
        (Some(kind), Confirmed::Done { total }) => Ok(done(kind, total, false)),
        (Some(kind), Confirmed::Repeated { total }) => Ok(done(kind, total, true)),
        (_, Confirmed::Changed) => {
            let read = sign_in::preview(app, caller, named, id.clone(), asked).await;
            match sign_in::read_now(read).map_err(refused)? {
                Some(Closing::Key) | None => Err(stale(CHANGED_GONE, None)),
                Some(closing) => {
                    let body = preview_body(app, caller, &id, asked, closing)?;
                    Err(stale(CHANGED, Some(body)))
                }
            }
        }
        _ => Err(stale(STALE, None)),
    }
}
