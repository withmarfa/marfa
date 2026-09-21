//! Where a kept credential lives: the operating system's keychain, and
//! nowhere else.
//!
//! One entry per server origin, holding a key or a token set as JSON, and
//! one entry naming the origin a bare command talks to. Never a file: a file
//! is readable by anything on the machine, and two processes refreshing one
//! token from a file race each other into a revoked chain; a process with no
//! keychain is told so and pointed at `--key` or the environment.

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

use crate::error::CliError;

/// The keychain service every entry is filed under. A test run files
/// under a service of its own: the keychain guards an item by the code
/// signature of the binary that wrote it, so every rebuilt test binary
/// would otherwise ask, on the person's screen, before touching an item an
/// earlier build left behind.
fn service() -> String {
    if cfg!(test) {
        format!("marfa-test-{}", std::process::id())
    } else {
        "marfa".to_string()
    }
}

/// The account that names the origin a command with no `--url` talks to.
const CURRENT: &str = "current";

/// The account prefix under which an origin's registered client id is
/// kept: the registration outlives any one sign-in, so it is not part of
/// the token entry that a sign-out removes.
const CLIENT: &str = "client:";

/// What is kept for one origin, tagged by kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Kept {
    /// A key, as minted.
    Key { key: String },
    /// A token set from a sign-in, with the client it was issued to and the
    /// doors a refresh and a sign-out go through, so neither needs the
    /// discovery document again.
    Token {
        access_token: String,
        refresh_token: Option<String>,
        /// Seconds since the epoch, when the access token stops working.
        expires_at: Option<u64>,
        client_id: String,
        scope: Option<String>,
        token_endpoint: String,
        revocation_endpoint: Option<String>,
    },
}

impl Kept {
    /// The bearer value a call sends.
    pub fn bearer(&self) -> &str {
        match self {
            Kept::Key { key } => key,
            Kept::Token { access_token, .. } => access_token,
        }
    }
}

fn entry(account: &str) -> Result<Entry, CliError> {
    Entry::new(&service(), account).map_err(no_keychain)
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

/// Forgets an origin's credential, and that the origin was current.
/// Answers whether there was one.
pub fn forget(origin: &str) -> Result<bool, CliError> {
    let had = drop(origin)?;
    if current()?.as_deref() == Some(origin) {
        match entry(CURRENT)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => {}
            Err(error) => return Err(no_keychain(error)),
        }
    }
    Ok(had)
}

/// Removes an origin's credential and leaves the origin current, for a
/// sign-in that ended on its own: the next bare command still knows which
/// server it was talking to, and says what to do about it.
pub fn drop(origin: &str) -> Result<bool, CliError> {
    match entry(origin)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(no_keychain(error)),
    }
}

/// The client id the binary registered at an origin, if it has.
pub fn client_id(origin: &str) -> Result<Option<String>, CliError> {
    match entry(&format!("{CLIENT}{origin}"))?.get_password() {
        Ok(id) => Ok(Some(id)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(no_keychain(error)),
    }
}

pub fn keep_client_id(origin: &str, id: &str) -> Result<(), CliError> {
    entry(&format!("{CLIENT}{origin}"))?
        .set_password(id)
        .map_err(no_keychain)
}

/// The origin a command with no `--url` talks to, if one was kept.
pub fn current() -> Result<Option<String>, CliError> {
    match entry(CURRENT)?.get_password() {
        Ok(origin) => Ok(Some(origin)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(no_keychain(error)),
    }
}

/// Holds the keychain for one test: every test that keeps a credential
/// writes the one `current` entry, so two running at once read each
/// other's origin back.
#[cfg(test)]
pub(crate) fn hold() -> std::sync::MutexGuard<'static, ()> {
    static KEYCHAIN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    KEYCHAIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a test does where the keychain does not answer: says so, unless
/// `MARFA_KEYCHAIN_REQUIRED` is set, in which case a keychain that does not
/// answer is the failure, so a runner that was told it has one cannot pass
/// these tests by skipping them.
#[cfg(test)]
pub(crate) fn skipped(reason: &str) {
    if std::env::var_os("MARFA_KEYCHAIN_REQUIRED").is_some() {
        panic!("the keychain did not answer and MARFA_KEYCHAIN_REQUIRED is set: {reason}");
    }
    eprintln!("skipped: the keychain did not answer ({reason})");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A round trip through the real keychain, on a machine that has one:
    /// the credential, the current origin, and the client id that outlives
    /// both.
    ///
    /// Skipped with its reason where the keychain does not answer at any
    /// step (a headless runner, or a Mac whose keychain asks a person
    /// before a rebuilt binary may touch an item), unless the runner says
    /// it has one; the scenario suite covers the same path wherever a
    /// keychain answers.
    #[test]
    fn keeps_reads_and_forgets_a_credential_for_one_origin() {
        let _keychain = hold();
        let origin = format!("https://test.invalid:{}", std::process::id());
        let kept = Kept::Key {
            key: "marfa_k1_test".into(),
        };
        let outcome = (|| -> Result<(), CliError> {
            keep(&origin, &kept)?;
            keep_client_id(&origin, "client-1")?;
            assert_eq!(read(&origin)?, Some(kept.clone()));
            assert_eq!(current()?.as_deref(), Some(origin.as_str()));
            assert_eq!(client_id(&origin)?.as_deref(), Some("client-1"));
            assert!(drop(&origin)?);
            assert_eq!(read(&origin)?, None);
            assert_eq!(
                current()?.as_deref(),
                Some(origin.as_str()),
                "a drop leaves the origin current"
            );
            keep(&origin, &kept)?;
            assert!(forget(&origin)?);
            assert_eq!(read(&origin)?, None);
            assert_eq!(current()?, None);
            assert_eq!(
                client_id(&origin)?.as_deref(),
                Some("client-1"),
                "a registration outlives the credential"
            );
            assert!(!forget(&origin)?);
            entry(&format!("{CLIENT}{origin}"))?
                .delete_credential()
                .map_err(no_keychain)?;
            assert_eq!(client_id(&origin)?, None);
            Ok(())
        })();
        match outcome {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => skipped(&reason),
            Err(error) => panic!("{error}"),
        }
    }
}
