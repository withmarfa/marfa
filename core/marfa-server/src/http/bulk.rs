//! `POST /items/bulk`. The door reads a page; `app::items::bulk` decides what becomes of it.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use marfa_rules::validation;
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::{Bag, JsonBody, ReadBody, only_declared};
use super::items::{
    declared_type, edges_of, invalid_field, properties_of, tags_of, text_of, time_of, version_of,
};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::bulk::{self, Asked, Entry, rollback};
use crate::app::items::write::{Put, ruled};
use crate::app::refusal::{Refusal, Result};
use crate::app::types::missing_field;

const PAGE_FIELDS: [&str; 5] = ["mode", "atomic", "retype", "enable_fanout", "items"];
const ENTRY_FIELDS: [&str; 12] = [
    "id",
    "type",
    "properties",
    "properties_mode",
    "state",
    "tier",
    "occurred_at",
    "source",
    "source_id",
    "version",
    "tags",
    "edges",
];
const MAX_ENTRIES: usize = 5000;

fn flag_of(sent: &Map<String, Value>, field: &str) -> Result<Option<bool>> {
    match sent.get(field) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(invalid_field(field, format!("{field} must be a boolean."))),
    }
}

fn declared_entry(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(entry) => only_declared(entry, &ENTRY_FIELDS),
        _ => Err(Refusal::validation("An entry must be an object.")),
    }
}

/// The rules for a tag and a property name judge the page's text, so an entry
/// that breaks one refuses the whole page, as it refuses any other write.
fn judge_text(entry: &Map<String, Value>) -> Result<()> {
    if let Some(Value::Array(listed)) = entry.get("tags") {
        let tags: Vec<String> = listed
            .iter()
            .filter_map(|tag| tag.as_str().map(str::to_string))
            .collect();
        validation::tags(&tags).map_err(ruled)?;
    }
    if let Some(Value::Object(properties)) = entry.get("properties") {
        validation::property_names(properties).map_err(ruled)?;
    }
    Ok(())
}

fn entry_of(mut sent: Map<String, Value>, create_only: bool) -> Result<Entry> {
    let Some(type_id) = declared_type(&sent)? else {
        return Err(missing_field("type"));
    };
    let properties = properties_of(&mut sent)?;
    let id = text_of(&sent, "id")?;
    if let Some(id) = &id {
        validation::id("id", id).map_err(ruled)?;
    }
    let replace = match text_of(&sent, "properties_mode")?.as_deref() {
        None | Some("merge") => false,
        Some("replace") => true,
        Some(_) => {
            return Err(invalid_field(
                "properties_mode",
                "properties_mode is merge or replace.",
            ));
        }
    };
    Ok(Entry {
        put: Put {
            type_id,
            properties,
            id,
            state: text_of(&sent, "state")?,
            occurred_at: time_of(&sent)?,
            source: text_of(&sent, "source")?,
            source_id: text_of(&sent, "source_id")?,
            create_only,
            version: version_of(&sent)?,
            tier: text_of(&sent, "tier")?,
            tags: sent.get("tags").map(tags_of).transpose()?,
            edges: edges_of(&sent)?,
            ..Put::default()
        },
        replace,
    })
}

fn asked_of(body: &ReadBody) -> Result<Asked> {
    let mut sent = only_declared(body.object(Bag::Entries("items"))?, &PAGE_FIELDS)?;
    body.refuse_inexact_numbers(Bag::Entries("items"))?;
    let mode = match text_of(&sent, "mode")?.as_deref() {
        None | Some("upsert") => "upsert",
        Some("create_only") => "create_only",
        Some(_) => return Err(invalid_field("mode", "mode is upsert or create_only.")),
    };
    let atomic = flag_of(&sent, "atomic")?.unwrap_or(true);
    let retype = flag_of(&sent, "retype")?.unwrap_or(false);
    flag_of(&sent, "enable_fanout")?;
    let items = match sent.remove("items") {
        None => return Err(missing_field("items")),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(invalid_field("items", "items must be a list.")),
    };
    if items.len() > MAX_ENTRIES {
        return Err(
            Refusal::validation(format!("Maximum {MAX_ENTRIES} items per call"))
                .with_detail("cap", MAX_ENTRIES)
                .with_detail("provided", items.len()),
        );
    }
    let declared: Vec<_> = items.into_iter().map(declared_entry).collect();
    if atomic
        && let Some((index, Err(refusal))) = declared
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.is_err())
    {
        return Err(rollback(index, refusal));
    }
    for entry in declared.iter().flatten() {
        judge_text(entry)?;
    }
    let create_only = mode == "create_only";
    Ok(Asked {
        entries: declared
            .into_iter()
            .map(|entry| entry.and_then(|sent| entry_of(sent, create_only)))
            .collect(),
        mode,
        atomic,
        retype,
    })
}

pub async fn write(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_reach()?;
    let sent = body.read().await?;
    let asked = asked_of(&sent)?;
    let answer = bulk::write(&app, &caller, asked).await?;
    Ok(text_answer(StatusCode::OK, answer))
}
