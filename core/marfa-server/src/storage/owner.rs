//! The one owner an instance is claimed by.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Owner {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub created_at: String,
}

pub fn get(conn: &Connection) -> rusqlite::Result<Option<Owner>> {
    conn.prepare_cached("SELECT id, email, name, created_at FROM owner LIMIT 1")?
        .query_row([], |row| {
            Ok(Owner {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .optional()
}

pub fn insert(conn: &Connection, owner: &Owner, password_hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO owner (id, email, name, password_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            owner.id,
            owner.email,
            owner.name,
            password_hash,
            owner.created_at
        ],
    )?;
    Ok(())
}
