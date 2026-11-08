//! What changing a registered type touches: what any writer may change and what only a schema writer may.

use std::collections::HashSet;

use serde_json::Value;

use super::{Obj, as_obj};

const FREE_MEMBERS: [&str; 7] = [
    "id",
    "label",
    "plural",
    "description",
    "display_hints",
    "version",
    "fields",
];

fn shape_of(field: &Value) -> Value {
    let Some(field) = field.as_object() else {
        return field.clone();
    };
    let mut shape = field.clone();
    shape.remove("description");
    shape.remove("label");
    if let Some(Value::Object(members)) = shape.get_mut("items_fields") {
        for member in members.values_mut() {
            if let Value::Object(member) = member {
                member.remove("label");
            }
        }
    }
    Value::Object(shape)
}

/// Returns (what only a schema writer may change, optional fields added).
pub fn evolution_of(stored: &Obj, next: &Obj) -> (Vec<String>, Vec<String>) {
    let mut needs = Vec::new();
    let mut additions = Vec::new();
    let members: HashSet<&String> = stored.keys().chain(next.keys()).collect();
    let mut members: Vec<&String> = members
        .into_iter()
        .filter(|m| !FREE_MEMBERS.contains(&m.as_str()))
        .collect();
    members.sort_unstable();
    for member in members {
        if stored.get(member) != next.get(member) {
            needs.push(member.clone());
        }
    }
    let before = as_obj(stored.get("fields")).cloned().unwrap_or_default();
    let after = as_obj(next.get("fields")).cloned().unwrap_or_default();
    for (name, field) in &before {
        if after
            .get(name)
            .is_none_or(|replaced| shape_of(field) != shape_of(replaced))
        {
            needs.push(format!("fields.{name}"));
        }
    }
    for (name, field) in &after {
        if before.contains_key(name) {
            continue;
        }
        if field.get("required") == Some(&Value::Bool(true)) {
            needs.push(format!("fields.{name}"));
        } else {
            additions.push(name.clone());
        }
    }
    (needs, additions)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn obj(value: Value) -> Obj {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn a_label_is_free_a_changed_shape_and_a_required_addition_are_not() {
        let stored =
            obj(json!({"id": "user.a", "fields": {"x": {"type": "string", "label": "X"}}}));
        let relabelled = obj(
            json!({"id": "user.a", "label": "A", "fields": {"x": {"type": "string", "label": "Y"}, "y": {"type": "string"}}}),
        );
        assert_eq!(
            evolution_of(&stored, &relabelled),
            (vec![], vec!["y".to_string()])
        );
        let changed = obj(
            json!({"id": "user.a", "fields": {"x": {"type": "number"}, "z": {"type": "string", "required": true}}}),
        );
        assert_eq!(
            evolution_of(&stored, &changed).0,
            vec!["fields.x".to_string(), "fields.z".to_string()]
        );
    }
}
