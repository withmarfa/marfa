use std::time::Duration;

use super::super::blobs::upkeep;
use super::super::{enrichment, inbound, items, jobs, oauth};
use super::{Job, cleanups, heartbeat};
use crate::settings::registry::{
    AUDIT_CLEANUP_INTERVAL_MS, AUTH_SESSION_CLEANUP_INTERVAL_MS, BLOB_CLEANUP_INTERVAL_MS,
    BLOB_INTEGRITY_INTERVAL_MS, BLOB_REPLICATE_INTERVAL_MS, DCR_CLIENT_CLEANUP_INTERVAL_MS,
    ENRICHMENT_INTERVAL_MS, EVENT_LOG_CLEANUP_INTERVAL_MS, FEED_EXPIRY_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS, INBOUND_CLEANUP_INTERVAL_MS, RATE_LIMIT_CLEANUP_INTERVAL_MS,
    REVOKED_KEY_REAP_INTERVAL_MS, TRASH_PURGE_INTERVAL_MS, VERSION_THINNING_INTERVAL_MS,
};

const HOUR: Duration = Duration::from_secs(3_600);
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;
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
    Job::new(
        "rate-limit-cleanup",
        RATE_LIMIT_CLEANUP_INTERVAL_MS,
        20_000,
        HOUR,
        |app, run| Box::pin(cleanups::rate_limit(app, run)),
    ),
    Job::new(
        "revoked-key-reap",
        REVOKED_KEY_REAP_INTERVAL_MS,
        45_000,
        HOUR,
        |app, run| Box::pin(cleanups::revoked_keys(app, run)),
    ),
    Job::new(
        "auth-session-cleanup",
        AUTH_SESSION_CLEANUP_INTERVAL_MS,
        10_000,
        HOUR,
        |app, run| Box::pin(oauth::sweep::sweep_expired(app, run)),
    ),
    Job::new(
        "dcr-client-cleanup",
        DCR_CLIENT_CLEANUP_INTERVAL_MS,
        25_000,
        HOUR,
        |app, run| Box::pin(oauth::sweep::remove_idle_clients(app, run)),
    ),
    Job::fixed("revoked-grant-purge", HOUR_MS, 20_000, HOUR, |app, run| {
        Box::pin(oauth::sweep::purge_withdrawn_grants(app, run))
    }),
    Job::fixed("bulk-action-gc", HOUR_MS, 30_000, HOUR, |app, run| {
        Box::pin(jobs::gc(app, run))
    }),
    Job::fixed(
        "grant-inactivity-retirement",
        DAY_MS,
        40_000,
        HOUR,
        |app, run| Box::pin(oauth::sweep::retire_idle_grants(app, run)),
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
];
