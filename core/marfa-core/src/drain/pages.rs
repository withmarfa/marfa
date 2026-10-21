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
    Classified, DrainReport, ReadBack, Readiness, Shape, ViewChange, classify, committed,
    ends_the_drain, failure_of, not_the_writes, put_verdict, rate_limited, readiness,
    settle_success, store_fault, unavailable, unavailable_by, verdict_of, waited,
};
use crate::error::CoreError;
use crate::http::{Answer, BULK_GET_LIMIT, Http, INSTANCE_CHANGED};
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
        for page in pages(sender.core, &waiting)? {
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

/// The creates the walk would send unchanged, in queue order: never sent,
/// so a page is the first attempt and every later one goes on its own door
/// under its key (`queue-and-verdicts/page-never-sent`); each naming the id
/// it minted, the only thing a page settles by; ready now; and with nothing
/// about them the walk decides on a write's own answer.
fn candidates<'a>(
    core: &Core,
    lane: Lane,
    standing: &Standing<'a, '_>,
) -> Result<Vec<&'a QueuedWrite>> {
    let conn = core.conn()?;
    let none = HashSet::new();
    let mut found = Vec::new();
    for row in standing.all {
        if row.kind != lane.kind()
            || standing
                .answers
                .get(&row.id)
                .is_none_or(|verdict| verdict.is_some())
            || row.follows.is_some()
            || row.environmental_streak != 0
            || store_fault(row).is_some()
            || !fits(lane, row, &row.body)
            || !store::unsent(&conn, &row.id)?
        {
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
        found.push(row);
    }
    Ok(found)
}

fn fits(lane: Lane, row: &QueuedWrite, body: &serde_json::Value) -> bool {
    let Some(object) = body.as_object() else {
        return false;
    };
    object.keys().all(|key| lane.keys().contains(&key.as_str()))
        && object.get("id").and_then(serde_json::Value::as_str) == lane.minted(row)
        && lane.minted(row).is_some()
}

/// The creates split into pages by count and by the bytes they send.
fn pages<'a>(core: &Core, waiting: &[&'a QueuedWrite]) -> Result<Vec<Vec<&'a QueuedWrite>>> {
    let conn = core.conn()?;
    let mut pages = Vec::new();
    let mut page = Vec::new();
    let mut bytes = 0;
    for row in waiting {
        let size = store::payload_of(&conn, &row.id)?.len() + 1;
        if !page.is_empty() && (page.len() == ENTRIES || bytes + size > BYTES) {
            pages.push(std::mem::take(&mut page));
            bytes = 0;
        }
        bytes += size;
        page.push(*row);
    }
    if !page.is_empty() {
        pages.push(page);
    }
    Ok(pages)
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
/// the rest of the pass goes on the walk.
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
            let payload: serde_json::Value =
                serde_json::from_str(&store::payload_of(&tx, &now.id)?)?;
            if !fits(lane, &now, &payload) {
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
            // A request the server limited was not taken, so the page goes
            // out again as a first attempt.
            if rate_limited(&answer) {
                for row in &sent {
                    store::mark_unsent(&conn, &row.id)?;
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
        _ => return Ok(false),
    }
    let Some(created) = created(lane, &sent, answer.as_ref().ok()) else {
        return Ok(false);
    };
    settle(core, stop, pass, report, standing, lane, &created)?;
    Ok(true)
}

/// The writes the page created under the ids they minted. `None` where the
/// answer does not say, entry by entry, what the page did.
fn created<'a>(
    lane: Lane,
    sent: &'a [QueuedWrite],
    answer: Option<&Answer>,
) -> Option<Vec<&'a QueuedWrite>> {
    let parsed = serde_json::from_str::<PageAnswer>(&answer?.body).ok()?;
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
            created.push(row);
        }
    }
    Some(created)
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
    created: &[&QueuedWrite],
) -> Result<()> {
    let sources: Vec<String> = {
        let mut seen = HashSet::new();
        created
            .iter()
            .filter_map(|row| match lane {
                Lane::Items => row.item_id.clone(),
                Lane::Edges => row
                    .body
                    .get("source_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
            .filter(|id| seen.insert(id.clone()))
            .collect()
    };
    let subject = match lane {
        Lane::Items => Subject::Item,
        Lane::Edges => Subject::Edge,
    };
    let (context, before) = {
        let conn = core.conn()?;
        let context = read_view::Context::capture(&conn)?;
        let mut before = HashMap::new();
        for row in created {
            if let Some(id) = lane.minted(row) {
                before.insert(id.to_string(), store::stamp(&conn, subject, id)?);
            }
        }
        (context, before)
    };
    let reader = context.http(core.http()?);
    let mut held: HashMap<String, (WireItemWithMetadata, serde_json::Value)> = HashMap::new();
    for ids in sources.chunks(BULK_GET_LIMIT) {
        crate::catch_up::refuse_if_stopped(stop)?;
        match reader.items_by_id_whole(ids) {
            Ok(rows) => {
                for (row, whole) in rows {
                    held.insert(row.item.id.clone(), (row, whole));
                }
            }
            // Nothing is settled yet, so each write waits, sent, for the
            // next pass, which sends it on its own door under its key.
            Err(error) if error.is_environmental() => {
                telemetry::degraded!(&error);
                report.unavailable = unavailable_by(&error).or_else(|| Some(error.to_string()));
                waited(report, error.retry_after().map(|wait| wait.as_secs()));
                return Ok(());
            }
            Err(error) => return Err(context.failed(core, error)?),
        }
    }
    for row in created {
        let Some(id) = lane.minted(row) else {
            continue;
        };
        let found = match lane {
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
                        before: before.get(id).cloned().flatten(),
                    },
                )
            }),
            Lane::Edges => row
                .body
                .get("source_id")
                .and_then(serde_json::Value::as_str)
                .and_then(|source| held.get(source))
                .and_then(|(_, whole)| edge_in(whole, row, id))
                .map(|(edge, whole)| {
                    (
                        serde_json::json!({ "edge": whole }),
                        ReadBack::Edge {
                            context: context.clone(),
                            id: id.to_string(),
                            held: Some(Box::new(edge)),
                            before: before.get(id).cloned().flatten(),
                        },
                    )
                }),
        };
        let Some((body, read)) = found else {
            continue;
        };
        // An earlier write's settling can have changed the copy the read was
        // made against; this one then goes on its own door.
        if context.check(&*core.conn()?).is_err() {
            continue;
        }
        settle_one(core, pass, report, standing, lane, row, (body, read))?;
    }
    Ok(())
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
    let shape = match lane {
        Lane::Items => Shape::Item,
        Lane::Edges => Shape::Edge,
    };
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
