use std::io;

use marfa_core::CoreError;

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("{0}")]
    Io(io::Error),
    #[error("{0} is not in the local copy")]
    NotHeld(String),
    #[error("no data directory on this system; pass --db")]
    NoDataDirectory,
    #[error("{0}")]
    Watch(String),
    /// The reader went away (a closed pipe); nothing is wrong.
    #[error("output closed")]
    ClosedOutput,
}

impl From<io::Error> for CliError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::BrokenPipe {
            CliError::ClosedOutput
        } else {
            CliError::Io(error)
        }
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        CliError::Io(error.into())
    }
}
