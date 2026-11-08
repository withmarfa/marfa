//! `GET /occurrences`: nothing is stored, every series is unfolded from its rule on the read.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use marfa_rules::recurrence::{
    Input, Meter, SERIES_OCCURRENCE_LIMIT, Stop, WORK_LIMIT, compile, span,
};
use marfa_rules::time;
use serde_json::{Value, json};

use super::App;
use super::access::Caller;
use super::items::{Many, listed, reading};
use super::query::{Event, Recurrence, events, parents};
use super::refusal::{Refusal, Result};

pub const MAX_WINDOW_DAYS: i64 = 400;
pub const MAX_OCCURRENCES: usize = 5000;
const MAX_SERIES_ERRORS: usize = 500;
const MAX_ERROR_CHARACTERS: usize = 200;
/// Candidates the series of one request may spend unfolding to nothing before the rest go unreached.
const UNPRODUCTIVE_BUDGET: u64 = 2_000_000;
const TIME_BOUND: Duration = Duration::from_millis(1000);

pub struct Window {
    pub from: i64,
    pub to: i64,
    pub type_filter: Option<String>,
}

pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// One with no length overlaps where it starts.
fn overlaps(start: i64, end: i64, window: &Window) -> bool {
    if start >= window.to {
        return false;
    }
    if end > start {
        end > window.from
    } else {
        start >= window.from
    }
}

struct Shown {
    row: usize,
    start: i64,
    end: Option<i64>,
    series: Option<usize>,
    replaces: Option<i64>,
}

#[derive(Default)]
struct Errors {
    listed: Vec<(String, String)>,
    count: usize,
}

impl Errors {
    fn push(&mut self, id: &str, message: String) {
        self.count += 1;
        if self.listed.len() >= MAX_SERIES_ERRORS {
            return;
        }
        let message = if message.chars().count() > MAX_ERROR_CHARACTERS {
            let cut: String = message.chars().take(MAX_ERROR_CHARACTERS).collect();
            format!("{cut}…")
        } else {
            message
        };
        self.listed.push((id.to_string(), message));
    }
}

fn input(event: &Event) -> Option<Input<'_>> {
    Some(Input {
        starts_at: event.starts_at.as_deref()?,
        ends_at: event.ends_at.as_deref(),
        duration: event.duration,
        all_day: event.all_day,
        timezone: event.timezone.as_deref(),
        recurrence: &[],
    })
}

fn rule_lines(event: &Event) -> (Option<Vec<&str>>, Option<String>) {
    let id = &event.id;
    match &event.recurrence {
        Recurrence::Absent => (None, None),
        Recurrence::NotAList => (
            None,
            Some(format!(
                "Series {id} has a recurrence that is not a list of RFC 5545 property lines, so no rule was applied"
            )),
        ),
        Recurrence::Entries(entries) if entries.is_empty() => (None, None),
        Recurrence::Entries(entries) => {
            let lines: Vec<&str> = entries.iter().filter_map(Value::as_str).collect();
            let dropped = entries.len() - lines.len();
            if lines.is_empty() {
                return (
                    None,
                    Some(format!(
                        "Series {id} has a recurrence holding no readable property line, so no rule was applied"
                    )),
                );
            }
            let defect = (dropped > 0).then(|| {
                format!(
                    "Series {id} has {dropped} recurrence {}; {} ignored and the rest of the rule was applied",
                    if dropped == 1 {
                        "entry that is not a property line"
                    } else {
                        "entries that are not property lines"
                    },
                    if dropped == 1 { "it was" } else { "they were" },
                )
            });
            (Some(lines), defect)
        }
    }
}

fn is_series(event: &Event) -> bool {
    match &event.recurrence {
        Recurrence::Absent => false,
        Recurrence::Entries(entries) => !entries.is_empty(),
        Recurrence::NotAList => true,
    }
}

/// A row whose start cannot be read is shown at `slot`.
fn shown_times(event: &Event, slot: i64) -> (i64, Option<i64>) {
    let Some(base) = input(event) else {
        return (slot, None);
    };
    if event.all_day {
        return match span(&base) {
            Ok((start, end)) => (start, Some(end)),
            Err(_) => (slot, None),
        };
    }
    let start = time::epoch_ms(base.starts_at).unwrap_or(slot);
    (start, base.ends_at.and_then(time::epoch_ms))
}

pub async fn read(app: &App, caller: &Caller, window: Window) -> Result<String> {
    let faults = app.faults.clone();
    reading(app, caller, move |read| {
        let rows = events(read, window.type_filter.as_deref())?;
        let rules = &read.catalog.rules;
        let answered = |row: &Event| {
            window
                .type_filter
                .as_deref()
                .is_none_or(|named| rules.matches(named, &row.type_id))
        };
        let by_id: HashMap<&str, usize> = rows
            .iter()
            .enumerate()
            .map(|(at, row)| (row.id.as_str(), at))
            .collect();
        let series_rows: Vec<usize> = (0..rows.len()).filter(|at| is_series(&rows[*at])).collect();
        let slot_of = |row: &Event| row.original_starts_at.as_deref().and_then(time::epoch_ms);
        let exception_rows: Vec<usize> = (0..rows.len())
            .filter(|at| rows[*at].original_starts_at.is_some())
            .collect();

        let mut bound: HashMap<usize, usize> = HashMap::new();
        let targets: Vec<&str> = exception_rows.iter().map(|at| rows[*at].id.as_str()).collect();
        for (source, target) in parents(read, &targets)? {
            let (Some(&series), Some(&exception)) =
                (by_id.get(source.as_str()), by_id.get(target.as_str()))
            else {
                continue;
            };
            if is_series(&rows[series])
                && rows[exception].original_starts_at.is_some()
                && read.caller.may_read_edge("parent-of", &rows[series].type_id)
            {
                bound.entry(exception).or_insert(series);
            }
        }
        let mut moved: HashMap<usize, Vec<(usize, i64)>> = HashMap::new();
        for (exception, series) in &bound {
            if let Some(slot) = slot_of(&rows[*exception]) {
                moved.entry(*series).or_default().push((*exception, slot));
            }
        }
        for slots in moved.values_mut() {
            slots.sort_by_key(|(exception, _)| *exception);
        }

        let mut shown: Vec<Shown> = Vec::new();
        let mut push = |entry: Shown| -> Result<()> {
            if shown.len() >= MAX_OCCURRENCES {
                return Err(Refusal::validation(format!(
                    "This window holds more than {MAX_OCCURRENCES} occurrences; narrow it"
                ))
                .with_detail("max_occurrences", MAX_OCCURRENCES));
            }
            shown.push(entry);
            Ok(())
        };
        let mut errors = Errors::default();
        let mut unexpanded: usize = 0;
        let mut unproductive: u64 = 0;
        let mut consumed: HashSet<usize> = HashSet::new();
        let deadline = faults.unfold_deadline().unwrap_or(TIME_BOUND);

        for &at in &series_rows {
            let row = &rows[at];
            if !answered(row) {
                continue;
            }
            let (lines, defect) = rule_lines(row);
            if let Some(defect) = defect {
                errors.push(&row.id, defect);
            }
            let Some(lines) = lines else { continue };
            if row.starts_at.is_none() {
                errors.push(
                    &row.id,
                    format!(
                        "Series {} carries a recurrence rule but no readable starts_at to unfold it from",
                        row.id
                    ),
                );
                continue;
            }
            if unproductive >= UNPRODUCTIVE_BUDGET {
                unexpanded += 1;
                continue;
            }
            let Some(base) = input(row) else { continue };
            let schedule = match compile(&Input {
                recurrence: &lines,
                ..base
            }) {
                Ok(schedule) => schedule,
                Err(why) => {
                    errors.push(
                        &row.id,
                        format!("Series {} has an unreadable recurrence rule: {why}", row.id),
                    );
                    continue;
                }
            };
            let slots = moved.get(&at).map(Vec::as_slice).unwrap_or_default();
            let named: Vec<i64> = slots.iter().map(|(_, slot)| *slot).collect();
            let started = Instant::now();
            let expired = || started.elapsed() >= deadline;
            let mut meter = Meter::with_clock(WORK_LIMIT, &expired);
            let unfolded = schedule.unfold(window.from, window.to, &mut meter, SERIES_OCCURRENCE_LIMIT, &named);
            match unfolded {
                Err(stop) => {
                    unproductive += meter.spent();
                    unexpanded += 1;
                    let why = match stop {
                        Stop::Occurrences => format!(
                            "Series {} yields more than {SERIES_OCCURRENCE_LIMIT} occurrences in this window; narrow the window",
                            row.id
                        ),
                        Stop::Candidates => format!(
                            "Series {} was stopped before it reaches the window's end: the rule considers more than {WORK_LIMIT} candidates, so the rule is too costly to expand at read time",
                            row.id
                        ),
                        Stop::Time => format!(
                            "Series {} was stopped before it reaches the window's end: the rule takes too long to unfold, so the rule is too costly to expand at read time",
                            row.id
                        ),
                    };
                    errors.push(&row.id, why);
                }
                Ok(list) => {
                    if list.is_empty() {
                        unproductive += meter.spent();
                    }
                    for occurrence in list {
                        match occurrence.replaced_by {
                            Some(which) => {
                                let Some(&(exception, slot)) = slots.get(which) else {
                                    continue;
                                };
                                consumed.insert(exception);
                                let moved_row = &rows[exception];
                                if !answered(moved_row) {
                                    continue;
                                }
                                let own = input(moved_row).and_then(|own| span(&own).ok());
                                if own.is_some_and(|(start, end)| !overlaps(start, end, &window)) {
                                    continue;
                                }
                                let (start, end) = shown_times(moved_row, slot);
                                push(Shown {
                                    row: exception,
                                    start,
                                    end,
                                    series: Some(at),
                                    replaces: Some(slot),
                                })?;
                            }
                            None => push(Shown {
                                row: at,
                                start: occurrence.start_ms,
                                end: (occurrence.end_ms > occurrence.start_ms)
                                    .then_some(occurrence.end_ms),
                                series: Some(at),
                                replaces: None,
                            })?,
                        }
                    }
                }
            }
        }

        for (at, row) in rows.iter().enumerate() {
            if consumed.contains(&at) || !answered(row) {
                continue;
            }
            let Some(base) = input(row) else { continue };
            if matches!(&row.recurrence, Recurrence::Entries(entries) if entries.iter().any(Value::is_string)) {
                continue;
            }
            let (start, end) = match span(&base) {
                Ok(times) => times,
                Err(why) => {
                    errors.push(&row.id, format!("Event {} has a schedule that cannot be read: {why}", row.id));
                    continue;
                }
            };
            if !overlaps(start, end, &window) {
                continue;
            }
            let (series, replaces) = match bound.get(&at).and_then(|series| {
                slot_of(row).map(|slot| (*series, slot))
            }) {
                Some((series, slot)) => (Some(series), Some(slot)),
                None => (None, None),
            };
            let (start, end) = shown_times(row, start);
            push(Shown {
                row: at,
                start,
                end,
                series,
                replaces,
            })?;
        }

        shown.sort_by_key(|entry| entry.start);
        read.hydrating();
        let mut seqs: Vec<i64> = Vec::new();
        let mut place: HashMap<usize, usize> = HashMap::new();
        for entry in &shown {
            place.entry(entry.row).or_insert_with(|| {
                seqs.push(rows[entry.row].seq);
                seqs.len() - 1
            });
        }
        let items = listed(read, &seqs, &Many::default())?;
        let data: Vec<String> = shown
            .iter()
            .filter_map(|entry| {
                let item = place.get(&entry.row).and_then(|at| items.get(*at))?;
                let mut out = format!("{{\"starts_at\":\"{}\"", iso(entry.start));
                if let Some(end) = entry.end {
                    out.push_str(&format!(",\"ends_at\":\"{}\"", iso(end)));
                }
                out.push_str(",\"item\":");
                out.push_str(item);
                if let Some(series) = entry.series {
                    out.push_str(&format!(",\"series_id\":{}", json!(rows[series].id)));
                }
                if let Some(slot) = entry.replaces {
                    out.push_str(&format!(",\"replaces\":\"{}\"", iso(slot)));
                }
                out.push('}');
                Some(out)
            })
            .collect();

        let mut answer = format!(
            "{{\"data\":[{}],\"next_cursor\":null,\"window\":{},\"scan\":{}",
            data.join(","),
            json!({ "from": iso(window.from), "to": iso(window.to) }),
            json!({ "series_errors": errors.count, "series_unexpanded": unexpanded }),
        );
        if !errors.listed.is_empty() {
            let listed: Vec<Value> = errors
                .listed
                .iter()
                .map(|(id, message)| json!({ "item_id": id, "message": message }))
                .collect();
            answer.push_str(&format!(",\"series_errors\":{}", Value::Array(listed)));
        }
        if errors.count > errors.listed.len() {
            answer.push_str(",\"series_errors_truncated\":true");
        }
        if unexpanded > 0 {
            answer.push_str(",\"expansion_incomplete\":true");
        }
        answer.push('}');
        Ok(answer)
    })
    .await
}
