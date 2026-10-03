//! A keychain file of the test's own, so no test touches the person's
//! keychain. Prompts are refused before the first keychain call and the file
//! is unlocked before every run, so nothing can wait on a person.

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

    pub fn directory(&self) -> &std::path::Path {
        &self.folder
    }

    #[cfg(target_os = "macos")]
    pub fn keychain_path(&self) -> PathBuf {
        self.keychain.clone()
    }

    #[cfg(target_os = "macos")]
    pub fn put(&self, account: &str, text: &str) {
        self.opened();
        let output = Command::new("security")
            .args([
                "add-generic-password",
                "-A",
                "-s",
                "marfa",
                "-a",
                account,
                "-w",
                text,
            ])
            .arg(&self.keychain)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "could not seed isolated credential store"
        );
    }

    pub fn missing(&self) -> PathBuf {
        self.folder.join("missing.keychain-db")
    }

    #[cfg(target_os = "macos")]
    fn opened(&self) -> security_framework::os::macos::keychain::SecKeychain {
        let mut keychain =
            security_framework::os::macos::keychain::SecKeychain::open(&self.keychain).unwrap();
        keychain.unlock(Some(&self.password)).unwrap();
        keychain
    }

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

/// Searches the login keychain too: by attributes alone, with prompts
/// refused, so no secret is read and no dialog can appear.
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
        // errSecItemNotFound.
        Err(error) if error.code() == -25300 => false,
        Err(error) => panic!("{error}"),
    }
}
