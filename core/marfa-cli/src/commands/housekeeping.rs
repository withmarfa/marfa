use clap::Subcommand;
use serde_json::Value;

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
    let answer = remote.json(&request)?;
    match &command {
        HousekeepingCommand::Run { name } => out.report(&answer, || {
            let text = |field: &str| answer.get(field).and_then(Value::as_str).unwrap_or("");
            let said = match answer.get("error").and_then(Value::as_str) {
                Some(error) => error.to_string(),
                None => answer
                    .get("result")
                    .filter(|result| !result.is_null())
                    .map(Value::to_string)
                    .unwrap_or_default(),
            };
            format!("ran {name}: {} {said}", text("outcome"))
                .trim_end()
                .to_string()
        }),
        HousekeepingCommand::List => out.value(&answer),
    }
}
