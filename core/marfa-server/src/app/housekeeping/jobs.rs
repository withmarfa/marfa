use std::time::Duration;

use super::super::backups;
use super::super::blobs::upkeep;
use super::super::{enrichment, inbound, items, jobs};
use super::{Job, cleanups, heartbeat};
use crate::settings::registry::{
    AUDIT_CLEANUP_INTERVAL_MS, BACKUP_INTERVAL_MS, BLOB_CLEANUP_INTERVAL_MS,
    BLOB_INTEGRITY_INTERVAL_MS, BLOB_REPLICATE_INTERVAL_MS, CREDENTIAL_CLEANUP_INTERVAL_MS,
    ENRICHMENT_INTERVAL_MS, EVENT_LOG_CLEANUP_INTERVAL_MS, FEED_EXPIRY_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS, INBOUND_CLEANUP_INTERVAL_MS, TRASH_PURGE_INTERVAL_MS,
    VERSION_THINNING_INTERVAL_MS,
};

const HOUR: Duration = Duration::from_secs(3_600);
const HOUR_MS: u64 = 3_600_000;
const SIX_HOURS: Duration = Duration::from_secs(6 * 3_600);
const HEARTBEAT_DEADLINE: Duration = Duration::from_secs(30);

pub(super) const JOBS: &[Job] = &[
    Job::new(
        "heartbeat",
        HEARTBEAT_INTERVAL_MS,
        0,
        HEARTBEAT_DEADLINE,
        |app, run| Box::pin(heartbeat::beat(app, run)),
    )
    .switched_by(heartbeat::configured)
    .without_statements(),
    Job::new(
        "enrichment-sweep",
        ENRICHMENT_INTERVAL_MS,
        30_000,
        HOUR,
        |app, run| Box::pin(enrichment::sweep(app, run)),
    ),
    Job::new(
        "audit-cleanup",
        AUDIT_CLEANUP_INTERVAL_MS,
        5_000,
        HOUR,
        |app, run| Box::pin(cleanups::audit(app, run)),
    ),
    Job::new(
        "trash-purge",
        TRASH_PURGE_INTERVAL_MS,
        5_000,
        HOUR,
        |app, run| Box::pin(items::sweep::trash_purge(app, run)),
    ),
    Job::new(
        "version-thinning",
        VERSION_THINNING_INTERVAL_MS,
        5_000,
        SIX_HOURS,
        |app, run| Box::pin(items::thinning::version_thinning(app, run)),
    ),
    Job::new(
        "feed-expiry",
        FEED_EXPIRY_INTERVAL_MS,
        5_000,
        SIX_HOURS,
        |app, run| Box::pin(items::expiry::feed_expiry(app, run)),
    ),
    Job::new(
        "event-log-cleanup",
        EVENT_LOG_CLEANUP_INTERVAL_MS,
        10_000,
        HOUR,
        |app, run| Box::pin(cleanups::event_log(app, run)),
    ),
    Job::new(
        "inbound-delivery-cleanup",
        INBOUND_CLEANUP_INTERVAL_MS,
        15_000,
        HOUR,
        |app, run| Box::pin(inbound::delivery_cleanup(app, run)),
    ),
    Job::fixed("bulk-action-gc", HOUR_MS, 30_000, HOUR, |app, run| {
        Box::pin(jobs::gc(app, run))
    }),
    Job::new(
        "credential-cleanup",
        CREDENTIAL_CLEANUP_INTERVAL_MS,
        20_000,
        HOUR,
        |app, run| Box::pin(cleanups::credentials(app, run)),
    ),
    Job::new(
        "blob-replicate",
        BLOB_REPLICATE_INTERVAL_MS,
        5_000,
        HOUR,
        |app, run| Box::pin(upkeep::replicate(app, run)),
    ),
    Job::new(
        "blob-orphans",
        BLOB_CLEANUP_INTERVAL_MS,
        30_000,
        HOUR,
        |app, run| Box::pin(upkeep::orphans(app, run)),
    )
    .switched_by(upkeep::sweeps),
    Job::new(
        "blob-integrity",
        BLOB_INTEGRITY_INTERVAL_MS,
        60_000,
        HOUR,
        |app, run| Box::pin(upkeep::integrity(app, run)),
    ),
    Job::new("backup", BACKUP_INTERVAL_MS, 5_000, HOUR, |app, run| {
        Box::pin(backups::job(app, run))
    })
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
        let tabled: Vec<&str> = table
            .lines()
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|rest| rest.split('`').next())
            .collect();
        assert!(JOBS.len() > 5);
        for job in JOBS {
            assert!(tabled.contains(&job.name), "{} is not tabled", job.name);
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
