//! The Swift-facing shape of `marfa_core`. Properties, bodies and answers
//! cross as `JsonValue` and `JsonObject`, values the generated Swift holds as
//! its own, not as text to parse.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

uniffi::setup_scaffolding!();

mod folder_settings;
mod folders;
mod json;
mod renewal;

pub use json::{JsonMember, JsonObject, JsonValue};
pub use renewal::{CredentialRenewer, RenewalError};

/// The tier an item is in: `library` for lasting material, `feed` for an
/// incoming stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Tier {
    Library,
    Feed,
}

/// The tiers a slice holds: one, or `All` for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SliceTier {
    Library,
    Feed,
    All,
}

/// Where an item is in its life.
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

/// An item as the copy holds it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Item {
    pub id: String,
    pub r#type: String,
    /// The item's properties, in the order the server answers them. Empty
    /// where `unreadable_properties` is set.
    pub properties: JsonObject,
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
    #[uniffi(default = None)]
    pub title: Option<String>,
    /// The text under the property the type's display hints name as its
    /// body, or `body` where they name none; none where that holds no
    /// string.
    #[uniffi(default = None)]
    pub body: Option<String>,
    /// Why `properties` is empty where the copy holds the item but its stored
    /// properties cannot be read, such as a store written to by something
    /// else. Every other field is as the copy holds it. A hydration replaces
    /// the stored properties from the server.
    #[uniffi(default = None)]
    pub unreadable_properties: Option<String>,
}

/// A page of the server's bin.
#[derive(Debug, Clone, uniffi::Record)]
pub struct BinPage {
    pub items: Vec<Item>,
    /// Where the next page starts; none on the last.
    pub next_cursor: Option<String>,
}

/// An edge as the copy holds it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Edge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    /// Empty where `unreadable_properties` is set.
    pub properties: JsonObject,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Why `properties` is empty where the copy holds the edge but its stored
    /// properties cannot be read.
    #[uniffi(default = None)]
    pub unreadable_properties: Option<String>,
}

/// Narrowing for a search: the state rule a list takes, a type with its
/// subtree, tags, a listing-grammar expression and `beneath`, each read as
/// the list reads it.
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct SearchFilters {
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = None)]
    pub state: Option<ItemState>,
    #[uniffi(default = false)]
    pub all_states: bool,
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

/// One hit of a search, with the item it found.
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
    pub tier: SliceTier,
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
/// reached, and a drain leaves what it had not sent queued, and an upload or
/// item or edge write it had in flight queued as sent, for the next drain to
/// send again under the same key. A raised `Stop` stays raised, so a call given one afterwards
/// ends at once.
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
    /// The catch-up changed the catalog the copy holds.
    pub catalog_changed: bool,
}

/// A catch-up that failed. The copy keeps the catalog a catch-up took
/// whatever ends it, so `catalog_changed` says whether the types changed
/// though the catch-up did not finish.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum CatchUpError {
    Failed {
        error: MarfaError,
        catalog_changed: bool,
    },
}

impl std::fmt::Display for CatchUpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let CatchUpError::Failed { error, .. } = self;
        error.fmt(f)
    }
}

impl From<marfa_core::CatchUpFailed> for CatchUpError {
    fn from(failed: marfa_core::CatchUpFailed) -> Self {
        CatchUpError::Failed {
            error: failed.error.into(),
            catalog_changed: failed.catalog_changed,
        }
    }
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
    pub slice_tier: Option<SliceTier>,
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
    /// The definition whole, as the server answers it.
    pub definition: JsonObject,
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

/// One end of an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EdgeEnd {
    Source,
    Target,
}

/// Which end of an edge has the file that writes it in a folder, or neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EdgeWrittenAt {
    Source,
    Target,
    None,
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
    pub written_at: EdgeWrittenAt,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    pub properties: Vec<TypeField>,
    pub shipped: bool,
}

/// A server's two catalogs as it lists them now.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ServerCatalog {
    /// By id.
    pub item_types: Vec<ItemType>,
    /// By id.
    pub edge_types: Vec<EdgeType>,
}

impl From<marfa_core::TypeField> for TypeField {
    fn from(field: marfa_core::TypeField) -> Self {
        TypeField {
            name: field.name,
            field_type: field.r#type,
            required: field.required,
            description: field.description,
            declared_by: field.declared_by,
            definition: match field.definition {
                serde_json::Value::Object(map) => map.into(),
                _ => JsonObject::default(),
            },
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
                marfa_core::WrittenAt::Source => EdgeWrittenAt::Source,
                marfa_core::WrittenAt::Target => EdgeWrittenAt::Target,
                marfa_core::WrittenAt::None => EdgeWrittenAt::None,
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
    /// The write keeps meeting an environmental failure while the server
    /// answers other writes.
    FailingAlone,
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
///
/// The tags are queued as writes of their own. Where `source_id` names a row
/// the server already holds, the create lands on it, and `base_version` makes
/// that conditional on the version it was read at. With no `tier`, the copy
/// uses its slice's tier, `library` in a slice of both tiers, or `library`
/// before its first hydration, and sends that tier explicitly, unless
/// `source` and `source_id` name an item the copy holds, or the server's
/// answer to a lookup of that natural key does not say that no row holds
/// it. The create is then sent with no tier: a row keeps its own, and a new
/// row takes the key's default. A create outside the slice is held as a pin.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Draft {
    pub r#type: String,
    #[uniffi(default)]
    pub properties: JsonObject,
    /// Each queued as a write of its own, waiting on the create.
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    #[uniffi(default = None)]
    pub id: Option<String>,
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
///
/// A type or a tier the item already has moves nothing and is not sent. A
/// `type` the copy's catalog does not hold is refused `UnknownType` before
/// anything is queued.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Edit {
    /// Whole field values; a device never merges inside a field. Unless
    /// `replace_properties` is set, each property given replaces its value and
    /// the rest stay, and a `null` clears nothing: the server drops it, and
    /// so does the copy, so the property keeps its value.
    #[uniffi(default)]
    pub properties: JsonObject,
    /// The properties are the item's whole properties: one left out is
    /// cleared. Sent at a version older than the one the copy holds, through
    /// `update_item_as_read`, it is merged as a merge is.
    #[uniffi(default = false)]
    pub replace_properties: bool,
    /// The version the change was made against.
    pub base_version: i64,
    /// The natural key to move the row to.
    #[uniffi(default = None)]
    pub source_id: Option<String>,
    /// The type to move the row to, sent as the server's retype. The
    /// properties it ends up with are held to that type.
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    /// The tier to move the row to.
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
}

impl Edit {
    fn core(self) -> Result<marfa_core::Edit, MarfaError> {
        Ok(marfa_core::Edit {
            properties: self.properties.into_map()?,
            base_version: Some(self.base_version),
            source_id: self.source_id,
            r#type: self.r#type,
            tier: self.tier.map(Into::into),
            occurred_at: None,
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
    #[uniffi(default)]
    pub properties: JsonObject,
    #[uniffi(default = None)]
    pub id: Option<String>,
}

/// A change to an edge's properties, a move of one of its ends, or both,
/// and the version it was read at.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EdgeEdit {
    /// Each property given replaces its whole value; every other one stays as
    /// it is.
    #[uniffi(default)]
    pub properties: JsonObject,
    pub base_version: i64,
    #[uniffi(default = None)]
    pub moves: Option<EdgeMove>,
}

/// The end an edge edit moves, and the item it moves it to.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EdgeMove {
    pub end: EdgeEnd,
    pub to: String,
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
    /// The body the write sends, or sent: a refused write's content stays
    /// readable here until it is discarded.
    pub body: JsonObject,
    /// The server's answer, whole, as it arrived: the JSON it held, or, for
    /// an answer that was not JSON, its text as a string.
    pub answer: Option<JsonValue>,
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
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LastFailure {
    pub status: Option<u16>,
    pub text: Option<String>,
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

/// The three writes an attachment is, in the order they go out, and the
/// text that embeds the file in the item's body.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
    /// `![[title]]`, which reads back as `edge` once written into the item's
    /// body; none where its title cannot name it alone in an embed.
    pub embed: Option<String>,
}

/// The two writes a file added on its own is, in the order they go out.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Added {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
}

/// What a link or an embed in an item's body names.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum BodyTarget {
    /// The item it names; for an embed, the file item with the bytes.
    Item { id: String },
    /// Not yet looked up on the server.
    Pending,
    /// Names no item.
    Missing,
    /// Names more than one item.
    Ambiguous,
    /// The edge's write, or the server's lookup, was refused, for `reason`.
    Refused { reason: String },
}

/// A link or an embed as the body carries it, and what it names.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BodyName {
    /// As typed: `[[Note|shown]]`, `![[photo.png]]`.
    pub text: String,
    /// What it is read as: the name before any `|` or `#`, or the embed's
    /// path or name.
    pub name: String,
    pub target: BodyTarget,
}

/// The links in an item's body, and its embeds of files, in body order.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BodyLinks {
    pub links: Vec<BodyName>,
    pub embeds: Vec<BodyName>,
}

impl From<marfa_core::BodyName> for BodyName {
    fn from(name: marfa_core::BodyName) -> BodyName {
        BodyName {
            text: name.text,
            name: name.name,
            target: match name.target {
                marfa_core::BodyTarget::Item { id } => BodyTarget::Item { id },
                marfa_core::BodyTarget::Pending => BodyTarget::Pending,
                marfa_core::BodyTarget::Missing => BodyTarget::Missing,
                marfa_core::BodyTarget::Ambiguous => BodyTarget::Ambiguous,
                marfa_core::BodyTarget::Refused { reason } => BodyTarget::Refused { reason },
            },
        }
    }
}

/// What became of one write a drain answered, sent or not.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
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
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
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
        properties: item.properties.into(),
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
        unreadable_properties: shown.unreadable_properties,
    }
}

/// `unreadable_properties` is why the edge has none, where the read kept an
/// edge whose stored properties it could not read.
fn edge(edge: marfa_core::Edge, unreadable_properties: Option<String>) -> Edge {
    Edge {
        id: edge.id,
        source_id: edge.source_id,
        target_id: edge.target_id,
        edge_type: edge.edge_type,
        properties: edge.properties.into(),
        version: edge.version,
        created_at: edge.created_at,
        updated_at: edge.updated_at,
        unreadable_properties,
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
        body: match write.body {
            serde_json::Value::Object(map) => map.into(),
            _ => JsonObject::default(),
        },
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
        answer: write.answer.as_deref().map(json::answer),
        refusals: write.refusals,
        environmental_streak: write.environmental_streak,
        last_failure: write.last_failure.map(|failure| LastFailure {
            status: failure.status,
            text: failure.text,
        }),
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

/// A local copy of a slice of one server. Every method blocks; call from off
/// the main thread.
#[derive(uniffi::Object)]
pub struct Core {
    inner: Arc<marfa_core::Core>,
}

/// An item's thumbnail: the image's type and its bytes.
#[derive(uniffi::Record)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// What a held stream changed in the copy, what became of the server, or
/// what became of the queue it drained then. `cursor` is the cursor held
/// after it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
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
    /// No stream can be had, told once until one is had again. `reason` is
    /// the failure, such as the network failing, a rate limit, a failing
    /// server or a refusal naming no contract.
    ServerUnreachable { reason: MarfaError, cursor: String },
    /// A stream is had again. Where a drain has work queued, the follow
    /// drains once and tells `QueueDrained` or `QueueNotDrained`.
    ServerReachable { cursor: String },
    /// The queue was drained once a stream was had again, and what that
    /// drain did, as `drain` returns it.
    QueueDrained { report: DrainReport, cursor: String },
    /// The drain started once a stream was had again ended with `error`.
    /// The answers it had recorded stay recorded.
    QueueNotDrained { error: MarfaError, cursor: String },
    /// Told by a watch of a reading handle: another process saved to the
    /// store, which now has this data version.
    Saved { data_version: i64, cursor: String },
    /// Told by a watch, once, when what feeds it fails. A follow that failed
    /// holds no stream until the next hydration or catch-up; a reading
    /// handle's reads go on, and the first that works is told as `Saved`.
    WatchFailed { reason: MarfaError, cursor: String },
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
                reason: reason.clone().into(),
                cursor,
            },
            marfa_core::ChangeEvent::ServerReachable => Change::ServerReachable { cursor },
            marfa_core::ChangeEvent::QueueDrained(report) => match drained(report.clone()) {
                Ok(report) => Change::QueueDrained { report, cursor },
                // A report whose verdict cannot be read is told as a drain
                // that failed with that error.
                Err(error) => Change::QueueNotDrained { error, cursor },
            },
            marfa_core::ChangeEvent::QueueNotDrained(error) => Change::QueueNotDrained {
                error: error.clone().into(),
                cursor,
            },
            marfa_core::ChangeEvent::Saved(data_version) => Change::Saved {
                data_version: *data_version,
                cursor,
            },
            marfa_core::ChangeEvent::WatchFailed(reason) => Change::WatchFailed {
                reason: reason.clone().into(),
                cursor,
            },
        }
    }
}

/// What an app hands `follow` or `watch`: told of each change as it lands, on a
/// thread of the core's, and once when the stream ends, with the error that
/// ended it or none where it was stopped.
#[uniffi::export(with_foreign)]
pub trait ChangeListener: Send + Sync {
    fn changed(&self, change: Change);
    fn ended(&self, error: Option<MarfaError>);
}

/// A held stream, a folder's watch, or a place in a store's watch, stopped by
/// `stop` or by letting it go. A follow ends within a quarter second of either;
/// a folder's watch within about a second, or once the pass under way is done.
/// `ended` is called once it has.
#[derive(uniffi::Object)]
pub struct Subscription {
    ending: Ending,
}

enum Ending {
    Flag(Arc<AtomicBool>),
    Listening(marfa_core::Listening),
}

impl Subscription {
    fn raising(stop: Arc<AtomicBool>) -> Arc<Subscription> {
        Arc::new(Subscription {
            ending: Ending::Flag(stop),
        })
    }
}

#[uniffi::export]
impl Subscription {
    pub fn stop(&self) {
        match &self.ending {
            Ending::Flag(stop) => stop.store(true, Ordering::Relaxed),
            Ending::Listening(listening) => listening.stop(),
        }
    }
}

/// The thread holds the core, and with it the writer's claim on the store,
/// so a subscription nobody holds any more must end it. A place in a watch
/// leaves it when dropped.
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ending::Flag(stop) = &self.ending {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Hands a watch's changes to an app's listener.
struct Telling(Arc<dyn ChangeListener>);

impl marfa_core::WatchListener for Telling {
    fn changed(&self, change: &marfa_core::Change) {
        self.0.changed(change.into());
    }

    fn ended(&self, error: Option<marfa_core::CoreError>) {
        self.0.ended(error.map(Into::into));
    }
}

pub(crate) fn server_of(
    url: Option<String>,
    key: Option<String>,
) -> Result<Option<marfa_core::Server>, MarfaError> {
    match (url, key) {
        (Some(url), Some(key)) => Ok(Some(marfa_core::Server { url, key })),
        (None, None) => Ok(None),
        _ => Err(MarfaError::Invalid {
            message: "url and key go together".into(),
        }),
    }
}

impl Core {
    fn renewing(core: marfa_core::Core, renewal: Option<Arc<renewal::Renewal>>) -> Arc<Self> {
        if let Some(renewal) = renewal {
            core.renew_credential_with(renewal.renew());
        }
        Arc::new(Core {
            inner: Arc::new(core),
        })
    }
}

#[uniffi::export]
impl Core {
    /// Opens a store another process writes, to read it only: never the
    /// writer, never a write, and a path with no store is refused.
    #[uniffi::constructor]
    pub fn open_reader(path: String) -> Result<Arc<Self>, MarfaError> {
        Ok(Arc::new(Core {
            inner: Arc::new(marfa_core::Core::open_reader(path)?),
        }))
    }

    /// A number that moves each time another process saves to the store.
    pub fn data_version(&self) -> Result<i64, MarfaError> {
        Ok(self.inner.data_version()?)
    }

    /// Holds the event stream open on a thread of its own and applies each
    /// event as it arrives, telling `listener` of each change. On a copy
    /// never hydrated, or whose hydration was interrupted, it waits, asking
    /// the server nothing, until a hydration completes; an expired copy is
    /// refused. `told_unreachable` says the app was last told
    /// `ServerUnreachable` by a follow before this one, so this one tells
    /// `ServerReachable` when it has its first stream. Each time it tells
    /// `ServerReachable` with work queued for a drain, it drains once, after
    /// any drain under way, and tells `QueueDrained` or `QueueNotDrained`;
    /// `ended` follows that drain's end.
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
        Subscription::raising(stop)
    }

    /// Adds `listener` to this store's watch, and starts it if it was idle.
    /// However many listeners there are, one source runs: a writer with a
    /// server holds the event stream and tells what `follow` tells, and a
    /// reading handle tells `Saved` each time another process saves. A
    /// hydration or catch-up takes the stream for its duration and gives it
    /// back, and no listener is told of the gap.
    ///
    /// A listener hears what changes after it joins, and is first told the
    /// outage or failure that holds then. `told_unreachable` says the app was
    /// last told `ServerUnreachable` by an earlier watch, so it is told
    /// `ServerReachable` once the server is reached, and not
    /// `ServerUnreachable` again before. A request that reaches the server
    /// tells `ServerReachable` to a listener that was told it did not:
    /// the follow's, a hydration's or catch-up's that succeeded, or a drain's
    /// that answered a write. A follow that fails ends no listener: each is
    /// told `WatchFailed` once, and no stream is held until the next
    /// hydration or catch-up. The first stream the watch has after the server
    /// was lost, or after a drain left a write undelivered, is drained to
    /// once, and the drain is told as `follow` tells it.
    ///
    /// Throws `NoServer` for a writer with no server. `changed` must return
    /// promptly, and a hydration or catch-up called from inside it throws
    /// `Invalid`.
    pub fn watch(
        self: Arc<Self>,
        told_unreachable: bool,
        listener: Arc<dyn ChangeListener>,
    ) -> Result<Arc<Subscription>, MarfaError> {
        let listening = self
            .inner
            .watch(told_unreachable, Arc::new(Telling(listener)))?;
        Ok(Arc::new(Subscription {
            ending: Ending::Listening(listening),
        }))
    }

    /// Opens the file at `path`, creating it when absent. `url` and `key`
    /// go together; without them only local reads work. `renewer` renews
    /// `key` when the server refuses it, as an app signed in with OAuth
    /// does with its refresh token; it needs `url` and `key`.
    #[uniffi::constructor(default(renewer = None))]
    pub fn open(
        path: String,
        url: Option<String>,
        key: Option<String>,
        renewer: Option<Arc<dyn CredentialRenewer>>,
    ) -> Result<Arc<Self>, MarfaError> {
        let server = server_of(url, key)?;
        let renewal = renewal::Renewal::of(renewer, server.as_ref())?;
        Ok(Self::renewing(
            marfa_core::Core::open(path, server)?,
            renewal,
        ))
    }

    /// Replaces the store at `path` that `open` refuses with `WrongSchema`
    /// by an empty one, and opens it, taking `url`, `key` and `renewer` as
    /// `open` does. Refuses with `ReadingHandle` while another process
    /// writes the store, with `WrongSchema` and its `unsent` count while it
    /// holds a write the server has not taken, and with `Invalid` where
    /// `open` would not refuse it, leaving the store as it is. The new store
    /// is empty, so what only the old store held, such as pins, is lost: read
    /// it first.
    #[uniffi::constructor(default(renewer = None))]
    pub fn replace_refused(
        path: String,
        url: Option<String>,
        key: Option<String>,
        renewer: Option<Arc<dyn CredentialRenewer>>,
    ) -> Result<Arc<Self>, MarfaError> {
        let server = server_of(url, key)?;
        let renewal = renewal::Renewal::of(renewer, server.as_ref())?;
        Ok(Self::renewing(
            marfa_core::Core::replace_refused(path, server)?,
            renewal,
        ))
    }

    pub fn hydrate(
        &self,
        types: Vec<String>,
        tier: SliceTier,
        stop: Option<Arc<Stop>>,
    ) -> Result<HydrateReport, MarfaError> {
        self.hydrate_with(types, tier, Vec::new(), stop)
    }

    /// A hydration that also holds every edge of `edge_types` the key reads,
    /// whichever ends the copy holds.
    pub fn hydrate_with(
        &self,
        types: Vec<String>,
        tier: SliceTier,
        edge_types: Vec<String>,
        stop: Option<Arc<Stop>>,
    ) -> Result<HydrateReport, MarfaError> {
        Ok(self
            .inner
            .hydrate_until(&types, tier.into(), &edge_types, &flag_of(stop))?
            .into())
    }

    /// Declares the types this app saves, each an object with its `id`, its
    /// `fields` and whatever else a type carries. A copy that has never
    /// reached a server checks what it queues against them and the types
    /// Marfa ships, and a hydration registers the ones the instance lacks,
    /// where the key may. The call is the app's whole set and replaces every
    /// earlier declaration.
    pub fn declare_types(&self, types: Vec<JsonObject>) -> Result<(), MarfaError> {
        let parsed = types
            .into_iter()
            .map(|declaration| declaration.into_map().map(serde_json::Value::Object))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(self.inner.declare_types(&parsed)?)
    }

    /// The declarations this copy holds, with the empty `fields` and the
    /// `version` a registration needs filled in where the app left them out.
    pub fn declared_types(&self) -> Result<Vec<JsonObject>, MarfaError> {
        self.inner
            .declared_types()?
            .into_iter()
            .map(|declaration| match declaration {
                serde_json::Value::Object(map) => Ok(map.into()),
                other => Err(MarfaError::Store {
                    message: format!("a declared type is not an object: {other}"),
                }),
            })
            .collect()
    }

    /// Holds one row by id whatever the slice says of it, read now. An item
    /// in the bin throws `NotFound` with the code `trashed`.
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

    pub fn catch_up(&self, stop: Option<Arc<Stop>>) -> Result<CatchUpReport, CatchUpError> {
        let report = self.inner.catch_up_until(&flag_of(stop))?;
        Ok(CatchUpReport {
            applied: report.applied,
            skipped: report.skipped,
            cursor: report.cursor,
            catalog_changed: report.catalog_changed,
        })
    }

    pub fn list(&self, filters: ListFilters, sort: Sort) -> Result<Vec<Item>, MarfaError> {
        Ok(self
            .inner
            .list_kept(&filters.into(), sort.into())?
            .into_iter()
            .map(|(held, shown)| item(held, shown))
            .collect())
    }

    pub fn get(&self, id: String) -> Result<Option<Item>, MarfaError> {
        Ok(self
            .inner
            .get_kept(&id)?
            .map(|(held, shown)| item(held, shown)))
    }

    pub fn edges_from(&self, id: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_from_kept(&id)?
            .into_iter()
            .map(|(held, why)| edge(held, why))
            .collect())
    }

    pub fn edges_to(&self, id: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_to_kept(&id)?
            .into_iter()
            .map(|(held, why)| edge(held, why))
            .collect())
    }

    pub fn edges_of_type(&self, edge_type: String) -> Result<Vec<Edge>, MarfaError> {
        Ok(self
            .inner
            .edges_of_type_kept(&edge_type)?
            .into_iter()
            .map(|(held, why)| edge(held, why))
            .collect())
    }

    /// The ID of the item a conflicted copy was made from, or `nil` where
    /// `id` is not a held conflicted copy outside the bin.
    pub fn original_of_conflicted_copy(&self, id: String) -> Result<Option<String>, MarfaError> {
        Ok(self.inner.original_of_conflicted_copy(&id)?)
    }

    /// The held conflicted copies made from `id` that are outside the bin,
    /// oldest link first.
    pub fn conflicted_copies_of(&self, id: String) -> Result<Vec<Item>, MarfaError> {
        Ok(self
            .inner
            .conflicted_copies_kept(&id)?
            .into_iter()
            .map(|(held, shown)| item(held, shown))
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
            .search_kept(&query, &filters.into(), limit as usize)?
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

    /// The server's item types and edge types, read from it now, so an app
    /// can choose a slice before a first hydration. Nothing in the copy
    /// changes. `NoServer` for a copy with no server.
    pub fn server_catalog(&self, stop: Option<Arc<Stop>>) -> Result<ServerCatalog, MarfaError> {
        let served = self.inner.server_catalog_until(&flag_of(stop))?;
        Ok(ServerCatalog {
            item_types: served.item_types.into_iter().map(Into::into).collect(),
            edge_types: served.edge_types.into_iter().map(Into::into).collect(),
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
            properties: draft.properties.into_map()?,
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

    /// Destroys an item in the bin on the server now, never queued, and
    /// takes it, its edges and its pin out of the copy once the server
    /// accepts it. Sent at `version`, the one the caller was shown, such as
    /// a bin entry's, or else the version the copy holds, and only with no
    /// write to the item waiting. Before anything is sent it throws
    /// `NotFound` with `not_held` for an item the copy does not hold where no
    /// version is named, `Validation` with `invalid_transition` for one the
    /// copy shows outside the bin, and `Invalid` while a write waits.
    /// Every error leaves the copy and the queue as they were, but
    /// `CopyExpired` for another instance at the origin. `Network` means the
    /// server was not reached or did not answer, and in the second case it
    /// may have purged the item, which its event then shows. The server
    /// refuses an item it does not hold in the bin `Validation` with
    /// `invalid_transition`, one that moved since the copy read it `Server`
    /// with the status 409 and `version_conflict`, and a key without
    /// `items.purge`, or without write on the item's type, `Forbidden`.
    pub fn purge_item(&self, id: String, version: Option<i64>) -> Result<(), MarfaError> {
        Ok(self.inner.purge_item(&id, version)?)
    }

    /// A page of the server's bin, newest change first, read online and held
    /// nowhere in the copy. Each item's `updated_at` stands for when it went
    /// to the bin. Offline it throws `Network`, and `NoServer` for a copy with
    /// none.
    pub fn bin(
        &self,
        r#type: Option<String>,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<BinPage, MarfaError> {
        let page = self
            .inner
            .bin(r#type.as_deref(), cursor.as_deref(), limit)?;
        Ok(BinPage {
            items: page
                .items
                .into_iter()
                .map(|(held, shown)| item(held, shown))
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    /// Takes an item out of the bin and queues the restore: locally where the
    /// copy holds it, and by id where it does not, the item arriving once the
    /// server answers where the slice takes it.
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
            properties: draft.properties.into_map()?,
            source_id: draft.source_id,
            target_id: draft.target_id,
            edge_type: draft.edge_type,
            id: draft.id,
        };
        queued(self.inner.create_edge(&draft)?)
    }

    /// Answers `nil` for an edit that names no property and no new end, which
    /// queues no write.
    pub fn update_edge(
        &self,
        id: String,
        edit: EdgeEdit,
    ) -> Result<Option<QueuedWrite>, MarfaError> {
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
            properties: edit.properties.into_map()?,
            base_version: Some(edit.base_version),
            source_id,
            target_id,
        };
        self.inner.update_edge(&id, &edit)?.map(queued).transpose()
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
        queued(self.inner.replace_metadata(&id, &write)?)
    }

    /// Writes one extension namespace, as its own write.
    pub fn write_extension(
        &self,
        id: String,
        namespace: String,
        body: JsonObject,
    ) -> Result<QueuedWrite, MarfaError> {
        let body = serde_json::Value::Object(body.into_map()?).to_string();
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
            embed: attached.embed,
        })
    }

    /// Adds a file as an item of its own, attached to nothing: its upload and
    /// a file item naming the bytes, and a write for each tag.
    pub fn add_file(
        &self,
        path: String,
        attachment: Attachment,
        tags: Vec<String>,
    ) -> Result<Added, MarfaError> {
        let added = self.inner.add_file(
            std::path::Path::new(&path),
            &marfa_core::Attachment {
                mime_type: attachment.mime_type,
                title: attachment.title,
                r#type: attachment.r#type,
                tier: attachment.tier.map(Into::into),
            },
            &tags,
        )?;
        Ok(Added {
            upload: queued(added.upload)?,
            item: queued(added.item)?,
        })
    }

    /// Each link and each embed of a file in an item's body, with the item it
    /// names or why it names none yet, from the copy alone. An item the copy
    /// does not hold throws `NotFound`.
    pub fn body_links(&self, id: String) -> Result<BodyLinks, MarfaError> {
        let links = self.inner.body_links(&id)?;
        Ok(BodyLinks {
            links: links.links.into_iter().map(Into::into).collect(),
            embeds: links.embeds.into_iter().map(Into::into).collect(),
        })
    }

    /// The text that embeds the file item `file` in the body of `id`, which
    /// names that file alone; throws `Invalid` where no embed can.
    pub fn embed_text(&self, id: String, file: String) -> Result<String, MarfaError> {
        Ok(self.inner.embed_text(&id, &file)?)
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

    /// Takes a write blocked `ancestor_unavailable`, `conflict_unresolved` or
    /// `failing_alone` out of the queue, and puts the copy back to what the server holds;
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

    /// Clears only the named writes, under the rules `forget_answered`
    /// keeps, and says how many went. Every other answered write stays, so an
    /// app clears just the answers it has read; an id that names no write, or
    /// one not answered, is ignored.
    pub fn forget_answered_ids(&self, ids: Vec<String>) -> Result<u64, MarfaError> {
        Ok(self.inner.forget_answered_ids(&ids)? as u64)
    }

    /// Takes a refused write out of the queue, with the content it carried.
    /// Answers whether the row was one a discard takes: refused, and with no
    /// write still waiting on it, or a create refused onto a row its natural
    /// key names that no read has found, whose waiting writes it refuses
    /// unsent. A create's discard first waits for a drain already running to
    /// end.
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
                details: None,
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
    fn a_change_crosses_as_its_own_kind() {
        let change = |event, item: Option<&str>| {
            Change::from(&marfa_core::Change {
                event,
                item_id: item.map(str::to_string),
                edge_id: None,
                cursor: "11".into(),
            })
        };
        use marfa_core::ChangeEvent as E;
        assert_eq!(
            change(E::CatalogChanged, None),
            Change::CatalogChanged {
                cursor: "11".into()
            }
        );
        assert_eq!(
            change(E::ServerReachable, None),
            Change::ServerReachable {
                cursor: "11".into()
            }
        );
        assert_eq!(
            change(
                E::ServerUnreachable(marfa_core::CoreError::Network("refused".into())),
                None
            ),
            Change::ServerUnreachable {
                reason: MarfaError::Network {
                    message: "refused".into()
                },
                cursor: "11".into()
            }
        );
        let report = marfa_core::DrainReport {
            answered: 2,
            held: 0,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts: Vec::new(),
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        };
        assert_eq!(
            change(E::QueueDrained(report.clone()), None),
            Change::QueueDrained {
                report: drained(report).unwrap(),
                cursor: "11".into()
            }
        );
        assert_eq!(
            change(
                E::QueueNotDrained(marfa_core::CoreError::Network("refused".into())),
                None
            ),
            Change::QueueNotDrained {
                error: MarfaError::Network {
                    message: "refused".into()
                },
                cursor: "11".into()
            }
        );
        // The witness: an event of the same name is an applied event.
        assert_eq!(
            change(E::Applied("catalog.changed".into()), Some("n1")),
            Change::Applied {
                event: "catalog.changed".into(),
                item_id: Some("n1".into()),
                edge_id: None,
                cursor: "11".into()
            }
        );
    }

    #[test]
    fn a_failed_catch_up_crosses_with_whether_it_changed_the_catalog() {
        for catalog_changed in [false, true] {
            let crossed = CatchUpError::from(marfa_core::CatchUpFailed {
                error: marfa_core::CoreError::Canceled,
                catalog_changed,
            });
            let CatchUpError::Failed {
                error,
                catalog_changed: told,
            } = &crossed;
            assert_eq!(
                (error.code().as_str(), *told),
                ("canceled", catalog_changed)
            );
            assert_eq!(crossed.to_string(), error.to_string());
        }
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
                    details: None,
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
    fn an_attached_file_crosses_with_its_embed_and_reads_back_from_the_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
        let host = core
            .create_item(Draft {
                r#type: "core.note".into(),
                properties: object(serde_json::json!({ "title": "Host", "body": "" })),
                id: None,
                tags: Vec::new(),
                tier: None,
                source: None,
                source_id: None,
                occurred_at: None,
                base_version: None,
            })
            .unwrap()
            .item_id
            .unwrap();
        let file = dir.path().join("clip.mov");
        std::fs::write(&file, b"not really a video").unwrap();
        let file = file.display().to_string();
        let attached = core
            .attach(host.clone(), file.clone(), Attachment::default())
            .unwrap();
        let embed = attached.embed.clone().expect("no embed text");
        assert_eq!(embed, "![[clip.mov]]");
        let file_id = attached.item.item_id.clone().unwrap();
        assert_eq!(
            core.embed_text(host.clone(), file_id.clone()).unwrap(),
            embed
        );
        let version = core.get(host.clone()).unwrap().unwrap().version;
        core.update_item(
            host.clone(),
            Edit {
                properties: object(
                    serde_json::json!({ "body": format!("{embed} and [[Elsewhere]]") }),
                ),
                base_version: version,
                source_id: None,
                replace_properties: false,
                r#type: None,
                tier: None,
            },
        )
        .unwrap();
        let links = core.body_links(host).unwrap();
        assert_eq!(
            links.embeds,
            vec![BodyName {
                text: embed,
                name: "clip.mov".into(),
                target: BodyTarget::Item { id: file_id },
            }]
        );
        assert_eq!(links.links[0].target, BodyTarget::Pending);
        let added = core
            .add_file(file, Attachment::default(), vec!["kept".into()])
            .unwrap();
        assert!(added.item.item_id.is_some());
    }

    #[test]
    fn a_copy_that_never_reached_a_server_holds_the_types_marfa_ships() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
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
            written_at: marfa_core::WrittenAt::Target,
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
        assert_eq!(crossed.written_at, EdgeWrittenAt::Target);
        assert_eq!(
            text(&crossed.properties[0].definition),
            r#"{"type":"string"}"#
        );
        held.written_at = marfa_core::WrittenAt::Source;
        assert_eq!(
            EdgeType::from(held.clone()).written_at,
            EdgeWrittenAt::Source
        );
        held.written_at = marfa_core::WrittenAt::None;
        assert_eq!(EdgeType::from(held).written_at, EdgeWrittenAt::None);
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

    /// A request the test server answered: method, path and `Authorization`.
    type Sent = (String, String, Option<String>);

    struct Quiet {
        url: String,
        streams: Arc<std::sync::atomic::AtomicUsize>,
        expire: Arc<AtomicBool>,
        /// Each bearer in it is refused with a `401`, as an expired one is.
        refused: Arc<std::sync::Mutex<Vec<String>>>,
        /// Each request's method, path and `Authorization` header.
        seen: Arc<std::sync::Mutex<Vec<Sent>>>,
    }

    impl Quiet {
        fn refuse(&self, bearer: &str) {
            self.refused
                .lock()
                .unwrap()
                .push(format!("Bearer {bearer}"));
        }

        fn sent_since(&self, from: usize) -> Vec<Sent> {
            self.seen.lock().unwrap()[from..].to_vec()
        }

        /// The requests since `from` that carried a credential, as the
        /// instance check before a drain carries none.
        fn bearing_since(&self, from: usize) -> Vec<Sent> {
            let mut sent = self.sent_since(from);
            sent.retain(|(_, _, authorization)| authorization.is_some());
            sent
        }

        fn asked(&self) -> usize {
            self.seen.lock().unwrap().len()
        }
    }

    fn quiet() -> Quiet {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&streams);
        let expire = Arc::new(AtomicBool::new(false));
        let changed = Arc::clone(&expire);
        let replayed = Arc::new(AtomicBool::new(false));
        let refused = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (refusing, seeing) = (Arc::clone(&refused), Arc::clone(&seen));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let counted = Arc::clone(&counted);
                let changed = Arc::clone(&changed);
                let replayed = Arc::clone(&replayed);
                let (refusing, seeing) = (Arc::clone(&refusing), Arc::clone(&seeing));
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut head, mut line) = (String::new(), String::new());
                    while reader.read_line(&mut line).unwrap_or(0) > 2 {
                        head.push_str(&line);
                        line.clear();
                    }
                    let header = |name: &str| {
                        head.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name)
                                .then(|| value.trim().to_string())
                        })
                    };
                    // Read whole, so closing the connection cannot reset it
                    // before the client reads the answer.
                    let length = header("content-length")
                        .and_then(|length| length.parse::<usize>().ok())
                        .unwrap_or(0);
                    let _ = reader.read_exact(&mut vec![0; length]);
                    let method = head.split_whitespace().next().unwrap_or("GET").to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/");
                    let path = path.split('?').next().unwrap_or("/").to_string();
                    let authorization = header("authorization");
                    seeing
                        .lock()
                        .unwrap()
                        .push((method, path.clone(), authorization.clone()));
                    let resumed = head.to_ascii_lowercase().contains("last-event-id");
                    let mut stream = stream;
                    let contract = marfa_core::contract::CONTRACT_VERSION;
                    if authorization.is_some_and(|sent| refusing.lock().unwrap().contains(&sent)) {
                        let body =
                            r#"{"error":{"code":"unauthorized","message":"the token expired"}}"#;
                        let _ = stream.write_all(format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marfa-Contract: {contract}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        ).as_bytes());
                        return;
                    }
                    let fence = "a".repeat(64);
                    let instance = "00000000-0000-7000-8000-000000000000";
                    let proof = if head.to_ascii_lowercase().contains("x-marfa-reach:") {
                        format!("X-Marfa-Reach: {fence}\r\nCache-Control: no-store\r\n")
                    } else {
                        String::new()
                    };
                    let marker = |kind: &str| {
                        format!(
                            "event: {kind}\ndata: {{\"event_type\":\"{kind}\",\"cursor\":\"10\",\"instance_id\":\"{instance}\",\"reach\":\"{fence}\"}}\n\n"
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
                                        let _ = stream.write_all(b"event: reach_changed\ndata: {\"event_type\":\"reach_changed\"}\n\n");
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
            refused,
            seen,
        }
    }

    /// The scenario is the contract's (`queue-and-verdicts/unclaimed-source-blocks`) and the
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
        let core = Core::open(path, Some(server.url.clone()), Some("k".into()), None).unwrap();
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
            core.hydrate(vec!["core.note".into()], SliceTier::Library, raised())
                .unwrap_err()
        ));
        assert!(canceled(core.drain(raised()).unwrap_err()));
        // The witness: given none, the same calls run to their end.
        core.hydrate(
            vec!["core.note".into()],
            SliceTier::Library,
            Some(Stop::new()),
        )
        .unwrap();
        let CatchUpError::Failed { error, .. } = core.catch_up(raised()).unwrap_err();
        assert!(canceled(error));
        core.catch_up(None).unwrap();
        core.drain(None).unwrap();
    }

    /// Answers each renewal from its list in order, and records what it was
    /// handed.
    struct Renewing {
        answers: std::sync::Mutex<Vec<Result<String, RenewalError>>>,
        refused: std::sync::Mutex<Vec<String>>,
    }

    impl Renewing {
        fn answering(answers: Vec<Result<String, RenewalError>>) -> Arc<Renewing> {
            Arc::new(Renewing {
                answers: std::sync::Mutex::new(answers),
                refused: std::sync::Mutex::default(),
            })
        }

        fn asked(&self) -> Vec<String> {
            self.refused.lock().unwrap().clone()
        }
    }

    impl CredentialRenewer for Renewing {
        fn renew(&self, refused: String) -> Result<String, RenewalError> {
            self.refused.lock().unwrap().push(refused);
            self.answers.lock().unwrap().remove(0)
        }
    }

    fn renewing_copy(server: &Quiet, renewer: &Arc<Renewing>) -> (tempfile::TempDir, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let renewer: Arc<dyn CredentialRenewer> = renewer.clone();
        let core = Core::open(
            path,
            Some(server.url.clone()),
            Some("stale".into()),
            Some(renewer),
        )
        .unwrap();
        (dir, core)
    }

    /// A hydrated copy with two creates queued, whose token the server
    /// refuses from now on.
    fn expired_with_writes(
        server: &Quiet,
        renewer: &Arc<Renewing>,
    ) -> (tempfile::TempDir, Arc<Core>) {
        let (dir, core) = renewing_copy(server, renewer);
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        for title in ["first", "later"] {
            core.create_item(draft("core.note", &format!(r#"{{"title":"{title}"}}"#)))
                .unwrap();
        }
        server.refuse("stale");
        (dir, core)
    }

    #[test]
    fn a_refused_token_is_renewed_through_the_app_and_the_new_one_sent() {
        let server = quiet();
        server.refuse("stale");
        let renewer = Renewing::answering(vec![Ok("fresh".into())]);
        let (_dir, core) = renewing_copy(&server, &renewer);

        core.server_catalog(None).unwrap();
        let sent: Vec<_> = server
            .sent_since(0)
            .into_iter()
            .map(|(_, path, authorization)| (path, authorization))
            .collect();
        assert_eq!(
            sent[..2],
            [
                ("/types".to_string(), Some("Bearer stale".to_string())),
                ("/types".to_string(), Some("Bearer fresh".to_string())),
            ]
        );
        assert_eq!(renewer.asked(), vec!["stale".to_string()]);

        let from = server.asked();
        core.server_catalog(None).unwrap();
        assert!(
            server
                .sent_since(from)
                .iter()
                .all(|(_, _, authorization)| authorization.as_deref() == Some("Bearer fresh")),
            "a later call did not send the renewed token"
        );
        assert_eq!(renewer.asked().len(), 1, "a token in use was renewed again");
    }

    #[test]
    #[ignore = "needs a running server: MARFA_TEST_URL and MARFA_TEST_KEY"]
    fn a_copy_renews_a_token_the_server_refuses_and_drains_under_the_new_one() {
        let url = std::env::var("MARFA_TEST_URL").expect("MARFA_TEST_URL names the server");
        let key = std::env::var("MARFA_TEST_KEY").expect("MARFA_TEST_KEY holds a working key");
        let renewer = Renewing::answering(vec![Ok(key)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(
            path,
            Some(url),
            Some("marfa_refused_by_the_server".into()),
            Some(renewer.clone() as Arc<dyn CredentialRenewer>),
        )
        .unwrap();
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        core.create_item(draft(
            "core.note",
            r#"{"title":"renewed","body":"sent under a renewed token"}"#,
        ))
        .unwrap();
        let report = core.drain(None).unwrap();
        assert_eq!((report.answered, report.undelivered), (1, 0), "{report:?}");
        assert_eq!(
            renewer.asked(),
            vec!["marfa_refused_by_the_server".to_string()]
        );
    }

    #[test]
    fn an_ended_sign_in_stops_the_drain_keeps_the_writes_and_is_not_renewed_again() {
        let server = quiet();
        let renewer = Renewing::answering(vec![
            Err(RenewalError::Ended {
                message: "invalid_grant".into(),
            }),
            Ok("fresh".into()),
        ]);
        let (_dir, core) = expired_with_writes(&server, &renewer);
        let before = format!("{:?}", core.queue().unwrap());

        for _ in 0..2 {
            let from = server.asked();
            let error = core.drain(None).unwrap_err();
            assert!(
                matches!(&error, MarfaError::SignedOut { origin, .. } if *origin == server.url),
                "{error:?}"
            );
            assert_eq!(error.code(), "signed_out");
            assert_eq!(
                server.bearing_since(from).len(),
                1,
                "the drain sent more once the sign-in had ended"
            );
        }
        assert_eq!(format!("{:?}", core.queue().unwrap()), before);
        // The renewer still had a token to answer, and was not asked for it.
        assert_eq!(renewer.asked(), vec!["stale".to_string()]);
    }

    #[test]
    fn a_renewal_the_network_stopped_keeps_the_writes_queued_and_renews_later() {
        let server = quiet();
        let renewer = Renewing::answering(vec![
            Err(RenewalError::Unavailable {
                message: "the token endpoint did not answer".into(),
            }),
            Ok("fresh".into()),
        ]);
        let (_dir, core) = expired_with_writes(&server, &renewer);
        let before = format!("{:?}", core.queue().unwrap());

        let from = server.asked();
        let report = core.drain(None).unwrap();
        assert!(
            report
                .unavailable
                .as_deref()
                .is_some_and(|why| why.contains("the token endpoint did not answer")),
            "{report:?}"
        );
        assert_eq!((report.answered, report.undelivered), (0, 2));
        assert_eq!(server.bearing_since(from).len(), 1);
        assert_eq!(format!("{:?}", core.queue().unwrap()), before);

        core.server_catalog(None).unwrap();
        assert_eq!(
            renewer.asked(),
            vec!["stale".to_string(), "stale".to_string()]
        );
        assert_eq!(
            server.sent_since(from).last().unwrap().2.as_deref(),
            Some("Bearer fresh")
        );
    }

    struct Heard {
        changes: std::sync::mpsc::Sender<Change>,
        ended: std::sync::mpsc::Sender<Option<MarfaError>>,
    }

    impl ChangeListener for Heard {
        fn changed(&self, change: Change) {
            let _ = self.changes.send(change);
        }
        fn ended(&self, error: Option<MarfaError>) {
            let _ = self.ended.send(error);
        }
    }

    #[test]
    fn a_follow_waits_for_a_first_hydration_then_follows() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, Some(server.url.clone()), Some("k".into()), None).unwrap();
        let (changes, _heard) = std::sync::mpsc::channel();
        let (told, ended) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core).follow(
            false,
            Arc::new(Heard {
                changes,
                ended: told,
            }),
        );
        assert!(
            ended
                .recv_timeout(std::time::Duration::from_millis(400))
                .is_err(),
            "a follow on a copy never hydrated ended rather than waiting"
        );
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while server.streams.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < until,
                "the follow never held a stream once the copy was hydrated"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(subscription);
        assert_eq!(
            ended.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(None)
        );
    }

    #[test]
    fn a_watch_keeps_its_listener_through_a_hydration_that_takes_its_stream() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, Some(server.url.clone()), Some("k".into()), None).unwrap();
        let (changes, _heard) = std::sync::mpsc::channel();
        let (told, ended) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core)
            .watch(
                false,
                Arc::new(Heard {
                    changes,
                    ended: told,
                }),
            )
            .unwrap();
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while server.streams.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < until,
                "the watch never held a stream once the copy was hydrated"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .expect("a hydration was refused while a watch held the stream");
        assert!(
            ended
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err(),
            "a hydration ended the listener of a watch"
        );
        drop(subscription);
        assert_eq!(
            ended.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(None)
        );
    }

    #[test]
    fn a_watch_of_a_reading_handle_tells_each_save_and_a_writer_with_no_server_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let writer = Core::open(path.clone(), None, None, None).unwrap();
        let (changes, _heard) = std::sync::mpsc::channel();
        let (told, _ended) = std::sync::mpsc::channel();
        assert!(matches!(
            Arc::clone(&writer).watch(
                false,
                Arc::new(Heard {
                    changes,
                    ended: told
                })
            ),
            Err(MarfaError::NoServer { .. })
        ));
        let reader = Core::open_reader(path).unwrap();
        let (changes, heard) = std::sync::mpsc::channel();
        let (told, _ended) = std::sync::mpsc::channel();
        let _subscription = Arc::clone(&reader)
            .watch(
                false,
                Arc::new(Heard {
                    changes,
                    ended: told,
                }),
            )
            .unwrap();
        let before = reader.data_version().unwrap();
        writer
            .create_item(Draft {
                r#type: "core.note".into(),
                id: None,
                properties: parsed(r#"{"title":"saved","body":"b"}"#),
                tags: Vec::new(),
                tier: None,
                source: None,
                source_id: None,
                occurred_at: None,
                base_version: None,
            })
            .unwrap();
        match heard.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Change::Saved { data_version, .. }) => assert_ne!(data_version, before),
            other => panic!("the writer saved and the watch told {other:?}"),
        }
    }

    /// A JSON object from its text, as the tests below write theirs.
    fn object(json: serde_json::Value) -> JsonObject {
        match json {
            serde_json::Value::Object(map) => map.into(),
            other => panic!("{other} is not an object"),
        }
    }

    fn parsed(json: &str) -> JsonObject {
        object(serde_json::from_str(json).unwrap())
    }

    /// An object as compact JSON text, keys in order.
    fn text(object: &JsonObject) -> String {
        serde_json::Value::Object(object.clone().into_map().unwrap()).to_string()
    }

    fn draft(r#type: &str, properties_json: &str) -> Draft {
        Draft {
            r#type: r#type.into(),
            id: None,
            properties: parsed(properties_json),
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
            properties: parsed(properties_json),
            replace_properties: false,
            base_version,
            source_id: None,
            r#type: None,
            tier: None,
        }
    }

    #[test]
    fn an_edit_crosses_with_its_move_and_its_whole_properties() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
        let note = core
            .create_item(draft(
                "core.note",
                r#"{"body":"b","title":"t","notes":"n"}"#,
            ))
            .unwrap()
            .item_id
            .unwrap();
        let body =
            |write: &QueuedWrite| serde_json::Value::Object(write.body.clone().into_map().unwrap());

        let merged = core
            .update_item(note.clone(), edit(r#"{"title":"T"}"#, 0))
            .unwrap();
        assert_eq!(body(&merged).get("properties_mode"), None);
        let held = core.get(note.clone()).unwrap().unwrap();
        assert_eq!(
            text(&held.properties),
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
            text(&core.get(note.clone()).unwrap().unwrap().properties),
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
    fn an_edge_edit_crosses_with_the_one_end_it_moves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
        let note = |title: &str| {
            core.create_item(draft(
                "core.note",
                &format!(r#"{{"body":"b","title":"{title}"}}"#),
            ))
            .unwrap()
            .item_id
            .unwrap()
        };
        let (first, second, child) = (note("first"), note("second"), note("child"));
        let edge = core
            .create_edge(EdgeDraft {
                source_id: first.clone(),
                target_id: child.clone(),
                edge_type: "parent-of".into(),
                properties: JsonObject::default(),
                id: None,
            })
            .unwrap()
            .edge_id
            .unwrap();
        let move_to = |end: EdgeEnd, to: &str| EdgeEdit {
            properties: JsonObject::default(),
            base_version: 0,
            moves: Some(EdgeMove { end, to: to.into() }),
        };

        let moved = core
            .update_edge(edge.clone(), move_to(EdgeEnd::Source, &second))
            .unwrap()
            .expect("a move of an end was not queued");
        let body = serde_json::Value::Object(moved.body.clone().into_map().unwrap());
        assert_eq!(body["source_id"], serde_json::json!(second));
        assert_eq!(body.get("target_id"), None);
        let parents: Vec<String> = core
            .edges_to(child.clone())
            .unwrap()
            .into_iter()
            .map(|edge| edge.source_id)
            .collect();
        assert_eq!(parents, vec![second.clone()]);
        assert!(core.edges_from(first.clone()).unwrap().is_empty());

        let queued = core.queue().unwrap().len();
        assert!(
            core.update_edge(edge.clone(), move_to(EdgeEnd::Source, &second))
                .unwrap()
                .is_none(),
            "a move to the source the edge holds was queued"
        );
        assert_eq!(core.queue().unwrap().len(), queued);
        for (end, to, code) in [
            (EdgeEnd::Source, child.as_str(), "edge_cycle"),
            (EdgeEnd::Target, first.as_str(), "validation_error"),
        ] {
            match core.update_edge(edge.clone(), move_to(end, to)) {
                Err(MarfaError::Validation { code: refused, .. }) => assert_eq!(refused, code),
                other => panic!("a move the server refuses was answered {other:?}"),
            }
        }
        assert_eq!(core.queue().unwrap().len(), queued);
    }

    #[test]
    fn an_item_crosses_with_the_title_and_body_its_type_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
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

    /// A copy with an app type that declares one field, so a property it
    /// does not declare is one the app has never seen.
    fn copy_with_entries() -> (tempfile::TempDir, std::path::PathBuf, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let core = Core::open(path.display().to_string(), None, None, None).unwrap();
        core.declare_types(vec![parsed(
            r#"{"id":"app.test.entry","fields":{"title":{"type":"string"}}}"#,
        )])
        .unwrap();
        (dir, path, core)
    }

    #[test]
    fn a_value_nested_past_what_the_server_reads_is_refused_invalid_whole() {
        let (_dir, _path, core) = copy_with_entries();
        let nested = |arrays: usize| {
            let deep = (0..arrays).fold(JsonValue::Null, |inner, _| JsonValue::Array(vec![inner]));
            JsonObject {
                members: vec![JsonMember {
                    key: "deep".into(),
                    value: deep,
                }],
            }
        };
        let id = core
            .create_item(draft("app.test.entry", r#"{"title":"t"}"#))
            .unwrap()
            .item_id
            .unwrap();
        let version = core.get(id.clone()).unwrap().unwrap().version;
        let queued = core.queue().unwrap().len();
        // The properties object and 63 arrays pass the binding's own limit,
        // and the body that holds them is one level too deep for the core.
        for arrays in [62 + 1, 62 + 2, 200] {
            let created = core.create_item(Draft {
                properties: nested(arrays),
                ..draft("app.test.entry", "{}")
            });
            let updated = core.update_item(
                id.clone(),
                Edit {
                    properties: nested(arrays),
                    ..edit("{}", version)
                },
            );
            for refusal in [created.map(|_| ()), updated.map(|_| ())] {
                assert!(
                    matches!(refusal, Err(MarfaError::Invalid { .. })),
                    "{arrays}: {refusal:?}"
                );
            }
        }
        assert_eq!(core.queue().unwrap().len(), queued);
        core.create_item(Draft {
            properties: nested(62),
            ..draft("app.test.entry", "{}")
        })
        .unwrap();
        assert_eq!(core.queue().unwrap().len(), queued + 1);
    }

    #[test]
    fn properties_of_every_json_kind_cross_in_and_out_unchanged() {
        let (_dir, _path, core) = copy_with_entries();
        let properties = r#"{
            "title": "caf\u00e9 \ud83d\ude00 \u2028 \n \"quoted\"",
            "nothing": null, "yes": true, "no": false,
            "small": -7, "beyond": 1152921504606847000, "least": -1152921504606847000,
            "ratio": 0.1, "whole": 2.0, "tiny": 1e-300,
            "list": [1, [2, [3, {"deep": [null, "x"]}]]], "empty": {}, "none": [],
            "z": 1, "a": 2, "10": 3, "2": 4
        }"#;
        let id = core
            .create_item(draft("app.test.entry", properties))
            .unwrap()
            .item_id
            .unwrap();
        let held = core.get(id.clone()).unwrap().unwrap();
        assert_eq!(held.unreadable_properties, None);
        // The copy keeps numbers and orders keys as the server does, which is
        // JavaScript: a whole float is an integer, and integer-like keys come
        // first, ascending.
        let wanted = parsed(
            r#"{
            "2": 4, "10": 3,
            "title": "caf\u00e9 \ud83d\ude00 \u2028 \n \"quoted\"",
            "nothing": null, "yes": true, "no": false,
            "small": -7, "beyond": 1152921504606847000, "least": -1152921504606847000,
            "ratio": 0.1, "whole": 2, "tiny": 1e-300,
            "list": [1, [2, [3, {"deep": [null, "x"]}]]], "empty": {}, "none": [],
            "z": 1, "a": 2
        }"#,
        );
        assert_eq!(held.properties, wanted);
        let member = |name: &str| {
            held.properties
                .members
                .iter()
                .find(|m| m.key == name)
                .map(|m| m.value.clone())
        };
        assert_eq!(
            member("beyond"),
            Some(JsonValue::Integer(1_152_921_504_606_847_000))
        );
        assert_eq!(
            member("least"),
            Some(JsonValue::Integer(-1_152_921_504_606_847_000))
        );
        assert_eq!(member("ratio"), Some(JsonValue::Number(0.1)));
        assert_eq!(member("whole"), Some(JsonValue::Integer(2)));
        assert_eq!(member("nothing"), Some(JsonValue::Null));
        let listed = core
            .list(
                ListFilters::default(),
                Sort {
                    field: SortField::CreatedAt,
                    direction: SortDirection::Ascending,
                },
            )
            .unwrap();
        assert_eq!(listed[0].properties, wanted);
        // An integer the server would serve back with other digits is refused.
        for value in ["9007199254740993", "-9223372036854775808"] {
            let refused = core.create_item(draft(
                "app.test.entry",
                &format!(r#"{{"beyond": {value}}}"#),
            ));
            assert!(
                matches!(refused, Err(MarfaError::Validation { .. })),
                "{value}: {refused:?}"
            );
        }
    }

    #[test]
    fn a_draft_and_an_edit_that_name_no_properties_cross_as_an_empty_object() {
        let (_dir, _path, core) = copy_with_entries();
        let id = core
            .create_item(Draft {
                properties: JsonObject::default(),
                ..draft("app.test.entry", "{}")
            })
            .unwrap()
            .item_id
            .unwrap();
        let held = core.get(id.clone()).unwrap().unwrap();
        assert!(held.properties.members.is_empty());
        assert_eq!(held.unreadable_properties, None);
        let write = core
            .update_item(
                id,
                Edit {
                    tier: Some(Tier::Feed),
                    ..edit("{}", held.version)
                },
            )
            .unwrap();
        let sent = write.body.members.iter().find(|m| m.key == "properties");
        assert_eq!(
            sent.map(|m| &m.value),
            Some(&JsonValue::Object(JsonObject::default()))
        );
    }

    #[test]
    fn an_edit_keeps_every_property_it_does_not_name_including_ones_the_type_does_not_declare() {
        let (_dir, _path, core) = copy_with_entries();
        let id = core
            .create_item(draft(
                "app.test.entry",
                r#"{"title":"t","unknown":{"nested":[1,2.5,"x"]},"also":null}"#,
            ))
            .unwrap()
            .item_id
            .unwrap();
        let version = core.get(id.clone()).unwrap().unwrap().version;
        core.update_item(id.clone(), edit(r#"{"title":"T"}"#, version))
            .unwrap();
        assert_eq!(
            text(&core.get(id.clone()).unwrap().unwrap().properties),
            r#"{"title":"T","unknown":{"nested":[1,2.5,"x"]},"also":null}"#
        );
        // A whole edit clears what it leaves out, which is its meaning.
        core.update_item(
            id.clone(),
            Edit {
                replace_properties: true,
                ..edit(r#"{"title":"U"}"#, version)
            },
        )
        .unwrap();
        assert_eq!(
            text(&core.get(id).unwrap().unwrap().properties),
            r#"{"title":"U"}"#
        );
    }

    #[test]
    fn a_value_the_core_cannot_hold_is_refused_before_anything_is_queued() {
        let (_dir, _path, core) = copy_with_entries();
        let id = core
            .create_item(draft("app.test.entry", r#"{"title":"t"}"#))
            .unwrap()
            .item_id
            .unwrap();
        let version = core.get(id.clone()).unwrap().unwrap().version;
        let queued = core.queue().unwrap().len();
        let member = |key: &str, value: JsonValue| JsonObject {
            members: vec![JsonMember {
                key: key.into(),
                value,
            }],
        };
        let twice = JsonObject {
            members: vec![
                JsonMember {
                    key: "a".into(),
                    value: JsonValue::Null,
                },
                JsonMember {
                    key: "a".into(),
                    value: JsonValue::Bool(true),
                },
            ],
        };
        for bad in [
            member("rating", JsonValue::Number(f64::NAN)),
            member(
                "rating",
                JsonValue::Array(vec![JsonValue::Number(f64::INFINITY)]),
            ),
            twice,
        ] {
            let created = core.create_item(Draft {
                properties: bad.clone(),
                ..draft("app.test.entry", "{}")
            });
            let updated = core.update_item(
                id.clone(),
                Edit {
                    properties: bad.clone(),
                    ..edit("{}", version)
                },
            );
            let extension = core.write_extension(id.clone(), "acme.x".into(), bad.clone());
            for refusal in [
                created.map(|_| ()),
                updated.map(|_| ()),
                extension.map(|_| ()),
            ] {
                assert!(
                    matches!(refusal, Err(MarfaError::Invalid { .. })),
                    "{bad:?}"
                );
            }
        }
        assert_eq!(core.queue().unwrap().len(), queued);
    }

    #[test]
    fn a_row_with_unreadable_properties_crosses_flagged_and_does_not_fail_a_list_or_a_search() {
        let (_dir, path, core) = copy_with_entries();
        let mut ids = Vec::new();
        for title in ["kept zebra", "torn zebra", "bare zebra"] {
            ids.push(
                core.create_item(draft(
                    "app.test.entry",
                    &format!(r#"{{"title":"{title}"}}"#),
                ))
                .unwrap()
                .item_id
                .unwrap(),
            );
        }
        {
            let store = rusqlite::Connection::open(&path).unwrap();
            for (id, damage) in [(&ids[1], "{\"title\":"), (&ids[2], "[1]")] {
                store
                    .execute(
                        "UPDATE items SET properties = ?1 WHERE id = ?2",
                        [damage, id.as_str()],
                    )
                    .unwrap();
            }
        }
        let by_creation = Sort {
            field: SortField::CreatedAt,
            direction: SortDirection::Ascending,
        };
        let listed = core.list(ListFilters::default(), by_creation).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].unreadable_properties, None);
        assert_eq!(text(&listed[0].properties), r#"{"title":"kept zebra"}"#);
        for damaged in &listed[1..] {
            assert!(damaged.properties.members.is_empty());
            assert!(damaged.unreadable_properties.is_some());
            assert_eq!(damaged.title, None);
            assert_eq!(
                damaged.state,
                ItemState::Active,
                "the rest of the row is as held"
            );
        }
        let hits = core
            .search("zebra".into(), SearchFilters::default(), 10)
            .unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(
            hits.iter()
                .filter(|hit| hit.item.unreadable_properties.is_some())
                .count(),
            2
        );
        // A damaged row matches no property condition: a filtered list and a
        // filtered search leave it out and still answer.
        let filter = Some(r#"properties.title eq "kept zebra""#.to_string());
        let filtered = core
            .list(
                ListFilters {
                    filter: filter.clone(),
                    ..ListFilters::default()
                },
                Sort {
                    field: SortField::CreatedAt,
                    direction: SortDirection::Ascending,
                },
            )
            .unwrap();
        assert_eq!(
            filtered.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            [ids[0].clone()]
        );
        let found = core
            .search(
                "zebra".into(),
                SearchFilters {
                    filter,
                    ..SearchFilters::default()
                },
                10,
            )
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].item.id, ids[0]);

        let one = core.get(ids[1].clone()).unwrap().unwrap();
        assert!(one.unreadable_properties.is_some());
        assert_eq!(core.status().unwrap().items, 3);
    }

    #[test]
    fn an_edges_properties_cross_both_ways_and_a_damaged_edge_is_flagged_not_fatal() {
        let (_dir, path, core) = copy_with_entries();
        let item = |title: &str| {
            core.create_item(draft(
                "app.test.entry",
                &format!(r#"{{"title":"{title}"}}"#),
            ))
            .unwrap()
            .item_id
            .unwrap()
        };
        let (reply, root, other) = (item("reply"), item("root"), item("other"));
        let thread = core
            .create_edge(EdgeDraft {
                source_id: reply.clone(),
                target_id: root.clone(),
                edge_type: "in-thread".into(),
                properties: parsed(r#"{"position":1}"#),
                id: None,
            })
            .unwrap()
            .edge_id
            .unwrap();
        let plain = core
            .create_edge(EdgeDraft {
                source_id: other.clone(),
                target_id: root.clone(),
                edge_type: "in-thread".into(),
                properties: JsonObject::default(),
                id: None,
            })
            .unwrap()
            .edge_id
            .unwrap();
        let from = core.edges_from(reply.clone()).unwrap();
        assert_eq!(text(&from[0].properties), r#"{"position":1}"#);
        assert_eq!(from[0].unreadable_properties, None);

        core.update_edge(
            thread.clone(),
            EdgeEdit {
                properties: parsed(r#"{"position":2}"#),
                base_version: 0,
                moves: None,
            },
        )
        .unwrap();
        assert_eq!(
            text(&core.edges_from(reply).unwrap()[0].properties),
            r#"{"position":2}"#
        );

        rusqlite::Connection::open(&path)
            .unwrap()
            .execute("UPDATE edges SET properties = '{' WHERE id = ?1", [&plain])
            .unwrap();
        let to = core.edges_to(root).unwrap();
        assert_eq!(to.len(), 2);
        let damaged = to.iter().find(|edge| edge.id == plain).unwrap();
        assert!(damaged.properties.members.is_empty());
        assert!(damaged.unreadable_properties.is_some());
        let sound = to.iter().find(|edge| edge.id == thread).unwrap();
        assert_eq!(sound.unreadable_properties, None);
        assert_eq!(core.edges_of_type("in-thread".into()).unwrap().len(), 2);
    }

    #[test]
    fn a_queued_writes_answer_crosses_as_the_value_it_holds() {
        let queued_with = |answer: Option<&str>| {
            let mut write = marfa_core::QueuedWrite {
                id: "q".into(),
                kind: marfa_core::WriteKind::UpdateItem,
                item_id: None,
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                idempotency_key: "k".into(),
                depends_on: Vec::new(),
                follows: None,
                verdict: None,
                reason: None,
                answer: None,
                refusal: None,
                body: serde_json::json!({ "properties": { "title": "t" } }),
                conflicted_copy_id: None,
                refusals: 0,
                environmental_streak: 0,
                last_failure: None,
                queued_at: String::new(),
                answered_at: None,
            };
            write.answer = answer.map(str::to_string);
            super::queued(write).unwrap()
        };
        assert_eq!(queued_with(None).answer, None);
        assert_eq!(
            queued_with(Some(
                r#"{"data":{"id":"i","version":4},"flags":[1,2.5,null]}"#
            ))
            .answer,
            Some(JsonValue::from(
                serde_json::json!({ "data": { "id": "i", "version": 4 }, "flags": [1, 2.5, null] })
            ))
        );
        assert_eq!(
            queued_with(Some("<html>Bad Gateway</html>")).answer,
            Some(JsonValue::String("<html>Bad Gateway</html>".into()))
        );
        assert_eq!(
            queued_with(None).body,
            parsed(r#"{"properties":{"title":"t"}}"#)
        );
    }

    #[test]
    fn a_copy_declares_types_and_hands_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
        core.declare_types(vec![parsed(
            r#"{"id":"app.recipe.entry","fields":{"title":{"type":"string","required":true}}}"#,
        )])
        .unwrap();
        let held = core.declared_types().unwrap();
        assert_eq!(held.len(), 1);
        assert!(text(&held[0]).contains("app.recipe.entry"));
        assert!(matches!(
            core.declare_types(vec![JsonObject {
                members: vec![JsonMember {
                    key: "id".into(),
                    value: JsonValue::Number(f64::INFINITY),
                }],
            }]),
            Err(MarfaError::Invalid { .. })
        ));
    }

    #[test]
    fn a_subscription_let_go_ends_its_follow() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(path, Some(server.url.clone()), Some("k".into()), None).unwrap();
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
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
    fn reach_expiry_ends_subscription_once_with_typed_error() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(
            path.clone(),
            Some(server.url.clone()),
            Some("k".into()),
            None,
        )
        .unwrap();
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        let reader = Core::open_reader(path).unwrap();
        let (told, ended) = std::sync::mpsc::channel();
        let subscription = Arc::clone(&core).follow(false, Arc::new(Told(told)));
        server.expire.store(true, Ordering::SeqCst);
        let error = ended
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(
            matches!(error, Some(MarfaError::CopyExpired { reason, .. }) if reason == "reach_changed")
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
            let reopened = Core::open(self.path.clone(), None, None, None).unwrap();
            let _ = self.handle.send(reopened.held_handle());
        }
    }

    #[test]
    fn a_follow_lets_go_of_the_store_before_it_says_it_ended() {
        let server = quiet();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite").display().to_string();
        let core = Core::open(
            path.clone(),
            Some(server.url.clone()),
            Some("k".into()),
            None,
        )
        .unwrap();
        core.hydrate(vec!["core.note".into()], SliceTier::Library, None)
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
        let writer = Core::open(path.clone(), Some(server.url), Some("k".into()), None).unwrap();
        writer
            .hydrate(vec!["core.note".into()], SliceTier::Library, None)
            .unwrap();
        let reader = Core::open_reader(path).unwrap();
        assert!(matches!(reader.held_handle(), Handle::Reader));
        let before = reader.data_version().unwrap();
        writer
            .create_item(Draft {
                r#type: "core.note".into(),
                id: None,
                properties: parsed(r#"{"title":"saved"}"#),
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
