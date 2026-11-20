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
        // A file another file carries is no removal to confirm.
        let journaled: HashSet<(String, String)> = state::journaled(&*self.core.conn()?)?
            .into_iter()
            .filter(|row| !row.carried())
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
                Missing::Gone | Missing::Carried => {}
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
        paused_over_query(id, names, serde_json::json!({}))
    }

    fn paused_over_query(id: &str, names: &[&str], query: serde_json::Value) -> Paused {
        let (dir, folder) = folder_with(
            id,
            serde_json::json!({
                "query": query,
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

    fn keeps_case_apart(dir: &std::path::Path) -> bool {
        std::fs::write(dir.join("case.probe"), b"").unwrap();
        let apart = !dir.join("CASE.probe").exists();
        std::fs::remove_file(dir.join("case.probe")).unwrap();
        apart
    }

    #[test]
    fn a_confirmed_removal_keeps_the_item_of_a_file_back_under_a_name_another_file_holds() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over(
            "01a00000-0000-7000-8000-00000000c607",
            &["original.md", "gone.md"],
        );
        if !keeps_case_apart(paused.dir.path()) {
            eprintln!("skipped: the temporary folder reads names in either case as one");
            return;
        }
        std::fs::write(paused.dir.path().join("Q.md"), "a new note\n").unwrap();
        paused.back("original.md", "q.md");
        let Paused { folder, items, .. } = &paused;
        let confirmed = folder.confirm().unwrap();
        // The witness: the file gone under every name is let go.
        assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 1);
        assert_eq!(bound_item(folder, "gone.md"), None);
        assert_eq!(bound_item(folder, "original.md").as_ref(), Some(&items[0]));
        let status = folder.status().unwrap();
        let held = status.files.iter().find(|file| file.path == "q.md");
        assert_eq!(
            held.and_then(|file| file.item_id.as_ref()),
            Some(&items[0]),
            "{status:?}"
        );
        let again = folder.scan().unwrap();
        assert_eq!((again.deleted, again.paused), (0, 0), "{again:?}");
        // Free of the clash, the file is read and its item follows it.
        std::fs::remove_file(paused.dir.path().join("Q.md")).unwrap();
        folder.scan().unwrap();
        assert_eq!(bound_item(folder, "q.md").as_ref(), Some(&items[0]));
        assert_eq!(deletes_queued(folder).len(), 1);
    }

    #[test]
    fn a_confirmed_removal_keeps_the_item_of_a_file_back_under_a_name_the_folder_does_not_send() {
        let (_, _registry) = registry::tests::own_registry();
        let paused = paused_over_query(
            "01a00000-0000-7000-8000-00000000c608",
            &["original.md", "gone.md"],
            serde_json::json!({ "types": ["core.note"] }),
        );
        paused.back("original.md", "original.bin");
        let Paused { folder, items, .. } = &paused;
        let confirmed = folder.confirm().unwrap();
        assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
        assert_eq!(deletes_queued(folder).len(), 1);
        assert_eq!(bound_item(folder, "original.md").as_ref(), Some(&items[0]));
        let status = folder.status().unwrap();
        let skipped = status.files.iter().find(|file| file.path == "original.bin");
        assert_eq!(
            skipped.and_then(|file| file.item_id.as_ref()),
            Some(&items[0]),
            "{status:?}"
        );
        assert!(
            !status.files.iter().any(|file| file.path == "original.md"),
            "{status:?}"
        );
        // Written back, the item would have two files.
        let pulled = folder.pull().unwrap();
        assert!(
            !paused.dir.path().join("original.md").exists(),
            "{pulled:?}"
        );
        // Once the file is gone under every name, its item goes too.
        std::fs::remove_file(paused.dir.path().join("original.bin")).unwrap();
        assert_eq!(folder.scan().unwrap().paused, 1);
        assert_eq!(folder.confirm().unwrap().deleted, 1);
        assert_eq!(deletes_queued(folder).len(), 2);
    }

    #[test]
    fn a_sweep_keeps_the_item_of_a_file_moved_to_a_name_the_folder_does_not_send() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-00000000c609",
            serde_json::json!({ "query": { "types": ["core.note"] } }),
            None,
        );
        std::fs::write(dir.path().join("note.md"), "words\n").unwrap();
        std::fs::write(dir.path().join("gone.md"), "more words\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 2);
        let item = landed(&folder, "note.md");
        landed(&folder, "gone.md");
        folder.pull().unwrap();
        std::fs::rename(dir.path().join("note.md"), dir.path().join("note.bin")).unwrap();
        std::fs::remove_file(dir.path().join("gone.md")).unwrap();
        let first = folder.scan().unwrap();
        assert_eq!(first.missing, 1, "{first:?}");
        past_the_grace(&folder, "gone.md");
        let swept = folder.scan().unwrap();
        // The witness: the file gone under every name is let go.
        assert_eq!(swept.trashed, ["gone.md"], "{swept:?}");
        assert_eq!(deletes_queued(&folder).len(), 1);
        assert_eq!(bound_item(&folder, "note.md"), Some(item));
    }

    #[cfg(all(unix, debug_assertions))]
    #[test]
    fn a_sweep_holds_a_file_whose_path_cannot_be_checked_as_it_decides_as_unsure() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-00000000c610",
            serde_json::json!({ "query": {} }),
            None,
        );
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/note.md"), "words\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let id = landed(&folder, "sub/note.md");
        folder.pull().unwrap();
        std::fs::remove_file(dir.path().join("sub/note.md")).unwrap();
        assert_eq!(folder.scan().unwrap().missing, 1);
        past_the_grace(&folder, "sub/note.md");
        let point = &format!("folder-sweep-decided:{id}");
        crate::fault::arm(point);
        let sealed = std::sync::Mutex::new(None);
        let swept = std::thread::scope(|scope| {
            let sealing = scope.spawn(|| {
                let waited = std::time::Instant::now();
                while crate::fault::waiting(point) == 0 {
                    if waited.elapsed() > std::time::Duration::from_secs(10) {
                        crate::fault::release(point);
                        panic!("the sweep never decided");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                *sealed.lock().unwrap() =
                    Some(crate::test_folders::locked(dir.path().join("sub"), 0o000));
                crate::fault::release(point);
            });
            let swept = folder.scan();
            sealing.join().unwrap();
            swept
        })
        .unwrap();
        assert!(swept.trashed.is_empty(), "{swept:?}");
        assert!(deletes_queued(&folder).is_empty(), "a delete was queued");
        assert!(
            swept
                .unsure
                .iter()
                .any(|file| file.path == "sub/note.md" && file.reason.contains("cannot be checked")),
            "{swept:?}"
        );
        drop(sealed.lock().unwrap().take());
        // The witness: once the path can be checked, the file gone is let go.
        let again = folder.scan().unwrap();
        assert_eq!(again.trashed, ["sub/note.md"], "{again:?}");
    }

    /// A folder of notes whose `note.md` moved to `note.bin`, a name it does
    /// not send, and a scan that found it there, with the item's id.
    fn carried_note(id: &str) -> (tempfile::TempDir, Folder, String) {
        let (dir, folder) = folder_with(
            id,
            serde_json::json!({ "query": { "types": ["core.note"] } }),
            None,
        );
        std::fs::write(dir.path().join("note.md"), "the original words\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let item = landed(&folder, "note.md");
        folder.pull().unwrap();
        std::fs::rename(dir.path().join("note.md"), dir.path().join("note.bin")).unwrap();
        let moved = folder.scan().unwrap();
        assert_eq!((moved.missing, moved.deleted), (0, 0), "{moved:?}");
        (dir, folder, item)
    }

    fn updates_queued(folder: &Folder, item: &str) -> usize {
        folder
            .core
            .queue()
            .unwrap()
            .iter()
            .filter(|write| {
                write.kind == crate::model::WriteKind::UpdateItem
                    && write.item_id.as_deref() == Some(item)
            })
            .count()
    }

    fn items_deleted(folder: &Folder) -> Vec<String> {
        folder
            .core
            .queue()
            .unwrap()
            .into_iter()
            .filter(|write| write.kind == crate::model::WriteKind::DeleteItem)
            .filter_map(|write| write.item_id)
            .collect()
    }

    fn waits_for(scanned: &super::super::ScanReport, path: &str, carrier: &str) -> bool {
        scanned.flagged.iter().any(|file| {
            file.path == path
                && file.flag == "waiting"
                && file.item.is_none()
                && file.reason
                    == format!("Marfa still holds this path for an item that {carrier} carries. Move {carrier} to a name the folder sends, or delete it, and this file is sent")
        })
    }

    /// `carried_note` with a new file written at the carried path, which the
    /// next scan holds.
    fn held_at_carried_path(id: &str) -> (tempfile::TempDir, Folder, String) {
        let (dir, folder, item) = carried_note(id);
        std::fs::write(dir.path().join("note.md"), "a different note altogether\n").unwrap();
        let scanned = folder.scan().unwrap();
        assert_eq!((scanned.created, scanned.updated), (0, 0), "{scanned:?}");
        assert!(waits_for(&scanned, "note.md", "note.bin"), "{scanned:?}");
        (dir, folder, item)
    }

    #[test]
    fn a_new_file_at_a_carried_path_waits_and_is_sent_once_its_carrier_has_a_name_the_folder_sends()
    {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c615");
        assert_eq!(updates_queued(&folder, &item), 0);
        assert_eq!(bound_item(&folder, "note.md"), Some(item.clone()));
        assert_eq!(
            super::super::tests::kept(&folder, "note.md"),
            Some(state::Kept::Carried("note.bin".into()))
        );
        let again = folder.scan().unwrap();
        assert_eq!((again.created, again.updated, again.missing), (0, 0, 0));
        assert!(waits_for(&again, "note.md", "note.bin"), "{again:?}");
        let pulled = folder.pull().unwrap();
        assert!(
            pulled
                .flagged
                .iter()
                .any(|file| file.item.as_deref() == Some(item.as_str()) && file.flag == "carried"),
            "{pulled:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("note.md")).unwrap(),
            "a different note altogether\n"
        );
        let status = folder.status().unwrap();
        assert!(
            status.files.iter().any(|file| file.path == "note.md"
                && file.item_id.is_none()
                && file.flag == Some("waiting")),
            "{status:?}"
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| file.path == "note.bin"
                    && file.item_id.as_deref() == Some(item.as_str())),
            "{status:?}"
        );

        std::fs::rename(dir.path().join("note.bin"), dir.path().join("moved.md")).unwrap();
        let sent = folder.scan().unwrap();
        assert_eq!((sent.created, sent.renamed), (1, 1), "{sent:?}");
        assert_eq!(bound_item(&folder, "moved.md"), Some(item.clone()));
        assert!(bound_item(&folder, "note.md").is_some_and(|other| other != item));
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(items_deleted(&folder).is_empty());
    }

    #[test]
    fn a_new_file_at_a_carried_path_is_the_items_edit_once_its_carrier_is_deleted() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c616");
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        let sent = folder.scan().unwrap();
        assert_eq!((sent.created, sent.updated), (0, 1), "{sent:?}");
        assert_eq!(updates_queued(&folder, &item), 1);
        assert_eq!(bound_item(&folder, "note.md"), Some(item));
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(items_deleted(&folder).is_empty());
    }

    #[test]
    fn a_new_file_at_a_carried_path_whose_carrier_went_in_the_same_scan_is_the_items_edit() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = carried_note("01a00000-0000-7000-8000-00000000c617");
        // The witness: with no carrier, a file saved anew at another note's
        // path is its edit.
        std::fs::write(dir.path().join("other.md"), "other words\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        let other = landed(&folder, "other.md");
        folder.pull().unwrap();
        std::fs::remove_file(dir.path().join("other.md")).unwrap();
        std::fs::write(dir.path().join("other.md"), "other words, edited\n").unwrap();
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        std::fs::write(dir.path().join("note.md"), "the words, saved again\n").unwrap();
        let scanned = folder.scan().unwrap();
        assert_eq!((scanned.created, scanned.updated), (0, 2), "{scanned:?}");
        assert_eq!(updates_queued(&folder, &other), 1);
        assert_eq!(updates_queued(&folder, &item), 1);
        assert_eq!(bound_item(&folder, "note.md"), Some(item.clone()));
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        let pulled = folder.pull().unwrap();
        assert!(
            !pulled
                .flagged
                .iter()
                .any(|file| file.item.as_deref() == Some(item.as_str())),
            "{pulled:?}"
        );
        assert!(items_deleted(&folder).is_empty());
    }

    #[test]
    fn a_new_file_at_a_carried_path_waits_while_its_carrier_is_renamed_in_the_same_scan() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = carried_note("01a00000-0000-7000-8000-00000000c618");
        std::fs::rename(dir.path().join("note.bin"), dir.path().join("note.dat")).unwrap();
        std::fs::write(dir.path().join("note.md"), "a different note altogether\n").unwrap();
        let scanned = folder.scan().unwrap();
        assert_eq!((scanned.created, scanned.updated), (0, 0), "{scanned:?}");
        assert_eq!(
            updates_queued(&folder, &item),
            0,
            "the carried item's words were replaced"
        );
        assert!(waits_for(&scanned, "note.md", "note.dat"), "{scanned:?}");
        assert_eq!(
            super::super::tests::kept(&folder, "note.md"),
            Some(state::Kept::Carried("note.dat".into()))
        );
    }

    #[test]
    fn a_carried_item_follows_its_carrier_renamed_again_while_a_new_file_waits_at_its_path() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c619");
        std::fs::rename(dir.path().join("note.bin"), dir.path().join("note.dat")).unwrap();
        let scanned = folder.scan().unwrap();
        assert_eq!(scanned.missing, 0, "{scanned:?}");
        assert!(waits_for(&scanned, "note.md", "note.dat"), "{scanned:?}");
        assert_eq!(
            super::super::tests::kept(&folder, "note.md"),
            Some(state::Kept::Carried("note.dat".into()))
        );
        past_the_grace(&folder, "note.md");
        let swept = folder.scan().unwrap();
        assert_eq!((swept.missing, swept.deleted), (0, 0), "{swept:?}");
        assert!(
            items_deleted(&folder).is_empty(),
            "the carried item was trashed"
        );
        assert_eq!(bound_item(&folder, "note.md"), Some(item));
    }

    #[test]
    fn a_carried_item_changed_elsewhere_is_written_back_once_its_files_are_gone() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c61a");
        super::super::tests::changed_elsewhere(&folder, &item, "changed elsewhere");
        std::fs::remove_file(dir.path().join("note.md")).unwrap();
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        folder.scan().unwrap();
        past_the_grace(&folder, "note.md");
        let swept = folder.scan().unwrap();
        assert!(
            items_deleted(&folder).is_empty(),
            "the changed item was trashed"
        );
        assert_eq!(swept.deleted, 0, "{swept:?}");
        let pulled = folder.pull().unwrap();
        let written = std::fs::read_to_string(dir.path().join("note.md")).unwrap();
        assert!(
            written.contains("changed elsewhere"),
            "{pulled:?} {written}"
        );
        // The witness: unchanged, the same item goes once its grace has run.
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c61b");
        std::fs::remove_file(dir.path().join("note.md")).unwrap();
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        assert_eq!(folder.scan().unwrap().missing, 1);
        past_the_grace(&folder, "note.md");
        folder.scan().unwrap();
        assert_eq!(items_deleted(&folder), [item]);
    }

    #[test]
    fn a_new_file_deleted_while_it_waits_at_a_carried_path_leaves_nothing_to_send() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = held_at_carried_path("01a00000-0000-7000-8000-00000000c61c");
        std::fs::remove_file(dir.path().join("note.md")).unwrap();
        for _ in 0..2 {
            let scanned = folder.scan().unwrap();
            assert_eq!(scanned.missing, 0, "{scanned:?}");
        }
        assert_eq!(
            super::super::tests::kept(&folder, "note.md"),
            Some(state::Kept::Carried("note.bin".into()))
        );
        let pulled = folder.pull().unwrap();
        assert_eq!(pulled.unwritten, 0, "{pulled:?}");
        assert!(
            pulled
                .flagged
                .iter()
                .all(|file| file.item.as_deref() == Some(item.as_str()) && file.flag == "carried"),
            "{pulled:?}"
        );
        folder.health_observe(true, true, Some(&pulled), None, false);
        let observed = folder.observed_health().unwrap();
        assert_eq!(observed.pending_downloads, 0, "{observed:?}");
        assert!(items_deleted(&folder).is_empty());
    }

    #[test]
    fn a_pull_names_the_file_that_carries_a_kept_item_and_counts_no_download() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = carried_note("01a00000-0000-7000-8000-00000000c612");
        let pulled = folder.pull().unwrap();
        assert!(!dir.path().join("note.md").exists(), "{pulled:?}");
        assert_eq!(pulled.unwritten, 0, "{pulled:?}");
        let flagged = pulled
            .flagged
            .iter()
            .find(|file| file.item.as_deref() == Some(item.as_str()));
        assert!(
            flagged.is_some_and(|file| file.flag == "carried" && file.reason.contains("note.bin")),
            "{pulled:?}"
        );
        folder.health_observe(true, true, Some(&pulled), None, false);
        let observed = folder.observed_health().unwrap();
        assert_eq!(observed.pending_downloads, 0, "{observed:?}");
        assert!(observed.problems.is_empty(), "{observed:?}");
        // The witness: an item whose file is gone under every name is a
        // download its pull counts.
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        let unwritten = super::super::PullReport {
            flagged: vec![Flagged {
                path: "note.md".into(),
                flag: "unwritten",
                reason: "a reason".into(),
                item: Some(item),
            }],
            ..super::super::PullReport::default()
        };
        folder.health_observe(true, true, Some(&unwritten), None, false);
        assert_eq!(folder.observed_health().unwrap().pending_downloads, 1);
    }

    #[test]
    fn status_names_the_item_on_an_emptied_file_that_carries_it() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder, item) = carried_note("01a00000-0000-7000-8000-00000000c613");
        // Emptied in place, the file keeps its identity.
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(dir.path().join("note.bin"))
            .unwrap();
        let scanned = folder.scan().unwrap();
        assert_eq!((scanned.missing, scanned.deleted), (0, 0), "{scanned:?}");
        let status = folder.status().unwrap();
        let carrier = status.files.iter().find(|file| file.path == "note.bin");
        assert_eq!(
            carrier.and_then(|file| file.item_id.as_ref()),
            Some(&item),
            "{status:?}"
        );
        assert!(
            !status.files.iter().any(|file| file.path == "note.md"),
            "{status:?}"
        );
        // The witness: gone under every name, the file waits for its delete.
        std::fs::remove_file(dir.path().join("note.bin")).unwrap();
        let status = folder.status().unwrap();
        assert!(
            status.files.iter().any(|file| file.path == "note.md"
                && file.item_id.as_ref() == Some(&item)
                && file.status == "waiting"),
            "{status:?}"
        );
    }

    #[cfg(all(unix, debug_assertions))]
    #[test]
    fn a_sweep_that_cannot_read_a_file_held_for_its_name_journals_no_missing_file_and_says_why() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-00000000c614",
            serde_json::json!({ "query": {} }),
            None,
        );
        if !keeps_case_apart(dir.path()) {
            eprintln!("skipped: the temporary folder reads names in either case as one");
            return;
        }
        std::fs::write(dir.path().join("Q.md"), "a note\n").unwrap();
        std::fs::write(dir.path().join("q.md"), "another note\n").unwrap();
        std::fs::write(dir.path().join("gone.md"), "words\n").unwrap();
        folder.scan().unwrap();
        let gone = landed(&folder, "gone.md");
        folder.pull().unwrap();
        let held = ["Q.md", "q.md"]
            .into_iter()
            .find(|name| bound_item(&folder, name).is_none())
            .expect("one of the two names is held");
        std::fs::remove_file(dir.path().join("gone.md")).unwrap();
        let point = "folder-sweep-carriers";
        crate::fault::arm(point);
        let sealed = std::sync::Mutex::new(None);
        let scanned = std::thread::scope(|scope| {
            let sealing = scope.spawn(|| {
                let waited = std::time::Instant::now();
                while crate::fault::waiting(point) == 0 {
                    if waited.elapsed() > std::time::Duration::from_secs(10) {
                        crate::fault::release(point);
                        panic!("the sweep never looked for carriers");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                *sealed.lock().unwrap() =
                    Some(crate::test_folders::locked(dir.path().join(held), 0o000));
                crate::fault::release(point);
            });
            let scanned = folder.scan();
            sealing.join().unwrap();
            scanned
        })
        .unwrap();
        assert_eq!(scanned.missing, 0, "{scanned:?}");
        assert!(!scanned.swept, "{scanned:?}");
        assert!(
            state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(
            scanned.flagged.iter().any(|file| file.path == held
                && file.flag == "unreadable"
                && file.reason.contains("journals no missing file")),
            "{scanned:?}"
        );
        drop(sealed.lock().unwrap().take());
        // The witness: once the held file can be read, the file gone is journaled.
        let again = folder.scan().unwrap();
        assert_eq!(again.missing, 1, "{again:?}");
        assert_eq!(bound_item(&folder, "gone.md"), Some(gone));
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
                matches!(&error, Err(crate::error::CoreError::SyncPaused)),
                "{error:?}"
            );
        };

        // The witness: each command acts on this state before the pause.
        let witness = kept(folder);
        assert!(witness.contains("one.md"), "{witness}");
        assert_eq!(
            state::paused(&folder.core.conn().unwrap(), state::Removal::Disk)
                .unwrap()
                .len(),
            2
        );

        folder.pause_sync().unwrap();
        refused(folder.confirm().map(drop));
        refused(folder.restore().map(drop));
        refused(folder.remove_unmatched(&["one.md".into()]).map(drop));
        refused(folder.scan().map(drop));
        refused(folder.hydrate().map(drop));
        refused(folder.confirm_first_sync().map(drop));
        refused(folder.plan_first_sync().map(drop));
        assert_eq!(
            kept(folder),
            witness,
            "a refused command changed the folder"
        );

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
            Err(crate::error::CoreError::SyncPaused)
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
