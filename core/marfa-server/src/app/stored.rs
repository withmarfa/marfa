//! The `settings` table: registry values and the server's own notes.

use std::future::Future;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

use super::App;
use super::refusal::{Refusal, Result};
use crate::db::Write;
use crate::settings::registry;

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

pub fn get(tx: &Transaction<'_>, key: &str) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT value FROM settings WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}

pub fn remove(tx: &Transaction<'_>, key: &str) -> Result<()> {
    tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

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

pub type Rows = [(String, Option<String>)];

pub fn write_rows(tx: &Transaction<'_>, rows: &Rows) -> Result<()> {
    for (key, text) in rows {
        match text {
            Some(text) => write_row(tx, key, text)?,
            None => remove(tx, key)?,
        }
    }
    Ok(())
}

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
    pub fn publish(self, app: &App) {
        app.settings.publish(self.generation, &self.rows);
    }
}

/// Runs as a task of its own, since a commit outlives a caller who goes away and so must
/// its publish. When the commit's outcome is unknown the settings are read again, so a
/// change that landed is live.
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

/// A write of its own: it waits for any write still running and follows it in the commit order.
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

/// Reads a `setting` line as the row it stores. The two addresses name where an instance
/// answers, which a move changes, so a line naming either is a damaged archive.
pub fn archived(line: &serde_json::Value) -> Result<(String, String)> {
    let key = line
        .get("key")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let refused =
        |why: String| Refusal::validation(format!("The archive carries a setting {why}."));
    let entry = registry::entry(key)
        .filter(|entry| {
            ![
                registry::ADDRESSES.entry.key,
                registry::SIGN_IN_ADDRESS.entry.key,
            ]
            .contains(&entry.key)
        })
        .ok_or_else(|| refused(format!("this instance does not take: {key}")))?;
    let value = line
        .get("value")
        .ok_or_else(|| refused(format!("with no value: {key}")))?;
    let text = entry
        .row_text_of_json(value)
        .and_then(|text| entry.row_text(&text))
        .map_err(|rule| refused(format!("{key} whose value {rule}")))?;
    Ok((key.to_string(), text))
}

/// Stores each archived setting the instance has none stored for, and answers how many it
/// stored and how many it left.
pub fn restore(tx: &Transaction<'_>, rows: &[(String, String)]) -> Result<(usize, usize)> {
    let (mut added, mut held) = (0, 0);
    for (key, text) in rows {
        if get(tx, key)?.is_some() {
            held += 1;
            continue;
        }
        write_row(tx, key, text)?;
        added += 1;
    }
    Ok((added, held))
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
