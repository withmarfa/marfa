//! What a view's settings may hold, judged before a view is written.

use marfa_rules::{filter, validation};
use serde_json::{Map, Value, json};

use super::catalog::Catalog;
use super::refusal::{Code, Refusal, Result};
use super::types::check_id;

/// What a change to a view may name beside `version`.
pub const SETTINGS: [&str; 4] = ["title", "query", "sort", "group"];

const QUERY: [&str; 5] = ["types", "tier", "state", "filter", "beneath"];
const SORT_KEY: [&str; 2] = ["by", "direction"];
const GROUP: [&str; 4] = ["by", "bucket", "order", "hidden"];
const OWN_FIELDS: [&str; 8] = [
    "title",
    "created_at",
    "updated_at",
    "occurred_at",
    "type",
    "state",
    "tier",
    "tags",
];
const DATE_FIELDS: [&str; 3] = ["created_at", "updated_at", "occurred_at"];
const BUCKETS: [&str; 4] = ["day", "week", "month", "year"];
const TIERS: [&str; 3] = ["library", "feed", "all"];
const STATES: [&str; 2] = ["active", "archived"];
const MAX_TITLE: usize = 500;
const MAX_TYPES: usize = 100;
const MAX_SORT_KEYS: usize = 10;
const MAX_GROUP_VALUES: usize = 1_000;

fn at(path: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    Refusal::validation(message.clone())
        .with_detail("errors", json!([{ "path": path, "message": message }]))
}

fn undeclared_in(
    object: &Map<String, Value>,
    allowed: &[&str],
    prefix: &str,
    out: &mut Vec<String>,
) {
    out.extend(
        object
            .keys()
            .filter(|key| !allowed.contains(&key.as_str()))
            .map(|key| format!("{prefix}{key}")),
    );
}

/// The paths in a settings body that no setting declares.
pub fn undeclared(body: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    let mut paths = Vec::new();
    undeclared_in(body, allowed, "", &mut paths);
    if let Some(query) = body.get("query").and_then(Value::as_object) {
        undeclared_in(query, &QUERY, "query.", &mut paths);
    }
    if let Some(group) = body.get("group").and_then(Value::as_object) {
        undeclared_in(group, &GROUP, "group.", &mut paths);
    }
    if let Some(keys) = body.get("sort").and_then(Value::as_array) {
        for (index, key) in keys.iter().enumerate() {
            if let Some(key) = key.as_object() {
                undeclared_in(key, &SORT_KEY, &format!("sort.{index}."), &mut paths);
            }
        }
    }
    paths.sort_unstable();
    paths
}

fn is_property(field: &str) -> bool {
    let Some(name) = field.strip_prefix("properties.") else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

fn is_sort_field(field: &str) -> bool {
    OWN_FIELDS.contains(&field) || is_property(field)
}

fn is_edge_field(field: &str, catalog: &Catalog) -> bool {
    ["edge[", "backref["].iter().any(|open| {
        field
            .strip_prefix(open)
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|edge_type| catalog.edge_kind(edge_type).is_some())
    })
}

fn check_title(value: &Value) -> Result<()> {
    let Some(title) = value.as_str() else {
        return Err(at("title", "title must be a string."));
    };
    let length = title.chars().count();
    if length == 0 || length > MAX_TITLE {
        return Err(at(
            "title",
            format!("title holds 1 to {MAX_TITLE} characters."),
        ));
    }
    Ok(())
}

fn check_types(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(types) = value.as_array() else {
        return Err(at("query.types", "query.types must be a list."));
    };
    if types.len() > MAX_TYPES {
        return Err(at(
            "query.types",
            format!("query.types holds at most {MAX_TYPES} types."),
        ));
    }
    for (index, entry) in types.iter().enumerate() {
        let path = format!("query.types.{index}");
        let Some(type_id) = entry.as_str() else {
            return Err(at(&path, "A type is a string."));
        };
        check_id(type_id, &path)?;
        if type_id == "system" || type_id.starts_with("system.") {
            return Err(at(&path, "A view lists no system type."));
        }
        if !catalog.rules.known(type_id) {
            return Err(
                Refusal::new(Code::UnknownType, format!("Unknown type: {type_id}")).with_detail(
                    "errors",
                    json!([{ "path": path, "message": "Unknown type" }]),
                ),
            );
        }
    }
    Ok(())
}

fn check_query(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(query) = value.as_object() else {
        return Err(at("query", "query must be an object."));
    };
    if let Some(types) = query.get("types") {
        check_types(types, catalog)?;
    }
    if let Some(tier) = query.get("tier")
        && !tier.as_str().is_some_and(|tier| TIERS.contains(&tier))
    {
        return Err(at("query.tier", "query.tier is library, feed or all."));
    }
    if let Some(states) = query.get("state") {
        let Some(states) = states.as_array().filter(|states| !states.is_empty()) else {
            return Err(at("query.state", "query.state is a list of states."));
        };
        for (index, state) in states.iter().enumerate() {
            if !state.as_str().is_some_and(|state| STATES.contains(&state)) {
                return Err(at(
                    &format!("query.state.{index}"),
                    "A view lists the active and archived states.",
                ));
            }
        }
    }
    if let Some(text) = query.get("filter") {
        let Some(text) = text.as_str() else {
            return Err(at("query.filter", "query.filter must be a string."));
        };
        filter::parse(text).map_err(|error| at("query.filter", error.message))?;
    }
    if let Some(beneath) = query.get("beneath")
        && !beneath
            .as_str()
            .is_some_and(|id| validation::id("query.beneath", id).is_ok())
    {
        return Err(at("query.beneath", "query.beneath must be an item ID."));
    }
    Ok(())
}

fn check_sort(value: &Value) -> Result<()> {
    let Some(keys) = value.as_array() else {
        return Err(at("sort", "sort must be a list."));
    };
    if keys.len() > MAX_SORT_KEYS {
        return Err(at(
            "sort",
            format!("sort holds at most {MAX_SORT_KEYS} keys."),
        ));
    }
    for (index, key) in keys.iter().enumerate() {
        let Some(key) = key.as_object() else {
            return Err(at(&format!("sort.{index}"), "A sort key is an object."));
        };
        if !key
            .get("by")
            .and_then(Value::as_str)
            .is_some_and(is_sort_field)
        {
            return Err(at(
                &format!("sort.{index}.by"),
                "A view sorts by an own field or properties.<name>.",
            ));
        }
        if !matches!(
            key.get("direction").and_then(Value::as_str),
            Some("asc" | "desc")
        ) {
            return Err(at(
                &format!("sort.{index}.direction"),
                "direction is asc or desc.",
            ));
        }
    }
    Ok(())
}

fn check_scalars(group: &Map<String, Value>, name: &str) -> Result<()> {
    let Some(value) = group.get(name) else {
        return Ok(());
    };
    let path = format!("group.{name}");
    let Some(values) = value.as_array() else {
        return Err(at(&path, format!("{path} must be a list.")));
    };
    if values.len() > MAX_GROUP_VALUES {
        return Err(at(
            &path,
            format!("{path} holds at most {MAX_GROUP_VALUES} values."),
        ));
    }
    if let Some(index) = values
        .iter()
        .position(|value| value.is_array() || value.is_object())
    {
        return Err(at(&format!("{path}.{index}"), "A group value is a scalar."));
    }
    Ok(())
}

fn check_group(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(group) = value.as_object() else {
        return Err(at("group", "group must be an object."));
    };
    let by = group.get("by").and_then(Value::as_str).unwrap_or_default();
    if !is_sort_field(by) && !is_edge_field(by, catalog) {
        return Err(at(
            "group.by",
            "A view groups by an own field, properties.<name>, or a registered edge type.",
        ));
    }
    if let Some(bucket) = group.get("bucket") {
        if !bucket
            .as_str()
            .is_some_and(|bucket| BUCKETS.contains(&bucket))
        {
            return Err(at(
                "group.bucket",
                "group.bucket is day, week, month or year.",
            ));
        }
        if !DATE_FIELDS.contains(&by) && !is_property(by) {
            return Err(at("group.bucket", "A bucket groups a date field."));
        }
    }
    check_scalars(group, "order")?;
    check_scalars(group, "hidden")
}

/// Refuses a setting `settings` holds that a view may not.
pub fn check(settings: &Map<String, Value>, catalog: &Catalog) -> Result<()> {
    if let Some(title) = settings.get("title") {
        check_title(title)?;
    }
    if let Some(query) = settings.get("query") {
        check_query(query, catalog)?;
    }
    if let Some(sort) = settings.get("sort") {
        check_sort(sort)?;
    }
    match settings.get("group") {
        Some(group) => check_group(group, catalog),
        None => Ok(()),
    }
}

/// Refuses a `null` setting, which only a change's `group` may carry.
pub fn refuse_null(settings: &Map<String, Value>) -> Result<()> {
    match settings.iter().find(|(_, value)| value.is_null()) {
        Some((name, _)) => Err(at(name, format!("{name} cannot be null."))),
        None => Ok(()),
    }
}
