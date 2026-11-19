//! Creates sent in pages, through `POST /items/bulk` and `POST /edges/bulk`,
//! and read back through `POST /items/bulk-get`
//! (`queue-and-verdicts/create-pages`).
//!
//! This is a second way to send a write beside the walk, kept for one reason:
//! a write on its own door costs a request and its read-back another, and the
//! server limits requests, so a first sync of a folder of thousands of notes
//! sent one at a time meets the limit long before it ends. A page takes only
//! what the walk would have sent unchanged on its own door, settles only what
//! the server created under the id the device minted, and leaves everything
//! else to the walk, which sends it on its own door under its own key.
//!
//! An item's create carries in its entry the tags queued with it, whose own
//! writes the page then answers (`queue-and-verdicts/page-carries-tags`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use serde::Deserialize;

use super::address::{Readiness, Shape, ends_the_drain, readiness};
use super::classify::{
    Classified, classify, failure_of, limited_by_server, not_the_writes, put_verdict, rate_limited,
};
use super::read_back::{Bin, ReachChange, ReadBack, Unreadable, apply_read_back, read_owed};
use super::report::DrainReport;
use super::send::{park_for_credential, store_fault, unavailable, unavailable_by, waited};
use super::settle::{Settled, committed, receipt_key, same_attempt, settle_success, verdict_of};
use crate::error::CoreError;
use crate::http::{Answer, BULK_GET_LIMIT, Http, INSTANCE_CHANGED, REQUEST_LIMIT};
use crate::model::{ItemState, QueuedWrite, Subject, Verdict, WriteKind};
use crate::wire::{WireEdge, WireItemWithMetadata};
use crate::{Core, Result};
use crate::{reach, store, telemetry};

/// Below this many creates of one kind, a pass sends them on their own doors:
/// a handful costs no more than a page, and the walk's answers are the ones
/// every other rule of the queue is written against.
const FLOOR: usize = 50;

/// Well inside the server's 5,000 entries and 16 MiB to a page
/// (`items/bulk-entry-cap`, `items/bulk-body-cap`).
const ENTRIES: usize = 1000;
const BYTES: usize = 4 * 1024 * 1024;

/// The keys a create takes on its own door that a bulk entry takes the same
/// way. A create carrying any other is sent on its own door.
const ITEM_KEYS: &[&str] = &["id", "type", "properties", "tier", "occurred_at", "source"];
const EDGE_KEYS: &[&str] = &["id", "from_id", "to_id", "edge_type", "properties"];

#[derive(Clone, Copy, PartialEq)]
enum Lane {
    Items,
    Edges,
}

impl Lane {
    fn kind(self) -> WriteKind {
        match self {
            Lane::Items => WriteKind::CreateItem,
            Lane::Edges => WriteKind::CreateEdge,
        }
    }

    fn door(self) -> &'static [&'static str] {
        match self {
            Lane::Items => &["items", "bulk"],
            Lane::Edges => &["edges", "bulk"],
        }
    }

    fn entries(self) -> &'static str {
        match self {
            Lane::Items => "items",
            Lane::Edges => "edges",
        }
    }

    fn keys(self) -> &'static [&'static str] {
        match self {
            Lane::Items => ITEM_KEYS,
            Lane::Edges => EDGE_KEYS,
        }
    }

    /// What a created write waits under, its verdict kept, while the read
    /// that settles it is owed.
    fn receipt(self) -> &'static str {
        match self {
            Lane::Items => "page:item",
            Lane::Edges => "page:edge",
        }
    }

    fn of_receipt(receipt: &str) -> Option<Lane> {
        [Lane::Items, Lane::Edges]
            .into_iter()
            .find(|lane| lane.receipt() == receipt)
    }

    fn subject(self) -> Subject {
        match self {
            Lane::Items => Subject::Item,
            Lane::Edges => Subject::Edge,
        }
    }

    fn shape(self) -> Shape {
        match self {
            Lane::Items => Shape::Item,
            Lane::Edges => Shape::Edge,
        }
    }

    /// The item a read by id finds the row in: the item itself, or the
    /// edge's source, which holds it among its edges.
    fn source(self, row: &QueuedWrite) -> Option<String> {
        match self {
            Lane::Items => row.item_id.clone(),
            Lane::Edges => row
                .body
                .get("from_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        }
    }

    /// The id the create minted, which a created entry must answer with.
    fn minted(self, row: &QueuedWrite) -> Option<&str> {
        match self {
            Lane::Items => row.item_id.as_deref(),
            Lane::Edges => row.edge_id.as_deref(),
        }
    }
}

/// What every page of a pass is sent with.
pub(super) struct Sender<'a> {
    pub core: &'a Core,
    pub http: &'a Http,
    pub generation: u64,
    pub stop: &'a AtomicBool,
}

/// What the pass has decided so far, which the pages add to.
pub(super) struct Standing<'a, 'b> {
    pub all: &'a [QueuedWrite],
    pub rows: &'a HashMap<&'a str, &'a QueuedWrite>,
    pub answers: &'b mut HashMap<String, Option<Verdict>>,
    pub landing: &'a HashMap<String, String>,
}

/// Sends the creates of items, then of edges, that wait in pages, where at
/// least `FLOOR` of a kind do. Edges go after every item page is settled, so
/// an edge goes in a page only once both its ends are answered.
///
/// With `defer`, the ids of the edge creates left for a later pass are returned (see `hold_back`).
pub(super) fn send(
    sender: &Sender<'_>,
    pass: &mut ReachChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    confirm: &mut dyn FnMut(&mut DrainReport) -> Result<bool>,
    defer: bool,
) -> Result<HashSet<String>> {
    let mut deferred = HashSet::new();
    for lane in [Lane::Items, Lane::Edges] {
        if report.unavailable.is_some() || pass.changed() {
            return Ok(deferred);
        }
        let led = (defer && lane == Lane::Edges).then(|| led(standing));
        let Found {
            ready: mut waiting,
            deferrable,
        } = candidates(sender.core, lane, standing, led.as_ref())?;
        if waiting.len() + deferrable.len() < FLOOR || !confirm(report)? {
            continue;
        }
        // The root was read just now. A create over its limit meets the walk,
        // so whether it goes does not depend on what else waits.
        if let Some(limit) = store::request_limit(&*sender.core.conn()?)? {
            waiting.retain(|candidate| candidate.size <= limit);
            if waiting.len() + deferrable.len() < FLOOR {
                continue;
            }
            for candidate in &mut waiting {
                if candidate.entry_size > limit {
                    candidate.drop_tags();
                }
            }
        }
        if let Some(led) = &led {
            deferred.extend(hold_back(&mut waiting, &deferrable, led));
        }
        if waiting.len() >= FLOOR {
            for page in pages(&waiting) {
                crate::catch_up::refuse_if_stopped(sender.stop)?;
                if report.unavailable.is_some() {
                    return Ok(deferred);
                }
                if !send_page(sender, pass, report, standing, lane, &page)? {
                    // The server would not take the page whole: what is left
                    // goes on its own doors.
                    return Ok(deferred);
                }
            }
        }
    }
    Ok(deferred)
}

/// The creates the walk would send unchanged, in queue order, each with the
/// bytes it sends: never sent, so a page is the first attempt and every
/// later one goes on its own door under its key
/// (`queue-and-verdicts/page-never-sent`); each naming the id it minted, the
/// only thing a page settles by; ready now; no larger than a request on its
/// own door may carry, so whether the server takes it does not depend on
/// what else waits; and with nothing about them the walk decides on a
/// write's own answer.
///
/// A page goes before the writes queued ahead of its creates: an entry one of
/// them would have changed is refused and goes on its own door after it.
fn candidates<'a>(
    core: &Core,
    lane: Lane,
    standing: &Standing<'a, '_>,
    led: Option<&HashSet<&str>>,
) -> Result<Found<'a>> {
    let conn = core.conn()?;
    let none = HashSet::new();
    let mut found = Vec::new();
    let mut deferrable = Vec::new();
    let mut by_item: HashMap<&str, Vec<&'a QueuedWrite>> = HashMap::new();
    if lane == Lane::Items {
        for row in standing.all {
            if let Some(item) = row.item_id.as_deref() {
                by_item.entry(item).or_default().push(row);
            }
        }
    }
    for row in standing.all {
        let unanswered = standing
            .answers
            .get(&row.id)
            .is_some_and(|verdict| verdict.is_none());
        if row.kind != lane.kind()
            || !unanswered
            || row.follows.is_some()
            || row.environmental_streak != 0
            || store_fault(row).is_some()
            || !store::unsent(&conn, &row.id)?
        {
            continue;
        }
        let size = store::payload_of(&conn, &row.id)?.len();
        if !fits(lane, row, &row.body, size) {
            continue;
        }
        let ready = readiness(
            row,
            standing.rows,
            &*standing.answers,
            &none,
            standing.landing,
            super::create_edges::waits(&conn, row)?,
        );
        let held = match ready {
            Readiness::Ready => false,
            Readiness::Held if led.is_some_and(|led| waits_for_answers(row, standing, led)) => true,
            _ => continue,
        };
        if crate::body::rule::lost_body(&conn, row)?.is_some() {
            continue;
        }
        if held {
            deferrable.push(row);
            continue;
        }
        let tags = match row.item_id.as_deref().and_then(|item| by_item.get(item)) {
            Some(writes) => carried(&conn, standing, row, writes)?,
            None => Vec::new(),
        };
        let mut candidate = Candidate {
            row,
            size,
            entry_size: size,
            tags,
        };
        candidate.entry_size = entry_size(row, size, &candidate.tags);
        if candidate.entry_size > REQUEST_LIMIT {
            candidate.drop_tags();
        }
        found.push(candidate);
    }
    Ok(Found {
        ready: found,
        deferrable,
    })
}

/// The creates ready for a page, and the edge creates that wait only on writes not yet answered.
struct Found<'a> {
    ready: Vec<Candidate<'a>>,
    deferrable: Vec<&'a QueuedWrite>,
}

/// The writes an unanswered write behind them acts on, so that none of them
/// goes later than that write: those it follows or depends on, and a create
/// of an edge that a later write names (the edge, or either end), other than
/// another edge's create between other ends. A later delete, or move into the
/// bin, of any item leads every create of an edge queued before it: the server
/// takes into the bin each item a cascading edge reaches from that item, and
/// refuses an edge to one there.
fn led<'a>(standing: &Standing<'a, '_>) -> HashSet<&'a str> {
    let mut led = HashSet::new();
    let mut items: HashSet<&str> = HashSet::new();
    let mut edges: HashSet<&str> = HashSet::new();
    let mut links: HashSet<(&str, &str, &str)> = HashSet::new();
    let mut bins = false;
    for row in standing.all.iter().rev() {
        let unanswered = standing
            .answers
            .get(&row.id)
            .is_some_and(|verdict| verdict.is_none());
        if !unanswered {
            continue;
        }
        led.extend(
            row.follows
                .as_deref()
                .into_iter()
                .chain(row.depends_on.iter().map(String::as_str)),
        );
        let (from, to) = (row.item_id.as_deref(), row.to_id.as_deref());
        let edge_type = row
            .body
            .get("edge_type")
            .and_then(serde_json::Value::as_str);
        if row.kind == WriteKind::CreateEdge {
            let named = bins
                || [from, to]
                    .into_iter()
                    .flatten()
                    .any(|id| items.contains(id))
                || row.edge_id.as_deref().is_some_and(|id| edges.contains(id))
                || matches!((from, to, edge_type), (Some(from), Some(to), Some(kind))
                    if links.contains(&(from, to, kind)));
            if named {
                led.insert(row.id.as_str());
            }
            if let (Some(from), Some(to), Some(kind)) = (from, to, edge_type) {
                links.insert((from, to, kind));
            }
        } else {
            bins |= row.kind == WriteKind::DeleteItem
                || (row.kind == WriteKind::TransitionItem
                    && row.body.get("state").and_then(serde_json::Value::as_str)
                        == Some(ItemState::Trashed.as_str()));
            let body_end = |key: &str| row.body.get(key).and_then(serde_json::Value::as_str);
            // An edge write holds its edge's ends, which every sibling link
            // shares: it names them only where it moves one.
            let held = (!matches!(row.kind, WriteKind::UpdateEdge | WriteKind::DeleteEdge))
                .then_some([from, to])
                .into_iter()
                .flatten();
            items.extend(
                held.chain([body_end("from_id"), body_end("to_id")])
                    .flatten(),
            );
        }
        edges.extend(row.edge_id.as_deref());
    }
    led
}

/// The edge creates to hold for the pass after this one, and the ready ones
/// among `waiting` that go with them, removed from it. A held create waits on
/// answers this drain has yet to make, so it is held only where the creates
/// held make a page of their own then, and none of them has a write behind it.
/// A create with one stays where it is, on the walk in queue order, so the
/// write behind it never reaches the server first.
fn hold_back(
    waiting: &mut Vec<Candidate<'_>>,
    deferrable: &[&QueuedWrite],
    led: &HashSet<&str>,
) -> HashSet<String> {
    let mut held: HashSet<String> = deferrable.iter().map(|row| row.id.clone()).collect();
    if waiting.len() < FLOOR {
        let free = waiting
            .iter()
            .filter(|candidate| !led.contains(candidate.row.id.as_str()))
            .count();
        if free + held.len() < FLOOR {
            return HashSet::new();
        }
        waiting.retain(|candidate| {
            let stays = led.contains(candidate.row.id.as_str());
            if !stays {
                held.insert(candidate.row.id.clone());
            }
            stays
        });
    } else if held.len() < FLOOR {
        return HashSet::new();
    }
    held
}

/// Whether the write waits only on unanswered writes, with no write behind it.
fn waits_for_answers(row: &QueuedWrite, standing: &Standing<'_, '_>, led: &HashSet<&str>) -> bool {
    if led.contains(row.id.as_str()) {
        return false;
    }
    let mut pending = false;
    for dependency in &row.depends_on {
        if standing.landing.contains_key(dependency) {
            return false;
        }
        match standing.answers.get(dependency) {
            Some(None) => pending = true,
            Some(Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted)) => {}
            _ => return false,
        }
    }
    pending
}

/// A create a page may carry, and the tag writes its entry carries with it.
struct Candidate<'a> {
    row: &'a QueuedWrite,
    /// The bytes the create sends on its own door.
    size: usize,
    /// The bytes its entry sends, with its tags.
    entry_size: usize,
    tags: Vec<&'a QueuedWrite>,
}

impl Candidate<'_> {
    fn drop_tags(&mut self) {
        self.tags.clear();
        self.entry_size = self.size;
    }
}

/// The tag writes queued with the create `row` that its entry carries: each
/// adds one tag, waits on the create alone, has never been sent and met no
/// failure, and has no other write to the item queued between it and the
/// create. `writes` are the item's writes in queue order.
fn carried<'a>(
    conn: &rusqlite::Connection,
    standing: &Standing<'a, '_>,
    row: &QueuedWrite,
    writes: &[&'a QueuedWrite],
) -> Result<Vec<&'a QueuedWrite>> {
    let mut tags = Vec::new();
    let mut ahead = row.id.as_str();
    for write in writes.iter().skip_while(|write| write.id != row.id).skip(1) {
        let unanswered = standing
            .answers
            .get(&write.id)
            .is_some_and(|verdict| verdict.is_none());
        if write.kind != WriteKind::AddTag
            || !unanswered
            || write.depends_on != [row.id.clone()]
            || write.follows.as_deref() != Some(ahead)
            || write.environmental_streak != 0
            || store_fault(write).is_some()
            || tag_of(write).is_none()
            || !store::unsent(conn, &write.id)?
        {
            break;
        }
        ahead = write.id.as_str();
        tags.push(*write);
    }
    Ok(tags)
}

/// The one tag an add-tag write adds, where its body is that and no more.
fn tag_of(write: &QueuedWrite) -> Option<&str> {
    let object = write.body.as_object()?;
    match object.get("tags")?.as_array()?.as_slice() {
        [tag] if object.len() == 1 => tag.as_str(),
        _ => None,
    }
}

/// The tags an entry carries, each once, in the order they were queued.
fn tags_of<'a>(writes: impl IntoIterator<Item = &'a QueuedWrite>) -> Vec<&'a str> {
    let mut tags: Vec<&str> = Vec::new();
    for tag in writes.into_iter().filter_map(tag_of) {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

fn entry_size(row: &QueuedWrite, size: usize, tags: &[&QueuedWrite]) -> usize {
    let tags = tags_of(tags.iter().copied());
    if tags.is_empty() {
        return size;
    }
    let mut body = row.body.clone();
    if let Some(object) = body.as_object_mut() {
        object.insert("tags".into(), serde_json::json!(tags));
    }
    body.to_string().len()
}

/// `size` is the bytes the write sends as its own request's body.
fn fits(lane: Lane, row: &QueuedWrite, body: &serde_json::Value, size: usize) -> bool {
    let Some(object) = body.as_object() else {
        return false;
    };
    size <= REQUEST_LIMIT
        && object.keys().all(|key| lane.keys().contains(&key.as_str()))
        && object.get("id").and_then(serde_json::Value::as_str) == lane.minted(row)
        && lane.minted(row).is_some()
}

/// The creates split into pages by count and by the bytes they send.
fn pages<'a, 'b>(waiting: &'b [Candidate<'a>]) -> Vec<Vec<&'b Candidate<'a>>> {
    let mut pages = Vec::new();
    let mut page = Vec::new();
    let mut bytes = 0;
    for candidate in waiting {
        let size = candidate.entry_size + 1;
        if !page.is_empty() && (page.len() == ENTRIES || bytes + size > BYTES) {
            pages.push(std::mem::take(&mut page));
            bytes = 0;
        }
        bytes += size;
        page.push(candidate);
    }
    if !page.is_empty() {
        pages.push(page);
    }
    pages
}

#[derive(Deserialize)]
struct PageAnswer {
    results: Vec<PageResult>,
}

#[derive(Deserialize)]
struct PageResult {
    index: usize,
    outcome: String,
    #[serde(default)]
    id: Option<String>,
}

/// Sends one page and settles what it created. `false` where the server
/// answered the page with no answer for its entries that is about them, so
/// the rest of the pass goes on the walk, or refused its credential and
/// parked the queue.
fn send_page(
    sender: &Sender<'_>,
    pass: &mut ReachChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    lane: Lane,
    page: &[&Candidate<'_>],
) -> Result<bool> {
    // Checked and marked sent in one transaction: a write changed since the
    // pass read the queue is left to the walk, which reads it again.
    let Sender {
        core,
        http,
        generation,
        stop,
    } = *sender;
    let (sent, payloads, tagged) = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        let mut sent = Vec::with_capacity(page.len());
        let mut payloads = Vec::with_capacity(page.len());
        let mut tagged: HashMap<String, Vec<QueuedWrite>> = HashMap::new();
        for candidate in page {
            let row = candidate.row;
            let Some(now) = store::queued_write(&tx, &row.id)? else {
                continue;
            };
            if now.verdict.is_some()
                || now.idempotency_key != row.idempotency_key
                || now.follows.is_some()
                || !store::unsent(&tx, &now.id)?
            {
                continue;
            }
            let sent_as = store::payload_of(&tx, &now.id)?;
            let mut payload: serde_json::Value = serde_json::from_str(&sent_as)?;
            if !fits(lane, &now, &payload, sent_as.len()) {
                continue;
            }
            store::mark_sent(&tx, &now.id)?;
            let tags = still_carried(&tx, &now.id, &candidate.tags)?;
            for tag in &tags {
                store::mark_sent(&tx, &tag.id)?;
            }
            let names = tags_of(&tags);
            if let (false, Some(object)) = (names.is_empty(), payload.as_object_mut()) {
                object.insert("tags".into(), serde_json::json!(names));
            }
            if !tags.is_empty() {
                tagged.insert(now.id.clone(), tags);
            }
            payloads.push(payload);
            sent.push(now);
        }
        tx.commit()?;
        (sent, payloads, tagged)
    };
    let carrying = || tagged.values().flatten();
    if sent.is_empty() {
        return Ok(true);
    }
    let body = serde_json::json!({
        lane.entries(): payloads,
        "mode": "create_only",
        "atomic": false,
        // A write on its own door reaches outbound webhooks
        // (`items/single-write-fanout`), and a page's would not without it.
        "enable_fanout": true,
    })
    .to_string();
    let answer = {
        let span = telemetry::operation!("write_page", kind, entries, status);
        telemetry::record!(span, kind = lane.kind().as_str(), entries = sent.len());
        let door = lane.door();
        let answer = crate::catch_up::ask_unless_stopped(stop, http, move |http| {
            http.send_page(door, &body)
        });
        telemetry::ended!(
            span,
            answer.as_ref(),
            |answer| {
                outcome = if answer.is_environmental() {
                    "unavailable"
                } else {
                    "answered"
                },
                status = answer.status,
            },
            unanswered ends_the_drain
        );
        answer
    };
    if not_taken(&answer) {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for row in sent.iter().chain(carrying()) {
            store::mark_unsent(&tx, &row.id)?;
        }
        tx.commit()?;
    }
    let answer = match answer {
        // Another instance took none of the page, so each write is judged
        // there afresh, as one on its own door is.
        Err(CoreError::CopyExpired { reason, server }) if reason == INSTANCE_CHANGED => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            for row in sent.iter().chain(carrying()) {
                store::mark_unsent(&tx, &row.id)?;
            }
            let error = crate::catch_up::expire_for_another_instance(&tx, generation, server)?;
            tx.commit()?;
            return Err(error);
        }
        Err(error) if ends_the_drain(&error) || error == CoreError::Canceled => {
            return Err(error);
        }
        answer => answer,
    };
    waited(
        report,
        match &answer {
            Ok(answer) => answer.retry_after_seconds,
            Err(error) => error.retry_after().map(|wait| wait.as_secs()),
        },
    );
    match classify(&answer) {
        Classified::Success => {}
        Classified::Environmental => {
            let conn = core.conn()?;
            if !not_the_writes(&answer) {
                let failure = failure_of(&answer);
                for row in sent.iter().chain(carrying()) {
                    store::note_last_failure(&conn, &row.id, &failure)?;
                }
            }
            if let Err(error) = &answer {
                telemetry::degraded!(error);
            }
            // The walk counts each write undelivered, as it counts every
            // write it reaches once the server cannot take writes.
            report.unavailable =
                unavailable(&answer).or_else(|| answer.as_ref().err().map(CoreError::to_string));
            report.limited = limited_by_server(&answer);
            return Ok(true);
        }
        // A write sent on its own door would meet the same refusal, under a
        // key that then keeps it out of every later page.
        Classified::BlockQueue(_) => {
            let refusal = answer.as_ref().ok().map(crate::http::Answer::server_answer);
            park_for_credential(core, report, refusal)?;
            return Ok(false);
        }
        _ => return Ok(false),
    }
    let Some(created) = created(lane, &sent, answer.as_ref().ok()) else {
        return Ok(false);
    };
    settle(core, stop, pass, report, standing, lane, &created)?;
    for (row, entry) in &created {
        // A create the page settles goes before its tags, as on the walk; one
        // it leaves to the walk leaves its tags to it too.
        let accepted = standing.answers.get(&row.id) == Some(&Some(Verdict::Accepted));
        if let (true, Some(tags)) = (accepted, tagged.get(&row.id)) {
            settle_carried(core, report, standing, tags, entry)?;
        }
    }
    Ok(true)
}

/// The tag writes of a create as they stand now, up to the first that has
/// changed since the pass read the queue: those go on their own doors, after
/// the create, as queued.
fn still_carried(
    tx: &rusqlite::Transaction<'_>,
    create: &str,
    tags: &[&QueuedWrite],
) -> Result<Vec<QueuedWrite>> {
    let mut kept: Vec<QueuedWrite> = Vec::with_capacity(tags.len());
    for tag in tags {
        let ahead = kept.last().map_or(create, |last| last.id.as_str());
        let Some(now) = store::queued_write(tx, &tag.id)? else {
            break;
        };
        let payload: serde_json::Value = serde_json::from_str(&store::payload_of(tx, &now.id)?)?;
        if now.verdict.is_some()
            || now.idempotency_key != tag.idempotency_key
            || now.body != tag.body
            || payload != now.body
            || now.follows.as_deref() != Some(ahead)
            || !store::unsent(tx, &now.id)?
        {
            break;
        }
        kept.push(now);
    }
    Ok(kept)
}

/// Answers the tag writes an entry the page created carried: the server
/// wrote the entry's item and tags in one step
/// (`items/bulk-errored-wrote-nothing`), so each tag landed with it.
fn settle_carried(
    core: &Core,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    tags: &[QueuedWrite],
    entry: &str,
) -> Result<()> {
    let mut answered = Vec::with_capacity(tags.len());
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for tag in tags {
            let gone = store::queued_write(&tx, &tag.id)?.is_none_or(|now| now.verdict.is_some());
            if gone || same_attempt(&tx, tag).is_err() {
                break;
            }
            store::record_verdict(
                &tx,
                &tag.id,
                &store::Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: Some(entry),
                    conflicted_copy_id: None,
                },
            )?;
            answered.push(tag);
        }
        tx.commit()?;
    }
    for tag in answered {
        report.answered += 1;
        standing
            .answers
            .insert(tag.id.clone(), Some(Verdict::Accepted));
        put_verdict(
            report,
            None,
            verdict_of(
                tag,
                &Settled::plain(Some(Verdict::Accepted), None, tag.refusals),
                Some(entry),
            ),
        );
    }
    Ok(())
}

/// Whether the server wrote nothing of the page, so its writes go out again
/// as a first attempt: it limited the request, or refused its credential
/// (`items/write-race-key-revoked`) and the device kept that refusal or
/// could not renew the credential, a sign-out included.
fn not_taken(answer: &std::result::Result<Answer, CoreError>) -> bool {
    rate_limited(answer)
        || match answer {
            Ok(answer) => answer.status == 401,
            Err(error) => matches!(
                error,
                CoreError::RenewalFailed(_) | CoreError::SignedOut { .. }
            ),
        }
}

/// The writes the page created under the ids they minted, each with the
/// page's answer for it. `None` where the answer does not say, entry by
/// entry, what the page did.
fn created<'a>(
    lane: Lane,
    sent: &'a [QueuedWrite],
    answer: Option<&Answer>,
) -> Option<Vec<(&'a QueuedWrite, String)>> {
    let body = &answer?.body;
    let parsed = serde_json::from_str::<PageAnswer>(body).ok()?;
    let entries = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let entries = entries.get("results")?.as_array()?;
    if parsed.results.len() != sent.len() {
        return None;
    }
    let mut created = Vec::new();
    for (at, result) in parsed.results.iter().enumerate() {
        if result.index != at {
            return None;
        }
        let row = &sent[at];
        if result.outcome == "created" && result.id.as_deref() == lane.minted(row) {
            created.push((row, entries.get(at)?.to_string()));
        }
    }
    Some(created)
}

/// Each item the reads found, as parsed and as the server wrote it.
type Held = HashMap<String, (WireItemWithMetadata, serde_json::Value)>;

/// The copy the reads are made against, and each row's stamp before them.
fn capture(
    core: &Core,
    lane: Lane,
    rows: &[&QueuedWrite],
) -> Result<(reach::Context, HashMap<String, Option<store::Stamp>>)> {
    let conn = core.conn()?;
    let context = reach::Context::capture(&conn)?;
    let mut before = HashMap::new();
    for row in rows {
        if let Some(id) = lane.minted(row) {
            before.insert(id.to_string(), store::stamp(&conn, lane.subject(), id)?);
        }
    }
    Ok((context, before))
}

/// Reads the items `rows` are found in, a hundred to a request.
fn read(
    core: &Core,
    stop: &AtomicBool,
    context: &reach::Context,
    lane: Lane,
    rows: &[&QueuedWrite],
) -> Result<Held> {
    let mut seen = HashSet::new();
    let sources: Vec<String> = rows
        .iter()
        .filter_map(|row| lane.source(row))
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let reader = context.http(core.http()?);
    let mut held = Held::new();
    for ids in sources.chunks(BULK_GET_LIMIT) {
        crate::catch_up::refuse_if_stopped(stop)?;
        let asked = ids.to_vec();
        let found = crate::catch_up::ask_unless_stopped(stop, &reader, move |http| {
            http.items_by_id_whole(&asked)
        })?;
        for (row, whole) in found {
            held.insert(row.item.id.clone(), (row, whole));
        }
    }
    if lane == Lane::Edges {
        read_rest(&reader, stop, rows, &mut held)?;
    }
    Ok(held)
}

/// The most pages of one source's edges of a type a read follows.
const LISTING_PAGES: usize = 20;

/// Looks for an edge past the first page of its source's edges (`edges/hydrate-cap`) in the rest of the listing.
fn read_rest(http: &Http, stop: &AtomicBool, rows: &[&QueuedWrite], held: &mut Held) -> Result<()> {
    let mut wanted: BTreeMap<(String, String), HashSet<String>> = BTreeMap::new();
    for row in rows {
        let (Some(source), Some(id), Some(edge_type)) = (
            Lane::Edges.source(row),
            row.edge_id.as_deref(),
            row.body
                .get("edge_type")
                .and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        if held
            .get(&source)
            .is_some_and(|(_, whole)| edge_in(whole, row, id).is_none())
        {
            wanted
                .entry((source, edge_type.to_string()))
                .or_default()
                .insert(id.to_string());
        }
    }
    for ((source, edge_type), mut ids) in wanted {
        let Some((_, whole)) = held.get_mut(&source) else {
            continue;
        };
        let Some(block) = whole
            .get_mut("edges")
            .and_then(|edges| edges.get_mut(&edge_type))
        else {
            continue;
        };
        let mut cursor = block
            .get("next_cursor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let Some(data) = block
            .get_mut("data")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let mut seen = HashSet::new();
        for _ in 0..LISTING_PAGES {
            let Some(at) = cursor.take() else {
                break;
            };
            if ids.is_empty() || !seen.insert(at.clone()) {
                break;
            }
            crate::catch_up::refuse_if_stopped(stop)?;
            let page = match crate::catch_up::ask_unless_stopped(stop, http, {
                let (source, edge_type, at) = (source.clone(), edge_type.clone(), at.clone());
                move |http| http.item_edges_page(&source, &edge_type, Some(&at))
            }) {
                Ok(page) => page,
                Err(error)
                    if error.is_environmental()
                        || ends_the_drain(&error)
                        || error == CoreError::Canceled =>
                {
                    return Err(error);
                }
                // The walk sends what the listing did not bring.
                Err(_) => break,
            };
            for edge in page.data {
                if ids.remove(&edge.id) {
                    data.push(serde_json::to_value(&edge)?);
                }
            }
            cursor = page.next_cursor;
        }
    }
    Ok(())
}

/// The write's row as the reads found it, as a write's answer and as its
/// read-back. `None` where the reads did not find it.
fn found(
    lane: Lane,
    row: &QueuedWrite,
    held: &Held,
    context: &reach::Context,
    before: &HashMap<String, Option<store::Stamp>>,
) -> Option<(serde_json::Value, ReadBack)> {
    let id = lane.minted(row)?;
    let before = before.get(id).cloned().flatten();
    match lane {
        Lane::Items => held.get(id).map(|(row, whole)| {
            let mut row = row.clone();
            row.item.edges = None;
            let mut whole = whole.clone();
            if let Some(object) = whole.as_object_mut() {
                object.remove("edges");
            }
            (
                serde_json::json!({ "item": whole }),
                ReadBack::Item {
                    context: context.clone(),
                    id: id.to_string(),
                    held: Some(Box::new(row)),
                    before,
                },
            )
        }),
        Lane::Edges => {
            let (_, whole) = held.get(&lane.source(row)?)?;
            let (edge, whole) = edge_in(whole, row, id)?;
            Some((
                serde_json::json!({ "edge": whole }),
                ReadBack::Edge {
                    context: context.clone(),
                    id: id.to_string(),
                    held: Some(Box::new(edge)),
                    before,
                },
            ))
        }
    }
}

/// Reads what the page created, a hundred rows to a request, and settles
/// each write on the row as the server holds it, as a repeat of the write
/// would be answered (`queue-and-verdicts/not-retained-accepted`). A write
/// the read does not find is left to the walk.
fn settle(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ReachChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    lane: Lane,
    created: &[(&QueuedWrite, String)],
) -> Result<()> {
    let rows: Vec<&QueuedWrite> = created.iter().map(|(row, _)| *row).collect();
    let (context, before) = capture(core, lane, &rows)?;
    let held = match read(core, stop, &context, lane, &rows) {
        Ok(held) => held,
        Err(error) if error.is_environmental() => {
            telemetry::degraded!(&error);
            owe(core, report, standing, lane, created)?;
            report.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
            report.limited = error.is_limit_named();
            waited(report, error.retry_after().map(|wait| wait.as_secs()));
            return Ok(());
        }
        // The server took the page, so each create is owed its read, not sent
        // again.
        Err(CoreError::Canceled) => {
            owe(core, report, standing, lane, created)?;
            return Err(CoreError::Canceled);
        }
        Err(error) => return Err(context.failed(core, error)?),
    };
    for row in rows {
        let Some(found) = found(lane, row, &held, &context, &before) else {
            continue;
        };
        // An earlier write's settling can have changed the copy the read was
        // made against; this one then goes on its own door.
        if context.check(&*core.conn()?).is_err() {
            continue;
        }
        settle_one(core, stop, pass, report, standing, lane, row, found)?;
    }
    Ok(())
}

/// Settles each created write on the page's answer for it, as a write whose
/// own answer came and whose read failed is settled: its verdict is kept,
/// and its read is owed under the lane's receipt, which the next pass makes
/// before it sends anything (`queue-and-verdicts/page-read-back-failed`).
fn owe(
    core: &Core,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    lane: Lane,
    created: &[(&QueuedWrite, String)],
) -> Result<()> {
    let mut owing = Vec::with_capacity(created.len());
    {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        for (row, entry) in created {
            // Changed since it was sent, so the walk reads it again.
            if same_attempt(&tx, row).is_err() {
                continue;
            }
            let Some(owed) = store::owed_of(&tx, row)? else {
                continue;
            };
            store::record_verdict(
                &tx,
                &row.id,
                &store::Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: Some(entry),
                    conflicted_copy_id: None,
                },
            )?;
            store::owe_read_back(&tx, &owed)?;
            store::meta_set(&tx, &receipt_key(&row.id), lane.receipt())?;
            owing.push(*row);
        }
        tx.commit()?;
    }
    for row in owing {
        report.answered += 1;
        standing
            .answers
            .insert(row.id.clone(), Some(Verdict::Accepted));
        let answered = store::queued_write(&*core.conn()?, &row.id)?;
        let answered = answered.as_ref().unwrap_or(row);
        put_verdict(
            report,
            None,
            verdict_of(
                answered,
                &Settled::plain(Some(Verdict::Accepted), None, answered.refusals),
                answered.answer.as_deref(),
            ),
        );
    }
    Ok(())
}

/// Whether a write's receipt is one `owe` left.
pub(super) fn owed_by_a_page(receipt: &str) -> bool {
    Lane::of_receipt(receipt).is_some()
}

/// Makes the reads `owe` left, a hundred rows to a request, and settles each
/// write on what they find, as a page's read settles it. An edge the read of
/// its source does not hold is read by its id. Any other write the reads do
/// not find keeps its verdict, and its read stays owed as any other. A read
/// the server refuses stays owed, as one on its own door does, and the pass
/// goes on.
pub(super) fn settle_owed(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ReachChange,
    waiting: &[(QueuedWrite, String)],
) -> Result<Option<Unreadable>> {
    for lane in [Lane::Items, Lane::Edges] {
        let mut left: Vec<&QueuedWrite> = waiting
            .iter()
            .filter(|(_, receipt)| Lane::of_receipt(receipt) == Some(lane))
            .map(|(row, _)| row)
            .collect();
        while !left.is_empty() {
            let (context, before) = capture(core, lane, &left)?;
            let held = match read(core, stop, &context, lane, &left) {
                Ok(held) => held,
                Err(error) if error.is_environmental() => {
                    telemetry::degraded!(&error);
                    return Ok(Some(Unreadable {
                        reason: unavailable_by(&error).unwrap_or_else(|| error.to_string()),
                        limited: error.is_limit_named(),
                        retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
                    }));
                }
                Err(error) if ends_the_drain(&error) || error == CoreError::Canceled => {
                    return Err(context.failed(core, error)?);
                }
                Err(_) => break,
            };
            let mut again = Vec::new();
            for row in &left {
                crate::catch_up::refuse_if_stopped(stop)?;
                // An earlier write's settling can have changed the copy the
                // read was made against; this one is read again.
                if context.check(&*core.conn()?).is_err() {
                    again.push(*row);
                    continue;
                }
                let read = match found(lane, row, &held, &context, &before) {
                    Some(found) => Some(found),
                    None => match alone(core, stop, pass, lane, row) {
                        Ok(read) => read,
                        Err(error) if error.is_environmental() => {
                            telemetry::degraded!(&error);
                            return Ok(Some(Unreadable {
                                reason: unavailable_by(&error).unwrap_or_else(|| error.to_string()),
                                limited: error.is_limit_named(),
                                retry_after_seconds: error.retry_after().map(|wait| wait.as_secs()),
                            }));
                        }
                        Err(error) if ends_the_drain(&error) || error == CoreError::Canceled => {
                            return Err(error);
                        }
                        Err(_) => continue,
                    },
                };
                let Some((body, read)) = read else {
                    continue;
                };
                let answer = Answer {
                    status: 200,
                    code: String::new(),
                    body: body.to_string(),
                    retry_after_seconds: None,
                    replayed: true,
                    contract_named: true,
                };
                settle_success(
                    core,
                    stop,
                    row,
                    &answer,
                    lane.shape(),
                    pass,
                    false,
                    Some(read),
                )?;
            }
            // Each round settles at least one write, or the copy changed
            // under every read and the pass ends.
            if again.len() == left.len() {
                return Ok(Some(Unreadable {
                    reason: "the copy changed while the writes a page created were read back"
                        .into(),
                    limited: false,
                    retry_after_seconds: None,
                }));
            }
            left = again;
        }
    }
    Ok(None)
}

/// A write the reads of a page's rows did not find, read on its own. An edge
/// found by its id comes back as its answer and its read; anything else is
/// applied as a read owed is, and its receipt goes.
fn alone(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ReachChange,
    lane: Lane,
    row: &QueuedWrite,
) -> Result<Option<(serde_json::Value, ReadBack)>> {
    let Some(owed) = store::owed_of(&*core.conn()?, row)? else {
        store::meta_delete(&*core.conn()?, &receipt_key(&row.id))?;
        return Ok(None);
    };
    let read = read_owed(core, stop, &owed, Bin::Held, pass, false)?;
    if lane == Lane::Edges
        && let ReadBack::Edge {
            held: Some(edge), ..
        } = &read
    {
        return Ok(Some((
            serde_json::json!({ "edge": serde_json::to_value(edge.as_ref())? }),
            read,
        )));
    }
    if matches!(read, ReadBack::Unread) {
        return Ok(None);
    }
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    apply_read_back(&tx, &read)?;
    store::settle_read_back(&tx, owed.subject, &owed.id)?;
    store::meta_delete(&tx, &receipt_key(&row.id))?;
    tx.commit()?;
    Ok(None)
}

/// The edge as its from item's first page of its edges of the type holds
/// it, which the read asked for.
fn edge_in(
    item: &serde_json::Value,
    row: &QueuedWrite,
    id: &str,
) -> Option<(WireEdge, serde_json::Value)> {
    let edge_type = row.body.get("edge_type")?.as_str()?;
    let whole = item
        .get("edges")?
        .get(edge_type)?
        .get("data")?
        .as_array()?
        .iter()
        .find(|edge| edge.get("id").and_then(serde_json::Value::as_str) == Some(id))?
        .clone();
    let edge = serde_json::from_value::<WireEdge>(whole.clone()).ok()?;
    Some((edge, whole))
}

#[allow(clippy::too_many_arguments)]
fn settle_one(
    core: &Core,
    stop: &AtomicBool,
    pass: &mut ReachChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    lane: Lane,
    row: &QueuedWrite,
    (body, read): (serde_json::Value, ReadBack),
) -> Result<()> {
    let shape = lane.shape();
    let answer = Answer {
        status: 201,
        code: String::new(),
        body: body.to_string(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    };
    let settled = match settle_success(core, stop, row, &answer, shape, pass, true, Some(read)) {
        Ok(settled) => settled,
        Err(error) => {
            // As on the walk: a verdict committed before the error is told
            // with it, and a write the error left unanswered goes on.
            if let Some(current) = store::queued_write(&*core.conn()?, &row.id)?
                && current.verdict.is_some()
            {
                report.answered += 1;
                put_verdict(
                    report,
                    None,
                    verdict_of(
                        &current,
                        &committed(&current, Some(&answer), shape, false),
                        current.answer.as_deref(),
                    ),
                );
            }
            return Err(error);
        }
    };
    report.answered += 1;
    standing.answers.insert(row.id.clone(), settled.verdict);
    let answered = store::queued_write(&*core.conn()?, &row.id)?;
    let answered = answered.as_ref().unwrap_or(row);
    put_verdict(
        report,
        None,
        verdict_of(answered, &settled, answered.answer.as_deref()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Draft;
    use crate::scripted::{self, Scripted};

    /// A copy with `count` notes queued to create, and nothing to pull.
    fn creating(server: &Scripted, count: usize) -> (tempfile::TempDir, Core) {
        tagged(server, count, &[])
    }

    /// As `creating`, each note naming `tags`.
    fn tagged(server: &Scripted, count: usize, tags: &[&str]) -> (tempfile::TempDir, Core) {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("core.sqlite"),
            Some(crate::Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, &"a".repeat(64)).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
            store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        }
        for at in 0..count {
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": format!("Note {at}"), "body": "text" })
                    .as_object()
                    .unwrap()
                    .clone(),
                tags: tags.iter().map(|tag| tag.to_string()).collect(),
                ..Default::default()
            })
            .unwrap();
        }
        (dir, core)
    }

    /// `queue-and-verdicts/page-not-authorized`, where renewal is refused
    /// for good and where it fails for now.
    #[test]
    fn a_page_whose_credential_cannot_be_renewed_leaves_every_write_unsent() {
        for error in [
            CoreError::SignedOut {
                origin: "https://marfa.example".into(),
            },
            CoreError::StorageFull("fixture disk full".into()),
        ] {
            let server = Scripted::start();
            let (_dir, core) = creating(&server, FLOOR + 1);
            server.on("/items/bulk", vec![scripted::refusal(401, "unauthorized")]);
            core.renew_credential_with(Box::new(move |_| Err(error.clone())));

            let drained = core.drain();

            assert_eq!(server.seen("/items/bulk").len(), 1, "{drained:?}");
            assert!(
                matches!(
                    &drained,
                    Err(CoreError::RenewalFailed(_))
                        | Ok(DrainReport {
                            unavailable: Some(_),
                            ..
                        })
                ),
                "{drained:?}"
            );
            let queued = core.queue().unwrap();
            assert_eq!(queued.len(), FLOOR + 1);
            let conn = core.conn().unwrap();
            // Witness: every row this checks is one the page carried.
            for row in &queued {
                assert!(store::unsent(&conn, &row.id).unwrap(), "{row:?}");
                assert_eq!((row.verdict, row.refusals), (None, 0));
            }
        }
    }

    /// `queue-and-verdicts/create-pages`: a write ahead of the creates, here
    /// an edit to the first, holds none of them out of the page.
    #[test]
    fn creates_queued_behind_a_write_that_is_not_a_create_go_in_a_page() {
        let server = Scripted::start();
        let (_dir, core) = creating(&server, FLOOR + 1);
        let first = core.queue().unwrap()[0].item_id.clone().unwrap();
        let mut edit = crate::model::Edit {
            base_version: Some(0),
            ..Default::default()
        };
        edit.properties.insert("title".into(), "Renamed".into());
        core.update_item(&first, &edit).unwrap();
        for at in 0..FLOOR {
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": format!("Later {at}") })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        }
        server.on(
            "/items/bulk",
            vec![scripted::refusal(400, "invalid_request")],
        );

        let _ = core.drain();

        let pages = server.seen("/items/bulk");
        assert_eq!(pages.len(), 1);
        let page: serde_json::Value = serde_json::from_slice(&pages[0].body).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 2 * FLOOR + 1);
    }

    /// A limited page says what the server did and for how long, and the
    /// drain keeps the wait.
    #[test]
    fn a_limited_page_says_the_server_is_limiting_requests_and_for_how_long() {
        let server = Scripted::start();
        let (_dir, core) = creating(&server, FLOOR + 1);
        server.on(
            "/items/bulk",
            vec![scripted::Answer::Json {
                status: 429,
                body: r#"{"error":{"code":"rate_limited","message":"scripted"}}"#.into(),
                headers: vec![("Retry-After".into(), "7".into())],
            }],
        );

        let drained = core.drain().unwrap();

        assert_eq!(
            drained.unavailable.as_deref(),
            Some("the server is limiting requests (429) and asked for a wait of 7s")
        );
        assert_eq!(drained.retry_after_seconds, Some(7));
        assert_eq!(server.seen("/items/bulk").len(), 1);
    }

    #[test]
    fn a_limited_page_leaves_the_tags_it_carried_unsent_and_unanswered() {
        let server = Scripted::start();
        let (_dir, core) = tagged(&server, FLOOR + 1, &["alpha", "beta"]);
        server.on(
            "/items/bulk",
            vec![scripted::Answer::Json {
                status: 429,
                body: r#"{"error":{"code":"rate_limited","message":"scripted"}}"#.into(),
                headers: vec![("Retry-After".into(), "7".into())],
            }],
        );

        let drained = core.drain().unwrap();

        assert!(drained.limited);
        let seen = server.seen("/items/bulk");
        let page: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(
            page["items"][0]["tags"],
            serde_json::json!(["alpha", "beta"])
        );
        let conn = core.conn().unwrap();
        let queue = store::queued_writes(&conn).unwrap();
        assert_eq!(queue.len(), (FLOOR + 1) * 3);
        for row in &queue {
            // A tag waits on its create, which a later pass clears.
            let waits = row.kind == WriteKind::AddTag && row.verdict == Some(Verdict::Blocked);
            assert!(row.verdict.is_none() || waits, "{row:?}");
            assert!(store::unsent(&conn, &row.id).unwrap(), "{row:?}");
        }
        assert!(server.seen("/items/").is_empty());
    }

    #[test]
    fn tags_behind_another_write_to_the_item_stay_on_their_own_doors() {
        let server = Scripted::start();
        let (_dir, core) = tagged(&server, FLOOR, &["alpha"]);
        let first = core.queue().unwrap()[0].item_id.clone().unwrap();
        core.remove_tag(&first, "alpha").unwrap();
        core.add_tag(&first, "beta").unwrap();
        let all = store::queued_writes(&core.conn().unwrap()).unwrap();
        let mut answers = all
            .iter()
            .map(|row| (row.id.clone(), row.verdict))
            .collect();
        let rows = all.iter().map(|row| (row.id.as_str(), row)).collect();
        let landing = store::pending_landings(&core.conn().unwrap()).unwrap();
        let found = candidates(
            &core,
            Lane::Items,
            &Standing {
                all: &all,
                rows: &rows,
                answers: &mut answers,
                landing: &landing,
            },
            None,
        )
        .unwrap()
        .ready;
        assert_eq!(found.len(), FLOOR);
        let carried: Vec<Vec<&str>> = found
            .iter()
            .map(|candidate| {
                candidate
                    .tags
                    .iter()
                    .filter_map(|row| tag_of(row))
                    .collect()
            })
            .collect();
        // The second tag is queued behind the removal of the first.
        assert_eq!(carried[0], vec!["alpha"]);
        assert!(carried[1..].iter().all(|tags| tags == &vec!["alpha"]));
    }

    fn edge_json(row: &QueuedWrite) -> serde_json::Value {
        serde_json::json!({
            "id": row.edge_id,
            "from_id": row.body["from_id"],
            "to_id": row.body["to_id"],
            "edge_type": "references",
            "properties": {},
            "version": 1,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        })
    }

    fn item_json(id: &str, edges: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "type": "core.note",
            "properties": {},
            "state": "active",
            "tier": "library",
            "version": 1,
            "schema_version": 1,
            "source": "test",
            "occurred_at": "2026-01-01T00:00:00Z",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "edges": edges,
        })
    }

    /// A host with `count` notes behind it, and an edge to each.
    fn linking(server: &Scripted, count: usize) -> (tempfile::TempDir, Core, Vec<QueuedWrite>) {
        let (dir, core) = creating(server, count + 1);
        let notes: Vec<String> = core
            .queue()
            .unwrap()
            .iter()
            .filter_map(|row| row.item_id.clone())
            .collect();
        let edges = notes[1..]
            .iter()
            .map(|to| {
                core.create_edge(&crate::model::EdgeDraft {
                    from_id: notes[0].clone(),
                    to_id: to.clone(),
                    edge_type: "references".into(),
                    ..Default::default()
                })
                .unwrap()
            })
            .collect();
        (dir, core, edges)
    }

    /// `queue-and-verdicts/page-read-back`: the first page of an item's
    /// edges of a type holds 50 at most (`edges/hydrate-cap`), and the rest
    /// of the listing is read from the cursor that page names.
    #[test]
    fn an_edge_past_the_first_page_of_its_hosts_edges_is_read_from_the_rest_of_the_listing() {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, 3);
        let host = edges[0].body["from_id"].as_str().unwrap().to_string();
        server.on(
            "/items/bulk-get",
            vec![scripted::certified(scripted::json(
                200,
                &serde_json::json!({
                    "data": [item_json(&host, serde_json::json!({
                        "references": { "data": [edge_json(&edges[0])], "next_cursor": "c1" }
                    }))],
                    "metadata": [{ "item_id": host, "tags": [] }],
                    "listed": [true],
                })
                .to_string(),
            ))],
        );
        server.on(
            &format!("/items/{host}/edges"),
            vec![
                scripted::certified(scripted::json(
                    200,
                    &serde_json::json!({ "data": [edge_json(&edges[1])], "next_cursor": "c2" })
                        .to_string(),
                )),
                scripted::certified(scripted::json(
                    200,
                    &serde_json::json!({ "data": [edge_json(&edges[2])], "next_cursor": null })
                        .to_string(),
                )),
            ],
        );
        let rows: Vec<&QueuedWrite> = edges.iter().collect();
        let (context, before) = capture(&core, Lane::Edges, &rows).unwrap();

        let held = read(&core, &AtomicBool::new(false), &context, Lane::Edges, &rows).unwrap();

        for row in &rows {
            assert!(
                found(Lane::Edges, row, &held, &context, &before).is_some(),
                "{row:?}"
            );
        }
        let listed = server.seen(&format!("/items/{host}/edges"));
        assert_eq!(listed.len(), 2);
        assert!(listed[0].query.contains("cursor=c1"), "{}", listed[0].query);
        assert!(listed[1].query.contains("cursor=c2"), "{}", listed[1].query);
    }

    /// Where the edge is not in a block that names no cursor, the server made
    /// none, and no listing is read.
    #[test]
    fn an_edge_a_whole_block_leaves_out_is_left_to_the_walk_with_no_listing_read() {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, 2);
        let host = edges[0].body["from_id"].as_str().unwrap().to_string();
        server.on(
            "/items/bulk-get",
            vec![scripted::certified(scripted::json(
                200,
                &serde_json::json!({
                    "data": [item_json(&host, serde_json::json!({
                        "references": { "data": [edge_json(&edges[0])], "next_cursor": null }
                    }))],
                    "metadata": [{ "item_id": host, "tags": [] }],
                    "listed": [true],
                })
                .to_string(),
            ))],
        );
        let rows: Vec<&QueuedWrite> = edges.iter().collect();
        let (context, before) = capture(&core, Lane::Edges, &rows).unwrap();

        let held = read(&core, &AtomicBool::new(false), &context, Lane::Edges, &rows).unwrap();

        assert!(found(Lane::Edges, rows[0], &held, &context, &before).is_some());
        assert!(found(Lane::Edges, rows[1], &held, &context, &before).is_none());
        assert!(server.seen(&format!("/items/{host}/edges")).is_empty());
    }

    /// An edge whose ends are creates the walk sends on their own doors is
    /// held for a pass after them, and none of the others is.
    #[test]
    fn edges_waiting_on_creates_the_walk_sends_are_deferred_where_nothing_follows_them() {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, FLOOR + 1);
        // An edit queued behind an edge's create: that edge stays on the walk.
        core.update_edge(
            edges[0].edge_id.as_deref().unwrap(),
            &crate::model::EdgeEdit {
                properties: serde_json::json!({ "note": "x" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        let all = store::queued_writes(&core.conn().unwrap()).unwrap();
        let mut answers = all
            .iter()
            .map(|row| (row.id.clone(), row.verdict))
            .collect();
        let rows = all.iter().map(|row| (row.id.as_str(), row)).collect();
        let landing = store::pending_landings(&core.conn().unwrap()).unwrap();
        let standing = Standing {
            all: &all,
            rows: &rows,
            answers: &mut answers,
            landing: &landing,
        };

        let led = led(&standing);
        let off = candidates(&core, Lane::Edges, &standing, None).unwrap();
        let on = candidates(&core, Lane::Edges, &standing, Some(&led)).unwrap();

        // The witness: the same rows are ready once their ends are answered.
        assert!(off.ready.is_empty() && off.deferrable.is_empty());
        assert_eq!(on.deferrable.len(), FLOOR);
        assert!(on.deferrable.iter().all(|row| row.id != edges[0].id));
        let ends: Vec<String> = all
            .iter()
            .filter(|row| row.kind == WriteKind::CreateItem)
            .map(|row| row.id.clone())
            .collect();
        for end in ends {
            standing.answers.insert(end, Some(Verdict::Accepted));
        }
        let answered = candidates(&core, Lane::Edges, &standing, Some(&led)).unwrap();
        assert_eq!(answered.ready.len(), FLOOR + 1);
        assert!(answered.deferrable.is_empty());
    }

    /// The edges deferred for the pass after, and the edges the later writes lead,
    /// where a note that is no end of any edge is then removed by `remove`.
    fn deferred_after(remove: impl FnOnce(&Core, &str)) -> (usize, usize) {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, FLOOR + 5);
        core.create_item(&Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "Parent", "body": "text" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap();
        let parent = core
            .queue()
            .unwrap()
            .last()
            .and_then(|row| row.item_id.clone())
            .unwrap();
        remove(&core, &parent);
        let all = store::queued_writes(&core.conn().unwrap()).unwrap();
        let mut answers = all
            .iter()
            .map(|row| (row.id.clone(), row.verdict))
            .collect();
        let rows = all.iter().map(|row| (row.id.as_str(), row)).collect();
        let landing = store::pending_landings(&core.conn().unwrap()).unwrap();
        let standing = Standing {
            all: &all,
            rows: &rows,
            answers: &mut answers,
            landing: &landing,
        };
        let led = led(&standing);
        let found = candidates(&core, Lane::Edges, &standing, Some(&led)).unwrap();
        let leading = edges
            .iter()
            .filter(|row| led.contains(row.id.as_str()))
            .count();
        (found.deferrable.len(), leading)
    }

    /// A delete, or a transition into the bin, of an item that no edge names
    /// can still take an end of an edge into the bin, through a cascading
    /// edge, so that an edge create queued ahead of it must reach the server
    /// before it: none of them is deferred.
    #[test]
    fn a_later_delete_or_trash_of_any_item_leads_every_edge_create_before_it() {
        // The witness: a later write that neither deletes nor trashes leads none.
        let edges = FLOOR + 5;
        assert_eq!(deferred_after(|_, _| {}), (edges, 0));
        assert_eq!(
            deferred_after(|core, parent| {
                core.transition_item(parent, ItemState::Archived).unwrap();
            }),
            (edges, 0)
        );
        assert_eq!(
            deferred_after(|core, parent| {
                core.delete_item(parent).unwrap();
            }),
            (0, edges)
        );
        assert_eq!(
            deferred_after(|core, parent| {
                core.transition_item(parent, ItemState::Trashed).unwrap();
            }),
            (0, edges)
        );
    }

    /// What `hold_back` does with `total` edges from one host, `ready` of
    /// them with both ends answered and an edit queued behind each of those
    /// in `edited`: how many it holds for the pass after, and how many it
    /// leaves on the walk's side of the pass.
    fn held(total: usize, ready: usize, edited: &[usize]) -> (usize, usize) {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, total);
        for at in edited {
            core.update_edge(
                edges[*at].edge_id.as_deref().unwrap(),
                &crate::model::EdgeEdit {
                    properties: serde_json::json!({ "note": "x" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(0),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let all = store::queued_writes(&core.conn().unwrap()).unwrap();
        let mut answers: HashMap<String, Option<Verdict>> = all
            .iter()
            .map(|row| (row.id.clone(), row.verdict))
            .collect();
        let creates: Vec<&QueuedWrite> = all
            .iter()
            .filter(|row| row.kind == WriteKind::CreateItem)
            .collect();
        // The host, then the ends of the first `ready` edges.
        for create in creates.iter().take(ready + 1) {
            answers.insert(create.id.clone(), Some(Verdict::Accepted));
        }
        let rows = all.iter().map(|row| (row.id.as_str(), row)).collect();
        let landing = store::pending_landings(&core.conn().unwrap()).unwrap();
        let standing = Standing {
            all: &all,
            rows: &rows,
            answers: &mut answers,
            landing: &landing,
        };
        let led = led(&standing);
        let Found {
            ready: mut waiting,
            deferrable,
        } = candidates(&core, Lane::Edges, &standing, Some(&led)).unwrap();
        assert_eq!(waiting.len(), ready);
        let held = hold_back(&mut waiting, &deferrable, &led);
        for edit in edited {
            let edge = edges[*edit].id.as_str();
            assert!(!held.contains(edge), "an edge with an edit behind it");
        }
        (held.len(), waiting.len())
    }

    /// An edge with a write behind it is never held for the pass after, ready
    /// or not, and the rest are held only where they make a page then.
    #[test]
    fn ready_edges_are_held_back_only_where_nothing_follows_them_and_a_page_forms() {
        // The witness: with no edit behind any, all of them are held.
        assert_eq!(held(FLOOR + 2, 4, &[]), (FLOOR + 2, 0));
        // An edit behind a ready edge keeps that edge on the walk.
        assert_eq!(held(FLOOR + 2, 4, &[0]), (FLOOR + 1, 1));
        // Three of them leave 49 for the pass after, which makes no page.
        assert_eq!(held(FLOOR + 2, 4, &[0, 1, 2]), (0, 4));
        // Few enough that the pass after would send each alone.
        assert_eq!(held(FLOOR - 2, 3, &[]), (0, 3));
        // A page of ready edges goes now, and the few held would not make one.
        assert_eq!(held(FLOOR + 10, FLOOR, &[]), (0, FLOOR));
        // Where they would, they are held.
        assert_eq!(held(2 * FLOOR, FLOOR, &[]), (FLOOR, FLOOR));
    }

    /// The edges a later write names, by either end or by itself, and not by
    /// a sibling link from the same item.
    #[test]
    fn an_edge_is_led_by_a_later_write_that_names_it_or_an_end_and_not_by_a_sibling() {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, 3);
        let ends: Vec<String> = edges
            .iter()
            .map(|row| row.body["to_id"].as_str().unwrap().to_string())
            .collect();
        let led_after = |core: &Core| -> Vec<bool> {
            let all = store::queued_writes(&core.conn().unwrap()).unwrap();
            let mut answers = all
                .iter()
                .map(|row| (row.id.clone(), row.verdict))
                .collect();
            let rows = all.iter().map(|row| (row.id.as_str(), row)).collect();
            let landing = store::pending_landings(&core.conn().unwrap()).unwrap();
            let led = led(&Standing {
                all: &all,
                rows: &rows,
                answers: &mut answers,
                landing: &landing,
            });
            edges
                .iter()
                .map(|row| led.contains(row.id.as_str()))
                .collect()
        };
        // The witness: each edge names the host, and the later ones do not
        // lead the earlier.
        assert_eq!(led_after(&core), vec![false, false, false]);

        let mut edit = crate::model::Edit {
            base_version: Some(0),
            ..Default::default()
        };
        edit.properties.insert("title".into(), "Renamed".into());
        core.update_item(&ends[1], &edit).unwrap();
        assert_eq!(led_after(&core), vec![false, true, false]);

        // A delete leads every edge queued before it, whichever item it names.
        core.delete_item(&ends[2]).unwrap();
        assert_eq!(led_after(&core), vec![true, true, true]);
    }

    /// A read of the three edges from one host, whose first page of edges
    /// holds the first and names a cursor, with `listing` the answers to the
    /// reads of the rest.
    struct Listed {
        held: Result<Held>,
        edges: Vec<QueuedWrite>,
        /// The requests for the listing the read sent.
        asked: usize,
        context: reach::Context,
        before: HashMap<String, Option<store::Stamp>>,
        _core: Core,
        _dir: tempfile::TempDir,
    }

    impl Listed {
        fn finds(&self, at: usize) -> bool {
            let held = self.held.as_ref().unwrap();
            found(
                Lane::Edges,
                &self.edges[at],
                held,
                &self.context,
                &self.before,
            )
            .is_some()
        }
    }

    /// The host that serves the listing of `edges`.
    fn host_of(server: &Scripted, edges: &[QueuedWrite]) -> String {
        let host = edges[0].body["from_id"].as_str().unwrap().to_string();
        server.on(
            "/items/bulk-get",
            vec![scripted::certified(scripted::json(
                200,
                &serde_json::json!({
                    "data": [item_json(&host, serde_json::json!({
                        "references": { "data": [edge_json(&edges[0])], "next_cursor": "p0" }
                    }))],
                    "metadata": [{ "item_id": host, "tags": [] }],
                    "listed": [true],
                })
                .to_string(),
            ))],
        );
        host
    }

    fn read_listing(listing: impl FnOnce(&[QueuedWrite]) -> Vec<scripted::Answer>) -> Listed {
        let server = Scripted::start();
        let (dir, core, edges) = linking(&server, 3);
        let host = host_of(&server, &edges);
        server.on(&format!("/items/{host}/edges"), listing(&edges));
        let rows: Vec<&QueuedWrite> = edges.iter().collect();
        let (context, before) = capture(&core, Lane::Edges, &rows).unwrap();
        let held = read(&core, &AtomicBool::new(false), &context, Lane::Edges, &rows);
        let asked = server.seen(&format!("/items/{host}/edges")).len();
        Listed {
            held,
            edges,
            asked,
            context,
            before,
            _core: core,
            _dir: dir,
        }
    }

    fn listing_page(at: usize, data: Vec<serde_json::Value>) -> scripted::Answer {
        scripted::certified(scripted::json(
            200,
            &serde_json::json!({ "data": data, "next_cursor": format!("p{at}") }).to_string(),
        ))
    }

    #[test]
    fn a_stop_ends_the_read_of_a_listing_while_a_page_of_it_waits() {
        let server = Scripted::start();
        let (_dir, core, edges) = linking(&server, 3);
        let host = host_of(&server, &edges);
        let listing = format!("/items/{host}/edges");
        server.on(
            &listing,
            vec![scripted::Answer::WaitFor {
                ready: std::sync::Arc::new(AtomicBool::new(false)),
                answer: Box::new(listing_page(1, vec![edge_json(&edges[1])])),
            }],
        );
        let rows: Vec<&QueuedWrite> = edges.iter().collect();
        let (context, _) = capture(&core, Lane::Edges, &rows).unwrap();
        let stop = AtomicBool::new(false);
        let ended = std::thread::scope(|scope| {
            scope.spawn(|| {
                server.wait_for(&listing, 1, std::time::Duration::from_secs(2));
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            });
            read(&core, &stop, &context, Lane::Edges, &rows)
        });
        assert_eq!(ended.err(), Some(CoreError::Canceled));
    }

    /// A listing that never ends is read for `LISTING_PAGES` pages, and an
    /// edge past them is left to the walk, to be sent alone and answered as
    /// the repeat it is.
    #[test]
    fn a_listing_is_read_for_twenty_pages_and_an_edge_past_them_is_left_to_the_walk() {
        let read = read_listing(|edges| {
            (1..=LISTING_PAGES + 5)
                .map(|at| {
                    let data = match at {
                        LISTING_PAGES => vec![edge_json(&edges[1])],
                        _ if at == LISTING_PAGES + 1 => vec![edge_json(&edges[2])],
                        _ => Vec::new(),
                    };
                    listing_page(at, data)
                })
                .collect()
        });

        assert!(read.held.is_ok());
        assert_eq!(read.asked, LISTING_PAGES);
        // The witness: the edge on the last page read is found.
        assert!(read.finds(0) && read.finds(1));
        assert!(!read.finds(2));
    }

    /// A refused listing is no failure of the drain: the edge it did not
    /// bring is left to the walk.
    #[test]
    fn a_listing_the_server_refuses_leaves_the_edges_it_did_not_bring_to_the_walk() {
        let refused = read_listing(|_| {
            vec![scripted::certified(scripted::refusal(
                404,
                "item_not_found",
            ))]
        });
        assert!(refused.held.is_ok(), "{:?}", refused.held.as_ref().err());
        assert_eq!(refused.asked, 1);
        assert!(refused.finds(0));
        assert!(!refused.finds(1) && !refused.finds(2));

        // The witness: the same listing, answered, brings them.
        let answered = read_listing(|edges| {
            vec![listing_page(
                1,
                vec![edge_json(&edges[1]), edge_json(&edges[2])],
            )]
        });
        assert!(answered.finds(1) && answered.finds(2));

        // An environmental failure is the drain's own.
        let failing =
            read_listing(|_| vec![scripted::certified(scripted::refusal(503, "unavailable"))]);
        assert!(failing.held.is_err());
    }
}
