//! The starting definition `marfa types scaffold` prints: a type's
//! identifier and fields, held to what a registration and a declaration take,
//! with no copy, server or key.

use serde_json::{Map, Value, json};

use crate::error::CoreError;

/// One field of the type to scaffold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScaffoldField {
    pub name: String,
    /// A field type: `string`, `enum`, `array` and the rest.
    pub kind: String,
    pub required: bool,
    /// What an `enum` field allows.
    pub enum_values: Vec<String>,
    /// What each element of an `array` field is.
    pub items_type: Option<String>,
}

/// A type definition naming `id`, with `fields` in the order given, that a
/// declaration takes unchanged and a key that may register `id` can register.
/// `parent` is checked only for its grammar: a parent the instance or the
/// declaration holds cannot be known here.
pub fn scaffold_type(
    id: &str,
    parent: Option<&str>,
    description: Option<&str>,
    fields: &[ScaffoldField],
) -> Result<Value, CoreError> {
    let invalid = |message: String| CoreError::Invalid(message);
    crate::catalog::declaration(&json!({ "id": id, "fields": {} }), &|_| true)?;
    if let Some(parent) = parent {
        if parent == id {
            return Err(invalid(format!("{id} cannot be its own parent")));
        }
        if parent.ends_with(".*") || !crate::hydrate::type_pattern(parent)? {
            return Err(invalid(format!(
                "not a parent for {id}: {parent:?}; {}",
                crate::hydrate::GRAMMAR
            )));
        }
    }
    let kinds = crate::builtin::field_types()?;
    let reserved = crate::builtin::reserved_field_names()?;
    let searched = crate::builtin::searched_field_names()?;
    let mut held = Map::new();
    let mut thumbnail = false;
    for field in fields {
        let name = field.name.as_str();
        if reserved.iter().any(|held| held == name) {
            return Err(invalid(format!(
                "{name} is a name every item has, so a type cannot declare it as a field: {}",
                reserved.join(", ")
            )));
        }
        if held.contains_key(name) {
            return Err(invalid(format!("the field {name} is given twice")));
        }
        if !kinds.contains(&field.kind) {
            return Err(invalid(format!(
                "{name} is {:?}, which is not a field type: one of {}",
                field.kind,
                kinds.join(", ")
            )));
        }
        let mut definition = Map::new();
        definition.insert("type".into(), field.kind.clone().into());
        if field.required {
            definition.insert("required".into(), true.into());
        }
        match field.kind.as_str() {
            "enum" => {
                let values = &field.enum_values;
                if values.is_empty() || values.iter().any(String::is_empty) {
                    return Err(invalid(format!(
                        "{name} is an enum, which needs its allowed values, none of them empty"
                    )));
                }
                if let Some(twice) = values
                    .iter()
                    .enumerate()
                    .find_map(|(at, value)| values[..at].contains(value).then_some(value))
                {
                    return Err(invalid(format!("{name} lists the value {twice:?} twice")));
                }
                definition.insert("enum_values".into(), json!(values));
            }
            "array" => {
                let Some(items) = field.items_type.as_deref() else {
                    return Err(invalid(format!(
                        "{name} is an array, which needs the type of its elements"
                    )));
                };
                if !kinds.iter().any(|kind| kind == items)
                    || ["array", "enum", "thumbnail"].contains(&items)
                {
                    return Err(invalid(format!(
                        "{name} is an array of {items:?}, which is not an element type: one of {}",
                        kinds
                            .iter()
                            .filter(|kind| !["array", "enum", "thumbnail"].contains(&kind.as_str()))
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                definition.insert("items_type".into(), items.into());
            }
            _ => {}
        }
        if field.kind == "thumbnail" {
            if thumbnail {
                return Err(invalid(format!(
                    "{name} is a second thumbnail, and a type has at most one"
                )));
            }
            if searched.iter().any(|searched| searched == name) {
                return Err(invalid(format!(
                    "a thumbnail cannot be named {name}: search reads {} whatever their type",
                    searched.join(", ")
                )));
            }
            thumbnail = true;
        }
        held.insert(name.to_string(), Value::Object(definition));
    }
    if let Some(parent) = parent {
        agree_with_shipped(parent, &held)?;
    }
    let mut row = Map::new();
    row.insert("id".into(), id.into());
    if let Some(description) = description {
        row.insert("description".into(), description.into());
    }
    if let Some(parent) = parent {
        row.insert("parent".into(), parent.into());
    }
    row.insert("fields".into(), Value::Object(held));
    Ok(Value::Object(row))
}

/// What a subtype may not change of a field it inherits
/// (`types/child-shape`), for a parent Marfa ships, whose fields are known
/// here. A parent the instance or the declaration holds is judged by the
/// server.
const SHAPE: [&str; 7] = [
    "type",
    "format",
    "items_type",
    "searchable",
    "maxLength",
    "maxItems",
    "enum_values",
];

fn agree_with_shipped(parent: &str, held: &Map<String, Value>) -> Result<(), CoreError> {
    let catalog = crate::builtin::catalog()?;
    let Some(inherited) = catalog
        .types
        .iter()
        .find(|shipped| shipped.id == parent)
        .and_then(|shipped| shipped.rest.get("fields"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    for (name, definition) in held {
        let Some(above) = inherited.get(name) else {
            continue;
        };
        if let Some(attribute) = SHAPE
            .iter()
            .find(|attribute| above.get(**attribute) != definition.get(**attribute))
        {
            return Err(CoreError::Invalid(format!(
                "{parent} already declares {name} with a different {attribute}, which a subtype cannot change: leave {name} out to inherit it"
            )));
        }
        if above.get("required") == Some(&Value::Bool(true))
            && definition.get("required") != Some(&Value::Bool(true))
        {
            return Err(CoreError::Invalid(format!(
                "{parent} requires {name}, which a subtype cannot make optional: mark it required, or leave it out to inherit it"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Core;

    fn field(name: &str, kind: &str) -> ScaffoldField {
        ScaffoldField {
            name: name.into(),
            kind: kind.into(),
            required: false,
            enum_values: Vec::new(),
            items_type: None,
        }
    }

    fn required(name: &str, kind: &str) -> ScaffoldField {
        ScaffoldField {
            required: true,
            ..field(name, kind)
        }
    }

    fn refusal(id: &str, parent: Option<&str>, fields: &[ScaffoldField]) -> String {
        match scaffold_type(id, parent, None, fields) {
            Err(CoreError::Invalid(message)) => message,
            other => panic!("{id} {fields:?} was not refused as invalid: {other:?}"),
        }
    }

    #[test]
    fn it_prints_the_id_and_the_fields_it_was_given_in_order() {
        let definition = scaffold_type(
            "user.recipe",
            Some("core.note"),
            Some("A recipe"),
            &[
                ScaffoldField {
                    required: true,
                    ..field("body", "string")
                },
                field("servings", "integer"),
                ScaffoldField {
                    enum_values: vec!["easy".into(), "hard".into()],
                    ..field("effort", "enum")
                },
                ScaffoldField {
                    items_type: Some("url".into()),
                    ..field("sources", "array")
                },
            ],
        )
        .unwrap();
        assert_eq!(
            definition,
            json!({
                "id": "user.recipe",
                "description": "A recipe",
                "parent": "core.note",
                "fields": {
                    "body": { "type": "string", "required": true },
                    "servings": { "type": "integer" },
                    "effort": { "type": "enum", "enum_values": ["easy", "hard"] },
                    "sources": { "type": "array", "items_type": "url" },
                }
            })
        );
        let names: Vec<&String> = definition["fields"].as_object().unwrap().keys().collect();
        assert_eq!(names, ["body", "servings", "effort", "sources"]);
    }

    #[test]
    fn a_bare_id_is_a_definition_with_no_fields() {
        assert_eq!(
            scaffold_type("user.recipe", None, None, &[]).unwrap(),
            json!({ "id": "user.recipe", "fields": {} })
        );
    }

    #[test]
    fn a_declaration_takes_what_it_printed_for_every_field_type() {
        let kinds = crate::builtin::field_types().unwrap();
        let fields: Vec<ScaffoldField> = kinds
            .iter()
            .map(|kind| ScaffoldField {
                enum_values: if kind == "enum" {
                    vec!["a".into()]
                } else {
                    Vec::new()
                },
                items_type: (kind == "array").then(|| "string".to_string()),
                ..field(&format!("{kind}_field"), kind)
            })
            .collect();
        assert!(fields.len() >= 12, "the field types were not read");
        let definition = scaffold_type("user.everything", None, None, &fields).unwrap();
        let core = Core::open_in_memory(None).unwrap();
        core.declare_types(std::slice::from_ref(&definition))
            .unwrap();
        let declared = core.declared_types().unwrap();
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0]["fields"], definition["fields"]);
        assert_eq!(declared[0]["id"], definition["id"]);
    }

    #[test]
    fn a_parent_is_declared_with_its_child_in_either_order() {
        let child = scaffold_type("user.child", Some("user.parent"), None, &[]).unwrap();
        let parent = scaffold_type("user.parent", None, None, &[field("title", "string")]).unwrap();
        let core = Core::open_in_memory(None).unwrap();
        core.declare_types(&[child, parent]).unwrap();
    }

    #[test]
    fn an_id_the_grammar_or_a_reserved_root_refuses_is_refused_with_the_reason() {
        for id in [
            "recipe",
            "User.recipe",
            "user.Recipe",
            "user..recipe",
            "user.recipe.",
            "user.1recipe",
            "app.recipe",
            "app.notes.entry.more",
            "keys.recipe",
            "schema.recipe",
            "user.recipe.*",
        ] {
            assert!(
                refusal(id, None, &[]).contains("lowercase dotted segments"),
                "{id}"
            );
        }
        for id in ["core.recipe", "system.recipe", "marfa.recipe", "core.note"] {
            assert!(refusal(id, None, &[]).contains("Marfa's"), "{id}");
        }
        let too_long = format!("user.{}", "a".repeat(124));
        assert!(refusal(&too_long, None, &[]).contains("128"));
        // Witness: ids at the edges of those rules are taken.
        for id in [
            "user.recipe",
            "app.notes.entry",
            "acme.recipe",
            "keys-pub.recipe",
            &format!("user.{}", "a".repeat(123)),
        ] {
            scaffold_type(id, None, None, &[]).unwrap();
        }
    }

    #[test]
    fn a_field_a_registration_would_refuse_is_refused_with_the_reason() {
        let cases: Vec<(Vec<ScaffoldField>, &str)> = vec![
            (vec![field("state", "string")], "every item has"),
            (vec![field("type", "string")], "every item has"),
            (vec![field("a", "string"), field("a", "number")], "twice"),
            (vec![field("a", "blob")], "not a field type"),
            (vec![field("a", "enum")], "allowed values"),
            (
                vec![ScaffoldField {
                    enum_values: vec!["x".into(), "x".into()],
                    ..field("a", "enum")
                }],
                "twice",
            ),
            (vec![field("a", "array")], "type of its elements"),
            (
                vec![ScaffoldField {
                    items_type: Some("thumbnail".into()),
                    ..field("a", "array")
                }],
                "not an element type",
            ),
            (
                vec![ScaffoldField {
                    items_type: Some("nothing".into()),
                    ..field("a", "array")
                }],
                "not an element type",
            ),
            (
                vec![field("a", "thumbnail"), field("b", "thumbnail")],
                "at most one",
            ),
            (vec![field("title", "thumbnail")], "search reads"),
        ];
        for (fields, reason) in cases {
            let message = refusal("user.recipe", None, &fields);
            assert!(message.contains(reason), "{fields:?}: {message}");
        }
        // Witness: the same names and kinds, written so the rule is met, are taken,
        // and so is any name the registry takes, however it is spelled.
        scaffold_type(
            "user.recipe",
            None,
            None,
            &[
                field("status_text", "string"),
                field("a", "string"),
                field("Title", "string"),
                field("1st", "string"),
                field("toString", "string"),
                field("a-b.c", "string"),
                field("image", "thumbnail"),
                ScaffoldField {
                    enum_values: vec!["x".into()],
                    ..field("kind", "enum")
                },
                ScaffoldField {
                    items_type: Some("object".into()),
                    ..field("rows", "array")
                },
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_parent_is_held_to_the_grammar_and_a_shipped_one_to_its_fields() {
        for parent in ["user.recipe", "Core.note", "note", "core.*", "keys.x"] {
            assert!(
                refusal("user.recipe", Some(parent), &[]).contains("parent"),
                "{parent}"
            );
        }
        // Witness: a parent the grammar takes, shipped or not, is.
        for parent in ["core.note", "user.base", "acme.base.thing"] {
            scaffold_type("user.child", Some(parent), None, &[]).unwrap();
        }
        let optional_body = refusal("user.child", Some("core.note"), &[field("body", "string")]);
        assert!(
            optional_body.contains("cannot make optional"),
            "{optional_body}"
        );
        let reshaped = refusal(
            "user.child",
            Some("core.note"),
            &[required("body", "integer")],
        );
        assert!(reshaped.contains("different type"), "{reshaped}");
        let reformatted = refusal(
            "user.child",
            Some("core.note"),
            &[field("language", "string")],
        );
        assert!(reformatted.contains("different format"), "{reformatted}");
        // Witness: the same fields, restated as the parent has them or left out, are taken.
        scaffold_type(
            "user.child",
            Some("core.note"),
            None,
            &[required("body", "string")],
        )
        .unwrap();
        scaffold_type(
            "user.child",
            Some("core.note"),
            None,
            &[field("title", "string")],
        )
        .unwrap();
        // A parent that is not shipped is not judged here.
        scaffold_type(
            "user.child",
            Some("user.base"),
            None,
            &[field("body", "integer")],
        )
        .unwrap();
    }
}
