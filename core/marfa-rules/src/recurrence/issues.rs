//! What the schedule fields of an event and the `recurrence` of a task may hold, judged on a write.

use serde_json::{Map, Value};

use super::calendar::Zone;
use super::schedule::{Input, compile, is_duration};
use super::walk::Meter;
use super::{MAX_DURATION_SECONDS, WORK_LIMIT};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub field: &'static str,
    pub message: String,
}

fn issue(field: &'static str, message: impl Into<String>) -> Issue {
    Issue {
        field,
        message: message.into(),
    }
}

/// Whether `name` is an IANA zone name, spelled as the database spells it.
pub fn is_event_time_zone(name: &str) -> bool {
    Zone::named(name).is_some()
}

pub fn event_issues(properties: &Map<String, Value>) -> Vec<Issue> {
    let mut issues = Vec::new();
    if let Some(duration) = properties.get("duration").and_then(Value::as_f64)
        && !is_duration(duration)
    {
        issues.push(issue(
            "duration",
            format!("Expected a length in seconds from 0 to {MAX_DURATION_SECONDS}"),
        ));
    }
    for field in ["timezone", "end_timezone"] {
        match properties.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(name)) if is_event_time_zone(name) => {}
            Some(_) => issues.push(issue(
                field,
                "Expected an IANA time zone name the zone database resolves, e.g. Europe/Berlin",
            )),
        }
    }
    let unfold = !issues
        .iter()
        .any(|held| held.field == "timezone" || held.field == "duration");
    let timezone = properties.get("timezone").and_then(Value::as_str);
    issues.extend(recurrence_issues(
        properties,
        properties.get("starts_at"),
        unfold,
        "A recurrence rule needs starts_at to unfold from",
        Input {
            starts_at: "",
            ends_at: properties.get("ends_at").and_then(Value::as_str),
            duration: properties.get("duration").and_then(Value::as_f64),
            all_day: properties.get("all_day") == Some(&Value::Bool(true)),
            timezone,
            recurrence: &[],
        },
    ));
    issues
}

/// A task's rule starts at its `due_at`, or its `starts_at`, and advances in UTC.
pub fn task_issues(properties: &Map<String, Value>) -> Vec<Issue> {
    let start = properties
        .get("due_at")
        .filter(|held| !held.is_null())
        .or_else(|| properties.get("starts_at"));
    recurrence_issues(
        properties,
        start,
        true,
        "A recurrence rule needs due_at or starts_at to unfold from",
        Input {
            starts_at: "",
            ends_at: None,
            duration: None,
            all_day: false,
            timezone: None,
            recurrence: &[],
        },
    )
}

fn recurrence_issues(
    properties: &Map<String, Value>,
    starts_at: Option<&Value>,
    unfold: bool,
    missing_start: &str,
    base: Input<'_>,
) -> Vec<Issue> {
    let Some(Value::Array(entries)) = properties.get("recurrence") else {
        return Vec::new();
    };
    if entries.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = entries.iter().filter_map(Value::as_str).collect();
    if lines.len() != entries.len() {
        return vec![issue(
            "recurrence",
            "Expected every entry to be an RFC 5545 property line",
        )];
    }
    if !unfold {
        return Vec::new();
    }
    let Some(Value::String(starts_at)) = starts_at else {
        return vec![issue("recurrence", missing_start)];
    };
    let schedule = match compile(&Input {
        starts_at,
        recurrence: &lines,
        ..base
    }) {
        Ok(schedule) => schedule,
        Err(message) => return vec![issue("recurrence", capitalized(&message))],
    };
    match schedule.problem(&mut Meter::new(WORK_LIMIT)) {
        Some(message) => vec![issue("recurrence", capitalized(&message))],
        None => Vec::new(),
    }
}

fn capitalized(message: &str) -> String {
    let mut chars = message.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
