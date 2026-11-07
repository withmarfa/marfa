//! The one write every item door goes through: `POST /items` and each entry
//! of `POST /items/bulk`. A write is judged by the core's rules, then written
//! in one transaction: the item row, its tags, its title key, its search
//! rows and an event, with a version row beside an update. The caller adds
//! the audit entry, one for a single write and one for each entry or page of
//! a bulk write.

use axum::http::StatusCode;
use marfa_core::server::{self as core, Catalog};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::auth::{Caller, Level};
use crate::clock;
use crate::error::{ApiError, ApiResult};
use crate::storage::items::{self, ItemRow};
use crate::storage::keys;

/// The version of the item shape this server writes.
const SCHEMA_VERSION: i64 = 1;
/// The source the local command writes under when it names none.
const LOCAL_SOURCE: &str = "local";

/// Which door a write came through, which decides how it meets an item that
/// already holds its natural key or id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Door {
    Item,
    ItemCreateOnly,
    BulkUpsert,
    BulkCreateOnly,
}

impl Door {
    fn bulk(self) -> bool {
        matches!(self, Door::BulkUpsert | Door::BulkCreateOnly)
    }
}

/// A create or upsert, as `POST /items` or a bulk entry names it.
#[derive(Debug, Clone)]
pub struct ItemWrite {
    pub type_id: String,
    pub properties: Map<String, Value>,
    /// Whether `properties` replace an existing item's, not merge into them.
    pub replace: bool,
    pub id: Option<String>,
    pub state: Option<String>,
    pub occurred_at: Option<String>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub door: Door,
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
    /// A bulk entry that wrote nothing, and why.
    Skipped {
        reason: &'static str,
        disclosed: bool,
    },
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
            _ => StatusCode::OK,
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
#[derive(Clone)]
pub struct Actor {
    pub id: String,
    pub key_id: Option<String>,
}

pub fn actor_of(caller: &Caller) -> Actor {
    Actor {
        id: caller
            .key()
            .map_or_else(|| "local".to_string(), |key| key.id.clone()),
        key_id: caller.key().map(|key| key.id.clone()),
    }
}

/// What the caller's key reaches, read inside the transaction that writes,
/// so a key revoked or narrowed since the request began is held to it.
pub struct Reach(Option<Map<String, Value>>);

impl Reach {
    fn open(conn: &Connection, actor: &Actor) -> ApiResult<Reach> {
        let Some(key_id) = &actor.key_id else {
            return Ok(Reach(None));
        };
        let key = keys::live_by_id(conn, key_id)?.ok_or_else(ApiError::unauthorized)?;
        Ok(Reach(Some(key.maps.types)))
    }

    fn level(&self, type_id: &str) -> Level {
        match &self.0 {
            None => Level::Write,
            Some(map) => crate::auth::type_level(map, type_id),
        }
    }

    fn may_read(&self, type_id: &str) -> bool {
        self.level(type_id) >= Level::Read
    }

    fn may_write(&self, type_id: &str) -> bool {
        self.level(type_id) >= Level::Write
    }

    /// Refuses a write to a type, naming the type the caller itself named.
    fn require_write(&self, type_id: &str) -> ApiResult<()> {
        if self.may_write(type_id) {
            return Ok(());
        }
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "type_not_permitted",
            format!("This credential may not write items of type {type_id}."),
        )
        .with(json!({ "grant": { "kind": "type", "name": type_id, "level": "write" } })))
    }

    /// Refuses a write to the item a natural key or id resolved, naming
    /// nothing of it.
    fn require_write_held(&self, held: &ItemRow) -> ApiResult<()> {
        if self.may_write(&held.type_id) {
            return Ok(());
        }
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "type_not_permitted",
            "This credential may not write the item this entry names.",
        ))
    }
}

/// A write that has passed every check that needs no stored row.
pub struct Prepared {
    write: ItemWrite,
    source: String,
    tier: String,
    properties: Map<String, Value>,
}

/// A new item starts active or archived. A bulk entry that resolves an item
/// ignores its state, so only an entry that can be nothing but a create is
/// asked before the item is looked up.
fn creatable_state(state: Option<&str>) -> ApiResult<()> {
    match state {
        None | Some("active" | "archived") => Ok(()),
        Some(_) => Err(ApiError::field("state", "Must be active or archived.")),
    }
}

pub fn prepare(app: &App, caller: &Caller, write: ItemWrite) -> ApiResult<Prepared> {
    if !write.door.bulk() || (write.id.is_none() && write.source_id.is_none()) {
        creatable_state(write.state.as_deref())?;
    }
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

    if !app.catalog.known(&write.type_id) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "unknown_type",
            format!("No type {} is registered.", write.type_id),
        ));
    }
    core::validate_property_names(&write.properties)?;
    core::validate_tags(&write.tags)?;
    let properties = judged(&app.catalog, &write.type_id, &write.properties)?;
    Ok(Prepared {
        write,
        source,
        tier,
        properties,
    })
}

/// `POST /items`: one write, one transaction, one audit entry.
pub async fn write_item(app: &App, caller: &Caller, write: ItemWrite) -> ApiResult<Written> {
    let prepared = prepare(app, caller, write)?;
    let catalog = app.catalog.clone();
    let actor = actor_of(caller);
    app.db
        .write(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let written = commit(&tx, &catalog, prepared, &actor)?;
            let event = match written.outcome {
                Outcome::Created => Some("item.created"),
                Outcome::Updated => Some("item.updated"),
                _ => None,
            };
            if let Some(event) = event {
                audit(
                    &tx,
                    event,
                    &actor.id,
                    "item",
                    &written.item.id,
                    json!({ "type": written.item.type_id, "version": written.item.version }),
                )?;
            }
            tx.commit()?;
            Ok(written)
        })
        .await
}

/// Writes one prepared write inside the caller's transaction.
pub fn commit(
    tx: &Connection,
    catalog: &Catalog,
    prepared: Prepared,
    actor: &Actor,
) -> ApiResult<Written> {
    let reach = Reach::open(tx, actor)?;
    reach.require_write(&prepared.write.type_id)?;
    write_in(tx, catalog, prepared, &reach, actor)
}

fn write_in(
    tx: &Connection,
    catalog: &Catalog,
    prepared: Prepared,
    reach: &Reach,
    actor: &Actor,
) -> ApiResult<Written> {
    let Prepared {
        write,
        source,
        tier,
        properties,
    } = prepared;

    // A natural key that resolves an item decides the write before an id.
    if let Some(source_id) = &write.source_id
        && let Some(held) = items::by_natural_key(tx, &source, source_id)?
    {
        match write.door {
            Door::BulkCreateOnly => {
                let disclosed = reach.may_read(&held.type_id);
                return Ok(skipped(held, "duplicate_source", disclosed));
            }
            Door::ItemCreateOnly => {
                if held.type_id != write.type_id {
                    return Err(type_mismatch(&held, &write.type_id));
                }
                return Err(item_exists(&held.id, "source_id"));
            }
            Door::Item | Door::BulkUpsert => {
                reach.require_write_held(&held)?;
                if held.type_id != write.type_id {
                    return Err(type_mismatch(&held, &write.type_id));
                }
                if !held.is_live() {
                    return unchanged(tx, held, write.door);
                }
                return upsert(tx, catalog, &write, held, properties, actor);
            }
        }
    }

    if let Some(id) = &write.id
        && let Some(held) = items::by_id(tx, id)?
    {
        match write.door {
            Door::BulkCreateOnly => return Ok(skipped(held, "duplicate_id", true)),
            Door::ItemCreateOnly => {
                if !reach.may_read(&held.type_id) {
                    return Err(unreadable_id());
                }
                return Err(item_exists(&held.id, "id"));
            }
            Door::Item => {
                if !reach.may_read(&held.type_id) {
                    return Err(unreadable_id());
                }
                if held.type_id != write.type_id {
                    return Err(id_reused(id));
                }
                return acknowledged(tx, held);
            }
            Door::BulkUpsert => {
                if !reach.may_read(&held.type_id) {
                    return Err(unreadable_id());
                }
                if held.type_id != write.type_id {
                    return Err(id_reused(id));
                }
                reach.require_write_held(&held)?;
                if !held.is_live() {
                    return Ok(skipped(held, "trashed", true));
                }
                if write.source_id.is_some() && write.source_id != held.source_id {
                    return Err(ApiError::validation(
                        "This server does not move an item's natural key yet.",
                    ));
                }
                return upsert(tx, catalog, &write, held, properties, actor);
            }
        }
    }

    create(tx, catalog, &write, &source, &tier, properties, actor)
}

fn type_mismatch(held: &ItemRow, declared: &str) -> ApiError {
    ApiError::conflict(
        "type_mismatch",
        format!(
            "The source and source_id name an item of type {}, not {declared}.",
            held.type_id
        ),
    )
    .with(json!({ "actual_type": held.type_id }))
}

fn id_reused(id: &str) -> ApiError {
    ApiError::conflict(
        "id_reused",
        format!("The item {id} already exists as another type."),
    )
    .with(json!({ "differs": ["type"] }))
}

fn unreadable_id() -> ApiError {
    ApiError::conflict(
        "conflict",
        "An item this credential cannot read already has this id.",
    )
}

fn item_exists(existing_id: &str, matched_by: &str) -> ApiError {
    ApiError::conflict("item_exists", "The item this create names already exists.")
        .with(json!({ "existing_id": existing_id, "matched_by": matched_by }))
}

fn skipped(item: ItemRow, reason: &'static str, disclosed: bool) -> Written {
    Written {
        outcome: Outcome::Skipped { reason, disclosed },
        item,
        tags: Vec::new(),
    }
}

/// A held item in the bin: a bulk entry skips it, and a single write
/// acknowledges it.
fn unchanged(tx: &Connection, held: ItemRow, door: Door) -> ApiResult<Written> {
    if door.bulk() {
        Ok(skipped(held, "trashed", true))
    } else {
        acknowledged(tx, held)
    }
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
    creatable_state(write.state.as_deref())?;
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
    items::sync_title_key(tx, catalog, &item)?;
    let tags = items::tags(tx, &item.id)?;
    record(tx, catalog, &item, &tags, "item.created", actor)?;
    Ok(Written {
        outcome: Outcome::Created,
        item,
        tags,
    })
}

/// A write naming a live item's natural key lays its properties over the
/// item's, or takes them as the whole set, at the next version.
fn upsert(
    tx: &Connection,
    catalog: &Catalog,
    write: &ItemWrite,
    mut item: ItemRow,
    properties: Map<String, Value>,
    actor: &Actor,
) -> ApiResult<Written> {
    let before = item.to_json();
    let before_tags = items::tags(tx, &item.id)?;
    let merged = if write.replace {
        properties
    } else {
        let mut merged = item.properties.clone();
        for (name, value) in properties {
            merged.insert(name, value);
        }
        merged
    };
    catalog
        .validate_properties(&item.type_id, &merged, true)
        .map_err(field_errors)?;
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
    snapshot(tx, &item.id, item.version - 1, &before, &before_tags, actor)?;
    items::add_tags(tx, &item.id, &write.tags)?;
    items::sync_title_key(tx, catalog, &item)?;
    let tags = items::tags(tx, &item.id)?;
    record(tx, catalog, &item, &tags, "item.updated", actor)?;
    Ok(Written {
        outcome: Outcome::Updated,
        item,
        tags,
    })
}

/// The row an update replaced, kept as its version.
fn snapshot(
    tx: &Connection,
    id: &str,
    version: i64,
    before: &Value,
    tags: &[String],
    actor: &Actor,
) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO item_versions (item_id, version, item, tags, key_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?
    .execute(params![
        id,
        version,
        before.to_string(),
        json!(tags).to_string(),
        actor.key_id,
        clock::now_stamp()
    ])?;
    Ok(())
}

/// What every change to an item writes beside the row: an event and its
/// search rows.
fn record(
    tx: &Connection,
    catalog: &Catalog,
    item: &ItemRow,
    tags: &[String],
    event: &str,
    actor: &Actor,
) -> ApiResult<()> {
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
        json!({
            "event_type": event,
            "item": item.to_json(),
            "metadata": items::metadata(&item.id, tags),
        })
        .to_string(),
        clock::now_stamp()
    ])?;
    items::add_search_key(tx, item)?;
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
