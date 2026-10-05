use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum BackgroundJobsCommand {
    /// Every background job the server runs on itself: its cadence, when
    /// it is next due, and what its last run did. Operator key only.
    List,
    /// Run one background job now and report what it did. Operator key only.
    Run {
        /// The background job's name, as `background-jobs list` shows it.
        name: String,
    },
}

pub fn list_request() -> Request {
    Request::get(&["background-jobs"])
}

pub fn run_request(name: &str) -> Request {
    Request::post(&["background-jobs", name, "run"])
}

pub fn run(command: BackgroundJobsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        BackgroundJobsCommand::List => list_request(),
        BackgroundJobsCommand::Run { name } => run_request(name),
    };
    out.value(&remote.json(&request)?)
}
