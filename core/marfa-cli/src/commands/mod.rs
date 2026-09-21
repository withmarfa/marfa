//! The direct surface: one root per area of the API, each leaf one
//! published operation (or, for the few composites, a short sequence).
//!
//! Every leaf builds a `Request` in a function of its own, so the shape a
//! command sends is testable without a server, and runs it through the
//! `Remote`. Nothing here mirrors the document's schemas: a command builds
//! the request from its arguments and prints the answer as it came.

pub mod audit;
pub mod blobs;
pub mod config;
pub mod connectors;
pub mod edge_types;
pub mod edges;
pub mod events;
pub mod export;
pub mod extensions;
pub mod housekeeping;
pub mod items;
pub mod keys;
pub mod metadata;
pub mod operations;
pub mod search;
pub mod status;
pub mod types;
pub mod webhooks;
pub mod whoami;

use std::io::Read;
use std::path::PathBuf;

use clap::{Args, ValueEnum};
use serde_json::{Map, Value};

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

/// A tier filter on a listing, which admits `all` where a write does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TierFilter {
    Library,
    Feed,
    All,
}

impl TierFilter {
    pub fn as_str(self) -> &'static str {
        match self {
            TierFilter::Library => "library",
            TierFilter::Feed => "feed",
            TierFilter::All => "all",
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

/// A state filter on a listing or a search: one state, or `any` to widen
/// past the active default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StateFilter {
    Active,
    Archived,
    Trashed,
    Revoked,
    Any,
}

impl StateFilter {
    pub fn as_str(self) -> &'static str {
        match self {
            StateFilter::Active => "active",
            StateFilter::Archived => "archived",
            StateFilter::Trashed => "trashed",
            StateFilter::Revoked => "revoked",
            StateFilter::Any => "any",
        }
    }
}

// Every sortable column is a verb plus `_at`, so the shared suffix is the
// naming rule rather than a redundant prefix the variants could drop.
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
pub enum Direction {
    Asc,
    Desc,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Asc => "asc",
            Direction::Desc => "desc",
        }
    }
}

/// A page of a listing: how many, and where the last page stopped.
#[derive(Debug, Default, Args)]
pub struct PageArgs {
    /// How many at most.
    #[arg(long)]
    pub limit: Option<u32>,
    /// The cursor the previous page answered with.
    #[arg(long)]
    pub cursor: Option<String>,
}

/// A JSON body from a file, from stdin as `-`, or inline.
#[derive(Debug, Default, Args)]
pub struct BodySource {
    /// A file holding the JSON body; `-` reads stdin.
    #[arg(
        long,
        value_name = "PATH",
        conflicts_with = "body",
        required_unless_present = "body"
    )]
    pub file: Option<PathBuf>,
    /// The JSON body inline.
    #[arg(long, value_name = "JSON")]
    pub body: Option<String>,
}

impl BodySource {
    pub fn read(&self) -> Result<Value, CliError> {
        let text = match (&self.file, &self.body) {
            (Some(path), _) => read_text(path)?,
            (None, Some(body)) => body.clone(),
            // clap refuses this combination, so reaching it means the
            // argument rules and this branch have drifted apart.
            (None, None) => {
                return Err(CliError::Invalid(
                    "a body is needed: --file PATH, --file - for stdin, or --body JSON".into(),
                ));
            }
        };
        serde_json::from_str(&text)
            .map_err(|error| CliError::Invalid(format!("the body is not JSON: {error}")))
    }
}

/// The text of a file, or of stdin for `-`.
pub fn read_text(path: &PathBuf) -> Result<String, CliError> {
    if path.as_os_str() == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        return Ok(text);
    }
    std::fs::read_to_string(path)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", path.display())))
}

/// The properties of an item, as a command takes them.
///
/// `--properties` is the JSON object whole; `--prop key=value` is one string
/// property at a time, for a person at a terminal. A key given both ways is
/// refused rather than resolved, because whichever won, the other was typed
/// for a reason.
#[derive(Debug, Default, Args)]
pub struct PropertyArgs {
    /// The properties, as a JSON object.
    #[arg(long, value_name = "JSON")]
    pub properties: Option<String>,
    /// One property as key=value, repeatable. The value is a string.
    #[arg(long = "prop", value_name = "KEY=VALUE")]
    pub props: Vec<String>,
}

impl PropertyArgs {
    pub fn is_empty(&self) -> bool {
        self.properties.is_none() && self.props.is_empty()
    }

    pub fn read(&self) -> Result<Map<String, Value>, CliError> {
        let mut map = match &self.properties {
            Some(text) => object(text, "--properties")?,
            None => Map::new(),
        };
        for pair in &self.props {
            let Some((key, value)) = pair.split_once('=') else {
                return Err(CliError::Invalid(format!(
                    "--prop takes key=value, not {pair:?}"
                )));
            };
            if map.contains_key(key) {
                return Err(CliError::Invalid(format!(
                    "the property {key:?} was given both in --properties and as --prop"
                )));
            }
            map.insert(key.to_string(), Value::String(value.to_string()));
        }
        Ok(map)
    }
}

/// A JSON object from an argument, refused here rather than by the server so
/// the person hears about their argument rather than about a field.
pub fn object(text: &str, flag: &str) -> Result<Map<String, Value>, CliError> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(CliError::Invalid(format!("{flag} takes a JSON object"))),
        Err(error) => Err(CliError::Invalid(format!("{flag} is not JSON: {error}"))),
    }
}

/// `key=value` pairs into a JSON object of strings, for the permission maps.
pub fn pairs(values: &[String], flag: &str) -> Result<Map<String, Value>, CliError> {
    let mut map = Map::new();
    for pair in values {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(CliError::Invalid(format!(
                "{flag} takes key=value, not {pair:?}"
            )));
        };
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
    Ok(map)
}

/// Inserts into a body only the fields that were given.
pub fn insert_opt(body: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        body.insert(key.to_string(), value.into());
    }
}

#[cfg(test)]
mod tests;
