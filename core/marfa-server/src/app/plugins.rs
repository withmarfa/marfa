//! A plugin's types outlive its install record.

use marfa_rules::plugin::{self, Version};
use marfa_rules::schema::{Obj, Problem};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::access::{Caller, Level, Permission};
use super::catalog::{self, Catalog, Origin, Snapshot};
use super::clock::Stamp;
use super::items::reading;
use super::refusal::{Code, Refusal, Result};
use super::{edge_types, instance, types};

#[derive(Clone, Debug)]
pub struct Installed {
    pub name: String,
    pub version: String,
    pub manifest: Obj,
    /// The SHA-256 of the bundle's bytes as `POST /plugins` received them.
    pub fingerprint: String,
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
    let held: Option<Stored> = tx
        .query_row(
            "SELECT name, version, manifest, fingerprint, installed_at, installed_by, updated_at \
             FROM plugins WHERE name = ?1",
            [name],
            stored,
        )
        .optional()?;
    held.map(read_row).transpose()
}

type Stored = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);

fn stored(row: &rusqlite::Row<'_>) -> rusqlite::Result<Stored> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn read_row(
    (name, version, manifest, fingerprint, installed_at, installed_by, updated_at): Stored,
) -> Result<Installed> {
    let Ok(Value::Object(manifest)) = serde_json::from_str::<Value>(&manifest) else {
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
    if !plugin::is_sha256(&fingerprint) {
        return Err(Refusal::internal(&format!(
            "the stored fingerprint of plugin {name} does not read"
        )));
    }
    Ok(Installed {
        name,
        version,
        manifest,
        fingerprint,
        installed_at,
        installed_by,
        updated_at,
    })
}

fn rows(tx: &Transaction<'_>) -> Result<Vec<Installed>> {
    let mut statement = tx.prepare(
        "SELECT name, version, manifest, fingerprint, installed_at, installed_by, updated_at \
         FROM plugins ORDER BY name",
    )?;
    let found = statement.query_map([], stored)?;
    let mut held = Vec::new();
    for read in found {
        held.push(read_row(read?)?);
    }
    Ok(held)
}

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

/// The edge types the plugin brought that the instance still holds.
fn edge_types_held(installed: &Installed, catalog: &Catalog) -> Vec<String> {
    installed
        .ids("edge_types")
        .into_iter()
        .filter(|id| catalog.edge_type(id).is_some())
        .collect()
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
        "edge_types": edge_types_held(installed, catalog),
        "connector": installed.manifest.get("connector").cloned().unwrap_or(Value::Null),
        "fingerprint": installed.fingerprint,
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

fn require_install(caller: &Caller, bundle: &Obj) -> Result<()> {
    caller.require(Permission::SchemaWrite)?;
    if bundle.get("connector").is_some_and(|held| !held.is_null()) {
        caller.require(Permission::ConnectorsManage)?;
    }
    for id in bundle_ids(bundle, "types") {
        caller.require_type(id, Level::Write)?;
    }
    for edge in bundle_objects(bundle, "edge_types") {
        for key in ["id", "reverse_name"] {
            if let Some(name) = edge.get(key).and_then(Value::as_str) {
                caller.require_edge(name, Level::Write)?;
            }
        }
    }
    let guided = bundle_objects(bundle, "types").iter().any(|definition| {
        definition
            .get("guidance")
            .is_some_and(|held| !held.is_null())
    });
    if guided && caller.app_made() {
        return Err(Refusal::new(
            Code::Forbidden,
            "Installing a plugin whose types carry guidance is the owner's to do. An app, or a key an app made, can install it only without guidance.",
        )
        .with_detail("changes", vec!["guidance"]));
    }
    Ok(())
}

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

pub async fn install(
    app: &App,
    caller: &Caller,
    bundle: Obj,
    fingerprint: String,
) -> Result<(Outcome, Value)> {
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
            let plan = types::write::plan_install(
                caller,
                &catalog,
                &name,
                &definitions,
                held.as_ref().map(|held| &held.manifest),
            )?;
            edge_types::install(unit, &catalog, &bundle_objects(&bundle, "edge_types"))?;
            let before = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
            types::write::write_install(unit, &cache, &before, plan, &origin)?;
            let manifest = Value::Object(bundle.clone()).to_string();
            let by = caller.actor().to_string();
            unit.tx().execute(
                "INSERT INTO plugins (name, version, title, description, mark, maker, marfa, \
                 manifest, installed_at, installed_by, updated_at, fingerprint) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?11) \
                 ON CONFLICT (name) DO UPDATE SET version = excluded.version, \
                 title = excluded.title, description = excluded.description, \
                 mark = excluded.mark, maker = excluded.maker, marfa = excluded.marfa, \
                 manifest = excluded.manifest, updated_at = excluded.updated_at, \
                 fingerprint = excluded.fingerprint",
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
                    fingerprint,
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
                "edge_types": edge_types_held(&held, &catalog),
            },
        }))
    })
    .await
}

#[derive(Clone, Debug)]
pub struct Archived {
    pub name: String,
    line: Installed,
}

pub fn archive_lines(tx: &Transaction<'_>) -> Result<Vec<Value>> {
    Ok(rows(tx)?
        .into_iter()
        .map(|held| {
            json!({ "plugin": {
                "name": held.name,
                "version": held.version,
                "bundle": held.manifest,
                "fingerprint": held.fingerprint,
                "installed_at": held.installed_at,
                "installed_by": held.installed_by,
                "updated_at": held.updated_at,
            } })
        })
        .collect())
}

/// A sign-in as `provenance.created_by` and `installed_by` name it.
pub fn is_actor(value: &Value) -> bool {
    let Some(actor) = value.as_object() else {
        return false;
    };
    let text = |key: &str| actor.get(key).and_then(Value::as_str);
    actor.len() == 3
        && matches!(
            text("kind"),
            Some("local" | "server" | "key" | "browser" | "app")
        )
        && text("id").is_some_and(|id| !id.is_empty())
        && text("name").is_some()
}

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
    let stamped = |key: &str| {
        read(key)
            .filter(|at| Stamp::parsed(at).is_some())
            .ok_or_else(|| format!("names no {key} time in the stored form"))
    };
    let fingerprint = read("fingerprint")
        .filter(|held| plugin::is_sha256(held))
        .ok_or("names no fingerprint as a SHA-256 in lowercase hexadecimal")?;
    let installed_at = stamped("installed_at")?;
    let updated_at = stamped("updated_at")?;
    let installed_by = match line.get("installed_by") {
        Some(Value::Null) => None,
        Some(by) if is_actor(by) => Some(by.clone()),
        _ => return Err("names who installed it in no form a sign-in is named".into()),
    };
    Ok(Archived {
        name: name.clone(),
        line: Installed {
            name,
            version,
            manifest: bundle,
            fingerprint,
            installed_at,
            installed_by,
            updated_at,
        },
    })
}

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
             manifest, installed_at, installed_by, updated_at, fingerprint) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                installed.fingerprint,
            ],
        )?;
        added += 1;
    }
    Ok((added, held))
}
