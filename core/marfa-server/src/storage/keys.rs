//! API keys. Only a keyed hash of each key is kept; the key itself is
//! answered once, at mint.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value, json};

/// The five permission maps a key carries, each level a string.
#[derive(Debug, Clone, Default)]
pub struct Maps {
    pub types: Map<String, Value>,
    pub edges: Map<String, Value>,
    pub extensions: Map<String, Value>,
    pub metadata: Map<String, Value>,
    pub profile: Map<String, Value>,
}

impl Maps {
    pub fn everything() -> Maps {
        let all = || {
            let mut map = Map::new();
            map.insert("*".into(), "write".into());
            map
        };
        Maps {
            types: all(),
            edges: all(),
            extensions: all(),
            metadata: all(),
            profile: all(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Key {
    pub id: String,
    pub label: String,
    pub source: String,
    pub sources: Vec<String>,
    pub permissions: Vec<String>,
    pub default_tier: String,
    pub maps: Maps,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
}

impl Key {
    /// The key as `GET /keys` answers it.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "source": self.source,
            "sources": self.sources,
            "permissions": self.permissions,
            "default_tier": self.default_tier,
            "type_permissions": self.maps.types,
            "edge_permissions": self.maps.edges,
            "extension_permissions": self.maps.extensions,
            "metadata_permissions": self.maps.metadata,
            "profile_permissions": self.maps.profile,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "last_used_at": self.last_used_at,
        })
    }
}

const COLUMNS: &str = "id, label, source, sources, permissions, default_tier, type_permissions,
    edge_permissions, extension_permissions, metadata_permissions, profile_permissions,
    created_at, expires_at, last_used_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Key> {
    let list = |at: usize| -> rusqlite::Result<Vec<String>> {
        Ok(serde_json::from_str(&row.get::<_, String>(at)?).unwrap_or_default())
    };
    let map = |at: usize| -> rusqlite::Result<Map<String, Value>> {
        Ok(serde_json::from_str(&row.get::<_, String>(at)?).unwrap_or_default())
    };
    Ok(Key {
        id: row.get(0)?,
        label: row.get(1)?,
        source: row.get(2)?,
        sources: list(3)?,
        permissions: list(4)?,
        default_tier: row
            .get::<_, Option<String>>(5)?
            .unwrap_or_else(|| "library".into()),
        maps: Maps {
            types: map(6)?,
            edges: map(7)?,
            extensions: map(8)?,
            metadata: map(9)?,
            profile: map(10)?,
        },
        created_at: row.get(11)?,
        expires_at: row.get(12)?,
        last_used_at: row.get(13)?,
    })
}

/// The live key whose hash is `hash`: not revoked and not past its expiry.
pub fn by_hash(conn: &Connection, hash: &str, now: &str) -> rusqlite::Result<Option<Key>> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM api_keys
         WHERE hash = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)"
    ))?
    .query_row(params![hash, now], from_row)
    .optional()
}

pub fn live(conn: &Connection) -> rusqlite::Result<Vec<Key>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM api_keys WHERE revoked_at IS NULL ORDER BY id"
    ))?;
    let rows = statement.query_map([], from_row)?;
    rows.collect()
}

pub fn live_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Key>> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM api_keys WHERE id = ?1 AND revoked_at IS NULL"
    ))?
    .query_row([id], from_row)
    .optional()
}

/// Whether a live key writes under `source` as its own.
pub fn source_taken(conn: &Connection, source: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM api_keys WHERE source = ?1 AND revoked_at IS NULL)",
    )?
    .query_row([source], |row| row.get(0))
}

pub fn insert(conn: &Connection, key: &Key, hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_keys (id, hash, label, source, sources, permissions, default_tier,
           type_permissions, edge_permissions, extension_permissions, metadata_permissions,
           profile_permissions, created_at, expires_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)",
        params![
            key.id,
            hash,
            key.label,
            key.source,
            text(&key.sources),
            text(&key.permissions),
            key.default_tier,
            text(&key.maps.types),
            text(&key.maps.edges),
            text(&key.maps.extensions),
            text(&key.maps.metadata),
            text(&key.maps.profile),
            key.created_at,
            key.expires_at,
        ],
    )?;
    Ok(())
}

/// Revokes a live key; answers false where none is live under `id`.
pub fn revoke(conn: &Connection, id: &str, now: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
        params![id, now],
    )?;
    Ok(changed == 1)
}

fn text<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}
