use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum BackupsCommand {
    /// The backups where the instance keeps them, its backup folder or its object store, newest
    /// first, from every instance that put them there. Requires private local authority
    /// (--socket).
    List,
    /// Take a backup now, whether or not anything changed since the last one.
    /// Requires private local authority (--socket).
    Run,
    /// Restore a backup from the instance's backup folder or object store. The
    /// server reads it itself, files included, so nothing is downloaded here. It
    /// restores as `restore` does an archive, and holds no sign-in, keys, apps
    /// or webhooks. Requires private local authority (--socket).
    Restore {
        /// The id of the instance that took the backup, as `backups list` shows it.
        instance_id: String,
        /// The backup's name, as `backups list` shows it.
        name: String,
    },
}

pub fn request(command: &BackupsCommand) -> Request {
    match command {
        BackupsCommand::List => Request::get(&["backups"]),
        BackupsCommand::Run => Request::post(&["backups"]),
        BackupsCommand::Restore { instance_id, name } => {
            Request::post(&["backups", instance_id, name, "restore"])
        }
    }
}

pub fn run(command: BackupsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let answer = remote.json(&request(&command))?;
    match command {
        BackupsCommand::Restore { .. } => super::restore::answered(&answer, out),
        BackupsCommand::List | BackupsCommand::Run => out.value(&answer),
    }
}
