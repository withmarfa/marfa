//! Pages are cut like `items::bulk`'s; every edge goes through [`write::write`].

use std::sync::Arc;

use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::rows;
use super::write::{self as edges, By, Create, Op, Update, Writing};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::catalog::{self, Snapshot as Reading};
use crate::app::faults::{Faults, HOLD_BULK_PAGE};
use crate::app::idempotency::Need;
use crate::app::items::bulk::{Counts, Entered, refused_entry, rollback};
use crate::app::items::{self, Reader, reading};
use crate::app::refusal::{Refusal, Result};
use crate::db::Pulse;

const ACTION: &str = "edges.bulk";

#[derive(Debug)]
pub struct Entry {
    pub id: Option<String>,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub properties: Option<Map<String, Value>>,
    pub version: Option<i64>,
}

#[derive(Debug)]
pub struct Asked {
    pub entries: Vec<Result<Entry>>,
    pub create_only: bool,
    pub atomic: bool,
    pub fanout: bool,
}

fn mode_word(create_only: bool) -> &'static str {
    if create_only { "create_only" } else { "upsert" }
}

impl Writing<'_, '_, '_> {
    /// Answers across all entries before any is held against the stored edges: an id that cannot
    /// be one, and a grant the caller lacks.
    fn entry_gates(&self, entry: &Entry) -> Result<()> {
        edges::check_entry_ids(entry)?;
        if let Some(source) = items::row(self.unit.tx(), &entry.source_id)?
            .filter(|row| self.unit.caller.may_read_type(&row.type_id))
        {
            self.unit
                .caller
                .require_type(&source.type_id, Level::Write)?;
        }
        self.unit
            .caller
            .require_edge(&entry.edge_type, Level::Write)
    }

    fn entry(&self, entry: Entry, create_only: bool) -> Result<Entered> {
        self.entry_gates(&entry)?;
        let source = self.source_row(&entry.source_id)?;
        self.require_row_write(&source)?;
        self.require_edge_write(&entry.edge_type)?;
        let reachable = items::row(self.unit.tx(), &entry.target_id)?
            .is_some_and(|row| self.unit.caller.may_read_type(&row.type_id));
        if !reachable {
            return Err(edges::target_missing(&entry.target_id));
        }
        self.note(Need::Reach);
        if let Some(id) = &entry.id
            && let Some(held) = rows::by_id(self.unit.tx(), id)?
            && self.may_read(&held)?
        {
            edges::repeat(&held, &entry.source_id, &entry.target_id, &entry.edge_type)?;
        }
        let matched = rows::by_triple(
            self.unit.tx(),
            &entry.source_id,
            &entry.target_id,
            &entry.edge_type,
        )?;
        let Some(matched) = matched else {
            let made = edges::write(
                self,
                Op::Create(Create {
                    id: entry.id,
                    source_id: entry.source_id,
                    target_id: entry.target_id,
                    edge_type: entry.edge_type,
                    properties: entry.properties.unwrap_or_default(),
                    source_version: None,
                }),
                By::Caller,
            )?;
            return Ok(Entered::Created(made.edge().id.clone()));
        };
        if create_only {
            return Ok(Entered::Skipped {
                id: Some(matched.id),
                reason: "duplicate_edge",
            });
        }
        let id = matched.id.clone();
        edges::write(
            self,
            Op::Update(Update {
                id,
                version: entry.version.unwrap_or(matched.version),
                source_id: None,
                target_id: None,
                properties: Some(entry.properties.unwrap_or_default()),
            }),
            By::Caller,
        )
        .map_err(|refusal| refusal.naming_row(&matched.id))?;
        Ok(Entered::Updated(matched.id))
    }
}

struct Atomic {
    entries: Vec<Result<Entry>>,
    create_only: bool,
    operation: String,
    pulse: Pulse,
    faults: Arc<Faults>,
}

fn atomic_page(writing: &Writing<'_, '_, '_>, page: Atomic) -> Result<String> {
    let Atomic {
        entries,
        create_only,
        operation,
        pulse,
        faults,
    } = page;
    for (index, entry) in entries.iter().enumerate() {
        if let Err(refusal) = entry {
            return Err(rollback(index, refusal));
        }
    }
    for (index, entry) in entries.iter().enumerate() {
        entry
            .as_ref()
            .map_err(Refusal::clone)
            .and_then(|entry| writing.entry_gates(entry))
            .map_err(|refusal| rollback(index, &refusal))?;
    }
    let total = entries.len();
    let mut counts = Counts::default();
    let mut results = Vec::with_capacity(total);
    for (index, entry) in entries.into_iter().enumerate() {
        faults.hold_beating(HOLD_BULK_PAGE, &pulse);
        let entered = entry
            .and_then(|entry| writing.entry(entry, create_only))
            .map_err(|refusal| rollback(index, &refusal))?;
        pulse.tick();
        counts.add(entered.outcome());
        results.push(entered.answered(index));
    }
    writing.unit.audit_set(
        ACTION,
        Some(json!({
            "operation_id": operation,
            "mode": mode_word(create_only),
            "atomic": true,
            "total": total,
            "created": counts.created,
            "updated": counts.updated,
            "skipped": counts.skipped,
            "errored": counts.errored,
        })),
    )?;
    Ok(json!({ "counts": counts, "results": results }).to_string())
}

pub async fn write(app: &App, caller: &Caller, asked: Asked) -> Result<String> {
    let Asked {
        entries,
        create_only,
        atomic,
        fanout,
    } = asked;
    if entries.is_empty() {
        reading(app, caller, |read: &Reader<'_, '_>| {
            read.caller.require_reach()
        })
        .await?;
        return Ok(json!({ "counts": Counts::default(), "results": [] }).to_string());
    }
    let operation = Uuid::now_v7().to_string();
    let cache = app.catalog_handle();
    if atomic {
        let page = Atomic {
            entries,
            create_only,
            operation,
            pulse: app.db.pulse(),
            faults: app.faults.clone(),
        };
        return app
            .write(caller, ACTION, move |unit| {
                unit.fanning(fanout, |unit| {
                    let catalog = catalog::current(&cache, unit.tx(), Reading::Pending)?;
                    let writing = Writing::page(unit, &catalog);
                    unit.caller.require_reach()?;
                    atomic_page(&writing, page)
                })
            })
            .await;
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
                let cache = cache.clone();
                let operation = operation.clone();
                let written = app
                    .write(caller, ACTION, move |unit| {
                        unit.fanning(fanout, |unit| {
                            let catalog = catalog::current(&cache, unit.tx(), Reading::Pending)?;
                            let writing = Writing::page(unit, &catalog);
                            let entered = writing.entry(entry, create_only)?;
                            if let Entered::Created(id) | Entered::Updated(id) = &entered {
                                unit.audit(
                                    ACTION,
                                    id,
                                    Some(json!({
                                        "operation_id": operation,
                                        "mode": mode_word(create_only),
                                        "atomic": false,
                                        "total": total,
                                        "index": index,
                                        "outcome": entered.outcome(),
                                    })),
                                )?;
                            }
                            Ok(entered.answered(index))
                        })
                    })
                    .await;
                match written {
                    Ok(answer) => answer,
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
