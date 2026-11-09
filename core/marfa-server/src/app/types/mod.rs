//! Types: judgement of a definition is `marfa_rules::schema`'s; this module reads the catalog and writes.

mod moving;
mod read;
mod write;

pub(crate) use moving::{Guard, dry_run, finish_move, start_guarded};
pub use moving::{Move, move_type};
pub use read::{get, list, normalize};
use write::not_found;
pub use write::{Merge, change, clear_icon, delete, register, replace, set_icon};

use marfa_rules::grammar;
use marfa_rules::schema::{ChainFault, Issue, Obj, plural_of};
use serde_json::{Value, json};

use super::access::Caller;
use super::catalog::{Catalog, Provenance, provenance_json};
use super::refusal::{Code, Refusal, Result};

pub(super) fn issues_json(issues: &[Issue]) -> Vec<Value> {
    issues.iter().map(Issue::to_json).collect()
}

fn schema_refusal(issues: Vec<Issue>) -> Refusal {
    let has = |code: &str| issues.iter().any(|issue| issue.code == Some(code));
    let (code, message) = if has("property_shadows_field") {
        (
            Code::PropertyShadowsField,
            "Type schema declares a property whose name shadows a first-class Item field",
        )
    } else if has("inheritance_violation") {
        (
            Code::InheritanceViolation,
            "Type gives a field a shape another type in its chain declares differently",
        )
    } else if has("compatible_with_violation") {
        (
            Code::CompatibleWithViolation,
            "Type does not satisfy the structural-superset of its compatible_with target",
        )
    } else {
        (Code::InvalidSchema, "Invalid type schema")
    };
    Refusal::new(code, message).with_detail("errors", issues_json(&issues))
}

fn dependents_refusal(broken: Vec<(String, Vec<Issue>)>) -> Refusal {
    let ids: Vec<&str> = broken.iter().map(|(id, _)| id.as_str()).collect();
    let message = format!("Change would break compatible_with for: {}", ids.join(", "));
    let errors: Vec<Value> = broken
        .iter()
        .flat_map(|(id, issues)| {
            issues.iter().map(move |issue| {
                let mut issue = issue.clone();
                issue.field = format!("types.{id}.{}", issue.field);
                issue.to_json()
            })
        })
        .collect();
    Refusal::new(Code::CompatibleWithViolation, message)
        .with_detail("dependent_type_ids", ids)
        .with_detail("errors", errors)
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
    let message = format!("Invalid type identifier: {}.", grammar::GRAMMAR);
    Err(Refusal::validation(message.clone())
        .with_detail("field", field)
        .with_detail("errors", json!([{ "path": field, "message": message }])))
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

fn names(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn require_reach(caller: &Caller, next: &Obj, stored: Option<&Obj>) -> Result<()> {
    let held = |key: &str| stored.and_then(|stored| stored.get(key));
    if let Some(parent) = next.get("parent").and_then(Value::as_str)
        && held("parent").and_then(Value::as_str) != Some(parent)
    {
        caller.require_dependency(parent, Catalog::ships(parent))?;
    }
    let known = names(held("compatible_with"));
    for target in names(next.get("compatible_with")) {
        if !known.contains(&target) {
            caller.require_dependency(target, Catalog::ships(target))?;
        }
    }
    Ok(())
}

fn presented(mut schema: Obj, held: Option<&Provenance>) -> Value {
    let plural = plural_of(&schema);
    schema.insert("plural".into(), Value::String(plural));
    schema.insert("provenance".into(), provenance_json(held));
    Value::Object(schema)
}
