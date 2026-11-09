use marfa_rules::builtin;
use marfa_rules::schema::{
    EdgeIssues, Issue, Obj, constraint_evolution_changes, edge_id, edge_type_from_request,
    request_shape, unread_edge_keys,
};
use rusqlite::params;
use serde_json::Value;

use super::App;
use super::access::{Caller, Door, Level, Permission, SchemaKind};
use super::catalog::{self, Catalog, Snapshot};
use super::edges;
use super::instance;
use super::items::reading;
use super::refusal::{Code, Refusal, Result};
use super::types::{issues_json, missing_field};
use super::unit::Unit;

const INVALID: &str = "Invalid edge type schema";

fn text_of<'a>(schema: &'a Obj, key: &str) -> Option<&'a str> {
    schema.get(key).and_then(Value::as_str)
}

fn shipped(id: &str) -> Result<bool> {
    let held = builtin::shipped_edge_types()
        .map_err(|error| Refusal::internal(&format!("the shipped edge types: {error}")))?;
    Ok(held
        .iter()
        .any(|edge| edge.get("id").and_then(Value::as_str) == Some(id)))
}

fn refusal_of(issues: EdgeIssues) -> Refusal {
    match issues {
        EdgeIssues::Missing { field } => missing_field(field),
        EdgeIssues::Validation { message, field } => {
            let refusal = Refusal::validation(message);
            match field {
                Some(field) => refusal.with_detail("field", field),
                None => refusal,
            }
        }
        EdgeIssues::Schema(issues) => {
            Refusal::new(Code::InvalidSchema, INVALID).with_detail("errors", issues_json(&issues))
        }
        EdgeIssues::Conflict {
            message,
            field,
            held_by,
        } => {
            let mut refusal = Refusal::new(Code::Conflict, message);
            if let Some(field) = field {
                refusal = refusal.with_detail("field", field);
            }
            if let Some(holder) = held_by {
                refusal = refusal.with_detail("held_by", holder);
            }
            refusal
        }
    }
}

pub(super) fn presented(mut schema: Obj) -> Value {
    if !schema.contains_key("reverse_label")
        && let Some(label) = schema.get("label").cloned()
    {
        schema.insert("reverse_label".into(), label);
    }
    for flag in ["shipped", "acyclic", "flat"] {
        schema.entry(flag).or_insert(Value::Bool(false));
    }
    Value::Object(schema)
}

fn require_names(caller: &Caller, id: &str, reverse: Option<&str>) -> Result<()> {
    caller.require_edge(id, Level::Write)?;
    if let Some(reverse) = reverse {
        caller.require_edge(reverse, Level::Write)?;
    }
    Ok(())
}

/// The grant that reaches a `user.` name no edge type holds yet.
const NAMESPACE_WILDCARD: &str = "edge.user.*:write";

fn require_new_name(caller: &Caller, catalog: &Catalog, name: &str) -> Result<()> {
    caller.require_edge(name, Level::Write).map_err(|refusal| {
        if name.starts_with("user.") && catalog.edge_kind(name).is_none() {
            refusal.with_detail("required_scope", NAMESPACE_WILDCARD)
        } else {
            refusal
        }
    })
}

/// Every edge type, the shipped ones and the registered ones.
pub fn all(catalog: &Catalog) -> Result<Vec<Obj>> {
    let held = builtin::shipped_edge_types()
        .map_err(|error| Refusal::internal(&format!("the shipped edge types: {error}")))?;
    Ok(held
        .iter()
        .filter_map(Value::as_object)
        .cloned()
        .chain(catalog.edge_types.iter().cloned())
        .collect())
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    reading(app, caller, |read| {
        Ok(all(&read.catalog)?.into_iter().map(presented).collect())
    })
    .await
}

/// Registers an edge type, or widens the endpoint constraints of a registered one. The
/// answer says whether a type was created.
pub async fn register(app: &App, caller: &Caller, body: Obj) -> Result<(bool, Value)> {
    request_shape(&body).map_err(refusal_of)?;
    let id = text_of(&body, "id").unwrap_or_default().to_string();
    if shipped(&id)? {
        return Err(Refusal::new(
            Code::Conflict,
            format!("{id} is a core edge type and cannot be redefined"),
        ));
    }
    if !edge_id(&id) {
        return Err(Refusal::validation("Invalid edge-type identifier"));
    }
    let cache = app.catalog_handle();
    let outcome = app
        .write(caller, "edge_type.register", move |unit| {
            let caller = &unit.caller;
            caller.require_door(SchemaKind::EdgeTypes, Door::Register)?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            require_new_name(caller, &catalog, &id)?;
            if let Some(reverse) = text_of(&body, "reverse_name") {
                require_new_name(caller, &catalog, reverse)?;
            }
            if body.contains_key("extends") {
                return Err(Refusal::validation(
                    "A registered edge type does not support `extends`",
                ));
            }
            let mut definition = body.clone();
            definition.remove("evolve_constraints");
            let unread: Vec<Issue> = unread_edge_keys(&definition);
            if !unread.is_empty() {
                return Err(refusal_of(EdgeIssues::Schema(unread)));
            }
            let existing = catalog.edge_type(&id);
            if let Some(existing) = existing {
                require_names(caller, &id, text_of(existing, "reverse_name"))?;
            }
            let taken = |name: &str| holder_of(&catalog, name);
            if body.get("evolve_constraints") == Some(&Value::Bool(true)) {
                let Some(existing) = existing else {
                    return Err(Refusal::new(
                        Code::EdgeTypeNotFound,
                        format!("Edge type {id} not found"),
                    ));
                };
                let mut asked = body.clone();
                if text_of(&asked, "label").is_none_or(str::is_empty)
                    && let Some(label) = existing.get("label")
                {
                    asked.insert("label".into(), label.clone());
                }
                if !asked.contains_key("reverse_label")
                    && let Some(label) = existing.get("reverse_label")
                {
                    asked.insert("reverse_label".into(), label.clone());
                }
                let built = edge_type_from_request(&asked, &taken).map_err(refusal_of)?;
                let changes = constraint_evolution_changes(existing, &built);
                if !changes.is_empty() {
                    return Err(Refusal::new(
                        Code::Conflict,
                        "Constraint evolution may only add endpoint constraint tokens or allow every type; every other definition member except the labels must stay unchanged",
                    )
                    .with_detail("edge_type", id.as_str())
                    .with_detail("changes", changes));
                }
                if *existing == built {
                    return Ok((false, built));
                }
                unit.tx().execute(
                    "UPDATE edge_types SET reverse_name = ?2, definition = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, text_of(&built, "reverse_name"), Value::Object(built.clone()).to_string(), unit.at],
                )?;
                catalog::raise(unit.tx())?;
                unit.audit_also("edge_type.update", "edge_type", &id, None)?;
                return Ok((false, built));
            }
            if existing.is_some() {
                return Err(Refusal::new(
                    Code::Conflict,
                    format!("Edge type {id} already exists"),
                ));
            }
            let built = edge_type_from_request(&body, &taken).map_err(refusal_of)?;
            require_stored_targets(unit, &id, &built)?;
            unit.tx().execute(
                "INSERT INTO edge_types (id, reverse_name, created_by, definition, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    id,
                    text_of(&built, "reverse_name"),
                    caller.actor().to_string(),
                    Value::Object(built.clone()).to_string(),
                    unit.at,
                ],
            )?;
            catalog::raise(unit.tx())?;
            instance::raise_reach(unit.tx())?;
            unit.audit("edge_type", &id, None)?;
            Ok((true, built))
        })
        .await?;
    app.publish_catalog().await;
    Ok((outcome.0, presented(outcome.1)))
}

/// A type that cascades asks of each stored target what writing such an edge asks. The
/// refusal names no type, since the target can be one the caller cannot read.
fn require_stored_targets(unit: &Unit<'_, '_>, id: &str, built: &Obj) -> Result<()> {
    if text_of(built, "cascade_on_delete") != Some("cascade") {
        return Ok(());
    }
    for target_type in edges::target_types(unit.tx(), id)? {
        unit.caller
            .require_cascade_target(&target_type)
            .map_err(|_| {
                Refusal::new(
                    Code::TypeNotPermitted,
                    "This edge type cannot cascade onto the targets its stored edges hold.",
                )
            })?;
    }
    Ok(())
}

fn holder_of(catalog: &Catalog, name: &str) -> Option<String> {
    catalog.edge_types.iter().find_map(|edge| {
        let id = text_of(edge, "id")?;
        (id == name || text_of(edge, "reverse_name") == Some(name)).then(|| id.to_string())
    })
}

pub async fn delete(app: &App, caller: &Caller, id: String, force: bool) -> Result<()> {
    let cache = app.catalog_handle();
    app.write(caller, "edge_type.delete", move |unit| {
        let caller = &unit.caller;
        caller.require(Permission::SchemaWrite)?;
        if shipped(&id)? {
            return Err(Refusal::validation(format!(
                "{id} is a core edge type and cannot be deleted"
            )));
        }
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let Some(existing) = catalog.edge_type(&id) else {
            return Err(Refusal::new(
                Code::EdgeTypeNotFound,
                format!("Edge type {id} not found"),
            ));
        };
        require_names(caller, &id, text_of(existing, "reverse_name"))?;
        if !force && edges::count_of_type(unit.tx(), &id)? > 0 {
            return Err(Refusal::new(
                Code::EdgeTypeInUse,
                format!("Edges of type {id} still exist."),
            )
            .with_detail("edge_type", id.as_str()));
        }
        unit.tx()
            .execute("DELETE FROM edge_types WHERE id = ?1", [&id])?;
        catalog::raise(unit.tx())?;
        instance::raise_reach(unit.tx())?;
        unit.audit("edge_type", &id, None)?;
        Ok(())
    })
    .await?;
    app.publish_catalog().await;
    Ok(())
}

/// What a restore does with an archive's edge types, judged on the catalog its write holds.
pub struct Restoring {
    fresh: Vec<Obj>,
    pub skipped: usize,
    pub conflicts: Vec<String>,
}

impl Restoring {
    pub fn registered(&self) -> usize {
        self.fresh.len()
    }

    pub fn rows(&self) -> Vec<Obj> {
        self.fresh.clone()
    }
}

/// Judges each edge type an archive carries as `POST /edge-types` would register it.
pub fn plan_restored(catalog: &Catalog, archived: &[Obj]) -> Result<Restoring> {
    let mut plan = Restoring {
        fresh: Vec::new(),
        skipped: 0,
        conflicts: Vec::new(),
    };
    let mut named: Vec<(String, String)> = Vec::new();
    for body in archived {
        let id = text_of(body, "id").unwrap_or_default().to_string();
        if shipped(&id)? {
            return Err(Refusal::new(
                Code::Conflict,
                format!("The archive carries {id}, a core edge type, which cannot be redefined"),
            ));
        }
        let unread = unread_edge_keys(body);
        if !unread.is_empty() {
            return Err(refusal_of(EdgeIssues::Schema(unread)));
        }
        request_shape(body).map_err(refusal_of)?;
        if !edge_id(&id) {
            return Err(Refusal::validation("Invalid edge-type identifier"));
        }
        if body.contains_key("extends") || body.contains_key("evolve_constraints") {
            return Err(Refusal::validation(
                "A registered edge type does not support `extends` or `evolve_constraints`",
            ));
        }
        let existing = catalog.edge_type(&id);
        let taken = |name: &str| {
            named
                .iter()
                .find(|(held, _)| held == name)
                .map(|(_, owner)| owner.clone())
                .or_else(|| holder_of(catalog, name).filter(|owner| *owner != id || existing.is_none()))
        };
        let built = edge_type_from_request(body, &taken).map_err(refusal_of)?;
        match existing {
            Some(held) if *held == built => plan.skipped += 1,
            Some(_) => plan.conflicts.push(id),
            None => {
                named.push((id.clone(), id.clone()));
                if let Some(reverse) = text_of(&built, "reverse_name") {
                    named.push((reverse.to_string(), id.clone()));
                }
                plan.fresh.push(built);
            }
        }
    }
    Ok(plan)
}

pub fn write_restored(unit: &Unit<'_, '_>, plan: Restoring) -> Result<()> {
    if plan.fresh.is_empty() {
        return Ok(());
    }
    for built in plan.fresh {
        let id = text_of(&built, "id").unwrap_or_default().to_string();
        unit.tx().execute(
            "INSERT INTO edge_types (id, reverse_name, created_by, definition, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                text_of(&built, "reverse_name"),
                unit.caller.actor().to_string(),
                Value::Object(built.clone()).to_string(),
                unit.at,
            ],
        )?;
    }
    catalog::raise(unit.tx())?;
    instance::raise_reach(unit.tx())
}
