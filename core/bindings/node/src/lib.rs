//! The Node-facing shape of `marfa_core`.

use std::sync::Arc;

use napi::bindgen_prelude::*;
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
    pub device: Option<String>,
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

/// Narrowing for a list. Leaving `state` unset excludes trashed rows, as the
/// server does; `includeTrashed` lifts that, and a named state wins.
#[napi(object)]
#[derive(Default)]
pub struct ListFilters {
    #[napi(js_name = "type")]
    pub type_: Option<String>,
    pub state: Option<ItemState>,
    pub include_trashed: Option<bool>,
    pub tier: Option<Tier>,
    pub tags: Option<Vec<String>>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
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
    pub items: i64,
    pub edges: i64,
    pub pages: i64,
    pub cursor: String,
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
    pub slice_types: Vec<String>,
    pub slice_tier: Option<Tier>,
    pub event_cursor: Option<String>,
    pub hydration: Hydration,
    pub items: i64,
    pub edges: i64,
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
        }
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
        device: item.device,
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
        include_trashed: filters.include_trashed.unwrap_or(false),
        tier: filters.tier.map(Into::into),
        tags: filters.tags.unwrap_or_default(),
        occurred_after: filters.occurred_after,
        occurred_before: filters.occurred_before,
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
    let (code, detail) = match &error {
        E::NotFound { .. } => ("not_found", error.to_string()),
        E::Unauthorized { .. } => ("unauthorized", error.to_string()),
        E::Forbidden { .. } => ("forbidden", error.to_string()),
        E::Validation { .. } => ("validation", error.to_string()),
        E::UnknownType { .. } => ("unknown_type", error.to_string()),
        E::RateLimited { .. } => ("rate_limited", error.to_string()),
        E::Server { .. } => ("server", error.to_string()),
        E::Network(message) => ("network", message.clone()),
        E::Decoding(message) => ("decoding", message.clone()),
        E::Store(message) => ("store", message.clone()),
        E::NoServer => ("no_server", error.to_string()),
        E::NoCursor => ("no_cursor", error.to_string()),
        E::HydrationIncomplete => ("hydration_incomplete", error.to_string()),
        E::CatchUpTooOld { .. } => ("catch_up_too_old", error.to_string()),
        E::StreamIncomplete { .. } => ("stream_incomplete", error.to_string()),
        E::WrongServer { .. } => ("wrong_server", error.to_string()),
        E::Invalid(message) => ("invalid", message.clone()),
    };
    Error::new(napi::Status::GenericFailure, format!("{code}: {detail}"))
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
}

#[napi]
impl Task for Hydrate {
    type Output = marfa_core::HydrateReport;
    type JsValue = HydrateReport;

    fn compute(&mut self) -> Result<Self::Output> {
        self.core.hydrate(&self.types, self.tier).map_err(failure)
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(HydrateReport {
            types: report.types,
            tier: report.tier.into(),
            items: count(report.items),
            edges: count(report.edges),
            pages: count(report.pages),
            cursor: report.cursor,
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

#[napi]
impl MarfaCore {
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
        AsyncTask::new(Hydrate {
            core: Arc::clone(&self.inner),
            types,
            tier: tier.into(),
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
    pub fn search(&self, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>> {
        let hits = self
            .inner
            .search(&query, limit.unwrap_or(20) as usize)
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
            slice_types: status.slice_types,
            slice_tier: status.slice_tier.map(Into::into),
            event_cursor: status.event_cursor,
            hydration: status.hydration.into(),
            items: count(status.items),
            edges: count(status.edges),
        })
    }
}
