//! The `release-check` housekeeping job.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use url::Url;

use super::feed::Feed;
use super::release::{self, Asset, Latest};
use crate::app::App;
use crate::app::faults::ReleaseFeed;
use crate::app::housekeeping::{self, Report, Run};
use crate::app::refusal::Result;
use crate::settings::registry::UPDATE_CHECK_ENABLED;

pub const JOB: &str = "release-check";

const LATEST: &str = "https://api.github.com/repos/withmarfa/marfa/releases/latest";
const ANSWER_BYTES: u64 = 1 << 20;
const TIME: Duration = Duration::from_secs(15);

pub fn enabled(app: &App) -> bool {
    app.settings.live().get(UPDATE_CHECK_ENABLED)
}

/// What the job keeps between runs, as flat values.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    pub checked_at: Option<String>,
    pub version: Option<String>,
    pub published_at: Option<String>,
    pub archive_url: Option<String>,
    pub archive_bytes: Option<u64>,
    pub checksums_url: Option<String>,
    pub checksums_bytes: Option<u64>,
    pub failed_at: Option<String>,
    pub error: Option<String>,
}

impl Kept {
    fn found(latest: Latest, at: String) -> Kept {
        Kept {
            checked_at: Some(at),
            version: Some(latest.version),
            published_at: Some(latest.published_at),
            archive_url: latest.archive.as_ref().map(|asset| asset.url.clone()),
            archive_bytes: latest.archive.map(|asset| asset.bytes),
            checksums_url: latest.checksums.as_ref().map(|asset| asset.url.clone()),
            checksums_bytes: latest.checksums.map(|asset| asset.bytes),
            failed_at: None,
            error: None,
        }
    }

    pub fn latest(&self) -> Option<Latest> {
        let asset = |url: &Option<String>, bytes: Option<u64>| {
            Some(Asset {
                url: url.clone()?,
                bytes: bytes?,
            })
        };
        Some(Latest {
            version: self.version.clone()?,
            published_at: self.published_at.clone()?,
            archive: asset(&self.archive_url, self.archive_bytes),
            checksums: asset(&self.checksums_url, self.checksums_bytes),
        })
    }
}

pub async fn kept(app: &App) -> Result<Kept> {
    let last = app
        .db
        .read(|tx| housekeeping::last_run(tx, JOB))
        .await?
        .and_then(|last| last.result);
    Ok(last
        .and_then(|result| serde_json::from_value(result).ok())
        .unwrap_or_default())
}

fn ask(feed: &Feed, address: &str) -> std::result::Result<Latest, String> {
    let url = Url::parse(address).map_err(|_| "the release address does not read".to_string())?;
    let body = feed
        .document(&url, ANSWER_BYTES, TIME, None)
        .map_err(|failed| failed.words())?;
    release::read_latest(&body, release::platform()).map_err(str::to_string)
}

fn result(kept: &Kept) -> Value {
    json!(kept)
}

/// Runs on a thread of its own, which a stop can leave behind.
pub async fn job(app: Arc<App>, run: Run) -> Result<Report> {
    let before = kept(&app).await?;
    let address = match app.faults.release_feed() {
        ReleaseFeed::Public => LATEST.to_string(),
        ReleaseFeed::At(address) => address,
        ReleaseFeed::Nowhere => return Ok(Report::done(result(&before))),
    };
    if !enabled(&app) {
        return Ok(Report::done(result(&before)));
    }
    let feed = Feed::new(app.faults.clone());
    let (answer, answered) = oneshot::channel();
    std::thread::Builder::new()
        .name("marfa-release-check".to_string())
        .spawn(move || {
            let _ = answer.send(ask(&feed, &address));
        })
        .map_err(|_| {
            crate::app::refusal::Refusal::internal("the release check's thread did not start")
        })?;
    let found = tokio::select! {
        found = answered => found.unwrap_or_else(|_| Err("the check did not finish".to_string())),
        () = run.stopped() => return Ok(Report::done(result(&before))),
    };
    let at = app.clock.stamp();
    let after = match found {
        Ok(latest) => Kept::found(latest, at),
        Err(message) => {
            tracing::warn!("The check for a new release failed: {message}");
            Kept {
                failed_at: Some(at),
                error: Some(message),
                ..before
            }
        }
    };
    Ok(Report::done(result(&after)))
}
