//! The lines the server logs that the command line reads, defined once for both.

use serde_json::Value;

/// The line the server logs once it has upgraded a database an earlier build wrote.
pub mod upgraded {
    pub const MESSAGE: &str = "The database was upgraded";
    pub const SCHEMA_FROM: &str = "schema_from";
    pub const SCHEMA_TO: &str = "schema_to";
    /// The release of the server that made the upgrade.
    pub const RELEASE: &str = "release";
    /// Left out when the database held no row, so no copy was made.
    pub const COPY: &str = "copy";
}

/// The message of the line the server logs when it stops for a failure to start.
pub const START_FAILED: &str = "Failed to start server";
/// The field of that line that holds the failure's message.
pub const ERROR: &str = "error";
/// The field of that line that names the refusal, when the server stopped rather than change
/// its database; the line has none for any other failure.
pub const REFUSED: &str = "refused";

/// Why the server declined to upgrade a database, leaving it as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeRefusal {
    /// The copy kept before the upgrade could not be made.
    CopyNotMade,
    /// The settings stored in the database could not be read to decide the copy.
    SettingsUnreadable,
}

impl UpgradeRefusal {
    /// The word the server's line carries in its `refused` field.
    pub const fn name(self) -> &'static str {
        match self {
            UpgradeRefusal::CopyNotMade => "copy",
            UpgradeRefusal::SettingsUnreadable => "settings",
        }
    }

    fn named(name: &str) -> Option<UpgradeRefusal> {
        [
            UpgradeRefusal::CopyNotMade,
            UpgradeRefusal::SettingsUnreadable,
        ]
        .into_iter()
        .find(|refusal| refusal.name() == name)
    }
}

/// A refusal to upgrade the log reports, with the message the server gave for it.
#[derive(Debug, PartialEq, Eq)]
pub struct RefusedUpgrade {
    pub refusal: UpgradeRefusal,
    pub error: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DatabaseUpgrade {
    pub from: u64,
    pub to: u64,
    pub copy: Option<String>,
}

fn entries(log: &str) -> impl DoubleEndedIterator<Item = Value> + '_ {
    log.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

/// The last upgrade a server's log reports, since a log holds every start it made. With a
/// `release`, only an upgrade that release's server made counts.
pub fn last_upgrade(log: &str, release: Option<&str>) -> Option<DatabaseUpgrade> {
    entries(log)
        .filter(|entry| entry["message"] == upgraded::MESSAGE)
        .filter(|entry| release.is_none_or(|release| entry[upgraded::RELEASE] == release))
        .filter_map(|entry| {
            Some(DatabaseUpgrade {
                from: entry[upgraded::SCHEMA_FROM].as_u64()?,
                to: entry[upgraded::SCHEMA_TO].as_u64()?,
                copy: entry[upgraded::COPY].as_str().map(str::to_string),
            })
        })
        .next_back()
}

/// The refusal to upgrade that a log, read from this start, ends on: a later failure to start
/// for another reason, or an upgrade that went through, leaves the database in another state.
pub fn refused_upgrade(log: &str) -> Option<RefusedUpgrade> {
    let mut refused = None;
    for entry in entries(log) {
        if entry["message"] == START_FAILED {
            refused =
                UpgradeRefusal::named(entry[REFUSED].as_str().unwrap_or_default()).map(|refusal| {
                    RefusedUpgrade {
                        refusal,
                        error: entry[ERROR].as_str().unwrap_or_default().to_string(),
                    }
                });
        } else if entry["message"] == upgraded::MESSAGE {
            refused = None;
        }
    }
    refused
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upgraded_line(from: u64, to: u64, copy: Option<&str>) -> String {
        let mut line = serde_json::json!({
            "level": "info",
            "message": upgraded::MESSAGE,
            upgraded::SCHEMA_FROM: from,
            upgraded::SCHEMA_TO: to,
        });
        if let Some(copy) = copy {
            line[upgraded::COPY] = copy.into();
        }
        line.to_string()
    }

    #[test]
    fn the_last_upgrade_in_the_log_is_the_one_read() {
        let log = [
            upgraded_line(1, 2, Some("/d/marfa.db.before-upgrade")),
            "not json".into(),
            upgraded_line(2, 3, None),
            r#"{"message":"Listening"}"#.into(),
        ]
        .join("\n");
        assert_eq!(
            last_upgrade(&log, None),
            Some(DatabaseUpgrade {
                from: 2,
                to: 3,
                copy: None
            })
        );
        assert_eq!(last_upgrade("{}", None), None);
    }

    #[test]
    fn an_upgrade_is_read_for_the_release_that_made_it() {
        let by = |release: &str, from: u64| {
            let mut line: Value =
                serde_json::from_str(&upgraded_line(from, from + 1, None)).unwrap();
            line[upgraded::RELEASE] = release.into();
            line.to_string()
        };
        let log = [by("0.2.0", 1), by("0.3.0", 2), by("0.2.0", 3)].join("\n");
        assert_eq!(last_upgrade(&log, Some("0.2.0")).map(|up| up.from), Some(3));
        assert_eq!(last_upgrade(&log, Some("0.3.0")).map(|up| up.from), Some(2));
        assert_eq!(last_upgrade(&log, Some("0.4.0")), None);
        // Witness: a line that names no release is not any release's.
        assert_eq!(
            last_upgrade(&upgraded_line(1, 2, None), Some("0.2.0")),
            None
        );
        assert!(last_upgrade(&upgraded_line(1, 2, None), None).is_some());
    }

    #[test]
    fn an_upgrade_line_without_its_versions_is_not_one() {
        let line = serde_json::json!({ "message": upgraded::MESSAGE }).to_string();
        assert_eq!(last_upgrade(&line, None), None);
    }

    fn failed_line(refusal: Option<UpgradeRefusal>, error: &str) -> String {
        let mut line = serde_json::json!({ "message": START_FAILED, ERROR: error });
        if let Some(refusal) = refusal {
            line[REFUSED] = refusal.name().into();
        }
        line.to_string()
    }

    #[test]
    fn only_a_failure_that_names_its_refusal_is_read_as_one() {
        let refused = failed_line(Some(UpgradeRefusal::CopyNotMade), "no space");
        assert_eq!(
            refused_upgrade(&refused),
            Some(RefusedUpgrade {
                refusal: UpgradeRefusal::CopyNotMade,
                error: "no space".into()
            })
        );
        let unnamed = failed_line(None, "The port 8080 is already taken (EADDRINUSE)");
        assert_eq!(refused_upgrade(&unnamed), None);
        let unknown = serde_json::json!({ "message": START_FAILED, ERROR: "x", REFUSED: "other" });
        assert_eq!(refused_upgrade(&unknown.to_string()), None);
        assert_eq!(
            refused_upgrade(&failed_line(Some(UpgradeRefusal::SettingsUnreadable), "x"))
                .map(|refused| refused.refusal),
            Some(UpgradeRefusal::SettingsUnreadable)
        );
    }

    #[test]
    fn a_refusal_stands_only_until_a_later_start_ends_otherwise() {
        let refused = failed_line(Some(UpgradeRefusal::CopyNotMade), "no space");
        let port = failed_line(None, "The port 8080 is already taken (EADDRINUSE)");
        let upgraded = upgraded_line(1, 2, None);
        let read = |lines: &[&String]| {
            refused_upgrade(
                &lines
                    .iter()
                    .map(|l| l.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        };
        assert!(read(&[&refused]).is_some());
        assert!(read(&[&port, &refused]).is_some());
        assert!(read(&[&refused, &port]).is_none());
        // Witness: the same refusal, with the upgrade that went through after it, is not one.
        assert!(read(&[&refused, &upgraded]).is_none());
        // And in the other order, the refusal is the later event.
        assert!(read(&[&upgraded, &refused]).is_some());
    }
}
