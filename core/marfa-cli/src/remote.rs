//! The server a command talks to, as named on the command line or in the
//! environment.

use marfa_core::Server;

use crate::error::CliError;

/// The two values the command line and the environment can name.
#[derive(Debug, Default, Clone)]
pub struct Named {
    pub url: Option<String>,
    pub key: Option<String>,
}

impl Named {
    /// The flag, then the environment, for each. An empty value is unset,
    /// so a variable exported as nothing does not name a server of nothing.
    pub fn from_flags(url: Option<String>, key: Option<String>) -> Named {
        Named {
            url: url.or_else(|| non_empty(std::env::var("MARFA_API_URL").ok())),
            key: key.or_else(|| non_empty(std::env::var("MARFA_API_KEY").ok())),
        }
    }

    /// What a command that sends needs: both values, or a refusal naming
    /// the one missing.
    pub fn server(&self) -> Result<Server, CliError> {
        let url = self.url.clone().ok_or(CliError::NoServerNamed)?;
        let key = self.key.clone().ok_or(CliError::NoCredentialNamed)?;
        Ok(Server { url, key })
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sending_command_needs_both_values_and_is_told_which_is_missing() {
        let both = Named {
            url: Some("http://localhost:8600".into()),
            key: Some("marfa_k1_test".into()),
        };
        let server = both.server().unwrap();
        assert_eq!(server.url, "http://localhost:8600");
        assert_eq!(server.key, "marfa_k1_test");

        assert!(matches!(
            Named::default().server(),
            Err(CliError::NoServerNamed)
        ));
        assert!(matches!(
            Named {
                url: Some("http://localhost:8600".into()),
                key: None,
            }
            .server(),
            Err(CliError::NoCredentialNamed)
        ));
    }
}
