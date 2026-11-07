//! API keys. A credential comes from a key made through the control socket.

mod secret;

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::{Map, Value, json};

use super::App;
use super::refusal::{Refusal, Result};
use crate::db::Write;

/// Every permission a key may hold.
pub const PERMISSIONS: [&str; 12] = [
    "audit.read",
    "blobs.manage",
    "config.manage",
    "connectors.manage",
    "grants.manage",
    "instance.maintain",
    "instance.read",
    "items.purge",
    "keys.manage",
    "keys.mint",
    "schema.write",
    "webhooks.manage",
];

const MAP_FIELDS: [&str; 5] = [
    "type_permissions",
    "edge_permissions",
    "extension_permissions",
    "metadata_permissions",
    "profile_permissions",
];

/// What a key mint's body may name.
pub const MINT_FIELDS: [&str; 8] = [
    "label",
    "source",
    "permissions",
    "type_permissions",
    "edge_permissions",
    "extension_permissions",
    "metadata_permissions",
    "profile_permissions",
];

#[derive(Clone, Debug)]
pub struct Key {
    pub id: String,
    pub label: String,
    pub source: String,
    pub permissions: Vec<String>,
    pub maps: [Map<String, Value>; 5],
    pub created_at: String,
}

impl Key {
    pub fn holds(&self, permission: &str) -> bool {
        self.permissions.iter().any(|held| held == permission)
    }

    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("id".into(), self.id.as_str().into());
        out.insert("label".into(), self.label.as_str().into());
        out.insert("source".into(), self.source.as_str().into());
        out.insert("permissions".into(), json!(self.permissions));
        for (field, map) in MAP_FIELDS.iter().zip(&self.maps) {
            out.insert((*field).into(), Value::Object(map.clone()));
        }
        out.insert("created_at".into(), self.created_at.as_str().into());
        out
    }
}

fn text_field(body: &Map<String, Value>, field: &str) -> Result<String> {
    match body.get(field).and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Ok(text.to_string()),
        _ => Err(Refusal::validation(format!(
            "{field} must be text that is not empty."
        ))),
    }
}

fn permission_list(body: &Map<String, Value>) -> Result<Vec<String>> {
    let Some(named) = body.get("permissions") else {
        return Ok(Vec::new());
    };
    let refused = || Refusal::validation("permissions must be a list of known permissions.");
    named
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(|permission| match permission.as_str() {
            Some(word) if PERMISSIONS.contains(&word) => Ok(word.to_string()),
            _ => Err(refused()),
        })
        .collect()
}

fn level_map(body: &Map<String, Value>, field: &str) -> Result<Map<String, Value>> {
    let Some(named) = body.get(field) else {
        return Ok(Map::new());
    };
    let refused = || Refusal::validation(format!("{field} must map names to levels."));
    let map = named.as_object().ok_or_else(refused)?;
    let known = |level: &Value| matches!(level.as_str(), Some("none" | "read" | "write"));
    if map.values().all(known) {
        Ok(map.clone())
    } else {
        Err(refused())
    }
}

fn map_column(row: &Row<'_>, column: &str) -> rusqlite::Result<Map<String, Value>> {
    let text: String = row.get(column)?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Key> {
    let permissions: String = row.get("permissions")?;
    Ok(Key {
        id: row.get("id")?,
        label: row.get("label")?,
        source: row.get("source")?,
        permissions: serde_json::from_str(&permissions).unwrap_or_default(),
        maps: [
            map_column(row, MAP_FIELDS[0])?,
            map_column(row, MAP_FIELDS[1])?,
            map_column(row, MAP_FIELDS[2])?,
            map_column(row, MAP_FIELDS[3])?,
            map_column(row, MAP_FIELDS[4])?,
        ],
        created_at: row.get("created_at")?,
    })
}

fn insert(tx: &Transaction<'_>, key: &Key, hash: &str) -> Result<()> {
    let [types, edges, extensions, metadata, profile] = key
        .maps
        .each_ref()
        .map(|map| Value::Object(map.clone()).to_string());
    tx.execute(
        "INSERT INTO api_keys (id, hash, label, source, permissions, type_permissions, \
         edge_permissions, extension_permissions, metadata_permissions, profile_permissions, \
         created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            key.id,
            hash,
            key.label,
            key.source,
            json!(key.permissions).to_string(),
            types,
            edges,
            extensions,
            metadata,
            profile,
            key.created_at,
        ],
    )?;
    Ok(())
}

/// Makes a key from a mint's body, and answers it with its secret, which is
/// the only time the secret is seen.
pub async fn mint(app: &App, body: &Map<String, Value>) -> Result<(Key, String)> {
    let key = Key {
        id: uuid::Uuid::now_v7().to_string(),
        label: text_field(body, "label")?,
        source: text_field(body, "source")?,
        permissions: permission_list(body)?,
        maps: [
            level_map(body, MAP_FIELDS[0])?,
            level_map(body, MAP_FIELDS[1])?,
            level_map(body, MAP_FIELDS[2])?,
            level_map(body, MAP_FIELDS[3])?,
            level_map(body, MAP_FIELDS[4])?,
        ],
        created_at: app.clock.stamp(),
    };
    let plain = secret::new_secret()?;
    let hash = secret::hash(&app.settings.start.api_key_salt, &plain)?;
    let stored = key.clone();
    app.db
        .write(Write::caller("key.mint"), move |tx| {
            insert(tx, &stored, &hash)
        })
        .await?;
    Ok((key, plain))
}

/// The live key a bearer token names, if any.
pub async fn authenticate(app: &App, token: &str) -> Result<Option<Key>> {
    if !secret::looks_like_a_key(token) {
        return Ok(None);
    }
    let hash = secret::hash(&app.settings.start.api_key_salt, token)?;
    app.db
        .read(move |tx| {
            Ok(tx
                .query_row(
                    "SELECT * FROM api_keys WHERE hash = ?1 AND revoked_at IS NULL",
                    [hash],
                    from_row,
                )
                .optional()?)
        })
        .await
}
