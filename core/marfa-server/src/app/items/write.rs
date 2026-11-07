//! The one way an item is written. Every door describes its write as a
//! [`Change`], and [`apply`] makes each access check on the state the
//! transaction commits, writes the rows, keeps the version left behind, leaves
//! the audit entry and adds the event, all in the write's transaction.

use std::sync::Arc;

use arc_swap::ArcSwap;
use marfa_rules::conflict::{
    self, Detection, ItemFields, MergePolicy, Precondition, Stale, Strategy,
};
use marfa_rules::error::RuleError;
use marfa_rules::{js, validation};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::rows::{self, Landed, NewRow};
use super::{Item, Snapshot, Writer, is_system, metadata_for, metadata_text, parsed, title_key};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::catalog::{self, Catalog, Snapshot as Reading};
use crate::app::events::Event;
use crate::app::idempotency::{self, Claim, Need};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;

const COPY_TAG: &str = "conflicted-copy";
const RESERVED_NAMESPACES: [&str; 3] = ["core", "marfa", "system"];
const MAX_EXTENSION_UNITS: usize = 102_400;

/// What `POST /items` asks for.
#[derive(Debug, Default)]
pub struct Put {
    pub type_id: String,
    pub properties: Option<Map<String, Value>>,
    pub id: Option<String>,
    pub state: Option<String>,
    pub occurred_at: Option<String>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub create_only: bool,
    pub version: Option<i64>,
    pub tier: Option<String>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    pub tags: Option<Vec<String>>,
}

/// How a stale write that collides is settled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Settle {
    #[default]
    Refuse,
    Automatically,
}

/// What `PATCH /items/{id}` asks for.
#[derive(Debug, Default)]
pub struct Update {
    pub id: String,
    pub properties: Option<Map<String, Value>>,
    pub clear: Vec<String>,
    pub replace: bool,
    /// The type the body declares.
    pub type_id: Option<String>,
    /// Whether the declared type is where the item moves.
    pub retype: bool,
    pub version: i64,
    pub exact: bool,
    pub tier: Option<String>,
    pub occurred_at: Option<String>,
    pub source_id: Option<String>,
    pub settle: Settle,
}

/// A write to an item, by the door's description of it.
#[derive(Debug)]
pub enum Change {
    Put(Box<Put>),
    Update(Box<Update>),
    SetTags {
        id: String,
        tags: Vec<String>,
        version: Option<i64>,
    },
    AddTags {
        id: String,
        tags: Vec<String>,
        version: Option<i64>,
    },
    RemoveTag {
        id: String,
        tag: String,
        version: Option<i64>,
    },
    SetExtension {
        id: String,
        namespace: String,
        data: Map<String, Value>,
    },
    ClearExtension {
        id: String,
        namespace: String,
    },
}

impl Change {
    fn action(&self) -> &'static str {
        match self {
            Change::Put(_) => "item.create",
            Change::Update(_) => "item.update",
            Change::SetTags { .. } => "item.metadata.replace",
            Change::AddTags { .. } => "item.tag",
            Change::RemoveTag { .. } => "item.untag",
            Change::SetExtension { .. } => "extension.set",
            Change::ClearExtension { .. } => "extension.delete",
        }
    }
}

/// What a settled collision leaves: the properties to land, how it was
/// settled, and a copy this attempt wrote.
type Outcome = (Map<String, Value>, Option<Value>, Option<Item>);

/// The answer a write gives, as it would be recorded for a replay.
#[derive(Debug)]
pub struct Done {
    pub status: u16,
    pub body: String,
}

/// Runs `change` as one write. With a `claim`, the answer is recorded under it
/// in the same transaction.
pub async fn run(app: &App, caller: &Caller, claim: Option<Claim>, change: Change) -> Result<Done> {
    let cache = app.catalog_handle();
    let action = change.action();
    app.write(caller, action, move |unit| {
        let done = apply(unit, &cache, claim.as_ref(), change)?;
        if let Some(claim) = &claim {
            idempotency::complete(unit, claim, done.status, done.body.as_bytes())?;
        }
        Ok(done)
    })
    .await
}

/// The one function every item write goes through.
pub fn apply(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    claim: Option<&Claim>,
    change: Change,
) -> Result<Done> {
    let job = Job {
        unit,
        catalog: catalog::current(cache, unit.tx(), Reading::Pending)?,
        claim,
    };
    match change {
        Change::Put(put) => job.put(*put),
        Change::Update(update) => job.update(*update),
        Change::SetTags { id, tags, version } => job.set_tags(&id, tags, version),
        Change::AddTags { id, tags, version } => job.add_tags(&id, tags, version),
        Change::RemoveTag { id, tag, version } => job.remove_tag(&id, &tag, version),
        Change::SetExtension {
            id,
            namespace,
            data,
        } => job.set_extension(&id, &namespace, &data),
        Change::ClearExtension { id, namespace } => job.clear_extension(&id, &namespace),
    }
}

/// A rule's refusal, as a write answers it.
pub fn ruled(error: RuleError) -> Refusal {
    use marfa_rules::error::Code as Rule;
    let code = match error.code {
        Rule::InvalidProperties => Code::InvalidProperties,
        Rule::InvalidId => Code::InvalidId,
        Rule::UnknownType => Code::UnknownType,
        _ => Code::ValidationError,
    };
    let named_by = if code == Code::InvalidProperties {
        "field"
    } else {
        "path"
    };
    let errors: Vec<Value> = error
        .fields
        .iter()
        .map(|field| json!({ named_by: field.path, "message": field.message }))
        .collect();
    let refusal = Refusal::new(code, error.message);
    if errors.is_empty() {
        refusal
    } else {
        refusal.with_detail("errors", errors)
    }
}

fn not_found() -> Refusal {
    Refusal::new(Code::ItemNotFound, "Item not found")
}

fn distinct(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.iter()
        .filter(|tag| seen.insert(tag.as_str()))
        .cloned()
        .collect()
}

fn id_reused(row: &Item, declared: &str) -> Refusal {
    Refusal::new(
        Code::IdReused,
        format!(
            "Item id {} already names an item of type \"{}\", not \"{declared}\"",
            row.id, row.type_id
        ),
    )
    .with_detail("existing_id", row.id.as_str())
    .with_detail("differs", json!(["type"]))
    .with_detail("declared_type", declared)
    .with_detail("actual_type", row.type_id.as_str())
}

fn require_declared(declared: &str, row: &Item) -> Result<()> {
    if declared == row.type_id {
        return Ok(());
    }
    Err(Refusal::new(
        Code::TypeMismatch,
        format!(
            "Request declares type \"{declared}\" but resolves an item of type \"{}\"; a write \
             does not re-type the row it resolves.",
            row.type_id
        ),
    )
    .with_detail("item_id", row.id.as_str())
    .with_detail("declared_type", declared)
    .with_detail("actual_type", row.type_id.as_str()))
}

fn item_exists(row: &Item, by_id: bool) -> Refusal {
    Refusal::new(
        Code::ItemExists,
        format!(
            "An item already holds this {}",
            if by_id { "id" } else { "source and source id" }
        ),
    )
    .with_detail("existing_id", row.id.as_str())
    .with_detail("matched_by", if by_id { "id" } else { "source_id" })
}

fn stale_bare(row: &Item, named: i64) -> Result<Refusal> {
    Ok(Refusal::new(
        Code::VersionConflict,
        format!(
            "Version {named} is stale; current version is {0}. Re-read the item and send again \
             at version {0}.",
            row.version
        ),
    )
    .with_member("current", row.state_named()?))
}

fn no_ancestor(row: &Item, named: i64) -> Result<Refusal> {
    Ok(Refusal::new(
        Code::AncestorUnavailable,
        format!(
            "No snapshot of version {named} is available to this write, so it cannot be merged. \
             Re-read the item at version {} and re-apply the change.",
            row.version
        ),
    )
    .with_member("current", row.state_named()?)
    .with_member("requested_version", named))
}

fn collision(
    row: &Item,
    named: i64,
    ancestor: &Snapshot,
    conflicting: &[String],
    policy: &MergePolicy,
) -> Result<Refusal> {
    let listed = if conflicting.is_empty() {
        "none".to_string()
    } else {
        conflicting.join(", ")
    };
    Ok(Refusal::new(
        Code::VersionConflict,
        format!(
            "Version {named} is stale; current version is {}. Conflicting fields: {listed}.",
            row.version
        ),
    )
    .with_member("current", row.state_named()?)
    .with_member("ancestor", ancestor.state_named()?)
    .with_member("conflicting_fields", conflicting)
    .with_member("merge_policy", policy.to_json())
    .with_member("requested_version", named))
}

/// What a write to a row it resolved asks for.
#[derive(Default)]
struct Writing {
    properties: Option<Map<String, Value>>,
    clear: Vec<String>,
    replace: bool,
    destination: Option<String>,
    version: Option<i64>,
    exact: bool,
    tier: Option<String>,
    occurred_at: Option<String>,
    source_id: Option<String>,
    settle: Settle,
    tags: Option<Vec<String>>,
    /// Landing on the row is the write, whatever it carries.
    upsert: bool,
}

impl Writing {
    fn writes_row(&self) -> bool {
        self.upsert
            || self.properties.is_some()
            || !self.clear.is_empty()
            || self.tier.is_some()
            || self.occurred_at.is_some()
            || self.source_id.is_some()
            || self.destination.is_some()
    }

    fn judged(&self) -> bool {
        self.properties.is_some() || !self.clear.is_empty() || self.destination.is_some()
    }

    fn fields(&self) -> ItemFields {
        ItemFields {
            tier: self.tier.clone(),
            occurred_at: self.occurred_at.clone(),
            source_id: self.source_id.clone(),
        }
    }
}

/// What a stale write settled on, beside the properties.
struct Settled {
    properties: Map<String, Value>,
    fields: ItemFields,
    resolution: Option<Value>,
    copy: Option<Item>,
}

struct Job<'a, 't, 'c> {
    unit: &'a Unit<'t, 'c>,
    catalog: Arc<Catalog>,
    claim: Option<&'a Claim>,
}

impl Job<'_, '_, '_> {
    fn caller(&self) -> &Caller {
        &self.unit.caller
    }

    fn note(&self, need: Need) {
        if let Some(claim) = self.claim {
            claim.note(need);
        }
    }

    fn writer(&self) -> Writer {
        self.caller().writer()
    }

    /// Whether the caller may write items of `type_id` through an item door,
    /// which no caller may for a `system.*` type.
    fn type_gate(&self, type_id: &str) -> Result<()> {
        self.note(Need::Reach);
        self.caller().require_reach()?;
        self.note(Need::Type {
            name: type_id.to_string(),
            write: true,
        });
        self.caller().require_type(type_id, Level::Write)?;
        if is_system(type_id) {
            return Err(Refusal::new(
                Code::TypeNotPermitted,
                format!("Items of type \"{type_id}\" are not written through this door."),
            ));
        }
        Ok(())
    }

    /// The row a door names by id, which reads as missing where it is gone
    /// or unreadable, and says so where the caller may read it in the bin.
    fn writable_row(&self, id: &str) -> Result<Item> {
        self.note(Need::Reach);
        self.caller().require_reach()?;
        let row = rows::by_id(self.unit.tx(), id)?
            .filter(|row| self.caller().may_read_type(&row.type_id))
            .ok_or_else(not_found)?;
        if row.state == "trashed" {
            self.note(Need::Item {
                id: row.id.clone(),
                type_id: row.type_id.clone(),
                write: false,
            });
            return Err(not_found().with_detail("trashed", true));
        }
        self.row_gate(&row)?;
        Ok(row)
    }

    fn row_gate(&self, row: &Item) -> Result<()> {
        self.note(Need::Item {
            id: row.id.clone(),
            type_id: row.type_id.clone(),
            write: true,
        });
        self.type_gate(&row.type_id)
    }

    /// The source a write stands under: the one it names, which the caller
    /// must hold, or the caller's own.
    fn source_of(&self, named: Option<&str>) -> Result<String> {
        let Some(name) = named else {
            return Ok(self.caller().own_source().to_string());
        };
        self.may_write_under(name, true)?;
        Ok(name.to_string())
    }

    fn may_write_under(&self, source: &str, disclosed: bool) -> Result<()> {
        self.note(Need::Source {
            name: source.to_string(),
            disclosed,
        });
        if self.caller().may_grant(source) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!(
                "This credential may not write under the source \"{source}\". A write names its \
                 own credential's source or one that credential claims."
            ),
        )
        .with_detail("source", source))
    }

    fn refuse_unlisted_source(&self, type_id: &str, source: &str) -> Result<()> {
        let Some(allowed) = self.caller().allowed_sources(type_id) else {
            return Ok(());
        };
        if allowed.iter().any(|name| name == source) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!("Source \"{source}\" is not in the allow-list for type {type_id}"),
        )
        .with_detail("type", type_id)
        .with_detail("source", source)
        .with_detail("allowed", allowed))
    }

    fn refuse_undeclared(
        &self,
        type_id: &str,
        properties: Option<&Map<String, Value>>,
    ) -> Result<()> {
        let rules = &self.catalog.rules;
        let Some(properties) = properties else {
            return Ok(());
        };
        if !self.caller().strict_on(type_id) || !rules.known(type_id) {
            return Ok(());
        }
        let declared = rules.resolved(type_id).map_err(ruled)?;
        let errors: Vec<Value> = properties
            .keys()
            .filter(|name| !declared.contains_key(*name))
            .map(
                |name| json!({ "field": name, "message": format!("Unrecognized key: \"{name}\"") }),
            )
            .collect();
        if errors.is_empty() {
            return Ok(());
        }
        Err(Refusal::new(
            Code::InvalidProperties,
            "Unknown property: strict mode rejects properties not declared in the type schema",
        )
        .with_detail("errors", errors)
        .with_detail("code", "unknown_property"))
    }

    fn schema_version(&self, type_id: &str) -> i64 {
        self.catalog
            .types
            .get(type_id)
            .and_then(|definition| definition.get("version"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }

    /// The merge policy of `type_id`, laid root to leaf down its chain.
    fn policy_of(&self, type_id: &str) -> MergePolicy {
        let mut chain = Vec::new();
        let mut at = Some(type_id);
        while let Some(id) = at {
            if chain.contains(&id) {
                break;
            }
            chain.push(id);
            at = self.catalog.types.parent_of(id);
        }
        chain
            .into_iter()
            .rev()
            .filter_map(|id| self.catalog.types.get(id)?.get("merge_policy"))
            .fold(MergePolicy::default(), MergePolicy::laid_over_by)
    }

    fn answer(&self, status: u16, item: &Item, also: &str) -> Result<Done> {
        let tx = self.unit.tx();
        Ok(Done {
            status,
            body: format!(
                "{{\"item\":{},\"metadata\":{}{also}}}",
                item.answered(tx)?,
                metadata_for(tx, item, self.caller())?
            ),
        })
    }

    fn acknowledge(&self, row: &Item) -> Result<Done> {
        self.answer(200, row, ",\"acknowledged\":true")
    }

    fn announce(&self, event_type: &'static str, item: &Item) -> Result<()> {
        self.unit.announce(&Event {
            event_type,
            item_id: &item.id,
            type_id: &item.type_id,
            source: &item.source,
            payload: format!(
                "{{\"event_type\":\"{event_type}\",\"item\":{}}}",
                item.logged()?
            ),
        })
    }

    fn announce_metadata(&self, item: &Item) -> Result<()> {
        let tx = self.unit.tx();
        self.unit.announce(&Event {
            event_type: "metadata.changed",
            item_id: &item.id,
            type_id: &item.type_id,
            source: &item.source,
            payload: format!(
                "{{\"event_type\":\"metadata.changed\",\"item\":{},\"metadata\":{}}}",
                item.logged()?,
                metadata_text(tx, item, |_| true)?
            ),
        })
    }

    fn put(&self, put: Put) -> Result<Done> {
        let tx = self.unit.tx();
        if let Some(state) = put.state.as_deref()
            && !matches!(state, "active" | "archived" | "trashed")
        {
            return Err(Refusal::validation(format!(
                "An item cannot be created in the state \"{state}\"."
            )));
        }
        self.type_gate(&put.type_id)?;
        let source = self.source_of(put.source.as_deref())?;
        self.refuse_unlisted_source(&put.type_id, &source)?;
        if let Some(tags) = &put.tags {
            validation::tag_count(0, tags.len()).map_err(ruled)?;
        }
        if let Some(source_id) = put.source_id.as_deref()
            && let Some(row) = rows::by_natural_key(tx, &source, source_id)?
        {
            return self.on_natural_key(row, put, &source);
        }
        if let Some(id) = put.id.as_deref()
            && let Some(row) = rows::by_id(tx, id)?
        {
            if !self.caller().may_read_type(&row.type_id) {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!("Item with id={id} already exists"),
                )
                .with_detail("existing_id", id));
            }
            if put.create_only {
                return Err(item_exists(&row, true));
            }
            if row.type_id != put.type_id {
                return Err(id_reused(&row, &put.type_id));
            }
            return self.acknowledge(&row);
        }
        self.create(put, &source)
    }

    fn on_natural_key(&self, row: Item, put: Put, source: &str) -> Result<Done> {
        if !self.caller().may_read_type(&row.type_id) {
            return Err(Refusal::new(
                Code::TypeNotPermitted,
                "The natural key resolves a row of a type this credential may not reach",
            ));
        }
        if put.create_only {
            return Err(item_exists(&row, false));
        }
        self.row_gate(&row)?;
        if row.state == "trashed" {
            require_declared(&put.type_id, &row)?;
            return self.acknowledge(&row);
        }
        if let Some(id) = put.id.as_deref()
            && id != row.id
        {
            return Err(Refusal::validation(
                "Request `id` does not match the item resolved by (source, source_id)",
            )
            .with_detail("field", "id")
            .with_detail("requested_id", id)
            .with_detail("existing_id", row.id.as_str())
            .with_detail("source", source)
            .with_detail("source_id", put.source_id.as_deref()));
        }
        require_declared(&put.type_id, &row)?;
        self.change_row(
            row,
            Writing {
                properties: put.properties,
                version: put.version,
                tier: put.tier,
                occurred_at: put.occurred_at,
                source_id: put.source_id,
                tags: put.tags,
                upsert: true,
                ..Writing::default()
            },
        )
    }

    fn create(&self, put: Put, source: &str) -> Result<Done> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        self.refuse_undeclared(&put.type_id, put.properties.as_ref())?;
        if !rules.known(&put.type_id) {
            return Err(Refusal::new(
                Code::UnknownType,
                format!(
                    "Unknown type: {0}. Register it via POST /types before writing items of it.",
                    put.type_id
                ),
            )
            .with_detail("type", put.type_id.as_str()));
        }
        let sent = put.properties.unwrap_or_default();
        let properties = rules.created_properties(&put.type_id, &sent);
        rules
            .validate_properties(&put.type_id, &properties, true)
            .map_err(ruled)?;
        let properties = rules.in_answer_order(
            &put.type_id,
            &rules.coerced_properties(&put.type_id, &properties),
        );
        let id = put.id.unwrap_or_else(|| Uuid::now_v7().to_string());
        let state = put.state.as_deref().unwrap_or("active");
        let at = self.unit.at.as_str();
        let tier = put
            .tier
            .as_deref()
            .or(self.caller().default_tier())
            .unwrap_or("library");
        let writer = self.writer();
        let key = title_key(rules, &put.type_id, &properties);
        let item = rows::insert(
            tx,
            &NewRow {
                id: &id,
                type_id: &put.type_id,
                state,
                tier: Some(tier),
                source,
                source_id: put.source_id.as_deref(),
                properties: &js::canonical(&properties),
                title_key: key.as_deref(),
                schema_version: self.schema_version(&put.type_id),
                occurred_at: put.occurred_at.as_deref().unwrap_or(at),
                at,
                trashed_at: (state == "trashed").then_some(at),
                capture_latitude: put.capture_latitude,
                capture_longitude: put.capture_longitude,
                writer: &writer,
            },
        )?;
        if let Some(tags) = &put.tags {
            rows::set_tags(tx, item.seq, &distinct(tags))?;
        }
        self.unit
            .audit("item", &id, Some(json!({ "type": put.type_id })))?;
        self.announce("item.created", &item)?;
        self.answer(201, &item, "")
    }

    fn update(&self, update: Update) -> Result<Done> {
        let row = self.writable_row(&update.id)?;
        let moving = update.retype
            && update
                .type_id
                .as_deref()
                .is_some_and(|declared| declared != row.type_id);
        if moving {
            if let Some(destination) = update.type_id.as_deref() {
                self.type_gate(destination)?;
            }
        } else if let Some(declared) = update.type_id.as_deref() {
            require_declared(declared, &row)?;
        }
        self.change_row(
            row,
            Writing {
                properties: update.properties,
                clear: update.clear,
                replace: update.replace,
                destination: update.type_id.filter(|_| moving),
                version: Some(update.version),
                exact: update.exact,
                tier: update.tier,
                occurred_at: update.occurred_at,
                source_id: update.source_id,
                settle: update.settle,
                ..Writing::default()
            },
        )
    }

    /// What a write asks after the row's own gate, in the order the contract
    /// answers it, ending on the write itself.
    fn change_row(&self, row: Item, writing: Writing) -> Result<Done> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        if let Some(destination) = writing.destination.as_deref()
            && !rules.known(destination)
        {
            return Err(Refusal::new(
                Code::UnknownType,
                format!(
                    "Unknown type: {destination}. Register it via POST /types before moving \
                     items into it."
                ),
            )
            .with_detail("type", destination));
        }
        if let Some(source_id) = writing.source_id.as_deref()
            && Some(source_id) != row.source_id.as_deref()
        {
            self.may_write_under(&row.source, false)?;
            if rows::by_natural_key(tx, &row.source, source_id)?
                .is_some_and(|holder| holder.id != row.id)
            {
                return Err(Refusal::new(
                    Code::SourceIdConflict,
                    format!(
                        "source_id \"{source_id}\" is already in use under source \"{}\"",
                        row.source
                    ),
                )
                .with_detail("source", row.source.as_str())
                .with_detail("source_id", source_id));
            }
        }
        let resulting = writing
            .destination
            .clone()
            .unwrap_or_else(|| row.type_id.clone());
        self.refuse_undeclared(&resulting, writing.properties.as_ref())?;
        let unknown_row = || {
            Refusal::new(
                Code::UnknownType,
                format!(
                    "Unknown type: {0}. Register it via POST /types before writing items of it.",
                    row.type_id
                ),
            )
            .with_detail("type", row.type_id.as_str())
        };
        if writing.exact {
            if !rules.known(&row.type_id) {
                return Err(unknown_row());
            }
            if conflict::precondition(row.version, writing.version, true) == Precondition::Refused {
                return Err(stale_bare(&row, writing.version.unwrap_or(0))?);
            }
        }
        if !writing.writes_row() {
            if let Some(named) = writing.version
                && named != row.version
            {
                return Err(stale_bare(&row, named)?);
            }
            return self.answer(200, &row, "");
        }
        if !rules.known(&row.type_id) {
            return Err(unknown_row());
        }
        let settled = self.settled(&row, &resulting, &writing)?;
        let item = self.land(&row, &resulting, &settled)?;
        if let Some(tags) = &writing.tags {
            rows::set_tags(tx, item.seq, &distinct(tags))?;
        }
        let details = if writing.upsert {
            json!({
                "type": item.type_id,
                "idempotent": true,
                "source": item.source,
                "source_id": item.source_id,
            })
        } else {
            json!({ "type": item.type_id })
        };
        self.unit
            .audit_also("item.update", "item", &item.id, Some(details))?;
        if let Some(copy) = &settled.copy {
            self.announce("item.created", copy)?;
        }
        self.announce("item.updated", &item)?;
        let also = match &settled.resolution {
            Some(resolution) => format!(",\"conflict_resolution\":{resolution}"),
            None => String::new(),
        };
        self.answer(200, &item, &also)
    }

    /// What the row holds once the write lands, at its own version or merged
    /// from a stale one.
    fn settled(&self, row: &Item, resulting: &str, writing: &Writing) -> Result<Settled> {
        let rules = &self.catalog.rules;
        let current = parsed(&row.properties)?;
        let sent = writing
            .properties
            .as_ref()
            .map(|sent| rules.projected_properties(resulting, sent, writing.replace));
        if conflict::precondition(row.version, writing.version, false) == Precondition::Current {
            let mut result = match &sent {
                Some(sent) => conflict::laid_over(&current, sent, writing.replace),
                None => current.clone(),
            };
            for name in &writing.clear {
                result.shift_remove(name);
            }
            return Ok(Settled {
                properties: self.judged(row, resulting, writing, &current, result)?,
                fields: writing.fields(),
                resolution: None,
                copy: None,
            });
        }
        let named = writing.version.unwrap_or(0);
        let ancestor = rows::snapshot_at(self.unit.tx(), row.seq, named)?
            .filter(|snapshot| self.caller().may_read_type(&snapshot.type_id));
        let Some(ancestor) = ancestor else {
            return Err(no_ancestor(row, named)?);
        };
        let held = parsed(&ancestor.properties)?;
        let nothing = Map::new();
        let sent_now = sent.as_ref().unwrap_or(&nothing);
        let mut cleared: Vec<String> = Vec::new();
        if writing.replace && sent.is_some() {
            cleared.extend(
                held.keys()
                    .filter(|name| !sent_now.contains_key(*name))
                    .cloned(),
            );
        }
        cleared.extend(writing.clear.iter().cloned());
        let fields = writing.fields();
        let (current_fields, ancestor_fields) = (row.fields(), ancestor.fields());
        let stale = Stale {
            sent: sent_now,
            cleared: &cleared,
            fields: &fields,
            current: &current,
            current_fields: &current_fields,
            ancestor: &held,
            ancestor_fields: &ancestor_fields,
        };
        let detection = conflict::detect(&stale);
        let policy = self.policy_of(&row.type_id);
        if writing.destination.is_some() && row.type_id != ancestor.type_id {
            let mut conflicting = detection.conflicting.clone();
            conflicting.push("type".to_string());
            conflicting.sort();
            return Err(collision(row, named, &ancestor, &conflicting, &policy)?);
        }
        let (properties, resolution, copy) = match &detection.merged {
            Some(merged) => (merged.clone(), None, None),
            None => {
                if writing.settle != Settle::Automatically || writing.destination.is_some() {
                    return Err(collision(
                        row,
                        named,
                        &ancestor,
                        &detection.conflicting,
                        &policy,
                    )?);
                }
                self.resolved(row, named, &stale, &detection, &policy)?
            }
        };
        Ok(Settled {
            properties: self.judged(row, resulting, writing, &current, properties)?,
            fields: detection.changed_fields,
            resolution,
            copy,
        })
    }

    /// Settles a collision under `conflict=auto`, writing the copy its merge
    /// policy keeps.
    fn resolved(
        &self,
        row: &Item,
        named: i64,
        stale: &Stale<'_>,
        detection: &Detection,
        policy: &MergePolicy,
    ) -> Result<Outcome> {
        let plan = conflict::plan(stale, detection, policy);
        let strategies: Map<String, Value> = plan
            .strategies
            .iter()
            .map(|(field, strategy): (&String, &Strategy)| {
                (field.clone(), Value::from(strategy.word()))
            })
            .collect();
        let mut resolution = json!({ "fields": detection.conflicting, "strategy": strategies });
        let copy = if plan.keep_both.is_empty() {
            None
        } else {
            let copy = self.conflicted_copy(row, named, stale, &plan.keep_both)?;
            resolution["conflicted_copy_id"] = Value::from(copy.1.id.as_str());
            copy.0.then_some(copy.1)
        };
        Ok((plan.merged, Some(resolution), copy))
    }

    /// Writes the copy a stale write's losing values go to, unless this
    /// attempt wrote it already. Answers whether it is new, and the copy.
    fn conflicted_copy(
        &self,
        row: &Item,
        named: i64,
        stale: &Stale<'_>,
        keep_both: &[String],
    ) -> Result<(bool, Item)> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        let properties = conflict::copy_properties(stale, keep_both);
        let written: Map<String, Value> = properties
            .iter()
            .filter(|(name, value)| {
                stale
                    .current
                    .get(*name)
                    .is_none_or(|held| !conflict::same(value, held))
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        rules
            .validate_merged(&row.type_id, &properties, true, &written)
            .map_err(|error| self.invalid(error, None))?;
        let properties = rules.coerced_properties(&row.type_id, &properties);
        let id = match self.claim {
            Some(claim) => conflict::copy_id(&row.id, named, &claim.attempt()),
            None => Uuid::now_v7().to_string(),
        };
        if let Some(held) = rows::by_id(tx, &id)? {
            return Ok((false, held));
        }
        let at = self.unit.at.as_str();
        let writer = self.writer();
        let key = title_key(rules, &row.type_id, &properties);
        let copy = rows::insert(
            tx,
            &NewRow {
                id: &id,
                type_id: &row.type_id,
                state: "active",
                tier: row.tier.as_deref(),
                source: &row.source,
                source_id: None,
                properties: &js::canonical(&properties),
                title_key: key.as_deref(),
                schema_version: self.schema_version(&row.type_id),
                occurred_at: at,
                at,
                trashed_at: None,
                capture_latitude: None,
                capture_longitude: None,
                writer: &writer,
            },
        )?;
        let mut tags = rows::tags(tx, row.seq)?;
        tags.push(COPY_TAG.to_string());
        rows::set_tags(tx, copy.seq, &distinct(&tags))?;
        Ok((true, copy))
    }

    fn invalid(&self, error: RuleError, moved_to: Option<&str>) -> Refusal {
        if error.fields.is_empty() {
            return ruled(error);
        }
        let detail = error
            .fields
            .iter()
            .map(|field| format!("{}: {}", field.path, field.message))
            .collect::<Vec<_>>()
            .join("; ");
        let message = match moved_to {
            Some(destination) => format!("Cannot move item to \"{destination}\": {detail}"),
            None => format!("Invalid properties: {detail}"),
        };
        let mut refusal = ruled(error);
        refusal.code = Code::InvalidProperties;
        refusal.message = message.into();
        refusal
    }

    /// Holds what a write leaves to the type the row ends up as. A write that
    /// carries no property and no move is not the write that has to satisfy a
    /// type that gained a field, and a status word is judged where the write
    /// changes it or moves the row.
    fn judged(
        &self,
        row: &Item,
        resulting: &str,
        writing: &Writing,
        current: &Map<String, Value>,
        result: Map<String, Value>,
    ) -> Result<Map<String, Value>> {
        if !writing.judged() {
            return Ok(result);
        }
        let rules = &self.catalog.rules;
        let moved = resulting != row.type_id;
        let written: Map<String, Value> = if moved {
            result.clone()
        } else {
            result
                .iter()
                .filter(|(name, value)| {
                    current
                        .get(*name)
                        .is_none_or(|held| !conflict::same(value, held))
                })
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        };
        rules
            .validate_merged(resulting, &result, true, &written)
            .map_err(|error| self.invalid(error, moved.then_some(resulting)))?;
        Ok(rules.coerced_properties(resulting, &result))
    }

    /// Keeps the version the row leaves and writes the one it reaches.
    fn land(&self, row: &Item, resulting: &str, settled: &Settled) -> Result<Item> {
        let rules = &self.catalog.rules;
        let at = self.unit.at.as_str();
        let writer = self.writer();
        let key = title_key(rules, resulting, &settled.properties);
        let fields = &settled.fields;
        rows::advance(
            self.unit.tx(),
            row,
            &Uuid::now_v7().to_string(),
            &Landed {
                type_id: resulting,
                tier: fields.tier.as_deref().or(row.tier.as_deref()),
                source_id: fields.source_id.as_deref().or(row.source_id.as_deref()),
                properties: &js::canonical(&settled.properties),
                title_key: key.as_deref(),
                schema_version: self.schema_version(resulting),
                occurred_at: fields.occurred_at.as_deref().unwrap_or(&row.occurred_at),
                at,
                writer: &writer,
            },
        )
    }

    fn tag_row(&self, id: &str, version: Option<i64>) -> Result<Item> {
        let row = self.writable_row(id)?;
        if let Some(named) = version
            && named != row.version
        {
            return Err(stale_bare(&row, named)?);
        }
        Ok(row)
    }

    fn tags_landed(&self, row: &Item, details: Value) -> Result<Done> {
        let tx = self.unit.tx();
        let item = rows::touch(tx, row, &self.unit.at)?;
        self.unit.audit("item", &item.id, Some(details))?;
        self.announce_metadata(&item)?;
        Ok(Done {
            status: 200,
            body: format!(
                "{{\"metadata\":{}}}",
                metadata_for(tx, &item, self.caller())?
            ),
        })
    }

    fn set_tags(&self, id: &str, tags: Vec<String>, version: Option<i64>) -> Result<Done> {
        let tx = self.unit.tx();
        let row = self.tag_row(id, version)?;
        let tags = distinct(&tags);
        let before = rows::tags(tx, row.seq)?.len();
        validation::tag_count(before, tags.len()).map_err(ruled)?;
        rows::set_tags(tx, row.seq, &tags)?;
        self.tags_landed(&row, json!({ "tags": tags }))
    }

    fn add_tags(&self, id: &str, tags: Vec<String>, version: Option<i64>) -> Result<Done> {
        let tx = self.unit.tx();
        let row = self.tag_row(id, version)?;
        let tags = distinct(&tags);
        let held = rows::tags(tx, row.seq)?;
        let after = held.len() + tags.iter().filter(|tag| !held.contains(tag)).count();
        validation::tag_count(held.len(), after).map_err(ruled)?;
        rows::add_tags(tx, row.seq, &tags)?;
        self.tags_landed(&row, json!({ "tags": tags }))
    }

    fn remove_tag(&self, id: &str, tag: &str, version: Option<i64>) -> Result<Done> {
        let row = self.tag_row(id, version)?;
        rows::remove_tag(self.unit.tx(), row.seq, tag)?;
        self.tags_landed(&row, json!({ "tag": tag }))
    }

    fn extension_row(&self, id: &str, namespace: &str) -> Result<Item> {
        let row = self.writable_row(id)?;
        if RESERVED_NAMESPACES.contains(&namespace) {
            return Err(Refusal::new(
                Code::Forbidden,
                format!("Namespace \"{namespace}\" is reserved"),
            ));
        }
        self.note(Need::Extension {
            namespace: namespace.to_string(),
            write: true,
        });
        self.caller().require_extension(namespace, Level::Write)?;
        Ok(row)
    }

    fn extensions_landed(&self, row: &Item, namespace: &str) -> Result<Done> {
        let tx = self.unit.tx();
        self.unit
            .audit("item", &row.id, Some(json!({ "namespace": namespace })))?;
        self.announce_metadata(row)?;
        Ok(Done {
            status: 200,
            body: format!(
                "{{\"extensions\":{}}}",
                super::extensions_text(tx, row, |held| self.caller().may_read_extension(held))?
            ),
        })
    }

    fn set_extension(&self, id: &str, namespace: &str, data: &Map<String, Value>) -> Result<Done> {
        let row = self.extension_row(id, namespace)?;
        let text = js::canonical(data);
        if text.encode_utf16().count() > MAX_EXTENSION_UNITS {
            return Err(Refusal::validation(
                "Extension data exceeds maximum size of 100KB",
            ));
        }
        rows::put_extension(self.unit.tx(), row.seq, namespace, &text)?;
        self.extensions_landed(&row, namespace)
    }

    fn clear_extension(&self, id: &str, namespace: &str) -> Result<Done> {
        let row = self.extension_row(id, namespace)?;
        rows::remove_extension(self.unit.tx(), row.seq, namespace)?;
        self.extensions_landed(&row, namespace)
    }
}
