//! What the server is told. [`Start`] is fixed when the process begins; the
//! registry holds what can change while it runs. Reading settings gives
//! [`Accepted`], which touches nothing on disk; opening its secrets gives
//! [`Settings`], the only way to reach a [`Start`].

mod environment;
pub mod registry;
pub(crate) mod rule;
mod secrets;
pub mod start;

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use arc_swap::ArcSwap;

use crate::failure::Failure;
use registry::{ENTRIES, Seeds};
use secrets::Given;
use start::Fixed;

pub use environment::Environment;
pub use registry::{Entry, Snapshot};
pub use start::{DatabasePath, Start};

/// Every setting a start cannot accept, one line each.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused {
    pub lines: Vec<String>,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "The server cannot start; fix these settings:")?;
        for line in &self.lines {
            write!(f, "\n  {line}")?;
        }
        Ok(())
    }
}

/// Settings every rule has accepted, with their secrets still to open.
pub struct Accepted {
    fixed: Fixed,
    given: Given,
    seeds: Seeds,
}

impl Accepted {
    pub fn fixed(&self) -> &Fixed {
        &self.fixed
    }

    /// Fills in the secrets, making their file on a first start. A server
    /// holds the control socket's claim before it comes here.
    pub fn open_secrets(self) -> Result<Settings, Failure> {
        let filled = secrets::open(self.given, &self.fixed.database, self.fixed.test_hooks)?;
        let live = Snapshot::resolve(&self.seeds, &[], 0);
        Ok(Settings {
            start: Arc::new(Start::new(
                self.fixed,
                filled.api_key_salt,
                filled.auth_secret,
            )),
            seeds: self.seeds,
            live: ArcSwap::from_pointee(live),
            generation: AtomicU64::new(0),
        })
    }
}

fn warn_of_ignored(environment: &Environment) {
    for entry in ENTRIES {
        if let Some(name) = entry
            .test_name
            .filter(|name| environment.get(name).is_some())
        {
            let key = entry.key;
            tracing::warn!(
                setting = name,
                "{name} is ignored; {key} is a stored setting, set through /config"
            );
        }
    }
}

/// The settings a running server reads.
pub struct Settings {
    pub start: Arc<Start>,
    seeds: Seeds,
    live: ArcSwap<Snapshot>,
    generation: AtomicU64,
}

impl Settings {
    /// Reads every setting from the environment and refuses what is outside
    /// its rule. Nothing here touches the disk. Only test hooks read a stored
    /// setting from the environment, and then only in place of its default.
    pub fn read(environment: Environment) -> Result<Accepted, Refused> {
        let mut problems = Vec::new();
        let read = Fixed::read(&environment, &mut problems);
        let seeds = if Fixed::hooks_on(&environment) {
            registry::seeds(&environment, &mut problems)
        } else {
            Seeds::new()
        };
        let (fixed, given) = match (read, problems.is_empty()) {
            (Some(read), true) => read,
            _ => return Err(Refused { lines: problems }),
        };
        fixed.check_together(&environment, &mut problems);
        if !problems.is_empty() {
            return Err(Refused { lines: problems });
        }
        if !fixed.test_hooks {
            warn_of_ignored(&environment);
        }
        Ok(Accepted {
            fixed,
            given,
            seeds,
        })
    }

    /// Takes in the rows the database holds. A row that no longer reads stays
    /// in the table and its setting falls back, since a stop here could not be
    /// mended through the API.
    pub fn apply_stored(&self, stored: &[(String, String)]) {
        let snapshot = Snapshot::resolve(&self.seeds, stored, 0);
        for key in snapshot.unreadable() {
            tracing::error!(
                setting = key,
                "A stored setting does not read; its row is kept and its default is in use"
            );
        }
        self.live.store(Arc::new(snapshot));
    }

    /// Numbers a change. Taken inside the write transaction, where writes are
    /// serial, so the numbers follow the order of the commits.
    pub(crate) fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Makes committed rows live, unless a later commit is already.
    pub(crate) fn publish(&self, generation: u64, stored: &[(String, String)]) {
        let snapshot = Arc::new(Snapshot::resolve(&self.seeds, stored, generation));
        self.live.rcu(|current| {
            if current.generation() < generation {
                snapshot.clone()
            } else {
                current.clone()
            }
        });
    }

    pub fn live(&self) -> Arc<Snapshot> {
        self.live.load_full()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::addresses::Address;
    use crate::settings::registry::{MAX_REQUEST_BYTES, SIGN_IN_ADDRESS};

    const IN_MEMORY: (&str, &str) = ("SQLITE_PATH", ":memory:");
    const HOOKS: (&str, &str) = ("MARFA_TEST_HOOKS", "true");

    fn read(pairs: &[(&str, &str)]) -> Result<Accepted, Refused> {
        Settings::read(Environment::from_pairs(pairs))
    }

    fn opened(pairs: &[(&str, &str)]) -> Settings {
        let pairs = [&[IN_MEMORY], pairs].concat();
        read(&pairs)
            .map_err(|refused| refused.to_string())
            .unwrap()
            .open_secrets()
            .unwrap()
    }

    fn refused(pairs: &[(&str, &str)]) -> Vec<String> {
        match read(pairs) {
            Ok(_) => panic!("the settings were accepted"),
            Err(refused) => refused.lines,
        }
    }

    fn row(key: &str, value: &str) -> [(String, String); 1] {
        [(key.to_string(), value.to_string())]
    }

    #[test]
    fn with_hooks_off_a_setting_comes_from_its_row_then_its_default() {
        let settings = opened(&[("MARFA_MAX_REQUEST_BYTES", "4096")]);
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 1_048_576);

        settings.apply_stored(&row("max_request_bytes", "2048"));
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 2048);
    }

    #[test]
    fn with_hooks_on_the_environment_replaces_the_default_and_a_row_still_wins() {
        let settings = opened(&[HOOKS, ("MARFA_MAX_REQUEST_BYTES", "4096")]);
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 4096);

        settings.apply_stored(&row("max_request_bytes", "2048"));
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 2048);

        settings.apply_stored(&[]);
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 4096);
    }

    #[test]
    fn the_address_seed_is_a_test_name_like_any_other() {
        let seeded = ("MARFA_AUTH_BASE_URL", "HTTPS://Marfa.Example:443/");
        let settings = opened(&[HOOKS, seeded]);
        let origin = |settings: &Settings| {
            settings
                .live()
                .get(SIGN_IN_ADDRESS)
                .map(|address: Address| address.origin().to_string())
        };
        assert_eq!(origin(&settings).as_deref(), Some("https://marfa.example"));

        settings.apply_stored(&row("sign_in_address", "https://stored.example"));
        assert_eq!(origin(&settings).as_deref(), Some("https://stored.example"));

        assert_eq!(origin(&opened(&[seeded])), None);
    }

    #[test]
    fn with_hooks_on_a_value_outside_its_rule_refuses_the_start() {
        assert_eq!(
            refused(&[HOOKS, ("MARFA_MAX_REQUEST_BYTES", "0"), ("PORT", "x")]),
            [
                r#"PORT must be a whole number, from 0 to 65535 (got "x")"#,
                r#"MARFA_MAX_REQUEST_BYTES must be a whole number, 1 or more (got "0")"#,
            ]
        );
        let lines = refused(&[HOOKS, ("MARFA_AUTH_BASE_URL", "marfa.example")]);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].starts_with("MARFA_AUTH_BASE_URL must"),
            "{lines:?}"
        );
        assert!(lines[0].ends_with(r#"(got "marfa.example")"#), "{lines:?}");
    }

    #[test]
    fn with_hooks_off_a_stale_value_cannot_refuse_a_start() {
        assert!(read(&[("MARFA_MAX_REQUEST_BYTES", "0")]).is_ok());
    }

    #[test]
    fn a_row_that_does_not_read_falls_back_and_is_listed() {
        let settings = opened(&[HOOKS, ("MARFA_MAX_REQUEST_BYTES", "4096")]);
        settings.apply_stored(&row("max_request_bytes", "0"));
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 4096);
        assert_eq!(settings.live().unreadable(), ["max_request_bytes"]);

        let settings = opened(&[]);
        settings.apply_stored(&row("sign_in_address", "not an address"));
        assert_eq!(settings.live().get(SIGN_IN_ADDRESS), None);
        assert_eq!(settings.live().unreadable(), ["sign_in_address"]);
    }

    #[test]
    fn an_older_publish_never_replaces_a_newer_one() {
        let settings = opened(&[]);
        let older = settings.next_generation();
        let newer = settings.next_generation();
        settings.publish(newer, &row("max_request_bytes", "2048"));
        settings.publish(older, &row("max_request_bytes", "1024"));
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 2048);
    }

    #[test]
    fn a_blank_row_counts_as_absent() {
        let settings = opened(&[HOOKS, ("MARFA_AUTH_BASE_URL", "https://seed.example")]);
        settings.apply_stored(&row("sign_in_address", ""));
        assert!(settings.live().get(SIGN_IN_ADDRESS).is_some());
        assert!(settings.live().unreadable().is_empty());
    }

    #[test]
    fn a_row_with_no_entry_is_left_alone() {
        let settings = opened(&[]);
        settings.apply_stored(&row("health_probe", "2026-11-07T12:00:00Z"));
        assert!(settings.live().unreadable().is_empty());
    }

    #[test]
    fn node_env_is_ignored_without_comment() {
        assert!(read(&[("NODE_ENV", "production")]).is_ok());
        assert!(read(&[("NODE_ENV", "staging")]).is_ok());
    }

    #[test]
    fn names_every_bad_setting_on_its_own_line() {
        assert_eq!(
            refused(&[("PORT", "70000"), ("SQLITE_BUSY_BUDGET_MS", "soon")]),
            [
                r#"PORT must be a whole number, from 0 to 65535 (got "70000")"#,
                r#"SQLITE_BUSY_BUDGET_MS must be a whole number, from 0 to 2147483647 (got "soon")"#,
            ]
        );
    }

    #[test]
    fn never_prints_a_secret() {
        let secret = " padded-secret-value-of-enough-length-to-pass ";
        let lines = refused(&[("MARFA_AUTH_SECRET", secret), ("API_KEY_SALT", " salt")]);
        assert_eq!(lines.len(), 2);
        for line in lines {
            assert!(!line.contains("padded-secret"), "{line}");
            assert!(!line.contains("salt\""), "{line}");
        }
        let environment = Environment::from_pairs(&[("MARFA_AUTH_SECRET", secret)]);
        let printed = format!("{environment:?}");
        assert!(printed.contains("MARFA_AUTH_SECRET"), "{printed}");
        assert!(!printed.contains("padded-secret"), "{printed}");
    }

    #[test]
    fn a_secret_from_the_environment_reaches_start() {
        let salt = ("API_KEY_SALT", "a-salt-from-the-environment");
        let auth = (
            "MARFA_AUTH_SECRET",
            "an-auth-secret-of-at-least-32-characters",
        );
        let settings = opened(&[salt, auth]);
        assert_eq!(settings.start.api_key_salt, salt.1);
        assert_eq!(settings.start.auth_secret, auth.1);
    }

    #[test]
    fn a_blank_value_counts_as_unset() {
        assert_eq!(read(&[("PORT", "   ")]).ok().unwrap().fixed().port, 8600);
    }

    #[test]
    fn holds_back_rules_between_settings_until_each_one_parses() {
        assert_eq!(
            refused(&[("MARFA_TEST_CONTRACT_VERSION", "1"), ("PORT", "x")]),
            [r#"PORT must be a whole number, from 0 to 65535 (got "x")"#]
        );
    }

    #[test]
    fn a_test_setting_needs_the_hooks() {
        assert_eq!(
            refused(&[("MARFA_TEST_CLOCK_OFFSET_MS", "3600000")]),
            [r#"MARFA_TEST_CLOCK_OFFSET_MS needs MARFA_TEST_HOOKS to be true (got "3600000")"#]
        );
    }
}
