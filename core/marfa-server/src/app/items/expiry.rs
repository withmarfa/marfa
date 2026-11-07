//! The `feed-expiry` job: a feed item past its type's `feed_days` goes to the
//! bin, as a delete would put it there.
//!
//! An item brought back from the bin carries `restored_at`, which a trigger sets
//! however it came back, and the job leaves it alone for good.

use std::sync::Arc;

use marfa_rules::schema::resolve;
use rusqlite::{Transaction, params};
use serde_json::{Value, json};

use super::super::App;
use super::super::access::Caller;
use super::super::catalog::{self, Catalog, Snapshot};
use super::super::housekeeping::{DAY_MS, Report, Run, ago};
use super::super::refusal::Result;
use super::super::unit::Unit;
use super::is_system;
use super::rows::{self, Moved};
use super::sweep::{alone, announced};

/// Items one write moves. A run goes on to the last of them.
const CHUNK: i64 = 100;

const EXPIRABLE: &str = "tier = 'feed' AND state = 'active' AND restored_at IS NULL";

/// The days a type's feed items are kept, or `None` while nothing expires them:
/// no window, a zero one, a system type's bounded life, or a type that is not
/// registered or does not resolve.
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

fn expired(tx: &Transaction<'_>, type_id: &str, before: &str, limit: i64) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT id FROM items WHERE type = ?1 AND {EXPIRABLE} AND created_at < ?2 \
         ORDER BY created_at, id LIMIT ?3"
    ))?;
    Ok(statement
        .query_map(params![type_id, before, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The types with an item past its window as things stand.
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
            && !expired(tx, &type_id, &before, 1)?.is_empty()
        {
            due.push(type_id);
        }
    }
    Ok(due)
}

struct Chunk {
    chosen: usize,
    moved: usize,
}

/// One chunk, judged inside the write that moves it: the window is the type's
/// as it stands then, and the rows are as they stand then.
fn move_chunk(unit: &Unit<'_, '_>, app: &App, type_id: &str) -> Result<Chunk> {
    let tx = unit.tx();
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Pending)?;
    let Some(before) = cutoff_of(app, &catalog, type_id) else {
        return Ok(Chunk {
            chosen: 0,
            moved: 0,
        });
    };
    let chosen = expired(tx, type_id, &before, CHUNK)?;
    let writer = unit.caller.writer();
    let mut moved: Vec<&String> = Vec::with_capacity(chosen.len());
    for id in &chosen {
        let refused = alone(tx, || {
            let Some(item) = rows::by_id(tx, id)? else {
                return Ok(());
            };
            let item = rows::move_state(
                tx,
                &item,
                &Moved {
                    state: "trashed",
                    trashed_at: Some(&unit.at),
                    trashed_by: Some(&writer),
                    at: &unit.at,
                },
            )?;
            announced(unit, "item.deleted", &item)
        })?;
        match refused {
            None => moved.push(id),
            Some(refused) => {
                tracing::error!(item = %id, error = %refused, "A feed item could not be moved");
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
        chosen: chosen.len(),
        moved: moved.len(),
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
        held += loop {
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
                    move_chunk(unit, &live, &id)
                })
                .await?;
            moved += chunk.moved;
            if chunk.moved == 0 || (chunk.chosen as i64) < CHUNK {
                break chunk.chosen - chunk.moved;
            }
        };
    }
    Ok(Report::done(result(moved, held)))
}
