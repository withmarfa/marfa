use clap::Subcommand;
use serde_json::Value;

use crate::error::CliError;
use crate::output::{Printer, printable};
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
    /// Take the server's clock as right. Requires `instance.maintain`. While the
    /// clock reads more than 7 days later than the server's trusted time, the
    /// jobs that delete old records do nothing; this lets them run now. A
    /// clock more than an hour behind that time is named on the attention
    /// list until this runs or the clock catches up.
    ConfirmClock,
}

pub fn list_request() -> Request {
    Request::get(&["housekeeping"])
}

pub fn run_request(name: &str) -> Request {
    Request::post(&["housekeeping", name, "run"])
}

pub fn confirm_clock_request() -> Request {
    Request::post(&["clock", "confirm"])
}

pub fn run(command: HousekeepingCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        HousekeepingCommand::List => list_request(),
        HousekeepingCommand::Run { name } => run_request(name),
        HousekeepingCommand::ConfirmClock => confirm_clock_request(),
    };
    let answer = remote.json(&request)?;
    match &command {
        HousekeepingCommand::Run { name } => out.report(&answer, |answer| {
            let text = |field: &str| answer.get(field).and_then(Value::as_str).unwrap_or("");
            let said = match answer.get("error").and_then(Value::as_str) {
                Some(error) => printable(error),
                None => answer
                    .get("result")
                    .filter(|result| !result.is_null())
                    .map(|result| printable(&result.to_string()))
                    .unwrap_or_default(),
            };
            format!("ran {name}: {} {said}", printable(text("outcome")))
                .trim_end()
                .to_string()
        }),
        HousekeepingCommand::ConfirmClock => out.report(&answer, |answer| {
            let at = answer
                .get("confirmed_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("confirmed the clock at {}", printable(at))
        }),
        HousekeepingCommand::List => out.value(&answer),
    }
}
