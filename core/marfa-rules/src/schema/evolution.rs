//! What changing a registered type touches: what any writer may change and what only a schema writer may.

use std::collections::HashSet;

use serde_json::Value;

use super::tables::{OWN_COLUMNS, normalize_table};
use super::{Obj, as_obj};

const FREE_MEMBERS: [&str; 8] = [
    "id",
    "label",
    "plural",
    "description",
    "display_hints",
    "version",
    "fields",
    "tables",
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

fn column_shape_of(column: &Value) -> Value {
    let mut shape = column.clone();
    if let Value::Object(shape) = &mut shape {
        shape.remove("description");
        shape.remove("label");
    }
    shape
}

fn column_changes(was: &Obj, is: &Obj, prefix: &str) -> Vec<String> {
    let mut needs = Vec::new();
    for (column, definition) in was {
        if is
            .get(column)
            .is_none_or(|changed| column_shape_of(definition) != column_shape_of(changed))
        {
            needs.push(format!("{prefix}{column}"));
        }
    }
    for (column, definition) in is {
        if !was.contains_key(column) && definition.get("required") == Some(&Value::Bool(true)) {
            needs.push(format!("{prefix}{column}"));
        }
    }
    needs
}

/// Normalize defaults so writing an explicit default is not a schema change.
pub fn own_column_changes(was: &Obj, is: &Obj) -> Vec<String> {
    let stored = |columns: &Obj| {
        let mut table = Obj::new();
        table.insert(OWN_COLUMNS.into(), Value::Object(columns.clone()));
        as_obj(normalize_table(&table).get(OWN_COLUMNS))
            .cloned()
            .unwrap_or_default()
    };
    let mut changes = column_changes(&stored(was), &stored(is), &format!("{OWN_COLUMNS}."));
    changes.sort();
    changes
}

/// The tables and columns only a schema writer may remove, change or require.
fn table_changes(stored: &Obj, next: &Obj) -> Vec<String> {
    let before = as_obj(stored.get("tables")).cloned().unwrap_or_default();
    let after = as_obj(next.get("tables")).cloned().unwrap_or_default();
    let mut needs = Vec::new();
    for (name, table) in &before {
        let Some(replaced) = after.get(name) else {
            needs.push(format!("tables.{name}"));
            continue;
        };
        let columns = |table: &Value| as_obj(table.get("columns")).cloned().unwrap_or_default();
        needs.extend(column_changes(
            &columns(table),
            &columns(replaced),
            &format!("tables.{name}.columns."),
        ));
    }
    needs
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
    needs.extend(table_changes(stored, next));
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
    #[test]
    fn an_item_s_columns_compare_as_stored_so_a_written_default_and_a_label_change_nothing() {
        let held = obj(json!({"a": {"type": "string"}, "b": {"type": "number"}}));
        let same = obj(json!({
            "b": {"type": "number", "label": "B", "required": false, "searchable": false},
            "a": {"type": "string", "description": "A."},
            "c": {"type": "date"}
        }));
        assert!(own_column_changes(&held, &same).is_empty());
        let changed = obj(json!({
            "a": {"type": "string", "required": true},
            "c": {"type": "date", "required": true}
        }));
        assert_eq!(
            own_column_changes(&held, &changed),
            ["columns.a", "columns.b", "columns.c"]
        );
    }
}
