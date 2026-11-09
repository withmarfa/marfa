//! [`apply`] is the one way an item is written: it makes each access check on the state the
//! transaction commits, writes the rows, keeps the version left behind, and leaves the audit
//! entry and the event, all in that transaction.

use std::collections::BTreeSet;
use std::sync::Arc;

use arc_swap::ArcSwap;
use marfa_rules::conflict::{
    self, Detection, ItemFields, MergePolicy, Precondition, Stale, Strategy,
};
use marfa_rules::error::RuleError;
use marfa_rules::{js, validation};
use serde_json::{Map, Value, json};
use uuid::Uuid;

mod enrichment;

use super::bulk::{Counts, Entered, Entry, Note, Page, rollback};
use super::index;
use super::plan::{self, Act, Asked, Gate, Moving, invalid_transition, require_version};
use super::rows::{self, Landed, Moved, NewRow};
use super::{
    Item, Keys, Snapshot, Writer, check_keys, link_in, metadata_for, metadata_text, not_found,
    parsed, summary_of, title_key,
};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::blobs::Hash;
use crate::app::blobs::references::{self, Decided, Naming, Row as Referencing};
use crate::app::catalog::{self, Catalog, Snapshot as Reading};
use crate::app::connectors::ReadOnly;
use crate::app::edges::write::{self as edges, Inline, Writing as EdgeWriting};
use crate::app::events::Event;
use crate::app::faults::HOLD_BULK_PAGE;
use crate::app::idempotency::{self, Claim, Need};
use crate::app::instance;
use crate::app::query::VIEW_TYPE;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::app::views;

const COPY_TAG: &str = "conflicted-copy";
const RESERVED_NAMESPACES: [&str; 3] = ["core", "marfa", "system"];
const MAX_EXTENSION_UNITS: usize = 102_400;
const FILE_TYPE: &str = "core.file";
const FILE_BYTES: &str = "blob_ref";
const FILE_SIZE: &str = "size_bytes";

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
    pub edges: Option<Inline>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Settle {
    #[default]
    Refuse,
    Automatically,
}

#[derive(Debug, Default)]
pub struct Update {
    pub id: String,
    pub properties: Option<Map<String, Value>>,
    pub clear: Vec<String>,
    pub replace: bool,
    pub type_id: Option<String>,
    pub retype: bool,
    pub version: i64,
    pub exact: bool,
    pub tier: Option<String>,
    pub occurred_at: Option<String>,
    pub source_id: Option<String>,
    pub settle: Settle,
    pub edges: Option<Inline>,
}

#[derive(Debug)]
pub enum ViewChange {
    Create {
        settings: Map<String, Value>,
    },
    Update {
        id: String,
        settings: Map<String, Value>,
        clear: Vec<String>,
        version: i64,
    },
    Delete {
        id: String,
    },
}

#[derive(Debug)]
pub enum Change {
    View(ViewChange),
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
    Transition {
        id: String,
        state: String,
        version: Option<i64>,
    },
    Delete {
        id: String,
        version: Option<i64>,
    },
    Trash {
        ids: Vec<String>,
        digest: Option<String>,
    },
    Restore {
        id: String,
        version: Option<i64>,
    },
    Purge {
        id: String,
        version: Option<i64>,
    },
    Owner {
        act: OwnerAct,
        id: String,
        version: i64,
    },
    Settle {
        type_id: String,
        keys: Keys,
        settled_at: String,
    },
    Page(Box<Page>),
    Entry {
        entry: Box<Entry>,
        note: Note,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerAct {
    Trash,
    Restore,
    Purge,
}

impl Change {
    pub(crate) fn action(&self) -> &'static str {
        match self {
            Change::View(ViewChange::Create { .. }) => "view.create",
            Change::View(ViewChange::Update { .. }) => "view.update",
            Change::View(ViewChange::Delete { .. }) => "view.delete",
            Change::Put(_) => "item.create",
            Change::Update(_) => "item.update",
            Change::SetTags { .. } => "item.metadata.replace",
            Change::AddTags { .. } => "item.tag",
            Change::RemoveTag { .. } => "item.untag",
            Change::SetExtension { .. } => "extension.set",
            Change::ClearExtension { .. } => "extension.delete",
            Change::Transition { .. } => "item.transition",
            Change::Delete { .. }
            | Change::Owner {
                act: OwnerAct::Trash,
                ..
            } => "item.delete",
            Change::Trash { .. } => "items.trash",
            Change::Restore { .. }
            | Change::Owner {
                act: OwnerAct::Restore,
                ..
            } => "item.restore",
            Change::Purge { .. }
            | Change::Owner {
                act: OwnerAct::Purge,
                ..
            } => "item.purge",
            Change::Settle { .. } => "items.tombstones",
            Change::Page(_) | Change::Entry { .. } => "items.bulk",
        }
    }

    fn fans_out(&self) -> bool {
        match self {
            Change::Page(page) => page.fanout,
            Change::Entry { note, .. } => note.fanout,
            _ => true,
        }
    }
}

type Outcome = (Map<String, Value>, Option<Value>, Option<Item>);

#[derive(Debug)]
pub struct Done {
    pub status: u16,
    pub body: String,
}

fn done_ok() -> Done {
    Done {
        status: 200,
        body: "{\"ok\":true}".to_string(),
    }
}

/// With a `claim`, the answer is recorded under it in the same transaction.
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

pub fn apply(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    claim: Option<&Claim>,
    change: Change,
) -> Result<Done> {
    unit.fanning(change.fans_out(), |unit| {
        let job = Job {
            unit,
            catalog: catalog::current(cache, unit.tx(), Reading::Pending)?,
            read_only: unit.read_only()?,
            claim,
            server_own: false,
        };
        job.run(change)
    })
}

pub(crate) use enrichment::{Enriched, Offer, Offered, Written, apply_enrichment, offer};

/// A change the server makes to an item it keeps for itself. No door that
/// takes a caller's item may lead here.
pub(crate) fn apply_server_own(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    change: Change,
) -> Result<Done> {
    let job = Job {
        unit,
        catalog: catalog::current(cache, unit.tx(), Reading::Pending)?,
        read_only: unit.read_only()?,
        claim: None,
        server_own: true,
    };
    job.run(change)
}

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

fn unknown_row(row: &Item) -> Refusal {
    Refusal::new(
        Code::UnknownType,
        format!(
            "Unknown type: {0}. Register it via POST /types before writing items of it.",
            row.type_id
        ),
    )
    .with_detail("type", row.type_id.as_str())
}

fn refuse_other_type(row: &Item, declared: &str, named_by_id: bool) -> Result<()> {
    if named_by_id && declared != row.type_id {
        return Err(id_reused(row, declared));
    }
    require_declared(declared, row)
}

fn refuse_uncreatable(put: &Put) -> Result<()> {
    match put.state.as_deref() {
        None | Some("active" | "archived" | "trashed") => Ok(()),
        Some(state) => Err(Refusal::validation(format!(
            "An item cannot be created in the state \"{state}\"."
        ))),
    }
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

pub(super) fn stale_bare(row: &Item, named: i64) -> Result<Refusal> {
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
    .with_member("merge_policy", policy.to_json()))
}

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
    edges: Option<Inline>,
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

struct Settled {
    properties: Map<String, Value>,
    /// What the version a stale write was made against named.
    base: Option<BTreeSet<String>>,
    fields: ItemFields,
    resolution: Option<Value>,
    copy: Option<Item>,
}

pub(super) fn announce(unit: &Unit<'_, '_>, event_type: &'static str, item: &Item) -> Result<()> {
    announce_held(
        unit,
        event_type,
        item,
        &metadata_text(unit.tx(), item, |_| true)?,
    )
}

fn announce_held(
    unit: &Unit<'_, '_>,
    event_type: &'static str,
    item: &Item,
    metadata: &str,
) -> Result<()> {
    unit.announce(&Event {
        event_type,
        item_id: &item.id,
        type_id: &item.type_id,
        source: &item.source,
        payload: format!("{{\"item\":{},\"metadata\":{metadata}}}", item.logged()?),
    })
}

pub(super) fn purge(unit: &Unit<'_, '_>, item: &Item) -> Result<()> {
    let metadata = metadata_text(unit.tx(), item, |_| true)?;
    rows::purge(unit.tx(), item, &unit.at)?;
    announce_held(unit, "item.purged", item, &metadata)
}

pub(super) fn moved_to_bin(unit: &Unit<'_, '_>, moving: &[Moving]) -> Result<Vec<Item>> {
    let (at, writer) = (unit.at.as_str(), unit.caller.writer());
    moving
        .iter()
        .map(|moving| {
            rows::move_state(
                unit.tx(),
                &moving.item,
                &Moved {
                    state: moving.state,
                    trashed_at: Some(at),
                    trashed_by: writer.as_ref(),
                    at,
                    mark: moving.mark.as_ref(),
                },
            )
        })
        .collect()
}

pub(crate) fn settle_late_part(
    unit: &Unit<'_, '_>,
    catalog: &Catalog,
    source_id: &str,
    target_id: &str,
) -> Result<()> {
    let tx = unit.tx();
    let (Some(source), Some(host)) = (rows::by_id(tx, source_id)?, rows::by_id(tx, target_id)?)
    else {
        return Ok(());
    };
    let gate = Gate {
        tx,
        caller: &unit.caller,
        catalog,
        claim: None,
        server_own: false,
    };
    for item in moved_to_bin(unit, &plan::late_part(&gate, &source, &host)?)? {
        unit.audit("item", &item.id, None)?;
        announce(unit, "item.deleted", &item)?;
    }
    index::settle(tx, &catalog.rules)
}

struct Job<'a, 't, 'c> {
    unit: &'a Unit<'t, 'c>,
    catalog: Arc<Catalog>,
    read_only: ReadOnly,
    claim: Option<&'a Claim>,
    server_own: bool,
}

impl<'t, 'c> Job<'_, 't, 'c> {
    fn run(self, change: Change) -> Result<Done> {
        let done = match change {
            Change::View(change) => self.view(change),
            Change::Put(put) => self.put(*put),
            Change::Update(update) => self.update(*update),
            Change::SetTags { id, tags, version } => self.set_tags(&id, tags, version),
            Change::AddTags { id, tags, version } => self.add_tags(&id, tags, version),
            Change::RemoveTag { id, tag, version } => self.remove_tag(&id, &tag, version),
            Change::SetExtension {
                id,
                namespace,
                data,
            } => self.set_extension(&id, &namespace, &data),
            Change::ClearExtension { id, namespace } => self.clear_extension(&id, &namespace),
            Change::Transition { id, state, version } => self.transition(&id, &state, version),
            Change::Delete { id, version } => self.delete(id, version),
            Change::Trash { ids, digest } => self.trash(ids, digest.as_deref()),
            Change::Restore { id, version } => self.restore(&id, version),
            Change::Purge { id, version } => self.purge(id, version),
            Change::Owner { act, id, version } => self.owner(act, id, version),
            Change::Settle {
                type_id,
                keys,
                settled_at,
            } => self.settle(&type_id, &keys, &settled_at),
            Change::Page(page) => self.page(*page),
            Change::Entry { entry, note } => self.lone_entry(*entry, &note),
        }?;
        index::settle(self.unit.tx(), &self.catalog.rules)?;
        Ok(done)
    }

    /// Whose reach this write is judged by. The server's own write answers to
    /// the door that decided it, not to what the person asking may touch.
    fn caller(&self) -> &Caller {
        if self.server_own {
            &Caller::Server
        } else {
            &self.unit.caller
        }
    }

    fn gate(&self) -> Gate<'_, 'c> {
        Gate {
            tx: self.unit.tx(),
            caller: self.caller(),
            catalog: &self.catalog,
            claim: self.claim,
            server_own: self.server_own,
        }
    }

    fn edge_writing(&self) -> EdgeWriting<'_, 't, 'c> {
        EdgeWriting::of(self.unit, &self.catalog, self.claim)
    }

    /// A part written to a host in the bin follows it there.
    fn with_inline(&self, item: Item, inline: Option<&Inline>) -> Result<Item> {
        let Some(inline) = inline else {
            return Ok(item);
        };
        edges::inline_replace(&self.edge_writing(), &item, inline)?;
        rows::by_id(self.unit.tx(), &item.id)?.ok_or_else(not_found)
    }

    fn writer(&self) -> Option<Writer> {
        self.unit.caller.writer()
    }

    fn source_of(&self, named: Option<&str>) -> Result<String> {
        let Some(name) = named else {
            return Ok(self.caller().own_source().to_string());
        };
        self.may_write_under(name, true)?;
        Ok(name.to_string())
    }

    fn may_write_under(&self, source: &str, disclosed: bool) -> Result<()> {
        self.gate().note(Need::Source {
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
        let Some(allowed) = self.caller().levers()?.allowed_sources(type_id) else {
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
        if !self.caller().levers()?.strict_on(type_id) || !rules.known(type_id) {
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
        self.answer_with(
            status,
            item.answered(&self.read_only, self.caller())?,
            item,
            also,
        )
    }

    fn answer_edges(&self, status: u16, item: &Item, also: &str) -> Result<Done> {
        let shown = item.hydrated(
            self.unit.tx(),
            &self.read_only,
            self.caller(),
            &self.catalog,
        )?;
        self.answer_with(status, shown, item, also)
    }

    fn answer_with(&self, status: u16, shown: String, item: &Item, also: &str) -> Result<Done> {
        Ok(Done {
            status,
            body: format!(
                "{{\"item\":{shown},\"metadata\":{}{also}}}",
                metadata_for(self.unit.tx(), item, self.caller())?
            ),
        })
    }

    fn acknowledge(&self, row: &Item) -> Result<Done> {
        self.answer(200, row, ",\"acknowledged\":true")
    }

    fn announce(&self, event_type: &'static str, item: &Item) -> Result<()> {
        announce(self.unit, event_type, item)
    }

    fn announce_metadata(&self, item: &Item) -> Result<()> {
        announce(self.unit, "metadata.changed", item)
    }

    /// Item doors fence `system.*` off from every key, so view doors ask write on `system.view`.
    fn view(&self, change: ViewChange) -> Result<Done> {
        self.caller().require_view_write()?;
        match change {
            ViewChange::Create { settings } => {
                views::check(&settings, &self.catalog)?;
                let source = self.source_of(None)?;
                let item = self.created(
                    Put {
                        type_id: VIEW_TYPE.to_string(),
                        properties: Some(settings),
                        ..Put::default()
                    },
                    &source,
                )?;
                self.unit.audit("item", &item.id, None)?;
                self.answer(201, &item, "")
            }
            ViewChange::Update {
                id,
                settings,
                clear,
                version,
            } => {
                let row = self.view_row(&id)?;
                views::check(&settings, &self.catalog)?;
                if row.state == "revoked" {
                    return Err(Refusal::new(
                        Code::InvalidTransition,
                        format!("View {id} is revoked, and a revoked view does not change"),
                    ));
                }
                let (item, resolution) = self.landed(
                    &row,
                    &Writing {
                        properties: Some(settings),
                        clear,
                        version: Some(version),
                        ..Writing::default()
                    },
                )?;
                self.unit.audit("item", &item.id, None)?;
                let also = match resolution {
                    Some(resolution) => format!(",\"conflict_resolution\":{resolution}"),
                    None => String::new(),
                };
                self.answer(200, &item, &also)
            }
            ViewChange::Delete { id } => {
                let row = self.view_row(&id)?;
                for purging in plan::walked_purge(&self.gate(), row)? {
                    let item = &purging.item;
                    for (edge, source) in &purging.edges {
                        edges::purge_edge(self.unit, edge, source, &item.id)?;
                    }
                    purge(self.unit, item)?;
                    self.unit.audit("item", &item.id, None)?;
                }
                Ok(done_ok())
            }
        }
    }

    fn view_row(&self, id: &str) -> Result<Item> {
        rows::by_id(self.unit.tx(), id)?
            .filter(|row| row.type_id == VIEW_TYPE)
            .ok_or_else(|| Refusal::new(Code::ItemNotFound, format!("View {id} not found")))
    }

    fn put(&self, put: Put) -> Result<Done> {
        let tx = self.unit.tx();
        refuse_uncreatable(&put)?;
        let source = self.put_gates(&put)?;
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

    fn put_gates(&self, put: &Put) -> Result<String> {
        self.gate().type_gate(&put.type_id)?;
        let source = self.source_of(put.source.as_deref())?;
        self.refuse_unlisted_source(&put.type_id, &source)?;
        Ok(source)
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
        self.gate().row_gate(&row)?;
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
                edges: put.edges,
                upsert: true,
                ..Writing::default()
            },
        )
    }

    fn create(&self, put: Put, source: &str) -> Result<Done> {
        let item = self.created(put, source)?;
        self.unit
            .audit("item", &item.id, Some(json!({ "type": item.type_id })))?;
        self.answer_edges(201, &item, "")
    }

    fn created(&self, put: Put, source: &str) -> Result<Item> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        if let Some(inline) = &put.edges {
            edges::inline_gates(&self.edge_writing(), inline)?;
        }
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
        let mut properties = rules.coerced_properties(&put.type_id, &properties);
        let decided = self.referenced(None, &put.type_id, &mut properties, Naming::default())?;
        let properties = rules.in_answer_order(&put.type_id, &properties);
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
        let link = self.held_link(&put.type_id, &properties, None)?;
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
                trashed_by: writer.as_ref().filter(|_| state == "trashed"),
                link: link.as_deref(),
                capture_latitude: put.capture_latitude,
                capture_longitude: put.capture_longitude,
                writer: writer.as_ref(),
            },
        )?;
        decided.apply(tx, Referencing::Item(item.seq))?;
        if let Some(tags) = &put.tags {
            rows::set_tags(tx, item.seq, &distinct(tags))?;
        }
        self.announce("item.created", &item)?;
        self.with_inline(item, put.edges.as_ref())
    }

    fn update(&self, update: Update) -> Result<Done> {
        let row = self.gate().writable_row(&update.id)?;
        let moving = update.retype
            && update
                .type_id
                .as_deref()
                .is_some_and(|declared| declared != row.type_id);
        if moving {
            if let Some(destination) = update.type_id.as_deref() {
                self.gate().type_gate(destination)?;
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
                edges: update.edges,
                ..Writing::default()
            },
        )
    }

    fn change_row(&self, row: Item, writing: Writing) -> Result<Done> {
        self.judge_change(&row, &writing)?;
        if !writing.writes_row() {
            if let Some(named) = writing.version
                && named != row.version
            {
                return Err(stale_bare(&row, named)?);
            }
            if writing.edges.is_some() {
                self.announce("item.updated", &row)?;
            }
            let item = self.with_inline(row, writing.edges.as_ref())?;
            return self.answer_edges(200, &item, "");
        }
        let (item, resolution) = self.landed(&row, &writing)?;
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
        let also = match resolution {
            Some(resolution) => format!(",\"conflict_resolution\":{resolution}"),
            None => String::new(),
        };
        self.answer_edges(200, &item, &also)
    }

    fn judge_change(&self, row: &Item, writing: &Writing) -> Result<()> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        if let Some(inline) = &writing.edges {
            edges::inline_gates(&self.edge_writing(), inline)?;
        }
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
        let resulting = writing.destination.as_deref().unwrap_or(&row.type_id);
        self.refuse_undeclared(resulting, writing.properties.as_ref())?;
        if writing.exact {
            if !rules.known(&row.type_id) {
                return Err(unknown_row(row));
            }
            if conflict::precondition(row.version, writing.version, true) == Precondition::Refused {
                return Err(stale_bare(row, writing.version.unwrap_or(0))?);
            }
        }
        Ok(())
    }

    fn landed(&self, row: &Item, writing: &Writing) -> Result<(Item, Option<Value>)> {
        if !self.catalog.rules.known(&row.type_id) {
            return Err(unknown_row(row));
        }
        let resulting = writing.destination.as_deref().unwrap_or(&row.type_id);
        let mut settled = self.settled(row, resulting, writing)?;
        if resulting != row.type_id {
            let replaced = writing.edges.as_deref().unwrap_or_default();
            edges::judge_retype(&self.edge_writing(), row, resulting, replaced)?;
            instance::raise_reach(self.unit.tx())?;
        }
        let decided = self.referenced(
            Some(Referencing::Item(row.seq)),
            resulting,
            &mut settled.properties,
            Naming {
                base: settled.base.as_ref(),
                ..Naming::default()
            },
        )?;
        let item = self.land(row, resulting, &settled)?;
        decided.apply(self.unit.tx(), Referencing::Item(item.seq))?;
        if let Some(tags) = &writing.tags {
            rows::set_tags(self.unit.tx(), item.seq, &distinct(tags))?;
        }
        if let Some(copy) = &settled.copy {
            self.announce("item.created", copy)?;
            edges::copy_edges(&self.edge_writing(), row, copy)?;
        }
        self.announce("item.updated", &item)?;
        let item = self.with_inline(item, writing.edges.as_ref())?;
        Ok((item, settled.resolution))
    }

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
                base: None,
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
        let sized = [row.type_id.as_str(), resulting]
            .iter()
            .any(|type_id| self.is_file(type_id));
        let mut sent_now = sent.unwrap_or_default();
        if sized
            && sent_now
                .get(FILE_SIZE)
                .is_some_and(|size| size.is_null() || size.is_i64() || size.is_u64())
        {
            sent_now.shift_remove(FILE_SIZE);
        }
        let mut cleared: Vec<String> = Vec::new();
        if writing.replace && writing.properties.is_some() {
            cleared.extend(
                held.keys()
                    .filter(|name| !sent_now.contains_key(*name))
                    .cloned(),
            );
        }
        cleared.extend(writing.clear.iter().cloned());
        if sized {
            cleared.retain(|name| name != FILE_SIZE);
        }
        let fields = writing.fields();
        let (current_fields, ancestor_fields) = (row.fields(), ancestor.fields());
        let stale = Stale {
            sent: &sent_now,
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
                self.resolved(row, named, &ancestor, &stale, &detection, &policy)?
            }
        };
        Ok(Settled {
            properties: self.judged(row, resulting, writing, &current, properties)?,
            base: Some(references::digests(&held)),
            fields: detection.changed_fields,
            resolution,
            copy,
        })
    }

    fn resolved(
        &self,
        row: &Item,
        named: i64,
        ancestor: &Snapshot,
        stale: &Stale<'_>,
        detection: &Detection,
        policy: &MergePolicy,
    ) -> Result<Outcome> {
        let plan = conflict::plan(stale, detection, policy);
        if !plan.keep_both.is_empty()
            && self
                .catalog
                .link_field(&row.type_id)
                .is_some_and(|field| self.catalog.rules.requires(&row.type_id, field))
        {
            return Err(collision(
                row,
                named,
                ancestor,
                &detection.conflicting,
                policy,
            )?);
        }
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

    fn conflicted_copy(
        &self,
        row: &Item,
        named: i64,
        stale: &Stale<'_>,
        keep_both: &[String],
    ) -> Result<(bool, Item)> {
        let tx = self.unit.tx();
        let rules = &self.catalog.rules;
        let mut properties = conflict::copy_properties(stale, keep_both);
        if let Some(field) = self.catalog.link_field(&row.type_id) {
            properties.shift_remove(field);
        }
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
        let mut properties = rules.coerced_properties(&row.type_id, &properties);
        let id = match self.claim {
            // A caller may mint any id, so the id must be one it cannot work
            // out, or a row it placed there would pass for this attempt's copy.
            Some(claim) => {
                let attempt = instance::secret(tx)?.keyed("conflicted-copy", &claim.attempt())?;
                conflict::copy_id(&row.id, named, &attempt)
            }
            None => Uuid::now_v7().to_string(),
        };
        if let Some(held) = rows::by_id(tx, &id)? {
            return Ok((false, held));
        }
        let base = references::digests(stale.ancestor);
        let inherited = references::held(tx, Referencing::Item(row.seq))?;
        let decided = self.referenced(
            None,
            &row.type_id,
            &mut properties,
            Naming {
                base: Some(&base),
                inherited: Some(&inherited),
                ..Naming::default()
            },
        )?;
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
                trashed_by: None,
                link: None,
                capture_latitude: None,
                capture_longitude: None,
                writer: writer.as_ref(),
            },
        )?;
        decided.apply(tx, Referencing::Item(copy.seq))?;
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

    fn is_file(&self, type_id: &str) -> bool {
        self.catalog.rules.matches(FILE_TYPE, type_id)
    }

    /// Decides the references `properties` give a row of `type_id`, and the size a file holds.
    /// Each item-writing path comes through here, so the bulk actions' and the folders' doors
    /// must too.
    fn referenced(
        &self,
        row: Option<Referencing<'_>>,
        type_id: &str,
        properties: &mut Map<String, Value>,
        naming: Naming<'_>,
    ) -> Result<Decided> {
        let tx = self.unit.tx();
        let file = self.is_file(type_id);
        let bytes = properties
            .get(FILE_BYTES)
            .and_then(Value::as_str)
            .and_then(Hash::whole)
            .filter(|_| file);
        let decided = references::decide(
            tx,
            self.caller(),
            row,
            properties,
            Naming {
                bytes: bytes.as_ref(),
                ..naming
            },
        )?;
        if file {
            match bytes
                .map(|hash| decided.lent_size(tx, &hash))
                .transpose()?
                .flatten()
            {
                Some(size) => properties.insert(FILE_SIZE.to_string(), Value::from(size)),
                None => properties.shift_remove(FILE_SIZE),
            };
        }
        Ok(decided)
    }

    /// Each row-writing path comes through here, so the link rule cannot differ by door.
    fn held_link(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        own: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(field) = self.catalog.link_field(type_id) else {
            return Ok(None);
        };
        let Some(link) = link_in(field, properties) else {
            return Ok(None);
        };
        if let Some(holder) = rows::link_holder(self.unit.tx(), type_id, link)?
            && Some(holder.as_str()) != own
        {
            return Err(Refusal::new(
                Code::LinkTaken,
                format!("Another item of type \"{type_id}\" already holds this link."),
            )
            .with_detail("existing_id", holder)
            .with_detail("field", field)
            .with_detail("value", link));
        }
        Ok(Some(link.to_string()))
    }

    fn land(&self, row: &Item, resulting: &str, settled: &Settled) -> Result<Item> {
        let rules = &self.catalog.rules;
        let at = self.unit.at.as_str();
        let writer = self.writer();
        let key = title_key(rules, resulting, &settled.properties);
        let link = self.held_link(resulting, &settled.properties, Some(&row.id))?;
        let fields = &settled.fields;
        rows::advance(
            self.unit.tx(),
            row,
            &Uuid::now_v7().to_string(),
            &Landed {
                type_id: resulting,
                tier: fields.tier.as_deref().or(row.tier.as_deref()),
                source_id: fields.source_id.as_deref().or(row.source_id.as_deref()),
                link: link.as_deref(),
                properties: &js::canonical(&settled.properties),
                title_key: key.as_deref(),
                schema_version: self.schema_version(resulting),
                occurred_at: fields.occurred_at.as_deref().unwrap_or(&row.occurred_at),
                at,
                writer: writer.as_ref(),
            },
        )
    }

    fn tag_row(&self, id: &str, version: Option<i64>) -> Result<Item> {
        let row = self.gate().writable_row(id)?;
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
        let row = self.gate().writable_row(id)?;
        if RESERVED_NAMESPACES.contains(&namespace) {
            return Err(Refusal::new(
                Code::Forbidden,
                format!("Namespace \"{namespace}\" is reserved"),
            ));
        }
        self.gate().note(Need::Extension {
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
        let held = Referencing::Extension(row.seq, namespace);
        let decided = references::decide(
            self.unit.tx(),
            self.caller(),
            Some(held),
            data,
            Naming::default(),
        )?;
        rows::put_extension(self.unit.tx(), row.seq, namespace, &text)?;
        decided.apply(self.unit.tx(), held)?;
        self.extensions_landed(&row, namespace)
    }

    fn clear_extension(&self, id: &str, namespace: &str) -> Result<Done> {
        let row = self.extension_row(id, namespace)?;
        rows::remove_extension(self.unit.tx(), row.seq, namespace)?;
        self.extensions_landed(&row, namespace)
    }

    /// One transaction, so any refusal undoes all of it.
    fn page(&self, page: Page) -> Result<Done> {
        let Page {
            entries,
            mode,
            retype,
            operation,
            pulse,
            faults,
            fanout: _,
        } = page;
        for (index, entry) in entries.iter().enumerate() {
            entry
                .as_ref()
                .map_err(Refusal::clone)
                .and_then(|entry| self.entry_gates(&entry.put))
                .map_err(|refusal| rollback(index, &refusal))?;
        }
        let total = entries.len();
        let mut counts = Counts::default();
        let mut results = Vec::with_capacity(total);
        for (index, entry) in entries.into_iter().enumerate() {
            faults.hold_beating(HOLD_BULK_PAGE, &pulse);
            let entered = entry
                .and_then(|entry| self.entry(entry, retype))
                .map_err(|refusal| rollback(index, &refusal))?;
            pulse.tick();
            counts.add(entered.outcome());
            results.push(entered.answered(index));
        }
        self.unit.audit_set(
            "items.bulk",
            Some(json!({
                "operation_id": operation,
                "mode": mode,
                "atomic": true,
                "total": total,
                "created": counts.created,
                "updated": counts.updated,
                "skipped": counts.skipped,
                "errored": counts.errored,
            })),
        )?;
        Ok(Done {
            status: 200,
            body: json!({ "counts": counts, "results": results }).to_string(),
        })
    }

    fn entry_gates(&self, put: &Put) -> Result<()> {
        if put.id.is_none() && put.source_id.is_none() {
            refuse_uncreatable(put)?;
        }
        self.put_gates(put).map(|_| ())
    }

    fn lone_entry(&self, entry: Entry, note: &Note) -> Result<Done> {
        let entered = self.entry(entry, note.retype)?;
        if let Some(id) = entered.written() {
            self.unit.audit(
                "items.bulk",
                id,
                Some(json!({
                    "operation_id": note.operation,
                    "mode": note.mode,
                    "atomic": false,
                    "total": note.total,
                    "index": note.index,
                    "outcome": entered.outcome(),
                })),
            )?;
        }
        Ok(Done {
            status: 200,
            body: entered.answered(note.index).to_string(),
        })
    }

    fn entry(&self, entry: Entry, retype: bool) -> Result<Entered> {
        let tx = self.unit.tx();
        let Entry { put, replace } = entry;
        let source = self.put_gates(&put)?;
        if let Some(tags) = &put.tags {
            validation::tag_count(0, tags.len()).map_err(ruled)?;
        }
        let by_key = match put.source_id.as_deref() {
            Some(source_id) => rows::by_natural_key(tx, &source, source_id)?,
            None => None,
        };
        let by_id = match (&by_key, put.id.as_deref()) {
            (None, Some(id)) => rows::by_id(tx, id)?,
            _ => None,
        };
        if put.create_only {
            return self.entry_once(put, &source, by_key, by_id);
        }
        let named_by_id = by_id.is_some();
        let Some(row) = by_key.or(by_id) else {
            return self.new_entry(put, &source);
        };
        if !self.caller().may_read_type(&row.type_id) {
            return Err(if named_by_id {
                Refusal::new(
                    Code::Conflict,
                    format!("Item with id={} already exists", row.id),
                )
                .with_detail("existing_id", row.id.as_str())
            } else {
                Refusal::new(
                    Code::TypeNotPermitted,
                    "The natural key resolves a row of a type this credential may not reach",
                )
            });
        }
        self.gate().row_gate(&row)?;
        if row.state == "trashed" {
            if !retype {
                refuse_other_type(&row, &put.type_id, named_by_id)?;
            }
            return Ok(Entered::Skipped {
                id: Some(row.id),
                reason: "trashed",
            });
        }
        let id = row.id.clone();
        self.entry_row(row, put, replace, retype, named_by_id)
            .map(|()| Entered::Updated(id.clone()))
            .map_err(|refusal| refusal.naming_row(&id))
    }

    fn entry_once(
        &self,
        put: Put,
        source: &str,
        by_key: Option<Item>,
        by_id: Option<Item>,
    ) -> Result<Entered> {
        if let Some(row) = by_key {
            return Ok(Entered::Skipped {
                id: self.caller().may_read_type(&row.type_id).then_some(row.id),
                reason: "duplicate_source",
            });
        }
        if let Some(row) = by_id {
            return Ok(Entered::Skipped {
                id: Some(row.id),
                reason: "duplicate_id",
            });
        }
        self.new_entry(put, source)
    }

    fn new_entry(&self, put: Put, source: &str) -> Result<Entered> {
        refuse_uncreatable(&put)?;
        Ok(Entered::Created(self.created(put, source)?.id))
    }

    fn entry_row(
        &self,
        row: Item,
        put: Put,
        replace: bool,
        retype: bool,
        named_by_id: bool,
    ) -> Result<()> {
        let moving = retype && put.type_id != row.type_id;
        if !moving {
            refuse_other_type(&row, &put.type_id, named_by_id)?;
        }
        let writing = Writing {
            properties: put.properties,
            replace,
            destination: moving.then_some(put.type_id),
            version: put.version,
            tier: put.tier,
            occurred_at: put.occurred_at,
            source_id: put.source_id,
            tags: put.tags,
            edges: put.edges,
            upsert: true,
            ..Writing::default()
        };
        self.judge_change(&row, &writing)?;
        self.landed(&row, &writing).map(|_| ())
    }

    fn moved_to_bin(&self, moving: &[Moving]) -> Result<Vec<Item>> {
        moved_to_bin(self.unit, moving)
    }

    fn moved_out(&self, item: &Item, state: &str) -> Result<Item> {
        rows::move_state(
            self.unit.tx(),
            item,
            &Moved {
                state,
                trashed_at: None,
                trashed_by: None,
                at: &self.unit.at,
                mark: None,
            },
        )
    }

    fn brought_back(&self, row: &Item) -> Result<()> {
        for back in plan::returning(&self.gate(), row)? {
            let item = self.moved_out(&back.item, "active")?;
            self.unit.audit("item", &item.id, None)?;
            self.unit.announce(&Event {
                event_type: "item.restored",
                item_id: &item.id,
                type_id: &item.type_id,
                source: &item.source,
                payload: format!(
                    "{{\"item\":{},\"metadata\":{},\"restored_with\":{},\
                     \"restored_with_type\":{}}}",
                    item.logged()?,
                    metadata_text(self.unit.tx(), &item, |_| true)?,
                    Value::from(back.with),
                    Value::from(back.with_type)
                ),
            })?;
        }
        Ok(())
    }

    fn lifecycle_row(&self, id: &str, version: Option<i64>) -> Result<Item> {
        let gate = self.gate();
        let row = gate.readable_row(id)?;
        gate.row_gate(&row)?;
        require_version(&row, version)?;
        Ok(row)
    }

    fn transition(&self, id: &str, state: &str, version: Option<i64>) -> Result<Done> {
        let row = self.lifecycle_row(id, version)?;
        let to_bin = state == "trashed";
        let from_bin = row.state == "trashed";
        if !matches!(
            (row.state.as_str(), state),
            ("active", "archived" | "trashed")
                | ("archived", "active" | "trashed")
                | ("trashed", "active")
        ) {
            return Err(invalid_transition(&row.state, state));
        }
        let mut taken = if to_bin {
            let asked = [Asked {
                id: row.id.clone(),
                version,
            }];
            let plan = plan::plan(&self.gate(), Act::Bin, &asked)?;
            self.moved_to_bin(&plan.moving)?
        } else {
            vec![self.moved_out(&row, state)?]
        };
        let item = taken
            .pop()
            .ok_or_else(|| Refusal::internal("a plan lost the row it was asked about"))?;
        self.unit.audit(
            "item",
            &item.id,
            Some(json!({ "from_state": row.state, "to_state": state })),
        )?;
        self.announce("item.state_changed", &item)?;
        if to_bin {
            for row in &taken {
                self.unit.audit("item", &row.id, None)?;
                self.announce("item.deleted", row)?;
            }
            self.announce("item.deleted", &item)?;
        } else if from_bin {
            self.announce("item.restored", &item)?;
            self.brought_back(&row)?;
        }
        self.answer(200, &item, "")
    }

    fn delete(&self, id: String, version: Option<i64>) -> Result<Done> {
        let plan = plan::plan(&self.gate(), Act::Bin, &[Asked { id, version }])?;
        for item in self.moved_to_bin(&plan.moving)? {
            self.unit.audit("item", &item.id, None)?;
            self.announce("item.deleted", &item)?;
        }
        Ok(done_ok())
    }

    fn trash(&self, ids: Vec<String>, digest: Option<&str>) -> Result<Done> {
        let asked: Vec<Asked> = ids
            .iter()
            .map(|id| Asked {
                id: id.clone(),
                version: None,
            })
            .collect();
        let plan = plan::plan(&self.gate(), Act::Bin, &asked)?;
        if digest.is_some_and(|digest| digest != plan.digest) {
            return Err(Refusal::new(
                Code::TrashPlanChanged,
                "What this trash would take has changed since the preview.",
            )
            .with_detail("digest", plan.digest));
        }
        let moved = self.moved_to_bin(&plan.moving)?;
        for item in &moved {
            self.announce("item.deleted", item)?;
        }
        self.unit.audit_set(
            "items.trash",
            Some(json!({ "ids": ids, "trashed": moved.len() })),
        )?;
        Ok(done_ok())
    }

    fn restore(&self, id: &str, version: Option<i64>) -> Result<Done> {
        let row = self.lifecycle_row(id, version)?;
        if row.state != "trashed" {
            return Err(invalid_transition(&row.state, "active"));
        }
        let item = self.moved_out(&row, "active")?;
        self.unit.audit("item", &item.id, None)?;
        self.announce("item.restored", &item)?;
        self.brought_back(&row)?;
        self.answer(200, &item, "")
    }

    fn purge(&self, id: String, version: Option<i64>) -> Result<Done> {
        let plan = plan::plan(&self.gate(), Act::Purge, &[Asked { id, version }])?;
        for purging in &plan.purging {
            let item = &purging.item;
            for (edge, source) in &purging.edges {
                edges::purge_edge(self.unit, edge, source, &item.id)?;
            }
            purge(self.unit, item)?;
            self.unit.audit("item", &item.id, None)?;
        }
        Ok(done_ok())
    }

    /// Answers with the summary alone, so nothing of the item's content leaves through this door.
    fn owner(&self, act: OwnerAct, id: String, version: i64) -> Result<Done> {
        self.caller().require_local()?;
        let levers = self.caller().levers()?;
        let row = rows::by_id(self.unit.tx(), &id)?
            .filter(|row| !super::is_system(&row.type_id))
            .filter(|row| levers.lists(&self.catalog.rules, &row.type_id, &row.source))
            .ok_or_else(not_found)?;
        let summary = summary_of(self.unit.tx(), &self.catalog, &row)?;
        if row.version != version {
            return Ok(Done {
                status: 409,
                body: json!({
                    "error": {
                        "code": "version_conflict",
                        "message": "This item changed. Refresh the page before trying again.",
                    },
                    "current": summary,
                })
                .to_string(),
            });
        }
        match act {
            OwnerAct::Trash => self.delete(id, None)?,
            OwnerAct::Restore => self.restore(&id, None)?,
            OwnerAct::Purge => self.purge(id, None)?,
        };
        Ok(Done {
            status: 200,
            body: summary.to_string(),
        })
    }

    fn settle(&self, type_id: &str, keys: &Keys, settled_at: &str) -> Result<Done> {
        check_keys(&self.catalog, type_id, Some(keys))?;
        self.gate().type_gate(type_id)?;
        let tx = self.unit.tx();
        match keys {
            Keys::Links(links) => {
                for link in links {
                    rows::settle_link(tx, type_id, link, settled_at)?;
                }
            }
            Keys::Natural { source, source_ids } => {
                self.may_write_under(source, true)?;
                for source_id in source_ids {
                    rows::settle_key(tx, type_id, source, source_id, settled_at)?;
                }
            }
        }
        let tombstones = rows::tombstones(tx, type_id, keys)?;
        self.unit.audit(
            "type",
            type_id,
            Some(json!({ "settled_at": settled_at, "count": tombstones.len() })),
        )?;
        Ok(Done {
            status: 200,
            body: json!({ "tombstones": tombstones }).to_string(),
        })
    }
}
