//! What a write is told while a restore holds the writer.

use super::refusal::{Code, Refusal};

pub const REASON: &str = "restore_running";

// The retry interval is fixed because the restore has no completion estimate.
const RETRY_SECONDS: i64 = 5;

pub const HEALTH: &str = "a restore is running and holds every write";

pub fn refusal() -> Refusal {
    Refusal::new(
        Code::WriteContention,
        "A restore is running and holds every write; nothing was written. Try again in a few seconds.",
    )
    .with_detail("reason", REASON)
    .with_detail("retry_after", RETRY_SECONDS)
}
