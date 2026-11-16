use std::collections::HashMap;
use std::marker::PhantomData;

use serde_json::Value as Json;

#[cfg(feature = "test-hooks")]
use super::Environment;
use super::rule;
use super::sealed::{Sealer, Secret};
use crate::app::addresses::{self, Address};

#[derive(Clone, Copy, Debug)]
pub enum Rule {
    Whole {
        min: u64,
        max: u64,
    },
    Boolean,
    Address,
    Addresses,
    /// Text of at most `max` characters, or nothing.
    Text {
        max: usize,
    },
    /// An absolute http or https URL with no user name or password, or nothing.
    Endpoint,
    /// An absolute http or https URL, kept as written, or nothing.
    Url,
    /// `/`-joined segments naming a folder in an object store.
    Prefix,
    /// An absolute path with no `..` in it, or nothing.
    Folder,
}

/// Where a setting's value is kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// In the database, an archive and a backup.
    Instance,
    /// In the database only: it describes this machine or its network, so no archive carries it.
    Machine,
    /// Sealed in the database with the machine's key, never shown back, and named in an archive
    /// without its value.
    Secret,
    /// A secret that stays with this machine's settings, named in no archive.
    MachineSecret,
}

#[derive(Debug)]
pub struct Entry {
    pub key: &'static str,
    pub rule: Rule,
    pub default: &'static str,
    pub description: &'static str,
    pub keep: Keep,
}

const MOST_URL_CHARS: usize = 2048;

fn url(text: &str, bare: bool) -> Result<String, String> {
    let rule = if bare {
        "must be an absolute http or https URL with no user name or password"
    } else {
        "must be an absolute http or https URL"
    };
    if text.chars().count() > MOST_URL_CHARS {
        return Err(format!("{rule}, of at most {MOST_URL_CHARS} characters"));
    }
    let parsed = url::Url::parse(text).map_err(|_| rule.to_string())?;
    let usable = matches!(parsed.scheme(), "http" | "https")
        && parsed.host().is_some()
        && (!bare || (parsed.username().is_empty() && parsed.password().is_none()));
    if !usable {
        return Err(rule.to_string());
    }
    if !bare {
        return Ok(text.to_string());
    }
    let mut normal = parsed.to_string();
    if parsed.path() == "/" && parsed.query().is_none() && parsed.fragment().is_none() {
        normal.pop();
    }
    Ok(normal)
}

const PREFIX_RULE: &str =
    "must be /-joined segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`";

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

fn folder(text: &str) -> Result<String, String> {
    let path = std::path::Path::new(text);
    let usable = path.is_absolute()
        && !path
            .components()
            .any(|part| part == std::path::Component::ParentDir);
    if !usable {
        return Err("must be an absolute path with no `..` in it".to_string());
    }
    let mut kept = text.to_string();
    while kept.len() > 1 && kept.ends_with('/') {
        kept.pop();
    }
    Ok(kept)
}

impl Entry {
    pub fn is_secret(&self) -> bool {
        matches!(self.keep, Keep::Secret | Keep::MachineSecret)
    }

    /// Whether an archive names this setting, without its value, for a restore to ask for.
    pub fn named_without_value(&self) -> bool {
        self.keep == Keep::Secret
    }

    /// Whether a refusal must not repeat the value given: a secret, or an address that could
    /// carry a credential.
    pub fn hides_value(&self) -> bool {
        self.is_secret() || matches!(self.rule, Rule::Endpoint | Rule::Url)
    }

    /// Whether an archive carries this setting's value.
    pub fn carried(&self) -> bool {
        self.keep == Keep::Instance
    }

    fn parse(&self, text: &str) -> Result<Value, String> {
        let text_value = match self.rule {
            Rule::Whole { min, max } => {
                return rule::whole_number(text, min, max).map(Value::Whole);
            }
            Rule::Boolean => return rule::boolean(text).map(Value::Boolean),
            Rule::Address if text.is_empty() => return Ok(Value::Address(None)),
            Rule::Address => {
                return Address::parse(text).map(|address| Value::Address(Some(address)));
            }
            Rule::Addresses => return addresses::parse_list(text).map(Value::Addresses),
            _ if text.is_empty() || (!self.is_secret() && text.trim().is_empty()) => None,
            // A secret is used as written, so whitespace around it would be part of it.
            _ if self.is_secret() && text != text.trim() => {
                return Err(
                    "must have no whitespace around it, which would be part of the secret"
                        .to_string(),
                );
            }
            Rule::Text { max } => {
                let kept = if self.is_secret() { text } else { text.trim() };
                if kept.is_empty()
                    || kept.chars().count() > max
                    || kept.chars().any(char::is_control)
                {
                    return Err(format!(
                        "must be text of 1 to {max} characters, with no control characters"
                    ));
                }
                Some(kept.to_string())
            }
            Rule::Endpoint => Some(url(text.trim(), true)?),
            Rule::Url => Some(url(
                if self.is_secret() { text } else { text.trim() },
                false,
            )?),
            Rule::Prefix => Some(prefix(text.trim())?),
            Rule::Folder => Some(folder(text.trim())?),
        };
        Ok(if self.is_secret() {
            Value::Secret(text_value.map(Secret::new))
        } else {
            Value::Text(text_value)
        })
    }

    /// The text a secret's row is sealed from, judged by its rule; never for a setting that is
    /// not a secret.
    pub fn secret_text(&self, value: &Json) -> Result<Option<Secret>, String> {
        let Json::String(text) = value else {
            return Err(format!("must be {}", self.phrase()));
        };
        match self.parse(text)? {
            Value::Secret(secret) => Ok(secret),
            _ => Err("is not a secret".to_string()),
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
            Rule::Text { max } => format!("text of 1 to {max} characters, or nothing"),
            Rule::Endpoint => {
                "an http or https URL with no user name or password, or nothing".to_string()
            }
            Rule::Url => "an http or https URL, or nothing".to_string(),
            Rule::Prefix => {
                "a folder such as marfa or a/b, of letters, digits, `.`, `_` and `-`".to_string()
            }
            Rule::Folder => "an absolute path such as /srv/backups, or nothing".to_string(),
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
            (
                Rule::Text { .. } | Rule::Endpoint | Rule::Url | Rule::Prefix | Rule::Folder,
                Json::String(text),
            ) if !self.is_secret() => text.clone(),
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

    /// A blank or unreadable row counts as absent, then the seed, then the default. A secret's
    /// row opens only with `sealer`.
    fn resolve(
        &self,
        seeds: &Seeds,
        sealer: Option<&Sealer>,
        row: Option<&str>,
    ) -> (Value, Reading) {
        let read = row.filter(|text| !text.is_empty()).map(|text| {
            if self.is_secret() {
                sealer
                    .and_then(|sealer| sealer.open(self.key, text))
                    .map(|secret| Value::Secret(Some(secret)))
                    .ok_or_else(String::new)
            } else {
                self.parse(text)
            }
        });
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

    /// The value of this one setting from its stored row, as a [`Snapshot`] resolves it. A
    /// secret's row does not open here.
    pub fn resolve(self, seeds: &Seeds, row: Option<&str>) -> (T, Reading) {
        let (value, reading) = self.entry.resolve(seeds, None, row);
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
    Text(Option<String>),
    Secret(Option<Secret>),
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
            Value::Text(text) => text
                .as_ref()
                .map_or(Json::Null, |text| Json::from(text.as_str())),
            Value::Secret(_) => Json::Null,
        }
    }

    /// Whether a secret holds a value; `false` for anything else.
    pub fn is_set_secret(&self) -> bool {
        matches!(self, Value::Secret(Some(_)))
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
            Value::Text(text) => text.clone().unwrap_or_default(),
            // A secret's row is sealed by the one who writes it.
            Value::Secret(_) => String::new(),
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

impl Kind for Option<String> {
    fn from_value(value: &Value) -> Option<Option<String>> {
        match value {
            Value::Text(text) => Some(text.clone()),
            _ => None,
        }
    }
}

impl Kind for Option<Secret> {
    fn from_value(value: &Value) -> Option<Option<Secret>> {
        match value {
            Value::Secret(secret) => Some(secret.clone()),
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

macro_rules! keep {
    () => {
        Keep::Instance
    };
    ($keep:ident) => {
        Keep::$keep
    };
}

macro_rules! registry {
    ($($constant:ident: $kind:ty = $key:literal, $rule:expr, $default:literal, $description:literal $(, $keep:ident)?;)*) => {
        $(pub const $constant: Setting<$kind> = Setting {
            entry: &Entry {
                key: $key,
                rule: $rule,
                default: $default,
                description: $description,
                keep: keep!($($keep)?),
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

const UP_TO_A_DAY: Rule = Rule::Whole {
    min: 1,
    max: rule::DAY_SECONDS,
};
const UP_TO_AN_HOUR: Rule = Rule::Whole {
    min: 1,
    max: rule::HOUR_SECONDS,
};
const UP_TO_A_YEAR_OR_NONE: Rule = Rule::Whole {
    min: 0,
    max: rule::YEAR_SECONDS,
};
const BYTES: Rule = Rule::Whole {
    min: 1,
    max: rule::TERABYTE,
};
const BULK_BYTES: Rule = Rule::Whole {
    min: 1,
    max: (crate::app::archive::LINE_CAP / 2) as u64,
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
    MAX_REQUEST_BYTES: u64 = "max_request_bytes", BYTES, "1048576", "The largest request body the server accepts, in bytes. The server waits 180 seconds for a body, so a body larger than about 21 MiB can't arrive in time over a 1 Mbit/s link.";
    MAX_BULK_REQUEST_BYTES: u64 = "max_bulk_request_bytes", BULK_BYTES, "16777216", "The largest body the bulk operations accept, in bytes. A restore refuses a row larger than this. It may be set to at most 33554432, half of the 67108864 bytes a restore reads on one archive line. An export or backup refuses an item, version or edge whose line passes that limit, and names it. The server waits 180 seconds for a body, so a body larger than about 21 MiB can't arrive in time over a 1 Mbit/s link.";
    DISK_RESERVE_BYTES: u64 = "disk_reserve_bytes", BYTES_OR_NONE, "134217728", "Free disk space on the blob volume that an upload must leave, in bytes. A backup folder on a volume the server shares is held to it, and counts as on a disk of its own only when its device and its free space both differ from the server's, so a shared pool whose free space changes between two reads can look separate. Health reports the disk as degraded when the database's or the blob volume has less free than the greater of this and 64 MiB. At 0 no write is refused for room, and health still degrades below 64 MiB.";
    BLOB_MIN_COPIES: u64 = "blob_min_copies", COUNT, "1", "The fewest live copies the server keeps of each blob.";
    BLOB_CLEANUP_ENABLED: bool = "blob_cleanup_enabled", Rule::Boolean, "true", "Whether the `blob-orphans` job sweeps for blobs nothing references and purges them once they have stood in the orphan report for the grace.";
    BLOB_CLEANUP_GRACE_SECONDS: u64 = "blob_cleanup_grace_seconds", UP_TO_A_YEAR_OR_NONE, "86400", "How long a blob nothing references stands in the orphan report before a later run purges it, in seconds.";
    BACKUP_INTERVAL_SECONDS: u64 = "backup_interval_seconds", UP_TO_A_YEAR_OR_NONE, "3600", "How often the `backup` job puts a backup in the backup folder or the object store when anything it holds has changed, in seconds. 0 turns scheduled backups off.";
    BACKUP_PATH: Option<String> = "backup_path", Rule::Folder, "", "A folder the server backs itself up to and keeps a second copy of each file in, outside the data directory and the blob folder, best on another disk. The server makes only the folders inside it. It cannot be set together with object_store_bucket.", Machine;
    OBJECT_STORE_BUCKET: Option<String> = "object_store_bucket", Rule::Text { max: 255 }, "", "The bucket of an object store the server keeps a second copy of each file in and backs itself up to. Leave it empty to keep files on the disk alone.", Machine;
    OBJECT_STORE_REGION: Option<String> = "object_store_region", Rule::Text { max: 100 }, "us-east-1", "The region of the object store.", Machine;
    OBJECT_STORE_ENDPOINT: Option<String> = "object_store_endpoint", Rule::Endpoint, "", "Where the object store is, for a store other than Amazon S3. Leave it empty for Amazon S3.", Machine;
    OBJECT_STORE_PATH_STYLE: bool = "object_store_path_style", Rule::Boolean, "true", "Whether the object store at object_store_endpoint is addressed by path rather than by host. Amazon S3, with no endpoint set, is always addressed by path.", Machine;
    OBJECT_STORE_PREFIX: Option<String> = "object_store_prefix", Rule::Prefix, "marfa", "The folder in the bucket the server keeps files and backups under.", Machine;
    OBJECT_STORE_ACCESS_KEY_ID: Option<String> = "object_store_access_key_id", Rule::Text { max: 256 }, "", "The key the object store is reached with.", Machine;
    OBJECT_STORE_SECRET_ACCESS_KEY: Option<Secret> = "object_store_secret_access_key", Rule::Text { max: 4096 }, "", "The secret the object store is reached with.", MachineSecret;
    HEARTBEAT_URL: Option<Secret> = "heartbeat_url", Rule::Url, "", "Where the server sends its heartbeat, a GET request on the housekeeping schedule, so that something else can notice when the requests stop.", Secret;
    ERROR_WEBHOOK_URL: Option<Secret> = "error_webhook_url", Rule::Url, "", "Where the server posts a notice of each error it answers with a 500.", Secret;
    ALLOW_PRIVATE_ADDRESSES: bool = "allow_private_addresses", Rule::Boolean, "false", "Whether the server may send to loopback, private and other addresses that are not public: webhooks, heartbeat_url, error_webhook_url and object_store_endpoint. Only the private local command can change it.", Machine;
    RATE_LIMIT_ENABLED: bool = "rate_limit_enabled", Rule::Boolean, "true", "Whether the rate limiter is on for the requests a key or app makes, app registrations, device code requests, passkey sign-in challenges and deliveries to inbound addresses.";
    RATE_LIMIT_REQUESTS: u64 = "rate_limit_requests", COUNT, "4000", "How many requests one key or app may make in each window, across every operation.";
    RATE_LIMIT_KEYS_REQUESTS: u64 = "rate_limit_keys_requests", COUNT, "200", "How many requests one key may make in each window to the operations under `/keys`.";
    RATE_LIMIT_WINDOW_SECONDS: u64 = "rate_limit_window_seconds", UP_TO_A_DAY, "60", "How long one rate-limit window lasts, in seconds.";
    ERROR_REPORTING_ENABLED: bool = "error_reporting_enabled", Rule::Boolean, "true", "Whether the server reports its own errors to error_webhook_url and to the exception receiver set where it runs.";
    AUDIT_RETENTION_DAYS: u64 = "audit_retention_days", Rule::Whole { min: 0, max: 36_500 }, "90", "How many days the audit log is kept. 0 keeps it for ever.";
    UNAPPROVED_APP_RETENTION_HOURS: u64 = "unapproved_app_retention_hours", Rule::Whole { min: 0, max: 876_000 }, "1", "How many hours an app that registered itself and holds no grant is kept. 0 keeps it for ever.";
    REVOKED_GRANT_RETENTION_DAYS: u64 = "revoked_grant_retention_days", Rule::Whole { min: 0, max: 36_500 }, "90", "How many days a revoked app grant is kept. 0 keeps it for ever.";
    GRANT_INACTIVITY_DAYS: u64 = "grant_inactivity_days", Rule::Whole { min: 0, max: 36_500 }, "365", "How many days an app grant may go unused before it is retired. 0 never retires one.";
    TRASH_RETENTION_DAYS: u64 = "trash_retention_days", Rule::Whole { min: 0, max: 36_500 }, "60", "How many days a trashed item is kept before it is deleted. 0 keeps it for ever.";
    ROW_LOG_RETENTION_DAYS: u64 = "row_log_retention_days", Rule::Whole { min: 0, max: 36_500 }, "30", "How many days a table keeps a batch in its change log, so the batch can be undone. 0 keeps every batch.";
    EVENT_LOG_RETENTION_DAYS: u64 = "event_log_retention_days", Rule::Whole { min: 0, max: 36_500 }, "30", "How many days the event log and the kept answers to a write sent with an Idempotency-Key are kept. 0 keeps them for ever.";
    VERSION_RECENT_DAYS: u64 = "version_recent_days", Rule::Whole { min: 0, max: 36_500 }, "30", "For this many days, every version of an item is kept.";
    VERSION_DAILY_SNAPSHOT_DAYS: u64 = "version_daily_snapshot_days", Rule::Whole { min: 0, max: 36_500 }, "90", "Up to this many days, one version a day is kept.";
    VERSION_WEEKLY_SNAPSHOT_DAYS: u64 = "version_weekly_snapshot_days", Rule::Whole { min: 0, max: 36_500 }, "365", "Up to this many days, one version a week is kept.";
    VERSION_MAX_VERSIONS: u64 = "version_max_versions", COUNT, "500", "The most versions kept for one item.";
    ENRICHMENT_ENABLED: bool = "enrichment_enabled", Rule::Boolean, "true", "Whether the server reads text, sizes and lengths out of files.";
    ENRICHMENT_OCR_ENABLED: bool = "enrichment_ocr_enabled", Rule::Boolean, "true", "Whether the server reads text out of pictures with OCR. Turning it on reads again the pictures it had left.";
    ENRICHMENT_MAX_BLOB_BYTES: u64 = "enrichment_max_blob_bytes", BYTES, "20971520", "The largest file the server reads whole to extract its text, in bytes. A larger one is skipped unread. A sound or a video is read from its headers whatever its size.";
    ENRICHMENT_MAX_TEXT_CHARS: u64 = "enrichment_max_text_chars", Rule::Whole { min: 1, max: 100_000_000 }, "100000", "The most Unicode characters of extracted text the server keeps, counted as characters, not UTF-16 code units. Longer text is cut short.";
    ENRICHMENT_MAX_INFLATED_BYTES: u64 = "enrichment_max_inflated_bytes", BYTES, "67108864", "The most a document may inflate to when the server extracts its text, all of its parts together, in bytes. A document that inflates past it is skipped.";
    ENRICHMENT_MAX_MEMORY_BYTES: u64 = "enrichment_max_memory_bytes", BYTES, "1073741824", "The most memory the process that reads one file may take, in bytes. A file that needs more is skipped.";
    ENRICHMENT_MAX_ATTEMPTS: u64 = "enrichment_max_attempts", Rule::Whole { min: 1, max: 100 }, "3", "How many times the server tries to read a file that fails, or that stops the server, before it stops.";
    HEARTBEAT_ENABLED: bool = "heartbeat_enabled", Rule::Boolean, "true", "Whether the server sends a heartbeat to heartbeat_url.";
    UPDATE_CHECK_ENABLED: bool = "update_check_enabled", Rule::Boolean, "true", "Whether the server checks GitHub for new Marfa releases every few hours. When off, it makes no request for them and reports no release as newer.";
    EVENT_STREAM_MAX_VIEWERS: u64 = "event_stream_max_viewers", COUNT_OR_NONE, "0", "The most event-stream viewers one server serves at once. 0 sets no limit.";
    MCP_FETCH_ENABLED: bool = "mcp_fetch_enabled", Rule::Boolean, "true", "Whether MCP tools fetch a file from a web address, or a file a chat attached, to save it. When off, a tool asked to fetch one is refused.";
    MCP_FETCH_MAX_BYTES: u64 = "mcp_fetch_max_bytes", BYTES, "52428800", "The largest file an MCP tool fetches from a web address to save, in bytes. A larger file is refused and nothing is stored.";
    MCP_FETCH_TIMEOUT_SECONDS: u64 = "mcp_fetch_timeout_seconds", UP_TO_AN_HOUR, "60", "How long an MCP tool's fetch of a file from a web address may take, from connecting to the last byte, in seconds.";
    INBOUND_MAX_BYTES: u64 = "inbound_max_bytes", BYTES, "26214400", "The largest inbound webhook delivery the server stores, in bytes.";
    RATE_LIMIT_INBOUND_REQUESTS: u64 = "rate_limit_inbound_requests", COUNT, "600", "How many requests one inbound endpoint's address takes in each rate-limit window, whatever each is answered.";
    INBOUND_IN_FLIGHT_BYTES: u64 = "inbound_in_flight_bytes", BYTES, "104857600", "The most bytes of inbound webhook deliveries the server holds in memory at once. One source holds at most half.";
    INBOUND_BACKLOG_DELIVERIES: u64 = "inbound_backlog_deliveries", COUNT, "10000", "The unhandled deliveries one registration may hold before the server refuses more for it.";
    INBOUND_BACKLOG_BYTES: u64 = "inbound_backlog_bytes", BYTES, "1073741824", "The bytes of unhandled deliveries one registration may hold before the server refuses more for it.";
    INBOUND_RETAINED_DELIVERIES: u64 = "inbound_retained_deliveries", COUNT, "10000", "The most deliveries one registration retains across its live and retired endpoints.";
    INBOUND_RETAINED_BYTES: u64 = "inbound_retained_bytes", BYTES, "1073741824", "The most bytes of bodies, headers and queries one registration retains across its live and retired endpoints.";
    INBOUND_HANDLED_RETENTION_DAYS: u64 = "inbound_handled_retention_days", Rule::Whole { min: 0, max: 36_500 }, "7", "How many days a handled inbound delivery is kept after it was handled. 0 keeps it for ever.";
    INBOUND_PENDING_RETENTION_DAYS: u64 = "inbound_pending_retention_days", Rule::Whole { min: 0, max: 36_500 }, "30", "How many days an unhandled inbound delivery is kept after it arrived. 0 keeps it for ever.";
    ADDRESSES: Vec<Address> = "addresses", Rule::Addresses, "[]", "The addresses people reach this instance at, such as https://marfa.example.", Machine;
    CORS_ORIGINS: Vec<Address> = "cors_origins", Rule::Addresses, "[]", "The browser origins allowed to call the API across origins with a token, beside the web pages the owner approves.";
    SIGN_IN_ADDRESS: Option<Address> = "sign_in_address", Rule::Address, "", "The address people sign in at. Leave it empty to use this computer's own address.", Machine;
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
            Err(broken) if entry.hides_value() => problems.push(format!("{name} {broken}")),
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
    /// A blank or unreadable row counts as absent; unreadable keys go on `unreadable`. A secret's
    /// row opens only with `sealer`.
    pub fn resolve(
        seeds: &Seeds,
        sealer: Option<&Sealer>,
        stored: &[(String, String)],
        generation: u64,
    ) -> Snapshot {
        let mut values = HashMap::with_capacity(ENTRIES.len());
        let mut unreadable = Vec::new();
        let mut rows = HashMap::new();
        for entry in ENTRIES {
            let row = stored
                .iter()
                .find(|(key, _)| key == entry.key)
                .map(|(_, text)| text.as_str());
            let (value, reading) = entry.resolve(seeds, sealer, row);
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

    pub fn rate_limit_window_ms(&self) -> u64 {
        self.get(RATE_LIMIT_WINDOW_SECONDS) * 1_000
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

    /// The secrets stored that this machine's key cannot open, which must be set again.
    pub fn secrets_to_set(&self) -> Vec<&'static str> {
        self.unreadable
            .iter()
            .copied()
            .filter(|key| entry(key).is_some_and(Entry::is_secret))
            .collect()
    }

    /// Where a notice of a fault goes: `error_webhook_url`, while error reporting is on.
    pub fn error_notice_url(&self) -> Option<String> {
        self.get(ERROR_WEBHOOK_URL)
            .filter(|_| self.get(ERROR_REPORTING_ENABLED))
            .map(|url| url.expose().to_string())
    }

    /// Whether `entry`, a secret, holds a value now.
    pub fn secret_set(&self, entry: &Entry) -> bool {
        self.values.get(entry.key).is_some_and(Value::is_set_secret)
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
    fn the_contract_tables_only_the_settings_built_and_each_once() {
        let rows = spec_table("Stored settings");
        for (index, row) in rows.iter().enumerate() {
            let key = row[0].trim_matches('`');
            assert!(entry(key).is_some(), "{key} is tabled and not built");
            assert!(
                rows[index + 1..].iter().all(|other| other[0] != row[0]),
                "{key} is tabled twice"
            );
        }
        assert_eq!(rows.len(), ENTRIES.len());
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
    fn a_duration_a_person_sets_is_in_seconds_hours_or_days() {
        for entry in ENTRIES {
            let key = entry.key;
            let timed = ["interval", "timeout", "window", "grace"]
                .iter()
                .any(|word| key.contains(word));
            assert!(!key.ends_with("_ms"), "{key}");
            assert!(!timed || key.ends_with("_seconds"), "{key}");
        }
    }

    #[test]
    fn a_seconds_setting_is_refused_one_past_its_bound_and_taken_at_it() {
        for (setting, most) in [
            (BACKUP_INTERVAL_SECONDS.entry, rule::YEAR_SECONDS),
            (BLOB_CLEANUP_GRACE_SECONDS.entry, rule::YEAR_SECONDS),
            (RATE_LIMIT_WINDOW_SECONDS.entry, rule::DAY_SECONDS),
            (MCP_FETCH_TIMEOUT_SECONDS.entry, rule::HOUR_SECONDS),
        ] {
            assert!(setting.parse(&most.to_string()).is_ok(), "{}", setting.key);
            assert!(
                setting.parse(&(most + 1).to_string()).is_err(),
                "{}",
                setting.key
            );
        }
        for setting in [
            BACKUP_INTERVAL_SECONDS.entry,
            BLOB_CLEANUP_GRACE_SECONDS.entry,
        ] {
            assert!(setting.parse("0").is_ok(), "{}", setting.key);
        }
        for setting in [
            RATE_LIMIT_WINDOW_SECONDS.entry,
            MCP_FETCH_TIMEOUT_SECONDS.entry,
        ] {
            assert!(setting.parse("1").is_ok(), "{}", setting.key);
            assert!(setting.parse("0").is_err(), "{}", setting.key);
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
    fn untidy_text_is_kept_plain_and_blank_text_clears() {
        let text = |setting: &Entry, given: &str| setting.row_text(given);
        assert_eq!(
            text(BACKUP_PATH.entry, " /srv/backups// "),
            Ok("/srv/backups".into())
        );
        assert_eq!(text(BACKUP_PATH.entry, "/"), Ok("/".into()));
        assert!(text(BACKUP_PATH.entry, "backups").is_err());
        assert!(text(BACKUP_PATH.entry, "/srv/../etc").is_err());
        assert_eq!(
            text(OBJECT_STORE_ENDPOINT.entry, "HTTP://Store.Example/"),
            Ok("http://store.example".into())
        );
        assert!(text(OBJECT_STORE_ENDPOINT.entry, "http://k:s@store.example").is_err());
        assert_eq!(text(OBJECT_STORE_PREFIX.entry, "/a/b/"), Ok("a/b".into()));
        assert!(text(OBJECT_STORE_PREFIX.entry, "a//b").is_err());
        for blank in ["", "   ", "\t"] {
            for entry in [
                BACKUP_PATH.entry,
                OBJECT_STORE_BUCKET.entry,
                OBJECT_STORE_ENDPOINT.entry,
            ] {
                assert_eq!(text(entry, blank), Ok(String::new()), "{}", entry.key);
            }
        }
        let secret = OBJECT_STORE_SECRET_ACCESS_KEY.entry;
        assert!(secret.secret_text(&Json::from(" hush")).is_err());
        assert!(secret.secret_text(&Json::from("   ")).is_err());
        assert_eq!(secret.secret_text(&Json::from("")), Ok(None));
        assert_eq!(
            HEARTBEAT_URL
                .entry
                .secret_text(&Json::from("https://beat.example/x?token=t"))
                .map(|secret| secret.map(|secret| secret.expose().to_string())),
            Ok(Some("https://beat.example/x?token=t".into()))
        );
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
