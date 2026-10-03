//! The Node-facing shape of `marfa_core`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi(string_enum = "snake_case")]
pub enum Tier {
    Library,
    Feed,
}

#[napi(string_enum = "snake_case")]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
}

// Every sortable column is a verb plus `_at`, so the shared `At` suffix the
// lint reports is the naming rule rather than noise the variants could drop.
#[allow(clippy::enum_variant_names)]
#[napi(string_enum = "snake_case")]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
}

#[napi(string_enum = "snake_case")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[napi(string_enum = "snake_case")]
pub enum Hydration {
    Never,
    InProgress,
    Complete,
    Expired,
}

#[napi(object)]
pub struct Item {
    pub id: String,
    #[napi(js_name = "type")]
    pub type_: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: serde_json::Value,
    pub state: ItemState,
    pub tier: Option<Tier>,
    pub version: i64,
    pub schema_version: i64,
    pub source: String,
    pub source_id: Option<String>,
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

#[napi(object)]
pub struct Edge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: serde_json::Value,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Narrowing for a search: the state rule a list takes, a type with its
/// subtree, tags, a listing-grammar expression and `beneath`, each read as
/// the list reads it.
#[napi(object)]
#[derive(Default)]
pub struct SearchFilters {
    pub state: Option<ItemState>,
    pub all_states: Option<bool>,
    #[napi(js_name = "type")]
    pub type_: Option<String>,
    pub tags: Option<Vec<String>>,
    /// An expression in the server's listing grammar, answered as the server
    /// answers `filter` and refused `validation_error` where it refuses it.
    /// A `backref` condition is refused `invalid`.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, as far as the copy holds them.
    pub beneath: Option<String>,
}

/// Narrowing for a list. Leaving `state` unset answers the active state, as
/// the server does; `allStates` lifts that, and a named state wins.
#[napi(object)]
#[derive(Default)]
pub struct ListFilters {
    #[napi(js_name = "type")]
    pub type_: Option<String>,
    pub state: Option<ItemState>,
    pub all_states: Option<bool>,
    pub tier: Option<Tier>,
    pub tags: Option<Vec<String>>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the server
    /// answers `filter` and refused `validation_error` where it refuses it.
    /// A `backref` condition is refused `invalid`.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, as far as the copy holds them.
    pub beneath: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[napi(object)]
pub struct Sort {
    pub field: SortField,
    pub direction: SortDirection,
}

#[napi(object)]
pub struct SearchHit {
    pub item: Item,
    /// Higher is a better match.
    pub score: f64,
    pub snippet: String,
}

#[napi(object)]
pub struct HydrateReport {
    pub types: Vec<String>,
    pub tier: Tier,
    pub edge_types: Vec<String>,
    pub items: i64,
    pub edges: i64,
    pub pages: i64,
    pub cursor: String,
}

/// What a pin or an unpin answers.
#[napi(object)]
pub struct PinReport {
    /// Whether the row is pinned now.
    pub pinned: bool,
    /// Whether it was pinned before the call.
    pub was_pinned: bool,
}

#[napi(object)]
pub struct CatchUpReport {
    pub applied: i64,
    pub skipped: i64,
    pub cursor: String,
    pub reached_head: bool,
}

#[napi(object)]
pub struct Status {
    pub server_origin: Option<String>,
    /// The instance the copy was hydrated from.
    pub instance_id: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
    pub slice_edge_types: Vec<String>,
    pub pinned: Vec<String>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: i64,
    pub edges: i64,
    /// Moves each time a refresh changes the catalog; absent where the copy
    /// has never held one.
    pub catalog_version: Option<i64>,
}

/// A field of an item type, or a property of an edge type.
#[napi(object)]
pub struct TypeField {
    pub name: String,
    /// The field's own type, such as `string` or `thumbnail`.
    #[napi(js_name = "type")]
    pub type_: String,
    pub required: bool,
    pub description: Option<String>,
    /// The type that declares it: the type itself, or the nearest one it
    /// inherits the field from.
    pub declared_by: String,
    /// The definition whole, as the server answers it.
    #[napi(ts_type = "Record<string, unknown>")]
    pub definition: serde_json::Value,
}

/// An item type as the copy holds it, with the fields it inherits.
#[napi(object)]
pub struct ItemType {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub parent: Option<String>,
    pub version: i64,
    pub fields: Vec<TypeField>,
    pub title_field: Option<String>,
    pub body_field: Option<String>,
    pub link_field: Option<String>,
    pub roles: Vec<String>,
    pub compatible_with: Vec<String>,
}

/// The end of an edge whose file writes it.
#[napi(string_enum = "snake_case")]
pub enum EdgeEnd {
    Source,
    Target,
}

/// An edge type as the copy holds it.
#[napi(object)]
pub struct EdgeType {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub cardinality: String,
    /// The name the edge goes by read from its target.
    pub reverse_name: Option<String>,
    pub written_at: EdgeEnd,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    pub properties: Vec<TypeField>,
    pub shipped: bool,
}

fn type_field(field: marfa_core::TypeField) -> TypeField {
    TypeField {
        name: field.name,
        type_: field.r#type,
        required: field.required,
        description: field.description,
        declared_by: field.declared_by,
        definition: field.definition,
    }
}

fn item_type(held: marfa_core::ItemType) -> ItemType {
    ItemType {
        id: held.id,
        label: held.label,
        description: held.description,
        parent: held.parent,
        version: held.version,
        fields: held.fields.into_iter().map(type_field).collect(),
        title_field: held.title_field,
        body_field: held.body_field,
        link_field: held.link_field,
        roles: held.roles,
        compatible_with: held.compatible_with,
    }
}

fn edge_type(held: marfa_core::EdgeType) -> EdgeType {
    EdgeType {
        id: held.id,
        label: held.label,
        description: held.description,
        cardinality: held.cardinality,
        reverse_name: held.reverse_name,
        written_at: match held.written_at {
            marfa_core::End::Source => EdgeEnd::Source,
            marfa_core::End::Target => EdgeEnd::Target,
        },
        source_type_constraints: held.source_type_constraints,
        target_type_constraints: held.target_type_constraints,
        cascade_on_delete: held.cascade_on_delete,
        properties: held.properties.into_iter().map(type_field).collect(),
        shipped: held.shipped,
    }
}

/// The kinds of write a queue holds.
#[napi(string_enum = "snake_case")]
pub enum WriteKind {
    CreateItem,
    UpdateItem,
    DeleteItem,
    RestoreItem,
    TransitionItem,
    CreateEdge,
    UpdateEdge,
    DeleteEdge,
    ReplaceMetadata,
    MergeMetadata,
    AddTag,
    RemoveTag,
    WriteExtension,
    DeleteExtension,
    UploadBlob,
}

/// Why a `blocked` write has stopped.
#[napi(string_enum = "snake_case")]
pub enum BlockedReason {
    CredentialRefused,
    KeySpent,
    AncestorUnavailable,
    ConflictUnresolved,
    AwaitingDependency,
}

/// Which handle this process holds on the store.
#[napi(string_enum = "snake_case")]
pub enum Handle {
    Writer,
    Reader,
}

/// What the server made of a write: one of six, and absent while the write
/// is unanswered.
#[napi(discriminant = "verdict", discriminant_case = "camelCase")]
pub enum Verdict {
    Accepted,
    /// The server applied the write over changes made since, field by field.
    Merged {
        fields: Vec<String>,
    },
    /// The server kept its own value and wrote the losing one to a sibling.
    Conflicted {
        sibling_id: String,
        fields: Vec<String>,
    },
    /// The refusal read into its parts.
    Refused {
        refusal: Refusal,
    },
    /// Stopped until something outside the queue changes. A write held
    /// behind another that has no answer yet is not blocked: it has no
    /// verdict, and its `waiting` says so.
    Blocked {
        reason: BlockedReason,
        refusal: Option<Refusal>,
    },
    /// Refused until the ceiling; released by id. The row's `answer` holds
    /// the last answer it got.
    Dead,
}

/// Why the server, or the drain for a write it never sent, refused a write.
#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    /// The server's code verbatim, or the sentence naming the write this one
    /// waited on where that write was refused.
    pub reason: String,
    /// The code in the server's envelope, where the server refused it.
    pub code: Option<String>,
    pub message: Option<String>,
    /// Each property the server would not take, and why.
    pub fields: Vec<FieldRefusal>,
    /// The row the write named is in the bin, and can be restored.
    pub trashed: bool,
    /// The permission the credential's key lacks, where the refusal names one.
    pub grant: Option<MissingGrant>,
}

#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct FieldRefusal {
    pub field: String,
    pub message: String,
}

#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct MissingGrant {
    pub kind: GrantKind,
    /// The type or edge type id, or the extension namespace.
    pub name: String,
    pub level: GrantLevel,
}

/// What a missing grant is on.
#[napi(string_enum = "snake_case")]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GrantKind {
    Type,
    EdgeType,
    Extension,
}

#[napi(string_enum = "snake_case")]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GrantLevel {
    Read,
    Write,
}

/// A create, before it is queued.
#[napi(object)]
pub struct Draft {
    #[napi(js_name = "type")]
    pub type_: String,
    pub id: Option<String>,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: Option<serde_json::Value>,
    /// Each queued as a write of its own, waiting on the create.
    pub tags: Option<Vec<String>>,
    pub tier: Option<Tier>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub occurred_at: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves a row the server holds.
    pub base_version: Option<i64>,
}

/// A change to an item, and the version it was read at.
#[napi(object)]
pub struct Edit {
    /// Whole field values; a device never merges inside a field.
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: serde_json::Value,
    /// Required: an update naming no version is refused before it is sent.
    pub base_version: Option<i64>,
    /// The natural key to move the row to.
    pub source_id: Option<String>,
}

/// An edge, before it is queued.
#[napi(object)]
pub struct EdgeDraft {
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: Option<serde_json::Value>,
    pub id: Option<String>,
}

/// A change to an edge's properties, and the version it was read at.
#[napi(object)]
pub struct EdgeEdit {
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: serde_json::Value,
    pub base_version: Option<i64>,
}

/// One queued write and what became of it.
#[napi(object)]
pub struct QueuedWrite {
    pub id: String,
    pub kind: WriteKind,
    pub item_id: Option<String>,
    pub target_id: Option<String>,
    pub edge_id: Option<String>,
    pub namespace: Option<String>,
    pub tag: Option<String>,
    /// The blob an upload carries, by its hash.
    pub blob: Option<String>,
    pub base_version: Option<i64>,
    pub idempotency_key: String,
    /// The writes this one cannot go without, and is refused with.
    pub depends_on: Vec<String>,
    /// The write ahead of this one to the same row or edge, which it goes
    /// out after and is not refused with.
    pub follows: Option<String>,
    /// Absent while the server has not answered it.
    pub verdict: Option<Verdict>,
    /// Held behind a write that has no answer yet: `depends_on` and
    /// `follows` say which.
    pub waiting: bool,
    /// The body the write sends, or sent: a refused write's content stays
    /// readable here until it is discarded.
    #[napi(ts_type = "Record<string, unknown>")]
    pub body: serde_json::Value,
    /// The server's answer, whole, as it arrived.
    pub answer: Option<String>,
    pub refusals: i64,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

/// How a file is attached. Every field has a default: the MIME type from the
/// file's extension, the title from its name, the type from the MIME type.
#[napi(object)]
#[derive(Default)]
pub struct Attachment {
    pub mime_type: Option<String>,
    pub title: Option<String>,
    #[napi(js_name = "type")]
    pub r#type: Option<String>,
    pub tier: Option<Tier>,
}

/// The three writes an attachment is, in the order they go out.
#[napi(object)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
}

/// What became of one write a drain answered, sent or not.
#[napi(object)]
pub struct DrainVerdict {
    pub id: String,
    pub kind: WriteKind,
    /// An edge write's source; otherwise the row written to.
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub verdict: Option<Verdict>,
    pub refusals: i64,
    /// The server answered from its record of this idempotency key rather
    /// than writing again.
    pub replayed: bool,
}

/// What a drain did.
#[napi(object)]
pub struct DrainReport {
    /// Writes the server answered this drain, whatever it answered.
    pub answered: i64,
    pub held: i64,
    /// Writes it could not deliver, each still waiting, uncounted, for the
    /// next drain.
    pub undelivered: i64,
    /// Writes it gave a verdict without sending them: refused for a write
    /// they waited on or for bytes no longer held, or settled by another
    /// write's answer.
    pub unsent: i64,
    /// Writes whose request could not be made: each is counted against its
    /// write and waits for the next drain, or is dead at the ceiling. The
    /// writes a refused credential parks are counted in `stopped`.
    pub unmade: i64,
    /// Why the drain ended before the queue was through: the server could
    /// not be reached, failed, or asked to be left alone for a while.
    pub unavailable: Option<String>,
    pub verdicts: Vec<DrainVerdict>,
    /// Why the drain stopped: the server refused the credential, and every
    /// write waits until it is replaced.
    pub stopped: Option<String>,
    /// The sources the server said this credential's key does not claim,
    /// where a create naming one was refused for it: every create naming
    /// one is blocked `credential_refused` until the key claims it.
    pub unclaimed_sources: Vec<String>,
    pub retry_after_seconds: Option<i64>,
}

impl From<Tier> for marfa_core::Tier {
    fn from(tier: Tier) -> Self {
        match tier {
            Tier::Library => marfa_core::Tier::Library,
            Tier::Feed => marfa_core::Tier::Feed,
        }
    }
}

impl From<marfa_core::Tier> for Tier {
    fn from(tier: marfa_core::Tier) -> Self {
        match tier {
            marfa_core::Tier::Library => Tier::Library,
            marfa_core::Tier::Feed => Tier::Feed,
        }
    }
}

impl From<ItemState> for marfa_core::ItemState {
    fn from(state: ItemState) -> Self {
        match state {
            ItemState::Active => marfa_core::ItemState::Active,
            ItemState::Archived => marfa_core::ItemState::Archived,
            ItemState::Trashed => marfa_core::ItemState::Trashed,
            ItemState::Revoked => marfa_core::ItemState::Revoked,
        }
    }
}

impl From<marfa_core::ItemState> for ItemState {
    fn from(state: marfa_core::ItemState) -> Self {
        match state {
            marfa_core::ItemState::Active => ItemState::Active,
            marfa_core::ItemState::Archived => ItemState::Archived,
            marfa_core::ItemState::Trashed => ItemState::Trashed,
            marfa_core::ItemState::Revoked => ItemState::Revoked,
        }
    }
}

impl From<marfa_core::Hydration> for Hydration {
    fn from(hydration: marfa_core::Hydration) -> Self {
        match hydration {
            marfa_core::Hydration::Never => Hydration::Never,
            marfa_core::Hydration::InProgress => Hydration::InProgress,
            marfa_core::Hydration::Complete => Hydration::Complete,
            marfa_core::Hydration::Expired => Hydration::Expired,
        }
    }
}

impl From<marfa_core::WriteKind> for WriteKind {
    fn from(kind: marfa_core::WriteKind) -> Self {
        use marfa_core::WriteKind as K;
        match kind {
            K::CreateItem => WriteKind::CreateItem,
            K::UpdateItem => WriteKind::UpdateItem,
            K::DeleteItem => WriteKind::DeleteItem,
            K::RestoreItem => WriteKind::RestoreItem,
            K::TransitionItem => WriteKind::TransitionItem,
            K::CreateEdge => WriteKind::CreateEdge,
            K::UpdateEdge => WriteKind::UpdateEdge,
            K::DeleteEdge => WriteKind::DeleteEdge,
            K::ReplaceMetadata => WriteKind::ReplaceMetadata,
            K::MergeMetadata => WriteKind::MergeMetadata,
            K::AddTag => WriteKind::AddTag,
            K::RemoveTag => WriteKind::RemoveTag,
            K::WriteExtension => WriteKind::WriteExtension,
            K::DeleteExtension => WriteKind::DeleteExtension,
            K::UploadBlob => WriteKind::UploadBlob,
        }
    }
}

impl From<marfa_core::BlockedReason> for BlockedReason {
    fn from(reason: marfa_core::BlockedReason) -> Self {
        use marfa_core::BlockedReason as R;
        match reason {
            R::CredentialRefused => BlockedReason::CredentialRefused,
            R::KeySpent => BlockedReason::KeySpent,
            R::AncestorUnavailable => BlockedReason::AncestorUnavailable,
            R::ConflictUnresolved => BlockedReason::ConflictUnresolved,
            R::AwaitingDependency => BlockedReason::AwaitingDependency,
        }
    }
}

impl From<BlockedReason> for marfa_core::BlockedReason {
    fn from(reason: BlockedReason) -> Self {
        use marfa_core::BlockedReason as R;
        match reason {
            BlockedReason::CredentialRefused => R::CredentialRefused,
            BlockedReason::KeySpent => R::KeySpent,
            BlockedReason::AncestorUnavailable => R::AncestorUnavailable,
            BlockedReason::ConflictUnresolved => R::ConflictUnresolved,
            BlockedReason::AwaitingDependency => R::AwaitingDependency,
        }
    }
}

impl From<SearchFilters> for marfa_core::SearchFilters {
    fn from(filters: SearchFilters) -> Self {
        marfa_core::SearchFilters {
            state: filters.state.map(Into::into),
            all_states: filters.all_states.unwrap_or(false),
            r#type: filters.type_,
            tags: filters.tags.unwrap_or_default(),
            filter: filters.filter,
            beneath: filters.beneath,
        }
    }
}

impl From<marfa_core::Refusal> for Refusal {
    fn from(refusal: marfa_core::Refusal) -> Self {
        Refusal {
            reason: refusal.reason,
            code: refusal.code,
            message: refusal.message,
            fields: refusal
                .fields
                .into_iter()
                .map(|field| FieldRefusal {
                    field: field.field,
                    message: field.message,
                })
                .collect(),
            trashed: refusal.trashed,
            grant: refusal.grant.map(|grant| MissingGrant {
                kind: match grant.kind {
                    marfa_core::GrantKind::Type => GrantKind::Type,
                    marfa_core::GrantKind::EdgeType => GrantKind::EdgeType,
                    marfa_core::GrantKind::Extension => GrantKind::Extension,
                },
                name: grant.name,
                level: match grant.level {
                    marfa_core::GrantLevel::Read => GrantLevel::Read,
                    marfa_core::GrantLevel::Write => GrantLevel::Write,
                },
            }),
        }
    }
}

/// The verdict, and whether the write waits behind another instead.
fn crossed(outcome: Option<marfa_core::Outcome>) -> (Option<Verdict>, bool) {
    use marfa_core::Outcome as O;
    let verdict = match outcome {
        None => return (None, false),
        Some(O::Waiting) => return (None, true),
        Some(O::Accepted) => Verdict::Accepted,
        Some(O::Merged { fields }) => Verdict::Merged { fields },
        Some(O::Conflicted { sibling_id, fields }) => Verdict::Conflicted { sibling_id, fields },
        Some(O::Refused(refusal)) => Verdict::Refused {
            refusal: refusal.into(),
        },
        Some(O::Blocked { reason, refusal }) => Verdict::Blocked {
            reason: reason.into(),
            refusal: refusal.map(Into::into),
        },
        Some(O::Dead) => Verdict::Dead,
    };
    (Some(verdict), false)
}

fn queued(write: marfa_core::QueuedWrite) -> Result<QueuedWrite> {
    let (verdict, waiting) = crossed(write.outcome().map_err(failure)?);
    Ok(QueuedWrite {
        verdict,
        waiting,
        body: write.body,
        id: write.id,
        kind: write.kind.into(),
        item_id: write.item_id,
        target_id: write.target_id,
        edge_id: write.edge_id,
        namespace: write.namespace,
        tag: write.tag,
        blob: write.blob,
        base_version: write.base_version,
        idempotency_key: write.idempotency_key,
        depends_on: write.depends_on,
        follows: write.follows,
        answer: write.answer,
        refusals: write.refusals,
        queued_at: write.queued_at,
        answered_at: write.answered_at,
    })
}

fn drained(report: marfa_core::DrainReport) -> Result<DrainReport> {
    let mut verdicts = Vec::with_capacity(report.verdicts.len());
    for entry in report.verdicts {
        verdicts.push(DrainVerdict {
            verdict: crossed(entry.outcome().map_err(failure)?).0,
            id: entry.id,
            kind: entry.kind.into(),
            item_id: entry.item_id,
            edge_id: entry.edge_id,
            refusals: entry.refusals,
            replayed: entry.replayed,
        });
    }
    Ok(DrainReport {
        answered: count(report.answered as u64),
        held: count(report.held as u64),
        undelivered: count(report.undelivered as u64),
        unsent: count(report.unsent as u64),
        unmade: count(report.unmade as u64),
        unavailable: report.unavailable,
        verdicts,
        stopped: report.stopped,
        unclaimed_sources: report.unclaimed_sources,
        retry_after_seconds: report.retry_after_seconds.map(count),
    })
}

fn object(value: Option<serde_json::Value>) -> Result<serde_json::Map<String, serde_json::Value>> {
    match value {
        None => Ok(serde_json::Map::new()),
        Some(serde_json::Value::Object(map)) => Ok(map),
        Some(_) => Err(Error::new(
            napi::Status::InvalidArg,
            "invalid: properties must be an object",
        )),
    }
}

fn count(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn item(item: marfa_core::Item) -> Item {
    Item {
        id: item.id,
        type_: item.r#type,
        properties: serde_json::Value::Object(item.properties),
        state: item.state.into(),
        tier: item.tier.map(Into::into),
        version: item.version,
        schema_version: item.schema_version,
        source: item.source,
        source_id: item.source_id,
        occurred_at: item.occurred_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        tags: item.tags,
    }
}

fn edge(edge: marfa_core::Edge) -> Edge {
    Edge {
        id: edge.id,
        source_id: edge.source_id,
        target_id: edge.target_id,
        edge_type: edge.edge_type,
        properties: serde_json::Value::Object(edge.properties),
        version: edge.version,
        created_at: edge.created_at,
        updated_at: edge.updated_at,
    }
}

fn filters(filters: Option<ListFilters>) -> marfa_core::ListFilters {
    let filters = filters.unwrap_or_default();
    marfa_core::ListFilters {
        r#type: filters.type_,
        state: filters.state.map(Into::into),
        all_states: filters.all_states.unwrap_or(false),
        tier: filters.tier.map(Into::into),
        tags: filters.tags.unwrap_or_default(),
        occurred_after: filters.occurred_after,
        occurred_before: filters.occurred_before,
        filter: filters.filter,
        beneath: filters.beneath,
        limit: filters.limit,
        offset: filters.offset,
    }
}

fn sort(sort: Option<Sort>) -> marfa_core::Sort {
    match sort {
        None => marfa_core::Sort::default(),
        Some(sort) => marfa_core::Sort {
            field: match sort.field {
                SortField::CreatedAt => marfa_core::SortField::CreatedAt,
                SortField::UpdatedAt => marfa_core::SortField::UpdatedAt,
                SortField::OccurredAt => marfa_core::SortField::OccurredAt,
            },
            direction: match sort.direction {
                SortDirection::Asc => marfa_core::SortDirection::Ascending,
                SortDirection::Desc => marfa_core::SortDirection::Descending,
            },
        },
    }
}

/// A core error as a JS error whose message starts with the variant's code,
/// `not_found: …`, `wrong_server: …`; the code cannot ride on `code`, which
/// napi reserves for its own status.
fn failure(error: marfa_core::CoreError) -> Error {
    use marfa_core::CoreError as E;
    if let E::RenewalFailed(cause) = error {
        return failure(*cause);
    }
    let (code, detail) = match &error {
        E::RenewalFailed(_) => unreachable!("renewal cause was unwrapped"),
        E::NotFound { code, message, .. } => {
            ("not_found", server_detail("not_found", Some(code), message))
        }
        E::Unauthorized { code, message, .. } => (
            "unauthorized",
            server_detail("unauthorized", Some(code), message),
        ),
        E::Forbidden { code, message, .. } => {
            ("forbidden", server_detail("forbidden", Some(code), message))
        }
        E::Validation { code, message, .. } => (
            "validation",
            server_detail("validation", Some(code), message),
        ),
        E::UnknownType { message } => {
            ("unknown_type", server_detail("unknown_type", None, message))
        }
        E::RateLimited { code, message, .. } => (
            "rate_limited",
            server_detail("rate_limited", Some(code), message),
        ),
        E::Server {
            status,
            code,
            message,
        } => ("server", format!("answered {status} ({code}): {message}")),
        E::Io(message) => ("io", message.clone()),
        E::Network(message) => ("network", message.clone()),
        E::Unnamed { .. } => ("unnamed_answer", error.to_string()),
        E::Decoding(message) => ("decoding", message.clone()),
        E::Store(message) => ("store", message.clone()),
        E::Redirected { .. } => ("redirect", error.to_string()),
        E::StorageFull(message) => ("storage_full", message.clone()),
        E::SignedOut { .. } => ("signed_out", error.to_string()),
        E::NoKeychain(message) => ("no_keychain", message.clone()),
        E::NoServer => ("no_server", error.to_string()),
        E::NoCursor => ("no_cursor", error.to_string()),
        E::HydrationIncomplete => ("hydration_incomplete", error.to_string()),
        E::NoCatalog => ("no_catalog", error.to_string()),
        E::WrongSchema { .. } => ("wrong_schema", error.to_string()),
        E::ReadingHandle => ("reading_handle", error.to_string()),
        E::CopyExpired { .. } => ("copy_expired", error.to_string()),
        E::StreamIncomplete { .. } => ("stream_incomplete", error.to_string()),
        E::WrongServer { .. } => ("wrong_server", error.to_string()),
        E::BytesAbsent { .. } => ("bytes_absent", error.to_string()),
        E::ContractMismatch { .. } => ("contract_mismatch", error.to_string()),
        E::Invalid(message) => ("invalid", message.clone()),
    };
    Error::new(napi::Status::GenericFailure, format!("{code}: {detail}"))
}

fn server_detail(kind: &str, code: Option<&str>, message: &str) -> String {
    let human = kind.replace('_', " ");
    let prefix = format!("{human}:");
    let message = if message.to_lowercase().starts_with(&prefix) {
        message[prefix.len()..].trim_start()
    } else {
        message
    };
    match code.filter(|code| *code != kind) {
        Some(code) if message.is_empty() => format!("({code})"),
        Some(code) => format!("({code}) {message}"),
        None => message.into(),
    }
}

/// An item's thumbnail: the image's type and its bytes.
#[napi(object)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Buffer,
}

/// What a held stream changed in the copy: an event it applied, named by the
/// event's type with the item or edge it was about, or `catalog.changed`,
/// naming neither, where a stream it opened read a catalog that differs from
/// the one held. Or what became of the server: `server.unreachable`, with
/// `reason`, once when a stream cannot be had, and `server.reachable` once
/// when one is had again, which is when to drain what waited. `cursor` is
/// the cursor held after it.
#[napi(object)]
pub struct Change {
    pub event: String,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
    pub reason: Option<String>,
}

enum Told {
    Change(Change),
    End(Option<String>),
}

/// A held stream, stopped by `stop` or by being collected. The follow ends
/// within a quarter second of either, and `onEnd` is called once it has.
#[napi]
pub struct Subscription {
    stop: Arc<AtomicBool>,
}

#[napi]
impl Subscription {
    #[napi]
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The follow's thread holds the core, and with it the writer's claim on
/// the store, so a subscription nobody holds any more must end it. Node
/// drops it when it is collected and when its environment is torn down, a
/// worker's included, so either ends the follow.
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// A local copy of a slice of one server.
#[napi]
pub struct MarfaCore {
    inner: Arc<marfa_core::Core>,
}

pub struct Hydrate {
    core: Arc<marfa_core::Core>,
    types: Vec<String>,
    tier: marfa_core::Tier,
    edge_types: Vec<String>,
}

#[napi]
impl Task for Hydrate {
    type Output = marfa_core::HydrateReport;
    type JsValue = HydrateReport;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .hydrate_with(&self.types, self.tier, &self.edge_types)
            .map_err(failure)
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(HydrateReport {
            types: report.types,
            tier: report.tier.into(),
            edge_types: report.edge_types,
            items: count(report.items),
            edges: count(report.edges),
            pages: count(report.pages),
            cursor: report.cursor,
        })
    }
}

pub struct Pin {
    core: Arc<marfa_core::Core>,
    id: String,
}

#[napi]
impl Task for Pin {
    type Output = bool;
    type JsValue = PinReport;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.pin(&self.id).map_err(failure)
    }

    fn resolve(&mut self, _: Env, was_pinned: Self::Output) -> Result<Self::JsValue> {
        Ok(PinReport {
            pinned: true,
            was_pinned,
        })
    }
}

pub struct CatchUp {
    core: Arc<marfa_core::Core>,
}

#[napi]
impl Task for CatchUp {
    type Output = marfa_core::CatchUpReport;
    type JsValue = CatchUpReport;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.catch_up().map_err(failure)
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(CatchUpReport {
            applied: count(report.applied),
            skipped: count(report.skipped),
            cursor: report.cursor,
            reached_head: report.reached_head,
        })
    }
}

pub struct Drain {
    core: Arc<marfa_core::Core>,
}

pub struct PutBlob {
    core: Arc<marfa_core::Core>,
    path: String,
    mime_type: Option<String>,
}

#[napi]
impl Task for PutBlob {
    type Output = marfa_core::QueuedWrite;
    type JsValue = QueuedWrite;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .put_blob(std::path::Path::new(&self.path), self.mime_type.as_deref())
            .map_err(failure)
    }

    fn resolve(&mut self, _: Env, write: Self::Output) -> Result<Self::JsValue> {
        queued(write)
    }
}

pub struct Attach {
    core: Arc<marfa_core::Core>,
    id: String,
    path: String,
    attachment: marfa_core::Attachment,
}

#[napi]
impl Task for Attach {
    type Output = marfa_core::Attached;
    type JsValue = Attached;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .attach(&self.id, std::path::Path::new(&self.path), &self.attachment)
            .map_err(failure)
    }

    fn resolve(&mut self, _: Env, attached: Self::Output) -> Result<Self::JsValue> {
        Ok(Attached {
            upload: queued(attached.upload)?,
            item: queued(attached.item)?,
            edge: queued(attached.edge)?,
        })
    }
}

pub struct FetchBlob {
    core: Arc<marfa_core::Core>,
    hash: String,
}

#[napi]
impl Task for FetchBlob {
    type Output = std::path::PathBuf;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.blob(&self.hash).map_err(failure)
    }

    fn resolve(&mut self, _: Env, path: Self::Output) -> Result<Self::JsValue> {
        Ok(path.to_string_lossy().into_owned())
    }
}

#[napi]
impl Task for Drain {
    type Output = marfa_core::DrainReport;
    type JsValue = DrainReport;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.drain().map_err(failure)
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        drained(report)
    }
}

#[napi]
impl MarfaCore {
    /// Opens a store another process writes, to read it only: never the
    /// writer, never a write, and a path with no store is refused.
    #[napi(factory)]
    pub fn open_reader(path: String) -> Result<MarfaCore> {
        let core = marfa_core::Core::open_reader(path).map_err(failure)?;
        Ok(MarfaCore {
            inner: Arc::new(core),
        })
    }

    /// A number that moves each time another process saves to the store.
    #[napi]
    pub fn data_version(&self) -> Result<i64> {
        self.inner.data_version().map_err(failure)
    }

    /// Holds the event stream open on a thread of its own and applies each
    /// event as it arrives: `onChange` for each change, then `onEnd` once,
    /// with the error that ended it or null where it was stopped. Neither
    /// callback keeps the process alive. An `onChange` that throws ends the
    /// follow, and `onEnd` is told what it threw, as `listener_threw: …`.
    #[napi]
    pub fn follow(
        &self,
        env: Env,
        on_change: Function<Change, ()>,
        on_end: Function<Option<String>, ()>,
    ) -> Result<Subscription> {
        let stop = Arc::new(AtomicBool::new(false));
        let on_change = on_change.create_ref()?;
        let on_end = on_end.create_ref()?;
        let flag = Arc::clone(&stop);
        let mut threw: Option<String> = None;
        // One queue carries both callbacks, so `onEnd` runs after every
        // `onChange` sent before it; two would keep no order between them.
        // Its own function does nothing: each call is made here, where a
        // throw can be caught.
        let tell = env
            .create_function_from_closure::<(), (), _>("follow", |_| Ok(()))?
            .build_threadsafe_function::<Told>()
            .callee_handled::<false>()
            .weak::<true>()
            .build_callback(move |context: ThreadsafeCallContext<Told>| {
                match context.value {
                    Told::Change(change) => {
                        if threw.is_none()
                            && let Err(thrown) = on_change.borrow_back(&context.env)?.call(change)
                        {
                            threw = Some(thrown.reason);
                            flag.store(true, Ordering::Relaxed);
                        }
                    }
                    Told::End(error) => {
                        let error = match threw.take() {
                            Some(thrown) => {
                                Some(format!("listener_threw: onChange threw {thrown}"))
                            }
                            None => error,
                        };
                        on_end.borrow_back(&context.env)?.call(error)?;
                    }
                }
                Ok(())
            })?;
        let flag = Arc::clone(&stop);
        let core = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            let result = core.follow(&flag, |change| {
                tell.call(
                    Told::Change(Change {
                        event: change.event.clone(),
                        item_id: change.item_id.clone(),
                        edge_id: change.edge_id.clone(),
                        cursor: change.cursor.clone(),
                        reason: change.reason.clone(),
                    }),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            });
            // Let go of the store before saying so: an `onEnd` that opens it
            // again must find the writer's role free.
            drop(core);
            tell.call(
                Told::End(result.err().map(|error| failure(error).reason)),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        });
        Ok(Subscription { stop })
    }

    /// Opens the file at `path`, creating it when absent. `url` and `key` go
    /// together; without them only local reads work.
    #[napi(factory)]
    pub fn open(path: String, url: Option<String>, key: Option<String>) -> Result<MarfaCore> {
        let server = match (url, key) {
            (Some(url), Some(key)) => Some(marfa_core::Server { url, key }),
            (None, None) => None,
            _ => {
                return Err(Error::new(
                    napi::Status::InvalidArg,
                    "url and key go together",
                ));
            }
        };
        let core = marfa_core::Core::open(path, server).map_err(failure)?;
        Ok(MarfaCore {
            inner: Arc::new(core),
        })
    }

    /// Replaces the local copy with the declared types at `tier`.
    #[napi]
    pub fn hydrate(&self, types: Vec<String>, tier: Tier) -> AsyncTask<Hydrate> {
        self.hydrate_with(types, tier, Vec::new())
    }

    /// A hydration that also holds every edge of `edgeTypes` the key reads,
    /// whichever ends the copy holds.
    #[napi]
    pub fn hydrate_with(
        &self,
        types: Vec<String>,
        tier: Tier,
        edge_types: Vec<String>,
    ) -> AsyncTask<Hydrate> {
        AsyncTask::new(Hydrate {
            core: Arc::clone(&self.inner),
            types,
            tier: tier.into(),
            edge_types,
        })
    }

    /// Holds one row by id whatever the slice says of it, read now.
    #[napi]
    pub fn pin(&self, id: String) -> AsyncTask<Pin> {
        AsyncTask::new(Pin {
            core: Arc::clone(&self.inner),
            id,
        })
    }

    /// Stops holding a row by id; one the slice does not take goes, unless
    /// writes to it still wait.
    #[napi]
    pub fn unpin(&self, id: String) -> Result<PinReport> {
        Ok(PinReport {
            pinned: false,
            was_pinned: self.inner.unpin(&id).map_err(failure)?,
        })
    }

    /// Applies every event since the stored cursor.
    #[napi]
    pub fn catch_up(&self) -> AsyncTask<CatchUp> {
        AsyncTask::new(CatchUp {
            core: Arc::clone(&self.inner),
        })
    }

    #[napi]
    pub fn list(&self, filters: Option<ListFilters>, sort: Option<Sort>) -> Result<Vec<Item>> {
        let items = self
            .inner
            .list(&self::filters(filters), self::sort(sort))
            .map_err(failure)?;
        Ok(items.into_iter().map(item).collect())
    }

    #[napi]
    pub fn get(&self, id: String) -> Result<Option<Item>> {
        Ok(self.inner.get(&id).map_err(failure)?.map(item))
    }

    #[napi]
    pub fn edges_from(&self, id: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_from(&id)
            .map_err(failure)?
            .into_iter()
            .map(edge)
            .collect())
    }

    #[napi]
    pub fn edges_to(&self, id: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_to(&id)
            .map_err(failure)?
            .into_iter()
            .map(edge)
            .collect())
    }

    #[napi]
    pub fn edges_of_type(&self, edge_type: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_of_type(&edge_type)
            .map_err(failure)?
            .into_iter()
            .map(edge)
            .collect())
    }

    #[napi]
    pub fn search(
        &self,
        query: String,
        filters: Option<SearchFilters>,
        limit: Option<u32>,
    ) -> Result<Vec<SearchHit>> {
        let filters = filters.unwrap_or_default();
        let hits = self
            .inner
            .search(&query, &filters.into(), limit.unwrap_or(20) as usize)
            .map_err(failure)?;
        Ok(hits
            .into_iter()
            .map(|hit| SearchHit {
                item: item(hit.item),
                score: hit.score,
                snippet: hit.snippet,
            })
            .collect())
    }

    #[napi]
    pub fn status(&self) -> Result<Status> {
        let status = self.inner.status().map_err(failure)?;
        Ok(Status {
            server_origin: status.server_origin,
            instance_id: status.instance_id,
            slice_types: status.slice_types,
            slice_tier: status.slice_tier.map(Into::into),
            slice_edge_types: status.slice_edge_types,
            pinned: status.pinned,
            event_cursor: status.event_cursor,
            hydration: status.hydration.into(),
            items: count(status.items),
            edges: count(status.edges),
            catalog_version: status.catalog_version.map(count),
        })
    }

    /// Every item type the copy holds, by id, read from the copy alone.
    #[napi]
    pub fn item_types(&self) -> Result<Vec<ItemType>> {
        Ok(self
            .inner
            .item_types()
            .map_err(failure)?
            .into_iter()
            .map(item_type)
            .collect())
    }

    /// `not_found` where the catalog holds no such type.
    #[napi]
    pub fn item_type(&self, id: String) -> Result<ItemType> {
        Ok(item_type(self.inner.item_type(&id).map_err(failure)?))
    }

    /// Every edge type the copy holds, by id, read from the copy alone.
    #[napi]
    pub fn edge_types(&self) -> Result<Vec<EdgeType>> {
        Ok(self
            .inner
            .edge_types()
            .map_err(failure)?
            .into_iter()
            .map(edge_type)
            .collect())
    }

    /// `not_found` where the catalog holds no such edge type.
    #[napi]
    pub fn edge_type(&self, id: String) -> Result<EdgeType> {
        Ok(edge_type(self.inner.edge_type(&id).map_err(failure)?))
    }

    /// Which handle this process holds: the one that may write, or a second
    /// opener that reads and refuses every write.
    #[napi]
    pub fn held_handle(&self) -> Handle {
        match self.inner.handle() {
            marfa_core::Handle::Writer => Handle::Writer,
            marfa_core::Handle::Reader => Handle::Reader,
        }
    }

    /// Writes a new item into the local copy and queues it for the server.
    #[napi]
    pub fn create_item(&self, draft: Draft) -> Result<QueuedWrite> {
        let draft = marfa_core::Draft {
            r#type: draft.type_,
            id: draft.id,
            properties: object(draft.properties)?,
            tags: draft.tags.unwrap_or_default(),
            tier: draft.tier.map(Into::into),
            source: draft.source,
            source_id: draft.source_id,
            occurred_at: draft.occurred_at,
            base_version: draft.base_version,
        };
        queued(self.inner.create_item(&draft).map_err(failure)?)
    }

    /// Changes an item in the local copy and queues the change.
    #[napi]
    pub fn update_item(&self, id: String, edit: Edit) -> Result<QueuedWrite> {
        let edit = marfa_core::Edit {
            properties: object(Some(edit.properties))?,
            base_version: edit.base_version,
            source_id: edit.source_id,
            ..Default::default()
        };
        queued(self.inner.update_item(&id, &edit).map_err(failure)?)
    }

    /// Changes an item in the local copy and queues the change, based on a
    /// version read before the one the copy holds now, which the server
    /// merges the change against.
    #[napi]
    pub fn update_item_as_read(&self, id: String, edit: Edit) -> Result<QueuedWrite> {
        let edit = marfa_core::Edit {
            properties: object(Some(edit.properties))?,
            base_version: edit.base_version,
            source_id: edit.source_id,
            ..Default::default()
        };
        queued(
            self.inner
                .update_item_as_read(&id, &edit)
                .map_err(failure)?,
        )
    }

    /// Moves an item to the bin locally and queues the delete.
    #[napi]
    pub fn delete_item(&self, id: String) -> Result<QueuedWrite> {
        queued(self.inner.delete_item(&id).map_err(failure)?)
    }

    /// Takes an item out of the bin locally and queues the restore.
    #[napi]
    pub fn restore_item(&self, id: String) -> Result<QueuedWrite> {
        queued(self.inner.restore_item(&id).map_err(failure)?)
    }

    /// Moves an item to another lifecycle state.
    #[napi]
    pub fn transition_item(&self, id: String, state: ItemState) -> Result<QueuedWrite> {
        queued(
            self.inner
                .transition_item(&id, state.into())
                .map_err(failure)?,
        )
    }

    /// Links two items. An edge is its own write.
    #[napi]
    pub fn create_edge(&self, draft: EdgeDraft) -> Result<QueuedWrite> {
        let draft = marfa_core::EdgeDraft {
            source_id: draft.source_id,
            target_id: draft.target_id,
            edge_type: draft.edge_type,
            properties: object(draft.properties)?,
            id: draft.id,
        };
        queued(self.inner.create_edge(&draft).map_err(failure)?)
    }

    #[napi]
    pub fn update_edge(&self, id: String, edit: EdgeEdit) -> Result<QueuedWrite> {
        let edit = marfa_core::EdgeEdit {
            properties: object(Some(edit.properties))?,
            base_version: edit.base_version,
            ..Default::default()
        };
        queued(self.inner.update_edge(&id, &edit).map_err(failure)?)
    }

    #[napi]
    pub fn delete_edge(&self, id: String) -> Result<QueuedWrite> {
        queued(self.inner.delete_edge(&id).map_err(failure)?)
    }

    /// Puts one tag on an item, as its own write.
    #[napi]
    pub fn add_tag(&self, id: String, tag: String) -> Result<QueuedWrite> {
        queued(self.inner.add_tag(&id, &tag).map_err(failure)?)
    }

    #[napi]
    pub fn remove_tag(&self, id: String, tag: String) -> Result<QueuedWrite> {
        queued(self.inner.remove_tag(&id, &tag).map_err(failure)?)
    }

    /// Writes the item's tags whole, dropping any not named.
    #[napi]
    pub fn replace_metadata(&self, id: String, tags: Vec<String>) -> Result<QueuedWrite> {
        let write = marfa_core::MetadataWrite { tags };
        queued(
            self.inner
                .write_metadata(&id, &write, true)
                .map_err(failure)?,
        )
    }

    /// Adds the named tags, leaving the rest.
    #[napi]
    pub fn merge_metadata(&self, id: String, tags: Vec<String>) -> Result<QueuedWrite> {
        let write = marfa_core::MetadataWrite { tags };
        queued(
            self.inner
                .write_metadata(&id, &write, false)
                .map_err(failure)?,
        )
    }

    /// Writes one extension namespace, as its own write.
    #[napi]
    pub fn write_extension(
        &self,
        id: String,
        namespace: String,
        #[napi(ts_arg_type = "Record<string, unknown>")] body: serde_json::Value,
    ) -> Result<QueuedWrite> {
        let body = serde_json::Value::Object(object(Some(body))?).to_string();
        queued(
            self.inner
                .write_extension(&id, &namespace, &body)
                .map_err(failure)?,
        )
    }

    #[napi]
    pub fn delete_extension(&self, id: String, namespace: String) -> Result<QueuedWrite> {
        queued(
            self.inner
                .delete_extension(&id, &namespace)
                .map_err(failure)?,
        )
    }

    /// Every queued write and what became of it.
    #[napi]
    pub fn queue(&self) -> Result<Vec<QueuedWrite>> {
        self.inner
            .queue()
            .map_err(failure)?
            .into_iter()
            .map(queued)
            .collect()
    }

    /// Sends what the queue holds and records what came back. One pass.
    #[napi]
    pub fn drain(&self) -> AsyncTask<Drain> {
        AsyncTask::new(Drain {
            core: Arc::clone(&self.inner),
        })
    }

    /// Holds a file's bytes beside the working copy and queues their upload.
    /// Off the JavaScript thread, because the whole file is copied and
    /// hashed.
    #[napi(ts_return_type = "Promise<QueuedWrite>")]
    pub fn put_blob(&self, path: String, mime_type: Option<String>) -> AsyncTask<PutBlob> {
        AsyncTask::new(PutBlob {
            core: Arc::clone(&self.inner),
            path,
            mime_type,
        })
    }

    /// Attaches a file to an item: its upload, a file item naming the bytes,
    /// and an `attached-to` edge, three queued writes. Off the JavaScript
    /// thread, for the reason `putBlob` is.
    #[napi(ts_return_type = "Promise<Attached>")]
    pub fn attach(
        &self,
        id: String,
        path: String,
        attachment: Option<Attachment>,
    ) -> AsyncTask<Attach> {
        let attachment = attachment.unwrap_or_default();
        AsyncTask::new(Attach {
            core: Arc::clone(&self.inner),
            id,
            path,
            attachment: marfa_core::Attachment {
                mime_type: attachment.mime_type,
                title: attachment.title,
                r#type: attachment.r#type,
                tier: attachment.tier.map(Into::into),
            },
        })
    }

    /// Where a blob's bytes are held, fetching them first where this store
    /// does not hold them yet. Refused `bytes_absent` where they can be
    /// neither read nor fetched.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn blob(&self, hash: String) -> AsyncTask<FetchBlob> {
        AsyncTask::new(FetchBlob {
            core: Arc::clone(&self.inner),
            hash,
        })
    }

    /// Whether a blob's bytes are held beside the store, with no request.
    #[napi]
    pub fn blob_held(&self, hash: String) -> Result<bool> {
        self.inner.blob_held(&hash).map_err(failure)
    }

    /// The thumbnail an item carries, from the copy with no request; null
    /// where its type declares none or it carries none. An item the copy does
    /// not hold throws `not_found` naming `not_held`, and a held value that is
    /// not a thumbnail throws `decoding` naming the item.
    #[napi]
    pub fn thumbnail(&self, id: String) -> Result<Option<Thumbnail>> {
        Ok(self
            .inner
            .thumbnail(&id)
            .map_err(failure)?
            .map(|thumbnail| Thumbnail {
                mime_type: thumbnail.mime_type,
                bytes: thumbnail.bytes.into(),
            }))
    }

    /// Sends a blocked or dead write again, under a fresh idempotency key.
    /// Answers whether the row was one a release applies to.
    #[napi]
    pub fn release(&self, id: String) -> Result<bool> {
        self.inner.release(&id).map_err(failure)
    }

    /// Releases every write blocked for one reason, and says how many.
    #[napi]
    pub fn release_reason(&self, reason: BlockedReason) -> Result<i64> {
        let released = self.inner.release_reason(reason.into()).map_err(failure)?;
        Ok(count(released as u64))
    }

    /// Takes a write blocked `ancestor_unavailable` or `conflict_unresolved`
    /// out of the queue, and puts the copy back to what the server holds;
    /// each write held for it is refused unsent. Answers whether the row was
    /// one a withdraw takes.
    #[napi]
    pub fn withdraw(&self, id: String) -> Result<bool> {
        self.inner.withdraw(&id).map_err(failure)
    }

    /// Clears the writes the server has answered, and says how many went. A
    /// refused write that carried content stays until it is discarded.
    #[napi]
    pub fn forget_answered(&self) -> Result<i64> {
        Ok(count(self.inner.forget_answered().map_err(failure)? as u64))
    }

    /// Takes a refused write out of the queue, with the content it carried.
    /// Answers whether the row was one a discard takes: refused, and with no
    /// write still waiting on it.
    #[napi]
    pub fn discard(&self, id: String) -> Result<bool> {
        self.inner.discard(&id).map_err(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_messages_keep_one_classification_and_distinct_detail_codes() {
        use marfa_core::CoreError as E;
        assert_eq!(
            failure(E::Unauthorized {
                code: "unauthorized".into(),
                message: "Authentication required".into()
            })
            .reason,
            "unauthorized: Authentication required"
        );
        assert_eq!(
            failure(E::UnknownType {
                message: "Unknown type: acme.absent".into()
            })
            .reason,
            "unknown_type: acme.absent"
        );
        assert_eq!(
            failure(E::Validation {
                code: "invalid_properties".into(),
                message: "read: Expected boolean".into()
            })
            .reason,
            "validation: (invalid_properties) read: Expected boolean"
        );
    }

    #[test]
    fn blocked_grant_crosses_without_losing_the_refusal() {
        let refusal = marfa_core::Refusal::read(
            "credential_refused",
            Some(
                r#"{"error":{"code":"type_not_permitted","message":"No write access","details":{"grant":{"kind":"type","name":"core.note","level":"write"}}}}"#,
            ),
        );
        let outcome = marfa_core::Outcome::of(
            Some(marfa_core::Verdict::Blocked),
            Some("credential_refused"),
            None,
            Vec::new(),
            Some(&refusal),
        )
        .unwrap();
        let (
            Some(Verdict::Blocked {
                refusal: Some(refusal),
                ..
            }),
            false,
        ) = crossed(outcome)
        else {
            panic!("the blocked grant lost its parsed refusal");
        };
        assert_eq!(refusal.code.as_deref(), Some("type_not_permitted"));
        assert_eq!(refusal.message.as_deref(), Some("No write access"));
        assert_eq!(
            refusal.grant,
            Some(MissingGrant {
                kind: GrantKind::Type,
                name: "core.note".into(),
                level: GrantLevel::Write
            })
        );
    }

    #[test]
    fn local_failures_cross_with_their_own_codes_through_renewal() {
        use marfa_core::CoreError as E;
        for (cause, code) in [
            (E::StorageFull("full".into()), "storage_full"),
            (
                E::SignedOut {
                    origin: "https://marfa.example".into(),
                },
                "signed_out",
            ),
            (E::NoKeychain("locked".into()), "no_keychain"),
            (E::Io("unavailable".into()), "io"),
            (
                E::Redirected {
                    origin: "https://marfa.example".into(),
                    status: 302,
                    location: None,
                },
                "redirect",
            ),
        ] {
            assert!(
                failure(E::RenewalFailed(Box::new(cause)))
                    .reason
                    .starts_with(&format!("{code}: "))
            );
        }
    }

    #[test]
    fn a_contract_refusal_crosses_under_its_own_code() {
        let error = failure(marfa_core::CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: Some("4".into()),
            expected: 3,
            status: Some(200),
            write_sent: false,
        });
        assert!(
            error.reason.starts_with("contract_mismatch: "),
            "{}",
            error.reason
        );
    }

    #[test]
    fn every_blocked_reason_crosses_as_itself_both_ways() {
        for reason in marfa_core::BlockedReason::ALL {
            let crossed: BlockedReason = reason.into();
            assert_eq!(marfa_core::BlockedReason::from(crossed), reason);
        }
    }

    #[test]
    fn every_outcome_crosses_with_what_it_carries() {
        use marfa_core::Outcome as O;
        assert!(matches!(crossed(None), (None, false)));
        assert!(matches!(
            crossed(Some(O::Accepted)),
            (Some(Verdict::Accepted), false)
        ));
        assert!(matches!(
            crossed(Some(O::Merged { fields: vec!["title".into()] })),
            (Some(Verdict::Merged { fields }), false) if fields == ["title"]
        ));
        assert!(matches!(
            crossed(Some(O::Conflicted { sibling_id: "s".into(), fields: vec!["body".into()] })),
            (Some(Verdict::Conflicted { sibling_id, fields }), false) if sibling_id == "s" && fields == ["body"]
        ));
        let refusal = marfa_core::Refusal::read(
            "item_not_found",
            Some(
                r#"{"error":{"code":"item_not_found","message":"gone","details":{"trashed":true,"grant":{"kind":"type","name":"core.note","level":"write"}}}}"#,
            ),
        );
        let (Some(Verdict::Refused { refusal }), false) = crossed(Some(O::Refused(refusal))) else {
            panic!("a refused outcome crossed as another verdict");
        };
        assert_eq!(refusal.code.as_deref(), Some("item_not_found"));
        assert!(refusal.trashed);
        assert_eq!(
            refusal.grant,
            Some(MissingGrant {
                kind: GrantKind::Type,
                name: "core.note".into(),
                level: GrantLevel::Write,
            })
        );
        for reason in marfa_core::BlockedReason::ALL {
            let (
                Some(Verdict::Blocked {
                    reason: crossed,
                    refusal: None,
                }),
                false,
            ) = crossed(Some(O::Blocked {
                reason,
                refusal: None,
            }))
            else {
                panic!("a blocked outcome crossed as another verdict");
            };
            assert_eq!(marfa_core::BlockedReason::from(crossed), reason);
        }
        assert!(
            matches!(crossed(Some(O::Waiting)), (None, true)),
            "a write held behind another crossed as a verdict"
        );
        assert!(matches!(
            crossed(Some(O::Dead)),
            (Some(Verdict::Dead), false)
        ));
    }

    #[test]
    fn list_filters_cross_whole() {
        let crossed = filters(Some(ListFilters {
            type_: Some("core.note".into()),
            state: Some(ItemState::Archived),
            all_states: Some(true),
            tier: Some(Tier::Feed),
            tags: Some(vec!["a".into()]),
            occurred_after: Some("after".into()),
            occurred_before: Some("before".into()),
            filter: Some("tags exists".into()),
            beneath: Some("root".into()),
            limit: Some(3),
            offset: Some(4),
        }));
        assert_eq!(
            crossed,
            marfa_core::ListFilters {
                r#type: Some("core.note".into()),
                state: Some(marfa_core::ItemState::Archived),
                all_states: true,
                tier: Some(marfa_core::Tier::Feed),
                tags: vec!["a".into()],
                occurred_after: Some("after".into()),
                occurred_before: Some("before".into()),
                filter: Some("tags exists".into()),
                beneath: Some("root".into()),
                limit: Some(3),
                offset: Some(4),
            }
        );
    }

    #[test]
    fn search_filters_cross_whole() {
        let crossed: marfa_core::SearchFilters = SearchFilters {
            state: Some(ItemState::Archived),
            all_states: Some(true),
            type_: Some("core.note".into()),
            tags: Some(vec!["a".into(), "b".into()]),
            filter: Some("tags exists".into()),
            beneath: Some("root".into()),
        }
        .into();
        assert_eq!(
            crossed,
            marfa_core::SearchFilters {
                state: Some(marfa_core::ItemState::Archived),
                all_states: true,
                r#type: Some("core.note".into()),
                tags: vec!["a".into(), "b".into()],
                filter: Some("tags exists".into()),
                beneath: Some("root".into()),
            }
        );
    }
}
