use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use marfa_rules::{time, validation};
use serde_json::{Map, Value};

use super::answer::{Answer, text_answer};
use super::body::{Bag, JsonBody, ReadBody, only_declared};
use super::items::{
    Named, Sent, check_item_id, invalid_field, keyed, properties_of, text_of, version_of,
};
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::edges::bulk::{self, Asked, Entry};
use crate::app::edges::write::{self, Create, Delete, Op, Update};
use crate::app::edges::{self, ItemListing, Listing, Reach};
use crate::app::items::bulk::rollback;
use crate::app::items::write::ruled;
use crate::app::refusal::{Refusal, Result};
use crate::app::types::missing_field;

const CREATE_FIELDS: [&str; 5] = ["id", "source_id", "target_id", "edge_type", "properties"];
const UPDATE_FIELDS: [&str; 4] = ["version", "source_id", "target_id", "properties"];
const PAGE_FIELDS: [&str; 4] = ["edges", "atomic", "mode", "enable_fanout"];
const ENTRY_FIELDS: [&str; 6] = [
    "id",
    "source_id",
    "target_id",
    "edge_type",
    "properties",
    "version",
];
const LIST_PARAMETERS: [&str; 5] = [
    "edge_type",
    "updated_after",
    "updated_before",
    "cursor",
    "limit",
];
const ITEM_PARAMETERS: [&str; 3] = ["edge_type", "cursor", "limit"];
const SOURCE_VERSION: [&str; 1] = ["source_version"];
const MAX_ENTRIES: usize = 5000;
const MAX_EDGE_TYPES: usize = 10;
const MAX_LIMIT: i64 = 500;
const DEFAULT_LIMIT: i64 = 100;

fn required(sent: &Map<String, Value>, field: &str) -> Result<String> {
    match text_of(sent, field)? {
        Some(text) if !text.is_empty() => Ok(text),
        _ => Err(missing_field(field)),
    }
}

fn check_edge_id(field: &str, id: &str) -> Result<()> {
    validation::id(field, id).map_err(ruled)
}

fn source_version_of(uri: &Uri) -> Result<Option<i64>> {
    query::only(uri, &SOURCE_VERSION)?;
    let named = query::pairs(uri)?
        .into_iter()
        .find(|(name, _)| name == "source_version");
    named
        .map(|(_, value)| {
            value
                .parse::<i64>()
                .ok()
                .filter(|version| *version >= 0)
                .ok_or_else(|| {
                    invalid_field(
                        "source_version",
                        "source_version must be a whole number of 0 or more.",
                    )
                })
        })
        .transpose()
}

fn create_of(body: &ReadBody, uri: &Uri) -> Result<Op> {
    let source_version = source_version_of(uri)?;
    let sent = body.object(Bag::Properties)?;
    for field in ["source_id", "target_id", "edge_type"] {
        if !sent.contains_key(field) {
            return Err(missing_field(field));
        }
    }
    let mut sent = only_declared(sent, &CREATE_FIELDS)?;
    body.refuse_inexact_numbers(Bag::Properties)?;
    let properties = properties_of(&mut sent)?.unwrap_or_default();
    let (source_id, target_id) = (required(&sent, "source_id")?, required(&sent, "target_id")?);
    let edge_type = required(&sent, "edge_type")?;
    let id = text_of(&sent, "id")?;
    check_edge_id("source_id", &source_id)?;
    check_edge_id("target_id", &target_id)?;
    if let Some(id) = &id {
        check_edge_id("id", id)?;
    }
    Ok(Op::Create(Create {
        id,
        source_id,
        target_id,
        edge_type,
        properties,
        source_version,
    }))
}

pub async fn create(State(app): State<Arc<App>>, caller: Caller, sent: Sent) -> Answer {
    caller.require_reach()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, body| async move {
        write::run(&door, &who, claim, create_of(&body, &uri)?).await
    })
    .await
}

fn update_of(id: String, body: &ReadBody) -> Result<Op> {
    let sent = body.object(Bag::Properties)?;
    if !sent.contains_key("version") {
        return Err(missing_field("version"));
    }
    let mut sent = only_declared(sent, &UPDATE_FIELDS)?;
    body.refuse_inexact_numbers(Bag::Properties)?;
    let Some(version) = version_of(&sent)? else {
        return Err(missing_field("version"));
    };
    let properties = properties_of(&mut sent)?;
    Ok(Op::Update(Update {
        id,
        version,
        source_id: text_of(&sent, "source_id")?,
        target_id: text_of(&sent, "target_id")?,
        properties,
    }))
}

pub async fn update(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    caller.require_reach()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, _, body| async move {
        write::run(&door, &who, claim, update_of(id, &body)?).await
    })
    .await
}

pub async fn delete(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    sent: Sent,
) -> Answer {
    caller.require_reach()?;
    let (door, who) = (app.clone(), caller.clone());
    keyed(&app, &caller, sent, |claim, uri, _| async move {
        let source_version = source_version_of(&uri)?;
        write::run(
            &door,
            &who,
            claim,
            Op::Delete(Delete { id, source_version }),
        )
        .await
    })
    .await
}

pub async fn read(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    query::only(&uri, &[])?;
    let answer = edges::get(&app, &caller, id).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn edge_types_of(pairs: &[(String, String)]) -> Result<Vec<String>> {
    let named: Vec<String> = pairs
        .iter()
        .filter(|(name, _)| name == "edge_type")
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    if named.len() > MAX_EDGE_TYPES {
        return Err(invalid_field(
            "edge_type",
            format!("edge_type names at most {MAX_EDGE_TYPES} edge types."),
        ));
    }
    Ok(named)
}

fn limit_of(pairs: &[(String, String)]) -> Result<i64> {
    let Some((_, value)) = pairs.iter().find(|(name, _)| name == "limit") else {
        return Ok(DEFAULT_LIMIT);
    };
    value
        .parse::<i64>()
        .ok()
        .filter(|limit| *limit >= 1)
        .map(|limit| limit.min(MAX_LIMIT))
        .ok_or_else(|| invalid_field("limit", "limit must be a whole number of 1 or more."))
}

fn named(pairs: &[(String, String)], parameter: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(name, _)| name == parameter)
        .map(|(_, value)| value.clone())
}

fn moment_of(pairs: &[(String, String)], parameter: &str) -> Result<Option<String>> {
    named(pairs, parameter)
        .map(|value| time::normalize_bound(&value, parameter).map_err(ruled))
        .transpose()
}

pub async fn list(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    query::only(&uri, &LIST_PARAMETERS)?;
    let pairs = query::pairs(&uri)?;
    let listing = Listing {
        edge_types: edge_types_of(&pairs)?,
        updated_after: moment_of(&pairs, "updated_after")?,
        updated_before: moment_of(&pairs, "updated_before")?,
        cursor: named(&pairs, "cursor"),
        limit: limit_of(&pairs)?,
    };
    let answer = edges::list(&app, &caller, listing).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

fn item_listing_of(uri: &Uri) -> Result<ItemListing> {
    query::only(uri, &ITEM_PARAMETERS)?;
    let pairs = query::pairs(uri)?;
    Ok(ItemListing {
        edge_types: edge_types_of(&pairs)?,
        cursor: named(&pairs, "cursor"),
        limit: limit_of(&pairs)?,
    })
}

async fn of_item(app: &App, caller: &Caller, id: String, uri: &Uri, reach: Reach) -> Answer {
    check_item_id(&id)?;
    let listing = item_listing_of(uri)?;
    let answer = edges::of_item(app, caller, id, reach, listing).await?;
    Ok(text_answer(StatusCode::OK, answer))
}

pub async fn outbound(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    of_item(&app, &caller, id, &uri, Reach::Outbound).await
}

pub async fn backrefs(
    State(app): State<Arc<App>>,
    caller: Caller,
    Named(id): Named<String>,
    uri: Uri,
) -> Answer {
    of_item(&app, &caller, id, &uri, Reach::Inbound).await
}

fn declared_entry(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(entry) => only_declared(entry, &ENTRY_FIELDS),
        _ => Err(Refusal::validation("An entry must be an object.")),
    }
}

fn entry_of(mut sent: Map<String, Value>) -> Result<Entry> {
    let properties = properties_of(&mut sent)?;
    Ok(Entry {
        id: text_of(&sent, "id")?,
        source_id: required(&sent, "source_id")?,
        target_id: required(&sent, "target_id")?,
        edge_type: required(&sent, "edge_type")?,
        properties,
        version: version_of(&sent)?,
    })
}

fn asked_of(body: &ReadBody) -> Result<Asked> {
    let mut sent = only_declared(body.object(Bag::Entries("edges"))?, &PAGE_FIELDS)?;
    body.refuse_inexact_numbers(Bag::Entries("edges"))?;
    let create_only = match text_of(&sent, "mode")?.as_deref() {
        None | Some("upsert") => false,
        Some("create_only") => true,
        Some(_) => return Err(invalid_field("mode", "mode is upsert or create_only.")),
    };
    let atomic = match sent.get("atomic") {
        None => true,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(invalid_field("atomic", "atomic must be a boolean.")),
    };
    let fanout = match sent.get("enable_fanout") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            return Err(invalid_field(
                "enable_fanout",
                "enable_fanout must be a boolean.",
            ));
        }
    };
    let entries = match sent.remove("edges") {
        None => return Err(missing_field("edges")),
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err(invalid_field("edges", "edges must be a list.")),
    };
    if entries.len() > MAX_ENTRIES {
        return Err(
            Refusal::validation(format!("Maximum {MAX_ENTRIES} edges per call"))
                .with_detail("cap", MAX_ENTRIES)
                .with_detail("provided", entries.len()),
        );
    }
    let declared: Vec<_> = entries.into_iter().map(declared_entry).collect();
    if atomic
        && let Some((index, Err(refusal))) = declared
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.is_err())
    {
        return Err(rollback(index, refusal));
    }
    Ok(Asked {
        entries: declared
            .into_iter()
            .map(|entry| entry.and_then(entry_of))
            .collect(),
        create_only,
        atomic,
        fanout,
    })
}

pub async fn write_page(State(app): State<Arc<App>>, caller: Caller, body: JsonBody) -> Answer {
    caller.require_reach()?;
    let sent = body.read().await?;
    let asked = asked_of(&sent)?;
    let answer = bulk::write(&app, &caller, asked).await?;
    Ok(text_answer(StatusCode::OK, answer))
}
