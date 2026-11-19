//! Rules that compare settings, judged on what the settings would be after a change.

use std::path::{Component, Path, PathBuf};

use super::registry::{
    ADDRESSES, ALLOW_PRIVATE_ADDRESSES, BACKUP_PATH, ERROR_REPORTING_ENABLED, HEARTBEAT_ENABLED,
    HEARTBEAT_URL, OBJECT_STORE_BUCKET, OBJECT_STORE_ENDPOINT, OBJECT_STORE_PATH_STYLE,
    OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, POSTHOG_HOST, POSTHOG_PROJECT_TOKEN, Setting, Snapshot,
    VERSION_DAILY_SNAPSHOT_DAYS, VERSION_RECENT_DAYS, VERSION_WEEKLY_SNAPSHOT_DAYS, Value,
};
use super::sealed::Secret;
use super::start::Fixed;
use crate::app::addresses::Address;
use crate::app::blobs::s3::virtual_host;
use crate::app::outbound::address::names_private_literal;

#[derive(Debug, PartialEq, Eq)]
pub struct Breach {
    pub path: &'static str,
    pub message: String,
}

pub struct Judged<'a> {
    pub before: &'a Snapshot,
    pub after: &'a Snapshot,
    pub touched: &'a [&'a str],
    pub start: &'a Fixed,
    /// None until the system chooses the port for an unstored sign-in address.
    pub sign_in: Option<Address>,
}

impl Judged<'_> {
    fn names(&self, key: &str) -> bool {
        self.touched.contains(&key)
    }
}

pub struct Together {
    pub name: &'static str,
    pub description: &'static str,
    pub keys: &'static [&'static str],
    judge: fn(&Judged) -> Vec<Breach>,
}

pub const TOGETHER: &[Together] = &[
    Together {
        name: "version_windows",
        description: "The recent, daily and weekly version windows must not shrink in that order.",
        keys: &[
            "version_recent_days",
            "version_daily_snapshot_days",
            "version_weekly_snapshot_days",
        ],
        judge: version_windows,
    },
    Together {
        name: "reporting_needs_a_receiver",
        description: "Error reporting and the heartbeat can be turned from off to on only where a receiver is set: posthog_host with posthog_project_token, and heartbeat_url.",
        keys: &[
            "error_reporting_enabled",
            "heartbeat_enabled",
            "posthog_host",
            "posthog_project_token",
            "heartbeat_url",
        ],
        judge: reporting_needs_a_receiver,
    },
    Together {
        name: "posthog_pair",
        description: "posthog_host and posthog_project_token are set together or not at all.",
        keys: &["posthog_host", "posthog_project_token"],
        judge: posthog_pair,
    },
    Together {
        name: "one_backup_destination",
        description: "Backups go to one place, so backup_path and object_store_bucket cannot both be set.",
        keys: &["backup_path", "object_store_bucket"],
        judge: one_backup_destination,
    },
    Together {
        name: "backup_path_outside_the_data",
        description: "The backup folder must be outside the data directory and the blob folder, since a backup there is lost with what it backs up.",
        keys: &["backup_path"],
        judge: backup_path_outside_the_data,
    },
    Together {
        name: "destinations_are_public",
        description: "While allow_private_addresses is false, heartbeat_url, posthog_host, otel_exporter_otlp_endpoint, otel_exporter_otlp_traces_endpoint, otel_exporter_otlp_logs_endpoint and object_store_endpoint cannot be written as a loopback, private or other address that is not public.",
        keys: &[
            "allow_private_addresses",
            "heartbeat_url",
            "posthog_host",
            "otel_exporter_otlp_endpoint",
            "otel_exporter_otlp_traces_endpoint",
            "otel_exporter_otlp_logs_endpoint",
            "object_store_endpoint",
        ],
        judge: destinations_are_public,
    },
    Together {
        name: "otlp_signal_needs_base",
        description: "otel_exporter_otlp_traces_endpoint and otel_exporter_otlp_logs_endpoint can be set only while otel_exporter_otlp_endpoint is set.",
        keys: &[
            "otel_exporter_otlp_endpoint",
            "otel_exporter_otlp_traces_endpoint",
            "otel_exporter_otlp_logs_endpoint",
        ],
        judge: otlp_signal_needs_base,
    },
    Together {
        name: "virtual_host_is_a_host",
        description: "When object_store_path_style is false and object_store_endpoint is set, the bucket goes before the endpoint's host name. Each label must have 1 to 63 characters. Bucket labels may contain only lowercase ASCII letters, digits and hyphens, with no leading or trailing hyphen. The full name may end in one dot and must fit in 253 characters excluding that dot.",
        keys: &[
            "object_store_bucket",
            "object_store_endpoint",
            "object_store_path_style",
        ],
        judge: virtual_host_is_a_host,
    },
    Together {
        name: "sign_in_is_an_address",
        description: "The sign-in address must be one of the addresses.",
        keys: &["addresses", "sign_in_address"],
        judge: sign_in_is_an_address,
    },
];

pub fn rules_of(key: &str) -> impl Iterator<Item = &'static Together> + '_ {
    TOGETHER.iter().filter(move |rule| rule.keys.contains(&key))
}

pub fn judge(
    before: &Snapshot,
    after: &Snapshot,
    touched: &[&str],
    start: &Fixed,
    sign_in: Option<Address>,
) -> Vec<Breach> {
    let judged = Judged {
        before,
        after,
        touched,
        start,
        sign_in,
    };
    TOGETHER
        .iter()
        .filter(|rule| rule.keys.iter().any(|key| judged.names(key)))
        .flat_map(|rule| (rule.judge)(&judged))
        .collect()
}

/// A write through `/config` or a restore is refused, so a seed is the only way a setting can
/// start outside a rule.
#[cfg(feature = "test-hooks")]
pub fn seed_lines(seeds: &super::registry::Seeds, start: &Fixed) -> Vec<String> {
    use std::sync::Arc;

    use super::registry;
    use crate::app::addresses::Addresses;

    let before = Snapshot::resolve(&registry::Seeds::new(), None, &[], 0);
    let after = Arc::new(Snapshot::resolve(seeds, None, &[], 0));
    let touched: Vec<&str> = seeds.keys().copied().collect();
    let known = start.port != 0 || after.get(registry::SIGN_IN_ADDRESS).is_some();
    let sign_in = known.then(|| Addresses::of(start, after.clone(), None).sign_in());
    judge(&before, &after, &touched, start, sign_in)
        .into_iter()
        .filter_map(|breach| {
            let entry = registry::entry(breach.path)?;
            let words = registry::ENTRIES
                .iter()
                .fold(breach.message, |words, other| {
                    words.replace(other.key, &other.seed_name())
                });
            let got = after.value(entry).to_json().to_string();
            Some(super::rule::line(&entry.seed_name(), &words, &got))
        })
        .collect()
}

fn version_windows(judged: &Judged) -> Vec<Breach> {
    let after = judged.after;
    let recent = after.get(VERSION_RECENT_DAYS);
    let daily = after.get(VERSION_DAILY_SNAPSHOT_DAYS);
    let weekly = after.get(VERSION_WEEKLY_SNAPSHOT_DAYS);
    let mut breaches = Vec::new();
    if daily < recent {
        breaches.push(Breach {
            path: "version_daily_snapshot_days",
            message: "must be at least version_recent_days".to_string(),
        });
    }
    if weekly < daily {
        breaches.push(Breach {
            path: "version_weekly_snapshot_days",
            message: "must be at least version_daily_snapshot_days".to_string(),
        });
    }
    breaches
}

/// Whether `key` is a reporting switch whose receiver `settings` lack.
pub fn lacks_receiver(settings: &Snapshot, key: &str) -> bool {
    match key {
        "heartbeat_enabled" => !settings.secret_set(HEARTBEAT_URL.entry),
        "error_reporting_enabled" => {
            !(settings.secret_set(POSTHOG_HOST.entry)
                && settings.secret_set(POSTHOG_PROJECT_TOKEN.entry))
        }
        _ => false,
    }
}

/// A row that must be set again counts as unset, so the other cannot be set alone.
fn posthog_pair(judged: &Judged) -> Vec<Breach> {
    let host = POSTHOG_HOST.entry.key;
    let token = POSTHOG_PROJECT_TOKEN.entry.key;
    let (set, unset) = match (
        judged.after.secret_set(POSTHOG_HOST.entry),
        judged.after.secret_set(POSTHOG_PROJECT_TOKEN.entry),
    ) {
        (true, false) => (host, token),
        (false, true) => (token, host),
        _ => return Vec::new(),
    };
    let breach = if judged.names(set) {
        Breach {
            path: set,
            message: format!("needs {unset} set too"),
        }
    } else {
        Breach {
            path: unset,
            message: format!("cannot be removed while {set} is set; remove both together"),
        }
    };
    vec![breach]
}

fn reporting_needs_a_receiver(judged: &Judged) -> Vec<Breach> {
    [HEARTBEAT_ENABLED.entry, ERROR_REPORTING_ENABLED.entry]
        .into_iter()
        .filter(|entry| {
            judged.names(entry.key)
                && *judged.after.value(entry) == Value::Boolean(true)
                && *judged.before.value(entry) != Value::Boolean(true)
                && lacks_receiver(judged.after, entry.key)
        })
        .map(|entry| Breach {
            path: entry.key,
            message: if entry.key == HEARTBEAT_ENABLED.entry.key {
                "needs heartbeat_url to be set"
            } else {
                "needs posthog_host and posthog_project_token to be set"
            }
            .to_string(),
        })
        .collect()
}

/// A secret's value never reaches the message.
fn destinations_are_public(judged: &Judged) -> Vec<Breach> {
    let after = judged.after;
    if after.get(ALLOW_PRIVATE_ADDRESSES) {
        return Vec::new();
    }
    let switch_named = judged.names(ALLOW_PRIVATE_ADDRESSES.entry.key);
    let secret = |setting: Setting<Option<Secret>>| {
        (
            setting.entry.key,
            after.get(setting).map(|url| url.expose().to_string()),
        )
    };
    [
        secret(HEARTBEAT_URL),
        secret(POSTHOG_HOST),
        secret(OTEL_EXPORTER_OTLP_ENDPOINT),
        secret(OTEL_EXPORTER_OTLP_TRACES_ENDPOINT),
        secret(OTEL_EXPORTER_OTLP_LOGS_ENDPOINT),
        (
            OBJECT_STORE_ENDPOINT.entry.key,
            after.get(OBJECT_STORE_ENDPOINT),
        ),
    ]
    .into_iter()
    .filter(|(key, url)| {
        (switch_named || judged.names(key)) && url.as_deref().is_some_and(names_private_literal)
    })
    .map(|(path, _)| Breach {
        path,
        message:
            "names an address that is not public; allow one by setting allow_private_addresses \
                  to true, from the private local command or an app signed in to within five \
                  minutes"
                .to_string(),
    })
    .collect()
}

/// A row that must be set again counts as unset. Names the signal's key, or the base's where the
/// write removes the base.
fn otlp_signal_needs_base(judged: &Judged) -> Vec<Breach> {
    let after = judged.after;
    let base = OTEL_EXPORTER_OTLP_ENDPOINT.entry;
    if after.secret_set(base) {
        return Vec::new();
    }
    let lonely: Vec<&'static str> = [
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.entry,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.entry,
    ]
    .into_iter()
    .filter(|signal| after.secret_set(signal))
    .map(|signal| signal.key)
    .collect();
    let named: Vec<&'static str> = lonely
        .iter()
        .copied()
        .filter(|key| judged.names(key))
        .collect();
    if !named.is_empty() {
        return named
            .into_iter()
            .map(|path| Breach {
                path,
                message: format!("needs {} set too", base.key),
            })
            .collect();
    }
    match lonely.first() {
        Some(signal) => vec![Breach {
            path: base.key,
            message: format!("cannot be removed while {signal} is set; remove it too"),
        }],
        None => Vec::new(),
    }
}

fn one_backup_destination(judged: &Judged) -> Vec<Breach> {
    let folder = judged.after.get(BACKUP_PATH).is_some();
    let bucket = judged.after.get(OBJECT_STORE_BUCKET).is_some();
    if !(folder && bucket) {
        return Vec::new();
    }
    let (path, other) = if judged.names(BACKUP_PATH.entry.key) {
        (BACKUP_PATH.entry.key, OBJECT_STORE_BUCKET.entry.key)
    } else {
        (OBJECT_STORE_BUCKET.entry.key, BACKUP_PATH.entry.key)
    };
    vec![Breach {
        path,
        message: format!("cannot be set while {other} is; backups go to one place"),
    }]
}

/// Names the setting at fault where the write sets it, else one the write sets.
fn virtual_host_is_a_host(judged: &Judged) -> Vec<Breach> {
    let after = judged.after;
    let (Some(bucket), Some(endpoint)) = (
        after.get(OBJECT_STORE_BUCKET),
        after.get(OBJECT_STORE_ENDPOINT),
    ) else {
        return Vec::new();
    };
    if after.get(OBJECT_STORE_PATH_STYLE) {
        return Vec::new();
    }
    let Err(why) = virtual_host(&bucket, &endpoint) else {
        return Vec::new();
    };
    let path = [
        why.key(),
        OBJECT_STORE_PATH_STYLE.entry.key,
        OBJECT_STORE_BUCKET.entry.key,
        OBJECT_STORE_ENDPOINT.entry.key,
    ]
    .into_iter()
    .find(|key| judged.names(key))
    .unwrap_or(why.key());
    vec![Breach {
        path,
        message: why.reason().to_string(),
    }]
}

/// `.` parts dropped, so a path is compared as written; links are judged where it is taken.
fn lexical(path: &Path) -> PathBuf {
    path.components()
        .filter(|part| *part != Component::CurDir)
        .collect()
}

/// The data directory and the blob folder, each as a path from the root.
pub fn kept_folders(start: &Fixed) -> Vec<(&'static str, PathBuf)> {
    let here = std::env::current_dir().unwrap_or_default();
    let data = start
        .database
        .file()
        .map(|_| ("data directory", start.database.folder()));
    data.into_iter()
        .chain([("blob folder", start.blob_path.clone())])
        .map(|(what, path)| (what, lexical(&here.join(path))))
        .collect()
}

fn backup_path_outside_the_data(judged: &Judged) -> Vec<Breach> {
    let Some(text) = judged.after.get(BACKUP_PATH) else {
        return Vec::new();
    };
    let folder = lexical(Path::new(&text));
    kept_folders(judged.start)
        .into_iter()
        .filter(|(_, kept)| folder.starts_with(kept))
        .map(|(what, kept)| Breach {
            path: BACKUP_PATH.entry.key,
            message: format!(
                "names a folder inside the {what} {}; a backup there is lost with what it backs \
                 up, so name a folder outside it, best on another disk",
                kept.display()
            ),
        })
        .take(1)
        .collect()
}

fn sign_in_is_an_address(judged: &Judged) -> Vec<Breach> {
    let Some(sign_in) = &judged.sign_in else {
        return Vec::new();
    };
    let listed = judged.after.get(ADDRESSES);
    // No list stored means the sign-in address stands alone, which is whole.
    if listed.is_empty() || listed.contains(sign_in) {
        return Vec::new();
    }
    if judged.names("sign_in_address") {
        vec![Breach {
            path: "sign_in_address",
            message: "must be one of addresses".to_string(),
        }]
    } else {
        vec![Breach {
            path: "addresses",
            message: format!("must include the sign-in address {sign_in}"),
        }]
    }
}
