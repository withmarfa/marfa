/// Why the server did not start, and the status it exits with: 78 for a
/// database this build will not run on, 1 for anything else.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub status: u8,
    pub message: String,
}

impl Failure {
    pub fn start(message: impl Into<String>) -> Failure {
        Failure {
            status: 1,
            message: message.into(),
        }
    }

    pub fn database(message: impl Into<String>) -> Failure {
        Failure {
            status: 78,
            message: message.into(),
        }
    }
}
