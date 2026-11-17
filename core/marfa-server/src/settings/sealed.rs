//! The key that seals secret settings, kept in a private file beside the database and never in
//! it, so a copy of the database or a backup holds no secret it can open.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, Nonce, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::start::DatabasePath;
use crate::failure::Failure;

const FILE_NAME: &str = "marfa.settings.key";
const LINE: &str = "settings_key";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const PRIVATE_FILE: u32 = 0o600;
const SHARED_BITS: u32 = 0o077;
const SEALED: &str = "sealed:";

/// What the start found of the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    Kept,
    /// Made now: a first start, or a database whose key was lost.
    Made,
    /// The file did not read; it was set aside and a new key made.
    Replaced,
}

pub struct Sealer {
    cipher: Aes256Gcm,
    pub found: Found,
}

impl fmt::Debug for Sealer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sealer")
            .field("found", &self.found)
            .finish_non_exhaustive()
    }
}

/// A secret's value; it never prints.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(text: String) -> Secret {
        Secret(text)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

fn fresh() -> Result<[u8; KEY_BYTES], Failure> {
    let mut key = [0u8; KEY_BYTES];
    getrandom::fill(&mut key)
        .map_err(|_| Failure::start("No randomness was available to make the settings key"))?;
    Ok(key)
}

fn parse(text: &str) -> Option<[u8; KEY_BYTES]> {
    let line = text.strip_suffix('\n').unwrap_or(text);
    let line = line.strip_suffix('\r').unwrap_or(line);
    let value = line.strip_prefix(LINE)?.strip_prefix('=')?;
    let bytes = hex::decode(value).ok()?;
    bytes.try_into().ok()
}

pub(crate) fn path_of(database: &DatabasePath) -> PathBuf {
    database.folder().join(FILE_NAME)
}

fn read(path: &Path) -> Result<Option<Option<[u8; KEY_BYTES]>>, Failure> {
    let unreadable = |error: io::Error| {
        Failure::start(format!(
            "The settings key {} could not be read: {error}",
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
            "The settings key {} is open to group or others; make it private with chmod 600",
            path.display()
        )));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(unreadable)?;
    Ok(Some(std::str::from_utf8(&bytes).ok().and_then(parse)))
}

/// A crash at any step leaves no file or a whole one.
fn write(path: &Path, key: &[u8; KEY_BYTES]) -> Result<(), Failure> {
    let refused = |error: io::Error| {
        Failure::start(format!(
            "The settings key {} could not be written: {error}",
            path.display()
        ))
    };
    let folder = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(folder).map_err(refused)?;
    let temporary = path.with_extension("key.tmp");
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
    file.write_all(format!("{LINE}={}\n", hex::encode(key)).as_bytes())
        .map_err(refused)?;
    file.sync_all().map_err(refused)?;
    fs::rename(&temporary, path).map_err(refused)?;
    File::open(folder)
        .and_then(|folder| folder.sync_all())
        .map_err(refused)
}

/// Keeps a damaged file for whoever can mend it, under a name no later start reuses.
#[allow(
    clippy::disallowed_methods,
    reason = "the name must differ from any earlier start's, whatever the test clock says"
)]
fn set_aside(path: &Path) -> Result<(), Failure> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let aside = path.with_extension(format!("key.damaged-{stamp}"));
    fs::rename(path, &aside).map_err(|error| {
        Failure::start(format!(
            "The settings key {} does not read and could not be set aside: {error}",
            path.display()
        ))
    })?;
    tracing::error!(
        kept = %aside.display(),
        "The settings key did not read; it is set aside and a new one is made, so every \
         secret setting must be set again"
    );
    Ok(())
}

impl Sealer {
    fn with(key: &[u8; KEY_BYTES], found: Found) -> Result<Sealer, Failure> {
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| Failure::start("The settings key was refused"))?;
        Ok(Sealer { cipher, found })
    }

    /// Must run once the control socket's claim is held, so two starts cannot both make one.
    pub fn open_beside(database: &DatabasePath) -> Result<Sealer, Failure> {
        let Some(file) = database.file() else {
            return Sealer::with(&fresh()?, Found::Made);
        };
        let path = path_of(database);
        let found = match read(&path)? {
            Some(Some(key)) => return Sealer::with(&key, Found::Kept),
            Some(None) => {
                set_aside(&path)?;
                Found::Replaced
            }
            None => {
                if file.exists() {
                    tracing::error!(
                        "The settings key is missing beside an existing database; a new one is \
                         made, so every secret setting must be set again"
                    );
                }
                Found::Made
            }
        };
        let key = fresh()?;
        write(&path, &key)?;
        Sealer::with(&key, found)
    }

    /// Bound to the setting's key, so a sealed value cannot be moved to another setting.
    pub fn seal(&self, setting: &str, secret: &Secret) -> Option<String> {
        let mut nonce = [0u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).ok()?;
        let payload = Payload {
            msg: secret.expose().as_bytes(),
            aad: setting.as_bytes(),
        };
        let closed = self
            .cipher
            .encrypt(&Nonce::<Aes256Gcm>::try_from(&nonce[..]).ok()?, payload)
            .ok()?;
        Some(format!(
            "{SEALED}{}",
            URL_SAFE_NO_PAD.encode([&nonce[..], &closed].concat())
        ))
    }

    /// Every failure is `None`, so nothing says why a value did not open.
    pub fn open(&self, setting: &str, text: &str) -> Option<Secret> {
        let bytes = URL_SAFE_NO_PAD.decode(text.strip_prefix(SEALED)?).ok()?;
        if bytes.len() <= NONCE_BYTES {
            return None;
        }
        let (nonce, closed) = bytes.split_at(NONCE_BYTES);
        let payload = Payload {
            msg: closed,
            aad: setting.as_bytes(),
        };
        let plain = self
            .cipher
            .decrypt(&Nonce::<Aes256Gcm>::try_from(nonce).ok()?, payload)
            .ok()?;
        String::from_utf8(plain).ok().map(Secret)
    }

    #[cfg(test)]
    pub fn for_tests() -> Sealer {
        let mut key = [0u8; KEY_BYTES];
        getrandom::fill(&mut key).expect("randomness for a test key");
        Sealer::with(&key, Found::Kept).expect("a key of the right length")
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    fn database(dir: &TempDir) -> DatabasePath {
        DatabasePath::File(dir.path().join("marfa.db"))
    }

    #[test]
    fn a_first_start_makes_a_private_key_and_a_second_opens_what_the_first_sealed() {
        let dir = TempDir::new().unwrap();
        let first = Sealer::open_beside(&database(&dir)).unwrap();
        assert_eq!(first.found, Found::Made);
        let path = dir.path().join(FILE_NAME);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, PRIVATE_FILE);
        let sealed = first
            .seal(
                "object_store_secret_access_key",
                &Secret::new("hush".into()),
            )
            .unwrap();
        assert!(!sealed.contains("hush"));
        let second = Sealer::open_beside(&database(&dir)).unwrap();
        assert_eq!(second.found, Found::Kept);
        let opened = second.open("object_store_secret_access_key", &sealed);
        assert_eq!(opened.unwrap().expose(), "hush");
        assert!(second.open("heartbeat_url", &sealed).is_none());
    }

    #[test]
    fn a_lost_key_is_made_again_and_cannot_open_what_the_old_one_sealed() {
        let dir = TempDir::new().unwrap();
        let first = Sealer::open_beside(&database(&dir)).unwrap();
        let sealed = first
            .seal("heartbeat_url", &Secret::new("x".into()))
            .unwrap();
        fs::write(dir.path().join("marfa.db"), "").unwrap();
        fs::remove_file(dir.path().join(FILE_NAME)).unwrap();
        let again = Sealer::open_beside(&database(&dir)).unwrap();
        assert_eq!(again.found, Found::Made);
        assert!(again.open("heartbeat_url", &sealed).is_none());
    }

    #[test]
    fn a_damaged_key_is_set_aside_and_replaced() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, "settings_key=short\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(PRIVATE_FILE)).unwrap();
        let sealer = Sealer::open_beside(&database(&dir)).unwrap();
        assert_eq!(sealer.found, Found::Replaced);
        let kept: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with("marfa.settings.key.damaged-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert!(parse(&fs::read_to_string(&path).unwrap()).is_some());
    }

    #[test]
    fn a_key_open_to_others_refuses_the_start() {
        let dir = TempDir::new().unwrap();
        Sealer::open_beside(&database(&dir)).unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(Sealer::open_beside(&database(&dir)).is_err());
    }

    #[test]
    fn text_that_is_not_sealed_does_not_open() {
        let sealer = Sealer::for_tests();
        for text in ["", "sealed:", "sealed:AAAA", "needed", "plain secret"] {
            assert!(sealer.open("heartbeat_url", text).is_none(), "{text}");
        }
    }

    #[test]
    fn a_secret_never_prints() {
        assert_eq!(format!("{:?}", Secret::new("hush".into())), "Secret(..)");
    }
}
