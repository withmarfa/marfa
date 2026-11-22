//! What the owner should look at: one list over the instance's own state, where a check that
//! cannot answer is itself an entry, so an empty list always means every check found nothing.

pub mod faults;
mod memory;

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};

use rusqlite::{Transaction, params};

use super::access::Caller;
use super::backups::{BackupHealth, StoreFault};
use super::blobs::disk::{Disk, PENDING};
use super::blobs::folder::Folder;
use super::connectors::{self, Reason};
use super::events::Event;
use super::faults::{FAIL_ATTENTION, HOLD_ATTENTION};
use super::housekeeping::{Report, Run};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use super::{App, folders, health, housekeeping, keys, webhooks};
use crate::app::clock::{Stamp, Standing};
use crate::telemetry::{Finished, Kind, RequestSpan};
use faults::Entry;
use memory::{Key, Mark, Memory};

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

/// The event a new entry is announced by.
pub const RAISED: &str = "attention.raised";

const FAULT: &str = "fault";
const WRITE_ACTION: &str = "attention.check";

/// The kinds of entry each check finds, kept as announced while the check cannot answer.
const FOUND_BY: [(&str, &[&str]); 5] = [
    (HEALTH, &["health", "backup"]),
    (HOUSEKEEPING, &["job"]),
    (CONNECTORS, &["connector"]),
    (FOLDERS, &["folder"]),
    (KEYS, &["key"]),
];

#[derive(Clone)]
struct Concern {
    kind: &'static str,
    reference: String,
    title: String,
    description: String,
    /// A connector whose last run failed, not one that reports problems or has gone quiet.
    failed_run: bool,
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

    /// The entry without its title or description, which can name a path or an error.
    fn to_event(&self) -> Value {
        let description = match self.kind {
            "health" => "A part of the server is degraded or down.",
            "job" => "A housekeeping job failed its last run.",
            "connector" => "A connector failed its last run, reports problems or has gone quiet.",
            "folder" => "A folder's sync needs a look.",
            "key" => "An API key expires within seven days.",
            "backup" => "The backups need a look.",
            "clock" => "The server's clock disagrees with the time it last trusted.",
            "setting" => "A secret setting must be set again.",
            FAULT => faults::DESCRIPTION,
            _ => "A check of what needs attention could not answer.",
        };
        json!({
            "kind": self.kind,
            "reference": self.reference,
            "description": description,
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
        failed_run: false,
        reference: reference.to_string(),
        title: title.to_string(),
        description,
    };
    let mut found = Vec::new();
    if text("reason") == Some("no_backup_destination") {
        found.push(concern(
            "no_backup_destination",
            "No backups are kept",
            "This instance has nowhere to put them. Set backup_path to a folder on another disk, \
             or object_store_bucket and its access key and secret to an object store, through \
             `PATCH /config`."
                .to_string(),
        ));
    }
    // Told whatever else the destination is doing, so a refused store does not hide it.
    if health.turned_off {
        found.push(concern(
            "turned_off",
            "Scheduled backups are turned off",
            "backup_interval_seconds is 0, so the server takes no backup unless asked. `marfa \
             backups run` takes one now. Set backup_interval_seconds above 0 to take them on a \
             schedule."
                .to_string(),
        ));
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
            StoreFault::Unusable => "The backup destination cannot be used".to_string(),
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
    let damaged = backups["damaged_parts"].as_u64().unwrap_or(0);
    if damaged > 0 {
        let place = match text("destination") {
            Some("folder") => "backup folder",
            _ => "object store",
        };
        let parts = match damaged {
            1 => format!(
                "1 part in the {place} does not hold the bytes its name gives or cannot be read"
            ),
            count => format!(
                "{count} parts in the {place} do not hold the bytes their names give or cannot \
                 be read"
            ),
        };
        found.push(concern(
            "parts_damaged",
            "Parts of backups are damaged",
            format!(
                "{parts}. A restore of a backup that names one is refused. The next backup stores \
                 again each damaged part it names; `marfa backups run` takes one now. A part that \
                 only older backups name stays damaged until those backups are gone."
            ),
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
                "{files} for a copy in the {place}. A restore needs those files unless the \
                 restoring instance holds them or the backup lists them as lost."
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
            failed_run: false,
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
    if let Some(folder) = app.blobs.folder() {
        found.extend(
            health::bounded(move || {
                let mut found = locking(&folder.files());
                found.extend(claim_kept(&folder));
                found
            })
            .await
            .unwrap_or_default(),
        );
    }
    found.extend(secrets_to_set(&app.settings.live()));
    Ok(found)
}

/// Each secret setting stored that this server's key cannot open.
fn secrets_to_set(settings: &crate::settings::Snapshot) -> Vec<Concern> {
    settings
        .secrets_to_set()
        .into_iter()
        .map(|key| Concern {
            kind: "setting",
            failed_run: false,
            reference: key.to_string(),
            title: format!("Set {key} again"),
            description: format!(
                "{key} is a secret, and this server cannot read the value stored for it: the \
                 instance was restored from a backup or an archive, which never holds a secret, \
                 or the settings key beside the database was lost or replaced. Until it is set \
                 again through `PATCH /config`, the server cannot use it."
            ),
        })
        .collect()
}

/// What keeps the backup folder's files area from being this server's alone. It blocks.
fn locking(files: &Disk) -> Vec<Concern> {
    let folder = files.root().display().to_string();
    let backup = |reference: &str, title: &str, description: String| Concern {
        kind: "backup",
        failed_run: false,
        reference: reference.to_string(),
        title: title.to_string(),
        description,
    };
    let mut found: Vec<Concern> = unlocked(files).into_iter().collect();
    // A folder that is not there is the backup store's own entry.
    if files.reachable()
        && let Some(why) = files.unwritable()
    {
        found.push(backup(
            "folder_lock_lost",
            "The backup folder is not this server's alone",
            format!(
                "The server stopped copying files to {folder}: {why}. Stop any other Marfa \
                 server that uses the backup folder, then restart this one."
            ),
        ));
    }
    if let Some(fs) = files.shared() {
        found.push(backup(
            "folder_shared",
            "The backup folder is on a network file system",
            format!(
                "{folder} is on a network file system ({fs}), whose locks may not keep out a \
                 Marfa server on another machine. A copy of this instance started there could \
                 remove the files this one is still copying. Keep the backup folder on a disk \
                 of this machine, or make sure only one server uses it."
            ),
        ));
    }
    if let Some(note) = files.lock_note() {
        found.push(backup(
            "folder_lock_restored",
            "The backup folder's lock file was put back",
            format!(
                "Something other than this server changed {folder}: {note}. Check that no other \
                 program or server changes the backup folder."
            ),
        ));
    }
    found
}

/// An adopt's claim the server kept in a files area that takes no locks. It blocks.
fn claim_kept(folder: &Folder) -> Option<Concern> {
    folder.kept_claim().map(|id| Concern {
        kind: "backup",
        failed_run: false,
        reference: "folder_claim_kept".to_string(),
        title: "The backup folder keeps an adopt's claim".to_string(),
        description: format!(
            "{} holds the claim of an adopt for the store {id}, which the record does not name. \
             The server did not remove it: the folder is not locked, so the claim may be another \
             Marfa server's. Stop any other server that uses the backup folder, then remove {}.",
            folder.files().root().display(),
            folder.files().root().join(PENDING).display()
        ),
    })
}

/// A backup folder whose files area another server could use too, since it took no lock.
fn unlocked(files: &Disk) -> Option<Concern> {
    files.unlocked().map(|why| Concern {
        kind: "backup",
        failed_run: false,
        reference: "folder_unlocked".to_string(),
        title: "The backup folder is not locked".to_string(),
        description: format!(
            "The server could not lock {} against another Marfa server: {why}. A copy of this \
             instance started on the same backup folder could remove the files this one is \
             still copying there. Keep the backup folder on a file system that supports file \
             locks.",
            files.root().display()
        ),
    })
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// A length of time in the largest whole unit that keeps it above one.
fn span(ms: i64) -> String {
    const HOUR_MS: i64 = housekeeping::HOUR_MS;
    match ms {
        ms if ms >= 2 * housekeeping::DAY_MS => format!("{} days", ms / housekeeping::DAY_MS),
        ms if ms >= 2 * HOUR_MS => format!("{} hours", ms / HOUR_MS),
        ms => plural((ms / 60_000).max(1), "minute", "minutes"),
    }
}

const CONFIRM: &str = "`marfa housekeeping confirm-clock`";

fn clocked(standing: Standing) -> Option<Concern> {
    match standing {
        Standing::Agrees => None,
        Standing::Ahead {
            trusted,
            wall,
            ends,
        } => Some(Concern {
            kind: "clock",
            failed_run: false,
            reference: "clock_ahead".to_string(),
            title: "Clean-up is held because the clock is ahead".to_string(),
            description: format!(
                "The server's clock reads {wall}, {} later than the last time the server trusted, \
                 {trusted}. Jobs that delete old records do nothing until {ends}, once the clock \
                 has run a day without jumping. If the clock is right, run {CONFIRM} to let \
                 them run now. If it is wrong, set it right.",
                span(wall.ms() - trusted.ms())
            ),
        }),
        Standing::Behind { trusted, wall } => Some(Concern {
            kind: "clock",
            failed_run: false,
            reference: "clock_behind".to_string(),
            title: "The server's clock is behind".to_string(),
            description: format!(
                "The server's clock reads {wall}, {} earlier than the last time the server \
                 trusted, {trusted}. The server stamps records by its clock, so records written \
                 now can carry earlier times than records written before. If the clock is right, \
                 run {CONFIRM}. If it is wrong, set it right.",
                span(trusted.ms() - wall.ms())
            ),
        }),
    }
}

async fn jobs(app: &Arc<App>) -> Result<Vec<Concern>> {
    Ok(housekeeping::failed(app)
        .await?
        .into_iter()
        .map(|(name, error)| Concern {
            kind: "job",
            failed_run: false,
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
                failed_run: matches!(concern.reasons.first(), Some(Reason::Failed(_))),
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
                failed_run: false,
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
            failed_run: false,
            reference: id,
            title: format!("{label} expires soon"),
            description: format!("It expires at {expires}. Scripts using it will stop working."),
        })
        .collect())
}

/// One check, bounded in time; a check that fails, runs out of time or is made to fail by a
/// fault becomes one entry naming it.
async fn checked<F>(app: &App, name: &'static str, check: F) -> (Vec<Concern>, bool)
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
        Ok(Some(found)) => (found, true),
        _ => {
            let label = CHECKS
                .iter()
                .find(|(key, _)| *key == name)
                .map_or(name, |(_, label)| *label);
            let unavailable = Concern {
                kind: "unavailable",
                failed_run: false,
                reference: label.to_string(),
                title: format!("Couldn't check {}", label.to_lowercase()),
                description: "The check failed or did not answer in time. Its state is unknown."
                    .to_string(),
            };
            (vec![unavailable], false)
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

/// Checks are numbered as they begin, so a check's write knows whether a newer one has looked.
#[derive(Default)]
pub struct Order {
    begun: AtomicU64,
    looked: Arc<AtomicU64>,
    pub reported: Arc<faults::Faults>,
    told: Arc<Memory>,
}

fn fault_concern(entry: &Entry) -> Concern {
    Concern {
        kind: FAULT,
        failed_run: false,
        reference: entry.reference.clone(),
        title: entry.title(),
        description: faults::DESCRIPTION.to_string(),
    }
}

/// Every entry, and the kinds of entry a check that could not answer would have found.
#[derive(Clone)]
struct Gathered {
    concerns: Vec<Concern>,
    unknown: Vec<&'static str>,
    order: u64,
}

impl Gathered {
    /// Holds back a covered job while health cannot answer, so one fault is announced once.
    fn announceable(&self) -> impl Iterator<Item = &Concern> {
        let health_unknown = self.unknown.contains(&"health");
        self.concerns.iter().filter(move |concern| {
            !(health_unknown
                && concern.kind == "job"
                && COVERED_JOBS.contains(&concern.reference.as_str()))
        })
    }
}

/// The jobs whose failure a backup entry of the health check tells.
const COVERED_JOBS: [&str; 2] = ["backup", "blob-replicate"];

async fn gather(app: &Arc<App>) -> Gathered {
    let order = app.attention.begun.fetch_add(1, Ordering::AcqRel) + 1;
    let at = app.clock.stamp();
    let (health, jobs, connectors, folders, keys) = tokio::join!(
        checked(app, HEALTH, healthy(app)),
        checked(app, HOUSEKEEPING, jobs(app)),
        checked(app, CONNECTORS, connected(app, &at)),
        checked(app, FOLDERS, synced(app, &at)),
        checked(app, KEYS, ending(app, &at)),
    );
    let answered = [
        (HEALTH, health.1),
        (HOUSEKEEPING, jobs.1),
        (CONNECTORS, connectors.1),
        (FOLDERS, folders.1),
        (KEYS, keys.1),
    ];
    let unknown = FOUND_BY
        .iter()
        .filter(|(check, _)| answered.contains(&(*check, false)))
        .flat_map(|(_, kinds)| kinds.iter().copied())
        .collect();
    let jobs = without_covered_jobs(&health.0, jobs.0);
    let clock: Vec<Concern> = clocked(app.clock.standing()).into_iter().collect();
    let met: Vec<Concern> = app
        .attention
        .reported
        .standing(app.clock.now_ms())
        .iter()
        .map(fault_concern)
        .collect();
    let concerns = [health.0, clock, met, jobs, connectors.0, folders.0, keys.0]
        .into_iter()
        .flatten()
        .collect();
    app.attention.looked.fetch_max(order, Ordering::AcqRel);
    Gathered {
        concerns,
        unknown,
        order,
    }
}

fn announced(tx: &Transaction<'_>) -> Result<Vec<(String, String)>> {
    let mut statement = tx.prepare("SELECT kind, reference FROM attention_announced")?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The entries no earlier check announced.
fn unannounced<'a>(tx: &Transaction<'_>, gathered: &'a Gathered) -> Result<Vec<&'a Concern>> {
    let announced = announced(tx)?;
    Ok(gathered
        .announceable()
        .filter(|concern| {
            !announced
                .iter()
                .any(|(kind, reference)| kind == concern.kind && *reference == concern.reference)
        })
        .collect())
}

/// The announced entries that are gone, so that one is announced again should it come back.
/// An entry of a check that could not answer is kept, and a fault is judged by `faults`, the
/// faults standing as the write runs, since one can be met after the check looked.
fn forgotten(
    tx: &Transaction<'_>,
    gathered: &Gathered,
    faults: &HashSet<String>,
) -> Result<Vec<(String, String)>> {
    Ok(announced(tx)?
        .into_iter()
        .filter(|(kind, reference)| {
            if kind == FAULT {
                return !faults.contains(reference);
            }
            !gathered.unknown.contains(&kind.as_str())
                && !gathered
                    .concerns
                    .iter()
                    .any(|concern| concern.kind == kind && concern.reference == *reference)
        })
        .collect())
}

fn remember(tx: &Transaction<'_>, kind: &str, reference: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO attention_announced (kind, reference, announced_at) VALUES (?1, ?2, ?3)",
        params![kind, reference, at],
    )?;
    Ok(())
}

fn raised_event(concern: &Concern) -> Event<'static> {
    Event {
        event_type: RAISED,
        item_id: "",
        type_id: "",
        source: "",
        payload: json!({ "attention": concern.to_event() }).to_string(),
    }
}

/// What an announcing write did: the entries it announced and the marks it settled.
#[derive(Debug, Default)]
struct Written {
    raised: usize,
    failed_runs: usize,
    settled: Vec<(Key, u64)>,
}

fn key_of(concern: &Concern) -> Key {
    (concern.kind.to_string(), concern.reference.clone())
}

/// The entries an announcing write's job chose to announce from the log, decided on the state
/// it would commit, so a failed write sends from memory only what it would have announced.
#[derive(Clone, Default)]
struct Chosen(Arc<Mutex<Option<Vec<Concern>>>>);

impl Chosen {
    /// Set empty as the job starts, then to its choice before it records any entry.
    fn choose(&self, concerns: Vec<Concern>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(concerns);
    }

    /// What a failed write sends from memory: what its job chose, or `unread` if it never ran.
    fn or(self, unread: Vec<Concern>) -> Vec<Concern> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            .unwrap_or(unread)
    }
}

/// Records a new entry, announcing it unless memory sent it; one still on its way waits.
fn record_new(
    unit: &Unit<'_, '_>,
    concern: &Concern,
    mark: Option<Mark>,
    written: &mut Written,
) -> Result<()> {
    match mark {
        Some(Mark::Pending(_)) => return Ok(()),
        Some(Mark::Sent(serial)) => written.settled.push((key_of(concern), serial)),
        None => {
            unit.announce(&raised_event(concern))?;
            written.raised += 1;
            written.failed_runs += usize::from(concern.failed_run);
        }
    }
    remember(unit.tx(), concern.kind, &concern.reference, &unit.at)
}

/// Unmarks entries the newest check no longer finds, and faults that no longer stand.
fn forget_gone(app: &App, gathered: &Gathered) {
    let standing = app.attention.reported.references(app.clock.now_ms());
    let looked = &app.attention.looked;
    app.attention.told.retain(|(kind, reference)| {
        if looked.load(Ordering::Acquire) != gathered.order {
            return true;
        }
        if kind == FAULT {
            return standing.contains(reference);
        }
        gathered.unknown.contains(&kind.as_str())
            || gathered
                .concerns
                .iter()
                .any(|concern| concern.kind == kind && concern.reference == *reference)
    });
}

/// The new entries, read before the write; `None` when no entry is gone and every new one is
/// already on its way from memory.
async fn to_write(app: &Arc<App>, gathered: &Gathered) -> Result<Option<Vec<Concern>>> {
    let looking = gathered.clone();
    let standing = app.attention.reported.references(app.clock.now_ms());
    let (fresh, gone) = app
        .db
        .read(move |tx| {
            let fresh: Vec<Concern> = unannounced(tx, &looking)?.into_iter().cloned().collect();
            Ok((fresh, !forgotten(tx, &looking, &standing)?.is_empty()))
        })
        .await?;
    let told = &app.attention.told;
    let waiting = |concern: &Concern| {
        matches!(
            told.get(concern.kind, &concern.reference),
            Some(Mark::Pending(_))
        )
    };
    Ok((gone || !fresh.iter().all(waiting)).then_some(fresh))
}

/// Writes only when an entry is new or gone, decided again in the write unless a newer check looked.
async fn announce(app: &Arc<App>, gathered: &Gathered) -> Result<usize> {
    forget_gone(app, gathered);
    let Some(fresh) = to_write(app, gathered).await? else {
        return Ok(0);
    };
    let chosen = Chosen::default();
    let written = match write_new(app, gathered, chosen.clone()).await {
        Ok(written) => written,
        Err(refused) => {
            if database_failed(&refused) {
                let looked = &app.attention.looked;
                send_from_memory(app, &chosen.or(fresh), || {
                    looked.load(Ordering::Acquire) <= gathered.order
                });
            }
            return Err(refused);
        }
    };
    app.attention.told.settle(&written.settled);
    if written.failed_runs > 0 {
        let (settings, at) = (app.settings.live(), app.clock.stamp());
        for _ in 0..written.failed_runs {
            app.telemetry.report_connector_failure(&settings, &at);
        }
    }
    Ok(written.raised)
}

async fn write_new(app: &Arc<App>, gathered: &Gathered, chosen: Chosen) -> Result<Written> {
    let (writing, looked) = (gathered.clone(), app.attention.looked.clone());
    let reported = app.attention.reported.clone();
    let told = app.attention.told.clone();
    app.write(&Caller::Server, WRITE_ACTION, move |unit| {
        let mut written = Written::default();
        chosen.choose(Vec::new());
        if looked.load(Ordering::Acquire) > writing.order {
            return Ok(written);
        }
        let tx = unit.tx();
        let now_ms = unit.instant.ms();
        for (kind, reference) in forgotten(tx, &writing, &reported.references(now_ms))? {
            tx.execute(
                "DELETE FROM attention_announced WHERE kind = ?1 AND reference = ?2",
                params![kind, reference],
            )?;
        }
        let marks = told.snapshot();
        // A failed commit that landed left its row, and the log delivers that entry.
        let rows: HashSet<Key> = announced(tx)?.into_iter().collect();
        for (key, mark) in &marks {
            if let Mark::Sent(serial) = mark
                && rows.contains(key)
            {
                written.settled.push((key.clone(), *serial));
            }
        }
        let new: Vec<(&Concern, Option<Mark>)> = unannounced(tx, &writing)?
            .into_iter()
            .map(|concern| (concern, marks.get(&key_of(concern)).copied()))
            .collect();
        chosen.choose(
            new.iter()
                .filter(|(_, mark)| mark.is_none())
                .map(|(concern, _)| (*concern).clone())
                .collect(),
        );
        for (concern, mark) in new {
            record_new(unit, concern, mark, &mut written)?;
        }
        Ok(written)
    })
    .await
}

/// Whether an announcing write failed in the database, refused or at its commit.
fn database_failed(refused: &Refusal) -> bool {
    refused.commit_failed
        || refused.code == Code::InsufficientStorage
        || refused
            .fault
            .as_ref()
            .is_some_and(|fault| fault.kind == Kind::Database)
}

/// A failed commit may have landed, so the log can deliver an entry sent here too.
fn send_from_memory(app: &Arc<App>, concerns: &[Concern], current: impl Fn() -> bool) {
    for concern in concerns {
        if let Some(pending) = app
            .attention
            .told
            .begin(concern.kind, &concern.reference, &current)
        {
            webhooks::tell_from_memory(app, concern.to_event(), Box::new(move || pending.handed()));
        }
    }
}

/// Announces a fault entry at once, or sends it from memory where the database fails.
fn raise_fault(app: &Arc<App>, entry: Entry) {
    let app = app.clone();
    app.attention.told.forget(FAULT, &entry.reference);
    tokio::spawn(async move {
        let concern = fault_concern(&entry);
        let chosen = Chosen::default();
        match write_fault(&app, concern.clone(), entry.first_ms, chosen.clone()).await {
            Ok(written) => app.attention.told.settle(&written.settled),
            Err(refused) if database_failed(&refused) => {
                send_from_memory(&app, &chosen.or(vec![concern]), || true);
            }
            Err(refused) => {
                tracing::warn!(error = %refused, "A fault's attention entry was not announced");
            }
        }
    });
}

async fn write_fault(
    app: &Arc<App>,
    concern: Concern,
    first_ms: i64,
    chosen: Chosen,
) -> Result<Written> {
    let told = app.attention.told.clone();
    app.write(&Caller::Server, WRITE_ACTION, move |unit| {
        let mut written = Written::default();
        chosen.choose(Vec::new());
        let tx = unit.tx();
        if let Some(at) = announced_at(tx, &concern.reference)? {
            if Stamp::read(&at)?.ms() >= first_ms {
                return Ok(written);
            }
            tx.execute(
                "DELETE FROM attention_announced WHERE kind = ?1 AND reference = ?2",
                params![FAULT, concern.reference],
            )?;
        }
        let mark = told.get(FAULT, &concern.reference);
        if mark.is_none() {
            chosen.choose(vec![concern.clone()]);
        }
        record_new(unit, &concern, mark, &mut written)?;
        Ok(written)
    })
    .await
}

impl App {
    /// Lists a fault in what needs attention, announcing it when it is new there, and offers
    /// its report to error tracking.
    pub fn report_fault(
        self: &Arc<App>,
        place: faults::Place<'_>,
        span: Option<RequestSpan>,
        done: &Finished<'_>,
    ) {
        if let Some(fault) = done.fault
            && let Some(entry) =
                self.attention
                    .reported
                    .record(fault.kind, &place, self.clock.now_ms())
        {
            raise_fault(self, entry);
        }
        self.telemetry.finish(span, done);
    }
}

/// When a fault's entry was announced, read in the write that decides whether to announce it.
fn announced_at(tx: &Transaction<'_>, reference: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(tx
        .query_row(
            "SELECT announced_at FROM attention_announced WHERE kind = ?1 AND reference = ?2",
            params![FAULT, reference],
            |row| row.get(0),
        )
        .optional()?)
}

/// A list that cannot announce its new entries is still answered whole.
pub async fn read(app: &Arc<App>) -> Value {
    let gathered = gather(app).await;
    if let Err(refused) = announce(app, &gathered).await {
        tracing::warn!(error = %refused, "New attention entries were not announced");
    }
    let data: Vec<Value> = gathered.concerns.iter().map(Concern::to_json).collect();
    json!({ "data": data })
}

/// The housekeeping job that announces new entries when nobody reads the list.
pub async fn check(app: Arc<App>, _run: Run) -> Result<Report> {
    let raised = announce(&app, &gather(&app).await).await?;
    Ok(Report::done(json!({ "raised": raised })))
}

#[cfg(test)]
mod tests {
    use super::super::blobs::disk::Place;
    use super::*;
    use crate::settings::{Environment, Settings};

    async fn started() -> (tempfile::TempDir, Arc<App>) {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        (dir, App::start(settings).await.unwrap())
    }

    fn met_fault(app: &App) -> Entry {
        let place = faults::Place::Job("backup");
        app.attention
            .reported
            .record(Kind::Database, &place, app.clock.now_ms())
            .unwrap()
    }

    fn looking(app: &App, concerns: Vec<Concern>) -> Gathered {
        let order = app.attention.begun.fetch_add(1, Ordering::AcqRel) + 1;
        app.attention.looked.fetch_max(order, Ordering::AcqRel);
        Gathered {
            concerns,
            unknown: Vec::new(),
            order,
        }
    }

    fn health(reference: &str) -> Concern {
        Concern {
            kind: "health",
            failed_run: false,
            reference: reference.to_string(),
            title: String::new(),
            description: String::new(),
        }
    }

    fn keys(concerns: &[Concern]) -> Vec<Key> {
        concerns.iter().map(key_of).collect()
    }

    #[tokio::test]
    async fn a_failed_check_sends_from_memory_no_entry_a_fault_announced_after_its_read() {
        let (_dir, app) = started().await;
        let entry = met_fault(&app);
        let fault = fault_concern(&entry);
        let disk = health("disk");
        let gathered = looking(&app, vec![fault.clone(), disk.clone()]);
        let fresh = to_write(&app, &gathered).await.unwrap().unwrap();
        assert_eq!(keys(&fresh), keys(&[fault.clone(), disk.clone()]));

        let raised = write_fault(&app, fault.clone(), entry.first_ms, Chosen::default())
            .await
            .unwrap();
        assert_eq!(raised.raised, 1, "the fault is announced from the log");

        app.faults.set("fail:commit", Some(WRITE_ACTION)).unwrap();
        let chosen = Chosen::default();
        let refused = write_new(&app, &gathered, chosen.clone())
            .await
            .unwrap_err();
        assert!(database_failed(&refused));
        assert_eq!(keys(&chosen.or(fresh)), keys(&[disk]));
    }

    #[tokio::test]
    async fn a_fault_whose_commit_fails_after_a_check_announced_it_sends_nothing_from_memory() {
        let (_dir, app) = started().await;
        let entry = met_fault(&app);
        let fault = fault_concern(&entry);
        let gathered = looking(&app, vec![fault.clone()]);
        let written = write_new(&app, &gathered, Chosen::default()).await.unwrap();
        assert_eq!(
            written.raised, 1,
            "the check announces the fault from the log"
        );

        app.faults.set("fail:commit", Some(WRITE_ACTION)).unwrap();
        let chosen = Chosen::default();
        let refused = write_fault(&app, fault.clone(), entry.first_ms, chosen.clone())
            .await
            .unwrap_err();
        assert!(database_failed(&refused));
        assert!(chosen.or(vec![fault.clone()]).is_empty());

        // The witness: a write refused before its job sends the entry from memory.
        app.faults.set("refuse:write", None).unwrap();
        let chosen = Chosen::default();
        let refused = write_fault(&app, fault.clone(), entry.first_ms, chosen.clone())
            .await
            .unwrap_err();
        assert!(database_failed(&refused));
        assert_eq!(keys(&chosen.or(vec![fault.clone()])), keys(&[fault]));
    }

    #[test]
    fn a_backup_files_area_left_unlocked_asks_for_a_look_and_a_locked_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let area = dir.path().join("files").join("instance");
        let open =
            crate::server_lock::without_locks(|| Disk::open(&area, Place::BackupFiles, None))
                .unwrap();
        let concern = unlocked(&open).expect("no entry for an unlocked folder");
        assert_eq!(
            (concern.kind, concern.reference.as_str()),
            ("backup", "folder_unlocked")
        );
        assert!(
            concern.description.contains(&area.display().to_string()),
            "{}",
            concern.description
        );

        let locked = dir.path().join("locked");
        let held = Disk::open(&locked, Place::BackupFiles, None).unwrap();
        assert!(unlocked(&held).is_none());
    }

    #[test]
    fn an_adopts_claim_kept_in_a_folder_without_locks_asks_for_a_look_until_it_is_removed() {
        let (recorded, other) = (
            uuid::Uuid::now_v7().to_string(),
            uuid::Uuid::now_v7().to_string(),
        );
        let dir = tempfile::tempdir().unwrap();
        let folder = crate::app::blobs::folder::claimed_for(dir.path(), &recorded, &other);
        // The witness: a locked folder removes the claim and asks for nothing.
        folder.settle(Some(recorded.clone())).unwrap();
        assert!(claim_kept(&folder).is_none());

        let dir = tempfile::tempdir().unwrap();
        let folder = crate::app::blobs::folder::claimed_for(dir.path(), &recorded, &other);
        crate::server_lock::without_locks(|| folder.settle(Some(recorded.clone()))).unwrap();
        let concern = claim_kept(&folder).expect("no entry for a kept claim");
        assert_eq!(
            (concern.kind, concern.reference.as_str()),
            ("backup", "folder_claim_kept")
        );
        let pending = folder.files().root().join(PENDING);
        assert!(
            concern.description.contains(&pending.display().to_string()),
            "{}",
            concern.description
        );
        std::fs::remove_file(&pending).unwrap();
        assert!(claim_kept(&folder).is_none());
    }
}
