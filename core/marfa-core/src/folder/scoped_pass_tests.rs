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
            Looks::All => assert!(captured >= 13, "took the metadata of {captured} files"),
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
fn a_delete_is_found() {
    finds_what_a_walk_finds(
        |dir| {
            std::fs::remove_file(dir.join("n002.md")).unwrap();
            vec![data(dir.join("n002.md"))]
        },
        Looks::Few,
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
