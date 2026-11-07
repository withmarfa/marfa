//! A key's own enforcement levers.

use serde_json::{Value, json};

use crate::app::refusal::{Code, Refusal, Result};

const LEVERS: [(&str, &[&str]); 3] = [
    ("strict_mode", &["types"]),
    ("source_allowlist", &["types", "sources"]),
    ("source_filter", &["types", "sources"]),
];

/// Levers as a request names them and as they are stored and answered.
#[derive(Clone, Debug, PartialEq)]
pub struct Levers(serde_json::Map<String, Value>);

fn missing(path: String) -> Refusal {
    Refusal::new(
        Code::MissingRequiredField,
        format!("{path} is required by the lever that holds it."),
    )
    .with_detail("field", path)
}

fn list_of_text(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

impl Levers {
    pub fn from_stored(entries: serde_json::Map<String, Value>) -> Levers {
        Levers(entries)
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.0.clone())
    }

    pub fn from_body(value: &Value) -> Result<Levers> {
        Levers::from_body_at(value, "enforcement_override")
    }

    /// Reads the levers a body holds under `at`, which is the path a refusal
    /// names them by.
    pub fn from_body_at(value: &Value, at: &str) -> Result<Levers> {
        let refused = |path: &str| {
            let message = format!("{path} is not a valid lever setting.");
            Refusal::validation(message.clone())
                .with_detail("errors", json!([{ "path": path, "message": message }]))
        };
        let block = value.as_object().ok_or_else(|| refused(at))?;
        let mut levers = serde_json::Map::new();
        for (lever, members) in LEVERS {
            let Some(named) = block.get(lever) else {
                continue;
            };
            let path = format!("{at}.{lever}");
            let named = named.as_object().ok_or_else(|| refused(&path))?;
            let mut kept = serde_json::Map::new();
            for member in members {
                let path = format!("{path}.{member}");
                let list = named.get(*member).ok_or_else(|| missing(path.clone()))?;
                if !list_of_text(list) {
                    return Err(refused(&path));
                }
                kept.insert((*member).into(), list.clone());
            }
            levers.insert(lever.into(), Value::Object(kept));
        }
        Ok(Levers(levers))
    }

    /// The paths under `at` that name no lever, or no member of one.
    pub fn unknown_names(value: &Value, at: &str) -> Vec<String> {
        let Some(block) = value.as_object() else {
            return Vec::new();
        };
        let mut unknown = Vec::new();
        for (name, named) in block {
            let Some((lever, members)) = LEVERS.iter().find(|(lever, _)| lever == name) else {
                unknown.push(format!("{at}.{name}"));
                continue;
            };
            for member in named.as_object().into_iter().flat_map(|named| named.keys()) {
                if !members.contains(&member.as_str()) {
                    unknown.push(format!("{at}.{lever}.{member}"));
                }
            }
        }
        unknown
    }
}
