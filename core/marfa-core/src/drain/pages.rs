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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

use serde::Deserialize;

use super::{
    Bin, Classified, DrainReport, ReadBack, Readiness, Settled, Shape, Unreadable, ViewChange,
    apply_read_back, classify, committed, ends_the_drain, failure_of, not_the_writes,
    park_for_credential, put_verdict, rate_limited, read_owed, readiness, receipt_key,
    same_attempt, settle_success, store_fault, unavailable, unavailable_by, verdict_of, waited,
};
use crate::error::CoreError;
use crate::http::{Answer, BULK_GET_LIMIT, Http, INSTANCE_CHANGED, REQUEST_LIMIT};
use crate::model::{QueuedWrite, Subject, Verdict, WriteKind};
use crate::wire::{WireEdge, WireItemWithMetadata};
use crate::{Core, Result};
use crate::{read_view, store, telemetry};

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
const ITEM_KEYS: &[&str] = &[
    "id",
    "type",
    "properties",
    "tier",
    "occurred_at",
    "source",
    "tags",
];
const EDGE_KEYS: &[&str] = &["id", "source_id", "target_id", "edge_type", "properties"];

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
                .get("source_id")
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
pub(super) fn send(
    sender: &Sender<'_>,
    pass: &mut ViewChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    confirm: &mut dyn FnMut(&mut DrainReport) -> Result<bool>,
) -> Result<()> {
    for lane in [Lane::Items, Lane::Edges] {
        if report.unavailable.is_some() || pass.changed() {
            return Ok(());
        }
        let waiting = candidates(sender.core, lane, standing)?;
        if waiting.len() < FLOOR || !confirm(report)? {
            continue;
        }
        for page in pages(&waiting) {
            crate::catch_up::refuse_if_stopped(sender.stop)?;
            if report.unavailable.is_some() {
                return Ok(());
            }
            if !send_page(sender, pass, report, standing, lane, &page)? {
                // The server would not take the page whole: what is left goes
                // on its own doors.
                return Ok(());
            }
        }
    }
    Ok(())
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
/// A page goes before the walk, so it stops at the first unanswered write
/// that is not a create: everything behind that write goes after it, as the
/// queue's order says (`queue-and-verdicts/queue-sends-in-order`).
fn candidates<'a>(
    core: &Core,
    lane: Lane,
    standing: &Standing<'a, '_>,
) -> Result<Vec<(&'a QueuedWrite, usize)>> {
    let conn = core.conn()?;
    let none = HashSet::new();
    let mut found = Vec::new();
    for row in standing.all {
        let unanswered = standing
            .answers
            .get(&row.id)
            .is_some_and(|verdict| verdict.is_none());
        if !matches!(row.kind, WriteKind::CreateItem | WriteKind::CreateEdge) && unanswered {
            break;
        }
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
        if !matches!(
            readiness(
                row,
                standing.rows,
                &*standing.answers,
                &none,
                standing.landing
            ),
            Readiness::Ready
        ) || crate::body::rule::lost_body(&conn, row)?.is_some()
        {
            continue;
        }
        found.push((row, size));
    }
    Ok(found)
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
fn pages<'a>(waiting: &[(&'a QueuedWrite, usize)]) -> Vec<Vec<&'a QueuedWrite>> {
    let mut pages = Vec::new();
    let mut page = Vec::new();
    let mut bytes = 0;
    for &(row, size) in waiting {
        let size = size + 1;
        if !page.is_empty() && (page.len() == ENTRIES || bytes + size > BYTES) {
            pages.push(std::mem::take(&mut page));
            bytes = 0;
        }
        bytes += size;
        page.push(row);
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
    pass: &mut ViewChange,
    report: &mut DrainReport,
    standing: &mut Standing<'_, '_>,
    lane: Lane,
    page: &[&QueuedWrite],
) -> Result<bool> {
    // Checked and marked sent in one transaction: a write changed since the
    // pass read the queue is left to the walk, which reads it again.
    let Sender {
        core,
        http,
        generation,
        stop,
    } = *sender;
    let (sent, payloads) = {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        let mut sent = Vec::with_capacity(page.len());
        let mut payloads = Vec::with_capacity(page.len());
        for row in page {
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
            let payload: serde_json::Value = serde_json::from_str(&sent_as)?;
            if !fits(lane, &now, &payload, sent_as.len()) {
                continue;
            }
            store::mark_sent(&tx, &now.id)?;
            payloads.push(payload);
            sent.push(now);
        }
        tx.commit()?;
        (sent, payloads)
    };
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
        for row in &sent {
            store::mark_unsent(&tx, &row.id)?;
        }
        tx.commit()?;
    }
    let answer = match answer {
        // Another instance took none of the page, so each write is judged
        // there afresh, as one on its own door is.
        Err(CoreError::CopyExpired { reason }) if reason == INSTANCE_CHANGED => {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            for row in &sent {
                store::mark_unsent(&tx, &row.id)?;
            }
            let error = crate::catch_up::expire_for_another_instance(&tx, generation)?;
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
                for row in &sent {
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
            return Ok(true);
        }
        // A write sent on its own door would meet the same refusal, under a
        // key that then keeps it out of every later page.
        Classified::BlockQueue(_) => {
            park_for_credential(core, report)?;
            return Ok(false);
        }
        _ => return Ok(false),
    }
    let Some(created) = created(lane, &sent, answer.as_ref().ok()) else {
        return Ok(false);
    };
    settle(core, stop, pass, report, standing, lane, &created)?;
    Ok(true)
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
) -> Result<(read_view::Context, HashMap<String, Option<store::Stamp>>)> {
    let conn = core.conn()?;
    let context = read_view::Context::capture(&conn)?;
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
    context: &read_view::Context,
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
        for (row, whole) in reader.items_by_id_whole(ids)? {
            held.insert(row.item.id.clone(), (row, whole));
        }
    }
    Ok(held)
}

/// The write's row as the reads found it, as a write's answer and as its
/// read-back. `None` where the reads did not find it.
fn found(
    lane: Lane,
    row: &QueuedWrite,
    held: &Held,
    context: &read_view::Context,
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
    pass: &mut ViewChange,
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
            waited(report, error.retry_after().map(|wait| wait.as_secs()));
            return Ok(());
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
        settle_one(core, pass, report, standing, lane, row, found)?;
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
    pass: &mut ViewChange,
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
                    None => match alone(core, pass, lane, row) {
                        Ok(read) => read,
                        Err(error) if error.is_environmental() => {
                            telemetry::degraded!(&error);
                            return Ok(Some(Unreadable {
                                reason: unavailable_by(&error).unwrap_or_else(|| error.to_string()),
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
                settle_success(core, row, &answer, lane.shape(), pass, false, Some(read))?;
            }
            // Each round settles at least one write, or the copy changed
            // under every read and the pass ends.
            if again.len() == left.len() {
                return Ok(Some(Unreadable {
                    reason: "the copy changed while the writes a page created were read back"
                        .into(),
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
    pass: &mut ViewChange,
    lane: Lane,
    row: &QueuedWrite,
) -> Result<Option<(serde_json::Value, ReadBack)>> {
    let Some(owed) = store::owed_of(&*core.conn()?, row)? else {
        store::meta_delete(&*core.conn()?, &receipt_key(&row.id))?;
        return Ok(None);
    };
    let read = read_owed(core, &owed, Bin::Held, pass, false)?;
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

/// The edge as the source item's first page of its edges of the type holds
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

fn settle_one(
    core: &Core,
    pass: &mut ViewChange,
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
    let settled = match settle_success(core, row, &answer, shape, pass, true, Some(read)) {
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
            store::meta_set(&conn, read_view::FENCE, &"a".repeat(64)).unwrap();
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
}
