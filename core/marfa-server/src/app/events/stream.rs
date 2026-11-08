//! Each log page and its credential share one read snapshot.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::body::Bytes;
use chrono::DateTime;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until, timeout, timeout_at};

use super::frame::{Filter, Judge, Verdict, marker};
use super::page::{self, Next};
use crate::app::App;
use crate::app::access::reach::{Demand, Judge as Reach};
use crate::app::faults::{
    FAIL_STREAM_CREDENTIAL, FAIL_STREAM_REPLAY, FAIL_STREAM_REPLAY_ROW, FAIL_STREAM_REPLAY_UNTYPED,
    Faults, HOLD_STREAM_DRAIN, HOLD_STREAM_HEAD, HOLD_STREAM_REPLAY,
};
use crate::app::items::{Reader, reading_under};
use crate::app::refusal::{Code, Refusal, Result};

/// A quiet stream is pinged this often, and a reader that takes nothing for this long is closed.
pub const PING: Duration = Duration::from_secs(30);
const PAGE_ROWS: usize = 200;
const PAGE_BYTES: usize = 1 << 20;
/// Measure stalls per piece, not per page or frame.
const PIECE_BYTES: usize = 64 * 1024;
/// How long a closing frame and the end of the response may take before the connection is closed.
const CLOSING_SEND: Duration = Duration::from_secs(3);
/// How long a connection told to close may take to confirm it.
const CLOSE_ACK: Duration = Duration::from_secs(1);
/// The credential is read again at least this soon before a key's `expires_at`.
const MIN_EXPIRY_WAIT: Duration = Duration::from_millis(50);

#[derive(Clone, Default)]
pub struct Viewers(Arc<AtomicU64>);

/// Counted from admission to the end of the stream, however the stream ends.
pub struct Viewer(Arc<AtomicU64>);

impl Viewers {
    /// A `cap` of 0 admits every viewer.
    pub fn admit(&self, cap: u64) -> Option<Viewer> {
        let mut open = self.0.load(Ordering::Acquire);
        loop {
            if cap != 0 && open >= cap {
                return None;
            }
            match self
                .0
                .compare_exchange_weak(open, open + 1, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return Some(Viewer(self.0.clone())),
                Err(now) => open = now,
            }
        }
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

/// The reader's connection.
pub struct Hangup {
    /// Closes it.
    pub close: Box<dyn Fn() + Send + Sync>,
    /// Resolves once it is closed.
    pub closed: Pin<Box<dyn Future<Output = ()> + Send>>,
}

pub struct Opening {
    pub filter: Filter,
    pub resume: Option<i64>,
    /// Set on a copy stream: the reach it resumes under, none where it begins.
    pub reach: Option<String>,
}

/// Each page must satisfy the reach announced by the copy stream.
struct Copying {
    judge: Reach,
    reach: Option<String>,
}

impl Copying {
    fn demand(&self) -> Option<Demand> {
        self.reach
            .clone()
            .map(|reach| Demand::new(self.judge.clone(), reach))
    }
}

/// `hangup` closes the connection when its reader stalls.
pub fn open(
    app: Arc<App>,
    caller: crate::app::access::Caller,
    opening: Opening,
    viewer: Viewer,
    hangup: Option<Hangup>,
) -> mpsc::Receiver<Bytes> {
    let (frames, feed) = mpsc::channel(1);
    let copy = opening.filter.copy.then(|| Copying {
        judge: Reach::of(&app),
        reach: opening.reach,
    });
    let run = Run {
        stopping: app.stopping(),
        commits: app.db.commits(),
        app,
        caller,
        filter: opening.filter,
        resume: opening.resume,
        copy,
        frames,
        hangup,
        started: 0,
        position: 0,
        sent: None,
        torn: false,
        last_output: Instant::now(),
        checked: Instant::now(),
        expiry: None,
        viewer,
    };
    tokio::spawn(run.drive());
    feed
}

struct Run {
    app: Arc<App>,
    caller: crate::app::access::Caller,
    filter: Filter,
    resume: Option<i64>,
    copy: Option<Copying>,
    frames: mpsc::Sender<Bytes>,
    hangup: Option<Hangup>,
    stopping: watch::Receiver<bool>,
    commits: watch::Receiver<u64>,
    /// The id the stream began after: the cursor the client sent, or the head when it sent none.
    started: i64,
    /// The last id read, sent or not.
    position: i64,
    /// The last id whose whole frame was handed over.
    sent: Option<i64>,
    /// Part of a frame was handed over and the rest was not, so nothing may follow it.
    torn: bool,
    last_output: Instant,
    /// When the credential was last read.
    checked: Instant,
    expiry: Option<Instant>,
    viewer: Viewer,
}

/// A full channel holds back the next page's read.
async fn hand_over(frames: &mpsc::Sender<Bytes>, piece: Bytes, patience: Duration) -> bool {
    matches!(timeout(patience, frames.send(piece)).await, Ok(Ok(())))
}

/// How a handed-over piece ends.
enum Tail {
    /// At the end of a frame, which is the event `id` unless it is a marker or a ping.
    Whole(Option<i64>),
    /// Inside a frame.
    Cut,
}

enum Ending {
    /// The reader left, or stopped reading.
    Gone,
    Closing(String),
}

#[derive(Default)]
struct Page {
    /// Each frame with the id of its event.
    frames: Vec<(i64, String)>,
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
    let mut bytes = 0;
    page::scan(read.tx, after, PAGE_ROWS, |entry| {
        scanned += 1;
        let Some(kind) = judge.wants(entry) else {
            page.position = entry.id;
            return Ok(Next::Continue);
        };
        let mut payload = entry.payload()?;
        if let Some(faults) = replay {
            let (invalid, untyped) = (
                faults.fail(FAIL_STREAM_REPLAY_ROW, None),
                faults.fail(FAIL_STREAM_REPLAY_UNTYPED, None),
            );
            if invalid {
                payload = "not json".to_string();
            } else if untyped {
                payload = without_item_type(payload);
            }
        }
        match judge.render(entry, kind, &payload)? {
            Verdict::Send(text) => {
                bytes += text.len();
                page.frames.push((entry.id, text));
                page.position = entry.id;
                Ok(if bytes >= PAGE_BYTES {
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

/// The viewer's slot is freed once the connection is closed, or `ack` after it was told to close.
async fn release(hangup: Option<Hangup>, viewer: Viewer, deadline: Instant, ack: Duration) {
    if let Some(Hangup { close, closed }) = hangup {
        let mut closed = closed;
        if timeout_at(deadline, &mut closed).await.is_err() {
            close();
            let _ = timeout(ack, closed).await;
        }
    }
    drop(viewer);
}

impl Run {
    /// Hyper can hold a response's end for a reader that takes nothing, so its connection is closed at the deadline.
    async fn drive(mut self) {
        let ending = self.run().await;
        let deadline = Instant::now() + CLOSING_SEND;
        if let Err(Ending::Closing(text)) = ending {
            let _ = timeout_at(deadline, self.frames.send(Bytes::from(text))).await;
        }
        let Run {
            frames,
            hangup,
            viewer,
            ..
        } = self;
        drop(frames);
        release(hangup, viewer, deadline, CLOSE_ACK).await;
    }

    async fn run(&mut self) -> std::result::Result<(), Ending> {
        self.check_stop()?;
        let head = self.opening().await?;
        self.check_stop()?;
        self.announce("stream_cursor", head).await?;
        // Retention may have passed the cursor since the head was read.
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
        if self.copy.is_some() {
            // Only a log read to its end under the reach lets the marker certify the copy.
            self.app.faults.hold(HOLD_STREAM_DRAIN, None).await;
            self.drain().await?;
            // Delivering the last page took time in which the reach can have moved.
            self.reread().await?;
        }
        self.announce("stream_live", self.position.max(head))
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

    /// The marker that names where the stream stands, and for a copy stream the instance and reach it holds.
    async fn announce(&mut self, name: &str, cursor: i64) -> std::result::Result<(), Ending> {
        let mut fields: Vec<(&str, Value)> = vec![("cursor", cursor.to_string().into())];
        if let Some(copy) = &self.copy {
            let reach = copy.reach.clone().ok_or(Ending::Gone)?;
            fields.push(("instance_id", copy.judge.instance_id().into()));
            fields.push(("reach", reach.into()));
        }
        self.send(frame(marker(name, fields))?).await
    }

    /// Reads the head, in the snapshot that settles the reach of a copy stream.
    async fn head(&mut self) -> std::result::Result<page::Bounds, Ending> {
        let read = match &self.copy {
            None => {
                reading_under(&self.app, &self.caller, None, |read| {
                    Ok((page::bounds(read.tx)?, None))
                })
                .await
            }
            Some(copy) => {
                let (judge, asked) = (copy.judge.clone(), copy.reach.clone());
                reading_under(&self.app, &self.caller, None, move |read| {
                    let reach = match asked {
                        Some(asked) => {
                            judge.require(read.tx, &read.caller, &asked)?;
                            asked
                        }
                        None => judge.reach(read.tx, &read.caller)?,
                    };
                    Ok((page::bounds(read.tx)?, Some(reach)))
                })
                .await
            }
        };
        match read {
            Ok((bounds, reach)) => {
                if let (Some(copy), Some(reach)) = (self.copy.as_mut(), reach) {
                    copy.reach = Some(reach);
                }
                Ok(bounds)
            }
            Err(refusal) => Err(self.failure(&refusal)),
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
        let bounds = self.head().await?;
        self.app.faults.hold(HOLD_STREAM_HEAD, None).await;
        let Some(cursor) = self.resume else {
            self.started = bounds.head;
            self.position = bounds.head;
            return Ok(bounds.head);
        };
        self.started = cursor;
        let too_old = bounds
            .oldest
            .filter(|oldest| *oldest > cursor.saturating_add(1));
        if self.copy.is_some() && (cursor > bounds.head || too_old.is_some()) {
            self.announce("stream_cursor", bounds.head).await?;
        }
        if cursor > bounds.head {
            return Err(ending(marker(
                "cursor_ahead",
                vec![
                    ("requested", cursor.to_string().into()),
                    ("head", bounds.head.to_string().into()),
                ],
            )));
        }
        if let Some(oldest) = too_old {
            return Err(self.too_old(oldest));
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
        let demand = self.copy.as_ref().and_then(Copying::demand);
        let read = reading_under(&self.app, &self.caller, demand, move |read| {
            read_page(read, &filter, after, replay.as_deref())
        })
        .await;
        let mut page = match read {
            Ok(page) => page,
            Err(refusal) => return Err(self.failure(&refusal)),
        };
        self.credential_read(page.expires_at.as_deref());
        if page.gap {
            return Err(self.too_old(page.oldest.unwrap_or(after)));
        }
        self.send_frames(std::mem::take(&mut page.frames)).await?;
        self.position = page.position;
        if let Some(id) = page.damaged {
            tracing::error!(
                event_id = id,
                "A logged event does not read, and ends the streams that reach it"
            );
            return Err(self.too_old(page.oldest.unwrap_or(id)));
        }
        Ok(page)
    }

    fn credential_read(&mut self, expires_at: Option<&str>) {
        self.checked = Instant::now();
        self.expiry = expires_at
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .map(|at| {
                let wait = (at.to_utc() - self.app.clock.now())
                    .to_std()
                    .unwrap_or_default();
                Instant::now() + wait.max(MIN_EXPIRY_WAIT)
            });
    }

    /// Reads the credential again while a page is handed over.
    async fn recheck(&mut self) -> std::result::Result<(), Ending> {
        if self.app.faults.fail(FAIL_STREAM_CREDENTIAL, None) {
            return Err(self.cut_short("read_failed"));
        }
        self.reread().await
    }

    /// Reads the credential, and for a copy stream its reach, in a snapshot of its own.
    async fn reread(&mut self) -> std::result::Result<(), Ending> {
        let demand = self.copy.as_ref().and_then(Copying::demand);
        let read = reading_under(&self.app, &self.caller, demand, |read| {
            Ok(read.caller.key().and_then(|key| key.expires_at.clone()))
        })
        .await;
        match read {
            Ok(expires_at) => {
                self.credential_read(expires_at.as_deref());
                Ok(())
            }
            Err(refusal) if self.torn => {
                tracing::debug!(error = %refusal, "A stream ended inside a frame");
                Err(self.give_up())
            }
            Err(refusal) => Err(self.failure(&refusal)),
        }
    }

    /// A closing frame cannot follow part of a frame, so a torn stream is closed without one.
    fn cut_short(&self, reason: &str) -> Ending {
        if self.torn {
            self.give_up()
        } else {
            self.incomplete(reason)
        }
    }

    fn check_stop(&self) -> std::result::Result<(), Ending> {
        if *self.stopping.borrow() {
            return Err(self.incomplete("server_stopping"));
        }
        Ok(())
    }

    async fn send(&mut self, text: String) -> std::result::Result<(), Ending> {
        self.hand(text.into_bytes(), Tail::Whole(None)).await
    }

    async fn send_frames(&mut self, frames: Vec<(i64, String)>) -> std::result::Result<(), Ending> {
        for (piece, tail) in pieces(frames) {
            self.hand(piece, tail).await?;
        }
        Ok(())
    }

    /// A stop, a commit, a heartbeat and the credential's expiry come before the send.
    async fn hand(&mut self, piece: Vec<u8>, tail: Tail) -> std::result::Result<(), Ending> {
        let mut stopping = self.stopping.clone();
        // A clone, so the live loop still sees a commit made while this waits.
        let mut commits = self.commits.clone();
        let frames = self.frames.clone();
        let handing = hand_over(&frames, Bytes::from(piece), PING);
        tokio::pin!(handing);
        let handed = loop {
            let heartbeat = self.checked + PING;
            let recheck = self
                .expiry
                .map_or(heartbeat, |expiry| expiry.min(heartbeat));
            let stopped = tokio::select! {
                biased;
                _ = stopping.wait_for(|stopping| *stopping) => true,
                changed = commits.changed() => {
                    if changed.is_err() {
                        return Err(Ending::Gone);
                    }
                    false
                }
                () = sleep_until(recheck) => false,
                handed = &mut handing => break handed,
            };
            if stopped {
                return Err(self.cut_short("server_stopping"));
            }
            self.recheck().await?;
        };
        if !handed {
            return Err(self.give_up());
        }
        self.last_output = Instant::now();
        match tail {
            Tail::Whole(id) => {
                self.torn = false;
                if id.is_some() {
                    self.sent = id;
                }
            }
            Tail::Cut => self.torn = true,
        }
        Ok(())
    }

    /// Hyper may keep a stalled connection open after its body ends.
    fn give_up(&self) -> Ending {
        if let Some(hangup) = &self.hangup {
            (hangup.close)();
        }
        Ending::Gone
    }

    fn failure(&self, refusal: &Refusal) -> Ending {
        if refusal.code == Code::ReachChanged {
            return ending(marker("reach_changed", Vec::new()));
        }
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

    /// `oldest` is the oldest id the log holds.
    fn too_old(&self, oldest: i64) -> Ending {
        ending(marker(
            "catchup_too_old",
            vec![
                ("min_retained_id", oldest.to_string().into()),
                ("requested", self.started.to_string().into()),
            ],
        ))
    }
}

/// Keep frame boundaries unless a frame exceeds `PIECE_BYTES`.
fn pieces(frames: Vec<(i64, String)>) -> Vec<(Vec<u8>, Tail)> {
    let mut out = Vec::new();
    let mut piece: Vec<u8> = Vec::new();
    let mut last = None;
    for (id, text) in frames {
        if !piece.is_empty() && piece.len() + text.len() > PIECE_BYTES {
            out.push((std::mem::take(&mut piece), Tail::Whole(last.take())));
        }
        let mut rest = text.as_bytes();
        while piece.len() + rest.len() > PIECE_BYTES {
            let (head, tail) = rest.split_at(PIECE_BYTES - piece.len());
            piece.extend_from_slice(head);
            out.push((std::mem::take(&mut piece), Tail::Cut));
            rest = tail;
        }
        piece.extend_from_slice(rest);
        last = Some(id);
    }
    if !piece.is_empty() {
        out.push((piece, Tail::Whole(last)));
    }
    out
}

fn without_item_type(payload: String) -> String {
    let Ok(mut body) = serde_json::from_str::<Value>(&payload) else {
        return payload;
    };
    match body.get_mut("item").and_then(Value::as_object_mut) {
        Some(item) => {
            item.remove("type");
            body.to_string()
        }
        None => payload,
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
    use std::sync::atomic::AtomicBool;

    use tokio::time::sleep;

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
        assert!(hand_over(&frames, Bytes::from_static(b"one"), patience).await);
        let started = std::time::Instant::now();
        assert!(
            !hand_over(&frames, Bytes::from_static(b"two"), patience).await,
            "the second chunk waits for a reader that is not reading"
        );
        assert!(started.elapsed() >= patience);
        assert_eq!(feed.recv().await.as_deref(), Some(&b"one"[..]));
        assert!(
            feed.try_recv().is_err(),
            "the chunk that timed out was never queued"
        );
    }

    fn frames(sizes: &[usize]) -> Vec<(i64, String)> {
        (1..)
            .zip(sizes)
            .map(|(id, size)| (id, char::from(b'a' + id as u8).to_string().repeat(*size)))
            .collect()
    }

    #[test]
    fn a_page_is_cut_into_pieces_that_end_where_frames_end() {
        let page = frames(&[PIECE_BYTES / 2, PIECE_BYTES / 2, PIECE_BYTES / 4, 10]);
        let whole: String = page.iter().map(|(_, text)| text.as_str()).collect();
        let cut = pieces(page);
        assert!(cut.iter().all(|(piece, _)| piece.len() <= PIECE_BYTES));
        let joined: Vec<u8> = cut.iter().flat_map(|(piece, _)| piece.clone()).collect();
        assert_eq!(joined, whole.as_bytes());
        let ends: Vec<_> = cut
            .iter()
            .map(|(_, tail)| match tail {
                Tail::Whole(id) => *id,
                Tail::Cut => None,
            })
            .collect();
        assert_eq!(ends, [Some(2), Some(4)]);
    }

    #[test]
    fn a_frame_longer_than_a_piece_is_cut_and_only_its_last_piece_names_it() {
        let cut = pieces(frames(&[10, 3 * PIECE_BYTES + 5, 10]));
        assert!(cut.iter().all(|(piece, _)| piece.len() <= PIECE_BYTES));
        let tails: Vec<_> = cut
            .iter()
            .map(|(_, tail)| match tail {
                Tail::Whole(id) => format!("whole {id:?}"),
                Tail::Cut => "cut".to_string(),
            })
            .collect();
        assert_eq!(
            tails,
            ["whole Some(1)", "cut", "cut", "cut", "whole Some(3)"]
        );
        assert!(pieces(Vec::new()).is_empty());
    }

    #[tokio::test]
    async fn a_slow_reader_that_keeps_taking_pieces_is_not_let_go() {
        let (frames_in, mut feed) = mpsc::channel(1);
        let patience = Duration::from_millis(150);
        let page = frames(&[PIECE_BYTES; 6]);
        let producer = tokio::spawn(async move {
            for (piece, _) in pieces(page) {
                if !hand_over(&frames_in, Bytes::from(piece), patience).await {
                    return false;
                }
            }
            true
        });
        // Each piece takes most of the patience, so the page as a whole takes several times it.
        let mut taken = 0;
        while taken < 6 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            taken += usize::from(feed.recv().await.is_some());
        }
        assert!(
            producer.await.unwrap(),
            "a reader taking a piece in time was let go"
        );
    }

    #[tokio::test]
    async fn a_reader_that_leaves_ends_the_wait_at_once() {
        let (frames, feed) = mpsc::channel(1);
        drop(feed);
        let started = std::time::Instant::now();
        assert!(!hand_over(&frames, Bytes::from_static(b"one"), Duration::from_secs(30)).await);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_viewer_slot_is_held_until_the_connection_has_closed() {
        let viewers = Viewers::default();
        let viewer = viewers.admit(1).unwrap();
        let asked = Arc::new(AtomicBool::new(false));
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
        let hangup = Hangup {
            close: Box::new({
                let asked = asked.clone();
                move || asked.store(true, Ordering::Release)
            }),
            closed: Box::pin(async move {
                let _ = closed_rx.await;
            }),
        };
        let releasing = tokio::spawn(release(
            Some(hangup),
            viewer,
            Instant::now(),
            Duration::from_secs(30),
        ));
        while !asked.load(Ordering::Acquire) {
            sleep(Duration::from_millis(5)).await;
        }
        sleep(Duration::from_millis(100)).await;
        assert_eq!(viewers.open(), 1, "the slot was freed before the close");
        assert!(viewers.admit(1).is_none());
        closed_tx.send(()).unwrap();
        releasing.await.unwrap();
        assert_eq!(viewers.open(), 0);
        assert!(viewers.admit(1).is_some());
    }

    #[tokio::test]
    async fn a_connection_that_never_confirms_its_close_does_not_hold_the_slot_forever() {
        let viewers = Viewers::default();
        let viewer = viewers.admit(1).unwrap();
        let hangup = Hangup {
            close: Box::new(|| {}),
            closed: Box::pin(std::future::pending()),
        };
        let started = std::time::Instant::now();
        release(
            Some(hangup),
            viewer,
            Instant::now(),
            Duration::from_millis(80),
        )
        .await;
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(viewers.open(), 0);
    }
}
