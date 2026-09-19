use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;

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
    pub device: Option<String>,
    /// When the item's content happened, as opposed to when the row was
    /// written. The server defaults it to `created_at`.
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
}

impl Item {
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
}

impl Hydration {
    pub fn as_str(self) -> &'static str {
        match self {
            Hydration::Never => "never",
            Hydration::InProgress => "in_progress",
            Hydration::Complete => "complete",
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
