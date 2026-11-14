use std::ops::Deref;
use std::path::{Component, Path, PathBuf};
use url::Url;

use super::Environment;
use super::rule;
use super::secrets::Given;
use super::tuning::Tuning;
#[cfg(feature = "test-hooks")]
use crate::app::clock::MAX_OFFSET_MS as MAX_CLOCK_OFFSET_MS;
use crate::control_socket;
use crate::listener::{self, Declaration, Trust};

const MIN_AUTH_SECRET: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DatabasePath {
    File(PathBuf),
    Uri(String),
    Memory,
}

impl DatabasePath {
    fn read(text: &str) -> DatabasePath {
        if text == ":memory:" {
            DatabasePath::Memory
        } else if text.starts_with("file:") {
            DatabasePath::Uri(text.to_string())
        } else {
            DatabasePath::File(PathBuf::from(text))
        }
    }

    /// Resolves disk paths; memory, temporary files and unsupported authorities return `None`.
    pub fn file(&self) -> Option<PathBuf> {
        match self {
            DatabasePath::File(path) => Some(path.clone()),
            DatabasePath::Uri(uri) => uri_file(uri),
            DatabasePath::Memory => None,
        }
    }

    pub fn folder(&self) -> PathBuf {
        self.file()
            .as_deref()
            .and_then(Path::parent)
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .to_path_buf()
    }
}

/// Read as SQLite's `sqlite3ParseUri` reads it, built without `SQLITE_ALLOW_URI_AUTHORITY`.
fn uri_file(uri: &str) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let rest = uri.strip_prefix("file:")?;
    let rest = match rest.strip_prefix("//") {
        Some(after) => {
            let end = after.find('/').unwrap_or(after.len());
            if !matches!(&after[..end], "" | "localhost") {
                return None;
            }
            &after[end..]
        }
        None => rest,
    };
    let rest = rest.split('#').next().unwrap_or_default();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let path = uri_decoded(path);
    let (mut mode, mut vfs) = (Vec::new(), Vec::new());
    for option in query.split('&') {
        let (key, value) = option.split_once('=').unwrap_or((option, ""));
        match uri_decoded(key).as_slice() {
            b"mode" => mode = uri_decoded(value),
            b"vfs" => vfs = uri_decoded(value),
            _ => {}
        }
    }
    let in_memory = path.is_empty() || path == b":memory:" || mode == b"memory" || vfs == b"memdb";
    (!in_memory).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&path)))
}

/// `%00` ends the part, and a `%` without two hex digits stays as it is.
fn uri_decoded(part: &str) -> Vec<u8> {
    let bytes = part.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        let escaped = (byte == b'%')
            .then(|| bytes.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .filter(|hex| hex.bytes().all(|digit| digit.is_ascii_hexdigit()))
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(0) => break,
            Some(octet) => {
                decoded.push(octet);
                at += 3;
            }
            None => {
                decoded.push(byte);
                at += 1;
            }
        }
    }
    decoded
}

pub struct Fixed {
    pub port: u16,
    pub listen_host: Option<String>,
    /// Never stored: its trust describes the network in front of this port,
    /// which a restored backup or a key with `config.manage` must not change.
    pub public_listener: Declaration,
    pub database: DatabasePath,
    pub control_socket: PathBuf,
    pub control_only: bool,
    pub test_hooks: bool,
    #[cfg(feature = "test-hooks")]
    pub clock_offset_ms: u64,
    #[cfg(feature = "test-hooks")]
    pub contract_version: Option<u32>,
    pub tuning: Tuning,
    pub max_connections: usize,
    pub max_connections_per_address: usize,
    pub blob_path: PathBuf,
    /// A folder of OCR language models read beside the ones the server carries.
    pub enrichment_tessdata_dir: Option<PathBuf>,
    /// Never stored and never logged: its address can hold a credential.
    pub heartbeat_url: Option<String>,
    /// Judged by the presence of the settings that name it, not by reachability.
    pub error_receiver: bool,
    /// Never stored: a key that may change the configuration must not reach the owner's network.
    pub webhook_private_addresses: bool,
    pub object_store: Option<ObjectStoreSettings>,
    /// The folder backups go to, which the server never creates.
    pub backup_path: Option<PathBuf>,
}

/// Never logged: the endpoint and the secret can hold credentials.
pub struct ObjectStoreSettings {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub path_style: bool,
    pub prefix: String,
}

impl ObjectStoreSettings {
    pub fn locator(&self) -> String {
        format!("s3://{}/{}", self.bucket, self.prefix)
    }
}

const PREFIX_RULE: &str = "must be /-joined segments of letters, digits, `.`, `_` and `-`, \
                           none of them `.` or `..`";

fn prefix(text: &str) -> Result<String, String> {
    let trimmed = text.trim_matches('/');
    let fits = !trimmed.is_empty()
        && trimmed.split('/').all(|segment| {
            !matches!(segment, "" | "." | "..")
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        });
    if fits {
        Ok(trimmed.to_string())
    } else {
        Err(PREFIX_RULE.to_string())
    }
}

fn absolute_folder(text: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(text);
    if path.is_absolute() && !path.components().any(|part| part == Component::ParentDir) {
        Ok(path)
    } else {
        Err("must be an absolute path with no `..` in it".to_string())
    }
}

pub struct Start {
    fixed: Fixed,
    pub key_salt: String,
    pub auth_secret: String,
}

impl Start {
    pub(super) fn new(fixed: Fixed, key_salt: String, auth_secret: String) -> Start {
        Start {
            fixed,
            key_salt,
            auth_secret,
        }
    }
}

impl Deref for Start {
    type Target = Fixed;

    fn deref(&self) -> &Fixed {
        &self.fixed
    }
}

struct Reader<'a> {
    environment: &'a Environment,
    problems: &'a mut Vec<String>,
    failed: bool,
}

impl Reader<'_> {
    fn refuse(&mut self, line: String) {
        self.problems.push(line);
        self.failed = true;
    }

    fn take<T>(&mut self, name: &str, parse: impl Fn(&str) -> Result<T, String>) -> Option<T> {
        let text = self.environment.get(name)?;
        match parse(text) {
            Ok(value) => Some(value),
            Err(rule_text) => {
                let line = rule::line(name, &rule_text, text);
                self.refuse(line);
                None
            }
        }
    }

    fn whole(&mut self, name: &str, min: u64, max: u64) -> Option<u64> {
        self.take(name, |text| rule::whole_number(text, min, max))
    }

    fn flag(&mut self, name: &str) -> bool {
        self.take(name, rule::boolean).unwrap_or(false)
    }

    fn trust(&mut self) -> Trust {
        let named = self.environment.get("MARFA_TRUSTED_PROXY_CIDRS").is_some();
        let ranges = self.take("MARFA_TRUSTED_PROXY_CIDRS", listener::proxy_ranges);
        let header = self.take("MARFA_TRUSTED_PROXY_HEADER", listener::header_name);
        match (header, ranges) {
            (Some(header), Some(ranges)) => Trust::EdgeHeader { header, ranges },
            (Some(_), None) if !named => {
                self.refuse(
                    "MARFA_TRUSTED_PROXY_HEADER is believed only from the proxies that write it; \
                     set MARFA_TRUSTED_PROXY_CIDRS to the ranges they connect from, which \
                     `marfa server install` writes, such as 127.0.0.0/8,::1/128 for a tunnel \
                     to a native server on this machine"
                        .to_string(),
                );
                Trust::Nothing
            }
            (None, Some(ranges)) => Trust::Proxies(ranges),
            _ => Trust::Nothing,
        }
    }

    fn object_store(&mut self) -> Option<ObjectStoreSettings> {
        let bucket = self.environment.get("S3_BUCKET")?.to_string();
        let endpoint = self.url_kept_private("S3_ENDPOINT").filter(|text| {
            // The object store's errors, which are logged, carry the whole endpoint.
            let bare = Url::parse(text)
                .is_ok_and(|url| url.username().is_empty() && url.password().is_none());
            if !bare {
                self.refuse(
                    "S3_ENDPOINT must not carry a user name or password; set \
                     S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY instead"
                        .to_string(),
                );
            }
            bare
        });
        let path_style = match endpoint {
            Some(_) => self
                .take("S3_FORCE_PATH_STYLE", rule::boolean)
                .unwrap_or(true),
            None => true,
        };
        let text = |name: &str| self.environment.get(name).map(str::to_string);
        let (region, access_key_id) = (text("S3_REGION"), text("S3_ACCESS_KEY_ID"));
        Some(ObjectStoreSettings {
            bucket,
            region: region.unwrap_or_else(|| "us-east-1".to_string()),
            endpoint,
            access_key_id,
            secret_access_key: self.secret("S3_SECRET_ACCESS_KEY", 1),
            path_style,
            prefix: self
                .take("S3_PREFIX", prefix)
                .unwrap_or_else(|| "marfa".to_string()),
        })
    }

    fn url_kept_private(&mut self, name: &str) -> Option<String> {
        let text = self.environment.get(name)?;
        let usable = Url::parse(text).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
        if usable {
            return Some(text.to_string());
        }
        self.refuse(format!("{name} must be an absolute http or https URL"));
        None
    }

    /// A secret is used as written, so whitespace around it would be part of
    /// it, and its value never reaches a refusal.
    fn secret(&mut self, name: &str, min_length: usize) -> Option<String> {
        let text = self.environment.get(name)?;
        if text != text.trim() {
            self.refuse(format!(
                "{name} has whitespace around it, which would be part of the secret; remove it"
            ));
            return None;
        }
        if text.chars().count() < min_length {
            self.refuse(format!(
                "{name} must be at least {min_length} characters; generate one with \
                 `openssl rand -hex {min_length}`"
            ));
            return None;
        }
        Some(text.to_string())
    }
}

/// A server built without test hooks cannot run them, so it will not start asking for any.
#[cfg(not(feature = "test-hooks"))]
fn refuse_hooks(reader: &mut Reader) {
    const NAMES: [&str; 4] = [
        "MARFA_TEST_HOOKS",
        "MARFA_TEST_CLOCK_OFFSET_MS",
        "MARFA_TEST_CONTRACT_VERSION",
        "MARFA_TEST_TUNING",
    ];
    for name in NAMES {
        let Some(text) = reader.environment.get(name) else {
            continue;
        };
        let off = name == "MARFA_TEST_HOOKS" && !rule::boolean(text).unwrap_or(false);
        if !off {
            let line = rule::line(
                name,
                "cannot be used: this server was built without test hooks",
                text,
            );
            reader.refuse(line);
        }
    }
}

impl Fixed {
    #[cfg(feature = "test-hooks")]
    pub(super) fn hooks_on(environment: &Environment) -> bool {
        environment
            .get("MARFA_TEST_HOOKS")
            .is_some_and(|text| rule::boolean(text).unwrap_or(false))
    }

    pub(super) fn read(
        environment: &Environment,
        problems: &mut Vec<String>,
    ) -> Option<(Fixed, Given)> {
        let mut reader = Reader {
            environment,
            problems,
            failed: false,
        };
        let port = reader.whole("MARFA_PORT", 0, 65_535).unwrap_or(8600) as u16;
        let trust = reader.trust();
        let control_only = reader.flag("MARFA_CONTROL_ONLY");
        let test_hooks = reader.flag("MARFA_TEST_HOOKS");
        let webhook_private_addresses = reader.flag("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES");
        #[cfg(feature = "test-hooks")]
        let clock_offset_ms = reader
            .whole("MARFA_TEST_CLOCK_OFFSET_MS", 0, MAX_CLOCK_OFFSET_MS)
            .unwrap_or(0);
        #[cfg(feature = "test-hooks")]
        let contract_version = reader
            .whole("MARFA_TEST_CONTRACT_VERSION", 0, rule::MILLION)
            .map(|version| version as u32);
        #[cfg(not(feature = "test-hooks"))]
        refuse_hooks(&mut reader);
        #[cfg(feature = "test-hooks")]
        let tuning = reader
            .take("MARFA_TEST_TUNING", |text| {
                Tuning::read(text, &crate::app::housekeeping::job_names())
            })
            .unwrap_or_default();
        #[cfg(not(feature = "test-hooks"))]
        let tuning = Tuning::default();
        let max_connections = reader
            .whole("MARFA_MAX_CONNECTIONS", 1, rule::MILLION)
            .unwrap_or(1_024) as usize;
        let max_connections_per_address = reader
            .whole("MARFA_MAX_CONNECTIONS_PER_ADDRESS", 1, rule::MILLION)
            .unwrap_or(256) as usize;
        let given = Given {
            key_salt: reader.secret("MARFA_KEY_SALT", 1),
            auth_secret: reader.secret("MARFA_AUTH_SECRET", MIN_AUTH_SECRET),
        };

        let heartbeat_url = reader.url_kept_private("MARFA_HEARTBEAT_URL");
        let object_store = reader.object_store();
        let backup_path = reader.take("MARFA_BACKUP_PATH", absolute_folder);
        if object_store.is_some() && backup_path.is_some() {
            reader.refuse(
                "S3_BUCKET and MARFA_BACKUP_PATH are both set; backups go to one place, so set \
                 only one of them"
                    .to_string(),
            );
        }
        let database = DatabasePath::read(
            environment
                .get("MARFA_DATABASE_PATH")
                .unwrap_or("./data/marfa.db"),
        );
        let control_socket = environment
            .get("MARFA_CONTROL_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| control_socket::default_path(&database.folder()));
        let failed = reader.failed;
        let fixed = Fixed {
            port,
            listen_host: environment.get("MARFA_LISTEN_HOST").map(str::to_string),
            public_listener: Declaration::public(trust),
            database,
            control_socket,
            control_only,
            test_hooks,
            #[cfg(feature = "test-hooks")]
            clock_offset_ms,
            #[cfg(feature = "test-hooks")]
            contract_version,
            tuning,
            max_connections,
            max_connections_per_address,
            blob_path: PathBuf::from(environment.get("MARFA_BLOB_PATH").unwrap_or("./data/blobs")),
            enrichment_tessdata_dir: environment
                .get("MARFA_ENRICHMENT_TESSDATA_DIR")
                .filter(|folder| !folder.is_empty())
                .map(PathBuf::from),
            heartbeat_url,
            error_receiver: environment.get("MARFA_ERROR_WEBHOOK_URL").is_some()
                || (environment.get("MARFA_POSTHOG_HOST").is_some()
                    && environment.get("MARFA_POSTHOG_PROJECT_TOKEN").is_some()),
            webhook_private_addresses,
            object_store,
            backup_path,
        };
        (!failed).then_some((fixed, given))
    }

    #[cfg(feature = "test-hooks")]
    pub(super) fn check_together(&self, environment: &Environment, problems: &mut Vec<String>) {
        if !self.test_hooks {
            let hooked = |name: &'static str| environment.get(name).map(|value| (name, value));
            let offset = hooked("MARFA_TEST_CLOCK_OFFSET_MS").filter(|_| self.clock_offset_ms > 0);
            let contract = hooked("MARFA_TEST_CONTRACT_VERSION");
            let tuning = hooked("MARFA_TEST_TUNING");
            for (name, value) in offset.into_iter().chain(contract).chain(tuning) {
                problems.push(rule::line(name, "needs MARFA_TEST_HOOKS to be true", value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, OpenFlags};

    use super::*;

    #[test]
    fn a_file_uri_names_the_file_sqlite_opens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs_folder(&dir, "uri data");
        for (uri, name) in [
            (format!("file:{root}/uri%20data/a.db"), "uri data/a.db"),
            (
                format!("file://localhost{root}/b%2Edb?cache=shared"),
                "b.db",
            ),
            (format!("file://{root}/c.db%3Fx#y"), "c.db?x"),
            (format!("file:{root}/d.db%00ignored?mode=rwc"), "d.db"),
            (format!("file:{root}/e%zz.db"), "e%zz.db"),
        ] {
            let flags = OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE;
            let conn = Connection::open_with_flags(&uri, flags).unwrap();
            conn.execute_batch("CREATE TABLE t (x)").unwrap();
            let expected = dir.path().join(name);
            assert!(expected.is_file(), "{uri}");
            assert_eq!(DatabasePath::read(&uri).file(), Some(expected), "{uri}");
        }
        for uri in [
            "file::memory:",
            "file:",
            &format!("file:{root}/f.db?mode=memory"),
            &format!("file:{root}/f.db?vfs=memdb"),
            &format!("file:{root}/f.db?mod%65=memory"),
            "file://elsewhere/g.db",
        ] {
            assert_eq!(DatabasePath::read(uri).file(), None, "{uri}");
        }
    }

    fn fs_folder(dir: &tempfile::TempDir, name: &str) {
        std::fs::create_dir(dir.path().join(name)).unwrap();
    }
}
