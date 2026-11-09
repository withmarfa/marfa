//! The two secrets, when the environment does not give them: generated on a
//! first start and kept in one private file beside the database.

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use super::start::DatabasePath;
use crate::failure::Failure;

const FILE_NAME: &str = "marfa.secrets";
const SALT_LINE: &str = "key_salt";
const AUTH_LINE: &str = "auth_secret";
const SECRET_BYTES: usize = 32;
const PRIVATE_FILE: u32 = 0o600;
const SHARED_BITS: u32 = 0o077;
/// A fixed salt, used only when test hooks are on.
#[cfg(feature = "test-hooks")]
pub(super) const TEST_SALT: &str = "marfa-test-salt";

/// Neither value may reach a log or a refusal.
pub(super) struct Given {
    pub key_salt: Option<String>,
    pub auth_secret: Option<String>,
}

pub(super) struct Filled {
    pub key_salt: String,
    pub auth_secret: String,
}

#[derive(Default)]
struct Held {
    key_salt: Option<String>,
    auth_secret: Option<String>,
}

fn fresh() -> Result<String, Failure> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|_| Failure::start("No randomness was available to generate a secret"))?;
    Ok(hex::encode(bytes))
}

fn generated(unset: bool) -> Result<Option<String>, Failure> {
    unset.then(fresh).transpose()
}

fn well_formed(value: &str) -> bool {
    value.len() == SECRET_BYTES * 2 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse(text: &str) -> Option<Held> {
    let mut held = Held::default();
    for line in text.lines().rev().skip_while(|line| line.is_empty()) {
        let (name, value) = line.split_once('=')?;
        let slot = match name {
            SALT_LINE => &mut held.key_salt,
            AUTH_LINE => &mut held.auth_secret,
            _ => return None,
        };
        if !well_formed(value) || slot.replace(value.to_string()).is_some() {
            return None;
        }
    }
    Some(held)
}

fn print(held: &Held) -> String {
    let line = |name: &str, value: &Option<String>| {
        value
            .as_ref()
            .map(|value| format!("{name}={value}\n"))
            .unwrap_or_default()
    };
    line(SALT_LINE, &held.key_salt) + &line(AUTH_LINE, &held.auth_secret)
}

fn read(path: &Path) -> Result<Option<Held>, Failure> {
    let unreadable = |error: io::Error| {
        Failure::start(format!(
            "The secrets file {} could not be read: {error}",
            path.display()
        ))
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(error)),
    };
    if file.metadata().map_err(unreadable)?.mode() & SHARED_BITS != 0 {
        return Err(Failure::start(format!(
            "The secrets file {} is open to group or others; make it private with chmod 600",
            path.display()
        )));
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(unreadable)?;
    parse(&text).map(Some).ok_or_else(|| {
        Failure::start(format!(
            "The secrets file {} does not read, and replacing it would end every key; restore \
             it, or set MARFA_KEY_SALT and MARFA_AUTH_SECRET",
            path.display()
        ))
    })
}

/// A crash at any step leaves no file or a whole one; the next start removes a leftover
/// temporary file.
fn write(path: &Path, held: &Held) -> Result<(), Failure> {
    let refused = |error: io::Error| {
        Failure::start(format!(
            "The secrets file {} could not be written: {error}",
            path.display()
        ))
    };
    let folder = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(folder).map_err(refused)?;
    let temporary = path.with_extension("secrets.tmp");
    match fs::remove_file(&temporary) {
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(refused(error)),
        _ => {}
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE)
        .open(&temporary)
        .map_err(refused)?;
    file.write_all(print(held).as_bytes()).map_err(refused)?;
    file.sync_all().map_err(refused)?;
    fs::rename(&temporary, path).map_err(refused)?;
    File::open(folder)
        .and_then(|folder| folder.sync_all())
        .map_err(refused)
}

fn path_of(database: &DatabasePath) -> PathBuf {
    database.folder().join(FILE_NAME)
}

fn lacks(path: &Path, value: &str, name: &str) -> Failure {
    Failure::start(format!(
        "The secrets file {} holds no {value}; restore it, or set {name}",
        path.display()
    ))
}

/// Reads the file, or makes it on a first start. It must only run once the
/// control socket's claim is held, so two starts cannot both make one.
fn from_file(
    salt: Option<String>,
    auth: Option<String>,
    database: &Path,
    path: &Path,
) -> Result<Filled, Failure> {
    let held = match read(path)? {
        Some(held) => held,
        None if salt.is_none() && database.exists() => {
            return Err(Failure::start(format!(
                "{} exists without {}, so this is not a first start, and a new salt would end \
                 every key; restore the file, or set MARFA_KEY_SALT",
                database.display(),
                path.display()
            )));
        }
        None => {
            let held = Held {
                key_salt: generated(salt.is_none())?,
                auth_secret: generated(auth.is_none())?,
            };
            write(path, &held)?;
            held
        }
    };
    Ok(Filled {
        key_salt: salt
            .or(held.key_salt)
            .ok_or_else(|| lacks(path, SALT_LINE, "MARFA_KEY_SALT"))?,
        auth_secret: auth
            .or(held.auth_secret)
            .ok_or_else(|| lacks(path, AUTH_LINE, "MARFA_AUTH_SECRET"))?,
    })
}

pub(super) fn open(given: Given, database: &DatabasePath) -> Result<Filled, Failure> {
    let salt = given.key_salt;
    match (salt, given.auth_secret, database.file()) {
        (Some(key_salt), Some(auth_secret), _) => Ok(Filled {
            key_salt,
            auth_secret,
        }),
        (salt, auth, Some(file)) => from_file(salt, auth, &file, &path_of(database)),
        (salt, auth, None) => Ok(Filled {
            key_salt: salt.map_or_else(fresh, Ok)?,
            auth_secret: auth.map_or_else(fresh, Ok)?,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    const SALT: &str = "salt-from-the-environment";
    const AUTH: &str = "auth-secret-from-the-environment";

    fn none() -> Given {
        Given {
            key_salt: None,
            auth_secret: None,
        }
    }

    fn database(dir: &TempDir) -> DatabasePath {
        DatabasePath::File(dir.path().join("marfa.db"))
    }

    fn secrets(dir: &TempDir) -> PathBuf {
        dir.path().join(FILE_NAME)
    }

    fn refusal(result: Result<Filled, Failure>) -> String {
        match result {
            Ok(_) => panic!("the secrets were accepted"),
            Err(failure) => {
                assert_eq!(failure.status, 1);
                failure.message
            }
        }
    }

    #[test]
    fn a_first_start_makes_a_private_file_and_a_second_rereads_it() {
        let dir = TempDir::new().unwrap();
        let first = open(none(), &database(&dir)).unwrap();
        assert!(well_formed(&first.key_salt) && well_formed(&first.auth_secret));
        assert_ne!(first.key_salt, first.auth_secret);
        let mode = fs::metadata(secrets(&dir)).unwrap().mode();
        assert_eq!(mode & 0o777, PRIVATE_FILE);

        let written = fs::read(secrets(&dir)).unwrap();
        let second = open(none(), &database(&dir)).unwrap();
        assert_eq!(second.key_salt, first.key_salt);
        assert_eq!(second.auth_secret, first.auth_secret);
        assert_eq!(fs::read(secrets(&dir)).unwrap(), written);
    }

    #[test]
    fn a_value_from_the_environment_is_used_and_not_written() {
        let dir = TempDir::new().unwrap();
        let given = Given {
            key_salt: Some(SALT.to_string()),
            auth_secret: None,
        };
        let filled = open(given, &database(&dir)).unwrap();
        assert_eq!(filled.key_salt, SALT);
        let text = fs::read_to_string(secrets(&dir)).unwrap();
        assert!(!text.contains(SALT) && !text.contains(SALT_LINE));
        assert!(text.contains(&filled.auth_secret));
    }

    #[test]
    fn with_both_given_the_file_is_neither_made_nor_read() {
        let dir = TempDir::new().unwrap();
        fs::write(secrets(&dir), "not a secrets file").unwrap();
        let given = || Given {
            key_salt: Some(SALT.to_string()),
            auth_secret: Some(AUTH.to_string()),
        };
        assert!(open(given(), &database(&dir)).is_ok());
        fs::remove_file(secrets(&dir)).unwrap();
        assert!(open(given(), &database(&dir)).is_ok());
        assert!(!secrets(&dir).exists());
    }

    #[test]
    fn a_file_that_does_not_read_or_lacks_a_value_is_refused_and_kept() {
        let dir = TempDir::new().unwrap();
        let path = secrets(&dir);
        let whole = format!("{SALT_LINE}={}\n", "a".repeat(64));
        let half = format!("{SALT_LINE}={}", "a".repeat(40));
        for text in ["", "secret\n", half.as_str(), whole.as_str()] {
            fs::write(&path, text).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(PRIVATE_FILE)).unwrap();
            let line = refusal(open(none(), &database(&dir)));
            assert!(line.contains(path.to_str().unwrap()), "{line}");
            assert!(!line.contains("aaaa"), "{line}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn only_line_endings_and_blank_lines_at_the_end_are_forgiven() {
        let dir = TempDir::new().unwrap();
        let path = secrets(&dir);
        let filled = open(none(), &database(&dir)).unwrap();
        let whole = fs::read_to_string(&path).unwrap();
        let bare = whole.trim_end();
        let spread = whole.replace('\n', "\r\n");
        let write = |text: &str| {
            fs::write(&path, text).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(PRIVATE_FILE)).unwrap();
        };
        for text in [
            bare.to_string(),
            format!("{whole}\n"),
            format!("{whole}\n\n"),
            format!("{whole}\r\n"),
            spread.clone(),
            format!("{spread}\r\n"),
        ] {
            write(&text);
            let again = open(none(), &database(&dir)).unwrap();
            assert_eq!(again.key_salt, filled.key_salt, "{text:?}");
            assert_eq!(again.auth_secret, filled.auth_secret, "{text:?}");
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
        for text in [
            format!("\n{whole}"),
            whole.replacen('\n', "\n\n", 1),
            format!("{whole} \n"),
            format!("{bare}\r"),
            format!("{bare} \n"),
            "\n".to_string(),
        ] {
            write(&text);
            refusal(open(none(), &database(&dir)));
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn a_file_open_to_others_is_refused() {
        let dir = TempDir::new().unwrap();
        open(none(), &database(&dir)).unwrap();
        let path = secrets(&dir);
        for mode in [0o640, 0o604] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            let line = refusal(open(none(), &database(&dir)));
            assert!(line.contains(path.to_str().unwrap()), "{line}");
        }
    }

    #[test]
    fn a_crash_before_the_rename_leaves_a_first_start() {
        let dir = TempDir::new().unwrap();
        let temporary = dir.path().join("marfa.secrets.tmp");
        fs::write(&temporary, "api_key_sa").unwrap();
        open(none(), &database(&dir)).unwrap();
        assert!(!temporary.exists());
        assert!(open(none(), &database(&dir)).is_ok());
    }

    #[test]
    fn a_database_without_its_file_is_refused_rather_than_given_a_new_salt() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("marfa.db"), "").unwrap();
        let line = refusal(open(none(), &database(&dir)));
        assert!(line.contains("MARFA_KEY_SALT"), "{line}");
        assert!(!secrets(&dir).exists());
    }

    #[test]
    fn a_read_only_folder_refuses_a_first_start_and_serves_a_later_one() {
        let dir = TempDir::new().unwrap();
        let held = dir.path().join("held");
        fs::create_dir(&held).unwrap();
        let data = DatabasePath::File(held.join("marfa.db"));
        let private = |mode| fs::set_permissions(&held, fs::Permissions::from_mode(mode)).unwrap();

        private(0o500);
        let line = refusal(open(none(), &data));
        assert!(line.contains("could not be written"), "{line}");

        private(0o700);
        let first = open(none(), &data).unwrap();
        private(0o500);
        let second = open(none(), &data);
        private(0o700);
        assert_eq!(second.unwrap().key_salt, first.key_salt);
    }

    #[test]
    fn a_database_in_memory_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let uri = |text: &str| DatabasePath::Uri(text.replace("DIR", dir.path().to_str().unwrap()));
        for database in [
            DatabasePath::Memory,
            uri("file::memory:?cache=shared"),
            uri("file:DIR/marfa.db?mode=memory&cache=shared"),
        ] {
            let filled = open(none(), &database).unwrap();
            assert!(well_formed(&filled.key_salt), "{database:?}");
            assert!(!secrets(&dir).exists(), "{database:?}");
        }
    }

    #[test]
    fn a_database_uri_on_disk_keeps_its_file_beside_it() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("marfa.db");
        let database = DatabasePath::Uri(format!("file:{}?cache=shared", path.display()));
        open(none(), &database).unwrap();
        assert!(secrets(&dir).exists());
    }
}
