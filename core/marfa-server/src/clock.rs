use std::sync::atomic::{AtomicI64, Ordering};

use chrono::{DateTime, TimeDelta, Utc};

static OFFSET_MS: AtomicI64 = AtomicI64::new(0);

pub fn set_offset_ms(offset: i64) {
    OFFSET_MS.store(offset, Ordering::Relaxed);
}

pub fn now() -> DateTime<Utc> {
    Utc::now() + TimeDelta::milliseconds(OFFSET_MS.load(Ordering::Relaxed))
}

/// The contract's time: UTC to the millisecond, `YYYY-MM-DDTHH:mm:ss.sssZ`.
pub fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn now_stamp() -> String {
    stamp(now())
}
