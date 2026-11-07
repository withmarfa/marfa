//! `POST /items/bulk`: a page of entries, each written by the same function
//! `POST /items` uses. Under `atomic: true` the page is one transaction and
//! one refused entry rolls it all back. Under `atomic: false` each entry is
//! its own transaction, and the writer is free to others between entries.

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use serde_json::{Map, Value, json};

use super::items::{no_content_map, read_create};
use crate::app::App;
use crate::auth::Caller;
use crate::body::JsonBody;
use crate::error::{ApiError, ApiResult};
use crate::write::{self, Actor, Door, ItemWrite, Outcome, Written};
use rusqlite::TransactionBehavior;

const PAGE_CAP: usize = 5000;
const BODY_CAP: usize = 16 * 1024 * 1024;
const PAGE_FIELDS: [&str; 5] = ["items", "mode", "atomic", "enable_fanout", "retype"];
const ENTRY_FIELDS: [&str; 12] = [
    "type",
    "properties",
    "properties_mode",
    "id",
    "state",
    "tier",
    "occurred_at",
    "source",
    "source_id",
    "version",
    "tags",
    "edges",
];

pub fn router() -> Router<App> {
    Router::new().route("/items/bulk", post(bulk))
}

struct Page {
    entries: Vec<Value>,
    door: Door,
    atomic: bool,
}

/// One entry's place in the answer.
struct Entry {
    outcome: &'static str,
    value: Value,
}

async fn bulk(
    State(app): State<App>,
    caller: Caller,
    body: JsonBody,
) -> ApiResult<axum::Json<Value>> {
    if caller.key().is_some_and(|key| key.maps.types.is_empty()) {
        return Err(no_content_map());
    }
    let body = body.object_within(&PAGE_FIELDS, BODY_CAP).await?;
    let page = read_page(&body)?;
    if page.entries.is_empty() {
        return Ok(axum::Json(answer(&[])));
    }
    let operation_id = uuid::Uuid::now_v7().to_string();
    let entries = if page.atomic {
        atomic(&app, &caller, &page, &operation_id).await?
    } else {
        best_effort(&app, &caller, &page, &operation_id).await?
    };
    Ok(axum::Json(answer(&entries)))
}

fn read_page(body: &Map<String, Value>) -> ApiResult<Page> {
    let entries = match body.get("items") {
        None | Some(Value::Null) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "missing_required_field",
                "items: Required field is missing.",
            )
            .with(json!({ "field": "items" })));
        }
        Some(Value::Array(entries)) => entries.clone(),
        Some(_) => return Err(ApiError::field("items", "Must be an array.")),
    };
    if entries.len() > PAGE_CAP {
        return Err(
            ApiError::validation(format!("Maximum {PAGE_CAP} items per call"))
                .with(json!({ "cap": PAGE_CAP, "provided": entries.len() })),
        );
    }
    let door = match body.get("mode") {
        None | Some(Value::Null) => Door::BulkUpsert,
        Some(Value::String(mode)) if mode == "upsert" => Door::BulkUpsert,
        Some(Value::String(mode)) if mode == "create_only" => Door::BulkCreateOnly,
        Some(_) => return Err(ApiError::field("mode", "Must be upsert or create_only.")),
    };
    let flag = |field: &str, default: bool| match body.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(ApiError::field(field, "Must be true or false.")),
    };
    let atomic = flag("atomic", true)?;
    // No webhooks are delivered by this server, so there is nothing to fan out.
    flag("enable_fanout", false)?;
    if flag("retype", false)? {
        return Err(ApiError::field(
            "retype",
            "This server does not move an item to another type yet.",
        ));
    }
    Ok(Page {
        entries,
        door,
        atomic,
    })
}

/// The keys an entry sends that the operation does not declare.
fn undeclared(raw: &Value) -> Option<ApiError> {
    let map = raw.as_object()?;
    let mut unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| !ENTRY_FIELDS.contains(key))
        .collect();
    if unknown.is_empty() {
        return None;
    }
    unknown.sort_unstable();
    Some(
        ApiError::validation(format!(
            "The entry names fields this operation does not take: {}.",
            unknown.join(", ")
        ))
        .with(json!({ "unknown_body_fields": unknown })),
    )
}

fn read_entry(raw: &Value, door: Door) -> ApiResult<ItemWrite> {
    let Some(map) = raw.as_object() else {
        return Err(ApiError::validation("Each entry must be an object."));
    };
    if let Some(refusal) = undeclared(raw) {
        return Err(refusal);
    }
    let replace = match map.get("properties_mode") {
        None | Some(Value::Null) => false,
        Some(Value::String(mode)) if mode == "merge" => false,
        Some(Value::String(mode)) if mode == "replace" => true,
        Some(_) => {
            return Err(ApiError::field(
                "properties_mode",
                "Must be merge or replace.",
            ));
        }
    };
    let mut write = read_create(map)?;
    write.door = door;
    write.replace = replace;
    Ok(write)
}

fn prepared(app: &App, caller: &Caller, raw: &Value, door: Door) -> ApiResult<write::Prepared> {
    write::prepare(app, caller, read_entry(raw, door)?)
}

async fn atomic(
    app: &App,
    caller: &Caller,
    page: &Page,
    operation_id: &str,
) -> ApiResult<Vec<Entry>> {
    // The shape of every entry is judged before anything an entry names.
    if let Some((index, refusal)) = page
        .entries
        .iter()
        .enumerate()
        .find_map(|(index, raw)| undeclared(raw).map(|refusal| (index, refusal)))
    {
        return Err(rollback(index, refusal));
    }
    let mut ready = Vec::with_capacity(page.entries.len());
    for (index, raw) in page.entries.iter().enumerate() {
        ready.push(prepared(app, caller, raw, page.door).map_err(|error| rollback(index, error))?);
    }
    let catalog = app.catalog.clone();
    let actor = write::actor_of(caller);
    let operation_id = operation_id.to_string();
    let mode = mode_word(page.door);
    app.db
        .write(move |conn| {
            let total = ready.len();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut entries = Vec::with_capacity(total);
            for (index, item) in ready.into_iter().enumerate() {
                let written = match write::commit(&tx, &catalog, item, &actor) {
                    Ok(written) => written,
                    Err(error) if error.status == StatusCode::UNAUTHORIZED => return Err(error),
                    Err(error) if error.status.is_client_error() => {
                        return Err(rollback(index, error));
                    }
                    Err(error) => return Err(error),
                };
                entries.push(entry(index, &written)?);
            }
            let counts = counts(&entries);
            write::audit(
                &tx,
                "items.bulk",
                &actor.id,
                "items.bulk",
                &operation_id,
                json!({
                    "operation_id": operation_id,
                    "mode": mode,
                    "atomic": true,
                    "total": total,
                    "created": counts["created"],
                    "updated": counts["updated"],
                    "skipped": counts["skipped"],
                    "errored": counts["errored"],
                }),
            )?;
            tx.commit()?;
            Ok(entries)
        })
        .await
}

async fn best_effort(
    app: &App,
    caller: &Caller,
    page: &Page,
    operation_id: &str,
) -> ApiResult<Vec<Entry>> {
    let actor = write::actor_of(caller);
    let mode = mode_word(page.door);
    let total = page.entries.len();
    let mut entries = Vec::with_capacity(total);
    let mut wrote = false;
    for (index, raw) in page.entries.iter().enumerate() {
        if index > 0 {
            tokio::task::yield_now().await;
        }
        let item = match prepared(app, caller, raw, page.door) {
            Ok(item) => item,
            Err(error) => {
                entries.push(errored(index, &error, None));
                continue;
            }
        };
        let catalog = app.catalog.clone();
        let actor = Actor {
            id: actor.id.clone(),
            key_id: actor.key_id.clone(),
        };
        let operation_id = operation_id.to_string();
        let written = app
            .db
            .write(move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let written = write::commit(&tx, &catalog, item, &actor)?;
                let entry = entry(index, &written)?;
                if matches!(entry.outcome, "created" | "updated") {
                    write::audit(
                        &tx,
                        "items.bulk",
                        &actor.id,
                        "items.bulk",
                        &written.item.id,
                        json!({
                            "operation_id": operation_id,
                            "mode": mode,
                            "atomic": false,
                            "total": total,
                            "index": index,
                            "outcome": entry.outcome,
                        }),
                    )?;
                }
                tx.commit()?;
                Ok(entry)
            })
            .await;
        match written {
            Ok(entry) => {
                wrote |= matches!(entry.outcome, "created" | "updated");
                entries.push(entry);
            }
            Err(error)
                if error.status.is_client_error()
                    && (wrote || error.status != StatusCode::UNAUTHORIZED) =>
            {
                entries.push(errored(index, &error, None));
            }
            Err(error) if !wrote => return Err(error),
            Err(error) => {
                entries.push(errored(
                    index,
                    &error,
                    Some(json!({ "write_outcome": "unknown" })),
                ));
            }
        }
    }
    Ok(entries)
}

fn mode_word(door: Door) -> &'static str {
    if door == Door::BulkCreateOnly {
        "create_only"
    } else {
        "upsert"
    }
}

/// The refusal an atomic page answers with, at the status of the entry's own.
fn rollback(index: usize, inner: ApiError) -> ApiError {
    let status = if inner.status.is_client_error() {
        inner.status
    } else {
        StatusCode::BAD_REQUEST
    };
    let mut details = json!({ "index": index, "code": inner.code, "message": inner.message });
    if let Some(inner_details) = inner.details {
        details["details"] = inner_details;
    }
    ApiError::new(
        status,
        "bulk_atomic_rollback",
        format!("Bulk upsert rolled back on item {index}"),
    )
    .with(details)
}

fn entry(index: usize, written: &Written) -> ApiResult<Entry> {
    let id = &written.item.id;
    let (outcome, value) = match &written.outcome {
        Outcome::Created => (
            "created",
            json!({ "index": index, "outcome": "created", "id": id }),
        ),
        Outcome::Updated => (
            "updated",
            json!({ "index": index, "outcome": "updated", "id": id }),
        ),
        Outcome::Skipped { reason, disclosed } => {
            let mut value = json!({ "index": index, "outcome": "skipped", "reason": reason });
            if *disclosed {
                value["id"] = id.clone().into();
            }
            ("skipped", value)
        }
        Outcome::Acknowledged => {
            return Err(ApiError::internal("a bulk entry was acknowledged"));
        }
    };
    Ok(Entry { outcome, value })
}

fn errored(index: usize, error: &ApiError, extra: Option<Value>) -> Entry {
    let mut refusal = json!({ "code": error.code, "message": error.message });
    let details = match (&error.details, extra) {
        (Some(Value::Object(held)), Some(Value::Object(extra))) => {
            let mut merged = held.clone();
            merged.extend(extra);
            Some(Value::Object(merged))
        }
        (_, Some(extra)) => Some(extra),
        (held, None) => held.clone(),
    };
    if let Some(details) = details {
        refusal["details"] = details;
    }
    Entry {
        outcome: "errored",
        value: json!({ "index": index, "outcome": "errored", "error": refusal }),
    }
}

fn counts(entries: &[Entry]) -> Value {
    let count = |outcome: &str| entries.iter().filter(|e| e.outcome == outcome).count();
    json!({
        "created": count("created"),
        "updated": count("updated"),
        "skipped": count("skipped"),
        "errored": count("errored"),
    })
}

fn answer(entries: &[Entry]) -> Value {
    json!({
        "counts": counts(entries),
        "results": entries.iter().map(|e| e.value.clone()).collect::<Vec<_>>(),
    })
}
