//! A folder whose query narrows beneath the path of one of its own files,
//! until that file has an item whose id can take the path's place.

use std::path::Path;

use marfa_rules::names;
use serde_json::{Map, Value};

use super::settings::Settings;
use super::{Folder, state};
use crate::error::CoreError;
use crate::http::ByIdRead;
use crate::{Result, catch_up};

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

/// Version conflicts met in a row before a pass leaves the rest to the next.
const ATTEMPTS: usize = 3;

impl Folder {
    /// The path the folder's query narrows beneath, while the file at it has
    /// no item to name. The folder holds nothing from the server meanwhile.
    pub fn beneath_waiting(&self) -> Option<String> {
        self.settings()
            .ok()
            .and_then(|settings| settings.pending_beneath().map(str::to_string))
    }

    fn bound_beneath(&self, path: &str) -> Result<Option<state::Bound>> {
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

    /// Why no pass could send the file at `path`, where none could.
    fn unsendable(&self, settings: &Settings, path: &str) -> Result<Option<String>> {
        if !self.is_file(self.root.join(path)) {
            return Ok(Some(format!(
                "there is no such file in {}",
                self.root.display()
            )));
        }
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

    /// Refuses, before the folder sends or writes anything, a query that
    /// narrows beneath a file no pass could send: the folder would hold
    /// nothing for good.
    pub(super) fn check_beneath_file(&self) -> Result<()> {
        let settings = self.settings()?;
        let Some(path) = settings.pending_beneath() else {
            return Ok(());
        };
        if self.bound_beneath(path)?.is_some() {
            return Ok(());
        }
        match self.unsendable(&settings, path)? {
            Some(why) => Err(CoreError::Invalid(format!(
                "the folder narrows beneath the file {path}, and {why}; put the file there, or change `query.beneath` with `marfa folders update`"
            ))),
            None => Ok(()),
        }
    }

    /// Writes the id of the item the file named by `query.beneath` became in
    /// the path's place, once the server holds that item: the folder's copy
    /// then moves to what lies beneath it, which the next catch-up reads.
    /// `None` where the query names no path. Whatever stops it leaves the
    /// path and a reason in the report; the next pass tries again.
    pub(super) fn resolve_beneath(&self) -> Result<Option<BeneathReport>> {
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

    /// Replaces the path in the folder's query with `item`, based on the
    /// version the server holds. A change to the query since, which the door
    /// refuses as a conflict, is read again: an id already named there is
    /// accepted, and the path still named is replaced on top of it.
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
                Err(
                    error @ (CoreError::Forbidden { .. }
                    | CoreError::Validation { .. }
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
