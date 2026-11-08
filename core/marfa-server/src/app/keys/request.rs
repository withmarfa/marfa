use serde_json::{Map as Object, Value, json};

use crate::app::access::{Axis, Grants, Levers, Map, Permission};
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::sources;

const MAX_CLAIMS: usize = 1000;
const MAX_SOURCE_LENGTH: usize = 200;
const RESERVED_SOURCES: [&str; 2] = ["oauth:", "restored:"];

pub const MINT_FIELDS: [&str; 12] = [
    "label",
    "source",
    "sources",
    "permissions",
    "default_tier",
    "type_permissions",
    "extension_permissions",
    "edge_permissions",
    "metadata_permissions",
    "profile_permissions",
    "enforcement_override",
    "expires_at",
];

pub const UPDATE_FIELDS: [&str; 12] = [
    "label",
    "default_tier",
    "sources",
    "permissions",
    "type_permissions",
    "extension_permissions",
    "edge_permissions",
    "metadata_permissions",
    "profile_permissions",
    "enforcement_override",
    "expires_at",
    "narrow_only",
];

#[derive(Debug, Default)]
pub struct Families {
    permissions: Option<Vec<Permission>>,
    maps: [Option<Map>; 5],
    sources: Option<Vec<String>>,
}

impl Families {
    fn from_body(body: &Object<String, Value>) -> Result<Families> {
        let mut families = Families {
            permissions: body.get("permissions").map(permission_list).transpose()?,
            maps: Default::default(),
            sources: body.get("sources").map(claims).transpose()?,
        };
        let mut errors = Vec::new();
        for axis in Axis::ALL {
            let Some(named) = body.get(axis.field()) else {
                continue;
            };
            match axis.from_body(named) {
                Ok(map) => families.maps[axis as usize] = Some(map),
                Err(refusal) if refusal.code == Code::ValidationError => {
                    errors.push(refusal);
                }
                Err(refusal) => return Err(refusal),
            }
        }
        match merged(errors) {
            Some(refusal) => Err(refusal),
            None => Ok(families),
        }
    }

    pub fn names_any(&self) -> bool {
        self.permissions.is_some()
            || self.sources.is_some()
            || self.maps.iter().any(Option::is_some)
    }

    pub fn over(&self, base: &Grants) -> Grants {
        let mut grants = base.clone();
        if let Some(permissions) = &self.permissions {
            grants.permissions.clone_from(permissions);
        }
        if let Some(sources) = &self.sources {
            grants.sources.clone_from(sources);
        }
        for (held, named) in grants.maps.iter_mut().zip(&self.maps) {
            if let Some(named) = named {
                held.clone_from(named);
            }
        }
        grants
    }
}

fn merged(refusals: Vec<Refusal>) -> Option<Refusal> {
    let mut refusals = refusals.into_iter();
    let first = refusals.next()?;
    let mut errors: Vec<Value> = entry_errors(&first);
    for refusal in refusals {
        errors.extend(entry_errors(&refusal));
    }
    Some(first.with_detail("errors", errors))
}

fn entry_errors(refusal: &Refusal) -> Vec<Value> {
    refusal
        .details
        .as_ref()
        .and_then(|details| details.get("errors"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn permission_list(value: &Value) -> Result<Vec<Permission>> {
    let refused = || Refusal::validation("permissions must be a list of known permissions.");
    let mut permissions = Vec::new();
    for word in value.as_array().ok_or_else(refused)? {
        let permission = word
            .as_str()
            .and_then(Permission::from_word)
            .ok_or_else(refused)?;
        if !permissions.contains(&permission) {
            permissions.push(permission);
        }
    }
    Ok(permissions)
}

fn reserved(source: &str) -> bool {
    let lowered = source.to_ascii_lowercase();
    RESERVED_SOURCES
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
}

fn held_source(text: &str, field: &str) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || sources::length(trimmed) > MAX_SOURCE_LENGTH {
        return Err(Refusal::validation(format!(
            "{field} must hold 1 to 200 characters once trimmed."
        )));
    }
    if reserved(trimmed) {
        return Err(Refusal::validation(format!(
            "{field} can't start with oauth: or restored:."
        )));
    }
    Ok(trimmed.to_string())
}

fn claims(value: &Value) -> Result<Vec<String>> {
    let entries = value
        .as_array()
        .ok_or_else(|| Refusal::validation("sources must be a list."))?;
    if entries.len() > MAX_CLAIMS {
        return Err(Refusal::validation(
            "A key can claim at most 1,000 sources.",
        ));
    }
    let mut claims: Vec<String> = Vec::new();
    for entry in entries {
        let text = entry
            .as_str()
            .ok_or_else(|| Refusal::validation("sources must be a list of text."))?;
        let claim = held_source(text, "A claimed source")?;
        if !claims.contains(&claim) {
            claims.push(claim);
        }
    }
    Ok(claims)
}

fn required<'a>(body: &'a Object<String, Value>, field: &str) -> Result<&'a Value> {
    body.get(field).ok_or_else(|| {
        Refusal::new(Code::MissingRequiredField, format!("{field} is required."))
            .with_detail("field", field)
    })
}

fn label(value: &Value) -> Result<String> {
    let refused = || Refusal::validation("label must be text that is not empty.");
    let label = value.as_str().ok_or_else(refused)?.trim();
    if label.is_empty() {
        return Err(refused());
    }
    Ok(label.to_string())
}

fn tier(value: &Value) -> Result<String> {
    match value.as_str() {
        Some(tier @ ("library" | "feed")) => Ok(tier.to_string()),
        _ => Err(Refusal::validation("default_tier must be library or feed.")),
    }
}

pub fn bad_expiry(value: impl Into<Value>) -> Refusal {
    Refusal::validation("expires_at must be a date and time in the future.")
        .with_detail("field", "expires_at")
        .with_detail("value", value)
}

fn has_a_time(text: &str) -> bool {
    let date_and_hour = text.get(..16).map(str::as_bytes);
    let shape = b"dddd-dd-ddTdd:dd";
    date_and_hour.is_some_and(|held| {
        held.iter().zip(shape).all(|(byte, want)| match want {
            b'd' => byte.is_ascii_digit(),
            other => byte == other,
        })
    })
}

fn expiry(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(text) = value.as_str().filter(|text| has_a_time(text)) else {
        return Err(bad_expiry(value.clone()));
    };
    marfa_rules::time::rfc3339(text, "expires_at")
        .map(Some)
        .map_err(|_| bad_expiry(text))
}

fn levers(value: &Value) -> Result<Option<Levers>> {
    if value.is_null() {
        Ok(None)
    } else {
        Levers::from_body(value).map(Some)
    }
}

/// A field left out is `None`; `null` for an end or levers is `Some(None)`.
#[derive(Debug)]
pub struct Mint {
    pub label: String,
    pub source: String,
    pub default_tier: String,
    pub families: Families,
    pub levers: Option<Option<Levers>>,
    pub expires_at: Option<Option<String>>,
}

impl Mint {
    pub fn from_body(body: &Object<String, Value>) -> Result<Mint> {
        let name = label(required(body, "label")?)?;
        let source = required(body, "source")?
            .as_str()
            .ok_or_else(|| Refusal::validation("source must be text."))?;
        Ok(Mint {
            label: name,
            source: held_source(source, "source")?,
            default_tier: body
                .get("default_tier")
                .map_or_else(|| Ok("library".to_string()), tier)?,
            families: Families::from_body(body)?,
            levers: body.get("enforcement_override").map(levers).transpose()?,
            expires_at: body.get("expires_at").map(expiry).transpose()?,
        })
    }
}

#[derive(Debug)]
pub struct Update {
    pub label: Option<String>,
    pub default_tier: Option<String>,
    pub families: Families,
    pub levers: Option<Option<Levers>>,
    pub expires_at: Option<Option<String>>,
    pub narrow_only: bool,
    pub fields: Value,
}

impl Update {
    pub fn from_body(body: &Object<String, Value>) -> Result<Update> {
        let narrow_only = match body.get("narrow_only") {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(Refusal::validation("narrow_only must be true or false.")),
        };
        Ok(Update {
            label: body.get("label").map(label).transpose()?,
            default_tier: body.get("default_tier").map(tier).transpose()?,
            families: Families::from_body(body)?,
            levers: body.get("enforcement_override").map(levers).transpose()?,
            expires_at: body.get("expires_at").map(expiry).transpose()?,
            narrow_only,
            fields: json!(body.keys().collect::<Vec<_>>()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_end_needs_a_date_and_a_time() {
        for (value, ok) in [
            (json!("2030-01-02T03:04:05Z"), true),
            (json!("2030-01-02T03:04"), false),
            (json!("2030-01-02T03:04:05"), false),
            (json!("2030-01-02"), false),
            (json!("2030"), false),
            (json!("soon"), false),
            (json!(5), false),
            (json!("9999-12-31T23:59:59-01:00"), false),
        ] {
            assert_eq!(expiry(&value).is_ok(), ok, "{value}");
        }
        assert_eq!(
            expiry(&json!("2030-01-02T03:04:05+01:00"))
                .unwrap()
                .as_deref(),
            Some("2030-01-02T02:04:05.000Z")
        );
        assert_eq!(expiry(&Value::Null).unwrap(), None);
    }

    #[test]
    fn a_held_source_is_trimmed_bounded_and_kept_from_what_is_reserved() {
        assert_eq!(held_source("  mine ", "source").unwrap(), "mine");
        assert_eq!(held_source("\u{85}mine\u{3000}", "source").unwrap(), "mine");
        assert!(held_source("\u{feff}", "source").is_ok());
        for text in [
            "   ",
            &"x".repeat(201),
            " OAuth:client",
            "RESTORED:device",
            "oauth:",
        ] {
            assert!(held_source(text, "source").is_err(), "{text}");
        }
        assert!(held_source(&"😀".repeat(201), "source").is_err());
        assert!(held_source(&"😀".repeat(200), "source").is_ok());
        assert!(held_source("oauthish:mine", "source").is_ok());
    }

    #[test]
    fn claims_are_trimmed_once_each_in_the_order_named() {
        assert_eq!(
            claims(&json!(["b", " a ", "b", "B"])).unwrap(),
            ["b", "a", "B"]
        );
        assert!(claims(&json!(vec!["a"; 1001])).is_err());
        assert!(claims(&json!(vec!["a"; 1000])).is_ok());
        assert!(claims(&json!("a")).is_err());
        assert!(claims(&json!([5])).is_err());
    }
}
