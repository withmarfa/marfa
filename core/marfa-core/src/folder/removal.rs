use std::collections::{HashMap, HashSet};

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
    /// Paused files the volume could not take away safely, each with why.
    /// Each stays, and stays paused.
    pub refused: Vec<Unsure>,
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
        self.refuse_while_paused()?;
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
        let journaled: HashMap<String, String> = journaled
            .into_iter()
            .map(|row| (row.path, row.item_id))
            .collect();
        let paused: Vec<(String, String)> = disk
            .iter()
            .filter_map(|path| Some((path.clone(), journaled.get(path)?.clone())))
            .collect();
        let mut confirmed = Confirmed::default();
        // Allowed before the one scan, which then queues them.
        let released = held
            .iter()
            .filter(|path| self.is_file(self.root.join(path)))
            .count();
        if !held.is_empty() {
            state::set_additions_allowed(&*self.core.conn()?, &held)?;
        }
        if !paused.is_empty() || !held.is_empty() {
            // A scan that failed before it read the folder leaves the
            // confirmation for the next one.
            let scanned = self.scan_holding_missing()?;
            confirmed.added = released;
            if !paused.is_empty() {
                self.confirm_removals(&paused, &scanned, &settings, &mut confirmed)?;
            }
        }
        copy.same_copy(&*self.core.conn()?)?;
        let mut context = crate::reach::Context::capture(&*self.core.conn()?)?;
        let members = self.members(&settings)?;
        for path in &pull {
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                continue;
            };
            if !matches!(
                self.departing(&row, &members, &settings, &lists)?,
                Departing::Yes
            ) {
                continue;
            }
            match self.take_away(&row, &mut context)? {
                super::pull::TakenAway::Ended(_) => confirmed.removed += 1,
                super::pull::TakenAway::Kept => {}
                super::pull::TakenAway::Refused(reason) => confirmed.refused.push(Unsure {
                    path: path.clone(),
                    reason: format!("Marfa left the file rather than remove it: {reason}"),
                }),
            }
        }
        {
            let conn = self.core.conn()?;
            let refused: Vec<String> = confirmed
                .refused
                .iter()
                .map(|file| file.path.clone())
                .collect();
            state::set_paused(&conn, state::Removal::Disk, &[])?;
            state::set_paused(&conn, state::Removal::Pull, &refused)?;
        }
        Ok(confirmed)
    }

    /// Lets go of each paused file, a path and its item, that `scanned`, a
    /// fresh scan of the whole folder that let go of nothing, finds under no
    /// name, and of no other file. A file the scan finds back, at its path or
    /// another, keeps its item.
    fn confirm_removals(
        &self,
        paused: &[(String, String)],
        scanned: &super::ScanReport,
        settings: &super::Settings,
        confirmed: &mut Confirmed,
    ) -> Result<()> {
        let journaled: HashSet<(String, String)> = state::journaled(&*self.core.conn()?)?
            .into_iter()
            .map(|row| (row.path, row.item_id))
            .collect();
        let unread = unread_reason(scanned);
        let mut missing = Vec::new();
        for (path, item_id) in paused {
            let bound = state::bound_at(&*self.core.conn()?, path)?
                .is_some_and(|bound| &bound.item_id == item_id);
            // Unbound: found under another name by the scan.
            if !bound {
                continue;
            }
            let unsure = |reason: String| Unsure {
                path: path.clone(),
                reason,
            };
            match self.file_at(&self.root.join(path)) {
                Err(error) => confirmed
                    .unsure
                    .push(unsure(format!("its path cannot be checked ({error})"))),
                Ok(true) => {}
                Ok(false) if !scanned.swept => confirmed.unsure.push(unsure(unread.clone())),
                Ok(false) if journaled.contains(&(path.clone(), item_id.clone())) => {
                    missing.push((path.clone(), item_id.clone()));
                }
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
        self.refuse_while_paused()?;
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

/// Why a scan that did not read the whole folder leaves a missing file
/// unsure, naming the first directory it could not read.
fn unread_reason(scanned: &super::ScanReport) -> String {
    match scanned
        .directories
        .iter()
        .find(|dir| matches!(dir.flag, "gone" | "unreadable"))
    {
        Some(dir) if dir.path.is_empty() => {
            "the folder could not be read, so it may be there under another name".into()
        }
        Some(dir) => format!(
            "`{}` could not be read, so it may be there under another name",
            dir.path
        ),
        None => "a file in the folder could not be read, so it may be that file".into(),
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
    use super::super::tests::{deletes_queued, folder_with, landed, past_the_grace, settled_under};
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
        assert!(
            confirmed
                .unsure
                .iter()
                .any(|file| file.path == "gone.md"
                    && file.reason.contains("`sub` could not be read")),
            "{confirmed:?}"
        );
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

    #[test]
    fn a_confirmed_removal_under_a_raised_threshold_counts_the_files_found_in_another_folder() {
        let (_, _registry) = registry::tests::own_registry();
        let names: Vec<String> = (0..15).map(|n| format!("note {n}.md")).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let paused = paused_over("01a00000-0000-7000-8000-00000000c604", &names);
        let (other, _peer) = folder_with(
            "01a00000-0000-7000-8000-00000000c605",
            serde_json::json!({ "query": {} }),
            None,
        );
        for name in &names[..5] {
            std::fs::rename(paused.away.path().join(name), other.path().join(name)).unwrap();
        }
        let folder = &paused.folder;
        for name in &names {
            past_the_grace(folder, name);
        }
        // No longer a large removal, so a scan that let go of files past the
        // grace would decide them before the confirmation could.
        settled_under(
            folder,
            serde_json::json!({
                "query": {},
                "removal_threshold": { "files": 100, "fraction": 1.0 }
            }),
        );
        let confirmed = folder.confirm().unwrap();
        assert_eq!(
            (confirmed.moved, confirmed.deleted),
            (5, 10),
            "{confirmed:?}"
        );
        assert!(confirmed.unsure.is_empty(), "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 10);
    }

    #[cfg(unix)]
    #[test]
    fn a_confirmed_removal_takes_a_file_under_a_directory_now_a_symbolic_link_as_gone() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over("01a00000-0000-7000-8000-00000000c606", &["sub/original.md"]);
        let Paused {
            dir, away, folder, ..
        } = &paused;
        std::fs::remove_dir(dir.path().join("sub")).unwrap();
        std::fs::create_dir(away.path().join("sub")).unwrap();
        std::fs::rename(
            away.path().join("sub-original.md"),
            away.path().join("sub/original.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(away.path().join("sub"), dir.path().join("sub")).unwrap();
        let confirmed = folder.confirm().unwrap();
        // The walk does not follow the link, so the file is in no name the
        // folder holds, on Linux too, where the path's check is a loop.
        assert!(confirmed.unsure.is_empty(), "{confirmed:?}");
        assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 1);
    }

    /// Everything a command that refuses must leave as it found it.
    fn kept(folder: &Folder) -> String {
        let queued = folder.core.queue().unwrap().len();
        let conn = folder.core.conn().unwrap();
        format!(
            "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{}",
            state::every_bound(&conn).unwrap(),
            state::journaled(&conn).unwrap(),
            state::paused(&conn, state::Removal::Disk).unwrap(),
            state::paused(&conn, state::Removal::Pull).unwrap(),
            state::paused_additions(&conn).unwrap(),
            queued,
        )
    }

    #[test]
    fn a_paused_directory_refuses_each_command_that_writes_and_changes_nothing() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over(
            "01a00000-0000-7000-8000-00000000c611",
            &["one.md", "two.md"],
        );
        let folder = &paused.folder;
        let refused = |error: Result<()>| {
            assert!(
                matches!(&error, Err(crate::error::CoreError::Invalid(said)) if said.contains("folders resume")),
                "{error:?}"
            );
        };

        // The witness: each command acts on this state before the pause.
        let witness = kept(folder);
        assert!(witness.contains("one.md"), "{witness}");
        assert_eq!(
            state::paused(&folder.core.conn().unwrap(), state::Removal::Disk).unwrap().len(),
            2
        );

        folder.pause_sync().unwrap();
        refused(folder.confirm().map(drop));
        refused(folder.restore().map(drop));
        refused(folder.remove_unmatched(&["one.md".into()]).map(drop));
        refused(folder.scan().map(drop));
        refused(folder.hydrate().map(drop));
        refused(folder.confirm_first_sync().map(drop));
        assert_eq!(kept(folder), witness, "a refused command changed the folder");

        // Resumed, the same restore goes ahead.
        folder.resume_sync().unwrap();
        folder.restore().unwrap();
        assert_ne!(kept(folder), witness);
    }

    #[test]
    fn a_paused_directory_leaves_a_first_sync_waiting() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over("01a00000-0000-7000-8000-00000000c612", &["one.md"]);
        let folder = &paused.folder;
        folder.wait_for_confirmation().unwrap();
        folder.pause_sync().unwrap();
        assert!(matches!(
            folder.confirm_first_sync(),
            Err(crate::error::CoreError::Invalid(_))
        ));
        assert!(folder.awaiting_confirmation().unwrap());
        folder.resume_sync().unwrap();
        assert!(folder.confirm_first_sync().unwrap());
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
