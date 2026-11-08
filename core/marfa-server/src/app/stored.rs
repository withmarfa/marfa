//! The `settings` table: the registry's stored values, and the server's own
//! small notes beside them.

use std::future::Future;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

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

/// What a row holds, whether a setting's or a note's.
pub fn get(tx: &Transaction<'_>, key: &str) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT value FROM settings WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}

/// Removes one of the server's notes.
pub fn remove(tx: &Transaction<'_>, key: &str) -> Result<()> {
    tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
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

/// Rows as they are to be written: the key and its normalized text, or no
/// text to clear it.
pub type Rows = [(String, Option<String>)];

/// Writes settings' rows, clearing those given no text.
pub fn write_rows(tx: &Transaction<'_>, rows: &Rows) -> Result<()> {
    for (key, text) in rows {
        match text {
            Some(text) => write_row(tx, key, text)?,
            None => remove(tx, key)?,
        }
    }
    Ok(())
}

/// The table as a write left it, numbered for publishing once the write has
/// committed.
pub struct Staged {
    generation: u64,
    rows: Vec<(String, String)>,
}

/// Takes the table as this transaction holds it, in its place in the order of
/// the commits. Taken inside the write transaction, where writes are serial.
pub fn stage(tx: &Transaction<'_>, app: &App) -> Result<Staged> {
    Ok(Staged {
        generation: app.settings.next_generation(),
        rows: rows(tx)?,
    })
}

impl Staged {
    /// Makes the rows live, unless a later commit already is.
    pub fn publish(self, app: &App) {
        app.settings.publish(self.generation, &self.rows);
    }
}

/// Runs a write that may change settings, and makes them live once it has
/// committed. It runs as a task of its own: a commit outlives a caller who
/// goes away, and its publish must too. When the commit's outcome is unknown,
/// the settings are read again from the database, so a change that landed is
/// live.
pub async fn committing<T, F>(app: &Arc<App>, write: F) -> Result<T>
where
    T: Send + 'static,
    F: Future<Output = Result<(T, Option<Staged>)>> + Send + 'static,
{
    let app = app.clone();
    tokio::spawn(async move {
        match write.await {
            Ok((value, staged)) => {
                if let Some(staged) = staged {
                    staged.publish(&app);
                }
                Ok(value)
            }
            Err(refusal) => {
                if refusal.commit_failed {
                    reload(&app).await;
                }
                Err(refusal)
            }
        }
    })
    .await
    .map_err(|_| Refusal::internal("a settings change did not finish"))?
}

/// Takes the committed rows as the live settings. It is a write of its own, so
/// it waits for any write still running and follows it in the order of the
/// commits.
async fn reload(app: &Arc<App>) {
    let numbering = app.clone();
    let staged = app
        .db
        .write(Write::own(), move |tx| stage(tx, &numbering))
        .await;
    match staged {
        Ok(staged) => staged.publish(app),
        Err(_) => tracing::error!(
            "The settings could not be read again after a commit of unknown outcome"
        ),
    }
}

/// Applies changes together or not at all, and makes them live once they have
/// committed.
pub async fn change(app: &Arc<App>, write: Write, changes: Vec<Change>) -> Result<()> {
    let changes = changes
        .into_iter()
        .map(row_of)
        .collect::<Result<Vec<_>>>()?;
    let writing = app.clone();
    let doing = app.clone();
    committing(app, async move {
        let staged = doing
            .db
            .write(write, move |tx| {
                write_rows(tx, &changes)?;
                stage(tx, &writing).map(Some)
            })
            .await?;
        Ok(((), staged))
    })
    .await
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
