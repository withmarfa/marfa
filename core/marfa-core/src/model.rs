use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::wire::WireItem;
pub use marfa_rules::query::{SortDirection, SortField};

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

/// The tiers a slice holds. An item is in exactly one `Tier`; a slice may
/// hold both, so a row moved between them stays in the copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SliceTier {
    Library,
    Feed,
    All,
}

impl SliceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            SliceTier::Library => "library",
            SliceTier::Feed => "feed",
            SliceTier::All => "all",
        }
    }

    /// A row with no tier is taken by no slice.
    pub fn takes(self, row: Option<Tier>) -> bool {
        match (self, row) {
            (_, None) => false,
            (SliceTier::All, Some(_)) => true,
            (one, Some(tier)) => one == SliceTier::from(tier),
        }
    }

    /// The tier a create naming none is sent at. A slice of both sends
    /// `library`, the tier the server gives a row nothing names one for
    /// (`items/tier-new`), since the create has to name one for the copy to
    /// show it where the server will put it.
    pub fn create_tier(self) -> Tier {
        match self {
            SliceTier::Library | SliceTier::All => Tier::Library,
            SliceTier::Feed => Tier::Feed,
        }
    }
}

impl From<Tier> for SliceTier {
    fn from(tier: Tier) -> Self {
        match tier {
            Tier::Library => SliceTier::Library,
            Tier::Feed => SliceTier::Feed,
        }
    }
}

impl FromStr for SliceTier {
    type Err = CoreError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "library" => Ok(SliceTier::Library),
            "feed" => Ok(SliceTier::Feed),
            "all" => Ok(SliceTier::All),
            other => Err(CoreError::Invalid(format!(
                "a slice's tier must be library, feed or all, not {other:?}"
            ))),
        }
    }
}

impl fmt::Display for SliceTier {
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
    /// Where the item was captured, as its writer set it. Each is absent
    /// where the writer set none.
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    /// When the item went to the bin, or a `system.*` item was revoked; absent
    /// outside that state, and for a row an archive restored to the bin
    /// without the time.
    pub trashed_at: Option<String>,
    /// Whether a connector holds the item read only, as the server last
    /// answered it. Advice for showing the item: a write to it is taken and
    /// sent as any other is (`items/read-only-writable`). False for a row the
    /// server has not answered, and in a row kept before the copy held this.
    #[serde(default)]
    pub read_only: bool,
    pub tags: Vec<String>,
}

impl Item {
    /// A row as the server answers it, with the tags its metadata carries.
    pub(crate) fn from_wire(item: WireItem, tags: Vec<String>) -> Result<Item, CoreError> {
        Ok(Item {
            state: item.state.parse()?,
            tier: Tier::parse_wire(item.tier.as_deref())?,
            id: item.id,
            r#type: item.r#type,
            properties: item.properties,
            version: item.version,
            schema_version: item.schema_version,
            source: item.source,
            source_id: item.source_id,
            occurred_at: item.occurred_at,
            created_at: item.created_at,
            updated_at: item.updated_at,
            capture_latitude: item.capture_latitude,
            capture_longitude: item.capture_longitude,
            trashed_at: item.trashed_at,
            read_only: item.read_only,
            tags,
        })
    }

    /// Moves the item to `state`, made at `at`, as the server records it: a
    /// move into the bin takes `at` as `trashed_at`, a move out of it clears
    /// it, and a row already in the bin keeps the time it holds.
    pub(crate) fn move_to(&mut self, state: ItemState, at: &str) {
        if state == ItemState::Trashed {
            if self.state != ItemState::Trashed {
                self.trashed_at = Some(at.to_string());
            }
        } else if self.state == ItemState::Trashed {
            self.trashed_at = None;
        }
        self.state = state;
    }

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
            capture_latitude: self.capture_latitude,
            capture_longitude: self.capture_longitude,
            trashed_at: self.trashed_at.clone(),
            read_only: self.read_only,
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
    /// Why the item has no properties, where a read that keeps such rows
    /// found its stored properties unreadable. Never set by a read that
    /// refuses them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable_properties: Option<String>,
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

/// Leaving `states` unset answers the active state, as the server does;
/// `all_states` lifts that.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListFilters {
    /// Only the rows of these types, each with its subtree, as the server's
    /// `type` list reads them. `None` narrows nothing; an empty list, a blank
    /// entry or more than ten entries is refused `validation`.
    pub types: Option<Vec<String>>,
    /// Only the rows in these states, as the server's `state` list reads
    /// them. `None` is the active state unless `all_states` is set; an empty
    /// list, or a list beside `all_states`, is refused `validation`.
    pub states: Option<Vec<ItemState>>,
    pub all_states: bool,
    pub tier: Option<Tier>,
    /// Only the rows stamped with this source.
    pub source: Option<String>,
    pub tags: Vec<String>,
    /// Both ends of the own-time range are exclusive.
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    /// Only the rows changed at or after this time, inclusive, so a caller
    /// resuming from the latest `updated_at` it holds misses none that share
    /// the instant. It orders the list by `updated_at`, then id, ascending,
    /// and a list that names another sort or direction is refused.
    pub updated_after: Option<String>,
    /// Only the rows changed before this time, exclusive. It leaves the order
    /// as it is.
    pub updated_before: Option<String>,
    /// A `backref` condition is refused `Invalid` unless the copy holds its
    /// edge type whole: otherwise it lacks the edges drawn to its items from
    /// outside the slice.
    pub filter: Option<String>,
    /// An item id: that item and every item it reaches along `parent-of`
    /// edges the copy holds, at any depth.
    pub beneath: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchFilters {
    /// Only the rows of these types, each with its subtree, as the server's
    /// `type` list reads them. `None` narrows nothing; an empty list, a blank
    /// entry or more than ten entries is refused `validation`.
    pub types: Option<Vec<String>>,
    /// Only the rows in these states, as the server's `state` list reads
    /// them. `None` is the active state unless `all_states` is set; an empty
    /// list, or a list beside `all_states`, is refused `validation`.
    pub states: Option<Vec<ItemState>>,
    pub all_states: bool,
    pub tier: Option<Tier>,
    pub tags: Vec<String>,
    /// Both ends of the own-time range are exclusive.
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    pub filter: Option<String>,
    pub beneath: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

impl Sort {
    /// The order a list naming `updated_after` answers in, and the only one
    /// it takes.
    pub(crate) const RESUMED: Sort = Sort {
        field: SortField::UpdatedAt,
        direction: SortDirection::Ascending,
    };

    /// The order of a list of the bin alone that names no field.
    pub(crate) const BINNED: Sort = Sort {
        field: SortField::TrashedAt,
        direction: SortDirection::Descending,
    };

    /// A list's order from the halves a caller named, as the server reads
    /// `sort` and `direction`: a half left out is the half of the order
    /// `filters` take when they name none, so only a half naming another is
    /// refused beside `updated_after`. Nothing named is `None`, the list's own.
    pub fn named(
        field: Option<SortField>,
        direction: Option<SortDirection>,
        filters: &ListFilters,
    ) -> Option<Sort> {
        if field.is_none() && direction.is_none() {
            return None;
        }
        let fallback = Sort::unnamed(filters);
        Some(Sort {
            field: field.unwrap_or(fallback.field),
            direction: direction.unwrap_or(fallback.direction),
        })
    }

    /// The order a list answers in when it names none: by `updated_at`,
    /// ascending, beside `updated_after`; when each row went to the bin,
    /// newest first, for the bin alone; and otherwise the default.
    pub(crate) fn unnamed(filters: &ListFilters) -> Sort {
        if filters.updated_after.is_some() {
            Sort::RESUMED
        } else if !filters.all_states
            && filters.states.as_deref() == Some(&[ItemState::Trashed][..])
        {
            Sort::BINNED
        } else {
            Sort::default()
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
    pub tier: SliceTier,
    pub edge_types: Vec<String>,
    /// The slice's narrowing past its types and tier; `None` holds every row
    /// of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<crate::slice::SliceQuery>,
    pub items: u64,
    pub edges: u64,
    /// The listing pages this call read, those of a walk it then started
    /// again from the first page included.
    pub pages: u64,
    /// The listing pages the hydration read in all, those of the interrupted
    /// calls it resumed included.
    pub pages_total: u64,
    /// Whether this call carried on from the page an interrupted hydration
    /// of the same slice had reached.
    pub resumed: bool,
    /// Why an interrupted hydration was not resumed, and the copy was filled
    /// again from the first page; `None` where it was resumed or there was
    /// nothing to resume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted: Option<HydrateRestart>,
    /// Whether the copy was filled again over the rows it held, which it
    /// answered marked stale meanwhile, rather than cleared first: so it is
    /// filled when the event log let its cursor go and the instance, the reach
    /// and the slice are those it was built under.
    pub in_place: bool,
    pub cursor: String,
    /// Types the app declared that the instance did not hold and now does.
    pub registered_types: Vec<String>,
    /// Declared types the instance did not hold and would not take. Writes to
    /// them wait for the server's verdict, which is a refusal until a key
    /// that may registers them.
    pub unregistered_types: Vec<UnregisteredType>,
    /// Declared `app.*` types the instance held in another definition and now
    /// holds as declared.
    pub replaced_types: Vec<String>,
    /// Declared `app.*` types the instance holds in another definition and
    /// would not replace, which stay as the server holds them. A write to one
    /// is judged by that definition.
    pub unreplaced_types: Vec<UnregisteredType>,
}

/// Why a hydration began again from the first page rather than carry on from
/// where an interrupted one had reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HydrateRestart {
    /// The server at the address is another instance.
    InstanceChanged,
    /// The credential reads another set of rows than the one the pages
    /// already held were read under.
    ReachChanged,
    /// The hydration declares other types, another tier or other edge types.
    SliceChanged,
    /// The server's catalog of item types or edge types changed.
    CatalogChanged,
    /// The event log no longer holds the head the interrupted hydration
    /// started from, so the writes made since cannot be replayed.
    HeadAgedOut,
    /// The event log ends behind the head the interrupted hydration started
    /// from, as a server restored from an earlier point does.
    HeadPastLog,
    /// The listing refused the page cursor the interrupted hydration kept.
    CursorRefused,
}

impl HydrateRestart {
    pub fn as_str(self) -> &'static str {
        match self {
            HydrateRestart::InstanceChanged => "instance_changed",
            HydrateRestart::ReachChanged => "reach_changed",
            HydrateRestart::SliceChanged => "slice_changed",
            HydrateRestart::CatalogChanged => "catalog_changed",
            HydrateRestart::HeadAgedOut => "head_aged_out",
            HydrateRestart::HeadPastLog => "head_past_log",
            HydrateRestart::CursorRefused => "cursor_refused",
        }
    }

    /// Why, in words a person reads.
    pub fn says(self) -> &'static str {
        match self {
            HydrateRestart::InstanceChanged => "another instance answers at the server's address",
            HydrateRestart::ReachChanged => "the credential now reads other rows",
            HydrateRestart::SliceChanged => {
                "this hydration declares other types, another tier or other edge types"
            }
            HydrateRestart::CatalogChanged => "the server's catalog of types changed",
            HydrateRestart::HeadAgedOut => {
                "the server's event log no longer holds the point the interrupted hydration started from"
            }
            HydrateRestart::HeadPastLog => {
                "the server's event log ends before the point the interrupted hydration started from"
            }
            HydrateRestart::CursorRefused => {
                "the server refused the page cursor the interrupted hydration kept"
            }
        }
    }
}

/// A declared type the instance refused to register or to replace, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnregisteredType {
    pub id: String,
    /// The server's code for the refusal.
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatchUpReport {
    /// Events, never the rows a read of `read_only` moved.
    pub applied: u64,
    pub skipped: u64,
    /// Rows a read of `read_only` changed, which no event brought.
    pub read_only_held: u64,
    pub cursor: String,
    /// The catch-up replaced the catalog the copy holds with one that
    /// differs from it.
    pub catalog_changed: bool,
    /// The fill of the tables the copy holds that were not whole.
    pub tables: crate::tables::FillReport,
}

/// A catch-up that failed. A catch-up commits the catalog it reads before it
/// applies an event, and keeps it when it then fails.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{error}")]
pub struct CatchUpFailed {
    pub error: CoreError,
    /// The catch-up had replaced the catalog the copy holds with one that
    /// differs from it before it failed.
    pub catalog_changed: bool,
}

impl From<CoreError> for CatchUpFailed {
    fn from(error: CoreError) -> Self {
        CatchUpFailed {
            error,
            catalog_changed: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hydration {
    Never,
    InProgress,
    Complete,
    /// A catch-up or a held stream learned that the server's log no longer
    /// continues from the kept cursor in a way the copy cannot be filled
    /// again over (`Stale`), or any call that reads the root (a catch-up, a
    /// held stream, a drain, a pin or a folder's settings edit) found another
    /// instance at the origin. Set only on that answer. Local reads and
    /// writes are refused, where `Never` answers them.
    Expired,
    /// A catch-up or a held stream learned that the event log let the kept
    /// cursor go. Set only on that answer: a store whose cursor aged out and
    /// has not asked since still reports `Complete`. Local reads answer what
    /// the copy holds marked `stale`, and writes but edge writes are queued,
    /// from then until a hydration has filled it again in place, through that
    /// hydration and an interrupted one.
    Stale,
}

/// Whether a local list or search was read from a whole copy; from one a
/// hydration has started and not completed, which holds only the rows that
/// have arrived; or from one whose cursor the event log let go, which holds
/// the rows it held then, some since changed or gone on the server, until a
/// hydration has filled it again in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Complete,
    Partial,
    Stale,
}

/// The rows a local list or search answers, and whether the copy they were
/// read from is whole.
#[derive(Debug, Clone, PartialEq)]
pub struct Rows<T> {
    pub rows: Vec<T>,
    pub completeness: Completeness,
}

impl<T> Rows<T> {
    pub fn map<U>(self, f: impl FnMut(T) -> U) -> Rows<U> {
        Rows {
            rows: self.rows.into_iter().map(f).collect(),
            completeness: self.completeness,
        }
    }
}

impl Hydration {
    pub fn as_str(self) -> &'static str {
        match self {
            Hydration::Never => "never",
            Hydration::InProgress => "in_progress",
            Hydration::Complete => "complete",
            Hydration::Expired => "expired",
            Hydration::Stale => "stale",
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
    /// When the item's content happened, in any form the server reads as a
    /// time.
    pub occurred_at: Option<String>,
    /// Gives the item no time of its own again, so its own time is its
    /// creation time as at first. The server holds no empty `occurred_at`,
    /// so this sends the row's `created_at`; while the row's create is
    /// unsent, it sends no time in that create or any edit behind it, and the
    /// server takes its own creation time. Refused beside `occurred_at`.
    pub clear_occurred_at: bool,
    /// A property left out is cleared; otherwise they merge over the row's.
    pub replace_properties: bool,
    /// Properties removed from the item; every other stays as the row holds
    /// it, those this copy cannot read included. Refused where a name is
    /// also in `properties`.
    pub clear_properties: Vec<String>,
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
        if !self.clear_properties.is_empty() {
            body.insert(
                "clear_properties".into(),
                Value::from(self.clear_properties.clone()),
            );
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
        if let Some(occurred_at) = &self.occurred_at {
            body.insert("occurred_at".into(), Value::String(occurred_at.clone()));
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
    /// The state the item starts in, one its type's lifecycle can reach.
    /// Unset, the server gives `active`.
    pub state: Option<ItemState>,
    pub source: Option<String>,
    pub source_id: Option<String>,
    pub occurred_at: Option<String>,
    /// Where the item was captured. The server stores each number as sent.
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    /// Edge type to the ids of the items the new item points to. They go in
    /// the create's own request, so the server makes the item and every edge
    /// or none.
    pub edges: BTreeMap<String, Vec<String>>,
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
        if let Some(state) = self.state {
            body.insert("state".into(), Value::String(state.as_str().into()));
        }
        for (key, value) in [
            ("capture_latitude", self.capture_latitude),
            ("capture_longitude", self.capture_longitude),
        ] {
            if let Some(value) = value {
                body.insert(key.into(), serde_json::to_value(value)?);
            }
        }
        let edges = self.named_edges();
        if !edges.is_empty() {
            body.insert("edges".into(), serde_json::to_value(edges)?);
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
            state: text("state").map(|state| state.parse()).transpose()?,
            source: text("source"),
            source_id: text("source_id"),
            occurred_at: text("occurred_at"),
            capture_latitude: body.get("capture_latitude").and_then(Value::as_f64),
            capture_longitude: body.get("capture_longitude").and_then(Value::as_f64),
            edges: body
                .get("edges")
                .map(|edges| serde_json::from_value(edges.clone()))
                .transpose()?
                .unwrap_or_default(),
            ..Default::default()
        };
        Ok(draft)
    }

    fn named_edges(&self) -> BTreeMap<&String, &Vec<String>> {
        self.edges
            .iter()
            .filter(|(_, targets)| !targets.is_empty())
            .collect()
    }

    /// Each (edge type, target) pair the create names; a type with an empty
    /// list makes no edge.
    pub(crate) fn edge_pairs(&self) -> Vec<(String, String)> {
        self.edges
            .iter()
            .flat_map(|(edge_type, targets)| {
                targets
                    .iter()
                    .map(move |target| (edge_type.clone(), target.clone()))
            })
            .collect()
    }

    /// The edges the copy shows from a create that waits, under ids of the
    /// device's own, since the server gives the ones it makes ids of its own.
    /// The same create always shows the same ids, so a copy laid over its
    /// queue again finds them.
    pub(crate) fn projected_edges(&self, id: &str, at: &str) -> Vec<crate::wire::WireEdge> {
        self.edge_pairs()
            .into_iter()
            .map(|(edge_type, target)| crate::wire::WireEdge {
                id: projected_edge_id(id, &edge_type, &target),
                source_id: id.to_string(),
                target_id: target,
                edge_type,
                properties: Map::new(),
                version: 0,
                created_at: at.to_string(),
                updated_at: at.to_string(),
            })
            .collect()
    }

    /// Version 0: the server's versions start at 1, so a local row is never
    /// mistaken for one it has seen, and the first event for this id
    /// replaces it.
    pub(crate) fn wire(&self, id: &str) -> WireItem {
        let at = self
            .occurred_at
            .as_deref()
            .map(marfa_rules::time::projected)
            .unwrap_or_else(crate::store::now_iso);
        WireItem {
            id: id.to_string(),
            r#type: self.r#type.clone(),
            state: self.state.unwrap_or(ItemState::Active).as_str().into(),
            tier: Some(self.tier.unwrap_or(Tier::Library).as_str().into()),
            version: 0,
            schema_version: 1,
            source: self.source.clone().unwrap_or_else(|| "device".into()),
            source_id: self.source_id.clone(),
            occurred_at: at.clone(),
            created_at: at.clone(),
            updated_at: at,
            properties: self.properties.clone(),
            capture_latitude: self.capture_latitude,
            capture_longitude: self.capture_longitude,
            trashed_at: (self.state == Some(ItemState::Trashed)).then(crate::store::now_iso),
            read_only: false,
            edges: None,
        }
    }
}

/// A UUID made from the three names alone.
pub(crate) fn projected_edge_id(source: &str, edge_type: &str, target: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for part in [source, edge_type, target] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    let digest = hash.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
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
    AddTag,
    RemoveTag,
    WriteExtension,
    DeleteExtension,
    UploadBlob,
    WriteRows,
    UndoRows,
}

impl WriteKind {
    pub const ALL: [WriteKind; 16] = [
        WriteKind::CreateItem,
        WriteKind::UpdateItem,
        WriteKind::DeleteItem,
        WriteKind::RestoreItem,
        WriteKind::TransitionItem,
        WriteKind::CreateEdge,
        WriteKind::UpdateEdge,
        WriteKind::DeleteEdge,
        WriteKind::ReplaceMetadata,
        WriteKind::AddTag,
        WriteKind::RemoveTag,
        WriteKind::WriteExtension,
        WriteKind::DeleteExtension,
        WriteKind::UploadBlob,
        WriteKind::WriteRows,
        WriteKind::UndoRows,
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
                | WriteKind::WriteExtension
                | WriteKind::CreateEdge
                | WriteKind::UpdateEdge
                | WriteKind::WriteRows
        )
    }

    pub fn rows(self) -> bool {
        matches!(self, WriteKind::WriteRows | WriteKind::UndoRows)
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
            | WriteKind::AddTag
            | WriteKind::RemoveTag
            | WriteKind::WriteExtension
            | WriteKind::DeleteExtension => Some(Subject::Item),
            WriteKind::CreateEdge | WriteKind::UpdateEdge | WriteKind::DeleteEdge => {
                Some(Subject::Edge)
            }
            WriteKind::UploadBlob | WriteKind::WriteRows | WriteKind::UndoRows => None,
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
            WriteKind::AddTag => "add_tag",
            WriteKind::RemoveTag => "remove_tag",
            WriteKind::WriteExtension => "write_extension",
            WriteKind::DeleteExtension => "delete_extension",
            WriteKind::UploadBlob => "upload_blob",
            WriteKind::WriteRows => "write_rows",
            WriteKind::UndoRows => "undo_rows",
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
    /// An item write has the sibling that holds what it replaced; a row write
    /// has none, and names the rows and columns it replaced unseen.
    Conflicted {
        sibling_id: Option<String>,
        fields: Vec<String>,
        conflicts: Vec<RowConflict>,
    },
    Refused(Refusal),
    Blocked {
        reason: BlockedReason,
        refusal: Option<Refusal>,
    },
    /// Held behind a write that has no answer yet. The queue stores it as
    /// `blocked` `AWAITING_DEPENDENCY`; nothing outside the queue has to
    /// change for it to go, so it is not presented as a stop.
    Waiting,
    Dead,
}

impl Outcome {
    /// A blocked row whose reason is neither a `BlockedReason` nor
    /// `AWAITING_DEPENDENCY` is an error.
    pub fn of(
        verdict: Option<Verdict>,
        reason: Option<&str>,
        sibling_id: Option<&str>,
        fields: Vec<String>,
        conflicts: &[RowConflict],
        refusal: Option<&Refusal>,
    ) -> Result<Option<Outcome>, CoreError> {
        Ok(Some(match verdict {
            None => return Ok(None),
            Some(Verdict::Accepted) => Outcome::Accepted,
            Some(Verdict::Merged) => Outcome::Merged { fields },
            Some(Verdict::Conflicted) => Outcome::Conflicted {
                sibling_id: sibling_id.map(str::to_string),
                fields,
                conflicts: conflicts.to_vec(),
            },
            Some(Verdict::Refused) => Outcome::Refused(
                refusal
                    .cloned()
                    .unwrap_or_else(|| Refusal::read(reason.unwrap_or_default(), None)),
            ),
            Some(Verdict::Blocked) if reason == Some(AWAITING_DEPENDENCY) => Outcome::Waiting,
            Some(Verdict::Blocked) => Outcome::Blocked {
                reason: reason.unwrap_or_default().parse()?,
                refusal: refusal.cloned(),
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
    /// An unsent write exceeded the server's request limit.
    pub request_limit: Option<RequestLimit>,
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
            request_limit: body
                .get("request_limit")
                .and_then(|limit| serde_json::from_value(limit.clone()).ok()),
        }
    }
}

/// Why a write has stopped until something outside the queue changes: what
/// a `blocked` verdict carries and what a release by reason names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    CredentialRefused,
    KeySpent,
    AncestorUnavailable,
    ConflictUnresolved,
    FailingAlone,
    /// Queued against an instance other than the one the copy was built from
    /// since: sent only once a caller releases it.
    InstanceChanged,
}

/// The reason the queue stores under `blocked` for a write held behind
/// another that has no answer yet (`queue-and-verdicts/held-reason`). It is
/// no `BlockedReason`: only the answer to the write it waits for releases it
/// (`queue-and-verdicts/held-released-same-pass`), and a binding shows it as
/// waiting (`queue-and-verdicts/binding-shows-waiting`).
pub(crate) const AWAITING_DEPENDENCY: &str = "awaiting_dependency";

/// What a device calls a write it will not send because its body is larger
/// than the server said it takes. The device's decision, never the server's
/// answer, so it is no `request_too_large`.
pub(crate) const OVER_REQUEST_LIMIT: &str = "over_request_limit";

/// How the reason for such a write starts, ahead of `over_request_limit`'s words.
pub(crate) const OVER_REQUEST_LIMIT_WRITE: &str = "This write is ";

/// An unsent write's request size and the server's limit, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestLimit {
    pub size: u64,
    pub limit: u64,
}

impl RequestLimit {
    /// An unknown limit cannot justify refusing a write.
    pub(crate) fn over(size: usize, limit: Option<usize>) -> Option<RequestLimit> {
        let limit = limit.filter(|limit| size > *limit)?;
        Some(RequestLimit {
            size: size as u64,
            limit: limit as u64,
        })
    }

    /// The words for a person, after `OVER_REQUEST_LIMIT_WRITE`.
    pub(crate) fn words(self) -> String {
        format!(
            "{} bytes as a request, and this server takes {}. Make it smaller to send it.",
            grouped(self.size as usize),
            grouped(self.limit as usize)
        )
    }

    /// What the queue stores as the answer to a write refused for its size.
    pub(crate) fn stored(self) -> String {
        serde_json::json!({ "request_limit": self }).to_string()
    }
}

fn grouped(number: usize) -> String {
    let digits = number.to_string();
    let mut grouped = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

impl BlockedReason {
    pub const ALL: [BlockedReason; 6] = [
        BlockedReason::CredentialRefused,
        BlockedReason::KeySpent,
        BlockedReason::AncestorUnavailable,
        BlockedReason::ConflictUnresolved,
        BlockedReason::FailingAlone,
        BlockedReason::InstanceChanged,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            BlockedReason::CredentialRefused => "credential_refused",
            BlockedReason::KeySpent => "key_spent",
            BlockedReason::AncestorUnavailable => "ancestor_unavailable",
            BlockedReason::ConflictUnresolved => "conflict_unresolved",
            BlockedReason::FailingAlone => "failing_alone",
            BlockedReason::InstanceChanged => "instance_changed",
        }
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
                    "{text:?} is not one of the six blocked reasons a caller can release by: {}",
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

/// What a write met that was no answer to it: the HTTP status, or none where
/// nothing answered, and the start of the body when it was text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastFailure {
    pub status: Option<u16>,
    pub text: Option<String>,
}

impl LastFailure {
    /// The longest text kept, in characters.
    pub const TEXT_LIMIT: usize = 200;

    /// Keeps the start of a body that is text, with its whitespace collapsed,
    /// and nothing of one that is not.
    pub fn of(status: Option<u16>, body: &[u8]) -> LastFailure {
        // Only the start is read: a cut through the middle of a character at
        // the end is not a body that is not text.
        let head = &body[..body.len().min(Self::TEXT_LIMIT * 8)];
        let text = match std::str::from_utf8(head) {
            Ok(text) => Some(text),
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&head[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        };
        let text = text
            .filter(|text| !text.chars().any(|c| c.is_control() && !c.is_whitespace()))
            .map(|text| {
                let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
                let mut kept: String = collapsed.chars().take(Self::TEXT_LIMIT).collect();
                if collapsed.chars().count() > Self::TEXT_LIMIT || head.len() < body.len() {
                    kept.push_str("...");
                }
                kept
            })
            .filter(|text| !text.is_empty());
        LastFailure { status, text }
    }

    /// One line for a person: `HTTP 413: <start of body>` or `no answer`.
    pub fn describe(&self) -> String {
        match (self.status, self.text.as_deref()) {
            (Some(status), Some(text)) => format!("HTTP {status}: {text}"),
            (Some(status), None) => format!("HTTP {status}"),
            (None, _) => "no answer".to_string(),
        }
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
    /// The queue id of the earlier write to the same item or edge. Any answer
    /// to it releases this one; unlike `depends_on`, its refusal refuses
    /// nothing.
    pub follows: Option<String>,
    pub verdict: Option<Verdict>,
    /// A blocked reason under `blocked`; under `refused`, the server's code
    /// verbatim or a sentence naming the refused write this one was held behind.
    pub reason: Option<String>,
    /// The server's answer, kept whole.
    pub answer: Option<String>,
    /// The drains in a row in which this write met an environmental failure.
    pub environmental_streak: i64,
    /// The last answer the server gave the write that was no answer to it, a
    /// `429` included, which adds nothing to the streak. A failure that was not
    /// the write's own leaves it as it was. Kept until the write is answered,
    /// and shown for a write set aside as `failing_alone`.
    pub last_failure: Option<LastFailure>,
    /// The refusal for a terminal answer or a credential-blocked write.
    pub refusal: Option<Refusal>,
    /// What the write sends, or sent: kept so a refused write's content can
    /// be read back from the queue until it is discarded.
    pub body: Value,
    pub conflicted_copy_id: Option<String>,
    pub refusals: i64,
    /// The table a row write or an undo names.
    pub table: Option<String>,
    /// The row write whose batch this one was sent in, where it was not the first.
    pub batched_with: Option<String>,
    /// What a `conflicted` row write replaced unseen.
    pub conflicts: Vec<RowConflict>,
    pub queued_at: String,
    pub answered_at: Option<String>,
}

/// A column of a row whose value a row write replaced without the copy having shown it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowConflict {
    pub row: String,
    pub column: String,
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
            &self.conflicts,
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
        self.verdict == Some(Verdict::Dead)
            || matches!(
                self.blocked_reason(),
                Some(
                    BlockedReason::AncestorUnavailable
                        | BlockedReason::ConflictUnresolved
                        | BlockedReason::FailingAlone
                        | BlockedReason::InstanceChanged
                )
            )
    }

    /// A held write uses its blocker's exits.
    pub fn exits(&self) -> &'static str {
        if self.withdrawable() {
            "withdraw or release"
        } else if self.blocked_reason().is_some() {
            "release"
        } else {
            "drain"
        }
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

/// Finds, for writes of one queue read, the write each ultimately waits on.
/// The queue is indexed once and each chain is walked once, so any number of
/// lookups costs about one pass over the queue.
pub struct Blockers<'a> {
    by_id: HashMap<&'a str, &'a QueuedWrite>,
    ends: HashMap<&'a str, &'a QueuedWrite>,
}

impl<'a> Blockers<'a> {
    pub fn new(queue: &'a [QueuedWrite]) -> Self {
        let mut by_id = HashMap::with_capacity(queue.len());
        for write in queue {
            by_id.entry(write.id.as_str()).or_insert(write);
        }
        Self {
            by_id,
            ends: HashMap::new(),
        }
    }

    fn holding(&self, write: &QueuedWrite) -> Option<&'a QueuedWrite> {
        write
            .follows
            .iter()
            .chain(&write.depends_on)
            .filter_map(|ahead| self.by_id.get(ahead.as_str()).copied())
            .find(|ahead| matches!(ahead.verdict, None | Some(Verdict::Blocked)))
    }

    /// The last unanswered write in the chain `write` waits behind, or `None`
    /// where it waits on nothing. Where the chain loops, the last write before
    /// it comes back round.
    pub fn of(&mut self, write: &QueuedWrite) -> Option<&'a QueuedWrite> {
        let mut at = self.holding(write)?;
        let mut seen: HashMap<&str, usize> = HashMap::from([(write.id.as_str(), usize::MAX)]);
        let mut path: Vec<&'a QueuedWrite> = Vec::new();
        let (end, settled) = loop {
            if let Some(end) = self.ends.get(at.id.as_str()) {
                break (*end, path.len());
            }
            if let Some(&index) = seen.get(at.id.as_str()) {
                let end = path.last().copied().unwrap_or(at);
                break (end, if index == usize::MAX { 0 } else { index });
            }
            seen.insert(at.id.as_str(), path.len());
            path.push(at);
            match self.holding(at) {
                Some(next) => at = next,
                None => break (at, path.len()),
            }
        };
        for passed in &path[..settled] {
            self.ends.insert(passed.id.as_str(), end);
        }
        Some(end)
    }
}

/// A page of the server's bin, newest binned first, read online and never
/// held in the copy.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BinPage {
    pub items: Vec<(Item, Shown)>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub server_origin: Option<String>,
    /// The instance the copy was hydrated from, as the server's root named
    /// it; `None` before a hydration that read one.
    pub instance_id: Option<String>,
    pub slice_types: Vec<String>,
    pub slice_tier: Option<SliceTier>,
    pub slice_edge_types: Vec<String>,
    /// The slice's narrowing past its types and tier (`device/report-fields`);
    /// `None` where the copy holds every row of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_query: Option<crate::slice::SliceQuery>,
    /// The rows held by id whatever the slice says of them.
    pub pinned: Vec<String>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: u64,
    /// While a hydration fills the copy, how many items its slice held on the
    /// server when it started; `None` where the server did not count them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_expected: Option<u64>,
    /// While a hydration fills the copy, how many rows its listings have
    /// brought: the figure to set against `items_expected`, which `items`
    /// is not, since `items` also counts pinned rows and queued creates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_listed: Option<u64>,
    pub edges: u64,
    /// Moves each time a refresh changes the catalog; `None` where the copy
    /// has never held one.
    pub catalog_version: Option<u64>,
    /// When the copy last finished a pull from the server without error, an
    /// RFC 3339 UTC timestamp from the device's clock; `None` where it has not
    /// since the store was made or a hydration last cleared it.
    pub synced_at: Option<String>,
    /// The file cache's budget and what it holds.
    pub file_cache: crate::file_cache::FileCache,
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

/// In the order they go out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attached {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
    pub edge: QueuedWrite,
    /// `![[title]]`, which names this file alone among the item's
    /// attachments; `None` where its title cannot name it alone in an embed.
    pub embed: Option<String>,
}

/// In the order they go out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Added {
    pub upload: QueuedWrite,
    pub item: QueuedWrite,
}

/// One edge write of a batch (`Core::queue_edge_ops`).
#[derive(Debug, Clone)]
pub enum EdgeOp {
    Create(EdgeDraft),
    Update { id: String, edit: EdgeEdit },
    Delete(String),
}

#[derive(Debug, Clone, Default)]
pub struct EdgeEdit {
    pub properties: Map<String, Value>,
    pub base_version: Option<i64>,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
}

impl EdgeEdit {
    /// Whether the edit names no property and no end to move to.
    pub(crate) fn is_empty(&self) -> bool {
        self.properties.is_empty() && self.source_id.is_none() && self.target_id.is_none()
    }

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

    use super::*;

    #[test]
    fn a_slice_of_both_tiers_takes_either_and_a_row_of_none_is_taken_by_no_slice() {
        for (slice, library, feed) in [
            (SliceTier::All, true, true),
            (SliceTier::Library, true, false),
            (SliceTier::Feed, false, true),
        ] {
            assert_eq!(slice.takes(Some(Tier::Library)), library, "{slice}");
            assert_eq!(slice.takes(Some(Tier::Feed)), feed, "{slice}");
            assert!(!slice.takes(None), "{slice}");
            assert_eq!(slice.as_str().parse::<SliceTier>().unwrap(), slice);
        }
        assert_eq!(SliceTier::All.create_tier(), Tier::Library);
        assert_eq!(SliceTier::Feed.create_tier(), Tier::Feed);
        assert!("both".parse::<SliceTier>().is_err());
        assert!("all".parse::<Tier>().is_err());
    }

    #[test]
    fn timestamp_projection_keeps_the_original_request() {
        let draft = Draft {
            r#type: "core.note".into(),
            occurred_at: Some("2026-01-01T01:00:00.500+01:00".into()),
            ..Default::default()
        };
        let body: Value = serde_json::from_str(&draft.payload("held").unwrap()).unwrap();
        assert_eq!(body["occurred_at"], "2026-01-01T01:00:00.500+01:00");
        let row = draft.wire("held");
        assert_eq!(row.occurred_at, "2026-01-01T00:00:00.500Z");
        assert_eq!(row.created_at, row.occurred_at);
        assert_eq!(row.updated_at, row.occurred_at);
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
            table: None,
            batched_with: None,
            conflicts: Vec::new(),
            environmental_streak: 0,
            last_failure: None,
            queued_at: "2026-01-01T00:00:00Z".into(),
            answered_at: None,
        }
    }

    fn waiting_on(id: &str, ahead: Option<&str>) -> QueuedWrite {
        let mut write = row(None, None, None);
        write.id = id.into();
        write.follows = ahead.map(str::to_string);
        write
    }

    #[test]
    fn a_write_waits_on_the_last_unanswered_write_of_a_chain_however_long() {
        let length = 20_000;
        let mut queue = vec![waiting_on("w0", None)];
        queue.extend(
            (1..length).map(|n| waiting_on(&format!("w{n}"), Some(&format!("w{}", n - 1)))),
        );
        queue.reverse();
        let mut blockers = Blockers::new(&queue);
        for write in &queue {
            let expected = (write.id != "w0").then_some("w0");
            assert_eq!(blockers.of(write).map(|end| end.id.as_str()), expected);
        }
    }

    #[test]
    fn a_write_waits_past_an_answered_write_only_to_one_still_open() {
        let mut answered = waiting_on("b", None);
        answered.verdict = Some(Verdict::Accepted);
        let queue = vec![
            waiting_on("a", Some("b")),
            answered,
            waiting_on("c", Some("a")),
        ];
        let mut blockers = Blockers::new(&queue);
        assert!(blockers.of(&queue[0]).is_none());
        assert_eq!(blockers.of(&queue[2]).map(|end| end.id.as_str()), Some("a"));
    }

    #[test]
    fn a_chain_that_loops_ends_at_a_write_other_than_the_one_asked_about() {
        let queue = vec![
            waiting_on("tail", Some("a")),
            waiting_on("a", Some("b")),
            waiting_on("b", Some("c")),
            waiting_on("c", Some("a")),
        ];
        let mut blockers = Blockers::new(&queue);
        for write in &queue {
            let end = blockers.of(write).expect("every write waits on another");
            assert_ne!(end.id, write.id, "{}", write.id);
            assert!(["a", "b", "c"].contains(&end.id.as_str()), "{}", write.id);
        }
    }

    #[test]
    fn a_last_failure_keeps_the_start_of_a_text_body_on_one_line() {
        let page =
            b"<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n</html>\r\n";
        let failure = LastFailure::of(Some(413), page);
        assert_eq!(failure.status, Some(413));
        assert_eq!(
            failure.text.as_deref(),
            Some("<html> <head><title>413 Request Entity Too Large</title></head> </html>")
        );
        assert_eq!(
            failure.describe(),
            "HTTP 413: <html> <head><title>413 Request Entity Too Large</title></head> </html>"
        );
    }

    #[test]
    fn a_last_failure_cuts_a_long_body_and_keeps_nothing_of_one_that_is_no_text() {
        let long = "word ".repeat(4000);
        let cut = LastFailure::of(Some(502), long.as_bytes()).text.unwrap();
        assert!(cut.ends_with("..."));
        assert_eq!(cut.chars().count(), LastFailure::TEXT_LIMIT + 3);

        // A cut through the last character of the part read is not a body
        // that is not text.
        let wide = "\u{e9}".repeat(LastFailure::TEXT_LIMIT * 8);
        assert!(LastFailure::of(Some(502), wide.as_bytes()).text.is_some());

        for body in [&b"\xff\xfe\x00 not text"[..], b"\x00\x01 page", b"  \r\n "] {
            assert_eq!(LastFailure::of(Some(500), body).text, None, "{body:?}");
        }
        // Witness: the same words without the control characters are kept.
        assert!(LastFailure::of(Some(500), b"page").text.is_some());
    }

    #[test]
    fn a_last_failure_with_no_status_reads_as_no_answer() {
        let failure = LastFailure::of(None, b"");
        assert_eq!(failure.describe(), "no answer");
        assert_eq!(
            LastFailure::of(Some(503), b"").describe(),
            "HTTP 503",
            "a status with no body was described as no answer"
        );
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
    fn a_write_held_behind_another_is_no_blocked_reason_a_caller_can_name() {
        assert!(
            AWAITING_DEPENDENCY.parse::<BlockedReason>().is_err(),
            "the reason a held write waits under reads as one a release can name"
        );
        assert!(
            !BlockedReason::ALL
                .map(BlockedReason::as_str)
                .contains(&AWAITING_DEPENDENCY)
        );
        // The witness: each reason that stops a write is one a caller names.
        for reason in BlockedReason::ALL {
            assert_eq!(reason.as_str().parse::<BlockedReason>().unwrap(), reason);
        }
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
                sibling_id: Some("sibling".into()),
                fields: vec!["title".into(), "body".into()],
                conflicts: Vec::new(),
            })
        );
        let mut rows = row(Some(Verdict::Conflicted), None, None);
        rows.conflicted_copy_id = None;
        rows.conflicts = vec![RowConflict {
            row: "r".into(),
            column: "c".into(),
        }];
        assert_eq!(
            rows.outcome().unwrap(),
            Some(Outcome::Conflicted {
                sibling_id: None,
                fields: Vec::new(),
                conflicts: rows.conflicts.clone(),
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
                request_limit: None,
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
