//! What the inbound doors take in a body. A top-level field the door does not declare is
//! refused once the registration and the caller are judged.

use std::collections::HashSet;

use super::super::connectors::{Fields, Stray, invalid, missing, required, text};
use super::super::refusal::Result;

const ENDPOINT_FIELDS: [&str; 2] = ["label", "duplicate_header"];
const MARK_FIELDS: [&str; 2] = ["ids", "outcome"];
const MAX_LABEL: usize = 200;
const MAX_HEADER: usize = 100;
const MOST_IDS: usize = 200;

pub const OUTCOMES: [&str; 3] = ["processed", "duplicate", "rejected"];

pub struct NewEndpoint {
    pub label: Option<String>,
    pub duplicate_header: Option<String>,
    stray: Stray,
}

fn is_token_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(character)
}

impl NewEndpoint {
    pub fn parse(fields: &Fields) -> Result<NewEndpoint> {
        let label = fields
            .get("label")
            .map(|value| text(value, "label", MAX_LABEL, 1))
            .transpose()?;
        let duplicate_header = fields
            .get("duplicate_header")
            .map(|value| {
                let name = text(value, "duplicate_header", MAX_HEADER, 1)?;
                if !name.chars().all(is_token_character) {
                    return Err(invalid(
                        "duplicate_header",
                        "duplicate_header must be an HTTP header name.",
                    ));
                }
                Ok(name.to_ascii_lowercase())
            })
            .transpose()?;
        Ok(NewEndpoint {
            label,
            duplicate_header,
            stray: Stray::of(fields, &ENDPOINT_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()
    }
}

/// The deliveries to mark and how they were handled.
pub struct Mark {
    /// Each id once, in the order first named.
    pub ids: Vec<String>,
    pub outcome: &'static str,
    stray: Stray,
}

impl Mark {
    pub fn parse(fields: &Fields) -> Result<Mark> {
        let named = required(fields, "ids", "ids")?
            .as_array()
            .ok_or_else(|| invalid("ids", "ids must be a list."))?;
        if named.is_empty() || named.len() > MOST_IDS {
            return Err(invalid("ids", "ids names 1 to 200 deliveries."));
        }
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        for entry in named {
            let id = entry
                .as_str()
                .ok_or_else(|| invalid("ids", "ids holds text."))?;
            if seen.insert(id) {
                ids.push(id.to_string());
            }
        }
        let outcome = fields.get("outcome").ok_or_else(|| missing("outcome"))?;
        let outcome = outcome
            .as_str()
            .and_then(|held| OUTCOMES.iter().find(|known| **known == held))
            .ok_or_else(|| invalid("outcome", "outcome is processed, duplicate or rejected."))?;
        Ok(Mark {
            ids,
            outcome,
            stray: Stray::of(fields, &MARK_FIELDS),
        })
    }

    pub fn checked(&self) -> Result<()> {
        self.stray.refuse()
    }
}

/// Which deliveries a listing names by whether they are handled.
pub fn state_of(named: Option<&str>) -> Result<Option<bool>> {
    match named {
        None | Some("pending") => Ok(Some(false)),
        Some("handled") => Ok(Some(true)),
        Some("any") => Ok(None),
        Some(_) => Err(invalid("state", "state is pending, handled or any.")),
    }
}
