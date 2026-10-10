use crate::error::CliError;
use crate::output::Printer;
use crate::remote::{Remote, request::Request};
use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum SignInsCommand {
    /// List the browser sessions the owner is signed in with. Needs --socket
    /// PATH.
    List,
    /// End a browser session at once; connected apps keep their access. Needs
    /// --socket PATH.
    End {
        /// The ID of the sign-in, as `sign-ins list` prints it.
        id: String,
    },
}

pub fn run(command: SignInsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        SignInsCommand::List => out.value(&remote.json(&Request::get(&["owner", "sign-ins"]))?),
        SignInsCommand::End { id } => {
            let answer = remote.json(&Request::delete(&["owner", "sign-ins", &id]))?;
            out.report(&answer, || format!("ended sign-in {id}"))
        }
    }
}
