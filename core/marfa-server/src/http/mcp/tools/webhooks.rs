//! `marfa_webhooks` and `marfa_manage_webhook`: the webhooks a credential made, and making, changing or deleting one.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::{Definition, instant, item_id, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::mcp::confirm;
use crate::app::mcp::webhook::{self, Confirmed, Plan, Request};
use crate::app::refusal::Refusal;
use crate::app::webhooks::{self as hooks, Subscription, Update};
use crate::http::mcp::results::{ANSWER_BUDGET_CHARS, Outcome, Stop, fit_list};

pub const LIST_NAME: &str = "marfa_webhooks";
pub const MANAGE_NAME: &str = "marfa_manage_webhook";

const SENDS: &str = "Each event it names, signed with the webhook's secret. Item events and metadata.changed carry the item, its tags and the extensions this credential can read, after the change or before a purge. An edge event carries the edge.";

pub fn list_definition() -> Definition {
    Definition {
        name: LIST_NAME,
        title: "List webhooks",
        description: "Use to see the webhooks this credential made: where each sends events, which events, and whether it is active.",
        input: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "webhooks": { "type": "array", "items": { "type": "object" } },
                "left_out": { "type": "integer" },
            },
            "required": ["webhooks"],
        }),
        annotations: json!({ "readOnlyHint": true, "openWorldHint": false }),
        meta: None,
    }
}

pub fn manage_definition() -> Definition {
    Definition {
        name: MANAGE_NAME,
        title: "Make, change or delete a webhook",
        description: "Use to have Marfa post events, such as new items, to a web address, or to change or delete such a webhook. Making one, or changing where one posts or what it sends, first previews what would leave Marfa: show the person, and call again with the same arguments and confirm. A confirmation works once. Making one returns the secret that signs each delivery, once. Pausing, resuming or deleting one takes one call.",
        input: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["make", "change", "delete"] },
                "id": { "type": "string", "minLength": 1, "description": "The webhook to change or delete." },
                "url": { "type": "string", "minLength": 1,
                    "description": "A public http or https address. Required to make one." },
                "events": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 },
                    "description": "The events to send, such as item.created. Required to make one." },
                "type_filter": { "type": ["string", "null"],
                    "description": "Send item events only for this type or pattern, such as `app.*`; null sends every type." },
                "active": { "type": "boolean", "description": "`false` pauses it. Only to change one." },
                "confirm": { "type": "string", "minLength": 1,
                    "description": "The confirm token from the preview. Leave out to preview." },
            },
            "required": ["action"],
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "preview": { "type": "object" },
                "confirm": { "type": "string" },
                "expires_at": { "type": "string" },
                "webhook": { "type": "object" },
                "deleted": { "type": "string" },
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

pub async fn list(app: &Arc<App>, caller: &Caller) -> Outcome {
    let listed = hooks::list(app, caller).await?;
    let shown: Vec<Value> = listed["data"]
        .as_array()
        .map(|data| {
            data.iter()
                .cloned()
                .map(|mut hook| {
                    if let Some(object) = hook.as_object_mut() {
                        object.remove("secret");
                    }
                    hook
                })
                .collect()
        })
        .unwrap_or_default();
    let (kept, left_out) = fit_list(shown, ANSWER_BUDGET_CHARS - 200);
    let mut answer = Map::new();
    answer.insert("webhooks".into(), Value::Array(kept));
    if left_out > 0 {
        answer.insert("left_out".into(), left_out.into());
    }
    Ok(Value::Object(answer))
}

fn body_of(arguments: &Map<String, Value>, names: &[&str]) -> Map<String, Value> {
    let mut body = Map::new();
    for name in names {
        if let Some(value) = arguments.get(*name) {
            body.insert((*name).into(), value.clone());
        }
    }
    body
}

/// A webhook as the tools show it: the secret only when the webhook was just made.
fn view(subscription: &Subscription, secret_shown: bool) -> Value {
    let mut shown = hooks::answer(subscription, secret_shown);
    if !secret_shown {
        shown.remove("secret");
    }
    Value::Object(shown)
}

fn preview_body(plan: &Plan, token: &confirm::Token, made: bool) -> Map<String, Value> {
    let mut shown = Map::new();
    if let Some(id) = &plan.id {
        shown.insert("id".into(), id.clone().into());
    }
    shown.insert("url".into(), plan.url.clone().into());
    shown.insert("host".into(), plan.host.clone().into());
    shown.insert("events".into(), json!(plan.events));
    shown.insert("type_filter".into(), json!(plan.type_filter));
    shown.insert("active".into(), plan.active.into());
    shown.insert(
        "sends".into(),
        format!(
            "{SENDS} Everything is posted to {}, outside Marfa.",
            plan.host
        )
        .into(),
    );
    let mut body = Map::new();
    body.insert("preview".into(), Value::Object(shown));
    body.insert("confirm".into(), token.text.clone().into());
    body.insert("expires_at".into(), instant(token.expires_at_ms).into());
    body.insert(
        "next".into(),
        format!(
            "Nothing has {}. Show the person where this sends what, and call again with the same arguments and confirm once they agree.",
            if made { "been made" } else { "changed" }
        )
        .into(),
    );
    body
}

fn stale(body: Map<String, Value>, expired: bool, made: bool) -> Stop {
    let nothing = if made {
        "Nothing was made"
    } else {
        "Nothing changed"
    };
    let mut stop = Stop::coded(
        "confirmation_stale",
        if expired {
            format!("The confirmation expired. {nothing}; here is a new preview.")
        } else {
            format!(
                "The webhook, or the webhooks this credential reads, changed, or the confirmation is not this preview's, or it was already used. {nothing}; here is a new preview."
            )
        },
    );
    for (name, value) in body {
        stop.error.insert(name, value);
    }
    stop
}

fn required(name: &str, message: &str) -> Stop {
    Stop::coded("missing_required_field", format!("{message} ({name})"))
}

fn request_of(arguments: &Map<String, Value>, id: Option<&str>) -> Result<Request, Refusal> {
    match id {
        None => Request::make(&body_of(arguments, &["url", "events", "type_filter"])),
        Some(id) => Request::change(
            id.to_string(),
            &body_of(arguments, &["url", "events", "type_filter", "active"]),
        ),
    }
}

async fn make_or_change(
    app: &Arc<App>,
    caller: &Caller,
    arguments: &Map<String, Value>,
    id: Option<String>,
) -> Outcome {
    let made = id.is_none();
    let request = request_of(arguments, id.as_deref())?;
    let Some(token) = text(arguments, "confirm") else {
        let shown = webhook::preview(app, caller, request).await?;
        return Ok(Value::Object(preview_body(&shown.plan, &shown.token, made)));
    };
    match webhook::confirmed(app, caller, request, &token).await? {
        Confirmed::Made(subscription) => Ok(json!({
            "webhook": view(&subscription, true),
            "next": "Give the secret to whoever receives the deliveries now: Marfa never shows it again.",
        })),
        Confirmed::Changed(subscription) => Ok(json!({ "webhook": view(&subscription, false) })),
        Confirmed::Stale => {
            let expired = confirm::is_expired(&token, app.clock.now_ms());
            let shown =
                webhook::preview(app, caller, request_of(arguments, id.as_deref())?).await?;
            Err(stale(
                preview_body(&shown.plan, &shown.token, made),
                expired,
                made,
            ))
        }
    }
}

pub async fn manage(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let action = text(&arguments, "action").unwrap_or_default();
    if action == "make" {
        if !arguments.contains_key("url") || !arguments.contains_key("events") {
            return Err(required("url", "A new webhook needs a url and events."));
        }
        if arguments.contains_key("active") || arguments.contains_key("id") {
            return Err(Stop::invalid(
                "A new webhook starts active and gets its own id; leave out active and id.",
            ));
        }
        return make_or_change(app, caller, &arguments, None).await;
    }
    let Some(id) = text(&arguments, "id") else {
        return Err(required("id", "Name the webhook with id."));
    };
    item_id(&id)?;
    if action == "delete" {
        hooks::delete(app, caller, id.clone()).await?;
        return Ok(json!({ "deleted": id }));
    }
    let named = ["url", "events", "type_filter"]
        .iter()
        .any(|name| arguments.contains_key(*name));
    if named {
        return make_or_change(app, caller, &arguments, Some(id)).await;
    }
    let Some(active) = arguments.get("active") else {
        return Err(Stop::invalid(
            "Name what to change: url, events, type_filter or active.",
        ));
    };
    let body = Map::from_iter([("active".to_string(), active.clone())]);
    let update = Update::from_body(&body)?;
    let changed = hooks::update(app, caller, id, update).await?;
    let mut shown = changed;
    if let Some(object) = shown.as_object_mut() {
        object.remove("secret");
    }
    Ok(json!({ "webhook": shown }))
}
