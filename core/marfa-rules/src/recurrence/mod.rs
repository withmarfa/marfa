//! RFC 5545 recurrence, walked in the series' wall clock. Pure: no clock, no I/O.

mod calendar;
mod issues;
mod rule;
mod schedule;
mod walk;

#[cfg(test)]
mod tests;

pub use issues::{Issue, event_issues, is_event_time_zone, task_issues};
pub use schedule::{Input, Occurrence, Schedule, compile, span};
pub use walk::{Meter, Stop};

/// Candidates one unfolding may consider.
pub const WORK_LIMIT: u64 = 100_000;

pub const SERIES_OCCURRENCE_LIMIT: usize = 2_000;

pub const MAX_CHARACTERS: usize = 40_000;

pub const MAX_DATES: usize = 1_000;

/// Longest an event lasts, in seconds: a century of 366-day years.
pub const MAX_DURATION_SECONDS: f64 = 3_162_240_000.0;
