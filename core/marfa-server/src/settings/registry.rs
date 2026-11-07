//! The settings that can change while the server runs. An entry here is all a
//! new one needs: it resolves from its stored row, then its default, and reads
//! back typed from the snapshot.

use std::collections::HashMap;
use std::marker::PhantomData;

use super::Environment;
use super::rule;
use crate::app::addresses::{self, Address};

#[derive(Clone, Copy, Debug)]
pub enum Rule {
    Whole {
        min: u64,
        max: u64,
    },
    Boolean,
    Text,
    /// One origin, or nothing when blank.
    Address,
    /// A JSON array of origins.
    Addresses,
}

/// One setting. Its `key` is its row in the `settings` table and its field in
/// `/config`.
#[derive(Debug)]
pub struct Entry {
    pub key: &'static str,
    /// What the contract's fixtures set it by. Only test hooks read this name.
    pub test_name: Option<&'static str>,
    pub rule: Rule,
    pub default: &'static str,
}

impl Entry {
    fn parse(&self, text: &str) -> Result<Value, String> {
        match self.rule {
            Rule::Whole { min, max } => rule::whole_number(text, min, max).map(Value::Whole),
            Rule::Boolean => rule::boolean(text).map(Value::Boolean),
            Rule::Text => Ok(Value::Text(text.to_string())),
            Rule::Address if text.is_empty() => Ok(Value::Address(None)),
            Rule::Address => Address::parse(text).map(|address| Value::Address(Some(address))),
            Rule::Addresses => addresses::parse_list(text).map(Value::Addresses),
        }
    }

    /// The text a row holds for a value this setting accepts: blank when it
    /// means nothing, and otherwise normalized.
    pub fn row_text(&self, text: &str) -> Result<String, String> {
        self.parse(text).map(|value| value.row_text())
    }

    fn default_value(&self) -> Value {
        self.parse(self.default)
            .expect("a registered default is inside its own rule")
    }
}

/// A registered setting, typed by what it reads as.
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Whole(u64),
    Boolean(bool),
    Text(String),
    Address(Option<Address>),
    Addresses(Vec<Address>),
}

impl Value {
    fn row_text(&self) -> String {
        match self {
            Value::Whole(number) => number.to_string(),
            Value::Boolean(flag) => flag.to_string(),
            Value::Text(text) => text.clone(),
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

/// What a typed setting reads a resolved value as.
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

impl Kind for String {
    fn from_value(value: &Value) -> Option<String> {
        match value {
            Value::Text(text) => Some(text.clone()),
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
    ($($constant:ident: $kind:ty = $key:literal, $test_name:expr, $rule:expr, $default:literal;)*) => {
        $(pub const $constant: Setting<$kind> = Setting {
            entry: &Entry { key: $key, test_name: $test_name, rule: $rule, default: $default },
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

registry! {
    MAX_REQUEST_BYTES: u64 = "max_request_bytes", Some("MARFA_MAX_REQUEST_BYTES"), Rule::Whole { min: 1, max: u64::MAX }, "1048576";
    DISK_RESERVE_BYTES: u64 = "disk_reserve_bytes", Some("MARFA_DISK_RESERVE_BYTES"), Rule::Whole { min: 0, max: u64::MAX }, "134217728";
    RATE_LIMIT_ENABLED: bool = "rate_limit_enabled", Some("RATE_LIMIT_ENABLED"), Rule::Boolean, "true";
    RATE_LIMIT_KEYS_REQUESTS: u64 = "rate_limit_keys_requests", Some("RATE_LIMIT_KEYS_REQUESTS"), Rule::Whole { min: 1, max: u64::MAX }, "200";
    RATE_LIMIT_WINDOW_MS: u64 = "rate_limit_window_ms", Some("RATE_LIMIT_WINDOW_MS"), Rule::Whole { min: 1, max: u64::MAX }, "60000";
    ERROR_REPORTING_ENABLED: bool = "error_reporting_enabled", Some("MARFA_ERROR_REPORTING_ENABLED"), Rule::Boolean, "true";
    AUDIT_RETENTION_DAYS: u64 = "audit_retention_days", Some("AUDIT_RETENTION_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "90";
    DCR_CLIENT_RETENTION_DAYS: u64 = "dcr_client_retention_days", Some("MARFA_DCR_CLIENT_RETENTION_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "1";
    REVOKED_GRANT_RETENTION_DAYS: u64 = "revoked_grant_retention_days", Some("MARFA_REVOKED_GRANT_RETENTION_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "90";
    GRANT_INACTIVITY_DAYS: u64 = "grant_inactivity_days", Some("MARFA_GRANT_INACTIVITY_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "365";
    TRASH_RETENTION_DAYS: u64 = "trash_retention_days", Some("TRASH_RETENTION_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "60";
    EVENT_LOG_RETENTION_HOURS: u64 = "event_log_retention_hours", Some("MARFA_EVENT_LOG_RETENTION_HOURS"), Rule::Whole { min: 0, max: 876_000 }, "720";
    VERSION_RECENT_DAYS: u64 = "version_recent_days", Some("VERSION_RECENT_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "30";
    VERSION_DAILY_SNAPSHOT_DAYS: u64 = "version_daily_snapshot_days", Some("VERSION_DAILY_SNAPSHOT_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "90";
    VERSION_WEEKLY_SNAPSHOT_DAYS: u64 = "version_weekly_snapshot_days", Some("VERSION_WEEKLY_SNAPSHOT_DAYS"), Rule::Whole { min: 0, max: 36_500 }, "365";
    VERSION_MAX_VERSIONS: u64 = "version_max_versions", Some("VERSION_MAX_VERSIONS"), Rule::Whole { min: 1, max: u64::MAX }, "500";
    HEARTBEAT_ENABLED: bool = "heartbeat_enabled", Some("MARFA_HEARTBEAT_ENABLED"), Rule::Boolean, "true";
    ADDRESSES: Vec<Address> = "addresses", None, Rule::Addresses, "[]";
    SIGN_IN_ADDRESS: Option<Address> = "sign_in_address", Some("MARFA_AUTH_BASE_URL"), Rule::Address, "";
}

/// The entry a key names.
pub fn entry(key: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|entry| entry.key == key).copied()
}

/// What replaces a default under test hooks, by key.
pub type Seeds = HashMap<&'static str, Value>;

/// Reads each entry's test name, adding a line for a value outside its rule.
pub fn seeds(environment: &Environment, problems: &mut Vec<String>) -> Seeds {
    let mut seeds = Seeds::new();
    for entry in ENTRIES {
        let Some((name, text)) = entry
            .test_name
            .and_then(|name| environment.get(name).map(|text| (name, text)))
        else {
            continue;
        };
        match entry.parse(text) {
            Ok(value) => {
                seeds.insert(entry.key, value);
            }
            Err(broken) => problems.push(rule::line(name, &broken, text)),
        }
    }
    seeds
}

/// Every setting's value at one moment.
#[derive(Debug)]
pub struct Snapshot {
    values: HashMap<&'static str, Value>,
    unreadable: Vec<&'static str>,
    generation: u64,
}

impl Snapshot {
    /// Resolves each entry from its row, then its seed, then its default. A
    /// blank row counts as absent, as a blank environment value does. A row
    /// that does not read also counts as absent and goes on `unreadable`, and
    /// a row with no entry is left alone.
    pub fn resolve(seeds: &Seeds, stored: &[(String, String)], generation: u64) -> Snapshot {
        let mut values = HashMap::with_capacity(ENTRIES.len());
        let mut unreadable = Vec::new();
        for entry in ENTRIES {
            let row = stored
                .iter()
                .find(|(key, text)| key == entry.key && !text.is_empty())
                .map(|(_, text)| entry.parse(text));
            let value = match row {
                Some(Ok(value)) => value,
                absent => {
                    if matches!(absent, Some(Err(_))) {
                        unreadable.push(entry.key);
                    }
                    seeds
                        .get(entry.key)
                        .cloned()
                        .unwrap_or_else(|| entry.default_value())
                }
            };
            values.insert(entry.key, value);
        }
        Snapshot {
            values,
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

    /// The keys whose stored row does not read.
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
    fn text_reads_as_written() {
        let entry = Entry {
            key: "region",
            test_name: None,
            rule: Rule::Text,
            default: "",
        };
        assert_eq!(
            entry
                .parse("eu west")
                .as_ref()
                .ok()
                .and_then(String::from_value),
            Some("eu west".to_string())
        );
    }
}
