//! Every housekeeping job. A later area adds a job with one entry here, and an
//! interval in `settings/registry.rs`.

use std::time::Duration;

use super::super::items;
use super::{Job, cleanups, heartbeat};
use crate::settings::registry::{
    AUDIT_CLEANUP_INTERVAL_MS, EVENT_LOG_CLEANUP_INTERVAL_MS, FEED_EXPIRY_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS, RATE_LIMIT_CLEANUP_INTERVAL_MS, REVOKED_KEY_REAP_INTERVAL_MS,
    TRASH_PURGE_INTERVAL_MS, VERSION_THINNING_INTERVAL_MS,
};

const HOUR: Duration = Duration::from_secs(3_600);
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
        "rate-limit-cleanup",
        RATE_LIMIT_CLEANUP_INTERVAL_MS,
        20_000,
        HOUR,
        |app, run| Box::pin(cleanups::rate_limit(app, run)),
    )
    .without_statements(),
    Job::new(
        "revoked-key-reap",
        REVOKED_KEY_REAP_INTERVAL_MS,
        45_000,
        HOUR,
        |app, run| Box::pin(cleanups::revoked_keys(app, run)),
    ),
];
