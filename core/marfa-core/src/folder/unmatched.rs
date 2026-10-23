use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::{Folder, copy_changed, lists::Lists, plainly_inside, state};
use crate::Result;

/// A file the folder keeps whose item the folder's search no longer matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unmatched {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// Why removing the file would keep it, where it would, as a clause that
    /// follows `is kept:`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<String>,
}

/// What removing unmatched files did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UnmatchedRemoved {
    /// The files taken away. Their items are unchanged.
    pub removed: Vec<Unmatched>,
    /// The files left in place, each with why.
    pub kept: Vec<Unmatched>,
    /// The folder's placements of the removed files' items, ended and queued
    /// to be sent.
    pub ended: usize,
}

impl Folder {
    /// The unmatched files of the folder at `root` as the last pull left
    /// them, read from its store without claiming it, so it answers beside a
    /// running watch.
    pub fn unmatched_of(root: impl AsRef<Path>) -> Result<Vec<Unmatched>> {
        Folder::reading(root.as_ref())?.unmatched_files()
    }

    /// The files whose items the last pull left in place because the search
    /// no longer matches them, in path order. Each says why removing it would
    /// keep it, where it would.
    pub fn unmatched_files(&self) -> Result<Vec<Unmatched>> {
        self.refuse_if_gone()?;
        let (unmatched, bound) = {
            let conn = self.core.conn()?;
            (state::unmatched(&conn)?, state::every_bound(&conn)?)
        };
        let unmatched: HashSet<String> = unmatched.into_iter().collect();
        let mut rows: Vec<state::Bound> = bound
            .into_iter()
            .filter(|row| unmatched.contains(&row.item_id))
            .collect();
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let members = self.members(&settings)?;
        rows.into_iter()
            .map(|row| {
                let kept = self.kept_because(&row, &members, &settings, &lists)?;
                Ok(entry(&row, kept))
            })
            .collect()
    }

    /// Takes away the named unmatched files, each only while it is still
    /// unmatched, still the bytes the folder wrote, and has no edit waiting
    /// to be sent. Ends the folder's placement of each item first; the item
    /// itself is not changed. A file that cannot go is kept and reported, and
    /// the rest go on.
    pub fn remove_unmatched(&self, paths: &[String]) -> Result<UnmatchedRemoved> {
        self.refuse_if_gone()?;
        self.refuse_while_waiting()?;
        let mut done = UnmatchedRemoved::default();
        if paths.is_empty() {
            return Ok(done);
        }
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let members = self.members(&settings)?;
        let mut context = crate::reach::Context::capture(&*self.core.conn()?)?;
        let mut unmatched: Vec<String> = state::unmatched(&*self.core.conn()?)?;
        for path in paths {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                done.kept.push(Unmatched {
                    path: path.clone(),
                    item_id: None,
                    kept: Some("it is no longer a file of the folder".into()),
                });
                continue;
            };
            let kept = if unmatched.contains(&row.item_id) {
                self.kept_because(&row, &members, &settings, &lists)?
            } else {
                Some("it is not unmatched any more".into())
            };
            if kept.is_some() {
                done.kept.push(entry(&row, kept));
                continue;
            }
            match self.take_away(&row, &mut context) {
                Ok(Some(ended)) => {
                    done.ended += ended;
                    done.removed.push(entry(&row, None));
                    if state::bound_to_item(&*self.core.conn()?, &row.item_id)?.is_none() {
                        unmatched.retain(|id| *id != row.item_id);
                    }
                }
                Ok(None) => done.kept.push(entry(
                    &row,
                    Some("it changed while it was being removed".into()),
                )),
                Err(error) if copy_changed(&error) => return Err(error),
                Err(error) => done.kept.push(entry(&row, Some(error.to_string()))),
            }
        }
        state::set_unmatched(&*self.core.conn()?, &unmatched)?;
        Ok(done)
    }

    /// Why removing `row`'s file would leave it, where it would: it is not
    /// the folder's to take, or something of the person's is in it or waits
    /// behind it.
    fn kept_because(
        &self,
        row: &state::Bound,
        members: &HashSet<String>,
        settings: &super::Settings,
        lists: &Lists,
    ) -> Result<Option<String>> {
        if let Some(why) = self.not_writing_at(lists, &row.path) {
            return Ok(Some(format!("it is not the folder's to remove: {why}")));
        }
        if !plainly_inside(&self.root_dir, &row.path) {
            return Ok(Some("it is not inside the folder".into()));
        }
        let item =
            crate::store::items_by_ids(&*self.core.conn()?, std::slice::from_ref(&row.item_id))?
                .pop();
        match item {
            None => return Ok(Some("its item is not in this copy any more".into())),
            Some(_) if members.contains(&row.item_id) => {
                return Ok(Some("its item matches the search again".into()));
            }
            Some(item) if !settings.holds_state(item.state) => {
                return Ok(Some(
                    "its item left the search's states, which the next pull settles".into(),
                ));
            }
            Some(_) => {}
        }
        if row.held.is_some() || !row.writes.refused.is_empty() {
            return Ok(Some(
                "an edit of it was held or refused, and mending that is the person's".into(),
            ));
        }
        if !row.writes.queued.is_empty()
            || crate::store::item_waits(&*self.core.conn()?, &row.item_id)?
        {
            return Ok(Some("an edit of it waits to be sent".into()));
        }
        Ok(match self.read(self.root.join(&row.path)) {
            Ok(found) if row.written_hash.as_deref() == Some(state::hash(&found).as_str()) => None,
            Ok(_) => Some("its bytes differ from what the folder wrote".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Some("it is not in the directory, which the next scan settles".into())
            }
            Err(error) => Some(format!("it cannot be read: {error}")),
        })
    }
}

fn entry(row: &state::Bound, kept: Option<String>) -> Unmatched {
    Unmatched {
        path: row.path.clone(),
        item_id: Some(row.item_id.clone()),
        kept,
    }
}
