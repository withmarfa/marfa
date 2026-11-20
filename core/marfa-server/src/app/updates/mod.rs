//! Release checks, and the update of a server installed as a service.

mod apply;
mod check;
mod feed;
mod install;
mod pending;
mod release;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rusqlite::Transaction;
use serde_json::{Value, json};
use tokio::sync::Notify;

pub use check::{JOB as CHECK_JOB, enabled as checking, job as check};

use super::access::{Caller, Permission};
use super::faults::HOLD_UPDATE_START;
use super::refusal::{Code, Refusal, Result};
use super::{App, audit, health, provenance};
use crate::db::{self, Write, migrate::MIGRATIONS};
use crate::failure::Failure;
use crate::settings::DatabasePath;
use feed::Feed;
use install::Install;
use pending::{Folder, Outcome, Settled};
use release::{Latest, Version};

/// The exit status that asks a service manager to start the server again.
pub const RESTART_STATUS: u8 = 75;

/// How long a new release stays up before its swap stands.
const SETTLE_AFTER: Duration = Duration::from_secs(20);
const SETTLE_LOOKS_AGAIN: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Idle,
    Fetching {
        version: String,
        stage: &'static str,
    },
    Restarting {
        version: String,
    },
}

pub struct Updates {
    state: Mutex<State>,
    restart: Notify,
    install: Install,
    record: Option<Folder>,
}

impl std::fmt::Debug for Updates {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("Updates").finish_non_exhaustive()
    }
}

impl Updates {
    pub fn new(database: &DatabasePath) -> Updates {
        Updates {
            state: Mutex::default(),
            restart: Notify::new(),
            install: install::detect(),
            record: pending::record_of(database),
        }
    }

    fn state(&self) -> State {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set(&self, state: State) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = state;
    }

    /// Whether this call started the update; another joins it.
    fn begin(&self, version: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if *state != State::Idle {
            return false;
        }
        *state = State::Fetching {
            version: version.to_string(),
            stage: apply::FETCHING,
        };
        true
    }

    fn stage(&self, stage: &'static str) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let State::Fetching { version, .. } = &*state {
            *state = State::Fetching {
                version: version.clone(),
                stage,
            };
        }
    }

    pub async fn restart_wanted(&self) {
        self.restart.notified().await;
    }
}

/// Where this start marks an upgrade of the database: only a server that `marfa server run`
/// started for an update to this release that has not settled. It blocks.
pub fn upgrade_marks(database: &DatabasePath) -> Option<Folder> {
    if !matches!(install::detect(), Install::Service { .. }) {
        return None;
    }
    let record = pending::record_of(database)?;
    match record.pending() {
        Ok(Some(pending)) if pending.to == Version::running().to_string() => Some(record),
        _ => None,
    }
}

/// What `--can-open` prints for a database file.
pub fn inspect(file: &Path) -> std::result::Result<String, Failure> {
    let looked = db::inspect(file, MIGRATIONS)?;
    let standing = match looked.standing {
        db::migrate::Standing::Current => "current",
        db::migrate::Standing::Unfinished => "new",
        db::migrate::Standing::Behind(_) => "behind",
    };
    Ok(json!({ "schema": looked.schema, "standing": standing }).to_string())
}

/// What a program prints for `--version`, or `None` when it does not run and say.
fn reports(program: &Path) -> Option<String> {
    apply::ask(program, &["--version".as_ref()])
        .ok()
        .filter(|ran| ran.status.success())
        .map(|ran| ran.stdout.trim().to_string())
}

/// Only a server `marfa server run` started settles: one started another way could move the
/// programs while that command supervises them.
pub fn settle_when_up(app: &Arc<App>) {
    let Some(record) = app.updates.record.clone() else {
        return;
    };
    if !matches!(app.updates.install, Install::Service { .. }) {
        return;
    }
    let database = app.settings.start.database.file();
    let app = app.clone();
    tokio::spawn(async move {
        let unsettled = {
            let record = record.clone();
            tokio::task::spawn_blocking(move || record.pending())
                .await
                .is_ok_and(|read| !matches!(read, Ok(None)))
        };
        if !unsettled {
            return;
        }
        let mut stopping = app.stopping();
        let running = Version::running().to_string();
        let mut wait = SETTLE_AFTER;
        loop {
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                _ = stopping.wait_for(|stopping| *stopping) => return,
            }
            if health::check(&app).await.overall() != health::Status::Down {
                break;
            }
            wait = SETTLE_LOOKS_AGAIN;
        }
        let at = app.clock.stamp();
        let settled = tokio::task::spawn_blocking(move || {
            // The old server gets this server's own environment, as `marfa server run` gave it.
            let cannot = |pending: &pending::Pending| match database.as_deref() {
                Some(file) => pending::cannot_put_back(pending, file, &[]),
                None => Some("this server has no database file".to_string()),
            };
            pending::settle(
                &record,
                database.as_deref(),
                &running,
                &at,
                &cannot,
                &reports,
            )
        })
        .await;
        if let Ok(Settled::PutBack) = settled {
            tracing::warn!(
                "The new release's programs were not all in place, and the server ends to start the old ones"
            );
            app.updates.set(State::Restarting {
                version: Version::running().to_string(),
            });
            app.updates.restart.notify_one();
        }
    });
}

fn latest_newer(latest: Option<Latest>) -> Option<Latest> {
    latest.filter(|latest| {
        latest
            .version()
            .is_some_and(|found| found > Version::running())
    })
}

pub async fn status(app: &App) -> Result<Value> {
    let enabled = check::enabled(app);
    let kept = if enabled {
        check::kept(app).await?
    } else {
        check::Kept::default()
    };
    let newer = latest_newer(kept.latest());
    let (method, step) = match &newer {
        Some(newer) => {
            let capable = matches!(app.updates.install, Install::Service { .. })
                && newer.archive.is_some()
                && newer.checksums.is_some();
            if capable {
                ("server", None)
            } else {
                let how = match &app.updates.install {
                    Install::Container => &Install::Container,
                    _ => &Install::Other,
                };
                ("manual", install::step(how, &newer.version))
            }
        }
        None => (
            if matches!(app.updates.install, Install::Service { .. }) {
                "server"
            } else {
                "manual"
            },
            None,
        ),
    };
    let progress = match app.updates.state() {
        State::Idle => json!({ "state": "idle", "release": null }),
        State::Fetching { version, stage } => json!({ "state": stage, "release": version }),
        State::Restarting { version } => json!({ "state": "restarting", "release": version }),
    };
    let record = app.updates.record.clone();
    let (settling, last) = tokio::task::spawn_blocking(move || {
        fn read<T>(name: &str, read: std::io::Result<Option<T>>) -> Option<T> {
            read.unwrap_or_else(|error| {
                tracing::warn!("The update's {name} could not be read: {error}");
                None
            })
        }
        record.map_or((None, None), |record| {
            (
                read("record", record.pending()),
                read("outcome", record.last()),
            )
        })
    })
    .await
    .map_err(|_| Refusal::internal("the update's record did not read"))?;
    let progress = match settling {
        Some(pending) if progress["state"] == "idle" => {
            json!({ "state": "settling", "release": pending.to })
        }
        _ => progress,
    };
    Ok(json!({
        "release": Version::running().to_string(),
        "check_enabled": enabled,
        "checked_at": kept.checked_at,
        "check_error": kept.error.as_ref().map(|message| json!({
            "at": kept.failed_at,
            "message": message,
        })),
        "latest": kept.latest().map(|latest| json!({
            "release": latest.version,
            "published_at": latest.published_at,
        })),
        "available": newer.is_some(),
        "method": method,
        "step": step,
        "progress": progress,
        "last": last.map(|last| json!({
            "outcome": last.outcome,
            "release": last.release,
            "finished_at": last.finished_at,
            "reason": last.reason,
        })),
    }))
}

pub const UPDATE_STARTED: &str = "instance.update.started";

/// What a start did, or why a gate stopped it.
pub enum Started<T> {
    /// The update runs, begun by this call or by one before it.
    Running(Value),
    Stopped(T),
}

pub async fn start(app: &Arc<App>, caller: &Caller) -> Result<Value> {
    match start_if(app, caller, |_, _| Ok(None::<()>)).await? {
        Started::Running(status) => Ok(status),
        Started::Stopped(()) => Err(Refusal::internal("an open gate stopped the update")),
    }
}

/// Decided as the writer admits it, so no change to the caller's access commits between the
/// decision and the start. `gate` judges the newest release found in the same write, and
/// anything it writes commits with the start.
pub async fn start_if<T, G>(app: &Arc<App>, caller: &Caller, gate: G) -> Result<Started<T>>
where
    T: Send + 'static,
    G: FnOnce(&Transaction<'_>, &str) -> Result<Option<T>> + Send + 'static,
{
    app.faults.hold(HOLD_UPDATE_START, None).await;
    let (deciding, caller, origin) = (app.clone(), caller.clone(), provenance::current());
    let decided = begin_on_writer(
        app.clone(),
        |app: &App| &app.db,
        |app: &App| app.updates.set(State::Idle),
        move |tx, begun: &Begun| {
            let at = deciding.clock.stamp();
            let caller = caller.current(tx, &at)?;
            caller.require(Permission::InstanceMaintain)?;
            let kept = if check::enabled(&deciding) {
                check::kept_in(tx)?
            } else {
                check::Kept::default()
            };
            let latest = newest(kept)?;
            if let Some(stopped) = gate(tx, &latest.version)? {
                return Ok(Err(stopped));
            }
            let job = decide(&deciding, latest)?;
            if !deciding.updates.begin(&job.version) {
                return Ok(Ok(None));
            }
            begun.mark();
            audit::record_from(
                tx,
                &at,
                Some(&caller),
                origin.client_ip.as_deref(),
                audit::Entry {
                    action: UPDATE_STARTED,
                    resource_type: "instance",
                    resource_id: None,
                    details: origin.mark(Some(json!({ "from": job.from, "to": job.version }))),
                },
            )?;
            Ok(Ok(Some(run(deciding.clone(), job))))
        },
    )
    .await?;
    match decided {
        Ok(()) => Ok(Started::Running(status(app).await?)),
        Err(stopped) => Ok(Started::Stopped(stopped)),
    }
}

/// What `decide` marks once it has begun the update, so a write that then fails undoes it.
struct Begun(Arc<AtomicBool>);

impl Begun {
    fn mark(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Runs `decide` on the writer from a task of its own, and starts what it begins once the write
/// has committed, so begun work runs even if the request is gone by then.
async fn begin_on_writer<O, W, T>(
    owner: Arc<O>,
    db: fn(&O) -> &db::Db,
    undo_begin: fn(&O),
    decide: impl FnOnce(&Transaction<'_>, &Begun) -> Result<std::result::Result<Option<W>, T>>
    + Send
    + 'static,
) -> Result<std::result::Result<(), T>>
where
    O: Send + Sync + 'static,
    W: Future<Output = ()> + Send + 'static,
    T: Send + 'static,
{
    let begun = Arc::new(AtomicBool::new(false));
    let marked = Begun(begun.clone());
    let task = tokio::spawn(provenance::carried(async move {
        let decided = db(&owner)
            .write(Write::caller(UPDATE_STARTED), move |tx| decide(tx, &marked))
            .await;
        match decided {
            Ok(Ok(Some(work))) => {
                tokio::spawn(work);
                Ok(Ok(()))
            }
            Ok(Ok(None)) => Ok(Ok(())),
            Ok(Err(stopped)) => Ok(Err(stopped)),
            Err(failed) => {
                if begun.load(Ordering::SeqCst) {
                    undo_begin(&owner);
                }
                Err(failed)
            }
        }
    }));
    task.await
        .map_err(|_| Refusal::internal("the update's start stopped without an answer"))?
}

fn newest(kept: check::Kept) -> Result<Latest> {
    latest_newer(kept.latest()).ok_or_else(|| {
        Refusal::new(
            Code::UpdateNotReady,
            "No release newer than the running one has been found.",
        )
    })
}

/// The release the server runs.
pub fn running() -> String {
    Version::running().to_string()
}

/// The release an update would move to now, refused as `POST /update` refuses it.
pub async fn offer(app: &App) -> Result<String> {
    let kept = if check::enabled(app) {
        check::kept(app).await?
    } else {
        check::Kept::default()
    };
    Ok(decide(app, newest(kept)?)?.version)
}

fn decide(app: &App, latest: Latest) -> Result<apply::Job> {
    let (Install::Service { programs, dir }, Some(archive), Some(checksums), Some(platform)) = (
        &app.updates.install,
        latest.archive.clone(),
        latest.checksums.clone(),
        release::platform(),
    ) else {
        let how = match &app.updates.install {
            Install::Container => Install::Container,
            _ => Install::Other,
        };
        let step = install::step(&how, &latest.version).unwrap_or_default();
        return Err(Refusal::new(
            Code::UpdateUnavailable,
            format!("This server cannot update itself. {step}"),
        )
        .with_detail("step", step));
    };
    let Some(file) = app.settings.start.database.file() else {
        return Err(Refusal::internal(
            "an installed service has no database file",
        ));
    };
    let Some(record) = app.updates.record.clone() else {
        return Err(Refusal::internal(
            "an installed service has no record folder",
        ));
    };
    Ok(apply::Job {
        from: Version::running().to_string(),
        archive_name: release::archive_name(&latest.version, platform),
        version: latest.version,
        archive,
        checksums,
        programs: programs.clone(),
        dir: dir.clone(),
        database: file,
        record,
        attempt: uuid::Uuid::now_v7().to_string(),
    })
}

async fn run(app: Arc<App>, job: apply::Job) {
    let feed = Feed::new(app.faults.clone());
    let version = job.version.clone();
    let record = job.record.clone();
    let attempt = job.attempt.clone();
    let stages = app.clone();
    let done = tokio::task::spawn_blocking(move || {
        apply::run(&feed, &job, &|stage| stages.updates.stage(stage))
    })
    .await
    .unwrap_or_else(|_| Err("The update stopped without an answer.".to_string()));
    match done {
        Ok(()) => {
            tracing::info!("Release {version} is in place, and the server ends to start it");
            app.updates.set(State::Restarting { version });
            app.updates.restart.notify_one();
        }
        Err(reason) => {
            tracing::warn!("The update to release {version} did not go ahead: {reason}");
            let at = app.clock.stamp();
            let _ = tokio::task::spawn_blocking(move || {
                pending::end(
                    &record,
                    &at,
                    Outcome::Failed,
                    &version,
                    Some(reason),
                    Some(&attempt),
                );
            })
            .await;
            app.updates.set(State::Idle);
        }
    }
}
