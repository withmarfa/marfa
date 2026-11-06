//! The one function every item write goes through. A write is judged by the
//! core's rules, then written in one transaction: the item row, its version,
//! an event, an audit entry, its tags and its search row.

use axum::http::StatusCode;
use marfa_core::server::{self as core, Catalog};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::auth::{Caller, Level};
use crate::clock;
use crate::error::{ApiError, ApiResult};
use crate::storage::items::{self, ItemRow};

/// The version of the item shape this server writes.
const SCHEMA_VERSION: i64 = 1;
/// The source the local command writes under when it names none.
const LOCAL_SOURCE: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Upsert,
    CreateOnly,
}

/// A create or upsert, as `POST /items` names it.
#[derive(Debug, Clone)]
pub struct ItemWrite {
    pub type_id: String,
    pub properties: Map<String, Value>,
    pub id: Option<String>,
    pub state: Option<String>,
    pub occurred_at: Option<String>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub mode: Mode,
    pub tier: Option<String>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    pub tags: Vec<String>,
}

pub enum Outcome {
    Created,
    Updated,
    /// The write was already made; nothing changed and no event was written.
    Acknowledged,
}

pub struct Written {
    pub outcome: Outcome,
    pub item: ItemRow,
    pub tags: Vec<String>,
}

impl Written {
    pub fn status(&self) -> StatusCode {
        match self.outcome {
            Outcome::Created => StatusCode::CREATED,
            Outcome::Updated | Outcome::Acknowledged => StatusCode::OK,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut answer = json!({
            "item": self.item.to_json(),
            "metadata": items::metadata(&self.item.id, &self.tags),
        });
        if matches!(self.outcome, Outcome::Acknowledged) {
            answer["acknowledged"] = true.into();
        }
        answer
    }
}

/// Who made a write, as the log and audit rows record it.
struct Actor {
    id: String,
    key_id: Option<String>,
}

pub async fn write_item(app: &App, caller: &Caller, write: ItemWrite) -> ApiResult<Written> {
    if write.type_id.starts_with("system.") {
        return Err(type_refused(&write.type_id));
    }
    caller.require_type(&write.type_id, Level::Write)?;
    let source = stamped_source(caller, write.source.as_deref())?;
    let tier = write
        .tier
        .clone()
        .or_else(|| caller.key().map(|key| key.default_tier.clone()))
        .unwrap_or_else(|| "library".into());

    let catalog = app.catalog.clone();
    if !catalog.known(&write.type_id) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unknown_type",
            format!("No type {} is registered.", write.type_id),
        ));
    }
    core::validate_property_names(&write.properties)?;
    core::validate_tags(&write.tags)?;
    let properties = judged(&catalog, &write.type_id, &write.properties)?;

    let readable = readable_types(caller);
    let actor = Actor {
        id: caller
            .key()
            .map_or_else(|| "local".to_string(), |key| key.id.clone()),
        key_id: caller.key().map(|key| key.id.clone()),
    };
    app.db
        .write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let written = write_in(
                &tx, &catalog, &write, &source, &tier, properties, &readable, &actor,
            )?;
            tx.commit()?;
            Ok(written)
        })
        .await
}

/// Which types the caller may read, asked inside the transaction where the
/// caller itself cannot go.
fn readable_types(caller: &Caller) -> impl Fn(&str) -> bool + Send + 'static {
    let map = caller.key().map(|key| key.maps.types.clone());
    move |type_id| match &map {
        None => true,
        Some(map) => crate::auth::type_level(map, type_id) >= Level::Read,
    }
}

#[allow(clippy::too_many_arguments)]
fn write_in(
    tx: &Connection,
    catalog: &Catalog,
    write: &ItemWrite,
    source: &str,
    tier: &str,
    properties: Map<String, Value>,
    readable: &dyn Fn(&str) -> bool,
    actor: &Actor,
) -> ApiResult<Written> {
    // A natural key that resolves an item decides the write before an id.
    if let Some(source_id) = &write.source_id
        && let Some(held) = items::by_natural_key(tx, source, source_id)?
    {
        if held.type_id != write.type_id {
            return Err(ApiError::conflict(
                "type_mismatch",
                format!(
                    "The source and source_id name an item of type {}, not {}.",
                    held.type_id, write.type_id
                ),
            ));
        }
        if write.mode == Mode::CreateOnly {
            return Err(item_exists(&held.id, "source_id"));
        }
        if !held.is_live() {
            return acknowledged(tx, held);
        }
        return upsert(tx, catalog, write, held, properties, actor);
    }

    if let Some(id) = &write.id
        && let Some(held) = items::by_id(tx, id)?
    {
        if !readable(&held.type_id) {
            return Err(ApiError::conflict(
                "conflict",
                "An item this credential cannot read already has this id.",
            ));
        }
        if write.mode == Mode::CreateOnly {
            return Err(item_exists(&held.id, "id"));
        }
        if held.type_id != write.type_id {
            return Err(ApiError::conflict(
                "id_reused",
                format!("The item {id} already exists as another type."),
            )
            .with(json!({ "differs": ["type"] })));
        }
        return acknowledged(tx, held);
    }

    create(tx, catalog, write, source, tier, properties, actor)
}

fn item_exists(existing_id: &str, matched_by: &str) -> ApiError {
    ApiError::conflict("item_exists", "The item this create names already exists.")
        .with(json!({ "existing_id": existing_id, "matched_by": matched_by }))
}

fn acknowledged(tx: &Connection, item: ItemRow) -> ApiResult<Written> {
    let tags = items::tags(tx, &item.id)?;
    Ok(Written {
        outcome: Outcome::Acknowledged,
        item,
        tags,
    })
}

fn create(
    tx: &Connection,
    catalog: &Catalog,
    write: &ItemWrite,
    source: &str,
    tier: &str,
    properties: Map<String, Value>,
    actor: &Actor,
) -> ApiResult<Written> {
    let now = clock::now_stamp();
    let mut item = ItemRow {
        seq: 0,
        id: write
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
        type_id: write.type_id.clone(),
        state: write.state.clone().unwrap_or_else(|| "active".into()),
        tier: Some(tier.to_string()),
        version: 1,
        schema_version: SCHEMA_VERSION,
        source: source.to_string(),
        source_id: write.source_id.clone(),
        occurred_at: write.occurred_at.clone().unwrap_or_else(|| now.clone()),
        created_at: now.clone(),
        updated_at: now,
        properties,
        capture_latitude: write.capture_latitude,
        capture_longitude: write.capture_longitude,
        trashed_at: None,
    };
    item.seq = items::insert(tx, &item)?;
    items::add_tags(tx, &item.id, &write.tags)?;
    let tags = items::tags(tx, &item.id)?;
    record(tx, catalog, &item, &tags, "item.created", actor)?;
    Ok(Written {
        outcome: Outcome::Created,
        item,
        tags,
    })
}

/// A write naming a live item's natural key merges its properties into the
/// item at the next version.
fn upsert(
    tx: &Connection,
    catalog: &Catalog,
    write: &ItemWrite,
    mut item: ItemRow,
    properties: Map<String, Value>,
    actor: &Actor,
) -> ApiResult<Written> {
    let mut merged = item.properties.clone();
    for (name, value) in properties {
        merged.insert(name, value);
    }
    catalog.validate_properties(&item.type_id, &merged, true)?;
    item.properties = catalog.in_answer_order(&item.type_id, &merged);
    item.version += 1;
    item.updated_at = clock::now_stamp();
    if let Some(occurred_at) = &write.occurred_at {
        item.occurred_at = occurred_at.clone();
    }
    if let Some(tier) = &write.tier {
        item.tier = Some(tier.clone());
    }
    if write.capture_latitude.is_some() {
        item.capture_latitude = write.capture_latitude;
        item.capture_longitude = write.capture_longitude;
    }
    items::update(tx, &item)?;
    items::add_tags(tx, &item.id, &write.tags)?;
    let tags = items::tags(tx, &item.id)?;
    record(tx, catalog, &item, &tags, "item.updated", actor)?;
    Ok(Written {
        outcome: Outcome::Updated,
        item,
        tags,
    })
}

/// What every change to an item writes beside the row: its version, an
/// event, an audit entry and its search row.
fn record(
    tx: &Connection,
    catalog: &Catalog,
    item: &ItemRow,
    tags: &[String],
    event: &str,
    actor: &Actor,
) -> ApiResult<()> {
    let snapshot = item.to_json();
    let now = clock::now_stamp();
    tx.prepare_cached(
        "INSERT INTO item_versions (item_id, version, item, tags, key_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?
    .execute(params![
        item.id,
        item.version,
        snapshot.to_string(),
        json!(tags).to_string(),
        actor.key_id,
        now
    ])?;
    tx.prepare_cached(
        "INSERT INTO event_log (event, entity_id, item_type, version, source, key_id, payload,
           created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        event,
        item.id,
        item.type_id,
        item.version,
        item.source,
        actor.key_id,
        json!({ "item": snapshot, "tags": tags }).to_string(),
        now
    ])?;
    audit(
        tx,
        event,
        &actor.id,
        "item",
        &item.id,
        json!({ "type": item.type_id, "version": item.version }),
    )?;
    core::index_item(
        tx,
        catalog,
        item.seq,
        &item.id,
        &item.type_id,
        &item.state,
        &item.properties,
    )?;
    Ok(())
}

pub fn audit(
    conn: &Connection,
    action: &str,
    actor: &str,
    target_kind: &str,
    target_id: &str,
    details: Value,
) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO audit_log (action, actor, target_kind, target_id, details, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?
    .execute(params![
        action,
        actor,
        target_kind,
        target_id,
        details.to_string(),
        clock::now_stamp()
    ])?;
    Ok(())
}

/// A create's properties as the core keeps them: optional nulls dropped,
/// URLs trimmed, judged against the type, in the order the server answers.
fn judged(
    catalog: &Catalog,
    type_id: &str,
    properties: &Map<String, Value>,
) -> ApiResult<Map<String, Value>> {
    let created = catalog.created_properties(type_id, properties);
    let coerced = catalog.coerced_properties(type_id, &created);
    catalog
        .validate_properties(type_id, &coerced, true)
        .map_err(field_errors)?;
    Ok(catalog.in_answer_order(type_id, &coerced))
}

/// The core names each refused field only in its message, as
/// `name: reason; name: reason`; the contract asks for them in
/// `details.errors[].field`.
fn field_errors(error: marfa_core::CoreError) -> ApiError {
    let mut refusal = ApiError::from(error);
    if refusal.code == "invalid_properties" && refusal.details.is_none() {
        let errors: Vec<Value> = refusal
            .message
            .split("; ")
            .map(|part| match part.split_once(": ") {
                Some((field, message)) => json!({ "field": field, "message": message }),
                None => json!({ "field": "", "message": part }),
            })
            .collect();
        refusal.details = Some(json!({ "errors": errors }));
    }
    refusal
}

fn stamped_source(caller: &Caller, named: Option<&str>) -> ApiResult<String> {
    let Some(key) = caller.key() else {
        return Ok(named.unwrap_or(LOCAL_SOURCE).to_string());
    };
    match named {
        None => Ok(key.source.clone()),
        Some(named) if named == key.source || key.sources.iter().any(|claim| claim == named) => {
            Ok(named.to_string())
        }
        Some(named) => Err(ApiError::forbidden(format!(
            "This key may not write under the source \"{named}\"."
        ))
        .with(json!({ "source": named }))),
    }
}

fn type_refused(type_id: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "type_not_permitted",
        format!("Items of type {type_id} are written only through their own operation."),
    )
    .with(json!({ "grant": { "kind": "type", "name": type_id, "level": "write" } }))
}
