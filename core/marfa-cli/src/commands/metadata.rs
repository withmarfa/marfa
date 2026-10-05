use clap::Subcommand;
use serde_json::json;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum MetadataCommand {
    /// An item's metadata: its tags and the namespaces it carries.
    Get {
        /// The item id.
        id: String,
    },
    /// Write an item's tags whole, dropping any not named.
    Replace {
        /// The item id.
        id: String,
        /// A tag, repeatable; none at all clears them.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Add the named tags, leaving the rest.
    Update {
        /// The item id.
        id: String,
        /// A tag, repeatable.
        #[arg(long = "tag", value_name = "TAG", required = true)]
        tags: Vec<String>,
    },
    /// Every distinct tag in use on the instance.
    Tags,
}

pub fn get_request(id: &str) -> Request {
    Request::get(&["items", id, "metadata"])
}

pub fn replace_request(id: &str, tags: &[String]) -> Request {
    Request::put(&["items", id, "metadata"]).json(json!({ "tags": tags }))
}

pub fn update_request(id: &str, tags: &[String]) -> Request {
    Request::patch(&["items", id, "metadata"]).json(json!({ "tags": tags }))
}

pub fn tags_request() -> Request {
    Request::get(&["metadata", "tags"])
}

pub fn run(command: MetadataCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        MetadataCommand::Get { id } => get_request(id),
        MetadataCommand::Replace { id, tags } => replace_request(id, tags),
        MetadataCommand::Update { id, tags } => update_request(id, tags),
        MetadataCommand::Tags => tags_request(),
    };
    out.value(&remote.json(&request)?)
}
