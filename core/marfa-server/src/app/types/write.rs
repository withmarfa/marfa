//! The writes that change the types of an instance.

use marfa_rules::grammar;
use marfa_rules::schema::{
    Obj, broken_compatible_dependents, descendant_depth, evolution_of, icon_issue, labelled,
    parent_chain_fault, read_back_free, resolve, validate_type,
};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};

use super::{
    chain_refusal, check_id, dependents_refusal, missing_field, presented, require_reach,
    schema_refusal,
};
use crate::app::App;
use crate::app::access::{Caller, Door, Level, Permission, SchemaKind};
use crate::app::catalog::{self, Catalog, Provenance, Snapshot};
use crate::app::items;
use crate::app::refusal::{Code, Refusal, Result};

fn not_found(id: &str) -> Refusal {
    Refusal::new(Code::TypeNotFound, format!("Type \"{id}\" not found"))
}

/// Refuses an identifier Marfa's own build holds.
fn platform_locked(catalog: &Catalog, id: &str, what: &str) -> Result<()> {
    let platform = catalog
        .provenance
        .get(id)
        .is_some_and(|held| held.origin == "platform");
    if Catalog::ships(id) || platform {
        return Err(Refusal::new(
            Code::CoreTypeImmutable,
            format!("Cannot {what} platform-shipped types"),
        ));
    }
    Ok(())
}

fn text_of<'a>(schema: &'a Obj, key: &str) -> Option<&'a str> {
    schema.get(key).and_then(Value::as_str)
}

fn store(tx: &Transaction<'_>, id: &str, schema: &Obj, at: &str) -> Result<()> {
    tx.execute(
        "UPDATE types SET parent = ?2, definition = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            id,
            text_of(schema, "parent"),
            Value::Object(schema.clone()).to_string(),
            at
        ],
    )?;
    catalog::raise(tx)
}

/// The grant that reaches an identifier nothing has registered yet.
const NAMESPACE_WILDCARD: &str = "user.*:write";

/// Registers a type. The answer is the type as it was stored.
pub async fn register(app: &App, caller: &Caller, body: Obj) -> Result<Value> {
    if !body.contains_key("fields") {
        return Err(missing_field("fields"));
    }
    let named = text_of(&body, "id").map(str::to_string);
    if let Some(id) = &named {
        check_id(id, "id")?;
        if let Some(root) = grammar::platform_root(id) {
            return Err(Refusal::new(
                Code::Forbidden,
                format!(
                    "Reserved namespace: {root}.* types are platform-shipped and cannot be registered at runtime"
                ),
            )
            .with_detail("namespace", root));
        }
    }
    let cache = app.catalog_handle();
    let created = app
        .write(caller, "type.register", move |unit| {
            let caller = &unit.caller;
            caller.require_door(SchemaKind::Types, Door::Register)?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            if let Some(id) = &named {
                caller.require_type(id, Level::Write).map_err(|refusal| {
                    if catalog.holds(id) {
                        refusal
                    } else {
                        refusal.with_detail("required_scope", NAMESPACE_WILDCARD)
                    }
                })?;
            }
            let schema = validate_type(&Value::Object(body), &catalog.types)
                .map_err(schema_refusal)?;
            let schema = labelled(schema);
            let id = text_of(&schema, "id")
                .ok_or_else(|| Refusal::internal("a registered type has no id"))?
                .to_string();
            require_reach(caller, &schema, None)?;
            if let Some(parent) = text_of(&schema, "parent")
                && let Some(fault) = parent_chain_fault(&catalog.types, &id, parent, 0)
            {
                return Err(Refusal::validation(fault));
            }
            if catalog.holds(&id) {
                return Err(Refusal::new(
                    Code::TypeAlreadyExists,
                    format!("Type \"{id}\" already exists"),
                ));
            }
            let broken = broken_compatible_dependents(&catalog.types.with(schema.clone()), &[&id]);
            if !broken.is_empty() {
                return Err(dependents_refusal(broken));
            }
            let creator = caller.actor();
            unit.tx().execute(
                "INSERT INTO types (id, parent, origin, created_by, definition, created_at, updated_at) \
                 VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?5)",
                params![
                    id,
                    text_of(&schema, "parent"),
                    creator.to_string(),
                    Value::Object(schema.clone()).to_string(),
                    unit.at,
                ],
            )?;
            catalog::raise(unit.tx())?;
            let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            items::rekey_changed(unit.tx(), &catalog.rules, &after.rules, std::slice::from_ref(&id))?;
            items::relink_changed(unit.tx(), &catalog, &after, std::slice::from_ref(&id))?;
            items::drop_tombstones(unit.tx(), &id)?;
            unit.audit("type", &id, None)?;
            let held = Provenance {
                origin: "user",
                created_by: Some(creator),
            };
            Ok(presented(schema, Some(&held)))
        })
        .await?;
    app.publish_catalog().await;
    Ok(created)
}

/// Replaces a type with a new definition. A key holding `schema.write` may
/// make any replacement; one admitted by the metadata map alone may make
/// only the changes that leave stored data valid.
pub async fn replace(app: &App, caller: &Caller, id: String, body: Obj) -> Result<Value> {
    let cache = app.catalog_handle();
    let replaced = app
        .write(caller, "type.replace", move |unit| {
            let caller = &unit.caller;
            caller.require_door(SchemaKind::Types, Door::Replace)?;
            check_id(&id, "id")?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            platform_locked(&catalog, &id, "replace")?;
            if !catalog.holds(&id) {
                return Err(not_found(&id));
            }
            caller.require_type(&id, Level::Write)?;
            let stored = catalog.types.get(&id);
            let mut definition = body;
            definition.remove("provenance");
            definition.insert("id".into(), Value::String(id.clone()));
            let schema = validate_type(&Value::Object(definition), &catalog.types)
                .map_err(schema_refusal)?;
            let schema = labelled(schema);
            let schema = match stored {
                Some(stored) => {
                    let read = resolve(&catalog.types, &id, false).ok().flatten();
                    read_back_free(schema, stored, read.as_ref(), catalog.types.icon_of(&id))
                }
                None => schema,
            };
            let family = with_subtypes(unit.tx(), &id)?;
            require_evolution(unit.tx(), caller, &family, stored, &schema)?;
            require_reach(caller, &schema, stored)?;
            if let Some(parent) = text_of(&schema, "parent") {
                let below = descendant_depth(&catalog.types, &id);
                if let Some(fault) = parent_chain_fault(&catalog.types, &id, parent, below) {
                    return Err(Refusal::validation(fault));
                }
            }
            store(unit.tx(), &id, &schema, &unit.at)?;
            let next = catalog.types.with(schema);
            let broken = broken_compatible_dependents(&next, &[&id]);
            if !broken.is_empty() {
                return Err(dependents_refusal(broken));
            }
            let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            items::rekey_changed(unit.tx(), &catalog.rules, &after.rules, &family)?;
            items::relink_changed(unit.tx(), &catalog, &after, std::slice::from_ref(&id))?;
            unit.audit("type", &id, None)?;
            let shown = next
                .owned(&id)
                .ok_or_else(|| Refusal::internal("a replaced type is not in its registry"))?;
            Ok(presented(shown, catalog.provenance.get(&id)))
        })
        .await?;
    app.publish_catalog().await;
    Ok(replaced)
}

/// Holds a replacement to what the caller's permissions allow. A stored
/// definition that does not read can be replaced only by a schema writer.
fn require_evolution(
    tx: &Transaction<'_>,
    caller: &Caller,
    family: &[String],
    stored: Option<&Obj>,
    next: &Obj,
) -> Result<()> {
    if caller.holds(Permission::SchemaWrite) {
        return Ok(());
    }
    let Some(stored) = stored else {
        return caller.require(Permission::SchemaWrite);
    };
    let (mut changes, additions) = evolution_of(stored, next);
    let held = items::held_names(tx, family, &additions)?;
    changes.extend(held.iter().map(|name| format!("fields.{name}")));
    if changes.is_empty() {
        return Ok(());
    }
    changes.sort();
    Err(Refusal::new(
        Code::Forbidden,
        format!(
            "Changing {} requires schema.write. A credential holding metadata.types:write alone may add optional fields that no stored row holds a value under, and change the label, plural, description, display hints and version, and a kept field's description and labels.",
            changes.join(", ")
        ),
    )
    .with_detail("required_scope", Permission::SchemaWrite.word())
    .with_detail("changes", changes))
}

/// Deletes a type. `force` is the owner console's refusal and a key's leave
/// to delete a type that items hold.
pub async fn delete(app: &App, caller: &Caller, id: String, force: bool) -> Result<()> {
    let cache = app.catalog_handle();
    app.write(caller, "type.delete", move |unit| {
        let caller = &unit.caller;
        caller.require(Permission::SchemaWrite)?;
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        platform_locked(&catalog, &id, "delete")?;
        if !catalog.holds(&id) {
            return Err(not_found(&id));
        }
        if caller.is_direct() {
            if force {
                return Err(Refusal::new(
                    Code::Forbidden,
                    "The owner console removes only unused types. Move their items to another type, and change the folders, views and webhooks that name them, first.",
                ));
            }
        } else {
            caller.require_type(&id, Level::Write)?;
        }
        let subtypes = subtypes_of(unit.tx(), &id)?;
        if !subtypes.is_empty() {
            let quoted: Vec<String> = subtypes.iter().map(|subtype| format!("\"{subtype}\"")).collect();
            return Err(Refusal::new(
                Code::TypeHasSubtypes,
                format!(
                    "Type \"{id}\" cannot be deleted while {} inherit from it. Delete them first, or give each a different parent with PUT /types/{{id}}. This is not what ?force=true covers, which is existing items.",
                    quoted.join(", ")
                ),
            )
            .with_detail("subtype_ids", subtypes));
        }
        let broken = broken_compatible_dependents(&catalog.types.without(&id), &[&id]);
        if !broken.is_empty() {
            return Err(dependents_refusal(broken));
        }
        let held = items::count_of_type(unit.tx(), &id)?;
        if held > 0 && !force {
            return Err(Refusal::new(
                Code::TypeInUse,
                format!(
                    "Type \"{id}\" still has {held} item(s). Move them to another type, or delete with ?force=true to keep them unregistered."
                ),
            )
            .with_detail("item_count", held)
            .with_detail("settings", json!([])));
        }
        unit.tx().execute("DELETE FROM types WHERE id = ?1", [&id])?;
        catalog::raise(unit.tx())?;
        let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        items::rekey_changed(unit.tx(), &catalog.rules, &after.rules, std::slice::from_ref(&id))?;
        items::relink_changed(unit.tx(), &catalog, &after, std::slice::from_ref(&id))?;
        unit.audit("type", &id, None)?;
        Ok(())
    })
    .await?;
    app.publish_catalog().await;
    Ok(())
}

/// The types that name `id` as their parent, readable or not.
pub(super) fn subtypes_of(tx: &Transaction<'_>, id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare("SELECT id FROM types WHERE parent = ?1 ORDER BY id")?;
    let found = statement.query_map([id], |row| row.get(0))?;
    Ok(found.collect::<std::result::Result<_, _>>()?)
}

/// `id` and every type under it.
fn with_subtypes(tx: &Transaction<'_>, id: &str) -> Result<Vec<String>> {
    let mut family = vec![id.to_string()];
    let mut at = 0;
    while let Some(held) = family.get(at).cloned() {
        for subtype in subtypes_of(tx, &held)? {
            if !family.contains(&subtype) {
                family.push(subtype);
            }
        }
        at += 1;
    }
    Ok(family)
}

/// Sets the icon the owner chose for a type, which stands in place of the one
/// its author set.
pub async fn set_icon(app: &App, caller: &Caller, id: String, body: Obj) -> Result<Value> {
    let icon = body
        .get("icon")
        .ok_or_else(|| missing_field("icon"))?
        .clone();
    if !icon.is_string() {
        return Err(Refusal::validation("icon is a string").with_detail("field", "icon"));
    }
    if let Some(issue) = icon_issue(Some(&icon), "icon") {
        return Err(Refusal::new(Code::InvalidSchema, "Invalid type icon")
            .with_detail("errors", json!([issue.to_json()])));
    }
    change_icon(
        app,
        caller,
        id,
        "type.icon.set",
        icon.as_str().map(str::to_string),
    )
    .await
}

/// Takes back the icon the owner chose.
pub async fn clear_icon(app: &App, caller: &Caller, id: String) -> Result<Value> {
    change_icon(app, caller, id, "type.icon.clear", None).await
}

async fn change_icon(
    app: &App,
    caller: &Caller,
    id: String,
    action: &'static str,
    icon: Option<String>,
) -> Result<Value> {
    let cache = app.catalog_handle();
    let answered = app
        .write(caller, action, move |unit| {
            let caller = &unit.caller;
            caller.require_door(SchemaKind::Types, Door::Change)?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            if !catalog.holds(&id) {
                return Err(not_found(&id));
            }
            caller.require_type(&id, Level::Write)?;
            unit.tx().execute(
                "UPDATE types SET owner_icon = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, icon, unit.at],
            )?;
            catalog::raise(unit.tx())?;
            unit.audit("type", &id, None)?;
            let registry = catalog.types.with_icon(&id, icon.as_deref());
            let resolved = resolve(&registry, &id, false)
                .map_err(|fault| chain_refusal(&fault))?
                .ok_or_else(|| not_found(&id))?;
            Ok(presented(resolved, catalog.provenance.get(&id)))
        })
        .await?;
    app.publish_catalog().await;
    Ok(answered)
}
