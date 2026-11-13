//! What a server's `/health` says of backups, in words for the person who installed it.

use std::path::Path;

use serde_json::{Value, json};

use super::PrivateCommand;

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
        let mut response = agent
            .get(&format!("http://127.0.0.1:{port}/health"))
            .call()
            .ok()?;
        Said::of(&response.body_mut().read_json::<Value>().ok()?)
    }

    /// What a person should be told, or `None` when backups are running well. `docker` is
    /// whether the server runs in a container, where a folder must be mounted into it first.
    pub fn words(
        &self,
        settings: &Path,
        docker: bool,
        private: Option<&PrivateCommand>,
    ) -> Option<String> {
        match (self.status.as_str(), self.reason.as_deref()) {
            ("off", Some("no_backup_destination")) => {
                let folder = if docker {
                    "MARFA_BACKUP_PATH to a folder on another disk that is mounted into the \
                     container"
                } else {
                    "MARFA_BACKUP_PATH to a folder on another disk"
                };
                Some(format!(
                    "No backups are kept: this server has nowhere to put them. Set {folder}, or \
                     S3_BUCKET to an object store, in {}, then run `marfa server stop` and \
                     `marfa server start`.",
                    settings.display()
                ))
            }
            ("off", Some("turned_off")) => Some(
                "Scheduled backups are turned off, because backup_interval_seconds is 0. A \
                 backup is taken only when you ask for one."
                    .to_string(),
            ),
            ("failing", _) => Some(match private {
                Some(private) => format!(
                    "Backups are failing. See why with {}.",
                    private.run_text("attention")
                ),
                None => "Backups are failing. The server's attention list says why.".to_string(),
            }),
            _ => None,
        }
    }

    pub fn json(&self, words: Option<&str>) -> Value {
        json!({ "status": self.status, "reason": self.reason, "say": words })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn said(backups: Value) -> Said {
        Said::of(&json!({ "status": "ok", "backups": backups })).unwrap()
    }

    #[test]
    fn no_destination_names_both_settings_the_file_and_how_to_restart() {
        let off = said(json!({ "status": "off", "reason": "no_backup_destination" }));
        let settings = PathBuf::from("/srv/marfa/marfa.env");
        let words = off.words(&settings, false, None).unwrap();
        for part in [
            "No backups are kept",
            "MARFA_BACKUP_PATH",
            "S3_BUCKET",
            "/srv/marfa/marfa.env",
            "marfa server stop",
            "marfa server start",
        ] {
            assert!(words.contains(part), "{part}: {words}");
        }
        assert!(!words.contains("mounted"));
        assert!(
            off.words(&settings, true, None)
                .unwrap()
                .contains("mounted into the container")
        );
    }

    #[test]
    fn turned_off_is_told_apart_from_no_destination() {
        let off = said(json!({ "status": "off", "reason": "turned_off" }));
        let words = off.words(Path::new("/x/marfa.env"), false, None).unwrap();
        assert!(words.contains("turned off"), "{words}");
        assert!(!words.contains("No backups are kept"), "{words}");
        assert!(!words.contains("MARFA_BACKUP_PATH"), "{words}");
    }

    #[test]
    fn working_backups_say_nothing_and_a_failing_one_points_at_attention() {
        let settings = Path::new("/x/marfa.env");
        assert_eq!(
            said(json!({ "status": "ok" })).words(settings, false, None),
            None
        );
        let failing = said(json!({ "status": "failing" }));
        assert!(
            failing
                .words(settings, false, None)
                .unwrap()
                .contains("attention")
        );
    }

    #[test]
    fn a_health_answer_without_backups_says_nothing() {
        assert_eq!(Said::of(&json!({ "status": "ok" })), None);
    }
}
