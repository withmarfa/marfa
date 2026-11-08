//! Walking one rule in the wall clock of its series, every candidate charged to a [`Meter`].

use std::ops::ControlFlow;

use super::calendar::{
    DAY, LAST_YEAR, ceil_div, civil_from_days, days_from_civil, days_in_month, is_leap, week_number,
    week_start, weekday,
};
use super::rule::{DAILY, HOURLY, MINUTELY, MONTHLY, Rule, SECONDLY, WEEKLY, YEARLY};

/// Why a walk stopped before it finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// The rule considered more candidates than it may.
    Candidates,
    /// The caller's clock ran out.
    Time,
    /// The series has more occurrences in the window than it may unfold.
    Occurrences,
}

/// Counts the candidates one walk considers. `expired` is the caller's clock, asked every 256
/// candidates, since a rule's own code reads none.
pub struct Meter<'a> {
    limit: u64,
    spent: u64,
    expired: Option<&'a dyn Fn() -> bool>,
}

impl<'a> Meter<'a> {
    pub fn new(limit: u64) -> Meter<'a> {
        Meter {
            limit,
            spent: 0,
            expired: None,
        }
    }

    pub fn with_clock(limit: u64, expired: &'a dyn Fn() -> bool) -> Meter<'a> {
        Meter {
            limit,
            spent: 0,
            expired: Some(expired),
        }
    }

    pub fn spent(&self) -> u64 {
        self.spent
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    pub fn charge(&mut self) -> Result<(), Stop> {
        self.spent += 1;
        if self.spent > self.limit {
            return Err(Stop::Candidates);
        }
        if self.spent % 256 == 0 && self.expired.is_some_and(|expired| expired()) {
            return Err(Stop::Time);
        }
        Ok(())
    }
}

/// A rule with the parts its start fills in.
pub struct Walk {
    rule: Rule,
    hours: Vec<i64>,
    minutes: Vec<i64>,
    seconds: Vec<i64>,
}

pub fn prepare(rule: &Rule, start_wall: i64) -> Walk {
    let start_day = start_wall.div_euclid(DAY);
    let (_, month, month_day) = civil_from_days(start_day);
    let tod = start_wall - start_day * DAY;
    let mut rule = rule.clone();
    let anchored = rule.byweekno.is_some()
        || rule.byyearday.is_some()
        || rule.bymonthday.is_some()
        || rule.byweekday.is_some()
        || rule.bynweekday.is_some();
    if !anchored {
        match rule.freq {
            YEARLY => {
                rule.bymonth.get_or_insert_with(|| vec![month]);
                rule.bymonthday = Some(vec![month_day]);
            }
            MONTHLY => rule.bymonthday = Some(vec![month_day]),
            WEEKLY => rule.byweekday = Some([weekday(start_day)].into()),
            _ => {}
        }
    }
    let hours = match (&rule.byhour, rule.freq > HOURLY) {
        (Some(held), _) => held.clone(),
        (None, true) => vec![tod / 3600],
        (None, false) => Vec::new(),
    };
    let minutes = match (&rule.byminute, rule.freq > MINUTELY) {
        (Some(held), _) => held.clone(),
        (None, true) => vec![tod % 3600 / 60],
        (None, false) => Vec::new(),
    };
    let seconds: Vec<i64> = match (&rule.bysecond, rule.freq > SECONDLY) {
        (Some(held), _) => held.clone(),
        (None, true) => vec![tod % 60],
        (None, false) => Vec::new(),
    }
    .into_iter()
    .filter(|second| *second < 60)
    .collect();
    Walk {
        rule,
        hours,
        minutes,
        seconds,
    }
}

fn list_has(list: &Option<Vec<i64>>, value: i64) -> bool {
    list.as_ref().is_none_or(|held| held.contains(&value))
}

/// Whether `day` passes the day-level parts of `rule`; `marked` holds the days a numbered BYDAY
/// chose in the current period.
fn day_matches(rule: &Rule, day: i64, marked: Option<&[i64]>) -> bool {
    let (y, m, d) = civil_from_days(day);
    if !list_has(&rule.bymonth, m) {
        return false;
    }
    if let Some(weeks) = &rule.byweekno {
        let (n, total) = week_number(day, rule.wkst);
        if !weeks.contains(&n) && !weeks.contains(&(n - total - 1)) {
            return false;
        }
    }
    if let Some(days) = &rule.byyearday {
        let number = day - days_from_civil(y, 1, 1) + 1;
        let length = if is_leap(y) { 366 } else { 365 };
        if !days.contains(&number) && !days.contains(&(number - length - 1)) {
            return false;
        }
    }
    if let Some(days) = &rule.bymonthday {
        let length = days_in_month(y, m);
        if !days.contains(&d) && !days.contains(&(d - length - 1)) {
            return false;
        }
    }
    if rule.byweekday.is_some() || rule.bynweekday.is_some() {
        let plain = rule
            .byweekday
            .as_ref()
            .is_some_and(|days| days.contains(&weekday(day)));
        if !plain && !marked.is_some_and(|days| days.contains(&day)) {
            return false;
        }
    }
    true
}

/// The days a numbered BYDAY picks out of each range of a period.
fn mark_numbered(rule: &Rule, ranges: &[(i64, i64)]) -> Option<Vec<i64>> {
    let numbered = rule.bynweekday.as_ref()?;
    let mut marked = Vec::new();
    for (first, last) in ranges {
        for (wd, n) in numbered {
            let day = if *n > 0 {
                first + (wd - weekday(*first)).rem_euclid(7) + (n - 1) * 7
            } else {
                last - (weekday(*last) - wd).rem_euclid(7) + (n + 1) * 7
            };
            if day >= *first && day <= *last {
                marked.push(day);
            }
        }
    }
    Some(marked)
}

/// The members a period's candidates, `size` of them, are narrowed to: all, or those BYSETPOS names.
fn positions(bysetpos: &Option<Vec<i64>>, size: usize) -> Box<dyn Iterator<Item = usize>> {
    let Some(wanted) = bysetpos else {
        return Box::new(0..size);
    };
    let mut picked: Vec<usize> = wanted
        .iter()
        .filter_map(|pos| {
            let at = if *pos > 0 {
                *pos - 1
            } else {
                size as i64 + pos
            };
            usize::try_from(at).ok().filter(|at| *at < size)
        })
        .collect();
    picked.sort_unstable();
    picked.dedup();
    Box::new(picked.into_iter())
}

pub type Emit<'a> = &'a mut dyn FnMut(i64) -> Result<ControlFlow<()>, Stop>;

/// Every reading `walk` produces at or after `start_wall`, ascending, in wall-clock seconds,
/// until one passes `stop_wall`, `emit` breaks or the calendar ends.
pub fn walk_rule(
    walk: &Walk,
    start_wall: i64,
    stop_wall: i64,
    meter: &mut Meter<'_>,
    emit: Emit<'_>,
) -> Result<(), Stop> {
    if walk.rule.freq >= DAILY {
        walk_days(walk, start_wall, stop_wall, meter, emit)
    } else {
        walk_clock(walk, start_wall, stop_wall, meter, emit)
    }
}

fn walk_days(
    walk: &Walk,
    start_wall: i64,
    stop_wall: i64,
    meter: &mut Meter<'_>,
    emit: Emit<'_>,
) -> Result<(), Stop> {
    let Walk {
        rule,
        hours,
        minutes,
        seconds,
    } = walk;
    let start_day = start_wall.div_euclid(DAY);
    let last_day = days_from_civil(LAST_YEAR, 12, 31);
    let stop_day = stop_wall.div_euclid(DAY).min(last_day);
    let times = hours.len() * minutes.len() * seconds.len();
    let time_at = |index: usize| {
        let inner = minutes.len() * seconds.len();
        hours[index / inner] * 3600
            + minutes[index % inner / seconds.len()] * 60
            + seconds[index % seconds.len()]
    };
    let (start_year, start_month, _) = civil_from_days(start_day);
    let start_week = week_start(start_day, rule.wkst);
    let mut k: i64 = 0;
    loop {
        let (first, last, ranges, months): (i64, i64, Vec<(i64, i64)>, Option<&Vec<i64>>) =
            match rule.freq {
                YEARLY => {
                    let y = start_year + k * rule.interval;
                    if y > LAST_YEAR {
                        return Ok(());
                    }
                    let first = days_from_civil(y, 1, 1);
                    let last = days_from_civil(y, 12, 31);
                    let ranges = match (&rule.bymonth, &rule.bynweekday) {
                        (Some(months), Some(_)) => months
                            .iter()
                            .map(|m| {
                                (
                                    days_from_civil(y, *m, 1),
                                    days_from_civil(y, *m, days_in_month(y, *m)),
                                )
                            })
                            .collect(),
                        _ => vec![(first, last)],
                    };
                    (first, last, ranges, rule.bymonth.as_ref())
                }
                MONTHLY => {
                    let index = start_year * 12 + (start_month - 1) + k * rule.interval;
                    let (y, m) = (index.div_euclid(12), index.rem_euclid(12) + 1);
                    if y > LAST_YEAR {
                        return Ok(());
                    }
                    let first = days_from_civil(y, m, 1);
                    let last = days_from_civil(y, m, days_in_month(y, m));
                    (first, last, vec![(first, last)], None)
                }
                WEEKLY => {
                    let first = start_week + k * rule.interval * 7;
                    (first, first + 6, Vec::new(), None)
                }
                _ => {
                    let first = start_day + k * rule.interval;
                    (first, first, Vec::new(), None)
                }
            };
        if first > stop_day {
            return Ok(());
        }

        let marked = mark_numbered(rule, &ranges);
        let mut days: Vec<i64> = Vec::new();
        let mut scan = |from: i64, to: i64, days: &mut Vec<i64>| -> Result<(), Stop> {
            for day in from..=to {
                meter.charge()?;
                if day_matches(rule, day, marked.as_deref()) {
                    days.push(day);
                }
            }
            Ok(())
        };
        if let Some(months) = months {
            let (y, _, _) = civil_from_days(first);
            for m in months {
                scan(
                    days_from_civil(y, *m, 1),
                    days_from_civil(y, *m, days_in_month(y, *m)),
                    &mut days,
                )?;
            }
        } else {
            scan(first, last, &mut days)?;
        }

        let mut previous = i64::MIN;
        for index in positions(&rule.bysetpos, days.len() * times) {
            let wall = days[index / times] * DAY + time_at(index % times);
            let day = wall.div_euclid(DAY);
            if day == previous {
                meter.charge()?;
            }
            previous = day;
            if wall < start_wall {
                continue;
            }
            if wall > stop_wall {
                return Ok(());
            }
            if emit(wall)?.is_break() {
                return Ok(());
            }
        }
        k += 1;
    }
}

/// Hourly, minutely and secondly: one period per step, skipping a whole day, hour or minute at
/// once when the parts above the period rule it out.
fn walk_clock(
    walk: &Walk,
    start_wall: i64,
    stop_wall: i64,
    meter: &mut Meter<'_>,
    emit: Emit<'_>,
) -> Result<(), Stop> {
    let Walk {
        rule,
        minutes,
        seconds,
        ..
    } = walk;
    let last_day = days_from_civil(LAST_YEAR, 12, 31);
    let unit: i64 = match rule.freq {
        HOURLY => 3600,
        MINUTELY => 60,
        _ => 1,
    };
    let step = unit * rule.interval;
    let base = start_wall - start_wall.rem_euclid(unit);
    let stop = stop_wall.min((last_day + 1) * DAY - 1);
    let inner = match rule.freq {
        HOURLY => minutes.len() * seconds.len(),
        MINUTELY => seconds.len(),
        _ => 1,
    };
    let mut k: i64 = 0;
    loop {
        let t = base + k * step;
        if t > stop {
            return Ok(());
        }
        meter.charge()?;
        let day = t.div_euclid(DAY);
        let tod = t - day * DAY;
        let skip_to = |wall: i64, k: &mut i64| *k = (*k + 1).max(ceil_div(wall - base, step));
        if !day_matches(rule, day, None) {
            skip_to((day + 1) * DAY, &mut k);
            continue;
        }
        let hour = tod / 3600;
        if rule.byhour.as_ref().is_some_and(|held| !held.contains(&hour)) {
            skip_to(day * DAY + (hour + 1) * 3600, &mut k);
            continue;
        }
        let minute = tod % 3600 / 60;
        if rule.freq <= MINUTELY && !list_has(&rule.byminute, minute) {
            skip_to(day * DAY + hour * 3600 + (minute + 1) * 60, &mut k);
            continue;
        }
        if rule.freq == SECONDLY && !list_has(&rule.bysecond, tod % 60) {
            k += 1;
            continue;
        }
        let at = |index: usize| match rule.freq {
            HOURLY => t + minutes[index / seconds.len()] * 60 + seconds[index % seconds.len()],
            MINUTELY => t + seconds[index],
            _ => t,
        };
        let mut first_in_period = true;
        for index in positions(&rule.bysetpos, inner) {
            if !first_in_period {
                meter.charge()?;
            }
            first_in_period = false;
            let wall = at(index);
            if wall < start_wall {
                continue;
            }
            if wall > stop_wall {
                return Ok(());
            }
            if emit(wall)?.is_break() {
                return Ok(());
            }
        }
        k += 1;
    }
}
