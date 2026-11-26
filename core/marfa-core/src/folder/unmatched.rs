use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::pull::{TakenAway, TakenNow, held_empty};
use super::{Folder, copy_changed, lists::Lists, plainly_inside, state};
use crate::Result;

/// A file the folder keeps whose item the folder's query does not match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unmatched {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// Why removing the file would keep it, where it would, as a clause that
    /// follows `is kept:`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<String>,
    /// Why the folder holds the file where it has no item yet: a new file the
    /// query would not hold, in a folder whose `outside_query` is `hold`.
    /// Removing unmatched files never takes it away.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held: Option<String>,
    /// Why a removal a stop left holds the file's binding where no file is
    /// at its path. Removing unmatched files ends it and keeps the item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removing: Option<String>,
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
    /// Removals a stop left, ended because no file is at their paths. Their
    /// items are unchanged.
    pub settled: Vec<Unmatched>,
}

impl Folder {
    /// The unmatched files of the folder at `root` as the last pull left
    /// them, read from its store without claiming it, so it answers beside a
    /// running watch.
    pub fn unmatched_of(root: impl AsRef<Path>) -> Result<Vec<Unmatched>> {
        Folder::reading(root.as_ref())?.unmatched_files()
    }

    /// The files whose items the last pull left in place because the query
    /// no longer matches them, in path order. Each says why removing it would
    /// keep it, where it would.
    pub fn unmatched_files(&self) -> Result<Vec<Unmatched>> {
        self.refuse_if_gone()?;
        let (unmatched, bound) = {
            let conn = self.core.conn()?;
            (state::unmatched(&conn)?, state::every_bound(&conn)?)
        };
        let held = state::held_outside(&*self.core.conn()?)?;
        let removing = self.removals_ended_by_hand()?;
        let unmatched: HashSet<String> = unmatched.into_iter().collect();
        let mut rows: Vec<state::Bound> = bound
            .iter()
            .filter(|row| unmatched.contains(&row.item_id) && !removing.contains_key(&row.path))
            .cloned()
            .collect();
        let removing = removing.into_iter().map(|(path, (record, why))| {
            let item_id = bound
                .iter()
                .find(|row| row.path == path)
                .map(|row| row.item_id.clone())
                .or(record.map(|record| record.item_id));
            Unmatched {
                path,
                item_id,
                kept: None,
                held: None,
                removing: Some(why),
            }
        });
        if rows.is_empty() {
            let mut files: Vec<Unmatched> =
                held.into_iter().map(held_entry).chain(removing).collect();
            files.sort_by(|a, b| a.path.cmp(&b.path));
            return Ok(files);
        }
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let members = self.members(&settings)?;
        let recorded = state::new_outside_state(&*self.core.conn()?)?;
        let mut files = rows
            .into_iter()
            .map(|row| {
                let row = as_removable(row, &recorded);
                let kept = self.kept_because(&row, &members, &settings, &lists)?;
                Ok(entry(&row, kept))
            })
            .collect::<Result<Vec<Unmatched>>>()?;
        files.extend(held.into_iter().map(held_entry));
        files.extend(removing);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// The removals a stop left whose paths hold no file but which recovery
    /// cannot end, each with its record, where it reads, and why it holds.
    fn removals_ended_by_hand(
        &self,
    ) -> Result<std::collections::HashMap<String, (Option<state::Taken>, String)>> {
        if self.root_gone().is_some() {
            return Ok(Default::default());
        }
        let taken = state::taken(&*self.core.conn()?)?;
        Ok(taken
            .into_iter()
            .filter_map(
                |(path, record)| match self.taken_now(&path, record.as_ref()) {
                    TakenNow::Empty(why) => Some((path, (record, held_empty(&why)))),
                    TakenNow::Present | TakenNow::Absent | TakenNow::Unsure(_) => None,
                },
            )
            .collect())
    }

    /// Ends a removal a stop left at `path`, as recovery ends one whose file
    /// is gone, where no file is at its path: its binding ends and its item
    /// stays. Answers the item whose binding ended, or `None` where there
    /// was no such removal.
    fn end_removal(&self, path: &str) -> Result<Option<Option<String>>> {
        let Some((record, _)) = self.removals_ended_by_hand()?.remove(path) else {
            return Ok(None);
        };
        let conn = self.core.conn()?;
        let tx = conn.unchecked_transaction()?;
        let bound = state::bound_at(&tx, path)?.filter(|bound| {
            record
                .as_ref()
                .is_none_or(|record| record.item_id == bound.item_id)
        });
        if let Some(bound) = &bound {
            state::unbind(&tx, path)?;
            state::journal_clear(&tx, path, &bound.item_id)?;
        }
        state::clear_taken(&tx, path)?;
        tx.commit()?;
        Ok(Some(
            bound
                .map(|bound| bound.item_id)
                .or(record.map(|record| record.item_id)),
        ))
    }

    /// Takes away the named unmatched files, each only while it is still
    /// unmatched, still the bytes the folder wrote, and has no edit waiting
    /// to be sent. Ends the folder's placement of each item first; the item
    /// itself is not changed. A file that cannot go is kept and reported, and
    /// the rest go on. A path named twice is taken once, and one that is not
    /// plainly inside the folder, or names no unmatched file, is kept.
    pub fn remove_unmatched(&self, paths: &[String]) -> Result<UnmatchedRemoved> {
        self.refuse_if_gone()?;
        self.refuse_while_paused()?;
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
        let recorded = state::new_outside_state(&*self.core.conn()?)?;
        let held = state::held_outside(&*self.core.conn()?)?;
        let mut named = HashSet::new();
        for path in paths {
            if !named.insert(path.as_str()) {
                continue;
            }
            let unbound = |why: &str| Unmatched {
                path: path.clone(),
                item_id: None,
                kept: Some(why.into()),
                held: None,
                removing: None,
            };
            if !plainly_inside(&self.root_dir, path) {
                let reason = "it is not inside the folder";
                match state::bound_at(&*self.core.conn()?, path)? {
                    Some(row) => done.kept.push(entry(&row, Some(reason.into()))),
                    None => done.kept.push(unbound(reason)),
                }
                continue;
            }
            if held.contains(path) {
                done.kept.push(unbound(
                    "it is held outside the query with no item, which removing unmatched files never takes away",
                ));
                continue;
            }
            if let Some(item_id) = self.end_removal(path)? {
                if let Some(item_id) = &item_id
                    && state::bound_to_item(&*self.core.conn()?, item_id)?.is_none()
                {
                    unmatched.retain(|id| id != item_id);
                }
                done.settled.push(Unmatched {
                    path: path.clone(),
                    item_id,
                    kept: None,
                    held: None,
                    removing: None,
                });
                continue;
            }
            let Some(row) = state::bound_at(&*self.core.conn()?, path)? else {
                done.kept.push(unbound("it is not a file of the folder"));
                continue;
            };
            let row = as_removable(row, &recorded);
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
                Ok(TakenAway::Ended(ended)) => {
                    done.ended += ended;
                    done.removed.push(entry(&row, None));
                    if state::bound_to_item(&*self.core.conn()?, &row.item_id)?.is_none() {
                        unmatched.retain(|id| *id != row.item_id);
                        let conn = self.core.conn()?;
                        let mut outside = state::new_outside_state(&conn)?;
                        if outside.contains(&row.item_id) {
                            outside.retain(|id| *id != row.item_id);
                            state::set_new_outside_state(&conn, &outside)?;
                        }
                    }
                }
                Ok(TakenAway::Kept) => done.kept.push(entry(
                    &row,
                    Some("it changed while it was being removed".into()),
                )),
                Ok(TakenAway::Refused(reason) | TakenAway::Busy(reason)) => {
                    done.kept.push(entry(&row, Some(reason)))
                }
                Err(error) if copy_changed(&error) => return Err(error),
                Err(error) => done.kept.push(entry(&row, Some(error.to_string()))),
            }
        }
        state::set_unmatched(&*self.core.conn()?, &unmatched)?;
        self.settle_retained()?;
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
                return Ok(Some("its item matches the query again".into()));
            }
            Some(item)
                if !settings.holds_state(item.state)
                    && !state::new_outside_state(&*self.core.conn()?)?.contains(&item.id) =>
            {
                return Ok(Some(
                    "its item left the query's states, which the next pull settles".into(),
                ));
            }
            Some(_) => {}
        }
        if row.held.is_some() || row.holds_refusal() {
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

/// A file made from a new file outside the query's states holds the bytes
/// the person made, which the folder never wrote; the scan's read of them
/// stands for what it wrote, so they go while unchanged.
fn as_removable(mut row: state::Bound, recorded: &[String]) -> state::Bound {
    if row.written_hash.is_none() && recorded.contains(&row.item_id) {
        row.written_hash = Some(row.content_hash.clone());
    }
    row
}

fn entry(row: &state::Bound, kept: Option<String>) -> Unmatched {
    Unmatched {
        path: row.path.clone(),
        item_id: Some(row.item_id.clone()),
        kept,
        held: None,
        removing: None,
    }
}

/// The reason the status of a held file gives, too.
pub(super) const HELD_OUTSIDE_REASON: &str = "is a new file that the folder's query would not hold, so it is held on disk and not sent, with no item: it is sent once its content matches the query, or once the folder's `outside_query` is `send`";

fn held_entry(path: String) -> Unmatched {
    Unmatched {
        path,
        item_id: None,
        kept: None,
        held: Some(HELD_OUTSIDE_REASON.into()),
        removing: None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[cfg(debug_assertions)]
    use super::super::tests::{deletes_queued, past_the_grace};
    use super::super::tests::{
        folder_with, landed, scanned_folder_with, set_item_state, write_note,
    };
    use super::super::{Folder, registry, state};

    /// A folder whose `new.md` is unmatched and may be removed, with its item's id.
    fn removable() -> (
        impl std::ops::Deref<Target = tempfile::TempDir>,
        Folder,
        String,
    ) {
        removable_at("new.md")
    }

    /// A folder whose file at `path` is unmatched and may be removed, with
    /// its item's id.
    fn removable_at(
        path: &str,
    ) -> (
        impl std::ops::Deref<Target = tempfile::TempDir>,
        Folder,
        String,
    ) {
        let (dir, folder) = scanned_folder_with(
            serde_json::json!({ "query": { "state": ["active"] } }),
            None,
        );
        let file = dir.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "---\ntitle: new\nstate: archived\n---\nbody\n").unwrap();
        assert_eq!(folder.scan().unwrap().created, 1);
        folder.scan().unwrap();
        let id = landed(&folder, path);
        let conn = folder.core.conn().unwrap();
        conn.execute("DELETE FROM queue", []).unwrap();
        drop(conn);
        set_item_state(&folder, &id, "archived");
        assert_eq!(folder.pull().unwrap().unmatched, 1);
        let conn = folder.core.conn().unwrap();
        let mut row = state::bound_at(&conn, path).unwrap().unwrap();
        row.writes.queued.clear();
        state::bind(&conn, &row).unwrap();
        drop(conn);
        (dir, folder, id)
    }

    /// Moves the directory `sub` of `dir` into `elsewhere` and leaves a
    /// symbolic link to it in its place.
    fn sub_made_a_link(dir: &Path, elsewhere: &Path) {
        std::fs::rename(dir.join("sub"), elsewhere.join("sub")).unwrap();
        std::os::unix::fs::symlink(elsewhere.join("sub"), dir.join("sub")).unwrap();
    }

    fn kept_reasons(done: &super::UnmatchedRemoved) -> Vec<(&str, &str)> {
        done.kept
            .iter()
            .map(|file| (file.path.as_str(), file.kept.as_deref().unwrap_or("")))
            .collect()
    }

    #[test]
    fn removing_unmatched_keeps_each_path_it_may_not_take_once_and_touches_nothing_outside() {
        let (dir, folder, id) = removable();
        let bytes = std::fs::read(dir.path().join("new.md")).unwrap();
        let outside = tempfile::tempdir_in(dir.path().parent().unwrap()).unwrap();
        std::fs::write(outside.path().join("new.md"), &bytes).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let sibling = outside.path().file_name().unwrap().to_str().unwrap();
        let escape = format!("../{sibling}/new.md");
        let absolute = outside.path().join("new.md").display().to_string();
        let paths: Vec<String> = [
            "new.md",
            "new.md",
            &escape,
            &absolute,
            "link/new.md",
            "",
            "./new.md",
            "missing.md",
        ]
        .map(str::to_string)
        .to_vec();

        let done = folder.remove_unmatched(&paths).unwrap();

        let removed: Vec<&str> = done.removed.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(removed, ["new.md"], "{done:?}");
        let outside_reason = "it is not inside the folder";
        assert_eq!(
            kept_reasons(&done),
            [
                (escape.as_str(), outside_reason),
                (absolute.as_str(), outside_reason),
                ("link/new.md", outside_reason),
                ("", outside_reason),
                ("./new.md", outside_reason),
                ("missing.md", "it is not a file of the folder"),
            ],
            "{done:?}"
        );
        assert!(!dir.path().join("new.md").exists());
        assert_eq!(std::fs::read(outside.path().join("new.md")).unwrap(), bytes);
        assert!(dir.path().join("link").is_symlink());
        assert!(folder.core.get(&id).unwrap().is_some(), "the item went");
    }

    #[test]
    fn removing_unmatched_keeps_a_file_replaced_by_a_link_and_leaves_what_it_names() {
        let (dir, folder, _) = removable();
        let bytes = std::fs::read(dir.path().join("new.md")).unwrap();
        let outside = tempfile::tempdir_in(dir.path().parent().unwrap()).unwrap();
        let target = outside.path().join("new.md");
        std::fs::write(&target, &bytes).unwrap();
        std::fs::remove_file(dir.path().join("new.md")).unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("new.md")).unwrap();

        let done = folder.remove_unmatched(&["new.md".into()]).unwrap();

        assert!(done.removed.is_empty(), "{done:?}");
        assert_eq!(done.kept.len(), 1, "{done:?}");
        assert!(done.kept[0].kept.is_some(), "{done:?}");
        assert!(dir.path().join("new.md").is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn removing_unmatched_keeps_a_file_held_outside_the_query_and_says_so() {
        let (_, _registry) = registry::tests::own_registry();
        let (dir, folder) = folder_with(
            "01a00000-0000-7000-8000-00000000b0f1",
            serde_json::json!({ "query": { "state": ["active"] }, "outside_query": "hold" }),
            None,
        );
        write_note(dir.path(), "in.md", "");
        write_note(dir.path(), "out.md", "state: archived\n");
        assert_eq!(folder.scan().unwrap().held_outside, 1);
        landed(&folder, "in.md");

        let done = folder
            .remove_unmatched(&["out.md".into(), "out.md".into()])
            .unwrap();

        assert!(done.removed.is_empty(), "{done:?}");
        assert_eq!(done.kept.len(), 1, "{done:?}");
        assert_eq!(done.kept[0].path, "out.md");
        assert!(
            done.kept[0]
                .kept
                .as_deref()
                .is_some_and(|reason| reason.contains("held")),
            "{done:?}"
        );
        assert!(Path::new(&dir.path().join("out.md")).is_file());
    }

    #[test]
    fn removing_unmatched_names_the_item_of_a_bound_file_behind_a_link() {
        let (dir, folder, id) = removable_at("sub/new.md");
        let elsewhere = tempfile::tempdir_in(dir.path().parent().unwrap()).unwrap();
        sub_made_a_link(dir.path(), elsewhere.path());

        let done = folder.remove_unmatched(&["sub/new.md".into()]).unwrap();

        assert!(done.removed.is_empty(), "{done:?}");
        assert_eq!(done.kept.len(), 1, "{done:?}");
        assert_eq!(
            done.kept[0].item_id.as_deref(),
            Some(id.as_str()),
            "{done:?}"
        );
        assert!(elsewhere.path().join("sub/new.md").is_file());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn removing_unmatched_keeps_a_file_whose_directory_becomes_a_link_as_it_goes() {
        const POINT: &str = "folder-take-away-ended";
        let (dir, folder, id) = removable_at("sub/new.md");
        let bytes = std::fs::read(dir.path().join("sub/new.md")).unwrap();
        let elsewhere = tempfile::tempdir_in(dir.path().parent().unwrap()).unwrap();
        crate::fault::arm(POINT);
        let swapper = {
            let (root, elsewhere) = (dir.path().to_path_buf(), elsewhere.path().to_path_buf());
            std::thread::spawn(move || {
                while crate::fault::waiting(POINT) == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                sub_made_a_link(&root, &elsewhere);
                crate::fault::release(POINT);
            })
        };

        let done = folder.remove_unmatched(&["sub/new.md".into()]).unwrap();
        swapper.join().unwrap();

        assert!(done.removed.is_empty(), "{done:?}");
        assert_eq!(done.kept.len(), 1, "{done:?}");
        assert_eq!(
            done.kept[0].item_id.as_deref(),
            Some(id.as_str()),
            "{done:?}"
        );
        assert!(
            done.kept[0]
                .kept
                .as_deref()
                .is_some_and(|reason| reason.contains("symbolic link")),
            "{done:?}"
        );
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, "sub/new.md").unwrap().is_some());
        assert_eq!(
            std::fs::read(elsewhere.path().join("sub/new.md")).unwrap(),
            bytes
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn removing_unmatched_stopped_at_any_step_never_reads_the_gap_as_a_delete() {
        for point in [
            "crash-before-take-away",
            "crash-after-withdraw",
            "crash-after-take-away",
        ] {
            let (dir, folder, id) = removable();
            let root = dir.path().to_path_buf();
            {
                let _stop = crate::fault::fail_on_this_thread(point);
                let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    folder.remove_unmatched(&["new.md".into()])
                }));
                assert!(stopped.is_err(), "{point}: it did not stop");
            }
            drop(folder);
            let folder = Folder::open(&root, None).unwrap();
            folder.scan().unwrap();
            let journaled = state::journaled(&folder.core.conn().unwrap())
                .unwrap()
                .iter()
                .any(|row| row.path == "new.md");
            if journaled {
                past_the_grace(&folder, "new.md");
                folder.scan().unwrap();
            }

            assert!(deletes_queued(&folder).is_empty(), "{point}");
            let item = folder.core.get(&id).unwrap().unwrap();
            assert_eq!(item.state, crate::model::ItemState::Archived, "{point}");
            let bound = state::bound_at(&folder.core.conn().unwrap(), "new.md").unwrap();
            // Stopped before the file went, it stays bound for a later removal.
            assert_eq!(
                bound.is_some(),
                root.join("new.md").exists(),
                "{point}: the binding and the file disagree"
            );
            if point != "crash-before-take-away" {
                assert!(!root.join("new.md").exists(), "{point}");
            }
            let held = point == "crash-before-take-away" && !births_kept(&root, "new.md");
            assert_eq!(
                state::taken(&folder.core.conn().unwrap()).unwrap().len(),
                usize::from(held),
                "{point}"
            );
            if held {
                assert!(held_in_status(&folder, "new.md"));
            }
        }
    }

    /// Reopens the folder after the injected stop.
    #[cfg(debug_assertions)]
    fn stopped_at(folder: Folder, root: &Path, path: &str, point: &str) -> Folder {
        {
            let _stop = crate::fault::fail_on_this_thread(point);
            let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                folder.remove_unmatched(&[path.into()])
            }));
            assert!(stopped.is_err(), "{point}: it did not stop");
        }
        drop(folder);
        Folder::open(root, None).unwrap()
    }

    /// Scans, and once more past the rename grace where the file is journaled.
    #[cfg(debug_assertions)]
    fn scanned_past_the_grace(folder: &Folder, path: &str) {
        folder.scan().unwrap();
        let journaled = state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .iter()
            .any(|row| row.path == path);
        if journaled {
            past_the_grace(folder, path);
            folder.scan().unwrap();
        }
    }

    #[cfg(debug_assertions)]
    fn births_kept(root: &Path, path: &str) -> bool {
        std::fs::metadata(root.join(path))
            .unwrap()
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .is_some_and(|age| !age.is_zero())
    }

    /// Held, with its record, and no delete once the person removes it.
    #[cfg(debug_assertions)]
    fn held_until_removed(folder: &Folder, root: &Path, path: &str) {
        assert_eq!(state::taken(&folder.core.conn().unwrap()).unwrap().len(), 1);
        let conn = folder.core.conn().unwrap();
        let bound = state::bound_at(&conn, path).unwrap().unwrap();
        let records = state::taken(&conn).unwrap();
        assert!(records.iter().any(|(name, record)| {
            name == path
                && record
                    .as_ref()
                    .is_some_and(|taken| taken.item_id == bound.item_id)
        }));
        drop(conn);
        assert!(held_in_status(folder, path));
        assert!(folder.core.queue().unwrap().iter().all(|write| !matches!(
            write.kind,
            crate::model::WriteKind::UpdateItem | crate::model::WriteKind::DeleteItem
        )));
        std::fs::remove_file(root.join(path)).unwrap();
        scanned_past_the_grace(folder, path);
        assert!(folder.core.queue().unwrap().iter().all(|write| !matches!(
            write.kind,
            crate::model::WriteKind::UpdateItem | crate::model::WriteKind::DeleteItem
        )));
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, path).unwrap().is_none());
        assert!(state::taken(&conn).unwrap().is_empty());
    }

    #[cfg(debug_assertions)]
    fn held_in_status(folder: &Folder, path: &str) -> bool {
        folder.status().unwrap().files.iter().any(|file| {
            file.path == path
                && file.status == "held"
                && file.flag == Some(super::super::pull::REMOVING)
                && file.reason.is_some()
        })
    }

    #[cfg(debug_assertions)]
    #[test]
    fn removing_unmatched_refused_after_the_move_aside_never_reads_the_gap_as_a_delete() {
        let (dir, folder, id) = removable();
        let done = {
            let _refused = crate::fault::fail_on_this_thread("withdraw-look-refused");
            folder.remove_unmatched(&["new.md".into()]).unwrap()
        };
        assert!(done.removed.is_empty(), "{done:?}");
        assert!(!dir.path().join("new.md").exists());

        scanned_past_the_grace(&folder, "new.md");

        assert!(deletes_queued(&folder).is_empty());
        let item = folder.core.get(&id).unwrap().unwrap();
        assert_eq!(item.state, crate::model::ItemState::Archived);
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, "new.md").unwrap().is_none());
        assert!(state::taken(&conn).unwrap().is_empty());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_later_delete_of_a_file_that_stayed_requires_a_confirmed_identity() {
        let (dir, folder, _) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-before-take-away");

        folder.scan().unwrap();
        if !births_kept(&root, "new.md") {
            return held_until_removed(&folder, &root, "new.md");
        }
        assert!(
            state::taken(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(
            state::bound_at(&folder.core.conn().unwrap(), "new.md")
                .unwrap()
                .is_some()
        );
        std::fs::remove_file(root.join("new.md")).unwrap();
        scanned_past_the_grace(&folder, "new.md");

        assert_eq!(deletes_queued(&folder).len(), 1);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_later_delete_of_a_restored_file_requires_a_confirmed_identity() {
        let (dir, folder, _) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-after-withdraw");
        fn reserved_below(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    reserved_below(&path, found);
                } else if super::super::landing::is_reserved(&path) {
                    found.push(path);
                }
            }
        }
        let mut aside = Vec::new();
        reserved_below(&root, &mut aside);
        assert_eq!(aside.len(), 1, "{aside:?}");
        std::fs::rename(&aside[0], root.join("new.md")).unwrap();

        folder.scan().unwrap();
        if !births_kept(&root, "new.md") {
            return held_until_removed(&folder, &root, "new.md");
        }
        {
            let conn = folder.core.conn().unwrap();
            assert!(state::taken(&conn).unwrap().is_empty());
            assert!(state::bound_at(&conn, "new.md").unwrap().is_some());
        }
        std::fs::remove_file(root.join("new.md")).unwrap();
        scanned_past_the_grace(&folder, "new.md");

        assert_eq!(deletes_queued(&folder).len(), 1);
    }

    /// The device cannot distinguish the owner's delete from its own removal.
    #[cfg(debug_assertions)]
    #[test]
    fn a_removal_stopped_before_the_move_aside_then_deleted_by_the_owner_keeps_the_item() {
        let (dir, folder, id) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-before-take-away");
        std::fs::remove_file(root.join("new.md")).unwrap();

        scanned_past_the_grace(&folder, "new.md");

        assert!(deletes_queued(&folder).is_empty());
        assert!(folder.core.get(&id).unwrap().is_some());
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, "new.md").unwrap().is_none());
        assert!(state::taken(&conn).unwrap().is_empty());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn matching_bytes_without_a_recorded_birth_stay_held_until_the_path_is_empty() {
        for born in [None, Some(0)] {
            let (dir, folder, _) = removable();
            let root = dir.path();
            let folder = stopped_at(folder, root, "new.md", "crash-before-take-away");
            let conn = folder.core.conn().unwrap();
            let mut records = state::taken(&conn).unwrap();
            let (path, record) = records.pop().unwrap();
            let mut record = record.unwrap();
            record.file.born = born;
            state::set_taken(&conn, &path, &record).unwrap();
            drop(conn);
            folder.scan().unwrap();
            held_until_removed(&folder, root, &path);
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_removal_stopped_before_the_move_aside_holds_another_file_at_its_path() {
        let (dir, folder, _) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-before-take-away");
        let mut bytes = std::fs::read(root.join("new.md")).unwrap();
        bytes.extend_from_slice(b"\nsaved by another program\n");
        std::fs::write(root.join("new.md.saved"), &bytes).unwrap();
        std::fs::rename(root.join("new.md.saved"), root.join("new.md")).unwrap();
        let queued = folder.core.queue().unwrap().len();

        folder.scan().unwrap();

        assert_eq!(
            folder.core.queue().unwrap().len(),
            queued,
            "it sent the file"
        );
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, "new.md").unwrap().is_some());
        assert_eq!(state::taken(&conn).unwrap().len(), 1);
        drop(conn);
        assert!(held_in_status(&folder, "new.md"));
        std::fs::remove_file(root.join("new.md")).unwrap();
        scanned_past_the_grace(&folder, "new.md");
        assert!(deletes_queued(&folder).is_empty());
        assert!(
            state::taken(&folder.core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_removal_stopped_before_the_move_aside_holds_a_file_behind_a_link_until_it_is_back() {
        let (dir, folder, _) = removable_at("sub/new.md");
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "sub/new.md", "crash-before-take-away");
        let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
        sub_made_a_link(&root, elsewhere.path());

        scanned_past_the_grace(&folder, "sub/new.md");

        assert!(deletes_queued(&folder).is_empty());
        let conn = folder.core.conn().unwrap();
        assert!(state::bound_at(&conn, "sub/new.md").unwrap().is_some());
        assert_eq!(state::taken(&conn).unwrap().len(), 1);
        drop(conn);
        assert!(held_in_status(&folder, "sub/new.md"));
        assert!(elsewhere.path().join("sub/new.md").is_file());

        std::fs::remove_file(root.join("sub")).unwrap();
        std::fs::rename(elsewhere.path().join("sub"), root.join("sub")).unwrap();
        folder.scan().unwrap();
        if !births_kept(&root, "sub/new.md") {
            return held_until_removed(&folder, &root, "sub/new.md");
        }
        let conn = folder.core.conn().unwrap();
        assert!(state::taken(&conn).unwrap().is_empty());
        assert!(state::bound_at(&conn, "sub/new.md").unwrap().is_some());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_file_an_editor_replaced_as_its_removal_went_stays_held_until_it_is_gone() {
        let (dir, folder, _) = removable();
        let done = {
            let _save = crate::fault::fail_on_this_thread("save-after-last-look");
            folder.remove_unmatched(&["new.md".into()]).unwrap()
        };
        assert!(done.removed.is_empty(), "{done:?}");
        assert_eq!(done.kept.len(), 1, "{done:?}");
        assert!(
            std::fs::read_to_string(dir.path().join("new.md"))
                .unwrap()
                .contains("saved after the last look"),
            "the editor's save was not at the path, so nothing below is about it"
        );

        held_until_removed(&folder, dir.path(), "new.md");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_removal_stopped_before_the_move_aside_stays_held_while_its_directory_is_away() {
        for replaced in [true, false] {
            let (dir, folder, _) = removable_at("sub/new.md");
            let root = dir.path().to_path_buf();
            let folder = stopped_at(folder, &root, "sub/new.md", "crash-before-take-away");
            let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
            std::fs::rename(root.join("sub"), elsewhere.path().join("sub")).unwrap();
            if replaced {
                std::fs::create_dir(root.join("sub")).unwrap();
            }

            scanned_past_the_grace(&folder, "sub/new.md");

            assert!(deletes_queued(&folder).is_empty(), "replaced {replaced}");
            let conn = folder.core.conn().unwrap();
            assert!(
                state::bound_at(&conn, "sub/new.md").unwrap().is_some(),
                "replaced {replaced}: the binding of a file that is still on disk ended"
            );
            assert_eq!(state::taken(&conn).unwrap().len(), 1, "replaced {replaced}");
            drop(conn);
            assert!(held_in_status(&folder, "sub/new.md"), "replaced {replaced}");

            if replaced {
                std::fs::remove_dir(root.join("sub")).unwrap();
            }
            std::fs::rename(elsewhere.path().join("sub"), root.join("sub")).unwrap();
            folder.scan().unwrap();
            if !births_kept(&root, "sub/new.md") {
                held_until_removed(&folder, &root, "sub/new.md");
                continue;
            }
            let conn = folder.core.conn().unwrap();
            assert!(
                state::taken(&conn).unwrap().is_empty(),
                "replaced {replaced}"
            );
            assert!(state::bound_at(&conn, "sub/new.md").unwrap().is_some());
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_scan_that_read_a_replacement_never_sends_it_once_the_original_is_back() {
        let (dir, folder, _) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-before-take-away");
        let elsewhere = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
        let original = elsewhere.path().join("new.md");
        std::fs::rename(root.join("new.md"), &original).unwrap();
        std::fs::write(
            root.join("new.md"),
            "---\ntitle: new\nstate: archived\n---\nreplaced\n",
        )
        .unwrap();
        let inode = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(root.join("new.md")).unwrap().ino()
        };
        let point = format!("folder-scan-read-inode:{inode}");
        crate::fault::arm(&point);
        let restorer = {
            let (point, original, at) = (point.clone(), original.clone(), root.join("new.md"));
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                while crate::fault::waiting(&point) == 0 {
                    if std::time::Instant::now() > deadline {
                        crate::fault::release(&point);
                        return false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                std::fs::rename(&original, &at).unwrap();
                crate::fault::release(&point);
                true
            })
        };

        folder.scan().unwrap();

        assert!(
            restorer.join().unwrap(),
            "the scan never read the replacement, so nothing below is about it"
        );
        let updates = |folder: &Folder| {
            folder
                .core
                .queue()
                .unwrap()
                .iter()
                .filter(|write| write.kind == crate::model::WriteKind::UpdateItem)
                .count()
        };
        assert_eq!(updates(&folder), 0, "the replacement's text was sent");
        folder.scan().unwrap();
        assert_eq!(updates(&folder), 0, "the replacement's text was sent");
        if births_kept(&root, "new.md") {
            let conn = folder.core.conn().unwrap();
            assert!(state::taken(&conn).unwrap().is_empty());
            assert!(state::bound_at(&conn, "new.md").unwrap().is_some());
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn an_unreadable_removal_record_whose_file_is_gone_is_ended_by_removing_unmatched_files() {
        let (dir, folder, id) = removable();
        let root = dir.path().to_path_buf();
        let folder = stopped_at(folder, &root, "new.md", "crash-before-take-away");
        folder
            .core
            .conn()
            .unwrap()
            .execute(
                "UPDATE meta SET value = 'unreadable' WHERE key LIKE 'folder_taken:%'",
                [],
            )
            .unwrap();
        std::fs::remove_file(root.join("new.md")).unwrap();
        scanned_past_the_grace(&folder, "new.md");
        assert!(held_in_status(&folder, "new.md"));

        let done = folder.remove_unmatched(&["new.md".into()]).unwrap();

        assert!(deletes_queued(&folder).is_empty(), "{done:?}");
        assert!(folder.core.get(&id).unwrap().is_some());
        let conn = folder.core.conn().unwrap();
        assert!(state::taken(&conn).unwrap().is_empty(), "{done:?}");
        assert!(
            state::bound_at(&conn, "new.md").unwrap().is_none(),
            "{done:?}"
        );
        drop(conn);
        assert!(!held_in_status(&folder, "new.md"));
    }
}
