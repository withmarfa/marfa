use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// The apps the owner has authorized. Every door needs `grants.manage`.
#[derive(Debug, Subcommand)]
pub enum GrantsCommand {
    /// Every active grant.
    List,
    /// Revoke an app's grant, ending every token issued under it.
    Revoke {
        /// The grant id.
        id: String,
        /// Also revoke the keys the app minted.
        #[arg(long)]
        revoke_keys: bool,
    },
}

pub fn list_request() -> Request {
    Request::get(&["auth", "grants"])
}

pub fn revoke_request(id: &str, revoke_keys: bool) -> Request {
    Request::delete(&["auth", "grants", id]).query_flag("revoke_keys", revoke_keys)
}

pub fn run(command: GrantsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        GrantsCommand::List => list_request(),
        GrantsCommand::Revoke { id, revoke_keys } => revoke_request(id, *revoke_keys),
    };
    out.value(&remote.json(&request)?)
}
