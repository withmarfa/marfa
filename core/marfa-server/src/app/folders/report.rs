//! A folder copy's report of its own sync, judged before the store is asked anything.

use chrono::{DateTime, SecondsFormat};
use serde_json::{Map, Value, json};

use crate::app::refusal::{Refusal, Result};
use crate::app::types::missing_field;

/// Largest count or sequence: the largest whole number a JSON number holds exactly.
pub const MOST: i64 = 9_007_199_254_740_991;

pub const PROBLEM_CODES: [&str; 8] = [
    "conflict",
    "refused",
    "credential_refused",
    "unreadable",
    "held_file",
    "unavailable",
    "root_gone",
    "settings_invalid",
];

const FIELDS: [&str; 8] = [
    "folder_store_id",
    "sequence",
    "last_success_at",
    "pending_uploads",
    "pending_downloads",
    "paused_removals",
    "first_sync_waiting",
    "problems",
];
const MOST_STORE_ID: usize = 128;

#[derive(Clone, Debug)]
pub struct Report {
    pub folder_store_id: String,
    pub sequence: i64,
    pub last_success_at: Option<String>,
    pub pending_uploads: i64,
    pub pending_downloads: i64,
    pub paused_removals: i64,
    pub first_sync_waiting: bool,
    pub problems: Vec<(&'static str, i64)>,
}

fn invalid(field: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    Refusal::validation(message.clone())
        .with_detail("field", field)
        .with_detail("errors", json!([{ "path": field, "message": message }]))
}

fn count(body: &Map<String, Value>, field: &str, least: i64) -> Result<i64> {
    let value = body.get(field).ok_or_else(|| missing_field(field))?;
    value
        .as_f64()
        .filter(|number| number.fract() == 0.0)
        .map(|number| number as i64)
        .filter(|number| (least..=MOST).contains(number))
        .ok_or_else(|| {
            invalid(
                field,
                format!("{field} is a whole number from {least} to {MOST}."),
            )
        })
}

fn store_id(body: &Map<String, Value>) -> Result<String> {
    let value = body
        .get("folder_store_id")
        .ok_or_else(|| missing_field("folder_store_id"))?;
    value
        .as_str()
        .filter(|id| {
            (1..=MOST_STORE_ID).contains(&id.len())
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .map(str::to_string)
        .ok_or_else(|| {
            invalid(
                "folder_store_id",
                "folder_store_id is 1 to 128 letters, digits, hyphens and underscores.",
            )
        })
}

/// A real UTC instant, written to the millisecond with a `Z`.
fn success_time(body: &Map<String, Value>) -> Result<Option<String>> {
    let value = body
        .get("last_success_at")
        .ok_or_else(|| missing_field("last_success_at"))?;
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|text| {
            text.ends_with('Z')
                && DateTime::parse_from_rfc3339(text)
                    .is_ok_and(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true) == *text)
        })
        .map(|text| Some(text.to_string()))
        .ok_or_else(|| {
            invalid(
                "last_success_at",
                "last_success_at is null or a UTC time such as 2026-10-03T09:30:00.000Z.",
            )
        })
}

fn problems(body: &Map<String, Value>) -> Result<Vec<(&'static str, i64)>> {
    let value = body.get("problems").ok_or_else(|| missing_field("problems"))?;
    let Some(listed) = value.as_array() else {
        return Err(invalid("problems", "problems must be a list."));
    };
    if listed.len() > PROBLEM_CODES.len() {
        return Err(invalid("problems", "problems names each code once."));
    }
    let mut found: Vec<(&'static str, i64)> = Vec::with_capacity(listed.len());
    for (index, problem) in listed.iter().enumerate() {
        let path = format!("problems.{index}");
        let Some(problem) = problem.as_object() else {
            return Err(invalid(&path, "A problem is an object."));
        };
        if let Some(extra) = problem.keys().find(|key| !matches!(key.as_str(), "code" | "count")) {
            return Err(invalid(
                &path,
                format!("A problem names a code and a count, not {extra}."),
            ));
        }
        let code = problem
            .get("code")
            .and_then(Value::as_str)
            .and_then(|code| PROBLEM_CODES.iter().find(|known| **known == code))
            .ok_or_else(|| invalid(&format!("{path}.code"), "That is not a problem code."))?;
        if found.iter().any(|(seen, _)| seen == code) {
            return Err(invalid(&format!("{path}.code"), "A code is named once."));
        }
        found.push((code, count(problem, "count", 0)?));
    }
    Ok(found)
}

impl Report {
    pub fn read(body: &Map<String, Value>) -> Result<Report> {
        let mut unknown: Vec<&str> = body
            .keys()
            .map(String::as_str)
            .filter(|key| !FIELDS.contains(key))
            .collect();
        if !unknown.is_empty() {
            unknown.sort_unstable();
            return Err(Refusal::validation(format!(
                "A report names no {}.",
                unknown.join(", ")
            ))
            .with_detail("unknown_body_fields", unknown));
        }
        let waiting = body
            .get("first_sync_waiting")
            .ok_or_else(|| missing_field("first_sync_waiting"))?
            .as_bool()
            .ok_or_else(|| {
                invalid("first_sync_waiting", "first_sync_waiting is true or false.")
            })?;
        Ok(Report {
            folder_store_id: store_id(body)?,
            sequence: count(body, "sequence", 1)?,
            last_success_at: success_time(body)?,
            pending_uploads: count(body, "pending_uploads", 0)?,
            pending_downloads: count(body, "pending_downloads", 0)?,
            paused_removals: count(body, "paused_removals", 0)?,
            first_sync_waiting: waiting,
            problems: problems(body)?,
        })
    }
}
