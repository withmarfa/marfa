//! A folder's settings on the server: the `system.folder` the folder door
//! creates, changes at a version and revokes.

use std::path::PathBuf;

use clap::Args;
use serde_json::{Map, Value, json};

use super::items::IdempotencyArgs;
use super::{object, read_text};
use crate::error::CliError;
use crate::remote::request::Request;

/// A folder's settings, from a JSON document and from flags laid over it.
#[derive(Debug, Default, Args)]
pub struct SettingsArgs {
    /// A file holding the settings as a JSON object; `-` reads stdin.
    #[arg(long, value_name = "PATH", conflicts_with = "body")]
    pub file: Option<PathBuf>,
    /// The settings as a JSON object, inline.
    #[arg(long, value_name = "JSON")]
    pub body: Option<String>,
    /// The folder's name.
    #[arg(long)]
    pub title: Option<String>,
    /// Which items the folder holds, as a JSON object: `types`, `tier`,
    /// `state`, `filter` and `beneath`.
    #[arg(long, value_name = "JSON")]
    pub search: Option<String>,
    /// What a new file takes where it leaves a blank, as a JSON object:
    /// `type`, `tier`, `properties`, `tags` and `edges`.
    #[arg(long, value_name = "JSON")]
    pub defaults: Option<String>,
    /// A gitignore pattern for the paths the folder takes, repeatable.
    #[arg(long = "include", value_name = "PATTERN")]
    pub include: Vec<String>,
    /// A gitignore pattern for the paths the folder leaves alone, repeatable.
    #[arg(long = "ignore", value_name = "PATTERN")]
    pub ignore: Vec<String>,
    /// Where a new item of a type made elsewhere first appears, as
    /// TYPE=DIR relative to the folder's root, repeatable.
    #[arg(long = "first-placement", value_name = "TYPE=DIR")]
    pub first_placement: Vec<String>,
    /// When a removal pauses, as a JSON object: `files` and `fraction`.
    #[arg(long, value_name = "JSON")]
    pub removal_threshold: Option<String>,
}

impl SettingsArgs {
    pub fn read(&self) -> Result<Map<String, Value>, CliError> {
        let mut settings = match (&self.file, &self.body) {
            (Some(path), _) => object(&read_text(path)?, "--file")?,
            (None, Some(body)) => object(body, "--body")?,
            (None, None) => Map::new(),
        };
        let mut flags = Map::new();
        if let Some(title) = &self.title {
            flags.insert("title".into(), json!(title));
        }
        if let Some(search) = &self.search {
            flags.insert("search".into(), Value::Object(object(search, "--search")?));
        }
        if let Some(defaults) = &self.defaults {
            flags.insert(
                "defaults".into(),
                Value::Object(object(defaults, "--defaults")?),
            );
        }
        if !self.include.is_empty() {
            flags.insert("include".into(), json!(self.include));
        }
        if !self.ignore.is_empty() {
            flags.insert("ignore".into(), json!(self.ignore));
        }
        if !self.first_placement.is_empty() {
            flags.insert(
                "first_placement".into(),
                Value::Object(super::pairs(&self.first_placement, "--first-placement")?),
            );
        }
        if let Some(threshold) = &self.removal_threshold {
            flags.insert(
                "removal_threshold".into(),
                Value::Object(object(threshold, "--removal-threshold")?),
            );
        }
        for (key, value) in flags {
            if settings.contains_key(&key) {
                return Err(CliError::Invalid(format!(
                    "the setting {key:?} was given both in the JSON and as a flag"
                )));
            }
            settings.insert(key, value);
        }
        Ok(settings)
    }
}

#[derive(Debug, Default, Args)]
pub struct CreateArgs {
    #[command(flatten)]
    pub settings: SettingsArgs,
    #[command(flatten)]
    pub idempotency: IdempotencyArgs,
}

#[derive(Debug, Default, Args)]
pub struct ChangeArgs {
    /// The folder's `system.folder` id.
    pub id: String,
    /// The version the change was based on.
    #[arg(long)]
    pub version: i64,
    #[command(flatten)]
    pub settings: SettingsArgs,
    #[command(flatten)]
    pub idempotency: IdempotencyArgs,
}

pub fn create_request(args: &CreateArgs) -> Result<Request, CliError> {
    let body = args.settings.read()?;
    Ok(args
        .idempotency
        .apply(Request::post(&["folders"]).json(Value::Object(body))))
}

pub fn change_request(args: &ChangeArgs) -> Result<Request, CliError> {
    let mut body = args.settings.read()?;
    body.insert("version".into(), Value::from(args.version));
    Ok(args
        .idempotency
        .apply(Request::patch(&["folders", &args.id]).json(Value::Object(body))))
}

pub fn revoke_request(id: &str, idempotency: &IdempotencyArgs) -> Request {
    idempotency.apply(Request::post(&["folders", id, "revoke"]))
}
