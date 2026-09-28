//! A removal large enough to be a mistake waits to be confirmed
//! (`folders.md` 46): `confirm` lets it go, `restore` puts it back.

use serde::Serialize;

use std::cell::OnceCell;

use super::{Departing, Folder, Missing, PullReport, Unsure, state};
use crate::Result;
use crate::model::ItemState;

/// A content hash no bytes have, so the pull after a restore writes the file
/// back rather than taking the missing file as in place.
const PUT_BACK: &str = "put-back";

/// What `folders confirm` let go.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Confirmed {
    /// Deletes queued for files gone from the disk, sent at the next push.
    pub deleted: usize,
    /// Files gone from the disk that another folder on the machine now
    /// holds, so nothing is trashed for them (`folders.md` 43).
    pub moved: usize,
    /// Files that cannot be told moved or gone yet, left to the next pass.
    pub unsure: Vec<Unsure>,
    /// Files taken away whose items were trashed or left the search's
    /// states elsewhere.
    pub removed: usize,
}

/// What `folders restore` put back.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Restored {
    /// Files gone from the disk, written back by the pull that follows.
    pub put_back: usize,
    /// Items trashed elsewhere restored from the bin, or moved back to a state
    /// the search holds, sent at the next push.
    pub restored: usize,
    pub pull: PullReport,
}

impl Folder {
    /// Lets every paused removal go: the deletes of files gone from the disk
    /// are queued, and the files of items that left elsewhere taken away.
    pub fn confirm(&self) -> Result<Confirmed> {
        self.core.lock.refuse_unless_writer()?;
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
            if self.root.join(path).exists() {
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
        let members = self.members(&settings)?;
        for path in &pull {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                continue;
            };
            if matches!(
                self.departing(&row, &members, &settings, &lists)?,
                Departing::Yes
            ) {
                self.take_away(&row)?;
                confirmed.removed += 1;
            }
        }
        let conn = self.core.conn()?;
        state::set_paused(&conn, state::Removal::Disk, &[])?;
        state::set_paused(&conn, state::Removal::Pull, &[])?;
        Ok(confirmed)
    }

    /// Cancels every paused removal: files gone from the disk are written
    /// back, and items that left elsewhere are restored.
    pub fn restore(&self) -> Result<Restored> {
        self.core.lock.refuse_unless_writer()?;
        let settings = self.settings()?;
        let (disk, pull) = {
            let conn = self.core.conn()?;
            (
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
            )
        };
        let mut put_back = 0;
        for path in &disk {
            let conn = self.core.conn()?;
            state::journal_clear(&conn, path)?;
            let Some(bound) = state::bound_at(&conn, path)? else {
                continue;
            };
            // No pull writes back an item the search's states no longer hold, so
            // bound it would be journaled again (`folders.md` 46).
            let held = crate::store::items_by_ids(&conn, std::slice::from_ref(&bound.item_id))?
                .pop()
                .is_some_and(|item| settings.holds_state(item.state));
            if !held {
                state::unbind(&conn, path)?;
                continue;
            }
            state::bind(
                &conn,
                &state::Bound {
                    content_hash: PUT_BACK.into(),
                    ..bound
                },
            )?;
            put_back += 1;
        }
        let mut restored = 0;
        for path in &pull {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                continue;
            };
            let Some(item) = self.core.get(&row.item_id)? else {
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
        Ok(Restored {
            put_back,
            restored,
            pull: self.pull()?,
        })
    }
}
