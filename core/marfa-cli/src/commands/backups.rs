use clap::Subcommand;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum BackupsCommand {
    /// The backups in the instance's object store, newest first. Requires the owner or --socket.
    List,
    /// Take a backup now, whether or not anything changed since the last one.
    /// Requires the owner or --socket.
    Run,
    /// Restore a backup from the object store. The server reads it itself, so
    /// nothing is downloaded here. It restores as `restore` does an archive,
    /// and holds no sign-in, keys, apps or webhooks. Requires the owner,
    /// signed in within five minutes, or --socket.
    Restore {
        /// The backup's name, as `backups list` shows it.
        name: String,
    },
}

pub fn request(command: &BackupsCommand) -> Request {
    match command {
        BackupsCommand::List => Request::get(&["backups"]),
        BackupsCommand::Run => Request::post(&["backups"]),
        BackupsCommand::Restore { name } => Request::post(&["backups", name, "restore"]),
    }
}

pub fn run(command: BackupsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let answer = remote.json(&request(&command))?;
    match command {
        BackupsCommand::Restore { .. } => super::restore::answered(&answer, out),
        BackupsCommand::List | BackupsCommand::Run => out.value(&answer),
    }
}
