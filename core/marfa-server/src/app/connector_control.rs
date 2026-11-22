//! What the owner asks of a plugin's connector. The server stores it; the connector acts on it.

use marfa_rules::connector::{self, Connector};
use marfa_rules::schema::Problem;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

use super::App;
use super::access::{Caller, Level, Permission};
use super::catalog::{self, Snapshot};
use super::clock::Stamp;
use super::connector_hosts::{self, Record};
use super::connectors;
use super::items;
use super::mapping;
use super::plugins;
use super::refusal::{Code, Refusal, Result};

pub const PREVIEW_LIFE_MS: i64 = 10 * 60 * 1000;
pub const PENDING_CAP: i64 = 20;
/// The longest `result` a connector may answer, in bytes written as JSON.
pub const RESULT_CAP: usize = 65_536;
pub const ERROR_CAP: usize = 500;
pub const PAUSED: &str = "connector.pause";
pub const RESUMED: &str = "connector.resume";
pub const RUN_REQUESTED: &str = "connector.run_request";
const PREVIEW_REQUESTED: &str = "connector.preview_request";
const PREVIEW_ANSWERED: &str = "connector.preview_answer";
const STATUSES: [&str; 3] = ["pending", "ready", "failed"];

fn not_installed(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginNotFound,
        format!("No plugin named {name} is installed."),
    )
    .with_detail("name", name)
}

fn no_connector(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginConnectorNotFound,
        format!("Plugin {name} has no connector."),
    )
    .with_detail("name", name)
}

fn paused_refusal(name: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorPaused,
        format!("The connector of plugin {name} is paused. Resume it, then ask it to run."),
    )
    .with_detail("plugin", name)
}

fn preview_not_found(id: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorPreviewNotFound,
        format!("The plugin holds no mapping preview {id}, or it has expired."),
    )
    .with_detail("id", id)
}

fn invalid(what: &str, problems: &[Problem]) -> Refusal {
    let named: Vec<&str> = problems
        .iter()
        .map(|problem| problem.path.as_str())
        .collect();
    Refusal::validation(format!("{what}: {}.", named.join(", "))).with_detail(
        "errors",
        problems
            .iter()
            .map(|problem| json!({ "path": problem.path, "message": problem.message }))
            .collect::<Vec<_>>(),
    )
}

fn problem(path: &str, message: &str) -> Problem {
    Problem {
        path: path.to_string(),
        code: "invalid",
        message: message.to_string(),
        hint: None,
    }
}

/// Who a door takes.
#[derive(Clone, Copy)]
enum Door {
    /// `connectors.manage`.
    Owner,
    /// `connectors.manage`, or the plugin's connector key.
    Reader,
    /// The plugin's connector key, or local authority.
    Connector,
}

struct Held {
    name: String,
    connector: Connector,
    record: Record,
    paused: bool,
    run_requested_at: Option<String>,
}

/// The plugin's connector and what the owner chose for it, as the caller may learn of them.
fn held(tx: &Transaction<'_>, caller: &Caller, name: &str, door: Door) -> Result<Held> {
    let installed = plugins::find(tx, name)?;
    let connector = installed
        .as_ref()
        .and_then(|installed| connector::connector_of(&installed.manifest));
    let source = connector
        .as_ref()
        .map(|connector| connector.source.as_str());
    match door {
        Door::Owner => caller.require(Permission::ConnectorsManage)?,
        Door::Reader => caller.require_mapping_reader(source)?,
        Door::Connector => caller.require_connector_source(source.unwrap_or_default())?,
    }
    let installed = installed.ok_or_else(|| not_installed(name))?;
    let connector = connector.ok_or_else(|| no_connector(name))?;
    let record = connector_hosts::record(tx, &installed.name)?
        .filter(|record| record.source == connector.source)
        .ok_or_else(|| no_connector(name))?;
    let (paused, run_requested_at) = chosen(tx, &installed.name)?;
    Ok(Held {
        name: installed.name,
        connector,
        record,
        paused,
        run_requested_at,
    })
}

/// Whether the owner paused the plugin's connector, and when they last asked it to run.
pub(crate) fn chosen(tx: &Transaction<'_>, plugin: &str) -> Result<(bool, Option<String>)> {
    let (paused, asked): (i64, Option<String>) = tx
        .prepare_cached("SELECT paused, run_requested_at FROM plugin_connectors WHERE plugin = ?1")?
        .query_row([plugin], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .ok_or_else(|| no_connector(plugin))?;
    if let Some(asked) = &asked {
        Stamp::read(asked)?;
    }
    match paused {
        0 => Ok((false, asked)),
        1 => Ok((true, asked)),
        _ => Err(Refusal::unread(&format!(
            "whether the connector of plugin {plugin} is paused does not read"
        ))),
    }
}

fn pending_count(tx: &Transaction<'_>, plugin: &str, at: &str) -> Result<i64> {
    Ok(tx
        .prepare_cached(
            "SELECT count(*) FROM connector_previews \
             WHERE plugin = ?1 AND status = 'pending' AND expires_at > ?2",
        )?
        .query_row(params![plugin, at], |row| row.get(0))?)
}

fn answered(tx: &Transaction<'_>, held: &Held, at: &str) -> Result<Value> {
    let registration = match held.record.key_id.as_deref() {
        Some(key_id) => connectors::registration_of_key(tx, key_id)?,
        None => None,
    };
    let (mapping_version, rewrites) = mapping::standing(tx, &held.name)?;
    Ok(json!({
        "plugin": held.name,
        "source": held.record.source,
        "host": held.record.host_id,
        "registration": registration,
        "paused": held.paused,
        "run_requested_at": held.run_requested_at,
        "mapping_version": mapping_version,
        "rewrites": rewrites,
        "previews": pending_count(tx, &held.name, at)?,
    }))
}

pub async fn read(app: &App, caller: &Caller, name: String) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, at| {
        let held = held(tx, caller, &name, Door::Reader)?;
        answered(tx, &held, at)
    })
    .await
}

/// Pauses or resumes the plugin's connector. A pause drops the run the owner asked for.
pub async fn pause(app: &App, caller: &Caller, name: String, paused: bool) -> Result<Value> {
    let action = if paused { PAUSED } else { RESUMED };
    app.write(caller, action, move |unit| {
        let mut held = held(unit.tx(), &unit.caller, &name, Door::Owner)?;
        unit.tx().execute(
            "UPDATE plugin_connectors SET paused = ?2, \
             run_requested_at = CASE WHEN ?2 = 1 THEN NULL ELSE run_requested_at END, \
             updated_at = ?3 WHERE plugin = ?1",
            params![held.name, paused, unit.at],
        )?;
        unit.audit("plugin", &held.name, None)?;
        held.paused = paused;
        if paused {
            held.run_requested_at = None;
        }
        answered(unit.tx(), &held, &unit.at)
    })
    .await
}

pub async fn run(app: &App, caller: &Caller, name: String) -> Result<Value> {
    app.write(caller, RUN_REQUESTED, move |unit| {
        let mut held = held(unit.tx(), &unit.caller, &name, Door::Owner)?;
        if held.paused {
            return Err(paused_refusal(&held.name));
        }
        unit.tx().execute(
            "UPDATE plugin_connectors SET run_requested_at = ?2, updated_at = ?2 WHERE plugin = ?1",
            params![held.name, unit.at],
        )?;
        unit.audit("plugin", &held.name, None)?;
        held.run_requested_at = Some(unit.at.clone());
        answered(unit.tx(), &held, &unit.at)
    })
    .await
}

/// `started_at` is the connector's clock, not the server's.
pub(crate) fn run_reported(tx: &Transaction<'_>, source: &str, started_at: &str) -> Result<()> {
    let Some(plugin) = connector_hosts::plugin_holding(tx, source)? else {
        return Ok(());
    };
    let (_, Some(asked)) = chosen(tx, &plugin)? else {
        return Ok(());
    };
    if Stamp::read(started_at)? >= Stamp::read(&asked)? {
        tx.execute(
            "UPDATE plugin_connectors SET run_requested_at = NULL WHERE plugin = ?1",
            [&plugin],
        )?;
    }
    Ok(())
}

struct Preview {
    id: String,
    kind: String,
    item_id: Option<String>,
    mapping: Option<String>,
    status: String,
    result: Option<String>,
    error: Option<String>,
    created_at: String,
    expires_at: String,
    answered_at: Option<String>,
}

const PREVIEW_COLUMNS: &str =
    "id, kind, item_id, mapping, status, result, error, created_at, expires_at, answered_at";

fn preview_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Preview> {
    Ok(Preview {
        id: row.get(0)?,
        kind: row.get(1)?,
        item_id: row.get(2)?,
        mapping: row.get(3)?,
        status: row.get(4)?,
        result: row.get(5)?,
        error: row.get(6)?,
        created_at: row.get(7)?,
        expires_at: row.get(8)?,
        answered_at: row.get(9)?,
    })
}

impl Preview {
    fn to_json(&self) -> Result<Value> {
        let parsed = |text: &Option<String>, what: &str| -> Result<Value> {
            text.as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()
                .map(Option::unwrap_or_default)
                .map_err(|_| {
                    Refusal::unread(&format!("the {what} of preview {} does not read", self.id))
                })
        };
        if !STATUSES.contains(&self.status.as_str()) {
            return Err(Refusal::unread(&format!(
                "the status of preview {} does not read",
                self.id
            )));
        }
        Ok(json!({
            "id": self.id,
            "kind": self.kind,
            "item_id": self.item_id,
            "mapping": parsed(&self.mapping, "mapping")?,
            "status": self.status,
            "result": parsed(&self.result, "result")?,
            "error": self.error,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "answered_at": self.answered_at,
        }))
    }
}

/// The plugin's preview `id`, while it has not expired.
fn live_preview(tx: &Transaction<'_>, plugin: &str, id: &str, at: &str) -> Result<Preview> {
    tx.prepare_cached(&format!(
        "SELECT {PREVIEW_COLUMNS} FROM connector_previews \
         WHERE plugin = ?1 AND id = ?2 AND expires_at > ?3"
    ))?
    .query_row(params![plugin, id, at], preview_row)
    .optional()?
    .ok_or_else(|| preview_not_found(id))
}

/// What a preview request asks for: its kind, the item, and the draft as a save would store it.
struct Asked {
    kind: String,
    item_id: Option<String>,
    mapping: Option<Value>,
}

fn asked(
    tx: &Transaction<'_>,
    body: &Value,
    connector: &Connector,
    rules: &marfa_rules::catalog::Catalog,
    may_write: impl Fn(&str) -> bool,
) -> Result<Asked> {
    let what = "The preview cannot be asked for";
    let Some(held) = body.as_object() else {
        return Err(invalid(
            what,
            &[problem("", "Must be an object holding kind.")],
        ));
    };
    let mut problems: Vec<Problem> = held
        .keys()
        .filter(|member| !["kind", "item_id", "mapping"].contains(&member.as_str()))
        .map(|member| problem(member, "Is not a member of a preview request."))
        .collect();
    let kind = held
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|name| connector.kind(name));
    if kind.is_none() {
        problems.push(problem("kind", "Must name a kind this connector brings."));
    }
    let item_id = match held.get("item_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => {
            let under = items::type_and_source_of(tx, id)?
                .is_some_and(|(_, source)| source == connector.source);
            if !under {
                problems.push(problem(
                    "item_id",
                    "Must be the id of an item this connector brought.",
                ));
            }
            Some(id.clone())
        }
        Some(_) => {
            problems.push(problem("item_id", "Must be the id of an item, as text."));
            None
        }
    };
    let mapping = match held.get("mapping") {
        None | Some(Value::Null) => None,
        Some(draft @ Value::Object(_)) => match kind {
            Some(kind) => match connector::read_draft(draft, kind, rules, "mapping", &may_write) {
                Ok(entry) => Some(entry.to_json()),
                Err(faults) => {
                    problems.extend(faults);
                    None
                }
            },
            None => None,
        },
        Some(_) => {
            problems.push(problem("mapping", "Must be an object: a kind's mapping."));
            None
        }
    };
    match kind {
        Some(kind) if problems.is_empty() => Ok(Asked {
            kind: kind.name.clone(),
            item_id,
            mapping,
        }),
        _ => Err(invalid(what, &problems)),
    }
}

pub async fn request_preview(
    app: &App,
    caller: &Caller,
    name: String,
    body: Value,
) -> Result<Value> {
    let cache = app.catalog_handle();
    app.write(caller, PREVIEW_REQUESTED, move |unit| {
        let held = held(unit.tx(), &unit.caller, &name, Door::Owner)?;
        let catalog = catalog::current(&cache, unit.tx(), Snapshot::Pending)?;
        let asked = asked(unit.tx(), &body, &held.connector, &catalog.rules, |target| {
            unit.caller.require_type(target, Level::Write).is_ok()
        })?;
        unit.tx().execute(
            "DELETE FROM connector_previews WHERE plugin = ?1 AND expires_at <= ?2",
            params![held.name, unit.at],
        )?;
        if pending_count(unit.tx(), &held.name, &unit.at)? >= PENDING_CAP {
            return Err(Refusal::new(
                Code::ConnectorPreviewsFull,
                format!(
                    "Plugin {} already has {PENDING_CAP} mapping previews waiting on its connector.",
                    held.name
                ),
            )
            .with_detail("limit", PENDING_CAP));
        }
        let preview = Preview {
            id: uuid::Uuid::now_v7().to_string(),
            kind: asked.kind,
            item_id: asked.item_id,
            mapping: asked.mapping.as_ref().map(Value::to_string),
            status: "pending".to_string(),
            result: None,
            error: None,
            created_at: unit.at.clone(),
            expires_at: unit.instant.plus_ms(PREVIEW_LIFE_MS)?.text(),
            answered_at: None,
        };
        unit.tx().execute(
            "INSERT INTO connector_previews (id, plugin, kind, item_id, mapping, status, \
             created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            params![
                preview.id,
                held.name,
                preview.kind,
                preview.item_id,
                preview.mapping,
                preview.created_at,
                preview.expires_at
            ],
        )?;
        preview.to_json()
    })
    .await
}

/// Refuses a status a listing does not take.
pub fn checked_status(status: Option<String>) -> Result<Option<String>> {
    match status {
        Some(status) if !STATUSES.contains(&status.as_str()) => {
            Err(Refusal::validation("status is pending, ready or failed.")
                .with_detail("field", "status"))
        }
        status => Ok(status),
    }
}

pub async fn list_previews(
    app: &App,
    caller: &Caller,
    name: String,
    status: Option<String>,
) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, at| {
        let held = held(tx, caller, &name, Door::Reader)?;
        let mut statement = tx.prepare_cached(&format!(
            "SELECT {PREVIEW_COLUMNS} FROM connector_previews \
             WHERE plugin = ?1 AND expires_at > ?2 AND (?3 IS NULL OR status = ?3) \
             ORDER BY created_at, rowid"
        ))?;
        let rows = statement.query_map(params![held.name, at, status], preview_row)?;
        let mut data = Vec::new();
        for row in rows {
            data.push(row?.to_json()?);
        }
        Ok(json!({ "data": data, "next_cursor": null }))
    })
    .await
}

pub async fn read_preview(app: &App, caller: &Caller, name: String, id: String) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, at| {
        let held = held(tx, caller, &name, Door::Reader)?;
        live_preview(tx, &held.name, &id, at)?.to_json()
    })
    .await
}

/// The connector's answer: a `result` object to store as given, or an `error` message.
fn answer_of(body: &Value) -> Result<(Option<String>, Option<String>)> {
    let what = "The answer cannot be kept";
    let Some(held) = body.as_object() else {
        return Err(invalid(
            what,
            &[problem("", "Must be an object holding result or error.")],
        ));
    };
    let mut problems: Vec<Problem> = held
        .keys()
        .filter(|member| *member != "result" && *member != "error")
        .map(|member| problem(member, "Is not a member of a preview's answer."))
        .collect();
    let result = match held.get("result") {
        None => None,
        Some(result @ Value::Object(_)) => {
            let text = result.to_string();
            if text.len() > RESULT_CAP {
                problems.push(problem(
                    "result",
                    &format!("Must be at most {RESULT_CAP} bytes written as JSON."),
                ));
            }
            Some(text)
        }
        Some(_) => {
            problems.push(problem("result", "Must be an object: the rendered fields."));
            None
        }
    };
    let error = match held.get("error") {
        None => None,
        Some(Value::String(text)) if (1..=ERROR_CAP).contains(&text.chars().count()) => {
            Some(text.clone())
        }
        Some(_) => {
            problems.push(problem(
                "error",
                &format!("Must be text of 1 to {ERROR_CAP} characters."),
            ));
            None
        }
    };
    let given = [held.contains_key("result"), held.contains_key("error")];
    if given == [false, false] {
        problems.push(problem("", "Must hold result or error."));
    } else if given == [true, true] {
        problems.push(problem("", "Must hold result or error, not both."));
    }
    if problems.is_empty() {
        Ok((result, error))
    } else {
        Err(invalid(what, &problems))
    }
}

pub async fn answer_preview(
    app: &App,
    caller: &Caller,
    name: String,
    id: String,
    body: Value,
) -> Result<Value> {
    app.write(caller, PREVIEW_ANSWERED, move |unit| {
        let held = held(unit.tx(), &unit.caller, &name, Door::Connector)?;
        let mut preview = live_preview(unit.tx(), &held.name, &id, &unit.at)?;
        let (result, error) = answer_of(&body)?;
        if preview.status != "pending" {
            return Err(Refusal::new(
                Code::ConnectorPreviewAnswered,
                format!("The connector already answered preview {id}."),
            )
            .with_detail("id", id.as_str())
            .with_detail("status", preview.status.as_str()));
        }
        preview.status = if result.is_some() { "ready" } else { "failed" }.to_string();
        unit.tx().execute(
            "UPDATE connector_previews SET status = ?3, result = ?4, error = ?5, answered_at = ?6 \
             WHERE plugin = ?1 AND id = ?2",
            params![held.name, id, preview.status, result, error, unit.at],
        )?;
        preview.result = result;
        preview.error = error;
        preview.answered_at = Some(unit.at.clone());
        preview.to_json()
    })
    .await
}

/// Each connector a host lists also says whether it is paused and whether a run was asked of it.
pub(crate) fn for_host(tx: &Transaction<'_>, plugin: &str) -> Result<Map<String, Value>> {
    let (paused, asked) = chosen(tx, plugin)?;
    let mut members = Map::new();
    members.insert("paused".into(), paused.into());
    members.insert("run_requested_at".into(), asked.into());
    Ok(members)
}
