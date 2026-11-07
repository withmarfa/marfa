//! What a list and a search ask, judged before any store is read: the sort
//! grammar, and the `type` and `state` lists.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::catalog::Catalog;
use crate::error::{Code, Result, RuleError};
use crate::grammar;

/// What a local list orders by, in the server's `sort` grammar: a time of the
/// item, or `properties.<field>` for the scalar a property stores.
// The shared `At` suffix is the column naming rule, not noise.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    CreatedAt,
    UpdatedAt,
    OccurredAt,
    /// The name after `properties.`, one or more of `a` to `z`, `0` to `9`
    /// and `_`.
    Property(String),
    /// When each row went to the bin, or its `updated_at` where it holds no
    /// such time: the order of a list of the bin alone that names no field
    /// (`device/bin-local-order`). No caller names it, as no server takes it.
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
    /// A property sort names its property as the server's grammar allows.
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

/// The `type` filter that names every type, which a `type` list refuses.
pub const EVERY_TYPE: &str = "*";

/// The most entries a `type` list may name, as on the server
/// (`search-and-filters/type-list-max`).
pub const MAX_TYPE_ENTRIES: usize = 10;

/// The entries of a `type` list, as the server reads one
/// (`search-and-filters/type-list`): trimmed, blank ones dropped and repeats
/// removed before the list is counted, in the order given. A list left with
/// no entry or with too many is refused. Each entry still has to pass
/// [`list_entry`] and [`refuse_unknown_type`].
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

/// One entry of a `type` list. `*` is no type filter at all and is refused
/// as the server refuses it, and a name outside the type grammar is refused
/// as [`declared_type`] refuses it. The entry still has to pass
/// [`refuse_unknown_type`].
pub fn list_entry(entry: &str) -> Result<&str> {
    if entry == EVERY_TYPE {
        return Err(RuleError::validation(format!(
            "Invalid type identifier: {EVERY_TYPE}"
        )));
    }
    declared_type(Some(entry))?;
    Ok(entry)
}

/// The type a `?type=` names, as the server reads it: none for no filter or
/// `*`, and a name outside the server's type grammar is refused.
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

/// A concrete type the catalog does not hold is refused `unknown_type`, as
/// the server refuses one nothing registers (`device/type-unknown`). A
/// wildcard is never refused: what it names may be nothing. A name outside the
/// grammar is left to [`declared_type`], which refuses it first on the
/// server's code. The server answers `type_not_permitted` for a registered
/// type its key may not read, so only a type the catalog lacks is refused
/// here: the catalog is the server's whole registry, whatever the key reads.
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

/// A `state` list, as the server reads one (`search-and-filters/state-list`),
/// given how many states it names. An empty list names nothing and is
/// refused, as the server refuses a `state` with no entry
/// (`search-and-filters/state-empty`), and so is a list beside `all_states`,
/// as the server refuses `any` beside a state
/// (`search-and-filters/state-any-alone`).
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
