//! The `release-check` housekeeping job: asks GitHub for the newest published release and keeps
//! the answer as the job's result. A check that fails keeps the last release it found.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use url::Url;

use super::feed::Feed;
use super::release::{self, Latest};
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

/// Why the last check did not find a release, and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trouble {
    pub at: String,
    pub message: String,
}

/// What the job keeps between runs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    /// When a check last found the newest release.
    pub checked_at: Option<String>,
    pub latest: Option<Latest>,
    /// Why the latest check failed; `None` once one succeeds.
    pub error: Option<Trouble>,
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
        .document(&url, ANSWER_BYTES, TIME)
        .map_err(|failed| failed.words())?;
    release::read_latest(&body, release::platform()).map_err(str::to_string)
}

fn result(kept: &Kept) -> Value {
    json!(kept)
}

/// The request runs on a thread of its own: it blocks, and a stop must be able to leave it
/// behind, which the runtime's blocking pool would wait for.
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
        Ok(latest) => Kept {
            checked_at: Some(at),
            latest: Some(latest),
            error: None,
        },
        Err(message) => {
            tracing::warn!("The check for a new release failed: {message}");
            Kept {
                error: Some(Trouble { at, message }),
                ..before
            }
        }
    };
    Ok(Report::done(result(&after)))
}
