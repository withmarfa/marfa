//! What `GET /items` and `GET /search` share: the query string, the filters
//! the core's clause builders take, and the key's read reach.

use std::collections::HashSet;

use axum::http::StatusCode;
use marfa_core::server::{self as core, Catalog, ItemState, ListFilters, Tier};
use serde_json::{Value, json};

use crate::auth::{Caller, Level};
use crate::error::{ApiError, ApiResult};

/// The decoded query pairs, in the order sent.
pub struct Pairs(pub Vec<(String, String)>);

impl Pairs {
    pub fn parse(raw: Option<&str>) -> ApiResult<Pairs> {
        let Some(raw) = raw else {
            return Ok(Pairs(Vec::new()));
        };
        let pairs = serde_urlencoded_pairs(raw)
            .ok_or_else(|| ApiError::validation("The query string is not valid."))?;
        Ok(Pairs(pairs))
    }

    /// The last value sent for `key`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    /// Refuses a key outside `declared`, naming each. A key starting with `_`
    /// is the caller's own, and an edge shorthand is taken where `shorthand`.
    pub fn declared(&self, declared: &[&str], shorthand: bool) -> ApiResult<()> {
        let mut unknown: Vec<&str> = Vec::new();
        for (name, _) in &self.0 {
            let known = declared.contains(&name.as_str())
                || name.starts_with('_')
                || (shorthand && is_shorthand(name));
            if !known && !unknown.contains(&name.as_str()) {
                unknown.push(name);
            }
        }
        if unknown.is_empty() {
            return Ok(());
        }
        Err(
            ApiError::validation(format!("Unknown query parameter: {}.", unknown.join(", ")))
                .with(json!({ "unknown_parameters": unknown })),
        )
    }

    /// Refuses a narrowing key sent with nothing in it.
    pub fn nothing_empty(&self) -> ApiResult<()> {
        let mut empty: Vec<&str> = Vec::new();
        for key in ["type", "source", "tags", "filter"] {
            let Some(value) = self.get(key) else { continue };
            let blank = match key {
                "type" | "tags" => value.split(',').all(|entry| entry.trim().is_empty()),
                _ => value.trim().is_empty(),
            };
            if blank {
                empty.push(key);
            }
        }
        if empty.is_empty() {
            return Ok(());
        }
        Err(ApiError::validation(format!(
            "A filter sent with no value narrows nothing: {}.",
            empty.join(", ")
        ))
        .with(json!({ "empty_parameters": empty })))
    }
}

fn is_shorthand(name: &str) -> bool {
    (name.starts_with("edge[") || name.starts_with("backref[")) && name.ends_with(']')
}

/// `application/x-www-form-urlencoded`, as the query string is spelled.
fn serde_urlencoded_pairs(raw: &str) -> Option<Vec<(String, String)>> {
    axum::extract::Query::<Vec<(String, String)>>::try_from_uri(&format!("/?{raw}").parse().ok()?)
        .ok()
        .map(|query| query.0)
}

/// The comma-separated entries of a value, trimmed, blanks dropped.
fn entries(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// The filters both doors take, read from the query. The bounds are left as
/// sent: the core judges them.
pub fn read_filters(pairs: &Pairs, shorthand: bool) -> ApiResult<ListFilters> {
    let mut filters = ListFilters {
        types: pairs.get("type").map(entries),
        tags: pairs.get("tags").map(entries).unwrap_or_default(),
        source: pairs.get("source").map(str::to_string),
        occurred_after: pairs.get("occurred_after").map(str::to_string),
        occurred_before: pairs.get("occurred_before").map(str::to_string),
        updated_after: pairs.get("updated_after").map(str::to_string),
        updated_before: pairs.get("updated_before").map(str::to_string),
        beneath: pairs.get("beneath").map(str::to_string),
        filter: pairs.get("filter").map(str::to_string),
        ..ListFilters::default()
    };
    if let Some(beneath) = &filters.beneath {
        core::validate_id("beneath", beneath).map_err(|error| {
            ApiError::from(error).with(json!({ "invalid_parameters": ["beneath"] }))
        })?;
    }
    if filters.types.as_ref().is_some_and(Vec::is_empty) {
        filters.types = None;
    }
    match pairs.get("tier") {
        None | Some("all") => {}
        Some(tier) => {
            filters.tier = Some(
                tier.parse::<Tier>()
                    .map_err(|_| ApiError::field("tier", "Must be library, feed or all."))?,
            )
        }
    }
    if let Some(state) = pairs.get("state") {
        let named = entries(state);
        if named.is_empty() {
            return Err(ApiError::field(
                "state",
                "Name a state, or leave the filter out.",
            ));
        }
        if named.iter().any(|entry| entry == "any") {
            if named.len() > 1 {
                return Err(ApiError::field("state", "any stands alone."));
            }
            filters.all_states = true;
        } else {
            let states = named
                .iter()
                .map(|entry| entry.parse::<ItemState>())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    ApiError::field(
                        "state",
                        "Must be active, archived, trashed, revoked or any.",
                    )
                })?;
            filters.states = Some(states);
        }
    }
    if shorthand {
        let mut terms = Vec::new();
        for (name, value) in &pairs.0 {
            if !is_shorthand(name) {
                continue;
            }
            if value.is_empty() {
                return Err(ApiError::validation(format!(
                    "The \"{name}\" filter was sent with no value."
                ))
                .with(json!({ "empty_parameters": [name] })));
            }
            if value.contains('\\') {
                return Err(ApiError::validation(format!(
                    "The \"{name}\" filter value contains a backslash."
                ))
                .with(json!({ "invalid_parameters": [name] })));
            }
            terms.push(format!("{name} eq \"{}\"", value.replace('"', "\\\"")));
        }
        if !terms.is_empty() {
            filters.filter = Some(match filters.filter.take() {
                Some(filter) => format!("{filter} AND {}", terms.join(" AND ")),
                None => terms.join(" AND "),
            });
        }
    }
    Ok(filters)
}

/// The tokens of `include`.
pub fn include(pairs: &Pairs) -> ApiResult<HashSet<String>> {
    let tokens: HashSet<String> = pairs
        .get("include")
        .map(|value| entries(value).into_iter().collect())
        .unwrap_or_default();
    for unsupported in ["edges", "extensions"] {
        if tokens.contains(unsupported) {
            return Err(ApiError::field(
                "include",
                format!("This server does not serve include={unsupported}."),
            ));
        }
    }
    Ok(tokens)
}

/// What the key may read: the types of the catalog, split by the key's map.
pub struct Reach {
    readable: Vec<String>,
    unreadable: Vec<String>,
}

impl Reach {
    pub fn of(caller: &Caller, catalog: &Catalog) -> Reach {
        let mut readable = Vec::new();
        let mut unreadable = Vec::new();
        for (id, _) in catalog.declared() {
            if caller.type_level(id) >= Level::Read {
                readable.push(id.to_string());
            } else {
                unreadable.push(id.to_string());
            }
        }
        readable.sort();
        unreadable.sort();
        Reach {
            readable,
            unreadable,
        }
    }

    /// A key that reads no type is refused before any filter is looked at.
    pub fn reads_some(&self) -> ApiResult<()> {
        if self.readable.is_empty() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "type_not_permitted",
                "This key holds no grant on any type.",
            ));
        }
        Ok(())
    }

    /// A concrete type the key may not read, with none under it that it may,
    /// is refused; a wildcard never is.
    pub fn permits(&self, catalog: &Catalog, types: &[String]) -> ApiResult<()> {
        for declared in types {
            if declared.ends_with(".*") || self.unreadable.is_empty() {
                continue;
            }
            let reaches = |id: &String| catalog.matches(declared, id);
            if self.readable.iter().any(reaches) {
                continue;
            }
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "type_not_permitted",
                format!("This credential may not read items of type {declared}."),
            )
            .with(json!({ "grant": { "kind": "type", "name": declared, "level": "read" } })));
        }
        Ok(())
    }

    /// The clause that holds a read to the types the key may read, and
    /// leaves out `system.*` unless the request asks for it.
    pub fn clauses(
        &self,
        types: Option<&[String]>,
        include: &HashSet<String>,
        clauses: &mut Vec<String>,
        values: &mut Vec<Value>,
    ) {
        if !self.unreadable.is_empty() {
            let (list, word) = if self.readable.len() <= self.unreadable.len() {
                (&self.readable, "IN")
            } else {
                (&self.unreadable, "NOT IN")
            };
            clauses.push(format!(
                "items.type {word} ({})",
                vec!["?"; list.len()].join(", ")
            ));
            values.extend(list.iter().cloned().map(Value::String));
        }
        let names_system = types
            .unwrap_or_default()
            .iter()
            .any(|entry| entry == "system" || entry.starts_with("system."));
        if !include.contains("system") && !names_system {
            clauses.push("items.type NOT LIKE 'system.%'".into());
        }
    }
}

/// The value as SQLite binds it.
pub fn bind(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => Sql::Integer(integer),
            None => Sql::Real(number.as_f64().unwrap_or(0.0)),
        },
        Value::String(text) => Sql::Text(text.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// A cursor: hex of a JSON object, so it is opaque and carries no character
/// a URL needs to escape.
pub fn seal(cursor: &Value) -> String {
    hex::encode(cursor.to_string())
}

pub fn unseal(cursor: &str) -> ApiResult<serde_json::Map<String, Value>> {
    hex::decode(cursor)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .ok_or_else(|| ApiError::validation("Invalid pagination cursor"))
}

/// A page limit read the way the contract reads one: a number, whole after
/// any cap, from 1.
pub fn limit(raw: Option<&str>, default: usize, max: usize, capped: bool) -> ApiResult<usize> {
    let Some(raw) = raw else { return Ok(default) };
    let refused = || ApiError::field("limit", format!("Must be a whole number from 1 to {max}."));
    let number: f64 = if raw.trim().is_empty() {
        0.0
    } else {
        raw.trim().parse().map_err(|_| refused())?
    };
    if number.is_nan() || number < 1.0 {
        return Err(refused());
    }
    let number = if capped {
        number.min(max as f64)
    } else {
        number
    };
    if number.fract() != 0.0 || number > max as f64 {
        return Err(refused());
    }
    Ok(number as usize)
}
