use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::time::Duration;

use url::Url;

use super::Environment;
use super::rule;
use super::secrets::Given;
use crate::control_socket;
use crate::listener::{self, Declaration, Trust};

const MAX_CLOCK_OFFSET_MS: u64 = 3_153_600_000_000;
const MAX_I32: u64 = 2_147_483_647;
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

    pub fn file(&self) -> Option<PathBuf> {
        match self {
            DatabasePath::File(path) => Some(path.clone()),
            DatabasePath::Uri(uri) => {
                let uri = uri.trim_start_matches("file:");
                let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
                let in_memory = path.is_empty()
                    || path == ":memory:"
                    || query
                        .split('&')
                        .any(|option| option == "mode=memory" || option == "vfs=memdb");
                (!in_memory).then(|| PathBuf::from(path))
            }
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
    pub clock_offset_ms: u64,
    pub contract_version: Option<u32>,
    pub busy_budget: Duration,
    pub blob_path: PathBuf,
    /// Never stored and never logged: its address can hold a credential.
    pub heartbeat_url: Option<String>,
    /// Judged by the presence of the settings that name it, not by reachability.
    pub error_receiver: bool,
    /// Never stored: a key that may change the configuration must not reach the owner's network.
    pub webhook_private_addresses: bool,
}

pub struct Start {
    fixed: Fixed,
    pub api_key_salt: String,
    pub auth_secret: String,
}

impl Start {
    pub(super) fn new(fixed: Fixed, api_key_salt: String, auth_secret: String) -> Start {
        Start {
            fixed,
            api_key_salt,
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
        let ranges = self.take("TRUSTED_PROXY_CIDRS", listener::proxy_ranges);
        let header = self.take("TRUSTED_PROXY_HEADER", listener::header_name);
        match (header, ranges) {
            (Some(header), Some(ranges)) => Trust::EdgeHeaderFrom { header, ranges },
            (Some(header), None) => Trust::EdgeHeader(header),
            (None, Some(ranges)) => Trust::Proxies(ranges),
            (None, None) => Trust::Nothing,
        }
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

impl Fixed {
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
        let port = reader.whole("PORT", 0, 65_535).unwrap_or(8600) as u16;
        let trust = reader.trust();
        let control_only = reader.flag("MARFA_CONTROL_ONLY");
        let test_hooks = reader.flag("MARFA_TEST_HOOKS");
        let webhook_private_addresses = reader.flag("MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES");
        let clock_offset_ms = reader
            .whole("MARFA_TEST_CLOCK_OFFSET_MS", 0, MAX_CLOCK_OFFSET_MS)
            .unwrap_or(0);
        let contract_version = reader
            .whole("MARFA_TEST_CONTRACT_VERSION", 0, MAX_I32)
            .map(|version| version as u32);
        let busy_budget = reader
            .whole("SQLITE_BUSY_BUDGET_MS", 0, MAX_I32)
            .unwrap_or(5_000);
        let given = Given {
            api_key_salt: reader.secret("API_KEY_SALT", 1),
            auth_secret: reader.secret("MARFA_AUTH_SECRET", MIN_AUTH_SECRET),
        };

        let heartbeat_url = reader.url_kept_private("MARFA_HEARTBEAT_URL");
        let database =
            DatabasePath::read(environment.get("SQLITE_PATH").unwrap_or("./data/marfa.db"));
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
            clock_offset_ms,
            contract_version,
            busy_budget: Duration::from_millis(busy_budget),
            blob_path: PathBuf::from(environment.get("BLOB_PATH").unwrap_or("./data/blobs")),
            heartbeat_url,
            error_receiver: environment.get("ERROR_WEBHOOK_URL").is_some()
                || (environment.get("MARFA_POSTHOG_HOST").is_some()
                    && environment.get("MARFA_POSTHOG_PROJECT_TOKEN").is_some()),
            webhook_private_addresses,
        };
        (!failed).then_some((fixed, given))
    }

    pub(super) fn check_together(&self, environment: &Environment, problems: &mut Vec<String>) {
        if !self.test_hooks {
            let hooked = |name: &'static str| environment.get(name).map(|value| (name, value));
            let offset = hooked("MARFA_TEST_CLOCK_OFFSET_MS").filter(|_| self.clock_offset_ms > 0);
            let contract = hooked("MARFA_TEST_CONTRACT_VERSION");
            for (name, value) in offset.into_iter().chain(contract) {
                problems.push(rule::line(name, "needs MARFA_TEST_HOOKS to be true", value));
            }
        }
    }
}
