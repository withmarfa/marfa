//! What the server is told. [`Start`] is fixed when the process begins; the
//! registry holds what can change while it runs.

mod environment;
pub mod registry;
mod rule;
pub mod start;

use std::fmt;
use std::sync::Arc;

use arc_swap::ArcSwap;

pub use environment::Environment;
pub use registry::{Entry, Snapshot};
pub use start::{DatabasePath, NodeEnv, Start};

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

/// The settings a running server reads.
pub struct Settings {
    pub start: Arc<Start>,
    environment: Environment,
    live: ArcSwap<Snapshot>,
}

impl Settings {
    /// Reads every setting from the environment and refuses what is outside
    /// its rule. Nothing here touches the disk.
    pub fn read(environment: Environment) -> Result<Settings, Refused> {
        let mut problems = Vec::new();
        let start = Start::read(&environment, &mut problems);
        let live = Snapshot::resolve(&environment, &[], &mut problems);
        let start = match (start, problems.is_empty()) {
            (Some(start), true) => start,
            _ => return Err(Refused { lines: problems }),
        };
        start.check_together(&environment, &mut problems);
        if !problems.is_empty() {
            return Err(Refused { lines: problems });
        }
        Ok(Settings {
            start: Arc::new(start),
            environment,
            live: ArcSwap::from_pointee(live),
        })
    }

    /// Takes in the rows the database holds. An environment value still wins.
    pub fn apply_stored(&self, stored: &[(String, String)]) -> Result<(), Refused> {
        let mut problems = Vec::new();
        let snapshot = Snapshot::resolve(&self.environment, stored, &mut problems);
        if !problems.is_empty() {
            return Err(Refused { lines: problems });
        }
        self.live.store(Arc::new(snapshot));
        Ok(())
    }

    pub fn live(&self) -> Arc<Snapshot> {
        self.live.load_full()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::registry::MAX_REQUEST_BYTES;

    fn read(pairs: &[(&str, &str)]) -> Result<Settings, Refused> {
        Settings::read(Environment::from_pairs(pairs))
    }

    fn refused(pairs: &[(&str, &str)]) -> Vec<String> {
        match read(pairs) {
            Ok(_) => panic!("the settings were accepted"),
            Err(refused) => refused.lines,
        }
    }

    #[test]
    fn a_live_value_comes_from_the_environment_then_the_row_then_the_default() {
        let settings = read(&[]).unwrap();
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 1_048_576);

        let row = [("MARFA_MAX_REQUEST_BYTES".to_string(), "2048".to_string())];
        settings.apply_stored(&row).unwrap();
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 2048);

        let settings = read(&[("MARFA_MAX_REQUEST_BYTES", "4096")]).unwrap();
        settings.apply_stored(&row).unwrap();
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 4096);
    }

    #[test]
    fn a_stored_value_outside_its_rule_is_refused_and_the_snapshot_stays() {
        let settings = read(&[]).unwrap();
        let row = [("MARFA_MAX_REQUEST_BYTES".to_string(), "0".to_string())];
        assert!(settings.apply_stored(&row).is_err());
        assert_eq!(settings.live().get(MAX_REQUEST_BYTES), 1_048_576);
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
    }

    #[test]
    fn a_blank_value_counts_as_unset() {
        let settings = read(&[("PORT", "   ")]).unwrap();
        assert_eq!(settings.start.port, 8600);
    }

    #[test]
    fn holds_back_rules_between_settings_until_each_one_parses() {
        assert_eq!(
            refused(&[("NODE_ENV", "production"), ("PORT", "x")]),
            [r#"PORT must be a whole number, from 0 to 65535 (got "x")"#]
        );
        let lines = refused(&[("NODE_ENV", "production")]);
        assert!(lines.iter().any(|line| line.starts_with("API_KEY_SALT")));
    }

    #[test]
    fn a_test_setting_needs_the_hooks() {
        assert_eq!(
            refused(&[("MARFA_TEST_CLOCK_OFFSET_MS", "3600000")]),
            [r#"MARFA_TEST_CLOCK_OFFSET_MS needs MARFA_TEST_HOOKS to be true (got "3600000")"#]
        );
    }
}
