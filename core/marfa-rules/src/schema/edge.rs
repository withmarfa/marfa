//! An edge type registration: what the request holds, and the form the
//! registry stores.

use serde_json::{Map, Value, json};

use super::field::{Shape, normalize_field, validate_field_shape, vocabulary};
use super::{Issue, Obj, ROLE_PREFIX, TYPE_ROLES, as_obj, is_role_constraint, known_role, text};
use crate::builtin;
use crate::wire::label_from_id;

const CARDINALITIES: [&str; 4] = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"];
const CASCADES: [&str; 4] = ["cascade", "orphan", "block", "with-hosts"];
const WRITTEN_AT: [&str; 3] = ["source", "target", "none"];

/// Why a request for an edge type is refused.
#[derive(Debug, Clone, PartialEq)]
pub enum EdgeIssues {
    /// `missing_required_field`.
    Missing { field: &'static str },
    /// `validation_error`, naming the field where one is at fault.
    Validation {
        message: String,
        field: Option<&'static str>,
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

fn invalid(message: impl Into<String>, field: Option<&'static str>) -> EdgeIssues {
    EdgeIssues::Validation {
        message: message.into(),
        field,
    }
}

/// Whether the edge-type grammar takes `name`: a single kebab-case word, or
/// anything the type grammar takes.
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

/// The shape a request body must have, before anything is read from it.
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
        ("written_at", &WRITTEN_AT[..]),
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
    for side in ["source_type_constraints", "target_type_constraints"] {
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
                None,
            ));
        };
        if !definition.get("type").is_some_and(Value::is_string) {
            return Err(invalid(
                format!("property_schema.{name}.type is a string"),
                None,
            ));
        }
        for key in ["type", "items_type"] {
            if matches!(text(definition, key), Some("thumbnail" | "status")) {
                return Err(invalid(
                    "An edge never carries a thumbnail or a status",
                    None,
                ));
            }
        }
        if text(definition, "format") == Some("thumbnail") {
            return Err(invalid("An edge never carries a thumbnail", None));
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

/// Refuses an id or reverse name another edge type already holds. `taken`
/// answers who holds a name among the registered edge types.
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

/// The edge type a request asks for, in the form the registry stores it.
pub fn edge_type_from_request(
    body: &Obj,
    taken: &dyn Fn(&str) -> Option<String>,
) -> Result<Obj, EdgeIssues> {
    let id = text(body, "id").unwrap_or_default();
    let properties = as_obj(body.get("property_schema"))
        .cloned()
        .unwrap_or_default();
    let kinds = &vocabulary().field_types;
    let unknown: Vec<Issue> = properties
        .iter()
        .filter_map(|(name, property)| {
            let held = as_obj(Some(property)).and_then(|p| text(p, "type"))?;
            (!kinds.iter().any(|k| k == held)).then(|| {
                Issue::new(
                    format!("property_schema.{name}.type"),
                    format!("one of: {}", kinds.join(", ")),
                    held,
                    format!("\"{held}\" is not a field type"),
                )
            })
        })
        .collect();
    if !unknown.is_empty() {
        return Err(EdgeIssues::Schema(unknown));
    }
    let mut refused = Vec::new();
    let mut normalized = Map::new();
    for (name, definition) in &properties {
        let mut found = Vec::new();
        validate_field_shape(
            name,
            definition,
            &mut found,
            &Shape {
                inherits_status: false,
                path: None,
            },
        );
        let prefix = format!("fields.{name}.format");
        let before = refused.len();
        refused.extend(
            found
                .into_iter()
                .filter(|i| i.field == prefix)
                .map(|mut i| {
                    i.field = format!("property_schema.{name}.format");
                    i
                }),
        );
        if refused.len() == before
            && let Some(record) = definition.as_object()
        {
            normalized.insert(name.clone(), Value::Object(normalize_field(record, None)));
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
    if text(body, "written_at") == Some("target") && reverse.is_none() {
        return Err(invalid(
            "written_at: target needs a reverse_name, the name the target's file writes the edge under",
            Some("written_at"),
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
    for side in ["source_type_constraints", "target_type_constraints"] {
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
        "written_at".into(),
        body.get("written_at")
            .cloned()
            .unwrap_or_else(|| json!("source")),
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

/// The members of an edge type an evolution changes beyond widening its
/// endpoint constraints and renaming its labels.
pub fn constraint_evolution_changes(stored: &Obj, next: &Obj) -> Vec<&'static str> {
    let mut changes: Vec<&'static str> = [
        "id",
        "description",
        "cardinality",
        "cascade_on_delete",
        "property_schema",
        "reverse_name",
        "written_at",
    ]
    .into_iter()
    .filter(|key| stored.get(*key) != next.get(*key))
    .collect();
    for side in ["source_type_constraints", "target_type_constraints"] {
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
            changes.push(if side == "source_type_constraints" {
                "source_type_constraints"
            } else {
                "target_type_constraints"
            });
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::edge_id;

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
