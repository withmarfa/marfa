use std::time::Duration;

use super::super::backups;
use super::super::blobs::upkeep;
use super::super::{attention, enrichment, inbound, items, jobs, tables};
use super::{Job, cleanups, heartbeat};
use crate::settings::registry::BACKUP_INTERVAL_SECONDS;

const HOUR: Duration = Duration::from_secs(3_600);
const SIX_HOURS: Duration = Duration::from_secs(6 * 3_600);
const HEARTBEAT_DEADLINE: Duration = Duration::from_secs(30);
const ATTENTION_DEADLINE: Duration = Duration::from_secs(60);

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

pub(super) const JOBS: &[Job] = &[
    Job::new("heartbeat", MINUTE_MS, 0, HEARTBEAT_DEADLINE, |app, run| {
        Box::pin(heartbeat::beat(app, run))
    })
    .switched_by(heartbeat::configured)
    .without_statements(),
    Job::new("enrichment-sweep", 30_000, 30_000, HOUR, |app, run| {
        Box::pin(enrichment::sweep(app, run))
    }),
    Job::new("audit-cleanup", DAY_MS, 5_000, HOUR, |app, run| {
        Box::pin(cleanups::audit(app, run))
    })
    .deleting(),
    Job::new("trash-purge", DAY_MS, 5_000, HOUR, |app, run| {
        Box::pin(items::sweep::trash_purge(app, run))
    })
    .deleting(),
    Job::new("version-thinning", HOUR_MS, 5_000, SIX_HOURS, |app, run| {
        Box::pin(items::thinning::version_thinning(app, run))
    })
    .deleting(),
    Job::new("feed-expiry", HOUR_MS, 5_000, SIX_HOURS, |app, run| {
        Box::pin(items::expiry::feed_expiry(app, run))
    })
    .deleting(),
    Job::new("event-log-cleanup", HOUR_MS, 10_000, HOUR, |app, run| {
        Box::pin(cleanups::event_log(app, run))
    })
    .deleting(),
    Job::new(
        "inbound-delivery-cleanup",
        MINUTE_MS,
        15_000,
        HOUR,
        |app, run| Box::pin(inbound::delivery_cleanup(app, run)),
    )
    .deleting(),
    Job::new("bulk-action-gc", HOUR_MS, 30_000, HOUR, |app, run| {
        Box::pin(jobs::gc(app, run))
    })
    .deleting(),
    Job::new("table-row-cleanup", HOUR_MS, 30_000, HOUR, |app, run| {
        Box::pin(tables::cleanup(app, run))
    })
    .deleting(),
    Job::new("credential-cleanup", HOUR_MS, 20_000, HOUR, |app, run| {
        Box::pin(cleanups::credentials(app, run))
    })
    .deleting(),
    Job::new("blob-replicate", MINUTE_MS, 5_000, HOUR, |app, run| {
        Box::pin(upkeep::replicate(app, run))
    }),
    Job::new("blob-orphans", DAY_MS, 30_000, HOUR, |app, run| {
        Box::pin(upkeep::orphans(app, run))
    })
    .switched_by(upkeep::sweeps)
    .deleting(),
    Job::new("blob-integrity", HOUR_MS, 60_000, HOUR, |app, run| {
        Box::pin(upkeep::integrity(app, run))
    }),
    Job::new(
        "attention-check",
        5 * MINUTE_MS,
        60_000,
        ATTENTION_DEADLINE,
        |app, run| Box::pin(attention::check(app, run)),
    ),
    Job::stored(
        "backup",
        BACKUP_INTERVAL_SECONDS,
        5_000,
        HOUR,
        |app, run| Box::pin(backups::job(app, run)),
    )
    .switched_by(backups::scheduled),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_contract_tables_exactly_the_jobs_the_server_runs_each_once() {
        let spec = include_str!("../../../../../conformance/spec/housekeeping.md");
        let table = spec
            .split("<!-- housekeeping-table:start -->")
            .nth(1)
            .and_then(|rest| rest.split("<!-- housekeeping-table:end -->").next())
            .expect("housekeeping.md holds the table");
        let rows: Vec<(&str, &str)> = table
            .lines()
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|rest| {
                let name = rest.split('`').next()?;
                let held = rest.trim_end().trim_end_matches('|').rsplit('|').next()?;
                Some((name, held.trim()))
            })
            .collect();
        let tabled: Vec<&str> = rows.iter().map(|(name, _)| *name).collect();
        assert!(JOBS.len() > 5);
        for job in JOBS {
            assert!(tabled.contains(&job.name), "{} is not tabled", job.name);
            let held = if job.deletes { "yes" } else { "no" };
            assert!(
                rows.contains(&(job.name, held)),
                "{} is not tabled as held: {held}",
                job.name
            );
        }
        for (index, name) in tabled.iter().enumerate() {
            assert!(
                JOBS.iter().any(|job| job.name == *name),
                "{name} is tabled and not run"
            );
            assert!(
                !tabled[index + 1..].contains(name),
                "{name} is tabled twice"
            );
        }
    }
}
