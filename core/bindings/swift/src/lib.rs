//! The Swift-facing shape of `marfa_core`: the same calls, records instead of
//! structs, one flat error enum, and properties carried as a JSON string.

use std::sync::Arc;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    Timestamp,
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
    pub device: Option<String>,
    pub timestamp: String,
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

/// Narrowing for a list. Leaving `state` unset excludes trashed rows, as the
/// server does; `include_trashed` lifts that, and a named state wins.
#[derive(Debug, Clone, Default, uniffi::Record)]
pub struct ListFilters {
    #[uniffi(default = None)]
    pub r#type: Option<String>,
    #[uniffi(default = None)]
    pub state: Option<ItemState>,
    #[uniffi(default = false)]
    pub include_trashed: bool,
    #[uniffi(default = None)]
    pub tier: Option<Tier>,
    #[uniffi(default = [])]
    pub tags: Vec<String>,
    #[uniffi(default = None)]
    pub timestamp_after: Option<String>,
    #[uniffi(default = None)]
    pub timestamp_before: Option<String>,
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
    NoServer,
    NoCursor,
    HydrationIncomplete,
    CatchUpTooOld {
        min_retained_id: String,
    },
    StreamIncomplete {
        reason: String,
    },
    WrongServer {
        expected: String,
        got: String,
    },
    Invalid {
        message: String,
    },
}

impl std::fmt::Display for MarfaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl From<marfa_core::CoreError> for MarfaError {
    fn from(error: marfa_core::CoreError) -> Self {
        use marfa_core::CoreError as E;
        match error {
            E::NotFound { code, message } => MarfaError::NotFound { code, message },
            E::Unauthorized { code, message } => MarfaError::Unauthorized { code, message },
            E::Forbidden { code, message } => MarfaError::Forbidden { code, message },
            E::Validation { code, message } => MarfaError::Validation { code, message },
            E::UnknownType { message } => MarfaError::UnknownType { message },
            E::RateLimited {
                code,
                message,
                retry_after_seconds,
            } => MarfaError::RateLimited {
                code,
                message,
                retry_after_seconds,
            },
            E::Server {
                status,
                code,
                message,
            } => MarfaError::Server {
                status,
                code,
                message,
            },
            E::Network(message) => MarfaError::Network { message },
            E::Decoding(message) => MarfaError::Decoding { message },
            E::Store(message) => MarfaError::Store { message },
            E::NoServer => MarfaError::NoServer,
            E::NoCursor => MarfaError::NoCursor,
            E::HydrationIncomplete => MarfaError::HydrationIncomplete,
            E::CatchUpTooOld { min_retained_id } => MarfaError::CatchUpTooOld { min_retained_id },
            E::StreamIncomplete { reason } => MarfaError::StreamIncomplete { reason },
            E::WrongServer { expected, got } => MarfaError::WrongServer { expected, got },
            E::Invalid(message) => MarfaError::Invalid { message },
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
            device: item.device,
            timestamp: item.timestamp,
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
            include_trashed: filters.include_trashed,
            tier: filters.tier.map(Into::into),
            tags: filters.tags,
            timestamp_after: filters.timestamp_after,
            timestamp_before: filters.timestamp_before,
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
                SortField::Timestamp => marfa_core::SortField::Timestamp,
            },
            direction: match sort.direction {
                SortDirection::Ascending => marfa_core::SortDirection::Ascending,
                SortDirection::Descending => marfa_core::SortDirection::Descending,
            },
        }
    }
}

/// A local copy of a slice of one server. Every method blocks; call from off
/// the main thread.
#[derive(uniffi::Object)]
pub struct MarfaCore {
    inner: marfa_core::Core,
}

#[uniffi::export]
impl MarfaCore {
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

    pub fn search(&self, query: String, limit: u32) -> Result<Vec<SearchHit>, MarfaError> {
        let hits = self.inner.search(&query, limit as usize)?;
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
            },
            items: status.items,
            edges: status.edges,
        })
    }
}

/// The sort the server and the CLI default to: newest first.
#[uniffi::export]
pub fn default_sort() -> Sort {
    Sort {
        field: SortField::CreatedAt,
        direction: SortDirection::Descending,
    }
}
