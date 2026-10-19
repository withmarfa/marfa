use std::collections::HashSet;
use std::fmt;
use std::io::{self, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::catalog::Catalog;
use crate::drain::DrainReport;
use crate::error::CoreError;
use crate::http::Http;
use crate::model::{CatchUpReport, SliceTier, Subject, Tier};
use crate::read_view::{self, Context};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::telemetry::Carried;
use crate::wire::{EventPayload, WireCatalog, WireEdge, WireItem};
use crate::{Core, Result};

const STREAM_HARD_BOUND: Duration = Duration::from_secs(120);
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(15);
// The server budgets its head read at five seconds before it announces the
// cursor, so this has to outlast that budget.
const HEAD_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
pub(crate) struct Pace {
    pub(crate) stop_poll: Duration,
    pub(crate) silence: Duration,
    /// Doubles to `reconnect_most`. A stream that stayed open at least
    /// `reconnect_most` resets it, so the client's own bound on a stream is
    /// followed by an immediate reopen, while a server that ends every
    /// stream at once is asked at most every `reconnect_most`.
    pub(crate) reconnect_first: Duration,
    pub(crate) reconnect_most: Duration,
    /// How long a stream stayed open is read from this clock, so a test can
    /// hold it still and a slow machine cannot make a stream that ended at
    /// once look like one that was held.
    pub(crate) clock: &'static (dyn Fn() -> Instant + Sync),
}

impl std::fmt::Debug for Pace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pace")
            .field("stop_poll", &self.stop_poll)
            .field("silence", &self.silence)
            .field("reconnect_first", &self.reconnect_first)
            .field("reconnect_most", &self.reconnect_most)
            .finish_non_exhaustive()
    }
}

pub(crate) const PACE: Pace = Pace {
    stop_poll: Duration::from_millis(250),
    silence: Duration::from_secs(90),
    reconnect_first: Duration::from_secs(1),
    reconnect_most: Duration::from_secs(30),
    clock: &crate::clock::now,
};

struct Slice {
    types: Vec<String>,
    tier: SliceTier,
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
    // A row of a tier the slice does not hold leaves the copy whatever its
    // type is, but a `system.*` row, which `store::slice_takes` holds at
    // either tier.
    if !pinned
        && !store::is_system(&item.r#type)
        && !slice
            .tier
            .takes(Tier::parse_wire(item.tier.as_deref()).ok()?)
    {
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

/// What a held stream changed in the copy: an event it applied, with the
/// item or edge it was about, or a catalog that differs from the one held,
/// naming neither. Or what became of the server: unreachable, with why, once
/// when a stream cannot be had, and reachable once when one is had again.
/// Or what became of the queue it drained then. `cursor` is the cursor held
/// after it.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub event: ChangeEvent,
    pub item_id: Option<String>,
    pub edge_id: Option<String>,
    pub cursor: String,
}

/// Written as text with the event's name; for an unreachable server, a queue
/// not drained or a watch that failed, why as its sentence; for a queue
/// drained, the drain's report; and for a save, the data version.
impl Serialize for Change {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let saved = match &self.event {
            ChangeEvent::Saved(version) => Some(version),
            _ => None,
        };
        let mut change = serializer.serialize_struct("Change", 6 + usize::from(saved.is_some()))?;
        change.serialize_field("event", self.event.as_str())?;
        change.serialize_field("item_id", &self.item_id)?;
        change.serialize_field("edge_id", &self.edge_id)?;
        change.serialize_field("cursor", &self.cursor)?;
        let reason = match &self.event {
            ChangeEvent::ServerUnreachable(reason) => Some(reason.to_string()),
            ChangeEvent::QueueNotDrained(error) | ChangeEvent::WatchFailed(error) => {
                Some(error.to_string())
            }
            _ => None,
        };
        change.serialize_field("reason", &reason)?;
        let drained = match &self.event {
            ChangeEvent::QueueDrained(report) => Some(report),
            _ => None,
        };
        change.serialize_field("drain", &drained)?;
        if let Some(version) = saved {
            change.serialize_field("data_version", version)?;
        }
        change.end()
    }
}

/// What a `Change` tells. Written as text by its name: the applied event's
/// type, or `catalog.changed`, `server.unreachable`, `server.reachable`,
/// `queue.drained`, `queue.not_drained`, and, from a watch only,
/// `store.saved` or `watch.failed`.
#[derive(Debug, Clone, PartialEq)]
pub enum ChangeEvent {
    /// An event the stream applied, by the event's type.
    Applied(String),
    /// A stream it opened read a catalog that differs from the one held.
    CatalogChanged,
    /// No stream can be had, for this failure: the network failing, a rate
    /// limit, a failing server or a refusal naming no contract.
    ServerUnreachable(CoreError),
    ServerReachable,
    /// The queue was drained once a stream was had again, and what that
    /// pass did (`device/follow-drains-reachable`).
    QueueDrained(DrainReport),
    /// The drain started once a stream was had again ended with this
    /// error. The answers it had recorded stay recorded.
    QueueNotDrained(CoreError),
    /// Told by a watch of a reading handle: another process saved to the
    /// store, which now has this data version (`Core::data_version`).
    Saved(i64),
    /// Told by a watch, once, when what feeds it fails with this error. A
    /// follow that failed holds no stream until the next hydration or
    /// catch-up; a reading handle's reads go on, and the first that works is
    /// told as `Saved`.
    WatchFailed(CoreError),
}

impl ChangeEvent {
    pub fn as_str(&self) -> &str {
        match self {
            ChangeEvent::Applied(event) => event,
            ChangeEvent::CatalogChanged => "catalog.changed",
            ChangeEvent::ServerUnreachable(_) => "server.unreachable",
            ChangeEvent::ServerReachable => "server.reachable",
            ChangeEvent::QueueDrained(_) => "queue.drained",
            ChangeEvent::QueueNotDrained(_) => "queue.not_drained",
            ChangeEvent::Saved(_) => "store.saved",
            ChangeEvent::WatchFailed(_) => "watch.failed",
        }
    }
}

impl fmt::Display for ChangeEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FollowReport {
    pub applied: u64,
    pub skipped: u64,
    /// Empty where the follow was stopped before it read the copy's cursor.
    pub cursor: String,
    /// Streams asked for after the first, for any reason.
    pub reconnects: u64,
    /// Counts failed reads of a row entering the slice as well as failed asks
    /// for a stream.
    pub failed_opens: u64,
    pub last_failure: Option<String>,
}

fn start(core: &Core) -> Result<(Slice, String)> {
    let mut conn = core.conn()?;
    refuse_unless_current(&mut conn)?;
    start_build(&conn)
}

/// A copy talks to its server only under the read view a completed hydration
/// gave it: refused `HydrationIncomplete` part way through one, `NoCursor`
/// where none has completed, and expired where its cursor has gone. Asked
/// before anything is sent, so the refusal is the same offline. A copy
/// expired already is refused as it stands: expiring it again would move its
/// generation, and with it every call begun on the copy, for nothing.
pub(crate) fn refuse_unless_current(conn: &mut rusqlite::Connection) -> Result<()> {
    if !store::hydration_complete(conn)? {
        return Err(CoreError::HydrationIncomplete);
    }
    if !store::hydrated(conn)? {
        if store::holds_slice(conn)? {
            if !read_view::expired(conn)? {
                let tx = conn.transaction()?;
                read_view::expire(&tx)?;
                tx.commit()?;
            }
            return Err(read_view::invalid());
        }
        return Err(CoreError::NoCursor);
    }
    Ok(())
}

fn start_build(conn: &rusqlite::Connection) -> Result<(Slice, String)> {
    let cursor = store::meta_get(conn, store::META_EVENT_CURSOR)?.ok_or_else(read_view::invalid)?;
    read_view::cursor(&cursor).ok_or_else(read_view::invalid)?;
    let (types, tier) = store::slice(conn)?.ok_or_else(read_view::invalid)?;
    let whole = store::whole_edge_types(conn)?;
    Ok((Slice { types, tier, whole }, cursor))
}

fn pinned_row(core: &Core, payload: &EventPayload) -> Result<bool> {
    match &payload.item {
        Some(item) => store::pinned(&*core.conn()?, &item.id),
        None => Ok(false),
    }
}

/// Written only where it differs from the one held, so a reader told of every
/// save is not told of this. `changed` is set once a changed catalog is
/// committed, before it is read back, so a caller learns of it even where
/// the read fails.
fn adopt(
    core: &Core,
    context: &Context,
    catalog: &WireCatalog,
    changed: &mut bool,
) -> Result<Catalog> {
    let conn = core.conn()?;
    context.same_copy(&conn)?;
    if store::replace_catalog(&conn, catalog)? {
        *changed = true;
    }
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
    context: &Context,
    catalog: &Catalog,
    slice: &Slice,
    id: &str,
    kind: &str,
    payload: &EventPayload,
) -> Result<Option<Change>> {
    // A held stream spans ordinary pin changes. Snapshot pins for this event's
    // awaited reads, while retaining the stream's copy and authority guard.
    let operation = {
        let conn = core.conn()?;
        context.same_copy(&conn)?;
        Context::capture_build(&conn)?
    };
    let brought = edges_of_entering_row(core, &operation, catalog, slice, kind, payload)?;
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    operation.check(&tx)?;
    read_view::cursor(id).ok_or_else(read_view::invalid)?;
    if ITEM_CHANGES.contains(&kind) || kind == "item.purged" {
        let listed = payload.listed.ok_or_else(read_view::invalid)?;
        let item = payload.item.as_ref().ok_or_else(read_view::invalid)?;
        read_view::set_listed(&tx, &item.id, listed)?;
    }
    let applied = apply(&tx, catalog, slice, kind, payload)?;
    if applied {
        for edge in &brought {
            store::put_server_edge(&tx, edge)?;
        }
    }
    // The last id applied, never the highest seen: where an event is not
    // applied, a high-water mark would step over it forever.
    store::meta_set(&tx, store::META_EVENT_CURSOR, id)?;
    tx.commit()?;
    Ok(applied.then(|| Change {
        event: ChangeEvent::Applied(kind.to_string()),
        item_id: payload.item.as_ref().map(|item| item.id.clone()),
        edge_id: payload.edge.as_ref().map(|edge| edge.id.clone()),
        cursor: id.to_string(),
    }))
}

/// Frames the filter or the credential withheld are never sent, so the
/// replay's marker is the only word this reader has that it is past them.
/// Never moves the cursor back.
fn pass_withheld(
    core: &Core,
    context: &Context,
    held: &str,
    live: Option<&str>,
) -> Result<Option<String>> {
    let Some(live) = live else { return Ok(None) };
    let (Ok(reached), Ok(have)) = (live.parse::<u64>(), held.parse::<u64>()) else {
        return Ok(None);
    };
    if reached <= have {
        return Ok(None);
    }
    let conn = core.conn()?;
    context.same_copy(&conn)?;
    store::meta_set(&conn, store::META_EVENT_CURSOR, live)?;
    Ok(Some(live.to_string()))
}

pub(crate) fn refuse_if_stopped(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::Relaxed) {
        Err(CoreError::Canceled)
    } else {
        Ok(())
    }
}

pub(crate) fn unless_stopped<T>(result: Result<T>, stop: &AtomicBool) -> Result<T> {
    refuse_if_stopped(stop)?;
    result
}

/// A wait for the next frame that looks at `stop` every `PACE.stop_poll`.
fn next_frame<T>(
    frames: &Receiver<T>,
    wait: Duration,
    stop: &AtomicBool,
) -> Result<std::result::Result<T, RecvTimeoutError>> {
    let started = Instant::now();
    loop {
        refuse_if_stopped(stop)?;
        let left = wait.saturating_sub(started.elapsed());
        match frames.recv_timeout(left.min(PACE.stop_poll)) {
            Err(RecvTimeoutError::Timeout) if !left.is_zero() => {}
            other => {
                refuse_if_stopped(stop)?;
                return Ok(other);
            }
        }
    }
}

/// `catalog_changed` is set on success and on failure alike: the catalog a
/// catch-up commits stays committed whatever ends it.
pub(crate) fn catch_up(
    core: &Core,
    http: &Http,
    idle: Duration,
    stop: &AtomicBool,
    catalog_changed: &mut bool,
) -> Result<CatchUpReport> {
    refuse_if_stopped(stop)?;
    start(core)?;
    let context = Context::capture(&*core.conn()?)?;
    let scoped = context.http(http);
    let result = replay_build(core, &scoped, &context, idle, stop, catalog_changed)
        .map_err(|error| context.failed(core, error).unwrap_or_else(|error| error));
    unless_stopped(result, stop)
}

pub(crate) fn replay_build(
    core: &Core,
    http: &Http,
    context: &Context,
    idle: Duration,
    stop: &AtomicBool,
    catalog_changed: &mut bool,
) -> Result<CatchUpReport> {
    let (slice, cursor) = start_build(&*core.conn()?)?;
    let catalog = ask_unless_stopped(stop, http, Http::catalog)?;
    refuse_if_stopped(stop)?;
    let mut catalog = adopt(core, context, &catalog, catalog_changed)?;
    let frames = open(http, &cursor, STREAM_HARD_BOUND)?;
    refuse_if_stopped(stop)?;
    // So a type the server will not describe costs one read of the catalog
    // rather than one for every event naming it.
    let mut refreshed = HashSet::new();

    let mut report = CatchUpReport {
        applied: 0,
        skipped: 0,
        cursor: cursor.clone(),
        catalog_changed: false,
    };
    let mut reached_head = false;
    let mut head: Option<u64> = None;
    let mut greatest = read_view::cursor(&cursor).ok_or_else(read_view::invalid)?;
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
        let frame = match next_frame(&frames, wait, stop)? {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) => match error.kind() {
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock if connected => break,
                // Read again, the same stream says the same thing.
                io::ErrorKind::InvalidData => return Err(CoreError::Decoding(error.to_string())),
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
                let payload = read_view::event_payload(name.as_deref(), id.as_deref(), &data)?;
                let kind = name.as_deref().unwrap_or(&payload.event_type);
                if let Some(reason) = diverged(kind, &payload, &report.cursor) {
                    return Err(CoreError::CopyExpired { reason });
                }
                match kind {
                    "read_view_changed" => {
                        return Err(CoreError::CopyExpired {
                            reason: "read_view_changed".into(),
                        });
                    }
                    "stream_cursor" => {
                        if id.is_some() || head.is_some() {
                            return Err(read_view::invalid());
                        }
                        head = Some(context.marker(&payload, kind)?);
                    }
                    "stream_live" => {
                        if id.is_some() {
                            return Err(read_view::invalid());
                        }
                        let live = context.marker(&payload, kind)?;
                        if head.is_none_or(|head| live < head)
                            || live < greatest
                            || live
                                < read_view::cursor(&report.cursor)
                                    .ok_or_else(read_view::invalid)?
                        {
                            return Err(read_view::invalid());
                        }
                        if let Some(cursor) =
                            pass_withheld(core, context, &report.cursor, payload.cursor.as_deref())?
                        {
                            report.cursor = cursor;
                        }
                        reached_head = true;
                        break;
                    }
                    "stream_incomplete" => {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    kind => {
                        let Some(id) = id else {
                            return Err(read_view::invalid());
                        };
                        if head.is_none() || read_view::cursor(&id).is_none() {
                            return Err(read_view::invalid());
                        }
                        greatest =
                            greatest.max(read_view::cursor(&id).ok_or_else(read_view::invalid)?);
                        let pinned = pinned_row(core, &payload)?;
                        while let Some(named) =
                            unexplained(&catalog, &slice, kind, &payload, &refreshed, pinned)
                        {
                            refreshed.insert(named);
                            let refreshed_catalog = http.catalog()?;
                            refuse_if_stopped(stop)?;
                            catalog = adopt(core, context, &refreshed_catalog, catalog_changed)?;
                        }
                        if take(core, context, &catalog, &slice, &id, kind, &payload)?.is_some() {
                            report.applied += 1;
                        } else {
                            report.skipped += 1;
                        }
                        report.cursor = id.clone();
                    }
                }
            }
        }
    }
    if !reached_head {
        return Err(CoreError::StreamIncomplete {
            reason: "replay_failed".into(),
        });
    }
    report.catalog_changed = *catalog_changed;
    Ok(report)
}

/// Why a frame says the server's log does not continue from `held`: the log
/// has aged past it, or ends behind it, as a server restored from an earlier
/// point does. A position the server names that is behind `held` is the
/// second, whichever frame names it.
fn diverged(kind: &str, payload: &EventPayload, held: &str) -> Option<String> {
    let behind = |head: Option<&str>| {
        let (Ok(head), Ok(have)) = (head?.parse::<u64>(), held.parse::<u64>()) else {
            return None;
        };
        (head < have).then(|| {
            format!(
                "the server's event log ends at {head}, behind the cursor {held} this copy holds, as a server restored from an earlier point does"
            )
        })
    };
    match kind {
        "catchup_too_old" => Some(format!(
            "the event log no longer holds the cursor {held} (oldest retained id {})",
            payload.min_retained_id.as_deref().unwrap_or("unknown")
        )),
        "cursor_ahead" => Some(behind(payload.head.as_deref()).unwrap_or_else(|| {
            format!(
                "the server says the cursor {held} this copy holds is past its event log, as a server restored from an earlier point does"
            )
        })),
        "stream_cursor" | "stream_live" => behind(payload.cursor.as_deref()),
        _ => None,
    }
}

/// For a call that sends or takes rows for a copy that names its instance:
/// a write sent to another instance at the origin would land on rows the
/// copy never held. A copy that names none learns it at its next hydration,
/// which a catch-up sends it to. A server that cannot be asked is an error
/// like any other, so nothing is sent while the instance is unconfirmed.
pub(crate) fn refuse_another_instance(core: &Core, http: &Http) -> Result<()> {
    refuse_another_instance_until(core, http, &crate::NEVER_STOPPED)
}

/// Ended with `Canceled` as soon as `stop` is raised, even while the root is
/// still being asked.
pub(crate) fn refuse_another_instance_until(
    core: &Core,
    http: &Http,
    stop: &AtomicBool,
) -> Result<()> {
    let generation = {
        let conn = core.conn()?;
        if store::meta_get(&conn, store::META_INSTANCE_ID)?.is_none() {
            return Ok(());
        }
        read_view::generation(&conn)?
    };
    let served = ask_unless_stopped(stop, http, Http::instance_id)?;
    same_instance(core, &served, generation)
}

/// Runs a request on a thread holding only the transport and ends with
/// `Canceled` as soon as `stop` is raised, so a call stopped while a request
/// waits on a server that does not answer, one still being connected to
/// among them, ends then rather than when the request gives up. The request
/// may still reach the server after the call has ended, and its answer is
/// dropped: only for a read, or a write the caller marked sent first that
/// its idempotency key, or its content, lets it send again. A credential
/// renewal the request started is finished first, and none starts after.
pub(crate) fn ask_unless_stopped<T: Send + 'static>(
    stop: &AtomicBool,
    http: &Http,
    read: impl FnOnce(&Http) -> Result<T> + Send + 'static,
) -> Result<T> {
    refuse_if_stopped(stop)?;
    let asked = http.to_let_go();
    let reading = asked.clone();
    let (sender, answer) = mpsc::sync_channel::<Result<T>>(1);
    thread::spawn(move || {
        if sender.send(read(&reading)).is_err() {
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "answer-dropped");
        }
    });
    loop {
        if stop.load(Ordering::Relaxed) {
            asked.let_go();
            return Err(CoreError::Canceled);
        }
        match answer.recv_timeout(PACE.stop_poll) {
            Ok(read) => return read,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CoreError::Network(
                    "the request ended with no answer".into(),
                ));
            }
        }
    }
}

/// `http` naming the copy's instance on what it writes, where the copy names
/// one, and the generation of the copy that was read from.
pub(crate) fn naming_instance(core: &Core, http: &Http) -> Result<(Http, u64)> {
    let conn = core.conn()?;
    let generation = read_view::generation(&conn)?;
    let named = match store::meta_get(&conn, store::META_INSTANCE_ID)? {
        Some(instance) if !instance.is_empty() => http.naming(&instance),
        _ => http.clone(),
    };
    Ok((named, generation))
}

/// Expires the copy whose instance another instance's refusal of a write
/// said is no longer at the origin, and answers the error that tells it. A
/// copy hydrated again since `generation` is left as it is.
pub(crate) fn expire_for_another_instance(
    tx: &rusqlite::Transaction<'_>,
    generation: u64,
) -> Result<CoreError> {
    if read_view::generation(tx)? != generation {
        return Ok(Context::changed());
    }
    read_view::expire(tx)?;
    Ok(CoreError::CopyExpired {
        reason: crate::http::INSTANCE_CHANGED.into(),
    })
}

/// Sends one write naming the copy's instance. Where another instance at the
/// origin refuses it, the copy is expired and the call ends `copy_expired`
/// with the reason `instance_changed`.
pub(crate) fn write_naming_instance<T>(
    core: &Core,
    http: &Http,
    write: impl FnOnce(&Http) -> Result<T>,
) -> Result<T> {
    let (named, generation) = naming_instance(core, http)?;
    match write(&named) {
        Err(CoreError::CopyExpired { reason }) if reason == crate::http::INSTANCE_CHANGED => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            let error = expire_for_another_instance(&tx, generation)?;
            tx.commit()?;
            Err(error)
        }
        other => other,
    }
}

fn same_instance(core: &Core, served: &str, generation: u64) -> Result<()> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    if read_view::generation(&tx)? != generation {
        return Err(Context::changed());
    }
    let held = store::meta_get(&tx, store::META_INSTANCE_ID)?;
    if held.as_deref() == Some(served) {
        return Ok(());
    }
    let reason = match held {
        Some(held) => format!(
            "the server at this address is instance {served}, and this copy was hydrated from instance {held}"
        ),
        None => format!(
            "this copy does not name the instance it was hydrated from, and the server at this address is instance {served}"
        ),
    };
    read_view::expire(&tx)?;
    tx.commit()?;
    Err(CoreError::CopyExpired { reason })
}

/// How a follow starts, beyond the stop that ends it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FollowAs {
    /// The caller was last told `server.unreachable`, so the first stream is
    /// told `server.reachable`.
    pub(crate) told_unreachable: bool,
    /// The first stream is drained to, though no one was told the server was
    /// lost.
    pub(crate) owes_drain: bool,
    /// It drains the queue each time it says `server.reachable`.
    pub(crate) drains: bool,
    pub(crate) pace: Pace,
}

/// `stop` is looked at at least every `PACE.stop_poll`, including while a
/// stream is being asked for: that request runs on a thread holding only the
/// transport, so it cannot keep the store once this has returned. The thread
/// reading the last stream may hold its connection a while longer (`open`).
/// `on_contact` is called each time a request reaches the server, whatever the
/// server answers.
pub(crate) fn follow(
    core: &Core,
    http: Arc<Http>,
    stop: &AtomicBool,
    how: FollowAs,
    on_change: &mut dyn FnMut(&Change),
    on_live: &mut dyn FnMut(bool),
    on_contact: &mut dyn FnMut(),
) -> Result<FollowReport> {
    let poll = how.pace.stop_poll;
    follow_paced(
        core,
        http,
        stop,
        how,
        on_change,
        on_live,
        on_contact,
        &mut |wait| {
            crate::clock::wait(stop, wait, poll);
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn follow_paced(
    core: &Core,
    http: Arc<Http>,
    stop: &AtomicBool,
    how: FollowAs,
    on_change: &mut dyn FnMut(&Change),
    on_live: &mut dyn FnMut(bool),
    on_contact: &mut dyn FnMut(),
    pause: &mut dyn FnMut(Duration),
) -> Result<FollowReport> {
    let FollowAs {
        told_unreachable,
        owes_drain,
        drains,
        ref pace,
    } = how;
    start(core)?;
    let context = Context::capture(&*core.conn()?)?;
    let http = Arc::new(context.http(&http));
    on_live(false);
    let asked = Mutex::new(Asked::default());
    let (told, heard) = mpsc::channel();
    let result = thread::scope(|scope| -> Result<FollowReport> {
        // The drains watch the caller's own stop, so none sends a write once
        // it is raised; raised here too, so a follow that ends on an error
        // sends no further write either. A folder's watch, which does not
        // drain, keeps its stop for its own pass.
        let _halt = drains.then(|| Raise(stop));
        let recovery = Recovery {
            scope: drains.then_some(scope),
            core,
            stop,
            asked: &asked,
            told,
            heard: &heard,
        };
        let mut report = FollowReport::default();
        let mut backoff = pace.reconnect_first;
        let mut asked = false;
        // So a type the server will not describe costs one reopen rather than one
        // per event. Kept across a reopen for one of these, and forgotten on any
        // other end, so the next stream reads again for a property its type has
        // since made its thumbnail.
        let mut refreshed = HashSet::new();
        // Unknown until the first stream is asked for, so a follow that never
        // reaches the server says so, and one that does says nothing, unless
        // its caller was last told the server could not be reached.
        let mut reachable: Option<bool> = told_unreachable.then_some(false);
        let mut owes_drain = owes_drain;
        while !stop.load(Ordering::Relaxed) {
            on_live(false);
            recovery.tell(&report.cursor, on_change);
            let (slice, cursor) = start(core)?;
            report.cursor = cursor.clone();
            if asked {
                report.reconnects += 1;
            }
            asked = true;
            let Some(reached) = reach(&http, &cursor, stop, pace.stop_poll) else {
                break;
            };
            if !matches!(&reached, Err(error) if error.is_environmental()) {
                on_contact();
            }
            let (instance, fetched, frames) = match reached {
                Ok(reached) => reached,
                Err(error) if error.is_environmental() => {
                    report.failed_opens += 1;
                    let wait = error
                        .retry_after()
                        .map_or(backoff, |named| backoff.max(named));
                    report.last_failure = Some(error.to_string());
                    if reachable != Some(false) {
                        reachable = Some(false);
                        on_change(&Change {
                            event: ChangeEvent::ServerUnreachable(error.clone()),
                            item_id: None,
                            edge_id: None,
                            cursor: report.cursor.clone(),
                        });
                    }
                    pause(wait);
                    backoff = (backoff * 2).min(pace.reconnect_most);
                    continue;
                }
                Err(error) => return Err(error),
            };
            same_instance(core, &instance, context.generation)?;
            if reachable == Some(false) {
                on_change(&Change {
                    event: ChangeEvent::ServerReachable,
                    item_id: None,
                    edge_id: None,
                    cursor: report.cursor.clone(),
                });
                recovery.reachable();
            } else if owes_drain {
                recovery.reachable();
            }
            owes_drain = false;
            reachable = Some(true);
            let mut moved = false;
            let catalog = adopt(core, &context, &fetched, &mut moved);
            if moved {
                on_change(&Change {
                    event: ChangeEvent::CatalogChanged,
                    item_id: None,
                    edge_id: None,
                    cursor: report.cursor.clone(),
                });
            }
            let catalog = catalog?;
            let opened = (pace.clock)();
            let ended = read_stream(
                core,
                &context,
                &catalog,
                &slice,
                &frames,
                stop,
                pace,
                &crate::clock::now,
                &mut report,
                &mut refreshed,
                &recovery,
                on_change,
                on_live,
            )?;
            on_live(false);
            match ended {
                Ended::Stopped => return Ok(report),
                Ended::Behind => continue,
                Ended::Over => {}
            }
            refreshed.clear();
            if (pace.clock)().saturating_duration_since(opened) >= pace.reconnect_most {
                backoff = pace.reconnect_first;
            } else {
                recovery.tell(&report.cursor, on_change);
                pause(backoff);
                backoff = (backoff * 2).min(pace.reconnect_most);
            }
        }
        Ok(report)
    });
    on_live(false);
    // Every drain it started has ended with the scope.
    let cursor = match &result {
        Ok(report) => report.cursor.clone(),
        Err(_) => core
            .conn()
            .ok()
            .and_then(|conn| {
                store::meta_get(&conn, store::META_EVENT_CURSOR)
                    .ok()
                    .flatten()
            })
            .unwrap_or_default(),
    };
    for event in heard.try_iter() {
        on_change(&Change {
            event,
            item_id: None,
            edge_id: None,
            cursor: cursor.clone(),
        });
    }
    result.map_err(|error| context.failed(core, error).unwrap_or_else(|error| error))
}

/// Raises its flag when dropped, unwinding included.
struct Raise<'a>(&'a AtomicBool);

impl Drop for Raise<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Whether a drain a follow started is running, and whether a stream was
/// had again while it ran.
#[derive(Default)]
struct Asked {
    running: bool,
    again: bool,
}

/// The drain a follow starts when its server is reachable again
/// (`device/follow-drains-reachable`), on a thread of its own: a drain sends
/// its writes one at a time, each waiting on the server's answer, and the
/// stream is read meanwhile. It waits for any drain under way to end, so
/// one runs at a time; a stream had again while the follow's own drain runs
/// drains once more after it, so each time the server comes back is drained
/// once and none is lost to a drain that ended before it.
struct Recovery<'scope, 'env> {
    /// `None` where the follow does not drain.
    scope: Option<&'scope thread::Scope<'scope, 'env>>,
    core: &'env Core,
    stop: &'env AtomicBool,
    asked: &'env Mutex<Asked>,
    told: Sender<ChangeEvent>,
    heard: &'env Receiver<ChangeEvent>,
}

impl Recovery<'_, '_> {
    fn reachable(&self) {
        let Some(scope) = self.scope else { return };
        {
            let mut asked = self.asked.lock().unwrap_or_else(|held| held.into_inner());
            if asked.running {
                asked.again = true;
                return;
            }
            asked.running = true;
        }
        let (core, stop, asked, told) = (self.core, self.stop, self.asked, self.told.clone());
        let carried = Carried::here();
        scope.spawn(move || {
            carried.run(|| {
                loop {
                    let event = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        recover(core, stop)
                    }))
                    .unwrap_or_else(|fault| {
                        Some(ChangeEvent::QueueNotDrained(CoreError::Invalid(format!(
                            "the drain stopped on a fault in the core: {}",
                            crate::fault_said(fault.as_ref())
                        ))))
                    });
                    if let Some(event) = event {
                        let _ = told.send(event);
                    }
                    let mut asked = asked.lock().unwrap_or_else(|held| held.into_inner());
                    if asked.again && !stop.load(Ordering::Relaxed) {
                        asked.again = false;
                        continue;
                    }
                    *asked = Asked::default();
                    return;
                }
            });
        });
    }

    /// What the drains it started have told since it last looked.
    fn tell(&self, cursor: &str, on_change: &mut dyn FnMut(&Change)) {
        for event in self.heard.try_iter() {
            on_change(&Change {
                event,
                item_id: None,
                edge_id: None,
                cursor: cursor.to_string(),
            });
        }
    }
}

/// `None` where no work was left for a drain, or the follow ended first.
fn recover(core: &Core, stop: &AtomicBool) -> Option<ChangeEvent> {
    match core.drain_what_remains(stop)? {
        Ok(report) => Some(ChangeEvent::QueueDrained(report)),
        Err(CoreError::Canceled) => None,
        Err(error) => Some(ChangeEvent::QueueNotDrained(error)),
    }
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
    context: &Context,
    catalog: &Catalog,
    slice: &Slice,
    frames: &Receiver<io::Result<Frame>>,
    stop: &AtomicBool,
    pace: &Pace,
    now: &dyn Fn() -> Instant,
    report: &mut FollowReport,
    refreshed: &mut HashSet<Unexplained>,
    recovery: &Recovery,
    on_change: &mut dyn FnMut(&Change),
    on_live: &mut dyn FnMut(bool),
) -> Result<Ended> {
    let mut heard = now();
    let mut head = None;
    let mut live_confirmed = false;
    let mut greatest = read_view::cursor(&report.cursor).unwrap_or(0);
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(Ended::Stopped);
        }
        recovery.tell(&report.cursor, on_change);
        let frame = match frames.recv_timeout(pace.stop_poll) {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
                return Err(CoreError::Decoding(error.to_string()));
            }
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
        let payload = read_view::event_payload(name.as_deref(), id.as_deref(), &data)?;
        let kind = name.as_deref().unwrap_or(&payload.event_type);
        if let Some(reason) = diverged(kind, &payload, &report.cursor) {
            return Err(CoreError::CopyExpired { reason });
        }
        match kind {
            "read_view_changed" => {
                return Err(CoreError::CopyExpired {
                    reason: "read_view_changed".into(),
                });
            }
            "stream_cursor" => {
                if id.is_some() || head.is_some() {
                    return Err(read_view::invalid());
                }
                head = Some(context.marker(&payload, kind)?);
            }
            "stream_live" => {
                let live = context.marker(&payload, kind)?;
                if id.is_some()
                    || head.is_none_or(|head| live < head)
                    || live < greatest
                    || live < read_view::cursor(&report.cursor).ok_or_else(read_view::invalid)?
                {
                    return Err(read_view::invalid());
                }
                if let Some(cursor) =
                    pass_withheld(core, context, &report.cursor, payload.cursor.as_deref())?
                {
                    report.cursor = cursor;
                }
                live_confirmed =
                    read_view::cursor(&report.cursor).is_some_and(|cursor| cursor >= live);
                on_live(live_confirmed);
            }
            "stream_incomplete" => return Ok(Ended::Over),
            kind => {
                on_live(false);
                let Some(id) = id else {
                    return Err(read_view::invalid());
                };
                if head.is_none() || read_view::cursor(&id).is_none() {
                    return Err(read_view::invalid());
                }
                greatest = greatest.max(read_view::cursor(&id).ok_or_else(read_view::invalid)?);
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
                let taken = match take(core, context, catalog, slice, &id, kind, &payload) {
                    Err(ref error) if crate::folder::copy_changed(error) => {
                        context.same_copy(&*core.conn()?)?;
                        // Pins changed during an awaited read. Replay this event
                        // against the new set without advancing its cursor.
                        return Ok(Ended::Behind);
                    }
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
                on_live(live_confirmed);
            }
        }
    }
}

/// The instance the server's root names, its catalog and its stream.
type Reached = Result<(String, WireCatalog, Receiver<io::Result<Frame>>)>;

/// `None` when `stop` was set first.
fn reach(http: &Arc<Http>, cursor: &str, stop: &AtomicBool, poll: Duration) -> Option<Reached> {
    let (sender, answer) = mpsc::sync_channel::<Reached>(1);
    let asked = http.to_let_go();
    let http = asked.clone();
    let cursor = cursor.to_string();
    thread::spawn(move || {
        let reached = (|| {
            let instance = http.instance_id()?;
            let catalog = http.catalog()?;
            let frames = open(&http, &cursor, STREAM_HARD_BOUND)?;
            Ok((instance, catalog, frames))
        })();
        let _ = sender.send(reached);
    });
    loop {
        if stop.load(Ordering::Relaxed) {
            asked.let_go();
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
    context: &Context,
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
    Ok(
        crate::hydrate::read_with_edges(&context.http(core.http()?), &item.id)?
            .map(|(_, edges)| edges)
            .unwrap_or_default(),
    )
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
            // Strictly older, not "no newer": the stream's order decides a
            // tie, and the copy can hold a row read ahead of the stream.
            if store::holds_later(tx, Subject::Item, &item.id, item.version, &item.updated_at)? {
                return Ok(false);
            }
            if (payload.listed == Some(true) && in_slice(catalog, slice, item)?)
                || store::pinned(tx, &item.id)?
            {
                let tags = payload
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.tags.as_slice());
                store::put_server_item(tx, item, tags, catalog)?;
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
            if store::holds_later(tx, Subject::Edge, &edge.id, edge.version, &edge.updated_at)? {
                return Ok(false);
            }
            // Kept where it waits on this device's own write, until that is
            // answered.
            if store::item_held(tx, &edge.source_id)?
                || slice.whole.contains(&edge.edge_type)
                || store::edge_write_waits(tx, &edge.id)?
            {
                store::put_server_edge(tx, edge)?;
                store::lay_waiting_edge_writes_over(tx, &edge.id)?;
                Ok(true)
            } else {
                // An edge moved to a source the copy does not hold leaves it.
                store::forget_edge(tx, &edge.id)
            }
        }
        "edge.deleted" => {
            let Some(edge) = &payload.edge else {
                return Ok(false);
            };
            store::forget_edge(tx, &edge.id)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::scripted::{Answer, Scripted, Then, connected, event, refusal};
    use crate::{CatchUpFailed, Server};

    fn types(entries: &[(&str, Option<&str>)]) -> Answer {
        crate::scripted::certified(crate::scripted::types(entries))
    }

    fn item_payload(event: &str, id: &str, ty: &str, version: i64) -> String {
        let mut value: serde_json::Value =
            serde_json::from_str(&crate::scripted::item_payload(event, id, ty, version)).unwrap();
        value["listed"] = true.into();
        value.to_string()
    }

    fn stream_cursor(cursor: &str) -> String {
        crate::scripted::copy_marker("stream_cursor", cursor)
    }
    fn stream_live(cursor: Option<&str>) -> String {
        cursor.map_or_else(
            || crate::scripted::stream_live(None),
            |cursor| crate::scripted::copy_marker("stream_live", cursor),
        )
    }

    fn stream(mut frames: Vec<String>, then: Then) -> Answer {
        if !frames
            .iter()
            .any(|frame| frame.contains("event: stream_cursor"))
        {
            let first = frames
                .iter()
                .find_map(|frame| frame.lines().find_map(|line| line.strip_prefix("id: ")))
                .map(str::to_string);
            if let Some(first) = first {
                frames.insert(0, stream_cursor(&first));
            }
        }
        crate::scripted::stream(frames, then)
    }

    const NOTE: &str = "core.note";
    const MS: fn(u64) -> Duration = Duration::from_millis;

    const QUICK: Pace = Pace {
        stop_poll: Duration::from_millis(10),
        silence: Duration::from_millis(150),
        reconnect_first: Duration::from_millis(10),
        reconnect_most: Duration::from_millis(40),
        clock: &frozen,
    };

    /// A clock that never moves, so no stream is held for `reconnect_most`
    /// however slowly the machine runs: a test that needs a held stream says
    /// so with a clock of its own.
    fn frozen() -> Instant {
        static AT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        *AT.get_or_init(Instant::now)
    }

    /// For a stream the test holds open with no keepalive while it looks at
    /// what was told: with `QUICK`'s silence, a slow run would end that
    /// stream on its own and tell the server lost and back again.
    const STILL: Pace = Pace {
        silence: Duration::from_secs(60),
        ..QUICK
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
            server.on(
                "/edge-types",
                vec![crate::scripted::certified(crate::scripted::edge_types(&[]))],
            );
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, read_view::FENCE, &"a".repeat(64)).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            store::replace_catalog(
                &conn,
                &WireCatalog {
                    types: vec![store::testing::wire_type(NOTE, None, Some("title"))],
                    edge_types: Vec::new(),
                },
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
        on_change: impl FnMut(&Change) + Send + 'static,
    ) -> Run {
        follow_told(core, pace, stop_on_wait, false, on_change)
    }

    fn follow_told(
        core: &Arc<Core>,
        pace: Pace,
        stop_on_wait: Option<usize>,
        told_unreachable: bool,
        on_change: impl FnMut(&Change) + Send + 'static,
    ) -> Run {
        follow_drains(core, pace, stop_on_wait, told_unreachable, true, on_change)
    }

    fn follow_drains(
        core: &Arc<Core>,
        pace: Pace,
        stop_on_wait: Option<usize>,
        told_unreachable: bool,
        drains: bool,
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
            let result = follow_paced(
                &core,
                http,
                &flag,
                FollowAs {
                    told_unreachable,
                    owes_drain: false,
                    drains,
                    pace,
                },
                &mut on_change,
                &mut |_| {},
                &mut || {},
                &mut pause,
            );
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
    fn a_follow_told_the_server_was_unreachable_says_once_it_is_reached() {
        let events = |told| {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            server.on("/events", vec![stream(vec![connected()], Then::End)]);
            let (_dir, core) = hydrated(&server);
            let (sent, heard) = mpsc::channel();
            let run = follow_told(&core, QUICK, Some(2), told, move |change| {
                let _ = sent.send(change.event.clone());
            });
            run.ended().unwrap();
            heard.try_iter().collect::<Vec<_>>()
        };
        // The witness: a follow told nothing says nothing of a server it has
        // at once.
        assert_eq!(events(false), Vec::<ChangeEvent>::new());
        assert_eq!(
            events(true),
            [ChangeEvent::ServerReachable],
            "a follow started after the server was told unreachable did not say it came back, once"
        );
    }

    /// Queues a create of a note and answers the read-back its answer
    /// makes, giving the row's id and the receipt the server sends for it.
    fn queued_note(core: &Core, server: &Scripted, title: &str) -> (String, Answer) {
        let created = core
            .create_item(&crate::Draft {
                r#type: NOTE.into(),
                properties: serde_json::json!({ "title": title })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let id = created.item_id.unwrap();
        let item = serde_json::from_str::<serde_json::Value>(&crate::scripted::item_payload(
            "item.created",
            &id,
            NOTE,
            1,
        ))
        .unwrap()["item"]
            .clone();
        let current =
            serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true });
        server.on(
            &format!("/items/{id}"),
            vec![crate::scripted::certified(crate::scripted::json(
                200,
                &current.to_string(),
            ))],
        );
        server.on(
            "/items/lookup",
            vec![crate::scripted::json(200, r#"{"data":[],"tombstones":[]}"#)],
        );
        let receipt = serde_json::json!({ "item": item }).to_string();
        (id, crate::scripted::json(201, &receipt))
    }

    fn held_open() -> Answer {
        stream(vec![connected()], held())
    }

    /// The bodies of the creates the server was sent, in order.
    fn creates(server: &Scripted) -> Vec<serde_json::Value> {
        server
            .seen("/items")
            .iter()
            .map(|seen| serde_json::from_slice(&seen.body).unwrap())
            .collect()
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < until, "{what}");
            thread::sleep(MS(5));
        }
    }

    fn drained(run: &Run) -> (Vec<ChangeEvent>, DrainReport) {
        let mut told = Vec::new();
        loop {
            let event = run.change().event;
            told.push(event.clone());
            if let ChangeEvent::QueueDrained(report) = event {
                return (told, report);
            }
        }
    }

    #[test]
    fn a_follow_drains_what_waited_once_its_server_is_back_and_tells_what_it_answered() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (first, took_first) = queued_note(&core, &server, "first");
        let (second, took_second) = queued_note(&core, &server, "second");
        server.on("/items", vec![took_first, took_second]);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let run = follow_on(&core, STILL, None);
        let (told, report) = drained(&run);
        assert!(
            matches!(
                told.as_slice(),
                [
                    ChangeEvent::ServerUnreachable(_),
                    ChangeEvent::ServerReachable,
                    ChangeEvent::QueueDrained(_)
                ]
            ),
            "the server's loss and return were not told before the drain: {told:?}"
        );
        assert_eq!(
            (report.answered, report.unavailable, report.stopped),
            (2, None, None),
            "the drain did not answer both writes that waited"
        );
        let sent: Vec<_> = creates(&server)
            .iter()
            .map(|body| body["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            sent,
            [first.clone(), second.clone()],
            "each write was not sent once, in order"
        );
        let queue = core.queue().unwrap();
        assert!(
            queue
                .iter()
                .all(|row| row.verdict == Some(crate::model::Verdict::Accepted)),
            "{queue:?}"
        );
        // Nothing more is sent while the stream stays held.
        thread::sleep(MS(100));
        assert_eq!(creates(&server).len(), 2);
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_follow_that_has_its_server_at_once_does_not_drain() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (_, took) = queued_note(&core, &server, "waiting");
        server.on("/items", vec![took]);
        server.on("/events", vec![held_open()]);
        let run = follow_on(&core, STILL, None);
        server.wait_for("/events", 1, Duration::from_secs(5));
        thread::sleep(MS(150));
        run.stop();
        run.ended().unwrap();
        // The witness that a drain would send it is the test above.
        assert_eq!(
            creates(&server).len(),
            0,
            "a server never lost was drained to"
        );
        assert!(run.changes.try_iter().next().is_none());
    }

    #[test]
    fn a_follow_with_nothing_queued_says_its_server_is_back_and_nothing_of_a_drain() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let run = follow_on(&core, STILL, None);
        assert!(matches!(
            run.change().event,
            ChangeEvent::ServerUnreachable(_)
        ));
        assert_eq!(run.change().event, ChangeEvent::ServerReachable);
        thread::sleep(MS(150));
        run.stop();
        run.ended().unwrap();
        // The witness, a drain told with writes queued, is the first test.
        assert!(
            run.changes.try_iter().next().is_none(),
            "a queue with nothing to send was told of"
        );
    }

    #[test]
    fn a_follow_that_does_not_drain_sends_nothing_when_its_server_is_back() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (_, took) = queued_note(&core, &server, "waiting");
        server.on("/items", vec![took]);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let (sent, heard) = mpsc::channel();
        let run = follow_drains(&core, STILL, None, false, false, move |change| {
            let _ = sent.send(change.event.clone());
        });
        wait_until("the server's return was not told", || {
            heard
                .try_iter()
                .any(|event| event == ChangeEvent::ServerReachable)
        });
        thread::sleep(MS(150));
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            creates(&server).len(),
            0,
            "a follow that does not drain sent a write"
        );
        assert!(heard.try_iter().next().is_none());
    }

    #[test]
    fn a_follow_waits_for_a_drain_under_way_then_drains_what_it_left() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (_, took) = queued_note(&core, &server, "waiting");
        server.on("/items", vec![took]);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let running = core.one_drain();
        let run = follow_on(&core, STILL, None);
        assert!(matches!(
            run.change().event,
            ChangeEvent::ServerUnreachable(_)
        ));
        assert_eq!(run.change().event, ChangeEvent::ServerReachable);
        thread::sleep(MS(150));
        assert_eq!(creates(&server).len(), 0, "a second drain was started");
        assert!(
            run.changes.try_iter().next().is_none(),
            "a follow told of a drain it had not run"
        );
        drop(running);
        let (_, report) = drained(&run);
        assert_eq!(
            report.answered, 1,
            "the follow did not drain what the drain under way left"
        );
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_follow_sends_nothing_a_drain_under_way_answered() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (_, took) = queued_note(&core, &server, "waiting");
        server.on("/items", vec![took]);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let running = core.one_drain();
        let run = follow_on(&core, STILL, None);
        assert!(matches!(
            run.change().event,
            ChangeEvent::ServerUnreachable(_)
        ));
        assert_eq!(run.change().event, ChangeEvent::ServerReachable);
        assert_eq!(core.drain_held(&running).unwrap().answered, 1);
        drop(running);
        thread::sleep(MS(200));
        run.stop();
        run.ended().unwrap();
        // The witness, a follow that drains what is left once the drain
        // under way ends, is the test above.
        assert_eq!(creates(&server).len(), 1, "a write was sent twice");
        assert!(
            run.changes.try_iter().next().is_none(),
            "a follow told of a drain with nothing left to send"
        );
    }

    #[test]
    fn a_follow_that_ends_on_an_error_sends_no_further_write() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (first, took_first) = queued_note(&core, &server, "first");
        let (_, took_second) = queued_note(&core, &server, "second");
        let answer = Arc::new(AtomicBool::new(false));
        server.on(
            "/items",
            vec![
                Answer::WaitFor {
                    ready: Arc::clone(&answer),
                    answer: Box::new(took_first),
                },
                took_second,
            ],
        );
        // The stream ends, and its reopening is refused, only once the
        // first write is in flight.
        let in_flight = Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                refusal(503, "unavailable"),
                stream(
                    vec![connected()],
                    Then::WaitFor {
                        entered: Arc::new(AtomicBool::new(false)),
                        ready: Arc::clone(&in_flight),
                        then: Box::new(Then::End),
                    },
                ),
                refusal(400, "validation_error"),
            ],
        );
        let run = follow_on(&core, STILL, None);
        server.wait_for("/items", 1, Duration::from_secs(5));
        in_flight.store(true, Ordering::SeqCst);
        server.wait_for("/events", 3, Duration::from_secs(5));
        answer.store(true, Ordering::SeqCst);
        let ended = run.ended();
        assert!(
            matches!(ended, Err(CoreError::Validation { .. })),
            "{ended:?}"
        );
        thread::sleep(MS(200));
        let sent: Vec<_> = creates(&server)
            .iter()
            .map(|body| body["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            sent,
            [first],
            "a follow that ended on an error went on sending its queue"
        );
    }

    #[test]
    fn a_drain_that_fails_is_told_with_its_error() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        queued_note(&core, &server, "waiting");
        server.on(
            "/items",
            vec![Answer::Json {
                status: 201,
                body: "{}".into(),
                headers: vec![(crate::http::CONTRACT_HEADER.into(), "999".into())],
            }],
        );
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let run = follow_on(&core, STILL, None);
        let told = loop {
            match run.change().event {
                ChangeEvent::QueueNotDrained(error) => break error,
                ChangeEvent::QueueDrained(report) => panic!("{report:?}"),
                _ => {}
            }
        };
        assert_eq!(told.code(), "contract_mismatch", "{told:?}");
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_queue_of_only_dead_or_blocked_writes_is_not_drained_until_released() {
        for (verdict, reason) in [
            (crate::model::Verdict::Dead, None),
            (crate::model::Verdict::Blocked, Some("conflict_unresolved")),
            (crate::model::Verdict::Blocked, Some("key_spent")),
            (crate::model::Verdict::Blocked, Some("ancestor_unavailable")),
        ] {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            let (_dir, core) = hydrated(&server);
            let (_, took) = queued_note(&core, &server, "stuck");
            server.on("/items", vec![took]);
            let row = core.queue().unwrap()[0].id.clone();
            {
                let mut conn = core.conn().unwrap();
                let tx = conn.transaction().unwrap();
                store::record_verdict(
                    &tx,
                    &row,
                    &store::Answered {
                        verdict,
                        reason,
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )
                .unwrap();
                tx.commit().unwrap();
            }
            let back_again = Arc::new(AtomicBool::new(false));
            server.on(
                "/events",
                vec![
                    refusal(503, "unavailable"),
                    stream(
                        vec![connected()],
                        Then::WaitFor {
                            entered: Arc::new(AtomicBool::new(false)),
                            ready: Arc::clone(&back_again),
                            then: Box::new(Then::End),
                        },
                    ),
                    refusal(503, "unavailable"),
                    held_open(),
                ],
            );
            let run = follow_on(&core, STILL, None);
            assert!(matches!(
                run.change().event,
                ChangeEvent::ServerUnreachable(_)
            ));
            assert_eq!(run.change().event, ChangeEvent::ServerReachable);
            thread::sleep(MS(150));
            assert_eq!(creates(&server).len(), 0, "{verdict:?} {reason:?} was sent");
            assert!(
                run.changes.try_iter().next().is_none(),
                "a drain of nothing sendable was told for {verdict:?} {reason:?}"
            );
            // The witness: released, the same write is drained at the next
            // return.
            assert!(core.release(&row).unwrap());
            back_again.store(true, Ordering::SeqCst);
            let (_, report) = drained(&run);
            assert_eq!(report.answered, 1, "{verdict:?} {reason:?}: {report:?}");
            run.stop();
            run.ended().unwrap();
        }
    }

    #[test]
    fn a_refused_credential_is_told_and_not_tried_again_while_the_server_stays() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        queued_note(&core, &server, "waiting");
        server.on("/items", vec![refusal(401, "unauthorized")]);
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let run = follow_on(&core, STILL, None);
        let (_, report) = drained(&run);
        assert!(
            report
                .stopped
                .as_deref()
                .is_some_and(|why| why.contains("credential")),
            "the drain did not say the credential was refused: {report:?}"
        );
        thread::sleep(MS(200));
        assert_eq!(
            creates(&server).len(),
            1,
            "a refused credential was tried again"
        );
        assert!(run.changes.try_iter().next().is_none());
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_server_that_comes_and_goes_is_drained_once_each_time_it_is_back() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (first, took_first) = queued_note(&core, &server, "first");
        let (second, took_second) = queued_note(&core, &server, "second");
        // The second write finds the server gone, and goes when it is back.
        server.on(
            "/items",
            vec![took_first, refusal(503, "unavailable"), took_second],
        );
        let gone = || refusal(503, "unavailable");
        let ended = || stream(vec![connected()], Then::End);
        let second_back = Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                gone(),
                stream(
                    vec![connected()],
                    Then::WaitFor {
                        entered: Arc::new(AtomicBool::new(false)),
                        ready: Arc::clone(&second_back),
                        then: Box::new(Then::End),
                    },
                ),
                gone(),
                ended(),
                gone(),
                held_open(),
            ],
        );
        let run = follow_on(&core, STILL, None);
        let (_, report) = drained(&run);
        assert_eq!((report.answered, report.undelivered), (1, 1), "{report:?}");
        second_back.store(true, Ordering::SeqCst);
        let (_, report) = drained(&run);
        assert_eq!((report.answered, report.undelivered), (1, 0), "{report:?}");
        // The third return finds nothing to send.
        wait_until("the stream was not held a third time", || {
            server.seen("/events").len() >= 6
        });
        thread::sleep(MS(150));
        run.stop();
        run.ended().unwrap();
        let told: Vec<_> = run.changes.try_iter().map(|change| change.event).collect();
        assert!(
            !told
                .iter()
                .any(|event| matches!(event, ChangeEvent::QueueDrained(_))),
            "a queue with nothing left to send was drained: {told:?}"
        );
        let sent: Vec<_> = creates(&server)
            .iter()
            .map(|body| body["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            sent,
            [first, second.clone(), second],
            "a write was sent other than once per return, or an answered one again"
        );
        let keys: Vec<_> = core
            .queue()
            .unwrap()
            .into_iter()
            .map(|row| row.verdict)
            .collect();
        assert_eq!(keys, [Some(crate::model::Verdict::Accepted); 2]);
    }

    #[test]
    fn a_server_back_again_while_its_drain_runs_is_drained_once_more_after_it() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (first, took_first) = queued_note(&core, &server, "first");
        let (second, took_second) = queued_note(&core, &server, "second");
        let answer = Arc::new(AtomicBool::new(false));
        server.on(
            "/items",
            vec![
                Answer::WaitFor {
                    ready: Arc::clone(&answer),
                    answer: Box::new(took_first),
                },
                refusal(503, "unavailable"),
                took_second,
            ],
        );
        let gone = || refusal(503, "unavailable");
        // The server is lost again only once the first drain's write is in
        // flight, so the second return comes while that drain runs.
        let in_flight = Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                gone(),
                stream(
                    vec![connected()],
                    Then::WaitFor {
                        entered: Arc::new(AtomicBool::new(false)),
                        ready: Arc::clone(&in_flight),
                        then: Box::new(Then::End),
                    },
                ),
                gone(),
                held_open(),
            ],
        );
        let run = follow_on(&core, STILL, None);
        server.wait_for("/items", 1, Duration::from_secs(5));
        in_flight.store(true, Ordering::SeqCst);
        let mut told = Vec::new();
        while told
            .iter()
            .filter(|event| **event == ChangeEvent::ServerReachable)
            .count()
            < 2
        {
            told.push(run.change().event);
        }
        assert_eq!(
            creates(&server).len(),
            1,
            "the first drain was not still under way"
        );
        answer.store(true, Ordering::SeqCst);
        let (_, report) = drained(&run);
        assert_eq!((report.answered, report.undelivered), (1, 1), "{report:?}");
        let (_, report) = drained(&run);
        assert_eq!(
            (report.answered, report.undelivered),
            (1, 0),
            "the server's second return, while the first drain ran, was not drained after it"
        );
        let sent: Vec<_> = creates(&server)
            .iter()
            .map(|body| body["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(sent, [first, second.clone(), second]);
        thread::sleep(MS(100));
        assert_eq!(creates(&server).len(), 3);
        run.stop();
        run.ended().unwrap();
    }

    #[test]
    fn a_stop_ends_the_follow_and_its_drain_before_the_next_write() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let (_dir, core) = hydrated(&server);
        let (_, took_first) = queued_note(&core, &server, "first");
        let (_, took_second) = queued_note(&core, &server, "second");
        let answer = Arc::new(AtomicBool::new(false));
        server.on(
            "/items",
            vec![
                Answer::WaitFor {
                    ready: Arc::clone(&answer),
                    answer: Box::new(took_first),
                },
                took_second,
            ],
        );
        server.on("/events", vec![refusal(503, "unavailable"), held_open()]);
        let run = follow_on(&core, STILL, None);
        server.wait_for("/items", 1, Duration::from_secs(5));
        run.stop();
        answer.store(true, Ordering::SeqCst);
        run.ended().unwrap();
        assert_eq!(
            creates(&server).len(),
            1,
            "a stopped drain sent its next write"
        );
        let told: Vec<_> = run.changes.try_iter().map(|change| change.event).collect();
        assert!(
            !told
                .iter()
                .any(|event| matches!(event, ChangeEvent::QueueNotDrained(_))),
            "a stop was told as a drain that failed: {told:?}"
        );
        // The witness: unstopped, the second write goes.
        assert_eq!(core.drain().unwrap().answered, 1);
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
        server.on("/events", vec![ended(), ended(), ended(), ended()]);
        let (_dir, core) = hydrated(&server);
        // `follow_paced` reads the clock once when a stream opens and once
        // after it ends, and not for an open that failed, so the sixth read
        // is the end of the third stream. It shows that stream as open for
        // the most wait; every other read shows none.
        let reads = AtomicUsize::new(0);
        let still = frozen();
        let most = QUICK.reconnect_most;
        let clock: &'static (dyn Fn() -> Instant + Sync) = Box::leak(Box::new(move || match reads
            .fetch_add(1, Ordering::SeqCst)
        {
            5 => still + most,
            _ => still,
        }));
        let pace = Pace { clock, ..QUICK };
        let run = follow_on(&core, pace, Some(3));
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

    fn follow_for_real(core: &Arc<Core>) -> (Arc<AtomicBool>, Receiver<Result<FollowReport>>) {
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        let (core, flag) = (Arc::clone(core), Arc::clone(&stop));
        thread::spawn(move || {
            let _ = ended.send(core.follow(&flag, false, |_| {}));
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
        "event: stream_incomplete\ndata: {\"event_type\":\"stream_incomplete\",\"reason\":\"scripted\"}\n\n"
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
            let (asked, (told, heard)) = (Mutex::new(Asked::default()), mpsc::channel());
            let still = AtomicBool::new(false);
            let recovery = Recovery {
                scope: None,
                core: &core,
                stop: &still,
                asked: &asked,
                told,
                heard: &heard,
            };
            let read = read_stream(
                &core,
                &Context::capture(&core.conn().unwrap()).unwrap(),
                &catalog,
                &slice,
                &frames,
                &AtomicBool::new(false),
                &QUICK,
                &|| reading.now(),
                &mut FollowReport::default(),
                &mut HashSet::new(),
                &recovery,
                &mut |_| {},
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
        let told = run.change();
        let change = run.change();
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            (told.event, told.item_id, told.edge_id),
            (ChangeEvent::CatalogChanged, None, None),
            "the second stream read a changed catalog and its caller was not told"
        );
        assert_eq!(
            change.item_id.as_deref(),
            Some("late"),
            "a type registered between two streams was not learned by the second"
        );
        assert!(core.get("late").unwrap().is_some());
    }

    #[test]
    fn a_conflicted_copy_answers_its_original_and_is_answered_by_it_after_a_reopen() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let row = |id: &str, tags: &[&str]| {
            let mut value: serde_json::Value =
                serde_json::from_str(&item_payload("item.created", id, NOTE, 1)).unwrap();
            value["metadata"]["tags"] = serde_json::json!(tags);
            value.to_string()
        };
        let link = |id: &str, source: &str| {
            format!(
                r#"{{"event_type":"edge.created","edge":{{"id":"{id}","source_id":"{source}","target_id":"original","edge_type":"derived-from","properties":{{}},"version":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}}}"#
            )
        };
        // The copy does not hold the original. A row made from it and not
        // tagged a conflicted copy, a promoted one, is the witness that the
        // tag is asked.
        server.on(
            "/events",
            vec![stream(
                vec![
                    connected(),
                    stream_cursor("14"),
                    event(
                        "11",
                        "item.created",
                        &row("copy", &[crate::CONFLICTED_COPY_TAG]),
                    ),
                    event("12", "edge.created", &link("e1", "copy")),
                    event("13", "item.created", &row("promoted", &[])),
                    event("14", "edge.created", &link("e2", "promoted")),
                    stream_live(Some("14")),
                ],
                Then::Hold {
                    keepalive: None,
                    lasting: None,
                },
            )],
        );
        let (dir, core) = hydrated(&server);
        assert_eq!(core.catch_up().unwrap().applied, 4);
        assert!(core.get("original").unwrap().is_none());
        let answers = |core: &Core| {
            (
                core.original_of_conflicted_copy("copy").unwrap(),
                core.original_of_conflicted_copy("promoted").unwrap(),
                core.conflicted_copies_of("original")
                    .unwrap()
                    .into_iter()
                    .map(|item| item.id)
                    .collect::<Vec<_>>(),
            )
        };
        let expected = (Some("original".to_string()), None, vec!["copy".to_string()]);
        assert_eq!(answers(&core), expected);
        assert_eq!(
            core.edges_to("original").unwrap().len(),
            2,
            "the promoted row's link was not held, so its absence above proves nothing"
        );
        drop(core);
        let reopened = Core::open(dir.path().join("core.sqlite"), None).unwrap();
        assert_eq!(
            answers(&reopened),
            expected,
            "a reopened store lost a conflicted copy's link to its original"
        );
    }

    #[test]
    fn a_change_to_an_edge_names_the_edge() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        let edge = r#"{"event_type":"edge.created","edge":{"id":"e1","source_id":"row","target_id":"other","edge_type":"references","properties":{},"version":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}"#;
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
            store::upsert_item(&conn, &row, Some(&[]), &crate::catalog::Indexing::default())
                .unwrap();
        }
        let run = follow_on(&core, QUICK, None);
        let change = run.change();
        run.stop();
        run.ended().unwrap();
        assert_eq!(
            (change.event, change.item_id, change.edge_id),
            (
                ChangeEvent::Applied("edge.created".into()),
                None,
                Some("e1".to_string())
            )
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
        let ended = core.follow(&AtomicBool::new(false), false, |_| {
            panic!("a listener fault")
        });
        match ended {
            Err(CoreError::Invalid(said)) => assert!(
                said.contains("a fault in the core: a listener fault"),
                "{said}"
            ),
            other => panic!("a fault ended the follow as {other:?}"),
        }
        assert!(core.claim_stream(crate::Mover::CatchUp).is_ok());
        assert!(core.claim_follow().is_ok());
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
            tier: SliceTier::Library,
            whole: Vec::new(),
        };
        let event = |r#type: &str| {
            let image = "data:image/png;base64,iVBORw0KGgo=";
            serde_json::from_str::<EventPayload>(
                &serde_json::json!({
                    "event_type": "item.created",
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
    fn a_move_between_the_tiers_of_a_slice_of_both_keeps_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let conn = store::open(&dir.path().join("core.sqlite")).unwrap();
        store::replace_types(
            &conn,
            &[store::testing::wire_type(NOTE, None, Some("title"))],
        )
        .unwrap();
        let catalog = Catalog::load(&conn).unwrap();
        let event = |version: i64, tier: &str| {
            serde_json::from_str::<EventPayload>(
                &serde_json::json!({
                    "listed": true,
                    "event_type": "item.updated",
                    "item": {
                        "id": "row", "type": NOTE, "state": "active", "tier": tier,
                        "version": version, "schema_version": 1, "source": "test",
                        "occurred_at": "2026-01-01T00:00:00Z",
                        "created_at": "2026-01-01T00:00:00Z",
                        "updated_at": format!("2026-01-01T00:00:0{version}Z"),
                        "properties": { "title": "inbox" },
                    },
                    "metadata": { "tags": [] },
                })
                .to_string(),
            )
            .unwrap()
        };
        let held = |conn: &rusqlite::Connection| {
            store::items_by_ids(conn, &["row".to_string()])
                .unwrap()
                .pop()
                .map(|item| item.tier)
        };
        // Held at the feed, then moved to the library: the feed's copy lets
        // it go, which is the witness that the move is one a slice can see.
        for (tier, at_feed, after_move) in [
            (
                SliceTier::All,
                Some(Some(Tier::Feed)),
                Some(Some(Tier::Library)),
            ),
            (SliceTier::Feed, Some(Some(Tier::Feed)), None),
            (SliceTier::Library, None, Some(Some(Tier::Library))),
        ] {
            let slice = Slice {
                types: vec![NOTE.into()],
                tier,
                whole: Vec::new(),
            };
            let tx = conn.unchecked_transaction().unwrap();
            apply(&tx, &catalog, &slice, "item.created", &event(1, "feed")).unwrap();
            assert_eq!(held(&tx), at_feed, "a slice at {tier} before the move");
            apply(&tx, &catalog, &slice, "item.updated", &event(2, "library")).unwrap();
            assert_eq!(held(&tx), after_move, "a slice at {tier} after the move");
            tx.rollback().unwrap();
        }
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
        let run = follow_on(&core, STILL, None);
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
            [STILL.reconnect_first],
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
                vec![connected(), stream_cursor("10"), stream_live(Some("10"))],
                Then::End,
            )],
        );
        let (_dir, core) = hydrated(&server);
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        }
        assert_eq!(core.catch_up(), Err(CoreError::HydrationIncomplete));
        let (stop, done) = follow_for_real(&core);
        thread::sleep(MS(300));
        stop.store(true, Ordering::Relaxed);
        assert_eq!(
            done.recv_timeout(Duration::from_secs(5))
                .expect("a follow waiting for a hydration did not end when stopped"),
            Ok(FollowReport::default())
        );
        assert!(server.seen("/types").is_empty());
        // Witness: the same store, its hydration finished, reads the catalog.
        {
            let conn = core.conn().unwrap();
            store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        }
        core.catch_up().unwrap();
        assert!(
            !server.seen("/types").is_empty(),
            "the catch-up read no catalog, so its absence above proves nothing"
        );
    }

    /// A store that names its server and holds nothing else, and a server
    /// that hydrates it to the cursor `10` and then holds a stream carrying
    /// `n1` at `11`.
    fn never_hydrated(server: &Scripted) -> (tempfile::TempDir, Arc<Core>) {
        use crate::scripted::copy_marker;
        unhydrated(
            server,
            vec![
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
                stream(
                    vec![
                        copy_marker("stream_cursor", "10"),
                        copy_marker("stream_live", "10"),
                    ],
                    Then::End,
                ),
                stream(vec![connected(), created("n1", "11")], held()),
            ],
        )
    }

    /// The same store, with `events` answering every stream asked for.
    fn unhydrated(server: &Scripted, events: Vec<Answer>) -> (tempfile::TempDir, Arc<Core>) {
        use crate::scripted::{certified, edge_types, json};
        server.on(
            "/types",
            vec![certified(crate::scripted::types(&[(NOTE, None)]))],
        );
        server.on("/edge-types", vec![certified(edge_types(&[]))]);
        server.on(
            "/keys/current",
            vec![certified(json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        server.on(
            "/items",
            vec![certified(json(200, r#"{"data":[],"next_cursor":null}"#))],
        );
        server.on("/events", events);
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        (dir, Arc::new(core))
    }

    /// The generation a store is left at, and the `/events` asked for, when
    /// its first hydration's replay finds the log aged past its head; with a
    /// follow opened before the hydration where `following`, and how it ended.
    fn first_hydration_expired(
        following: bool,
    ) -> (
        u64,
        usize,
        Option<std::result::Result<Result<FollowReport>, RecvTimeoutError>>,
    ) {
        use crate::scripted::copy_marker;
        let server = Scripted::start();
        let (_dir, core) = unhydrated(
            &server,
            vec![
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
                stream(
                    vec![
                        copy_marker("stream_cursor", "10"),
                        "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\"}\n\n".into(),
                    ],
                    Then::End,
                ),
            ],
        );
        let follow = following.then(|| follow_for_real(&core));
        if following {
            thread::sleep(MS(300));
        }
        assert!(matches!(
            core.hydrate(&[NOTE.into()], SliceTier::Library),
            Err(CoreError::CopyExpired { .. })
        ));
        let ended = follow.map(|(stop, done)| {
            let ended = done.recv_timeout(Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            ended
        });
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
        let generation = read_view::generation(&core.conn().unwrap()).unwrap();
        (generation, server.seen("/events").len(), ended)
    }

    #[test]
    fn a_follow_waiting_when_its_hydration_expires_the_copy_ends_copy_expired_leaving_it() {
        let (alone, asked_alone, _) = first_hydration_expired(false);
        let (followed, asked, ended) = first_hydration_expired(true);
        assert!(
            matches!(ended, Some(Ok(Err(CoreError::CopyExpired { .. })))),
            "a follow waiting when its hydration expired the copy did not end copy_expired: {ended:?}"
        );
        // The witness: the hydration's own expiry moves the generation.
        assert!(alone > 0);
        assert_eq!(
            followed, alone,
            "the waiting follow expired the copy its hydration had expired"
        );
        assert_eq!(asked, asked_alone, "the waiting follow asked for a stream");
    }

    #[test]
    fn a_follow_on_a_copy_never_hydrated_waits_for_its_first_hydration_then_follows() {
        let server = Scripted::start();
        let (_dir, core) = never_hydrated(&server);
        let (stop, done) = mpsc::channel();
        let (told, changes) = mpsc::channel();
        let flag = Arc::new(AtomicBool::new(false));
        {
            let (core, flag) = (Arc::clone(&core), Arc::clone(&flag));
            thread::spawn(move || {
                let _ = stop.send(core.follow(&flag, false, |change| {
                    let _ = told.send(change.clone());
                }));
            });
        }
        thread::sleep(MS(400));
        assert!(
            matches!(done.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "a follow on a copy that was never hydrated ended rather than waiting"
        );
        assert!(
            server.seen("/events").is_empty() && server.seen("/types").is_empty(),
            "a follow waiting for a hydration asked the server"
        );
        // The hydration runs beside the waiting follow, on the same store.
        core.hydrate(&[NOTE.into()], SliceTier::Library).unwrap();
        let change = changes
            .recv_timeout(Duration::from_secs(5))
            .expect("the follow did not follow once the copy was hydrated");
        assert_eq!(
            (change.item_id.as_deref(), change.cursor.as_str()),
            (Some("n1"), "11")
        );
        flag.store(true, Ordering::Relaxed);
        let report = done
            .recv_timeout(Duration::from_secs(5))
            .expect("the follow did not end when stopped")
            .unwrap();
        assert_eq!((report.applied, report.cursor.as_str()), (1, "11"));
    }

    #[test]
    fn a_follow_waiting_for_a_hydration_ends_when_stopped_having_asked_nothing() {
        let server = Scripted::start();
        let (_dir, core) = never_hydrated(&server);
        let (stop, done) = follow_for_real(&core);
        thread::sleep(MS(300));
        let asked = Instant::now();
        stop.store(true, Ordering::Relaxed);
        let ended = done
            .recv_timeout(Duration::from_secs(5))
            .expect("a follow waiting for a hydration did not end when stopped");
        assert!(asked.elapsed() < Duration::from_secs(1));
        assert_eq!(ended, Ok(FollowReport::default()));
        assert!(server.seen("/events").is_empty());
        // The witness: the same store refuses a catch-up, which does not wait.
        assert_eq!(core.catch_up(), Err(CoreError::NoCursor));
    }

    #[test]
    fn a_second_follow_opened_before_the_first_hydration_is_refused_at_once() {
        let server = Scripted::start();
        let (_dir, core) = never_hydrated(&server);
        let (first_stop, first) = follow_for_real(&core);
        thread::sleep(MS(100));
        let (second_stop, second) = follow_for_real(&core);
        let refused = second.recv_timeout(Duration::from_secs(2));
        second_stop.store(true, Ordering::Relaxed);
        assert!(
            matches!(&refused, Ok(Err(CoreError::Invalid(message))) if message.contains("one at a time")),
            "a second follow before the first hydration was not refused at once: {refused:?}"
        );
        assert!(
            matches!(first.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "the first follow ended when the second was refused"
        );
        first_stop.store(true, Ordering::Relaxed);
        assert_eq!(
            first.recv_timeout(Duration::from_secs(5)).unwrap(),
            Ok(FollowReport::default())
        );
        // The witness: with the first follow gone, a follow waits again.
        let (stop, again) = follow_for_real(&core);
        assert!(again.recv_timeout(MS(400)).is_err());
        stop.store(true, Ordering::Relaxed);
        again.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    }

    #[test]
    fn a_follow_that_waited_waits_on_behind_a_hydration_or_catch_up_holding_the_stream() {
        for holder in [crate::Mover::Hydration, crate::Mover::CatchUp] {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            server.on("/events", vec![stream(vec![connected()], held())]);
            let (_dir, core) = hydrated(&server);
            {
                let conn = core.conn().unwrap();
                store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS)
                    .unwrap();
            }
            let (stop, done) = follow_for_real(&core);
            thread::sleep(MS(300));
            let claim = core.claim_stream(holder).unwrap();
            store::meta_delete(&core.conn().unwrap(), store::META_HYDRATE_STATE).unwrap();
            assert!(
                done.recv_timeout(MS(600)).is_err(),
                "{holder:?}: a follow that waited for a hydration was refused for the stream it holds"
            );
            assert!(server.seen("/events").is_empty(), "{holder:?}");
            drop(claim);
            // The witness: let go, the stream is the follow's.
            server.wait_for("/events", 1, Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            done.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        }
    }

    #[test]
    fn a_follow_on_a_copy_whose_cursor_aged_out_ends_at_once_rather_than_waiting() {
        let server = Scripted::start();
        let (_dir, core) = hydrated(&server);
        store::meta_delete(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap();
        let generation = || read_view::generation(&core.conn().unwrap()).unwrap();
        let held = generation();
        let followed = || {
            let (stop, done) = follow_for_real(&core);
            let ended = done.recv_timeout(Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            assert!(
                matches!(ended, Ok(Err(CoreError::CopyExpired { .. }))),
                "a follow on a copy that must hydrate again waited for a hydration: {ended:?}"
            );
        };
        followed();
        // The witness: a copy that still held its read view is expired.
        let expired = generation();
        assert_ne!(expired, held);
        followed();
        assert_eq!(
            generation(),
            expired,
            "a follow on a copy expired already expired it again"
        );
        assert!(server.seen("/events").is_empty());
    }

    fn at_head() -> Answer {
        stream(
            vec![connected(), stream_cursor("10"), stream_live(Some("10"))],
            Then::End,
        )
    }

    fn registered() -> Answer {
        types(&[(NOTE, None), ("user.late", Some(NOTE))])
    }

    #[test]
    fn a_catch_up_says_whether_it_changed_the_catalog() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)]), registered()]);
        server.on("/events", vec![at_head()]);
        let (_dir, core) = hydrated(&server);
        assert!(
            !core.catch_up().unwrap().catalog_changed,
            "a catch-up that read the catalog the copy holds said it changed"
        );
        assert!(
            core.catch_up().unwrap().catalog_changed,
            "a catch-up that changed the catalog did not say so"
        );
    }

    #[test]
    fn a_changed_catalog_catches_up_past_unreadable_properties_and_repairs_them() {
        for damaged in [r#"{"title":"#, "[1]"] {
            let server = Scripted::start();
            server.on("/types", vec![registered()]);
            server.on(
                "/events",
                vec![
                    stream(
                        vec![
                            connected(),
                            event(
                                "11",
                                "item.created",
                                &item_payload("item.created", "neighbor", NOTE, 1),
                            ),
                            stream_live(Some("11")),
                        ],
                        Then::End,
                    ),
                    stream(
                        vec![
                            connected(),
                            event(
                                "12",
                                "item.updated",
                                &item_payload("item.updated", "damaged", NOTE, 2),
                            ),
                            stream_live(Some("12")),
                        ],
                        Then::End,
                    ),
                ],
            );
            let (_dir, core) = hydrated(&server);
            {
                let conn = core.conn().unwrap();
                let row =
                    store::testing::note("damaged", "original", "body", "2026-01-01T00:00:00Z");
                store::put_server_item(
                    &conn,
                    &row,
                    Some(&["genuinetag".into()]),
                    &Catalog::load(&conn).unwrap(),
                )
                .unwrap();
                conn.execute(
                    "UPDATE items SET properties = ?1 WHERE id = 'damaged'",
                    [damaged],
                )
                .unwrap();
            }
            let why = core
                .get_kept("damaged")
                .unwrap()
                .unwrap()
                .1
                .unreadable_properties
                .unwrap();

            let report = core.catch_up().unwrap();

            assert!(report.catalog_changed);
            assert!(core.get("neighbor").unwrap().is_some());
            assert_eq!(stored_cursor(&core).as_deref(), Some("11"));
            assert!(core.item_type("user.late").is_ok());
            let kept = core.get_kept("damaged").unwrap().unwrap();
            assert!(kept.0.properties.is_empty());
            assert_eq!(kept.1.unreadable_properties, Some(why));
            let raw: String = core
                .conn()
                .unwrap()
                .query_row(
                    "SELECT properties FROM items WHERE id = 'damaged'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(raw, damaged);

            assert!(!core.catch_up().unwrap().catalog_changed);
            let repaired = core.get_shown("damaged").unwrap().unwrap();
            assert_eq!(repaired.0.version, 2);
            assert_eq!(repaired.0.properties["title"], "damaged");
            assert_eq!(repaired.1.unreadable_properties, None);
            assert_eq!(stored_cursor(&core).as_deref(), Some("12"));
        }
    }

    /// The failure of a catch-up whose `/types` and `/events` answer as
    /// given, raising `stop` once the stream has been asked for when told to.
    fn failed_catch_up(types: Vec<Answer>, events: Answer, stopped: bool) -> CatchUpFailed {
        let server = Scripted::start();
        server.on("/types", types);
        server.on("/events", vec![events]);
        let (_dir, core) = hydrated(&server);
        let stop = Arc::new(AtomicBool::new(false));
        let (ended, done) = mpsc::channel();
        {
            let (core, stop) = (Arc::clone(&core), Arc::clone(&stop));
            thread::spawn(move || {
                let _ = ended.send(core.catch_up_until(&stop));
            });
        }
        if stopped {
            server.wait_for("/events", 1, Duration::from_secs(5));
            thread::sleep(MS(100));
            stop.store(true, Ordering::Relaxed);
        }
        done.recv_timeout(Duration::from_secs(10))
            .expect("the catch-up did not end")
            .expect_err("the catch-up did not fail")
    }

    #[test]
    fn a_catch_up_that_fails_after_changing_the_catalog_says_it_changed() {
        let silent = || {
            stream(
                vec![connected(), stream_cursor("10")],
                Then::Hold {
                    keepalive: Some(MS(5)),
                    lasting: None,
                },
            )
        };
        let unknown_then_cut = || {
            stream(
                vec![
                    connected(),
                    stream_cursor("12"),
                    event(
                        "11",
                        "item.created",
                        &item_payload("item.created", "late", "user.late", 1),
                    ),
                ],
                Then::Break,
            )
        };
        let aged = || {
            stream(
                vec![
                    connected(),
                    "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\"}\n\n".into(),
                ],
                Then::End,
            )
        };
        let unchanged = || types(&[(NOTE, None)]);
        for (path, types, events, stopped) in [
            (
                "the stream refused",
                vec![registered()],
                refusal(503, "unavailable"),
                false,
            ),
            ("stopped on the stream", vec![registered()], silent(), true),
            (
                "the log aged past the cursor",
                vec![registered()],
                aged(),
                false,
            ),
            (
                "read again for a type an event named, then cut off",
                vec![unchanged(), registered()],
                unknown_then_cut(),
                false,
            ),
        ] {
            let failed = failed_catch_up(types, events.clone(), stopped);
            assert!(
                failed.catalog_changed,
                "{path}: a catch-up that changed the catalog and then failed ({}) did not say the catalog changed",
                failed.error
            );
            // The witness: the same failure against the catalog the copy holds.
            let witness = failed_catch_up(vec![unchanged()], events, stopped);
            assert_eq!(
                (witness.error.code(), witness.catalog_changed),
                (failed.error.code(), false),
                "{path}: the same failure against an unchanged catalog"
            );
        }
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
            Err(CoreError::CopyExpired { .. })
        ));
        assert_eq!(carried(&server, "/types"), ["Bearer k"]);

        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, read_view::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        }
        let asked = renewing(&core);
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::CopyExpired { .. })
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
        assert!(matches!(
            catch_up(&core, &http, MS(200), &AtomicBool::new(false), &mut false),
            Err(CoreError::StreamIncomplete { .. })
        ));
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
        let report = catch_up(&core, &http, MS(1000), &AtomicBool::new(false), &mut false).unwrap();
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
        assert!(matches!(
            catch_up(&core, &http, MS(1000), &AtomicBool::new(false), &mut false),
            Err(CoreError::StreamIncomplete { .. })
        ));
        assert_eq!(stored_cursor(&core).as_deref(), Some("11"));
    }

    fn expired(ended: Result<impl std::fmt::Debug>, core: &Core, named: &str) {
        match ended {
            Err(CoreError::CopyExpired { reason }) => {
                assert!(reason.contains(named), "{reason}");
            }
            other => panic!("a server that does not continue the copy's log ended {other:?}"),
        }
        assert_eq!(stored_cursor(core), None, "the cursor was kept");
    }

    fn cursor_ahead(requested: &str, head: &str) -> String {
        format!(
            "event: cursor_ahead\ndata: {{\"event_type\":\"cursor_ahead\",\"requested\":\"{requested}\",\"head\":\"{head}\"}}\n\n"
        )
    }

    #[test]
    fn a_catch_up_expires_the_copy_where_the_log_ends_behind_its_cursor() {
        for frames in [
            vec![connected(), stream_cursor("9"), cursor_ahead("10", "9")],
            vec![connected(), cursor_ahead("10", "9")],
            vec![connected(), stream_live(Some("9"))],
        ] {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            server.on("/events", vec![stream(frames, Then::End)]);
            let (_dir, core) = hydrated(&server);
            expired(core.catch_up(), &core, "9");
        }
        // The witness: a log whose head is the cursor is one the copy is in
        // step with.
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected(), stream_cursor("10"), stream_live(Some("10"))],
                Then::End,
            )],
        );
        let (_dir, core) = hydrated(&server);
        core.catch_up().unwrap();
        assert_eq!(stored_cursor(&core).as_deref(), Some("10"));
    }

    #[test]
    fn a_follow_expires_the_copy_where_the_log_ends_behind_its_cursor() {
        for frames in [
            vec![connected(), stream_cursor("9"), stream_live(Some("9"))],
            vec![connected(), cursor_ahead("10", "9")],
        ] {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            server.on("/events", vec![stream(frames, held())]);
            let (_dir, core) = hydrated(&server);
            let run = follow_on(&core, QUICK, None);
            expired(run.ended(), &core, "9");
            assert_eq!(server.seen("/events").len(), 1, "the follow asked again");
        }
    }

    #[test]
    fn a_copy_expires_where_another_instance_answers_at_its_origin() {
        let server = Scripted::start();
        server.on("/types", vec![types(&[(NOTE, None)])]);
        server.on(
            "/events",
            vec![stream(
                vec![connected(), stream_cursor("40"), stream_live(Some("40"))],
                Then::End,
            )],
        );
        let (_dir, core) = hydrated(&server);
        // The witness: the instance it was hydrated from catches up.
        core.catch_up().unwrap();

        let other = "00000000-0000-7000-8000-0000000000ff";
        server.on(
            "/events",
            vec![stream(
                vec![stream_cursor("40").replace(crate::scripted::INSTANCE, other)],
                Then::End,
            )],
        );
        expired(core.catch_up(), &core, "read_view_invalid");
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, read_view::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "40").unwrap();
        }
        let run = follow_on(&core, QUICK, None);
        expired(run.ended(), &core, "read_view_invalid");
    }

    #[test]
    fn folder_health_observation_requires_a_live_completed_follow_and_clears_on_loss() {
        for completed in [false, true] {
            let server = Scripted::start();
            server.on("/types", vec![types(&[(NOTE, None)])]);
            server.on(
                "/events",
                vec![stream(
                    vec![
                        connected(),
                        stream_cursor("10"),
                        if completed {
                            stream_live(Some("10"))
                        } else {
                            incomplete()
                        },
                    ],
                    Then::End,
                )],
            );
            let (_dir, core) = hydrated(&server);
            let stop = AtomicBool::new(false);
            let mut observed = Vec::new();
            follow_paced(
                &core,
                Arc::clone(core.http.as_ref().unwrap()),
                &stop,
                FollowAs {
                    told_unreachable: false,
                    owes_drain: false,
                    drains: true,
                    pace: QUICK,
                },
                &mut |_| {},
                &mut |live| observed.push(live),
                &mut || {},
                &mut |_| stop.store(true, Ordering::SeqCst),
            )
            .unwrap();
            assert_eq!(observed.contains(&true), completed);
            assert_eq!(
                observed.last(),
                Some(&false),
                "disconnection invalidates a completed marker before the next pass"
            );
        }
    }
}
