//! The `settings` table: registry values and the server's own notes.

use std::future::Future;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

use super::App;
use super::refusal::{Refusal, Result};
use crate::db::Write;
use crate::settings::registry::{self, Kind, Reading, Seeds, Setting};
use crate::settings::report_unreadable;

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

/// Read in this transaction, so a change committed while the write waited is seen.
pub fn setting<T: Kind>(tx: &Transaction<'_>, seeds: &Seeds, setting: Setting<T>) -> Result<T> {
    let row = get(tx, setting.entry.key)?;
    let (value, reading) = setting.resolve(seeds, row.as_deref());
    if reading == Reading::Unreadable {
        report_unreadable(setting.entry.key);
    }
    Ok(value)
}

/// An unreadable row refuses, since a fallback could delete what the stored value keeps.
pub fn deciding<T: Kind>(tx: &Transaction<'_>, seeds: &Seeds, setting: Setting<T>) -> Result<T> {
    let row = get(tx, setting.entry.key)?;
    match setting.resolve(seeds, row.as_deref()) {
        (_, Reading::Unreadable) => Err(Refusal::internal(&format!(
            "the stored setting {} does not read, so nothing it decides is deleted",
            setting.entry.key
        ))),
        (value, _) => Ok(value),
    }
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
    /// A job's interval or switch may be a setting, so the scheduler looks again.
    pub fn publish(self, app: &App) {
        app.settings.publish(self.generation, &self.rows);
        super::housekeeping::wake(app);
    }
}

/// Runs as a task of its own so the publish outlives a caller who goes away.
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

/// Rows of the `settings` table that are no setting: the server's own notes.
const NOTES: [&str; 2] = [super::config::ENFORCEMENT_ROW, super::health::PROBE_KEY];

/// Logs the stored settings this server does not have; their rows are left alone.
pub fn report_unknown(rows: &[(String, String)]) {
    let unknown: Vec<&str> = rows
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| registry::entry(key).is_none() && !NOTES.contains(key))
        .collect();
    if !unknown.is_empty() {
        tracing::warn!(
            settings = unknown.join(", "),
            "Stored settings this server does not have are ignored; their rows stay in the database"
        );
    }
}

/// A line naming either address is a damaged archive; one naming an unknown setting gives no text.
pub fn archived(line: &serde_json::Value) -> Result<(String, Option<String>)> {
    let key = line
        .get("key")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let refused =
        |why: String| Refusal::validation(format!("The archive carries a setting {why}."));
    let Some(entry) = registry::entry(key) else {
        return Ok((key.to_string(), None));
    };
    if [
        registry::ADDRESSES.entry.key,
        registry::SIGN_IN_ADDRESS.entry.key,
    ]
    .contains(&entry.key)
    {
        return Err(refused(format!("this instance does not take: {key}")));
    }
    let value = line
        .get("value")
        .ok_or_else(|| refused(format!("with no value: {key}")))?;
    let text = entry
        .row_text_of_json(value)
        .and_then(|text| entry.row_text(&text))
        .map_err(|rule| refused(format!("{key} whose value {rule}")))?;
    Ok((key.to_string(), Some(text)))
}

/// Stores each archived setting the instance has none stored for, judged together with the
/// instance's own as `/config` judges them, and answers how many it stored and how many it left.
pub fn restore(
    tx: &Transaction<'_>,
    app: &App,
    archived: &[(String, String)],
) -> Result<(usize, usize)> {
    let mut stored = rows(tx)?;
    let held = archived.len();
    let added: Vec<&(String, String)> = archived
        .iter()
        .filter(|(key, _)| !stored.iter().any(|(held, _)| held == key))
        .collect();
    stored.extend(added.iter().map(|&row| row.clone()));
    let touched: Vec<&str> = added.iter().map(|(key, _)| key.as_str()).collect();
    super::config::judge_together(app, &stored, &touched)?;
    for (key, text) in &added {
        write_row(tx, key, text)?;
    }
    Ok((added.len(), held - added.len()))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::app::refusal::Code;
    use crate::settings::registry::{
        ENTRIES, MCP_FETCH_TIMEOUT_SECONDS, RATE_LIMIT_ENABLED, Value,
    };

    fn table() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        conn
    }

    #[test]
    fn one_setting_reads_its_row_then_its_seed_then_its_default() {
        let mut conn = table();
        let tx = conn.transaction().unwrap();
        let none = Seeds::new();
        let seeded = Seeds::from([(MCP_FETCH_TIMEOUT_SECONDS.entry.key, Value::Whole(5))]);
        assert_eq!(setting(&tx, &none, MCP_FETCH_TIMEOUT_SECONDS).unwrap(), 60);
        assert_eq!(setting(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(), 5);
        write_row(&tx, "mcp_fetch_timeout_seconds", "9").unwrap();
        assert_eq!(setting(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(), 9);
        write_row(&tx, "mcp_fetch_timeout_seconds", "").unwrap();
        assert_eq!(setting(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(), 5);
        assert!(setting(&tx, &seeded, RATE_LIMIT_ENABLED).unwrap());
    }

    #[test]
    fn a_row_that_does_not_read_falls_back_as_the_live_settings_do() {
        let mut conn = table();
        let tx = conn.transaction().unwrap();
        let seeded = Seeds::from([(MCP_FETCH_TIMEOUT_SECONDS.entry.key, Value::Whole(5))]);
        for broken in ["soon", "-1", "0", "3601"] {
            write_row(&tx, "mcp_fetch_timeout_seconds", broken).unwrap();
            let rows = rows(&tx).unwrap();
            let live = registry::Snapshot::resolve(&seeded, &rows, 0);
            assert_eq!(live.unreadable(), ["mcp_fetch_timeout_seconds"], "{broken}");
            assert_eq!(
                setting(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(),
                live.get(MCP_FETCH_TIMEOUT_SECONDS),
                "{broken}"
            );
            assert_eq!(live.get(MCP_FETCH_TIMEOUT_SECONDS), 5);
        }
    }

    #[test]
    fn a_deciding_row_that_does_not_read_refuses_and_an_absent_one_takes_its_seed() {
        let mut conn = table();
        let tx = conn.transaction().unwrap();
        let seeded = Seeds::from([(MCP_FETCH_TIMEOUT_SECONDS.entry.key, Value::Whole(5))]);
        assert_eq!(
            deciding(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(),
            5
        );
        write_row(&tx, "mcp_fetch_timeout_seconds", "").unwrap();
        assert_eq!(
            deciding(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap(),
            5
        );
        for broken in ["soon", "-1", "0", "3601"] {
            write_row(&tx, "mcp_fetch_timeout_seconds", broken).unwrap();
            let refused = deciding(&tx, &seeded, MCP_FETCH_TIMEOUT_SECONDS).unwrap_err();
            assert_eq!(refused.code, Code::InternalError, "{broken}");
        }
    }

    #[test]
    fn an_archived_line_for_a_setting_the_server_lacks_gives_no_text_and_one_for_an_address_is_refused()
     {
        let line = |key: &str| serde_json::json!({ "key": key, "value": 3_600_000 });
        assert_eq!(
            archived(&line("audit_cleanup_interval_ms")).unwrap(),
            ("audit_cleanup_interval_ms".to_string(), None)
        );
        assert_eq!(
            archived(&serde_json::json!({ "key": "trash_retention_days", "value": 7 })).unwrap(),
            ("trash_retention_days".to_string(), Some("7".to_string()))
        );
        for address in ["addresses", "sign_in_address"] {
            assert!(archived(&line(address)).is_err(), "{address}");
        }
        assert!(archived(&serde_json::json!({ "key": "trash_retention_days" })).is_err());
    }

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
