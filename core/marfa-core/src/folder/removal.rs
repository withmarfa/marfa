use serde::Serialize;

use std::cell::OnceCell;

use super::{Departing, Folder, Missing, PullReport, Unsure, state};
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
    pub put_back: usize,
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
        let mut put_back = 0;
        for path in &disk {
            let conn = self.core.conn()?;
            state::journal_clear(&conn, path)?;
            let Some(bound) = state::bound_at(&conn, path)? else {
                continue;
            };
            // No pull writes back an item the search's states no longer hold, so
            // bound it would be journaled again.
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
