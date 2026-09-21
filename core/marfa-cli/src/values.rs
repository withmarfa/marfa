//! The values both surfaces of the binary take from the command line.

use clap::ValueEnum;

use crate::error::CliError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Tier {
    Library,
    Feed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ItemState {
    Active,
    Archived,
    Trashed,
    Revoked,
}

// Every sortable column is a verb plus `_at`, so the shared `At` suffix the
// lint reports is the naming rule rather than noise the variants could drop.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SortDirection {
    Asc,
    Desc,
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

/// A `--properties` argument as the object the core takes.
///
/// Refused here rather than deeper, because a caller who typed malformed JSON
/// wants to hear about their argument rather than about a field a queue could
/// not build. An array or a bare value is refused for the same reason: the
/// wire shape is an object and a caller who sent something else meant an
/// object.
pub fn properties(text: &str) -> Result<serde_json::Map<String, serde_json::Value>, CliError> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err(CliError::Invalid("--properties takes a JSON object".into())),
        Err(error) => Err(CliError::Invalid(format!(
            "--properties is not JSON: {error}"
        ))),
    }
}
