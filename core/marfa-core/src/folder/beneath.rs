//! A folder whose query narrows beneath the path of one of its own files,
//! until that file has an item whose id can take the path's place.

use std::path::Path;

use marfa_rules::names;
use serde_json::{Map, Value};

use super::settings::Settings;
use super::{Folder, STATE_DIR, state};
use crate::directory::{Directory, FileType};
use crate::error::CoreError;
use crate::http::ByIdRead;
use crate::{Result, catch_up, store};

/// What a pass did about a folder narrowed beneath a file of its own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BeneathReport {
    /// The path the folder's query named.
    pub path: String,
    /// The item the folder now narrows beneath, once the pass has written
    /// its id in the path's place.
    pub resolved: Option<String>,
    /// Why the path still names no item.
    pub waiting: Option<String>,
}

/// How a scan judges new files while the query narrows beneath a path.
pub(super) enum PendingBeneath {
    /// The query names no path.
    No,
    /// The file has no item yet; only the file at this on-disk path is known
    /// to lie beneath it.
    Unbound(Option<String>),
    /// The file has an item the query does not name yet: the settings that do.
    Bound(Box<Settings>),
}

/// Version conflicts met in a row before a pass leaves the rest to the next.
const ATTEMPTS: usize = 3;

/// The path and why it still names no item, as the last pass that tried found.
const META_BENEATH_WAITING: &str = "folder_beneath_waiting";

impl Folder {
    /// The path the query narrows beneath while its file has no item.
    pub fn beneath_waiting(&self) -> Option<String> {
        self.settings()
            .ok()
            .and_then(|settings| settings.pending_beneath().map(str::to_string))
    }

    /// Why the path the query narrows beneath still names no item, as the
    /// last pass that tried to name it found.
    pub fn beneath_waiting_reason(&self) -> Result<Option<String>> {
        let Some(path) = self.beneath_waiting() else {
            return Ok(None);
        };
        let Some(kept) = store::meta_get(&*self.core.conn()?, META_BENEATH_WAITING)? else {
            return Ok(None);
        };
        let Ok((said, why)) = serde_json::from_str::<(String, String)>(&kept) else {
            return Ok(None);
        };
        Ok(names::same(&said, &path).then_some(why))
    }

    pub(super) fn bound_beneath(&self, path: &str) -> Result<Option<state::Bound>> {
        let conn = self.core.conn()?;
        if let Some(bound) = state::bound_at(&conn, path)? {
            return Ok(Some(bound));
        }
        for (held, _) in state::bound_paths(&conn)? {
            if names::same(&held, path) {
                return state::bound_at(&conn, &held);
            }
        }
        Ok(None)
    }

    pub(super) fn pending_beneath_of(&self, settings: &Settings) -> Result<PendingBeneath> {
        let Some(path) = settings.pending_beneath() else {
            return Ok(PendingBeneath::No);
        };
        Ok(match self.bound_beneath(path)? {
            Some(bound) => PendingBeneath::Bound(Box::new(settings.beneath_item(&bound.item_id))),
            None => PendingBeneath::Unbound(self.file_named(path)),
        })
    }

    /// The on-disk path of the file `path` names by `names::same`. Of several
    /// that match, the first in the scan's order is the one the folder keeps
    /// (`one_per_name`); a link or a folder is never the file.
    pub(super) fn file_named(&self, path: &str) -> Option<String> {
        let parts: Vec<&str> = path.split('/').collect();
        if names::same(parts.first()?, STATE_DIR) {
            return None;
        }
        named_in(&self.root_dir, &parts, "")
    }

    /// Why no pass could send the file at `path`, where none could.
    fn unsendable(&self, settings: &Settings, path: &str) -> Result<Option<String>> {
        let Some(on_disk) = self.file_named(path) else {
            return Ok(Some(format!(
                "there is no such file in {}",
                self.root.display()
            )));
        };
        let path = on_disk.as_str();
        if !settings.lists()?.takes(path) {
            return Ok(Some(
                "the folder's include and ignore lists do not take it".into(),
            ));
        }
        let catalog = crate::catalog::load(&*self.core.conn()?)?;
        if !self.pushes(Path::new(path), settings, &catalog) {
            return Ok(Some(
                "the folder's query holds no type of item that file becomes".into(),
            ));
        }
        Ok(None)
    }

    /// Why `settings` narrow beneath a file no pass could send, where they do.
    pub(super) fn beneath_refusal(&self, settings: &Settings) -> Result<Option<String>> {
        let Some(path) = settings.pending_beneath() else {
            return Ok(None);
        };
        if self.bound_beneath(path)?.is_some() {
            return Ok(None);
        }
        Ok(self.unsendable(settings, path)?.map(|why| {
            format!(
                "the folder narrows beneath the file {path}, and {why}; put the file there, or change `query.beneath` with `marfa folders update`"
            )
        }))
    }

    /// Refuses, before anything is sent or written, a query that narrows
    /// beneath a file no pass could send.
    pub(super) fn check_beneath_file(&self) -> Result<()> {
        match self.beneath_refusal(&self.settings()?)? {
            Some(refusal) => Err(CoreError::Invalid(refusal)),
            None => Ok(()),
        }
    }

    /// Writes the id of the item the file became in the place of the path in
    /// `query.beneath`, once the server holds it. `None` where the query names
    /// no path; what stops it is reported, kept for the folder's status, and
    /// the next pass tries again.
    pub(super) fn resolve_beneath(&self) -> Result<Option<BeneathReport>> {
        let report = self.name_file_beneath()?;
        let waiting = report
            .as_ref()
            .and_then(|said| Some((&said.path, said.waiting.as_ref()?)))
            .map(|waiting| serde_json::to_string(&waiting))
            .transpose()?;
        let conn = self.core.conn()?;
        // Only a change is written, so a pass that finds the same reason
        // leaves the store as it was.
        if store::meta_get(&conn, META_BENEATH_WAITING)? != waiting {
            match &waiting {
                Some(kept) => store::meta_set(&conn, META_BENEATH_WAITING, kept)?,
                None => store::meta_delete(&conn, META_BENEATH_WAITING)?,
            }
        }
        Ok(report)
    }

    fn name_file_beneath(&self) -> Result<Option<BeneathReport>> {
        let Ok(settings) = self.settings() else {
            return Ok(None);
        };
        let Some(path) = settings.pending_beneath().map(str::to_string) else {
            return Ok(None);
        };
        let waiting = |why: String| {
            Ok(Some(BeneathReport {
                path: path.clone(),
                resolved: None,
                waiting: Some(why),
            }))
        };
        let Some(bound) = self.bound_beneath(&path)? else {
            let why = match self.unsendable(&settings, &path)? {
                Some(why) => why,
                None => "the folder has not sent it yet".into(),
            };
            return waiting(format!("the file has no item: {why}"));
        };
        let item = {
            let http = self.core.http()?;
            catch_up::read_confirming(&self.core, http, |http| http.item_answered(&bound.item_id))
        };
        let why = match item {
            Ok(ByIdRead::Row(row)) if matches!(row.item.state.as_str(), "active" | "archived") => {
                return self.name_beneath(&path, &bound.item_id);
            }
            Ok(ByIdRead::Row(_)) => "its item is in the bin".to_string(),
            Ok(ByIdRead::Absent(_)) => match (&bound.held, bound.writes.refused.first()) {
                (Some(held), _) => format!("the folder holds the file back: {held}"),
                (None, Some(refused)) => format!("the server refused it: {}", refused.reason),
                (None, None) => "the server holds no item for it yet".to_string(),
            },
            Err(error) if error.is_environmental() => format!("not sent yet: {error}"),
            Err(error) => return Err(error),
        };
        waiting(format!("the file has no item: {why}"))
    }

    /// Replaces the path in the query with `item` on the version the server
    /// holds. After a version conflict the folder is read again: an id already
    /// named there is accepted, and a path still named is replaced.
    fn name_beneath(&self, path: &str, item: &str) -> Result<Option<BeneathReport>> {
        let report = |resolved: Option<String>, waiting: Option<String>| {
            Ok(Some(BeneathReport {
                path: path.to_string(),
                resolved,
                waiting,
            }))
        };
        for _ in 0..ATTEMPTS {
            let row = self.row_on_server()?;
            let now = Settings::of_wire(&row.item)?;
            match now.pending_beneath() {
                None => {
                    // Named meanwhile, by another machine or by hand.
                    let named = now.query.beneath.clone();
                    self.core.hold_answered(&self.folder, self.core.http()?);
                    return report(named, None);
                }
                Some(other) if !names::same(other, path) => {
                    return report(
                        None,
                        Some(format!("the query now narrows beneath {other}, not {path}")),
                    );
                }
                Some(_) => {}
            }
            let mut query = match row.item.properties.get("query") {
                Some(Value::Object(query)) => query.clone(),
                _ => Map::new(),
            };
            query.insert("beneath".into(), Value::String(item.to_string()));
            let mut changes = Map::new();
            changes.insert("query".into(), Value::Object(query));
            let key = format!("{}-beneath-{item}-{}", self.folder, row.item.version);
            match self
                .core
                .change_folder(&self.folder, &changes, row.item.version, Some(&key))
            {
                Ok(_) => return report(Some(item.to_string()), None),
                Err(CoreError::Server {
                    status: 409, code, ..
                }) if code == "version_conflict" => {}
                Err(error) if error.is_environmental() => {
                    return report(None, Some(format!("not sent yet: {error}")));
                }
                Err(error @ CoreError::Forbidden { .. }) => {
                    return report(
                        None,
                        Some(format!(
                            "this key cannot change the folder, which takes write access to `system.folder`: {error}"
                        )),
                    );
                }
                Err(
                    error @ (CoreError::Validation { .. }
                    | CoreError::NotFound { .. }
                    | CoreError::Server { .. }),
                ) => {
                    return report(None, Some(format!("the folder door refused it: {error}")));
                }
                Err(error) => return Err(error),
            }
        }
        report(
            None,
            Some("the folder's query kept changing under it".into()),
        )
    }
}

fn named_in(directory: &Directory, parts: &[&str], above: &str) -> Option<String> {
    let (part, rest) = parts.split_first()?;
    let wanted = if rest.is_empty() {
        FileType::RegularFile
    } else {
        FileType::Directory
    };
    let mut same: Vec<String> = directory
        .entries()
        .ok()?
        .into_iter()
        .filter_map(|name| name.into_string().ok())
        .filter(|name| names::same(name, part))
        .filter(|name| directory.entry_kind(Path::new(name)).ok() == Some(wanted))
        .collect();
    same.sort();
    same.into_iter().find_map(|name| {
        let at = if above.is_empty() {
            name.clone()
        } else {
            format!("{above}/{name}")
        };
        if rest.is_empty() {
            return Some(at);
        }
        let child = directory.child(Path::new(&name), false).ok()?;
        named_in(&child, rest, &at)
    })
}
