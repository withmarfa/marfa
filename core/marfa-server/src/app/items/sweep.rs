//! The `trash-purge` job: an item whose time in the bin is up goes for good.

use std::sync::Arc;

use rusqlite::{Transaction, params};
use serde_json::{Value, json};

use super::super::App;
use super::super::access::Caller;
use super::super::catalog::{self, Snapshot};
use super::super::clock::readable;
use super::super::edges::write::purge_edge;
use super::super::housekeeping::{DAY_MS, Report, Run, cutoff};
use super::super::instance;
use super::super::refusal::{Refusal, Result};
use super::super::unit::Unit;
use super::plan::{Act, Asked, Gate, plan};
use super::rows;
use super::write::purge;
use crate::settings::registry::TRASH_RETENTION_DAYS;

/// Rows one write takes. A run ends with the first write that removes any,
/// and a run that leaves more runs again at once.
const BATCH: i64 = 200;

/// How many of the rows a run could not take its log line names.
const NAMED: usize = 5;

/// Where a run has reached in the bin, by `trashed_at` and `id`. What it could
/// not take stays behind it, so the next batch starts past it.
type Position = (String, String);

fn binned_after(
    tx: &Transaction<'_>,
    before: &str,
    after: &Position,
    limit: i64,
) -> Result<Vec<Position>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT trashed_at, id FROM items WHERE state = 'trashed' AND {} AND trashed_at < ?1 \
         AND (trashed_at, id) > (?2, ?3) ORDER BY trashed_at, id LIMIT ?4",
        readable("trashed_at")
    ))?;
    Ok(statement
        .query_map(params![before, after.0, after.1, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
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

/// Whether what stopped a row says the store failed, and not that this row
/// cannot go: a constraint holds that row back and leaves every other one free.
fn is_actual_error(stopped: &Refusal) -> bool {
    stopped.code.status() >= 500 && stopped.database_code() != Some("SQLITE_CONSTRAINT")
}

/// The rows a run could not take, as its one log line says them.
#[derive(Debug, Default)]
struct Stopped {
    count: usize,
    named: Vec<String>,
    first_reason: Option<String>,
}

impl Stopped {
    fn add(&mut self, id: &str, stopped: &Refusal) {
        self.count += 1;
        if self.named.len() < NAMED {
            self.named.push(id.to_string());
        }
        self.first_reason.get_or_insert_with(|| stopped.to_string());
    }

    fn join(&mut self, batch: Stopped) {
        self.count += batch.count;
        self.named.extend(batch.named);
        self.named.truncate(NAMED);
        self.first_reason = self.first_reason.take().or(batch.first_reason);
    }

    fn report(&self) {
        if let Some(error) = &self.first_reason {
            tracing::error!(
                count = self.count,
                items = ?self.named,
                error = %error,
                "Items could not be purged"
            );
        }
    }
}

#[derive(Default)]
struct Batch {
    deleted: usize,
    refused: usize,
    failed: usize,
    first_error: Option<Refusal>,
    stopped: Stopped,
    /// Where the next batch starts, while there can be one.
    next: Option<Position>,
}

/// One batch, inside the write that removes it: the retention is read here, so
/// a retention raised or set to zero during a run holds for what has not gone.
fn purge_batch(unit: &Unit<'_, '_>, app: &App, after: &Position) -> Result<Batch> {
    let tx = unit.tx();
    let Some(before) = cutoff(tx, app, TRASH_RETENTION_DAYS, DAY_MS)? else {
        return Ok(Batch::default());
    };
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Pending)?;
    let gate = Gate {
        tx,
        caller: &unit.caller,
        catalog: &catalog,
        claim: None,
        server_own: false,
    };
    let chosen = binned_after(tx, &before, after, BATCH + 1)?;
    let taken = &chosen[..chosen.len().min(BATCH as usize)];
    let mut batch = Batch {
        next: taken.last().filter(|_| chosen.len() > taken.len()).cloned(),
        ..Batch::default()
    };
    for (_, id) in taken {
        let mut gone = 0;
        let stopped = alone(tx, || {
            // A part goes with its host, so a row chosen here can have gone already.
            if rows::by_id(tx, id)?.is_none() {
                return Ok(());
            }
            let asked = Asked {
                id: id.clone(),
                version: None,
            };
            let purging = plan(&gate, Act::Purge, &[asked])?.purging;
            for row in &purging {
                for (edge, source) in &row.edges {
                    purge_edge(unit, edge, source, &row.item.id)?;
                }
                purge(unit, &row.item)?;
            }
            gone = purging.len();
            Ok(())
        })?;
        match stopped {
            None => batch.deleted += gone,
            Some(stopped) => {
                batch.stopped.add(id, &stopped);
                if is_actual_error(&stopped) {
                    batch.failed += 1;
                    batch.first_error.get_or_insert(stopped);
                } else {
                    batch.refused += 1;
                }
            }
        }
    }
    if batch.deleted > 0 {
        instance::raise_reach(tx)?;
        unit.audit_set(
            "item",
            Some(json!({ "deleted": batch.deleted, "before": before })),
        )?;
    }
    Ok(batch)
}

fn result(deleted: usize, passed_over: usize) -> Value {
    let mut result = json!({ "deleted": deleted });
    if passed_over > 0 {
        result["passed_over"] = passed_over.into();
    }
    result
}

pub async fn trash_purge(app: Arc<App>, run: Run) -> Result<Report> {
    let live = app.clone();
    let due = app
        .db
        .read(
            move |tx| match cutoff(tx, &live, TRASH_RETENTION_DAYS, DAY_MS)? {
                Some(before) => Ok(!binned_after(tx, &before, &Position::default(), 1)?.is_empty()),
                None => Ok(false),
            },
        )
        .await?;
    if !due {
        return Ok(Report::done(result(0, 0)));
    }
    let mut stopped = Stopped::default();
    let ended = purge_due(&app, &run, &mut stopped).await;
    stopped.report();
    ended
}

/// Takes batches until one removes rows or the run must end.
async fn purge_due(app: &Arc<App>, run: &Run, stopped: &mut Stopped) -> Result<Report> {
    let (mut refused, mut failed, mut first_error) = (0, 0, None);
    let mut after = Position::default();
    loop {
        let live = app.clone();
        let batch = app
            .write(&Caller::Server, "items.trash_purged", move |unit| {
                purge_batch(unit, &live, &after)
            })
            .await?;
        refused += batch.refused;
        failed += batch.failed;
        first_error = first_error.or(batch.first_error);
        stopped.join(batch.stopped);
        match batch.next {
            Some(next) if batch.deleted == 0 && run.go_on().await => after = next,
            next => {
                if let (0, 0, Some(error)) = (batch.deleted, refused, first_error) {
                    return Err(error);
                }
                let passed_over = refused + failed;
                return Ok(Report {
                    result: result(batch.deleted, passed_over),
                    again: batch.deleted > 0 && (next.is_some() || passed_over > 0),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_counts_every_row_it_could_not_take_and_names_the_first_few() {
        let reason = |word: &str| Refusal::validation(word.to_string());
        let (mut run, mut batch) = (Stopped::default(), Stopped::default());
        for n in 0..NAMED + 1 {
            run.add(&format!("first {n}"), &reason("first"));
            batch.add(&format!("second {n}"), &reason("second"));
        }
        run.join(batch);

        assert_eq!(run.count, 2 * (NAMED + 1));
        assert_eq!(run.named.len(), NAMED);
        assert_eq!(run.named[0], "first 0");
        assert!(run.first_reason.unwrap().contains("first"));
    }
}
