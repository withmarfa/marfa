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

/// The tiers a slice holds: one, or `all` for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SliceTier {
    Library,
    Feed,
    All,
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

impl From<SliceTier> for marfa_core::SliceTier {
    fn from(tier: SliceTier) -> Self {
        match tier {
            SliceTier::Library => marfa_core::SliceTier::Library,
            SliceTier::Feed => marfa_core::SliceTier::Feed,
            SliceTier::All => marfa_core::SliceTier::All,
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

/// The properties of an item write: [`properties`], after the text is held to
/// the whole numbers a float keeps as written, which the parse alone would
/// round before the core could see them.
pub fn item_properties(text: &str) -> Result<serde_json::Map<String, serde_json::Value>, CliError> {
    marfa_core::refuse_inexact_integers(text)?;
    properties(text)
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

#[cfg(test)]
mod tests {
    use super::*;
    use marfa_core::CoreError;

    #[test]
    fn item_properties_refuse_a_number_a_float_would_change_before_it_is_rounded() {
        for text in [
            r#"{"id64": 1500000000000000001}"#,
            r#"{"max": 9223372036854775807}"#,
            r#"{"beyond": 99999999999999999999999}"#,
        ] {
            let error = item_properties(text).unwrap_err();
            assert!(
                matches!(&error, CliError::Core(CoreError::Validation { code, .. }) if code == "invalid_properties"),
                "{text}: {error:?}"
            );
        }
        assert!(item_properties(r#"{"num": 1152921504606846976}"#).is_err());
        assert!(item_properties(r#"{"num": 1152921504606847000, "x": 1.5, "y": 1e300}"#).is_ok());
        assert!(item_properties("[1]").is_err());
    }

    #[test]
    fn item_properties_read_a_number_as_the_float_javascript_reads() {
        // The nearest float to these digits is 999999999999999868928; a parse
        // that is off by one place in the last bit reads 1e21.
        let read = item_properties(r#"{"num": 999999999999999900000}"#).unwrap();
        assert_eq!(read["num"].as_f64(), Some(999_999_999_999_999_868_928.0));
    }
}
