//! `marfa_app_data`: previews what an app keeps under one of its vendors, then deletes it on a
//! single-use confirmation.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::delete_connector::stale;
use super::{Definition, text};
use crate::app::App;
use crate::app::access::{Caller, Permission};
use crate::app::mcp::app_data;
use crate::app::mcp::confirm;
use crate::app::mcp::connector::Confirmed;
use crate::app::vendor_data::{self, MOST_REMOVED};
use crate::http::mcp::results::Outcome;

pub const NAME: &str = app_data::TOOL;

const PREVIEW_NEXT: &str = "Nothing has been deleted. Deleting removes for good every item of these types in every state, the trash included, and then the types themselves; items of other types that point at them keep their item and lose the link. Only a backup taken before brings them back: run marfa_take_backup first if the person may want them. Show the person and ask; only if they agree, call marfa_app_data again with the same vendor and confirm.";
const READ_ONLY: &str =
    "Deleting this data needs items.purge, which this credential does not hold.";
const REMOVED_ALL: &str =
    "Deleted. The vendor's items and types are gone; the vendor stays with the app that holds it.";
const REMOVED_PART: &str = "Deleted one page of the vendor's items. Preview again and confirm to delete the rest; the types go with the last page.";
const REPEATED: &str = "This confirmation already did this. This call changed nothing.";
const STALE: &str = "This confirmation does not hold for this vendor. This call changed nothing. Preview again to get a new confirmation.";
const CHANGED: &str = "What the vendor holds has changed since the preview. This call changed nothing. Preview again.";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "List or delete an app's own data",
        description: "Use to see what an app keeps under one of its app.<vendor> namespaces, as marfa_apps lists them in vendors: its types, how many items each holds by state, and the items. With items.purge, the preview also gives a confirmation that deletes the data for good, up to 1,000 items a call. The first call only previews; show the person and ask. Only if they agree, call again with the same vendor and confirm.",
        input: json!({
            "type": "object",
            "properties": {
                "vendor": { "type": "string", "minLength": 1,
                    "description": "The app.<vendor> namespace, such as app.acme." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview, sent with the same vendor. Leave out to preview." },
            },
            "required": ["vendor"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "vendor": { "type": "string" },
                "client_id": { "type": ["string", "null"],
                    "description": "The app that holds the vendor, or null while the owner holds it." },
                "types": { "type": "array", "items": { "type": "object" },
                    "description": "Each type under the vendor, with how many items it holds in each state." },
                "items": { "type": "integer", "description": "How many items the vendor holds in every state." },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "removed_items": { "type": "integer" },
                "remaining_items": { "type": "integer" },
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

async fn preview(app: &App, caller: &Caller, vendor: &str) -> Outcome {
    let held = vendor_data::preview(app, caller, vendor.to_string(), false).await?;
    let mut body = match held.to_json() {
        Value::Object(body) => body,
        _ => Map::new(),
    };
    if !caller.holds(Permission::ItemsPurge) {
        body.insert("next".into(), READ_ONLY.into());
        return Ok(Value::Object(body));
    }
    let token = app_data::token(app, caller, &held)?;
    body.insert("confirm".into(), token.text.into());
    body.insert("expires_at".into(), token.expires_at.text().into());
    let mut next = PREVIEW_NEXT.to_string();
    if held.items > MOST_REMOVED {
        next.push_str(
            " One confirmation deletes the first 1,000 items; preview again for the rest.",
        );
    }
    body.insert("next".into(), next.into());
    Ok(Value::Object(body))
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    caller.require_vendor_door()?;
    let vendor = text(&arguments, "vendor").unwrap_or_default();
    crate::app::vendors::check_vendor(&vendor)?;
    let Some(token) = text(&arguments, "confirm") else {
        return preview(app, caller, &vendor).await;
    };
    caller.require(Permission::ItemsPurge)?;
    let Some(bound) = confirm::parse_bound(&token) else {
        return Err(stale(STALE, None));
    };
    let confirmed = app_data::remove_confirmed(app, caller, vendor.clone(), bound).await?;
    let (removed, repeated) = match confirmed {
        Confirmed::Done { total } => (total, false),
        Confirmed::Repeated { total } => (total, true),
        Confirmed::Changed => return Err(stale(CHANGED, None)),
        Confirmed::Stale => return Err(stale(STALE, None)),
    };
    let left = vendor_data::preview(app, caller, vendor.clone(), false).await?;
    let mut body = Map::new();
    body.insert("vendor".into(), vendor.into());
    body.insert("removed_items".into(), removed.into());
    body.insert("remaining_items".into(), left.items.into());
    if repeated {
        body.insert("already_done".into(), true.into());
    }
    let next = match (repeated, left.items) {
        (true, _) => REPEATED,
        (false, 0) => REMOVED_ALL,
        (false, _) => REMOVED_PART,
    };
    body.insert("next".into(), next.into());
    Ok(Value::Object(body))
}
