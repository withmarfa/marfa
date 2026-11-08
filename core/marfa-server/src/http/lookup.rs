use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use marfa_rules::{time, validation};
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::JsonBody;
use super::items::{finished, invalid_field, text_of};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::write::{self, Change};
use crate::app::items::{self, Keys, Selector};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::{check_id, missing_field};

const LOOKUP_FIELDS: [&str; 6] = ["type", "links", "source", "source_ids", "ids", "include"];
const SETTLE_FIELDS: [&str; 5] = ["type", "links", "source", "source_ids", "settled_at"];
const MAX_VALUES: usize = 500;

fn type_of(sent: &Map<String, Value>) -> Result<String> {
    let Some(type_id) = text_of(sent, "type")? else {
        return Err(missing_field("type"));
    };
    check_id(&type_id, "type")?;
    Ok(type_id)
}

fn values_of(sent: &Map<String, Value>, field: &str) -> Result<Vec<String>> {
    let refused = || invalid_field(field, format!("{field} must be a list of strings."));
    let named = sent
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(refused)?;
    if named.len() > MAX_VALUES {
        return Err(
            Refusal::validation(format!("Maximum {MAX_VALUES} values per call"))
                .with_detail("cap", MAX_VALUES)
                .with_detail("provided", named.len()),
        );
    }
    let mut seen = HashSet::new();
    let mut values = Vec::with_capacity(named.len());
    for value in named {
        let value = value.as_str().ok_or_else(refused)?;
        if value.is_empty() && field != "ids" {
            return Err(invalid_field(
                field,
                format!("{field} holds no empty value."),
            ));
        }
        if seen.insert(value) {
            values.push(value.to_string());
        }
    }
    Ok(values)
}

fn selector_of(sent: &Map<String, Value>, ids_too: bool) -> Result<Selector> {
    let by_links = sent.contains_key("links");
    let by_key = sent.contains_key("source") || sent.contains_key("source_ids");
    let by_ids = ids_too && sent.contains_key("ids");
    if usize::from(by_links) + usize::from(by_key) + usize::from(by_ids) != 1 {
        return Err(Refusal::validation(
            "Name exactly one selector: `links`, `source` with `source_ids`, or `ids`",
        ));
    }
    if by_links {
        return Ok(Selector::Keys(Keys::Links(values_of(sent, "links")?)));
    }
    if by_ids {
        let ids = values_of(sent, "ids")?;
        for id in &ids {
            if validation::id("ids", id).is_err() {
                return Err(
                    Refusal::new(Code::InvalidId, format!("Invalid item id: {id}"))
                        .with_detail("id", id.as_str()),
                );
            }
        }
        return Ok(Selector::Ids(ids));
    }
    let Some(source) = text_of(sent, "source")?.filter(|source| !source.is_empty()) else {
        return Err(invalid_field("source", "source is named with source_ids."));
    };
    if !sent.contains_key("source_ids") {
        return Err(invalid_field(
            "source_ids",
            "source_ids is named with source.",
        ));
    }
    Ok(Selector::Keys(Keys::Natural {
        source,
        source_ids: values_of(sent, "source_ids")?,
    }))
}

fn edges_asked(sent: &Map<String, Value>) -> Result<bool> {
    let Some(include) = sent.get("include") else {
        return Ok(false);
    };
    let refused = || invalid_field("include", "include may name edges.");
    let include = include.as_array().ok_or_else(refused)?;
    if include.iter().any(|entry| entry.as_str() != Some("edges")) {
        return Err(refused());
    }
    Ok(!include.is_empty())
}

pub async fn lookup(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_reach()?;
    let sent = body.object(&LOOKUP_FIELDS).await?;
    let type_id = type_of(&sent)?;
    let selector = selector_of(&sent, true)?;
    let edges = edges_asked(&sent)?;
    let answer = items::lookup(&app, &caller, type_id, selector, edges).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn settle(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    let sent = body.object(&SETTLE_FIELDS).await?;
    let type_id = type_of(&sent)?;
    let Some(settled_at) = text_of(&sent, "settled_at")? else {
        return Err(missing_field("settled_at").into());
    };
    let settled_at = time::normalize(&settled_at, "settled_at")
        .map_err(|error| invalid_field("settled_at", error.message))?;
    let Selector::Keys(keys) = selector_of(&sent, false)? else {
        return Err(Refusal::internal("a settle was asked by id").into());
    };
    let change = Change::Settle {
        type_id,
        keys,
        settled_at,
    };
    Ok(finished(write::run(&app, &caller, None, change).await?))
}
