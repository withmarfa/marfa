//! An atomic page is one transaction, so a refused last entry undoes the first; a best-effort
//! page is one transaction per entry.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::write::{self, Change, Put};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::faults::{Faults, HOLD_BULK_PAGE};
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::Pulse;
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
pub(crate) fn refused_entry(index: usize, refusal: &Refusal, landed: bool) -> Result<Value> {
    if refusal.commit_failed {
        let error = json!({
            "code": Code::InternalError.wire(),
            "message": UNKNOWN_OUTCOME,
            "details": { "write_outcome": "unknown" },
        });
        return Ok(errored(index, None, error));
    }
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
    if atomic {
        let page = Page {
            entries,
            mode,
            retype,
            fanout,
            operation,
            pulse: app.db.pulse(),
            faults: app.faults.clone(),
        };
        let done = write::run(app, caller, None, Change::Page(Box::new(page))).await?;
        return Ok(done.body);
    }
    let total = entries.len();
    let mut counts = Counts::default();
    let mut results = Vec::with_capacity(total);
    let mut landed = false;
    for (index, entry) in entries.into_iter().enumerate() {
        app.faults.hold(HOLD_BULK_PAGE, None).await;
        let result = match entry {
            Err(refusal) => refused_entry(index, &refusal, landed)?,
            Ok(entry) => {
                let note = Note {
                    index,
                    total,
                    mode,
                    retype,
                    fanout,
                    operation: operation.clone(),
                };
                let entry = Box::new(entry);
                match write::run(app, caller, None, Change::Entry { entry, note }).await {
                    Ok(done) => serde_json::from_str(&done.body)
                        .map_err(|_| Refusal::internal("an entry's answer did not read"))?,
                    Err(refusal) => refused_entry(index, &refusal, landed)?,
                }
            }
        };
        let outcome = result["outcome"].as_str().unwrap_or_default();
        counts.add(outcome);
        landed |= matches!(outcome, "created" | "updated")
            || result["error"]["details"]["write_outcome"] == "unknown";
        results.push(result);
    }
    Ok(json!({ "counts": counts, "results": results }).to_string())
}
