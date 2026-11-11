//! A field definition: what a registration holds it to, and the form the registry stores.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

use super::{
    Issue, MAX_LABEL_LENGTH, Obj, as_obj, describe, kind, number, positive_integer, text, whole,
};
use crate::builtin;
use crate::catalog::{STATUS_GROUPS, api_name};

const ANNOTATING_FORMATS: [&str; 4] = ["bcp47", "iso3166", "currency", "phone"];

pub(super) struct Vocabulary {
    pub field_types: Vec<String>,
    pub member_types: Vec<String>,
    pub collapses: HashMap<String, String>,
    pub formats: Vec<String>,
}

pub(super) fn vocabulary() -> &'static Vocabulary {
    static HELD: OnceLock<Vocabulary> = OnceLock::new();
    HELD.get_or_init(|| {
        let collapses = builtin::format_field_types().cloned().unwrap_or_default();
        let mut formats: Vec<String> = collapses.keys().cloned().collect();
        formats.sort_unstable();
        formats.extend(ANNOTATING_FORMATS.map(str::to_string));
        Vocabulary {
            field_types: builtin::field_types().unwrap_or_default(),
            member_types: builtin::entry_member_types().unwrap_or_default(),
            collapses,
            formats,
        }
    })
}

/// The format a kind absorbs is gone, and only what differs from the default is kept.
pub fn normalize_field(raw: &Obj, required: Option<bool>) -> Obj {
    let vocabulary = vocabulary();
    let declared_format = text(raw, "format").filter(|f| vocabulary.formats.iter().any(|v| v == f));
    let collapsed = declared_format.and_then(|f| vocabulary.collapses.get(f));
    let is_list = text(raw, "type") == Some("array");
    let mut out = Map::new();
    let held_kind = if is_list {
        raw.get("type").cloned()
    } else {
        collapsed
            .map(|c| json!(c))
            .or_else(|| raw.get("type").cloned())
    };
    out.insert("type".into(), held_kind.unwrap_or(Value::Null));
    for key in ["label", "description"] {
        if let Some(Value::String(value)) = raw
            .get(key)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            out.insert(key.into(), json!(value));
        }
    }
    if required.unwrap_or_else(|| super::required(raw)) {
        out.insert("required".into(), json!(true));
    }
    if let Some(values @ Value::Array(_)) = raw.get("enum_values") {
        out.insert("enum_values".into(), values.clone());
    }
    if let Some(Value::Array(words)) = raw.get("status_values") {
        let words = words.iter().map(|entry| {
            let entry = entry.as_object();
            let mut word = Map::new();
            if let Some(value) = entry.and_then(|e| e.get("value")) {
                word.insert("value".into(), value.clone());
            }
            if let Some(group) = entry.and_then(|e| e.get("group")) {
                word.insert("group".into(), group.clone());
            }
            Value::Object(word)
        });
        out.insert("status_values".into(), Value::Array(words.collect()));
    }
    if let Some(items) = text(raw, "items_type") {
        let items = if is_list {
            collapsed.map_or(items, String::as_str)
        } else {
            items
        };
        out.insert("items_type".into(), json!(items));
    }
    if let (Some(format), None) = (declared_format, collapsed) {
        out.insert("format".into(), json!(format));
    }
    if raw.get("searchable") == Some(&Value::Bool(false)) {
        out.insert("searchable".into(), json!(false));
    }
    for key in ["max_length", "max_items", "minimum", "maximum"] {
        if let Some(value @ Value::Number(_)) = raw.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(members) = as_obj(raw.get("items_fields"))
        && is_list
        && text(raw, "items_type") == Some("object")
    {
        let members = members.iter().map(|(name, def)| {
            let def = def
                .as_object()
                .cloned()
                .unwrap_or_else(|| Map::from_iter([("type".to_string(), json!("string"))]));
            (name.clone(), Value::Object(normalize_field(&def, None)))
        });
        out.insert("items_fields".into(), Value::Object(members.collect()));
    }
    out
}

pub(super) fn label_issue(field: &str, value: Option<&Value>, errors: &mut Vec<Issue>, hint: &str) {
    let Some(value) = value else { return };
    let length = value.as_str().map(|s| s.chars().count());
    if length.is_none_or(|n| n > MAX_LABEL_LENGTH) {
        errors.push(Issue::new(
            field,
            format!("a string of at most {MAX_LABEL_LENGTH} characters, or nothing"),
            match length {
                Some(n) => format!("a string of {n} characters"),
                None => describe(Some(value)),
            },
            hint,
        ));
    }
}

pub(super) struct Shape<'a> {
    pub inherits_status: bool,
    pub path: Option<&'a str>,
}

pub(super) fn validate_field_shape(
    name: &str,
    definition: &Value,
    errors: &mut Vec<Issue>,
    shape: &Shape<'_>,
) {
    let path = shape
        .path
        .map_or_else(|| format!("fields.{name}"), str::to_string);
    let Some(fd) = definition.as_object() else {
        errors.push(Issue::new(
            path.clone(),
            "an object describing the field",
            describe(Some(definition)),
            format!("Write {path} as {{ \"type\": \"string\", \"description\": \"...\" }}."),
        ));
        return;
    };
    let vocabulary = vocabulary();
    let issue = |suffix: &str, expected: String, actual: String, hint: String| {
        Issue::new(format!("{path}.{suffix}"), expected, actual, hint)
    };
    let held_kind = fd.get("type");
    let held_kind_text = held_kind.and_then(Value::as_str);
    label_issue(
        &format!("{path}.label"),
        fd.get("label"),
        errors,
        "A label is the name an app shows for it. Omit it to make one from the name.",
    );
    let one_of = format!("one of: {}", vocabulary.field_types.join(", "));
    match held_kind_text {
        None | Some("") => errors.push(issue(
            "type",
            one_of,
            describe(held_kind),
            "Every field declares a type. Use `string` when in doubt.".into(),
        )),
        Some(word) if !vocabulary.field_types.iter().any(|t| t == word) => errors.push(issue(
            "type",
            one_of,
            describe(held_kind),
            format!("\"{word}\" is not a field type. For a semantic refinement of a string, use \"format\" instead."),
        )),
        Some(_) => {}
    }
    let type_word = held_kind_text.unwrap_or("");
    if let Some(format) = text(fd, "format") {
        if !vocabulary.formats.iter().any(|f| f == format) {
            errors.push(issue(
                "format",
                format!("one of: {}", vocabulary.formats.join(", ")),
                describe(fd.get("format")),
                "Drop the format, or pick one of the supported values.".into(),
            ));
        } else if let Some(collapsed) = vocabulary.collapses.get(format) {
            let items = text(fd, "items_type");
            let fits_list = type_word == "array"
                && collapsed != "thumbnail"
                && (items == Some("string") || items == Some(collapsed.as_str()));
            if type_word != "string" && type_word != collapsed && !fits_list {
                errors.push(issue(
                    "format",
                    if collapsed == "thumbnail" {
                        "format \"thumbnail\" on a string field".to_string()
                    } else {
                        format!("format \"{format}\" on a string field, a {collapsed} field or a list of strings")
                    },
                    format!("format \"{format}\" on a {} field", describe(held_kind)),
                    format!("Set the field type to \"{collapsed}\" and drop the format."),
                ));
            }
        } else if type_word != "string" {
            errors.push(issue(
                "format",
                format!("format \"{format}\" on a string field"),
                format!("format \"{format}\" on a {} field", describe(held_kind)),
                format!("The {format} format annotates string contents. Set the field type to \"string\"."),
            ));
        }
    }
    if type_word == "enum" {
        let expected = "a non-empty array of allowed string values".to_string();
        match fd.get("enum_values") {
            Some(Value::Array(values)) if values.is_empty() => errors.push(issue(
                "enum_values",
                expected,
                "an empty array".into(),
                "An enum with no values can never validate. List the allowed values.".into(),
            )),
            Some(Value::Array(values)) if !values.iter().all(Value::is_string) => {
                errors.push(issue(
                    "enum_values",
                    "every entry to be a string".into(),
                    describe(fd.get("enum_values")),
                    "Enum values cross the wire as JSON strings. Quote the non-string entries."
                        .into(),
                ))
            }
            Some(Value::Array(_)) => {}
            other => errors.push(issue(
                "enum_values",
                expected,
                describe(other),
                "Add enum_values, e.g. [\"open\", \"closed\"], or change the type to \"string\"."
                    .into(),
            )),
        }
    }
    if type_word == "status" {
        validate_status_values(fd, shape.inherits_status, &path, errors);
    } else if fd.contains_key("status_values") {
        errors.push(issue(
            "status_values",
            "status_values on a status field".into(),
            format!("status_values on a {} field", describe(held_kind)),
            "Set the type to \"status\", or drop status_values.".into(),
        ));
    }
    if type_word == "status" && fd.contains_key("enum_values") {
        errors.push(issue(
            "enum_values",
            "no enum_values on a status field".into(),
            describe(fd.get("enum_values")),
            "A status field lists its words in status_values, each with its group.".into(),
        ));
    }
    if text(fd, "items_type") == Some("status") {
        errors.push(issue(
            "items_type",
            "an element type other than status".into(),
            "\"status\"".into(),
            "An item has one status. Declare it as its own field of type status.".into(),
        ));
    }
    if type_word == "array" && !fd.get("items_type").is_some_and(Value::is_string) {
        errors.push(issue(
            "items_type",
            "a string naming the element type".into(),
            describe(fd.get("items_type")),
            "Add items_type, e.g. \"string\" or \"object\".".into(),
        ));
    }
    if text(fd, "items_type") == Some("thumbnail") {
        errors.push(issue(
            "items_type",
            "an element type other than thumbnail".into(),
            "\"thumbnail\"".into(),
            "A thumbnail is one image a type carries. Declare it as its own field of type thumbnail.".into(),
        ));
    }
    if fd.get("searchable").is_some_and(|v| !v.is_boolean()) {
        errors.push(issue(
            "searchable",
            "a boolean".into(),
            describe(fd.get("searchable")),
            "Set searchable: false to keep the field out of full-text search; omit it to index the field.".into(),
        ));
    }
    for cap in ["max_length", "max_items"] {
        if fd.contains_key(cap) && !positive_integer(fd.get(cap)) {
            errors.push(issue(
                cap,
                "a positive integer".into(),
                describe(fd.get(cap)),
                format!(
                    "{cap} bounds a single field's size; a value below 1 would reject every write."
                ),
            ));
        }
    }
    if fd.contains_key("max_length") && type_word != "string" && type_word != "enum" {
        errors.push(issue(
            "max_length",
            "max_length on a string or enum field".into(),
            format!("max_length on a {} field", describe(held_kind)),
            "max_length bounds string length. Use max_items for arrays; drop it elsewhere.".into(),
        ));
    } else if fd.contains_key("max_length") && text(fd, "format") == Some("currency") {
        errors.push(issue(
            "max_length",
            "no max_length on a currency field".into(),
            describe(fd.get("max_length")),
            "A currency code is always three capital letters, so a length bound would be ignored. Drop max_length.".into(),
        ));
    }
    if fd.contains_key("max_items") && type_word != "array" {
        errors.push(issue(
            "max_items",
            "max_items on an array field".into(),
            format!("max_items on a {} field", describe(held_kind)),
            "max_items bounds element count. Use max_length for strings; drop it elsewhere.".into(),
        ));
    }
    validate_range(&path, fd, errors);
    validate_items_fields(&path, fd, errors);
}

fn validate_range(path: &str, fd: &Obj, errors: &mut Vec<Issue>) {
    let type_word = kind(fd).unwrap_or("");
    let mut bounds = Vec::new();
    for bound in ["minimum", "maximum"] {
        let Some(value) = fd.get(bound) else { continue };
        let at = format!("{path}.{bound}");
        if type_word != "number" && type_word != "integer" {
            errors.push(Issue::new(
                at,
                format!("{bound} on a number or integer field"),
                format!("{bound} on a {} field", describe(fd.get("type"))),
                format!("{bound} bounds a number. Use max_length for the length of a string and max_items for the count of a list; drop it elsewhere."),
            ));
        } else if !number(Some(value)).is_some_and(f64::is_finite) {
            errors.push(Issue::new(
                at,
                "a finite number",
                describe(Some(value)),
                format!("Write {bound} as a number such as 0 or 2.5."),
            ));
        } else if type_word == "integer" && !number(Some(value)).is_some_and(whole) {
            errors.push(Issue::new(
                at,
                "a whole number on an integer field",
                describe(Some(value)),
                format!("An integer field takes only whole numbers, so a {bound} between two of them is ambiguous. Use a whole number, or make the field a number."),
            ));
        } else {
            bounds.push(number(Some(value)).unwrap_or_default());
        }
    }
    if let [low, high] = bounds[..]
        && low > high
    {
        errors.push(Issue::new(
            format!("{path}.minimum"),
            "a minimum no higher than the maximum",
            format!("minimum {low} above maximum {high}"),
            "No value fits between them. Swap the bounds, or drop one.",
        ));
    }
}

fn validate_items_fields(path: &str, fd: &Obj, errors: &mut Vec<Issue>) {
    let Some(members) = fd.get("items_fields") else {
        return;
    };
    let at = format!("{path}.items_fields");
    if kind(fd) != Some("array") || text(fd, "items_type") != Some("object") {
        errors.push(Issue::new(
            at,
            "items_fields on an array field whose items_type is object",
            format!(
                "items_fields on {}",
                if kind(fd) == Some("array") {
                    format!("an array of {}", describe(fd.get("items_type")))
                } else {
                    format!("a {} field", describe(fd.get("type")))
                }
            ),
            "Set the field to { \"type\": \"array\", \"items_type\": \"object\" }, or drop items_fields.",
        ));
        return;
    }
    let Some(members) = members.as_object().filter(|m| !m.is_empty()) else {
        errors.push(Issue::new(
            at,
            "an object naming at least one member",
            describe(fd.get("items_fields")),
            "Name each member of an entry, e.g. { \"value\": { \"type\": \"string\" } }, or drop items_fields.",
        ));
        return;
    };
    for (member, definition) in members {
        validate_member(&format!("{at}.{member}"), definition, errors);
    }
}

/// A plain value of a kind a list entry's member may take.
pub(super) fn validate_member(path: &str, definition: &Value, errors: &mut Vec<Issue>) {
    let vocabulary = vocabulary();
    if let Some(record) = definition.as_object()
        && let Some(declared) = text(record, "type")
    {
        let folded = normalize_field(record, None);
        let folded_kind = kind(&folded).unwrap_or("");
        if vocabulary.field_types.iter().any(|t| t == declared)
            && !vocabulary.member_types.iter().any(|t| t == folded_kind)
        {
            errors.push(Issue::new(
                format!("{path}.type"),
                format!("one of: {}", vocabulary.member_types.join(", ")),
                describe(folded.get("type")),
                "A member of an entry is a plain value. A list, an object, a status or a thumbnail would need nesting an entry does not have.",
            ));
            return;
        }
    }
    validate_field_shape(
        path,
        definition,
        errors,
        &Shape {
            inherits_status: false,
            path: Some(path),
        },
    );
}

fn validate_status_values(
    fd: &Obj,
    inherits_status: bool,
    field_path: &str,
    errors: &mut Vec<Issue>,
) {
    let path = format!("{field_path}.status_values");
    let list = fd.get("status_values");
    if list.is_none() && inherits_status {
        return;
    }
    let words = match list {
        Some(Value::Array(words)) if !words.is_empty() => words,
        _ => {
            errors.push(Issue::new(
                path,
                format!(
                    "a non-empty array of {{ \"value\", \"group\" }} objects, each group one of: {}",
                    STATUS_GROUPS.join(", ")
                ),
                match list {
                    Some(Value::Array(_)) => "an empty array".to_string(),
                    other => describe(other),
                },
                "List the words the field takes, e.g. [{ \"value\": \"not_started\", \"group\": \"not_started\" }].",
            ));
            return;
        }
    };
    let mut seen = HashSet::new();
    for (index, entry) in words.iter().enumerate() {
        let at = format!("{path}.{index}");
        let record = entry.as_object();
        let mut keys: Vec<&str> = record
            .into_iter()
            .flat_map(|r| r.keys().map(String::as_str))
            .collect();
        keys.sort_unstable();
        let keys = keys.join(",");
        let Some(record) = record.filter(|_| keys == "group,value") else {
            errors.push(Issue::new(
                at,
                "an object with exactly \"value\" and \"group\"",
                if entry.is_object() {
                    format!(
                        "an object with keys {}",
                        if keys.is_empty() { "none" } else { &keys }
                    )
                } else {
                    describe(Some(entry))
                },
                "Write each word as { \"value\": \"blocked\", \"group\": \"in_progress\" }.",
            ));
            continue;
        };
        match record.get("value").and_then(Value::as_str) {
            Some(word) if api_name(word) => {
                if !seen.insert(word.to_string()) {
                    errors.push(Issue::new(
                        format!("{at}.value"),
                        "each word once",
                        format!("\"{word}\" again"),
                        "A word belongs to one group. Remove the repeat.",
                    ));
                }
            }
            _ => errors.push(Issue::new(
                format!("{at}.value"),
                "a word of a lowercase letter, then up to 63 lowercase letters, digits and underscores",
                describe(record.get("value")),
                "Write the word as an API name, such as in_review. Apps show their own labels.",
            )),
        }
        if !record
            .get("group")
            .and_then(Value::as_str)
            .is_some_and(|g| STATUS_GROUPS.contains(&g))
        {
            errors.push(Issue::new(
                format!("{at}.group"),
                format!("one of: {}", STATUS_GROUPS.join(", ")),
                describe(record.get("group")),
                "The four groups are fixed. Put the word in the one it belongs to.",
            ));
        }
    }
}
