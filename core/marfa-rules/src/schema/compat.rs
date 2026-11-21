//! How two declarations of one field compare: a child against what it inherits.

use serde_json::Value;

use super::registry::Ancestry;
use super::{Obj, Registry, as_obj, describe, number, required, text};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Conflict {
    pub attribute: &'static str,
    pub expected: String,
    pub actual: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShapeConflict {
    pub field: String,
    pub attribute: &'static str,
    pub owner: String,
    pub inherited: String,
    pub declared: String,
}

const SHAPE_ATTRIBUTES: [&str; 6] = [
    "type",
    "format",
    "items_type",
    "searchable",
    "max_length",
    "max_items",
];

fn same(one: Option<&Value>, other: Option<&Value>) -> bool {
    match (one, other) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => one == other,
    }
}

pub(super) fn entry_members_key(members: Option<&Value>) -> String {
    match members {
        None => String::new(),
        Some(Value::Object(members)) => {
            let mut entries: Vec<(&String, Value)> = members
                .iter()
                .map(|(name, member)| {
                    let mut rest = member.as_object().cloned().unwrap_or_default();
                    rest.remove("label");
                    rest.remove("description");
                    (name, Value::Object(rest))
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Array(
                entries
                    .into_iter()
                    .map(|(name, rest)| Value::Array(vec![Value::String(name.clone()), rest]))
                    .collect(),
            )
            .to_string()
        }
        Some(other) => format!("\0{other}"),
    }
}

fn enum_key(values: Option<&Value>) -> Option<String> {
    match values? {
        Value::Array(values) => Some(
            values
                .iter()
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
                .collect::<Vec<_>>()
                .join("|"),
        ),
        other => Some(format!("\0{other}")),
    }
}

fn describe_shape_conflict(child: &Obj, ancestor: &Obj) -> Option<Conflict> {
    for attribute in SHAPE_ATTRIBUTES {
        if !same(child.get(attribute), ancestor.get(attribute)) {
            return Some(Conflict {
                attribute,
                expected: format!("{attribute} {}", describe(ancestor.get(attribute))),
                actual: format!("{attribute} {}", describe(child.get(attribute))),
            });
        }
    }
    if enum_key(child.get("enum_values")) != enum_key(ancestor.get("enum_values")) {
        return Some(Conflict {
            attribute: "enum_values",
            expected: format!("enum_values {}", describe(ancestor.get("enum_values"))),
            actual: format!("enum_values {}", describe(child.get("enum_values"))),
        });
    }
    for bound in ["minimum", "maximum"] {
        let Some(inherited) = number(ancestor.get(bound)) else {
            continue;
        };
        let own = number(child.get(bound));
        let narrower = own.is_some_and(|own| {
            if bound == "minimum" {
                own >= inherited
            } else {
                own <= inherited
            }
        });
        if !narrower {
            return Some(Conflict {
                attribute: if bound == "minimum" {
                    "minimum"
                } else {
                    "maximum"
                },
                expected: format!(
                    "{bound} {} than {inherited}",
                    if bound == "minimum" {
                        "no lower"
                    } else {
                        "no higher"
                    }
                ),
                actual: format!("{bound} {}", describe(child.get(bound))),
            });
        }
    }
    if entry_members_key(child.get("items_fields"))
        != entry_members_key(ancestor.get("items_fields"))
    {
        return Some(Conflict {
            attribute: "items_fields",
            expected: format!("items_fields {}", describe(ancestor.get("items_fields"))),
            actual: format!("items_fields {}", describe(child.get("items_fields"))),
        });
    }
    if required(ancestor) && !required(child) {
        return Some(Conflict {
            attribute: "required",
            expected: "required true (inherited)".into(),
            actual: describe(child.get("required")),
        });
    }
    None
}

pub(super) fn inherited_shape_conflicts<'a>(
    own: impl IntoIterator<Item = (&'a str, &'a Obj)>,
    ancestry: &Ancestry,
) -> Vec<ShapeConflict> {
    own.into_iter()
        .filter_map(|(field, definition)| {
            let held = ancestry.get(field)?;
            let conflict = describe_shape_conflict(definition, &held.definition)?;
            Some(ShapeConflict {
                field: field.to_string(),
                attribute: conflict.attribute,
                owner: held.owner.clone(),
                inherited: conflict.expected,
                declared: conflict.actual,
            })
        })
        .collect()
}

pub fn stored_shape_conflicts(schema: &Obj, registry: &Registry) -> Vec<ShapeConflict> {
    let Some(parent) = text(schema, "parent") else {
        return Vec::new();
    };
    let own = as_obj(schema.get("fields"))
        .into_iter()
        .flatten()
        .filter_map(|(name, def)| Some((name.as_str(), def.as_object()?)));
    inherited_shape_conflicts(own, &registry.ancestry(parent))
}
