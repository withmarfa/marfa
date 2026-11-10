use marfa_rules::grammar;
use marfa_rules::schema::{
    Obj, broken_compatible_dependents, descendant_depth, evolution_of, icon_issue, labelled,
    parent_chain_fault, read_back_free, resolve, validate_type, with_set_stored,
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
use crate::app::instance;
use crate::app::items;
use crate::app::refusal::{Code, Refusal, Result};

pub(super) fn not_found(id: &str) -> Refusal {
    Refusal::new(Code::TypeNotFound, format!("Type \"{id}\" not found"))
}

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
            instance::raise_reach(unit.tx())?;
            let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            items::rekey_changed(unit.tx(), &catalog.rules, &after.rules, std::slice::from_ref(&id))?;
            items::relink_changed(unit.tx(), &catalog, &after, std::slice::from_ref(&id))?;
            items::drop_tombstones(unit.tx(), &id)?;
            items::reindex_changed(unit.tx(), &catalog.rules, &after.rules)?;
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

/// What a change merges into a type's own definition: a field or table set to `null` is removed.
pub struct Merge {
    pub label: Option<String>,
    pub description: Option<String>,
    pub fields: Obj,
    pub tables: Obj,
}

enum Replacement {
    Whole(Obj),
    Merge(Merge),
}

/// The nearest ancestor whose own definition has the field or table `name`.
fn inherited_from<'a>(
    catalog: &'a Catalog,
    stored: &'a Obj,
    member: &str,
    name: &str,
) -> Option<&'a str> {
    let mut seen: Vec<&str> = Vec::new();
    let mut next = text_of(stored, "parent");
    while let Some(parent) = next {
        if seen.contains(&parent) {
            return None;
        }
        seen.push(parent);
        let definition = catalog.types.get(parent)?;
        if definition
            .get(member)
            .and_then(Value::as_object)
            .is_some_and(|held| held.contains_key(name))
        {
            return Some(parent);
        }
        next = text_of(definition, "parent");
    }
    None
}

fn inherited_removal(id: &str, name: &str, owner: &str) -> Refusal {
    Refusal::validation(format!(
        "{id} inherits {name} from {owner}, so it cannot remove it. Removing {name} from {owner} removes it from every type that inherits it."
    ))
}

fn merged(catalog: &Catalog, id: &str, stored: &Obj, merge: Merge) -> Result<Obj> {
    let mut definition = stored.clone();
    definition.remove("provenance");
    let mut fields = definition
        .get("fields")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (name, value) in merge.fields {
        if !value.is_null() {
            fields.insert(name, value);
        } else if fields.remove(&name).is_none()
            && let Some(owner) = inherited_from(catalog, stored, "fields", &name)
        {
            return Err(inherited_removal(id, &name, owner));
        }
    }
    definition.insert("fields".into(), Value::Object(fields));
    let mut tables = definition
        .get("tables")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (name, value) in merge.tables {
        if !value.is_null() {
            tables.insert(name, value);
        } else if tables.remove(&name).is_none()
            && let Some(owner) = inherited_from(catalog, stored, "tables", &name)
        {
            return Err(inherited_removal(id, &name, owner));
        }
    }
    if tables.is_empty() {
        definition.remove("tables");
    } else {
        definition.insert("tables".into(), Value::Object(tables));
    }
    if let Some(label) = merge.label {
        definition.insert("label".into(), label.into());
    }
    if let Some(description) = merge.description {
        definition.insert("description".into(), description.into());
    }
    Ok(definition)
}

/// Without `schema.write`, only changes that leave stored data valid.
/// `force` keeps the rows and values of the tables and columns the replacement removes.
pub async fn replace(
    app: &App,
    caller: &Caller,
    id: String,
    body: Obj,
    force: bool,
) -> Result<Value> {
    replacing(app, caller, id, Replacement::Whole(body), force).await
}

/// Merges into the definition the write commits, so a change made meanwhile is kept.
pub async fn change(app: &App, caller: &Caller, id: String, merge: Merge) -> Result<Value> {
    replacing(app, caller, id, Replacement::Merge(merge), false).await
}

async fn replacing(
    app: &App,
    caller: &Caller,
    id: String,
    replacement: Replacement,
    force: bool,
) -> Result<Value> {
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
            let mut definition = match replacement {
                Replacement::Whole(body) => body,
                Replacement::Merge(merge) => {
                    let held = stored.ok_or_else(|| not_found(&id))?;
                    merged(&catalog, &id, held, merge)?
                }
            };
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
            if !force {
                let next = catalog.types.with(schema.clone());
                let held = crate::app::tables::held_in_use(unit.tx(), &catalog, &next, &family)?;
                if !held.is_empty() {
                    return Err(Refusal::new(
                        Code::TypeInUse,
                        format!(
                            "Rows hold {}, which this change removes. Remove those rows first, or replace the type with force=true to keep them as they are.",
                            held.join(", ")
                        ),
                    )
                    .with_detail("tables", held));
                }
            }
            require_reach(caller, &schema, stored)?;
            if let Some(parent) = text_of(&schema, "parent") {
                let below = descendant_depth(&catalog.types, &id);
                if let Some(fault) = parent_chain_fault(&catalog.types, &id, parent, below) {
                    return Err(Refusal::validation(fault));
                }
            }
            if stored.and_then(|held| text_of(held, "parent")) != text_of(&schema, "parent") {
                instance::raise_reach(unit.tx())?;
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
            items::reindex_changed(unit.tx(), &catalog.rules, &after.rules)?;
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

/// A stored definition that does not read can be replaced only by a schema writer.
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
            "Changing {} requires schema.write. A credential holding metadata.types:write alone may add optional fields that no stored item holds a value under, add a table or an optional column, and change the type's label, plural, description, display hints and version, or a field's, table's or column's label and description.",
            changes.join(", ")
        ),
    )
    .with_detail("required_scope", Permission::SchemaWrite.word())
    .with_detail("changes", changes))
}

/// `force` keeps a type's items, unregistered; the local command removes only unused types.
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
        if caller.is_local() {
            if force {
                return Err(Refusal::new(
                    Code::Forbidden,
                    "The local command removes only unused types. Move their items to another type, and change the folders, views and webhooks that name them, first.",
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
        let settings = super::moving::naming(unit.tx(), caller, &id)?;
        let named = settings.as_array().is_some_and(|named| !named.is_empty());
        let columns = crate::app::tables::constraining_columns(&catalog, &id);
        if (held > 0 || named || !columns.is_empty()) && !force {
            return Err(Refusal::new(
                Code::TypeInUse,
                format!(
                    "Type \"{id}\" still has {held} item(s), or a folder, view, webhook or table column names it. Move its items to another type, which rewrites those settings, or delete with ?force=true to keep the items, settings and columns as they are."
                ),
            )
            .with_detail("item_count", held)
            .with_detail("settings", settings)
            .with_detail("columns", columns));
        }
        unit.tx().execute("DELETE FROM types WHERE id = ?1", [&id])?;
        catalog::raise(unit.tx())?;
        instance::raise_reach(unit.tx())?;
        let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        items::rekey_changed(unit.tx(), &catalog.rules, &after.rules, std::slice::from_ref(&id))?;
        items::relink_changed(unit.tx(), &catalog, &after, std::slice::from_ref(&id))?;
        items::reindex_changed(unit.tx(), &catalog.rules, &after.rules)?;
        unit.audit("type", &id, None)?;
        Ok(())
    })
    .await?;
    app.publish_catalog().await;
    Ok(())
}

pub(super) fn subtypes_of(tx: &Transaction<'_>, id: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare("SELECT id FROM types WHERE parent = ?1 ORDER BY id")?;
    let found = statement.query_map([id], |row| row.get(0))?;
    Ok(found.collect::<std::result::Result<_, _>>()?)
}

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

/// An archive's type line: the definition and who made it.
pub struct Archived {
    pub definition: Value,
    pub created_by: Option<Value>,
}

/// What a restore does with an archive's types, judged on the catalog its write holds.
pub struct Restoring {
    fresh: Vec<(String, Obj, Option<Value>)>,
    pub skipped: usize,
    pub conflicts: Vec<String>,
}

impl Restoring {
    pub fn registered(&self) -> usize {
        self.fresh.len()
    }

    /// The definitions the plan registers.
    pub fn rows(&self) -> Vec<Obj> {
        self.fresh
            .iter()
            .map(|(_, schema, _)| schema.clone())
            .collect()
    }
}

fn reserved(id: &str, why: String) -> Refusal {
    Refusal::new(
        Code::Forbidden,
        format!("The archive registers {id}, {why}, which no archive can restore."),
    )
}

/// Judges every type an archive registers together, so registrations that name each other
/// restore in any order: each is held to what `POST /types` takes.
pub fn plan_restored(catalog: &Catalog, archived: &[Archived]) -> Result<Restoring> {
    let mut raw = Vec::new();
    for line in archived {
        let definition = line.definition.as_object().ok_or_else(|| {
            Refusal::new(Code::InvalidSchema, "An archived type is not an object")
        })?;
        let id = text_of(definition, "id").unwrap_or_default();
        check_id(id, "type.id")?;
        if let Some(root) = grammar::platform_root(id) {
            return Err(reserved(
                id,
                format!("a type in the reserved {root}.* namespace"),
            ));
        }
        raw.push(definition.clone());
    }
    let registry = with_set_stored(&catalog.types, &raw);
    let mut plan = Restoring {
        fresh: Vec::new(),
        skipped: 0,
        conflicts: Vec::new(),
    };
    for definition in &raw {
        let id = text_of(definition, "id").unwrap_or_default();
        if let Some(parent) = text_of(definition, "parent")
            && let Some(fault) = parent_chain_fault(&registry, id, parent, 0)
        {
            return Err(Refusal::validation(fault));
        }
    }
    for (line, definition) in archived.iter().zip(&raw) {
        let schema =
            validate_type(&Value::Object(definition.clone()), &registry).map_err(schema_refusal)?;
        let schema = labelled(schema);
        let id = text_of(&schema, "id")
            .ok_or_else(|| Refusal::internal("an archived type has no id"))?
            .to_string();
        if let Some(parent) = text_of(&schema, "parent")
            && let Some(fault) = parent_chain_fault(&registry, &id, parent, 0)
        {
            return Err(Refusal::validation(fault));
        }
        match catalog.types.get(&id) {
            Some(held) if catalog.holds(&id) && *held == schema => plan.skipped += 1,
            Some(_) if catalog.holds(&id) => plan.conflicts.push(id),
            _ => plan.fresh.push((id, schema, line.created_by.clone())),
        }
    }
    let ids: Vec<&str> = plan.fresh.iter().map(|(id, _, _)| id.as_str()).collect();
    let written = plan
        .fresh
        .iter()
        .fold(catalog.types.clone(), |held, (_, schema, _)| {
            held.with(schema.clone())
        });
    let broken = broken_compatible_dependents(&written, &ids);
    if !broken.is_empty() {
        return Err(dependents_refusal(broken));
    }
    Ok(plan)
}

/// Registers the types a plan found new, and brings their rows' keys, links and index up to them.
pub fn write_restored(
    unit: &crate::app::unit::Unit<'_, '_>,
    cache: &arc_swap::ArcSwap<Catalog>,
    before: &Catalog,
    plan: Restoring,
) -> Result<()> {
    if plan.fresh.is_empty() {
        return Ok(());
    }
    let tx = unit.tx();
    let mut ids = Vec::new();
    for (id, schema, created_by) in plan.fresh {
        let parent = text_of(&schema, "parent").map(str::to_string);
        tx.execute(
            "INSERT INTO types (id, parent, origin, created_by, definition, created_at, updated_at) \
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?5)",
            params![
                id,
                parent,
                created_by.map(|by| by.to_string()),
                Value::Object(schema).to_string(),
                unit.at,
            ],
        )?;
        unit.audit("type", &id, None)?;
        ids.push(id);
    }
    catalog::raise(tx)?;
    instance::raise_reach(tx)?;
    let after = catalog::current(cache, tx, Snapshot::Pending)?;
    items::rekey_changed(tx, &before.rules, &after.rules, &ids)?;
    items::relink_changed(tx, before, &after, &ids)?;
    for id in &ids {
        items::drop_tombstones(tx, id)?;
    }
    items::reindex_changed(tx, &before.rules, &after.rules)
}

/// Sets each icon whose type has no owner icon, and answers how many it set.
pub fn restore_icons(
    unit: &crate::app::unit::Unit<'_, '_>,
    catalog: &Catalog,
    icons: &[(String, String)],
) -> Result<(usize, usize)> {
    let (mut added, mut held) = (0, 0);
    for (id, icon) in icons {
        if catalog.types.icon_of(id).is_some() {
            held += 1;
            continue;
        }
        unit.tx().execute(
            "UPDATE types SET owner_icon = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, icon, unit.at],
        )?;
        added += 1;
    }
    if added > 0 {
        catalog::raise(unit.tx())?;
    }
    Ok((added, held))
}
