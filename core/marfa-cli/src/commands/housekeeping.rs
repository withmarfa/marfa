use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum HousekeepingCommand {
    /// Every housekeeping job the server runs on itself: its cadence, when
    /// it is next due, and what its last run did. Requires `instance.read`.
    List,
    /// Run one housekeeping job now and report what it did. Requires `instance.maintain`.
    Run {
        /// The housekeeping job's name, as `housekeeping list` shows it.
        name: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["housekeeping"])
}

pub fn run_request(name: &str) -> Request {
    Request::post(&["housekeeping", name, "run"])
}

pub fn run(command: HousekeepingCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        HousekeepingCommand::List => list_request(),
        HousekeepingCommand::Run { name } => run_request(name),
    };
    out.value(&remote.json(&request)?)
}
