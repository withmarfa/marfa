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
    /// Held new files the confirmation let go of, sent at the next push.
    pub added: usize,
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
        let (disk, pull, held, journaled) = {
            let conn = self.core.conn()?;
            (
                state::paused(&conn, state::Removal::Disk)?,
                state::paused(&conn, state::Removal::Pull)?,
                state::paused_additions(&conn)?,
                state::journaled(&conn)?,
            )
        };
        let paused: Vec<(String, String)> = disk
            .iter()
            .filter_map(|path| {
                let row = journaled.iter().find(|row| &row.path == path)?;
                Some((path.clone(), row.item_id.clone()))
            })
            .collect();
        let mut confirmed = Confirmed::default();
        if !paused.is_empty() {
            self.confirm_removals(&paused, &settings, &mut confirmed)?;
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
        {
            let conn = self.core.conn()?;
            state::set_paused(&conn, state::Removal::Disk, &[])?;
            state::set_paused(&conn, state::Removal::Pull, &[])?;
        }
        confirmed.added = self.confirm_additions(&held)?;
        Ok(confirmed)
    }

    /// Lets go of each paused file, a path and its item, that a fresh scan
    /// of the whole folder finds under no name, and of no other file. A file
    /// the scan finds back, at its path or another, keeps its item.
    fn confirm_removals(
        &self,
        paused: &[(String, String)],
        settings: &super::Settings,
        confirmed: &mut Confirmed,
    ) -> Result<()> {
        let scanned = self.scan()?;
        let journaled = state::journaled(&*self.core.conn()?)?;
        let mut missing = Vec::new();
        for (path, item_id) in paused {
            let still = journaled
                .iter()
                .any(|row| &row.path == path && &row.item_id == item_id);
            let bound = state::bound_at(&*self.core.conn()?, path)?
                .is_some_and(|bound| &bound.item_id == item_id);
            let unsure = |reason: String| Unsure {
                path: path.clone(),
                reason,
            };
            if !bound {
                // Let go of by the scan's own sweep, or found moved by it.
                if scanned.trashed.contains(path) {
                    confirmed.deleted += 1;
                }
                continue;
            }
            match self.file_at(path) {
                Err(error) => confirmed
                    .unsure
                    .push(unsure(format!("its path cannot be checked ({error})"))),
                Ok(true) => {}
                Ok(false) if !scanned.swept => confirmed.unsure.push(unsure(
                    "the folder could not be read in full, so it may be there under another name"
                        .into(),
                )),
                Ok(false) if still => missing.push((path.clone(), item_id.clone())),
                // Bound and missing, yet not journaled: a file the lists no
                // longer reach, which no scan deletes.
                Ok(false) => {}
            }
        }
        let peers = self.peers();
        let sweep = Sweep::default();
        self.decide_changed(&missing, settings, &sweep)?;
        for (path, item_id) in &missing {
            match self.let_go_missing(path, item_id, settings, &peers, &sweep)? {
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
        Ok(())
    }

    /// Whether a regular file is at `path`, as the walk takes one, or why the
    /// disk cannot say.
    fn file_at(&self, path: &str) -> std::io::Result<bool> {
        let kind = self
            .location(&self.root.join(path), false)
            .and_then(|(directory, name)| directory.entry_kind(std::path::Path::new(&name)));
        match kind {
            Ok(kind) => Ok(kind == crate::directory::FileType::RegularFile),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    /// Lets the new files `held`, which the last scan held back, become
    /// items, and no others: a file that arrived since waits for the
    /// threshold as before. The scan queues them for the next push, here or
    /// in a watch that gets there first. Answers how many held files it let
    /// go of, those still on the disk.
    fn confirm_additions(&self, held: &[String]) -> Result<usize> {
        if held.is_empty() {
            return Ok(0);
        }
        let released = held
            .iter()
            .filter(|path| self.is_file(self.root.join(path)))
            .count();
        state::set_additions_allowed(&*self.core.conn()?, held)?;
        // A scan that failed before it read the folder leaves the
        // confirmation for the next one.
        self.scan()?;
        Ok(released)
    }

    /// Lets every new file of the next scan on this open become an item,
    /// whatever its number, for a push no person is at (`folders push
    /// --confirm-additions`). Kept in memory, so a scan that does not run
    /// leaves nothing for a later one.
    pub fn allow_additions(&self) -> Result<()> {
        self.refuse_if_gone()?;
        self.every_addition
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
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
        let attachments = self.written_with_documents(&settings, &members, &disk)?;
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
            // never writes a new file for an item outside the query unless a
            // document here embeds it or has it attached.
            if !members.contains(&bound.item_id) && !attachments.contains(&bound.item_id) {
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
    use super::super::registry;
    use super::super::tests::{deletes_queued, folder_with, landed};
    use super::*;

    struct Paused {
        dir: tempfile::TempDir,
        /// Outside the folder, holding each moved-out file by its name with
        /// `/` as `-`.
        away: tempfile::TempDir,
        folder: Folder,
        items: Vec<String>,
    }

    /// A folder that pauses every removal, over one note per name the server
    /// has taken, each moved out of the folder and its removal paused.
    fn paused_over(id: &str, names: &[&str]) -> Paused {
        let (dir, folder) = folder_with(
            id,
            serde_json::json!({
                "query": {},
                "removal_threshold": { "files": 0, "fraction": 0.0, "ceiling": 0 }
            }),
            None,
        );
        for name in names {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, format!("{name} words\n")).unwrap();
        }
        assert_eq!(folder.scan().unwrap().created, names.len());
        let items = names.iter().map(|name| landed(&folder, name)).collect();
        folder.pull().unwrap();
        let away = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        for name in names {
            std::fs::rename(
                dir.path().join(name),
                away.path().join(name.replace('/', "-")),
            )
            .unwrap();
        }
        let paused = folder.scan().unwrap();
        assert_eq!(paused.paused, names.len(), "{paused:?}");
        Paused {
            dir,
            away,
            folder,
            items,
        }
    }

    impl Paused {
        fn back(&self, name: &str, to: &str) {
            std::fs::rename(
                self.away.path().join(name.replace('/', "-")),
                self.dir.path().join(to),
            )
            .unwrap();
        }
    }

    fn bound_item(folder: &Folder, path: &str) -> Option<String> {
        state::bound_at(&folder.core.conn().unwrap(), path)
            .unwrap()
            .map(|bound| bound.item_id)
    }

    #[test]
    fn a_confirmed_removal_lets_go_of_a_file_gone_under_every_name() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over("01a00000-0000-7000-8000-00000000c601", &["original.md"]);
        let folder = &paused.folder;
        let confirmed = folder.confirm().unwrap();
        assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 1);
        assert_eq!(bound_item(folder, "original.md"), None);
    }

    #[test]
    fn a_confirmed_removal_keeps_the_item_of_a_file_back_under_another_name() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over("01a00000-0000-7000-8000-00000000c602", &["original.md"]);
        paused.back("original.md", "moved.md");
        let Paused { folder, items, .. } = &paused;
        let confirmed = folder.confirm().unwrap();
        assert_eq!(confirmed.deleted, 0, "{confirmed:?}");
        assert!(confirmed.unsure.is_empty(), "{confirmed:?}");
        assert!(deletes_queued(folder).is_empty(), "a delete was queued");
        assert_eq!(bound_item(folder, "moved.md").as_ref(), Some(&items[0]));
        assert_eq!(bound_item(folder, "original.md"), None);
        let after = folder.scan().unwrap();
        assert_eq!(
            (after.created, after.deleted, after.paused),
            (0, 0, 0),
            "{after:?}"
        );
        assert!(deletes_queued(folder).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_confirmed_removal_holds_a_file_whose_directory_cannot_be_read_as_unsure() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over(
            "01a00000-0000-7000-8000-00000000c603",
            &["sub/original.md", "gone.md"],
        );
        paused.back("sub/original.md", "sub/original.md");
        let Paused {
            dir, folder, items, ..
        } = &paused;
        let sealed = crate::test_folders::locked(dir.path().join("sub"), 0o000);
        let confirmed = folder.confirm().unwrap();
        assert_eq!(confirmed.deleted, 0, "{confirmed:?}");
        let mut unsure: Vec<&str> = confirmed
            .unsure
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        unsure.sort_unstable();
        // Unread, `sub` may hold `gone.md` too, under another name.
        assert_eq!(unsure, ["gone.md", "sub/original.md"], "{confirmed:?}");
        assert!(deletes_queued(folder).is_empty(), "a delete was queued");
        drop(sealed);
        assert_eq!(
            bound_item(folder, "sub/original.md").as_ref(),
            Some(&items[0])
        );
        let again = folder.scan().unwrap();
        assert_eq!(again.paused, 1, "{again:?}");
        let confirmed = folder.confirm().unwrap();
        assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 1);
        assert_eq!(bound_item(folder, "gone.md"), None);
        assert_eq!(
            bound_item(folder, "sub/original.md").as_ref(),
            Some(&items[0])
        );
    }

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
