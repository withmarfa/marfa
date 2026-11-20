use clap::Subcommand;
use serde_json::Value;

use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum UpdateCommand {
    /// The release the server runs, the newest release it found and when, and
    /// whether and how it can be updated. Requires `instance.read`.
    Status,
    /// Have the server update itself to the newest release it found, where it
    /// runs as the service `marfa server install` set up. Elsewhere it changes
    /// nothing and says the step to take on the host. Requires `instance.maintain`.
    ///
    /// Before Marfa 0.1, a newer release may not read an earlier release's
    /// database. The server asks the newer release first, and when it cannot
    /// read the database, the update ends with nothing changed: the server stays
    /// on its release, and `marfa update status` gives the reason in `last`. The
    /// way to move is then to export, make a new install of the newer release
    /// and restore the archive there. A release that changes how the database is
    /// laid out keeps a copy of it first, as `marfa.db.before-upgrade` beside it.
    Start,
}

pub fn status_request() -> Request {
    Request::get(&["update"])
}

pub fn start_request() -> Request {
    Request::post(&["update"])
}

pub fn run(command: UpdateCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        UpdateCommand::Status => out.value(&remote.json(&status_request())?),
        UpdateCommand::Start => {
            let answer = remote.json(&start_request())?;
            out.report(&answer, |answer| {
                let to = answer
                    .pointer("/progress/release")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                format!("updating to {}", printable(to))
            })
        }
    }
}
