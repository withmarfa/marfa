//! The clock and the RFC 3339 times the store writes.

/// The store's clock. A debug build moves it by the milliseconds the
/// `clock-offset` fault names, negative to put it back, so a fixture can pass
/// minutes between two drains, or have the clock go backward, without waiting.
fn clock() -> std::time::SystemTime {
    let now = std::time::SystemTime::now();
    match crate::fault::named("clock-offset").and_then(|ms| ms.parse::<i64>().ok()) {
        Some(ms) if ms >= 0 => now + std::time::Duration::from_millis(ms.unsigned_abs()),
        Some(ms) => now - std::time::Duration::from_millis(ms.unsigned_abs()),
        None => now,
    }
}

pub fn now_iso() -> String {
    iso_at(clock())
}

/// The store's clock as milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    millis_at(clock())
}

/// The milliseconds since the Unix epoch at `at`, the epoch itself for a time before it.
pub(crate) fn millis_at(at: std::time::SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

pub(crate) fn iso_at(at: std::time::SystemTime) -> String {
    marfa_rules::time::written(millis_at(at))
}
