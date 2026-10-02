use clap::Subcommand;

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum TypesCommand {
    /// Every type the instance holds.
    List,
    /// One type by id, with its schema.
    Get {
        /// The type id, such as `core.note` or `user.recipe`.
        id: String,
    },
    /// Register a type from its definition. Needs `metadata.types:write`.
    Register(BodySource),
    /// Replace a registered type's definition. Needs `schema.write`.
    Update {
        /// The type id.
        id: String,
        #[command(flatten)]
        body: BodySource,
    },
    /// Remove a registered type. Needs `schema.write`.
    Delete {
        /// The type id.
        id: String,
        /// Remove it even where items of the type exist.
        #[arg(long)]
        force: bool,
    },
    /// Shipped types this instance carries that the build no longer does. Operator only.
    Drift,
    /// Remove one shipped type the build no longer carries. Operator only.
    Prune {
        /// The type id.
        id: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["types"])
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["types", id])
}

pub fn register_request(definition: serde_json::Value) -> Request {
    Request::post(&["types"]).json(definition)
}

pub fn update_request(id: &str, definition: serde_json::Value) -> Request {
    Request::put(&["types", id]).json(definition)
}

pub fn delete_request(id: &str, force: bool) -> Request {
    Request::delete(&["types", id]).query_flag("force", force)
}

pub fn drift_request() -> Request {
    Request::get(&["admin", "platform-types", "drift"])
}

pub fn prune_request(id: &str) -> Request {
    Request::delete(&["admin", "platform-types", id])
}

pub fn run(command: TypesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        TypesCommand::List => list_request(),
        TypesCommand::Get { id } => get_request(id),
        TypesCommand::Register(body) => register_request(body.read()?),
        TypesCommand::Update { id, body } => update_request(id, body.read()?),
        TypesCommand::Delete { id, force } => delete_request(id, *force),
        TypesCommand::Drift => drift_request(),
        TypesCommand::Prune { id } => prune_request(id),
    };
    let answer = remote.json(&request)?;
    match &command {
        TypesCommand::Delete { id, .. } => out.report(&answer, || format!("removed type {id}")),
        _ => out.value(&answer),
    }
}
