use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum TablesCommand {
    /// The tables an item's type declares, with how many rows the item holds
    /// in each and when one last changed.
    List {
        /// The item id.
        item: String,
    },
}

pub fn list_request(item: &str) -> Request {
    Request::get(&["items", item, "tables"])
}

pub fn run(command: TablesCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        TablesCommand::List { item } => list_request(item),
    };
    out.value(&remote.json(&request)?)
}
