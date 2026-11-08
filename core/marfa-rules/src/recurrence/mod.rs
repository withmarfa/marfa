//! RFC 5545 recurrence: reading the lines of a series and unfolding them into start instants.
//!
//! The walk happens in the series' own wall clock, because "weekly at 09:00" means 09:00 as the
//! series' zone reads it on both sides of a clock change. A candidate is anchored to an instant
//! only once it matters, and a value that names an instant of its own (an `UNTIL` in UTC, an
//! `EXDATE` in another zone) is compared as that instant. Every candidate a walk considers is
//! charged to a [`Meter`], so a rule that never produces costs at most the meter's limit however
//! it is written. Nothing here reads a clock or does any I/O.

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

/// Candidates one unfolding may consider: a day of a daily, weekly, monthly or yearly rule, a
/// period of an hourly, minutely or secondly one, or each further time of day a matching day
/// carries.
pub const WORK_LIMIT: u64 = 100_000;

/// Occurrences one series may have in one window.
pub const SERIES_OCCURRENCE_LIMIT: usize = 2_000;

/// Most characters the lines of a `recurrence` hold in all.
pub const MAX_CHARACTERS: usize = 40_000;

/// Most dates a series adds and removes together.
pub const MAX_DATES: usize = 1_000;

/// Longest an event lasts, in seconds: a century of 366-day years.
pub const MAX_DURATION_SECONDS: f64 = 3_162_240_000.0;
