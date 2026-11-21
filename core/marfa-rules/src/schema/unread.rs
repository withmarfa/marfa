//! A key a definition carries that Marfa reads nothing from is refused, with the key it most likely meant.

use serde_json::Value;

use super::{Issue, Obj, REFUSED_TYPE_KEYS, as_obj};

const TYPE_KEYS: [&str; 16] = [
    "id",
    "parent",
    "label",
    "plural",
    "description",
    "guidance",
    "version",
    "fields",
    "tables",
    "roles",
    "display_hints",
    "link_field",
    "version_policy",
    "merge_policy",
    "retention_policy",
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
    "from_type_constraints",
    "to_type_constraints",
    "cascade_on_delete",
    "property_schema",
    "reverse_name",
    "written_from",
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

    #[test]
    fn each_nested_list_holds_the_keys_its_model_has() {
        fn sorted<'a>(keys: &[&'a str]) -> Vec<&'a str> {
            let mut keys = keys.to_vec();
            keys.sort_unstable();
            keys
        }
        assert_eq!(
            sorted(&HINT_KEYS),
            ["body_field", "icon", "name_from_body", "title_field"]
        );
        assert_eq!(
            sorted(&VERSION_KEYS),
            [
                "daily_snapshot_days",
                "max_versions",
                "recent_days",
                "weekly_snapshot_days"
            ]
        );
        assert_eq!(sorted(&MERGE_KEYS), ["default", "fields"]);
        assert_eq!(sorted(&RETENTION_KEYS), ["feed_days"]);
        let left_out = [
            "items_fields",
            "label",
            "max_items",
            "max_length",
            "maximum",
            "minimum",
            "searchable",
            "status_values",
        ];
        assert_eq!(
            sorted(&EDGE_PROPERTY_KEYS),
            sorted(
                &FIELD_KEYS
                    .into_iter()
                    .filter(|key| !left_out.contains(key))
                    .collect::<Vec<_>>()
            )
        );
    }

    /// Whether registration reads `key`: some value of it is refused where it is, or it is stored back as written.
    fn is_read(
        build: impl Fn(Value) -> Value,
        at: &str,
        held: impl Fn(&Obj) -> Option<Value>,
    ) -> bool {
        use serde_json::json;
        let registry = super::super::Registry::default();
        let key = at.rsplit('.').next().unwrap_or(at);
        [
            json!(7),
            json!(["a"]),
            json!("a"),
            json!({"a": 1}),
            json!(true),
        ]
        .into_iter()
        .any(
            |value| match super::super::validate_type(&build(value.clone()), &registry) {
                Err(issues) => issues
                    .iter()
                    .filter(|issue| !issue.actual.starts_with("an unread key"))
                    .any(|issue| issue.field == at || issue.field.starts_with(&format!("{at}."))),
                Ok(stored) => held(&stored).is_some_and(|holder| holder.get(key) == Some(&value)),
            },
        )
    }

    #[test]
    fn every_key_the_lists_name_is_read_by_registration() {
        use serde_json::json;
        // The witness: a key nothing reads is neither refused for its value nor stored back.
        let invented = |value: Value| {
            let mut input = json!({"id": "user.t", "fields": {"title": {"type": "string"}}});
            input["invented_key"] = value;
            input
        };
        assert!(!is_read(invented, "invented_key", |stored| Some(
            Value::Object(stored.clone())
        )));
        for key in TYPE_KEYS {
            let build = |value: Value| {
                let mut input = json!({"id": "user.t", "fields": {"title": {"type": "string"}}});
                input[key] = value;
                input
            };
            assert!(
                is_read(build, key, |stored| Some(Value::Object(stored.clone()))),
                "type key {key} is listed and not read"
            );
        }
        for key in FIELD_KEYS {
            let build = |value: Value| {
                let mut field = json!({"type": "string"});
                field[key] = value;
                json!({"id": "user.t", "fields": {"title": field}})
            };
            assert!(
                is_read(build, &format!("fields.title.{key}"), |stored| {
                    stored["fields"].get("title").cloned()
                }),
                "field key {key} is listed and not read"
            );
        }
        for (holder, keys) in [
            ("display_hints", &HINT_KEYS[..]),
            ("version_policy", &VERSION_KEYS[..]),
            ("merge_policy", &MERGE_KEYS[..]),
            ("retention_policy", &RETENTION_KEYS[..]),
        ] {
            for key in keys {
                let build = |value: Value| json!({"id": "user.t", "fields": {"title": {"type": "string"}}, holder: {*key: value}});
                assert!(
                    is_read(build, &format!("{holder}.{key}"), |stored| stored
                        .get(holder)
                        .cloned()),
                    "{holder} key {key} is listed and not read"
                );
            }
        }
    }

    #[test]
    fn every_key_the_edge_lists_name_is_read_by_registration() {
        use serde_json::json;
        let values = [
            json!(7),
            json!(["a"]),
            json!("a"),
            json!({"a": 1}),
            json!(true),
        ];
        let refused = |body: Value| {
            let body = body.as_object().cloned().unwrap_or_default();
            super::super::request_shape(&body).is_err()
                || super::super::edge_type_from_request(
                    &body,
                    &|_| None,
                    super::super::Judging::Register,
                )
                .is_err()
        };
        for key in EDGE_KEYS {
            assert!(
                values.iter().any(|value| {
                    let mut body =
                        json!({"id": "cites", "label": "L", "cardinality": "many-to-many"});
                    body[key] = value.clone();
                    refused(body)
                }),
                "edge key {key} is listed and not read"
            );
        }
        for key in EDGE_PROPERTY_KEYS {
            assert!(
                values.iter().any(|value| {
                    let mut property = json!({"type": "string"});
                    property[key] = value.clone();
                    refused(
                        json!({"id": "cites", "label": "L", "cardinality": "many-to-many",
                                   "property_schema": {"weight": property}}),
                    )
                }),
                "edge property key {key} is listed and not read"
            );
        }
    }
}
