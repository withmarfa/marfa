use serde::Serialize;

use super::{Departing, Flagged, Folder, Missing, PullReport, Sweep, Unsure, state};
use crate::Result;
use crate::model::ItemState;

/// A content hash no bytes have, so the pull after a restore writes the file
/// back rather than taking the missing file as in place.
pub(super) const PUT_BACK: &str = "put-back";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Confirmed {
    pub deleted: usize,
    pub moved: usize,
    pub unsure: Vec<Unsure>,
    pub removed: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Restored {
    /// Missing files the restore's pull wrote back.
    pub put_back: usize,
    /// Missing files the restore's pull could not write back, such as one
    /// whose bytes could not be fetched, each with why. Every later pull
    /// tries each again.
    pub not_written_back: Vec<Flagged>,
    pub restored: usize,
    pub pull: PullReport,
}

impl Folder {
    pub fn confirm(&self) -> Result<Confirmed> {
        self.refuse_if_gone()?;
        self.refuse_while_waiting()?;
        let copy = crate::reach::Context::capture(&*self.core.conn()?)?;
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let (disk, pull, journaled) = {
            let conn = self.core.conn()?;
            (
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
                state::journaled(&conn)?,
            )
        };
        let mut confirmed = Confirmed::default();
        let peers = self.peers();
        let sweep = Sweep::default();
        for path in &disk {
            // A file put back since is not gone, whatever the pause recorded.
            if self.exists(self.root.join(path)) {
                continue;
            }
            if let Some(row) = journaled.iter().find(|row| &row.path == path) {
                match self.let_go_missing(path, &row.item_id, &settings, &peers, &sweep)? {
                    Missing::Moved => confirmed.moved += 1,
                    Missing::Arriving | Missing::Changed => {}
                    Missing::Unsure(reason) => confirmed.unsure.push(Unsure {
                        path: path.clone(),
                        reason,
                    }),
                    Missing::Deleted => confirmed.deleted += 1,
                    Missing::Gone => {}
                }
            }
        }
        copy.same_copy(&*self.core.conn()?)?;
        let mut context = crate::reach::Context::capture(&*self.core.conn()?)?;
        let members = self.members(&settings)?;
        for path in &pull {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                continue;
            };
            if matches!(
                self.departing(&row, &members, &settings, &lists)?,
                Departing::Yes
            ) && self.take_away(&row, &mut context)?.is_some()
            {
                confirmed.removed += 1;
            }
        }
        let conn = self.core.conn()?;
        state::set_paused(&conn, state::Removal::Disk, &[])?;
        state::set_paused(&conn, state::Removal::Pull, &[])?;
        Ok(confirmed)
    }

    pub fn restore(&self) -> Result<Restored> {
        self.refuse_if_gone()?;
        self.refuse_while_waiting()?;
        let settings = self.settings()?;
        let (disk, pull) = {
            let conn = self.core.conn()?;
            (
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
            )
        };
        let members = self.members(&settings)?;
        let mut marked = Vec::new();
        for path in &disk {
            let (bound, held) = {
                let conn = self.core.conn()?;
                let Some(bound) = state::bound_at(&conn, path)? else {
                    continue;
                };
                // No pull writes back an item the query's states no longer hold, so
                // bound it would be journaled again.
                let held = crate::store::items_by_ids(&conn, std::slice::from_ref(&bound.item_id))?
                    .pop()
                    .is_some_and(|item| settings.holds_state(item.state));
                (bound, held)
            };
            if !held {
                // The file leaves for good, so its placement ends before its binding.
                self.end_placement(&bound.item_id, path)?;
                let conn = self.core.conn()?;
                state::journal_clear(&conn, path)?;
                state::unbind(&conn, path)?;
                continue;
            }
            // A missing unmatched file remains the person's deletion: the pull
            // never writes a new file for an item outside the query.
            if !members.contains(&bound.item_id) {
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_clear(&conn, path)?;
            marked.push((path, bound.item_id.clone()));
            state::bind(
                &conn,
                &state::Bound {
                    content_hash: PUT_BACK.into(),
                    ..bound
                },
            )?;
        }
        let mut restored = 0;
        for path in &pull {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                continue;
            };
            // The ordinary read excludes the bin, but restoring a paused
            // removal must still find the trashed row the copy holds.
            let Some(item) = crate::store::items_by_ids(
                &*self.core.conn()?,
                std::slice::from_ref(&row.item_id),
            )?
            .pop() else {
                continue;
            };
            if item.state == ItemState::Trashed {
                self.core.restore_item(&item.id)?;
                restored += 1;
            } else if let Some(state) = [ItemState::Active, ItemState::Archived]
                .into_iter()
                .find(|state| *state != item.state && settings.holds_state(*state))
                && !settings.holds_state(item.state)
            {
                self.core.transition_item(&item.id, state)?;
                restored += 1;
            }
        }
        {
            let conn = self.core.conn()?;
            state::set_paused(&conn, state::Removal::Disk, &[])?;
            state::set_paused(&conn, state::Removal::Pull, &[])?;
        }
        let pull = self.pull()?;
        let mut not_written_back = Vec::new();
        for (path, item_id) in &marked {
            // Written where its binding holds the bytes the pull wrote, at
            // this path or one the item moved to; a file at the path proves
            // nothing, since it can be somebody else's.
            let conn = self.core.conn()?;
            if state::every_bound_to_item(&conn, item_id)?
                .iter()
                .any(|bound| bound.content_hash != PUT_BACK)
            {
                continue;
            }
            // Bound, the missing file would be read as deleted by the next
            // scan, and its item sent to the bin. Unbound, it is an item the
            // folder has not written yet, which every pull tries again.
            if state::bound_at(&conn, path)?
                .is_some_and(|bound| &bound.item_id == item_id && bound.content_hash == PUT_BACK)
            {
                state::unbind(&conn, path)?;
            }
            not_written_back.push(
                flagged_for(&pull.flagged, item_id, path).unwrap_or_else(|| Flagged {
                    path: (*path).clone(),
                    flag: "unwritten",
                    reason: "the pull did not write it".into(),
                    item: Some(item_id.clone()),
                }),
            );
        }
        Ok(Restored {
            put_back: marked.len() - not_written_back.len(),
            not_written_back,
            restored,
            pull,
        })
    }
}

/// What the pull said of the item's own file, or else of a file at its path
/// that the pull tied to no item: a flag on another item's file at the path
/// is about that item.
fn flagged_for(flagged: &[Flagged], item_id: &str, path: &str) -> Option<Flagged> {
    flagged
        .iter()
        .find(|file| file.item.as_deref() == Some(item_id))
        .or_else(|| {
            flagged
                .iter()
                .find(|file| file.item.is_none() && file.path == path)
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flag(path: &str, flag: &'static str, item: Option<&str>) -> Flagged {
        Flagged {
            path: path.into(),
            flag,
            reason: format!("{flag} at {path}"),
            item: item.map(str::to_string),
        }
    }

    #[test]
    fn reports_the_items_own_flag_ahead_of_a_strangers_at_its_path() {
        let stranger = flag("notes/a.md", "conflict", Some("someone-else"));
        let own = flag("notes/moved.md", "unfetched", Some("item"));
        assert_eq!(
            flagged_for(&[stranger.clone(), own.clone()], "item", "notes/a.md"),
            Some(own)
        );
        // A flag at the path that names no item still stands for the file,
        // but a stranger's alone says nothing of it.
        let untied = flag("notes/a.md", "unreadable", None);
        assert_eq!(
            flagged_for(&[stranger.clone(), untied.clone()], "item", "notes/a.md"),
            Some(untied)
        );
        assert_eq!(flagged_for(&[stranger], "item", "notes/a.md"), None);
    }
}
