//! An edge type registration: the request and the form the registry stores.

use serde_json::{Map, Value, json};

use super::field::{Shape, Stray, normalize_field, validate_field_shape};
use super::{Issue, Obj, ROLE_PREFIX, TYPE_ROLES, as_obj, is_role_constraint, known_role, text};
use crate::builtin;
use crate::wire::label_from_id;

const CARDINALITIES: [&str; 4] = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"];
const CASCADES: [&str; 4] = ["cascade", "orphan", "block", "with-hosts"];
const WRITTEN_FROM: [&str; 3] = ["from", "to", "none"];

#[derive(Debug, Clone, PartialEq)]
pub enum EdgeIssues {
    /// `missing_required_field`.
    Missing { field: &'static str },
    /// `validation_error`, naming the field where one is at fault.
    Validation {
        message: String,
        field: Option<String>,
    },
    /// `invalid_schema`.
    Schema(Vec<Issue>),
    /// `conflict`.
    Conflict {
        message: String,
        field: Option<&'static str>,
        held_by: Option<String>,
    },
}

#[derive(Clone, Copy, PartialEq)]
pub enum Judging<'a> {
    Register,
    /// Carries the stored edge type for comparison.
    Evolve(&'a Obj),
    /// An archive can carry shapes accepted when it was made.
    Restore,
}

fn invalid(message: impl Into<String>, field: Option<&str>) -> EdgeIssues {
    EdgeIssues::Validation {
        message: message.into(),
        field: field.map(str::to_string),
    }
}

pub fn edge_id(name: &str) -> bool {
    if name.contains('.') {
        return crate::grammar::type_id(name).unwrap_or(false);
    }
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && name
            .chars()
            .last()
            .is_some_and(|last| last.is_ascii_lowercase() || last.is_ascii_digit())
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// `evolve_constraints` is allowed and belongs to the caller.
pub fn request_shape(body: &Obj) -> Result<(), EdgeIssues> {
    for field in ["id", "cardinality"] {
        if !body.contains_key(field) {
            return Err(EdgeIssues::Missing {
                field: if field == "id" { "id" } else { "cardinality" },
            });
        }
    }
    let text_of = |key: &str| body.get(key).map(Value::as_str);
    if text_of("id") == Some(None) || body.get("id").and_then(Value::as_str) == Some("") {
        return Err(invalid("id is a non-empty string", Some("id")));
    }
    for key in ["label", "description", "reverse_name"] {
        if text_of(key) == Some(None) {
            return Err(invalid(format!("{key} is a string"), None));
        }
    }
    if body
        .get("reverse_label")
        .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
    {
        return Err(invalid(
            "reverse_label is a non-empty string",
            Some("reverse_label"),
        ));
    }
    for (key, allowed) in [
        ("cardinality", &CARDINALITIES[..]),
        ("cascade_on_delete", &CASCADES[..]),
        ("written_from", &WRITTEN_FROM[..]),
    ] {
        if body
            .get(key)
            .is_some_and(|v| !v.as_str().is_some_and(|s| allowed.contains(&s)))
        {
            return Err(invalid(
                format!("{key} is one of {}", allowed.join(", ")),
                None,
            ));
        }
    }
    for side in ["from_type_constraints", "to_type_constraints"] {
        let Some(value) = body.get(side) else {
            continue;
        };
        let Some(entries) = value.as_array() else {
            return Err(invalid(
                format!("{side} is an array of type constraints"),
                None,
            ));
        };
        for entry in entries {
            let Some(entry) = entry.as_str().filter(|e| !e.is_empty()) else {
                return Err(invalid(format!("{side} holds non-empty strings"), None));
            };
            if is_role_constraint(entry) && !known_role(entry) {
                let roles: Vec<String> = TYPE_ROLES
                    .iter()
                    .map(|r| format!("{ROLE_PREFIX}{r}"))
                    .collect();
                return Err(invalid(
                    format!("Unknown role constraint. Known roles: {}", roles.join(", ")),
                    None,
                ));
            }
        }
    }
    if body
        .get("evolve_constraints")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid("evolve_constraints is true or false", None));
    }
    let Some(properties) = body.get("property_schema") else {
        return Ok(());
    };
    let Some(properties) = properties.as_object() else {
        return Err(invalid(
            "property_schema is an object of property definitions",
            None,
        ));
    };
    for (name, definition) in properties {
        let Some(definition) = definition.as_object() else {
            return Err(invalid(
                format!("property_schema.{name} is an object"),
                Some(&format!("property_schema.{name}")),
            ));
        };
        if !definition.get("type").is_some_and(Value::is_string) {
            return Err(invalid(
                format!("property_schema.{name}.type is a string"),
                Some(&format!("property_schema.{name}.type")),
            ));
        }
        for key in ["type", "items_type"] {
            if matches!(text(definition, key), Some("thumbnail" | "status")) {
                return Err(invalid(
                    "An edge never carries a thumbnail or a status",
                    Some(&format!("property_schema.{name}.{key}")),
                ));
            }
        }
        if text(definition, "format") == Some("thumbnail") {
            return Err(invalid(
                "An edge never carries a thumbnail",
                Some(&format!("property_schema.{name}.format")),
            ));
        }
        if definition.get("items_type").is_some_and(|v| !v.is_string())
            || definition.get("format").is_some_and(|v| !v.is_string())
            || definition
                .get("description")
                .is_some_and(|v| !v.is_string())
            || definition.get("required").is_some_and(|v| !v.is_boolean())
            || definition
                .get("enum_values")
                .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
        {
            return Err(invalid(
                format!("property_schema.{name} is not a property definition"),
                None,
            ));
        }
    }
    Ok(())
}

fn shipped_holder(name: &str, except: &str) -> Option<String> {
    builtin::shipped_edge_types()
        .ok()?
        .iter()
        .filter_map(Value::as_object)
        .find_map(|edge| {
            let id = text(edge, "id")?;
            (id != except && (id == name || text(edge, "reverse_name") == Some(name)))
                .then(|| id.to_string())
        })
}

/// `taken` answers who holds a name among the registered edge types.
fn names_free(
    id: &str,
    reverse: Option<&str>,
    taken: &dyn Fn(&str) -> Option<String>,
) -> Result<(), EdgeIssues> {
    let mut claims = vec![("id", id)];
    if let Some(reverse) = reverse {
        claims.push(("reverse_name", reverse));
    }
    for (field, name) in claims {
        let holder = shipped_holder(name, id).or_else(|| taken(name));
        if let Some(holder) = holder.filter(|holder| holder != id) {
            return Err(EdgeIssues::Conflict {
                message: format!("\"{name}\" is already a name of the edge type {holder}"),
                field: Some(if field == "id" { "id" } else { "reverse_name" }),
                held_by: Some(holder),
            });
        }
    }
    Ok(())
}

pub fn edge_type_from_request(
    body: &Obj,
    taken: &dyn Fn(&str) -> Option<String>,
    judging: Judging<'_>,
) -> Result<Obj, EdgeIssues> {
    let id = text(body, "id").unwrap_or_default();
    let properties = as_obj(body.get("property_schema"))
        .cloned()
        .unwrap_or_default();
    let mut refused = Vec::new();
    let mut normalized = Map::new();
    for (name, definition) in &properties {
        if let Judging::Evolve(held) = judging
            && as_obj(held.get("property_schema")).and_then(|held| held.get(name))
                == Some(definition)
        {
            normalized.insert(name.clone(), definition.clone());
            continue;
        }
        let prefix = format!("property_schema.{name}");
        let mut found = Vec::new();
        validate_field_shape(
            name,
            definition,
            &mut found,
            &Shape {
                inherits_status: false,
                path: Some(&prefix),
                stray: Stray::Refuse,
            },
        );
        if judging == Judging::Restore {
            found.retain(|issue| {
                issue.field == format!("{prefix}.format") || issue.field == format!("{prefix}.type")
            });
        }
        match definition.as_object() {
            Some(record) if found.is_empty() => {
                normalized.insert(name.clone(), Value::Object(normalize_field(record, None)));
            }
            _ => refused.extend(found),
        }
    }
    if !refused.is_empty() {
        return Err(EdgeIssues::Schema(refused));
    }
    let reverse = text(body, "reverse_name");
    if let Some(reverse) = reverse
        && !edge_id(reverse)
    {
        return Err(invalid(
            "Invalid reverse_name: it takes the edge-type identifier grammar",
            Some("reverse_name"),
        ));
    }
    if text(body, "written_from") == Some("to") && reverse.is_none() {
        return Err(invalid(
            "written_from: to needs a reverse_name, the name the file at the to end writes the edge under",
            Some("written_from"),
        ));
    }
    if reverse == Some(id) {
        return Err(EdgeIssues::Conflict {
            message: "A reverse name cannot be the edge type's own id".into(),
            field: Some("reverse_name"),
            held_by: Some(id.to_string()),
        });
    }
    names_free(id, reverse, taken)?;
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    let label = text(body, "label")
        .filter(|l| !l.is_empty())
        .map_or_else(|| label_from_id(id), str::to_string);
    out.insert("label".into(), json!(label));
    for key in ["reverse_label", "description"] {
        if let Some(value) = body.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert(
        "cardinality".into(),
        body.get("cardinality").cloned().unwrap_or(Value::Null),
    );
    for side in ["from_type_constraints", "to_type_constraints"] {
        out.insert(
            side.into(),
            body.get(side).cloned().unwrap_or_else(|| json!(["*"])),
        );
    }
    out.insert(
        "cascade_on_delete".into(),
        body.get("cascade_on_delete")
            .cloned()
            .unwrap_or_else(|| json!("orphan")),
    );
    out.insert("property_schema".into(), Value::Object(normalized));
    if let Some(reverse) = reverse {
        out.insert("reverse_name".into(), json!(reverse));
    }
    out.insert(
        "written_from".into(),
        body.get("written_from")
            .cloned()
            .unwrap_or_else(|| json!("from")),
    );
    Ok(out)
}

fn unrestricted(values: Option<&Value>) -> bool {
    let list: Vec<&str> = values
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    list.is_empty() || list.contains(&"*")
}

pub fn constraint_evolution_changes(stored: &Obj, next: &Obj) -> Vec<&'static str> {
    let mut changes: Vec<&'static str> = [
        "id",
        "description",
        "cardinality",
        "cascade_on_delete",
        "property_schema",
        "reverse_name",
        "written_from",
    ]
    .into_iter()
    .filter(|key| stored.get(*key) != next.get(*key))
    .collect();
    for side in ["from_type_constraints", "to_type_constraints"] {
        let (before, after) = (stored.get(side), next.get(side));
        let widens = unrestricted(after) || {
            !unrestricted(before)
                && before
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .all(|held| {
                        after
                            .and_then(Value::as_array)
                            .is_some_and(|a| a.contains(held))
                    })
        };
        if !widens {
            changes.push(if side == "from_type_constraints" {
                "from_type_constraints"
            } else {
                "to_type_constraints"
            });
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{EdgeIssues, Judging, Obj, edge_id, edge_type_from_request};

    fn judged(property: Value, judging: Judging<'_>) -> Result<Obj, Vec<String>> {
        let body = json!({"id": "user.cites", "cardinality": "many-to-many",
            "property_schema": {"p": property}});
        match edge_type_from_request(body.as_object().unwrap_or(&Obj::new()), &|_| None, judging) {
            Ok(built) => Ok(built),
            Err(EdgeIssues::Schema(issues)) => {
                Err(issues.into_iter().map(|issue| issue.field).collect())
            }
            Err(other) => panic!("{other:?}"),
        }
    }

    fn registered(property: Value) -> Result<(), Vec<String>> {
        judged(property, Judging::Register).map(|_| ())
    }

    #[test]
    fn a_property_is_refused_for_each_shape_fault_a_field_is_refused_for() {
        assert_eq!(
            registered(json!({"type": "array", "items_type": "string"})),
            Ok(())
        );
        assert_eq!(
            registered(json!({"type": "enum", "enum_values": ["a"]})),
            Ok(())
        );
        for (property, path) in [
            (json!({"type": "array"}), "property_schema.p.items_type"),
            (json!({"type": "enum"}), "property_schema.p.enum_values"),
            (
                json!({"type": "enum", "enum_values": []}),
                "property_schema.p.enum_values",
            ),
            (
                json!({"type": "string", "enum_values": ["a"]}),
                "property_schema.p.enum_values",
            ),
        ] {
            assert_eq!(
                registered(property.clone()),
                Err(vec![path.to_string()]),
                "{property}"
            );
        }
    }

    #[test]
    fn a_restore_and_an_unchanged_property_keep_what_a_registration_would_refuse() {
        let faults = [
            json!({"type": "array"}),
            json!({"type": "enum"}),
            json!({"type": "string", "enum_values": ["a"]}),
        ];
        for fault in faults {
            let restored = judged(fault.clone(), Judging::Restore)
                .unwrap_or_else(|issues| panic!("{fault}: {issues:?}"));
            assert_eq!(restored["property_schema"]["p"]["type"], fault["type"]);
            assert!(judged(fault.clone(), Judging::Register).is_err(), "{fault}");
            assert!(
                judged(fault.clone(), Judging::Evolve(&restored)).is_ok(),
                "{fault}: unchanged"
            );
            let mut changed = fault.clone();
            changed["description"] = json!("now described");
            assert!(
                judged(changed, Judging::Evolve(&restored)).is_err(),
                "{fault}: changed"
            );
        }
        let format = json!({"type": "integer", "format": "url"});
        assert_eq!(
            judged(format, Judging::Restore),
            Err(vec!["property_schema.p.format".to_string()])
        );
    }

    #[test]
    fn an_evolution_judges_a_property_unless_it_is_sent_as_held() {
        let held = judged(json!({"type": "url"}), Judging::Register).unwrap_or_default();
        assert!(judged(json!({"type": "url"}), Judging::Evolve(&held)).is_ok());
        assert!(
            judged(
                json!({"type": "string", "format": "url"}),
                Judging::Evolve(&held)
            )
            .is_ok()
        );
        assert_eq!(
            judged(
                json!({"type": "integer", "format": "url"}),
                Judging::Evolve(&held)
            ),
            Err(vec!["property_schema.p.format".to_string()])
        );
    }

    #[test]
    fn every_property_that_breaks_a_rule_is_named() {
        let body = json!({"id": "user.cites", "cardinality": "many-to-many",
        "property_schema": {
            "a": {"type": "mystery"},
            "b": {"type": "array"},
            "c": {"type": "enum"},
            "d": {"type": "string"}
        }});
        let Err(EdgeIssues::Schema(issues)) = edge_type_from_request(
            body.as_object().unwrap_or(&Obj::new()),
            &|_| None,
            Judging::Register,
        ) else {
            panic!("registered");
        };
        let named: Vec<String> = issues.into_iter().map(|issue| issue.field).collect();
        assert_eq!(
            named,
            [
                "property_schema.a.type",
                "property_schema.b.items_type",
                "property_schema.c.enum_values"
            ]
        );
    }

    #[test]
    fn a_restore_normalizes_a_property_as_a_registration_does_and_keeps_its_faults() {
        let restored = judged(
            json!({"type": "string", "format": "url", "enum_values": ["a"]}),
            Judging::Restore,
        )
        .unwrap_or_default();
        assert_eq!(
            restored["property_schema"]["p"],
            json!({"type": "url", "enum_values": ["a"]})
        );
        for refused in [
            json!({"type": "mystery"}),
            json!({"type": "array", "format": "url"}),
            json!({"type": "integer", "format": "url"}),
        ] {
            assert!(
                judged(refused.clone(), Judging::Restore).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn an_array_naming_no_field_type_is_refused_by_a_registration() {
        assert_eq!(
            registered(json!({"type": "array", "items_type": "somethingelse"})),
            Err(vec!["property_schema.p.items_type".to_string()])
        );
        assert!(
            judged(
                json!({"type": "array", "items_type": "somethingelse"}),
                Judging::Restore
            )
            .is_ok()
        );
    }

    #[test]
    fn an_edge_type_is_one_kebab_word_or_a_namespaced_type_identifier() {
        for name in [
            "related-to",
            "a",
            "snake_case",
            "acme.related-to",
            "user.cites",
        ] {
            assert!(edge_id(name), "{name}");
        }
        for name in ["-", "MY-EDGE", "a b-c", "../-", "a-", "1a", ""] {
            assert!(!edge_id(name), "{name}");
        }
        assert!(!edge_id("acme."));
    }
}
