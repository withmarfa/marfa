//! The Swift-facing shape of `marfa_core`. Properties cross as a JSON string
//! because UniFFI has no arbitrary-JSON type.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

uniffi::setup_scaffolding!();

mod folders;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Tier {
    Library,
    Feed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
}

// Every sortable column is a verb plus `_at`, so the shared `At` suffix the
// lint reports is the naming rule rather than noise the variants could drop.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Item {
    pub id: String,
    pub r#type: String,
    /// The item's properties as one JSON object.
    pub properties_json: String,
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
    /// The text under the property the type's display hints name as its
    /// title, or `title` where they name none; none where that holds no
    /// string.
    pub title: Option<String>,
    /// The text under the property the type's display hints name as its
    /// body, or `body` where they name none; none where that holds no
    /// string.
    pub body: Option<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Edge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Narrowing for a search: the state rule a list takes, a type with its
/// subtree, tags, a listing-grammar expression and `beneath`, each read as
/// the list reads it.
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct SearchFilters {
    #[uniffi(default = None)]
    pub state: Option<ItemState>,
    #[uniffi(default = false)]
    pub all_states: bool,
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    /// An expression in the server's listing grammar, answered as the server
    /// answers `filter` and refused `validation_error` where it refuses it.
    /// A `backref` condition is refused `invalid`.
    #[uniffi(default = None)]
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, as far as the copy holds them.
    #[uniffi(default = None)]
    pub beneath: Option<String>,
}

/// Narrowing for a list. Leaving `state` unset answers the active state, as
/// the server does; `all_states` lifts that, and a named state wins.
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct ListFilters {
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = None)]
    pub state: Option<ItemState>,
    #[uniffi(default = false)]
    pub all_states: bool,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    #[uniffi(default = None)]
    pub occurred_after: Option<String>,
    #[uniffi(default = None)]
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the server
    /// answers `filter` and refused `validation_error` where it refuses it.
    /// A `backref` condition is refused `invalid`.
    #[uniffi(default = None)]
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, as far as the copy holds them.
    #[uniffi(default = None)]
    pub beneath: Option<String>,
    #[uniffi(default = None)]
    pub limit: Option<u32>,
    #[uniffi(default = None)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Sort {
    pub field: SortField,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SearchHit {
    pub item: Item,
    /// Higher is a better match.
    pub score: f64,
    /// An excerpt as HTML: the text escaped and each match in `<mark>` tags.
    pub snippet: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct HydrateReport {
    pub types: Vec<String>,
    pub tier: Tier,
    pub edge_types: Vec<String>,
    pub items: u64,
    pub edges: u64,
    pub pages: u64,
    pub cursor: String,
    /// Types the app declared that the instance did not hold and now does.
    pub registered_types: Vec<String>,
    /// Declared types the instance did not hold and would not take.
    pub unregistered_types: Vec<UnregisteredType>,
}

/// A declared type the instance refused to register, and why.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UnregisteredType {
    pub id: String,
    /// The server's code for the refusal.
    pub code: String,
    pub message: String,
}

/// Raised to end a `hydrate`, `catchUp` or `drain` it was given to, soon
/// after, with `MarfaError.Canceled`. What the call had taken is consistent:
/// a hydration left unfinished refuses reads, a catch-up keeps the cursor it
/// reached, and a drain leaves what it had not sent queued. A raised `Stop`
/// stays raised, so a call given one afterwards ends at once.
#[derive(uniffi::Object)]
pub struct Stop {
    flag: Arc<AtomicBool>,
}

#[uniffi::export]
impl Stop {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Stop {
            flag: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn raise(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

fn flag_of(stop: Option<Arc<Stop>>) -> Arc<AtomicBool> {
    stop.map_or_else(
        || Arc::new(AtomicBool::new(false)),
        |stop| Arc::clone(&stop.flag),
    )
}

/// What a pin or an unpin answers.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PinReport {
    /// Whether the row is pinned now.
    pub pinned: bool,
    /// Whether it was pinned before the call.
    pub was_pinned: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct CatchUpReport {
    pub applied: u64,
    pub skipped: u64,
    pub cursor: String,
    pub reached_head: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Hydration {
    Never,
    InProgress,
    Complete,
    Expired,
}

#[derive(Debug, Clone, uniffi::Record)]
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
    pub items: u64,
    pub edges: u64,
    /// Moves each time a refresh changes the catalog; none where the copy has
    /// never held one.
    pub catalog_version: Option<u64>,
}

/// A field of an item type, or a property of an edge type.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TypeField {
    pub name: String,
    /// The field's own type, such as `string` or `thumbnail`.
    pub field_type: String,
    pub required: bool,
    pub description: Option<String>,
    /// The type that declares it: the type itself, or the nearest one it
    /// inherits the field from.
    pub declared_by: String,
    /// The definition whole, as the server answers it, as one JSON object.
    pub definition_json: String,
}

/// An item type as the copy holds it, with the fields it inherits.
#[derive(Debug, Clone, uniffi::Record)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EdgeEnd {
    Source,
    Target,
}

/// An edge type as the copy holds it.
#[derive(Debug, Clone, uniffi::Record)]
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

impl From<marfa_core::TypeField> for TypeField {
    fn from(field: marfa_core::TypeField) -> Self {
        TypeField {
            name: field.name,
            field_type: field.r#type,
            required: field.required,
            description: field.description,
            declared_by: field.declared_by,
            definition_json: field.definition.to_string(),
        }
    }
}

impl From<marfa_core::ItemType> for ItemType {
    fn from(held: marfa_core::ItemType) -> Self {
        ItemType {
            id: held.id,
            label: held.label,
            description: held.description,
            parent: held.parent,
            version: held.version,
            fields: held.fields.into_iter().map(Into::into).collect(),
            title_field: held.title_field,
            body_field: held.body_field,
            link_field: held.link_field,
            roles: held.roles,
            compatible_with: held.compatible_with,
        }
    }
}

impl From<marfa_core::EdgeType> for EdgeType {
    fn from(held: marfa_core::EdgeType) -> Self {
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
            properties: held.properties.into_iter().map(Into::into).collect(),
            shipped: held.shipped,
        }
    }
}

/// The kinds of write a queue holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum BlockedReason {
    CredentialRefused,
    KeySpent,
    AncestorUnavailable,
    ConflictUnresolved,
    AwaitingDependency,
}

/// Which handle this process holds on the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Handle {
    Writer,
    Reader,
}

/// What the server made of a write: one of six, and absent while the write
/// is unanswered.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
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
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
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

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FieldRefusal {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissingGrant {
    pub kind: GrantKind,
    /// The type or edge type id, or the extension namespace.
    pub name: String,
    pub level: GrantLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum GrantKind {
    Type,
    EdgeType,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum GrantLevel {
    Read,
    Write,
}

/// A create, before it is queued.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Draft {
    pub r#type: String,
    #[uniffi(default = None)]
    pub id: Option<String>,
    /// The properties as one JSON object.
    #[uniffi(default = "{}")]
    pub properties_json: String,
    /// Each queued as a write of its own, waiting on the create.
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    #[uniffi(default = None)]
    pub source: Option<String>,
    #[uniffi(default = None)]
    pub source_id: Option<String>,
    #[uniffi(default = None)]
    pub occurred_at: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves a row the server holds.
    #[uniffi(default = None)]
    pub base_version: Option<i64>,
}

/// A change to an item, and the version it was read at.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Edit {
    /// Whole field values, as one JSON object; a device never merges
    /// inside a field.
    pub properties_json: String,
    /// The properties are the item's whole properties: one left out is
    /// cleared. Otherwise each one given replaces its value and the rest stay.
    #[uniffi(default = false)]
    pub replace_properties: bool,
    /// Required: an update naming no version is refused before it is sent.
    #[uniffi(default = None)]
    pub base_version: Option<i64>,
    /// The natural key to move the row to.
    #[uniffi(default = None)]
    pub source_id: Option<String>,
    /// The type to move the row to, sent as the server's retype. A type the
    /// copy's catalog does not hold is refused `UnknownType` before anything
    /// is queued; the type the row has already moves nothing.
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    /// The tier to move the row to; the tier it has already moves nothing.
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
}

impl Edit {
    fn core(self) -> Result<marfa_core::Edit, MarfaError> {
        Ok(marfa_core::Edit {
            properties: object(&self.properties_json)?,
            base_version: self.base_version,
            source_id: self.source_id,
            r#type: self.r#type,
            tier: self.tier.map(Into::into),
            replace_properties: self.replace_properties,
        })
    }
}

/// An edge, before it is queued.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EdgeDraft {
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    #[uniffi(default = "{}")]
    pub properties_json: String,
    #[uniffi(default = None)]
    pub id: Option<String>,
}

/// A change to an edge's properties, and the version it was read at.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EdgeEdit {
    pub properties_json: String,
    #[uniffi(default = None)]
    pub base_version: Option<i64>,
}

/// One queued write and what became of it.
#[derive(Debug, Clone, uniffi::Record)]
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
    /// None while the server has not answered it.
    pub verdict: Option<Verdict>,
    /// Held behind a write that has no answer yet: `depends_on` and
    /// `follows` say which.
    pub waiting: bool,
    /// The body the write sends, or sent, as one JSON object: a refused
    /// write's content stays readable here until it is discarded.
    pub body_json: String,
    /// The server's answer, whole, as it arrived.
    pub answer: Option<String>,
    pub refusals: i64,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

/// How a file is attached. Every field has a default: the MIME type from the
/// file's extension, the title from its name, the type from the MIME type.
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct Attachment {
    #[uniffi(default = None)]
    pub mime_type: Option<String>,
    #[uniffi(default = None)]
    pub title: Option<String>,
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
}

/// The three writes an attachment is, in the order they go out.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
}

/// What became of one write a drain answered, sent or not.
#[derive(Debug, Clone, uniffi::Record)]
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
#[derive(Debug, Clone, uniffi::Record)]
pub struct DrainReport {
    /// Writes the server answered this drain, whatever it answered.
    pub answered: u64,
    pub held: u64,
    /// Writes it could not deliver, each still waiting, uncounted, for the
    /// next drain.
    pub undelivered: u64,
    /// Writes it gave a verdict without sending them: refused for a write
    /// they waited on or for bytes no longer held, or settled by another
    /// write's answer.
    pub unsent: u64,
    /// Writes whose request could not be made: each is counted against its
    /// write and waits for the next drain, or is dead at the ceiling. The
    /// writes a refused credential parks are counted in `stopped`.
    pub unmade: u64,
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
    pub retry_after_seconds: Option<u64>,
}

/// Every variant carries `message`, the core's own sentence for it, because
/// UniFFI renders an error's description by reflection otherwise.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum MarfaError {
    NotFound {
        code: String,
        message: String,
    },
    Unauthorized {
        code: String,
        message: String,
    },
    Forbidden {
        code: String,
        message: String,
    },
    Validation {
        code: String,
        message: String,
    },
    UnknownType {
        message: String,
    },
    RateLimited {
        code: String,
        message: String,
        retry_after_seconds: Option<u64>,
    },
    Server {
        status: u16,
        code: String,
        message: String,
    },
    Io {
        message: String,
    },
    Network {
        message: String,
    },
    /// Something in front of the server answered `status` naming no
    /// contract: taken as the network failing, never as the server's word.
    Unnamed {
        status: u16,
        message: String,
    },
    Decoding {
        message: String,
    },
    Store {
        message: String,
    },
    Redirected {
        origin: String,
        status: u16,
        location: Option<String>,
        message: String,
    },
    StorageFull {
        message: String,
    },
    SignedOut {
        origin: String,
        message: String,
    },
    NoKeychain {
        message: String,
    },
    NoServer {
        message: String,
    },
    NoCursor {
        message: String,
    },
    HydrationIncomplete {
        message: String,
    },
    /// The copy has never held the type catalog: a hydration reads it.
    NoCatalog {
        message: String,
    },
    /// A store another build made. Carried rather than left in the message,
    /// because a Swift caller showing this to a person has to be able to name
    /// the file, and say what it holds, without parsing prose out of it.
    WrongSchema {
        path: String,
        reason: String,
        /// Writes still waiting to be sent, which only the build that made
        /// the store can send; `None` where its queue cannot be read.
        unsent: Option<u64>,
        message: String,
    },
    ReadingHandle {
        message: String,
    },
    /// The copy can no longer be kept current from its cursor: a hydration
    /// is owed, and the queue survives it.
    CopyExpired {
        reason: String,
        message: String,
    },
    StreamIncomplete {
        reason: String,
        message: String,
    },
    WrongServer {
        expected: String,
        got: String,
        message: String,
    },
    /// The item is whole and its bytes are not here, nor can they be fetched.
    BytesAbsent {
        hash: String,
        reason: String,
        message: String,
    },
    /// The server speaks a contract this build was not made for, and its
    /// answer was not read.
    ContractMismatch {
        /// The contract the answer named, or none where a success named none.
        served: Option<String>,
        expected: u64,
        status: Option<u16>,
        /// The answer was to a write, which may have taken effect.
        write_sent: bool,
        message: String,
    },
    /// The `Stop` the call was given was raised before it finished.
    Canceled {
        message: String,
    },
    /// A folder's first sync waits for confirmation, so the call that would
    /// write or send for it was refused.
    FirstSyncWaiting {
        message: String,
    },
    Invalid {
        message: String,
    },
}

impl MarfaError {
    pub fn message(&self) -> &str {
        match self {
            MarfaError::NotFound { message, .. }
            | MarfaError::Unauthorized { message, .. }
            | MarfaError::Forbidden { message, .. }
            | MarfaError::Validation { message, .. }
            | MarfaError::UnknownType { message }
            | MarfaError::RateLimited { message, .. }
            | MarfaError::Server { message, .. }
            | MarfaError::Io { message }
            | MarfaError::Network { message }
            | MarfaError::Unnamed { message, .. }
            | MarfaError::Decoding { message }
            | MarfaError::Store { message }
            | MarfaError::Redirected { message, .. }
            | MarfaError::StorageFull { message }
            | MarfaError::SignedOut { message, .. }
            | MarfaError::NoKeychain { message }
            | MarfaError::NoServer { message }
            | MarfaError::NoCursor { message }
            | MarfaError::HydrationIncomplete { message }
            | MarfaError::NoCatalog { message }
            | MarfaError::WrongSchema { message, .. }
            | MarfaError::ReadingHandle { message }
            | MarfaError::CopyExpired { message, .. }
            | MarfaError::StreamIncomplete { message, .. }
            | MarfaError::WrongServer { message, .. }
            | MarfaError::BytesAbsent { message, .. }
            | MarfaError::ContractMismatch { message, .. }
            | MarfaError::Canceled { message }
            | MarfaError::FirstSyncWaiting { message }
            | MarfaError::Invalid { message } => message,
        }
    }
}

#[uniffi::export]
impl MarfaError {
    /// The error classification used by the command line and Node binding.
    /// A variant's `code` field carries the server's more specific error code.
    pub fn code(&self) -> String {
        let kind = match self {
            MarfaError::NotFound { .. } => marfa_core::CoreErrorKind::NotFound,
            MarfaError::Unauthorized { .. } => marfa_core::CoreErrorKind::Unauthorized,
            MarfaError::Forbidden { .. } => marfa_core::CoreErrorKind::Forbidden,
            MarfaError::Validation { .. } => marfa_core::CoreErrorKind::Validation,
            MarfaError::UnknownType { .. } => marfa_core::CoreErrorKind::UnknownType,
            MarfaError::RateLimited { .. } => marfa_core::CoreErrorKind::RateLimited,
            MarfaError::Server { .. } => marfa_core::CoreErrorKind::Server,
            MarfaError::Io { .. } => marfa_core::CoreErrorKind::Io,
            MarfaError::Network { .. } => marfa_core::CoreErrorKind::Network,
            MarfaError::Unnamed { .. } => marfa_core::CoreErrorKind::Unnamed,
            MarfaError::Decoding { .. } => marfa_core::CoreErrorKind::Decoding,
            MarfaError::Store { .. } => marfa_core::CoreErrorKind::Store,
            MarfaError::StorageFull { .. } => marfa_core::CoreErrorKind::StorageFull,
            MarfaError::SignedOut { .. } => marfa_core::CoreErrorKind::SignedOut,
            MarfaError::NoKeychain { .. } => marfa_core::CoreErrorKind::NoKeychain,
            MarfaError::Redirected { .. } => marfa_core::CoreErrorKind::Redirected,
            MarfaError::NoServer { .. } => marfa_core::CoreErrorKind::NoServer,
            MarfaError::NoCursor { .. } => marfa_core::CoreErrorKind::NoCursor,
            MarfaError::HydrationIncomplete { .. } => {
                marfa_core::CoreErrorKind::HydrationIncomplete
            }
            MarfaError::NoCatalog { .. } => marfa_core::CoreErrorKind::NoCatalog,
            MarfaError::ReadingHandle { .. } => marfa_core::CoreErrorKind::ReadingHandle,
            MarfaError::WrongSchema { .. } => marfa_core::CoreErrorKind::WrongSchema,
            MarfaError::CopyExpired { .. } => marfa_core::CoreErrorKind::CopyExpired,
            MarfaError::StreamIncomplete { .. } => marfa_core::CoreErrorKind::StreamIncomplete,
            MarfaError::WrongServer { .. } => marfa_core::CoreErrorKind::WrongServer,
            MarfaError::BytesAbsent { .. } => marfa_core::CoreErrorKind::BytesAbsent,
            MarfaError::ContractMismatch { .. } => marfa_core::CoreErrorKind::ContractMismatch,
            MarfaError::Canceled { .. } => marfa_core::CoreErrorKind::Canceled,
            MarfaError::FirstSyncWaiting { .. } => marfa_core::CoreErrorKind::FirstSyncWaiting,
            MarfaError::Invalid { .. } => marfa_core::CoreErrorKind::Invalid,
        };
        kind.code().to_string()
    }
}

impl std::fmt::Display for MarfaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<marfa_core::CoreError> for MarfaError {
    fn from(error: marfa_core::CoreError) -> Self {
        use marfa_core::CoreError as E;
        let message = error.to_string();
        match error {
            E::RenewalFailed(cause) => Self::from(*cause),
            E::NotFound { code, .. } => MarfaError::NotFound { code, message },
            E::Unauthorized { code, .. } => MarfaError::Unauthorized { code, message },
            E::Forbidden { code, .. } => MarfaError::Forbidden { code, message },
            E::Validation { code, .. } => MarfaError::Validation { code, message },
            E::UnknownType { .. } => MarfaError::UnknownType { message },
            E::RateLimited {
                code,
                retry_after_seconds,
                ..
            } => MarfaError::RateLimited {
                code,
                message,
                retry_after_seconds,
            },
            E::Server { status, code, .. } => MarfaError::Server {
                status,
                code,
                message,
            },
            E::Io(_) => MarfaError::Io { message },
            E::Network(_) => MarfaError::Network { message },
            E::Unnamed { status, .. } => MarfaError::Unnamed { status, message },
            E::Decoding(_) => MarfaError::Decoding { message },
            E::Store(_) => MarfaError::Store { message },
            E::Redirected {
                origin,
                status,
                location,
            } => MarfaError::Redirected {
                origin,
                status,
                location,
                message,
            },
            E::StorageFull(_) => MarfaError::StorageFull { message },
            E::SignedOut { origin } => MarfaError::SignedOut { origin, message },
            E::NoKeychain(_) => MarfaError::NoKeychain { message },
            E::NoServer => MarfaError::NoServer { message },
            E::NoCursor => MarfaError::NoCursor { message },
            E::HydrationIncomplete => MarfaError::HydrationIncomplete { message },
            E::NoCatalog => MarfaError::NoCatalog { message },
            E::WrongSchema {
                path,
                reason,
                unsent,
            } => MarfaError::WrongSchema {
                path,
                reason,
                unsent,
                message,
            },
            E::ReadingHandle => MarfaError::ReadingHandle { message },
            E::CopyExpired { reason } => MarfaError::CopyExpired { reason, message },
            E::StreamIncomplete { reason } => MarfaError::StreamIncomplete { reason, message },
            E::WrongServer { expected, got } => MarfaError::WrongServer {
                expected,
                got,
                message,
            },
            E::BytesAbsent { hash, reason } => MarfaError::BytesAbsent {
                hash,
                reason,
                message,
            },
            E::ContractMismatch {
                served,
                expected,
                status,
                write_sent,
                ..
            } => MarfaError::ContractMismatch {
                served,
                expected,
                status,
                write_sent,
                message,
            },
            E::Canceled => MarfaError::Canceled { message },
            E::FirstSyncWaiting => MarfaError::FirstSyncWaiting { message },
            E::Invalid(_) => MarfaError::Invalid { message },
        }
    }
}

impl From<marfa_core::HydrateReport> for HydrateReport {
    fn from(report: marfa_core::HydrateReport) -> Self {
        HydrateReport {
            types: report.types,
            tier: report.tier.into(),
            edge_types: report.edge_types,
            items: report.items,
            edges: report.edges,
            pages: report.pages,
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
        }
    }
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

/// `shown` is what the core's catalog says the item shows.
fn item(item: marfa_core::Item, shown: marfa_core::Shown) -> Item {
    Item {
        id: item.id,
        r#type: item.r#type,
        properties_json: serde_json::Value::Object(item.properties).to_string(),
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
        title: shown.title,
        body: shown.body,
    }
}

impl From<marfa_core::Edge> for Edge {
    fn from(edge: marfa_core::Edge) -> Self {
        Edge {
            id: edge.id,
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: edge.edge_type,
            properties_json: serde_json::Value::Object(edge.properties).to_string(),
            version: edge.version,
            created_at: edge.created_at,
            updated_at: edge.updated_at,
        }
    }
}

impl From<ListFilters> for marfa_core::ListFilters {
    fn from(filters: ListFilters) -> Self {
        marfa_core::ListFilters {
            r#type: filters.r#type,
            state: filters.state.map(Into::into),
            all_states: filters.all_states,
            tier: filters.tier.map(Into::into),
            tags: filters.tags,
            occurred_after: filters.occurred_after,
            occurred_before: filters.occurred_before,
            filter: filters.filter,
            beneath: filters.beneath,
            limit: filters.limit,
            offset: filters.offset,
        }
    }
}

impl From<Sort> for marfa_core::Sort {
    fn from(sort: Sort) -> Self {
        marfa_core::Sort {
            field: match sort.field {
                SortField::CreatedAt => marfa_core::SortField::CreatedAt,
                SortField::UpdatedAt => marfa_core::SortField::UpdatedAt,
                SortField::OccurredAt => marfa_core::SortField::OccurredAt,
            },
            direction: match sort.direction {
                SortDirection::Ascending => marfa_core::SortDirection::Ascending,
                SortDirection::Descending => marfa_core::SortDirection::Descending,
            },
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
            all_states: filters.all_states,
            r#type: filters.r#type,
            tags: filters.tags,
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

fn queued(write: marfa_core::QueuedWrite) -> Result<QueuedWrite, MarfaError> {
    let (verdict, waiting) = crossed(write.outcome()?);
    Ok(QueuedWrite {
        verdict,
        waiting,
        body_json: write.body.to_string(),
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

fn drained(report: marfa_core::DrainReport) -> Result<DrainReport, MarfaError> {
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
        answered: report.answered as u64,
        held: report.held as u64,
        undelivered: report.undelivered as u64,
        unsent: report.unsent as u64,
        unmade: report.unmade as u64,
        unavailable: report.unavailable,
        verdicts,
        stopped: report.stopped,
        unclaimed_sources: report.unclaimed_sources,
        retry_after_seconds: report.retry_after_seconds,
    })
}

fn object(json: &str) -> Result<serde_json::Map<String, serde_json::Value>, MarfaError> {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(MarfaError::Invalid {
            message: "properties must be one JSON object".into(),
        }),
    }
}

/// A local copy of a slice of one server. Every method blocks; call from off
/// the main thread.
#[derive(uniffi::Object)]
pub struct Core {
    inner: marfa_core::Core,
}

/// An item's thumbnail: the image's type and its bytes.
#[derive(uniffi::Record)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// What a held stream changed in the copy: an event it applied, named by the
/// event's type with the item or edge it was about, or `catalog.changed`,
/// naming neither, where a stream it opened read a catalog that differs from
/// the one held. Or what became of the server: `server.unreachable`, with
/// `reason`, once when a stream cannot be had, and `server.reachable` once
/// when one is had again, which is when to drain what waited. `cursor` is
/// the cursor held after it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Change {
    pub event: String,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
    /// The failure the stream could not be had for, on `server.unreachable`
    /// alone, such as the network failing, a rate limit, a failing server or
    /// a refusal naming no contract.
    pub reason: Option<MarfaError>,
}

impl From<&marfa_core::Change> for Change {
    fn from(change: &marfa_core::Change) -> Self {
        Change {
            event: change.event.clone(),
            item_id: change.item_id.clone(),
            edge_id: change.edge_id.clone(),
            cursor: change.cursor.clone(),
            reason: change.reason.clone().map(Into::into),
        }
    }
}

/// What an app hands `follow`: told of each change as it lands, on a thread
/// of the core's, and once when the stream ends, with the error that ended
/// it or none where it was stopped.
#[uniffi::export(with_foreign)]
pub trait ChangeListener: Send + Sync {
    fn changed(&self, change: Change);
    fn ended(&self, error: Option<MarfaError>);
}

/// A held stream or a folder's watch, stopped by `stop` or by letting it go.
/// A follow ends within a quarter second of either; a watch within about a
/// second, or once the pass under way is done. `ended` is called once it has.
#[derive(uniffi::Object)]
pub struct Subscription {
    stop: Arc<AtomicBool>,
}

#[uniffi::export]
impl Subscription {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// The thread holds the core, and with it the writer's claim on the store,
/// so a subscription nobody holds any more must end it.
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[uniffi::export]
impl Core {
    /// Opens a store another process writes, to read it only: never the
    /// writer, never a write, and a path with no store is refused.
    #[uniffi::constructor]
    pub fn open_reader(path: String) -> Result<Arc<Self>, MarfaError> {
        Ok(Arc::new(Core {
            inner: marfa_core::Core::open_reader(path)?,
        }))
    }

    /// A number that moves each time another process saves to the store.
    pub fn data_version(&self) -> Result<i64, MarfaError> {
        Ok(self.inner.data_version()?)
    }

    /// Holds the event stream open on a thread of its own and applies each
    /// event as it arrives, telling `listener` of each change.
    /// `told_unreachable` says the app was last told `server.unreachable` by
    /// a follow before this one, so this one tells `server.reachable` when it
    /// has its first stream.
    pub fn follow(
        self: Arc<Self>,
        told_unreachable: bool,
        listener: Arc<dyn ChangeListener>,
    ) -> Arc<Subscription> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            let ended = self.inner.follow(&flag, told_unreachable, |change| {
                listener.changed(change.into())
            });
            // Let go of the store before saying so: a listener that opens it
            // again on being told must find the writer's role free.
            drop(self);
            listener.ended(ended.err().map(Into::into));
        });
        Arc::new(Subscription { stop })
    }

    /// Opens the file at `path`, creating it when absent. `url` and `key`
    /// go together; without them only local reads work.
    #[uniffi::constructor]
    pub fn open(
        path: String,
        url: Option<String>,
        key: Option<String>,
    ) -> Result<Arc<Self>, MarfaError> {
        let server = match (url, key) {
            (Some(url), Some(key)) => Some(marfa_core::Server { url, key }),
            (None, None) => None,
            _ => {
                return Err(MarfaError::Invalid {
                    message: "url and key go together".into(),
                });
            }
        };
        Ok(Arc::new(Core {
            inner: marfa_core::Core::open(path, server)?,
        }))
    }

    pub fn hydrate(
        &self,
        types: Vec<String>,
        tier: Tier,
        stop: Option<Arc<Stop>>,
    ) -> Result<HydrateReport, MarfaError> {
        self.hydrate_with(types, tier, Vec::new(), stop)
    }

    /// A hydration that also holds every edge of `edge_types` the key reads,
    /// whichever ends the copy holds.
    pub fn hydrate_with(
        &self,
        types: Vec<String>,
        tier: Tier,
        edge_types: Vec<String>,
        stop: Option<Arc<Stop>>,
    ) -> Result<HydrateReport, MarfaError> {
        Ok(self
            .inner
            .hydrate_until(&types, tier.into(), &edge_types, &flag_of(stop))?
            .into())
    }

    /// Declares the types this app saves, each a JSON object with its `id`,
    /// its `fields` and whatever else a type carries. A copy that has never
    /// reached a server checks what it queues against them and the types
    /// Marfa ships, and a hydration registers the ones the instance
    /// lacks, where the key may. The call is the app's whole set and replaces every earlier declaration.
    pub fn declare_types(&self, types: Vec<String>) -> Result<(), MarfaError> {
        let parsed = types
            .iter()
            .map(|text| {
                serde_json::from_str::<serde_json::Value>(text).map_err(|error| {
                    MarfaError::Invalid {
                        message: format!("a type definition is not JSON: {error}"),
                    }
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(self.inner.declare_types(&parsed)?)
    }

    /// The declarations this copy holds, each as JSON, with the empty
    /// `fields` and the `version` a registration needs filled in where the app
    /// left them out.
    pub fn declared_types(&self) -> Result<Vec<String>, MarfaError> {
        Ok(self
            .inner
            .declared_types()?
            .iter()
            .map(serde_json::Value::to_string)
            .collect())
    }

    /// Holds one row by id whatever the slice says of it, read now.
    pub fn pin(&self, id: String) -> Result<PinReport, MarfaError> {
        Ok(PinReport {
            pinned: true,
            was_pinned: self.inner.pin(&id)?,
        })
    }

    /// Stops holding a row by id; one the slice does not take goes, unless
    /// writes to it still wait.
    pub fn unpin(&self, id: String) -> Result<PinReport, MarfaError> {
        Ok(PinReport {
            pinned: false,
            was_pinned: self.inner.unpin(&id)?,
        })
    }

    pub fn catch_up(&self, stop: Option<Arc<Stop>>) -> Result<CatchUpReport, MarfaError> {
        let report = self.inner.catch_up_until(&flag_of(stop))?;
        Ok(CatchUpReport {
            applied: report.applied,
            skipped: report.skipped,
            cursor: report.cursor,
            reached_head: report.reached_head,
        })
    }

    pub fn list(&self, filters: ListFilters, sort: Sort) -> Result<Vec<Item>, MarfaError> {
        Ok(self
            .inner
            .list_shown(&filters.into(), sort.into())?
            .into_iter()
            .map(|(held, shown)| item(held, shown))
            .collect())
    }

    pub fn get(&self, id: String) -> Result<Option<Item>, MarfaError> {
        Ok(self
            .inner
            .get_shown(&id)?
            .map(|(held, shown)| item(held, shown)))
    }

    pub fn edges_from(&self, id: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_from(&id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn edges_to(&self, id: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_to(&id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn edges_of_type(&self, edge_type: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_of_type(&edge_type)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn search(
        &self,
        query: String,
        filters: SearchFilters,
        limit: u32,
    ) -> Result<Vec<SearchHit>, MarfaError> {
        Ok(self
            .inner
            .search_shown(&query, &filters.into(), limit as usize)?
            .into_iter()
            .map(|(hit, shown)| SearchHit {
                item: item(hit.item, shown),
                score: hit.score,
                snippet: hit.snippet,
            })
            .collect())
    }

    pub fn status(&self) -> Result<Status, MarfaError> {
        let status = self.inner.status()?;
        Ok(Status {
            server_origin: status.server_origin,
            instance_id: status.instance_id,
            slice_types: status.slice_types,
            slice_tier: status.slice_tier.map(Into::into),
            slice_edge_types: status.slice_edge_types,
            pinned: status.pinned,
            event_cursor: status.event_cursor,
            hydration: match status.hydration {
                marfa_core::Hydration::Never => Hydration::Never,
                marfa_core::Hydration::InProgress => Hydration::InProgress,
                marfa_core::Hydration::Complete => Hydration::Complete,
                marfa_core::Hydration::Expired => Hydration::Expired,
            },
            items: status.items,
            edges: status.edges,
            catalog_version: status.catalog_version,
        })
    }

    /// Every item type the copy holds, by id, read from the copy alone.
    pub fn item_types(&self) -> Result<Vec<ItemType>, MarfaError> {
        Ok(self
            .inner
            .item_types()?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// `NotFound` where the catalog holds no such type.
    pub fn item_type(&self, id: String) -> Result<ItemType, MarfaError> {
        Ok(self.inner.item_type(&id)?.into())
    }

    /// Every edge type the copy holds, by id, read from the copy alone.
    pub fn edge_types(&self) -> Result<Vec<EdgeType>, MarfaError> {
        Ok(self
            .inner
            .edge_types()?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// `NotFound` where the catalog holds no such edge type.
    pub fn edge_type(&self, id: String) -> Result<EdgeType, MarfaError> {
        Ok(self.inner.edge_type(&id)?.into())
    }

    /// Which handle this process holds: the one that may write, or a second
    /// opener that reads and refuses every write. Not `handle`, which the
    /// generated Swift object already uses for its own pointer.
    pub fn held_handle(&self) -> Handle {
        match self.inner.handle() {
            marfa_core::Handle::Writer => Handle::Writer,
            marfa_core::Handle::Reader => Handle::Reader,
        }
    }

    /// Writes a new item into the local copy and queues it for the server.
    pub fn create_item(&self, draft: Draft) -> Result<QueuedWrite, MarfaError> {
        let draft = marfa_core::Draft {
            properties: object(&draft.properties_json)?,
            r#type: draft.r#type,
            id: draft.id,
            tags: draft.tags,
            tier: draft.tier.map(Into::into),
            source: draft.source,
            source_id: draft.source_id,
            occurred_at: draft.occurred_at,
            base_version: draft.base_version,
        };
        queued(self.inner.create_item(&draft)?)
    }

    /// Changes an item in the local copy and queues the change.
    pub fn update_item(&self, id: String, edit: Edit) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.update_item(&id, &edit.core()?)?)
    }

    /// Changes an item in the local copy and queues the change, based on a
    /// version read before the one the copy holds now, which the server
    /// merges the change against.
    pub fn update_item_as_read(&self, id: String, edit: Edit) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.update_item_as_read(&id, &edit.core()?)?)
    }

    /// Moves an item to the bin locally and queues the delete.
    pub fn delete_item(&self, id: String) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.delete_item(&id)?)
    }

    /// Takes an item out of the bin locally and queues the restore.
    pub fn restore_item(&self, id: String) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.restore_item(&id)?)
    }

    /// Moves an item to another lifecycle state.
    pub fn transition_item(&self, id: String, state: ItemState) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.transition_item(&id, state.into())?)
    }

    /// Links two items. An edge is its own write.
    pub fn create_edge(&self, draft: EdgeDraft) -> Result<QueuedWrite, MarfaError> {
        let draft = marfa_core::EdgeDraft {
            properties: object(&draft.properties_json)?,
            source_id: draft.source_id,
            target_id: draft.target_id,
            edge_type: draft.edge_type,
            id: draft.id,
        };
        queued(self.inner.create_edge(&draft)?)
    }

    pub fn update_edge(&self, id: String, edit: EdgeEdit) -> Result<QueuedWrite, MarfaError> {
        let edit = marfa_core::EdgeEdit {
            properties: object(&edit.properties_json)?,
            base_version: edit.base_version,
            ..Default::default()
        };
        queued(self.inner.update_edge(&id, &edit)?)
    }

    pub fn delete_edge(&self, id: String) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.delete_edge(&id)?)
    }

    /// Puts one tag on an item, as its own write.
    pub fn add_tag(&self, id: String, tag: String) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.add_tag(&id, &tag)?)
    }

    pub fn remove_tag(&self, id: String, tag: String) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.remove_tag(&id, &tag)?)
    }

    /// Writes the item's tags whole, dropping any not named.
    pub fn replace_metadata(
        &self,
        id: String,
        tags: Vec<String>,
    ) -> Result<QueuedWrite, MarfaError> {
        let write = marfa_core::MetadataWrite { tags };
        queued(self.inner.write_metadata(&id, &write, true)?)
    }

    /// Adds the named tags, leaving the rest.
    pub fn merge_metadata(&self, id: String, tags: Vec<String>) -> Result<QueuedWrite, MarfaError> {
        let write = marfa_core::MetadataWrite { tags };
        queued(self.inner.write_metadata(&id, &write, false)?)
    }

    /// Writes one extension namespace, as its own write. The body is one
    /// JSON object.
    pub fn write_extension(
        &self,
        id: String,
        namespace: String,
        body_json: String,
    ) -> Result<QueuedWrite, MarfaError> {
        let body = serde_json::Value::Object(object(&body_json)?).to_string();
        queued(self.inner.write_extension(&id, &namespace, &body)?)
    }

    pub fn delete_extension(
        &self,
        id: String,
        namespace: String,
    ) -> Result<QueuedWrite, MarfaError> {
        queued(self.inner.delete_extension(&id, &namespace)?)
    }

    /// Every queued write and what became of it.
    pub fn queue(&self) -> Result<Vec<QueuedWrite>, MarfaError> {
        self.inner.queue()?.into_iter().map(queued).collect()
    }

    /// Holds a file's bytes beside the store and queues their upload.
    pub fn put_blob(
        &self,
        path: String,
        mime_type: Option<String>,
    ) -> Result<QueuedWrite, MarfaError> {
        queued(
            self.inner
                .put_blob(std::path::Path::new(&path), mime_type.as_deref())?,
        )
    }

    /// Attaches a file to an item: its upload, a file item naming the bytes,
    /// and an `attached-to` edge, three queued writes.
    pub fn attach(
        &self,
        id: String,
        path: String,
        attachment: Attachment,
    ) -> Result<Attached, MarfaError> {
        let attached = self.inner.attach(
            &id,
            std::path::Path::new(&path),
            &marfa_core::Attachment {
                mime_type: attachment.mime_type,
                title: attachment.title,
                r#type: attachment.r#type,
                tier: attachment.tier.map(Into::into),
            },
        )?;
        Ok(Attached {
            upload: queued(attached.upload)?,
            item: queued(attached.item)?,
            edge: queued(attached.edge)?,
        })
    }

    /// Where a blob's bytes are held, fetching them first where this store
    /// does not hold them yet. Refused `BytesAbsent` where they can be
    /// neither read nor fetched.
    pub fn blob(&self, hash: String) -> Result<String, MarfaError> {
        Ok(self.inner.blob(&hash)?.to_string_lossy().into_owned())
    }

    /// Whether a blob's bytes are held beside the store, with no request.
    pub fn blob_held(&self, hash: String) -> Result<bool, MarfaError> {
        Ok(self.inner.blob_held(&hash)?)
    }

    /// The thumbnail an item carries, from the copy with no request; none
    /// where its type declares none or it carries none. An item the copy does
    /// not hold throws `NotFound` with the code `not_held`, and a held value
    /// that is not a thumbnail throws `Decoding` naming the item.
    pub fn thumbnail(&self, id: String) -> Result<Option<Thumbnail>, MarfaError> {
        Ok(self.inner.thumbnail(&id)?.map(|thumbnail| Thumbnail {
            mime_type: thumbnail.mime_type,
            bytes: thumbnail.bytes,
        }))
    }

    /// Sends what the queue holds and records what came back. One pass.
    pub fn drain(&self, stop: Option<Arc<Stop>>) -> Result<DrainReport, MarfaError> {
        drained(self.inner.drain_until(&flag_of(stop))?)
    }

    /// Sends a blocked or dead write again, under a fresh idempotency key.
    /// Answers whether the row was one a release applies to.
    pub fn release(&self, id: String) -> Result<bool, MarfaError> {
        Ok(self.inner.release(&id)?)
    }

    /// Releases every write blocked for one reason, and says how many.
    pub fn release_reason(&self, reason: BlockedReason) -> Result<u64, MarfaError> {
        Ok(self.inner.release_reason(reason.into())? as u64)
    }

    /// Takes a write blocked `ancestor_unavailable` or `conflict_unresolved`
    /// out of the queue, and puts the copy back to what the server holds;
    /// each write held for it is refused unsent. Answers whether the row was
    /// one a withdraw takes.
    pub fn withdraw(&self, id: String) -> Result<bool, MarfaError> {
        Ok(self.inner.withdraw(&id)?)
    }

    /// Clears the writes the server has answered, and says how many went. A
    /// refused write that carried content stays until it is discarded.
    pub fn forget_answered(&self) -> Result<u64, MarfaError> {
        Ok(self.inner.forget_answered()? as u64)
    }

    /// Takes a refused write out of the queue, with the content it carried.
    /// Answers whether the row was one a discard takes: refused, and with no
    /// write still waiting on it.
    pub fn discard(&self, id: String) -> Result<bool, MarfaError> {
        Ok(self.inner.discard(&id)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_crosses_with_the_code_the_core_names_it_by() {
        use marfa_core::CoreError as E;
        let text = || "text".to_string();
        let all = vec![
            E::NotFound {
                code: text(),
                message: text(),
            },
            E::Unauthorized {
                code: text(),
                message: text(),
            },
            E::Forbidden {
                code: text(),
                message: text(),
            },
            E::Validation {
                code: text(),
                message: text(),
            },
            E::UnknownType { message: text() },
            E::RateLimited {
                code: text(),
                message: text(),
                retry_after_seconds: None,
            },
            E::Server {
                status: 500,
                code: text(),
                message: text(),
            },
            E::Io(text()),
            E::Network(text()),
            E::Unnamed {
                origin: text(),
                status: 502,
                retry_after_seconds: None,
            },
            E::Decoding(text()),
            E::SignedOut { origin: text() },
            E::NoKeychain(text()),
            E::StorageFull(text()),
            E::Store(text()),
            E::Redirected {
                origin: text(),
                status: 302,
                location: None,
            },
            E::NoServer,
            E::NoCursor,
            E::HydrationIncomplete,
            E::NoCatalog,
            E::ReadingHandle,
            E::FirstSyncWaiting,
            E::WrongSchema {
                path: text(),
                reason: text(),
                unsent: None,
            },
            E::CopyExpired { reason: text() },
            E::StreamIncomplete { reason: text() },
            E::WrongServer {
                expected: text(),
                got: text(),
            },
            E::BytesAbsent {
                hash: text(),
                reason: text(),
            },
            E::ContractMismatch {
                origin: text(),
                served: None,
                expected: 1,
                status: None,
                write_sent: false,
            },
            E::Invalid(text()),
            E::Canceled,
        ];
        for error in &all {
            assert_eq!(MarfaError::from(error.clone()).code(), error.code());
        }
        let mut named: Vec<&str> = all.iter().map(E::code).collect();
        named.sort_unstable();
        let mut listed: Vec<&str> = marfa_core::ERROR_CODES.to_vec();
        listed.sort_unstable();
        assert_eq!(named, listed, "a code of the core's has no case here");
        let wrapped = E::RenewalFailed(Box::new(E::Forbidden {
            code: text(),
            message: text(),
        }));
        assert_eq!(MarfaError::from(wrapped.clone()).code(), wrapped.code());
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
        let fields = vec!["title".to_string()];
        assert_eq!(crossed(None), (None, false));
        assert_eq!(crossed(Some(O::Accepted)), (Some(Verdict::Accepted), false));
        assert_eq!(
            crossed(Some(O::Merged {
                fields: fields.clone()
            })),
            (
                Some(Verdict::Merged {
                    fields: fields.clone()
                }),
                false
            )
        );
        assert_eq!(
            crossed(Some(O::Conflicted {
                sibling_id: "s".into(),
                fields: fields.clone()
            })),
            (
                Some(Verdict::Conflicted {
                    sibling_id: "s".into(),
                    fields
                }),
                false
            )
        );
        let refusal = marfa_core::Refusal::read(
            "type_not_permitted",
            Some(
                r#"{"error":{"code":"type_not_permitted","message":"no","details":{"trashed":true,"errors":[{"field":"title","message":"long"}],"grant":{"kind":"extension","name":"acme","level":"read"}}}}"#,
            ),
        );
        assert_eq!(
            crossed(Some(O::Refused(refusal))),
            (
                Some(Verdict::Refused {
                    refusal: Refusal {
                        reason: "type_not_permitted".into(),
                        code: Some("type_not_permitted".into()),
                        message: Some("no".into()),
                        fields: vec![FieldRefusal {
                            field: "title".into(),
                            message: "long".into()
                        }],
                        trashed: true,
                        grant: Some(MissingGrant {
                            kind: GrantKind::Extension,
                            name: "acme".into(),
                            level: GrantLevel::Read,
                        }),
                    }
                }),
                false
            )
        );
        for reason in marfa_core::BlockedReason::ALL {
            assert_eq!(
                crossed(Some(O::Blocked {
                    reason,
                    refusal: None
                })),
                (
                    Some(Verdict::Blocked {
                        reason: reason.into(),
                        refusal: None,
                    }),
                    false
                )
            );
        }
        assert_eq!(
            crossed(Some(O::Waiting)),
            (None, true),
            "a write held behind another crossed as a verdict"
        );
        assert_eq!(crossed(Some(O::Dead)), (Some(Verdict::Dead), false));
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
    fn every_core_error_crosses_as_its_own_case() {
        use marfa_core::CoreError as E;
        let text = || "x".to_string();
        let crossed: Vec<(MarfaError, &str)> = vec![
            (
                E::NotFound {
                    code: text(),
                    message: text(),
                }
                .into(),
                "NotFound",
            ),
            (
                E::Unauthorized {
                    code: text(),
                    message: text(),
                }
                .into(),
                "Unauthorized",
            ),
            (
                E::Forbidden {
                    code: text(),
                    message: text(),
                }
                .into(),
                "Forbidden",
            ),
            (
                E::Validation {
                    code: text(),
                    message: text(),
                }
                .into(),
                "Validation",
            ),
            (E::UnknownType { message: text() }.into(), "UnknownType"),
            (
                E::RateLimited {
                    code: text(),
                    message: text(),
                    retry_after_seconds: Some(1),
                }
                .into(),
                "RateLimited",
            ),
            (
                E::Server {
                    status: 500,
                    code: text(),
                    message: text(),
                }
                .into(),
                "Server",
            ),
            (E::Network(text()).into(), "Network"),
            (E::Io(text()).into(), "Io"),
            (
                E::RenewalFailed(Box::new(E::NoKeychain(text()))).into(),
                "NoKeychain",
            ),
            (
                E::Redirected {
                    origin: text(),
                    status: 302,
                    location: None,
                }
                .into(),
                "Redirected",
            ),
            (E::Decoding(text()).into(), "Decoding"),
            (E::Store(text()).into(), "Store"),
            (E::StorageFull(text()).into(), "StorageFull"),
            (E::SignedOut { origin: text() }.into(), "SignedOut"),
            (E::NoKeychain(text()).into(), "NoKeychain"),
            (E::NoServer.into(), "NoServer"),
            (E::NoCursor.into(), "NoCursor"),
            (E::HydrationIncomplete.into(), "HydrationIncomplete"),
            (E::NoCatalog.into(), "NoCatalog"),
            (E::ReadingHandle.into(), "ReadingHandle"),
            (
                E::WrongSchema {
                    path: text(),
                    reason: text(),
                    unsent: Some(1),
                }
                .into(),
                "WrongSchema",
            ),
            (E::CopyExpired { reason: text() }.into(), "CopyExpired"),
            (
                E::StreamIncomplete { reason: text() }.into(),
                "StreamIncomplete",
            ),
            (
                E::WrongServer {
                    expected: text(),
                    got: text(),
                }
                .into(),
                "WrongServer",
            ),
            (
                E::BytesAbsent {
                    hash: "sha256:h".into(),
                    reason: text(),
                }
                .into(),
                "BytesAbsent",
            ),
            (
                E::ContractMismatch {
                    origin: text(),
                    served: Some("4".into()),
                    expected: 3,
                    status: Some(200),
                    write_sent: false,
                }
                .into(),
                "ContractMismatch",
            ),
            (E::Invalid(text()).into(), "Invalid"),
            (
                E::Unnamed {
                    origin: text(),
                    status: 401,
                    retry_after_seconds: None,
                }
                .into(),
                "Unnamed",
            ),
        ];
        for (error, name) in &crossed {
            let debug = format!("{error:?}");
            assert!(
                debug.starts_with(&format!("{name} ")) || debug.starts_with(&format!("{name} {{")),
                "{name} crossed as {debug}"
            );
        }
        assert!(matches!(
            &crossed.iter().find(|(_, name)| *name == "BytesAbsent").unwrap().0,
            MarfaError::BytesAbsent { hash, .. } if hash == "sha256:h"
        ));
        assert!(matches!(
            &crossed.iter().find(|(_, name)| *name == "ContractMismatch").unwrap().0,
            MarfaError::ContractMismatch { served: Some(served), expected: 3, .. } if served == "4"
        ));
        assert!(matches!(
            &crossed
                .iter()
                .find(|(_, name)| *name == "Unnamed")
                .unwrap()
                .0,
            MarfaError::Unnamed { status: 401, .. }
        ));
    }

    #[test]
    fn a_contract_refusal_crosses_with_its_status_and_whether_a_write_went() {
        for (status, write_sent) in [(Some(201), true), (Some(200), false), (None, false)] {
            let crossed: MarfaError = marfa_core::CoreError::ContractMismatch {
                origin: "https://marfa.example".into(),
                served: None,
                expected: 3,
                status,
                write_sent,
            }
            .into();
            assert!(
                matches!(
                    crossed,
                    MarfaError::ContractMismatch {
                        served: None,
                        expected: 3,
                        status: crossed_status,
                        write_sent: crossed_write,
                        ..
                    } if crossed_status == status && crossed_write == write_sent
                ),
                "{crossed:?}"
            );
        }
    }

    #[test]
    fn a_copy_that_never_reached_a_server_holds_the_types_marfa_ships() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None).unwrap();
        assert_eq!(core.status().unwrap().catalog_version, None);
        assert!(
            core.item_types()
                .unwrap()
                .iter()
                .any(|held| held.id == "core.note")
        );
        assert_eq!(core.edge_type("parent-of".into()).unwrap().id, "parent-of");
    }

    #[test]
    fn an_edge_type_crosses_with_its_reverse_name_and_the_end_that_writes_it() {
        let mut held = marfa_core::EdgeType {
            id: "mentor-of".into(),
            label: None,
            description: None,
            cardinality: "one-to-many".into(),
            reverse_name: Some("mentored-by".into()),
            written_at: marfa_core::End::Target,
            source_type_constraints: vec!["*".into()],
            target_type_constraints: vec!["*".into()],
            cascade_on_delete: "orphan".into(),
            properties: vec![marfa_core::TypeField {
                name: "since".into(),
                r#type: "string".into(),
                required: false,
                description: None,
                declared_by: "mentor-of".into(),
                definition: serde_json::json!({ "type": "string" }),
            }],
            shipped: false,
        };
        let crossed = EdgeType::from(held.clone());
        assert_eq!(crossed.reverse_name.as_deref(), Some("mentored-by"));
        assert_eq!(crossed.written_at, EdgeEnd::Target);
        assert_eq!(
            crossed.properties[0].definition_json,
            r#"{"type":"string"}"#
        );
        held.written_at = marfa_core::End::Source;
        assert_eq!(EdgeType::from(held).written_at, EdgeEnd::Source);
    }

    #[test]
    fn list_filters_cross_whole() {
        let crossed: marfa_core::ListFilters = ListFilters {
            r#type: Some("core.note".into()),
            state: Some(ItemState::Archived),
            all_states: true,
            tier: Some(Tier::Feed),
            tags: vec!["a".into()],
            occurred_after: Some("after".into()),
            occurred_before: Some("before".into()),
            filter: Some("tags exists".into()),
            beneath: Some("root".into()),
            limit: Some(3),
            offset: Some(4),
        }
        .into();
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
            all_states: true,
            r#type: Some("core.note".into()),
            tags: vec!["a".into(), "b".into()],
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

    struct Quiet {
        url: String,
        streams: Arc<std::sync::atomic::AtomicUsize>,
        expire: Arc<AtomicBool>,
    }

    fn quiet() -> Quiet {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&streams);
        let expire = Arc::new(AtomicBool::new(false));
        let changed = Arc::clone(&expire);
        let replayed = Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let counted = Arc::clone(&counted);
                let changed = Arc::clone(&changed);
                let replayed = Arc::clone(&replayed);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut head, mut line) = (String::new(), String::new());
                    while reader.read_line(&mut line).unwrap_or(0) > 2 {
                        head.push_str(&line);
                        line.clear();
                    }
                    let path = head.split_whitespace().nth(1).unwrap_or("/");
                    let path = path.split('?').next().unwrap_or("/").to_string();
                    let resumed = head.to_ascii_lowercase().contains("last-event-id");
                    let mut stream = stream;
                    let contract = marfa_core::contract::CONTRACT_VERSION;
                    let fence = "a".repeat(64);
                    let instance = "00000000-0000-7000-8000-000000000000";
                    let proof = if head.to_ascii_lowercase().contains("x-marfa-read-view:") {
                        format!("X-Marfa-Read-View: {fence}\r\nCache-Control: no-store\r\n")
                    } else {
                        String::new()
                    };
                    let marker = |kind: &str| {
                        format!(
                            "event: {kind}\ndata: {{\"event_type\":\"{kind}\",\"cursor\":\"10\",\"instance_id\":\"{instance}\",\"read_view\":\"{fence}\"}}\n\n"
                        )
                    };
                    let json = |body: &str| {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marfa-Contract: {contract}\r\n{proof}Connection: close\r\n\r\n{body}",
                            body.len()
                        )
                    };
                    let events = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Marfa-Contract: {contract}\r\nConnection: close\r\n\r\n: connected\n\n"
                    );
                    let _ = match (path.as_str(), resumed) {
                        ("/", _) => stream.write_all(json(r#"{"instance_id":"00000000-0000-7000-8000-000000000000"}"#).as_bytes()),
                        ("/types", _) => stream.write_all(json(r#"{"data":[{"id":"core.note","display_hints":{"title_field":"title"}}],"next_cursor":null}"#).as_bytes()),
                        ("/edge-types", _) => stream.write_all(json(r#"{"data":[],"next_cursor":null}"#).as_bytes()),
                        ("/keys/current", _) => stream.write_all(json(r#"{"type_permissions":{"*":"write"}}"#).as_bytes()),
                        ("/items", _) => stream.write_all(json(r#"{"data":[],"next_cursor":null}"#).as_bytes()),
                        ("/events", false) => stream.write_all(format!("{events}{}", marker("stream_cursor")).as_bytes()),
                        ("/events", true) => {
                            let live = format!("{events}{}{}", marker("stream_cursor"), marker("stream_live"));
                            let _ = stream.write_all(live.as_bytes());
                            if replayed.swap(true, Ordering::SeqCst) {
                                counted.fetch_add(1, Ordering::SeqCst);
                                while stream.write_all(b": keepalive\n\n").is_ok() {
                                    if changed.load(Ordering::SeqCst) {
                                        let _ = stream.write_all(b"event: read_view_changed\ndata: {\"event_type\":\"read_view_changed\"}\n\n");
                                        break;
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                }
                            }
                            Ok(())
                        }
                        _ => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    };
                });
            }
        });
        Quiet {
            url,
            streams,
            expire,
        }
    }

    /// The scenario is the contract's (`queue-and-verdicts.md` 40) and the
    /// device fixtures drive it through the core; what is this binding's own
    /// is how the report crosses.
    #[test]
    fn a_drain_report_crosses_with_what_it_answered_and_could_not_deliver() {
        let report = drained(marfa_core::DrainReport {
            answered: 2,
            held: 1,
            undelivered: 3,
            unsent: 4,
            unmade: 5,
            unavailable: Some("the server could not be reached".into()),
            verdicts: Vec::new(),
            stopped: None,
            unclaimed_sources: vec!["notes".into()],
            retry_after_seconds: Some(7),
        })
        .unwrap();
        assert_eq!(
            (
                report.answered,
                report.held,
                report.undelivered,
                report.unsent,
                report.unmade,
                report.unavailable.as_deref(),
                report.unclaimed_sources,
                report.retry_after_seconds,
            ),
            (
                2,
                1,
                3,
                4,
                5,
                Some("the server could not be reached"),
                vec!["notes".to_string()],
                Some(7)
            )
        );
    }

    struct Told(std::sync::mpsc::Sender<Option<MarfaError>>);

    impl ChangeListener for Told {
        fn changed(&self, _: Change) {}
        fn ended(&self, error: Option<MarfaError>) {
            let _ = self.0.send(error);
        }
    }

    #[test]
    fn a_raised_stop_ends_each_long_call_with_canceled() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, Some(server.url.clone()), Some("k".into())).unwrap();
        let raised = || {
            let stop = Stop::new();
            stop.raise();
            Some(stop)
        };
        let canceled = |error: MarfaError| {
            assert_eq!(error.code(), "canceled");
            matches!(error, MarfaError::Canceled { .. })
        };
        assert!(canceled(
            core.hydrate(vec!["core.note".into()], Tier::Library, raised())
                .unwrap_err()
        ));
        assert!(canceled(core.drain(raised()).unwrap_err()));
        // The witness: given none, the same calls run to their end.
        core.hydrate(vec!["core.note".into()], Tier::Library, Some(Stop::new()))
            .unwrap();
        assert!(canceled(core.catch_up(raised()).unwrap_err()));
        core.catch_up(None).unwrap();
        core.drain(None).unwrap();
    }

    fn draft(r#type: &str, properties_json: &str) -> Draft {
        Draft {
            r#type: r#type.into(),
            id: None,
            properties_json: properties_json.into(),
            tags: Vec::new(),
            tier: None,
            source: None,
            source_id: None,
            occurred_at: None,
            base_version: None,
        }
    }

    fn edit(properties_json: &str, base_version: i64) -> Edit {
        Edit {
            properties_json: properties_json.into(),
            replace_properties: false,
            base_version: Some(base_version),
            source_id: None,
            r#type: None,
            tier: None,
        }
    }

    #[test]
    fn an_edit_crosses_with_its_move_and_its_whole_properties() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None).unwrap();
        let note = core
            .create_item(draft(
                "core.note",
                r#"{"body":"b","title":"t","notes":"n"}"#,
            ))
            .unwrap()
            .item_id
            .unwrap();
        let body = |write: &QueuedWrite| {
            serde_json::from_str::<serde_json::Value>(&write.body_json).unwrap()
        };

        let merged = core
            .update_item(note.clone(), edit(r#"{"title":"T"}"#, 0))
            .unwrap();
        assert_eq!(body(&merged).get("properties_mode"), None);
        let held = core.get(note.clone()).unwrap().unwrap();
        assert_eq!(
            held.properties_json,
            r#"{"body":"b","title":"T","notes":"n"}"#
        );

        let replaced = core
            .update_item(
                note.clone(),
                Edit {
                    replace_properties: true,
                    ..edit(r#"{"body":"b2"}"#, 0)
                },
            )
            .unwrap();
        assert_eq!(body(&replaced)["properties_mode"], "replace");
        assert_eq!(
            core.get(note.clone()).unwrap().unwrap().properties_json,
            r#"{"body":"b2"}"#,
            "a whole edit left the properties it did not name"
        );

        let moved = core
            .update_item(
                note.clone(),
                Edit {
                    r#type: Some("core.task".into()),
                    tier: Some(Tier::Feed),
                    ..edit(r#"{"title":"a task"}"#, 0)
                },
            )
            .unwrap();
        assert_eq!(
            (
                &body(&moved)["type"],
                &body(&moved)["retype"],
                &body(&moved)["tier"]
            ),
            (
                &serde_json::json!("core.task"),
                &serde_json::json!(true),
                &serde_json::json!("feed")
            )
        );
        let held = core.get(note.clone()).unwrap().unwrap();
        assert_eq!(
            (held.r#type.as_str(), held.tier),
            ("core.task", Some(Tier::Feed))
        );

        let queued = core.queue().unwrap().len();
        assert!(matches!(
            core.update_item(
                note.clone(),
                Edit {
                    r#type: Some("acme.nothing".into()),
                    ..edit("{}", 0)
                },
            ),
            Err(MarfaError::UnknownType { .. })
        ));
        assert_eq!(
            core.queue().unwrap().len(),
            queued,
            "a retype to a type the catalog does not hold was queued"
        );
        assert_eq!(core.get(note).unwrap().unwrap().r#type, "core.task");
    }

    #[test]
    fn an_item_crosses_with_the_title_and_body_its_type_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None).unwrap();
        let event = core
            .create_item(draft(
                "core.event",
                r#"{"title":"Standup","description":"Daily","body":"not the body","starts_at":"2026-01-01T09:00:00Z"}"#,
            ))
            .unwrap()
            .item_id
            .unwrap();
        let held = core.get(event).unwrap().unwrap();
        assert_eq!(
            (held.title.as_deref(), held.body.as_deref()),
            (Some("Standup"), Some("Daily")),
            "an event's body was read from somewhere other than its description"
        );
        let listed = core
            .list(
                ListFilters::default(),
                Sort {
                    field: SortField::CreatedAt,
                    direction: SortDirection::Descending,
                },
            )
            .unwrap();
        assert_eq!(listed[0].body.as_deref(), Some("Daily"));
    }

    #[test]
    fn a_copy_declares_types_and_hands_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None).unwrap();
        core.declare_types(vec![
            r#"{"id":"app.recipe.entry","fields":{"title":{"type":"string","required":true}}}"#
                .into(),
        ])
        .unwrap();
        let held = core.declared_types().unwrap();
        assert_eq!(held.len(), 1);
        assert!(held[0].contains("app.recipe.entry"));
        assert!(matches!(
            core.declare_types(vec!["not json".into()]),
            Err(MarfaError::Invalid { .. })
        ));
    }

    #[test]
    fn a_subscription_let_go_ends_its_follow() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, Some(server.url.clone()), Some("k".into())).unwrap();
        core.hydrate(vec!["core.note".into()], Tier::Library, None)
            .unwrap();
        let (told, ended) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core).follow(false, Arc::new(Told(told)));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while server.streams.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < until,
                "the follow never held a stream"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(subscription);
        assert_eq!(
            ended.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(None),
            "a subscription let go left its follow holding the store"
        );
    }

    #[test]
    fn read_view_expiry_ends_subscription_once_with_typed_error() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path.clone(), Some(server.url.clone()), Some("k".into())).unwrap();
        core.hydrate(vec!["core.note".into()], Tier::Library, None)
            .unwrap();
        let reader = Core::open_reader(path).unwrap();
        let (told, ended) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core).follow(false, Arc::new(Told(told)));
        server.expire.store(true, Ordering::SeqCst);
        let error = ended
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(
            matches!(error, Some(MarfaError::CopyExpired { reason, .. }) if reason == "read_view_changed")
        );
        assert!(matches!(
            reader.status().unwrap().hydration,
            Hydration::Expired
        ));
        assert!(matches!(
            reader.get("absent".into()),
            Err(MarfaError::HydrationIncomplete { .. })
        ));
        drop(subscription);
        assert!(
            ended
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err()
        );
    }

    struct Reopens {
        path: String,
        handle: std::sync::mpsc::Sender<Handle>,
    }

    impl ChangeListener for Reopens {
        fn changed(&self, _: Change) {}
        fn ended(&self, _: Option<MarfaError>) {
            let reopened = Core::open(self.path.clone(), None, None).unwrap();
            let _ = self.handle.send(reopened.held_handle());
        }
    }

    #[test]
    fn a_follow_lets_go_of_the_store_before_it_says_it_ended() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path.clone(), Some(server.url.clone()), Some("k".into())).unwrap();
        core.hydrate(vec!["core.note".into()], Tier::Library, None)
            .unwrap();
        let (handle, reopened) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core).follow(false, Arc::new(Reopens { path, handle }));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while server.streams.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < until,
                "the follow never held a stream"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(core);
        subscription.stop();
        let handle = reopened
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the follow never said it ended");
        assert!(
            matches!(handle, Handle::Writer),
            "a store opened again on being told the follow ended was still held by it"
        );
    }

    #[test]
    fn a_store_opened_to_read_is_never_made_never_the_writer_and_hears_of_saves() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("absent.sqlite");
        assert!(Core::open_reader(absent.display().to_string()).is_err());
        assert!(
            !absent.exists(),
            "a reading open made a store where there was none"
        );

        let server = quiet();
        let path = dir.path().join("core.sqlite").display().to_string();
        let writer = Core::open(path.clone(), Some(server.url), Some("k".into())).unwrap();
        writer
            .hydrate(vec!["core.note".into()], Tier::Library, None)
            .unwrap();
        let reader = Core::open_reader(path).unwrap();
        assert!(matches!(reader.held_handle(), Handle::Reader));
        let before = reader.data_version().unwrap();
        writer
            .create_item(Draft {
                r#type: "core.note".into(),
                id: None,
                properties_json: r#"{"title":"saved"}"#.into(),
                tags: Vec::new(),
                tier: None,
                source: None,
                source_id: None,
                occurred_at: None,
                base_version: None,
            })
            .unwrap();
        assert_ne!(
            reader.data_version().unwrap(),
            before,
            "the writer saved and the reader was not told"
        );
    }
}
