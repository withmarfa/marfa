//! The owner's mapping of a plugin connector's kinds, and the rewrites the owner asks of it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, PoisonError};

use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::connector::{self, Connector, Kinds};
use marfa_rules::schema::Problem;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::access::{Caller, Level, Mapped};
use super::catalog::{self, Snapshot};
use super::connector_hosts;
use super::items::{self, reading};
use super::plugins::{self, Installed};
use super::refusal::{Code, Refusal, Result};

fn no_connector(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginConnectorNotFound,
        format!("Plugin {name} has no connector."),
    )
    .with_detail("name", name)
}

fn not_installed(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginNotFound,
        format!("No plugin named {name} is installed."),
    )
    .with_detail("name", name)
}

fn invalid(problems: &[Problem]) -> Refusal {
    let named: Vec<&str> = problems
        .iter()
        .map(|problem| problem.path.as_str())
        .collect();
    Refusal::validation(format!(
        "The mapping cannot be saved: {}.",
        named.join(", ")
    ))
    .with_detail(
        "errors",
        problems
            .iter()
            .map(|problem| json!({ "path": problem.path, "message": problem.message }))
            .collect::<Vec<_>>(),
    )
}

fn stale(version: i64) -> Refusal {
    Refusal::new(
        Code::ConnectorMappingStale,
        format!("The mapping is at version {version}. Read it again and send that version."),
    )
    .with_detail("version", version)
}

/// The installed plugin and its connector, as the caller may learn of them.
fn connector_for(
    tx: &Transaction<'_>,
    caller: &Caller,
    name: &str,
    own_key_reads: bool,
) -> Result<(Installed, Connector)> {
    let held = plugins::find(tx, name)?;
    let connector = held
        .as_ref()
        .and_then(|installed| connector::connector_of(&installed.manifest));
    let source = connector
        .as_ref()
        .map(|connector| connector.source.as_str());
    if own_key_reads {
        caller.require_mapping_reader(source)?;
    } else {
        caller.require(super::access::Permission::ConnectorsManage)?;
    }
    let installed = held.ok_or_else(|| not_installed(name))?;
    let connector = connector.ok_or_else(|| no_connector(name))?;
    Ok((installed, connector))
}

struct Saved {
    version: i64,
    kinds: Kinds,
}

fn saved(tx: &Transaction<'_>, plugin: &str) -> Result<Option<Saved>> {
    let held: Option<(i64, String)> = tx
        .query_row(
            "SELECT version, kinds FROM connector_mappings WHERE plugin = ?1",
            [plugin],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    held.map(|(version, text)| {
        serde_json::from_str::<Value>(&text)
            .ok()
            .as_ref()
            .and_then(connector::stored)
            .map(|kinds| Saved { version, kinds })
            .ok_or_else(|| {
                Refusal::unread(&format!(
                    "the stored mapping of plugin {plugin} does not read"
                ))
            })
    })
    .transpose()
}

/// The types each kind was mapped onto before, by kind.
fn former_targets(tx: &Transaction<'_>, plugin: &str) -> Result<BTreeMap<String, Vec<String>>> {
    let mut statement = tx.prepare_cached(
        "SELECT kind, type_id FROM connector_former_targets WHERE plugin = ?1 \
         ORDER BY kind, type_id",
    )?;
    let found = statement.query_map([plugin], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut former: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for held in found {
        let (kind, type_id) = held?;
        former.entry(kind).or_default().push(type_id);
    }
    Ok(former)
}

/// Each type a rewrite moves a kind's items from: its own type and the types it was mapped onto
/// before, other than its target.
fn moves_from(
    connector: &Connector,
    kinds: &Kinds,
    former: &BTreeMap<String, Vec<String>>,
    kind: &str,
) -> Vec<String> {
    let (Some(own), Some(entry)) = (connector.kind(kind), kinds.get(kind)) else {
        return Vec::new();
    };
    std::iter::once(&own.own_type)
        .chain(former.get(kind).into_iter().flatten())
        .filter(|type_id| **type_id != entry.target_type)
        .cloned()
        .collect()
}

/// The kinds each open rewrite names, oldest first. A request that does not read names none.
fn rewrite_kinds_of(tx: &Transaction<'_>, plugin: &str) -> Result<Vec<Option<Vec<String>>>> {
    let mut statement = tx
        .prepare_cached("SELECT kinds FROM connector_rewrites WHERE plugin = ?1 ORDER BY number")?;
    let found = statement.query_map([plugin], |row| row.get::<_, String>(0))?;
    let mut held = Vec::new();
    for kinds in found {
        held.push(serde_json::from_str::<Vec<String>>(&kinds?).ok());
    }
    Ok(held)
}

/// The rewrites asked of the plugin's connector that it has not cleared, oldest first.
fn rewrites_of(
    tx: &Transaction<'_>,
    plugin: &str,
    connector: &Connector,
    kinds: &Kinds,
) -> Result<Vec<Value>> {
    let former = former_targets(tx, plugin)?;
    let mut statement = tx.prepare_cached(
        "SELECT number, version, kinds, requested_at FROM connector_rewrites \
         WHERE plugin = ?1 ORDER BY number",
    )?;
    let found = statement.query_map([plugin], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut pending = Vec::new();
    for held in found {
        let (number, version, text, requested_at) = held?;
        let named: Vec<String> = serde_json::from_str(&text).map_err(|_| {
            Refusal::internal(&format!(
                "rewrite {number} asked of plugin {plugin} does not read"
            ))
        })?;
        let from: serde_json::Map<String, Value> = named
            .iter()
            .map(|kind| {
                (
                    kind.clone(),
                    json!(moves_from(connector, kinds, &former, kind)),
                )
            })
            .collect();
        pending.push(json!({
            "number": number,
            "version": version,
            "kinds": named,
            "from": from,
            "requested_at": requested_at,
        }));
    }
    Ok(pending)
}

fn answered(
    tx: &Transaction<'_>,
    plugin: &str,
    connector: &Connector,
    rules: &Rules,
) -> Result<Value> {
    let held = saved(tx, plugin)?;
    let kinds = connector::in_force(
        held.as_ref().map(|held| &held.kinds),
        connector,
        Some(rules),
    );
    Ok(json!({
        "version": held.as_ref().map_or(0, |held| held.version),
        "kinds": connector::kinds_json(&kinds),
        "rewrites": rewrites_of(tx, plugin, connector, &kinds)?,
    }))
}

/// The saved mapping's version, 0 with none saved, and how many rewrites wait on the connector.
pub(crate) fn standing(tx: &Transaction<'_>, plugin: &str) -> Result<(i64, i64)> {
    let version: Option<i64> = tx
        .prepare_cached("SELECT version FROM connector_mappings WHERE plugin = ?1")?
        .query_row([plugin], |row| row.get(0))
        .optional()?;
    let rewrites: i64 = tx
        .prepare_cached("SELECT count(*) FROM connector_rewrites WHERE plugin = ?1")?
        .query_row([plugin], |row| row.get(0))?;
    Ok((version.unwrap_or(0), rewrites))
}

/// The `target_type` of `kind` in the mapping in force, or `None` for a kind the connector lacks.
pub(crate) fn target_of(
    tx: &Transaction<'_>,
    plugin: &str,
    connector: &Connector,
    kind: &str,
) -> Result<Option<String>> {
    let held = saved(tx, plugin)?;
    let kinds = connector::in_force(held.as_ref().map(|held| &held.kinds), connector, None);
    Ok(kinds.get(kind).map(|entry| entry.target_type.clone()))
}

static REPORTED: Mutex<BTreeSet<(String, &'static str)>> = Mutex::new(BTreeSet::new());

/// Logs once per plugin that its connector or mapping does not read, so its key reaches nothing
/// through the mapping.
fn unread(plugin: &str, what: &'static str) {
    let first = REPORTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert((plugin.to_string(), what));
    if first {
        tracing::error!(
            plugin,
            what,
            "A plugin's stored connector or mapping does not read, so its key reaches nothing through the mapping"
        );
    }
}

/// What the key holding `source` reaches through a plugin's mapping, where a plugin's connector
/// holds the source. A connector or mapping that does not read reaches nothing beyond the key's
/// type map, and the key stays a plugin's connector key.
pub fn reach(tx: &Transaction<'_>, source: &str) -> Result<Option<Mapped>> {
    let Some(plugin) = connector_hosts::plugin_holding(tx, source)? else {
        return Ok(None);
    };
    let connector = plugins::find(tx, &plugin)?
        .and_then(|installed| connector::connector_of(&installed.manifest))
        .filter(|connector| connector.source == source);
    let Some(connector) = connector else {
        unread(&plugin, "connector");
        return Ok(Some(Mapped::default()));
    };
    let held = match saved(tx, &plugin) {
        Ok(held) => held,
        Err(refused) if refused.unread => {
            unread(&plugin, "mapping");
            return Ok(Some(Mapped::default()));
        }
        Err(refused) => return Err(refused),
    };
    let kinds = connector::in_force(held.as_ref().map(|held| &held.kinds), &connector, None);
    let mut mapped = Mapped::of(&kinds, &connector);
    let former = former_targets(tx, &plugin)?;
    for named in rewrite_kinds_of(tx, &plugin)? {
        let Some(named) = named else {
            unread(&plugin, "rewrite");
            continue;
        };
        for kind in &named {
            let Some(entry) = kinds.get(kind).filter(|entry| entry.enabled) else {
                continue;
            };
            if is_system(&entry.target_type) {
                continue;
            }
            for from in former.get(kind).into_iter().flatten() {
                if *from != entry.target_type && !is_system(from) {
                    mapped.returning(from.clone(), entry.target_type.clone());
                }
            }
        }
    }
    Ok(Some(mapped))
}

fn is_system(type_id: &str) -> bool {
    type_id.split('.').next() == Some("system")
}

/// Keeps, for each kind whose target a save moves, the type it leaves, unless it is one of the
/// connector's own types, which the key's type map alone decides.
fn record_former_targets(
    tx: &Transaction<'_>,
    plugin: &str,
    connector: &Connector,
    before: &Kinds,
    after: &Kinds,
) -> Result<()> {
    for kind in &connector.kinds {
        let (Some(was), Some(now)) = (before.get(&kind.name), after.get(&kind.name)) else {
            continue;
        };
        tx.prepare_cached(
            "DELETE FROM connector_former_targets WHERE plugin = ?1 AND kind = ?2 AND type_id = ?3",
        )?
        .execute(params![plugin, kind.name, now.target_type])?;
        let own = connector
            .kinds
            .iter()
            .any(|held| held.own_type == was.target_type);
        if was.target_type != now.target_type && !own {
            tx.prepare_cached(
                "INSERT OR IGNORE INTO connector_former_targets (plugin, kind, type_id) \
                 VALUES (?1, ?2, ?3)",
            )?
            .execute(params![plugin, kind.name, was.target_type])?;
        }
    }
    Ok(())
}

pub async fn read(app: &App, caller: &Caller, name: String) -> Result<Value> {
    reading(app, caller, move |read| {
        let (installed, connector) = connector_for(read.tx, &read.caller, &name, true)?;
        answered(read.tx, &installed.name, &connector, &read.catalog.rules)
    })
    .await
}

pub async fn save(app: &App, caller: &Caller, name: String, body: Value) -> Result<Value> {
    let cache = app.catalog_handle();
    app.write(caller, "connector.mapping_change", move |unit| {
        let caller = &unit.caller;
        let (installed, connector) = connector_for(unit.tx(), caller, &name, false)?;
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let rules = &catalog.rules;
        let (version, kinds) = connector::read_body(&body, &connector, rules)
            .map_err(|problems| invalid(&problems))?;
        let problems = connector::judge(&kinds, &connector, rules, |target| {
            caller.require_type(target, Level::Write).is_ok()
        });
        if !problems.is_empty() {
            return Err(invalid(&problems));
        }
        let held = saved(unit.tx(), &installed.name)?;
        let current = held.as_ref().map_or(0, |held| held.version);
        if version != current {
            return Err(stale(current));
        }
        let before = connector::in_force(held.as_ref().map(|held| &held.kinds), &connector, None);
        record_former_targets(unit.tx(), &installed.name, &connector, &before, &kinds)?;
        let next = current + 1;
        unit.tx().execute(
            "INSERT INTO connector_mappings (plugin, version, kinds, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (plugin) DO UPDATE SET version = excluded.version, \
             kinds = excluded.kinds, updated_at = excluded.updated_at",
            params![
                installed.name,
                next,
                connector::kinds_json(&kinds).to_string(),
                unit.at
            ],
        )?;
        unit.audit("plugin", &installed.name, Some(json!({ "version": next })))?;
        answered(unit.tx(), &installed.name, &connector, rules)
    })
    .await
}

fn rewrite_kinds(
    body: &Value,
    connector: &Connector,
    kinds: &Kinds,
) -> Result<(bool, Vec<String>)> {
    let mut problems = Vec::new();
    let problem = |path: String, message: &str| Problem {
        path,
        code: "invalid",
        message: message.to_string(),
        hint: None,
    };
    let held = match body {
        Value::Object(held) => held.clone(),
        Value::Null => serde_json::Map::new(),
        _ => return Err(invalid(&[problem(String::new(), "Must be an object.")])),
    };
    for member in held.keys() {
        if member != "dry_run" && member != "kinds" {
            problems.push(problem(member.clone(), "Is not a member of a rewrite."));
        }
    }
    let dry_run = match held.get("dry_run") {
        None => false,
        Some(Value::Bool(dry_run)) => *dry_run,
        Some(_) => {
            problems.push(problem("dry_run".into(), "Must be true or false."));
            false
        }
    };
    let named = match held.get("kinds") {
        None => kinds
            .iter()
            .filter(|(_, entry)| entry.enabled)
            .map(|(name, _)| name.clone())
            .collect(),
        Some(Value::Array(named)) => {
            let mut read = Vec::new();
            for (at, name) in named.iter().enumerate() {
                match name.as_str().filter(|name| connector.kind(name).is_some()) {
                    Some(name) if !read.iter().any(|held: &String| held == name) => {
                        read.push(name.to_string());
                    }
                    Some(_) => {}
                    None => problems.push(problem(
                        format!("kinds.{at}"),
                        "Is not a kind this connector brings.",
                    )),
                }
            }
            read
        }
        Some(_) => {
            problems.push(problem("kinds".into(), "Must be a list of kinds."));
            Vec::new()
        }
    };
    if problems.is_empty() {
        Ok((dry_run, named))
    } else {
        Err(invalid(&problems))
    }
}

pub async fn rewrite(app: &App, caller: &Caller, name: String, body: Value) -> Result<Value> {
    let cache = app.catalog_handle();
    app.write(caller, "connector.rewrite_request", move |unit| {
        let (installed, connector) = connector_for(unit.tx(), &unit.caller, &name, false)?;
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let held = saved(unit.tx(), &installed.name)?;
        let version = held.as_ref().map_or(0, |held| held.version);
        let kinds = connector::in_force(
            held.as_ref().map(|held| &held.kinds),
            &connector,
            Some(&catalog.rules),
        );
        let (dry_run, named) = rewrite_kinds(&body, &connector, &kinds)?;
        let former = former_targets(unit.tx(), &installed.name)?;
        let mut counted = serde_json::Map::new();
        for kind in &named {
            let Some(entry) = kinds.get(kind) else {
                continue;
            };
            let mut count = 0;
            for from in moves_from(&connector, &kinds, &former, kind) {
                count += items::count_outside_bin(unit.tx(), &from, &connector.source)?;
            }
            counted.insert(
                kind.clone(),
                json!({ "target_type": entry.target_type, "count": count }),
            );
        }
        if dry_run {
            return Ok(json!({ "dry_run": true, "version": version, "kinds": counted }));
        }
        let number: i64 = unit.tx().query_row(
            "INSERT INTO connector_rewrites (plugin, version, kinds, requested_at) \
             VALUES (?1, ?2, ?3, ?4) RETURNING number",
            params![installed.name, version, json!(named).to_string(), unit.at],
            |row| row.get(0),
        )?;
        unit.audit(
            "plugin",
            &installed.name,
            Some(json!({ "version": version, "number": number })),
        )?;
        Ok(json!({ "dry_run": false, "number": number, "version": version, "kinds": counted }))
    })
    .await
}

/// The number of the rewrite a `rewrite/done` body says the connector carried out.
fn done_number(body: &Value) -> Result<i64> {
    let problem = |path: &str, message: &str| Problem {
        path: path.to_string(),
        code: "invalid",
        message: message.to_string(),
        hint: None,
    };
    let Some(held) = body.as_object() else {
        return Err(invalid(&[problem("", "Must be an object holding number.")]));
    };
    let mut problems: Vec<Problem> = held
        .keys()
        .filter(|member| *member != "number")
        .map(|member| problem(member, "Is not a member of a finished rewrite."))
        .collect();
    let number = held
        .get("number")
        .and_then(Value::as_i64)
        .filter(|number| *number >= 1);
    if number.is_none() {
        problems.push(problem(
            "number",
            "Must be the number of the rewrite carried out.",
        ));
    }
    match number {
        Some(number) if problems.is_empty() => Ok(number),
        _ => Err(invalid(&problems)),
    }
}

pub async fn rewrite_done(app: &App, caller: &Caller, name: String, body: Value) -> Result<Value> {
    app.write(caller, "connector.rewrite_done", move |unit| {
        let held = plugins::find(unit.tx(), &name)?;
        let connector = held
            .as_ref()
            .and_then(|installed| connector::connector_of(&installed.manifest));
        let source = connector
            .as_ref()
            .map_or("", |connector| connector.source.as_str());
        unit.caller.require_connector_source(source)?;
        if held.is_none() {
            return Err(not_installed(&name));
        }
        let Some(connector) = connector else {
            return Err(no_connector(&name));
        };
        let number = done_number(&body)?;
        let cleared = unit.tx().execute(
            "DELETE FROM connector_rewrites WHERE plugin = ?1 AND number = ?2",
            params![name, number],
        )?;
        if cleared > 0 {
            unit.audit("plugin", &name, Some(json!({ "number": number })))?;
        }
        let held = saved(unit.tx(), &name)?;
        let kinds = connector::in_force(held.as_ref().map(|held| &held.kinds), &connector, None);
        Ok(json!({ "rewrites": rewrites_of(unit.tx(), &name, &connector, &kinds)? }))
    })
    .await
}

/// One line per saved mapping of an installed plugin.
pub fn archive_lines(tx: &Transaction<'_>) -> Result<Vec<Value>> {
    let mut statement =
        tx.prepare_cached("SELECT plugin, version, kinds FROM connector_mappings ORDER BY plugin")?;
    let found = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut lines = Vec::new();
    for held in found {
        let (plugin, version, text) = held?;
        let kinds: Value = serde_json::from_str(&text).map_err(|_| {
            Refusal::internal(&format!(
                "the stored mapping of plugin {plugin} does not read"
            ))
        })?;
        lines.push(json!({ "connector_mapping": {
            "plugin": plugin,
            "version": version,
            "kinds": kinds,
        } }));
    }
    Ok(lines)
}

#[derive(Clone, Debug)]
pub struct Archived {
    pub plugin: String,
    version: i64,
    kinds: Value,
    /// Its line in `instance.ndjson.gz`.
    line: usize,
}

pub fn archived(body: &Value, line: usize) -> std::result::Result<Archived, String> {
    let held = body.as_object().ok_or("is not an object")?;
    let plugin = held
        .get("plugin")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or("names no plugin")?;
    let version = held
        .get("version")
        .and_then(Value::as_i64)
        .filter(|version| *version >= 1)
        .ok_or("names no version as a whole number from 1")?;
    let kinds = held
        .get("kinds")
        .filter(|kinds| connector::stored(kinds).is_some())
        .ok_or("holds kinds that do not read as a mapping")?;
    Ok(Archived {
        plugin: plugin.to_string(),
        version,
        kinds: kinds.clone(),
        line,
    })
}

fn refused_line(line: &Archived, message: String) -> Refusal {
    Refusal::validation(message)
        .with_detail("entry", "instance.ndjson.gz")
        .with_detail("line", line.line)
        .with_detail("plugin", line.plugin.as_str())
}

/// Stores each archived mapping whose plugin the instance holds and has none saved for, judged as
/// a save judges it, against the types as restored and the restoring caller's write.
pub fn restore(
    tx: &Transaction<'_>,
    archived: &[Archived],
    at: &str,
    caller: &Caller,
    rules: &Rules,
) -> Result<(usize, usize)> {
    let (mut added, mut held) = (0, 0);
    for line in archived {
        let Some(installed) = plugins::find(tx, &line.plugin)? else {
            return Err(refused_line(
                line,
                format!(
                    "Line {} of the archive holds a mapping for plugin {}, which neither the archive nor the instance holds.",
                    line.line, line.plugin
                ),
            ));
        };
        let Some(connector) = connector::connector_of(&installed.manifest) else {
            return Err(refused_line(
                line,
                format!(
                    "Line {} of the archive holds a mapping for plugin {}, which has no connector.",
                    line.line, line.plugin
                ),
            ));
        };
        if saved(tx, &line.plugin)?.is_some() {
            held += 1;
            continue;
        }
        let body = json!({ "version": line.version, "kinds": line.kinds });
        let judged = connector::read_body(&body, &connector, rules).and_then(|(_, kinds)| {
            let problems = connector::judge(&kinds, &connector, rules, |target| {
                caller.require_type(target, Level::Write).is_ok()
            });
            if problems.is_empty() {
                Ok(kinds)
            } else {
                Err(problems)
            }
        });
        let kinds = judged.map_err(|problems| {
            let named: Vec<&str> = problems.iter().map(|problem| problem.path.as_str()).collect();
            refused_line(
                line,
                format!(
                    "Line {} of the archive holds a mapping for plugin {} that this instance would not save: {}.",
                    line.line,
                    line.plugin,
                    named.join(", ")
                ),
            )
            .with_detail(
                "errors",
                problems
                    .iter()
                    .map(|problem| json!({ "path": problem.path, "message": problem.message }))
                    .collect::<Vec<_>>(),
            )
        })?;
        tx.execute(
            "INSERT INTO connector_mappings (plugin, version, kinds, updated_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                line.plugin,
                line.version,
                connector::kinds_json(&kinds).to_string(),
                at
            ],
        )?;
        added += 1;
    }
    Ok((added, held))
}
