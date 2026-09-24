use std::collections::HashSet;
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

/// The events that decide a row by its type: whether the slice holds it, and
/// what its index entry leaves out.
const ITEM_CHANGES: [&str; 6] = [
    "item.created",
    "item.updated",
    "item.deleted",
    "item.restored",
    "item.state_changed",
    "metadata.changed",
];

/// A type the catalog was read again for, with the property where it was an
/// image under one.
type Unexplained = (String, Option<String>);

/// What an item event names that the catalog cannot answer for, where the
/// row could be in the slice, and that it has not been read again for
/// already: a type the catalog does not hold, or an image's data URI under a
/// property it does not know as that type's thumbnail.
///
/// Either may mean the server's catalog changed after this one was read, and
/// taking the event by this one would drop a row the slice holds through a
/// parent it has not seen, or index an image's base64. Neither has to: a
/// type the server will not describe stays unknown, and a property the type
/// declares as text, an `icon` say, can hold an image as well as one the
/// type has since made its thumbnail can. The catalog cannot tell those from
/// a change until it is read again, so each costs one read a stream:
/// `refreshed` holds what the stream has read again for, and an event naming
/// only those is taken by the catalog as it is.
///
/// Only an image's data URI is looked for, because only a thumbnail changes
/// what an entry leaves out, and a property its type does not declare is
/// otherwise nothing unusual: the server takes one on any type its strict
/// mode does not name. Every image is looked at rather than the first, so
/// one already read again for does not hide another after it.
fn unexplained(
    catalog: &Catalog,
    slice: &Slice,
    kind: &str,
    payload: &EventPayload,
    refreshed: &HashSet<Unexplained>,
) -> Option<Unexplained> {
    if !ITEM_CHANGES.contains(&kind) {
        return None;
    }
    let item = payload.item.as_ref()?;
    // A row of the other tier leaves the copy whatever its type is.
    if Tier::parse_wire(item.tier.as_deref()).ok()? != Some(slice.tier) {
        return None;
    }
    if !catalog.known(&item.r#type) {
        let named = (item.r#type.clone(), None);
        return (!refreshed.contains(&named)).then_some(named);
    }
    if !slice
        .types
        .iter()
        .any(|declared| catalog.matches(declared, &item.r#type))
    {
        return None;
    }
    let thumbnail = catalog.thumbnail_field(&item.r#type);
    item.properties
        .iter()
        .filter(|(name, value)| {
            thumbnail != Some(name.as_str())
                && value
                    .as_str()
                    .is_some_and(|text| text.starts_with("data:image/"))
        })
        .map(|(name, _)| (item.r#type.clone(), Some(name.clone())))
        .find(|named| !refreshed.contains(named))
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
    /// stream, a stream that dropped or ended early, one that could not be
    /// opened, or an event the catalog could not explain.
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
    let mut catalog = adopt(core, &http.types()?)?;
    let frames = open(http, &cursor, &slice, STREAM_HARD_BOUND)?;
    // Read for once each, so a type the server will not describe costs one
    // read of the catalog rather than one for every event naming it. A
    // catch-up is one stream, so this lasts the call.
    let mut refreshed = HashSet::new();

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
                        while let Some(named) =
                            unexplained(&catalog, &slice, kind, &payload, &refreshed)
                        {
                            refreshed.insert(named);
                            catalog = adopt(core, &http.types()?)?;
                        }
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
    // Read for once each in a stream: an event naming one again is taken by
    // the catalog as it is, so a type the server will not describe costs one
    // reopen rather than one for every event naming it. Streams chained by a
    // reopen for one of these count as one, and any other end forgets them,
    // so the next stream reads again for a property its type has since made
    // its thumbnail.
    let mut refreshed = HashSet::new();
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
        let mut behind = false;
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
                    // Left untaken with the cursor before it: the stream
                    // opened again at once reads the catalog first, then
                    // replays this event.
                    if let Some(named) = unexplained(&catalog, &slice, kind, &payload, &refreshed) {
                        refreshed.insert(named);
                        behind = true;
                        break;
                    }
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
        if behind {
            continue;
        }
        refreshed.clear();
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
        kind if ITEM_CHANGES.contains(&kind) => {
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
                let indexing = catalog.indexing(&item.r#type);
                store::upsert_item(tx, item, tags, &indexing)?;
                store::lay_waiting_writes_over(tx, &item.id, &indexing)?;
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::Server;
    use crate::scripted::{
        Answer, Scripted, Then, connected, event, item_payload, refusal, stream, types,
    };

    const NOTE: &str = "core.note";
    const MS: fn(u64) -> Duration = Duration::from_millis;

    /// Short enough to watch a wait double to its most. The waits between
    /// streams are recorded rather than slept.
    const QUICK: Pace = Pace {
        stop_poll: Duration::from_millis(10),
        silence: Duration::from_millis(150),
        reconnect_first: Duration::from_millis(10),
        reconnect_most: Duration::from_millis(40),
        retry_after_most: PACE.retry_after_most,
    };

    /// A store bound to `server` and hydrated by hand: `core.note` at
    /// `library`, cursor 10.
    fn hydrated(server: &Scripted) -> (tempfile::TempDir, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type(NOTE, None, Some("title"))],
            )
            .unwrap();
        }
        (dir, Arc::new(core))
    }

    struct Run {
        stop: Arc<AtomicBool>,
        changes: Receiver<Change>,
        done: Receiver<Result<FollowReport>>,
        waits: Arc<Mutex<Vec<Duration>>>,
    }

    impl Run {
        fn change(&self) -> Change {
            self.changes
                .recv_timeout(Duration::from_secs(5))
                .expect("no change was told")
        }

        fn stop(&self) {
            self.stop.store(true, Ordering::Relaxed);
        }

        fn ended(&self) -> Result<FollowReport> {
            self.done
                .recv_timeout(Duration::from_secs(5))
                .expect("the follow did not end")
        }

        fn waits(&self) -> Vec<Duration> {
            self.waits.lock().unwrap().clone()
        }
    }

    /// Follows on a thread of its own at `pace`, recording each wait
    /// between streams and setting `stop` on the `stop_on_wait`th.
    fn follow_on(core: &Arc<Core>, pace: Pace, stop_on_wait: Option<usize>) -> Run {
        let (told, changes) = mpsc::channel();
        let mut run = follow_telling(core, pace, stop_on_wait, move |change| {
            let _ = told.send(change.clone());
        });
        run.changes = changes;
        run
    }

    fn follow_telling(
        core: &Arc<Core>,
        pace: Pace,
        stop_on_wait: Option<usize>,
        mut on_change: impl FnMut(&Change) + Send + 'static,
    ) -> Run {
        let (_, changes) = mpsc::channel();
        let (ended, done) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let waits = Arc::new(Mutex::new(Vec::new()));
        let (core, flag, recorded) = (Arc::clone(core), Arc::clone(&stop), Arc::clone(&waits));
        thread::spawn(move || {
            let http = core.http.clone().unwrap();
            let mut pause = |wait: Duration| {
                let mut recorded = recorded.lock().unwrap();
                recorded.push(wait);
                if Some(recorded.len()) == stop_on_wait {
                    flag.store(true, Ordering::Relaxed);
                }
            };
            let result = follow_paced(&core, http, &flag, &mut on_change, &pace, &mut pause);
            let _ = ended.send(result);
        });
        Run {
            stop,
            changes,
            done,
            waits,
        }
    }

    #[test]
    fn a_stream_that_ends_at_once_is_asked_for_again_after_a_wait_doubling_to_the_most() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on("/events", vec![stream(vec![connected()], Then::End)]);
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, Some(5));
        let report = run.ended().unwrap();
        assert_eq!(
            run.waits(),
            [MS(10), MS(20), MS(40), MS(40), MS(40)],
            "the wait after a stream that ended early did not double to its most and stay there"
        );
        assert_eq!(server.seen("/events").len(), 5);
        assert_eq!(
            report.reconnects, 4,
            "reconnects counts the streams asked for after the first"
        );
        assert_eq!((report.failed_opens, report.last_failure), (0, None));
    }

    #[test]
    fn a_stream_that_cannot_be_opened_is_asked_for_again_after_a_wait_doubling_to_the_most() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on("/events", vec![refusal(503, "unavailable")]);
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, Some(4));
        let report = run.ended().unwrap();
        assert_eq!(run.waits(), [MS(10), MS(20), MS(40), MS(40)]);
        assert_eq!(report.failed_opens, 4);
        assert_eq!(report.reconnects, 3);
        let last = report.last_failure.expect("the failure was not recorded");
        assert!(last.contains("503"), "{last}");
    }

    #[test]
    fn a_stream_held_as_long_as_the_most_wait_resets_it() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let ended = || stream(vec![connected()], Then::End);
        server.on(
            "/events",
            vec![
                ended(),
                ended(),
                stream(
                    vec![connected()],
                    Then::Hold {
                        keepalive: Some(MS(5)),
                        lasting: Some(MS(100)),
                    },
                ),
                ended(),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, Some(3));
        run.ended().unwrap();
        assert_eq!(
            run.waits(),
            [MS(10), MS(20), MS(10)],
            "a stream held for the most wait was followed by a wait, or the next one did not start again from the first"
        );
    }

    #[test]
    fn a_busy_server_is_asked_again_after_the_wait_it_names_up_to_a_bound() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let limited = |after: &str| Answer::Json {
            status: 429,
            body: r#"{"error":{"code":"rate_limited","message":"scripted"}}"#.into(),
            headers: vec![("Retry-After".into(), after.into())],
        };
        server.on(
            "/events",
            vec![
                limited("1"),
                refusal(408, "request_timeout"),
                limited(&u64::MAX.to_string()),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, Some(3));
        let report = run.ended().unwrap();
        assert_eq!(
            run.waits(),
            [Duration::from_secs(1), MS(20), PACE.retry_after_most],
            "a 429's Retry-After was not waited out, a 408 was not asked again, or a Retry-After past the bound was waited out whole"
        );
        assert_eq!(report.failed_opens, 3);
        let last = report.last_failure.expect("the failure was not recorded");
        assert!(last.contains("rate limited"), "{last}");
    }

    #[test]
    fn an_answer_no_retry_changes_ends_the_follow() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on("/events", vec![refusal(404, "not_found")]);
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        assert!(matches!(run.ended(), Err(CoreError::NotFound { .. })));
        assert_eq!(server.seen("/events").len(), 1);
        assert!(run.waits().is_empty());
    }

    /// The pace in use is the one `device.md` 40 and the comments above
    /// state; the tests that run at `QUICK` hold what is done with it.
    #[test]
    fn the_pace_in_use_is_the_stated_one() {
        assert_eq!(PACE.reconnect_first, Duration::from_secs(1));
        assert_eq!(PACE.reconnect_most, Duration::from_secs(30));
        assert_eq!(PACE.stop_poll, MS(250));
        assert_eq!(PACE.silence, Duration::from_secs(90));
        assert_eq!(PACE.retry_after_most, Duration::from_secs(300));
    }

    #[test]
    fn a_wait_ends_when_stopped_and_one_too_long_for_the_clock_does_not_panic() {
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        let flag = Arc::clone(&stop);
        let started = Instant::now();
        thread::spawn(move || {
            wait_unless_stopped(&flag, Duration::MAX, MS(10));
            let _ = ended.send(());
        });
        thread::sleep(MS(50));
        stop.store(true, Ordering::Relaxed);
        done.recv_timeout(Duration::from_secs(2))
            .expect("the wait outlasted its stop, or panicked");
        assert!(started.elapsed() < Duration::from_secs(1));
        // The witness: unstopped, a wait lasts as long as it was asked to.
        let started = Instant::now();
        wait_unless_stopped(&AtomicBool::new(false), MS(60), MS(10));
        assert!(started.elapsed() >= MS(60));
    }

    /// Follows at the pace in use, on a thread, until told to stop.
    fn follow_for_real(core: &Arc<Core>) -> (Arc<AtomicBool>, Receiver<Result<FollowReport>>) {
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        let (core, flag) = (Arc::clone(core), Arc::clone(&stop));
        thread::spawn(move || {
            let _ = ended.send(core.follow(&flag, |_| {}));
        });
        (stop, done)
    }

    /// Stops a follow once `path` has been asked for, and says how long
    /// it took to end.
    fn stopped_after(
        server: &Scripted,
        path: &str,
        stop: &AtomicBool,
        done: &Receiver<Result<FollowReport>>,
    ) -> (Duration, FollowReport) {
        server.wait_for(path, 1, Duration::from_secs(5));
        thread::sleep(MS(150));
        let asked = Instant::now();
        stop.store(true, Ordering::Relaxed);
        let report = done
            .recv_timeout(Duration::from_secs(10))
            .expect("the follow did not end")
            .unwrap();
        (asked.elapsed(), report)
    }

    #[test]
    fn a_follow_stops_at_once_while_its_stream_is_talking() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected()],
                Then::Hold {
                    keepalive: Some(MS(20)),
                    lasting: None,
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let (stop, done) = follow_for_real(&core);
        let (took, _) = stopped_after(&server, "/events", &stop, &done);
        assert!(
            took < Duration::from_secs(1),
            "a follow told to stop went on reading its stream for {took:?}"
        );
    }

    #[test]
    fn a_follow_stops_within_its_poll_while_its_stream_is_silent() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected()],
                Then::Hold {
                    keepalive: None,
                    lasting: None,
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let (stop, done) = follow_for_real(&core);
        let (took, _) = stopped_after(&server, "/events", &stop, &done);
        // A quarter second's poll, and room for a loaded machine.
        assert!(
            took < MS(750),
            "a follow on a silent stream took {took:?} to notice it was told to stop"
        );
    }

    #[test]
    fn a_follow_stops_at_once_while_the_type_catalog_is_still_being_asked_for() {
        let server = Scripted::start();
        server.on("/types", vec![Answer::Stall]);
        let (_dir, core) = hydrated(&server);
        let (stop, done) = follow_for_real(&core);
        let (took, report) = stopped_after(&server, "/types", &stop, &done);
        assert!(
            took < Duration::from_secs(1),
            "a follow waited {took:?} on a catalog nobody answered after it was told to stop"
        );
        assert_eq!(report.cursor, "10");
    }

    fn incomplete() -> String {
        "event: stream_incomplete\ndata: {\"type\":\"stream_incomplete\",\"reason\":\"scripted\"}\n\n"
            .into()
    }

    fn held() -> Then {
        Then::Hold {
            keepalive: Some(MS(5)),
            lasting: None,
        }
    }

    fn created(id: &str, cursor: &str) -> String {
        event(
            cursor,
            "item.created",
            &item_payload("item.created", id, NOTE, 1),
        )
    }

    #[test]
    fn a_stream_the_server_calls_incomplete_is_opened_again_from_the_cursor() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![
                stream(vec![connected(), incomplete()], held()),
                stream(vec![connected(), created("n1", "11")], held()),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        let change = run.change();
        run.stop();
        let report = run.ended().unwrap();
        assert_eq!(change.cursor, "11");
        assert_eq!(
            report.cursor, "11",
            "the report does not say where the follow left the cursor"
        );
        let asked: Vec<_> = server
            .seen("/events")
            .into_iter()
            .map(|seen| seen.last_event_id)
            .collect();
        assert_eq!(asked, [Some("10".to_string()), Some("10".to_string())]);
    }

    #[test]
    fn a_stream_silent_past_the_bound_is_opened_again() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![
                stream(
                    vec![connected()],
                    Then::Hold {
                        keepalive: None,
                        lasting: None,
                    },
                ),
                stream(vec![connected(), created("n1", "11")], held()),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        assert_eq!(run.change().item_id.as_deref(), Some("n1"));
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_keepalive_is_hearing_from_the_server() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected()],
                Then::Hold {
                    keepalive: Some(MS(20)),
                    lasting: None,
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        thread::sleep(QUICK.silence * 4);
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            server.seen("/events").len(),
            1,
            "a stream saying nothing but keepalives was taken as silent and opened again"
        );
    }

    #[test]
    fn a_stream_that_fails_part_way_is_opened_again() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![
                stream(vec![connected()], Then::Break),
                stream(vec![connected(), created("n1", "11")], held()),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        assert_eq!(run.change().item_id.as_deref(), Some("n1"));
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn each_stream_opened_adopts_the_type_catalog_the_server_has_then() {
        let server = Scripted::start();
        server.on(
            "/types",
            vec![
                types(&[(NOTE, None)]),
                types(&[(NOTE, None), ("user.late", Some(NOTE))]),
            ],
        );
        server.on(
            "/events",
            vec![
                stream(vec![connected()], Then::End),
                stream(
                    vec![
                        connected(),
                        event(
                            "11",
                            "item.created",
                            &item_payload("item.created", "late", "user.late", 1),
                        ),
                    ],
                    held(),
                ),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        let change = run.change();
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            change.item_id.as_deref(),
            Some("late"),
            "a type registered between two streams was not learned by the second"
        );
        assert!(core.get("late").unwrap().is_some());
    }

    #[test]
    fn a_change_to_an_edge_names_the_edge() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let edge = r#"{"type":"edge.created","edge":{"id":"e1","source_id":"row","target_id":"other","edge_type":"references","properties":{},"version":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}"#;
        server.on(
            "/events",
            vec![stream(
                vec![connected(), event("11", "edge.created", edge)],
                held(),
            )],
        );
        let (_dir, core) = hydrated(&server);
        {
            let conn = core.conn().unwrap();
            let row = store::testing::wire_item(
                "row",
                NOTE,
                "active",
                "2026-01-01T00:00:00Z",
                serde_json::json!({ "title": "row" }),
            );
            store::upsert_item(
                &conn,
                &row,
                Some(&[]),
                &crate::catalog::Indexing::titled("title"),
            )
            .unwrap();
        }
        let run = follow_on(&core, QUICK, None);
        let change = run.change();
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            (change.event.as_str(), change.item_id, change.edge_id),
            ("edge.created", None, Some("e1".to_string()))
        );
    }

    #[test]
    fn a_listener_told_of_a_change_can_read_the_row_it_names() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(vec![connected(), created("n1", "11")], held())],
        );
        let (_dir, core) = hydrated(&server);
        let (read, rows) = mpsc::channel();
        let reader = Arc::clone(&core);
        let run = follow_telling(&core, QUICK, None, move |change| {
            let id = change.item_id.clone().unwrap();
            let _ = read.send(reader.get(&id).map(|row| row.map(|row| row.id)));
        });
        let row = rows
            .recv_timeout(Duration::from_secs(5))
            .expect("the listener could not read the row it was told of, so the follow held the store while telling it");
        run.stop();
        run.ended().unwrap();
        assert_eq!(row, Ok(Some("n1".to_string())));
    }

    #[test]
    fn a_fault_on_the_follows_thread_ends_it_with_a_refusal_and_frees_the_stream() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(vec![connected(), created("n1", "11")], held())],
        );
        let (_dir, core) = hydrated(&server);
        let ended = core.follow(&AtomicBool::new(false), |_| panic!("a listener fault"));
        match ended {
            Err(CoreError::Invalid(said)) => assert!(
                said.contains("a fault in the core: a listener fault"),
                "{said}"
            ),
            other => panic!("a fault ended the follow as {other:?}"),
        }
        // The claim went with the unwinding, so the copy can be followed again.
        assert!(core.claim_stream().is_ok());
    }

    /// Every image under a property the catalog does not know as the
    /// thumbnail is looked at, so one already read again for does not hide
    /// another after it in the same item. The thumbnail itself is never
    /// named, and neither is a type or property already read again for.
    #[test]
    fn an_image_already_read_again_for_does_not_hide_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let conn = store::open(&dir.path().join("core.sqlite")).unwrap();
        let mut photo = store::testing::wire_type("user.photo", None, Some("title"));
        photo.rest.insert(
            "fields".into(),
            serde_json::json!({ "cover": { "type": "thumbnail" } }),
        );
        store::replace_types(&conn, &[photo]).unwrap();
        let catalog = Catalog::load(&conn).unwrap();
        let slice = Slice {
            types: vec!["user.photo".into()],
            tier: Tier::Library,
        };
        let event = |r#type: &str| {
            let image = "data:image/png;base64,iVBORw0KGgo=";
            payload_of(
                &serde_json::json!({
                    "type": "item.created",
                    "item": {
                        "id": "row", "type": r#type, "state": "active", "tier": "library",
                        "version": 1, "schema_version": 1, "source": "test",
                        "occurred_at": "2026-01-01T00:00:00Z",
                        "created_at": "2026-01-01T00:00:00Z",
                        "updated_at": "2026-01-01T00:00:00Z",
                        "properties": { "icon": image, "cover": image, "badge": image, "title": image },
                    },
                    "metadata": { "tags": [] },
                })
                .to_string(),
            )
            .unwrap()
        };
        let named = |property: &str| ("user.photo".to_string(), Some(property.to_string()));
        let mut refreshed = HashSet::new();
        let photo = event("user.photo");
        let mut met = Vec::new();
        while let Some(next) = unexplained(&catalog, &slice, "item.created", &photo, &refreshed) {
            met.push(next.clone());
            refreshed.insert(next);
        }
        assert_eq!(
            met,
            [named("icon"), named("badge"), named("title")],
            "an image read again for hid the next, or the thumbnail was named as one the catalog cannot explain"
        );

        let gone = event("user.gone");
        let unknown = ("user.gone".to_string(), None);
        assert_eq!(
            unexplained(&catalog, &slice, "item.created", &gone, &refreshed),
            Some(unknown.clone())
        );
        refreshed.insert(unknown);
        assert_eq!(
            unexplained(&catalog, &slice, "item.created", &gone, &refreshed),
            None
        );
    }

    /// A stream that ends for any reason but an event the catalog could not
    /// explain forgets what it was read again for, so the next stream reads
    /// again for an image its property meets there. The streams a reopen for
    /// one chains together remember it.
    #[test]
    fn a_stream_that_ends_forgets_what_it_was_read_again_for() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        // A note carrying an image under a property its type does not declare.
        let with_image = |id: &str, cursor: &str| {
            let payload = item_payload("item.created", id, NOTE, 1).replace(
                &format!(r#""properties":{{"title":"{id}"}}"#),
                &format!(
                    r#""properties":{{"title":"{id}","icon":"data:image/png;base64,iVBORw0KGgo="}}"#
                ),
            );
            assert!(payload.contains("icon"), "the image was not written in");
            event(cursor, "item.created", &payload)
        };
        let first = with_image("n1", "11");
        let second = with_image("n2", "12");
        server.on(
            "/events",
            vec![
                // Met, and opened again for.
                stream(vec![connected(), first.clone()], held()),
                // Taken as it is, and the stream ends.
                stream(vec![connected(), first], Then::End),
                // Met again, in a stream of its own, and opened again for.
                stream(vec![connected(), second.clone()], held()),
                stream(vec![connected(), second], held()),
            ],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        assert_eq!(run.change().item_id.as_deref(), Some("n1"));
        assert_eq!(run.change().item_id.as_deref(), Some("n2"));
        run.stop();
        let report = run.ended().unwrap();
        assert_eq!(
            server.seen("/types").len(),
            4,
            "a stream after one that ended did not read the catalog again for an image its property had met before"
        );
        assert_eq!(report.reconnects, 3);
        assert_eq!(
            run.waits(),
            [QUICK.reconnect_first],
            "a reopen for an image waited as a stream that ended early does"
        );
    }

    #[test]
    fn neither_a_catch_up_nor_a_follow_runs_on_a_hydration_that_did_not_finish() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![
                    connected(),
                    "event: stream_cursor\ndata: {\"type\":\"stream_cursor\",\"cursor\":\"10\"}\n\n"
                        .into(),
                ],
                Then::End,
            )],
        );
        let (_dir, core) = hydrated(&server);
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        }
        assert_eq!(core.catch_up(), Err(CoreError::HydrationIncomplete));
        assert_eq!(
            core.follow(&AtomicBool::new(false), |_| {}),
            Err(CoreError::HydrationIncomplete)
        );
        assert!(server.seen("/types").is_empty());
        // The witness: the same store, its hydration finished, catches up,
        // reading the catalog the refusals above did not.
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        }
        assert!(core.catch_up().unwrap().reached_head);
        assert!(
            !server.seen("/types").is_empty(),
            "the catch-up read no catalog, so its absence above proves nothing"
        );
    }
}
