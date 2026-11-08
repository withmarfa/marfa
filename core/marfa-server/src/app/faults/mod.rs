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
        HOLD_BLOB_READ = Hold "blob-read" Nth;
        HOLD_STREAM_OPEN = Hold "stream-open" None;
        HOLD_STREAM_HEAD = Hold "stream-head" None;
        HOLD_STREAM_REPLAY = Hold "stream-replay" None;
        HOLD_STREAM_DRAIN = Hold "stream-drain" None;
        HOLD_CONNECTOR_WRITE = Hold "connector-write" None;
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
        FAIL_HEALTH_WRITE = Fail "health-write" Nth;
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
