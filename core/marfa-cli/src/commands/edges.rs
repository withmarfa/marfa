use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

use super::items::IdempotencyArgs;
use super::{PageArgs, insert_opt, object, read_text};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum EdgesCommand {
    /// List edges on the server, a page at a time.
    List(EdgeListArgs),
    /// One edge by id.
    Get {
        /// The edge id.
        id: String,
    },
    /// Link two items with an edge.
    Create(EdgeCreateArgs),
    /// Change an edge's properties, or move one of its ends, conditional on
    /// the version read.
    Update {
        /// The edge id.
        id: String,
        /// The properties, as a JSON object. Whole values.
        #[arg(long, value_name = "JSON")]
        properties: Option<String>,
        /// Move the edge to this source, where each target holds one of its type.
        #[arg(long, value_name = "ID")]
        source: Option<String>,
        /// Move the edge to this target, where each source holds one of its type.
        #[arg(long, value_name = "ID")]
        target: Option<String>,
        /// The version the edit was based on.
        #[arg(long)]
        version: i64,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Remove an edge.
    Delete {
        /// The edge id.
        id: String,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Upsert many edges in one request.
    Bulk(EdgeBulkArgs),
}

#[derive(Debug, Default, Args)]
pub struct EdgeListArgs {
    /// Only edges of this type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// Inclusive lower bound on the modification time: the catch-up filter.
    #[arg(long, value_name = "TIME")]
    pub updated_after: Option<String>,
    /// Exclusive upper bound on the modification time.
    #[arg(long, value_name = "TIME")]
    pub updated_before: Option<String>,
    #[command(flatten)]
    pub page: PageArgs,
}

#[derive(Debug, Default, Args)]
pub struct EdgeCreateArgs {
    /// The item the edge leaves.
    #[arg(long, value_name = "ID")]
    pub source: String,
    /// The item the edge arrives at.
    #[arg(long, value_name = "ID")]
    pub target: String,
    /// The edge type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: String,
    /// The edge's properties, as a JSON object.
    #[arg(long, value_name = "JSON")]
    pub properties: Option<String>,
    /// The id to mint it under. Omitted, the server mints one.
    #[arg(long)]
    pub id: Option<String>,
    #[command(flatten)]
    pub idempotency: IdempotencyArgs,
}

#[derive(Debug, Default, Args)]
pub struct EdgeBulkArgs {
    /// A JSON file holding the edges, or the whole body with `edges` in it;
    /// `-` reads stdin.
    #[arg(long, value_name = "PATH")]
    pub file: PathBuf,
    /// `upsert` or `create_only`.
    #[arg(long)]
    pub mode: Option<String>,
    /// Refuse the whole request if any entry is refused.
    #[arg(long)]
    pub atomic: bool,
    /// Do not deliver the writes to webhooks.
    #[arg(long)]
    pub no_fanout: bool,
}

pub fn list_request(args: &EdgeListArgs) -> Request {
    Request::get(&["edges"])
        .query_opt("edge_type", args.type_.clone())
        .query_opt("updated_after", args.updated_after.clone())
        .query_opt("updated_before", args.updated_before.clone())
        .query_opt("limit", args.page.limit.map(|limit| limit.to_string()))
        .query_opt("cursor", args.page.cursor.clone())
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["edges", id])
}

pub fn create_request(args: &EdgeCreateArgs) -> Result<Request, CliError> {
    let mut body = Map::new();
    insert_opt(&mut body, "id", args.id.clone());
    body.insert("source_id".into(), Value::String(args.source.clone()));
    body.insert("target_id".into(), Value::String(args.target.clone()));
    body.insert("edge_type".into(), Value::String(args.type_.clone()));
    if let Some(properties) = &args.properties {
        body.insert(
            "properties".into(),
            Value::Object(object(properties, "--properties")?),
        );
    }
    Ok(args
        .idempotency
        .apply(Request::post(&["edges"]).json(Value::Object(body))))
}

pub fn update_request(
    id: &str,
    properties: Option<&str>,
    ends: (Option<String>, Option<String>),
    version: i64,
) -> Result<Request, CliError> {
    let mut body = Map::new();
    if let Some(properties) = properties {
        body.insert(
            "properties".into(),
            Value::Object(object(properties, "--properties")?),
        );
    }
    insert_opt(&mut body, "source_id", ends.0);
    insert_opt(&mut body, "target_id", ends.1);
    body.insert("version".into(), json!(version));
    Ok(Request::patch(&["edges", id]).json(Value::Object(body)))
}

pub fn delete_request(id: &str) -> Request {
    Request::delete(&["edges", id])
}

pub fn bulk_request(args: &EdgeBulkArgs) -> Result<Request, CliError> {
    let text = read_text(&args.file)?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| CliError::Invalid(format!("the body is not JSON: {error}")))?;
    let mut body = match parsed {
        Value::Array(edges) => {
            let mut body = Map::new();
            body.insert("edges".into(), Value::Array(edges));
            body
        }
        Value::Object(body) if body.contains_key("edges") => body,
        _ => {
            return Err(CliError::Invalid(
                "the file holds neither an array of edges nor an object with `edges`".into(),
            ));
        }
    };
    insert_opt(&mut body, "mode", args.mode.clone());
    if args.atomic {
        body.insert("atomic".into(), Value::Bool(true));
    }
    if args.no_fanout {
        body.insert("enable_fanout".into(), Value::Bool(false));
    }
    Ok(Request::post(&["edges", "bulk"]).json(Value::Object(body)))
}

pub fn run(command: EdgesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        EdgesCommand::List(args) => list_request(args),
        EdgesCommand::Get { id } => get_request(id),
        EdgesCommand::Create(args) => create_request(args)?,
        EdgesCommand::Update {
            id,
            properties,
            source,
            target,
            version,
            idempotency,
        } => idempotency.apply(update_request(
            id,
            properties.as_deref(),
            (source.clone(), target.clone()),
            *version,
        )?),
        EdgesCommand::Delete { id, idempotency } => idempotency.apply(delete_request(id)),
        EdgesCommand::Bulk(args) => bulk_request(args)?,
    };
    out.value(&remote.json(&request)?)
}
