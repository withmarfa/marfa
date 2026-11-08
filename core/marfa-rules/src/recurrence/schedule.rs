//! A series read once, ready to be unfolded over any window.

use std::collections::{BTreeSet, HashSet};
use std::ops::ControlFlow;

use super::calendar::{DAY, Zone};
use super::rule::{DAILY, DateValue, Refusal, Rule, read_date_value, read_rule, split_line};
use super::walk::{Meter, Stop, prepare, walk_rule};
use super::{MAX_CHARACTERS, MAX_DATES, MAX_DURATION_SECONDS};
use crate::time;

/// What a series states about when it happens.
#[derive(Clone, Copy, Debug)]
pub struct Input<'a> {
    /// The first occurrence: an instant, or a bare date for a whole day.
    pub starts_at: &'a str,
    pub ends_at: Option<&'a str>,
    /// A length in seconds, read when there is no `ends_at`.
    pub duration: Option<f64>,
    pub all_day: bool,
    /// The IANA zone the schedule keeps its wall clock in; none means UTC.
    pub timezone: Option<&'a str>,
    pub recurrence: &'a [&'a str],
}

/// One time a series happens, computed from its rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Occurrence {
    pub start_ms: i64,
    pub end_ms: i64,
    pub replaced_by: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
enum Length {
    Millis(i64),
    Days(i64),
}

#[derive(Clone, Debug)]
pub struct Schedule {
    zone: Zone,
    all_day: bool,
    start_ms: i64,
    start_wall: i64,
    rules: Vec<Rule>,
    rdates: Vec<i64>,
    ex_instants: HashSet<i64>,
    ex_days: HashSet<i64>,
    length: Length,
}

pub fn is_duration(duration: f64) -> bool {
    duration.is_finite() && (0.0..=MAX_DURATION_SECONDS).contains(&duration)
}

/// A bare `YYYY-MM-DD`, as a day number.
fn bare_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let ms = time::epoch_ms(value)?;
    Some(ms.div_euclid(1000).div_euclid(DAY))
}

fn day_of_value(value: &str, zone: Zone) -> Option<i64> {
    match bare_day(value) {
        Some(day) => Some(day),
        None => Some(zone.day_of(time::epoch_ms(value)?)),
    }
}

/// The span an event occupies, in milliseconds: a whole-day event from midnight of its first day
/// to midnight of the day its end names, any other from its start to its end, or to its start
/// plus its duration. The input's `recurrence` is not read.
pub fn span(input: &Input<'_>) -> Result<(i64, i64), Refusal> {
    if input.all_day {
        return Ok(compile(&Input {
            recurrence: &[],
            ..*input
        })?
        .span());
    }
    let start =
        time::epoch_ms(input.starts_at).ok_or_else(|| "starts_at cannot be read".to_string())?;
    let end = match (input.ends_at.and_then(time::epoch_ms), input.duration) {
        (Some(end), _) => end,
        (None, Some(duration)) if is_duration(duration) => {
            start + (duration * 1000.0).round() as i64
        }
        _ => start,
    };
    Ok((start, end.max(start)))
}

/// Reads a schedule against its start, refusing what cannot be read or would not be applied as
/// written.
pub fn compile(input: &Input<'_>) -> Result<Schedule, Refusal> {
    let zone = match input.timezone {
        None => Zone::UTC,
        Some(name) => {
            Zone::named(name).ok_or_else(|| format!("the timezone does not resolve: {name}"))?
        }
    };
    let parsed_start =
        time::epoch_ms(input.starts_at).ok_or_else(|| "starts_at cannot be read".to_string())?;
    let (start_ms, start_wall) = if input.all_day {
        let day = day_of_value(input.starts_at, zone)
            .ok_or_else(|| "starts_at cannot be read".to_string())?;
        (zone.midnight(day), day * DAY)
    } else {
        let start_ms = parsed_start.div_euclid(1000) * 1000;
        (start_ms, zone.wall_of(start_ms))
    };
    let start_time = start_wall.rem_euclid(DAY);
    let anchor = |value: DateValue| match value {
        DateValue::Instant(ms) => ms,
        DateValue::Date(day) if input.all_day => zone.midnight(day),
        DateValue::Date(day) => zone.instant_of(day * DAY + start_time),
        DateValue::Floating(wall) if input.all_day => zone.midnight(wall.div_euclid(DAY)),
        DateValue::Floating(wall) => zone.instant_of(wall),
    };

    if let Some(duration) = input.duration
        && !is_duration(duration)
    {
        return Err(format!(
            "duration must be between 0 and {MAX_DURATION_SECONDS} seconds"
        ));
    }
    let mut characters = 0;
    let mut rrules = 0;
    for line in input.recurrence {
        characters += line.chars().count();
        if characters > MAX_CHARACTERS {
            return Err(format!(
                "a recurrence may hold at most {MAX_CHARACTERS} characters in all"
            ));
        }
        let head = line.trim_start().get(..6).map(str::to_uppercase);
        if head.as_deref().is_some_and(|head| {
            head.starts_with("RRULE") && matches!(head.as_bytes()[5], b';' | b':')
        }) {
            rrules += 1;
        }
    }
    if rrules > 1 {
        return Err("a series carries at most one RRULE".to_string());
    }

    let mut rules = Vec::new();
    let mut rdates = Vec::new();
    let mut ex_instants = HashSet::new();
    let mut ex_days = HashSet::new();
    let mut dates = 0;
    let mut counted = |count: usize| {
        dates += count;
        if dates > MAX_DATES {
            Err(format!(
                "a series may add and remove at most {MAX_DATES} dates"
            ))
        } else {
            Ok(())
        }
    };
    for raw in input.recurrence {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let parts = split_line(line)?;
        match parts.name.as_str() {
            "RRULE" => {
                let rule = read_rule(parts.value)?;
                if input.all_day
                    && (rule.freq < DAILY
                        || rule.byhour.is_some()
                        || rule.byminute.is_some()
                        || rule.bysecond.is_some())
                {
                    return Err(
                        "a whole-day series repeats by days, not by hours, minutes or seconds"
                            .to_string(),
                    );
                }
                rules.push(rule);
            }
            "RDATE" => {
                if parts.params.get("VALUE").copied() == Some("PERIOD") {
                    return Err("RDATE periods are not applied; give each added start as a date or date-time".to_string());
                }
                let values: Vec<&str> = parts.value.split(',').collect();
                counted(values.len())?;
                for value in values {
                    rdates.push(anchor(read_date_value(value, &parts.params)?));
                }
            }
            "EXDATE" => {
                let values: Vec<&str> = parts.value.split(',').collect();
                counted(values.len())?;
                for value in values {
                    match read_date_value(value, &parts.params)? {
                        DateValue::Date(day) => {
                            ex_days.insert(day);
                        }
                        DateValue::Floating(wall) if input.all_day => {
                            ex_days.insert(wall.div_euclid(DAY));
                        }
                        DateValue::Instant(ms) if input.all_day => {
                            ex_days.insert(zone.day_of(ms));
                        }
                        other => {
                            ex_instants.insert(anchor(other));
                        }
                    }
                }
            }
            "EXRULE" => {
                return Err("EXRULE is not applied; express exclusions as EXDATE lines".to_string());
            }
            name => {
                return Err(format!(
                    "{name} is not a recurrence property; use RRULE, RDATE or EXDATE"
                ));
            }
        }
    }

    let end = input.ends_at.and_then(time::epoch_ms);
    let length = if input.all_day {
        let days = match (
            input.ends_at.and_then(|end| day_of_value(end, zone)),
            input.duration,
        ) {
            (Some(end_day), _) => end_day - start_wall / DAY,
            (None, Some(duration)) => (duration / DAY as f64).ceil() as i64,
            (None, None) => 1,
        };
        Length::Days(days.max(1))
    } else {
        let millis = match (end, input.duration) {
            (Some(end), _) => end - parsed_start,
            (None, Some(duration)) => (duration * 1000.0).round() as i64,
            (None, None) => 0,
        };
        Length::Millis(millis.max(0))
    };

    Ok(Schedule {
        zone,
        all_day: input.all_day,
        start_ms,
        start_wall,
        rules,
        rdates,
        ex_instants,
        ex_days,
        length,
    })
}

impl Schedule {
    pub fn start_ms(&self) -> i64 {
        self.start_ms
    }

    /// When an occurrence starting at `start_ms` ends, in milliseconds.
    pub fn end_of(&self, start_ms: i64) -> i64 {
        match self.length {
            Length::Millis(length) => start_ms + length,
            Length::Days(days) => self.zone.midnight(self.zone.day_of(start_ms) + days),
        }
    }

    fn max_length_ms(&self) -> i64 {
        match self.length {
            Length::Millis(length) => length,
            Length::Days(days) => days * 86_400_000 + 3_600_000,
        }
    }

    fn anchor_wall(&self, wall: i64) -> i64 {
        if self.all_day {
            self.zone.midnight(wall.div_euclid(DAY))
        } else {
            self.zone.instant_of(wall)
        }
    }

    fn past_until(&self, until: DateValue, wall: i64) -> bool {
        match until {
            DateValue::Date(day) => wall.div_euclid(DAY) > day,
            DateValue::Floating(until_wall) => wall > until_wall,
            DateValue::Instant(ms) => {
                let until_wall = self.zone.wall_of(ms);
                if wall < until_wall - DAY {
                    false
                } else if wall > until_wall + DAY {
                    true
                } else {
                    self.anchor_wall(wall) > ms
                }
            }
        }
    }

    /// The furthest reading an UNTIL can still admit.
    fn until_stop(&self, until: Option<DateValue>) -> i64 {
        match until {
            None => i64::MAX,
            Some(DateValue::Date(day)) => (day + 1) * DAY - 1,
            Some(DateValue::Floating(wall)) => wall,
            Some(DateValue::Instant(ms)) => self.zone.wall_of(ms) + DAY,
        }
    }

    /// The start of every occurrence overlapping `[from_ms, to_ms)`, ascending, with removed
    /// dates taken out. An occurrence of no length overlaps where it starts. The series' own
    /// start is always the first occurrence. More than `cap` occurrences stop the walk.
    pub fn starts(
        &self,
        from_ms: i64,
        to_ms: i64,
        meter: &mut Meter<'_>,
        cap: usize,
    ) -> Result<Vec<i64>, Stop> {
        let low = from_ms - self.max_length_ms();
        let low_wall = self.zone.wall_of(low) - DAY;
        let high_wall = self.zone.wall_of(to_ms) + DAY;
        let mut found: BTreeSet<i64> = BTreeSet::new();
        let mut consider = |ms: i64| -> Result<(), Stop> {
            if ms >= to_ms || ms < low {
                return Ok(());
            }
            let end = self.end_of(ms);
            if !(end > from_ms || (end == ms && ms >= from_ms)) {
                return Ok(());
            }
            if self.ex_instants.contains(&ms)
                || (!self.ex_days.is_empty() && self.ex_days.contains(&self.zone.day_of(ms)))
            {
                return Ok(());
            }
            found.insert(ms);
            if found.len() > cap {
                return Err(Stop::Occurrences);
            }
            Ok(())
        };

        consider(self.start_ms)?;
        for rule in &self.rules {
            let walk = prepare(rule, self.start_wall);
            let mut produced: i64 = 1;
            let stop_wall = high_wall.min(self.until_stop(rule.until));
            walk_rule(&walk, self.start_wall, stop_wall, meter, &mut |wall| {
                if wall == self.start_wall {
                    return Ok(ControlFlow::Continue(()));
                }
                if rule.count.is_some_and(|count| produced >= count) {
                    return Ok(ControlFlow::Break(()));
                }
                if rule.until.is_some_and(|until| self.past_until(until, wall)) {
                    return Ok(ControlFlow::Break(()));
                }
                produced += 1;
                if wall >= low_wall {
                    consider(self.anchor_wall(wall))?;
                }
                Ok(ControlFlow::Continue(()))
            })?;
        }
        for ms in &self.rdates {
            consider(*ms)?;
        }
        Ok(found.into_iter().collect())
    }

    /// The occurrences overlapping the window. A stored exception whose `moved[i]` names an
    /// occurrence's start takes its place: the occurrence says `replaced_by: Some(i)`.
    pub fn unfold(
        &self,
        from_ms: i64,
        to_ms: i64,
        meter: &mut Meter<'_>,
        cap: usize,
        moved: &[i64],
    ) -> Result<Vec<Occurrence>, Stop> {
        Ok(self
            .starts(from_ms, to_ms, meter, cap)?
            .into_iter()
            .map(|start_ms| Occurrence {
                start_ms,
                end_ms: self.end_of(start_ms),
                replaced_by: moved.iter().position(|slot| *slot == start_ms),
            })
            .collect())
    }

    /// Why a rule could not be unfolded when it is written, or `None` when every rule produces an
    /// occurrence after the start within the meter or ends by its own COUNT or UNTIL.
    pub fn problem(&self, meter: &mut Meter<'_>) -> Option<String> {
        for rule in &self.rules {
            if rule.count == Some(1) {
                continue;
            }
            if names_no_day(rule) {
                return Some("the rule never produces an occurrence after the start: no month it names has a day it names".to_string());
            }
            let walk = prepare(rule, self.start_wall);
            let mut found = false;
            let walked = walk_rule(
                &walk,
                self.start_wall,
                self.until_stop(rule.until),
                meter,
                &mut |wall| {
                    if wall == self.start_wall {
                        return Ok(ControlFlow::Continue(()));
                    }
                    found = true;
                    Ok(ControlFlow::Break(()))
                },
            );
            if walked.is_err() {
                return Some(format!(
                    "the rule produces no occurrence after the start within {} candidates, so it cannot be unfolded",
                    meter.limit()
                ));
            }
            if !found && rule.until.is_none() {
                return Some("the rule never produces an occurrence after the start: no date it names exists".to_string());
            }
        }
        None
    }

    /// The span the event occupies, single or repeating: its first occurrence.
    pub fn span(&self) -> (i64, i64) {
        (self.start_ms, self.end_of(self.start_ms))
    }
}

/// Whether no month a rule can reach has any day of the month it names.
fn names_no_day(rule: &Rule) -> bool {
    let Some(days) = &rule.bymonthday else {
        return false;
    };
    let longest = |month: i64| match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    let months: Vec<i64> = rule.bymonth.clone().unwrap_or_else(|| (1..=12).collect());
    !months
        .iter()
        .any(|month| days.iter().any(|day| day.abs() <= longest(*month)))
}
