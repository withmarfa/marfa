//! A type read down its parent chain, and the forms a definition takes on the
//! way in and out.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{Obj, Registry, as_obj, text};
use crate::catalog::merge_field_definition;
use crate::wire::{label_from_id, label_from_name, plural_from_label};

/// The parent chain a type may have before it cannot be resolved.
pub const MAX_RESOLUTION_DEPTH: usize = 100;

const HINT_KEYS: [&str; 4] = ["title_field", "body_field", "name_from_body", "icon"];

/// A parent chain that loops or runs past [`MAX_RESOLUTION_DEPTH`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainFault {
    pub type_id: String,
    pub at: String,
}

/// The chain of `id`, the root first, as each type reads. Empty where the
/// registry does not hold `id`; a parent it does not hold ends the chain.
pub fn chain(registry: &Registry, id: &str) -> Result<Vec<Obj>, ChainFault> {
    let mut found: Vec<Obj> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut current = registry.owned(id);
    while let Some(row) = current {
        let at = text(&row, "id").unwrap_or_default().to_string();
        if seen.contains(&at) || seen.len() >= MAX_RESOLUTION_DEPTH {
            return Err(ChainFault {
                type_id: id.to_string(),
                at,
            });
        }
        seen.insert(at);
        current = text(&row, "parent").and_then(|parent| registry.owned(parent));
        found.insert(0, row);
    }
    Ok(found)
}

/// The label a definition names, where it names one.
pub fn named(label: Option<&Value>) -> Option<&str> {
    label
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty())
}

/// The label a type answers with: its own, else the one its id makes.
pub fn label_or_default(schema: &Obj) -> String {
    named(schema.get("label"))
        .map(str::to_string)
        .unwrap_or_else(|| label_from_id(text(schema, "id").unwrap_or_default()))
}

/// The plural a type answers with: its own, else its label's. Never inherited.
pub fn plural_of(schema: &Obj) -> String {
    named(schema.get("plural"))
        .map(str::to_string)
        .unwrap_or_else(|| plural_from_label(&label_or_default(schema)))
}

/// A definition that names no label takes the one its id makes.
pub fn labelled(mut schema: Obj) -> Obj {
    let label = label_or_default(&schema);
    schema.insert("label".into(), Value::String(label));
    schema
}

fn label_member(definition: &mut Obj, name: &str) {
    if !definition.get("label").is_some_and(Value::is_string) {
        definition.insert("label".into(), Value::String(label_from_name(name)));
    }
}

/// Each field and each member of an entries field that names no label takes
/// the one its name makes.
pub fn with_field_labels(fields: &Obj) -> Obj {
    let mut out = Map::new();
    for (name, field) in fields {
        let mut field = field.clone();
        if let Value::Object(definition) = &mut field {
            label_member(definition, name);
            if let Some(Value::Object(members)) = definition.get_mut("items_fields") {
                for (member, entry) in members.iter_mut() {
                    if let Value::Object(entry) = entry {
                        label_member(entry, member);
                    }
                }
            }
        }
        out.insert(name.clone(), field);
    }
    out
}

/// A definition with the defaults its fields leave out written down, so two
/// equal definitions compare equal.
pub fn canonical(schema: Obj) -> Obj {
    let mut schema = labelled(schema);
    if let Some(Value::Object(fields)) = schema.get_mut("fields") {
        for field in fields.values_mut() {
            if let Value::Object(definition) = field {
                definition.entry("required").or_insert(Value::Bool(false));
                definition.entry("searchable").or_insert(Value::Bool(true));
            }
        }
    }
    schema
}

/// The roles a type carries, its own and every ancestor's, sorted; none where
/// the chain declares none.
pub fn roles_of(registry: &Registry, id: &str) -> Result<Option<Vec<String>>, ChainFault> {
    let mut roles: Vec<String> = chain(registry, id)?
        .iter()
        .flat_map(|row| {
            row.get("roles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    roles.sort();
    roles.dedup();
    Ok((!roles.is_empty()).then_some(roles))
}

/// What a type answers with once its chain is read: fields merged root to
/// leaf, each display hint from the nearest type that sets it, the policies
/// merged key by key, and the roles of the whole chain. `declared_only` makes
/// no label or plural a definition does not name.
pub fn resolve(
    registry: &Registry,
    id: &str,
    declared_only: bool,
) -> Result<Option<Obj>, ChainFault> {
    let chain = chain(registry, id)?;
    let Some(own) = chain.last() else {
        return Ok(None);
    };

    let mut merged = Obj::new();
    for row in &chain {
        for (name, definition) in as_obj(row.get("fields")).into_iter().flatten() {
            let next = merge_field_definition(merged.get(name), definition);
            merged.insert(name.clone(), next);
        }
    }
    let fields = if declared_only {
        merged
    } else {
        with_field_labels(&merged)
    };

    let mut hints = Obj::new();
    let mut version_policy = Obj::new();
    let mut retention = Obj::new();
    let mut merge_fields = Obj::new();
    let mut merge_default: Option<Value> = None;
    let mut has_merge = false;
    for row in &chain {
        for (key, value) in as_obj(row.get("display_hints")).into_iter().flatten() {
            if HINT_KEYS.contains(&key.as_str()) && !value.is_null() {
                hints.insert(key.clone(), value.clone());
            }
        }
        version_policy.extend(
            as_obj(row.get("version_policy"))
                .cloned()
                .unwrap_or_default(),
        );
        retention.extend(
            as_obj(row.get("retention_policy"))
                .cloned()
                .unwrap_or_default(),
        );
        if let Some(policy) = as_obj(row.get("merge_policy")) {
            merge_fields.extend(as_obj(policy.get("fields")).cloned().unwrap_or_default());
            if let Some(default) = policy.get("default").filter(|d| !d.is_null()) {
                merge_default = Some(default.clone());
            }
            has_merge = true;
        }
    }

    let mut out = Obj::new();
    out.insert("id".into(), Value::String(id.to_string()));
    out.insert(
        "version".into(),
        own.get("version").cloned().unwrap_or(Value::from(0)),
    );
    out.insert("fields".into(), Value::Object(fields));
    for key in ["parent", "compatible_with", "label"] {
        if let Some(value) = own.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if declared_only {
        if named(own.get("plural")).is_some() {
            out.insert("plural".into(), own["plural"].clone());
        }
    } else {
        out.insert("plural".into(), Value::String(plural_of(own)));
    }
    if let Some(value) = own.get("description") {
        out.insert("description".into(), value.clone());
    }
    if !hints.is_empty() {
        out.insert("display_hints".into(), Value::Object(hints));
    }
    if let Some(value) = own.get("link_field") {
        out.insert("link_field".into(), value.clone());
    }
    if !version_policy.is_empty() {
        out.insert("version_policy".into(), Value::Object(version_policy));
    }
    if has_merge && (!merge_fields.is_empty() || merge_default.is_some()) {
        let mut policy = Obj::new();
        if !merge_fields.is_empty() {
            policy.insert("fields".into(), Value::Object(merge_fields));
        }
        if let Some(default) = merge_default {
            policy.insert("default".into(), default);
        }
        out.insert("merge_policy".into(), Value::Object(policy));
    }
    if !retention.is_empty() {
        out.insert("retention_policy".into(), Value::Object(retention));
    }
    if let Some(roles) = roles_of(registry, id)? {
        out.insert(
            "roles".into(),
            Value::Array(roles.into_iter().map(Value::String).collect()),
        );
    }
    Ok(Some(out))
}

/// A definition written back as read carries more than its author wrote: the
/// owner's icon, every hint the type takes from an ancestor, and the labels
/// and plural Marfa made. What the stored definition does not set and the
/// submission gives as read is dropped, so the type goes on following where
/// it came from. `read` is the stored type as it resolves, where its chain
/// can be walked.
pub fn read_back_free(
    submitted: Obj,
    stored: &Obj,
    read: Option<&Obj>,
    owner_icon: Option<&str>,
) -> Obj {
    let Some(read) = read else {
        return submitted;
    };
    let mut out = submitted;
    if stored.get("plural").is_none()
        && out.get("plural").and_then(Value::as_str) == Some(plural_of(stored).as_str())
    {
        out.remove("plural");
    }
    let read_fields = as_obj(read.get("fields"));
    let own_fields = as_obj(stored.get("fields"));
    if let Some(Value::Object(fields)) = out.get_mut("fields") {
        for (name, field) in fields.iter_mut() {
            let (Value::Object(field), Some(read_field)) =
                (field, read_fields.and_then(|f| as_obj(f.get(name))))
            else {
                continue;
            };
            let own = own_fields.and_then(|f| as_obj(f.get(name)));
            if own.is_none_or(|own| !own.contains_key("label"))
                && field.get("label") == read_field.get("label")
            {
                field.remove("label");
            }
            let read_members = as_obj(read_field.get("items_fields"));
            let own_members = own.and_then(|own| as_obj(own.get("items_fields")));
            if let Some(Value::Object(members)) = field.get_mut("items_fields") {
                for (member, entry) in members.iter_mut() {
                    let (Value::Object(entry), Some(read_member)) =
                        (entry, read_members.and_then(|m| as_obj(m.get(member))))
                    else {
                        continue;
                    };
                    let own_member = own_members.and_then(|m| as_obj(m.get(member)));
                    if own_member.is_none_or(|own| !own.contains_key("label"))
                        && entry.get("label") == read_member.get("label")
                    {
                        entry.remove("label");
                    }
                }
            }
        }
    }
    if let Some(Value::Object(submitted_hints)) = out.get("display_hints").cloned() {
        let read_hints = as_obj(read.get("display_hints"));
        let own_hints = as_obj(stored.get("display_hints"));
        let mut kept = Obj::new();
        for key in HINT_KEYS {
            let Some(value) = submitted_hints.get(key).filter(|v| !v.is_null()) else {
                continue;
            };
            let own = own_hints.and_then(|h| h.get(key)).filter(|v| !v.is_null());
            if key == "icon" && owner_icon.is_some_and(|icon| value.as_str() == Some(icon)) {
                if let Some(own) = own {
                    kept.insert(key.into(), own.clone());
                }
            } else if own.is_none() && read_hints.and_then(|h| h.get(key)) == Some(value) {
                continue;
            } else {
                kept.insert(key.into(), value.clone());
            }
        }
        out.remove("display_hints");
        if !kept.is_empty() {
            out.insert("display_hints".into(), Value::Object(kept));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn registry(rows: &[Value]) -> Registry {
        Registry::new(rows.iter().filter_map(|row| row.as_object().cloned()))
    }

    #[test]
    fn a_chain_that_loops_is_named_where_it_closes() {
        let held = registry(&[
            json!({"id": "user.a", "parent": "user.b", "fields": {}}),
            json!({"id": "user.b", "parent": "user.a", "fields": {}}),
        ]);
        let fault = resolve(&held, "user.a", false).unwrap_err();
        assert_eq!(fault.type_id, "user.a");
        assert_eq!(fault.at, "user.a");
    }

    #[test]
    fn the_nearest_type_sets_each_hint_and_roles_are_the_chains() {
        let held = registry(&[
            json!({"id": "user.base", "fields": {}, "roles": ["container"],
                   "display_hints": {"title_field": "name", "icon": "lucide:box"}}),
            json!({"id": "user.note", "parent": "user.base", "fields": {"name": {"type": "string"}},
                   "display_hints": {"icon": "lucide:star"}}),
        ])
        .with_icons([("user.base".to_string(), "lucide:home".to_string())].into());
        let leaf = resolve(&held, "user.note", false).unwrap().unwrap();
        assert_eq!(
            leaf["display_hints"],
            json!({"title_field": "name", "icon": "lucide:star"})
        );
        assert_eq!(leaf["roles"], json!(["container"]));
        assert_eq!(leaf["fields"]["name"]["label"], "Name");
        assert_eq!(leaf["plural"], "Notes");
    }

    #[test]
    fn a_hint_read_from_an_ancestor_is_not_stored_again() {
        let stored = json!({"id": "user.note", "fields": {}})
            .as_object()
            .unwrap()
            .clone();
        let read =
            json!({"id": "user.note", "fields": {}, "display_hints": {"title_field": "name"}})
                .as_object()
                .unwrap()
                .clone();
        let submitted =
            json!({"id": "user.note", "fields": {}, "display_hints": {"title_field": "name"}})
                .as_object()
                .unwrap()
                .clone();
        let out = read_back_free(submitted, &stored, Some(&read), None);
        assert!(!out.contains_key("display_hints"));
    }
}
