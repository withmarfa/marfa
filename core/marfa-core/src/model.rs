use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::wire::WireItem;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Library,
    Feed,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Library => "library",
            Tier::Feed => "feed",
        }
    }
}

impl FromStr for Tier {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "library" => Ok(Tier::Library),
            "feed" => Ok(Tier::Feed),
            other => Err(CoreError::Invalid(format!(
                "tier must be library or feed, not {other:?}"
            ))),
        }
    }
}

impl fmt::Display for Tier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
}

impl ItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemState::Active => "active",
            ItemState::Archived => "archived",
            ItemState::Trashed => "trashed",
            ItemState::Revoked => "revoked",
        }
    }
}

impl FromStr for ItemState {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "active" => Ok(ItemState::Active),
            "archived" => Ok(ItemState::Archived),
            "trashed" => Ok(ItemState::Trashed),
            "revoked" => Ok(ItemState::Revoked),
            other => Err(CoreError::Decoding(format!("unknown item state {other:?}"))),
        }
    }
}

impl fmt::Display for ItemState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub r#type: String,
    pub properties: Map<String, Value>,
    pub state: ItemState,
    pub tier: Option<Tier>,
    pub version: i64,
    pub schema_version: i64,
    pub source: String,
    pub source_id: Option<String>,
    /// When the item's content happened, as opposed to when the row was
    /// written. The server defaults it to `created_at`.
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

impl Item {
    /// This row as the store writes it.
    ///
    /// A local edit changes fields on a row the copy already holds, and the
    /// store speaks the wire shape, so the two have to meet somewhere. Here
    /// rather than at the call site, where every caller would repeat it and
    /// one of them would eventually drop a field.
    pub(crate) fn as_wire(&self) -> WireItem {
        WireItem {
            id: self.id.clone(),
            r#type: self.r#type.clone(),
            state: self.state.as_str().into(),
            tier: self.tier.map(|tier| tier.as_str().to_string()),
            version: self.version,
            schema_version: self.schema_version,
            source: self.source.clone(),
            source_id: self.source_id.clone(),
            occurred_at: self.occurred_at.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            properties: self.properties.clone(),
            edges: None,
        }
    }

    /// The property a type names as its title, else `title`, else nothing.
    pub fn title(&self, title_field: Option<&str>) -> Option<&str> {
        self.properties
            .get(title_field.unwrap_or("title"))
            .and_then(Value::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties: Map<String, Value>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Edge {
    /// This edge as the store writes it, for the same reason `Item::as_wire`
    /// exists: a local edit changes an edge the copy already holds, and the
    /// store speaks the wire shape.
    pub(crate) fn as_wire(&self) -> crate::wire::WireEdge {
        crate::wire::WireEdge {
            id: self.id.clone(),
            source_id: self.source_id.clone(),
            target_id: self.target_id.clone(),
            edge_type: self.edge_type.clone(),
            properties: self.properties.clone(),
            version: self.version,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// Narrowing for a local list. Leaving `state` unset answers the active
/// state, as the server does; `all_states` lifts that, and a named state
/// wins.
///
/// The flag is a widening rather than a list of states because the question
/// a caller asks without one is always the same: what am I working with.
/// Everything else is a caller naming what it wants.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListFilters {
    pub r#type: Option<String>,
    pub state: Option<ItemState>,
    pub all_states: bool,
    pub tier: Option<Tier>,
    pub tags: Vec<String>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the
    /// server answers it and refused `validation_error` where the server
    /// refuses it. A `backref` condition is refused `Invalid`.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges, at any depth, as far as the copy holds those edges.
    pub beneath: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Narrowing for a local search: the state rule the list takes, a type
/// with its subtree, tags, a listing-grammar expression and `beneath`, each
/// read exactly as the list reads it. The tier and the time bounds are a
/// list's, and have no field here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchFilters {
    pub state: Option<ItemState>,
    pub all_states: bool,
    pub r#type: Option<String>,
    pub tags: Vec<String>,
    pub filter: Option<String>,
    pub beneath: Option<String>,
}

// Every sortable column is a verb plus `_at`, so the shared `At` suffix the
// lint reports is the naming rule rather than noise the variants could drop.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
}

impl SortField {
    pub fn as_str(self) -> &'static str {
        match self {
            SortField::CreatedAt => "created_at",
            SortField::UpdatedAt => "updated_at",
            SortField::OccurredAt => "occurred_at",
        }
    }
}

impl FromStr for SortField {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "created_at" => Ok(SortField::CreatedAt),
            "updated_at" => Ok(SortField::UpdatedAt),
            "occurred_at" => Ok(SortField::OccurredAt),
            other => Err(CoreError::Invalid(format!(
                "sort must be created_at, updated_at or occurred_at, not {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

impl SortDirection {
    pub fn as_sql(self) -> &'static str {
        match self {
            SortDirection::Ascending => "ASC",
            SortDirection::Descending => "DESC",
        }
    }
}

impl FromStr for SortDirection {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "asc" | "ascending" => Ok(SortDirection::Ascending),
            "desc" | "descending" => Ok(SortDirection::Descending),
            other => Err(CoreError::Invalid(format!(
                "direction must be asc or desc, not {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sort {
    pub field: SortField,
    pub direction: SortDirection,
}

impl Default for Sort {
    fn default() -> Self {
        Sort {
            field: SortField::CreatedAt,
            direction: SortDirection::Descending,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub item: Item,
    /// Higher is a better match.
    pub score: f64,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HydrateReport {
    pub types: Vec<String>,
    pub tier: Tier,
    /// The edge types held whole, every edge of each the key reads.
    pub edge_types: Vec<String>,
    pub items: u64,
    pub edges: u64,
    pub pages: u64,
    pub cursor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatchUpReport {
    pub applied: u64,
    pub skipped: u64,
    pub cursor: String,
    pub reached_head: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hydration {
    Never,
    InProgress,
    Complete,
    /// A catch-up was told the log has moved past the cursor this store
    /// kept, and the cursor was dropped.
    ///
    /// A record of an answer rather than a reading of the log: a store
    /// whose cursor aged out and has not asked since reports `Complete`,
    /// because nothing has told it. The copy is whole as of the moment it
    /// stopped and cannot be brought forward, so reads are refused exactly
    /// as they are for `Never` and the remedy is the same. It is a value of
    /// its own because the two are not the same fact about the copy:
    /// `Never` says there is nothing in it, and a caller deciding whether
    /// what it holds is worth anything reads that and is wrong.
    Expired,
}

impl Hydration {
    pub fn as_str(self) -> &'static str {
        match self {
            Hydration::Never => "never",
            Hydration::InProgress => "in_progress",
            Hydration::Complete => "complete",
            Hydration::Expired => "expired",
        }
    }
}

/// An edit a caller has asked for, before it is queued.
///
/// Whole field values and the version they were read at, and nothing else: a
/// device does not merge inside a field (`queue-and-verdicts.md` 34) and does
/// not mint or advance a version (`device.md` 20).
#[derive(Debug, Clone, Default)]
pub struct Edit {
    pub properties: Map<String, Value>,
    pub base_version: Option<i64>,
    /// The natural key this row should be under, where the caller is
    /// moving it (`items.md` 22). Sent under the item's id and the
    /// version it read, so a key another item holds is refused rather
    /// than taken. Absent leaves the key alone.
    pub source_id: Option<String>,
    /// The type to move the row to, sent as a retype: the server holds the
    /// row's properties to the type it enters (`items.md` 22). Absent, or
    /// the type the row already has, moves nothing.
    pub r#type: Option<String>,
    /// The tier to move the row to. Absent leaves it where it is.
    pub tier: Option<Tier>,
}

impl Edit {
    /// The body this update sends.
    ///
    /// `conflict=auto` is not here because it is a query parameter rather
    /// than a field, but it rides on every update this device sends
    /// (`queue-and-verdicts.md` 5): the server is asked to resolve within its
    /// own transaction rather than refusing and leaving two writes where one
    /// is atomic.
    pub(crate) fn payload(&self, base_version: i64) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        body.insert("version".into(), Value::from(base_version));
        if let Some(key) = &self.source_id {
            body.insert("source_id".into(), Value::String(key.clone()));
        }
        if let Some(r#type) = &self.r#type {
            // A `type` alone is a check the server refuses on a mismatch;
            // with `retype` it is a move.
            body.insert("type".into(), Value::String(r#type.clone()));
            body.insert("retype".into(), Value::Bool(true));
        }
        if let Some(tier) = self.tier {
            body.insert("tier".into(), serde_json::to_value(tier)?);
        }
        Ok(serde_json::to_string(&Value::Object(body))?)
    }
}

/// A create a caller has asked for, before it is queued.
///
/// Everything a device may send on a create and nothing it may invent: the
/// version is the caller's if they read one, the id is theirs if they minted
/// one, and the tags travel as their own writes rather than being dropped
/// (`device.md` 22).
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub r#type: String,
    pub id: Option<String>,
    pub properties: Map<String, Value>,
    pub tags: Vec<String>,
    pub tier: Option<Tier>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub occurred_at: Option<String>,
    pub base_version: Option<i64>,
}

impl Draft {
    /// The body this create sends, which is the caller's fields and nothing
    /// the device decided for itself.
    ///
    /// **The id minted here goes only on a create with no natural key**
    /// (`queue-and-verdicts.md` 38). The server resolves a create carrying a
    /// `source_id` by its key, onto a row it holds or into one it mints, and
    /// refuses a body `id` that is not the row the key resolves. The minted
    /// id names the copy's row until the answer names the server's. An id
    /// the caller named is theirs, and goes as named.
    pub(crate) fn payload(&self, id: &str) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        if self.id.is_some() || self.source_id.is_none() {
            body.insert("id".into(), Value::String(id.to_string()));
        }
        body.insert("type".into(), Value::String(self.r#type.clone()));
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        // The tags are not here. A tag is its own write
        // (`queue-and-verdicts.md` 33), queued and answered on its own, so
        // that a title changed on one device and a tag added on another both
        // land. Sending them inline would make the create carry something
        // that is not part of an item's fields, and a verdict about the
        // create would then be a verdict about the tags too.
        if let Some(tier) = self.tier {
            body.insert("tier".into(), Value::String(tier.as_str().into()));
        }
        for (key, value) in [
            ("source", &self.source),
            ("source_id", &self.source_id),
            ("occurred_at", &self.occurred_at),
        ] {
            if let Some(value) = value {
                body.insert(key.into(), Value::String(value.clone()));
            }
        }
        // Carried when the caller read one, absent when they did not. An
        // absent version is a create that is not conditional; a version the
        // device invented would be a version it minted (`device.md` 20).
        if let Some(version) = self.base_version {
            body.insert("version".into(), Value::from(version));
        }
        Ok(serde_json::to_string(&Value::Object(body))?)
    }

    /// The create a queued body describes: the row a copy holds again, under
    /// the id its queue row names, for a create still waiting when a
    /// hydration has cleared it (`queue-and-verdicts.md` 35). The body is no
    /// place to read the id from, because a create carrying a natural key
    /// sends none.
    pub(crate) fn from_payload(body: &str) -> std::result::Result<Draft, CoreError> {
        let body: Value = serde_json::from_str(body)?;
        let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_string);
        let draft = Draft {
            r#type: text("type").unwrap_or_default(),
            properties: body
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            tier: text("tier").map(|tier| tier.parse()).transpose()?,
            source: text("source"),
            source_id: text("source_id"),
            occurred_at: text("occurred_at"),
            ..Default::default()
        };
        Ok(draft)
    }

    /// The row the working copy holds until the server answers.
    ///
    /// Version 0, which is not a version the server ever mints: every row it
    /// returns starts at 1. A local row therefore cannot be mistaken for one
    /// the server has seen, and the first event that comes back for this id
    /// carries a higher version and replaces it (`device.md` 13).
    pub(crate) fn wire(&self, id: &str) -> WireItem {
        let at = self
            .occurred_at
            .clone()
            .unwrap_or_else(crate::store::now_iso);
        WireItem {
            id: id.to_string(),
            r#type: self.r#type.clone(),
            state: "active".into(),
            tier: Some(self.tier.unwrap_or(Tier::Library).as_str().into()),
            version: 0,
            schema_version: 1,
            source: self.source.clone().unwrap_or_else(|| "device".into()),
            source_id: self.source_id.clone(),
            occurred_at: at.clone(),
            created_at: at.clone(),
            updated_at: at,
            properties: self.properties.clone(),
            edges: None,
        }
    }
}

/// The kinds of write a queue holds (`queue-and-verdicts.md` 32).
///
/// A purge is not among them (`device.md` 25), and neither is a bulk door
/// or a bulk action: those are the server's way of doing many things in one
/// request rather than a thing a device holds a write for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

impl WriteKind {
    pub const ALL: [WriteKind; 15] = [
        WriteKind::CreateItem,
        WriteKind::UpdateItem,
        WriteKind::DeleteItem,
        WriteKind::RestoreItem,
        WriteKind::TransitionItem,
        WriteKind::CreateEdge,
        WriteKind::UpdateEdge,
        WriteKind::DeleteEdge,
        WriteKind::ReplaceMetadata,
        WriteKind::MergeMetadata,
        WriteKind::AddTag,
        WriteKind::RemoveTag,
        WriteKind::WriteExtension,
        WriteKind::DeleteExtension,
        WriteKind::UploadBlob,
    ];

    /// The edit of what a write of this kind writes: an item's update for an
    /// item's create or update, and an edge's for an edge's. No other write
    /// is based on a version, so no other has edits behind it that name one
    /// (`queue-and-verdicts.md` 36, 42).
    pub fn edit(self) -> Option<WriteKind> {
        match self {
            WriteKind::CreateItem | WriteKind::UpdateItem => Some(WriteKind::UpdateItem),
            WriteKind::CreateEdge | WriteKind::UpdateEdge => Some(WriteKind::UpdateEdge),
            _ => None,
        }
    }

    /// What a write of this kind is a write to: a row, named by `item_id`,
    /// or an edge, named by `edge_id`. An edge write names its endpoints in
    /// `item_id` and `target_id` too, and is a write to neither. An upload is
    /// a write to no row.
    pub fn subject(self) -> Option<Subject> {
        match self {
            WriteKind::CreateItem
            | WriteKind::UpdateItem
            | WriteKind::DeleteItem
            | WriteKind::RestoreItem
            | WriteKind::TransitionItem
            | WriteKind::ReplaceMetadata
            | WriteKind::MergeMetadata
            | WriteKind::AddTag
            | WriteKind::RemoveTag
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => Some(Subject::Item),
            WriteKind::CreateEdge | WriteKind::UpdateEdge | WriteKind::DeleteEdge => {
                Some(Subject::Edge)
            }
            WriteKind::UploadBlob => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WriteKind::CreateItem => "create_item",
            WriteKind::UpdateItem => "update_item",
            WriteKind::DeleteItem => "delete_item",
            WriteKind::RestoreItem => "restore_item",
            WriteKind::TransitionItem => "transition_item",
            WriteKind::CreateEdge => "create_edge",
            WriteKind::UpdateEdge => "update_edge",
            WriteKind::DeleteEdge => "delete_edge",
            WriteKind::ReplaceMetadata => "replace_metadata",
            WriteKind::MergeMetadata => "merge_metadata",
            WriteKind::AddTag => "add_tag",
            WriteKind::RemoveTag => "remove_tag",
            WriteKind::WriteExtension => "write_extension",
            WriteKind::DeleteExtension => "delete_extension",
            WriteKind::UploadBlob => "upload_blob",
        }
    }
}

/// What a queued write is a write to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Subject {
    Item,
    Edge,
}

impl Subject {
    /// The queue column that names it.
    pub fn column(self) -> &'static str {
        match self {
            Subject::Item => "item_id",
            Subject::Edge => "edge_id",
        }
    }

    /// Every kind of write to it.
    pub fn kinds(self) -> Vec<WriteKind> {
        WriteKind::ALL
            .into_iter()
            .filter(|kind| kind.subject() == Some(self))
            .collect()
    }
}

impl FromStr for WriteKind {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        WriteKind::ALL
            .into_iter()
            .find(|kind| kind.as_str() == text)
            .ok_or_else(|| CoreError::Store(format!("{text:?} is not a kind a queue holds")))
    }
}

impl fmt::Display for WriteKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The six verdicts (`queue-and-verdicts.md` 7). The set is closed: an
/// answer a device cannot classify is a defect in the device, not a seventh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Accepted,
    Merged,
    Conflicted,
    Refused,
    Blocked,
    Dead,
}

impl Verdict {
    pub const ALL: [Verdict; 6] = [
        Verdict::Accepted,
        Verdict::Merged,
        Verdict::Conflicted,
        Verdict::Refused,
        Verdict::Blocked,
        Verdict::Dead,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Accepted => "accepted",
            Verdict::Merged => "merged",
            Verdict::Conflicted => "conflicted",
            Verdict::Refused => "refused",
            Verdict::Blocked => "blocked",
            Verdict::Dead => "dead",
        }
    }
}

impl FromStr for Verdict {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Verdict::ALL
            .into_iter()
            .find(|verdict| verdict.as_str() == text)
            .ok_or_else(|| {
                CoreError::Store(format!(
                    "{text:?} is not one of the six verdicts a write is answered with"
                ))
            })
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A verdict with what it carries: the fields a resolution names, the
/// sibling a conflict wrote, the reason a refusal or a block gives. `Verdict`
/// is the six as the queue stores them; this is what a caller reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Accepted,
    Merged {
        fields: Vec<String>,
    },
    Conflicted {
        sibling_id: String,
        fields: Vec<String>,
    },
    /// The server's code verbatim, or the sentence naming the write this one
    /// waited on where that write was refused (`queue-and-verdicts.md` 16).
    Refused {
        reason: String,
    },
    Blocked {
        reason: BlockedReason,
    },
    Dead,
}

impl Outcome {
    /// Reads a stored verdict and its columns as one value. A blocked row
    /// whose reason is not one of the five is refused, not guessed at.
    pub fn of(
        verdict: Option<Verdict>,
        reason: Option<&str>,
        sibling_id: Option<&str>,
        fields: Vec<String>,
    ) -> Result<Option<Outcome>, CoreError> {
        Ok(Some(match verdict {
            None => return Ok(None),
            Some(Verdict::Accepted) => Outcome::Accepted,
            Some(Verdict::Merged) => Outcome::Merged { fields },
            Some(Verdict::Conflicted) => Outcome::Conflicted {
                sibling_id: sibling_id.unwrap_or_default().to_string(),
                fields,
            },
            Some(Verdict::Refused) => Outcome::Refused {
                reason: reason.unwrap_or_default().to_string(),
            },
            Some(Verdict::Blocked) => Outcome::Blocked {
                reason: reason.unwrap_or_default().parse()?,
            },
            Some(Verdict::Dead) => Outcome::Dead,
        }))
    }
}

/// Why a `blocked` write has stopped (`queue-and-verdicts.md` 26).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    CredentialRefused,
    KeySpent,
    AncestorUnavailable,
    ConflictUnresolved,
    AwaitingDependency,
}

impl BlockedReason {
    pub const ALL: [BlockedReason; 5] = [
        BlockedReason::CredentialRefused,
        BlockedReason::KeySpent,
        BlockedReason::AncestorUnavailable,
        BlockedReason::ConflictUnresolved,
        BlockedReason::AwaitingDependency,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BlockedReason::CredentialRefused => "credential_refused",
            BlockedReason::KeySpent => "key_spent",
            BlockedReason::AncestorUnavailable => "ancestor_unavailable",
            BlockedReason::ConflictUnresolved => "conflict_unresolved",
            BlockedReason::AwaitingDependency => "awaiting_dependency",
        }
    }

    /// The two that clear without a caller (`queue-and-verdicts.md` 24 and
    /// 27): a drain returns these rows to unanswered before it starts, so the
    /// block is the last drain's finding rather than a state that sticks.
    pub fn clears_itself(self) -> bool {
        matches!(
            self,
            BlockedReason::AwaitingDependency | BlockedReason::CredentialRefused
        )
    }
}

impl FromStr for BlockedReason {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        BlockedReason::ALL
            .into_iter()
            .find(|reason| reason.as_str() == text)
            .ok_or_else(|| {
                CoreError::Invalid(format!(
                    "{text:?} is not one of the five reasons a write is blocked: {}",
                    BlockedReason::ALL.map(BlockedReason::as_str).join(", ")
                ))
            })
    }
}

impl fmt::Display for BlockedReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One queued write, as the queue reports it.
///
/// A verdict of `None` is a write the server has not answered: the six are
/// what an answer carries (`queue-and-verdicts.md` 7), and this is the
/// absence of one. It serializes as `null` rather than as a token, so a
/// reader has to handle the absence rather than matching a seventh string.
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// The writes this one cannot go without, by queue id: the create of a
    /// row it names while the server has not taken it, the creates of both of
    /// an edge's endpoints, the edge's own create, the upload a file item
    /// names (`queue-and-verdicts.md` 4). A refusal of one refuses this one
    /// too (12, 16).
    pub depends_on: Vec<String>,
    /// The write ahead of this one to the same row or edge, by queue id,
    /// where one was still to be written when this one was queued. This one
    /// is held while that one has gone out without an answer or is held
    /// behind one that has; any answer to it releases this one, and a
    /// refusal of it refuses nothing (`queue-and-verdicts.md` 42).
    pub follows: Option<String>,
    pub verdict: Option<Verdict>,
    /// In whichever vocabulary the verdict speaks: one of the five blocked
    /// reasons under `blocked` (read as one by `blocked_reason`), and under
    /// `refused` the server's code verbatim, or for a write held behind one
    /// that was refused, the sentence naming it (`queue-and-verdicts.md` 16).
    pub reason: Option<String>,
    /// The server's answer, kept whole. A device reports a verdict and never
    /// acts on one (`queue-and-verdicts.md` 15), so what it reports has to be
    /// what it was told.
    pub answer: Option<String>,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

impl QueuedWrite {
    /// The row or edge this write is a write to, by id.
    pub fn subject_id(&self) -> Option<&str> {
        match self.kind.subject()? {
            Subject::Item => self.item_id.as_deref(),
            Subject::Edge => self.edge_id.as_deref(),
        }
    }

    /// What became of this write, with what its verdict carries; nothing
    /// while it is unanswered.
    pub fn outcome(&self) -> Result<Option<Outcome>, CoreError> {
        Outcome::of(
            self.verdict,
            self.reason.as_deref(),
            self.conflicted_copy_id.as_deref(),
            self.resolved_fields(),
        )
    }

    /// The reason a `blocked` row carries, as one of the five. The store
    /// refuses a row whose blocked reason is outside the set when it reads
    /// the queue, so a blocked row always has one.
    pub fn blocked_reason(&self) -> Option<BlockedReason> {
        match self.verdict {
            Some(Verdict::Blocked) => self
                .reason
                .as_deref()
                .and_then(|reason| reason.parse().ok()),
            _ => None,
        }
    }

    /// The fields a `merged` or `conflicted` answer says the server
    /// resolved, read from the answer kept on the row. Empty on every other
    /// verdict, because nothing was resolved.
    fn resolved_fields(&self) -> Vec<String> {
        if !matches!(self.verdict, Some(Verdict::Merged | Verdict::Conflicted)) {
            return Vec::new();
        }
        self.answer
            .as_deref()
            .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
            .and_then(|answer| {
                answer
                    .get("conflict_resolution")?
                    .get("fields")?
                    .as_array()
                    .map(|fields| {
                        fields
                            .iter()
                            .filter_map(|field| field.as_str().map(str::to_string))
                            .collect()
                    })
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub server_origin: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
    /// The edge types the slice holds whole.
    pub slice_edge_types: Vec<String>,
    /// The rows held by id whatever the slice says of them.
    pub pinned: Vec<String>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: u64,
    pub edges: u64,
}

/// An edge a caller has asked for, before it is queued.
///
/// An edge is its own write (`queue-and-verdicts.md` 33): it is not part of
/// an item's fields, so it does not collide with an edit to them, and a title
/// changed on one device and a link added on another both land.
#[derive(Debug, Clone, Default)]
pub struct EdgeDraft {
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties: Map<String, Value>,
    pub id: Option<String>,
}

impl EdgeDraft {
    pub(crate) fn payload(&self, id: &str) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("id".into(), Value::String(id.to_string()));
        body.insert("source_id".into(), Value::String(self.source_id.clone()));
        body.insert("target_id".into(), Value::String(self.target_id.clone()));
        body.insert("edge_type".into(), Value::String(self.edge_type.clone()));
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        Ok(serde_json::to_string(&Value::Object(body))?)
    }

    /// The edge a queued body describes, and the id it names, for the
    /// reason `Draft::from_payload` gives.
    pub(crate) fn from_payload(body: &str) -> std::result::Result<(String, EdgeDraft), CoreError> {
        let body: Value = serde_json::from_str(body)?;
        let text = |key: &str| {
            body.get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default()
        };
        let id = text("id");
        if id.is_empty() {
            return Err(CoreError::Store(
                "a queued edge create carries no id, so its edge cannot be held".into(),
            ));
        }
        let draft = EdgeDraft {
            source_id: text("source_id"),
            target_id: text("target_id"),
            edge_type: text("edge_type"),
            properties: body
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            id: None,
        };
        Ok((id, draft))
    }

    /// The edge the working copy holds until the server answers. Version 0,
    /// for the reason a local item is (`Draft::wire`).
    pub(crate) fn wire(&self, id: &str) -> crate::wire::WireEdge {
        let at = crate::store::now_iso();
        crate::wire::WireEdge {
            id: id.to_string(),
            source_id: self.source_id.clone(),
            target_id: self.target_id.clone(),
            edge_type: self.edge_type.clone(),
            properties: self.properties.clone(),
            version: 0,
            created_at: at.clone(),
            updated_at: at,
        }
    }
}

/// How a file is attached (`Core::attach`). Each field has a default: the
/// MIME type from the file's extension, the title from its name, the type
/// from the MIME type, the tier from the server.
#[derive(Debug, Clone, Default)]
pub struct Attachment {
    pub mime_type: Option<String>,
    pub title: Option<String>,
    pub r#type: Option<String>,
    pub tier: Option<Tier>,
}

/// An item's thumbnail, decoded from the data URI it travels as.
#[derive(Debug, Clone, PartialEq)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// The most a thumbnail decodes to, which is the server's cap on one.
pub const THUMBNAIL_MAX_BYTES: usize = 16 * 1024;

impl Thumbnail {
    /// A thumbnail as the server takes one: `data:image/png;base64,`,
    /// `data:image/jpeg;base64,` or `data:image/webp;base64,` and canonical
    /// base64 of at most [`THUMBNAIL_MAX_BYTES`], whose bytes begin with that
    /// format's signature. A held value that is not one is refused rather
    /// than answered as an image: it was written before its type declared
    /// the field, and nothing checked it.
    pub fn from_data_uri(value: &str) -> Result<Thumbnail, CoreError> {
        use base64::Engine;
        let unreadable =
            |why: &str| CoreError::Decoding(format!("a thumbnail that is {why}: {:.40}", value));
        let (mime_type, data) = value
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"))
            .ok_or_else(|| unreadable("not a base64 data URI"))?;
        let signed: fn(&[u8]) -> bool = match mime_type {
            "image/png" => |bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => |bytes| bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => {
                |bytes| bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
            }
            _ => return Err(unreadable("not a PNG, JPEG or WebP image")),
        };
        // The standard engine refuses bits the bytes do not use and padding
        // other than the one spelling, which is the server's canonical rule.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| unreadable("not canonical base64"))?;
        if bytes.len() > THUMBNAIL_MAX_BYTES {
            return Err(unreadable("over the thumbnail cap"));
        }
        if !signed(&bytes) {
            return Err(unreadable("not the image its data URI names"));
        }
        Ok(Thumbnail {
            mime_type: mime_type.to_string(),
            bytes,
        })
    }
}

/// The three writes an attachment is, in the order they go out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
}

/// A change to an edge's properties, and the version it was read at.
#[derive(Debug, Clone, Default)]
pub struct EdgeEdit {
    pub properties: Map<String, Value>,
    pub base_version: Option<i64>,
}

impl EdgeEdit {
    pub(crate) fn payload(&self, base_version: i64) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        body.insert("version".into(), Value::from(base_version));
        Ok(serde_json::to_string(&Value::Object(body))?)
    }
}

/// What a metadata write carries. Tags are the half a working copy holds;
/// an extension namespace is not, and travels as its own write.
#[derive(Debug, Clone, Default)]
pub struct MetadataWrite {
    pub tags: Vec<String>,
}

impl MetadataWrite {
    pub(crate) fn payload(&self) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert(
            "tags".into(),
            Value::Array(self.tags.iter().cloned().map(Value::String).collect()),
        );
        Ok(serde_json::to_string(&Value::Object(body))?)
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0";
    const WEBP: &[u8] = b"RIFF\0\0\0\0WEBPVP8 ";

    fn uri(mime_type: &str, head: &[u8], size: usize) -> String {
        let mut bytes = head.to_vec();
        bytes.resize(size, 7);
        format!(
            "data:{mime_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    /// Each of the three formats reads with its own type and its bytes, up
    /// to the cap.
    #[test]
    fn a_thumbnail_reads_as_the_image_its_data_uri_names() {
        for (mime_type, head) in [
            ("image/png", PNG),
            ("image/jpeg", JPEG),
            ("image/webp", WEBP),
        ] {
            let read = Thumbnail::from_data_uri(&uri(mime_type, head, 64)).unwrap();
            assert_eq!(read.mime_type, mime_type);
            assert_eq!(read.bytes.len(), 64);
            assert!(read.bytes.starts_with(head));
        }
        let at_cap = Thumbnail::from_data_uri(&uri("image/png", PNG, THUMBNAIL_MAX_BYTES)).unwrap();
        assert_eq!(at_cap.bytes.len(), THUMBNAIL_MAX_BYTES);
    }

    /// What the server refuses as a thumbnail, a device refuses to read as
    /// one: each of these was held under the property before its type
    /// declared it.
    #[test]
    fn a_value_the_server_would_refuse_is_not_read_as_a_thumbnail() {
        let refused = [
            ("not an image", uri("text/plain", PNG, 64)),
            ("another image", uri("image/gif", b"GIF89a", 64)),
            ("an uppercase type", uri("image/PNG", PNG, 64)),
            ("not the image it names", uri("image/jpeg", PNG, 64)),
            (
                "a signature short by a byte",
                uri("image/png", &PNG[..7], 64),
            ),
            (
                "a RIFF that is not WebP",
                uri("image/webp", b"RIFF\0\0\0\0WAVEfmt ", 64),
            ),
            (
                "over the cap",
                uri("image/png", PNG, THUMBNAIL_MAX_BYTES + 1),
            ),
            (
                "unused bits set",
                "data:image/png;base64,iVBORw0KGgp=".to_string(),
            ),
            (
                "padding left off",
                "data:image/png;base64,iVBORw0KGgo".to_string(),
            ),
            ("a link", "https://example.com/thumb.png".to_string()),
            ("empty", "data:image/png;base64,".to_string()),
        ];
        for (what, value) in refused {
            assert!(
                matches!(
                    Thumbnail::from_data_uri(&value),
                    Err(CoreError::Decoding(_))
                ),
                "{what} was read as a thumbnail"
            );
        }
        // The witness for the two base64 cases: the canonical spelling of the
        // same eight bytes is read.
        assert_eq!(
            Thumbnail::from_data_uri("data:image/png;base64,iVBORw0KGgo=")
                .unwrap()
                .bytes,
            PNG
        );
    }

    fn row(verdict: Option<Verdict>, reason: Option<&str>, answer: Option<&str>) -> QueuedWrite {
        QueuedWrite {
            id: "q".into(),
            kind: WriteKind::UpdateItem,
            item_id: Some("i".into()),
            target_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: Some(1),
            idempotency_key: "k".into(),
            depends_on: Vec::new(),
            follows: None,
            verdict,
            reason: reason.map(str::to_string),
            answer: answer.map(str::to_string),
            conflicted_copy_id: Some("sibling".into()),
            refusals: 0,
            queued_at: "2026-01-01T00:00:00Z".into(),
            answered_at: None,
        }
    }

    /// The id minted here goes on a create with no natural key, never on one
    /// carrying a `source_id`, and an id the caller named goes as named.
    #[test]
    fn a_create_carrying_a_natural_key_names_no_minted_id() {
        let body = |draft: &Draft| -> Value {
            let id = draft.id.clone().unwrap_or_else(|| "minted".into());
            serde_json::from_str(&draft.payload(&id).unwrap()).unwrap()
        };
        let plain = Draft {
            r#type: "core.note".into(),
            ..Default::default()
        };
        assert_eq!(body(&plain)["id"], "minted");
        let keyed = Draft {
            source_id: Some("note.md".into()),
            ..plain.clone()
        };
        assert!(body(&keyed).get("id").is_none());
        assert_eq!(body(&keyed)["source_id"], "note.md");
        let named = Draft {
            id: Some("named".into()),
            ..keyed.clone()
        };
        assert_eq!(body(&named)["id"], "named");
        // Held again from its body with nothing lost but the id, which the
        // queue row carries.
        let held = Draft::from_payload(&keyed.payload("minted").unwrap()).unwrap();
        assert_eq!(held.source_id.as_deref(), Some("note.md"));
        assert_eq!(held.r#type, "core.note");
    }

    /// Each of the six read with what it carries, and nothing for a write
    /// still waiting.
    #[test]
    fn a_stored_verdict_reads_as_one_outcome_with_what_it_carries() {
        let resolution = r#"{"conflict_resolution":{"fields":["title","body"]}}"#;
        assert_eq!(row(None, None, None).outcome().unwrap(), None);
        assert_eq!(
            row(Some(Verdict::Accepted), None, None).outcome().unwrap(),
            Some(Outcome::Accepted)
        );
        assert_eq!(
            row(Some(Verdict::Merged), None, Some(resolution))
                .outcome()
                .unwrap(),
            Some(Outcome::Merged {
                fields: vec!["title".into(), "body".into()]
            })
        );
        assert_eq!(
            row(Some(Verdict::Conflicted), None, Some(resolution))
                .outcome()
                .unwrap(),
            Some(Outcome::Conflicted {
                sibling_id: "sibling".into(),
                fields: vec!["title".into(), "body".into()]
            })
        );
        assert_eq!(
            row(Some(Verdict::Refused), Some("type_not_permitted"), None)
                .outcome()
                .unwrap(),
            Some(Outcome::Refused {
                reason: "type_not_permitted".into()
            })
        );
        assert_eq!(
            row(Some(Verdict::Blocked), Some("key_spent"), None)
                .outcome()
                .unwrap(),
            Some(Outcome::Blocked {
                reason: BlockedReason::KeySpent
            })
        );
        assert_eq!(
            row(Some(Verdict::Dead), None, None).outcome().unwrap(),
            Some(Outcome::Dead)
        );
        // An accepted answer carries no resolution, so no fields are read
        // off it even where its answer happens to name some.
        assert_eq!(
            row(Some(Verdict::Accepted), None, Some(resolution))
                .outcome()
                .unwrap(),
            Some(Outcome::Accepted)
        );
        assert!(
            row(Some(Verdict::Blocked), Some("resolver_missing"), None)
                .outcome()
                .is_err()
        );
    }

    /// Every member of the three closed sets round-trips through its text.
    #[test]
    fn the_closed_sets_round_trip_through_their_text() {
        for kind in WriteKind::ALL {
            assert_eq!(kind.as_str().parse::<WriteKind>().unwrap(), kind);
        }
        for verdict in Verdict::ALL {
            assert_eq!(verdict.as_str().parse::<Verdict>().unwrap(), verdict);
        }
        for reason in BlockedReason::ALL {
            assert_eq!(reason.as_str().parse::<BlockedReason>().unwrap(), reason);
        }
        assert!("seventh".parse::<Verdict>().is_err());
        assert!("resolver_missing".parse::<BlockedReason>().is_err());
    }
}
