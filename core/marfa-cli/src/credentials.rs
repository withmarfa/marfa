//! Never a plain file: two processes refreshing one token from a file race
//! each other into a revoked chain.
//!
//! The login keychain asks the person before a rebuilt binary may read an
//! item another build wrote, so a test waiting on it waits forever. Tests
//! keep their entries in a keychain file of their own (`isolated`), and
//! `MARFA_KEYCHAIN` lets an unwatched run do the same, with prompts refused.

use serde::{Deserialize, Serialize};

use crate::error::CliError;

#[cfg_attr(all(test, not(target_os = "macos")), allow(dead_code))]
const SERVICE: &str = "marfa";

const CURRENT: &str = "current";

/// Apart from the token entry, because the registration outlives a sign-out.
const CLIENT: &str = "client:";

trait Keychain: Sync {
    fn get(&self, account: &str) -> Result<Option<String>, CliError>;
    fn set(&self, account: &str, text: &str) -> Result<(), CliError>;
    fn delete(&self, account: &str) -> Result<bool, CliError>;
}

#[cfg(not(test))]
struct System;

#[cfg(not(test))]
impl System {
    fn entry(account: &str) -> Result<keyring::Entry, CliError> {
        keyring::Entry::new(SERVICE, account).map_err(no_keychain)
    }
}

#[cfg(not(test))]
fn no_keychain(error: keyring::Error) -> CliError {
    CliError::NoKeychain(error.to_string())
}

#[cfg(not(test))]
impl Keychain for System {
    fn get(&self, account: &str) -> Result<Option<String>, CliError> {
        match Self::entry(account)?.get_password() {
            Ok(text) => Ok(Some(text)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(no_keychain(error)),
        }
    }

    fn set(&self, account: &str, text: &str) -> Result<(), CliError> {
        Self::entry(account)?
            .set_password(text)
            .map_err(no_keychain)
    }

    fn delete(&self, account: &str) -> Result<bool, CliError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(no_keychain(error)),
        }
    }
}

#[cfg(not(test))]
fn keychain() -> &'static dyn Keychain {
    static CHOSEN: std::sync::LazyLock<Box<dyn Keychain + Send>> =
        std::sync::LazyLock::new(|| match std::env::var_os("MARFA_KEYCHAIN") {
            Some(path) if !path.is_empty() => named(std::path::PathBuf::from(path)),
            _ => Box::new(System),
        });
    CHOSEN.as_ref()
}

#[cfg(all(not(test), target_os = "macos"))]
fn named(path: std::path::PathBuf) -> Box<dyn Keychain + Send> {
    Box::new(file::File::named(path, None))
}

#[cfg(all(not(test), not(target_os = "macos")))]
fn named(_: std::path::PathBuf) -> Box<dyn Keychain + Send> {
    Box::new(Unavailable)
}

#[cfg(all(not(test), not(target_os = "macos")))]
struct Unavailable;

#[cfg(all(not(test), not(target_os = "macos")))]
impl Keychain for Unavailable {
    fn get(&self, _: &str) -> Result<Option<String>, CliError> {
        Err(Self::refusal())
    }

    fn set(&self, _: &str, _: &str) -> Result<(), CliError> {
        Err(Self::refusal())
    }

    fn delete(&self, _: &str) -> Result<bool, CliError> {
        Err(Self::refusal())
    }
}

#[cfg(all(not(test), not(target_os = "macos")))]
impl Unavailable {
    fn refusal() -> CliError {
        CliError::NoKeychain("MARFA_KEYCHAIN names a keychain file, which only macOS has".into())
    }
}

#[cfg(test)]
fn keychain() -> &'static dyn Keychain {
    isolated::keychain()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Kept {
    Key {
        key: String,
    },
    Token {
        access_token: String,
        refresh_token: Option<String>,
        /// Seconds since the epoch.
        expires_at: Option<u64>,
        client_id: String,
        scope: Option<String>,
        token_endpoint: String,
        revocation_endpoint: Option<String>,
    },
}

impl Kept {
    pub fn bearer(&self) -> &str {
        match self {
            Kept::Key { key } => key,
            Kept::Token { access_token, .. } => access_token,
        }
    }
}

pub fn read(origin: &str) -> Result<Option<Kept>, CliError> {
    match keychain().get(origin)? {
        Some(text) => serde_json::from_str(&text).map(Some).map_err(|error| {
            CliError::Invalid(format!(
                "the keychain entry for {origin} is not one this build wrote: {error}; forget it with `marfa keys forget`"
            ))
        }),
        None => Ok(None),
    }
}

pub fn keep(origin: &str, kept: &Kept) -> Result<(), CliError> {
    let text = serde_json::to_string(kept)?;
    keychain().set(origin, &text)?;
    keychain().set(CURRENT, origin)
}

pub fn forget(origin: &str) -> Result<bool, CliError> {
    let had = drop(origin)?;
    if current()?.as_deref() == Some(origin) {
        keychain().delete(CURRENT)?;
    }
    Ok(had)
}

/// Leaves the origin current, so after a sign-in ends on its own the next
/// bare command still names the server it lost.
pub fn drop(origin: &str) -> Result<bool, CliError> {
    keychain().delete(origin)
}

pub fn client_id(origin: &str) -> Result<Option<String>, CliError> {
    keychain().get(&format!("{CLIENT}{origin}"))
}

pub fn keep_client_id(origin: &str, id: &str) -> Result<(), CliError> {
    keychain().set(&format!("{CLIENT}{origin}"), id)
}

pub fn current() -> Result<Option<String>, CliError> {
    keychain().get(CURRENT)
}

/// Every test that keeps a credential writes the one `current` entry, so
/// tests running at once would read each other's origin back.
#[cfg(test)]
pub(crate) fn hold(origin: &str) -> Held {
    static KEYCHAIN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    Held {
        origin: origin.to_string(),
        _lock: KEYCHAIN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    }
}

#[cfg(test)]
pub(crate) struct Held {
    origin: String,
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for Held {
    fn drop(&mut self) {
        for account in [
            self.origin.clone(),
            format!("{CLIENT}{}", self.origin),
            CURRENT.to_string(),
        ] {
            let _ = keychain().delete(&account);
        }
    }
}

/// A keychain file is in no search list: a search that names no keychain
/// never finds what is kept in it.
#[cfg(target_os = "macos")]
mod file {
    use std::path::PathBuf;

    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::os::macos::passwords::find_generic_password;

    use super::{Keychain, SERVICE};
    use crate::error::CliError;

    /// `errSecItemNotFound`.
    const NOT_FOUND: i32 = -25300;

    pub(super) struct File {
        pub(super) path: PathBuf,
        /// Unlocks it before every call, so a file that locked itself is
        /// never unlocked by asking anyone.
        password: Option<String>,
        refused: bool,
    }

    impl File {
        /// A keychain file named for a run is a run nobody is watching, so
        /// prompts are refused for the whole process before its first call.
        pub(super) fn named(path: PathBuf, password: Option<String>) -> File {
            File {
                path,
                password,
                refused: refuse_prompts(),
            }
        }

        pub(super) fn opened(&self) -> Result<SecKeychain, CliError> {
            if !self.refused {
                return Err(CliError::NoKeychain(format!(
                    "{}: keychain prompts could not be refused, so it is not used",
                    self.path.display()
                )));
            }
            // An item added to a keychain path with no file there lands in
            // the person's default keychain.
            if !self.path.is_file() {
                return Err(CliError::NoKeychain(format!(
                    "{}: no keychain file is there",
                    self.path.display()
                )));
            }
            let mut keychain =
                SecKeychain::open(&self.path).map_err(|error| self.refused(error))?;
            if let Some(password) = &self.password {
                keychain
                    .unlock(Some(password))
                    .map_err(|error| self.refused(error))?;
            }
            Ok(keychain)
        }

        fn refused(&self, error: security_framework::base::Error) -> CliError {
            CliError::NoKeychain(format!("{}: {error}", self.path.display()))
        }
    }

    pub(super) fn refuse_prompts() -> bool {
        static REFUSED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *REFUSED.get_or_init(|| match SecKeychain::disable_user_interaction() {
            Ok(refusal) => {
                // Held for the life of the process: dropping it would allow
                // prompts again.
                std::mem::forget(refusal);
                true
            }
            Err(_) => false,
        })
    }

    impl Keychain for File {
        fn get(&self, account: &str) -> Result<Option<String>, CliError> {
            match find_generic_password(Some(&[self.opened()?]), SERVICE, account) {
                Ok((password, _)) => Ok(Some(String::from_utf8_lossy(&password).into_owned())),
                Err(error) if error.code() == NOT_FOUND => Ok(None),
                Err(error) => Err(self.refused(error)),
            }
        }

        fn set(&self, account: &str, text: &str) -> Result<(), CliError> {
            self.opened()?
                .set_generic_password(SERVICE, account, text.as_bytes())
                .map_err(|error| self.refused(error))
        }

        /// By attributes, so the secret is never read.
        fn delete(&self, account: &str) -> Result<bool, CliError> {
            use security_framework::item::{ItemClass, ItemSearchOptions};
            let keychains = [self.opened()?];
            let mut options = ItemSearchOptions::new();
            options
                .keychains(&keychains)
                .class(ItemClass::generic_password())
                .service(SERVICE)
                .account(account);
            match options.delete() {
                Ok(()) => Ok(true),
                Err(error) if error.code() == NOT_FOUND => Ok(false),
                Err(error) => Err(self.refused(error)),
            }
        }
    }
}

#[cfg(test)]
mod isolated {
    use super::Keychain;
    #[cfg(not(target_os = "macos"))]
    use crate::error::CliError;

    pub(super) fn keychain() -> &'static dyn Keychain {
        &*KEYCHAIN
    }

    #[cfg(target_os = "macos")]
    static KEYCHAIN: std::sync::LazyLock<super::file::File> = std::sync::LazyLock::new(create);

    /// Named anything but `login`: macOS adds a keychain of that name to the
    /// person's search list and will not unlock it with its own password.
    #[cfg(target_os = "macos")]
    fn create() -> super::file::File {
        use security_framework::os::macos::keychain::CreateOptions;
        assert!(super::file::refuse_prompts(), "keychain prompts refused");
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let folder =
            std::env::temp_dir().join(format!("marfa-cli-keychain-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("the test keychain's folder");
        FOLDER
            .set(folder.clone())
            .expect("one test keychain per run");
        // Safe: `remove_folder` takes nothing and touches only the path set
        // above.
        unsafe { libc::atexit(remove_folder) };
        let path = folder.join("run.keychain-db");
        let password = format!("{nanos:x}");
        CreateOptions::new()
            .password(&password)
            .prompt_user(false)
            .create(&path)
            .expect("the test keychain");
        super::file::File::named(path, Some(password))
    }

    #[cfg(target_os = "macos")]
    static FOLDER: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    #[cfg(target_os = "macos")]
    extern "C" fn remove_folder() {
        if let Some(folder) = FOLDER.get() {
            let _ = std::fs::remove_dir_all(folder);
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn file() -> &'static super::file::File {
        &KEYCHAIN
    }

    #[cfg(not(target_os = "macos"))]
    static KEYCHAIN: std::sync::LazyLock<Memory> = std::sync::LazyLock::new(Memory::default);

    #[cfg(not(target_os = "macos"))]
    #[derive(Default)]
    pub(super) struct Memory(std::sync::Mutex<std::collections::HashMap<String, String>>);

    #[cfg(not(target_os = "macos"))]
    impl Keychain for Memory {
        fn get(&self, account: &str) -> Result<Option<String>, CliError> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }

        fn set(&self, account: &str, text: &str) -> Result<(), CliError> {
            self.0
                .lock()
                .unwrap()
                .insert(account.to_string(), text.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<bool, CliError> {
            Ok(self.0.lock().unwrap().remove(account).is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_reads_and_forgets_a_credential_for_one_origin() {
        let origin = format!("https://test.invalid:{}", std::process::id());
        let _keychain = hold(&origin);
        let kept = Kept::Key {
            key: "marfa_k1_test".into(),
        };
        keep(&origin, &kept).unwrap();
        keep_client_id(&origin, "client-1").unwrap();
        assert_eq!(read(&origin).unwrap(), Some(kept.clone()));
        assert_eq!(current().unwrap().as_deref(), Some(origin.as_str()));
        assert_eq!(client_id(&origin).unwrap().as_deref(), Some("client-1"));
        assert!(drop(&origin).unwrap());
        assert_eq!(read(&origin).unwrap(), None);
        assert_eq!(
            current().unwrap().as_deref(),
            Some(origin.as_str()),
            "a drop leaves the origin current"
        );
        keep(&origin, &kept).unwrap();
        assert!(forget(&origin).unwrap());
        assert_eq!(read(&origin).unwrap(), None);
        assert_eq!(current().unwrap(), None);
        assert_eq!(
            client_id(&origin).unwrap().as_deref(),
            Some("client-1"),
            "a registration outlives the credential"
        );
        assert!(!forget(&origin).unwrap());
        assert!(keychain().delete(&format!("{CLIENT}{origin}")).unwrap());
        assert_eq!(client_id(&origin).unwrap(), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_keychain_file_that_is_not_there_is_refused() {
        let missing = file::File::named(
            std::env::temp_dir().join(format!("marfa-no-keychain-{}", std::process::id())),
            None,
        );
        assert!(matches!(
            missing.opened(),
            Err(CliError::NoKeychain(message)) if message.contains("no keychain file")
        ));
        // The witness: the run's own file, which is there, opens.
        assert!(isolated::file().opened().is_ok());
    }

    #[test]
    fn forgetting_an_origin_leaves_another_current() {
        let a = format!("https://a.invalid:{}", std::process::id());
        let b = format!("https://b.invalid:{}", std::process::id());
        let _keychain = hold(&a);
        let kept = Kept::Key {
            key: "marfa_k1_forget".into(),
        };
        keep(&a, &kept).unwrap();
        keep(&b, &kept).unwrap();
        assert!(forget(&a).unwrap());
        assert_eq!(current().unwrap().as_deref(), Some(b.as_str()));
        // The witness: forgetting the current one clears it.
        assert!(forget(&b).unwrap());
        assert_eq!(current().unwrap(), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_test_run_keeps_its_entries_in_a_keychain_of_its_own() {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        use security_framework::os::macos::keychain::SecKeychain;
        let origin = format!("https://isolated.invalid:{}", std::process::id());
        let _keychain = hold(&origin);
        keep(
            &origin,
            &Kept::Key {
                key: "marfa_k1_isolated".into(),
            },
        )
        .unwrap();
        assert!(!SecKeychain::user_interaction_allowed().unwrap());
        let search = |keychains: Option<Vec<SecKeychain>>| {
            let mut options = ItemSearchOptions::new();
            options
                .class(ItemClass::generic_password())
                .service(SERVICE)
                .account(&origin)
                .load_attributes(true);
            if let Some(keychains) = &keychains {
                options.keychains(keychains);
            }
            match options.search() {
                Ok(found) => !found.is_empty(),
                Err(error) if error.code() == -25300 => false,
                Err(error) => panic!("{error}"),
            }
        };
        // The witness: the run's own keychain holds it, asked the same way.
        assert!(search(Some(vec![isolated::file().opened().unwrap()])));
        assert!(!search(None), "the entry reached the user's keychains");
    }
}
