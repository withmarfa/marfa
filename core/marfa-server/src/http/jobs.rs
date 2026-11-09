use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use marfa_rules::{filter, time, validation};
use serde_json::{Map, Value};

use super::answer::{Answer, json_answer};
use super::body::{Bag, ReadBody};
use super::items::{Sent, invalid_field, keyed, text_of};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::{Done, ruled};
use crate::app::jobs::{self, Action, Asked};
use crate::app::query::{Ask, Filter, States};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::{self, Move, check_id, missing_field};

const COMMON: [&str; 5] = ["action", "filter", "dry_run", "max_items", "enable_fanout"];
const FILTER: [&str; 8] = [
    "type",
    "state",
    "source",
    "tier",
    "tags",
    "occurred_after",
    "occurred_before",
    "filter",
];
const MOVE_FIELDS: [&str; 3] = ["to", "properties", "dry_run"];
const STATES: [&str; 4] = ["active", "archived", "trashed", "revoked"];
const TARGET_STATES: [&str; 3] = ["active", "archived", "trashed"];
const TIERS: [&str; 2] = ["library", "feed"];
const DEFAULT_CAP: i64 = 10_000;
const MOST: i64 = 50_000;
const MAX_ADDED_TAGS: usize = 100;
const CONFIRMATION: &str = "PURGE";

fn own_fields(action: &str) -> Option<&'static [&'static str]> {
    Some(match action {
        "transition" => &["state"],
        "purge" => &["confirm", "expected_ids"],
        "update_tags" => &["add", "remove"],
        "update_tier" => &["tier"],
        "update_properties" => &["patch"],
        "update_occurred_at" => &["occurred_at"],
        _ => return None,
    })
}

/// A dropped filter field would widen the match to every item, so every unknown key is refused.
fn refuse_undeclared(sent: &Map<String, Value>, own: &[&str]) -> Result<()> {
    let mut unknown: Vec<String> = sent
        .keys()
        .filter(|key| !COMMON.contains(&key.as_str()) && !own.contains(&key.as_str()))
        .cloned()
        .collect();
    if let Some(Value::Object(filter)) = sent.get("filter") {
        unknown.extend(
            filter
                .keys()
                .filter(|key| !FILTER.contains(&key.as_str()))
                .map(|key| format!("filter.{key}")),
        );
    }
    if unknown.is_empty() {
        return Ok(());
    }
    unknown.sort_unstable();
    Err(Refusal::validation(format!(
        "The body names fields this operation does not take: {}.",
        unknown.join(", ")
    ))
    .with_detail("unknown_body_fields", unknown))
}

fn flag(sent: &Map<String, Value>, field: &str) -> Result<bool> {
    match sent.get(field) {
        None => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(invalid_field(field, format!("{field} must be a boolean."))),
    }
}

fn one_of(sent: &Map<String, Value>, field: &str, allowed: &[&str]) -> Result<Option<String>> {
    let Some(text) = text_of(sent, field)? else {
        return Ok(None);
    };
    if allowed.contains(&text.as_str()) {
        return Ok(Some(text));
    }
    Err(invalid_field(
        field,
        format!("{field} is one of {}.", allowed.join(", ")),
    ))
}

fn strings(sent: &Map<String, Value>, field: &str) -> Result<Option<Vec<String>>> {
    let Some(value) = sent.get(field) else {
        return Ok(None);
    };
    let refused = || invalid_field(field, format!("{field} must be a list of strings."));
    let Value::Array(entries) = value else {
        return Err(refused());
    };
    entries
        .iter()
        .map(|entry| entry.as_str().map(str::to_string).ok_or_else(refused))
        .collect::<Result<_>>()
        .map(Some)
}

fn timestamp(
    sent: &Map<String, Value>,
    field: &str,
    reads: fn(&str, &str) -> marfa_rules::error::Result<String>,
) -> Result<Option<String>> {
    text_of(sent, field)?
        .map(|text| reads(&text, field).map_err(|error| invalid_field(field, error.message)))
        .transpose()
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::String(text) => text.trim().is_empty(),
        Value::Array(entries) => entries.iter().all(is_blank),
        _ => false,
    }
}

/// A narrowing field that names nothing would match every item, so it is refused, not dropped.
fn refuse_empty(filter: &Map<String, Value>) -> Result<()> {
    let empty: Vec<String> = ["type", "source", "tags", "filter"]
        .into_iter()
        .filter(|field| filter.get(*field).is_some_and(is_blank))
        .map(|field| format!("filter.{field}"))
        .collect();
    if empty.is_empty() {
        return Ok(());
    }
    Err(Refusal::validation(format!(
        "The filter names fields that hold no value: {}.",
        empty.join(", ")
    ))
    .with_detail("empty_parameters", empty))
}

fn ask_of(sent: &Map<String, Value>) -> Result<Ask> {
    let filter = match sent.get("filter") {
        None => Map::new(),
        Some(Value::Object(filter)) => filter.clone(),
        Some(_) => return Err(invalid_field("filter", "filter must be an object.")),
    };
    refuse_empty(&filter)?;
    let types = match text_of(&filter, "type")? {
        Some(type_id) => {
            check_id(&type_id, "filter.type")?;
            vec![type_id]
        }
        None => Vec::new(),
    };
    let state = one_of(&filter, "state", &STATES)?.unwrap_or_else(|| "active".to_string());
    let expression = match text_of(&filter, "filter")? {
        Some(text) => {
            let expression = filter::parse(&text)
                .map_err(|error| invalid_field("filter.filter", error.message))?;
            Some(Filter { text, expression })
        }
        None => None,
    };
    Ok(Ask {
        types,
        states: States::Named(vec![state]),
        source: text_of(&filter, "source")?,
        tier: one_of(&filter, "tier", &TIERS)?,
        tags: strings(&filter, "tags")?
            .unwrap_or_default()
            .into_iter()
            .filter(|tag| !tag.trim().is_empty())
            .collect(),
        filter: expression,
        occurred_after: timestamp(&filter, "occurred_after", time::normalize_bound)?,
        occurred_before: timestamp(&filter, "occurred_before", time::normalize_bound)?,
        ..Ask::default()
    })
}

fn cap_of(sent: &Map<String, Value>) -> Result<i64> {
    match sent.get("max_items") {
        None => Ok(DEFAULT_CAP),
        Some(value) => value
            .as_i64()
            .filter(|cap| *cap > 0)
            .map(|cap| cap.min(MOST))
            .ok_or_else(|| invalid_field("max_items", "max_items is a whole number above 0.")),
    }
}

fn required<T>(found: Option<T>, field: &str) -> Result<T> {
    found.ok_or_else(|| missing_field(field))
}

fn action_of(name: &str, sent: &Map<String, Value>) -> Result<(Action, Option<Vec<String>>)> {
    let action = match name {
        "transition" => Action::Transition {
            state: required(one_of(sent, "state", &TARGET_STATES)?, "state")?,
        },
        "purge" => {
            if text_of(sent, "confirm")?.as_deref() != Some(CONFIRMATION) {
                return Err(Refusal::new(
                    Code::BulkConfirmationRequired,
                    "A bulk purge needs confirm: \"PURGE\".",
                ));
            }
            let expected = strings(sent, "expected_ids")?;
            if expected.as_ref().is_some_and(Vec::is_empty) {
                return Err(invalid_field(
                    "expected_ids",
                    "expected_ids names at least one item.",
                ));
            }
            return Ok((Action::Purge, expected));
        }
        "update_tags" => {
            let add = strings(sent, "add")?;
            let remove = strings(sent, "remove")?;
            if add.is_none() && remove.is_none() {
                return Err(Refusal::validation("update_tags needs add or remove."));
            }
            let add = add.unwrap_or_default();
            if add.len() > MAX_ADDED_TAGS {
                return Err(invalid_field(
                    "add",
                    format!("add names at most {MAX_ADDED_TAGS} tags."),
                ));
            }
            validation::tags(&add).map_err(ruled)?;
            Action::UpdateTags {
                add,
                remove: remove.unwrap_or_default(),
            }
        }
        "update_tier" => Action::UpdateTier {
            tier: required(one_of(sent, "tier", &TIERS)?, "tier")?,
        },
        "update_properties" => match sent.get("patch") {
            None => return Err(missing_field("patch")),
            Some(Value::Object(patch)) => {
                validation::property_names(patch).map_err(ruled)?;
                Action::UpdateProperties {
                    patch: patch.clone(),
                }
            }
            Some(_) => return Err(invalid_field("patch", "patch must be an object.")),
        },
        "update_occurred_at" => Action::UpdateOccurredAt {
            occurred_at: required(timestamp(sent, "occurred_at", time::rfc3339)?, "occurred_at")?,
        },
        _ => {
            return Err(invalid_field(
                "action",
                "action is transition, purge, update_tags, update_tier, update_properties or update_occurred_at.",
            ));
        }
    };
    Ok((action, None))
}

fn asked_of(body: &ReadBody) -> Result<Asked> {
    let sent = body.object(Bag::Patch)?;
    body.refuse_inexact_numbers(Bag::Patch)?;
    let name = required(text_of(&sent, "action")?, "action")?;
    let own = own_fields(&name).unwrap_or_default();
    refuse_undeclared(&sent, own)?;
    let ask = ask_of(&sent)?;
    let (action, expected) = action_of(&name, &sent)?;
    Ok(Asked {
        ask,
        cap: cap_of(&sent)?,
        dry_run: flag(&sent, "dry_run")?,
        fanout: flag(&sent, "enable_fanout")?,
        action,
        expected,
    })
}

pub async fn queue(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    caller.require_reach()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let asked = asked_of(&body)?;
        let (status, body) = jobs::queue(&door, &who, asked, claim).await?;
        Ok(Done { status, body })
    })
    .await
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &jobs::read(&app, &caller, id).await?,
    ))
}

pub async fn cancel(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(id): Path<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    Ok(json_answer(
        StatusCode::OK,
        &jobs::cancel(&app, &caller, id).await?,
    ))
}

fn move_of(body: &ReadBody) -> Result<Move> {
    let sent = body.object(Bag::Properties)?;
    body.refuse_inexact_numbers(Bag::Properties)?;
    let sent = super::body::only_declared(sent, &MOVE_FIELDS)?;
    let to = required(text_of(&sent, "to")?, "to")?;
    let properties = match sent.get("properties") {
        None => None,
        Some(Value::Object(properties)) => {
            validation::property_names(properties).map_err(ruled)?;
            Some(properties.clone())
        }
        Some(_) => {
            return Err(invalid_field("properties", "properties must be an object."));
        }
    };
    Ok(Move {
        to,
        properties,
        dry_run: flag(&sent, "dry_run")?,
    })
}

pub async fn move_type(
    State(app): State<Arc<App>>,
    caller: Caller,
    Path(from): Path<String>,
    sent: Sent,
) -> Answer {
    caller.require_reach()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        query::only(&uri, &[])?;
        let asked = move_of(&body)?;
        let (status, body) = types::move_type(&door, &who, from, asked, claim).await?;
        Ok(Done { status, body })
    })
    .await
}
