//! A folder's settings as one editable file, `.marfa/folder.yaml`
//! (`folders.md` 1): written from the `system.folder` the copy pins, and an
//! edit of it sent through the folder door at that file's version.

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::settings::{FOLDER_TYPE, Settings};
use super::{Folder, SETTINGS_FILE, STATE_DIR, document, state};
use crate::error::CoreError;
use crate::http::{Method, Outgoing};
use crate::{Core, Result, store};

/// The store's record of which `system.folder` this directory follows.
const META_FOLDER: &str = "folder_id";
/// The text last written to the settings file, and the version it was
/// written from: an edit is what differs from it, based on that version.
const META_WRITTEN: &str = "folder_file";
const META_WRITTEN_VERSION: &str = "folder_file_version";
/// The file text the door or the folder refused, and why, so the same
/// refused text is flagged rather than sent again.
const META_REFUSED: &str = "folder_file_refused";

/// Keys the file carries beside the settings, naming what it was written
/// from; never sent.
const FOLDER_KEY: &str = "folder";
const VERSION_KEY: &str = "version";

const HEADER: &str = "# This folder's settings, the system.folder it follows. An edit here is\n# sent through the folder door by `folders push`, or while watching.\n";

/// What became of the settings file in a pass.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SettingsFileReport {
    /// An edit of the file went through the folder door and landed.
    pub sent: bool,
    /// The file was written from the settings the copy holds.
    pub written: bool,
    /// Why the file's edit is not in force, where it is not: the settings
    /// the copy holds stay in force meanwhile.
    pub flagged: Option<String>,
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

    /// Writes the settings out, recording the text before the bytes land so
    /// a watch never reads the write back as an edit (`folders.md` 16).
    pub(super) fn write_settings_file(
        &self,
        properties: &Map<String, Value>,
        version: i64,
    ) -> Result<()> {
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
            store::meta_set(&conn, META_WRITTEN, &text)?;
            store::meta_set(&conn, META_WRITTEN_VERSION, &version.to_string())?;
            store::meta_delete(&conn, META_REFUSED)?;
        }
        let path = self.settings_path();
        std::fs::write(&path, text)
            .map_err(|error| CoreError::Store(format!("cannot write {}: {error}", path.display())))
    }

    /// The file's text where the person changed it since it was written.
    fn edited_settings(&self) -> Result<Option<String>> {
        let Ok(found) = std::fs::read_to_string(self.settings_path()) else {
            return Ok(None);
        };
        let written = store::meta_get(&*self.core.conn()?, META_WRITTEN)?;
        Ok((written.as_deref() != Some(found.as_str())).then_some(found))
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

    /// Rewrites the file where the settings the copy holds moved on since it
    /// was written, unless the person changed it: that is their edit, and it
    /// is sent first.
    pub fn write_settings_if_moved(&self) -> Result<SettingsFileReport> {
        if let Some(edited) = self.edited_settings()? {
            return Ok(SettingsFileReport {
                flagged: self.refused_for(&edited)?,
                ..Default::default()
            });
        }
        let Some(row) = self.core.get(&self.folder)? else {
            return Ok(SettingsFileReport::default());
        };
        let written = store::meta_get(&*self.core.conn()?, META_WRITTEN_VERSION)?;
        if written.as_deref() == Some(row.version.to_string().as_str())
            && self.settings_path().exists()
        {
            return Ok(SettingsFileReport::default());
        }
        self.write_settings_file(&row.properties, row.version)?;
        Ok(SettingsFileReport {
            written: true,
            ..Default::default()
        })
    }

    /// Sends the person's edit of the settings file through the folder door,
    /// based on the version the file was written from, so the door merges it
    /// (`items.md` 51). A refused edit, or a file that does not parse, keeps
    /// the settings in force and is flagged with the reason.
    pub fn send_settings_edit(&self) -> Result<SettingsFileReport> {
        let Some(text) = self.edited_settings()? else {
            return Ok(SettingsFileReport::default());
        };
        if let Some(reason) = self.refused_for(&text)? {
            return Ok(SettingsFileReport {
                flagged: Some(reason),
                ..Default::default()
            });
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
        let (written, version) = {
            let conn = self.core.conn()?;
            (
                store::meta_get(&conn, META_WRITTEN)?.unwrap_or_default(),
                store::meta_get(&conn, META_WRITTEN_VERSION)?
                    .and_then(|version| version.parse::<i64>().ok())
                    .unwrap_or(0),
            )
        };
        let base = document::read_map(&written).unwrap_or_default();
        let setting = |key: &String| key != FOLDER_KEY && key != VERSION_KEY;
        if let Some(gone) = base
            .keys()
            .find(|key| setting(key) && !edited.contains_key(*key))
        {
            return self.flag(
                &text,
                format!(
                    "the file no longer names {gone}; the folder door replaces a setting and never removes one, so write it an empty value instead"
                ),
            );
        }
        let changed: Map<String, Value> = edited
            .iter()
            .filter(|(key, value)| setting(key) && base.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if changed.is_empty() {
            let Some(row) = self.core.get(&self.folder)? else {
                return Ok(SettingsFileReport::default());
            };
            self.write_settings_file(&row.properties, row.version)?;
            return Ok(SettingsFileReport {
                written: true,
                ..Default::default()
            });
        }
        // Refused here rather than sent: the door would take a search this
        // folder cannot answer, and every pass after would stop on it.
        let mut merged = base.clone();
        merged.retain(|key, _| setting(key));
        merged.extend(changed.clone());
        if let Err(error) = Settings::read(&self.folder, FOLDER_TYPE, "active", &merged) {
            return self.flag(&text, error.to_string());
        }
        let mut body = changed;
        body.insert(VERSION_KEY.into(), Value::from(version));
        let body = Value::Object(body).to_string();
        // The same edit keeps its key, so one whose answer was lost is
        // answered from the server's record.
        let key = format!("{}-settings-{}", self.folder, state::hash(body.as_bytes()));
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
            let refused =
                crate::http::refusal(answer.status, &answer.body, answer.retry_after_seconds);
            return self.flag(&text, format!("the folder door refused it: {refused}"));
        }
        let row: crate::wire::WireItemWithMetadata = serde_json::from_str(&answer.body)?;
        {
            let mut conn = self.core.conn()?;
            let tx = conn.transaction()?;
            let catalog = crate::catalog::Catalog::load(&tx)?;
            crate::hydrate::hold_row(&tx, &catalog, &row, &[])?;
            tx.commit()?;
        }
        self.write_settings_file(&row.item.properties, row.item.version)?;
        Ok(SettingsFileReport {
            sent: true,
            written: true,
            flagged: None,
        })
    }
}
