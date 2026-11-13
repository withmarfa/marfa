//! What the owner should look at: one list over the instance's own state, where a check that
//! cannot answer is itself an entry, so an empty list always means every check found nothing.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::backups::{BackupHealth, StoreFault};
use super::connectors::{self, Reason};
use super::faults::{FAIL_ATTENTION, HOLD_ATTENTION};
use super::refusal::Result;
use super::{App, folders, health, housekeeping, keys};
use crate::app::clock::Stamp;

const CHECK_WAIT: Duration = Duration::from_secs(3);
const SOON_MS: i64 = 7 * housekeeping::DAY_MS;

pub const HEALTH: &str = "health";
pub const HOUSEKEEPING: &str = "housekeeping";
pub const CONNECTORS: &str = "connectors";
pub const FOLDERS: &str = "folders";
pub const KEYS: &str = "keys";

/// The checks a fault can name, each with how an unavailable entry names it.
pub const CHECKS: [(&str, &str); 5] = [
    (HEALTH, "Health"),
    (HOUSEKEEPING, "Housekeeping"),
    (CONNECTORS, "Connectors"),
    (FOLDERS, "Folders"),
    (KEYS, "API keys"),
];

struct Concern {
    kind: &'static str,
    reference: String,
    title: String,
    description: String,
}

impl Concern {
    fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "reference": self.reference,
            "title": self.title,
            "description": self.description,
        })
    }
}

fn words(text: &str) -> String {
    text.replace('_', " ")
}

fn plural(count: i64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// What the backups part of the health report asks of the owner.
fn backing(health: &BackupHealth) -> Vec<Concern> {
    let backups = &health.report;
    let text = |field: &str| backups[field].as_str().filter(|text| !text.is_empty());
    let concern = |reference: &str, title: &str, description: String| Concern {
        kind: "backup",
        reference: reference.to_string(),
        title: title.to_string(),
        description,
    };
    let mut found = Vec::new();
    match text("reason") {
        Some("no_backup_destination") => found.push(concern(
            "no_backup_destination",
            "No backups are kept",
            "This instance has nowhere to put them. Set MARFA_BACKUP_PATH to a folder on another \
             disk, or S3_BUCKET to an object store, in the server's settings (`marfa.env` for an \
             install made by `marfa server install`), then run `marfa server \
             restart`."
                .to_string(),
        )),
        Some("turned_off") => found.push(concern(
            "turned_off",
            "Scheduled backups are turned off",
            "backup_interval_seconds is 0, so the server takes no backup unless asked. `marfa \
             backups run` takes one now. Set backup_interval_seconds above 0 to take them on a \
             schedule."
                .to_string(),
        )),
        _ => {}
    }
    let mut folded = false;
    if let (Some(error), Some(fault)) = (text("store_error"), health.fault) {
        let place = match text("destination") {
            Some("folder") => "backup folder",
            _ => "object store",
        };
        let title = match fault {
            StoreFault::FolderGone => "The backup folder is not there".to_string(),
            StoreFault::FolderSilent => "The backup folder is not answering".to_string(),
            StoreFault::Refused => format!("Files are waiting for their copy in the {place}"),
        };
        let waiting = backups["copies_waiting"].as_u64().unwrap_or(0);
        let error = error.trim_end_matches('.');
        let mut description = match waiting {
            0 => format!("{error}."),
            1 => format!("{error}. 1 file waits for its second copy."),
            count => format!("{error}. {count} files wait for their second copy."),
        };
        folded = health.run_in_store && backups["failures"].as_i64().unwrap_or(0) > 0;
        if folded {
            description.push_str(" The last backup run failed too.");
        }
        found.push(concern("store", &title, description));
    }
    if !folded && backups["failures"].as_i64().unwrap_or(0) > 0 && !backups["destination"].is_null()
    {
        found.push(concern(
            "run",
            "The last backup run failed or lost files",
            text("last_error")
                .unwrap_or("The run did not complete.")
                .to_string(),
        ));
    }
    let waiting = backups["last_backup_files_waiting"].as_u64().unwrap_or(0);
    if waiting > 0 && backups["status"] != "failing" {
        let place = match text("destination") {
            Some("folder") => "backup folder",
            _ => "object store",
        };
        let files = match waiting {
            1 => "1 file it names waits".to_string(),
            count => format!("{count} files it names wait"),
        };
        found.push(concern(
            "incomplete",
            "The newest backup is not complete yet",
            format!(
                "{files} for a copy in the {place}, so a restore from it would refuse. It is \
                 complete once replication has copied them."
            ),
        ));
    }
    found
}

async fn healthy(app: &Arc<App>) -> Result<Vec<Concern>> {
    let report = health::check(app).await;
    let mut found: Vec<Concern> = report
        .failing()
        .into_iter()
        .map(|(name, status, reason)| Concern {
            kind: "health",
            reference: name.to_string(),
            title: format!("{} is {status}", capitalized(&words(name))),
            description: if reason.is_empty() {
                format!("The {} check reports {status}.", words(name))
            } else {
                reason
            },
        })
        .collect();
    found.extend(backing(report.backups()));
    Ok(found)
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

async fn jobs(app: &Arc<App>) -> Result<Vec<Concern>> {
    Ok(housekeeping::failed(app)
        .await?
        .into_iter()
        .map(|(name, error)| Concern {
            kind: "job",
            title: format!("The {name} job failed its last run"),
            description: error.unwrap_or_else(|| "The last run failed.".to_string()),
            reference: name,
        })
        .collect())
}

async fn connected(app: &Arc<App>, at: &str) -> Result<Vec<Concern>> {
    let at = at.to_string();
    let found = app.db.read(move |tx| connectors::concerns(tx, &at)).await?;
    Ok(found
        .into_iter()
        .map(|concern| {
            let mut said = Vec::new();
            for reason in &concern.reasons {
                said.push(match reason {
                    Reason::Failed(Some(error)) => format!("The last run failed: {error}"),
                    Reason::Failed(None) => "The last run failed.".to_string(),
                    Reason::Problems(count) => {
                        format!(
                            "It reports {}.",
                            plural(*count as i64, "problem", "problems")
                        )
                    }
                    Reason::Quiet => "Nothing heard from it for more than a day.".to_string(),
                });
            }
            let title = match concern.reasons.first() {
                Some(Reason::Failed(_)) => format!("{} failed its last run", concern.name),
                Some(Reason::Problems(_)) => format!("{} reports problems", concern.name),
                _ => format!("{} has gone quiet", concern.name),
            };
            Concern {
                kind: "connector",
                reference: concern.id,
                title,
                description: said.join(" "),
            }
        })
        .collect())
}

async fn synced(app: &Arc<App>, at: &str) -> Result<Vec<Concern>> {
    let at = at.to_string();
    let found = app.db.read(move |tx| folders::concerns(tx, &at)).await?;
    Ok(found
        .into_iter()
        .map(|folder| {
            let mut said = Vec::new();
            if folder.problems > 0 {
                said.push(plural(folder.problems, "problem", "problems"));
            }
            if folder.paused_removals > 0 {
                said.push(plural(
                    folder.paused_removals,
                    "paused removal",
                    "paused removals",
                ));
            }
            if folder.first_sync_waiting {
                said.push("a first sync waiting for confirmation".to_string());
            }
            Concern {
                kind: "folder",
                reference: folder.id,
                title: format!("{} needs a look", folder.title),
                description: format!("A current sign-in reports {}.", said.join(", ")),
            }
        })
        .collect())
}

async fn ending(app: &Arc<App>, at: &str) -> Result<Vec<Concern>> {
    let at = at.to_string();
    let live = app
        .db
        .read(move |tx| {
            let now = Stamp::read(&at)?.ms();
            let mut soon = Vec::new();
            for key in keys::all_live(tx, &at)? {
                let Some(expires) = key.expires_at.as_deref() else {
                    continue;
                };
                if Stamp::read(expires)?.ms() - now <= SOON_MS {
                    soon.push((key.id, key.label, expires.to_string()));
                }
            }
            Ok(soon)
        })
        .await?;
    Ok(live
        .into_iter()
        .map(|(id, label, expires)| Concern {
            kind: "key",
            reference: id,
            title: format!("{label} expires soon"),
            description: format!("It expires at {expires}. Scripts using it will stop working."),
        })
        .collect())
}

/// One check, bounded in time; a check that fails, runs out of time or is made to fail by a
/// fault becomes one entry naming it.
async fn checked<F>(app: &App, name: &'static str, check: F) -> Vec<Concern>
where
    F: Future<Output = Result<Vec<Concern>>>,
{
    let held = async {
        app.faults.hold(HOLD_ATTENTION, Some(name)).await;
        if app.faults.fail(FAIL_ATTENTION, Some(name)) {
            return None;
        }
        match check.await {
            Ok(found) => Some(found),
            Err(refused) => {
                tracing::warn!(check = name, error = %refused, "An attention check failed");
                None
            }
        }
    };
    match tokio::time::timeout(CHECK_WAIT, held).await {
        Ok(Some(found)) => found,
        _ => {
            let label = CHECKS
                .iter()
                .find(|(key, _)| *key == name)
                .map_or(name, |(_, label)| *label);
            vec![Concern {
                kind: "unavailable",
                reference: label.to_string(),
                title: format!("Couldn't check {}", label.to_lowercase()),
                description: "The check failed or did not answer in time. Its state is unknown."
                    .to_string(),
            }]
        }
    }
}

/// A job whose failure a backup concern already tells is left out, so one fault is one entry.
/// A failed backup run always lands in the backup state, which `run` or `store` tells.
fn without_covered_jobs(health: &[Concern], jobs: Vec<Concern>) -> Vec<Concern> {
    let told = |reference: &str| {
        health
            .iter()
            .any(|concern| concern.kind == "backup" && concern.reference == reference)
    };
    jobs.into_iter()
        .filter(|job| {
            !((job.reference == "backup" && (told("run") || told("store")))
                || (job.reference == "blob-replicate" && told("store")))
        })
        .collect()
}

pub async fn read(app: &Arc<App>) -> Value {
    let at = app.clock.stamp();
    let (health, jobs, connectors, folders, keys) = tokio::join!(
        checked(app, HEALTH, healthy(app)),
        checked(app, HOUSEKEEPING, jobs(app)),
        checked(app, CONNECTORS, connected(app, &at)),
        checked(app, FOLDERS, synced(app, &at)),
        checked(app, KEYS, ending(app, &at)),
    );
    let jobs = without_covered_jobs(&health, jobs);
    let data: Vec<Value> = [health, jobs, connectors, folders, keys]
        .iter()
        .flatten()
        .map(Concern::to_json)
        .collect();
    json!({ "data": data })
}
