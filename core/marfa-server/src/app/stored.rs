//! The `settings` table: registry values and the server's own notes.

use std::future::Future;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

use super::access::Levers;
use super::refusal::{Refusal, Result};
use super::{App, provenance};
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
    /// A job's interval or switch may be a setting, so the scheduler looks again, and the store
    /// beside the disk follows its settings. A store the settings newly name is taken before this
    /// returns, so what is answered next sees it; one that failed before is tried again behind.
    pub async fn publish(self, app: &Arc<App>) {
        app.settings.publish(self.generation, &self.rows);
        super::housekeeping::wake(app);
        let wanted = super::blobs::Wanted::of(&app.settings.live());
        if app.blobs.follows(&wanted) {
            return;
        }
        if app.blobs.names(&wanted) {
            let app = app.clone();
            tokio::spawn(async move { app.follow_stores().await });
        } else {
            app.follow_stores().await;
        }
    }
}

/// Runs as a task of its own so the publish outlives a caller who goes away.
pub async fn committing<T, F>(app: &Arc<App>, write: F) -> Result<T>
where
    T: Send + 'static,
    F: Future<Output = Result<(T, Option<Staged>)>> + Send + 'static,
{
    let app = app.clone();
    tokio::spawn(provenance::carried(async move {
        match write.await {
            Ok((value, staged)) => {
                if let Some(staged) = staged {
                    staged.publish(&app).await;
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
    }))
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
        Ok(staged) => staged.publish(app).await,
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
const NOTES: [&str; 1] = [super::config::ENFORCEMENT_ROW];

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

/// What an archive line says of one setting.
#[derive(Debug, PartialEq, Eq)]
pub enum Archived {
    /// A setting this server lacks, which the restore leaves out.
    Unknown,
    Value(String),
    /// A secret that was set, which an archive names without its value.
    Secret,
}

/// A line naming a setting kept by the machine is a damaged archive, as is one that carries a
/// secret's value.
pub fn archived(line: &serde_json::Value) -> Result<(String, Archived)> {
    let key = line
        .get("key")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let refused =
        |why: String| Refusal::validation(format!("The archive carries a setting {why}."));
    let Some(entry) = registry::entry(key) else {
        return Ok((key.to_string(), Archived::Unknown));
    };
    if entry.named_without_value() {
        if line.get("value").is_some() || line.get("secret") != Some(&serde_json::Value::Bool(true))
        {
            return Err(refused(format!("{key} that is a secret, with its value")));
        }
        return Ok((key.to_string(), Archived::Secret));
    }
    if !entry.carried() {
        return Err(refused(format!("this instance does not take: {key}")));
    }
    let value = line
        .get("value")
        .ok_or_else(|| refused(format!("with no value: {key}")))?;
    let text = entry
        .row_text_of_json(value)
        .and_then(|text| entry.row_text(&text))
        .map_err(|rule| refused(format!("{key} whose value {rule}")))?;
    Ok((key.to_string(), Archived::Value(text)))
}

/// The text a secret's row holds when an archive said it was set and this instance had none: it
/// never opens, so the secret is listed as one to set again.
const SET_AGAIN: &str = "set-again";

/// What a restore did with the archive's settings.
#[derive(Debug, Default)]
pub struct Restored {
    pub added: usize,
    pub skipped: usize,
    /// Reporting switches stored on that send nothing, because this server names no receiver.
    pub without_receiver: Vec<&'static str>,
    /// Secrets the archive's instance had set that this instance cannot read.
    pub secrets_to_set: Vec<String>,
}

impl Restored {
    /// Whether the restore changed the settings table.
    pub fn changed(&self) -> bool {
        self.added > 0 || !self.secrets_to_set.is_empty()
    }
}

/// Stores each archived setting the instance has none stored for, judged together with the
/// instance's own as `/config` judges them, and counts how many it stored and how many it left.
/// Each archived secret this instance holds no readable value for is listed to be set again.
pub fn restore(
    tx: &Transaction<'_>,
    app: &App,
    archived: &[(String, String)],
    secrets: &[String],
) -> Result<Restored> {
    let before = rows(tx)?;
    let readable = app.settings.candidate(&before);
    let mut secrets_to_set = Vec::new();
    for key in secrets {
        let Some(entry) = registry::entry(key) else {
            continue;
        };
        if readable.secret_set(entry) {
            continue;
        }
        if !before.iter().any(|(held, _)| held == key) {
            write_row(tx, key, SET_AGAIN)?;
        }
        secrets_to_set.push(key.clone());
    }
    let added: Vec<&(String, String)> = archived
        .iter()
        .filter(|(key, _)| !before.iter().any(|(held, _)| held == key))
        .collect();
    let mut after = before.clone();
    after.extend(added.iter().map(|&row| row.clone()));
    let touched: Vec<&str> = added.iter().map(|(key, _)| key.as_str()).collect();
    super::config::judge_together(app, &before, &after, &touched)?;
    for (key, text) in &added {
        write_row(tx, key, text)?;
    }
    let now = app.settings.candidate(&rows(tx)?);
    let without_receiver = [
        registry::HEARTBEAT_ENABLED.entry.key,
        registry::ERROR_REPORTING_ENABLED.entry.key,
    ]
    .into_iter()
    .filter(|switch| {
        added
            .iter()
            .any(|(key, text)| key == switch && text == "true")
            && crate::settings::together::lacks_receiver(&app.settings.start, &now, switch)
    })
    .collect();
    Ok(Restored {
        added: added.len(),
        skipped: archived.len() - added.len(),
        without_receiver,
        secrets_to_set,
    })
}

/// What a restore did with the archive's enforcement settings, each by name.
#[derive(Debug, Default)]
pub struct RestoredLevers {
    pub added: Vec<String>,
    pub skipped: Vec<String>,
}

/// Stores each archived enforcement setting the instance does not store and keeps each it does.
/// Stored levers that do not read keep every one, since what they hold is not known.
pub fn restore_enforcement(
    tx: &Transaction<'_>,
    archived: &serde_json::Map<String, serde_json::Value>,
) -> Result<RestoredLevers> {
    let names = || archived.keys().cloned().collect::<Vec<_>>();
    let mut held = match get(tx, super::config::ENFORCEMENT_ROW)? {
        None => serde_json::Map::new(),
        Some(text) => match Levers::from_row(&text) {
            Some(levers) => match levers.to_json() {
                serde_json::Value::Object(held) => held,
                _ => return Err(Refusal::internal("stored levers read as no object")),
            },
            None => {
                return Ok(RestoredLevers {
                    added: Vec::new(),
                    skipped: names(),
                });
            }
        },
    };
    let mut restored = RestoredLevers::default();
    for (name, setting) in archived {
        if held.contains_key(name) {
            restored.skipped.push(name.clone());
        } else {
            held.insert(name.clone(), setting.clone());
            restored.added.push(name.clone());
        }
    }
    if !restored.added.is_empty() {
        let levers = Levers::from_body_at(&serde_json::Value::Object(held), "enforcement")?;
        put(
            tx,
            super::config::ENFORCEMENT_ROW,
            &levers.to_json().to_string(),
        )?;
    }
    Ok(restored)
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
        conn.execute_batch(crate::db::migrate::MIGRATIONS[0].sql)
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
            let live = registry::Snapshot::resolve(&seeded, None, &rows, 0);
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
    fn an_archived_line_for_a_setting_the_server_lacks_gives_no_text_and_one_kept_by_the_machine_is_refused()
     {
        let line = |key: &str| serde_json::json!({ "key": key, "value": 3_600_000 });
        assert_eq!(
            archived(&line("audit_cleanup_interval_ms")).unwrap(),
            ("audit_cleanup_interval_ms".to_string(), Archived::Unknown)
        );
        assert_eq!(
            archived(&serde_json::json!({ "key": "trash_retention_days", "value": 7 })).unwrap(),
            (
                "trash_retention_days".to_string(),
                Archived::Value("7".to_string())
            )
        );
        for machine in [
            "addresses",
            "sign_in_address",
            "backup_path",
            "object_store_bucket",
            "allow_private_addresses",
        ] {
            assert!(archived(&line(machine)).is_err(), "{machine}");
        }
        let machine_secret =
            serde_json::json!({ "key": "object_store_secret_access_key", "secret": true });
        assert!(archived(&machine_secret).is_err());
        assert_eq!(
            archived(&serde_json::json!({ "key": "heartbeat_url", "secret": true })).unwrap(),
            ("heartbeat_url".to_string(), Archived::Secret)
        );
        assert!(
            archived(&serde_json::json!({ "key": "heartbeat_url", "value": "https://a.example" }))
                .is_err()
        );
        assert!(archived(&serde_json::json!({ "key": "trash_retention_days" })).is_err());
    }

    #[test]
    fn a_note_cannot_take_a_settings_row() {
        let mut conn = table();
        let tx = conn.transaction().unwrap();
        for entry in ENTRIES {
            assert!(put(&tx, entry.key, "note").is_err(), "{}", entry.key);
        }
        put(&tx, crate::app::config::ENFORCEMENT_ROW, "note").unwrap();
        assert_eq!(rows(&tx).unwrap().len(), 1);
    }
}
