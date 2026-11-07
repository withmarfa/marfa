use std::path::{Path, PathBuf};
use std::time::Duration;

use super::Environment;
use super::rule;

const MAX_CLOCK_OFFSET_MS: u64 = 3_153_600_000_000;
const MAX_I32: u64 = 2_147_483_647;
const MIN_AUTH_SECRET: usize = 32;
const LOCAL_SALT: &str = "marfa-local-key-salt";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeEnv {
    Production,
    Development,
    Test,
}

/// Where the database lives, as `SQLITE_PATH` names it.
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

    /// The folder the database's files sit in.
    pub fn folder(&self) -> PathBuf {
        let beside = |path: &Path| {
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."))
                .to_path_buf()
        };
        match self {
            DatabasePath::File(path) => beside(path),
            DatabasePath::Uri(uri) => {
                let path = uri.trim_start_matches("file:");
                beside(Path::new(path.split('?').next().unwrap_or(path)))
            }
            DatabasePath::Memory => PathBuf::from("."),
        }
    }
}

/// Everything fixed when the process starts.
pub struct Start {
    pub node_env: NodeEnv,
    pub port: u16,
    pub listen_host: Option<String>,
    pub database: DatabasePath,
    pub control_socket: PathBuf,
    pub control_only: bool,
    pub test_hooks: bool,
    pub clock_offset_ms: u64,
    pub contract_version: Option<u32>,
    pub migration_fault: Option<MigrationFault>,
    pub free_disk_bytes: Option<u64>,
    pub busy_budget: Duration,
    pub blob_path: PathBuf,
    pub api_key_salt: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationFault {
    Hold,
    LoseRow,
    ChangeShape,
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

impl Start {
    /// Reads every setting, adding a line for each one outside its rule.
    pub(super) fn read(environment: &Environment, problems: &mut Vec<String>) -> Option<Start> {
        let mut reader = Reader {
            environment,
            problems,
            failed: false,
        };
        let node_env = reader
            .take("NODE_ENV", |text| {
                rule::one_of(text, &["production", "development", "test"]).map(|name| match name {
                    "production" => NodeEnv::Production,
                    "test" => NodeEnv::Test,
                    _ => NodeEnv::Development,
                })
            })
            .unwrap_or(NodeEnv::Development);
        let port = reader.whole("PORT", 0, 65_535).unwrap_or(8600) as u16;
        let control_only = reader.flag("MARFA_CONTROL_ONLY");
        let test_hooks = reader.flag("MARFA_TEST_HOOKS");
        let clock_offset_ms = reader
            .whole("MARFA_TEST_CLOCK_OFFSET_MS", 0, MAX_CLOCK_OFFSET_MS)
            .unwrap_or(0);
        let contract_version = reader
            .whole("MARFA_TEST_CONTRACT_VERSION", 0, MAX_I32)
            .map(|version| version as u32);
        let migration_fault = reader.take("MARFA_TEST_MIGRATION_FAULT", |text| {
            rule::one_of(text, &["hold", "lose-row", "change-shape"]).map(|name| match name {
                "hold" => MigrationFault::Hold,
                "lose-row" => MigrationFault::LoseRow,
                _ => MigrationFault::ChangeShape,
            })
        });
        let free_disk_bytes = reader.whole("MARFA_TEST_FREE_DISK_BYTES", 0, u64::MAX);
        let busy_budget = reader
            .whole("SQLITE_BUSY_BUDGET_MS", 0, MAX_I32)
            .unwrap_or(5_000);
        let salt = reader.secret("API_KEY_SALT", 1);
        reader.secret("MARFA_AUTH_SECRET", MIN_AUTH_SECRET);

        let database =
            DatabasePath::read(environment.get("SQLITE_PATH").unwrap_or("./data/marfa.db"));
        let control_socket = environment
            .get("MARFA_CONTROL_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| database.folder().join("control").join("marfa.sock"));
        let failed = reader.failed;
        (!failed).then(|| Start {
            node_env,
            port,
            listen_host: environment.get("MARFA_LISTEN_HOST").map(str::to_string),
            database,
            control_socket,
            control_only,
            test_hooks,
            clock_offset_ms,
            contract_version,
            migration_fault,
            free_disk_bytes,
            busy_budget: Duration::from_millis(busy_budget),
            blob_path: PathBuf::from(environment.get("BLOB_PATH").unwrap_or("./data/blobs")),
            api_key_salt: salt.unwrap_or_else(|| LOCAL_SALT.to_string()),
        })
    }

    /// The rules that compare settings or hold only in production, once every
    /// setting has parsed.
    pub(super) fn check_together(&self, environment: &Environment, problems: &mut Vec<String>) {
        if !self.test_hooks {
            let hooked = |name: &'static str| environment.get(name).map(|value| (name, value));
            let offset = hooked("MARFA_TEST_CLOCK_OFFSET_MS").filter(|_| self.clock_offset_ms > 0);
            let others = [
                "MARFA_TEST_CONTRACT_VERSION",
                "MARFA_TEST_MIGRATION_FAULT",
                "MARFA_TEST_FREE_DISK_BYTES",
            ];
            for (name, value) in offset
                .into_iter()
                .chain(others.into_iter().filter_map(hooked))
            {
                problems.push(rule::line(name, "needs MARFA_TEST_HOOKS to be true", value));
            }
        }
        if self.node_env == NodeEnv::Production {
            if self.test_hooks {
                problems.push("MARFA_TEST_HOOKS must not be true in production".to_string());
            }
            for name in ["API_KEY_SALT", "MARFA_AUTH_SECRET", "MARFA_AUTH_BASE_URL"] {
                if environment.get(name).is_none() {
                    problems.push(format!("{name} is required in production"));
                }
            }
        }
    }
}
