//! One open stream: it reads the log after the last id it handled, one page at a time, each page
//! judged for the credential as it stands when the page is read.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::DateTime;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until, timeout};

use super::frame::{Filter, Judge, Verdict, marker};
use super::page::{self, Next};
use crate::app::App;
use crate::app::faults::{
    FAIL_STREAM_CREDENTIAL, FAIL_STREAM_REPLAY, FAIL_STREAM_REPLAY_ROW, Faults, HOLD_STREAM_HEAD,
    HOLD_STREAM_REPLAY,
};
use crate::app::items::{Reader, reading};
use crate::app::refusal::{Code, Refusal, Result};

/// A quiet stream is pinged this often, and a reader that takes nothing for this long is closed.
pub const PING: Duration = Duration::from_secs(30);
const PAGE_ROWS: usize = 200;
const PAGE_BYTES: usize = 1 << 20;
/// The closing frame of a stream whose reader has stopped reading is not waited for long.
const CLOSING_SEND: Duration = Duration::from_secs(3);
/// The credential is read again at least this soon before a key's `expires_at`.
const MIN_EXPIRY_WAIT: Duration = Duration::from_millis(50);

#[derive(Clone, Default)]
pub struct Viewers(Arc<AtomicU64>);

/// Counted from admission to the end of the stream, however the stream ends.
pub struct Viewer(Arc<AtomicU64>);

impl Viewers {
    /// A `cap` of 0 admits every viewer.
    pub fn admit(&self, cap: u64) -> Option<Viewer> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |open| {
                (cap == 0 || open < cap).then_some(open + 1)
            })
            .ok()
            .map(|_| Viewer(self.0.clone()))
    }

    pub fn open(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Opening {
    pub filter: Filter,
    pub resume: Option<i64>,
}

/// The frames of a new stream, written as the reader takes them.
pub fn open(
    app: Arc<App>,
    caller: crate::app::access::Caller,
    opening: Opening,
    viewer: Viewer,
) -> mpsc::Receiver<String> {
    let (frames, feed) = mpsc::channel(1);
    let run = Run {
        stopping: app.stopping(),
        commits: app.db.commits(),
        app,
        caller,
        filter: opening.filter,
        resume: opening.resume,
        frames,
        position: 0,
        sent: None,
        last_output: Instant::now(),
        expiry: None,
        _viewer: viewer,
    };
    tokio::spawn(run.drive());
    feed
}

struct Run {
    app: Arc<App>,
    caller: crate::app::access::Caller,
    filter: Filter,
    resume: Option<i64>,
    frames: mpsc::Sender<String>,
    stopping: watch::Receiver<bool>,
    commits: watch::Receiver<u64>,
    /// The last id read, sent or not.
    position: i64,
    /// The last id sent.
    sent: Option<i64>,
    last_output: Instant,
    expiry: Option<Instant>,
    _viewer: Viewer,
}

/// Waits up to `patience` for the reader to take `text`. The channel holds one chunk, so a reader that
/// stops reading holds back the next page's read, and is let go once it has taken nothing for `patience`.
async fn hand_over(frames: &mpsc::Sender<String>, text: String, patience: Duration) -> bool {
    matches!(timeout(patience, frames.send(text)).await, Ok(Ok(())))
}

enum Ending {
    /// The reader left, or stopped reading.
    Gone,
    Closing(String),
}

#[derive(Default)]
struct Page {
    text: String,
    last_sent: Option<i64>,
    position: i64,
    more: bool,
    oldest: Option<i64>,
    gap: bool,
    damaged: Option<i64>,
    expires_at: Option<String>,
}

fn read_page(
    read: &Reader<'_, '_>,
    filter: &Filter,
    after: i64,
    replay: Option<&Faults>,
) -> Result<Page> {
    let bounds = page::bounds(read.tx)?;
    let mut page = Page {
        position: after,
        oldest: bounds.oldest,
        expires_at: read.caller.key().and_then(|key| key.expires_at.clone()),
        ..Page::default()
    };
    if bounds
        .oldest
        .is_some_and(|oldest| oldest > after.saturating_add(1))
    {
        page.gap = true;
        return Ok(page);
    }
    let judge = Judge {
        tx: read.tx,
        caller: &read.caller,
        rules: &read.catalog.rules,
        filter,
    };
    let mut scanned = 0;
    page::scan(read.tx, after, PAGE_ROWS, |entry| {
        scanned += 1;
        let Some(kind) = judge.wants(entry) else {
            page.position = entry.id;
            return Ok(Next::Continue);
        };
        let payload = if replay.is_some_and(|faults| faults.fail(FAIL_STREAM_REPLAY_ROW, None)) {
            "not json".to_string()
        } else {
            entry.payload()?
        };
        match judge.render(entry, kind, &payload)? {
            Verdict::Send(text) => {
                page.text.push_str(&text);
                page.last_sent = Some(entry.id);
                page.position = entry.id;
                Ok(if page.text.len() >= PAGE_BYTES {
                    Next::Stop
                } else {
                    Next::Continue
                })
            }
            Verdict::Withhold => {
                page.position = entry.id;
                Ok(Next::Continue)
            }
            Verdict::Unreadable => {
                page.damaged = Some(entry.id);
                Ok(Next::Stop)
            }
        }
    })?;
    if scanned == 0 {
        page.position = bounds.head.max(after);
    }
    page.more = scanned > 0 && page.damaged.is_none() && page.position < bounds.head;
    Ok(page)
}

impl Run {
    async fn drive(mut self) {
        if let Err(Ending::Closing(text)) = self.run().await {
            let _ = timeout(CLOSING_SEND, self.frames.send(text)).await;
        }
    }

    async fn run(&mut self) -> std::result::Result<(), Ending> {
        self.check_stop()?;
        let head = self.opening().await?;
        self.check_stop()?;
        self.send(frame(marker(
            "stream_cursor",
            vec![("cursor", head.to_string().into())],
        ))?)
        .await?;
        // A resumed stream reads one page whatever the head says, so a log the sweep has moved
        // past the cursor since the head was read ends the stream before `stream_live`.
        let mut resumed = self.resume.is_some();
        if resumed {
            self.app.faults.hold(HOLD_STREAM_REPLAY, None).await;
        }
        while resumed || self.position < head {
            resumed = false;
            self.check_stop()?;
            let faults = self.app.faults.clone();
            if faults.fail(FAIL_STREAM_REPLAY, None) {
                return Err(self.incomplete("read_failed"));
            }
            self.page(Some(faults)).await?;
        }
        self.send(frame(marker(
            "stream_live",
            vec![("cursor", self.position.max(head).to_string().into())],
        ))?)
        .await?;
        self.position = self.position.max(head);
        let mut stopping = self.stopping.clone();
        loop {
            self.drain().await?;
            if self.last_output.elapsed() >= PING {
                self.send(":ping\n\n".to_string()).await?;
            }
            let wake = self.expiry.map_or(self.last_output + PING, |expiry| {
                expiry.min(self.last_output + PING)
            });
            tokio::select! {
                biased;
                _ = stopping.wait_for(|stopping| *stopping) => {
                    return Err(self.incomplete("server_stopping"));
                }
                _ = self.frames.closed() => return Err(Ending::Gone),
                changed = self.commits.changed() => {
                    if changed.is_err() {
                        return Err(Ending::Gone);
                    }
                }
                () = sleep_until(wake) => {}
            }
        }
    }

    /// Reads the head, and settles a cursor the log cannot resume from.
    async fn opening(&mut self) -> std::result::Result<i64, Ending> {
        if self
            .app
            .faults
            .fail(crate::app::faults::FAIL_STREAM_HEAD, None)
        {
            return Err(self.incomplete("read_failed"));
        }
        let bounds = match reading(&self.app, &self.caller, |read| page::bounds(read.tx)).await {
            Ok(bounds) => bounds,
            Err(refusal) => return Err(self.failure(&refusal)),
        };
        self.app.faults.hold(HOLD_STREAM_HEAD, None).await;
        let Some(cursor) = self.resume else {
            self.position = bounds.head;
            return Ok(bounds.head);
        };
        if cursor > bounds.head {
            return Err(ending(marker(
                "cursor_ahead",
                vec![
                    ("requested", cursor.to_string().into()),
                    ("head", bounds.head.to_string().into()),
                ],
            )));
        }
        if let Some(oldest) = bounds
            .oldest
            .filter(|oldest| *oldest > cursor.saturating_add(1))
        {
            return Err(self.too_old(oldest, cursor));
        }
        self.position = cursor;
        Ok(bounds.head)
    }

    /// Reads and sends pages until the log holds nothing more after the position.
    async fn drain(&mut self) -> std::result::Result<(), Ending> {
        loop {
            self.check_stop()?;
            self.commits.borrow_and_update();
            if !self.page(None).await?.more {
                return Ok(());
            }
        }
    }

    /// One page: the credential is read again in the same snapshot as the log, and what the page holds is sent.
    async fn page(&mut self, replay: Option<Arc<Faults>>) -> std::result::Result<Page, Ending> {
        if self.app.faults.fail(FAIL_STREAM_CREDENTIAL, None) {
            return Err(self.incomplete("read_failed"));
        }
        let (filter, after) = (self.filter.clone(), self.position);
        let read = reading(&self.app, &self.caller, move |read| {
            read_page(read, &filter, after, replay.as_deref())
        })
        .await;
        let mut page = match read {
            Ok(page) => page,
            Err(refusal) => return Err(self.failure(&refusal)),
        };
        self.expiry = page
            .expires_at
            .as_deref()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .map(|at| {
                let wait = (at.to_utc() - self.app.clock.now())
                    .to_std()
                    .unwrap_or_default();
                Instant::now() + wait.max(MIN_EXPIRY_WAIT)
            });
        if page.gap {
            return Err(self.too_old(page.oldest.unwrap_or(after), after));
        }
        let text = std::mem::take(&mut page.text);
        if !text.is_empty() {
            self.send(text).await?;
            self.sent = page.last_sent;
        }
        self.position = page.position;
        if let Some(id) = page.damaged {
            tracing::error!(
                event_id = id,
                "A logged event does not read, and ends the streams that reach it"
            );
            return Err(self.too_old(id.saturating_add(1), id.saturating_sub(1)));
        }
        Ok(page)
    }

    fn check_stop(&self) -> std::result::Result<(), Ending> {
        if *self.stopping.borrow() {
            return Err(self.incomplete("server_stopping"));
        }
        Ok(())
    }

    async fn send(&mut self, text: String) -> std::result::Result<(), Ending> {
        if hand_over(&self.frames, text, PING).await {
            self.last_output = Instant::now();
            return Ok(());
        }
        Err(Ending::Gone)
    }

    fn failure(&self, refusal: &Refusal) -> Ending {
        if refusal.code == Code::Unauthorized {
            return self.incomplete("credential_ended");
        }
        tracing::error!(error = %refusal, "A stream could not read the log");
        self.incomplete("read_failed")
    }

    fn incomplete(&self, reason: &str) -> Ending {
        let cursor = self.sent.map_or(Value::Null, |id| json!(id.to_string()));
        ending(marker(
            "stream_incomplete",
            vec![("reason", reason.into()), ("cursor", cursor)],
        ))
    }

    fn too_old(&self, oldest: i64, requested: i64) -> Ending {
        ending(marker(
            "catchup_too_old",
            vec![
                ("min_retained_id", oldest.to_string().into()),
                ("requested", requested.to_string().into()),
            ],
        ))
    }
}

fn frame(text: Result<String>) -> std::result::Result<String, Ending> {
    text.map_err(|_| Ending::Gone)
}

fn ending(text: Result<String>) -> Ending {
    text.map_or(Ending::Gone, Ending::Closing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_viewer_is_counted_until_it_is_dropped() {
        let viewers = Viewers::default();
        let first = viewers.admit(2).unwrap();
        let second = viewers.admit(2).unwrap();
        assert_eq!(viewers.open(), 2);
        assert!(viewers.admit(2).is_none());
        assert_eq!(viewers.open(), 2, "a refused viewer is not counted");
        drop(first);
        assert_eq!(viewers.open(), 1);
        let third = viewers.admit(2).unwrap();
        assert!(viewers.admit(2).is_none());
        drop((second, third));
        assert_eq!(viewers.open(), 0);
    }

    #[test]
    fn a_cap_of_zero_admits_every_viewer() {
        let viewers = Viewers::default();
        let held: Vec<_> = (0..100).map(|_| viewers.admit(0).unwrap()).collect();
        assert_eq!(viewers.open(), 100);
        drop(held);
        assert_eq!(viewers.open(), 0);
    }

    #[tokio::test]
    async fn a_reader_that_takes_nothing_holds_back_the_producer_and_is_let_go() {
        let (frames, mut feed) = mpsc::channel(1);
        let patience = Duration::from_millis(60);
        assert!(hand_over(&frames, "one".into(), patience).await);
        let started = std::time::Instant::now();
        assert!(
            !hand_over(&frames, "two".into(), patience).await,
            "the second chunk waits for a reader that is not reading"
        );
        assert!(started.elapsed() >= patience);
        assert_eq!(feed.recv().await.as_deref(), Some("one"));
        assert!(
            feed.try_recv().is_err(),
            "the chunk that timed out was never queued"
        );
    }

    #[tokio::test]
    async fn a_reader_that_leaves_ends_the_wait_at_once() {
        let (frames, feed) = mpsc::channel(1);
        drop(feed);
        let started = std::time::Instant::now();
        assert!(!hand_over(&frames, "one".into(), Duration::from_secs(30)).await);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
