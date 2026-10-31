//! The Node-facing shape of `marfa_core`.

pub mod filters;
mod folders;
mod views;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[napi(string_enum = "snake_case")]
pub enum Tier {
    Library,
    Feed,
}

/// The tiers a slice holds: one, or `all` for both.
#[napi(string_enum = "snake_case")]
pub enum SliceTier {
    Library,
    Feed,
    All,
}

#[napi(string_enum = "snake_case")]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
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
    Stale,
}

/// Whether a local list or search was read from a whole copy; from one a
/// hydration is still filling, which holds only the rows that have arrived;
/// or from one the server's event log no longer reaches, which holds the rows
/// it held then, some since changed or gone on the server, until a hydration
/// has filled it again.
#[napi(string_enum = "snake_case")]
pub enum Completeness {
    Complete,
    Partial,
    Stale,
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
    /// Where it was captured, in degrees, as sent.
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    /// When it went to the bin; absent outside it.
    pub trashed_at: Option<String>,
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

/// Narrowing for a search: the states and types a list takes, tags, a
/// listing-grammar expression and `beneath`, each read as the list reads it.
#[napi(object)]
#[derive(Default)]
pub struct SearchFilters {
    /// The states to answer; unset answers the active state. An empty list
    /// is refused, and so is a list beside `allStates`.
    pub states: Option<Vec<ItemState>>,
    pub all_states: Option<bool>,
    /// The types to answer, each with its subtree: up to ten. An empty list
    /// is refused.
    pub types: Option<Vec<String>>,
    /// One tier; unset answers both.
    pub tier: Option<Tier>,
    pub tags: Option<Vec<String>>,
    /// Exclusive lower bound on the item's own time. Either end alone works.
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time.
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the server
    /// answers `filter` and refused `validation_error` where it refuses it.
    /// A `backref` condition is refused `invalid`.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, as far as the copy holds them.
    pub beneath: Option<String>,
}

/// Narrowing for a list. Leaving `states` unset answers the active state, as
/// the server does; `allStates` lifts that. An empty `states` or `types` is
/// refused, as is `states` beside `allStates` and more than ten types.
#[napi(object)]
#[derive(Default)]
pub struct ListFilters {
    pub types: Option<Vec<String>>,
    pub states: Option<Vec<ItemState>>,
    pub all_states: Option<bool>,
    pub tier: Option<Tier>,
    pub tags: Option<Vec<String>>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    /// Only the items stamped with this source.
    pub source: Option<String>,
    /// Inclusive lower bound on the time the item was last changed. The list
    /// is then ordered by that time and id, oldest first, and a `sort` whose
    /// field or direction names another order is refused `validation_error`.
    pub updated_after: Option<String>,
    /// Exclusive upper bound on the time the item was last changed.
    pub updated_before: Option<String>,
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
    /// The server's own names: `created_at`, `updated_at`, `occurred_at` or
    /// `properties.<name>`, the name `a` to `z`, `0` to `9` and `_`. A
    /// property orders numbers and booleans (`false` before `true`) first,
    /// then text, with items lacking it last in either direction; ties go by
    /// id, oldest first. Left out, `created_at`, or `updated_at` beside
    /// `updatedAfter`.
    #[napi(ts_type = "\"created_at\" | \"updated_at\" | \"occurred_at\" | `properties.${string}`")]
    pub field: Option<String>,
    /// Left out, descending, or ascending beside `updatedAfter`.
    pub direction: Option<SortDirection>,
}

#[napi(object)]
pub struct SearchHit {
    pub item: Item,
    /// Higher is a better match.
    pub score: f64,
    /// An excerpt as HTML: the text escaped and each match in `<mark>` tags.
    pub snippet: String,
}

/// The items a local list answers, and whether the copy was whole.
#[napi(object)]
pub struct Listing {
    pub items: Vec<Item>,
    pub completeness: Completeness,
}

/// The hits a local search answers, best match first, and whether the copy
/// was whole.
#[napi(object)]
pub struct Found {
    pub hits: Vec<SearchHit>,
    pub completeness: Completeness,
}

#[napi(object)]
pub struct HydrateReport {
    pub types: Vec<String>,
    pub tier: SliceTier,
    pub edge_types: Vec<String>,
    pub items: i64,
    pub edges: i64,
    /// The listing pages this call read, those of a walk it then started
    /// again from the first page included.
    pub pages: i64,
    /// The listing pages the hydration read in all, those of the interrupted
    /// calls it resumed included.
    pub pages_total: i64,
    /// Whether this call carried on from the page an interrupted hydration
    /// of the same slice had reached.
    pub resumed: bool,
    /// Why an interrupted hydration was filled again from the first page
    /// rather than resumed, such as `slice_changed` or `head_aged_out`.
    pub restarted: Option<String>,
    /// Whether the copy was filled again over the rows it held, which it
    /// answered marked stale meanwhile, rather than cleared first: so it is
    /// filled when the event log let its cursor go and the instance, the reach
    /// and the slice are those it was built under.
    pub in_place: bool,
    pub cursor: String,
    /// Types the app declared that the instance did not hold and now does.
    pub registered_types: Vec<String>,
    /// Declared types the instance did not hold and would not take.
    pub unregistered_types: Vec<UnregisteredType>,
    /// Declared `app.*` types the instance held in another definition and now
    /// holds as declared.
    pub replaced_types: Vec<String>,
    /// Declared `app.*` types the instance holds in another definition and
    /// would not replace; they stay as the server holds them.
    pub unreplaced_types: Vec<UnregisteredType>,
}

/// A declared type the instance refused to register or to replace, and why.
#[napi(object)]
pub struct UnregisteredType {
    pub id: String,
    /// The server's code for the refusal.
    pub code: String,
    pub message: String,
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
    /// The catch-up changed the catalog the copy holds. A catch-up that
    /// fails says the same on its error, as `catalogChanged`.
    pub catalog_changed: bool,
}

/// How the cache of fetched files chooses its budget.
#[napi(string_enum = "snake_case")]
pub enum FileBudgetKind {
    /// The larger of 2 GiB and a tenth of the volume, held to what leaves a
    /// twentieth of the volume free and never below 256 MiB.
    Default,
    /// `bytes` bytes.
    Bytes,
    /// No budget: every file fetched stays.
    KeepAll,
}

#[napi(object)]
pub struct FileBudget {
    pub kind: FileBudgetKind,
    /// The byte count, for `bytes` alone: a whole number from zero to
    /// `Number.MAX_SAFE_INTEGER`.
    pub bytes: Option<f64>,
}

/// The cache of fetched files as the state report gives it.
#[napi(object)]
pub struct FileCache {
    /// What was chosen.
    pub setting: FileBudget,
    /// The budget in force, in bytes; null while every file fetched is kept.
    pub budget: Option<i64>,
    /// The bytes of the files kept now; null where the cache could not be
    /// read.
    pub held: Option<i64>,
    /// Why `held` is unknown; absent when it is known.
    pub held_unreadable: Option<String>,
    /// The default budget is 2 GiB because the disk could not be read.
    pub volume_unreadable: bool,
    /// Why the files fetched last could not be kept out of backups; absent
    /// once a fetched file is marked.
    pub backup_mark_failure: Option<String>,
    /// The files attached to items the copy holds, which stay on the device
    /// outside the budget; absent from the start of a hydration until one
    /// completes, for a folder's copy, and where the cache could not be read.
    pub attachments: Option<Attachments>,
}

/// Why an attachment's bytes are not held.
#[napi(string_enum = "snake_case")]
pub enum NotHeldReason {
    /// No fetch of them has been asked for since they became an attachment.
    NotFetched,
    /// The volume had no room for them, or for an attachment before them in
    /// the same fetch.
    NoRoom,
    /// The server, or the link it gave, could not be reached, or the link
    /// stopped sending part way.
    Unreachable,
    /// The server asked for a wait longer than a fetch of attachments
    /// makes, before them or an attachment before them in the same fetch.
    RateLimited,
    /// The server holds no bytes by that hash.
    Absent,
    /// The fetch failed otherwise.
    Failed,
    /// The edge is held but its file item is not.
    NotInCopy,
}

/// The attachments not held for one reason.
#[napi(object)]
pub struct NotHeld {
    pub reason: NotHeldReason,
    pub attachments: i64,
    /// The bytes they state, counted once for files that share them.
    pub bytes: i64,
    /// How many of them state no size, so add nothing to `bytes`.
    pub unstated: i64,
}

/// The files attached to items the copy holds.
#[napi(object)]
pub struct Attachments {
    /// The file items whose bytes the cache holds whole.
    pub held: i64,
    /// Their bytes, counted once for files that share them.
    pub held_bytes: i64,
    /// The bytes of partial files of attachments.
    pub partial_bytes: i64,
    /// The attachments whose bytes the cache does not hold whole.
    pub not_held: i64,
    /// The bytes they state, counted once for files that share them.
    pub not_held_bytes: i64,
    pub not_held_by_reason: Vec<NotHeld>,
}

/// What a fetch of the attachments did.
#[napi(object)]
pub struct KeptFetch {
    /// The files whose bytes it fetched, counted once for files that share
    /// them.
    pub fetched: i64,
    pub fetched_bytes: i64,
    /// The attachments after it, as the state report gives them.
    pub attachments: Option<Attachments>,
}

#[napi(object)]
pub struct Status {
    pub server_origin: Option<String>,
    /// The instance the copy was hydrated from.
    pub instance_id: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<SliceTier>,
    pub slice_edge_types: Vec<String>,
    pub pinned: Vec<String>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: i64,
    /// While a hydration fills the copy, how many items its slice held on the
    /// server when it started; absent where the server did not count them.
    pub items_expected: Option<i64>,
    /// While a hydration fills the copy, how many rows its listings have
    /// brought, the figure to set against `items_expected`.
    pub items_listed: Option<i64>,
    pub edges: i64,
    /// Moves each time a refresh changes the catalog; absent where the copy
    /// has never held one.
    pub catalog_version: Option<i64>,
    pub file_cache: FileCache,
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
    /// The Iconify icon ID, `<set>:<name>`, such as `lucide:book-open`.
    pub icon: Option<String>,
    pub link_field: Option<String>,
    pub roles: Vec<String>,
    pub compatible_with: Vec<String>,
}

/// One end of an edge.
#[napi(string_enum = "snake_case")]
pub enum EdgeEnd {
    Source,
    Target,
}

/// Which end of an edge has the file that writes it in a folder, or neither.
#[napi(string_enum = "snake_case")]
pub enum EdgeWrittenAt {
    Source,
    Target,
    None,
}

/// An edge type as the copy holds it.
#[napi(object)]
pub struct EdgeType {
    pub id: String,
    /// The name shown on the source end.
    pub label: String,
    /// The name shown on the target end.
    pub reverse_label: String,
    pub description: Option<String>,
    pub cardinality: String,
    /// The name the edge goes by read from its target.
    pub reverse_name: Option<String>,
    pub written_at: EdgeWrittenAt,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    pub properties: Vec<TypeField>,
    pub shipped: bool,
}

/// An item to name and preview: its type and properties.
#[napi(object)]
pub struct ItemDisplayInput {
    #[napi(js_name = "type")]
    pub type_: String,
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: Option<serde_json::Value>,
}

/// How a device shows an item: its name and a line of preview text, each
/// null where the item has nothing to show.
#[napi(object)]
pub struct ItemDisplay {
    pub name: Option<String>,
    pub preview: Option<String>,
}

/// A server's two catalogs as it lists them now.
#[napi(object)]
pub struct ServerCatalog {
    /// By id.
    pub item_types: Vec<ItemType>,
    /// By id.
    pub edge_types: Vec<EdgeType>,
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
        icon: held.icon,
        link_field: held.link_field,
        roles: held.roles,
        compatible_with: held.compatible_with,
    }
}

fn edge_type(held: marfa_core::EdgeType) -> EdgeType {
    EdgeType {
        id: held.id,
        label: held.label,
        reverse_label: held.reverse_label,
        description: held.description,
        cardinality: held.cardinality,
        reverse_name: held.reverse_name,
        written_at: match held.written_at {
            marfa_core::WrittenAt::Source => EdgeWrittenAt::Source,
            marfa_core::WrittenAt::Target => EdgeWrittenAt::Target,
            marfa_core::WrittenAt::None => EdgeWrittenAt::None,
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
    /// The write keeps meeting an environmental failure while the server
    /// answers other writes.
    FailingAlone,
    /// The write was queued against an instance other than the one the copy
    /// has been built from since, and is sent only once released.
    InstanceChanged,
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
    /// The state to create it in; unset, active. `revoked` is refused.
    pub state: Option<ItemState>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub occurred_at: Option<String>,
    /// Where it was captured, in degrees. Both or neither.
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    /// Edge type to the ids of the items it points at. They are queued and
    /// sent with the create as one write: if the server refuses any, it makes
    /// none, and the create stays in the queue as refused.
    #[napi(ts_type = "Record<string, string[]>")]
    pub edges: Option<std::collections::HashMap<String, Vec<String>>>,
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
    /// When the item's content happened.
    pub occurred_at: Option<String>,
    /// Gives the item no time of its own again, so it is its creation time.
    /// Refused beside `occurredAt`.
    pub clear_occurred_at: Option<bool>,
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

/// A change to an edge's properties, a move of one of its ends, or both,
/// and the version it was read at.
#[napi(object)]
pub struct EdgeEdit {
    #[napi(ts_type = "Record<string, unknown>")]
    pub properties: serde_json::Value,
    pub base_version: Option<i64>,
    pub moves: Option<EdgeMove>,
}

/// The end an edge edit moves, and the item it moves it to.
#[napi(object)]
pub struct EdgeMove {
    pub end: EdgeEnd,
    pub to: String,
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
    /// The drains in a row in which the write met an environmental failure.
    pub environmental_streak: i64,
    /// What the write last met when the failure was environmental.
    pub last_failure: Option<LastFailure>,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

/// What a write met that was no answer to it: the HTTP status, absent where
/// nothing answered, and the start of the answer's body when it is text.
#[napi(object)]
pub struct LastFailure {
    pub status: Option<u32>,
    pub text: Option<String>,
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

/// The three writes an attachment is, in the order they go out, and the
/// text that embeds the file in the item's body.
#[napi(object)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
    /// `![[title]]`; absent where the file's title cannot name it alone
    /// among the item's attachments.
    pub embed: Option<String>,
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

impl From<SliceTier> for marfa_core::SliceTier {
    fn from(tier: SliceTier) -> Self {
        match tier {
            SliceTier::Library => marfa_core::SliceTier::Library,
            SliceTier::Feed => marfa_core::SliceTier::Feed,
            SliceTier::All => marfa_core::SliceTier::All,
        }
    }
}

impl From<marfa_core::SliceTier> for SliceTier {
    fn from(tier: marfa_core::SliceTier) -> Self {
        match tier {
            marfa_core::SliceTier::Library => SliceTier::Library,
            marfa_core::SliceTier::Feed => SliceTier::Feed,
            marfa_core::SliceTier::All => SliceTier::All,
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
            marfa_core::Hydration::Stale => Hydration::Stale,
        }
    }
}

impl From<marfa_core::FileBudget> for FileBudget {
    fn from(budget: marfa_core::FileBudget) -> Self {
        match budget {
            marfa_core::FileBudget::Default => FileBudget {
                kind: FileBudgetKind::Default,
                bytes: None,
            },
            marfa_core::FileBudget::Bytes(bytes) => FileBudget {
                kind: FileBudgetKind::Bytes,
                bytes: Some(count(bytes) as f64),
            },
            marfa_core::FileBudget::KeepAll => FileBudget {
                kind: FileBudgetKind::KeepAll,
                bytes: None,
            },
        }
    }
}

impl From<marfa_core::FileCache> for FileCache {
    fn from(cache: marfa_core::FileCache) -> Self {
        FileCache {
            setting: cache.setting.into(),
            budget: cache.budget.map(count),
            held: cache.held.map(count),
            held_unreadable: cache.held_unreadable,
            volume_unreadable: cache.volume_unreadable,
            backup_mark_failure: cache.backup_mark_failure,
            attachments: cache.attachments.map(Into::into),
        }
    }
}

impl From<marfa_core::NotHeldReason> for NotHeldReason {
    fn from(reason: marfa_core::NotHeldReason) -> Self {
        use marfa_core::NotHeldReason as Why;
        match reason {
            Why::NotFetched => NotHeldReason::NotFetched,
            Why::NoRoom => NotHeldReason::NoRoom,
            Why::Unreachable => NotHeldReason::Unreachable,
            Why::RateLimited => NotHeldReason::RateLimited,
            Why::Absent => NotHeldReason::Absent,
            Why::Failed => NotHeldReason::Failed,
            Why::NotInCopy => NotHeldReason::NotInCopy,
        }
    }
}

impl From<marfa_core::Attachments> for Attachments {
    fn from(found: marfa_core::Attachments) -> Self {
        Attachments {
            held: count(found.held),
            held_bytes: count(found.held_bytes),
            partial_bytes: count(found.partial_bytes),
            not_held: count(found.not_held),
            not_held_bytes: count(found.not_held_bytes),
            not_held_by_reason: found
                .not_held_by_reason
                .into_iter()
                .map(|group| NotHeld {
                    reason: group.reason.into(),
                    attachments: count(group.attachments),
                    bytes: count(group.bytes),
                    unstated: count(group.unstated),
                })
                .collect(),
        }
    }
}

/// The largest whole number a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl TryFrom<FileBudget> for marfa_core::FileBudget {
    type Error = marfa_core::CoreError;

    /// Checked as a JavaScript number, before any conversion: napi's integer
    /// conversion truncates a fraction and reads NaN and infinity as zero.
    fn try_from(budget: FileBudget) -> std::result::Result<Self, Self::Error> {
        match (budget.kind, budget.bytes) {
            (FileBudgetKind::Default, None) => Ok(marfa_core::FileBudget::Default),
            (FileBudgetKind::KeepAll, None) => Ok(marfa_core::FileBudget::KeepAll),
            (FileBudgetKind::Bytes, Some(bytes))
                if bytes.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&bytes) =>
            {
                Ok(marfa_core::FileBudget::Bytes(bytes as u64))
            }
            _ => Err(marfa_core::CoreError::Invalid(
                "a file budget is `default` or `keep_all` with no bytes, or `bytes` with a whole count from 0 to Number.MAX_SAFE_INTEGER".to_string(),
            )),
        }
    }
}

impl From<marfa_core::Completeness> for Completeness {
    fn from(completeness: marfa_core::Completeness) -> Self {
        match completeness {
            marfa_core::Completeness::Complete => Completeness::Complete,
            marfa_core::Completeness::Partial => Completeness::Partial,
            marfa_core::Completeness::Stale => Completeness::Stale,
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
            R::FailingAlone => BlockedReason::FailingAlone,
            R::InstanceChanged => BlockedReason::InstanceChanged,
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
            BlockedReason::FailingAlone => R::FailingAlone,
            BlockedReason::InstanceChanged => R::InstanceChanged,
        }
    }
}

impl From<SearchFilters> for marfa_core::SearchFilters {
    fn from(filters: SearchFilters) -> Self {
        marfa_core::SearchFilters {
            states: filters
                .states
                .map(|states| states.into_iter().map(Into::into).collect()),
            all_states: filters.all_states.unwrap_or(false),
            types: filters.types,
            tier: filters.tier.map(Into::into),
            tags: filters.tags.unwrap_or_default(),
            occurred_after: filters.occurred_after,
            occurred_before: filters.occurred_before,
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

fn queued(env: Env, write: marfa_core::QueuedWrite) -> Result<QueuedWrite> {
    let (verdict, waiting) = crossed(write.outcome().map_err(|error| failure(env, error))?);
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
        environmental_streak: write.environmental_streak,
        last_failure: write.last_failure.map(|failure| LastFailure {
            status: failure.status.map(u32::from),
            text: failure.text,
        }),
        queued_at: write.queued_at,
        answered_at: write.answered_at,
    })
}

fn drained(env: Env, report: marfa_core::DrainReport) -> Result<DrainReport> {
    report_of(report).map_err(|error| failure(env, error))
}

fn report_of(
    report: marfa_core::DrainReport,
) -> std::result::Result<DrainReport, marfa_core::CoreError> {
    let mut verdicts = Vec::with_capacity(report.verdicts.len());
    for entry in report.verdicts {
        verdicts.push(DrainVerdict {
            verdict: crossed(entry.outcome()?).0,
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

/// A link in a text, as `linkParts` reads it. Every position is a range of
/// UTF-16 code units in the text, as a JavaScript string counts them.
#[napi(object)]
pub struct LinkParts {
    /// As it appears in the text, brackets included.
    pub text: String,
    pub start: i64,
    pub end: i64,
    /// The text between the brackets, trimmed: what the link is bound by and
    /// what `linkCandidates` takes.
    pub target: String,
    /// What the link names. Empty for a link to a heading of the same text.
    pub name: LinkPart,
    pub heading: Option<LinkPart>,
    pub alias: Option<LinkPart>,
}

/// One part of a link, trimmed, and where it sits in the text.
#[napi(object)]
pub struct LinkPart {
    pub text: String,
    pub start: i64,
    pub end: i64,
}

/// Whether a link names one item.
#[napi(string_enum = "snake_case")]
pub enum LinkState {
    /// Saving the link in the item's body would make its edge to `item`.
    Bound,
    /// More than one item the copy holds answers to it.
    Ambiguous,
    /// No item, or one the copy cannot tell is the only one, since it holds a
    /// slice: the server's lookup decides.
    Unresolved,
}

/// The items a link could name, from the copy alone.
#[napi(object)]
pub struct LinkCandidates {
    /// The link's text between its brackets, as asked.
    pub target: String,
    pub state: LinkState,
    /// The item it names, where `state` is `bound`.
    pub item: Option<String>,
    /// Every item outside the bin the copy holds that answers to the link's
    /// name, by id, title or file path, without regard to case or Unicode
    /// form; and the bound item.
    pub candidates: Vec<String>,
}

fn link_part(part: marfa_core::LinkPart) -> LinkPart {
    LinkPart {
        text: part.text,
        start: count(part.start),
        end: count(part.end),
    }
}

/// Every link in `text` in order, repeats included, split as Marfa reads it,
/// with each part's place in the text. Needs no store.
#[napi]
pub fn link_parts(text: String) -> Vec<LinkParts> {
    marfa_core::link_parts(&text)
        .into_iter()
        .map(|link| LinkParts {
            text: link.text,
            start: count(link.start),
            end: count(link.end),
            target: link.target,
            name: link_part(link.name),
            heading: link.heading.map(link_part),
            alias: link.alias.map(link_part),
        })
        .collect()
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
        capture_latitude: item.capture_latitude,
        capture_longitude: item.capture_longitude,
        trashed_at: item.trashed_at,
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

fn edit_of(edit: Edit) -> Result<marfa_core::Edit> {
    Ok(marfa_core::Edit {
        properties: object(Some(edit.properties))?,
        base_version: edit.base_version,
        source_id: edit.source_id,
        occurred_at: edit.occurred_at,
        clear_occurred_at: edit.clear_occurred_at.unwrap_or(false),
        ..Default::default()
    })
}

fn filters(filters: Option<ListFilters>) -> marfa_core::ListFilters {
    let filters = filters.unwrap_or_default();
    marfa_core::ListFilters {
        types: filters.types,
        states: filters
            .states
            .map(|states| states.into_iter().map(Into::into).collect()),
        all_states: filters.all_states.unwrap_or(false),
        tier: filters.tier.map(Into::into),
        tags: filters.tags.unwrap_or_default(),
        occurred_after: filters.occurred_after,
        occurred_before: filters.occurred_before,
        source: filters.source,
        updated_after: filters.updated_after,
        updated_before: filters.updated_before,
        filter: filters.filter,
        beneath: filters.beneath,
        limit: filters.limit,
        offset: filters.offset,
    }
}

/// Unset, the core's own order for `filters`.
fn sort(
    env: Env,
    sort: Option<Sort>,
    filters: &marfa_core::ListFilters,
) -> Result<Option<marfa_core::Sort>> {
    let Some(sort) = sort else {
        return Ok(None);
    };
    let field = sort
        .field
        .map(|field| field.parse().map_err(|error| failure(env, error)))
        .transpose()?;
    let direction = sort.direction.map(|direction| match direction {
        SortDirection::Asc => marfa_core::SortDirection::Ascending,
        SortDirection::Desc => marfa_core::SortDirection::Descending,
    });
    Ok(marfa_core::Sort::named(field, direction, filters))
}

fn server_of(url: Option<String>, key: Option<String>) -> Result<Option<marfa_core::Server>> {
    match (url, key) {
        (Some(url), Some(key)) => Ok(Some(marfa_core::Server { url, key })),
        (None, None) => Ok(None),
        _ => Err(Error::new(
            napi::Status::InvalidArg,
            "url and key go together",
        )),
    }
}

/// A core error as a JS error. The message starts with the error's code,
/// `not_found: …`, `wrong_server: …`, and the error carries what the Swift
/// binding's carries as properties: `code`, the core's own name for it, and
/// whichever of `serverCode`, `status`, `retryAfterSeconds`, `origin`,
/// `location`, `path`, `reason`, `unsent`, `agreed`, `expected`, `got`,
/// `served`, `writeSent` and `hash` it has.
fn failure(env: Env, error: marfa_core::CoreError) -> Error {
    match error_value(&env, &error) {
        Ok(thrown) => Error::from(thrown),
        Err(failed) => failed,
    }
}

/// The JS error `failure` throws, for a callback that is handed one.
fn error_value<'env>(env: &'env Env, error: &marfa_core::CoreError) -> Result<Unknown<'env>> {
    error_object(env, error)?.into_unknown(env)
}

fn error_object<'env>(env: &'env Env, error: &marfa_core::CoreError) -> Result<Object<'env>> {
    let (message, fields) = describe(error);
    let mut thrown = env.create_error(Error::new(napi::Status::GenericFailure, message))?;
    // The core's name replaces napi's own status in `code`.
    thrown.set_named_property("code", error.code())?;
    for (name, value) in fields {
        thrown.set_named_property(name, value)?;
    }
    Ok(thrown)
}

/// In `compute`, on a thread that cannot make a JS value: the core's error is
/// kept for `reject`, which can, and the plain message goes meanwhile.
fn record(slot: &mut Option<marfa_core::CoreError>, error: marfa_core::CoreError) -> Error {
    let plain = Error::new(napi::Status::GenericFailure, describe(&error).0);
    *slot = Some(error);
    plain
}

fn rethrown(env: Env, recorded: Option<marfa_core::CoreError>, plain: Error) -> Error {
    match recorded {
        Some(error) => failure(env, error),
        None => plain,
    }
}

/// The message of a core error, and the fields that ride on the error beside it.
fn describe(error: &marfa_core::CoreError) -> (String, Vec<(&'static str, serde_json::Value)>) {
    use marfa_core::CoreError as E;
    use serde_json::json;
    if let E::RenewalFailed(cause) = error {
        return describe(cause);
    }
    let code = error.code();
    let detail = match error {
        E::RenewalFailed(_) => unreachable!("renewal cause was unwrapped"),
        E::NotFound { code, message }
        | E::Unauthorized { code, message }
        | E::Forbidden { code, message }
        | E::Validation { code, message }
        | E::RateLimited { code, message, .. } => server_detail(error.code(), Some(code), message),
        E::UnknownType { message } => server_detail(error.code(), None, message),
        E::Server {
            status,
            code,
            message,
            ..
        } => format!("answered {status} ({code}): {message}"),
        E::Io(message)
        | E::Network(message)
        | E::Decoding(message)
        | E::Store(message)
        | E::StorageFull(message)
        | E::NoKeychain(message)
        | E::Invalid(message) => message.clone(),
        E::Unnamed { .. }
        | E::Redirected { .. }
        | E::SignedOut { .. }
        | E::NoServer
        | E::NoCursor
        | E::HydrationIncomplete
        | E::NoCatalog
        | E::WrongSchema { .. }
        | E::UnsentDiffers { .. }
        | E::ReadingHandle
        | E::CopyExpired { .. }
        | E::StreamIncomplete { .. }
        | E::WrongServer { .. }
        | E::BytesAbsent { .. }
        | E::NoRoom { .. }
        | E::ContractMismatch { .. }
        | E::FirstSyncWaiting
        | E::Canceled => error.to_string(),
    };
    let fields = match error {
        E::NotFound { code, .. }
        | E::Unauthorized { code, .. }
        | E::Forbidden { code, .. }
        | E::Validation { code, .. } => vec![("serverCode", json!(code))],
        E::UnknownType { .. } => vec![("serverCode", json!("unknown_type"))],
        E::RateLimited {
            code,
            retry_after_seconds,
            ..
        } => vec![
            ("serverCode", json!(code)),
            ("status", json!(429)),
            ("retryAfterSeconds", json!(retry_after_seconds)),
        ],
        E::Server { status, code, .. } => {
            vec![("status", json!(status)), ("serverCode", json!(code))]
        }
        E::Unnamed {
            origin,
            status,
            retry_after_seconds,
        } => vec![
            ("origin", json!(origin)),
            ("status", json!(status)),
            ("retryAfterSeconds", json!(retry_after_seconds)),
        ],
        E::Redirected {
            origin,
            status,
            location,
        } => vec![
            ("origin", json!(origin)),
            ("status", json!(status)),
            ("location", json!(location)),
        ],
        E::SignedOut { origin } => vec![("origin", json!(origin))],
        E::WrongSchema {
            path,
            reason,
            unsent,
            ..
        } => vec![
            ("path", json!(path)),
            ("reason", json!(reason)),
            ("unsent", json!(unsent)),
        ],
        E::UnsentDiffers {
            path,
            unsent,
            agreed,
        } => vec![
            ("path", json!(path)),
            ("unsent", json!(unsent)),
            ("agreed", json!(agreed)),
        ],
        E::CopyExpired { reason } | E::StreamIncomplete { reason } => {
            vec![("reason", json!(reason))]
        }
        E::WrongServer { expected, got } => {
            vec![("expected", json!(expected)), ("got", json!(got))]
        }
        E::BytesAbsent { hash, reason } => {
            vec![("hash", json!(hash)), ("reason", json!(reason))]
        }
        E::NoRoom { hash, size, free } => {
            vec![
                ("hash", json!(hash)),
                ("size", json!(size)),
                ("free", json!(free)),
            ]
        }
        E::ContractMismatch {
            origin,
            served,
            expected,
            status,
            write_sent,
        } => vec![
            ("origin", json!(origin)),
            ("served", json!(served)),
            ("expected", json!(expected)),
            ("status", json!(status)),
            ("writeSent", json!(write_sent)),
        ],
        E::RenewalFailed(_)
        | E::Io(_)
        | E::Network(_)
        | E::Decoding(_)
        | E::Store(_)
        | E::StorageFull(_)
        | E::NoKeychain(_)
        | E::NoServer
        | E::NoCursor
        | E::HydrationIncomplete
        | E::NoCatalog
        | E::ReadingHandle
        | E::FirstSyncWaiting
        | E::Canceled
        | E::Invalid(_) => Vec::new(),
    };
    (format!("{code}: {detail}"), fields)
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

/// What a held stream changed in the copy, what became of the server, or
/// what became of the queue it drained then, told apart by `kind`; and, from
/// a watch only, a save or a failure. `cursor` is the cursor held after it.
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum Change {
    /// An event the stream applied, by the event's type, with the item or
    /// edge it was about.
    Applied {
        event: String,
        item_id: Option<String>,
        edge_id: Option<String>,
        cursor: String,
    },
    /// A stream it opened read a catalog that differs from the one held.
    CatalogChanged { cursor: String },
    /// No stream can be had, for `reason`; told once until one is had again.
    ServerUnreachable { reason: String, cursor: String },
    /// A stream is had again. Where a drain has work queued, the follow
    /// drains once and tells `queueDrained` or `queueNotDrained`.
    ServerReachable { cursor: String },
    /// The queue was drained once a stream was had again, and what that
    /// drain did, as `drain` returns it.
    QueueDrained { report: DrainReport, cursor: String },
    /// The drain started once a stream was had again ended with an error:
    /// `code` is the same word a thrown error carries, and `reason` its
    /// message. The answers it had recorded stay recorded.
    QueueNotDrained {
        code: String,
        reason: String,
        cursor: String,
    },
    /// Told by a watch of a reading handle: another process saved to the
    /// store, which now has this data version.
    Saved { data_version: i64, cursor: String },
    /// Told by a watch, once, when what feeds it fails: `code` is the same
    /// word a thrown error carries, and `reason` its message. A follow that
    /// failed holds no stream until the next hydration or catch-up; a reading
    /// handle's reads go on, and the first that works is told as `saved`.
    WatchFailed {
        code: String,
        reason: String,
        cursor: String,
    },
}

impl From<&marfa_core::Change> for Change {
    fn from(change: &marfa_core::Change) -> Self {
        let cursor = change.cursor.clone();
        match &change.event {
            marfa_core::ChangeEvent::Applied(event) => Change::Applied {
                event: event.clone(),
                item_id: change.item_id.clone(),
                edge_id: change.edge_id.clone(),
                cursor,
            },
            marfa_core::ChangeEvent::CatalogChanged => Change::CatalogChanged { cursor },
            marfa_core::ChangeEvent::ServerUnreachable(reason) => Change::ServerUnreachable {
                reason: reason.to_string(),
                cursor,
            },
            marfa_core::ChangeEvent::ServerReachable => Change::ServerReachable { cursor },
            marfa_core::ChangeEvent::QueueDrained(report) => match report_of(report.clone()) {
                Ok(report) => Change::QueueDrained { report, cursor },
                // A report whose verdict cannot be read is told as a drain
                // that failed with that error.
                Err(error) => not_drained(&error, cursor),
            },
            marfa_core::ChangeEvent::QueueNotDrained(error) => not_drained(error, cursor),
            marfa_core::ChangeEvent::Saved(data_version) => Change::Saved {
                data_version: *data_version,
                cursor,
            },
            marfa_core::ChangeEvent::WatchFailed(error) => Change::WatchFailed {
                code: error.code().to_string(),
                reason: error.to_string(),
                cursor,
            },
        }
    }
}

fn not_drained(error: &marfa_core::CoreError, cursor: String) -> Change {
    Change::QueueNotDrained {
        code: error.code().to_string(),
        reason: error.to_string(),
        cursor,
    }
}

enum Told {
    Change(Change),
    End(Option<marfa_core::CoreError>),
}

/// A held stream or a place in a store's watch, stopped by `stop` or by being
/// collected. A follow ends within a quarter second of either, and `onEnd` is
/// called once it has.
#[napi]
pub struct Subscription {
    ending: Ending,
}

enum Ending {
    Flag(Arc<AtomicBool>),
    Listening(Arc<marfa_core::Listening>),
}

#[napi]
impl Subscription {
    #[napi]
    pub fn stop(&self) {
        match &self.ending {
            Ending::Flag(stop) => stop.store(true, Ordering::Relaxed),
            Ending::Listening(listening) => listening.stop(),
        }
    }
}

/// The follow's thread holds the core, and with it the writer's claim on
/// the store, so a subscription nobody holds any more must end it. Node
/// drops it when it is collected and when its environment is torn down, a
/// worker's included, so either ends the follow. A place in a watch is
/// left the same way.
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Both callbacks of a listener on one queue, so `onEnd` runs after every
/// `onChange` sent before it; two would keep no order between them. Its own
/// function does nothing: each call is made here, where a throw can be caught
/// and `stop` called, and `onEnd` is then given an error whose `code` is
/// `listener_threw`. Neither callback keeps the process alive.
fn told_by(
    env: Env,
    on_change: Function<Change, ()>,
    on_end: Function<Option<Unknown<'static>>, ()>,
    stop: impl Fn() + Send + 'static,
) -> Result<impl Fn(Told) + Send + Sync + 'static> {
    let on_change = on_change.create_ref()?;
    let on_end = on_end.create_ref()?;
    let mut threw: Option<String> = None;
    let tell = env
        .create_function_from_closure::<(), (), _>("listener", |_| Ok(()))?
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
                        stop();
                    }
                }
                Told::End(error) => {
                    let env = &context.env;
                    let error = match (threw.take(), error) {
                        (Some(thrown), _) => {
                            let mut made = env.create_error(Error::new(
                                napi::Status::GenericFailure,
                                format!("listener_threw: onChange threw {thrown}"),
                            ))?;
                            made.set_named_property("code", "listener_threw")?;
                            Some(made.into_unknown(env)?)
                        }
                        (None, Some(error)) => Some(error_value(env, &error)?),
                        (None, None) => None,
                    };
                    on_end.borrow_back(env)?.call(error)?;
                }
            }
            Ok(())
        })?;
    Ok(move |told| {
        tell.call(told, ThreadsafeFunctionCallMode::NonBlocking);
    })
}

/// Hands a watch's changes to the callbacks of an app.
struct Telling<F: Fn(Told) + Send + Sync>(F);

impl<F: Fn(Told) + Send + Sync> marfa_core::WatchListener for Telling<F> {
    fn changed(&self, change: &marfa_core::Change) {
        (self.0)(Told::Change(change.into()));
    }

    fn ended(&self, error: Option<marfa_core::CoreError>) {
        (self.0)(Told::End(error));
    }
}

/// A local copy of a slice of one server.
#[napi]
pub struct MarfaCore {
    inner: Arc<marfa_core::Core>,
}

/// Raised to end a `hydrate`, `catchUp` or `drain` it was given to, soon
/// after, with an error coded `canceled`. What the call had taken is
/// consistent: a hydration left unfinished answers lists and searches marked
/// partial, and takes writes only to the rows it holds and new ones, and no edge writes, until a hydration completes (the next one of the same slice carries on from the page it reached where it can), a catch-up keeps the cursor it reached, and a drain leaves what it had not sent queued, and
/// an upload or item or edge write it had in flight queued as sent, for the
/// next drain to send again under the same key. A raised `Stop` stays raised, so a call given one
/// afterwards ends at once.
#[napi]
pub struct Stop {
    flag: Arc<AtomicBool>,
}

#[napi]
impl Stop {
    #[napi(constructor)]
    pub fn new() -> Stop {
        Stop {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn raise(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

impl Default for Stop {
    fn default() -> Self {
        Stop::new()
    }
}

fn flag_of(stop: Option<&Stop>) -> Arc<AtomicBool> {
    stop.map_or_else(
        || Arc::new(AtomicBool::new(false)),
        |stop| Arc::clone(&stop.flag),
    )
}

pub struct Hydrate {
    core: Arc<marfa_core::Core>,
    types: Vec<String>,
    tier: marfa_core::SliceTier,
    edge_types: Vec<String>,
    in_place_only: bool,
    stop: Arc<AtomicBool>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for Hydrate {
    type Output = marfa_core::HydrateReport;
    type JsValue = HydrateReport;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        if self.in_place_only {
            self.core
                .hydrate_in_place_only(&self.types, self.tier, &self.edge_types, &self.stop)
        } else {
            self.core
                .hydrate_until(&self.types, self.tier, &self.edge_types, &self.stop)
        }
        .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report.into())
    }
}

impl From<marfa_core::HydrateReport> for HydrateReport {
    fn from(report: marfa_core::HydrateReport) -> Self {
        HydrateReport {
            types: report.types,
            tier: report.tier.into(),
            edge_types: report.edge_types,
            items: count(report.items),
            edges: count(report.edges),
            pages: count(report.pages),
            pages_total: count(report.pages_total),
            resumed: report.resumed,
            restarted: report.restarted.map(|reason| reason.as_str().to_string()),
            in_place: report.in_place,
            cursor: report.cursor,
            registered_types: report.registered_types,
            unregistered_types: report
                .unregistered_types
                .into_iter()
                .map(|held| UnregisteredType {
                    id: held.id,
                    code: held.code,
                    message: held.message,
                })
                .collect(),
            replaced_types: report.replaced_types,
            unreplaced_types: report
                .unreplaced_types
                .into_iter()
                .map(|held| UnregisteredType {
                    id: held.id,
                    code: held.code,
                    message: held.message,
                })
                .collect(),
        }
    }
}

pub struct Pin {
    core: Arc<marfa_core::Core>,
    id: String,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for Pin {
    type Output = bool;
    type JsValue = PinReport;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .pin(&self.id)
            .map_err(|error| record(&mut self.failed, error))
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
    stop: Arc<AtomicBool>,
    failed: Option<marfa_core::CoreError>,
    catalog_changed: bool,
}

#[napi]
impl Task for CatchUp {
    type Output = marfa_core::CatchUpReport;
    type JsValue = CatchUpReport;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        let Some(failed) = self.failed.take() else {
            return Err(error);
        };
        let mut thrown = error_object(&env, &failed)?;
        thrown.set_named_property("catalogChanged", self.catalog_changed)?;
        Err(Error::from(thrown.into_unknown(&env)?))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.catch_up_until(&self.stop).map_err(|failed| {
            self.catalog_changed = failed.catalog_changed;
            record(&mut self.failed, failed.error)
        })
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(CatchUpReport {
            applied: count(report.applied),
            skipped: count(report.skipped),
            cursor: report.cursor,
            catalog_changed: report.catalog_changed,
        })
    }
}

pub struct Drain {
    core: Arc<marfa_core::Core>,
    stop: Arc<AtomicBool>,
    failed: Option<marfa_core::CoreError>,
}

pub struct FetchKept {
    core: Arc<marfa_core::Core>,
    stop: Arc<AtomicBool>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for FetchKept {
    type Output = marfa_core::KeptFetch;
    type JsValue = KeptFetch;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .fetch_kept_until(&self.stop)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, fetched: Self::Output) -> Result<Self::JsValue> {
        Ok(KeptFetch {
            fetched: count(fetched.fetched),
            fetched_bytes: count(fetched.fetched_bytes),
            attachments: fetched.attachments.map(Into::into),
        })
    }
}

pub struct ReadServerCatalog {
    core: Arc<marfa_core::Core>,
    stop: Arc<AtomicBool>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for ReadServerCatalog {
    type Output = marfa_core::ServerCatalog;
    type JsValue = ServerCatalog;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .server_catalog_until(&self.stop)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, served: Self::Output) -> Result<Self::JsValue> {
        Ok(ServerCatalog {
            item_types: served.item_types.into_iter().map(item_type).collect(),
            edge_types: served.edge_types.into_iter().map(edge_type).collect(),
        })
    }
}

pub struct PutBlob {
    core: Arc<marfa_core::Core>,
    path: String,
    mime_type: Option<String>,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for PutBlob {
    type Output = marfa_core::QueuedWrite;
    type JsValue = QueuedWrite;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .put_blob(std::path::Path::new(&self.path), self.mime_type.as_deref())
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, env: Env, write: Self::Output) -> Result<Self::JsValue> {
        queued(env, write)
    }
}

pub struct Attach {
    core: Arc<marfa_core::Core>,
    id: String,
    path: String,
    attachment: marfa_core::Attachment,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for Attach {
    type Output = marfa_core::Attached;
    type JsValue = Attached;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .attach(&self.id, std::path::Path::new(&self.path), &self.attachment)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, env: Env, attached: Self::Output) -> Result<Self::JsValue> {
        Ok(Attached {
            upload: queued(env, attached.upload)?,
            item: queued(env, attached.item)?,
            edge: queued(env, attached.edge)?,
            embed: attached.embed,
        })
    }
}

pub struct FetchBlob {
    core: Arc<marfa_core::Core>,
    hash: String,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for FetchBlob {
    /// Holds the bytes from every trim until the promise resolves: the
    /// JavaScript thread may be busy long after the work is done.
    type Output = marfa_core::BlobPath;
    type JsValue = String;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .blob(&self.hash)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, held: Self::Output) -> Result<Self::JsValue> {
        Ok(held.path().to_string_lossy().into_owned())
    }
}

#[napi]
impl Task for Drain {
    type Output = marfa_core::DrainReport;
    type JsValue = DrainReport;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .drain_until(&self.stop)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, env: Env, report: Self::Output) -> Result<Self::JsValue> {
        drained(env, report)
    }
}

#[napi]
impl MarfaCore {
    /// Opens a store another process writes, to read it only: never the
    /// writer, never a write, and a path with no store is refused.
    #[napi(factory)]
    pub fn open_reader(env: Env, path: String) -> Result<MarfaCore> {
        let core = marfa_core::Core::open_reader(path).map_err(|error| failure(env, error))?;
        Ok(MarfaCore {
            inner: Arc::new(core),
        })
    }

    /// A number that moves each time another process saves to the store.
    #[napi]
    pub fn data_version(&self, env: Env) -> Result<i64> {
        self.inner
            .data_version()
            .map_err(|error| failure(env, error))
    }

    /// Holds the event stream open on a thread of its own and applies each
    /// event as it arrives: `onChange` for each change, then `onEnd` once,
    /// with the error that ended it, the same error as any call throws, or
    /// null where it was stopped. Neither callback keeps the process alive. An
    /// `onChange` that throws ends the follow, and `onEnd` is given an error
    /// whose `code` is `listener_threw` and whose message says what it threw.
    /// Each time it tells `serverReachable` with work queued for a drain, it
    /// drains once, after any drain under way, and tells `queueDrained` or
    /// `queueNotDrained`; `onEnd` follows that drain's end.
    ///
    /// `toldUnreachable` says the caller was last told `serverUnreachable` by
    /// an earlier follow: this one tells `serverReachable` when it has its
    /// first stream, and does not tell `serverUnreachable` again before.
    #[napi(
        ts_args_type = "onChange: (change: Change) => void, onEnd: (error: (Error & { code: string }) | null) => void, toldUnreachable?: boolean"
    )]
    pub fn follow(
        &self,
        env: Env,
        on_change: Function<Change, ()>,
        on_end: Function<Option<Unknown<'static>>, ()>,
        told_unreachable: Option<bool>,
    ) -> Result<Subscription> {
        let told_unreachable = told_unreachable.unwrap_or(false);
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let tell = told_by(env, on_change, on_end, move || {
            flag.store(true, Ordering::Relaxed)
        })?;
        let flag = Arc::clone(&stop);
        let core = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            let result = core.follow(&flag, told_unreachable, |change| {
                tell(Told::Change(change.into()));
            });
            // Let go of the store before saying so: an `onEnd` that opens it
            // again must find the writer's role free.
            drop(core);
            tell(Told::End(result.err()));
        });
        Ok(Subscription {
            ending: Ending::Flag(stop),
        })
    }

    /// Adds a listener to this store's watch, and starts it if it was idle.
    /// However many listeners there are, one source runs: a writer with a
    /// server holds the event stream and tells what `follow` tells, and a
    /// reading handle tells `saved` each time another process saves. A
    /// hydration or catch-up takes the stream for its duration and gives it
    /// back, and no listener is told of the gap.
    ///
    /// `onChange` is called for each change after the listener joins, which
    /// is first told the outage or failure that holds then; `onEnd` is called
    /// once, last, when the subscription stops, with null, or with the error
    /// that removed the listener. A request that reaches the server tells
    /// `serverReachable` to a listener that was told it did not: the
    /// follow's, a hydration's or catch-up's that succeeded, or a drain's that
    /// answered a write. A follow that fails ends no listener: each is told
    /// `watchFailed` once, and no stream is held until the next hydration or
    /// catch-up. The first stream the watch has after the server was lost, or
    /// after a drain left a write undelivered, is drained to once, and the
    /// drain is told as `follow` tells it. An `onChange` that throws ends its
    /// listener, and `onEnd` is given an error whose `code` is
    /// `listener_threw`. Throws `no_server` for a writer with no server.
    ///
    /// `toldUnreachable` says the listener was last told `serverUnreachable`
    /// by an earlier watch: it is told `serverReachable` once the server is
    /// reached, and not `serverUnreachable` again before.
    #[napi(
        ts_args_type = "onChange: (change: Change) => void, onEnd: (error: (Error & { code: string }) | null) => void, toldUnreachable?: boolean"
    )]
    pub fn watch(
        &self,
        env: Env,
        on_change: Function<Change, ()>,
        on_end: Function<Option<Unknown<'static>>, ()>,
        told_unreachable: Option<bool>,
    ) -> Result<Subscription> {
        let leaving: Arc<OnceLock<Arc<marfa_core::Listening>>> = Arc::new(OnceLock::new());
        let leave = Arc::clone(&leaving);
        let tell = told_by(env, on_change, on_end, move || {
            if let Some(listening) = leave.get() {
                listening.stop();
            }
        })?;
        let listening = self
            .inner
            .watch(told_unreachable.unwrap_or(false), Arc::new(Telling(tell)))
            .map_err(|error| failure(env, error))?;
        let listening = Arc::new(listening);
        let _ = leaving.set(Arc::clone(&listening));
        Ok(Subscription {
            ending: Ending::Listening(listening),
        })
    }

    /// Opens the file at `path`, creating it when absent. `url` and `key` go
    /// together; without them only local reads work.
    #[napi(factory)]
    pub fn open(
        env: Env,
        path: String,
        url: Option<String>,
        key: Option<String>,
    ) -> Result<MarfaCore> {
        let core = marfa_core::Core::open(path, server_of(url, key)?)
            .map_err(|error| failure(env, error))?;
        Ok(MarfaCore {
            inner: Arc::new(core),
        })
    }

    /// Replaces the store at `path` that `open` refuses with `wrong_schema`
    /// by an empty one, and opens it. Refuses with `reading_handle` while
    /// another process writes the store, with `wrong_schema` and its `unsent`
    /// count while it holds a write the server has not taken, and with
    /// `invalid` where `open` would not refuse it, leaving the store as it is.
    /// The new store keeps only the old store's file budget, so what else
    /// only the old store held, such as pins, is lost: read it first.
    #[napi(factory)]
    pub fn replace_refused(
        env: Env,
        path: String,
        url: Option<String>,
        key: Option<String>,
    ) -> Result<MarfaCore> {
        let core = marfa_core::Core::replace_refused(path, server_of(url, key)?)
            .map_err(|error| failure(env, error))?;
        Ok(MarfaCore {
            inner: Arc::new(core),
        })
    }

    /// Removes the store at `path`: the store, its log, the bytes it fetched
    /// and its writer lock, and nothing else beside it, unlinking a symbolic
    /// link at any of those names rather than what it leads to. A store of
    /// any schema is removed, including one `open` refuses with
    /// `wrong_schema`. Close every `MarfaCore` on the store first.
    ///
    /// `unsent` is the number of writes the server has not taken that the
    /// person agreed to lose. Refuses with `unsent_differs` and the store's
    /// own count as `unsent`, leaving it as it was, unless that count equals
    /// `unsent`; the count is `null` where it cannot be read, and such a store
    /// is never removed. Refuses with `reading_handle` while another process,
    /// or another `MarfaCore` in this one, writes the store, and with
    /// `invalid` for a folder's store. With nothing at `path`, removes what a
    /// removal stopped part way left there when `unsent` is 0. A process that
    /// only reads the store does not stop the removal and keeps showing the
    /// old copy until it reopens.
    #[napi]
    pub fn remove_store(env: Env, path: String, unsent: f64) -> Result<()> {
        // Checked as a number first: napi's integer conversion truncates a
        // fraction and reads NaN as zero, which would agree to lose writes.
        if unsent.fract() != 0.0 || !(0.0..=MAX_SAFE_INTEGER).contains(&unsent) {
            return Err(failure(
                env,
                marfa_core::CoreError::Invalid(
                    "unsent is a whole count from 0 to Number.MAX_SAFE_INTEGER".to_string(),
                ),
            ));
        }
        marfa_core::Core::remove_store(path, unsent as u64).map_err(|error| failure(env, error))
    }

    /// Replaces the local copy with the declared types at `tier`, one tier or
    /// `all` for both. `["*"]` alone is every type but `system.*`, hydrated in
    /// one pass with no need to read the catalog and name its types first;
    /// beside `system.*` types it adds them, and beside any other type it is
    /// refused `invalid`.
    #[napi]
    pub fn hydrate(
        &self,
        types: Vec<String>,
        tier: SliceTier,
        stop: Option<&Stop>,
    ) -> AsyncTask<Hydrate> {
        self.hydrate_with(types, tier, Vec::new(), stop, None)
    }

    /// A hydration that also holds every edge of `edgeTypes` the key reads,
    /// whichever ends the copy holds. `types` reads as in `hydrate`, so
    /// `["*"]` alone is every type but `system.*`.
    ///
    /// With `inPlaceOnly`, it fills only a copy whose cursor aged out, and
    /// only in place: where the instance, the key's reach or the slice has
    /// changed, the server was restored to an earlier point, or the copy is
    /// not stale, it is refused `copy_expired` with the reason
    /// (`instance_changed`, `reach_changed`, `slice_changed`,
    /// `head_past_log` or `not_stale`) before it changes anything, and the
    /// copy, its queue and its files stay as they were. Where the server
    /// refuses the credential or the reach, the stale copy still ends,
    /// keeping its queue, which can also carry `reach_changed`: read
    /// `status().hydration` before offering to keep the copy stale, since a refused
    /// fill leaves a stale copy `stale` and an ended copy is `expired`.
    #[napi]
    pub fn hydrate_with(
        &self,
        types: Vec<String>,
        tier: SliceTier,
        edge_types: Vec<String>,
        stop: Option<&Stop>,
        in_place_only: Option<bool>,
    ) -> AsyncTask<Hydrate> {
        AsyncTask::new(Hydrate {
            core: Arc::clone(&self.inner),
            failed: None,
            types,
            tier: tier.into(),
            edge_types,
            in_place_only: in_place_only.unwrap_or(false),
            stop: flag_of(stop),
        })
    }

    /// Holds one row by id whatever the slice says of it, read now.
    #[napi]
    pub fn pin(&self, id: String) -> AsyncTask<Pin> {
        AsyncTask::new(Pin {
            core: Arc::clone(&self.inner),
            failed: None,
            id,
        })
    }

    /// Stops holding a row by id; one the slice does not take goes, unless
    /// writes to it still wait.
    #[napi]
    pub fn unpin(&self, env: Env, id: String) -> Result<PinReport> {
        Ok(PinReport {
            pinned: false,
            was_pinned: self.inner.unpin(&id).map_err(|error| failure(env, error))?,
        })
    }

    /// Applies every event since the stored cursor.
    #[napi]
    pub fn catch_up(&self, stop: Option<&Stop>) -> AsyncTask<CatchUp> {
        AsyncTask::new(CatchUp {
            core: Arc::clone(&self.inner),
            failed: None,
            catalog_changed: false,
            stop: flag_of(stop),
        })
    }

    #[napi]
    pub fn list(
        &self,
        env: Env,
        filters: Option<ListFilters>,
        sort: Option<Sort>,
    ) -> Result<Listing> {
        let filters = self::filters(filters);
        let sort = self::sort(env, sort, &filters)?;
        let listed = self
            .inner
            .list(&filters, sort)
            .map_err(|error| failure(env, error))?;
        Ok(Listing {
            completeness: listed.completeness.into(),
            items: listed.rows.into_iter().map(item).collect(),
        })
    }

    #[napi]
    pub fn list_in_folder(
        &self,
        env: Env,
        id: String,
        sort: Option<Sort>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Listing> {
        let listed = self
            .inner
            .list_in_folder(
                &id,
                self::sort(env, sort, &marfa_core::ListFilters::default())?.unwrap_or_default(),
                limit,
                offset,
            )
            .map_err(|error| failure(env, error))?;
        Ok(Listing {
            completeness: listed.completeness.into(),
            items: listed
                .rows
                .into_iter()
                .map(|(value, _)| item(value))
                .collect(),
        })
    }

    #[napi]
    pub fn search_in_folder(
        &self,
        env: Env,
        query: String,
        id: String,
        limit: Option<u32>,
    ) -> Result<Found> {
        let found = self
            .inner
            .search_in_folder(&query, &id, limit.unwrap_or(20) as usize)
            .map_err(|error| failure(env, error))?;
        Ok(Found {
            completeness: found.completeness.into(),
            hits: found
                .rows
                .into_iter()
                .map(|(hit, _)| SearchHit {
                    item: item(hit.item),
                    score: hit.score,
                    snippet: hit.snippet,
                })
                .collect(),
        })
    }

    #[napi]
    pub fn get(&self, env: Env, id: String) -> Result<Option<Item>> {
        Ok(self
            .inner
            .get(&id)
            .map_err(|error| failure(env, error))?
            .map(item))
    }

    /// What each of `targets`, the text between a link's brackets as
    /// `linkParts` gives it, could name from the copy alone, in order. With
    /// `item`, each is read as a link in that item's body: `bound` where
    /// saving it there would make its edge. Refuses `item_not_found` for an
    /// item the copy does not hold.
    #[napi]
    pub fn link_candidates(
        &self,
        env: Env,
        item: Option<String>,
        targets: Vec<String>,
    ) -> Result<Vec<LinkCandidates>> {
        Ok(self
            .inner
            .link_candidates(item.as_deref(), &targets)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(|link| LinkCandidates {
                target: link.target,
                state: match link.state {
                    marfa_core::LinkState::Bound => LinkState::Bound,
                    marfa_core::LinkState::Ambiguous => LinkState::Ambiguous,
                    marfa_core::LinkState::Unresolved => LinkState::Unresolved,
                },
                item: link.item,
                candidates: link.candidates,
            })
            .collect())
    }

    #[napi]
    pub fn edges_from(&self, env: Env, id: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_from(&id)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(edge)
            .collect())
    }

    #[napi]
    pub fn edges_to(&self, env: Env, id: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_to(&id)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(edge)
            .collect())
    }

    #[napi]
    pub fn edges_of_type(&self, env: Env, edge_type: String) -> Result<Vec<Edge>> {
        Ok(self
            .inner
            .edges_of_type(&edge_type)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(edge)
            .collect())
    }

    /// The ID of the item a conflicted copy was made from, or `null` where
    /// `id` is not a held conflicted copy outside the bin.
    #[napi]
    pub fn original_of_conflicted_copy(&self, env: Env, id: String) -> Result<Option<String>> {
        self.inner
            .original_of_conflicted_copy(&id)
            .map_err(|error| failure(env, error))
    }

    /// The held conflicted copies made from `id` that are outside the bin,
    /// oldest link first.
    #[napi]
    pub fn conflicted_copies_of(&self, env: Env, id: String) -> Result<Vec<Item>> {
        Ok(self
            .inner
            .conflicted_copies_of(&id)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(item)
            .collect())
    }

    #[napi]
    pub fn search(
        &self,
        env: Env,
        query: String,
        filters: Option<SearchFilters>,
        limit: Option<u32>,
    ) -> Result<Found> {
        let filters = filters.unwrap_or_default();
        let found = self
            .inner
            .search(&query, &filters.into(), limit.unwrap_or(20) as usize)
            .map_err(|error| failure(env, error))?;
        Ok(Found {
            completeness: found.completeness.into(),
            hits: found
                .rows
                .into_iter()
                .map(|hit| SearchHit {
                    item: item(hit.item),
                    score: hit.score,
                    snippet: hit.snippet,
                })
                .collect(),
        })
    }

    #[napi]
    pub fn status(&self, env: Env) -> Result<Status> {
        let status = self.inner.status().map_err(|error| failure(env, error))?;
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
            items_expected: status.items_expected.map(count),
            items_listed: status.items_listed.map(count),
            edges: count(status.edges),
            catalog_version: status.catalog_version.map(count),
            file_cache: status.file_cache.into(),
        })
    }

    /// Declares the types this app saves, each an object with its `id`, its
    /// `fields` and whatever else a type carries. A copy that has never
    /// reached a server checks what it queues against them and the types
    /// Marfa ships, and a hydration registers the ones the instance
    /// lacks, where the key may. The call is the app's whole set and replaces every earlier declaration.
    #[napi]
    pub fn declare_types(
        &self,
        env: Env,
        #[napi(ts_arg_type = "Record<string, unknown>[]")] types: Vec<serde_json::Value>,
    ) -> Result<()> {
        self.inner
            .declare_types(&types)
            .map_err(|error| failure(env, error))
    }

    /// The declarations this copy holds, by id, with the empty `fields` and
    /// the `version` a registration needs filled in where the app left them
    /// out.
    #[napi(ts_return_type = "Record<string, unknown>[]")]
    pub fn declared_types(&self, env: Env) -> Result<Vec<serde_json::Value>> {
        self.inner
            .declared_types()
            .map_err(|error| failure(env, error))
    }

    /// Every item type the copy holds, by id, read from the copy alone.
    #[napi]
    pub fn item_types(&self, env: Env) -> Result<Vec<ItemType>> {
        Ok(self
            .inner
            .item_types()
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(item_type)
            .collect())
    }

    /// `not_found` where the catalog holds no such type.
    #[napi]
    pub fn item_type(&self, env: Env, id: String) -> Result<ItemType> {
        Ok(item_type(
            self.inner
                .item_type(&id)
                .map_err(|error| failure(env, error))?,
        ))
    }

    /// The name and preview text of each item, in order, by the copy's
    /// catalog alone. An unknown type is named by the fallback fields.
    #[napi]
    pub fn item_displays(
        &self,
        env: Env,
        items: Vec<ItemDisplayInput>,
    ) -> Result<Vec<ItemDisplay>> {
        let items = items
            .into_iter()
            .map(|item| Ok((item.type_, object(item.properties)?)))
            .collect::<Result<Vec<_>>>()?;
        let items: Vec<_> = items
            .iter()
            .map(|(item_type, properties)| (item_type.as_str(), properties))
            .collect();
        Ok(self
            .inner
            .item_displays(&items)
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(|display| ItemDisplay {
                name: display.name,
                preview: display.preview,
            })
            .collect())
    }

    /// Every edge type the copy holds, by id, read from the copy alone.
    #[napi]
    pub fn edge_types(&self, env: Env) -> Result<Vec<EdgeType>> {
        Ok(self
            .inner
            .edge_types()
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(edge_type)
            .collect())
    }

    /// `not_found` where the catalog holds no such edge type.
    #[napi]
    pub fn edge_type(&self, env: Env, id: String) -> Result<EdgeType> {
        Ok(edge_type(
            self.inner
                .edge_type(&id)
                .map_err(|error| failure(env, error))?,
        ))
    }

    /// The server's item types and edge types, read from it now, so a caller
    /// can choose a slice before a first hydration. Nothing in the copy
    /// changes. `no_server` for a copy with no server.
    #[napi]
    pub fn server_catalog(&self, stop: Option<&Stop>) -> AsyncTask<ReadServerCatalog> {
        AsyncTask::new(ReadServerCatalog {
            core: Arc::clone(&self.inner),
            failed: None,
            stop: flag_of(stop),
        })
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
    pub fn create_item(&self, env: Env, draft: Draft) -> Result<QueuedWrite> {
        let draft = marfa_core::Draft {
            r#type: draft.type_,
            id: draft.id,
            properties: object(draft.properties)?,
            tags: draft.tags.unwrap_or_default(),
            tier: draft.tier.map(Into::into),
            state: draft.state.map(Into::into),
            source: draft.source,
            source_id: draft.source_id,
            occurred_at: draft.occurred_at,
            capture_latitude: draft.capture_latitude,
            capture_longitude: draft.capture_longitude,
            edges: draft.edges.unwrap_or_default().into_iter().collect(),
            base_version: draft.base_version,
        };
        queued(
            env,
            self.inner
                .create_item(&draft)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Changes an item in the local copy and queues the change.
    #[napi]
    pub fn update_item(&self, env: Env, id: String, edit: Edit) -> Result<QueuedWrite> {
        let edit = edit_of(edit)?;
        queued(
            env,
            self.inner
                .update_item(&id, &edit)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Changes an item in the local copy and queues the change, based on a
    /// version read before the one the copy holds now, which the server
    /// merges the change against.
    #[napi]
    pub fn update_item_as_read(&self, env: Env, id: String, edit: Edit) -> Result<QueuedWrite> {
        let edit = edit_of(edit)?;
        queued(
            env,
            self.inner
                .update_item_as_read(&id, &edit)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Moves an item to the bin locally and queues the delete.
    #[napi]
    pub fn delete_item(&self, env: Env, id: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .delete_item(&id)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Takes an item out of the bin and queues the restore: locally where the
    /// copy holds it, and by id where it does not, the item arriving once the
    /// server answers where the slice takes it.
    #[napi]
    pub fn restore_item(&self, env: Env, id: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .restore_item(&id)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Moves an item to another lifecycle state.
    #[napi]
    pub fn transition_item(&self, env: Env, id: String, state: ItemState) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .transition_item(&id, state.into())
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Links two items. An edge is its own write.
    #[napi]
    pub fn create_edge(&self, env: Env, draft: EdgeDraft) -> Result<QueuedWrite> {
        let draft = marfa_core::EdgeDraft {
            source_id: draft.source_id,
            target_id: draft.target_id,
            edge_type: draft.edge_type,
            properties: object(draft.properties)?,
            id: draft.id,
        };
        queued(
            env,
            self.inner
                .create_edge(&draft)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Answers `null` for an edit that names no property and no new end, which
    /// queues no write.
    #[napi]
    pub fn update_edge(&self, env: Env, id: String, edit: EdgeEdit) -> Result<Option<QueuedWrite>> {
        let (source_id, target_id) = match edit.moves {
            None => (None, None),
            Some(EdgeMove {
                end: EdgeEnd::Source,
                to,
            }) => (Some(to), None),
            Some(EdgeMove {
                end: EdgeEnd::Target,
                to,
            }) => (None, Some(to)),
        };
        let edit = marfa_core::EdgeEdit {
            properties: object(Some(edit.properties))?,
            base_version: edit.base_version,
            source_id,
            target_id,
        };
        self.inner
            .update_edge(&id, &edit)
            .map_err(|error| failure(env, error))?
            .map(|write| queued(env, write))
            .transpose()
    }

    #[napi]
    pub fn delete_edge(&self, env: Env, id: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .delete_edge(&id)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Puts one tag on an item, as its own write.
    #[napi]
    pub fn add_tag(&self, env: Env, id: String, tag: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .add_tag(&id, &tag)
                .map_err(|error| failure(env, error))?,
        )
    }

    #[napi]
    pub fn remove_tag(&self, env: Env, id: String, tag: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .remove_tag(&id, &tag)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Writes the item's tags whole, dropping any not named.
    #[napi]
    pub fn replace_metadata(&self, env: Env, id: String, tags: Vec<String>) -> Result<QueuedWrite> {
        let write = marfa_core::MetadataWrite { tags };
        queued(
            env,
            self.inner
                .replace_metadata(&id, &write)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Writes one extension namespace, as its own write.
    #[napi]
    pub fn write_extension(
        &self,
        env: Env,
        id: String,
        namespace: String,
        #[napi(ts_arg_type = "Record<string, unknown>")] body: serde_json::Value,
    ) -> Result<QueuedWrite> {
        let body = serde_json::Value::Object(object(Some(body))?).to_string();
        queued(
            env,
            self.inner
                .write_extension(&id, &namespace, &body)
                .map_err(|error| failure(env, error))?,
        )
    }

    #[napi]
    pub fn delete_extension(&self, env: Env, id: String, namespace: String) -> Result<QueuedWrite> {
        queued(
            env,
            self.inner
                .delete_extension(&id, &namespace)
                .map_err(|error| failure(env, error))?,
        )
    }

    /// Every queued write and what became of it.
    #[napi]
    pub fn queue(&self, env: Env) -> Result<Vec<QueuedWrite>> {
        self.inner
            .queue()
            .map_err(|error| failure(env, error))?
            .into_iter()
            .map(|write| queued(env, write))
            .collect()
    }

    /// Sends what the queue holds and records what came back. One pass.
    #[napi]
    pub fn drain(&self, stop: Option<&Stop>) -> AsyncTask<Drain> {
        AsyncTask::new(Drain {
            core: Arc::clone(&self.inner),
            failed: None,
            stop: flag_of(stop),
        })
    }

    /// Holds a file's bytes beside the working copy and queues their upload.
    /// Off the JavaScript thread, because the whole file is copied and
    /// hashed.
    #[napi(ts_return_type = "Promise<QueuedWrite>")]
    pub fn put_blob(&self, path: String, mime_type: Option<String>) -> AsyncTask<PutBlob> {
        AsyncTask::new(PutBlob {
            core: Arc::clone(&self.inner),
            failed: None,
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
            failed: None,
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
    /// neither read nor fetched. No trim in this process takes the bytes
    /// before the promise resolves; after that a trim may, so open the path
    /// at once.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn blob(&self, hash: String) -> AsyncTask<FetchBlob> {
        AsyncTask::new(FetchBlob {
            core: Arc::clone(&self.inner),
            failed: None,
            hash,
        })
    }

    /// The cache of fetched files: its setting, the budget in force and the
    /// bytes held.
    #[napi]
    pub fn file_cache(&self, env: Env) -> Result<FileCache> {
        self.inner
            .file_cache()
            .map(Into::into)
            .map_err(|error| failure(env, error))
    }

    /// Chooses the cache's budget, trims to it at once and answers the bytes
    /// the trim took. Refused `invalid` for a budget that is not one, keeping
    /// the setting, and refused to a reading handle.
    #[napi]
    pub fn set_file_budget(&self, env: Env, budget: FileBudget) -> Result<i64> {
        marfa_core::FileBudget::try_from(budget)
            .and_then(|budget| self.inner.set_file_budget(budget))
            .map(count)
            .map_err(|error| failure(env, error))
    }

    /// Trims the cache to its budget now and answers the bytes it took.
    /// Refused to a reading handle.
    #[napi]
    pub fn trim_files(&self, env: Env) -> Result<i64> {
        self.inner
            .trim_files()
            .map(count)
            .map_err(|error| failure(env, error))
    }

    /// Fetches the bytes of every file attached to an item the copy holds
    /// that the cache does not hold whole, smallest first, and answers what
    /// it fetched and the attachments after it, resuming the part of one an
    /// earlier fetch left. Waits out a server that asks for a wait of a
    /// minute or less, and stops at the first the disk has no room for, once
    /// the server cannot be reached, or once it asks for a longer wait; one
    /// that fails otherwise is passed over. Run after a hydration and after
    /// a catch-up. Refused to a reading handle and for a folder's copy.
    #[napi]
    pub fn fetch_kept(&self, stop: Option<&Stop>) -> AsyncTask<FetchKept> {
        AsyncTask::new(FetchKept {
            core: Arc::clone(&self.inner),
            failed: None,
            stop: flag_of(stop),
        })
    }

    /// Whether a blob's bytes are held beside the store, with no request.
    #[napi]
    pub fn blob_held(&self, env: Env, hash: String) -> Result<bool> {
        self.inner
            .blob_held(&hash)
            .map_err(|error| failure(env, error))
    }

    /// The thumbnail an item carries, from the copy with no request; null
    /// where its type declares none or it carries none. An item the copy does
    /// not hold throws `not_found` naming `not_held`, and a held value that is
    /// not a thumbnail throws `decoding` naming the item.
    #[napi]
    pub fn thumbnail(&self, env: Env, id: String) -> Result<Option<Thumbnail>> {
        Ok(self
            .inner
            .thumbnail(&id)
            .map_err(|error| failure(env, error))?
            .map(|thumbnail| Thumbnail {
                mime_type: thumbnail.mime_type,
                bytes: thumbnail.bytes.into(),
            }))
    }

    /// Sends a blocked or dead write again, under a fresh idempotency key.
    /// Answers whether the row was one a release applies to.
    #[napi]
    pub fn release(&self, env: Env, id: String) -> Result<bool> {
        self.inner.release(&id).map_err(|error| failure(env, error))
    }

    /// Releases every write blocked for one reason, and says how many.
    #[napi]
    pub fn release_reason(&self, env: Env, reason: BlockedReason) -> Result<i64> {
        let released = self
            .inner
            .release_reason(reason.into())
            .map_err(|error| failure(env, error))?;
        Ok(count(released as u64))
    }

    /// Takes a write blocked `ancestor_unavailable`, `conflict_unresolved`,
    /// `failing_alone` or `instance_changed` out of the queue, and puts the copy back to what the server holds;
    /// each write held for it is refused unsent. Answers whether the row was
    /// one a withdraw takes. Off the JavaScript thread, because it reads each
    /// row it puts back from the server.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn withdraw(&self, id: String) -> AsyncTask<Withdraw> {
        AsyncTask::new(Withdraw {
            core: Arc::clone(&self.inner),
            id,
            failed: None,
        })
    }

    /// Clears the writes the server has answered, and says how many went. A
    /// refused write that carried content stays until it is discarded.
    #[napi]
    pub fn forget_answered(&self, env: Env) -> Result<i64> {
        Ok(count(
            self.inner
                .forget_answered()
                .map_err(|error| failure(env, error))? as u64,
        ))
    }

    /// Clears only the named writes, under the rules `forgetAnswered` keeps,
    /// and says how many went. Every other answered write stays, so an app
    /// clears just the answers it has read; an id that names no write, or
    /// one not answered, is ignored.
    #[napi]
    pub fn forget_answered_ids(&self, env: Env, ids: Vec<String>) -> Result<i64> {
        Ok(count(
            self.inner
                .forget_answered_ids(&ids)
                .map_err(|error| failure(env, error))? as u64,
        ))
    }

    /// Takes a refused write out of the queue, with the content it carried.
    /// Answers whether the row was one a discard takes: refused, and with no
    /// write still waiting on it, or a create refused onto a row its natural
    /// key names that no read has found, whose waiting writes it refuses
    /// unsent. A create's discard first waits for a drain already running to
    /// end, which is why it is off the JavaScript thread.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn discard(&self, id: String) -> AsyncTask<Discard> {
        AsyncTask::new(Discard {
            core: Arc::clone(&self.inner),
            id,
            failed: None,
        })
    }
}

pub struct Withdraw {
    core: Arc<marfa_core::Core>,
    id: String,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for Withdraw {
    type Output = bool;
    type JsValue = bool;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .withdraw(&self.id)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, taken: Self::Output) -> Result<Self::JsValue> {
        Ok(taken)
    }
}

pub struct Discard {
    core: Arc<marfa_core::Core>,
    id: String,
    failed: Option<marfa_core::CoreError>,
}

#[napi]
impl Task for Discard {
    type Output = bool;
    type JsValue = bool;

    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(rethrown(env, self.failed.take(), error))
    }

    fn compute(&mut self) -> Result<Self::Output> {
        self.core
            .discard(&self.id)
            .map_err(|error| record(&mut self.failed, error))
    }

    fn resolve(&mut self, _: Env, taken: Self::Output) -> Result<Self::JsValue> {
        Ok(taken)
    }
}

/// What a debug build lets a test hold and move. A release build has none of
/// it, so the module an app ships offers nothing here.
#[cfg(debug_assertions)]
pub mod test_controls {
    use std::time::Duration;

    use napi_derive::napi;

    /// Recorded operation answers; an absent error means the call succeeded.
    #[napi(object)]
    pub struct ReentryAnswers {
        pub hydration_error: Option<String>,
        pub catch_up_error: Option<String>,
    }

    #[napi]
    pub struct ReentryProbe {
        inner: marfa_core::ReentryProbe,
    }

    #[napi]
    impl ReentryProbe {
        /// Null until the engine has called the listener.
        #[napi]
        pub fn answers(&self) -> Option<ReentryAnswers> {
            self.inner.answers().map(|answers| ReentryAnswers {
                hydration_error: answers
                    .hydration
                    .err()
                    .map(|error| super::describe(&error).0),
                catch_up_error: answers
                    .catch_up
                    .err()
                    .map(|error| super::describe(&error).0),
            })
        }

        #[napi]
        pub fn stop(&self) {
            self.inner.stop();
        }
    }

    /// Registers a listener that attempts hydration and catch-up on the
    /// engine's dispatcher thread, where a synchronous binding calls back.
    #[napi(namespace = "testHooks")]
    pub fn probe_reentry(env: napi::Env, core: &super::MarfaCore) -> napi::Result<ReentryProbe> {
        Ok(ReentryProbe {
            inner: core
                .inner
                .probe_watch_reentry()
                .map_err(|error| super::failure(env, error))?,
        })
    }

    /// A wait the engine has asked the test clock for.
    #[napi(object)]
    pub struct ClockWait {
        /// What the engine asked to wait, in milliseconds.
        pub asked_ms: f64,
        /// How many milliseconds the clock has yet to be advanced by, or
        /// null for a wait too long to add to the clock.
        pub left_ms: Option<f64>,
    }

    /// Makes the engine wait at `point` the next time it reaches it, until
    /// `release`.
    #[napi(namespace = "testHooks")]
    pub fn hold(point: String) {
        marfa_core::fault::arm(&point);
    }

    /// Makes the engine fail at `point` each time it reaches it, until
    /// `fail` is called with false. Only the points the engine names fail.
    #[napi(namespace = "testHooks")]
    pub fn fail(point: String, on: Option<bool>) {
        marfa_core::fault::set_failing(&point, on.unwrap_or(true));
    }

    /// Lets go of what waits at `point`, and stops holding it.
    #[napi(namespace = "testHooks")]
    pub fn release(point: String) {
        marfa_core::fault::release(&point);
    }

    /// Enables or disables reach counters, without resetting their values.
    #[napi(namespace = "testHooks")]
    pub fn observe(on: bool) {
        marfa_core::fault::observe(on);
    }

    /// How many times the engine has reached `point` while observing.
    #[napi(namespace = "testHooks")]
    pub fn reached(point: String) -> u32 {
        u32::try_from(marfa_core::fault::reached(&point)).unwrap_or(u32::MAX)
    }

    /// How many calls wait at `point` now.
    #[napi(namespace = "testHooks")]
    pub fn waiting(point: String) -> u32 {
        u32::try_from(marfa_core::fault::waiting(&point)).unwrap_or(u32::MAX)
    }

    /// Sets the clock the engine waits by to one that moves only where
    /// `advance` moves it, or goes back to the system clock. Set it before the
    /// calls whose waits it is to read.
    #[napi(namespace = "testClock")]
    pub fn manual(on: Option<bool>) {
        marfa_core::clock::set_manual(on.unwrap_or(true));
    }

    /// Moves the manual clock forward by `ms` milliseconds and ends the waits
    /// it reaches.
    #[napi(namespace = "testClock")]
    pub fn advance(ms: f64) -> napi::Result<()> {
        if !ms.is_finite() || ms < 0.0 {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "the clock moves forward by a number of milliseconds, not back",
            ));
        }
        marfa_core::clock::advance(Duration::from_secs_f64(ms / 1000.0));
        Ok(())
    }

    /// The waits asked of the manual clock that it has not reached, in the
    /// order they were asked.
    #[napi(namespace = "testClock")]
    pub fn waits() -> Vec<ClockWait> {
        marfa_core::clock::waits()
            .into_iter()
            .map(|wait| ClockWait {
                asked_ms: wait.asked.as_secs_f64() * 1000.0,
                left_ms: wait.left.map(|left| left.as_secs_f64() * 1000.0),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_messages_keep_one_classification_and_distinct_detail_codes() {
        use marfa_core::CoreError as E;
        assert_eq!(
            describe(&E::Unauthorized {
                code: "unauthorized".into(),
                message: "Authentication required".into()
            })
            .0,
            "unauthorized: Authentication required"
        );
        assert_eq!(
            describe(&E::UnknownType {
                message: "Unknown type: acme.absent".into()
            })
            .0,
            "unknown_type: acme.absent"
        );
        assert_eq!(
            describe(&E::Validation {
                code: "invalid_properties".into(),
                message: "read: Expected boolean".into()
            })
            .0,
            "validation: (invalid_properties) read: Expected boolean"
        );
    }

    #[test]
    fn an_error_carries_the_fields_the_swift_binding_carries() {
        use marfa_core::CoreError as E;
        use serde_json::json;
        let fields = |error: E| describe(&error).1;
        assert_eq!(
            fields(E::RateLimited {
                code: "rate_limited".into(),
                message: String::new(),
                retry_after_seconds: Some(7),
            }),
            vec![
                ("serverCode", json!("rate_limited")),
                ("status", json!(429)),
                ("retryAfterSeconds", json!(7)),
            ]
        );
        assert_eq!(
            fields(E::WrongSchema {
                path: "/store".into(),
                reason: "its table queue".into(),
                unsent: Some(2),
                folder: None,
            }),
            vec![
                ("path", json!("/store")),
                ("reason", json!("its table queue")),
                ("unsent", json!(2)),
            ]
        );
        assert_eq!(
            fields(E::ContractMismatch {
                origin: "https://marfa.example".into(),
                served: Some("4".into()),
                expected: 3,
                status: Some(201),
                write_sent: true,
            }),
            vec![
                ("origin", json!("https://marfa.example")),
                ("served", json!("4")),
                ("expected", json!(3)),
                ("status", json!(201)),
                ("writeSent", json!(true)),
            ]
        );
        // A failed renewal carries its cause's fields, as it carries its code.
        let cause = E::BytesAbsent {
            hash: "sha256:a".into(),
            reason: "none".into(),
        };
        assert_eq!(
            fields(E::RenewalFailed(Box::new(cause.clone()))),
            fields(cause)
        );
        assert!(fields(E::NoServer).is_empty());
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
                describe(&E::RenewalFailed(Box::new(cause)))
                    .0
                    .starts_with(&format!("{code}: "))
            );
        }
    }

    #[test]
    fn a_contract_refusal_crosses_under_its_own_code() {
        let error = describe(&marfa_core::CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: Some("4".into()),
            expected: 3,
            status: Some(200),
            write_sent: false,
        });
        assert!(error.0.starts_with("contract_mismatch: "), "{}", error.0);
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
            types: Some(vec!["core.note".into(), "core.task".into()]),
            states: Some(vec![ItemState::Archived, ItemState::Trashed]),
            all_states: Some(true),
            tier: Some(Tier::Feed),
            tags: Some(vec!["a".into()]),
            occurred_after: Some("after".into()),
            occurred_before: Some("before".into()),
            source: Some("notes".into()),
            updated_after: Some("changed after".into()),
            updated_before: Some("changed before".into()),
            filter: Some("tags exists".into()),
            beneath: Some("root".into()),
            limit: Some(3),
            offset: Some(4),
        }));
        assert_eq!(
            crossed,
            marfa_core::ListFilters {
                types: Some(vec!["core.note".into(), "core.task".into()]),
                states: Some(vec![
                    marfa_core::ItemState::Archived,
                    marfa_core::ItemState::Trashed,
                ]),
                all_states: true,
                tier: Some(marfa_core::Tier::Feed),
                tags: vec!["a".into()],
                occurred_after: Some("after".into()),
                occurred_before: Some("before".into()),
                source: Some("notes".into()),
                updated_after: Some("changed after".into()),
                updated_before: Some("changed before".into()),
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
            states: Some(vec![ItemState::Archived, ItemState::Trashed]),
            all_states: Some(true),
            types: Some(vec!["core.note".into(), "core.task".into()]),
            tier: Some(Tier::Feed),
            tags: Some(vec!["a".into(), "b".into()]),
            occurred_after: Some("after".into()),
            occurred_before: Some("before".into()),
            filter: Some("tags exists".into()),
            beneath: Some("root".into()),
        }
        .into();
        assert_eq!(
            crossed,
            marfa_core::SearchFilters {
                states: Some(vec![
                    marfa_core::ItemState::Archived,
                    marfa_core::ItemState::Trashed,
                ]),
                all_states: true,
                types: Some(vec!["core.note".into(), "core.task".into()]),
                tier: Some(marfa_core::Tier::Feed),
                tags: vec!["a".into(), "b".into()],
                occurred_after: Some("after".into()),
                occurred_before: Some("before".into()),
                filter: Some("tags exists".into()),
                beneath: Some("root".into()),
            }
        );
    }
}
