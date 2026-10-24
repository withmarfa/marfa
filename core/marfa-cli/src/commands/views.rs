use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use super::items::IdempotencyArgs;
use super::{object, read_text};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Views: saved lists of items, held as `system.view` and shared by every
/// app. Writing one needs write on `system.view`, and reading one read.
#[derive(Debug, Subcommand)]
pub enum ViewsCommand {
    /// Create a view, as a `system.view`.
    Create(CreateArgs),
    /// Change a view's settings, each named one replaced whole.
    Change(ChangeArgs),
    /// Delete a view at once, with no trash.
    Delete {
        /// The view's `system.view` id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// One view by id, read through the item operations; an id that holds
    /// another type is refused.
    Get {
        /// The view's `system.view` id.
        id: String,
    },
}

/// A view's settings, from a JSON document and from flags laid over it.
#[derive(Debug, Default, Args)]
pub struct SettingsArgs {
    /// A file holding the settings as a JSON object; `-` reads stdin.
    #[arg(long, value_name = "PATH", conflicts_with = "body")]
    pub file: Option<PathBuf>,
    /// The settings as a JSON object, inline.
    #[arg(long, value_name = "JSON")]
    pub body: Option<String>,
    /// The view's name.
    #[arg(long)]
    pub title: Option<String>,
    /// Which items the view lists, as a JSON object: `types`, `tier`,
    /// `state`, `filter` and `beneath`.
    #[arg(long, value_name = "JSON")]
    pub query: Option<String>,
    /// The keys the view sorts by, as a JSON array of `{"by", "direction"}`
    /// objects, first key first.
    #[arg(long, value_name = "JSON")]
    pub sort: Option<String>,
    /// How the view groups its items, as a JSON object: `by`, and optionally
    /// `bucket`, `order` and `hidden`.
    #[arg(long, value_name = "JSON")]
    pub group: Option<String>,
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
        if let Some(query) = &self.query {
            flags.insert("query".into(), Value::Object(object(query, "--query")?));
        }
        if let Some(sort) = &self.sort {
            flags.insert("sort".into(), array(sort, "--sort")?);
        }
        if let Some(group) = &self.group {
            flags.insert("group".into(), Value::Object(object(group, "--group")?));
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

fn array(text: &str, flag: &str) -> Result<Value, CliError> {
    marfa_core::refuse_inexact_integers(text)?;
    match serde_json::from_str::<Value>(text) {
        Ok(value @ Value::Array(_)) => Ok(value),
        Ok(_) => Err(CliError::Invalid(format!("{flag} takes a JSON array"))),
        Err(error) => Err(CliError::Invalid(format!("{flag} is not JSON: {error}"))),
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
    /// The view's `system.view` id.
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
        .apply(Request::post(&["views"]).json(Value::Object(body))))
}

pub fn change_request(args: &ChangeArgs) -> Result<Request, CliError> {
    let mut body = args.settings.read()?;
    body.insert("version".into(), Value::from(args.version));
    Ok(args
        .idempotency
        .apply(Request::patch(&["views", &args.id]).json(Value::Object(body))))
}

pub fn delete_request(id: &str, idempotency: &IdempotencyArgs) -> Request {
    idempotency.apply(Request::delete(&["views", id]))
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["items", id])
}

pub fn run(command: ViewsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ViewsCommand::Create(args) => create_request(args)?,
        ViewsCommand::Change(args) => change_request(args)?,
        ViewsCommand::Delete { id, idempotency } => delete_request(id, idempotency),
        ViewsCommand::Get { id } => get_request(id),
    };
    let answer = remote.json(&request)?;
    if let ViewsCommand::Get { id } = &command
        && answer.pointer("/item/type").and_then(Value::as_str) != Some("system.view")
    {
        return Err(CliError::Invalid(format!("{id} is not a view")));
    }
    out.value(&answer)
}
