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
    /// When the item's content happened; the server defaults it to `created_at`.
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

impl Item {
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
}

/// What an item shows as its title and its body: the text under the
/// properties its type's display hints name, by the rule a folder names a
/// file and writes its body by.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Shown {
    pub title: Option<String>,
    pub body: Option<String>,
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

/// Leaving `state` unset answers the active state, as the server does;
/// `all_states` lifts that, and a named state wins.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListFilters {
    pub r#type: Option<String>,
    pub state: Option<ItemState>,
    pub all_states: bool,
    pub tier: Option<Tier>,
    pub tags: Vec<String>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    /// A `backref` condition is refused `Invalid`: the copy does not hold
    /// every edge drawn to its items.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges the copy holds, at any depth.
    pub beneath: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchFilters {
    pub state: Option<ItemState>,
    pub all_states: bool,
    pub r#type: Option<String>,
    pub tags: Vec<String>,
    pub filter: Option<String>,
    pub beneath: Option<String>,
}

// The shared `At` suffix is the column naming rule, not noise.
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
    /// An excerpt as HTML: the text escaped and each match in `<mark>` tags.
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// Declared types the instance did not hold and would not take. Writes to
    /// them wait for the server's verdict, which is a refusal until a key
    /// that may registers them.
    pub unregistered_types: Vec<UnregisteredType>,
}

/// A declared type the instance refused to register, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnregisteredType {
    pub id: String,
    /// The server's code for the refusal.
    pub code: String,
    pub message: String,
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
    /// A catch-up or a held stream learned that the server's log no longer
    /// continues from the kept cursor, or any call that reads the root (a
    /// catch-up, a held stream, a drain, a pin or a folder's settings edit)
    /// found another instance at the origin. Set only on that answer: a store
    /// whose cursor aged out and has not asked since still reports
    /// `Complete`. Reads are refused as for `Never`.
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

#[derive(Debug, Clone, Default)]
pub struct Edit {
    pub properties: Map<String, Value>,
    pub base_version: Option<i64>,
    pub source_id: Option<String>,
    pub r#type: Option<String>,
    pub tier: Option<Tier>,
    /// A property left out is cleared; otherwise they merge over the row's.
    pub replace_properties: bool,
}

impl Edit {
    /// `conflict=auto` rides on every update as a query parameter, so it is
    /// not in this body.
    pub(crate) fn payload(&self, base_version: i64) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        body.insert("version".into(), Value::from(base_version));
        if self.replace_properties {
            body.insert("properties_mode".into(), Value::String("replace".into()));
        }
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
    /// A minted id goes only on a create with no natural key: the server
    /// resolves a `source_id` itself and refuses a body `id` that is not the
    /// row the key resolves. An id the caller named goes as named.
    pub(crate) fn payload(&self, id: &str) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        if self.id.is_some() || self.source_id.is_none() {
            body.insert("id".into(), Value::String(id.to_string()));
        }
        body.insert("type".into(), Value::String(self.r#type.clone()));
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        // Tags go as their own writes, so a verdict on the create is not a
        // verdict on the tags.
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
        // Never invented: an absent version makes the create unconditional.
        if let Some(version) = self.base_version {
            body.insert("version".into(), Value::from(version));
        }
        Ok(serde_json::to_string(&Value::Object(body))?)
    }

    /// The id is not read from the body, because a create carrying a natural
    /// key sends none; the caller takes it from the queue row.
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

    /// Version 0: the server's versions start at 1, so a local row is never
    /// mistaken for one it has seen, and the first event for this id
    /// replaces it.
    pub(crate) fn wire(&self, id: &str) -> WireItem {
        let at = self
            .occurred_at
            .as_deref()
            .map(crate::time::projected)
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

    /// Creates and updates can advance the version a later edit names.
    pub fn edit(self) -> Option<WriteKind> {
        match self {
            WriteKind::CreateItem | WriteKind::UpdateItem => Some(WriteKind::UpdateItem),
            WriteKind::CreateEdge | WriteKind::UpdateEdge => Some(WriteKind::UpdateEdge),
            _ => None,
        }
    }

    /// A write whose refusal would lose what a person wrote, were it cleared
    /// with the answered rows: it leaves the queue only when discarded.
    pub fn carries_content(self) -> bool {
        matches!(
            self,
            WriteKind::CreateItem
                | WriteKind::UpdateItem
                | WriteKind::ReplaceMetadata
                | WriteKind::MergeMetadata
                | WriteKind::WriteExtension
                | WriteKind::CreateEdge
                | WriteKind::UpdateEdge
        )
    }

    /// An edge write names its endpoints in `item_id` and `target_id` too,
    /// but is a write to neither.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Subject {
    Item,
    Edge,
}

impl Subject {
    pub fn column(self) -> &'static str {
        match self {
            Subject::Item => "item_id",
            Subject::Edge => "edge_id",
        }
    }

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

/// Closed: an answer a device cannot classify is a defect in the device, not
/// a seventh verdict.
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

/// What became of a write, read once from what the queue stores.
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
    Refused(Refusal),
    Blocked {
        reason: BlockedReason,
        refusal: Option<Refusal>,
    },
    /// Held behind a write that has no answer yet. The queue stores it as
    /// `blocked` `awaiting_dependency`; nothing outside the queue has to
    /// change for it to go, so it is not presented as a stop.
    Waiting,
    Dead,
}

impl Outcome {
    /// A blocked row whose reason is not one of the five is an error.
    pub fn of(
        verdict: Option<Verdict>,
        reason: Option<&str>,
        sibling_id: Option<&str>,
        fields: Vec<String>,
        refusal: Option<&Refusal>,
    ) -> Result<Option<Outcome>, CoreError> {
        Ok(Some(match verdict {
            None => return Ok(None),
            Some(Verdict::Accepted) => Outcome::Accepted,
            Some(Verdict::Merged) => Outcome::Merged { fields },
            Some(Verdict::Conflicted) => Outcome::Conflicted {
                sibling_id: sibling_id.unwrap_or_default().to_string(),
                fields,
            },
            Some(Verdict::Refused) => Outcome::Refused(
                refusal
                    .cloned()
                    .unwrap_or_else(|| Refusal::read(reason.unwrap_or_default(), None)),
            ),
            Some(Verdict::Blocked) => match reason.unwrap_or_default().parse()? {
                BlockedReason::AwaitingDependency => Outcome::Waiting,
                reason => Outcome::Blocked {
                    reason,
                    refusal: refusal.cloned(),
                },
            },
            Some(Verdict::Dead) => Outcome::Dead,
        }))
    }
}

/// A refusal read into its parts from the server's envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    /// The server's code verbatim, or, for a write the drain refused without
    /// sending, the sentence naming the write it waited for.
    pub reason: String,
    /// `error.code`, where the server's envelope carries one.
    pub code: Option<String>,
    pub message: Option<String>,
    /// `details.errors`: each property the server would not take, and why.
    pub fields: Vec<FieldRefusal>,
    /// The row the write named is in the bin: a `404 item_not_found` saying
    /// so in `details.trashed`, or a create acknowledged onto a trashed row.
    pub trashed: bool,
    /// `details.grant`: the permission the credential's key lacks.
    pub grant: Option<MissingGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldRefusal {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissingGrant {
    pub kind: GrantKind,
    /// The type or edge type id, or the extension namespace.
    pub name: String,
    pub level: GrantLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    Type,
    EdgeType,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantLevel {
    Read,
    Write,
}

impl Refusal {
    pub(crate) fn for_write(
        verdict: Option<Verdict>,
        reason: Option<&str>,
        answer: Option<&str>,
    ) -> Option<Self> {
        (verdict == Some(Verdict::Refused)
            || (verdict == Some(Verdict::Blocked)
                && reason == Some(BlockedReason::CredentialRefused.as_str())
                && answer.is_some()))
        .then(|| Self::read(reason.unwrap_or_default(), answer))
    }

    /// `answer` is the stored answer, which for a create acknowledged onto a
    /// trashed row is the row and not an error. A part the envelope does
    /// not carry, or carries in another shape, reads as absent.
    pub fn read(reason: &str, answer: Option<&str>) -> Refusal {
        let body = answer
            .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
            .unwrap_or_default();
        let error = body.get("error");
        let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
        let details = error.and_then(|error| error.get("details"));
        let fields = details
            .and_then(|details| details.get("errors"))
            .and_then(Value::as_array)
            .map(|errors| {
                errors
                    .iter()
                    .filter_map(|entry| {
                        Some(FieldRefusal {
                            field: text(entry.get("field"))?,
                            message: text(entry.get("message")).unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let grant = details
            .and_then(|details| details.get("grant"))
            .and_then(|grant| {
                Some(MissingGrant {
                    kind: serde_json::from_value(grant.get("kind")?.clone()).ok()?,
                    name: text(grant.get("name"))?,
                    level: serde_json::from_value(grant.get("level")?.clone()).ok()?,
                })
            });
        let acknowledged_in_bin = body.get("acknowledged") == Some(&Value::Bool(true))
            && body.pointer("/item/state").and_then(Value::as_str) == Some("trashed");
        Refusal {
            reason: reason.to_string(),
            code: text(error.and_then(|error| error.get("code"))),
            message: text(error.and_then(|error| error.get("message"))),
            fields,
            trashed: details.and_then(|details| details.get("trashed")) == Some(&Value::Bool(true))
                || acknowledged_in_bin,
            grant,
        }
    }
}

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

    /// A drain returns these rows to unanswered before it starts, so the
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

/// A verdict of `None` is a write not yet answered, and serializes as `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedWrite {
    pub id: String,
    pub kind: WriteKind,
    pub item_id: Option<String>,
    pub target_id: Option<String>,
    pub edge_id: Option<String>,
    pub namespace: Option<String>,
    pub tag: Option<String>,
    /// The hash of the blob an upload carries.
    pub blob: Option<String>,
    pub base_version: Option<i64>,
    pub idempotency_key: String,
    /// Queue ids. A refusal of one refuses this one too.
    pub depends_on: Vec<String>,
    /// The queue id of the earlier write to the same row or edge. Any answer
    /// to it releases this one; unlike `depends_on`, its refusal refuses
    /// nothing.
    pub follows: Option<String>,
    pub verdict: Option<Verdict>,
    /// A blocked reason under `blocked`; under `refused`, the server's code
    /// verbatim or a sentence naming the refused write this one was held behind.
    pub reason: Option<String>,
    /// The server's answer, kept whole.
    pub answer: Option<String>,
    /// The refusal for a terminal answer or a credential-blocked write.
    pub refusal: Option<Refusal>,
    /// What the write sends, or sent: kept so a refused write's content can
    /// be read back from the queue until it is discarded.
    pub body: Value,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

impl QueuedWrite {
    pub fn subject_id(&self) -> Option<&str> {
        match self.kind.subject()? {
            Subject::Item => self.item_id.as_deref(),
            Subject::Edge => self.edge_id.as_deref(),
        }
    }

    pub fn outcome(&self) -> Result<Option<Outcome>, CoreError> {
        Outcome::of(
            self.verdict,
            self.reason.as_deref(),
            self.conflicted_copy_id.as_deref(),
            self.resolved_fields(),
            self.refusal.as_ref(),
        )
    }

    pub fn blocked_reason(&self) -> Option<BlockedReason> {
        match self.verdict {
            Some(Verdict::Blocked) => self
                .reason
                .as_deref()
                .and_then(|reason| reason.parse().ok()),
            _ => None,
        }
    }

    pub fn withdrawable(&self) -> bool {
        matches!(
            self.blocked_reason(),
            Some(BlockedReason::AncestorUnavailable | BlockedReason::ConflictUnresolved)
        )
    }

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
    /// The instance the copy was hydrated from, as the server's root named
    /// it; `None` before a hydration that read one.
    pub instance_id: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
    pub slice_edge_types: Vec<String>,
    /// The rows held by id whatever the slice says of them.
    pub pinned: Vec<String>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: u64,
    pub edges: u64,
    /// Moves each time a refresh changes the catalog; `None` where the copy
    /// has never held one.
    pub catalog_version: Option<u64>,
}

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

    /// Version 0, for the reason `Draft::wire` gives.
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

/// Each field left unset is worked out: the MIME type from the file's
/// extension, the title from its name, the type from the MIME type, the
/// tier by the server.
#[derive(Debug, Clone, Default)]
pub struct Attachment {
    pub mime_type: Option<String>,
    pub title: Option<String>,
    pub r#type: Option<String>,
    pub tier: Option<Tier>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// The server's cap on a decoded thumbnail.
pub const THUMBNAIL_MAX_BYTES: usize = 16 * 1024;

impl Thumbnail {
    /// Checks what the server checks, because a held value may have been
    /// written before its type declared the field, when nothing checked it.
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
        // The standard engine refuses unused bits set and non-canonical
        // padding, matching the server's canonical rule.
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

/// In the order they go out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
}

/// In the order they go out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Added {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
}

#[derive(Debug, Clone, Default)]
pub struct EdgeEdit {
    pub properties: Map<String, Value>,
    pub base_version: Option<i64>,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
}

impl EdgeEdit {
    pub(crate) fn payload(&self, base_version: i64) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("properties".into(), Value::Object(self.properties.clone()));
        body.insert("version".into(), Value::from(base_version));
        for (key, end) in [
            ("source_id", &self.source_id),
            ("target_id", &self.target_id),
        ] {
            if let Some(end) = end {
                body.insert(key.into(), Value::String(end.clone()));
            }
        }
        Ok(serde_json::to_string(&Value::Object(body))?)
    }
}

/// Extension namespaces are not here: the working copy does not hold them,
/// and they travel as their own writes.
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

    #[test]
    fn timestamp_projection_keeps_the_original_request() {
        let draft = Draft {
            r#type: "core.note".into(),
            occurred_at: Some("2026-01-01T01:00:00.500+0100".into()),
            ..Default::default()
        };
        let body: Value = serde_json::from_str(&draft.payload("held").unwrap()).unwrap();
        assert_eq!(body["occurred_at"], "2026-01-01T01:00:00.500+0100");
        let row = draft.wire("held");
        assert_eq!(row.occurred_at, "2026-01-01T00:00:00.500Z");
        assert_eq!(row.created_at, row.occurred_at);
        assert_eq!(row.updated_at, row.occurred_at);
    }

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
        // Witness for the two base64 cases.
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
            refusal: (verdict == Some(Verdict::Refused))
                .then(|| Refusal::read(reason.unwrap_or_default(), answer)),
            body: Value::Null,
            conflicted_copy_id: Some("sibling".into()),
            refusals: 0,
            queued_at: "2026-01-01T00:00:00Z".into(),
            answered_at: None,
        }
    }

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
        let held = Draft::from_payload(&keyed.payload("minted").unwrap()).unwrap();
        assert_eq!(held.source_id.as_deref(), Some("note.md"));
        assert_eq!(held.r#type, "core.note");
    }

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
            Some(Outcome::Refused(Refusal {
                reason: "type_not_permitted".into(),
                code: None,
                message: None,
                fields: Vec::new(),
                trashed: false,
                grant: None,
            }))
        );
        assert_eq!(
            row(Some(Verdict::Blocked), Some("awaiting_dependency"), None)
                .outcome()
                .unwrap(),
            Some(Outcome::Waiting),
            "a write held behind another read as a stop"
        );
        assert_eq!(
            row(Some(Verdict::Blocked), Some("key_spent"), None)
                .outcome()
                .unwrap(),
            Some(Outcome::Blocked {
                reason: BlockedReason::KeySpent,
                refusal: None,
            })
        );
        assert_eq!(
            row(Some(Verdict::Dead), None, None).outcome().unwrap(),
            Some(Outcome::Dead)
        );
        assert_eq!(
            row(Some(Verdict::Accepted), None, Some(resolution))
                .outcome()
                .unwrap(),
            Some(Outcome::Accepted)
        );
        assert!(
            row(Some(Verdict::Blocked), Some("no_such_reason"), None)
                .outcome()
                .is_err()
        );
    }

    #[test]
    fn a_refusal_reads_its_code_message_fields_bin_and_grant_from_the_envelope() {
        let envelope = |details: Value| {
            serde_json::json!({
                "error": { "code": "invalid_properties", "message": "Invalid properties", "details": details }
            })
            .to_string()
        };
        let read = Refusal::read(
            "invalid_properties",
            Some(&envelope(serde_json::json!({
                "errors": [{ "field": "title", "message": "Too long" }, { "message": "no field" }],
                "grant": { "kind": "edge_type", "name": "references", "level": "write" },
                "trashed": true,
            }))),
        );
        assert_eq!(read.code.as_deref(), Some("invalid_properties"));
        assert_eq!(read.message.as_deref(), Some("Invalid properties"));
        assert_eq!(
            read.fields,
            vec![FieldRefusal {
                field: "title".into(),
                message: "Too long".into()
            }]
        );
        assert!(read.trashed);
        assert_eq!(
            read.grant,
            Some(MissingGrant {
                kind: GrantKind::EdgeType,
                name: "references".into(),
                level: GrantLevel::Write,
            })
        );

        // A grant naming a kind or a level outside the sets reads as none,
        // and `trashed` only as the boolean.
        let odd = Refusal::read(
            "forbidden",
            Some(&envelope(serde_json::json!({
                "grant": { "kind": "folder", "name": "x", "level": "write" },
                "trashed": "yes",
            }))),
        );
        assert_eq!(odd.grant, None);
        assert!(!odd.trashed);

        let acknowledged = Refusal::read(
            "trashed",
            Some(r#"{"acknowledged":true,"item":{"id":"i","state":"trashed"}}"#),
        );
        assert!(acknowledged.trashed);
        assert_eq!(acknowledged.code, None);

        let unsent = Refusal::read("the create_item it waits for was refused", None);
        assert_eq!(unsent.reason, "the create_item it waits for was refused");
        assert!(unsent.fields.is_empty() && !unsent.trashed && unsent.grant.is_none());
    }
}
