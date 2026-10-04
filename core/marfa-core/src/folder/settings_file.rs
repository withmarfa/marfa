use serde::Serialize;
use serde_json::{Map, Value, json};

use super::settings::{FOLDER_TYPE, Settings};
use super::{Folder, SETTINGS_FILE, STATE_DIR, document, landing, state};
use crate::http::{Method, Outgoing};
use crate::{Core, CoreError, Result, store};

const META_FOLDER: &str = "folder_id";
const META_WRITTEN: &str = "folder_file";
const META_WRITTEN_VERSION: &str = "folder_file_version";
/// Kept so the same refused text is flagged rather than sent again.
const META_REFUSED: &str = "folder_file_refused";
/// The text and version written before, kept while a write has not landed.
const META_LANDING: &str = "folder_file_landing";

/// Keys the file carries beside the settings; never sent.
const FOLDER_KEY: &str = "folder";
const VERSION_KEY: &str = "version";

const HEADER: &str = "# This folder's settings, the system.folder it follows. An edit here is\n# sent through the folder door by `folders push`, or while watching.\n";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SettingsFileReport {
    pub sent: bool,
    pub written: bool,
    pub flagged: Option<String>,
    /// Why the file could not be written, a full disk say; the next pass
    /// writes it.
    pub unwritten: Option<String>,
}

/// What became of a write of the settings file.
pub(super) enum Wrote {
    Written,
    /// The person changed the file meanwhile, and it stays as their edit.
    Overtaken,
    Failed(String),
}

impl Wrote {
    fn report(self, sent: bool) -> SettingsFileReport {
        SettingsFileReport {
            sent,
            written: matches!(self, Wrote::Written),
            flagged: None,
            unwritten: match self {
                Wrote::Failed(reason) => Some(reason),
                _ => None,
            },
        }
    }
}

pub(super) fn bound(core: &Core) -> Result<Option<String>> {
    store::meta_get(&*core.conn()?, META_FOLDER)
}

pub(super) fn bind(core: &Core, folder: &str) -> Result<()> {
    store::meta_set(&*core.conn()?, META_FOLDER, folder)
}

impl Folder {
    fn settings_path(&self) -> std::path::PathBuf {
        self.root.join(STATE_DIR).join(SETTINGS_FILE)
    }

    /// Records the text before the bytes land, so a watch never reads the
    /// write back as an edit, and keeps the text before it until they do, so
    /// a crash in between leaves the old file the folder's own. `over` is the
    /// text the file must still hold, or no file at all; with none, whatever
    /// is there is replaced. A file changed from `over` meanwhile is the
    /// person's edit, and stays.
    pub(super) fn write_settings_file(
        &self,
        properties: &Map<String, Value>,
        version: i64,
        over: Option<&str>,
    ) -> Result<Wrote> {
        let mut map = Map::new();
        map.insert(FOLDER_KEY.into(), Value::String(self.folder.clone()));
        map.insert(VERSION_KEY.into(), Value::from(version));
        for (key, value) in properties {
            if key != "revoked_at" {
                map.insert(key.clone(), value.clone());
            }
        }
        let text = format!("{HEADER}{}", document::write_map(&map)?);
        {
            let conn = self.core.conn()?;
            let before = json!({
                "text": store::meta_get(&conn, META_WRITTEN)?,
                "version": store::meta_get(&conn, META_WRITTEN_VERSION)?,
            });
            store::meta_set(&conn, META_LANDING, &before.to_string())?;
            store::meta_set(&conn, META_WRITTEN, &text)?;
            store::meta_set(&conn, META_WRITTEN_VERSION, &version.to_string())?;
        }
        let path = self.settings_path();
        let landed = self.land(
            &path,
            |file, _| std::io::Write::write_all(file, text.as_bytes()),
            |found| match (over, found) {
                (None, _) | (Some(_), None) => true,
                (Some(over), Some(found)) => found == over.as_bytes(),
            },
        );
        if landed.is_ok() {
            let conn = self.core.conn()?;
            store::meta_delete(&conn, META_LANDING)?;
            store::meta_delete(&conn, META_REFUSED)?;
            return Ok(Wrote::Written);
        }
        // Left as the old text, the file would read as an edit of the new.
        self.put_settings_back()?;
        Ok(match landed {
            Err(landing::Unlanded::Failed(error)) => {
                Wrote::Failed(format!("cannot write {}: {error}", path.display()))
            }
            _ => Wrote::Overtaken,
        })
    }

    /// Puts back the text and version written before a write that did not
    /// land.
    fn put_settings_back(&self) -> Result<()> {
        let conn = self.core.conn()?;
        let Some(before) = store::meta_get(&conn, META_LANDING)? else {
            return Ok(());
        };
        let before: Value = serde_json::from_str(&before)?;
        for (key, value) in [
            (META_WRITTEN, &before["text"]),
            (META_WRITTEN_VERSION, &before["version"]),
        ] {
            match value.as_str() {
                Some(value) => store::meta_set(&conn, key, value)?,
                None => store::meta_delete(&conn, key)?,
            }
        }
        store::meta_delete(&conn, META_LANDING)
    }

    /// Settles a write a crash cut off between its record and its landing.
    fn settle_settings(&self) -> Result<()> {
        let (landing, written) = {
            let conn = self.core.conn()?;
            (
                store::meta_get(&conn, META_LANDING)?,
                store::meta_get(&conn, META_WRITTEN)?,
            )
        };
        if landing.is_none() {
            return Ok(());
        }
        let found = std::fs::read(self.settings_path()).ok();
        if found.is_some() && found.as_deref() == written.as_deref().map(str::as_bytes) {
            return store::meta_delete(&*self.core.conn()?, META_LANDING);
        }
        self.put_settings_back()
    }

    /// The text, and why the bytes are not text where they are not: the text
    /// of bytes that are not only names the edit, and is never sent.
    fn edited_settings(&self) -> Result<Option<(String, Option<&'static str>)>> {
        self.settle_settings()?;
        let Ok(found) = std::fs::read(self.settings_path()) else {
            return Ok(None);
        };
        let (found, not_text) = match super::text_of(&found) {
            Ok(text) => (text.to_string(), None),
            Err(reason) => (String::from_utf8_lossy(&found).into_owned(), Some(reason)),
        };
        let written = store::meta_get(&*self.core.conn()?, META_WRITTEN)?;
        Ok(
            (not_text.is_some() || written.as_deref() != Some(found.as_str()))
                .then_some((found, not_text)),
        )
    }

    fn refused_for(&self, text: &str) -> Result<Option<String>> {
        let Some(json) = store::meta_get(&*self.core.conn()?, META_REFUSED)? else {
            return Ok(None);
        };
        let refused: Value = serde_json::from_str(&json)?;
        Ok((refused["text"] == text)
            .then(|| refused["reason"].as_str().unwrap_or_default().to_string()))
    }

    fn flag(&self, text: &str, reason: String) -> Result<SettingsFileReport> {
        store::meta_set(
            &*self.core.conn()?,
            META_REFUSED,
            &json!({ "text": text, "reason": reason }).to_string(),
        )?;
        Ok(SettingsFileReport {
            flagged: Some(reason),
            ..Default::default()
        })
    }

    /// Leaves a file the person changed alone: that is their edit, and it is
    /// sent first.
    pub fn write_settings_if_moved(&self) -> Result<SettingsFileReport> {
        if self.root_gone().is_some() {
            return Ok(SettingsFileReport::default());
        }
        if let Some((edited, _)) = self.edited_settings()? {
            return Ok(SettingsFileReport {
                flagged: self.refused_for(&edited)?,
                ..Default::default()
            });
        }
        let Some(row) = self.core.get(&self.folder)? else {
            return Ok(SettingsFileReport::default());
        };
        let (written, version) = {
            let conn = self.core.conn()?;
            (
                store::meta_get(&conn, META_WRITTEN)?,
                store::meta_get(&conn, META_WRITTEN_VERSION)?,
            )
        };
        if version.as_deref() == Some(row.version.to_string().as_str())
            && self.settings_path().exists()
        {
            return Ok(SettingsFileReport::default());
        }
        Ok(self
            .write_settings_file(
                &row.properties,
                row.version,
                Some(written.as_deref().unwrap_or_default()),
            )?
            .report(false))
    }

    /// A refused edit, or a file that does not parse, is flagged in the report
    /// rather than returned as an error, and the settings in force stay.
    pub fn send_settings_edit(&self) -> Result<SettingsFileReport> {
        self.refuse_while_waiting()?;
        // The scan says so; a file read from where the folder was is not its.
        if self.root_gone().is_some() {
            return Ok(SettingsFileReport::default());
        }
        let Some((text, not_text)) = self.edited_settings()? else {
            return Ok(SettingsFileReport::default());
        };
        if let Some(reason) = self.refused_for(&text)? {
            return Ok(SettingsFileReport {
                flagged: Some(reason),
                ..Default::default()
            });
        }
        if let Some(reason) = not_text {
            return self.flag(&text, format!("the file is held and not sent: {reason}"));
        }
        let edited = match document::read_map(&text) {
            Ok(edited) => edited,
            Err(reason) => return self.flag(&text, format!("the file does not parse: {reason}")),
        };
        if edited
            .get(FOLDER_KEY)
            .is_some_and(|named| named.as_str() != Some(self.folder.as_str()))
        {
            return self.flag(
                &text,
                format!(
                    "the file names another folder, and this directory follows {}; `folders add` binds a directory",
                    self.folder
                ),
            );
        }
        let (written, written_version) = {
            let conn = self.core.conn()?;
            (
                store::meta_get(&conn, META_WRITTEN)?.unwrap_or_default(),
                store::meta_get(&conn, META_WRITTEN_VERSION)?
                    .and_then(|version| version.parse::<i64>().ok())
                    .unwrap_or(0),
            )
        };
        // Based on the file's own line: an editor saving text older than the
        // last write is merged against what it was written from.
        let version = edited
            .get(VERSION_KEY)
            .and_then(super::version_named)
            .unwrap_or(written_version);
        let base = document::read_map(&written).unwrap_or_default();
        let setting = |key: &String| key != FOLDER_KEY && key != VERSION_KEY;
        // A file naming the settings in force changes none, whatever its line.
        let in_force = edited.iter().filter(|(key, _)| setting(key)).count()
            == base.keys().filter(|key| setting(key)).count()
            && edited
                .iter()
                .all(|(key, value)| !setting(key) || base.get(key) == Some(value));
        let stale = version != written_version && !in_force;
        // What a stale file leaves out may be what was added since; the door
        // keeps a setting nobody sends.
        if !stale
            && let Some(gone) = base
                .keys()
                .find(|key| setting(key) && !edited.contains_key(*key))
        {
            return self.flag(
                &text,
                format!(
                    "the file no longer names {gone}; the folder door replaces a setting and never removes one, so write it empty instead, as `[]` for a list or `{{}}` for a map"
                ),
            );
        }
        // A stale file sends every setting it names, and the door merges
        // away those unchanged since its version.
        let changed: Map<String, Value> = edited
            .iter()
            .filter(|(key, value)| setting(key) && (stale || base.get(*key) != Some(*value)))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if changed.is_empty() {
            let Some(row) = self.core.get(&self.folder)? else {
                return Ok(SettingsFileReport::default());
            };
            return Ok(self
                .write_settings_file(&row.properties, row.version, Some(&text))?
                .report(false));
        }
        // Refused here rather than sent: the door would take a search this
        // folder cannot answer, and every pass after would stop on it.
        let mut merged = base.clone();
        merged.retain(|key, _| setting(key));
        merged.extend(changed.clone());
        let checked =
            Settings::read(&self.folder, FOLDER_TYPE, "active", &merged).and_then(|settings| {
                settings.check_types(&crate::catalog::Catalog::load(&*self.core.conn()?)?)
            });
        if let Err(error) = checked {
            return self.flag(&text, error.to_string());
        }
        let mut body = changed;
        body.insert(VERSION_KEY.into(), Value::from(version));
        let body = Value::Object(body).to_string();
        // The same edit keeps its key, so one whose answer was lost is
        // answered from the server's record.
        let key = format!("{}-settings-{}", self.folder, state::hash(body.as_bytes()));
        // Held to the instance as a drain's sends are: never sent while it is
        // unconfirmed.
        match crate::catch_up::refuse_another_instance(&self.core, self.core.http()?) {
            Ok(()) => {}
            Err(error) if error.is_environmental() => {
                return Ok(SettingsFileReport {
                    flagged: Some(format!(
                        "not sent yet: the server could not say which instance it is ({error})"
                    )),
                    ..Default::default()
                });
            }
            Err(error) => return Err(error),
        }
        let context = crate::read_view::Context::capture(&*self.core.conn()?)?;
        let answer = self.core.http()?.send(&Outgoing {
            method: Method::Patch,
            segments: vec!["folders".into(), self.folder.clone()],
            params: Vec::new(),
            body: &body,
            idempotency_key: &key,
        });
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) if error.is_environmental() => {
                return Ok(SettingsFileReport {
                    flagged: Some(format!("not sent yet: {error}")),
                    ..Default::default()
                });
            }
            Err(error) => return Err(error),
        };
        if !answer.is_success() {
            let http = self.core.http()?;
            let refused = http.refused(
                answer.status,
                answer.contract_named,
                &answer.body,
                answer.retry_after_seconds,
            );
            // Only the door's own answers about this edit are a refusal; a
            // failing server, a rate limit, a spent key or anything in front
            // of the server is tried again.
            if answer.is_environmental() || !matches!(answer.status, 400 | 403 | 404 | 409 | 422) {
                return Ok(SettingsFileReport {
                    flagged: Some(format!("not sent yet: {refused}")),
                    ..Default::default()
                });
            }
            let back = if answer.status == 409 {
                "; delete the file to take back the settings in force, then edit it again"
            } else {
                ""
            };
            return self.flag(
                &text,
                format!("the folder door refused it: {refused}{back}"),
            );
        }
        let row = context
            .http(self.core.http()?)
            .item(&self.folder)
            .map_err(|error| {
                context
                    .failed(&self.core, error)
                    .unwrap_or_else(|error| error)
            })?
            .ok_or_else(|| CoreError::NotFound {
                code: "item_not_found".into(),
                message: "The accepted folder settings are not returned to this read view.".into(),
            })?;
        {
            let mut conn = self.core.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let catalog = crate::catalog::Catalog::load(&tx)?;
            crate::hydrate::hold_row(&tx, &catalog, &row, &[])?;
            tx.commit()?;
        }
        context.check(&*self.core.conn()?)?;
        Ok(self
            .write_settings_file(&row.item.properties, row.item.version, Some(&text))?
            .report(true))
    }
}
