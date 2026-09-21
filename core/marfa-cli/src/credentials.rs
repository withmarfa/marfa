//! Where a kept credential lives: the operating system's keychain, and
//! nowhere else.
//!
//! One entry per server origin, holding a key as JSON, and one entry naming
//! the origin a bare command talks to. Never a file: a file is readable by
//! anything on the machine, and two processes refreshing one credential
//! from a file race each other; a process with no keychain is told so and
//! pointed at `--key` or the environment.

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// The keychain service every entry is filed under.
const SERVICE: &str = "marfa";

/// The account that names the origin a command with no `--url` talks to.
const CURRENT: &str = "current";

/// What is kept for one origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Kept {
    /// A key, as minted.
    Key { key: String },
}

fn entry(account: &str) -> Result<Entry, CliError> {
    Entry::new(SERVICE, account).map_err(no_keychain)
}

fn no_keychain(error: Error) -> CliError {
    CliError::NoKeychain(error.to_string())
}

/// The credential kept for an origin, if any.
pub fn read(origin: &str) -> Result<Option<Kept>, CliError> {
    match entry(origin)?.get_password() {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|error| {
            CliError::Invalid(format!(
                "the keychain entry for {origin} is not one this build wrote: {error}; forget it with `marfa keys forget`"
            ))
        }),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(no_keychain(error)),
    }
}

/// Keeps a credential for an origin, and makes that origin the current one.
pub fn keep(origin: &str, kept: &Kept) -> Result<(), CliError> {
    let text = serde_json::to_string(kept)?;
    entry(origin)?.set_password(&text).map_err(no_keychain)?;
    entry(CURRENT)?.set_password(origin).map_err(no_keychain)
}

/// Forgets an origin's credential. Answers whether there was one.
pub fn forget(origin: &str) -> Result<bool, CliError> {
    let had = match entry(origin)?.delete_credential() {
        Ok(()) => true,
        Err(Error::NoEntry) => false,
        Err(error) => return Err(no_keychain(error)),
    };
    if current()?.as_deref() == Some(origin) {
        match entry(CURRENT)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => {}
            Err(error) => return Err(no_keychain(error)),
        }
    }
    Ok(had)
}

/// The origin a command with no `--url` talks to, if one was kept.
pub fn current() -> Result<Option<String>, CliError> {
    match entry(CURRENT)?.get_password() {
        Ok(origin) => Ok(Some(origin)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(no_keychain(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A round trip through the real keychain, on a machine that has one.
    ///
    /// Skipped with its reason where the keychain does not answer at any
    /// step, because the alternative is a test that fails on every headless
    /// runner, and on a Mac whose keychain asks a person before a rebuilt
    /// binary may touch an item, for a reason that is not the code's; the
    /// scenario suite covers the same path wherever a keychain answers.
    #[test]
    fn keeps_reads_and_forgets_a_credential_for_one_origin() {
        let origin = format!("https://test.invalid:{}", std::process::id());
        let kept = Kept::Key {
            key: "marfa_k1_test".into(),
        };
        let outcome = (|| -> Result<(), CliError> {
            keep(&origin, &kept)?;
            assert_eq!(read(&origin)?, Some(kept.clone()));
            assert_eq!(current()?.as_deref(), Some(origin.as_str()));
            assert!(forget(&origin)?);
            assert_eq!(read(&origin)?, None);
            assert_eq!(current()?, None);
            assert!(!forget(&origin)?);
            Ok(())
        })();
        match outcome {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                eprintln!("skipped: the keychain did not answer ({reason})");
            }
            Err(error) => panic!("{error}"),
        }
    }
}
