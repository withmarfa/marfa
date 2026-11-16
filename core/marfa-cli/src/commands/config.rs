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
    /// What changing the addresses would do, whether a write needs
    /// confirming, and whether a new sign-in address answers as this
    /// instance; nothing is written. Needs `config.manage`.
    CheckAddress(BodySource),
}

#[derive(Debug, Args)]
pub struct WriteArgs {
    #[command(flatten)]
    body: BodySource,
    /// Confirm a change to the sign-in address, which signs out every browser
    /// and app, and leaves passkeys made for the old address unusable until it
    /// moves back. It needs a sign-in from the last five minutes, or the private
    /// local command (`--socket`). Without this the server answers what the
    /// change would do and writes nothing.
    #[arg(long)]
    confirm_address_change: bool,
    /// Move the sign-in address without first checking that it answers as
    /// this instance, for a host that answers only after the move. Only the
    /// private local command (`--socket`) may skip the check.
    #[arg(long)]
    skip_sign_in_address_check: bool,
}

impl WriteArgs {
    fn read(&self) -> Result<serde_json::Value, CliError> {
        let mut body = self.body.read()?;
        for (set, flag, field) in [
            (
                self.confirm_address_change,
                "--confirm-address-change",
                "confirm_sign_in_address_change",
            ),
            (
                self.skip_sign_in_address_check,
                "--skip-sign-in-address-check",
                "skip_sign_in_address_check",
            ),
        ] {
            if set {
                body.as_object_mut()
                    .ok_or_else(|| {
                        CliError::Invalid(format!("{flag} needs a JSON object as the body"))
                    })?
                    .insert(field.into(), true.into());
            }
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
    let answer = remote.json(&request)?;
    match &command {
        ConfigCommand::Replace(_) | ConfigCommand::Update(_) => out.report(&answer, |_| {
            "updated the instance configuration".to_string()
        }),
        _ => out.value(&answer),
    }
}
