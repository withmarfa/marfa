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
use crate::wire::{EventPayload, WireEdge, WireItem, WireType};
use crate::{Core, Result};

const STREAM_HARD_BOUND: Duration = Duration::from_secs(120);
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(15);
// The server budgets its head read at five seconds before it announces the
// cursor, so this has to outlast that budget.
const HEAD_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    pub(crate) stop_poll: Duration,
    pub(crate) silence: Duration,
    /// Doubles to `reconnect_most`. A stream that stayed open at least
    /// `reconnect_most` resets it, so the client's own bound on a stream is
    /// followed by an immediate reopen, while a server that ends every
    /// stream at once is asked at most every `reconnect_most`.
    pub(crate) reconnect_first: Duration,
    pub(crate) reconnect_most: Duration,
}

pub(crate) const PACE: Pace = Pace {
    stop_poll: Duration::from_millis(250),
    silence: Duration::from_secs(90),
    reconnect_first: Duration::from_secs(1),
    reconnect_most: Duration::from_secs(30),
};

struct Slice {
    types: Vec<String>,
    tier: Tier,
    whole: Vec<String>,
}

const ITEM_CHANGES: [&str; 6] = [
    "item.created",
    "item.updated",
    "item.deleted",
    "item.restored",
    "item.state_changed",
    "metadata.changed",
];

/// A type the catalog was read again for, and the property where an image
/// under it was the reason.
type Unexplained = (String, Option<String>);

/// What an event names that the catalog may be stale about: an unknown type,
/// or an image under a property that is not the type's thumbnail.
fn unexplained(
    catalog: &Catalog,
    slice: &Slice,
    kind: &str,
    payload: &EventPayload,
    refreshed: &HashSet<Unexplained>,
    pinned: bool,
) -> Option<Unexplained> {
    if !ITEM_CHANGES.contains(&kind) {
        return None;
    }
    let item = payload.item.as_ref()?;
    // A row of the other tier leaves the copy whatever its type is.
    if !pinned && Tier::parse_wire(item.tier.as_deref()).ok()? != Some(slice.tier) {
        return None;
    }
    if !catalog.known(&item.r#type) {
        let named = (item.r#type.clone(), None);
        return (!refreshed.contains(&named)).then_some(named);
    }
    if !pinned
        && !slice
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    pub event: String,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FollowReport {
    pub applied: u64,
    pub skipped: u64,
    pub cursor: String,
    /// Streams asked for after the first, for any reason.
    pub reconnects: u64,
    /// Counts failed reads of a row entering the slice as well as failed asks
    /// for a stream.
    pub failed_opens: u64,
    pub last_failure: Option<String>,
}

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
    let whole = store::whole_edge_types(&conn)?;
    Ok((Slice { types, tier, whole }, cursor))
}

fn pinned_row(core: &Core, payload: &EventPayload) -> Result<bool> {
    match &payload.item {
        Some(item) => store::pinned(&*core.conn()?, &item.id),
        None => Ok(false),
    }
}

/// Written only where it differs from the one held, so a reader told of every
/// save is not told of this.
fn adopt(core: &Core, types: &[WireType]) -> Result<Catalog> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    store::replace_types(&tx, types)?;
    tx.commit()?;
    Catalog::load(&conn)
}

/// The reading thread outlives a caller that lets the frames go: it learns
/// they are unwanted only when it next has a frame to hand on, so it keeps
/// the connection, and nothing of the store, until the server's next
/// keepalive or the stream's `bound`.
fn open(http: &Http, cursor: &str, bound: Duration) -> Result<Receiver<io::Result<Frame>>> {
    // Every type the key reads, not the slice's alone: the server narrows a
    // stream by the type a row has now, so one narrowed to the slice never
    // carries the frame of a row retyped out of it.
    let reader = http.open_events(Some(cursor), bound)?;
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

/// The connection is released before this returns, so a caller told of the
/// change can read the row it names.
fn take(
    core: &Core,
    catalog: &Catalog,
    slice: &Slice,
    id: &str,
    kind: &str,
    payload: &EventPayload,
) -> Result<Option<Change>> {
    let brought = edges_of_entering_row(core, catalog, slice, kind, payload)?;
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    let applied = apply(&tx, catalog, slice, kind, payload)?;
    if applied {
        for edge in &brought {
            store::upsert_edge(&tx, edge)?;
        }
    }
    // The last id applied, never the highest seen: where an event is not
    // applied, a high-water mark would step over it forever.
    store::meta_set(&tx, store::META_EVENT_CURSOR, id)?;
    tx.commit()?;
    Ok(applied.then(|| Change {
        event: kind.to_string(),
        item_id: payload.item.as_ref().map(|item| item.id.clone()),
        edge_id: payload.edge.as_ref().map(|edge| edge.id.clone()),
        cursor: id.to_string(),
    }))
}

/// Frames the filter or the credential withheld are never sent, so the
/// replay's marker is the only word this reader has that it is past them.
/// Never moves the cursor back.
fn pass_withheld(core: &Core, held: &str, live: Option<&str>) -> Result<Option<String>> {
    let Some(live) = live else { return Ok(None) };
    let (Ok(reached), Ok(have)) = (live.parse::<u64>(), held.parse::<u64>()) else {
        return Ok(None);
    };
    if reached <= have {
        return Ok(None);
    }
    let conn = core.conn()?;
    store::meta_set(&conn, store::META_EVENT_CURSOR, live)?;
    Ok(Some(live.to_string()))
}

fn payload_of(data: &str) -> Result<EventPayload> {
    serde_json::from_str(data)
        .map_err(|error| CoreError::Decoding(format!("event {data:?}: {error}")))
}

pub(crate) fn catch_up(core: &Core, http: &Http, idle: Duration) -> Result<CatchUpReport> {
    let (slice, cursor) = start(core)?;
    let mut catalog = adopt(core, &http.types()?)?;
    let frames = open(http, &cursor, STREAM_HARD_BOUND)?;
    // So a type the server will not describe costs one read of the catalog
    // rather than one for every event naming it.
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
                    "stream_live" => {
                        if let Some(cursor) =
                            pass_withheld(core, &report.cursor, payload.cursor.as_deref())?
                        {
                            report.cursor = cursor;
                        }
                        report.reached_head = true;
                        break;
                    }
                    "catchup_too_old" => return Err(aged_out(core, payload)?),
                    "stream_incomplete" => {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    kind => {
                        let Some(id) = id else { continue };
                        let pinned = pinned_row(core, &payload)?;
                        while let Some(named) =
                            unexplained(&catalog, &slice, kind, &payload, &refreshed, pinned)
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

/// Forgetting the cursor is what sends the next caller to hydrate.
fn aged_out(core: &Core, payload: EventPayload) -> Result<CoreError> {
    let conn = core.conn()?;
    store::meta_delete(&conn, store::META_EVENT_CURSOR)?;
    Ok(CoreError::CatchUpTooOld {
        min_retained_id: payload.min_retained_id.unwrap_or_default(),
    })
}

/// `stop` is looked at at least every `PACE.stop_poll`, including while a
/// stream is being asked for: that request runs on a thread holding only the
/// transport, so it cannot keep the store once this has returned. The thread
/// reading the last stream may hold its connection a while longer (`open`).
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
    // So a type the server will not describe costs one reopen rather than one
    // per event. Kept across a reopen for one of these, and forgotten on any
    // other end, so the next stream reads again for a property its type has
    // since made its thumbnail.
    let mut refreshed = HashSet::new();
    while !stop.load(Ordering::Relaxed) {
        let (slice, cursor) = start(core)?;
        report.cursor = cursor.clone();
        if asked {
            report.reconnects += 1;
        }
        asked = true;
        let Some(reached) = reach(&http, &cursor, stop, pace.stop_poll) else {
            break;
        };
        let (types, frames) = match reached {
            Ok(reached) => reached,
            Err(error) if error.is_environmental() => {
                report.failed_opens += 1;
                let wait = error
                    .retry_after()
                    .map_or(backoff, |named| backoff.max(named));
                report.last_failure = Some(error.to_string());
                pause(wait);
                backoff = (backoff * 2).min(pace.reconnect_most);
                continue;
            }
            Err(error) => return Err(error),
        };
        let catalog = adopt(core, &types)?;
        let opened = Instant::now();
        let ended = read_stream(
            core,
            &catalog,
            &slice,
            &frames,
            stop,
            pace,
            &Instant::now,
            &mut report,
            &mut refreshed,
            on_change,
        )?;
        match ended {
            Ended::Stopped => return Ok(report),
            Ended::Behind => continue,
            Ended::Over => {}
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

#[derive(Debug, PartialEq)]
enum Ended {
    Stopped,
    /// The catalog could not explain an event; reopen at once.
    Behind,
    Over,
}

/// Silence is measured on `now` so a test can hold time still.
#[allow(clippy::too_many_arguments)]
fn read_stream(
    core: &Core,
    catalog: &Catalog,
    slice: &Slice,
    frames: &Receiver<io::Result<Frame>>,
    stop: &AtomicBool,
    pace: &Pace,
    now: &dyn Fn() -> Instant,
    report: &mut FollowReport,
    refreshed: &mut HashSet<Unexplained>,
    on_change: &mut dyn FnMut(&Change),
) -> Result<Ended> {
    let mut heard = now();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(Ended::Stopped);
        }
        let frame = match frames.recv_timeout(pace.stop_poll) {
            Ok(Ok(frame)) => frame,
            Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => return Ok(Ended::Over),
            Err(RecvTimeoutError::Timeout)
                if now().saturating_duration_since(heard) > pace.silence =>
            {
                return Ok(Ended::Over);
            }
            Err(RecvTimeoutError::Timeout) => continue,
        };
        heard = now();
        let Frame::Event { id, name, data } = frame else {
            continue;
        };
        let payload = payload_of(&data)?;
        match name.as_deref().unwrap_or(&payload.r#type) {
            "stream_cursor" => {}
            "stream_live" => {
                if let Some(cursor) =
                    pass_withheld(core, &report.cursor, payload.cursor.as_deref())?
                {
                    report.cursor = cursor;
                }
            }
            "catchup_too_old" => return Err(aged_out(core, payload)?),
            "stream_incomplete" => return Ok(Ended::Over),
            kind => {
                let Some(id) = id else { continue };
                // Left untaken with the cursor before it, so the reopened
                // stream replays it after reading the catalog.
                let pinned = pinned_row(core, &payload)?;
                if let Some(named) = unexplained(catalog, slice, kind, &payload, refreshed, pinned)
                {
                    refreshed.insert(named);
                    return Ok(Ended::Behind);
                }
                // A failed read of a row entering the slice reopens the
                // stream from before this event rather than ending.
                let taken = match take(core, catalog, slice, &id, kind, &payload) {
                    Err(error) if error.is_environmental() => {
                        report.failed_opens += 1;
                        report.last_failure = Some(error.to_string());
                        return Ok(Ended::Over);
                    }
                    other => other?,
                };
                match taken {
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
}

type Reached = Result<(Vec<WireType>, Receiver<io::Result<Frame>>)>;

/// `None` when `stop` was set first.
fn reach(http: &Arc<Http>, cursor: &str, stop: &AtomicBool, poll: Duration) -> Option<Reached> {
    let (sender, answer) = mpsc::sync_channel::<Reached>(1);
    let http = Arc::clone(http);
    let cursor = cursor.to_string();
    thread::spawn(move || {
        let reached = http.types().and_then(|types| {
            let frames = open(&http, &cursor, STREAM_HARD_BOUND)?;
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

/// A wait too long to add to the clock lasts until `stop` is set.
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

fn in_slice(catalog: &Catalog, slice: &Slice, item: &WireItem) -> Result<bool> {
    Ok(store::slice_takes(
        catalog,
        &slice.types,
        slice.tier,
        &item.r#type,
        Tier::parse_wire(item.tier.as_deref())?,
    ))
}

/// Read outside the transaction. A created row's edges need no read: they
/// follow as frames.
fn edges_of_entering_row(
    core: &Core,
    catalog: &Catalog,
    slice: &Slice,
    kind: &str,
    payload: &EventPayload,
) -> Result<Vec<WireEdge>> {
    let Some(item) = &payload.item else {
        return Ok(Vec::new());
    };
    if kind == "item.created" || !ITEM_CHANGES.contains(&kind) {
        return Ok(Vec::new());
    }
    {
        let conn = core.conn()?;
        if store::item_held(&conn, &item.id)?
            || !(in_slice(catalog, slice, item)? || store::pinned(&conn, &item.id)?)
        {
            return Ok(Vec::new());
        }
    }
    Ok(crate::hydrate::read_with_edges(core.http()?, &item.id)?
        .map(|(_, edges)| edges)
        .unwrap_or_default())
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
            store::purge_item(tx, &item.id)
        }
        kind if ITEM_CHANGES.contains(&kind) => {
            let Some(item) = &payload.item else {
                return Ok(false);
            };
            // Strictly older, not "no newer": a transition, delete, restore or
            // tag write leaves the version where it was, so skipping a tie
            // would miss it. The stream's order decides ties.
            if let Some(held) = store::held_version(tx, &item.id)?
                && item.version < held
            {
                return Ok(false);
            }
            if in_slice(catalog, slice, item)? || store::pinned(tx, &item.id)? {
                let tags = payload
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.tags.as_slice());
                let indexing = catalog.indexing(&item.r#type);
                store::upsert_item(tx, item, tags, &indexing)?;
                store::lay_waiting_writes_over(tx, &item.id, &|laid| catalog.indexing(laid))?;
                Ok(true)
            } else {
                store::evict_item(tx, &item.id, &slice.whole)
            }
        }
        "edge.created" | "edge.updated" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            if store::item_held(tx, &edge.source_id)? || slice.whole.contains(&edge.edge_type) {
                store::upsert_edge(tx, edge)?;
                store::lay_waiting_edge_writes_over(tx, &edge.id)?;
                Ok(true)
            } else if store::edge_write_waits(tx, &edge.id)? {
                // Kept until this device's own write to it is answered.
                store::upsert_edge(tx, edge)?;
                store::lay_waiting_edge_writes_over(tx, &edge.id)?;
                Ok(true)
            } else {
                // An edge moved to a source the copy does not hold leaves it.
                store::delete_edge(tx, &edge.id)
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
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::Server;
    use crate::scripted::{
        Answer, Scripted, Then, connected, event, item_payload, refusal, stream, stream_cursor,
        stream_live, types,
    };

    const NOTE: &str = "core.note";
    const MS: fn(u64) -> Duration = Duration::from_millis;

    const QUICK: Pace = Pace {
        stop_poll: Duration::from_millis(10),
        silence: Duration::from_millis(150),
        reconnect_first: Duration::from_millis(10),
        reconnect_most: Duration::from_millis(40),
    };

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

    /// Records each wait between streams rather than sleeping it, and sets
    /// `stop` on the `stop_on_wait`th.
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
            [
                Duration::from_secs(1),
                MS(20),
                crate::error::RETRY_AFTER_MOST
            ],
            "a 429's Retry-After was not waited out, a 408 was not asked again, or a Retry-After past the bound was waited out whole"
        );
        assert_eq!(report.failed_opens, 3);
        let last = report.last_failure.expect("the failure was not recorded");
        assert!(last.contains("rate limited"), "{last}");
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
        // Witness: unstopped, a wait lasts as long as it was asked to.
        let started = Instant::now();
        wait_unless_stopped(&AtomicBool::new(false), MS(60), MS(10));
        assert!(started.elapsed() >= MS(60));
    }

    fn follow_for_real(core: &Arc<Core>) -> (Arc<AtomicBool>, Receiver<Result<FollowReport>>) {
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        let (core, flag) = (Arc::clone(core), Arc::clone(&stop));
        thread::spawn(move || {
            let _ = ended.send(core.follow(&flag, |_| {}));
        });
        (stop, done)
    }

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

    #[derive(Clone)]
    struct HeldClock {
        at: Arc<Mutex<Instant>>,
        reads: Arc<AtomicUsize>,
    }

    impl HeldClock {
        fn new() -> HeldClock {
            HeldClock {
                at: Arc::new(Mutex::new(Instant::now())),
                reads: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn now(&self) -> Instant {
            self.reads.fetch_add(1, Ordering::SeqCst);
            *self.at.lock().unwrap()
        }

        fn pass(&self, by: Duration) {
            *self.at.lock().unwrap() += by;
        }

        /// Waits for two reads of the clock after moving it: at most one is
        /// the stamp of a frame taken before, so the other is a look at
        /// silence with the clock already moved.
        fn pass_and_be_seen(&self, by: Duration, end: &Receiver<Result<Ended>>) {
            let before = self.reads.load(Ordering::SeqCst);
            self.pass(by);
            let hung = Instant::now() + Duration::from_secs(10);
            while self.reads.load(Ordering::SeqCst) < before + 2 {
                if let Ok(read) = end.try_recv() {
                    panic!("a stream saying nothing but keepalives was taken as silent: {read:?}");
                }
                assert!(
                    Instant::now() < hung,
                    "the stream's reader stopped looking at the time"
                );
                thread::sleep(MS(1));
            }
        }
    }

    #[test]
    fn a_keepalive_is_hearing_from_the_server() {
        let server = Scripted::start();
        let (_dir, core) = hydrated(&server);
        let clock = HeldClock::new();
        let (fed, frames) = mpsc::sync_channel::<io::Result<Frame>>(0);
        let (ended, end) = mpsc::channel();
        let reading = clock.clone();
        thread::spawn(move || {
            let (slice, _) = start(&core).unwrap();
            let catalog = Catalog::load(&core.conn().unwrap()).unwrap();
            let read = read_stream(
                &core,
                &catalog,
                &slice,
                &frames,
                &AtomicBool::new(false),
                &QUICK,
                &|| reading.now(),
                &mut FollowReport::default(),
                &mut HashSet::new(),
                &mut |_| {},
            );
            let _ = ended.send(read);
        });
        // A send on the rendezvous channel fails once the reader has let the
        // stream go.
        for _ in 0..8 {
            fed.send(Ok(Frame::Comment("keepalive".into())))
                .expect("a stream saying nothing but keepalives was taken as silent");
            clock.pass_and_be_seen(QUICK.silence / 2, &end);
        }
        // Two silences, not one: the last keepalive may have been stamped
        // after the clock passed it, leaving the reader exactly at the bound.
        clock.pass(QUICK.silence * 2);
        let read = end
            .recv_timeout(Duration::from_secs(10))
            .expect("a stream silent past the bound was still being read");
        assert_eq!(
            read.unwrap(),
            Ended::Over,
            "a stream silent past the bound once its keepalives stopped was not let go"
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
        assert!(core.claim_stream().is_ok());
    }

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
            whole: Vec::new(),
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
        while let Some(next) =
            unexplained(&catalog, &slice, "item.created", &photo, &refreshed, false)
        {
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
            unexplained(&catalog, &slice, "item.created", &gone, &refreshed, false),
            Some(unknown.clone())
        );
        refreshed.insert(unknown);
        assert_eq!(
            unexplained(&catalog, &slice, "item.created", &gone, &refreshed, false),
            None
        );
    }

    #[test]
    fn a_stream_that_ends_forgets_what_it_was_read_again_for() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
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
                stream(vec![connected(), first.clone()], held()),
                stream(vec![connected(), first], Then::End),
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
        // Witness: the same store, its hydration finished, reads the catalog.
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

    fn stored_cursor(core: &Core) -> Option<String> {
        store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap()
    }

    /// Event 11 is sent and 12 to 14 are withheld; the stream is held open
    /// after its marker, as a real server does.
    fn withheld_head(live: Option<&str>) -> Answer {
        let mut frames = vec![
            connected(),
            stream_cursor("14"),
            event(
                "11",
                "item.created",
                &item_payload("item.created", "n1", NOTE, 1),
            ),
        ];
        if let Some(live) = live {
            frames.push(stream_live(Some(live)));
        }
        stream(
            frames,
            Then::Hold {
                keepalive: None,
                lasting: None,
            },
        )
    }

    fn carried(server: &Scripted, path: &str) -> Vec<String> {
        server
            .seen(path)
            .into_iter()
            .map(|seen| seen.authorization.unwrap_or_default())
            .collect()
    }

    /// Hands out `fresh-1`, `fresh-2` and so on, recording the bearer each
    /// was asked to replace.
    fn renewing(core: &Core) -> Arc<Mutex<Vec<String>>> {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let told = Arc::clone(&asked);
        core.renew_credential_with(Box::new(move |refused| {
            let mut told = told.lock().unwrap();
            told.push(refused.to_string());
            Ok(format!("fresh-{}", told.len()))
        }));
        asked
    }

    #[test]
    fn a_catch_up_past_its_token_goes_on_under_a_renewed_one() {
        let server = Scripted::start();
        server.on(
            "/types",
            vec![refusal(401, "unauthorized"), types(&[(NOTE, None)])],
        );
        server.on(
            "/events",
            vec![refusal(401, "unauthorized"), withheld_head(Some("14"))],
        );
        let (_dir, core) = hydrated(&server);
        let asked = renewing(&core);
        let report = core.catch_up().unwrap();
        assert_eq!(report.applied, 1);
        assert_eq!(stored_cursor(&core).as_deref(), Some("14"));
        assert_eq!(*asked.lock().unwrap(), ["k", "fresh-1"]);
        assert_eq!(carried(&server, "/types"), ["Bearer k", "Bearer fresh-1"]);
        assert_eq!(
            carried(&server, "/events"),
            ["Bearer fresh-1", "Bearer fresh-2"]
        );
    }

    #[test]
    fn a_bearer_refused_after_its_renewal_is_the_answer() {
        let server = Scripted::start();
        server.on("/types", vec![refusal(401, "unauthorized")]);
        let (_dir, core) = hydrated(&server);
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::Unauthorized { .. })
        ));
        assert_eq!(carried(&server, "/types"), ["Bearer k"]);

        let asked = renewing(&core);
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::Unauthorized { .. })
        ));
        assert_eq!(*asked.lock().unwrap(), ["k"]);
        assert_eq!(
            carried(&server, "/types"),
            ["Bearer k", "Bearer k", "Bearer fresh-1"]
        );
    }

    #[test]
    fn a_catch_up_without_the_marker_stops_on_silence_at_the_last_row_applied() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on("/events", vec![withheld_head(None)]);
        let (_dir, core) = hydrated(&server);
        let http = core.http.clone().unwrap();
        let report = catch_up(&core, &http, MS(200)).unwrap();
        assert!(!report.reached_head);
        assert_eq!(report.cursor, "11");
        assert_eq!(stored_cursor(&core).as_deref(), Some("11"));
    }

    #[test]
    fn a_catch_up_waits_through_comments_for_a_marker_later_than_its_idle() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![
                    connected(),
                    stream_cursor("14"),
                    event(
                        "11",
                        "item.created",
                        &item_payload("item.created", "n1", NOTE, 1),
                    ),
                ],
                Then::Later {
                    keepalive: MS(50),
                    after: MS(2500),
                    frames: vec![stream_live(Some("14"))],
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let http = core.http.clone().unwrap();
        let report = catch_up(&core, &http, MS(1000)).unwrap();
        assert!(report.reached_head);
        assert_eq!(report.cursor, "14");
    }

    #[test]
    fn a_catch_up_ends_on_silence_before_a_marker_later_than_its_idle() {
        // Witness for the test above: no comment while it reads.
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![
                    connected(),
                    stream_cursor("14"),
                    event(
                        "11",
                        "item.created",
                        &item_payload("item.created", "n1", NOTE, 1),
                    ),
                ],
                Then::Later {
                    keepalive: Duration::from_secs(60),
                    after: MS(2500),
                    frames: vec![stream_live(Some("14"))],
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let http = core.http.clone().unwrap();
        let report = catch_up(&core, &http, MS(1000)).unwrap();
        assert!(!report.reached_head);
        assert_eq!(report.cursor, "11");
    }

    #[test]
    fn a_follow_keeps_its_cursor_when_the_marker_is_behind_it() {
        // A server restored from a backup, whose log stops short of the
        // cursor held.
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected(), stream_cursor("9"), stream_live(Some("9"))],
                Then::Hold {
                    keepalive: None,
                    lasting: None,
                },
            )],
        );
        let (_dir, core) = hydrated(&server);
        let run = follow_on(&core, QUICK, None);
        thread::sleep(MS(300));
        run.stop();
        let report = run.ended().unwrap();
        assert_eq!(report.cursor, "10");
        assert_eq!(stored_cursor(&core).as_deref(), Some("10"));
    }
}
