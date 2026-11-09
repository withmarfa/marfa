//! The sort grammar and the `type` and `state` lists, judged before any store is read.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::catalog::Catalog;
use crate::error::{Code, Result, RuleError};
use crate::grammar;

#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
    /// The name after `properties.`: `a` to `z`, `0` to `9` and `_`.
    Property(String),
    /// When each row went to the bin, or its `updated_at` where it has no such time. No caller names it.
    TrashedAt,
}

impl fmt::Display for SortField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SortField::CreatedAt => f.write_str("created_at"),
            SortField::UpdatedAt => f.write_str("updated_at"),
            SortField::OccurredAt => f.write_str("occurred_at"),
            SortField::Property(name) => write!(f, "properties.{name}"),
            SortField::TrashedAt => f.write_str("trashed_at"),
        }
    }
}

impl SortField {
    pub fn property(name: &str) -> Result<SortField> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(RuleError::validation(format!(
                "Invalid sort property field \"{name}\"; expected ^[a-z0-9_]+$"
            )));
        }
        Ok(SortField::Property(name.to_string()))
    }
}

impl FromStr for SortField {
    type Err = RuleError;

    fn from_str(text: &str) -> Result<Self> {
        match text {
            "created_at" => Ok(SortField::CreatedAt),
            "updated_at" => Ok(SortField::UpdatedAt),
            "occurred_at" => Ok(SortField::OccurredAt),
            other => match other.strip_prefix("properties.") {
                Some(name) => SortField::property(name),
                None => Err(RuleError::validation(format!(
                    "Invalid sort field \"{other}\"; expected one of created_at, updated_at, occurred_at or properties.<field>"
                ))),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

impl FromStr for SortDirection {
    type Err = RuleError;

    fn from_str(text: &str) -> Result<Self> {
        match text {
            "asc" | "ascending" => Ok(SortDirection::Ascending),
            "desc" | "descending" => Ok(SortDirection::Descending),
            other => Err(RuleError::invalid(format!(
                "direction must be asc or desc, not {other:?}"
            ))),
        }
    }
}

/// `text` as a `LIKE` pattern matches it, under `ESCAPE '\\'`.
pub fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Numbers and booleans by value, then text by its bytes, anything else null, which SQLite's own order gives. `path` is the SQL that gives the JSON path, and its property name must have passed [`SortField::property`].
pub fn property_sort_expression(table: &str, path: &str) -> String {
    format!(
        "CASE json_type({table}.properties, {path}) \
         WHEN 'integer' THEN CAST(json_extract({table}.properties, {path}) AS REAL) \
         WHEN 'real' THEN CAST(json_extract({table}.properties, {path}) AS REAL) \
         WHEN 'text' THEN json_extract({table}.properties, {path}) \
         WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE NULL END"
    )
}

pub const EVERY_TYPE: &str = "*";

/// The most entries a `type` list may name.
pub const MAX_TYPE_ENTRIES: usize = 10;

/// Trimmed, blank entries dropped and repeats removed before the list is counted, in the order given. A list left with no entry or too many is refused. Each entry must still pass [`list_entry`] and [`refuse_unknown_type`].
pub fn type_entries(types: &[String]) -> Result<Vec<&str>> {
    let mut entries: Vec<&str> = Vec::new();
    for entry in types.iter().map(|entry| entry.trim()) {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    if entries.is_empty() {
        return Err(RuleError::validation(
            "The type filter names no type. Name a type, or leave the filter out.",
        ));
    }
    if entries.len() > MAX_TYPE_ENTRIES {
        return Err(RuleError::validation(format!(
            "Too many types in filter (max {MAX_TYPE_ENTRIES})"
        )));
    }
    Ok(entries)
}

/// `*` is refused, and a name outside the type grammar is refused as [`declared_type`] does.
pub fn list_entry(entry: &str) -> Result<&str> {
    if entry == EVERY_TYPE {
        return Err(RuleError::validation(format!(
            "Invalid type identifier: {EVERY_TYPE}"
        )));
    }
    declared_type(Some(entry))?;
    Ok(entry)
}

/// None for no filter or `*`; a name outside the type grammar is refused.
pub fn declared_type(declared: Option<&str>) -> Result<Option<&str>> {
    let Some(declared) = declared.filter(|declared| *declared != EVERY_TYPE) else {
        return Ok(None);
    };
    if !grammar::type_pattern(declared)? {
        return Err(RuleError::validation(format!(
            "Invalid type identifier: {declared}"
        )));
    }
    Ok(Some(declared))
}

/// A concrete type the catalog does not hold is refused `unknown_type`. A wildcard is never refused, since what it names may be nothing. A name outside the grammar is left to [`declared_type`], which refuses it first. Only a type the catalog lacks is refused: the catalog is the whole registry, whatever the key reads.
pub fn refuse_unknown_type(catalog: &Catalog, declared: Option<&str>) -> Result<()> {
    let Some(declared) = declared else {
        return Ok(());
    };
    if declared.ends_with(".*") || !grammar::type_pattern(declared)? {
        return Ok(());
    }
    if catalog.known(declared) {
        return Ok(());
    }
    Err(RuleError::new(
        Code::UnknownType,
        format!("Unknown type: {declared}"),
    ))
}

/// The states a query may name.
pub const STATES: [&str; 2] = ["active", "archived"];

/// Why a query's `state` list holds nothing a query can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateFault {
    /// The list names no state, so the query would hold nothing.
    Empty,
    /// The entry at this index is no state a query holds.
    Unknown(usize),
}

/// Whether a query's `state` list names at least one state and only `active` and `archived`.
pub fn check_states(states: &[impl AsRef<str>]) -> std::result::Result<(), StateFault> {
    if states.is_empty() {
        return Err(StateFault::Empty);
    }
    match states
        .iter()
        .position(|state| !STATES.contains(&state.as_ref()))
    {
        Some(index) => Err(StateFault::Unknown(index)),
        None => Ok(()),
    }
}

/// Refuses a `state` list that names no state, and one beside `all_states`.
pub fn refuse_states(named: Option<usize>, all_states: bool) -> Result<()> {
    match named {
        Some(0) => Err(RuleError::validation(
            "The state filter names no state. Name a state, or leave the filter out.",
        )),
        Some(_) if all_states => Err(RuleError::validation(
            "The state filter names states beside every state. Name the states, or ask for every state, not both.",
        )),
        _ => Ok(()),
    }
}
