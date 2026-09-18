//! The Node-facing shape of `marfa_core`: the same calls, hydrate and catch-up
//! off the event loop, properties as plain objects.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct Item {
    pub id: String,
    #[napi(js_name = "type")]
    pub type_: String,
    pub properties: serde_json::Value,
    pub state: String,
    pub tier: Option<String>,
    pub version: i64,
    pub schema_version: i64,
    pub source: String,
    pub source_id: Option<String>,
    pub device: Option<String>,
    pub timestamp: String,
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
    pub state: Option<String>,
    pub include_trashed: Option<bool>,
    pub tier: Option<String>,
    pub tags: Option<Vec<String>>,
    pub timestamp_after: Option<String>,
    pub timestamp_before: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[napi(object)]
pub struct Sort {
    /// created_at, updated_at or timestamp.
    pub field: String,
    /// asc or desc.
    pub direction: String,
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
    pub tier: String,
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
    pub slice_tier: Option<String>,
    pub event_cursor: Option<String>,
    /// never, in_progress or complete.
    pub hydration: String,
    pub items: i64,
    pub edges: i64,
}

fn item(item: marfa_core::Item) -> Item {
    Item {
        id: item.id,
        type_: item.r#type,
        properties: serde_json::Value::Object(item.properties),
        state: item.state.as_str().into(),
        tier: item.tier.map(|tier| tier.as_str().into()),
        version: item.version,
        schema_version: item.schema_version,
        source: item.source,
        source_id: item.source_id,
        device: item.device,
        timestamp: item.timestamp,
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

fn filters(filters: Option<ListFilters>) -> Result<marfa_core::ListFilters> {
    let filters = filters.unwrap_or_default();
    Ok(marfa_core::ListFilters {
        r#type: filters.type_,
        state: filters
            .state
            .map(|text| text.parse())
            .transpose()
            .map_err(failure)?,
        include_trashed: filters.include_trashed.unwrap_or(false),
        tier: filters
            .tier
            .map(|text| text.parse())
            .transpose()
            .map_err(failure)?,
        tags: filters.tags.unwrap_or_default(),
        timestamp_after: filters.timestamp_after,
        timestamp_before: filters.timestamp_before,
        limit: filters.limit,
        offset: filters.offset,
    })
}

fn sort(sort: Option<Sort>) -> Result<marfa_core::Sort> {
    match sort {
        None => Ok(marfa_core::Sort::default()),
        Some(sort) => Ok(marfa_core::Sort {
            field: sort.field.parse().map_err(failure)?,
            direction: sort.direction.parse().map_err(failure)?,
        }),
    }
}

/// A core error as a JS error whose `code` names the variant and whose
/// message carries the detail.
fn failure(error: marfa_core::CoreError) -> Error {
    use marfa_core::CoreError as E;
    let code = match &error {
        E::NotFound { .. } => "not_found",
        E::Unauthorized { .. } => "unauthorized",
        E::Forbidden { .. } => "forbidden",
        E::Validation { .. } => "validation",
        E::UnknownType { .. } => "unknown_type",
        E::RateLimited { .. } => "rate_limited",
        E::Server { .. } => "server",
        E::Network(_) => "network",
        E::Decoding(_) => "decoding",
        E::Store(_) => "store",
        E::NoServer => "no_server",
        E::NoCursor => "no_cursor",
        E::HydrationIncomplete => "hydration_incomplete",
        E::CatchUpTooOld { .. } => "catch_up_too_old",
        E::StreamIncomplete { .. } => "stream_incomplete",
        E::WrongServer { .. } => "wrong_server",
        E::Invalid(_) => "invalid",
    };
    Error::new(napi::Status::GenericFailure, format!("{code}: {error}"))
}

/// A local copy of a slice of one server.
#[napi]
pub struct MarfaCore {
    inner: Arc<marfa_core::Core>,
}

pub struct Hydrate {
    core: Arc<marfa_core::Core>,
    types: Vec<String>,
    tier: String,
}

#[napi]
impl Task for Hydrate {
    type Output = marfa_core::HydrateReport;
    type JsValue = HydrateReport;

    fn compute(&mut self) -> Result<Self::Output> {
        let tier = self.tier.parse().map_err(failure)?;
        self.core.hydrate(&self.types, tier).map_err(failure)
    }

    fn resolve(&mut self, _: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(HydrateReport {
            types: report.types,
            tier: report.tier.as_str().into(),
            items: report.items as i64,
            edges: report.edges as i64,
            pages: report.pages as i64,
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
            applied: report.applied as i64,
            skipped: report.skipped as i64,
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

    /// Replaces the local copy with the declared types at `tier`, off the
    /// event loop.
    #[napi]
    pub fn hydrate(&self, types: Vec<String>, tier: String) -> AsyncTask<Hydrate> {
        AsyncTask::new(Hydrate {
            core: Arc::clone(&self.inner),
            types,
            tier,
        })
    }

    /// Applies every event since the stored cursor, off the event loop.
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
            .list(&self::filters(filters)?, self::sort(sort)?)
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
            slice_tier: status.slice_tier.map(|tier| tier.as_str().into()),
            event_cursor: status.event_cursor,
            hydration: status.hydration.as_str().into(),
            items: status.items as i64,
            edges: status.edges as i64,
        })
    }
}
