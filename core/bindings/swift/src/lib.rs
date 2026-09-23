//! The Swift-facing shape of `marfa_core`. Properties cross as a JSON string
//! because UniFFI has no arbitrary-JSON type.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

uniffi::setup_scaffolding!();

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
/// subtree, and tags, each read as the list reads it.
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
    pub snippet: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct HydrateReport {
    pub types: Vec<String>,
    pub tier: Tier,
    pub items: u64,
    pub edges: u64,
    pub pages: u64,
    pub cursor: String,
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
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: u64,
    pub edges: u64,
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
    /// The server's code verbatim, or the sentence naming the write this one
    /// waited on where that write was refused.
    Refused {
        reason: String,
    },
    Blocked {
        reason: BlockedReason,
    },
    /// Refused until the ceiling; released by id. The row's `answer` holds
    /// the last answer it got.
    Dead,
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
    /// Required: an update naming no version is refused before it is sent.
    #[uniffi(default = None)]
    pub base_version: Option<i64>,
    /// The natural key to move the row to.
    #[uniffi(default = None)]
    pub source_id: Option<String>,
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
    pub depends_on: Vec<String>,
    pub verdict: Option<Verdict>,
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

/// What became of one write a drain sent.
#[derive(Debug, Clone, uniffi::Record)]
pub struct DrainVerdict {
    pub id: String,
    pub kind: WriteKind,
    pub item_id: Option<String>,
    pub verdict: Option<Verdict>,
    pub refusals: i64,
    /// The server answered from its record of this idempotency key rather
    /// than writing again.
    pub replayed: bool,
}

/// What a drain did.
#[derive(Debug, Clone, uniffi::Record)]
pub struct DrainReport {
    pub sent: u64,
    pub held: u64,
    pub verdicts: Vec<DrainVerdict>,
    /// Why the drain stopped before the queue was empty, where it did.
    pub stopped: Option<String>,
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
    Network {
        message: String,
    },
    Decoding {
        message: String,
    },
    Store {
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
    WrongSchema {
        expected: String,
        found: String,
        /// The store the caller has to discard. Carried rather than left in
        /// the message, because a Swift caller showing this to a person has
        /// to be able to name the file without parsing prose out of it.
        path: String,
        message: String,
    },
    ReadingHandle {
        message: String,
    },
    CatchUpTooOld {
        min_retained_id: String,
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
            | MarfaError::Network { message }
            | MarfaError::Decoding { message }
            | MarfaError::Store { message }
            | MarfaError::NoServer { message }
            | MarfaError::NoCursor { message }
            | MarfaError::HydrationIncomplete { message }
            | MarfaError::WrongSchema { message, .. }
            | MarfaError::ReadingHandle { message }
            | MarfaError::CatchUpTooOld { message, .. }
            | MarfaError::StreamIncomplete { message, .. }
            | MarfaError::WrongServer { message, .. }
            | MarfaError::BytesAbsent { message, .. }
            | MarfaError::Invalid { message } => message,
        }
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
            E::Network(_) => MarfaError::Network { message },
            E::Decoding(_) => MarfaError::Decoding { message },
            E::Store(_) => MarfaError::Store { message },
            E::NoServer => MarfaError::NoServer { message },
            E::NoCursor => MarfaError::NoCursor { message },
            E::HydrationIncomplete => MarfaError::HydrationIncomplete { message },
            E::WrongSchema {
                expected,
                found,
                path,
            } => MarfaError::WrongSchema {
                expected,
                found,
                path,
                message,
            },
            E::ReadingHandle => MarfaError::ReadingHandle { message },
            E::CatchUpTooOld { min_retained_id } => MarfaError::CatchUpTooOld {
                min_retained_id,
                message,
            },
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
            E::Invalid(_) => MarfaError::Invalid { message },
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

impl From<marfa_core::Item> for Item {
    fn from(item: marfa_core::Item) -> Self {
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
        }
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
        }
    }
}

impl From<marfa_core::Outcome> for Verdict {
    fn from(outcome: marfa_core::Outcome) -> Self {
        use marfa_core::Outcome as O;
        match outcome {
            O::Accepted => Verdict::Accepted,
            O::Merged { fields } => Verdict::Merged { fields },
            O::Conflicted { sibling_id, fields } => Verdict::Conflicted { sibling_id, fields },
            O::Refused { reason } => Verdict::Refused { reason },
            O::Blocked { reason } => Verdict::Blocked {
                reason: reason.into(),
            },
            O::Dead => Verdict::Dead,
        }
    }
}

fn queued(write: marfa_core::QueuedWrite) -> Result<QueuedWrite, MarfaError> {
    Ok(QueuedWrite {
        verdict: write.outcome()?.map(Into::into),
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
            verdict: entry.outcome()?.map(Into::into),
            id: entry.id,
            kind: entry.kind.into(),
            item_id: entry.item_id,
            refusals: entry.refusals,
            replayed: entry.replayed,
        });
    }
    Ok(DrainReport {
        sent: report.sent as u64,
        held: report.held as u64,
        verdicts,
        stopped: report.stopped,
        retry_after_seconds: report.retry_after_seconds,
    })
}

/// A property bag from Swift, which crosses as JSON text. Anything but an
/// object is refused rather than coerced, since a device sends what it was
/// given.
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
pub struct MarfaCore {
    inner: marfa_core::Core,
}

/// One event a held stream applied: what it was, what it was about, and the
/// cursor it left.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Change {
    pub event: String,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
}

impl From<&marfa_core::Change> for Change {
    fn from(change: &marfa_core::Change) -> Self {
        Change {
            event: change.event.clone(),
            item_id: change.item_id.clone(),
            edge_id: change.edge_id.clone(),
            cursor: change.cursor.clone(),
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

/// A held stream, stopped by `stop` or by letting it go. The follow ends
/// within a quarter second of either, and `ended` is called once it has.
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

/// The follow's thread holds the core, and with it the writer's claim on
/// the store, so a subscription nobody holds any more must end it.
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[uniffi::export]
impl MarfaCore {
    /// Opens a store another process writes, to read it only: never the
    /// writer, never a write, and a path with no store is refused.
    #[uniffi::constructor]
    pub fn open_reader(path: String) -> Result<Arc<Self>, MarfaError> {
        Ok(Arc::new(MarfaCore {
            inner: marfa_core::Core::open_reader(path)?,
        }))
    }

    /// A number that moves each time another process saves to the store.
    pub fn data_version(&self) -> Result<i64, MarfaError> {
        Ok(self.inner.data_version()?)
    }

    /// Holds the event stream open on a thread of its own and applies each
    /// event as it arrives, telling `listener` of each change.
    pub fn follow(self: Arc<Self>, listener: Arc<dyn ChangeListener>) -> Arc<Subscription> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            let ended = self
                .inner
                .follow(&flag, |change| listener.changed(change.into()));
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
        Ok(Arc::new(MarfaCore {
            inner: marfa_core::Core::open(path, server)?,
        }))
    }

    pub fn hydrate(&self, types: Vec<String>, tier: Tier) -> Result<HydrateReport, MarfaError> {
        let report = self.inner.hydrate(&types, tier.into())?;
        Ok(HydrateReport {
            types: report.types,
            tier: report.tier.into(),
            items: report.items,
            edges: report.edges,
            pages: report.pages,
            cursor: report.cursor,
        })
    }

    pub fn catch_up(&self) -> Result<CatchUpReport, MarfaError> {
        let report = self.inner.catch_up()?;
        Ok(CatchUpReport {
            applied: report.applied,
            skipped: report.skipped,
            cursor: report.cursor,
            reached_head: report.reached_head,
        })
    }

    pub fn list(&self, filters: ListFilters, sort: Sort) -> Result<Vec<Item>, MarfaError> {
        let items = self.inner.list(&filters.into(), sort.into())?;
        Ok(items.into_iter().map(Into::into).collect())
    }

    pub fn get(&self, id: String) -> Result<Option<Item>, MarfaError> {
        Ok(self.inner.get(&id)?.map(Into::into))
    }

    pub fn edges_from(&self, id: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_from(&id)?
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
        let hits = self.inner.search(&query, &filters.into(), limit as usize)?;
        Ok(hits
            .into_iter()
            .map(|hit| SearchHit {
                item: hit.item.into(),
                score: hit.score,
                snippet: hit.snippet,
            })
            .collect())
    }

    pub fn status(&self) -> Result<Status, MarfaError> {
        let status = self.inner.status()?;
        Ok(Status {
            server_origin: status.server_origin,
            slice_types: status.slice_types,
            slice_tier: status.slice_tier.map(Into::into),
            event_cursor: status.event_cursor,
            hydration: match status.hydration {
                marfa_core::Hydration::Never => Hydration::Never,
                marfa_core::Hydration::InProgress => Hydration::InProgress,
                marfa_core::Hydration::Complete => Hydration::Complete,
                marfa_core::Hydration::Expired => Hydration::Expired,
            },
            items: status.items,
            edges: status.edges,
        })
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
        let edit = marfa_core::Edit {
            properties: object(&edit.properties_json)?,
            base_version: edit.base_version,
            source_id: edit.source_id,
        };
        queued(self.inner.update_item(&id, &edit)?)
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

    /// Sends what the queue holds and records what came back. One pass.
    pub fn drain(&self) -> Result<DrainReport, MarfaError> {
        drained(self.inner.drain()?)
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

    /// Clears the writes the server has answered, and says how many went.
    pub fn forget_answered(&self) -> Result<u64, MarfaError> {
        Ok(self.inner.forget_answered()? as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(Verdict::from(O::Accepted), Verdict::Accepted);
        assert_eq!(
            Verdict::from(O::Merged {
                fields: fields.clone()
            }),
            Verdict::Merged {
                fields: fields.clone()
            }
        );
        assert_eq!(
            Verdict::from(O::Conflicted {
                sibling_id: "s".into(),
                fields: fields.clone()
            }),
            Verdict::Conflicted {
                sibling_id: "s".into(),
                fields
            }
        );
        assert_eq!(
            Verdict::from(O::Refused {
                reason: "type_not_permitted".into()
            }),
            Verdict::Refused {
                reason: "type_not_permitted".into()
            }
        );
        for reason in marfa_core::BlockedReason::ALL {
            assert_eq!(
                Verdict::from(O::Blocked { reason }),
                Verdict::Blocked {
                    reason: reason.into()
                }
            );
        }
        assert_eq!(Verdict::from(O::Dead), Verdict::Dead);
    }

    /// Each of the core's refusals lands on the case of the same name, with
    /// what it carries.
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
            (E::Decoding(text()).into(), "Decoding"),
            (E::Store(text()).into(), "Store"),
            (E::NoServer.into(), "NoServer"),
            (E::NoCursor.into(), "NoCursor"),
            (E::HydrationIncomplete.into(), "HydrationIncomplete"),
            (E::ReadingHandle.into(), "ReadingHandle"),
            (
                E::WrongSchema {
                    expected: text(),
                    found: text(),
                    path: text(),
                }
                .into(),
                "WrongSchema",
            ),
            (
                E::CatchUpTooOld {
                    min_retained_id: text(),
                }
                .into(),
                "CatchUpTooOld",
            ),
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
            (E::Invalid(text()).into(), "Invalid"),
        ];
        for (error, name) in &crossed {
            let debug = format!("{error:?}");
            assert!(
                debug.starts_with(&format!("{name} ")) || debug.starts_with(&format!("{name} {{")),
                "{name} crossed as {debug}"
            );
        }
        assert!(matches!(
            &crossed[18].0,
            MarfaError::BytesAbsent { hash, .. } if hash == "sha256:h"
        ));
    }

    #[test]
    fn search_filters_cross_whole() {
        let crossed: marfa_core::SearchFilters = SearchFilters {
            state: Some(ItemState::Archived),
            all_states: true,
            r#type: Some("core.note".into()),
            tags: vec!["a".into(), "b".into()],
        }
        .into();
        assert_eq!(
            crossed,
            marfa_core::SearchFilters {
                state: Some(marfa_core::ItemState::Archived),
                all_states: true,
                r#type: Some("core.note".into()),
                tags: vec!["a".into(), "b".into()],
            }
        );
    }
}
