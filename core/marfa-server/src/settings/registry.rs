use std::collections::HashMap;
use std::marker::PhantomData;

use serde_json::Value as Json;

#[cfg(feature = "test-hooks")]
use super::Environment;
use super::rule;
use crate::app::addresses::{self, Address};

#[derive(Clone, Copy, Debug)]
pub enum Rule {
    Whole { min: u64, max: u64 },
    Boolean,
    Address,
    Addresses,
}

#[derive(Debug)]
pub struct Entry {
    pub key: &'static str,
    pub rule: Rule,
    pub default: &'static str,
    pub description: &'static str,
}

impl Entry {
    fn parse(&self, text: &str) -> Result<Value, String> {
        match self.rule {
            Rule::Whole { min, max } => rule::whole_number(text, min, max).map(Value::Whole),
            Rule::Boolean => rule::boolean(text).map(Value::Boolean),
            Rule::Address if text.is_empty() => Ok(Value::Address(None)),
            Rule::Address => Address::parse(text).map(|address| Value::Address(Some(address))),
            Rule::Addresses => addresses::parse_list(text).map(Value::Addresses),
        }
    }

    /// The value a stored row holds, as the configuration answers it.
    pub fn row_json(&self, text: &str) -> Result<Json, String> {
        self.parse(text).map(|value| value.to_json())
    }

    /// The environment name that seeds this setting's default under test hooks.
    pub fn seed_name(&self) -> String {
        format!("MARFA_{}", self.key.to_ascii_uppercase())
    }

    pub fn row_text(&self, text: &str) -> Result<String, String> {
        self.parse(text).map(|value| value.row_text())
    }

    fn phrase(&self) -> String {
        match self.rule {
            Rule::Whole { min, max } => format!("a whole number, from {min} to {max}"),
            Rule::Boolean => "true or false".to_string(),
            Rule::Address => "an address such as https://marfa.example, or nothing".to_string(),
            Rule::Addresses => "a list of addresses such as https://marfa.example".to_string(),
        }
    }

    pub fn words(&self) -> String {
        let phrase = self.phrase();
        let mut letters = phrase.chars();
        let first = letters.next().map(|c| c.to_ascii_uppercase());
        first.into_iter().chain(letters).collect()
    }

    pub fn row_text_of_json(&self, value: &Json) -> Result<String, String> {
        let wrong_type = || format!("must be {}", self.phrase());
        let text = match (self.rule, value) {
            (Rule::Whole { .. }, Json::Number(number)) => whole_text(number),
            (Rule::Boolean, Json::Bool(flag)) => flag.to_string(),
            (Rule::Address, Json::String(text)) => text.clone(),
            (Rule::Addresses, Json::Array(items)) if items.iter().all(Json::is_string) => {
                value.to_string()
            }
            _ => return Err(wrong_type()),
        };
        self.row_text(&text)
    }

    pub fn default_json(&self) -> Json {
        self.default_value().to_json()
    }

    fn default_value(&self) -> Value {
        self.parse(self.default)
            .expect("a registered default is inside its own rule")
    }

    /// A blank or unreadable row counts as absent, then the seed, then the default.
    fn resolve(&self, seeds: &Seeds, row: Option<&str>) -> (Value, Reading) {
        let read = row
            .filter(|text| !text.is_empty())
            .map(|text| self.parse(text));
        let reading = match read {
            Some(Ok(value)) => return (value, Reading::Stored),
            Some(Err(_)) => Reading::Unreadable,
            None => Reading::Absent,
        };
        let fallback = seeds
            .get(self.key)
            .cloned()
            .unwrap_or_else(|| self.default_value());
        (fallback, reading)
    }
}

/// How a setting's stored row read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    Absent,
    Stored,
    Unreadable,
}

pub struct Setting<T: 'static> {
    pub entry: &'static Entry,
    kind: PhantomData<T>,
}

impl<T> Clone for Setting<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Setting<T> {}

impl<T: Kind> Setting<T> {
    pub fn default_value(self) -> T {
        T::from_value(&self.entry.default_value()).expect("a setting reads as its rule's kind")
    }

    /// The value of this one setting from its stored row, as a [`Snapshot`] resolves it.
    pub fn resolve(self, seeds: &Seeds, row: Option<&str>) -> (T, Reading) {
        let (value, reading) = self.entry.resolve(seeds, row);
        let value = T::from_value(&value).expect("a setting reads as its rule's kind");
        (value, reading)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Whole(u64),
    Boolean(bool),
    Address(Option<Address>),
    Addresses(Vec<Address>),
}

// Lets the rule judge a fraction or a negative as it judges text.
fn whole_text(number: &serde_json::Number) -> String {
    if let Some(whole) = number.as_u64() {
        return whole.to_string();
    }
    match number.as_f64() {
        Some(float) if float.fract() == 0.0 => format!("{float:.0}"),
        _ => number.to_string(),
    }
}

impl Value {
    pub fn to_json(&self) -> Json {
        match self {
            Value::Whole(number) => Json::from(*number),
            Value::Boolean(flag) => Json::from(*flag),
            Value::Address(address) => address
                .as_ref()
                .map_or(Json::Null, |address| Json::from(address.origin())),
            Value::Addresses(list) => {
                Json::from(list.iter().map(Address::origin).collect::<Vec<_>>())
            }
        }
    }

    fn row_text(&self) -> String {
        match self {
            Value::Whole(number) => number.to_string(),
            Value::Boolean(flag) => flag.to_string(),
            Value::Address(address) => address
                .as_ref()
                .map_or_else(String::new, |address| address.origin().to_string()),
            Value::Addresses(list) => {
                let origins: Vec<_> = list.iter().map(Address::origin).collect();
                serde_json::Value::from(origins).to_string()
            }
        }
    }
}

pub trait Kind: Sized {
    fn from_value(value: &Value) -> Option<Self>;
}

impl Kind for u64 {
    fn from_value(value: &Value) -> Option<u64> {
        match value {
            Value::Whole(number) => Some(*number),
            _ => None,
        }
    }
}

impl Kind for bool {
    fn from_value(value: &Value) -> Option<bool> {
        match value {
            Value::Boolean(flag) => Some(*flag),
            _ => None,
        }
    }
}

impl Kind for Option<Address> {
    fn from_value(value: &Value) -> Option<Option<Address>> {
        match value {
            Value::Address(address) => Some(address.clone()),
            _ => None,
        }
    }
}

impl Kind for Vec<Address> {
    fn from_value(value: &Value) -> Option<Vec<Address>> {
        match value {
            Value::Addresses(list) => Some(list.clone()),
            _ => None,
        }
    }
}

macro_rules! registry {
    ($($constant:ident: $kind:ty = $key:literal, $rule:expr, $default:literal, $description:literal;)*) => {
        $(pub const $constant: Setting<$kind> = Setting {
            entry: &Entry {
                key: $key,
                rule: $rule,
                default: $default,
                description: $description,
            },
            kind: PhantomData,
        };)*
        pub const ENTRIES: &[&Entry] = &[$($constant.entry),*];

        #[cfg(test)]
        fn each_kind_reads_its_rule() {
            $(assert!(
                <$kind as Kind>::from_value(&$constant.entry.default_value()).is_some(),
                $key,
            );)*
        }
    };
}

const INTERVAL: Rule = Rule::Whole {
    min: 1,
    max: rule::YEAR_MS,
};
const UP_TO_A_DAY: Rule = Rule::Whole {
    min: 1,
    max: rule::DAY_MS,
};
const UP_TO_AN_HOUR: Rule = Rule::Whole {
    min: 1,
    max: rule::HOUR_MS,
};
const BYTES: Rule = Rule::Whole {
    min: 1,
    max: rule::TERABYTE,
};
const BYTES_OR_NONE: Rule = Rule::Whole {
    min: 0,
    max: rule::TERABYTE,
};
const COUNT: Rule = Rule::Whole {
    min: 1,
    max: rule::MILLION,
};
const COUNT_OR_NONE: Rule = Rule::Whole {
    min: 0,
    max: rule::MILLION,
};

registry! {
    MAX_REQUEST_BYTES: u64 = "max_request_bytes", BYTES, "1048576", "The largest request body the server accepts, in bytes.";
    DISK_RESERVE_BYTES: u64 = "disk_reserve_bytes", BYTES_OR_NONE, "134217728", "Free disk space on the blob volume that an upload must leave, and below which health reports the disk as degraded, in bytes.";
    UPLOAD_IDLE_TIMEOUT_MS: u64 = "upload_idle_timeout_ms", UP_TO_A_DAY, "60000", "How long a blob upload may go without receiving a byte, in milliseconds, before the server ends it.";
    BLOB_READ_IDLE_TIMEOUT_MS: u64 = "blob_read_idle_timeout_ms", UP_TO_A_DAY, "30000", "How long a blob download may make no progress, in milliseconds, before the server closes it.";
    BLOB_MIN_COPIES: u64 = "blob_min_copies", COUNT, "1", "The fewest live copies the server keeps of each blob.";
    BLOB_REPLICATE_INTERVAL_MS: u64 = "blob_replicate_interval_ms", INTERVAL, "60000", "How often the `blob-replicate` job gives every attached store its copies, in milliseconds.";
    BLOB_REPLICATE_BATCH: u64 = "blob_replicate_batch", COUNT, "100", "The most blobs one replication run copies.";
    BLOB_REPLICATE_BATCH_BYTES: u64 = "blob_replicate_batch_bytes", BYTES, "1073741824", "The most bytes one replication run copies.";
    BLOB_INTEGRITY_INTERVAL_MS: u64 = "blob_integrity_interval_ms", INTERVAL, "3600000", "How often the `blob-integrity` job checks the copies, in milliseconds.";
    BLOB_INTEGRITY_BATCH: u64 = "blob_integrity_batch", COUNT, "500", "The most copies one integrity run checks.";
    BLOB_INTEGRITY_BATCH_BYTES: u64 = "blob_integrity_batch_bytes", BYTES, "1073741824", "The most bytes one integrity run checks.";
    BLOB_CLEANUP_INTERVAL_MS: u64 = "blob_cleanup_interval_ms", Rule::Whole { min: 0, max: rule::YEAR_MS }, "86400000", "How often the `blob-orphans` job sweeps for blobs nothing references, in milliseconds. 0 turns the sweep off.";
    BLOB_CLEANUP_GRACE_MS: u64 = "blob_cleanup_grace_ms", Rule::Whole { min: 0, max: rule::YEAR_MS }, "86400000", "How long a blob nothing references stands in the orphan report before a later run purges it, in milliseconds.";
    BACKUP_INTERVAL_MS: u64 = "backup_interval_ms", Rule::Whole { min: 0, max: rule::YEAR_MS }, "3600000", "How often the `backup` job puts a backup in the object store when anything it holds has changed, in milliseconds. 0 turns scheduled backups off.";
    RATE_LIMIT_ENABLED: bool = "rate_limit_enabled", Rule::Boolean, "true", "Whether requests made with a key, app registrations, device code requests and passkey sign-in challenges are limited.";
    RATE_LIMIT_KEYS_REQUESTS: u64 = "rate_limit_keys_requests", COUNT, "200", "How many requests one key may make in each window.";
    RATE_LIMIT_WINDOW_MS: u64 = "rate_limit_window_ms", UP_TO_A_DAY, "60000", "How long one rate-limit window lasts, in milliseconds.";
    ERROR_REPORTING_ENABLED: bool = "error_reporting_enabled", Rule::Boolean, "true", "Whether the server reports its own errors to the receiver set where it runs.";
    AUDIT_RETENTION_DAYS: u64 = "audit_retention_days", Rule::Whole { min: 0, max: 36_500 }, "90", "How many days the audit log is kept. 0 keeps it for ever.";
    DCR_CLIENT_RETENTION_DAYS: u64 = "dcr_client_retention_days", Rule::Whole { min: 0, max: 36_500 }, "1", "How many days an app that registered itself and holds no grant is kept. 0 keeps it for ever.";
    REVOKED_GRANT_RETENTION_DAYS: u64 = "revoked_grant_retention_days", Rule::Whole { min: 0, max: 36_500 }, "90", "How many days a revoked app grant is kept. 0 keeps it for ever.";
    GRANT_INACTIVITY_DAYS: u64 = "grant_inactivity_days", Rule::Whole { min: 0, max: 36_500 }, "365", "How many days an app grant may go unused before it is retired. 0 never retires one.";
    TRASH_RETENTION_DAYS: u64 = "trash_retention_days", Rule::Whole { min: 0, max: 36_500 }, "60", "How many days a trashed item is kept before it is deleted. 0 keeps it for ever.";
    EVENT_LOG_RETENTION_HOURS: u64 = "event_log_retention_hours", Rule::Whole { min: 0, max: 876_000 }, "720", "How many hours the event log is kept. 0 keeps it for ever.";
    VERSION_RECENT_DAYS: u64 = "version_recent_days", Rule::Whole { min: 0, max: 36_500 }, "30", "For this many days, every version of an item is kept.";
    VERSION_DAILY_SNAPSHOT_DAYS: u64 = "version_daily_snapshot_days", Rule::Whole { min: 0, max: 36_500 }, "90", "Up to this many days, one version a day is kept.";
    VERSION_WEEKLY_SNAPSHOT_DAYS: u64 = "version_weekly_snapshot_days", Rule::Whole { min: 0, max: 36_500 }, "365", "Up to this many days, one version a week is kept.";
    VERSION_MAX_VERSIONS: u64 = "version_max_versions", COUNT, "500", "The most versions kept for one item.";
    ENRICHMENT_ENABLED: bool = "enrichment_enabled", Rule::Boolean, "true", "Whether the server reads text, sizes and lengths out of files.";
    ENRICHMENT_OCR_ENABLED: bool = "enrichment_ocr_enabled", Rule::Boolean, "true", "Whether the server reads text out of pictures with OCR. Turning it on reads again the pictures it had left.";
    ENRICHMENT_INTERVAL_MS: u64 = "enrichment_interval_ms", INTERVAL, "30000", "How often the `enrichment-sweep` job runs, in milliseconds. A file that is added or changed brings the next run forward.";
    ENRICHMENT_BATCH_SIZE: u64 = "enrichment_batch_size", COUNT, "8", "The most files one run of the enrichment sweep reads.";
    ENRICHMENT_ITEM_TIMEOUT_MS: u64 = "enrichment_item_timeout_ms", UP_TO_A_DAY, "60000", "How long reading one file may take, in milliseconds.";
    ENRICHMENT_MAX_BLOB_BYTES: u64 = "enrichment_max_blob_bytes", BYTES, "20971520", "The largest file the server reads whole to extract its text, in bytes. A larger one is skipped unread. A sound or a video is read from its headers whatever its size.";
    ENRICHMENT_MAX_TEXT_CHARS: u64 = "enrichment_max_text_chars", Rule::Whole { min: 1, max: 100_000_000 }, "100000", "The most Unicode characters of extracted text the server keeps, counted as characters, not UTF-16 code units. Longer text is cut short.";
    ENRICHMENT_MAX_INFLATED_BYTES: u64 = "enrichment_max_inflated_bytes", BYTES, "67108864", "The most a document may inflate to when the server extracts its text, all of its parts together, in bytes. A document that inflates past it is skipped.";
    ENRICHMENT_MAX_MEMORY_BYTES: u64 = "enrichment_max_memory_bytes", BYTES, "1073741824", "The most memory the process that reads one file may take, in bytes. A file that needs more is skipped.";
    ENRICHMENT_MAX_ATTEMPTS: u64 = "enrichment_max_attempts", Rule::Whole { min: 1, max: 100 }, "3", "How many times the server tries to read a file that fails, or that stops the server, before it stops.";
    CONNECTOR_HOLD_MS: u64 = "connector_hold_ms", Rule::Whole { min: 1_000, max: rule::HOUR_MS }, "180000", "How long a connector's hold on its registration lasts after its last take or renewal, in milliseconds.";
    HEARTBEAT_ENABLED: bool = "heartbeat_enabled", Rule::Boolean, "true", "Whether the server sends a heartbeat to the receiver set where it runs.";
    HOUSEKEEPING_POLL_INTERVAL_MS: u64 = "housekeeping_poll_interval_ms", UP_TO_AN_HOUR, "1000", "How often the scheduler looks for jobs that are due, in milliseconds.";
    AUDIT_CLEANUP_INTERVAL_MS: u64 = "audit_cleanup_interval_ms", INTERVAL, "86400000", "How often the `audit-cleanup` job runs, in milliseconds.";
    AUTH_SESSION_CLEANUP_INTERVAL_MS: u64 = "auth_session_cleanup_interval_ms", INTERVAL, "3600000", "How often the `auth-session-cleanup` job runs, in milliseconds.";
    DCR_CLIENT_CLEANUP_INTERVAL_MS: u64 = "dcr_client_cleanup_interval_ms", INTERVAL, "3600000", "How often the `dcr-client-cleanup` job runs, in milliseconds.";
    SSE_MAX_VIEWERS: u64 = "sse_max_viewers", COUNT_OR_NONE, "0", "The most event-stream viewers one server serves at once. 0 sets no limit.";
    MCP_FETCH_ENABLED: bool = "mcp_fetch_enabled", Rule::Boolean, "true", "Whether MCP tools fetch a file from a web address, or a file a chat attached, to save it. When off, a tool asked to fetch one is refused.";
    MCP_FETCH_MAX_BYTES: u64 = "mcp_fetch_max_bytes", BYTES, "52428800", "The largest file an MCP tool fetches from a web address to save, in bytes. A larger file is refused and nothing is stored.";
    MCP_FETCH_TIMEOUT_MS: u64 = "mcp_fetch_timeout_ms", UP_TO_AN_HOUR, "60000", "How long an MCP tool's fetch of a file from a web address may take, from connecting to the last byte, in milliseconds.";
    EVENT_LOG_CLEANUP_INTERVAL_MS: u64 = "event_log_cleanup_interval_ms", INTERVAL, "3600000", "How often the `event-log-cleanup` job runs, in milliseconds.";
    FEED_EXPIRY_INTERVAL_MS: u64 = "feed_expiry_interval_ms", INTERVAL, "3600000", "How often the `feed-expiry` job runs, in milliseconds.";
    HEARTBEAT_INTERVAL_MS: u64 = "heartbeat_interval_ms", INTERVAL, "60000", "How often the `heartbeat` job runs, in milliseconds.";
    RATE_LIMIT_CLEANUP_INTERVAL_MS: u64 = "rate_limit_cleanup_interval_ms", INTERVAL, "3600000", "How often the `rate-limit-cleanup` job runs, in milliseconds.";
    REVOKED_KEY_REAP_INTERVAL_MS: u64 = "revoked_key_reap_interval_ms", INTERVAL, "3600000", "How often the `revoked-key-reap` job runs, in milliseconds.";
    TRASH_PURGE_INTERVAL_MS: u64 = "trash_purge_interval_ms", INTERVAL, "86400000", "How often the `trash-purge` job runs, in milliseconds.";
    VERSION_THINNING_INTERVAL_MS: u64 = "version_thinning_interval_ms", INTERVAL, "3600000", "How often the `version-thinning` job runs, in milliseconds.";
    ADDRESSES: Vec<Address> = "addresses", Rule::Addresses, "[]", "The addresses people reach this instance at, such as https://marfa.example.";
    CORS_ORIGINS: Vec<Address> = "cors_origins", Rule::Addresses, "[]", "The browser origins allowed to call the API across origins, beside the web pages the owner approves, and trusted by the sign-in forms.";
    SIGN_IN_ADDRESS: Option<Address> = "sign_in_address", Rule::Address, "", "The address people sign in at. Leave it empty to use this computer's own address.";
}

pub fn entry(key: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|entry| entry.key == key).copied()
}

pub type Seeds = HashMap<&'static str, Value>;

#[cfg(feature = "test-hooks")]
fn list_of(text: &str) -> String {
    let origins: Vec<&str> = text
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .collect();
    Json::from(origins).to_string()
}

#[cfg(feature = "test-hooks")]
pub fn seeds(environment: &Environment, problems: &mut Vec<String>) -> Seeds {
    let mut seeds = Seeds::new();
    for entry in ENTRIES {
        let name = entry.seed_name();
        let Some(text) = environment.get(&name) else {
            continue;
        };
        let read = match entry.rule {
            Rule::Addresses => entry.parse(&list_of(text)),
            _ => entry.parse(text),
        };
        match read {
            Ok(value) => {
                seeds.insert(entry.key, value);
            }
            Err(broken) => problems.push(rule::line(&name, &broken, text)),
        }
    }
    seeds
}

#[derive(Debug)]
pub struct Snapshot {
    values: HashMap<&'static str, Value>,
    stored: HashMap<&'static str, Value>,
    unreadable: Vec<&'static str>,
    generation: u64,
}

impl Snapshot {
    /// A blank or unreadable row counts as absent; unreadable keys go on `unreadable`.
    pub fn resolve(seeds: &Seeds, stored: &[(String, String)], generation: u64) -> Snapshot {
        let mut values = HashMap::with_capacity(ENTRIES.len());
        let mut unreadable = Vec::new();
        let mut rows = HashMap::new();
        for entry in ENTRIES {
            let row = stored
                .iter()
                .find(|(key, _)| key == entry.key)
                .map(|(_, text)| text.as_str());
            let (value, reading) = entry.resolve(seeds, row);
            match reading {
                Reading::Stored => {
                    rows.insert(entry.key, value.clone());
                }
                Reading::Unreadable => unreadable.push(entry.key),
                Reading::Absent => {}
            }
            values.insert(entry.key, value);
        }
        Snapshot {
            values,
            stored: rows,
            unreadable,
            generation,
        }
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub fn get<T: Kind>(&self, setting: Setting<T>) -> T {
        T::from_value(&self.values[setting.entry.key]).expect("a setting reads as its rule's kind")
    }

    pub fn stored(&self, entry: &Entry) -> Option<&Value> {
        self.stored.get(entry.key)
    }

    pub fn value(&self, entry: &Entry) -> &Value {
        &self.values[entry.key]
    }

    pub fn unreadable(&self) -> &[&'static str] {
        &self.unreadable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_is_inside_its_own_rule_and_reads_as_its_kind() {
        for entry in ENTRIES {
            assert!(entry.parse(entry.default).is_ok(), "{}", entry.key);
        }
        each_kind_reads_its_rule();
    }

    fn spec_table(heading: &str) -> Vec<Vec<String>> {
        let spec = include_str!("../../../../conformance/spec/instance.md");
        let section = spec
            .split(&format!("\n## {heading}\n"))
            .nth(1)
            .and_then(|rest| rest.split("\n## ").next())
            .expect("instance.md holds the section");
        section
            .lines()
            .filter(|line| line.starts_with("| `"))
            .map(|row| {
                row.split('|')
                    .skip(1)
                    .map(|cell| cell.trim().to_string())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn the_contract_tables_each_setting_built_with_its_default_and_bounds() {
        let rows = spec_table("Stored settings");
        for entry in ENTRIES {
            let row = rows
                .iter()
                .find(|row| row[0] == format!("`{}`", entry.key))
                .unwrap_or_else(|| panic!("{} is not tabled", entry.key));
            let default = if entry.default.is_empty() || entry.default == "[]" {
                "None".to_string()
            } else {
                format!("`{}`", entry.default)
            };
            assert!(
                row[1] == default || row[1].starts_with(&format!("{default} ")),
                "{}: default {} against {}",
                entry.key,
                entry.default,
                row[1]
            );
            if let Rule::Whole { min, max } = entry.rule {
                assert!(
                    row[2].ends_with(&format!("{min} to {max}")),
                    "{}: {}",
                    entry.key,
                    row[2]
                );
            }
        }
    }

    #[test]
    fn each_key_is_snake_case_and_unique() {
        for (index, entry) in ENTRIES.iter().enumerate() {
            let snake = entry
                .key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
            assert!(snake, "{}", entry.key);
            assert!(
                ENTRIES[index + 1..]
                    .iter()
                    .all(|other| other.key != entry.key),
                "{}",
                entry.key
            );
        }
    }

    #[test]
    fn a_row_holds_the_normalized_value() {
        let text = |setting: &Entry, given: &str| setting.row_text(given).unwrap();
        assert_eq!(text(RATE_LIMIT_ENABLED.entry, "YES"), "true");
        assert_eq!(text(MAX_REQUEST_BYTES.entry, "2048"), "2048");
        assert_eq!(
            text(SIGN_IN_ADDRESS.entry, "HTTPS://Marfa.Example:443/"),
            "https://marfa.example"
        );
        assert_eq!(text(SIGN_IN_ADDRESS.entry, ""), "");
        let list = text(
            ADDRESSES.entry,
            r#"["HTTP://A.example/","http://a.example"]"#,
        );
        assert_eq!(list, r#"["http://a.example"]"#);
        assert_eq!(text(ADDRESSES.entry, &list), list);
    }

    #[test]
    fn a_json_value_is_read_by_the_kind_its_rule_names() {
        let read = |entry: &Entry, value: Json| entry.row_text_of_json(&value);
        assert_eq!(
            read(MAX_REQUEST_BYTES.entry, Json::from(2048)),
            Ok("2048".into())
        );
        assert_eq!(
            read(MAX_REQUEST_BYTES.entry, Json::from(2048.0)),
            Ok("2048".into())
        );
        for wrong in [
            Json::from("30"),
            Json::from(1.5),
            Json::from(-1),
            Json::from(9_007_199_254_740_993_u64),
            Json::from(1e30),
            Json::Null,
        ] {
            assert!(
                read(MAX_REQUEST_BYTES.entry, wrong.clone()).is_err(),
                "{wrong}"
            );
        }
        assert!(read(RATE_LIMIT_ENABLED.entry, Json::from("true")).is_err());
        assert_eq!(
            read(RATE_LIMIT_ENABLED.entry, Json::from(false)),
            Ok("false".into())
        );
        assert!(read(ADDRESSES.entry, Json::from("https://a.example")).is_err());
        assert!(read(ADDRESSES.entry, serde_json::json!([1])).is_err());
    }
}
