//! What a server's `/health` says of backups, in words for the person who installed it.

use serde_json::{Value, json};

use super::PrivateCommand;

const TURNED_OFF: &str = "Scheduled backups are turned off, because backup_interval_seconds is 0. \
                          A backup is taken only when you ask for one.";

/// The command that changes a stored setting on this server.
fn config_update(private: Option<&PrivateCommand>) -> String {
    match private {
        Some(private) => private.run_text("config update"),
        None => "`marfa config update`".to_string(),
    }
}

/// The `backups` object of a public `/health` answer.
#[derive(Debug, PartialEq, Eq)]
pub struct Said {
    status: String,
    reason: Option<String>,
}

impl Said {
    pub fn of(health: &Value) -> Option<Said> {
        let backups = health.get("backups")?;
        Some(Said {
            status: backups.get("status")?.as_str()?.to_string(),
            reason: backups
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// What the server answers now, or `None` when it does not answer.
    pub fn ask(agent: &ureq::Agent, port: u16) -> Option<Said> {
        let mut response = agent.get(&super::health_url(port)).call().ok()?;
        Said::of(&response.body_mut().read_json::<Value>().ok()?)
    }

    /// What a person should be told, or `None` when backups are running well. `docker` is
    /// whether the server runs in a container, where a folder must be mounted into it first.
    pub fn words(&self, docker: bool, private: Option<&PrivateCommand>) -> Option<String> {
        match (self.status.as_str(), self.reason.as_deref()) {
            ("off", Some("no_backup_destination")) => {
                let folder = if docker {
                    "backup_path to a folder on another disk that is mounted into the container"
                } else {
                    "backup_path to a folder on another disk"
                };
                Some(format!(
                    "No backups are kept: this server has nowhere to put them. Set {folder}, or \
                     object_store_bucket with its access key and secret to an object store, \
                     with {}.",
                    config_update(private)
                ))
            }
            ("off", Some("turned_off")) => Some(TURNED_OFF.to_string()),
            ("failing", reason) => {
                let failing = match private {
                    Some(private) => format!(
                        "Backups are failing. See why with {}.",
                        private.run_text("attention")
                    ),
                    None => {
                        "Backups are failing. The server's attention list says why.".to_string()
                    }
                };
                Some(match reason {
                    Some("turned_off") => format!("{failing} {TURNED_OFF}"),
                    _ => failing,
                })
            }
            _ => None,
        }
    }

    pub fn json(&self, words: Option<&str>) -> Value {
        json!({ "status": self.status, "reason": self.reason, "say": words })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(backups: Value) -> Said {
        Said::of(&json!({ "status": "ok", "backups": backups })).unwrap()
    }

    #[test]
    fn no_destination_names_both_settings_and_the_command_that_sets_them() {
        let off = said(json!({ "status": "off", "reason": "no_backup_destination" }));
        let words = off.words(false, None).unwrap();
        for part in [
            "No backups are kept",
            "backup_path",
            "object_store_bucket",
            "marfa config update",
        ] {
            assert!(words.contains(part), "{part}: {words}");
        }
        assert!(!words.contains("mounted"));
        assert!(
            off.words(true, None)
                .unwrap()
                .contains("mounted into the container")
        );
    }

    #[test]
    fn turned_off_is_told_apart_from_no_destination() {
        let off = said(json!({ "status": "off", "reason": "turned_off" }));
        let words = off.words(false, None).unwrap();
        assert!(words.contains("turned off"), "{words}");
        assert!(!words.contains("No backups are kept"), "{words}");
        assert!(!words.contains("backup_path"), "{words}");
    }

    #[test]
    fn working_backups_say_nothing_and_a_failing_one_points_at_attention() {
        assert_eq!(said(json!({ "status": "ok" })).words(false, None), None);
        let failing = said(json!({ "status": "failing" }));
        assert!(failing.words(false, None).unwrap().contains("attention"));
    }

    #[test]
    fn failing_backups_that_are_turned_off_say_both() {
        let failing = said(json!({ "status": "failing", "reason": "turned_off" }));
        let words = failing.words(false, None).unwrap();
        assert!(words.contains("Backups are failing"), "{words}");
        assert!(words.contains("turned off"), "{words}");
        assert!(!words.contains("No backups are kept"), "{words}");
    }

    #[test]
    fn a_health_answer_without_backups_says_nothing() {
        assert_eq!(Said::of(&json!({ "status": "ok" })), None);
    }
}
