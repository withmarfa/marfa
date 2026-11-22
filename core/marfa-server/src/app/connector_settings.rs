//! The value set for each setting a plugin's connector declares. A secret's value is sealed to
//! the setting and to the one install of the connector, and only the connector's own key reads
//! it opened.

use std::collections::HashMap;
use std::sync::Arc;

use marfa_rules::plugin_connector::{self, Kind, Setting};
use rusqlite::{Transaction, params};
use serde_json::{Map, Value, json};

use super::App;
use super::access::{Caller, Permission};
use super::connector_hosts::{self, Record};
use super::connectors;
use super::faults::HOLD_CONNECTOR_SETTINGS;
use super::plugins;
use super::refusal::{Code, Refusal, Result};
use crate::settings::sealed::{Sealer, Secret};

pub const CHANGED: &str = "connector.settings_change";
/// What a restore stores for a secret the archive names: no value this or any key opens.
const SET_AGAIN: &str = "set-again";

fn plugin_not_found(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginNotFound,
        format!("No plugin named {name} is installed."),
    )
    .with_detail("name", name)
}

fn no_connector(name: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorNotFound,
        format!("Plugin {name} has no connector."),
    )
    .with_detail("plugin", name)
}

fn no_plugin_connector() -> Refusal {
    Refusal::new(
        Code::ConnectorNotFound,
        "This registration's key is no plugin's connector key, so it has no settings.",
    )
}

/// The sealing name: one install of one plugin's connector and one setting.
fn sealed_as(install: &str, setting: &str) -> String {
    format!("connector:{install}:{setting}")
}

/// A plugin's connector with the settings its installed version declares and the rows set.
struct Held {
    plugin: String,
    install: String,
    declared: Vec<Setting>,
    rows: HashMap<String, String>,
}

fn declared_of(installed: &plugins::Installed) -> Result<Vec<Setting>> {
    let section = installed
        .manifest
        .get("connector")
        .and_then(Value::as_object)
        .ok_or_else(|| Refusal::internal("a recorded connector's plugin has no connector"))?;
    plugin_connector::settings(section).ok_or_else(|| {
        Refusal::internal(&format!(
            "the stored connector settings of plugin {} do not read",
            installed.name
        ))
    })
}

fn install_of(record: &Record) -> Result<String> {
    record.id.clone().ok_or_else(|| {
        Refusal::internal(&format!(
            "the connector of plugin {} records no install",
            record.plugin
        ))
    })
}

fn rows(tx: &Transaction<'_>, plugin: &str) -> Result<HashMap<String, String>> {
    let mut statement = tx.prepare_cached(
        "SELECT name, value FROM plugin_connector_settings WHERE plugin = ?1",
    )?;
    let rows = statement.query_map([plugin], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn held_of(tx: &Transaction<'_>, record: &Record) -> Result<Held> {
    let installed = plugins::installed(tx, &record.plugin)?
        .ok_or_else(|| Refusal::internal("a plugin's connector outlived its plugin"))?;
    Ok(Held {
        plugin: record.plugin.clone(),
        install: install_of(record)?,
        declared: declared_of(&installed)?,
        rows: rows(tx, &record.plugin)?,
    })
}

fn held(tx: &Transaction<'_>, plugin: &str) -> Result<Held> {
    if plugins::installed(tx, plugin)?.is_none() {
        return Err(plugin_not_found(plugin));
    }
    let record = connector_hosts::record(tx, plugin)?.ok_or_else(|| no_connector(plugin))?;
    held_of(tx, &record)
}

/// What one setting holds now.
enum Now {
    Unset,
    Plain(Value),
    Opened(Secret),
    Unreadable,
}

impl Held {
    fn now(&self, setting: &Setting, sealer: &Sealer) -> Result<Now> {
        let Some(text) = self.rows.get(&setting.name) else {
            return Ok(Now::Unset);
        };
        if setting.secret {
            return Ok(
                match sealer.open(&sealed_as(&self.install, &setting.name), text) {
                    Some(secret) => Now::Opened(secret),
                    None => Now::Unreadable,
                },
            );
        }
        serde_json::from_str(text).map(Now::Plain).map_err(|_| {
            Refusal::internal(&format!(
                "the stored value of setting {} of plugin {} does not read",
                setting.name, self.plugin
            ))
        })
    }

    /// Each required setting with no value the server can read and no default.
    fn missing(&self, sealer: &Sealer) -> Result<Vec<String>> {
        let mut missing = Vec::new();
        for setting in &self.declared {
            let readable = matches!(
                self.now(setting, sealer)?,
                Now::Plain(_) | Now::Opened(_)
            );
            if setting.required && !readable && setting.default.is_none() {
                missing.push(setting.name.clone());
            }
        }
        Ok(missing)
    }

    /// As the owner and the apps they approve are answered: never a secret's value.
    fn for_owner(&self, sealer: &Sealer) -> Result<Value> {
        let mut settings = Vec::new();
        for setting in &self.declared {
            let now = self.now(setting, sealer)?;
            let default = if setting.secret {
                Value::Null
            } else {
                setting.default.clone().unwrap_or(Value::Null)
            };
            let value = match &now {
                Now::Plain(value) => value.clone(),
                _ => default.clone(),
            };
            settings.push(json!({
                "name": setting.name,
                "label": setting.label,
                "kind": setting.kind.word(),
                "choices": (setting.kind == Kind::Choice).then(|| setting.choices.clone()),
                "secret": setting.secret,
                "required": setting.required,
                "default": default,
                "value": value,
                "set": matches!(now, Now::Plain(_) | Now::Opened(_)),
                "unreadable": matches!(now, Now::Unreadable),
            }));
        }
        Ok(json!({
            "plugin": self.plugin,
            "settings": settings,
            "missing": self.missing(sealer)?,
        }))
    }

    /// As the connector's own key is answered: every secret it can open, opened.
    fn for_connector(&self, sealer: &Sealer) -> Result<Value> {
        let mut settings = Vec::new();
        for setting in &self.declared {
            let now = self.now(setting, sealer)?;
            let value = match &now {
                Now::Plain(value) => value.clone(),
                Now::Opened(secret) => serde_json::from_str(secret.expose()).map_err(|_| {
                    Refusal::internal(&format!(
                        "an opened secret of plugin {} does not read",
                        self.plugin
                    ))
                })?,
                Now::Unset if !setting.secret => setting.default.clone().unwrap_or(Value::Null),
                Now::Unset | Now::Unreadable => Value::Null,
            };
            settings.push(json!({
                "name": setting.name,
                "kind": setting.kind.word(),
                "secret": setting.secret,
                "required": setting.required,
                "value": value,
                "set": matches!(now, Now::Plain(_) | Now::Opened(_)),
                "unreadable": matches!(now, Now::Unreadable),
            }));
        }
        Ok(json!({
            "plugin": self.plugin,
            "settings": settings,
            "missing": self.missing(sealer)?,
        }))
    }
}

fn store(tx: &Transaction<'_>, plugin: &str, name: &str, text: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO plugin_connector_settings (plugin, name, value, updated_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT (plugin, name) DO UPDATE SET \
         value = excluded.value, updated_at = excluded.updated_at",
        params![plugin, name, text, at],
    )?;
    Ok(())
}

fn clear(tx: &Transaction<'_>, plugin: &str, name: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM plugin_connector_settings WHERE plugin = ?1 AND name = ?2",
        params![plugin, name],
    )?;
    Ok(())
}

fn refused(errors: Vec<Value>) -> Refusal {
    Refusal::validation("Some settings were refused; nothing was stored.").with_detail("errors", errors)
}

/// The managing permission, judged before the body is read.
pub fn require_manager(caller: &Caller) -> Result<()> {
    caller.require(Permission::ConnectorsManage)
}

pub async fn list(app: &App, caller: &Caller, plugin: String) -> Result<Value> {
    let sealer = app.settings.shared_sealer();
    connectors::reading(app, caller, move |tx, caller, _| {
        caller.require(Permission::ConnectorsManage)?;
        held(tx, &plugin)?.for_owner(&sealer)
    })
    .await
}

pub async fn set(
    app: &App,
    caller: &Caller,
    plugin: String,
    changes: Map<String, Value>,
) -> Result<Value> {
    let sealer = app.settings.shared_sealer();
    app.write(caller, CHANGED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        let tx = unit.tx();
        let held = held(tx, &plugin)?;
        let unknown: Vec<Value> = changes
            .keys()
            .filter(|name| !held.declared.iter().any(|setting| &setting.name == *name))
            .map(|name| json!({ "path": name, "message": format!("{plugin}'s connector declares no setting {name}") }))
            .collect();
        if !unknown.is_empty() {
            return Err(refused(unknown));
        }
        let wrong: Vec<Value> = held
            .declared
            .iter()
            .filter_map(|setting| {
                let value = changes.get(&setting.name).filter(|value| !value.is_null())?;
                let why = setting.refuses(value)?;
                Some(json!({ "path": setting.name, "message": why }))
            })
            .collect();
        if !wrong.is_empty() {
            return Err(refused(wrong));
        }
        let mut written = Vec::new();
        for setting in &held.declared {
            let Some(value) = changes.get(&setting.name) else {
                continue;
            };
            match value {
                Value::Null => clear(tx, &plugin, &setting.name)?,
                value if setting.secret => {
                    let sealed = sealer
                        .seal(
                            &sealed_as(&held.install, &setting.name),
                            &Secret::new(value.to_string()),
                        )
                        .ok_or_else(|| Refusal::internal("a connector's secret could not be sealed"))?;
                    store(tx, &plugin, &setting.name, &sealed, &unit.at)?;
                }
                value => store(tx, &plugin, &setting.name, &value.to_string(), &unit.at)?,
            }
            written.push(setting.name.clone());
        }
        if !written.is_empty() {
            unit.audit("plugin", &plugin, Some(json!({ "settings": written })))?;
        }
        Held {
            rows: rows(tx, &plugin)?,
            ..held
        }
        .for_owner(&sealer)
    })
    .await
}

/// The settings of the plugin connector whose host minted the key `registration` was made
/// under, answered to that key alone.
pub async fn own(app: &App, caller: &Caller, registration: String) -> Result<Value> {
    app.faults.hold(HOLD_CONNECTOR_SETTINGS, None).await;
    let sealer = app.settings.shared_sealer();
    connectors::reading(app, caller, move |tx, caller, _| {
        let found = connectors::find(tx, &registration)?;
        caller.require_own_connector_key(&found.key_id)?;
        let record =
            connector_hosts::record_of_key(tx, &found.key_id)?.ok_or_else(no_plugin_connector)?;
        held_of(tx, &record)?.for_connector(&sealer)
    })
    .await
}

/// Keeps, through a newer version of the plugin, each value whose setting keeps its kind,
/// secrecy and choice, and removes the rest.
pub(crate) fn follow_update(
    tx: &Transaction<'_>,
    plugin: &str,
    before: &plugins::Installed,
    after: &plugins::Installed,
) -> Result<()> {
    let earlier = declared_of(before)?;
    let later = declared_of(after)?;
    for (name, text) in rows(tx, plugin)? {
        let kept = later.iter().find(|setting| setting.name == name).is_some_and(|setting| {
            earlier
                .iter()
                .find(|old| old.name == name)
                .is_some_and(|old| {
                    let value = (!old.secret)
                        .then(|| serde_json::from_str::<Value>(&text).ok())
                        .flatten();
                    setting.keeps(old, value.as_ref())
                })
        });
        if !kept {
            clear(tx, plugin, &name)?;
        }
    }
    Ok(())
}

/// The `connector_setting` lines of an archive: each value set, and each secret named alone.
pub(crate) fn archive_lines(tx: &Transaction<'_>) -> Result<Vec<Value>> {
    let mut lines = Vec::new();
    for record in connector_hosts::records(tx)? {
        let held = held_of(tx, &record)?;
        for setting in &held.declared {
            let Some(text) = held.rows.get(&setting.name) else {
                continue;
            };
            let body = if setting.secret {
                json!({ "plugin": held.plugin, "name": setting.name, "secret": true })
            } else {
                let value: Value = serde_json::from_str(text).map_err(|_| {
                    Refusal::internal(&format!(
                        "the stored value of setting {} of plugin {} does not read",
                        setting.name, held.plugin
                    ))
                })?;
                json!({ "plugin": held.plugin, "name": setting.name, "value": value })
            };
            lines.push(json!({ "connector_setting": body }));
        }
    }
    Ok(lines)
}

/// One `connector_setting` line of an archive.
#[derive(Clone, Debug)]
pub struct Archived {
    pub plugin: String,
    pub name: String,
    /// `None` for a secret, which the archive names without its value.
    pub value: Option<Value>,
}

/// Reads a line's body, or says what is wrong with it.
pub fn archived(body: &Value) -> std::result::Result<Archived, &'static str> {
    let object = body.as_object().ok_or("is not an object")?;
    let plugin = object
        .get("plugin")
        .and_then(Value::as_str)
        .filter(|name| marfa_rules::plugin::is_name(name))
        .ok_or("names no plugin")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| plugin_connector::is_identifier(name))
        .ok_or("names no setting")?;
    let value = match (object.get("value"), object.get("secret")) {
        (Some(value), None) if !value.is_null() => Some(value.clone()),
        (None, Some(Value::Bool(true))) => None,
        _ => return Err("holds neither a value nor secret true"),
    };
    Ok(Archived {
        plugin: plugin.to_string(),
        name: name.to_string(),
        value,
    })
}

/// Stores the archived settings of each plugin the restore recorded anew, and answers each
/// secret it names, which this machine holds no value for, to be set again.
pub(crate) fn restore(
    tx: &Transaction<'_>,
    archived: &[Archived],
    recorded: &[String],
    at: &str,
) -> Result<Vec<Value>> {
    let mut to_set = Vec::new();
    let mut declared: HashMap<&str, Option<Vec<Setting>>> = HashMap::new();
    for line in archived {
        if !recorded.contains(&line.plugin) {
            continue;
        }
        if !declared.contains_key(line.plugin.as_str()) {
            let settings = match connector_hosts::record(tx, &line.plugin)? {
                Some(record) => Some(held_of(tx, &record)?.declared),
                None => None,
            };
            declared.insert(line.plugin.as_str(), settings);
        }
        let Some(setting) = declared
            .get(line.plugin.as_str())
            .and_then(Option::as_ref)
            .and_then(|settings| settings.iter().find(|setting| setting.name == line.name))
        else {
            continue;
        };
        match (&line.value, setting.secret) {
            (None, true) => {
                store(tx, &line.plugin, &line.name, SET_AGAIN, at)?;
                to_set.push(json!({ "plugin": line.plugin, "name": line.name }));
            }
            (Some(value), false) if setting.refuses(value).is_none() => {
                store(tx, &line.plugin, &line.name, &value.to_string(), at)?;
            }
            _ => {}
        }
    }
    Ok(to_set)
}

/// Each plugin and secret setting of its connector whose stored value the server cannot open.
pub(crate) async fn unreadable(app: &Arc<App>) -> Result<Vec<(String, String)>> {
    let sealer = app.settings.shared_sealer();
    app.db
        .read(move |tx| {
            let mut found = Vec::new();
            for record in connector_hosts::records(tx)? {
                let held = held_of(tx, &record)?;
                for setting in held.declared.iter().filter(|setting| setting.secret) {
                    if matches!(held.now(setting, &sealer)?, Now::Unreadable) {
                        found.push((held.plugin.clone(), setting.name.clone()));
                    }
                }
            }
            Ok(found)
        })
        .await
}
