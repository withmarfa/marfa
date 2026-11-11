//! A key a definition carries that Marfa reads nothing from is refused, with the key it most likely meant.

use serde_json::Value;

use super::{Issue, Obj, REFUSED_TYPE_KEYS, as_obj};

const TYPE_KEYS: [&str; 16] = [
    "id",
    "parent",
    "label",
    "plural",
    "description",
    "version",
    "fields",
    "tables",
    "roles",
    "display_hints",
    "link_field",
    "version_policy",
    "merge_policy",
    "retention_policy",
    "compatible_with",
    "required",
];
const FIELD_KEYS: [&str; 14] = [
    "type",
    "label",
    "description",
    "required",
    "enum_values",
    "status_values",
    "items_type",
    "items_fields",
    "format",
    "searchable",
    "max_length",
    "max_items",
    "minimum",
    "maximum",
];
const MEMBER_KEYS: [&str; 9] = [
    "type",
    "label",
    "description",
    "required",
    "enum_values",
    "format",
    "max_length",
    "minimum",
    "maximum",
];
const TABLE_KEYS: [&str; 4] = ["label", "description", "columns", "order"];
const COLUMN_KEYS: [&str; 12] = [
    "type",
    "label",
    "description",
    "required",
    "enum_values",
    "format",
    "max_length",
    "minimum",
    "maximum",
    "type_constraints",
    "adds_up",
    "searchable",
];
const HINT_KEYS: [&str; 4] = ["title_field", "body_field", "name_from_body", "icon"];
const VERSION_KEYS: [&str; 4] = [
    "recent_days",
    "daily_snapshot_days",
    "weekly_snapshot_days",
    "max_versions",
];
const MERGE_KEYS: [&str; 2] = ["fields", "default"];
const RETENTION_KEYS: [&str; 1] = ["feed_days"];
const EDGE_KEYS: [&str; 11] = [
    "id",
    "label",
    "reverse_label",
    "description",
    "cardinality",
    "source_type_constraints",
    "target_type_constraints",
    "cascade_on_delete",
    "property_schema",
    "reverse_name",
    "written_at",
];
const EDGE_PROPERTY_KEYS: [&str; 6] = [
    "type",
    "description",
    "required",
    "enum_values",
    "items_type",
    "format",
];

fn squash(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn unread_of(
    value: &Obj,
    path: &str,
    read: &[&str],
    holder: &str,
    left_to_the_validator: &[&str],
) -> Vec<Issue> {
    value
        .keys()
        .filter(|key| !read.contains(&key.as_str()) && !left_to_the_validator.contains(&key.as_str()))
        .map(|key| {
            let likely = read.iter().find(|known| squash(known) == squash(key));
            let mut sorted = read.to_vec();
            sorted.sort_unstable();
            Issue::new(
                if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                },
                format!("only the keys {holder} takes: {}", sorted.join(", ")),
                format!("an unread key \"{key}\""),
                match likely {
                    None => "Remove it: Marfa reads no such key, so it would change nothing about the type.".to_string(),
                    Some(likely) => format!("Marfa reads no key \"{key}\". Write \"{likely}\" if that is the rule you meant."),
                },
            )
        })
        .collect()
}

pub fn unread_keys(input: &Obj) -> Vec<Issue> {
    let mut issues = unread_of(input, "", &TYPE_KEYS, "a type schema", &REFUSED_TYPE_KEYS);
    for (name, definition) in as_obj(input.get("fields")).into_iter().flatten() {
        let Some(definition) = definition.as_object() else {
            continue;
        };
        let path = format!("fields.{name}");
        issues.extend(unread_of(
            definition,
            &path,
            &FIELD_KEYS,
            "a field definition",
            &[],
        ));
        for (member, held) in as_obj(definition.get("items_fields")).into_iter().flatten() {
            if let Value::Object(held) = held {
                issues.extend(unread_of(
                    held,
                    &format!("{path}.items_fields.{member}"),
                    &MEMBER_KEYS,
                    "a member of a list entry",
                    &[],
                ));
            }
        }
    }
    for (key, read) in [
        ("display_hints", &HINT_KEYS[..]),
        ("version_policy", &VERSION_KEYS[..]),
        ("merge_policy", &MERGE_KEYS[..]),
        ("retention_policy", &RETENTION_KEYS[..]),
    ] {
        if let Some(record) = as_obj(input.get(key)) {
            issues.extend(unread_of(record, key, read, key, &[]));
        }
    }
    issues
}

pub(super) fn unread_table_keys(definition: &Obj, path: &str) -> Vec<Issue> {
    unread_of(definition, path, &TABLE_KEYS, "a table definition", &[])
}

pub(super) fn unread_column_keys(definition: &Obj, path: &str) -> Vec<Issue> {
    unread_of(definition, path, &COLUMN_KEYS, "a column definition", &[])
}

pub fn unread_edge_keys(input: &Obj) -> Vec<Issue> {
    let mut issues = unread_of(input, "", &EDGE_KEYS, "an edge type schema", &[]);
    for (name, definition) in as_obj(input.get("property_schema")).into_iter().flatten() {
        if let Value::Object(definition) = definition {
            issues.extend(unread_of(
                definition,
                &format!("property_schema.{name}"),
                &EDGE_PROPERTY_KEYS,
                "an edge property",
                &[],
            ));
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_column_takes_every_key_a_member_of_an_entry_takes() {
        for key in MEMBER_KEYS {
            assert!(COLUMN_KEYS.contains(&key), "{key}");
        }
    }
}
