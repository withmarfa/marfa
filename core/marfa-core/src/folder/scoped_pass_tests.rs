//! A quick pass that heard which paths changed looks at those, whatever the
//! size of the folder, and sends each change a walk would have found.

use super::tests::{FILES_CAPTURED, FILES_READ, ScannedDir, watched_notes};
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
    let (dir, folder, server, passes) = watched_notes(&refs);
    let conn = folder.core.conn().unwrap();
    for name in names {
        let item = state::bound_at(&conn, name).unwrap().unwrap().item_id;
        server.on(
            &format!("/items/{item}"),
            (0..8).map(|_| refusal(429, "rate_limited")).collect(),
        );
    }
    drop(conn);
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
