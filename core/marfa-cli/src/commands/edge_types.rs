use clap::Subcommand;

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum EdgeTypesCommand {
    /// Every edge type the instance holds.
    List,
    /// Register an edge type from its definition. Needs `metadata.edge_types:write` and write on its id and any reverse name in the key's edge map.
    Register(BodySource),
    /// Remove a registered edge type. Needs `schema.write` and write on its id and any reverse name in the key's edge map.
    Delete {
        /// The edge type id.
        id: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["edge-types"])
}

pub fn register_request(definition: serde_json::Value) -> Request {
    Request::post(&["edge-types"]).json(definition)
}

pub fn delete_request(id: &str) -> Request {
    Request::delete(&["edge-types", id])
}

pub fn run(command: EdgeTypesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        EdgeTypesCommand::List => list_request(),
        EdgeTypesCommand::Register(body) => register_request(body.read()?),
        EdgeTypesCommand::Delete { id } => delete_request(id),
    };
    let answer = remote.json(&request)?;
    match &command {
        EdgeTypesCommand::Delete { id, .. } => {
            out.report(&answer, || format!("removed edge type {id}"))
        }
        _ => out.value(&answer),
    }
}
