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
            updated_at: crate::store::now_iso(),
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
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Narrowing for a local search. The same state rule the list takes, and
/// the only axis a search narrows on: the rest of the listing grammar is
/// answered by a list, and a search that took half of it would advertise a
/// parity it does not have.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchFilters {
    pub state: Option<ItemState>,
    pub all_states: bool,
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
    /// moving it (`folders.md` 23). Sent under the item's id and the
    /// version it read, so a key another item holds is refused rather
    /// than taken. Absent leaves the key alone.
    pub source_id: Option<String>,
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
    pub(crate) fn payload(&self, id: &str) -> std::result::Result<String, CoreError> {
        let mut body = Map::new();
        body.insert("id".into(), Value::String(id.to_string()));
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

/// One queued write, as the queue reports it.
///
/// A verdict of `None` is a write the server has not answered: the six are
/// what an answer carries (`queue-and-verdicts.md` 7), and this is the
/// absence of one. It serializes as `null` rather than as a token, so a
/// reader has to handle the absence rather than matching a seventh string.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueuedWrite {
    pub id: String,
    pub kind: String,
    pub item_id: Option<String>,
    pub target_id: Option<String>,
    pub edge_id: Option<String>,
    pub namespace: Option<String>,
    pub tag: Option<String>,
    pub base_version: Option<i64>,
    pub idempotency_key: String,
    /// The queue rows this one waits for. Empty when nothing holds it; more
    /// than one when an edge waits on both of its endpoints.
    pub depends_on: Vec<String>,
    pub verdict: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub server_origin: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
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
