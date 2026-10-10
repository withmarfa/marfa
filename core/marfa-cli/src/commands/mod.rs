pub mod audit;
pub mod blobs;
pub mod config;
pub mod connectors;
pub mod docs;
pub mod edge_types;
pub mod edges;
pub mod events;
pub mod export;
pub mod extensions;
pub mod folders;
pub mod housekeeping;
pub mod items;
pub mod keys;
pub mod login;
pub mod logout;
pub mod metadata;
pub mod metrics;
pub mod operations;
pub mod owner;
pub mod restore;
pub mod search;
pub mod sign_ins;
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

#[derive(Debug, Default, Args)]
pub struct PageArgs {
    /// How many at most.
    #[arg(long)]
    pub limit: Option<u32>,
    /// The cursor the previous page answered with.
    #[arg(long)]
    pub cursor: Option<String>,
}

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
            // clap refuses this; reached only if the argument rules drift.
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

pub fn read_text(path: &PathBuf) -> Result<String, CliError> {
    if path.as_os_str() == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        return Ok(text);
    }
    std::fs::read_to_string(path)
        .map_err(|error| CliError::Invalid(format!("cannot read {}: {error}", path.display())))
}

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

pub fn object(text: &str, flag: &str) -> Result<Map<String, Value>, CliError> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(CliError::Invalid(format!("{flag} takes a JSON object"))),
        Err(error) => Err(CliError::Invalid(format!("{flag} is not JSON: {error}"))),
    }
}

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

pub fn insert_opt(body: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        body.insert(key.to_string(), value.into());
    }
}

#[cfg(test)]
mod driven;
#[cfg(test)]
mod tests;
