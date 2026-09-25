//! A keychain file of the test's own for the binary under test, named to it
//! by `MARFA_KEYCHAIN`, so what it keeps and reads is kept and read there
//! and never in the person's keychain. The binary refuses keychain prompts
//! whenever `MARFA_KEYCHAIN` names a file; this process refuses them before
//! its first keychain call and unlocks the file with its own password
//! before every run, so neither side can wait on a person.

// Each test crate that includes this module uses its own part of it.
#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Command;

pub struct Isolated {
    folder: PathBuf,
    #[cfg(target_os = "macos")]
    keychain: PathBuf,
    #[cfg(target_os = "macos")]
    password: String,
}

impl Isolated {
    /// Named anything but `login`: macOS adds a keychain file of that name
    /// to the person's search list when it is made, and will not unlock it
    /// with its own password.
    pub fn new(name: &str) -> Isolated {
        let folder =
            std::env::temp_dir().join(format!("marfa-isolated-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        #[cfg(target_os = "macos")]
        {
            use security_framework::os::macos::keychain::CreateOptions;
            refuse_prompts();
            let keychain = folder.join("run.keychain-db");
            let password = format!("{}-{name}", std::process::id());
            CreateOptions::new()
                .password(&password)
                .prompt_user(false)
                .create(&keychain)
                .unwrap();
            Isolated {
                folder,
                keychain,
                password,
            }
        }
        #[cfg(not(target_os = "macos"))]
        Isolated { folder }
    }

    /// The binary, keeping in this keychain, with none of the caller's
    /// server or credential.
    pub fn marfa(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_marfa"));
        command
            .env_remove("MARFA_API_URL")
            .env_remove("MARFA_API_KEY")
            .env_remove("MARFA_DB");
        #[cfg(target_os = "macos")]
        {
            self.opened();
            command.env("MARFA_KEYCHAIN", &self.keychain);
        }
        // Where there are no keychain files, a name the binary answers as no
        // keychain at all keeps it off the person's secret service.
        #[cfg(not(target_os = "macos"))]
        command.env("MARFA_KEYCHAIN", self.folder.join("none"));
        command
    }

    #[cfg(target_os = "macos")]
    fn opened(&self) -> security_framework::os::macos::keychain::SecKeychain {
        let mut keychain =
            security_framework::os::macos::keychain::SecKeychain::open(&self.keychain).unwrap();
        keychain.unlock(Some(&self.password)).unwrap();
        keychain
    }

    /// Whether this keychain holds an entry the binary kept for `account`,
    /// asked by attributes alone.
    #[cfg(target_os = "macos")]
    pub fn holds(&self, account: &str) -> bool {
        holds(Some(vec![self.opened()]), account)
    }
}

impl Drop for Isolated {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

#[cfg(target_os = "macos")]
fn refuse_prompts() {
    static REFUSED: std::sync::Once = std::sync::Once::new();
    REFUSED.call_once(|| {
        std::mem::forget(
            security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
                .unwrap(),
        );
    });
}

/// Whether the keychains a search that names none reaches, the login
/// keychain among them, hold an entry under the binary's service for
/// `account`: asked by attributes alone, with prompts refused.
#[cfg(target_os = "macos")]
pub fn the_users_keychains_hold(account: &str) -> bool {
    refuse_prompts();
    holds(None, account)
}

#[cfg(target_os = "macos")]
fn holds(
    keychains: Option<Vec<security_framework::os::macos::keychain::SecKeychain>>,
    account: &str,
) -> bool {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    let mut options = ItemSearchOptions::new();
    options
        .class(ItemClass::generic_password())
        .service("marfa")
        .account(account)
        .load_attributes(true);
    if let Some(keychains) = &keychains {
        options.keychains(keychains);
    }
    match options.search() {
        Ok(found) => !found.is_empty(),
        // Keychain Services' answer for an item that is not there.
        Err(error) if error.code() == -25300 => false,
        Err(error) => panic!("{error}"),
    }
}
