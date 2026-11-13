//! What a write is told while a restore holds the writer.

use super::refusal::{Code, Refusal};

/// The reason a refusal names when a restore is the cause.
pub const REASON: &str = "restore_running";

/// The server cannot tell how long a restore will run. Each refusal is answered at once, so
/// five seconds costs a client about ten of them across a 250,000-item restore.
const RETRY_SECONDS: i64 = 5;

/// What `GET /health` says of the write probe meanwhile.
pub const HEALTH: &str = "a restore is running and holds every write";

pub fn refusal() -> Refusal {
    Refusal::new(
        Code::WriteContention,
        "A restore is running and holds every write; nothing was written. Try again in a few seconds.",
    )
    .with_detail("reason", REASON)
    .with_detail("retry_after", RETRY_SECONDS)
}
