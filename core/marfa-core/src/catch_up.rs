use std::io::{self, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{CatchUpReport, Tier};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{EventPayload, WireType};
use crate::{Core, Result};

const STREAM_HARD_BOUND: Duration = Duration::from_secs(120);
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(15);
// The server budgets its head read at five seconds and only then announces
// the cursor, so the wait between the connect comment and the first event
// has to outlast that budget.
const HEAD_WAIT: Duration = Duration::from_secs(10);
const TYPE_FILTER_LIMIT: usize = 10;

/// How a follow paces itself. `PACE` is the one in use; the tests shorten
/// it so a wait that doubles to thirty seconds can be watched doubling.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    /// How often a held stream looks at its stop flag while nothing arrives.
    pub(crate) stop_poll: Duration,
    /// A held stream that says nothing, not even a keepalive, for this long
    /// is taken as gone and opened again.
    pub(crate) silence: Duration,
    /// The wait before asking again after a stream that could not be opened
    /// or ended early, doubling each time to `reconnect_most`. A stream that
    /// stayed open at least `reconnect_most` resets it, so the client's own
    /// bound on a stream is followed by an immediate reopen and a server
    /// that ends every stream at once is asked at most every
    /// `reconnect_most`.
    pub(crate) reconnect_first: Duration,
    pub(crate) reconnect_most: Duration,
    /// The longest `Retry-After` a follow waits out. A server may name any
    /// number, and one past this would park the follow for as long as it
    /// said; the server's own webhook delivery honors the same bound.
    pub(crate) retry_after_most: Duration,
}

pub(crate) const PACE: Pace = Pace {
    stop_poll: Duration::from_millis(250),
    silence: Duration::from_secs(90),
    reconnect_first: Duration::from_secs(1),
    reconnect_most: Duration::from_secs(30),
    retry_after_most: Duration::from_secs(300),
};

struct Slice {
    types: Vec<String>,
    tier: Tier,
}

/// One event a held stream applied (`device.md` 40): what it was, what it
/// was about, and the cursor it left behind.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    pub event: String,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
}

/// What a `follow` did before it was stopped.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FollowReport {
    pub applied: u64,
    pub skipped: u64,
    pub cursor: String,
    /// Streams asked for after the first: after the client's own bound on a
    /// stream, a stream that dropped or ended early, or one that could not
    /// be opened.
    pub reconnects: u64,
    /// Asks for a stream that failed and were retried, and the last reason.
    pub failed_opens: u64,
    pub last_failure: Option<String>,
}

/// What catch-up and follow both start from: the slice and the stored
/// cursor.
fn start(core: &Core) -> Result<(Slice, String)> {
    let conn = core.conn()?;
    if !store::hydration_complete(&conn)? {
        return Err(CoreError::HydrationIncomplete);
    }
    let cursor = store::meta_get(&conn, store::META_EVENT_CURSOR)?.ok_or(CoreError::NoCursor)?;
    if cursor.is_empty() || !cursor.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CoreError::Invalid(format!(
            "the stored event cursor {cursor:?} is not an event id"
        )));
    }
    let (types, tier) = store::slice(&conn)?.ok_or(CoreError::NoCursor)?;
    Ok((Slice { types, tier }, cursor))
}

/// The type catalog as the server has it now, written only where it differs
/// from the one held, so a reader told of every save is not told of this.
fn adopt(core: &Core, types: &[WireType]) -> Result<Catalog> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    store::replace_types(&tx, types)?;
    tx.commit()?;
    Catalog::load(&conn)
}

/// Opens the stream from `cursor` and reads its frames on a thread of their
/// own, so the caller can wait on them with a bound.
///
/// The thread outlives a caller that lets the frames go: it learns they are
/// unwanted only when it next has a frame to hand on, so it keeps the
/// connection, and nothing of the store, until the server's next keepalive
/// or the stream's `bound`.
fn open(
    http: &Http,
    cursor: &str,
    slice: &Slice,
    bound: Duration,
) -> Result<Receiver<io::Result<Frame>>> {
    let filter: &[String] = if slice.types.len() <= TYPE_FILTER_LIMIT {
        &slice.types
    } else {
        &[]
    };
    let reader = http.open_events(Some(cursor), filter, bound)?;
    let (sender, frames) = mpsc::sync_channel::<io::Result<Frame>>(256);
    thread::spawn(move || {
        let mut frames = Frames::new(BufReader::new(reader));
        loop {
            match frames.next_frame() {
                Ok(Some(frame)) => {
                    if sender.send(Ok(frame)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    Ok(frames)
}

/// Applies one event and moves the cursor past it, in one transaction.
/// Answers the change where the event changed the copy.
///
/// The connection is released before this returns, so a caller told of the
/// change can read the row it names without waiting on this.
fn take(
    core: &Core,
    catalog: &Catalog,
    slice: &Slice,
    id: &str,
    kind: &str,
    payload: &EventPayload,
) -> Result<Option<Change>> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    let applied = apply(&tx, catalog, slice, kind, payload)?;
    // The cursor is the last id received, never the highest: ids are
    // assigned before commit, so a lower id can arrive after a higher one
    // and would be skipped forever by a high-water mark.
    store::meta_set(&tx, store::META_EVENT_CURSOR, id)?;
    tx.commit()?;
    Ok(applied.then(|| Change {
        event: kind.to_string(),
        item_id: payload.item.as_ref().map(|item| item.id.clone()),
        edge_id: payload.edge.as_ref().map(|edge| edge.id.clone()),
        cursor: id.to_string(),
    }))
}

fn payload_of(data: &str) -> Result<EventPayload> {
    serde_json::from_str(data)
        .map_err(|error| CoreError::Decoding(format!("event {data:?}: {error}")))
}

pub(crate) fn catch_up(core: &Core, http: &Http, idle: Duration) -> Result<CatchUpReport> {
    let (slice, cursor) = start(core)?;
    let catalog = adopt(core, &http.types()?)?;
    let frames = open(http, &cursor, &slice, STREAM_HARD_BOUND)?;

    let mut report = CatchUpReport {
        applied: 0,
        skipped: 0,
        cursor: cursor.clone(),
        reached_head: false,
    };
    let mut head: Option<u64> = None;
    let mut connected = false;
    let mut prologue_seen = false;
    loop {
        let wait = if prologue_seen {
            idle
        } else if connected {
            HEAD_WAIT
        } else {
            FIRST_FRAME_WAIT
        };
        let frame = match frames.recv_timeout(wait) {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) => match error.kind() {
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock if connected => break,
                _ => return Err(CoreError::Network(error.to_string())),
            },
            Err(RecvTimeoutError::Timeout) if connected => break,
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreError::Network("the event stream sent nothing".into()));
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match frame {
            Frame::Comment(_) => connected = true,
            Frame::Event { id, name, data } => {
                connected = true;
                prologue_seen = true;
                let payload = payload_of(&data)?;
                match name.as_deref().unwrap_or(&payload.r#type) {
                    "stream_cursor" => {
                        head = payload.cursor.as_deref().and_then(|text| text.parse().ok());
                        if let (Some(head), Ok(have)) = (head, report.cursor.parse::<u64>())
                            && head <= have
                        {
                            report.reached_head = true;
                            break;
                        }
                    }
                    "catchup_too_old" => return Err(aged_out(core, payload)?),
                    "stream_incomplete" => {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    kind => {
                        let Some(id) = id else { continue };
                        if take(core, &catalog, &slice, &id, kind, &payload)?.is_some() {
                            report.applied += 1;
                        } else {
                            report.skipped += 1;
                        }
                        report.cursor = id.clone();
                        if let (Some(head), Ok(reached)) = (head, id.parse::<u64>())
                            && reached >= head
                        {
                            report.reached_head = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    Ok(report)
}

/// A cursor the log no longer holds: the store forgets it, which is what
/// sends the next caller to hydrate (`device.md` 16).
fn aged_out(core: &Core, payload: EventPayload) -> Result<CoreError> {
    let conn = core.conn()?;
    store::meta_delete(&conn, store::META_EVENT_CURSOR)?;
    Ok(CoreError::CatchUpTooOld {
        min_retained_id: payload.min_retained_id.unwrap_or_default(),
    })
}

/// Holds the stream open and applies each event as it arrives, under
/// catch-up's rules, until `stop` is set (`device.md` 40).
///
/// A stream that ends, drops or cannot be opened is opened again from the
/// stored cursor, so nothing between the two is lost: the cursor moves past
/// each event in the transaction that takes it, applied or skipped, and
/// never past one not yet taken. What does not clear by asking again ends
/// it: a cursor the log has aged past, a refused credential, a store that
/// is no longer hydrated, an answer no retry changes.
///
/// `stop` is looked at between frames and at least every quarter second,
/// including while a stream is being asked for: that request runs on a
/// thread of its own holding only the transport, so it cannot keep the
/// store once this has returned. The thread reading the last stream's
/// frames may hold its connection a while longer (`open` says how long).
pub(crate) fn follow(
    core: &Core,
    http: Arc<Http>,
    stop: &AtomicBool,
    on_change: &mut dyn FnMut(&Change),
) -> Result<FollowReport> {
    follow_paced(core, http, stop, on_change, &PACE, &mut |wait| {
        wait_unless_stopped(stop, wait, PACE.stop_poll);
    })
}

/// The follow, at a given pace and with a given way of waiting between
/// streams.
fn follow_paced(
    core: &Core,
    http: Arc<Http>,
    stop: &AtomicBool,
    on_change: &mut dyn FnMut(&Change),
    pace: &Pace,
    pause: &mut dyn FnMut(Duration),
) -> Result<FollowReport> {
    let mut report = FollowReport::default();
    let mut backoff = pace.reconnect_first;
    let mut asked = false;
    while !stop.load(Ordering::Relaxed) {
        let (slice, cursor) = start(core)?;
        report.cursor = cursor.clone();
        if asked {
            report.reconnects += 1;
        }
        asked = true;
        let Some(reached) = reach(&http, &cursor, &slice, stop, pace.stop_poll) else {
            break;
        };
        let (types, frames) = match reached {
            Ok(reached) => reached,
            Err(error) if passes(&error) => {
                report.failed_opens += 1;
                let wait = match &error {
                    CoreError::RateLimited {
                        retry_after_seconds: Some(seconds),
                        ..
                    } => backoff.max(Duration::from_secs(*seconds).min(pace.retry_after_most)),
                    _ => backoff,
                };
                report.last_failure = Some(error.to_string());
                pause(wait);
                backoff = (backoff * 2).min(pace.reconnect_most);
                continue;
            }
            Err(error) => return Err(error),
        };
        let catalog = adopt(core, &types)?;
        let opened = Instant::now();
        let mut heard = Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(report);
            }
            let frame = match frames.recv_timeout(pace.stop_poll) {
                Ok(Ok(frame)) => frame,
                Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) if heard.elapsed() > pace.silence => break,
                Err(RecvTimeoutError::Timeout) => continue,
            };
            heard = Instant::now();
            let Frame::Event { id, name, data } = frame else {
                continue;
            };
            let payload = payload_of(&data)?;
            match name.as_deref().unwrap_or(&payload.r#type) {
                "stream_cursor" => {}
                "catchup_too_old" => return Err(aged_out(core, payload)?),
                "stream_incomplete" => break,
                kind => {
                    let Some(id) = id else { continue };
                    match take(core, &catalog, &slice, &id, kind, &payload)? {
                        Some(change) => {
                            report.applied += 1;
                            on_change(&change);
                        }
                        None => report.skipped += 1,
                    }
                    report.cursor = id;
                }
            }
        }
        if opened.elapsed() >= pace.reconnect_most {
            backoff = pace.reconnect_first;
        } else {
            pause(backoff);
            backoff = (backoff * 2).min(pace.reconnect_most);
        }
    }
    Ok(report)
}

type Reached = Result<(Vec<WireType>, Receiver<io::Result<Frame>>)>;

/// Asks for the type catalog and the stream on a thread holding only the
/// transport, and waits for the answer while watching `stop`. `None` when
/// `stop` was set first.
fn reach(
    http: &Arc<Http>,
    cursor: &str,
    slice: &Slice,
    stop: &AtomicBool,
    poll: Duration,
) -> Option<Reached> {
    let (sender, answer) = mpsc::sync_channel::<Reached>(1);
    let http = Arc::clone(http);
    let cursor = cursor.to_string();
    let filter = slice.types.clone();
    let tier = slice.tier;
    thread::spawn(move || {
        let slice = Slice {
            types: filter,
            tier,
        };
        let reached = http.types().and_then(|types| {
            let frames = open(&http, &cursor, &slice, STREAM_HARD_BOUND)?;
            Ok((types, frames))
        });
        let _ = sender.send(reached);
    });
    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        match answer.recv_timeout(poll) {
            Ok(reached) => return Some(reached),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Some(Err(CoreError::Network(
                    "the request for the event stream ended with no answer".into(),
                )));
            }
        }
    }
}

/// Whether a failure to open a stream clears by asking again: the network,
/// a server busy or failing. Any other answer, a 404 or a 405 from a server
/// that is not Marfa's, ends the follow and says so rather than asking
/// forever without a word.
fn passes(error: &CoreError) -> bool {
    match error {
        CoreError::Network(_) | CoreError::RateLimited { .. } => true,
        CoreError::Server { status, .. } => *status >= 500 || *status == 408,
        _ => false,
    }
}

/// Sleeps for `wait`, looking at `stop` every `poll`. A wait too long to
/// add to the clock lasts until `stop` is set.
fn wait_unless_stopped(stop: &AtomicBool, wait: Duration, poll: Duration) {
    let until = Instant::now().checked_add(wait);
    while !stop.load(Ordering::Relaxed) {
        let left = until.map_or(poll, |until| {
            until.saturating_duration_since(Instant::now())
        });
        if left.is_zero() {
            return;
        }
        thread::sleep(poll.min(left));
    }
}

fn apply(
    tx: &rusqlite::Connection,
    catalog: &Catalog,
    slice: &Slice,
    kind: &str,
    payload: &EventPayload,
) -> Result<bool> {
    match kind {
        "item.purged" => {
            let Some(item) = &payload.item else {
                return Ok(false);
            };
            store::delete_item(tx, &item.id)
        }
        "item.created" | "item.updated" | "item.deleted" | "item.restored"
        | "item.state_changed" | "metadata.changed" => {
            let Some(item) = &payload.item else {
                return Ok(false);
            };
            // An event carrying a version *older* than the row held is
            // stale, and applying it would put back fields a later event
            // already replaced. Ids are assigned before commit, so a lower
            // id can arrive after a higher one: the stream's order is not
            // the version's (`device.md` 13).
            //
            // **Strictly older, not "no newer".** The version moves on a
            // write to an item's fields and on nothing else: a transition,
            // a delete, a restore and a tag write all move the modification
            // time and leave the version where it was. Every one of those
            // events therefore carries the version the device already
            // holds, and skipping them would mean a device never learning
            // that a row was archived, deleted or restored — silently, for
            // ever, while reporting the catch-up as clean.
            //
            // What is left is a genuine tie: two events can share a version
            // when one of them changed no field, and the version cannot
            // order them. The stream's order decides those (`device.md` 13).
            if let Some(held) = store::held_version(tx, &item.id)?
                && item.version < held
            {
                return Ok(false);
            }
            let tier = Tier::parse_wire(item.tier.as_deref())?;
            let in_slice = tier == Some(slice.tier)
                && slice
                    .types
                    .iter()
                    .any(|declared| catalog.matches(declared, &item.r#type));
            if in_slice {
                let tags = payload
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.tags.as_slice());
                let title_field = catalog.title_field(&item.r#type);
                store::upsert_item(tx, item, tags, title_field)?;
                store::lay_waiting_writes_over(tx, &item.id, title_field)?;
                Ok(true)
            } else {
                store::delete_item(tx, &item.id)
            }
        }
        "edge.created" | "edge.updated" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            if store::item_held(tx, &edge.source_id)? {
                store::upsert_edge(tx, edge)?;
                store::lay_waiting_edge_writes_over(tx, &edge.id)?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
        "edge.deleted" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            store::delete_edge(tx, &edge.id)
        }
        _ => Ok(false),
    }
}
