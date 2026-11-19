//! A quick pass that heard which paths changed looks at those, whatever the
//! size of the folder, and sends each change a walk would have found.

use super::health::tests::aged;
use super::tests::{FILES_CAPTURED, FILES_READ, ScannedDir, settle, watched_notes};
use super::*;
use crate::scripted::{Scripted, refusal};

/// The files a pass took the metadata of and the files it read, since the
/// last call.
fn counted() -> (usize, usize) {
    (
        FILES_CAPTURED.with(std::cell::Cell::take),
        FILES_READ.with(std::cell::Cell::take),
    )
}

fn names(count: usize) -> Vec<String> {
    (0..count).map(|at| format!("n{at:03}.md")).collect()
}

/// A watched folder of notes with these names, whose server turns each write
/// away for now: a pass sends the edit and the test reads what it queued.
fn watched(names: &[String]) -> (ScannedDir, Folder, Scripted, watch::Passes) {
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let (dir, folder, server, mut passes) = watched_notes(&refs);
    let conn = folder.core.conn().unwrap();
    for name in names {
        let item = state::bound_at(&conn, name).unwrap().unwrap().item_id;
        server.on(
            &format!("/items/{item}"),
            (0..8).map(|_| refusal(429, "rate_limited")).collect(),
        );
    }
    drop(conn);
    // As files a scan read some time ago, which a status takes as they were.
    for name in names {
        aged(&dir.path().join(name));
    }
    passes.run(&folder, true).unwrap();
    settle(&folder, &mut passes);
    (dir, folder, server, passes)
}

fn edit(dir: &Path, name: &str) {
    let path = dir.join(name);
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("one more line\n");
    std::fs::write(path, text).unwrap();
}

fn queued(folder: &Folder, name: &str) -> usize {
    state::bound_at(&folder.core.conn().unwrap(), name)
        .unwrap()
        .map_or(0, |bound| bound.writes.queued.len())
}

#[test]
fn a_quick_pass_after_one_edit_looks_at_the_same_files_in_a_folder_of_any_size() {
    let mut seen = Vec::new();
    for size in [4, 40] {
        let (dir, folder, _server, mut passes) = watched(&names(size));
        edit(dir.path(), "n001.md");
        counted();
        passes
            .touching(&folder, &[&dir.path().join("n001.md")])
            .unwrap();
        seen.push(counted());
        assert_eq!(queued(&folder, "n001.md"), 1, "the edit was sent");
    }
    assert_eq!(
        seen[0], seen[1],
        "a folder ten times the size is looked at no more"
    );

    // The witness: the same edit found by a walk takes a look at each file.
    let (dir, folder, _server, mut passes) = watched(&names(40));
    edit(dir.path(), "n001.md");
    counted();
    passes.run(&folder, false).unwrap();
    let (captured, _) = counted();
    assert!(
        captured >= 40,
        "a walk took the metadata of {captured} files"
    );
    assert_eq!(queued(&folder, "n001.md"), 1);
}

fn data(path: PathBuf) -> notify::Event {
    notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
        notify::event::DataChange::Any,
    )))
    .add_path(path)
}

fn renamed(from: PathBuf, to: PathBuf) -> notify::Event {
    notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Name(
        notify::event::RenameMode::Both,
    )))
    .add_path(from)
    .add_path(to)
}

/// Each file the folder keeps a record of, and what waits to be sent for it,
/// and each path journaled gone.
fn kept(folder: &Folder) -> (Vec<(String, usize, bool)>, Vec<String>) {
    let conn = folder.core.conn().unwrap();
    let mut rows: Vec<_> = state::every_bound(&conn)
        .unwrap()
        .into_iter()
        .map(|row| (row.path, row.writes.queued.len(), row.held.is_some()))
        .collect();
    rows.sort();
    let mut statement = conn
        .prepare("SELECT path FROM folder_journal ORDER BY path")
        .unwrap();
    let journal = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (rows, journal)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Looks {
    /// Only the files the events named.
    Few,
    /// The folder, as a walk does.
    All,
}

/// Makes `change` to a folder of notes and runs a quick pass that heard the
/// events it returns, and the same change to another run by a walk. The
/// record each leaves must be the same, and not the one before the change.
fn finds_what_a_walk_finds(change: impl Fn(&Path) -> Vec<notify::Event>, looks: Looks) {
    let mut all = names(12);
    all.push("sub/deep.md".into());
    let (before, scoped_ran) = {
        let (dir, folder, _server, mut passes) = watched(&all);
        counted();
        let events = change(dir.path());
        let ran = passes.hearing(&folder, &events);
        let (captured, _) = counted();
        match looks {
            Looks::Few => assert!(captured < 6, "took the metadata of {captured} files"),
            Looks::All => assert!(captured >= 12, "took the metadata of {captured} files"),
        }
        (kept(&folder), format!("{ran:?}"))
    };
    let (dir, folder, _server, mut passes) = watched(&all);
    let unchanged = kept(&folder);
    change(dir.path());
    let walked_ran = format!("{:?}", passes.run(&folder, false));
    assert_eq!(scoped_ran, walked_ran, "the passes ended differently");
    assert_eq!(before, kept(&folder), "a walk finds something else");
    assert_ne!(before, unchanged, "the change left no mark to find");
}

fn rewrite(dir: &Path, name: &str) -> notify::Event {
    edit(dir, name);
    data(dir.join(name))
}

#[test]
fn one_edit_is_sent() {
    finds_what_a_walk_finds(|dir| vec![rewrite(dir, "n001.md")], Looks::Few);
}

#[test]
fn two_edits_to_different_files_are_both_sent() {
    finds_what_a_walk_finds(
        |dir| vec![rewrite(dir, "n001.md"), rewrite(dir, "n007.md")],
        Looks::Few,
    );
}

#[test]
fn an_edit_in_a_nested_directory_is_sent() {
    finds_what_a_walk_finds(|dir| vec![rewrite(dir, "sub/deep.md")], Looks::Few);
}

#[test]
fn an_edit_and_a_new_file_are_both_sent() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::write(dir.join("fresh.md"), "---\ntitle: fresh\n---\nnew\n").unwrap();
            vec![rewrite(dir, "n001.md"), data(dir.join("fresh.md"))]
        },
        Looks::Few,
    );
}

#[test]
fn a_delete_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::remove_file(dir.join("n002.md")).unwrap();
            vec![data(dir.join("n002.md"))]
        },
        Looks::All,
    );
}

#[test]
fn a_rename_within_a_directory_is_found() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("moved.md")).unwrap();
            vec![renamed(dir.join("n003.md"), dir.join("moved.md"))]
        },
        Looks::Few,
    );
}

#[test]
fn a_rename_across_directories_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("sub/n003.md")).unwrap();
            vec![renamed(dir.join("n003.md"), dir.join("sub/n003.md"))]
        },
        Looks::All,
    );
}

#[test]
fn an_event_naming_only_a_directory_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            edit(dir, "sub/deep.md");
            vec![data(dir.join("sub"))]
        },
        Looks::All,
    );
}

#[test]
fn events_that_overflowed_are_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            edit(dir, "n001.md");
            vec![notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan)]
        },
        Looks::All,
    );
}

fn named_by_one_half(kind: notify::event::RenameMode, path: PathBuf) -> notify::Event {
    notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Name(
        kind,
    )))
    .add_path(path)
}

#[test]
fn a_rename_that_names_both_paths_one_at_a_time_is_found() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("moved.md")).unwrap();
            vec![
                named_by_one_half(notify::event::RenameMode::Any, dir.join("n003.md")),
                named_by_one_half(notify::event::RenameMode::Any, dir.join("moved.md")),
            ]
        },
        Looks::Few,
    );
}

#[test]
fn a_rename_that_names_only_its_old_path_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("moved.md")).unwrap();
            vec![named_by_one_half(
                notify::event::RenameMode::From,
                dir.join("n003.md"),
            )]
        },
        Looks::All,
    );
}

#[test]
fn a_rename_that_names_only_its_new_path_is_found() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("moved.md")).unwrap();
            vec![named_by_one_half(
                notify::event::RenameMode::To,
                dir.join("moved.md"),
            )]
        },
        Looks::Few,
    );
}

#[test]
fn a_case_only_rename_that_names_only_its_old_name_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::rename(dir.join("n003.md"), dir.join("N003.md")).unwrap();
            vec![named_by_one_half(
                notify::event::RenameMode::Any,
                dir.join("n003.md"),
            )]
        },
        Looks::All,
    );
}

#[test]
fn a_path_that_leaves_the_folder_is_found_by_a_walk() {
    finds_what_a_walk_finds(
        |dir| {
            edit(dir, "n001.md");
            vec![
                data(dir.join("..").join("elsewhere.md")),
                data(dir.join("n001.md")),
            ]
        },
        Looks::All,
    );
}

#[test]
fn a_new_file_is_kept_under_the_name_the_folder_gives_it() {
    let composed = "caf\u{e9}.md";
    let decomposed = "cafe\u{301}.md";
    finds_what_a_walk_finds(
        |dir| {
            std::fs::write(dir.join(composed), "---\ntitle: cafe\n---\nnew\n").unwrap();
            vec![data(dir.join(decomposed))]
        },
        Looks::Few,
    );
}

fn journaled(folder: &Folder) -> Vec<String> {
    kept(folder).1
}

#[test]
fn a_file_that_returns_with_no_event_the_watch_acts_on_leaves_no_journal_row() {
    let (dir, folder, _server, mut passes) = watched(&names(6));
    let path = dir.path().join("n002.md");
    let aside = dir.path().join(".away.md");
    std::fs::rename(&path, &aside).unwrap();
    passes.touching(&folder, &[&path]).unwrap();
    assert_eq!(
        journaled(&folder),
        ["n002.md"],
        "the witness: it was missed"
    );

    // Back as it was, so the watch passes its event over and the next pass
    // names nothing.
    std::fs::rename(&aside, &path).unwrap();
    passes.hearing(&folder, &[]).unwrap();
    assert!(journaled(&folder).is_empty(), "{:?}", journaled(&folder));
}

#[test]
fn a_file_whose_item_the_copy_lost_is_judged_by_a_pass_that_names_nothing() {
    let (_dir, folder, _server, _passes) = watched(&names(6));
    let id = state::bound_at(&folder.core.conn().unwrap(), "n002.md")
        .unwrap()
        .unwrap()
        .item_id;
    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM items WHERE id = ?1", [&id])
        .unwrap();
    let quick = Duration::from_millis(250);
    let named = folder
        .scan_watching_within(
            false,
            quick,
            scoped::Reading::Named(&scoped::Scope::default()),
        )
        .unwrap();
    let walked = folder
        .scan_watching_within(false, quick, scoped::Reading::Walk)
        .unwrap();
    assert_eq!(walked.lost, 1, "the witness: a walk judges it, {walked:?}");
    assert_eq!(named.lost, walked.lost, "{named:?}");
}

/// Every file the status would take as the scan read it holds the bytes the
/// scan read.
fn only_what_the_files_hold(folder: &Folder, dir: &Path) {
    let last = folder.last_reads.lock().unwrap();
    assert!(!last.is_empty(), "the witness: the scan kept what it read");
    for (key, read) in last.iter() {
        let Ok(bytes) = std::fs::read(dir.join(key)) else {
            continue;
        };
        assert_eq!(
            read.hash,
            state::hash(&bytes),
            "{key} is not as the scan read it"
        );
    }
}

#[test]
fn a_status_after_a_server_edit_is_what_a_walk_finds() {
    let (dir, folder, _server, mut passes) = watched(&names(6));
    let id = state::bound_at(&folder.core.conn().unwrap(), "n002.md")
        .unwrap()
        .unwrap()
        .item_id;
    super::tests::changed_elsewhere(&folder, &id, "words from another device\n");
    passes
        .touching(&folder, &[&dir.path().join("n001.md")])
        .unwrap();
    assert!(
        std::fs::read_to_string(dir.path().join("n002.md"))
            .unwrap()
            .contains("words from another device"),
        "the witness: the pass wrote the file"
    );
    only_what_the_files_hold(&folder, dir.path());
    let (scoped, walked) =
        super::health::tests::status_both_ways(&folder).expect("the pass left an inventory");
    assert_eq!(scoped, walked);
}

#[test]
fn a_rename_that_retitles_leaves_what_the_scan_read_true() {
    let (dir, folder, _server, mut passes) = watched(&names(6));
    std::fs::rename(dir.path().join("n003.md"), dir.path().join("Moved.md")).unwrap();
    passes
        .hearing(
            &folder,
            &[renamed(
                dir.path().join("n003.md"),
                dir.path().join("Moved.md"),
            )],
        )
        .unwrap();
    assert!(
        std::fs::read_to_string(dir.path().join("Moved.md"))
            .unwrap()
            .contains("title: Moved"),
        "the witness: the pass rewrote the title line"
    );
    only_what_the_files_hold(&folder, dir.path());
}
