//! Late checks follow registration lookup and authorization to preserve refusal precedence.

use std::collections::HashSet;

use marfa_rules::{grammar, js, time};
use serde_json::{Map, Value};

use crate::app::refusal::{Code, Refusal, Result};

pub const MAX_STATE_BYTES: usize = 512 * 1024;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;
pub const MAX_PROBLEMS_BYTES: usize = 512 * 1024;
const MAX_PROBLEMS: usize = 200;
const MAX_PROBLEM_CHARACTERS: usize = 500;
const MAX_NAME: usize = 200;
const MAX_DESCRIPTION: usize = 2000;
const MAX_TYPES: usize = 1000;
const MAX_PROCESS: usize = 100;
const MAX_ITEM_ID: usize = 200;
const MAX_ROWS: usize = 500;
const MAX_TEXT: usize = 2000;

const REGISTER_FIELDS: [&str; 3] = ["name", "description", "read_only_types"];
const PROCESS_FIELDS: [&str; 1] = ["process"];
const RUN_FIELDS: [&str; 5] = ["outcome", "started_at", "finished_at", "summary", "error"];
const STATE_FIELDS: [&str; 3] = ["process", "state", "problems"];
const AGREEMENT_FIELDS: [&str; 3] = ["process", "set", "clear"];
const LOOKUP_FIELDS: [&str; 1] = ["item_ids"];

type Fields = Map<String, Value>;

fn missing(field: &str) -> Refusal {
    Refusal::new(Code::MissingRequiredField, format!("{field} is required."))
        .with_detail("field", field)
}

fn invalid(field: &str, message: impl Into<String>) -> Refusal {
    Refusal::validation(message.into()).with_detail("field", field)
}

/// Size limits use the wire format's number printing.
fn serialized(document: &Fields) -> Result<usize> {
    js::to_vec(document)
        .map(|bytes| bytes.len())
        .map_err(|_| Refusal::internal("a request document did not serialize"))
}

fn characters(text: &str) -> usize {
    text.chars().count()
}

fn required<'a>(fields: &'a Fields, name: &str, path: &str) -> Result<&'a Value> {
    fields.get(name).ok_or_else(|| missing(path))
}

fn text(value: &Value, path: &str, most: usize, least: usize) -> Result<String> {
    let held = value
        .as_str()
        .ok_or_else(|| invalid(path, format!("{path} must be text.")))?;
    let length = characters(held);
    if length < least || length > most {
        return Err(invalid(
            path,
            format!("{path} must hold {least} to {most} characters."),
        ));
    }
    Ok(held.to_string())
}

fn object(value: &Value, path: &str) -> Result<Fields> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid(path, format!("{path} must be an object.")))
}

fn process(fields: &Fields, path: &str) -> Result<String> {
    text(required(fields, "process", path)?, path, MAX_PROCESS, 1)
}

/// A top-level field the operation does not declare.
#[derive(Debug, Default)]
pub struct Stray(Vec<String>);

impl Stray {
    fn of(fields: &Fields, declared: &[&str]) -> Stray {
        let mut stray: Vec<String> = fields
            .keys()
            .filter(|name| !declared.contains(&name.as_str()))
            .cloned()
            .collect();
        stray.sort_unstable();
        Stray(stray)
    }

    pub fn refuse(&self) -> Result<()> {
        if self.0.is_empty() {
            return Ok(());
        }
        Err(Refusal::validation(format!(
            "The body names fields this operation does not take: {}.",
            self.0.join(", ")
        ))
        .with_detail("unknown_body_fields", self.0.clone()))
    }
}

pub struct Register {
    pub name: String,
    pub description: Option<String>,
    pub read_only_types: Vec<String>,
}

impl Register {
    pub fn parse(fields: &Fields) -> Result<Register> {
        Stray::of(fields, &REGISTER_FIELDS).refuse()?;
        let name = text(required(fields, "name", "name")?, "name", MAX_NAME, 1)?;
        let description = fields
            .get("description")
            .map(|value| text(value, "description", MAX_DESCRIPTION, 0))
            .transpose()?;
        let read_only_types = match fields.get("read_only_types") {
            Some(value) => type_list(value)?,
            None => Vec::new(),
        };
        Ok(Register {
            name,
            description,
            read_only_types,
        })
    }
}

fn type_list(value: &Value) -> Result<Vec<String>> {
    let named = value
        .as_array()
        .ok_or_else(|| invalid("read_only_types", "read_only_types must be a list."))?;
    if named.len() > MAX_TYPES {
        return Err(invalid(
            "read_only_types",
            "read_only_types holds at most 1,000 type identifiers.",
        ));
    }
    let mut seen = HashSet::new();
    let mut types = Vec::new();
    for entry in named {
        let id = entry
            .as_str()
            .filter(|id| matches!(grammar::type_id(id), Ok(true)))
            .ok_or_else(|| {
                invalid(
                    "read_only_types",
                    format!("Invalid type identifier: {}.", grammar::GRAMMAR),
                )
            })?;
        if seen.insert(id) {
            types.push(id.to_string());
        }
    }
    Ok(types)
}

/// The `process` a hold is taken under.
pub struct Take {
    pub process: String,
    stray: Stray,
}

impl Take {
    pub fn parse(fields: &Fields) -> Result<Take> {
        Ok(Take {
            process: process(fields, "process")?,
            stray: Stray::of(fields, &PROCESS_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()
    }
}

pub struct Run {
    pub succeeded: bool,
    pub started_at: String,
    pub finished_at: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    stray: Stray,
}

impl Run {
    pub fn parse(fields: &Fields) -> Result<Run> {
        let outcome = match required(fields, "outcome", "outcome")?.as_str() {
            Some("succeeded") => true,
            Some("failed") => false,
            _ => {
                return Err(invalid("outcome", "outcome is succeeded or failed."));
            }
        };
        let moment = |name: &str| -> Result<String> {
            required(fields, name, name)?
                .as_str()
                .and_then(|held| time::rfc3339(held, name).ok())
                .ok_or_else(|| invalid(name, format!("{name} must be a timestamp.")))
        };
        let started_at = moment("started_at")?;
        let finished_at = moment("finished_at")?;
        let optional = |name: &str| -> Result<Option<String>> {
            fields
                .get(name)
                .map(|value| text(value, name, MAX_TEXT, 0))
                .transpose()
        };
        Ok(Run {
            succeeded: outcome,
            started_at,
            finished_at,
            summary: optional("summary")?,
            error: optional("error")?,
            stray: Stray::of(fields, &RUN_FIELDS),
        })
    }

    /// The two times as stored, and the check that the run did not finish before it started.
    pub fn checked(&self) -> Result<(String, String)> {
        self.stray.refuse()?;
        let (started, finished) = (self.started_at.clone(), self.finished_at.clone());
        if finished < started {
            return Err(invalid(
                "finished_at",
                "finished_at can't be before started_at.",
            ));
        }
        Ok((started, finished))
    }
}

/// A state document and the problems that go with it.
pub struct Replace {
    pub process: String,
    pub state: Fields,
    pub problems: Option<Fields>,
    stray: Stray,
}

impl Replace {
    pub fn parse(fields: &Fields) -> Result<Replace> {
        let process = process(fields, "process")?;
        let state = object(required(fields, "state", "state")?, "state")?;
        let problems = fields.get("problems").map(problems).transpose()?;
        Ok(Replace {
            process,
            state,
            problems,
            stray: Stray::of(fields, &STATE_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()?;
        if serialized(&self.state)? > MAX_STATE_BYTES {
            return Err(invalid("state", "state is at most 512 KiB serialized."));
        }
        Ok(())
    }
}

fn problems(value: &Value) -> Result<Fields> {
    let named = object(value, "problems")?;
    if named.len() > MAX_PROBLEMS {
        return Err(invalid("problems", "problems holds at most 200 entries."));
    }
    for message in named.values() {
        let held = message
            .as_str()
            .ok_or_else(|| invalid("problems", "Each problem is text."))?;
        if characters(held) > MAX_PROBLEM_CHARACTERS {
            return Err(invalid(
                "problems",
                "Each problem holds at most 500 characters.",
            ));
        }
    }
    if serialized(&named)? > MAX_PROBLEMS_BYTES {
        return Err(invalid(
            "problems",
            "problems is at most 512 KiB serialized.",
        ));
    }
    Ok(named)
}

pub struct Set {
    pub item_id: String,
    pub waiting: bool,
    pub record: Fields,
}

pub struct Batch {
    pub process: String,
    pub set: Vec<Set>,
    pub clear: Vec<String>,
    stray: Stray,
}

impl Batch {
    pub fn parse(fields: &Fields) -> Result<Batch> {
        let process = process(fields, "process")?;
        let mut set = Vec::new();
        if let Some(named) = fields.get("set") {
            let rows = named
                .as_array()
                .ok_or_else(|| invalid("set", "set must be a list."))?;
            if rows.len() > MAX_ROWS {
                return Err(invalid("set", "set holds at most 500 agreements."));
            }
            for (index, row) in rows.iter().enumerate() {
                set.push(set_row(row, index)?);
            }
        }
        let mut clear = Vec::new();
        if let Some(named) = fields.get("clear") {
            let rows = named
                .as_array()
                .ok_or_else(|| invalid("clear", "clear must be a list."))?;
            if rows.len() > MAX_ROWS {
                return Err(invalid("clear", "clear holds at most 500 item ids."));
            }
            for (index, row) in rows.iter().enumerate() {
                clear.push(text(row, &format!("clear.{index}"), MAX_ITEM_ID, 1)?);
            }
        }
        Ok(Batch {
            process,
            set,
            clear,
            stray: Stray::of(fields, &AGREEMENT_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()?;
        let mut named = HashSet::new();
        let ids = self
            .set
            .iter()
            .map(|row| row.item_id.as_str())
            .chain(self.clear.iter().map(String::as_str));
        for id in ids {
            if !named.insert(id) {
                return Err(
                    Refusal::validation("An item is named once in a batch of agreements.")
                        .with_detail("item_id", id),
                );
            }
        }
        for row in &self.set {
            if serialized(&row.record)? > MAX_RECORD_BYTES {
                return Err(invalid("record", "A record is at most 16 KiB serialized.")
                    .with_detail("item_id", row.item_id.as_str()));
            }
        }
        Ok(())
    }
}

fn set_row(row: &Value, index: usize) -> Result<Set> {
    let at = format!("set.{index}");
    let fields = row
        .as_object()
        .ok_or_else(|| invalid(&at, format!("{at} must be an object.")))?;
    let path = |name: &str| format!("{at}.{name}");
    let item_id = text(
        required(fields, "item_id", &path("item_id"))?,
        &path("item_id"),
        MAX_ITEM_ID,
        1,
    )?;
    let waiting = required(fields, "waiting", &path("waiting"))?
        .as_bool()
        .ok_or_else(|| invalid(&path("waiting"), "waiting is true or false."))?;
    let record = object(
        required(fields, "record", &path("record"))?,
        &path("record"),
    )?;
    Ok(Set {
        item_id,
        waiting,
        record,
    })
}

pub struct Lookup {
    pub item_ids: Vec<String>,
    stray: Stray,
}

impl Lookup {
    pub fn parse(fields: &Fields) -> Result<Lookup> {
        let named = required(fields, "item_ids", "item_ids")?
            .as_array()
            .ok_or_else(|| invalid("item_ids", "item_ids must be a list."))?;
        if named.is_empty() || named.len() > MAX_ROWS {
            return Err(invalid("item_ids", "item_ids holds 1 to 500 item ids."));
        }
        let mut item_ids = Vec::new();
        for (index, id) in named.iter().enumerate() {
            item_ids.push(text(id, &format!("item_ids.{index}"), MAX_ITEM_ID, 1)?);
        }
        Ok(Lookup {
            item_ids,
            stray: Stray::of(fields, &LOOKUP_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()
    }
}

/// The `process` a hold is released under, read from the query.
pub fn released(process: Option<&str>) -> Result<String> {
    let held = process.ok_or_else(|| missing("process"))?;
    text(&Value::from(held), "process", MAX_PROCESS, 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fields(value: Value) -> Fields {
        match value {
            Value::Object(map) => map,
            _ => Fields::new(),
        }
    }

    #[test]
    fn a_problem_counts_characters_not_utf16_units() {
        let taken = json!({ "process": "p", "state": {}, "problems": { "a": "😀".repeat(500) } });
        assert!(Replace::parse(&fields(taken)).is_ok());
        let refused = json!({ "process": "p", "state": {}, "problems": { "a": "😀".repeat(501) } });
        assert!(Replace::parse(&fields(refused)).is_err());
    }

    #[test]
    fn problems_stop_at_two_hundred_entries() {
        let many = |count: usize| {
            let entries: Map<String, Value> = (0..count)
                .map(|index| (index.to_string(), Value::from("bad")))
                .collect();
            json!({ "process": "p", "state": {}, "problems": entries })
        };
        assert!(Replace::parse(&fields(many(200))).is_ok());
        assert!(Replace::parse(&fields(many(201))).is_err());
    }

    #[test]
    fn a_state_over_its_cap_is_refused_only_once_checked() {
        let big = json!({ "process": "p", "state": { "bytes": "x".repeat(MAX_STATE_BYTES) } });
        assert!(Replace::parse(&fields(big)).is_ok_and(|replace| replace.checked().is_err()));
        let small = json!({ "process": "p", "state": { "bytes": "x" } });
        assert!(Replace::parse(&fields(small)).is_ok_and(|replace| replace.checked().is_ok()));
    }

    #[test]
    fn a_stray_field_is_refused_only_once_checked() {
        let stray = json!({ "process": "p", "state": {}, "extra": 1 });
        let parsed = Replace::parse(&fields(stray));
        assert!(parsed.is_ok_and(|replace| replace.checked().is_err()));
    }

    #[test]
    fn a_row_named_twice_in_a_batch_is_refused() {
        let twice = json!({
            "process": "p",
            "set": [{ "item_id": "a", "waiting": true, "record": {} }],
            "clear": ["a"],
        });
        let parsed = Batch::parse(&fields(twice));
        assert!(parsed.is_ok_and(|batch| batch.checked().is_err()));
    }

    #[test]
    fn a_release_names_its_process() {
        assert!(released(None).is_err());
        assert!(released(Some("")).is_err());
        assert!(released(Some(&"p".repeat(101))).is_err());
        assert!(released(Some("p")).is_ok());
    }
}
