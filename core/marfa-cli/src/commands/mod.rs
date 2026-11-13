pub mod apps;
pub mod attention;
pub mod audit;
pub mod backups;
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
pub mod overview;
pub mod owner;
pub mod owner_passkeys;
pub mod profile;
pub mod restore;
pub mod rows;
pub mod said;
pub mod search;
pub mod sign_ins;
pub mod sources;
pub mod status;
pub mod tables;
pub mod types;
pub mod views;
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

/// The server's `state` list for the states given, or none when `--state` was
/// not. `any` already reaches every state, so beside another it is refused here
/// as the server refuses it, before a request is made.
pub fn state_list(states: &[StateFilter]) -> Result<Option<String>, CliError> {
    if states.len() > 1 && states.contains(&StateFilter::Any) {
        return Err(CliError::Usage(
            "--state takes `any` alone: it already answers every state, so give it without the others, or name the states you want".into(),
        ));
    }
    Ok((!states.is_empty()).then(|| {
        states
            .iter()
            .map(|state| state.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }))
}

#[derive(Debug, Default, Args)]
pub struct PageArgs {
    /// How many at most.
    #[arg(long)]
    pub limit: Option<u32>,
    /// The cursor the previous page answered with.
    #[arg(long)]
    pub cursor: Option<String>,
    /// Read every page, one after another, and print them as one answer.
    /// `--limit` is then the size of each page.
    #[arg(long, conflicts_with = "cursor")]
    pub all: bool,
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
        marfa_core::refuse_inexact_integers(&text)?;
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
    /// One property as key=value, repeatable. The value is read as the field's
    /// kind, which the CLI looks up on the server: a whole number, a number,
    /// true or false, or JSON for an object or a list. A field the type does
    /// not name is sent as text.
    #[arg(long = "prop", value_name = "KEY=VALUE")]
    pub props: Vec<String>,
}

impl PropertyArgs {
    pub fn is_empty(&self) -> bool {
        self.properties.is_none() && self.props.is_empty()
    }

    /// The properties, each `--prop` value read as the kind its field has in
    /// `fields`, a type's field definitions. Without them every value is text.
    pub fn read(
        &self,
        fields: Option<&Map<String, Value>>,
    ) -> Result<Map<String, Value>, CliError> {
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
            let kind = fields
                .and_then(|fields| fields.get(key))
                .and_then(|field| field.get("type"))
                .and_then(Value::as_str);
            map.insert(key.to_string(), prop_value(key, value, kind)?);
        }
        Ok(map)
    }
}

/// `text` as the kind of field `key` is. A kind that holds text, and one the
/// type does not say, keep it as text, and the server decides.
pub fn prop_value(key: &str, text: &str, kind: Option<&str>) -> Result<Value, CliError> {
    let refuse = |kind: &str, wanted: &str| {
        CliError::Invalid(format!(
            "--prop {key}={text}: the field {key} is {kind}, and {text:?} is not {wanted}"
        ))
    };
    match kind {
        Some("integer") => text
            .parse::<i64>()
            .map(Value::from)
            .map_err(|_| refuse("an integer", "a whole number")),
        Some("number") => match text.parse::<i64>() {
            Ok(whole) => Ok(Value::from(whole)),
            Err(_) => text
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .ok_or_else(|| refuse("a number", "a number")),
        },
        Some("boolean") => match text {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(refuse("a boolean", "true or false")),
        },
        Some(kind @ ("object" | "array")) => {
            marfa_core::refuse_inexact_integers(text)?;
            match (kind, serde_json::from_str::<Value>(text)) {
                ("object", Ok(value @ Value::Object(_))) => Ok(value),
                ("array", Ok(value @ Value::Array(_))) => Ok(value),
                _ => Err(refuse(
                    if kind == "object" {
                        "an object"
                    } else {
                        "a list"
                    },
                    if kind == "object" {
                        "a JSON object"
                    } else {
                        "a JSON list"
                    },
                )),
            }
        }
        _ => Ok(Value::String(text.to_string())),
    }
}

pub fn object(text: &str, flag: &str) -> Result<Map<String, Value>, CliError> {
    marfa_core::refuse_inexact_integers(text)?;
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
