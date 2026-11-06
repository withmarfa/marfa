//! Item rows in the shared `items` and `tags` tables.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone)]
pub struct ItemRow {
    pub seq: i64,
    pub id: String,
    pub type_id: String,
    pub state: String,
    pub tier: Option<String>,
    pub version: i64,
    pub schema_version: i64,
    pub source: String,
    pub source_id: Option<String>,
    pub occurred_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub properties: Map<String, Value>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    pub trashed_at: Option<String>,
}

impl ItemRow {
    /// The item as the contract answers it. Nothing in this server makes an
    /// item read-only, since connectors are not served.
    pub fn to_json(&self) -> Value {
        let mut item = json!({
            "id": self.id,
            "type": self.type_id,
            "properties": self.properties,
            "state": self.state,
            "tier": self.tier,
            "version": self.version,
            "schema_version": self.schema_version,
            "source": self.source,
        });
        if let Some(source_id) = &self.source_id {
            item["source_id"] = source_id.clone().into();
        }
        item["read_only"] = false.into();
        item["occurred_at"] = self.occurred_at.clone().into();
        item["created_at"] = self.created_at.clone().into();
        item["updated_at"] = self.updated_at.clone().into();
        item["trashed_at"] = self.trashed_at.clone().into();
        if let Some(latitude) = self.capture_latitude {
            item["capture_latitude"] = latitude.into();
        }
        if let Some(longitude) = self.capture_longitude {
            item["capture_longitude"] = longitude.into();
        }
        item
    }

    pub fn is_live(&self) -> bool {
        self.state != "trashed" && self.trashed_at.is_none()
    }
}

pub fn metadata(id: &str, tags: &[String]) -> Value {
    json!({ "item_id": id, "tags": tags, "extensions": {} })
}

const COLUMNS: &str = "seq, id, type, state, tier, version, schema_version, source, source_id,
    occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude,
    trashed_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<ItemRow> {
    let properties: String = row.get(12)?;
    Ok(ItemRow {
        seq: row.get(0)?,
        id: row.get(1)?,
        type_id: row.get(2)?,
        state: row.get(3)?,
        tier: row.get(4)?,
        version: row.get(5)?,
        schema_version: row.get(6)?,
        source: row.get(7)?,
        source_id: row.get(8)?,
        occurred_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        properties: serde_json::from_str(&properties).unwrap_or_default(),
        capture_latitude: row.get(13)?,
        capture_longitude: row.get(14)?,
        trashed_at: row.get(15)?,
    })
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<ItemRow>> {
    conn.prepare_cached(&format!("SELECT {COLUMNS} FROM items WHERE id = ?1"))?
        .query_row([id], from_row)
        .optional()
}

pub fn by_natural_key(
    conn: &Connection,
    source: &str,
    source_id: &str,
) -> rusqlite::Result<Option<ItemRow>> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM items WHERE source = ?1 AND source_id = ?2"
    ))?
    .query_row(params![source, source_id], from_row)
    .optional()
}

/// Inserts the row and answers its `seq`, which keys its search row.
pub fn insert(conn: &Connection, item: &ItemRow) -> rusqlite::Result<i64> {
    conn.prepare_cached(
        "INSERT INTO items (id, type, state, tier, version, schema_version, source, source_id,
           occurred_at, created_at, updated_at, properties, capture_latitude, capture_longitude,
           trashed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )?
    .execute(params![
        item.id,
        item.type_id,
        item.state,
        item.tier,
        item.version,
        item.schema_version,
        item.source,
        item.source_id,
        item.occurred_at,
        item.created_at,
        item.updated_at,
        Value::Object(item.properties.clone()).to_string(),
        item.capture_latitude,
        item.capture_longitude,
        item.trashed_at,
    ])?;
    Ok(conn.last_insert_rowid())
}

pub fn update(conn: &Connection, item: &ItemRow) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "UPDATE items SET version = ?2, occurred_at = ?3, updated_at = ?4, properties = ?5,
           capture_latitude = ?6, capture_longitude = ?7, tier = ?8
         WHERE id = ?1",
    )?
    .execute(params![
        item.id,
        item.version,
        item.occurred_at,
        item.updated_at,
        Value::Object(item.properties.clone()).to_string(),
        item.capture_latitude,
        item.capture_longitude,
        item.tier,
    ])?;
    Ok(())
}

pub fn tags(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement =
        conn.prepare_cached("SELECT tag FROM tags WHERE item_id = ?1 ORDER BY tag")?;
    let rows = statement.query_map([id], |row| row.get(0))?;
    rows.collect()
}

pub fn add_tags(conn: &Connection, id: &str, tags: &[String]) -> rusqlite::Result<()> {
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)")?;
    for tag in tags {
        insert.execute(params![id, tag])?;
    }
    Ok(())
}
