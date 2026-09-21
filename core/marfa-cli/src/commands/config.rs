use clap::Subcommand;

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// The instance configuration: the enforcement levers and the retention
    /// overrides. Needs `config.manage`.
    Get,
    /// Replace the instance configuration whole. Needs `config.manage`.
    Replace(BodySource),
}

pub fn get_request() -> Request {
    Request::get(&["config"])
}

pub fn replace_request(body: serde_json::Value) -> Request {
    Request::put(&["config"]).json(body)
}

pub fn run(command: ConfigCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ConfigCommand::Get => get_request(),
        ConfigCommand::Replace(body) => replace_request(body.read()?),
    };
    out.value(&remote.json(&request)?)
}
