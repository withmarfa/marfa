//! The `settings` table: the registry's stored values, and the server's own
//! small notes beside them.

use rusqlite::{Transaction, params};

use super::refusal::Result;

pub fn rows(tx: &Transaction<'_>) -> Result<Vec<(String, String)>> {
    Ok(tx
        .prepare("SELECT key, value FROM settings")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn put(tx: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
