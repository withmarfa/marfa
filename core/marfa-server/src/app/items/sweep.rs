//! The `trash-purge` job: an item whose time in the bin is up goes for good.

use std::sync::Arc;

use rusqlite::{Transaction, params};
use serde_json::json;

use super::super::App;
use super::super::access::Caller;
use super::super::events::Event;
use super::super::housekeeping::{DAY_MS, Report, Run, cutoff};
use super::super::refusal::{Refusal, Result};
use super::super::unit::Unit;
use super::{Item, rows};
use crate::settings::registry::TRASH_RETENTION_DAYS;

/// Items one run removes. A run that leaves more runs again at once.
const BATCH: i64 = 200;

fn binned_before(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<Vec<String>> {
    let mut statement = tx.prepare_cached(
        "SELECT id FROM items WHERE state = 'trashed' AND trashed_at < ?1 \
         ORDER BY trashed_at, id LIMIT ?2",
    )?;
    Ok(statement
        .query_map(params![before, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Announces what happened to `item`, as a write of it would.
pub(super) fn announced(unit: &Unit<'_, '_>, event_type: &'static str, item: &Item) -> Result<()> {
    unit.announce(&Event {
        event_type,
        item_id: &item.id,
        type_id: &item.type_id,
        source: &item.source,
        payload: format!(
            "{{\"event_type\":\"{event_type}\",\"item\":{}}}",
            item.logged()?
        ),
    })
}

/// Does the work of one row of a batch so that its failure takes back that row
/// alone. A row that cannot be read or moved stays, and the rest go on.
pub(super) fn alone(
    tx: &Transaction<'_>,
    work: impl FnOnce() -> Result<()>,
) -> Result<Option<Refusal>> {
    tx.execute_batch("SAVEPOINT one_row")?;
    match work() {
        Ok(()) => {
            tx.execute_batch("RELEASE one_row")?;
            Ok(None)
        }
        Err(refused) => {
            tx.execute_batch("ROLLBACK TO one_row; RELEASE one_row")?;
            Ok(Some(refused))
        }
    }
}

struct Purged {
    deleted: usize,
    left: bool,
}

/// One batch, inside the write that removes it: the retention is read here, so
/// a retention raised or set to zero during a run holds for what has not gone.
fn purge_batch(unit: &Unit<'_, '_>, app: &App) -> Result<Purged> {
    let Some(before) = cutoff(app, TRASH_RETENTION_DAYS, DAY_MS) else {
        return Ok(Purged {
            deleted: 0,
            left: false,
        });
    };
    let tx = unit.tx();
    let chosen = binned_before(tx, &before, BATCH + 1)?;
    let left = chosen.len() as i64 > BATCH;
    let mut deleted = 0;
    let mut first_refusal = None;
    for id in chosen.iter().take(BATCH as usize) {
        let refused = alone(tx, || {
            let Some(item) = rows::by_id(tx, id)? else {
                return Ok(());
            };
            rows::purge(tx, &item, &unit.at)?;
            announced(unit, "item.purged", &item)
        })?;
        match refused {
            None => deleted += 1,
            Some(refused) => {
                tracing::error!(item = %id, error = %refused, "An item could not be purged");
                first_refusal.get_or_insert(refused);
            }
        }
    }
    match first_refusal {
        Some(refused) if deleted == 0 => return Err(refused),
        _ => {}
    }
    if deleted > 0 {
        unit.audit_set(
            "item",
            Some(json!({ "deleted": deleted, "before": before })),
        )?;
    }
    Ok(Purged { deleted, left })
}

pub async fn trash_purge(app: Arc<App>, _run: Run) -> Result<Report> {
    let Some(before) = cutoff(&app, TRASH_RETENTION_DAYS, DAY_MS) else {
        return Ok(Report::done(json!({ "deleted": 0 })));
    };
    let due = app
        .db
        .read(move |tx| Ok(!binned_before(tx, &before, 1)?.is_empty()))
        .await?;
    if !due {
        return Ok(Report::done(json!({ "deleted": 0 })));
    }
    let live = app.clone();
    let purged = app
        .write(&Caller::Server, "items.trash_purged", move |unit| {
            purge_batch(unit, &live)
        })
        .await?;
    Ok(Report {
        result: json!({ "deleted": purged.deleted }),
        again: purged.deleted > 0 && purged.left,
    })
}
