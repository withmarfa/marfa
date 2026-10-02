use clap::ValueEnum;

use crate::error::CliError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
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

// The `At` suffix is the server's column names.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            SortDirection::Asc => "asc",
            SortDirection::Desc => "desc",
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

impl From<SortField> for marfa_core::SortField {
    fn from(field: SortField) -> Self {
        match field {
            SortField::CreatedAt => marfa_core::SortField::CreatedAt,
            SortField::UpdatedAt => marfa_core::SortField::UpdatedAt,
            SortField::OccurredAt => marfa_core::SortField::OccurredAt,
        }
    }
}

impl From<SortDirection> for marfa_core::SortDirection {
    fn from(direction: SortDirection) -> Self {
        match direction {
            SortDirection::Asc => marfa_core::SortDirection::Ascending,
            SortDirection::Desc => marfa_core::SortDirection::Descending,
        }
    }
}

/// Refused here rather than deeper, so the caller hears about their argument
/// rather than about a field a queue could not build.
pub fn properties(text: &str) -> Result<serde_json::Map<String, serde_json::Value>, CliError> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err(CliError::Invalid("--properties takes a JSON object".into())),
        Err(error) => Err(CliError::Invalid(format!(
            "--properties is not JSON: {error}"
        ))),
    }
}
