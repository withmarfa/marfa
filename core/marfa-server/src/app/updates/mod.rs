//! Release checks, and the update of a server installed as a service.

mod apply;
mod check;
mod feed;
mod install;
mod pending;
mod release;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

pub use check::{JOB as CHECK_JOB, enabled as checking, job as check};
pub use pending::{Start, on_start};

use super::refusal::{Code, Refusal, Result};
use super::{App, health};
use crate::db::{self, migrate::MIGRATIONS};
use crate::failure::Failure;
use crate::settings::DatabasePath;
use feed::Feed;
use install::Install;
use pending::{Folder, Outcome};
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
            record: Folder::of(database),
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

/// Before the files are touched: puts the old programs back after a release that did not stay up.
#[allow(
    clippy::disallowed_methods,
    reason = "this runs before the settings are read and the clock exists"
)]
pub fn before_start(database: &DatabasePath) -> Start {
    let Some(record) = Folder::of(database) else {
        return Start::Proceed;
    };
    let file = database.file();
    let at = marfa_rules::time::written(jiff::Timestamp::now().as_millisecond());
    pending::on_start(&record, &Version::running().to_string(), &at, &|| {
        file.as_deref()
            .and_then(|file| db::inspect(file, MIGRATIONS).ok())
            .and_then(|looked| looked.schema)
    })
}

pub fn settle_when_up(app: &Arc<App>) {
    let Some(record) = app.updates.record.clone() else {
        return;
    };
    if record.pending().is_none() {
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
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
        let record = record.clone();
        let at = app.clock.stamp();
        let _ = tokio::task::spawn_blocking(move || pending::settle(&record, &running, &at)).await;
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
        record.map_or((None, None), |record| (record.pending(), record.last()))
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
        "last": last,
    }))
}

pub async fn start(app: &Arc<App>) -> Result<Value> {
    let kept = if check::enabled(app) {
        check::kept(app).await?
    } else {
        check::Kept::default()
    };
    let Some(latest) = latest_newer(kept.latest()) else {
        return Err(Refusal::new(
            Code::UpdateNotReady,
            "No release newer than the running one has been found.",
        ));
    };
    let (Install::Service { programs }, Some(archive), Some(checksums), Some(platform)) = (
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
    if app.updates.begin(&latest.version) {
        let job = apply::Job {
            from: Version::running().to_string(),
            archive_name: release::archive_name(&latest.version, platform),
            version: latest.version,
            archive,
            checksums,
            programs: programs.clone(),
            database: file,
            record,
        };
        run(app.clone(), job);
    }
    status(app).await
}

fn run(app: Arc<App>, job: apply::Job) {
    let feed = Feed::new(app.faults.clone());
    tokio::spawn(async move {
        let version = job.version.clone();
        let record = job.record.clone();
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
                let record = record.clone();
                let at = app.clock.stamp();
                let _ = tokio::task::spawn_blocking(move || {
                    record.end(&at, Outcome::Failed, &version, Some(reason));
                })
                .await;
                app.updates.set(State::Idle);
            }
        }
    });
}
