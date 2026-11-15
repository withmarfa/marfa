use marfa_rules::server_log::UpgradeRefusal;

/// Exit status: 78 for a database this build will not run on, 1 otherwise.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub status: u8,
    pub message: String,
    /// Set when the server stopped rather than change its database; the log line names it.
    pub refusal: Option<UpgradeRefusal>,
}

impl Failure {
    pub fn start(message: impl Into<String>) -> Failure {
        Failure {
            status: 1,
            message: message.into(),
            refusal: None,
        }
    }

    /// A refusal to upgrade the database, which stays as it was.
    pub fn refused_upgrade(refusal: UpgradeRefusal, message: impl Into<String>) -> Failure {
        Failure {
            refusal: Some(refusal),
            ..Failure::start(message)
        }
    }

    pub fn database(message: impl Into<String>) -> Failure {
        Failure {
            status: 78,
            message: message.into(),
            refusal: None,
        }
    }
}
