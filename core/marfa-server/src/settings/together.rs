//! Rules that compare settings with one another. Each is judged on what the settings would
//! be after a change, defaults a clear exposes included, and is registered once so a write
//! through `/config` and the listing read the same list.

use super::registry::{
    self, ADDRESSES, ERROR_REPORTING_ENABLED, HEARTBEAT_ENABLED, SIGN_IN_ADDRESS, Snapshot,
    VERSION_DAILY_SNAPSHOT_DAYS, VERSION_RECENT_DAYS, VERSION_WEEKLY_SNAPSHOT_DAYS, Value,
};
use super::start::Fixed;

#[derive(Debug, PartialEq, Eq)]
pub struct Breach {
    pub path: &'static str,
    pub message: String,
}

pub struct Judged<'a> {
    pub after: &'a Snapshot,
    pub touched: &'a [&'a str],
    pub start: &'a Fixed,
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
        description: "Error reporting and the heartbeat can be turned on only where a receiver is set.",
        keys: &["error_reporting_enabled", "heartbeat_enabled"],
        judge: reporting_needs_a_receiver,
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

pub fn judge(after: &Snapshot, touched: &[&str], start: &Fixed) -> Vec<Breach> {
    let judged = Judged {
        after,
        touched,
        start,
    };
    TOGETHER
        .iter()
        .filter(|rule| rule.keys.iter().any(|key| judged.names(key)))
        .flat_map(|rule| (rule.judge)(&judged))
        .collect()
}

/// A write through `/config` is refused, so a seed is the only way a setting can start
/// outside a rule.
#[cfg(feature = "test-hooks")]
pub fn seed_lines(seeds: &registry::Seeds, start: &Fixed) -> Vec<String> {
    let after = Snapshot::resolve(seeds, &[], 0);
    let touched: Vec<&str> = seeds.keys().copied().collect();
    judge(&after, &touched, start)
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

fn reporting_needs_a_receiver(judged: &Judged) -> Vec<Breach> {
    let on = |entry: &registry::Entry| {
        judged.names(entry.key) && judged.after.stored(entry) == Some(&Value::Boolean(true))
    };
    let mut breaches = Vec::new();
    if on(HEARTBEAT_ENABLED.entry) && judged.start.heartbeat_url.is_none() {
        breaches.push(Breach {
            path: "heartbeat_enabled",
            message: "needs a heartbeat receiver configured where Marfa runs".to_string(),
        });
    }
    if on(ERROR_REPORTING_ENABLED.entry) && !judged.start.error_receiver {
        breaches.push(Breach {
            path: "error_reporting_enabled",
            message: "needs an error receiver configured where Marfa runs".to_string(),
        });
    }
    breaches
}

fn sign_in_is_an_address(judged: &Judged) -> Vec<Breach> {
    let after = judged.after;
    let Some(Value::Address(Some(sign_in))) = after.stored(SIGN_IN_ADDRESS.entry) else {
        return Vec::new();
    };
    if after.get(ADDRESSES).contains(sign_in) {
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
