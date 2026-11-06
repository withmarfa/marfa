//! The instance's own settings: its id, kept across restarts, and its name.

use rusqlite::{Connection, OptionalExtension, params};

pub fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT value FROM settings WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()
}

pub fn set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

/// The instance id, made once on the first start.
pub fn instance_id(conn: &Connection) -> rusqlite::Result<String> {
    if let Some(id) = get(conn, "instance_id")? {
        return Ok(id);
    }
    let id = uuid::Uuid::now_v7().to_string();
    set(conn, "instance_id", &id)?;
    Ok(id)
}
