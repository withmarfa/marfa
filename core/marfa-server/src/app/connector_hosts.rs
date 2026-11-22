//! Connector hosts, their one-time links, and the record of each plugin's connector.

use std::net::IpAddr;

use marfa_rules::plugin_connector;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::App;
use super::connector_control;
use super::access::{Axis, Caller, Grants, Permission};
use super::auth::limits::{connector_link_lanes, hold_to};
use super::clock::Stamp;
use super::connectors;
use super::keys::{self, Maker};
use super::plugins;
use super::refusal::{Code, Refusal, Result};
use super::sources::CONNECTOR_HOST;
use super::unit::Unit;

pub const LINK_LIFE_MS: i64 = 15 * 60 * 1000;
pub const NAME_CAP: usize = 100;
const CODE_PREFIX: &str = "marfa_l1_";
const CODE_BYTES: usize = 32;
pub const CREATED: &str = "connector_host.create";
pub const LINKED: &str = "connector_host.link";
pub const REDEEMED: &str = "connector_host.redeem";
pub const REMOVED: &str = "connector_host.remove";
pub const ASSIGNED: &str = "plugin.connector_assign";
pub const KEY_MINTED: &str = "connector.key_mint";
const SEEN: &str = "connector_host.seen";

/// A plugin's connector as the instance records it.
#[derive(Clone, Debug)]
pub struct Record {
    pub plugin: String,
    /// This install of the connector; a reinstall gets another.
    pub id: Option<String>,
    pub source: String,
    pub host_id: Option<String>,
    pub key_id: Option<String>,
}

#[derive(Clone, Debug)]
struct Host {
    id: String,
    name: String,
    key_id: Option<String>,
    last_seen_at: Option<String>,
    created_at: String,
    updated_at: String,
}

fn host_not_found(id: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorHostNotFound,
        format!("No connector host has the id {id}."),
    )
    .with_detail("id", id)
}

fn link_not_found() -> Refusal {
    Refusal::new(
        Code::ConnectorLinkNotFound,
        "This link does not connect a host: it was used or replaced, it ended, or its host was removed. Make a fresh link.",
    )
}

fn plugin_not_found(name: &str) -> Refusal {
    Refusal::new(
        Code::PluginNotFound,
        format!("No plugin named {name} is installed and assigned to this host."),
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

fn hosts_only() -> Refusal {
    Refusal::new(
        Code::Forbidden,
        "Only a connector host's own key reaches this.",
    )
}

pub fn source_held_by_plugin(source: &str, plugin: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorSourceHeld,
        format!("The connector of plugin {plugin} holds the source {source}."),
    )
    .with_detail("source", source)
    .with_detail("plugin", plugin)
}

fn source_held_by_registration(source: &str, connector_id: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorSourceHeld,
        format!(
            "A connector registration holds the source {source}. Remove it with DELETE /connectors/{connector_id}, which keeps the source's state and agreements, then install again."
        ),
    )
    .with_detail("source", source)
    .with_detail("connector_id", connector_id)
}

fn source_held_by_key(source: &str, key_id: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorSourceHeld,
        format!("A live key holds the source {source}. Revoke it, then install again."),
    )
    .with_detail("source", source)
    .with_detail("key_id", key_id)
}

fn record_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    Ok(Record {
        plugin: row.get(0)?,
        source: row.get(1)?,
        host_id: row.get(2)?,
        key_id: row.get(3)?,
        id: row.get(4)?,
    })
}

pub(crate) fn record(tx: &Transaction<'_>, plugin: &str) -> Result<Option<Record>> {
    Ok(tx
        .prepare_cached(
            "SELECT plugin, source, host_id, key_id, id FROM plugin_connectors WHERE plugin = ?1",
        )?
        .query_row([plugin], record_of)
        .optional()?)
}

/// The plugin connector whose host minted the key `key_id`.
pub(crate) fn record_of_key(tx: &Transaction<'_>, key_id: &str) -> Result<Option<Record>> {
    Ok(tx
        .prepare_cached(
            "SELECT plugin, source, host_id, key_id, id FROM plugin_connectors WHERE key_id = ?1",
        )?
        .query_row([key_id], record_of)
        .optional()?)
}

pub(crate) fn records(tx: &Transaction<'_>) -> Result<Vec<Record>> {
    let mut statement = tx.prepare_cached(
        "SELECT plugin, source, host_id, key_id, id FROM plugin_connectors ORDER BY plugin",
    )?;
    let rows = statement.query_map([], record_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The plugin whose connector holds `source`.
pub(crate) fn plugin_holding(tx: &Transaction<'_>, source: &str) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT plugin FROM plugin_connectors WHERE source = ?1")?
        .query_row([source], |row| row.get(0))
        .optional()?)
}

/// Refuses a source another plugin's connector, a registration or a live key holds.
pub(crate) fn require_source_free(tx: &Transaction<'_>, source: &str, at: &str) -> Result<()> {
    if let Some(plugin) = plugin_holding(tx, source)? {
        return Err(source_held_by_plugin(source, &plugin));
    }
    if let Some(registration) = connectors::of_source(tx, source)?.last() {
        return Err(source_held_by_registration(source, &registration.id));
    }
    if let Some(key_id) = keys::oldest_holding(tx, source, at)? {
        return Err(source_held_by_key(source, &key_id));
    }
    Ok(())
}

/// Records a plugin's connector with no host and no key.
pub(crate) fn add(tx: &Transaction<'_>, plugin: &str, source: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO plugin_connectors (plugin, source, id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![plugin, source, uuid::Uuid::now_v7().to_string(), at],
    )?;
    Ok(())
}

/// The host a plugin's connector is assigned to.
pub(crate) fn host_of(tx: &Transaction<'_>, plugin: &str) -> Result<Option<String>> {
    Ok(record(tx, plugin)?.and_then(|record| record.host_id))
}

fn live(tx: &Transaction<'_>, key_id: Option<&str>, at: &str) -> Result<bool> {
    match key_id {
        Some(id) => keys::stands(tx, id, at),
        None => Ok(false),
    }
}

/// Revokes the key a host minted for the connector, if it still stands, and forgets it.
fn end_connector_key(unit: &Unit<'_, '_>, record: &Record) -> Result<Option<String>> {
    let ended = match record.key_id.as_deref() {
        Some(id) if keys::unrevoked_by_id(unit.tx(), id)?.is_some() => {
            keys::end(unit, id)?;
            Some(id.to_string())
        }
        _ => None,
    };
    unit.tx().execute(
        "UPDATE plugin_connectors SET key_id = NULL, updated_at = ?2 WHERE plugin = ?1",
        params![record.plugin, unit.at],
    )?;
    Ok(ended)
}

/// What removing a plugin did to its connector, for the answer.
pub(crate) struct Removed {
    pub removed: Value,
    pub kept: Value,
}

/// Stops a plugin's connector in the caller's write: its key, its registrations and its record.
pub(crate) fn remove_for_plugin(unit: &Unit<'_, '_>, plugin: &str) -> Result<Option<Removed>> {
    let Some(record) = record(unit.tx(), plugin)? else {
        return Ok(None);
    };
    let key_id = end_connector_key(unit, &record)?;
    let registrations = connectors::remove_of_source(unit, &record.source)?;
    let (state, agreements) = connectors::kept_of_source(unit.tx(), &record.source)?;
    unit.tx()
        .execute("DELETE FROM plugin_connectors WHERE plugin = ?1", [plugin])?;
    Ok(Some(Removed {
        removed: json!({
            "source": record.source,
            "key_id": key_id,
            "registrations": registrations,
        }),
        kept: json!({ "source": record.source, "state": state, "agreements": agreements }),
    }))
}

fn host_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get(0)?,
        name: row.get(1)?,
        key_id: row.get(2)?,
        last_seen_at: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const HOST_COLUMNS: &str = "id, name, key_id, last_seen_at, created_at, updated_at";

fn host(tx: &Transaction<'_>, id: &str) -> Result<Option<Host>> {
    Ok(tx
        .prepare_cached(&format!(
            "SELECT {HOST_COLUMNS} FROM connector_hosts WHERE id = ?1"
        ))?
        .query_row([id], host_row)
        .optional()?)
}

fn found(tx: &Transaction<'_>, id: &str) -> Result<Host> {
    host(tx, id)?.ok_or_else(|| host_not_found(id))
}

fn hosts(tx: &Transaction<'_>) -> Result<Vec<Host>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT {HOST_COLUMNS} FROM connector_hosts ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([], host_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn assigned(tx: &Transaction<'_>, host_id: &str) -> Result<Vec<Record>> {
    let mut statement = tx.prepare_cached(
        "SELECT plugin, source, host_id, key_id, id FROM plugin_connectors WHERE host_id = ?1 \
         ORDER BY plugin",
    )?;
    let rows = statement.query_map([host_id], record_of)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn link_expires_at(tx: &Transaction<'_>, host_id: &str, at: &str) -> Result<Option<String>> {
    let held: Option<String> = tx
        .prepare_cached("SELECT expires_at FROM connector_host_links WHERE host_id = ?1")?
        .query_row([host_id], |row| row.get(0))
        .optional()?;
    let now = Stamp::read(at)?;
    Ok(match held {
        Some(end) if Stamp::read(&end)? > now => Some(end),
        _ => None,
    })
}

fn presented(tx: &Transaction<'_>, host: &Host, at: &str) -> Result<Value> {
    let mut connectors = Vec::new();
    for record in assigned(tx, &host.id)? {
        let installed = plugins::installed(tx, &record.plugin)?
            .ok_or_else(|| Refusal::internal("a plugin's connector outlived its plugin"))?;
        connectors.push(json!({
            "plugin": record.plugin,
            "version": installed.version,
            "key_minted": live(tx, record.key_id.as_deref(), at)?,
        }));
    }
    Ok(json!({
        "id": host.id,
        "name": host.name,
        "created_at": host.created_at,
        "updated_at": host.updated_at,
        "last_seen_at": host.last_seen_at,
        "linked": live(tx, host.key_id.as_deref(), at)?,
        "link_expires_at": link_expires_at(tx, &host.id, at)?,
        "connectors": connectors,
    }))
}

/// A one-time link's code and the digest the server keeps of it.
pub struct LinkCode {
    plain: String,
    hash: String,
}

fn new_code(app: &App) -> Result<LinkCode> {
    let mut bytes = [0u8; CODE_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    let plain = format!("{CODE_PREFIX}{}", hex::encode(bytes));
    let hash = keys::digest_of(&app.settings.start.key_salt, &plain)?;
    Ok(LinkCode { plain, hash })
}

fn store_link(unit: &Unit<'_, '_>, host_id: &str, code: &LinkCode) -> Result<String> {
    let expires_at = Stamp::read(&unit.at)?.plus_ms(LINK_LIFE_MS)?.text();
    unit.tx().execute(
        "INSERT INTO connector_host_links (host_id, code_hash, expires_at, created_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT (host_id) DO UPDATE SET \
         code_hash = excluded.code_hash, expires_at = excluded.expires_at, \
         created_at = excluded.created_at",
        params![host_id, code.hash, expires_at, unit.at],
    )?;
    Ok(expires_at)
}

fn linked_answer(
    origin: &str,
    tx: &Transaction<'_>,
    host: &Host,
    code: &str,
    expires_at: &str,
    at: &str,
) -> Result<Value> {
    Ok(json!({
        "host": presented(tx, host, at)?,
        "link": format!("{origin}/connect#{code}"),
        "code": code,
        "expires_at": expires_at,
    }))
}

/// A host's name as stored: text of 1 to 100 characters once trimmed.
pub fn checked_name(value: Option<&Value>) -> Result<String> {
    let name = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= NAME_CAP);
    name.map(str::to_string).ok_or_else(|| {
        Refusal::validation(format!(
            "name must be text of 1 to {NAME_CAP} characters once trimmed."
        ))
        .with_detail(
            "errors",
            vec![json!({ "path": "name", "message": "name is required: text of 1 to 100 characters" })],
        )
    })
}

pub async fn create(app: &App, caller: &Caller, name: Option<Value>) -> Result<Value> {
    caller.require(Permission::ConnectorsManage)?;
    let name = checked_name(name.as_ref())?;
    let code = new_code(app)?;
    let origin = app.addresses().sign_in().origin().to_string();
    app.write(caller, CREATED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        let id = uuid::Uuid::now_v7().to_string();
        unit.tx().execute(
            "INSERT INTO connector_hosts (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, name, unit.at],
        )?;
        let expires_at = store_link(unit, &id, &code)?;
        unit.audit("connector_host", &id, Some(json!({ "name": name })))?;
        let host = found(unit.tx(), &id)?;
        linked_answer(&origin, unit.tx(), &host, &code.plain, &expires_at, &unit.at)
    })
    .await
}

pub async fn link(app: &App, caller: &Caller, id: String) -> Result<Value> {
    let code = new_code(app)?;
    let origin = app.addresses().sign_in().origin().to_string();
    app.write(caller, LINKED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        let host = found(unit.tx(), &id)?;
        let expires_at = store_link(unit, &id, &code)?;
        unit.tx().execute(
            "UPDATE connector_hosts SET updated_at = ?2 WHERE id = ?1",
            params![id, unit.at],
        )?;
        unit.audit("connector_host", &id, None)?;
        linked_answer(
            &origin,
            unit.tx(),
            &host,
            &code.plain,
            &expires_at,
            &unit.at,
        )
    })
    .await
}

pub async fn list(app: &App, caller: &Caller) -> Result<Value> {
    connectors::reading(app, caller, |tx, caller, at| {
        caller.require(Permission::ConnectorsManage)?;
        let mut data = Vec::new();
        for host in hosts(tx)? {
            data.push(presented(tx, &host, at)?);
        }
        Ok(json!({ "data": data, "next_cursor": null }))
    })
    .await
}

pub async fn get(app: &App, caller: &Caller, id: String) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, at| {
        caller.require(Permission::ConnectorsManage)?;
        presented(tx, &found(tx, &id)?, at)
    })
    .await
}

pub async fn remove(app: &App, caller: &Caller, id: String) -> Result<Value> {
    app.write(caller, REMOVED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        let host = found(unit.tx(), &id)?;
        let ending = keys::live_of_host(unit.tx(), &id, &unit.at)?;
        for key_id in &ending {
            keys::end(unit, key_id)?;
        }
        let unassigned: Vec<String> = assigned(unit.tx(), &id)?
            .into_iter()
            .map(|record| record.plugin)
            .collect();
        unit.tx().execute(
            "UPDATE plugin_connectors SET host_id = NULL, key_id = NULL, updated_at = ?2 \
             WHERE host_id = ?1",
            params![id, unit.at],
        )?;
        unit.tx()
            .execute("DELETE FROM connector_hosts WHERE id = ?1", [&id])?;
        unit.audit(
            "connector_host",
            &id,
            Some(json!({ "revoked_keys": ending.len(), "unassigned": unassigned })),
        )?;
        Ok(json!({
            "removed": { "id": host.id, "name": host.name },
            "revoked_keys": ending.len(),
            "unassigned": unassigned,
        }))
    })
    .await
}

/// Counts a try at redeeming a link from `address`, refusing one past the limit.
pub fn hold_redeem(app: &App, address: Option<IpAddr>) -> Result<()> {
    hold_to(
        app,
        connector_link_lanes(address),
        "Too many links tried from this address. Try again later.",
    )
}

/// The managing permission, judged before a door reads its body.
pub fn require_manager(caller: &Caller) -> Result<()> {
    caller.require(Permission::ConnectorsManage)
}

pub async fn redeem(app: &App, code: Option<Value>) -> Result<Value> {
    let code = match code {
        Some(Value::String(code)) => code,
        _ => {
            return Err(
                Refusal::validation("code must be the text of a one-time link.").with_detail(
                    "errors",
                    vec![json!({ "path": "code", "message": "code is required, as text" })],
                ),
            );
        }
    };
    let digest = keys::digest_of(&app.settings.start.key_salt, &code)?;
    let (plain, hash) = keys::new_secret(app)?;
    app.write(&Caller::Server, REDEEMED, move |unit| {
        let held: Option<(String, String)> = unit
            .tx()
            .prepare_cached(
                "SELECT host_id, expires_at FROM connector_host_links WHERE code_hash = ?1",
            )?
            .query_row([&digest], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let Some((host_id, expires_at)) = held else {
            return Err(link_not_found());
        };
        if Stamp::read(&expires_at)? <= Stamp::read(&unit.at)? {
            return Err(link_not_found());
        }
        let host = found(unit.tx(), &host_id)?;
        unit.tx().execute(
            "DELETE FROM connector_host_links WHERE host_id = ?1",
            [&host_id],
        )?;
        if let Some(old) = host.key_id.as_deref()
            && keys::unrevoked_by_id(unit.tx(), old)?.is_some()
        {
            keys::end(unit, old)?;
        }
        let grants = Grants {
            permissions: vec![Permission::ConnectorsHost],
            ..Grants::default()
        };
        let key = keys::given(
            format!("Connector host {}", host.name),
            format!("{CONNECTOR_HOST}{host_id}"),
            grants,
            "library",
            Maker::Host(host_id.clone()),
            &unit.at,
        );
        keys::store_given(unit, &key, &hash)?;
        unit.tx().execute(
            "UPDATE connector_hosts SET key_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![host_id, key.id, unit.at],
        )?;
        unit.audit(
            "connector_host",
            &host_id,
            Some(json!({ "key_id": key.id })),
        )?;
        Ok(json!({
            "host": { "id": host.id, "name": host.name },
            "key": plain,
            "key_id": key.id,
        }))
    })
    .await
}

/// The host whose own key the caller bears.
fn own_host(caller: &Caller) -> Result<String> {
    caller.host_id().map(str::to_string).ok_or_else(hosts_only)
}

pub async fn own(app: &App, caller: &Caller) -> Result<Value> {
    app.write(caller, SEEN, move |unit| {
        let host_id = own_host(&unit.caller)?;
        let host = found(unit.tx(), &host_id)?;
        unit.tx().execute(
            "UPDATE connector_hosts SET last_seen_at = ?2 WHERE id = ?1",
            params![host_id, unit.at],
        )?;
        let mut connectors = Vec::new();
        for record in assigned(unit.tx(), &host_id)? {
            let installed = plugins::installed(unit.tx(), &record.plugin)?
                .ok_or_else(|| Refusal::internal("a plugin's connector outlived its plugin"))?;
            let registration = match record.key_id.as_deref() {
                Some(key_id) => connectors::registration_of_key(unit.tx(), key_id)?,
                None => None,
            };
            let mut connector = json!({
                "plugin": record.plugin,
                "version": installed.version,
                "fingerprint": installed.fingerprint,
                "connector": installed.manifest.get("connector").cloned().unwrap_or(Value::Null),
                "registration_id": registration,
                "key_minted": live(unit.tx(), record.key_id.as_deref(), &unit.at)?,
            });
            if let Value::Object(members) = &mut connector {
                members.extend(connector_control::for_host(unit.tx(), &record.plugin)?);
            }
            connectors.push(connector);
        }
        Ok(json!({ "id": host.id, "name": host.name, "connectors": connectors }))
    })
    .await
}

pub async fn mint(app: &App, caller: &Caller, plugin: String) -> Result<Value> {
    let (plain, hash) = keys::new_secret(app)?;
    app.write(caller, KEY_MINTED, move |unit| {
        let host_id = own_host(&unit.caller)?;
        let record = record(unit.tx(), &plugin)?
            .filter(|record| record.host_id.as_deref() == Some(host_id.as_str()))
            .ok_or_else(|| plugin_not_found(&plugin))?;
        let installed =
            plugins::installed(unit.tx(), &plugin)?.ok_or_else(|| plugin_not_found(&plugin))?;
        let section = installed
            .manifest
            .get("connector")
            .and_then(Value::as_object)
            .ok_or_else(|| Refusal::internal("a recorded connector's plugin has no connector"))?;
        let writes: serde_json::Map<String, Value> = plugin_connector::kind_types(section)
            .into_iter()
            .map(|type_id| (type_id.to_string(), Value::from("write")))
            .collect();
        let mut grants = Grants::default();
        grants.maps[Axis::Type as usize] = Axis::Type.from_body(&Value::Object(writes))?;
        end_connector_key(unit, &record)?;
        let key = keys::given(
            format!("{plugin} connector"),
            record.source.clone(),
            grants,
            "feed",
            Maker::Host(host_id.clone()),
            &unit.at,
        );
        keys::store_given(unit, &key, &hash)?;
        unit.tx().execute(
            "UPDATE plugin_connectors SET key_id = ?2, updated_at = ?3 WHERE plugin = ?1",
            params![plugin, key.id, unit.at],
        )?;
        unit.audit(
            "plugin",
            &plugin,
            Some(json!({ "host": host_id, "key_id": key.id })),
        )?;
        Ok(json!({
            "plugin": plugin,
            "key": plain,
            "key_id": key.id,
            "source": record.source,
        }))
    })
    .await
}

pub async fn assign(
    app: &App,
    caller: &Caller,
    plugin: String,
    host: Option<String>,
) -> Result<Value> {
    app.write(caller, ASSIGNED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        if plugins::installed(unit.tx(), &plugin)?.is_none() {
            return Err(Refusal::new(
                Code::PluginNotFound,
                format!("No plugin named {plugin} is installed."),
            )
            .with_detail("name", plugin.as_str()));
        }
        let record = record(unit.tx(), &plugin)?.ok_or_else(|| no_connector(&plugin))?;
        if let Some(id) = &host {
            found(unit.tx(), id)?;
        }
        let mut key_id = record.key_id.clone();
        if record.host_id != host {
            end_connector_key(unit, &record)?;
            key_id = None;
            unit.tx().execute(
                "UPDATE plugin_connectors SET host_id = ?2, updated_at = ?3 WHERE plugin = ?1",
                params![plugin, host, unit.at],
            )?;
        }
        unit.audit("plugin", &plugin, Some(json!({ "host": host })))?;
        Ok(json!({
            "plugin": plugin,
            "source": record.source,
            "host": host,
            "key_minted": live(unit.tx(), key_id.as_deref(), &unit.at)?,
        }))
    })
    .await
}

/// Records each restored plugin's connector with no host and no key.
pub(crate) fn restore(
    tx: &Transaction<'_>,
    connectors: &[(String, String)],
    at: &str,
) -> Result<()> {
    for (plugin, source) in connectors {
        if record(tx, plugin)?.is_some() {
            continue;
        }
        if let Some(holder) = plugin_holding(tx, source)? {
            return Err(source_held_by_plugin(source, &holder));
        }
        if let Some(key_id) = keys::oldest_holding(tx, source, at)? {
            return Err(source_held_by_key(source, &key_id));
        }
        add(tx, plugin, source, at)?;
    }
    Ok(())
}
