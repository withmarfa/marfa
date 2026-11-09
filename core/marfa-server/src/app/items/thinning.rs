//! Which snapshots go is decided twice: to find items with work, and again inside the write
//! that removes them, so each item is thinned by the policy as it stands then.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Utc};
use marfa_rules::schema::resolve;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::super::access::Caller;
use super::super::blobs::references;
use super::super::catalog::{self, Catalog, Snapshot};
use super::super::faults::HOLD_THINNING_ITEM;
use super::super::housekeeping::{DAY_MS, Report, Run};
use super::super::refusal::Result;
use super::super::unit::Unit;
use super::super::{App, stored};
use crate::app::clock::Stamp;
use crate::settings::registry::{
    VERSION_DAILY_SNAPSHOT_DAYS, VERSION_MAX_VERSIONS, VERSION_RECENT_DAYS,
    VERSION_WEEKLY_SNAPSHOT_DAYS,
};

const PAGE: i64 = 100;
const CHUNK: usize = 200;
const MINIMUM: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Policy {
    recent_days: i64,
    daily_days: i64,
    weekly_days: i64,
    max_versions: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Kept {
    id: String,
    version: i64,
    created_at: String,
}

fn parsed(text: &str) -> Option<DateTime<Utc>> {
    let read = Stamp::parsed(text).map(Stamp::at);
    if read.is_none() {
        tracing::warn!("A snapshot's stored time does not read; the snapshot is kept");
    }
    read
}

/// The newest version and any snapshot whose age cannot be read always stay.
fn thin(history: &[Kept], policy: &Policy, now_ms: i64) -> Vec<Kept> {
    if history.len() <= MINIMUM {
        return Vec::new();
    }
    let days_ago = |days: i64| now_ms.saturating_sub(days.saturating_mul(DAY_MS));
    let (recent, daily, weekly) = (
        days_ago(policy.recent_days),
        days_ago(policy.daily_days),
        days_ago(policy.weekly_days),
    );
    let mut keep = vec![false; history.len()];
    let mut buckets: HashMap<String, usize> = HashMap::new();
    for (at, snapshot) in history.iter().enumerate() {
        let Some(created) = parsed(&snapshot.created_at) else {
            keep[at] = true;
            continue;
        };
        let ms = created.timestamp_millis();
        let bucket = if ms >= recent {
            keep[at] = true;
            continue;
        } else if ms >= daily {
            created.format("%Y-%m-%d").to_string()
        } else if ms >= weekly {
            let week = created.iso_week();
            format!("{}-W{:02}", week.year(), week.week())
        } else {
            keep[at] = policy.weekly_days == 0;
            continue;
        };
        let latest = buckets.entry(bucket).or_insert(at);
        let rank = |snapshot: &Kept| (snapshot.created_at.clone(), snapshot.version);
        if rank(snapshot) > rank(&history[*latest]) {
            *latest = at;
        }
    }
    for at in buckets.into_values() {
        keep[at] = true;
    }
    let newest = history
        .iter()
        .enumerate()
        .max_by_key(|(_, snapshot)| snapshot.version)
        .map_or(0, |(at, _)| at);
    keep[newest] = true;

    let mut kept: Vec<usize> = (0..history.len()).filter(|at| keep[*at]).collect();
    let cap = usize::try_from(policy.max_versions).unwrap_or(usize::MAX);
    if kept.len() > cap {
        kept.sort_by(|a, b| history[*a].created_at.cmp(&history[*b].created_at));
        let excess = kept.len() - cap;
        for at in kept.into_iter().take(excess) {
            if at != newest {
                keep[at] = false;
            }
        }
    }
    history
        .iter()
        .zip(keep)
        .filter(|(_, kept)| !kept)
        .map(|(snapshot, _)| snapshot.clone())
        .collect()
}

/// Read from `tx`, since the live settings lag a change the writer has committed.
fn instance_policy(tx: &Transaction<'_>, app: &App) -> Result<Policy> {
    let seeds = app.settings.seeds();
    let whole = |setting| -> Result<i64> {
        Ok(i64::try_from(stored::deciding(tx, &seeds, setting)?).unwrap_or(i64::MAX))
    };
    Ok(Policy {
        recent_days: whole(VERSION_RECENT_DAYS)?,
        daily_days: whole(VERSION_DAILY_SNAPSHOT_DAYS)?,
        weekly_days: whole(VERSION_WEEKLY_SNAPSHOT_DAYS)?,
        max_versions: whole(VERSION_MAX_VERSIONS)?,
    })
}

/// A type no longer registered has only the instance's policy; one that cannot be read has none, and its items are left whole.
fn policy_of(defaults: Policy, catalog: &Catalog, type_id: &str) -> Option<Policy> {
    if catalog.is_unreadable(type_id) {
        return None;
    }
    let schema = match resolve(&catalog.types, type_id, false) {
        Ok(schema) => schema,
        Err(_) => {
            tracing::warn!(
                type_id,
                "A type's chain does not resolve; its history stays"
            );
            return None;
        }
    };
    let declared = schema
        .as_ref()
        .and_then(|schema| schema.get("version_policy"));
    let field = |name: &str, default: i64| {
        declared
            .and_then(|policy| policy.get(name))
            .and_then(Value::as_i64)
            .unwrap_or(default)
    };
    Some(Policy {
        recent_days: field("recent_days", defaults.recent_days),
        daily_days: field("daily_snapshot_days", defaults.daily_days),
        weekly_days: field("weekly_snapshot_days", defaults.weekly_days),
        max_versions: field("max_versions", defaults.max_versions),
    })
}

fn history(tx: &Transaction<'_>, seq: i64) -> Result<Vec<Kept>> {
    let mut statement = tx.prepare_cached(
        "SELECT id, version, created_at FROM item_versions WHERE item_seq = ?1 ORDER BY version",
    )?;
    Ok(statement
        .query_map([seq], |row| {
            Ok(Kept {
                id: row.get(0)?,
                version: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn doomed(
    app: &App,
    defaults: Policy,
    catalog: &Catalog,
    tx: &Transaction<'_>,
    seq: i64,
) -> Result<Vec<Kept>> {
    let type_id: Option<String> = tx
        .query_row("SELECT type FROM items WHERE seq = ?1", [seq], |row| {
            row.get(0)
        })
        .optional()?;
    let policy = type_id.and_then(|type_id| policy_of(defaults, catalog, &type_id));
    match policy {
        Some(policy) => Ok(thin(&history(tx, seq)?, &policy, app.clock.now_ms())),
        None => Ok(Vec::new()),
    }
}

struct Page {
    last: Option<i64>,
    chosen: Vec<i64>,
}

fn page(app: &App, tx: &Transaction<'_>, after: i64) -> Result<Page> {
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Committed)?;
    let defaults = instance_policy(tx, app)?;
    let mut statement = tx.prepare_cached(
        "SELECT item_seq FROM item_versions WHERE item_seq > ?1 GROUP BY item_seq \
         HAVING count(*) > ?2 ORDER BY item_seq LIMIT ?3",
    )?;
    let seqs = statement
        .query_map(params![after, MINIMUM as i64, PAGE], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    let mut chosen = Vec::new();
    for seq in &seqs {
        if !doomed(app, defaults, &catalog, tx, *seq)?.is_empty() {
            chosen.push(*seq);
        }
    }
    Ok(Page {
        last: seqs.last().copied(),
        chosen,
    })
}

fn remove(unit: &Unit<'_, '_>, app: &App, seq: i64) -> Result<usize> {
    let tx = unit.tx();
    let catalog = catalog::current(&app.catalog_handle(), tx, Snapshot::Pending)?;
    let mut doomed = doomed(app, instance_policy(tx, app)?, &catalog, tx, seq)?;
    doomed.truncate(CHUNK);
    if doomed.is_empty() {
        return Ok(0);
    }
    for snapshot in &doomed {
        references::forget(tx, references::Row::Version(seq, snapshot.version))?;
        tx.prepare_cached("DELETE FROM item_versions WHERE item_seq = ?1 AND version = ?2")?
            .execute(params![seq, snapshot.version])?;
    }
    let item_id: String = tx.query_row("SELECT id FROM items WHERE seq = ?1", [seq], |row| {
        row.get(0)
    })?;
    let ids: Vec<&str> = doomed.iter().map(|snapshot| snapshot.id.as_str()).collect();
    unit.audit(
        "item",
        &item_id,
        Some(json!({ "pruned": doomed.len(), "version_ids": ids })),
    )?;
    Ok(doomed.len())
}

pub async fn version_thinning(app: Arc<App>, run: Run) -> Result<Report> {
    let (mut pruned, mut items) = (0, 0);
    let mut after = 0;
    let report = |pruned: usize, items: usize, again| Report {
        result: json!({ "pruned": pruned, "items": items }),
        again,
    };
    loop {
        let live = app.clone();
        let found = app.db.read(move |tx| page(&live, tx, after)).await?;
        let Some(last) = found.last else {
            return Ok(report(pruned, items, false));
        };
        after = last;
        for seq in found.chosen {
            if !run.go_on().await {
                return Ok(report(pruned, items, true));
            }
            app.faults.hold(HOLD_THINNING_ITEM, None).await;
            let mut removed_any = false;
            loop {
                let live = app.clone();
                let removed = app
                    .write(&Caller::Server, "item.versions_thinned", move |unit| {
                        remove(unit, &live, seq)
                    })
                    .await?;
                pruned += removed;
                removed_any |= removed > 0;
                if removed < CHUNK {
                    break;
                }
                if !run.go_on().await {
                    return Ok(report(pruned, items + 1, true));
                }
            }
            items += usize::from(removed_any);
        }
        if !run.go_on().await {
            return Ok(report(pruned, items, true));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR_MS: i64 = 3_600_000;

    fn at(ms: i64) -> String {
        Stamp::from_ms(ms).unwrap().text()
    }

    fn snapshots(ages_ms: &[i64]) -> Vec<Kept> {
        ages_ms
            .iter()
            .enumerate()
            .map(|(index, age)| Kept {
                id: format!("v{}", index + 1),
                version: index as i64 + 1,
                created_at: at(NOW - age),
            })
            .collect()
    }

    fn gone(ages_ms: &[i64], policy: &Policy) -> Vec<i64> {
        thin(&snapshots(ages_ms), policy, NOW)
            .iter()
            .map(|snapshot| snapshot.version)
            .collect()
    }

    const POLICY: Policy = Policy {
        recent_days: 1,
        daily_days: 3,
        weekly_days: 30,
        max_versions: 100,
    };

    #[test]
    fn two_snapshots_or_fewer_are_never_thinned() {
        let old = 400 * DAY_MS;
        assert!(gone(&[old], &POLICY).is_empty());
        assert!(gone(&[old + 1, old], &POLICY).is_empty());
        assert_eq!(gone(&[old + 2, old + 1, old], &POLICY), [1, 2]);
    }

    #[test]
    fn inside_the_recent_window_stays_and_a_moment_past_it_does_not() {
        let edge = POLICY.recent_days * DAY_MS;
        let two_days = 2 * DAY_MS;
        assert!(gone(&[edge, edge - 1, 0], &POLICY).is_empty());
        assert_eq!(gone(&[two_days + 1, two_days, 0], &POLICY), [1]);
    }

    #[test]
    fn beyond_the_weekly_window_goes_but_the_newest_stays() {
        let past = POLICY.weekly_days * DAY_MS + 1_000;
        let inside = POLICY.weekly_days * DAY_MS - 1_000;
        assert_eq!(gone(&[past, past - 1, inside, 0], &POLICY), [1, 2]);
    }

    #[test]
    fn one_a_day_stays_then_one_a_week() {
        let days = |n: i64| n * DAY_MS;
        let three_a_day = [days(2) + 2 * HOUR_MS, days(2) + HOUR_MS, days(2), 0];
        assert_eq!(gone(&three_a_day, &POLICY).len(), 2);
        let same_week = [days(20) + 2 * HOUR_MS, days(20) + HOUR_MS, days(20), 0];
        assert_eq!(gone(&same_week, &POLICY).len(), 2);
    }

    #[test]
    fn a_zero_outer_window_keeps_every_age() {
        let none = Policy {
            recent_days: 0,
            daily_days: 0,
            weekly_days: 0,
            max_versions: 100,
        };
        let old = 400 * DAY_MS;
        assert!(gone(&[old + 2, old + 1, old], &none).is_empty());
    }

    #[test]
    fn the_largest_windows_keep_every_snapshot_inside_them() {
        let widest = Policy {
            recent_days: 36_500,
            daily_days: 36_500,
            weekly_days: 36_500,
            max_versions: i64::MAX,
        };
        let old = 400 * DAY_MS;
        assert!(gone(&[old + 2, old + 1, old], &widest).is_empty());
    }

    #[test]
    fn the_cap_drops_the_oldest_and_never_the_newest() {
        let capped = Policy {
            max_versions: 1,
            ..POLICY
        };
        assert_eq!(gone(&[3_000, 2_000, 1_000], &capped), [1, 2]);
    }

    #[test]
    fn a_snapshot_whose_age_does_not_read_stays() {
        let mut history = snapshots(&[400 * DAY_MS, 400 * DAY_MS, 0]);
        history[0].created_at = "not a date".to_string();
        let versions: Vec<i64> = thin(&history, &POLICY, NOW)
            .iter()
            .map(|snapshot| snapshot.version)
            .collect();
        assert_eq!(versions, [2]);
    }
}
