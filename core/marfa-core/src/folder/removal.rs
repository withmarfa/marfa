use serde::Serialize;

use std::cell::OnceCell;

use super::{Departing, Flagged, Folder, Missing, PullReport, Unsure, state};
use crate::Result;
use crate::model::ItemState;

/// A content hash no bytes have, so the pull after a restore writes the file
/// back rather than taking the missing file as in place.
const PUT_BACK: &str = "put-back";

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
        let copy = crate::read_view::Context::capture(&*self.core.conn()?)?;
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
        let members = OnceCell::new();
        for path in &disk {
            // A file put back since is not gone, whatever the pause recorded.
            if self.exists(self.root.join(path)) {
                continue;
            }
            if let Some((_, item_id, _)) = journaled.iter().find(|(at, _, _)| at == path) {
                match self.let_go_missing(path, item_id, &settings, &peers, &members)? {
                    Missing::Moved => confirmed.moved += 1,
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
        let mut context = crate::read_view::Context::capture(&*self.core.conn()?)?;
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
                // No pull writes back an item the search's states no longer hold, so
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
            // never writes a new file for an item outside the search.
            if !members.contains(&bound.item_id) {
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_clear(&conn, path)?;
            state::bind(
                &conn,
                &state::Bound {
                    content_hash: PUT_BACK.into(),
                    ..bound
                },
            )?;
            marked.push(path);
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
        for path in &marked {
            if self.exists(self.root.join(path)) {
                continue;
            }
            // Bound, the missing file would be read as deleted by the next
            // scan, and its item sent to the bin. Unbound, it is an item the
            // folder has not written yet, which every pull tries again.
            state::unbind(&*self.core.conn()?, path)?;
            not_written_back.push(
                pull.flagged
                    .iter()
                    .find(|file| &file.path == *path)
                    .cloned()
                    .unwrap_or_else(|| Flagged {
                        path: (*path).clone(),
                        flag: "absent",
                        reason: "the pull did not write it".into(),
                        item: None,
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
