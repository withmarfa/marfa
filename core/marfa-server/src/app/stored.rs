//! The `settings` table: the registry's stored values, and the server's own
//! small notes beside them.

use std::sync::Arc;

use rusqlite::{Transaction, params};

use super::App;
use super::refusal::{Refusal, Result};
use crate::db::Write;
use crate::settings::registry;

/// A stored setting's new value. `None` or a blank value clears its row, which
/// returns it to its default.
#[derive(Clone, Debug)]
pub struct Change {
    pub key: String,
    pub value: Option<String>,
}

pub fn rows(tx: &Transaction<'_>) -> Result<Vec<(String, String)>> {
    Ok(tx
        .prepare("SELECT key, value FROM settings")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn write_row(tx: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Writes one of the server's notes. A note can never take a setting's row.
pub fn put(tx: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    if registry::entry(key).is_some() {
        return Err(Refusal::internal("a note took a setting's key"));
    }
    write_row(tx, key, value)
}

/// A change as its row: the key and normalized text, or no text to clear it.
fn row_of(change: Change) -> Result<(String, Option<String>)> {
    let Some(entry) = registry::entry(&change.key) else {
        return Err(Refusal::validation(format!(
            "{} is not a stored setting",
            change.key
        )));
    };
    let text = change
        .value
        .map(|value| entry.row_text(&value))
        .transpose()
        .map_err(|rule| Refusal::validation(format!("{} {rule}", entry.key)))?;
    Ok((change.key, text.filter(|text| !text.is_empty())))
}

/// Applies changes together or not at all, and makes them live once they have
/// committed. It runs as a task of its own: a commit outlives a caller who
/// goes away, and its publish must too.
pub async fn change(app: &Arc<App>, write: Write, changes: Vec<Change>) -> Result<()> {
    let changes = changes
        .into_iter()
        .map(row_of)
        .collect::<Result<Vec<_>>>()?;
    let app = app.clone();
    tokio::spawn(async move {
        let writing = app.clone();
        let (generation, stored) = app
            .db
            .write(write, move |tx| {
                for (key, text) in &changes {
                    match text {
                        Some(text) => write_row(tx, key, text)?,
                        None => {
                            tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
                        }
                    }
                }
                Ok((writing.settings.next_generation(), rows(tx)?))
            })
            .await?;
        app.settings.publish(generation, &stored);
        Ok(())
    })
    .await
    .map_err(|_| Refusal::internal("a settings change did not finish"))?
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::settings::registry::ENTRIES;

    #[test]
    fn a_note_cannot_take_a_settings_row() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        let tx = conn.transaction().unwrap();
        for entry in ENTRIES {
            assert!(put(&tx, entry.key, "note").is_err(), "{}", entry.key);
        }
        put(&tx, "health_probe", "note").unwrap();
        assert_eq!(rows(&tx).unwrap().len(), 1);
    }
}
