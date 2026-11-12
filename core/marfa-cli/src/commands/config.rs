use clap::{Args, Subcommand};

use super::BodySource;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// The instance configuration: the name, enforcement levers and live
    /// settings. Needs `config.manage`.
    Get,
    /// Replace the instance configuration whole. Needs `config.manage`.
    Replace(WriteArgs),
    /// Change only the settings the body names; `null` removes one. Needs
    /// `config.manage`.
    Update(WriteArgs),
    /// Every stored setting with its value, default and rule, and the
    /// settings only the environment sets. Needs `config.manage` or
    /// `instance.read`.
    Settings,
    /// What changing the addresses would do and whether a write needs
    /// confirming; nothing is written. Needs `config.manage`.
    CheckAddress(BodySource),
}

#[derive(Debug, Args)]
pub struct WriteArgs {
    #[command(flatten)]
    body: BodySource,
    /// Confirm a change to the sign-in address, which signs everyone out and
    /// can strand passkeys and apps. Only the private local command, `--socket`,
    /// may change the address. Without this the server answers what the change
    /// would do and writes nothing.
    #[arg(long)]
    confirm_address_change: bool,
}

impl WriteArgs {
    fn read(&self) -> Result<serde_json::Value, CliError> {
        let mut body = self.body.read()?;
        if self.confirm_address_change {
            body.as_object_mut()
                .ok_or_else(|| {
                    CliError::Invalid(
                        "--confirm-address-change needs a JSON object as the body".into(),
                    )
                })?
                .insert("confirm_sign_in_address_change".into(), true.into());
        }
        Ok(body)
    }
}

pub fn get_request() -> Request {
    Request::get(&["config"])
}

pub fn replace_request(body: serde_json::Value) -> Request {
    Request::put(&["config"]).json(body)
}

pub fn update_request(body: serde_json::Value) -> Request {
    Request::patch(&["config"]).json(body)
}

pub fn settings_request() -> Request {
    Request::get(&["config", "settings"])
}

pub fn check_address_request(body: serde_json::Value) -> Request {
    Request::post(&["config", "address-check"]).json(body)
}

pub fn run(command: ConfigCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let request = match &command {
        ConfigCommand::Get => get_request(),
        ConfigCommand::Replace(args) => replace_request(args.read()?),
        ConfigCommand::Update(args) => update_request(args.read()?),
        ConfigCommand::Settings => settings_request(),
        ConfigCommand::CheckAddress(body) => check_address_request(body.read()?),
    };
    out.value(&remote.json(&request)?)
}
