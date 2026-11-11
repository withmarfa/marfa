//! An atomic page is one transaction, so a refused last entry undoes the first; a best-effort
//! page is one transaction too, with a savepoint per entry.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Transaction;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::write::{self, Change, Put};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::faults::{FAIL_AUDIT, Faults, HOLD_BULK_PAGE};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::unit::Unit;
use crate::db::{Pulse, io_refusal};
use crate::settings::registry::MAX_BULK_REQUEST_BYTES;

impl App {
    /// The largest body the bulk write operations take, and so the largest row a restore takes.
    pub fn bulk_cap(&self) -> usize {
        usize::try_from(self.settings.live().get(MAX_BULK_REQUEST_BYTES)).unwrap_or(usize::MAX)
    }
}

const UNKNOWN_OUTCOME: &str = "The entry may have been written, but its commit could not be \
                               confirmed. Read its current state before retrying this entry; do \
                               not resend the whole page.";
const NOT_WRITTEN: &str = "The entry could not be written, and nothing of it was";
const ACTION: &str = "items.bulk";

#[derive(Debug)]
pub struct Entry {
    pub put: Put,
    pub replace: bool,
}

#[derive(Debug)]
pub struct Asked {
    pub entries: Vec<Result<Entry>>,
    pub mode: &'static str,
    pub atomic: bool,
    pub retype: bool,
    pub fanout: bool,
}

pub struct Page {
    pub entries: Vec<Result<Entry>>,
    pub mode: &'static str,
    pub retype: bool,
    pub fanout: bool,
    pub operation: String,
    pub pulse: Pulse,
    pub faults: Arc<Faults>,
}

impl std::fmt::Debug for Page {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Page")
            .field("operation", &self.operation)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct Note {
    pub index: usize,
    pub total: usize,
    pub mode: &'static str,
    pub retype: bool,
    pub fanout: bool,
    pub operation: String,
}

pub enum Entered {
    Created(String),
    Updated(String),
    Skipped {
        id: Option<String>,
        reason: &'static str,
    },
}

impl Entered {
    pub fn outcome(&self) -> &'static str {
        match self {
            Entered::Created(_) => "created",
            Entered::Updated(_) => "updated",
            Entered::Skipped { .. } => "skipped",
        }
    }

    pub fn written(&self) -> Option<&str> {
        match self {
            Entered::Created(id) | Entered::Updated(id) => Some(id),
            Entered::Skipped { .. } => None,
        }
    }

    pub fn answered(&self, index: usize) -> Value {
        let mut answer = json!({ "index": index, "outcome": self.outcome() });
        match self {
            Entered::Created(id) | Entered::Updated(id) => answer["id"] = json!(id),
            Entered::Skipped { id, reason } => {
                if let Some(id) = id {
                    answer["id"] = json!(id);
                }
                answer["reason"] = json!(reason);
            }
        }
        answer
    }
}

#[derive(Debug, Default, Serialize)]
pub struct Counts {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errored: usize,
}

impl Counts {
    pub fn add(&mut self, outcome: &str) {
        match outcome {
            "created" => self.created += 1,
            "updated" => self.updated += 1,
            "skipped" => self.skipped += 1,
            _ => self.errored += 1,
        }
    }
}

/// A fault is no verdict on an entry, and answers as it is.
pub fn rollback(index: usize, refused: &Refusal) -> Refusal {
    let status = refused.code.status();
    if status >= 500 {
        return refused.clone();
    }
    let rolled_back = Refusal::new(
        Code::BulkAtomicRollback { status },
        format!("Bulk upsert rolled back on item {index}"),
    )
    .with_detail("index", index)
    .with_detail("code", refused.code.wire())
    .with_detail("message", refused.message.as_ref());
    match &refused.details {
        Some(details) => rolled_back.with_detail("details", Value::Object((**details).clone())),
        None => rolled_back,
    }
}

fn errored(index: usize, id: Option<&str>, error: Value) -> Value {
    let mut answer = json!({ "index": index, "outcome": "errored" });
    if let Some(id) = id {
        answer["id"] = json!(id);
    }
    answer["error"] = error;
    answer
}

fn error_of(refusal: &Refusal) -> Value {
    let mut error = json!({ "code": refusal.code.wire(), "message": refusal.message });
    if let Some(details) = &refusal.details {
        error["details"] = Value::Object((**details).clone());
    }
    error
}

/// Before anything has landed, what is no verdict on the entry answers for the whole page.
fn refused_entry(index: usize, refusal: &Refusal, landed: bool) -> Result<Value> {
    let verdict = refusal.code.status() < 500 && refusal.code != Code::Unauthorized;
    if verdict {
        return Ok(errored(index, refusal.row.as_deref(), error_of(refusal)));
    }
    if !landed {
        return Err(refusal.clone());
    }
    if refusal.code == Code::InternalError {
        let error = json!({ "code": refusal.code.wire(), "message": NOT_WRITTEN });
        return Ok(errored(index, None, error));
    }
    Ok(errored(index, None, error_of(refusal)))
}

pub async fn write(app: &App, caller: &Caller, asked: Asked) -> Result<String> {
    let Asked {
        entries,
        mode,
        atomic,
        retype,
        fanout,
    } = asked;
    if entries.is_empty() {
        return Ok(json!({ "counts": Counts::default(), "results": [] }).to_string());
    }
    let operation = Uuid::now_v7().to_string();
    let pulse = app.db.pulse();
    let faults = app.faults.clone();
    if atomic {
        let page = Page {
            entries,
            mode,
            retype,
            fanout,
            operation,
            pulse,
            faults,
        };
        let done = write::run(app, caller, None, Change::Page(Box::new(page))).await?;
        return Ok(done.body);
    }
    let cache = app.catalog_handle();
    let total = entries.len();
    best_effort(app, caller, ACTION, move |unit| {
        each(
            unit.tx(),
            ACTION,
            &faults,
            &pulse,
            entries,
            |index, entry| {
                let note = Note {
                    index,
                    total,
                    mode,
                    retype,
                    fanout,
                    operation: operation.clone(),
                };
                let entry = Box::new(entry);
                let done = write::apply(unit, &cache, None, Change::Entry { entry, note })?;
                serde_json::from_str(&done.body)
                    .map_err(|_| Refusal::internal("an entry's answer did not read"))
            },
        )
    })
    .await
}

/// Kept outside the transaction, so a failed commit can still answer for each entry.
#[derive(Default)]
pub(crate) struct Answer {
    counts: Counts,
    results: Vec<Value>,
}

impl Answer {
    fn body(&self) -> String {
        json!({ "counts": self.counts, "results": self.results }).to_string()
    }

    /// Each entry that landed may or may not have survived the commit.
    fn unconfirmed(mut self) -> Answer {
        let unknown = json!({
            "code": Code::InternalError.wire(),
            "message": UNKNOWN_OUTCOME,
            "details": { "write_outcome": "unknown" },
        });
        for result in &mut self.results {
            let outcome = result["outcome"].as_str().unwrap_or_default();
            match outcome {
                "created" => self.counts.created -= 1,
                "updated" => self.counts.updated -= 1,
                _ => continue,
            }
            self.counts.errored += 1;
            result["outcome"] = json!("errored");
            result["error"] = unknown.clone();
        }
        self
    }
}

/// One transaction for the page, so nothing of it is read, streamed or sent before it is durable.
pub(crate) async fn best_effort<F>(
    app: &App,
    caller: &Caller,
    action: &'static str,
    job: F,
) -> Result<String>
where
    F: FnOnce(&Unit<'_, '_>) -> Result<Answer> + Send + 'static,
{
    let held: Arc<Mutex<Option<Answer>>> = Arc::default();
    let kept = held.clone();
    let written = app
        .write(caller, action, move |unit| {
            let answer = job(unit)?;
            *kept.lock().unwrap_or_else(PoisonError::into_inner) = Some(answer);
            Ok(())
        })
        .await;
    let answer = held.lock().unwrap_or_else(PoisonError::into_inner).take();
    match (written, answer) {
        (Ok(()), Some(answer)) => Ok(answer.body()),
        (Err(refusal), Some(answer)) if refusal.commit_failed => Ok(answer.unconfirmed().body()),
        (Err(refusal), _) => Err(refusal),
        (Ok(()), None) => Err(Refusal::internal("a page's answer was lost")),
    }
}

/// Writes each entry under a savepoint of its own, so a refused entry leaves the others.
pub(crate) fn each<E>(
    tx: &Transaction<'_>,
    action: &'static str,
    faults: &Faults,
    pulse: &Pulse,
    entries: Vec<Result<E>>,
    mut write: impl FnMut(usize, E) -> Result<Value>,
) -> Result<Answer> {
    let mut answer = Answer::default();
    let mut landed = false;
    for (index, entry) in entries.into_iter().enumerate() {
        faults.hold_beating(HOLD_BULK_PAGE, pulse);
        let result = match entry {
            Err(refusal) => refused_entry(index, &refusal, landed)?,
            Ok(entry) => {
                tx.execute_batch("SAVEPOINT entry")?;
                let written = write(index, entry).and_then(|result| {
                    if faults.fail(FAIL_AUDIT, Some(action)) {
                        Err(io_refusal())
                    } else {
                        Ok(result)
                    }
                });
                match written {
                    Ok(result) => {
                        tx.execute_batch("RELEASE entry")?;
                        result
                    }
                    // Rolled back whole, or a file that cannot be trusted with the rest of it.
                    Err(refusal) if tx.is_autocommit() || refusal.is_damage() => {
                        return Err(refusal);
                    }
                    Err(refusal) => {
                        tx.execute_batch("ROLLBACK TO entry; RELEASE entry")?;
                        refused_entry(index, &refusal, landed)?
                    }
                }
            }
        };
        pulse.tick();
        let outcome = result["outcome"].as_str().unwrap_or_default();
        answer.counts.add(outcome);
        landed |= matches!(outcome, "created" | "updated");
        answer.results.push(result);
    }
    Ok(answer)
}
