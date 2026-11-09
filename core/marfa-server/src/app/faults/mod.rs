//! Faults a test harness sets on a running server, each named for where it acts.
//! A build without test hooks carries none: every point answers as if nothing were armed.

macro_rules! point_list {
    ($each:ident) => {
        $each! {
        HOLD_WRITE = Hold "write" Write;
        HOLD_READ_HYDRATION = Hold "read-hydration" None;
        HOLD_READ_SNAPSHOT = Hold "read-snapshot" None;
        HOLD_THINNING_ITEM = Hold "version-thinning:item" None;
        HOLD_BULK_PAGE = Hold "bulk-page" Nth;
        HOLD_EXPORT_PAGE = Hold "export-page" Nth;
        HOLD_RESTORE_ITEM = Hold "restore:item" Nth;
        HOLD_RESTORE_COMMIT = Hold "restore:before-commit" None;
        HOLD_BACKUP_PUT = Hold "backup:put" None;
        HOLD_STREAM_OPEN = Hold "stream-open" None;
        HOLD_STREAM_HEAD = Hold "stream-head" None;
        HOLD_STREAM_REPLAY = Hold "stream-replay" None;
        HOLD_STREAM_DRAIN = Hold "stream-drain" None;
        HOLD_FOLDER_STATUS_READ = Hold "folder-status-read" None;
        HOLD_WEBHOOK_RESPONSE = Hold "webhook:response" None;
        HOLD_WEBHOOK_SCHEDULE = Hold "webhook-schedule" None;
        HOLD_WEBHOOK_SCHEDULE_QUEUED = Hold "webhook-schedule:queued" None;
        HOLD_CONNECTOR_WRITE = Hold "connector-write" None;
        HOLD_INBOUND_RESERVED = Hold "inbound-reserved" Nth;
        HOLD_ATTENTION = Hold "attention" Write;
        FAIL_ATTENTION = Fail "attention" Write;
        HOLD_JOB_SELECTED = Hold "bulk-job:selected" None;
        HOLD_JOB_CLAIMED = Hold "bulk-job:claimed" None;
        HOLD_JOB_IN_CHUNK = Hold "bulk-job:in-chunk" None;
        HOLD_JOB_BETWEEN_CHUNKS = Hold "bulk-job:between-chunks" Nth;
        HOLD_JOB_FINISHING = Hold "bulk-job:finishing" None;
        FAIL_STREAM_HEAD = Fail "stream-head" Nth;
        FAIL_STREAM_REPLAY = Fail "stream-replay" Nth;
        FAIL_STREAM_CREDENTIAL = Fail "stream-credential" Nth;
        FAIL_STREAM_REPLAY_ROW = Fail "stream-replay-row" Nth;
        FAIL_STREAM_REPLAY_UNTYPED = Fail "stream-replay-untyped" Nth;
        FAIL_LOCK = Fail "lock" Nth;
        FAIL_AUDIT = Fail "audit" Write;
        FAIL_COMMIT = Fail "commit" Write;
        FAIL_COMMIT_FULL = Fail "commit-full" Write;
        FAIL_COMMIT_ACK = Fail "commit-ack" Write;
        FAIL_SESSION_LOOKUP = Fail "session-lookup" Nth;
        FAIL_SESSION_DELETE = Fail "session-delete" Nth;
        FAIL_SESSION_USE = Fail "session-use" Nth;
        FAIL_BLOB_WRITE = Fail "blob-write" Nth;
        FAIL_BLOB_READ = Fail "blob-read" Nth;
        FAIL_BLOB_READ_SHORT = Fail "blob-read-short" Nth;
        FAIL_BLOB_DELETE = Fail "blob-delete" Nth;
        HOLD_BLOB_HAS = Hold "blob-has" None;
        HOLD_BLOB_READ = Hold "blob-read" Nth;
        HOLD_BLOB_WRITE = Hold "blob-write" None;
        HOLD_BLOB_DELETE = Hold "blob-delete" None;
        HOLD_BLOB_PURGE = Hold "blob-orphans:purge" None;
        FAIL_HEALTH_WRITE = Fail "health-write" Nth;
        FAIL_EXPORT_READ = Fail "export-read" Nth;
        HOLD_DISK_PROBE = Hold "disk-probe" None;
        HOLD_METRICS = Hold "metrics" None;
        FAIL_JOB_ROW = Fail "job-row" Nth;
        FAIL_INBOUND_RECEIPT = Fail "inbound-receipt" Nth;
        FAIL_INBOUND_CLEANUP = Fail "inbound-cleanup" Nth;
        FAIL_FOLDER_STATUS_REPORT = Fail "folder-status-report" Nth;
        REFUSE_READ = Refuse "read" None;
        REFUSE_WRITE = Refuse "write" None;
        REFUSE_WRITE_LOCK = Refuse "write-lock" None;
        REFUSE_BLOB_STORE = Refuse "blob-store" None;
        }
    };
}

/// `judged>reached` lets a public-address check connect to a local fixture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub judged: Vec<std::net::IpAddr>,
    pub reached: Vec<std::net::IpAddr>,
}

/// What a blob fault makes the disk store read of a blob it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lie {
    Lost,
    Unreadable,
    Damaged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Volume {
    Database,
    Blobs,
}

/// Lanes whose attempt cap a `limit:<lane>=<n>` fault lowers.
pub const DEVICE_OWNER_INSTANCE_LANE: &str = "device-owner-instance";
/// Stored values an `unreadable:<stored>=<id>` fault makes the server read as damaged.
pub const TYPE_DEFINITION: &str = "type-definition";

#[cfg(feature = "test-hooks")]
mod armed;
#[cfg(feature = "test-hooks")]
pub use armed::*;

#[cfg(not(feature = "test-hooks"))]
mod absent;
#[cfg(not(feature = "test-hooks"))]
pub use absent::*;
