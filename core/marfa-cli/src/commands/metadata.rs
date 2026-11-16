use clap::Subcommand;
use serde_json::json;

use super::items::IdempotencyArgs;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum MetadataCommand {
    /// Write an item's tags whole, dropping any not named.
    Replace {
        /// The item id.
        id: String,
        /// A tag, repeatable; none at all clears them.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        #[command(flatten)]
        idempotency: IdempotencyArgs,
    },
    /// Every distinct tag in use on the instance.
    Tags,
}

pub fn replace_request(id: &str, tags: &[String]) -> Request {
    Request::put(&["items", id, "tags"]).json(json!({ "tags": tags }))
}

pub fn tags_request() -> Request {
    Request::get(&["tags"])
}

pub fn run(command: MetadataCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        MetadataCommand::Replace {
            id,
            tags,
            idempotency,
        } => idempotency.apply(replace_request(id, tags)),
        MetadataCommand::Tags => tags_request(),
    };
    let answer = remote.json(&request)?;
    match &command {
        MetadataCommand::Replace { id, .. } => out.report(&answer, |answer| {
            super::said::replaced_tags("set the tags of", id, answer)
        }),
        _ => out.value(&answer),
    }
}
