//! A feed item past its type's `feed_days` goes to the bin, but only when all a delete would take
//! has expired too or is in the bin. An item brought back carries `restored_at`, set by a trigger,
//! and the job leaves it alone for good.

use std::sync::Arc;

use marfa_rules::schema::resolve;
use rusqlite::{Transaction, params};
use serde_json::{Value, json};

use super::super::App;
use super::super::access::Caller;
use super::super::catalog::{self, Catalog, Snapshot};
use super::super::housekeeping::{DAY_MS, Report, Run, ago};
use super::super::refusal::{Code, Result};
use super::super::unit::Unit;
use super::plan::{Act, Asked, Gate, plan};
use super::sweep::alone;
use super::write::{announce, moved_to_bin};
use super::{Item, is_system};

const CHUNK: i64 = 100;

const EXPIRABLE: &str = "tier = 'feed' AND state = 'active' AND restored_at IS NULL";

/// What a run held back stays expired, so the next chunk starts past it.
type Position = (String, String);

fn window(catalog: &Catalog, type_id: &str) -> Option<i64> {
    if is_system(type_id) || catalog.is_unreadable(type_id) {
        return None;
    }
    let schema = match resolve(&catalog.types, type_id, false) {
        Ok(schema) => schema?,
        Err(_) => {
            tracing::warn!(
                type_id,
                "A type's chain does not resolve; its feed items stay"
            );
            return None;
        }
    };
    schema
        .get("retention_policy")?
        .get("feed_days")?
        .as_i64()
        .filter(|days| *days > 0)
}

fn cutoff_of(app: &App, catalog: &Catalog, type_id: &str) -> Option<String> {
    window(catalog, type_id).map(|days| ago(app, days, DAY_MS))
}

fn expired(
    tx: &Transaction<'_>,
    type_id: &str,
    before: &str,
    after: &Position,
    limit: i64,
) -> Result<Vec<Position>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT created_at, id FROM items WHERE type = ?1 AND {EXPIRABLE} AND created_at < ?2 \
         AND (created_at, id) > (?3, ?4) ORDER BY created_at, id LIMIT ?5"
    ))?;
    Ok(statement
        .query_map(params![type_id, before, after.0, after.1, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn is_expired(app: &App, tx: &Transaction<'_>, catalog: &Catalog, item: &Item) -> Result<bool> {
    let Some(before) = cutoff_of(app, catalog, &item.type_id) else {
        return Ok(false);
    };
    let mut statement = tx.prepare_cached(&format!(
        "SELECT EXISTS (SELECT 1 FROM items WHERE id = ?1 AND {EXPIRABLE} AND created_at < ?2)"
    ))?;
    Ok(statement.query_row(params![item.id, before], |row| row.get(0))?)
}

fn types_due(app: &App, tx: &Transaction<'_>) -> Result<Vec<String>> {
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Committed)?;
    let mut statement = tx.prepare_cached(&format!(
        "SELECT DISTINCT type FROM items WHERE {EXPIRABLE}"
    ))?;
    let types = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut due = Vec::new();
    for type_id in types {
        if let Some(before) = cutoff_of(app, &catalog, &type_id)
            && !expired(tx, &type_id, &before, &Position::default(), 1)?.is_empty()
        {
            due.push(type_id);
        }
    }
    Ok(due)
}

#[derive(Default)]
struct Chunk {
    moved: usize,
    held: usize,
    next: Option<Position>,
}

fn move_one(
    unit: &Unit<'_, '_>,
    app: &App,
    gate: &Gate<'_, '_>,
    id: &str,
) -> Result<Option<Vec<String>>> {
    let asked = Asked {
        id: id.to_string(),
        version: None,
    };
    let moving = plan(gate, Act::Bin, &[asked])?.moving;
    for row in &moving {
        if !is_expired(app, gate.tx, gate.catalog, &row.item)? {
            return Ok(None);
        }
    }
    let moved = moved_to_bin(unit, &moving)?;
    for item in &moved {
        announce(unit, "item.deleted", item)?;
    }
    Ok(Some(moved.into_iter().map(|item| item.id).collect()))
}

/// One chunk, judged inside the write that moves it, so the window and rows are as they stand then.
fn move_chunk(unit: &Unit<'_, '_>, app: &App, type_id: &str, after: &Position) -> Result<Chunk> {
    let tx = unit.tx();
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Pending)?;
    let Some(before) = cutoff_of(app, &catalog, type_id) else {
        return Ok(Chunk::default());
    };
    let gate = Gate {
        tx,
        caller: &unit.caller,
        catalog: &catalog,
        claim: None,
        server_own: false,
    };
    let chosen = expired(tx, type_id, &before, after, CHUNK)?;
    let mut moved: Vec<String> = Vec::with_capacity(chosen.len());
    let mut held = 0;
    for (_, id) in &chosen {
        // A cascade from a row before it in this chunk can have moved it.
        if moved.contains(id) {
            continue;
        }
        let mut taken = None;
        let refused = alone(tx, || {
            taken = move_one(unit, app, &gate, id)?;
            Ok(())
        })?;
        match (refused, taken) {
            (None, Some(taken)) => moved.extend(taken),
            (None, None) => held += 1,
            (Some(refused), _) => {
                held += 1;
                if refused.code != Code::EdgeConstraintViolation {
                    tracing::error!(item = %id, error = %refused, "A feed item could not be moved");
                }
            }
        }
    }
    if !moved.is_empty() {
        unit.audit_set(
            "item",
            Some(json!({
                "type": type_id,
                "before": before,
                "moved": moved.len(),
                "item_ids": moved,
            })),
        )?;
    }
    Ok(Chunk {
        moved: moved.len(),
        held,
        next: chosen
            .last()
            .filter(|_| chosen.len() as i64 == CHUNK)
            .cloned(),
    })
}

fn result(moved: usize, held: usize) -> Value {
    json!({ "moved": moved, "held": held })
}

pub async fn feed_expiry(app: Arc<App>, run: Run) -> Result<Report> {
    let live = app.clone();
    let types = app.db.read(move |tx| types_due(&live, tx)).await?;
    let (mut moved, mut held) = (0, 0);
    for type_id in types {
        let mut after = Position::default();
        loop {
            if !run.go_on().await {
                return Ok(Report {
                    result: result(moved, held),
                    again: true,
                });
            }
            let live = app.clone();
            let id = type_id.clone();
            let chunk = app
                .write(&Caller::Server, "items.feed_expired", move |unit| {
                    move_chunk(unit, &live, &id, &after)
                })
                .await?;
            moved += chunk.moved;
            held += chunk.held;
            let Some(next) = chunk.next else {
                break;
            };
            after = next;
        }
    }
    Ok(Report::done(result(moved, held)))
}
