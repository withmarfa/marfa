//! Installed plugins: installing a bundle registers its edge types and types in one write and
//! keeps its record; removing a plugin removes the record and keeps every type.

use marfa_rules::plugin::{self, ChildClash, Version};
use marfa_rules::schema::{Obj, Problem};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::access::{Caller, Level, Permission};
use super::catalog::{self, Catalog, Origin, Snapshot};
use super::items::reading;
use super::refusal::{Code, Refusal, Result};
use super::{edge_types, instance, types};

/// An install record as the `plugins` table holds it.
#[derive(Clone, Debug)]
pub struct Installed {
    pub name: String,
    pub version: String,
    pub manifest: Obj,
    pub installed_at: String,
    pub installed_by: Option<Value>,
    pub updated_at: String,
}

impl Installed {
    fn text(&self, key: &str) -> &str {
        self.manifest
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    fn ids(&self, key: &str) -> Vec<String> {
        self.manifest
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }
}

fn not_found(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginNotFound,
        format!("No plugin named {name} is installed."),
    )
    .with_detail("name", name)
}

fn row(tx: &Transaction<'_>, name: &str) -> Result<Option<Installed>> {
    let held: Option<(String, String, String, Option<String>, String)> = tx
        .query_row(
            "SELECT version, manifest, installed_at, installed_by, updated_at FROM plugins \
             WHERE name = ?1",
            [name],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    held.map(
        |(version, manifest, installed_at, installed_by, updated_at)| {
            read_row(
                name,
                version,
                &manifest,
                installed_at,
                installed_by,
                updated_at,
            )
        },
    )
    .transpose()
}

fn read_row(
    name: &str,
    version: String,
    manifest: &str,
    installed_at: String,
    installed_by: Option<String>,
    updated_at: String,
) -> Result<Installed> {
    let Ok(Value::Object(manifest)) = serde_json::from_str::<Value>(manifest) else {
        return Err(Refusal::internal(&format!(
            "the stored bundle of plugin {name} does not read"
        )));
    };
    let installed_by = match installed_by {
        None => None,
        Some(text) => Some(serde_json::from_str(&text).map_err(|_| {
            Refusal::internal(&format!("who installed plugin {name} does not read"))
        })?),
    };
    Ok(Installed {
        name: name.to_string(),
        version,
        manifest,
        installed_at,
        installed_by,
        updated_at,
    })
}

fn rows(tx: &Transaction<'_>) -> Result<Vec<Installed>> {
    let mut statement = tx.prepare(
        "SELECT name, version, manifest, installed_at, installed_by, updated_at FROM plugins \
         ORDER BY name",
    )?;
    let found = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut held = Vec::new();
    for read in found {
        let (name, version, manifest, installed_at, installed_by, updated_at) = read?;
        held.push(read_row(
            &name,
            version,
            &manifest,
            installed_at,
            installed_by,
            updated_at,
        )?);
    }
    Ok(held)
}

/// The types the catalog holds from the plugin `name`, at any version.
fn types_from(catalog: &Catalog, name: &str) -> Vec<String> {
    let mut ids: Vec<String> = catalog
        .provenance
        .iter()
        .filter(|(_, held)| held.origin.plugin() == Some(name))
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

fn presented(installed: &Installed, catalog: &Catalog) -> Value {
    json!({
        "name": installed.name,
        "version": installed.version,
        "title": installed.text("title"),
        "description": installed.text("description"),
        "mark": installed.text("mark"),
        "maker": installed.text("maker"),
        "marfa": installed.text("marfa"),
        "types": types_from(catalog, &installed.name),
        "edge_types": installed.ids("edge_types"),
        "connector": installed.manifest.get("connector").cloned().unwrap_or(Value::Null),
        "installed_at": installed.installed_at,
        "installed_by": installed.installed_by.clone().unwrap_or(Value::Null),
        "updated_at": installed.updated_at,
    })
}

pub async fn list(app: &App, caller: &Caller) -> Result<Vec<Value>> {
    reading(app, caller, |read| {
        Ok(rows(read.tx)?
            .iter()
            .map(|installed| presented(installed, &read.catalog))
            .collect())
    })
    .await
}

pub async fn get(app: &App, caller: &Caller, name: String) -> Result<Value> {
    reading(app, caller, move |read| {
        let installed = row(read.tx, &name)?.ok_or_else(|| not_found(&name))?;
        Ok(presented(&installed, &read.catalog))
    })
    .await
}

fn problems_json(problems: &[Problem]) -> Vec<Value> {
    problems
        .iter()
        .map(|problem| json!({ "path": problem.path, "message": problem.message }))
        .collect()
}

/// Refuses a bundle whose shape is wrong, then one with a type under a reserved root.
fn require_shape(bundle: &Obj) -> Result<()> {
    let faults = plugin::bundle_faults(bundle);
    let (reserved, shape): (Vec<Problem>, Vec<Problem>) = faults
        .into_iter()
        .partition(|fault| fault.code == "forbidden");
    if !shape.is_empty() {
        let named: Vec<&str> = shape.iter().map(|fault| fault.path.as_str()).collect();
        return Err(Refusal::validation(format!(
            "The plugin bundle is not one this server installs: {}.",
            named.join(", ")
        ))
        .with_detail("errors", problems_json(&shape)));
    }
    if let Some(first) = reserved.first() {
        let root = bundle_ids(bundle, "types")
            .into_iter()
            .find_map(plugin::reserved_root)
            .unwrap_or_default();
        return Err(Refusal::new(Code::Forbidden, first.message.clone())
            .with_detail("namespace", root)
            .with_detail("errors", problems_json(&reserved)));
    }
    Ok(())
}

fn bundle_ids<'a>(bundle: &'a Obj, key: &str) -> Vec<&'a str> {
    bundle
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect()
}

fn bundle_objects(bundle: &Obj, key: &str) -> Vec<Obj> {
    bundle
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .cloned()
        .collect()
}

fn text(bundle: &Obj, key: &str) -> String {
    bundle
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn version_of(bundle: &Obj, key: &str) -> Result<Version> {
    Version::parse(&text(bundle, key))
        .ok_or_else(|| Refusal::internal("a checked bundle has no version"))
}

fn require_server(bundle: &Obj) -> Result<()> {
    let marfa = version_of(bundle, "marfa")?;
    let server = Version::parse(instance::VERSION)
        .ok_or_else(|| Refusal::internal("this build's version does not read"))?;
    if plugin::server_takes(server, marfa) {
        return Ok(());
    }
    Err(Refusal::new(
        Code::PluginNeedsNewerServer,
        format!(
            "This plugin needs Marfa {marfa} or later, and this server runs {server}. Update the server, then install the plugin again."
        ),
    )
    .with_detail("marfa", marfa.to_string())
    .with_detail("server", server.to_string()))
}

/// Install's permission: `schema.write`, and write on every type and edge type the bundle holds.
fn require_install(caller: &Caller, bundle: &Obj) -> Result<()> {
    caller.require(Permission::SchemaWrite)?;
    for id in bundle_ids(bundle, "types") {
        caller.require_type(id, Level::Write)?;
    }
    for id in bundle_ids(bundle, "edge_types") {
        caller.require_edge(id, Level::Write)?;
    }
    Ok(())
}

fn clashes_refusal(clashes: Vec<ChildClash>) -> Refusal {
    let mut named: Vec<&str> = clashes.iter().map(|clash| clash.type_id.as_str()).collect();
    named.dedup();
    let message = format!(
        "This version of the plugin gives a type a field or status word that {} already declares in another shape. Change or remove it on {}, then install again.",
        named.join(", "),
        if named.len() == 1 {
            "that type"
        } else {
            "each of those types"
        }
    );
    let conflicts: Vec<Value> = clashes
        .iter()
        .map(|clash| {
            json!({
                "type": clash.type_id,
                "field": clash.field,
                "attribute": clash.attribute,
                "inherited_from": clash.inherited_from,
                "inherited": clash.inherited,
                "declared": clash.declared,
            })
        })
        .collect();
    Refusal::new(Code::PluginChildConflict, message).with_detail("conflicts", conflicts)
}

/// What installing a bundle did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    Updated,
    Unchanged,
}

impl Outcome {
    pub fn word(self) -> &'static str {
        match self {
            Outcome::Installed => "installed",
            Outcome::Updated => "updated",
            Outcome::Unchanged => "unchanged",
        }
    }
}

pub async fn install(app: &App, caller: &Caller, bundle: Obj) -> Result<(Outcome, Value)> {
    require_shape(&bundle)?;
    require_server(&bundle)?;
    let cache = app.catalog_handle();
    let answered = app
        .write(caller, "plugin.install", move |unit| {
            let caller = &unit.caller;
            require_install(caller, &bundle)?;
            let name = text(&bundle, "name");
            let version = version_of(&bundle, "version")?;
            let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            let held = row(unit.tx(), &name)?;
            if let Some(held) = &held {
                let installed = Version::parse(&held.version).ok_or_else(|| {
                    Refusal::internal(&format!("the installed version of {name} does not read"))
                })?;
                if version == installed {
                    return Ok((Outcome::Unchanged, presented(held, &catalog)));
                }
                if version < installed {
                    return Err(Refusal::new(
                        Code::PluginVersionOlder,
                        format!(
                            "Version {installed} of {name} is installed, and {version} is older. Remove the plugin first to install an older version."
                        ),
                    )
                    .with_detail("installed", installed.to_string())
                    .with_detail("version", version.to_string()));
                }
            }
            let definitions = bundle_objects(&bundle, "types");
            let origin = Origin::Plugin {
                name: name.clone(),
                version: version.to_string(),
            };
            let plan = types::write::plan_install(caller, &catalog, &name, &definitions)?;
            let next = plan.next_registry(&catalog);
            let changed: Vec<&str> = plan.ids();
            let clashes = plugin::child_clashes(&next, &changed);
            if !clashes.is_empty() {
                return Err(clashes_refusal(clashes));
            }
            edge_types::install(unit, &catalog, &bundle_objects(&bundle, "edge_types"))?;
            let before = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            types::write::write_install(unit, &cache, &before, plan, &origin)?;
            let manifest = Value::Object(bundle.clone()).to_string();
            let by = caller.actor().to_string();
            unit.tx().execute(
                "INSERT INTO plugins (name, version, title, description, mark, maker, marfa, \
                 manifest, installed_at, installed_by, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9) \
                 ON CONFLICT (name) DO UPDATE SET version = excluded.version, \
                 title = excluded.title, description = excluded.description, \
                 mark = excluded.mark, maker = excluded.maker, marfa = excluded.marfa, \
                 manifest = excluded.manifest, updated_at = excluded.updated_at",
                params![
                    name,
                    version.to_string(),
                    text(&bundle, "title"),
                    text(&bundle, "description"),
                    text(&bundle, "mark"),
                    text(&bundle, "maker"),
                    text(&bundle, "marfa"),
                    manifest,
                    unit.at,
                    by,
                ],
            )?;
            unit.audit("plugin", &name, Some(json!({ "version": version.to_string() })))?;
            let after = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            let installed = row(unit.tx(), &name)?
                .ok_or_else(|| Refusal::internal("an installed plugin has no record"))?;
            let outcome = if held.is_some() {
                Outcome::Updated
            } else {
                Outcome::Installed
            };
            Ok((outcome, presented(&installed, &after)))
        })
        .await?;
    if answered.0 != Outcome::Unchanged {
        app.publish_catalog().await;
    }
    Ok(answered)
}

pub async fn remove(app: &App, caller: &Caller, name: String) -> Result<Value> {
    let cache = app.catalog_handle();
    app.write(caller, "plugin.remove", move |unit| {
        unit.caller.require(Permission::SchemaWrite)?;
        let held = row(unit.tx(), &name)?.ok_or_else(|| not_found(&name))?;
        unit.tx()
            .execute("DELETE FROM plugins WHERE name = ?1", [&name])?;
        unit.audit("plugin", &name, Some(json!({ "version": held.version })))?;
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        Ok(json!({
            "removed": { "name": held.name, "version": held.version },
            "kept": {
                "types": types_from(&catalog, &name),
                "edge_types": held.ids("edge_types"),
            },
        }))
    })
    .await
}

/// An archive's plugin line.
#[derive(Clone, Debug)]
pub struct Archived {
    pub name: String,
    line: Installed,
}

/// The archive's line for each installed plugin.
pub fn archive_lines(tx: &Transaction<'_>) -> Result<Vec<Value>> {
    Ok(rows(tx)?
        .into_iter()
        .map(|held| {
            json!({ "plugin": {
                "name": held.name,
                "version": held.version,
                "bundle": held.manifest,
                "installed_at": held.installed_at,
                "installed_by": held.installed_by,
                "updated_at": held.updated_at,
            } })
        })
        .collect())
}

/// Reads an archive's plugin line, or says what is wrong with it.
pub fn archived(body: &Value) -> std::result::Result<Archived, String> {
    let line = body.as_object().ok_or("is not an object")?;
    let read = |key: &str| line.get(key).and_then(Value::as_str).map(str::to_string);
    let bundle = line
        .get("bundle")
        .and_then(Value::as_object)
        .ok_or("names no bundle")?
        .clone();
    if !plugin::bundle_faults(&bundle).is_empty() {
        return Err("carries a bundle this server does not install".into());
    }
    let name = read("name").ok_or("names no name")?;
    let version = read("version").ok_or("names no version")?;
    if bundle.get("name").and_then(Value::as_str) != Some(name.as_str())
        || bundle.get("version").and_then(Value::as_str) != Some(version.as_str())
    {
        return Err("names another name or version than its bundle".into());
    }
    let installed_at = read("installed_at").ok_or("names no installed_at")?;
    let updated_at = read("updated_at").ok_or("names no updated_at")?;
    let installed_by = line
        .get("installed_by")
        .filter(|by| by.is_object())
        .cloned();
    Ok(Archived {
        name: name.clone(),
        line: Installed {
            name,
            version,
            manifest: bundle,
            installed_at,
            installed_by,
            updated_at,
        },
    })
}

/// Restores each archived install record this instance lacks, and answers how many it added
/// and how many it kept as held.
pub fn restore(tx: &Transaction<'_>, archived: &[Archived]) -> Result<(usize, usize)> {
    let (mut added, mut held) = (0, 0);
    for line in archived {
        let installed = &line.line;
        if row(tx, &installed.name)?.is_some() {
            held += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO plugins (name, version, title, description, mark, maker, marfa, \
             manifest, installed_at, installed_by, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                installed.name,
                installed.version,
                installed.text("title"),
                installed.text("description"),
                installed.text("mark"),
                installed.text("maker"),
                installed.text("marfa"),
                Value::Object(installed.manifest.clone()).to_string(),
                installed.installed_at,
                installed.installed_by.as_ref().map(Value::to_string),
                installed.updated_at,
            ],
        )?;
        added += 1;
    }
    Ok((added, held))
}
