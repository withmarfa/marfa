//! Types: judgement of a definition is `marfa_rules::schema`'s; this module reads the catalog and writes.

mod moving;
mod read;
pub mod write;

pub(crate) use moving::{Guard, dry_run, finish_move, start_guarded};
pub use moving::{Move, move_type};
pub use read::{get, list, normalize};
use write::not_found;
pub use write::{Merge, change, clear_icon, delete, register, replace, set_icon};

use marfa_rules::grammar;
use marfa_rules::schema::{
    ChainFault, Issue, Obj, Registry, SchemaVerdict, ancestor_guidance, chain, invalid_id_message,
    plural_of,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::access::Caller;
use super::catalog::{Catalog, Provenance, provenance_json};
use super::refusal::{Code, Refusal, Result};

pub(super) fn issues_json(issues: &[Issue]) -> Vec<Value> {
    issues.iter().map(Issue::to_json).collect()
}

fn schema_refusal(issues: Vec<Issue>) -> Refusal {
    let verdict = SchemaVerdict::of(&issues);
    let code = match verdict {
        SchemaVerdict::PropertyShadowsField => Code::PropertyShadowsField,
        SchemaVerdict::InheritanceViolation => Code::InheritanceViolation,
        SchemaVerdict::InvalidSchema => Code::InvalidSchema,
    };
    Refusal::new(code, verdict.message()).with_detail("errors", issues_json(&issues))
}

pub fn missing_field(field: &str) -> Refusal {
    Refusal::new(Code::MissingRequiredField, format!("{field} is required"))
        .with_detail("field", field)
}

pub fn check_id(id: &str, field: &str) -> Result<()> {
    let taken = grammar::type_id(id)
        .map_err(|error| Refusal::internal(&format!("the type grammar did not read: {error}")))?;
    if taken {
        return Ok(());
    }
    Err(invalid_id(field))
}

fn invalid_id(field: &str) -> Refusal {
    let message = invalid_id_message();
    Refusal::validation(message.clone())
        .with_detail("field", field)
        .with_detail("errors", json!([{ "path": field, "message": message }]))
}

fn unreadable_refusal(type_id: &str) -> Refusal {
    Refusal::new(
        Code::TypeChainUnresolvable,
        format!("The stored definition of type \"{type_id}\" does not read."),
    )
    .with_detail("type_id", type_id)
}

fn chain_refusal(fault: &ChainFault) -> Refusal {
    Refusal::new(
        Code::TypeChainUnresolvable,
        format!(
            "The parent chain of type \"{}\" is circular or longer than the server resolves.",
            fault.type_id
        ),
    )
    .with_detail("type_id", fault.type_id.as_str())
}

fn require_reach(caller: &Caller, next: &Obj, stored: Option<&Obj>) -> Result<()> {
    let held = |key: &str| stored.and_then(|stored| stored.get(key));
    if let Some(parent) = next.get("parent").and_then(Value::as_str)
        && held("parent").and_then(Value::as_str) != Some(parent)
    {
        caller.require_dependency(parent, Catalog::ships(parent))?;
    }
    Ok(())
}

/// What `GET /types/{id}` answers for a type, before it carries its `revision`.
fn presented(mut schema: Obj, held: Option<&Provenance>, registry: &Registry) -> Value {
    let plural = plural_of(&schema);
    schema.insert("plural".into(), Value::String(plural));
    let id = schema.get("id").and_then(Value::as_str).unwrap_or_default();
    let above = ancestor_guidance(registry, id).unwrap_or_default();
    if !above.is_empty() {
        let above: Vec<Value> = above
            .into_iter()
            .map(|(type_id, guidance)| json!({ "type": type_id, "guidance": guidance }))
            .collect();
        schema.insert("ancestor_guidance".into(), Value::Array(above));
    }
    schema.insert("provenance".into(), provenance_json(held));
    Value::Object(schema)
}

/// Hex SHA-256 of `stored` with keys in sorted order, so equal content has one digest.
fn digest(stored: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(members) => {
                let mut keys: Vec<&String> = members.keys().collect();
                keys.sort_unstable();
                out.push('{');
                for (at, key) in keys.into_iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String(key.clone()).to_string());
                    out.push(':');
                    if let Some(member) = members.get(key) {
                        write(member, out);
                    }
                }
                out.push('}');
            }
            Value::Array(members) => {
                out.push('[');
                for (at, member) in members.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    write(member, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut text = String::new();
    write(stored, &mut text);
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// Digest of each stored row root to leaf, its owner icon apart, and the type's provenance; `None` where the chain does not resolve.
pub(crate) fn revision_of(
    registry: &Registry,
    id: &str,
    held: Option<&Provenance>,
) -> Option<String> {
    let rows = chain(registry, id).ok()?;
    if rows.is_empty() {
        return None;
    }
    let stored: Vec<Value> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(|at| {
            json!({
                "definition": registry.get(at),
                "owner_icon": registry.icon_of(at),
            })
        })
        .collect();
    Some(digest(&json!({
        "chain": stored,
        "provenance": provenance_json(held),
    })))
}

/// `answer`, a type as a route presents it, carrying the `revision` of type `id` in `catalog`.
fn revised(mut answer: Value, catalog: &Catalog, id: &str) -> Value {
    if let (Value::Object(members), Some(revision)) = (
        &mut answer,
        revision_of(&catalog.types, id, catalog.provenance.get(id)),
    ) {
        members.insert("revision".into(), Value::String(revision));
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(icon: Option<&str>) -> Registry {
        let row = json!({ "id": "acme.thing", "version": 1, "fields": {} });
        let registry = Registry::new(vec![row.as_object().cloned().unwrap_or_default()]);
        match icon {
            Some(icon) => registry.with_icon("acme.thing", Some(icon)),
            None => registry,
        }
    }

    #[test]
    fn a_revision_is_stable_for_equal_content_and_changes_with_the_icon() {
        let held = Provenance {
            origin: crate::app::catalog::Origin::Registered,
            created_by: None,
        };
        let first = revision_of(&registry(None), "acme.thing", Some(&held));
        let again = revision_of(&registry(None), "acme.thing", Some(&held));
        let iconed = revision_of(&registry(Some("lucide:star")), "acme.thing", Some(&held));
        assert!(first.as_ref().is_some_and(|text| text.len() == 64));
        assert_eq!(first, again);
        assert_ne!(first, iconed);
        assert_eq!(revision_of(&registry(None), "acme.absent", None), None);
    }

    #[test]
    fn an_author_icon_moves_the_revision_under_an_owner_icon_and_an_equal_owner_icon_does_too() {
        let held = Provenance {
            origin: crate::app::catalog::Origin::Registered,
            created_by: None,
        };
        let with_author = |author: Option<&str>, owner: Option<&str>| {
            let mut row = json!({ "id": "acme.thing", "fields": {} });
            if let Some(author) = author {
                row["display_hints"] = json!({ "icon": author });
            }
            let registry = Registry::new(vec![row.as_object().cloned().unwrap_or_default()]);
            let registry = match owner {
                Some(owner) => registry.with_icon("acme.thing", Some(owner)),
                None => registry,
            };
            revision_of(&registry, "acme.thing", Some(&held))
        };
        let old = with_author(Some("lucide:a"), Some("lucide:star"));
        let new = with_author(Some("lucide:b"), Some("lucide:star"));
        let gone = with_author(None, Some("lucide:star"));
        assert!(old.is_some());
        assert_ne!(old, new);
        assert_ne!(old, gone);
        assert_ne!(
            with_author(Some("lucide:a"), None),
            with_author(Some("lucide:a"), Some("lucide:a"))
        );
    }

    #[test]
    fn a_revision_covers_what_a_read_folds_away() {
        let row = |value: Value| value.as_object().cloned().unwrap_or_default();
        let parent = row(json!({
            "id": "acme.parent", "roles": ["container"], "fields": { "s": { "type": "string" } }
        }));
        let restating = row(json!({
            "id": "acme.child", "parent": "acme.parent", "roles": ["container"],
            "fields": { "s": { "type": "string" } }
        }));
        let bare = row(json!({ "id": "acme.child", "parent": "acme.parent", "fields": {} }));
        let held = Provenance {
            origin: crate::app::catalog::Origin::Registered,
            created_by: None,
        };
        let before = revision_of(
            &Registry::new(vec![parent.clone(), restating]),
            "acme.child",
            Some(&held),
        );
        let after = revision_of(
            &Registry::new(vec![parent, bare]),
            "acme.child",
            Some(&held),
        );
        assert!(before.is_some() && after.is_some());
        assert_ne!(before, after);
    }
}
