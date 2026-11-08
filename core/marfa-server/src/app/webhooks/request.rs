//! What a subscription's create and update bodies may say, judged before anything is read.

use marfa_rules::query::list_entry;
use serde_json::{Map, Value, json};
use url::Url;

use crate::app::refusal::{Refusal, Result};
use crate::app::types::missing_field;

pub const EVENTS: [&str; 10] = [
    "item.created",
    "item.updated",
    "item.deleted",
    "item.restored",
    "item.purged",
    "item.state_changed",
    "metadata.changed",
    "edge.created",
    "edge.updated",
    "edge.deleted",
];

pub const CREATE_FIELDS: [&str; 4] = ["url", "events", "type_filter", "secret"];
pub const UPDATE_FIELDS: [&str; 4] = ["url", "events", "type_filter", "active"];

const SECRET_CHARS: usize = 32;

/// A receiver's URL as the caller wrote it, which is what a read answers, and as it parses.
#[derive(Debug)]
pub struct Address {
    pub text: String,
    pub url: Url,
}

#[derive(Debug)]
pub struct Create {
    pub url: Address,
    pub events: Vec<String>,
    pub type_filter: Option<String>,
    pub secret: Option<String>,
}

#[derive(Debug, Default)]
pub struct Update {
    pub url: Option<Address>,
    pub events: Option<Vec<String>>,
    pub type_filter: Option<Option<String>>,
    pub active: Option<bool>,
}

pub(super) fn invalid(path: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    Refusal::validation(message.clone())
        .with_detail("field", path.split('.').next().unwrap_or(path))
        .with_detail("errors", json!([{ "path": path, "message": message }]))
}

fn url_of(value: &Value) -> Result<Address> {
    let refused = || invalid("url", "url is an http or https URL with no user name or password.");
    let text = value.as_str().filter(|text| !text.is_empty()).ok_or_else(refused)?;
    let url = Url::parse(text).map_err(|_| refused())?;
    let plain = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.host().is_some();
    plain
        .then(|| Address {
            text: text.to_string(),
            url,
        })
        .ok_or_else(refused)
}

fn events_of(value: &Value) -> Result<Vec<String>> {
    let Some(entries) = value.as_array() else {
        return Err(invalid("events", "events is a list of event names."));
    };
    if entries.is_empty() {
        return Err(invalid("events", "events names at least one event."));
    }
    let mut events: Vec<String> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let name = entry.as_str().filter(|name| EVENTS.contains(name)).ok_or_else(|| {
            invalid(
                &format!("events.{index}"),
                format!("Each event is one of {}.", EVENTS.join(", ")),
            )
        })?;
        if !events.iter().any(|held| held == name) {
            events.push(name.to_string());
        }
    }
    Ok(events)
}

/// Blank text and `null` name no filter.
fn filter_of(value: &Value) -> Result<Option<String>> {
    let refused = || {
        invalid(
            "type_filter",
            "type_filter is one item type, such as core.note, or a pattern, such as core.*.",
        )
    };
    let text = match value {
        Value::Null => return Ok(None),
        Value::String(text) => text.trim(),
        _ => return Err(refused()),
    };
    if text.is_empty() {
        return Ok(None);
    }
    list_entry(text).map_err(|_| refused())?;
    Ok(Some(text.to_string()))
}

fn secret_of(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|secret| secret.chars().count() >= SECRET_CHARS)
        .map(str::to_string)
        .ok_or_else(|| invalid("secret", format!("secret is at least {SECRET_CHARS} characters.")))
}

impl Create {
    pub fn from_body(body: &Map<String, Value>) -> Result<Create> {
        let url = body.get("url").ok_or_else(|| missing_field("url"))?;
        let events = body.get("events").ok_or_else(|| missing_field("events"))?;
        Ok(Create {
            url: url_of(url)?,
            events: events_of(events)?,
            type_filter: body.get("type_filter").map(filter_of).transpose()?.flatten(),
            secret: body.get("secret").map(secret_of).transpose()?,
        })
    }
}

impl Update {
    pub fn from_body(body: &Map<String, Value>) -> Result<Update> {
        let active = match body.get("active") {
            None => None,
            Some(Value::Bool(active)) => Some(*active),
            Some(_) => return Err(invalid("active", "active is true or false.")),
        };
        Ok(Update {
            url: body.get("url").map(url_of).transpose()?,
            events: body.get("events").map(events_of).transpose()?,
            type_filter: body.get("type_filter").map(filter_of).transpose()?,
            active,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create(body: Value) -> Result<Create> {
        Create::from_body(body.as_object().expect("an object"))
    }

    fn detail(refusal: &Refusal, name: &str) -> Value {
        refusal
            .details
            .as_ref()
            .and_then(|details| details.get(name).cloned())
            .unwrap_or_default()
    }

    fn path_of(refusal: &Refusal) -> Value {
        detail(refusal, "errors")[0]["path"].clone()
    }

    #[test]
    fn names_the_first_missing_field() {
        let refused = create(json!({ "events": ["item.created"] })).unwrap_err();
        assert_eq!(detail(&refused, "field"), "url");
        let refused = create(json!({ "url": "https://example.com/" })).unwrap_err();
        assert_eq!(detail(&refused, "field"), "events");
    }

    #[test]
    fn refuses_a_wildcard_at_its_position() {
        let refused = create(json!({
            "url": "https://example.com/",
            "events": ["item.created", "*"],
        }))
        .unwrap_err();
        assert_eq!(path_of(&refused), "events.1");
    }

    #[test]
    fn refuses_a_url_that_is_not_plain_http() {
        for url in [
            "ftp://example.com/",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "example.com",
            "",
        ] {
            let refused = create(json!({ "url": url, "events": ["item.created"] })).unwrap_err();
            assert_eq!(path_of(&refused), "url", "{url}");
        }
    }

    #[test]
    fn trims_a_filter_and_refuses_what_is_not_one_pattern() {
        let taken = create(json!({
            "url": "https://example.com/",
            "events": ["item.created"],
            "type_filter": "  core.* ",
        }))
        .unwrap();
        assert_eq!(taken.type_filter.as_deref(), Some("core.*"));
        for filter in ["*", "bad filter", "core.note,core.task"] {
            let refused = create(json!({
                "url": "https://example.com/",
                "events": ["item.created"],
                "type_filter": filter,
            }))
            .unwrap_err();
            assert_eq!(path_of(&refused), "type_filter", "{filter}");
        }
        let cleared = Update::from_body(json!({ "type_filter": "  " }).as_object().unwrap()).unwrap();
        assert_eq!(cleared.type_filter, Some(None));
    }

    #[test]
    fn counts_a_secret_in_characters() {
        let short = create(json!({
            "url": "https://example.com/",
            "events": ["item.created"],
            "secret": "",
        }));
        assert!(short.is_err());
        let wide = create(json!({
            "url": "https://example.com/",
            "events": ["item.created"],
            "secret": "é".repeat(32),
        }));
        assert!(wide.is_ok());
    }
}
