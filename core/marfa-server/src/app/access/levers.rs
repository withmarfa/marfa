//! A key's own enforcement levers.

use serde_json::Value;

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
        let refused =
            |path: &str| Refusal::validation(format!("{path} is not a valid lever setting."));
        let block = value
            .as_object()
            .ok_or_else(|| refused("enforcement_override"))?;
        let mut levers = serde_json::Map::new();
        for (lever, members) in LEVERS {
            let Some(named) = block.get(lever) else {
                continue;
            };
            let path = format!("enforcement_override.{lever}");
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
}
