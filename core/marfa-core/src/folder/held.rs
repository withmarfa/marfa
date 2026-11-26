use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::scan::Letting;
use super::{Flagged, Folder, Missing, Sweep, Unsure, state};
use crate::Result;

/// A missing file whose deletion is held because Marfa cannot tell whether
/// it was deleted or moved into another folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeldFile {
    pub path: String,
    pub item: String,
    /// When this folder first found it missing.
    pub missing_since: String,
    pub reason: String,
}

/// What the person decides for a held file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    /// Send its item's delete, checked against the item's version.
    Trash,
    /// Keep its item and let the folder's file of it go; with `write_back`,
    /// write the file again where the folder's query holds the item.
    Keep { write_back: bool },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Settled {
    /// Files whose items' deletes are queued, sent at the next push.
    pub trashed: Vec<String>,
    /// Files whose items were already in the bin or gone.
    pub gone: Vec<String>,
    /// Files one other readable folder now holds, whose items stay.
    pub moved: Vec<String>,
    /// Files whose items stay, and which this folder lets go.
    pub kept: Vec<String>,
    /// Kept files the pull wrote again.
    pub written_back: Vec<String>,
    /// Kept files the pull did not write again, each with why.
    pub not_written_back: Vec<Flagged>,
    /// Named files left as they were, each with why.
    pub not_settled: Vec<Unsure>,
}

impl Folder {
    /// `held_files`, read without asking a watch for the folder.
    pub fn held_of(root: impl AsRef<Path>) -> Result<Vec<HeldFile>> {
        Folder::reading(root.as_ref())?.held_files()
    }

    /// The files whose deletion is held for the person, in path order.
    pub fn held_files(&self) -> Result<Vec<HeldFile>> {
        self.refuse_if_gone()?;
        let conn = self.core.conn()?;
        let mut files = Vec::new();
        for row in state::journaled(&conn)? {
            let Some(state::Kept::Unsure(reason)) = row.kept else {
                continue;
            };
            files.push(HeldFile {
                path: row.path,
                item: row.item_id,
                missing_since: row.missing_since,
                reason,
            });
        }
        Ok(files)
    }

    /// Settles each held file of `paths` as the person decides
    /// (`folder-files/missing-file-held-settled`). A file now at its path,
    /// or a path that is not held, is left as it is and said.
    pub fn settle_held(&self, paths: &[String], settle: Settle) -> Result<Settled> {
        self.refuse_if_gone()?;
        self.refuse_while_paused()?;
        let held: HashMap<String, String> = self
            .held_files()?
            .into_iter()
            .map(|file| (file.path, file.item))
            .collect();
        let mut settled = Settled::default();
        let mut chosen = Vec::new();
        for path in paths {
            let not = |reason: &str| Unsure {
                path: path.clone(),
                reason: reason.into(),
            };
            let Some(item_id) = held.get(path) else {
                settled.not_settled.push(not("its deletion is not held"));
                continue;
            };
            // A file at a path another item's binding holds is that item's.
            let taken = state::bound_at(&*self.core.conn()?, path)?
                .is_some_and(|bound| &bound.item_id != item_id);
            match self.file_at(&self.root.join(path)) {
                Ok(false) => chosen.push((path.clone(), item_id.clone())),
                Ok(true) if taken => chosen.push((path.clone(), item_id.clone())),
                Ok(true) => settled.not_settled.push(not(
                    "a file is at its path again, so Marfa leaves it, and the next scan reads it",
                )),
                Err(error) => settled.not_settled.push(Unsure {
                    path: path.clone(),
                    reason: format!("its path cannot be checked ({error})"),
                }),
            }
        }
        match settle {
            Settle::Trash => self.trash_held(&chosen, &mut settled)?,
            Settle::Keep { write_back } => self.keep_held(&chosen, write_back, &mut settled)?,
        }
        Ok(settled)
    }

    fn trash_held(&self, chosen: &[(String, String)], settled: &mut Settled) -> Result<()> {
        let settings = self.settings()?;
        let peers = self.peers();
        let sweep = Sweep::default();
        for (path, item_id) in chosen {
            let missing =
                self.let_go_missing(path, item_id, &settings, &peers, &sweep, Letting::Trash)?;
            let mut not_settled = |reason| {
                settled.not_settled.push(Unsure {
                    path: path.clone(),
                    reason,
                });
            };
            match missing {
                Missing::Deleted => settled.trashed.push(path.clone()),
                Missing::Gone => settled.gone.push(path.clone()),
                Missing::Moved | Missing::Arriving => settled.moved.push(path.clone()),
                Missing::Changed(reason) => not_settled(reason.into()),
                Missing::Carried => {
                    not_settled("another file carries its identity or item ID".into())
                }
                Missing::Unsure(reason) => not_settled(reason),
            }
        }
        Ok(())
    }

    fn keep_held(
        &self,
        chosen: &[(String, String)],
        write_back: bool,
        settled: &mut Settled,
    ) -> Result<()> {
        let settings = self.settings()?;
        let members = if write_back {
            self.members(&settings)?
        } else {
            Default::default()
        };
        let mut marked = Vec::new();
        for (path, item_id) in chosen {
            let at = state::bound_at(&*self.core.conn()?, path)?;
            let writes = write_back && {
                let conn = self.core.conn()?;
                members.contains(item_id)
                    && crate::store::items_by_ids(&conn, std::slice::from_ref(item_id))?
                        .pop()
                        .is_some_and(|item| settings.holds_state(item.state))
            };
            if writes && at.as_ref().is_some_and(|bound| &bound.item_id != item_id) {
                settled.not_settled.push(Unsure {
                    path: path.clone(),
                    reason: "another item's file is at its path, so it cannot be written again there: `--keep` without `--write-back` keeps its item".into(),
                });
                continue;
            }
            settled.kept.push(path.clone());
            // The hold ends in the step that records what replaces it.
            if writes {
                let conn = self.core.conn()?;
                let tx = conn.unchecked_transaction()?;
                if let Some(bound) = at {
                    state::bind(
                        &tx,
                        &state::Bound {
                            content_hash: super::removal::PUT_BACK.into(),
                            ..bound
                        },
                    )?;
                }
                state::journal_clear_for(&tx, path, item_id)?;
                tx.commit()?;
                marked.push((path, item_id));
                continue;
            }
            if write_back {
                settled.not_written_back.push(Flagged {
                    path: path.clone(),
                    flag: "outside_query",
                    reason:
                        "the folder's query no longer holds its item, so it is not written again"
                            .into(),
                    item: Some(item_id.clone()),
                });
            }
            // The file has left for good, so its placement ends first.
            self.end_placement(item_id, path)?;
            let conn = self.core.conn()?;
            let tx = conn.unchecked_transaction()?;
            if state::bound_at(&tx, path)?.is_some_and(|bound| &bound.item_id == item_id) {
                state::unbind(&tx, path)?;
            }
            state::journal_clear_for(&tx, path, item_id)?;
            tx.commit()?;
        }
        if marked.is_empty() {
            return Ok(());
        }
        let pull = self.pull()?;
        for (path, item_id) in marked {
            let conn = self.core.conn()?;
            if state::every_bound_to_item(&conn, item_id)?
                .iter()
                .any(|bound| bound.content_hash != super::removal::PUT_BACK)
            {
                settled.written_back.push(path.clone());
                continue;
            }
            // Left bound, the missing file would be read as a delete.
            if state::bound_at(&conn, path)?.is_some_and(|bound| {
                &bound.item_id == item_id && bound.content_hash == super::removal::PUT_BACK
            }) {
                state::unbind(&conn, path)?;
            }
            settled.not_written_back.push(
                super::removal::flagged_for(&pull.flagged, item_id, path).unwrap_or_else(|| {
                    Flagged {
                        path: path.clone(),
                        flag: "unwritten",
                        reason: "the pull did not write it".into(),
                        item: Some(item_id.clone()),
                    }
                }),
            );
        }
        Ok(())
    }
}
