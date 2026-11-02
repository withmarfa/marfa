//! A watch over a quiet folder rests between its full passes, whatever
//! stands in the folder, and a file held for a link line its item never took
//! goes to the bin, once the person deletes it, as any other file does.

use super::held_links_tests::{held, nothing_found, online_folder};
use super::tests::{
    ScannedDir, changed_elsewhere, deletes_queued, landed, past_the_grace, settle, watched_notes,
};
use super::*;
use crate::scripted::Scripted;

/// Two minutes of a watch's ticks.
const TWO_MINUTES: usize = 120;

/// Whether `pulls` is at most the one full pull a minute allows over two
/// minutes.
fn once_a_minute(pulls: usize) -> bool {
    pulls <= 2
}

/// Answers every write the folder queued, as a server that took them would.
fn answered(folder: &Folder) {
    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
}

/// A watched folder with the note `A.md`, which the folder wrote and the
/// person then gave a parent no item is named for. The file is held, and its
/// item has every line the folder recorded except that one. Answers the
/// folder's directory, the folder, its server, the watch's passes and the
/// note's item.
fn held_note() -> (ScannedDir, Folder, Scripted, watch::Passes, String) {
    let (dir, folder, server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("A.md"), "A\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let id = landed(&folder, "A.md");
    answered(&folder);
    let mut passes = watch::Passes::default();
    passes.run(&folder, true).unwrap();
    settle(&folder, &mut passes);

    let path = dir.path().join("A.md");
    let text = std::fs::read_to_string(&path).unwrap();
    let parented = match text.strip_prefix("---\n") {
        Some(rest) => format!("---\nchild-of: \"[[B]]\"\n{rest}"),
        None => format!("---\nchild-of: \"[[B]]\"\n---\n{text}"),
    };
    std::fs::write(&path, parented).unwrap();
    passes.run(&folder, false).unwrap();
    answered(&folder);
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.contains("matches no item")),
        "the witness: the file is held, {:?}",
        held(&folder, "A.md")
    );
    (dir, folder, server, passes, id)
}

/// Deletes `A.md` and runs a scan that finds it missing.
fn deleted(dir: &ScannedDir, folder: &Folder) {
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    let scanned = folder.scan().unwrap();
    assert_eq!(scanned.missing, 1, "{scanned:?}");
}

fn bound(folder: &Folder, path: &str) -> Option<state::Bound> {
    state::bound_at(&folder.core.conn().unwrap(), path).unwrap()
}

#[test]
fn a_quiet_watch_with_nothing_standing_pulls_at_most_once_a_minute() {
    let (_dir, folder, _server, mut passes) = watched_notes(&["a.md", "b.md"]);
    passes.pulls();
    for _ in 0..TWO_MINUTES {
        passes.tick(&folder).unwrap();
    }
    let pulls = passes.pulls();
    assert!(once_a_minute(pulls), "{pulls} pulls in two quiet minutes");
}

#[test]
fn a_quiet_watch_over_a_deleted_held_file_pulls_at_most_once_a_minute() {
    let (dir, folder, _server, mut passes, _) = held_note();
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    passes.run(&folder, false).unwrap();
    past_the_grace(&folder, "A.md");
    passes.run(&folder, false).unwrap();
    answered(&folder);
    passes.pulls();
    for _ in 0..TWO_MINUTES {
        passes.tick(&folder).unwrap();
    }
    let pulls = passes.pulls();
    assert!(once_a_minute(pulls), "{pulls} pulls in two quiet minutes");
}

#[cfg(unix)]
#[test]
fn a_quiet_watch_over_a_directory_it_cannot_read_pulls_at_most_once_a_minute() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    let shut = dir.path().join("shut");
    std::fs::create_dir(&shut).unwrap();
    std::fs::write(shut.join("inside.md"), "inside\n").unwrap();
    std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
    let open = |shut: &Path| {
        std::fs::set_permissions(shut, std::fs::Permissions::from_mode(0o700)).unwrap();
    };
    // A superuser reads every directory, so there is nothing to stand.
    if std::fs::read_dir(&shut).is_ok() {
        open(&shut);
        return;
    }
    passes.run(&folder, false).unwrap();
    passes.pulls();
    for _ in 0..TWO_MINUTES {
        passes.tick(&folder).unwrap();
    }
    let pulls = passes.pulls();
    let flagged = folder.scan_watching(false, Duration::ZERO).unwrap().directories;
    open(&shut);
    assert!(!flagged.is_empty(), "the witness: the directory stands");
    assert!(once_a_minute(pulls), "{pulls} pulls in two quiet minutes");
}

#[test]
fn a_deleted_file_held_for_a_line_its_item_never_took_goes_to_the_bin() {
    let (dir, folder, _server, _passes, id) = held_note();
    deleted(&dir, &folder);

    // Inside the grace the pull leaves the file deleted.
    let pulled = folder.pull().unwrap();
    assert!(!dir.path().join("A.md").exists(), "{pulled:?}");
    assert_eq!(pulled.revived, 0, "{pulled:?}");

    past_the_grace(&folder, "A.md");
    let swept = folder.scan().unwrap();
    assert_eq!(
        swept.trashed,
        ["A.md"],
        "the person's delete was held as a change made elsewhere: {swept:?}"
    );
    assert_eq!(deletes_queued(&folder).len(), 1);
    assert!(bound(&folder, "A.md").is_none());
    assert!(
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
    let pulled = folder.pull().unwrap();
    assert!(
        !dir.path().join("A.md").exists(),
        "{id} was written back: {pulled:?}"
    );
}

#[test]
fn a_deleted_held_file_whose_item_changed_elsewhere_comes_back() {
    let (dir, folder, _server, _passes, id) = held_note();
    deleted(&dir, &folder);
    changed_elsewhere(&folder, &id, "changed elsewhere");
    past_the_grace(&folder, "A.md");
    let swept = folder.scan().unwrap();
    assert!(swept.trashed.is_empty(), "{swept:?}");
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.revived, 1, "{pulled:?}");
    let text = std::fs::read_to_string(dir.path().join("A.md")).unwrap();
    assert!(text.contains("changed elsewhere"), "{text}");
    assert!(deletes_queued(&folder).is_empty());
    assert_eq!(bound(&folder, "A.md").map(|bound| bound.item_id), Some(id));
}

#[test]
fn a_deleted_held_file_goes_to_the_bin_once_its_link_target_appears() {
    const B: &str = "01a00000-0000-7000-8000-0000000026b1";
    let (dir, folder, _server, _passes, _) = held_note();
    deleted(&dir, &folder);
    crate::store::put_server_item(
        &folder.core.conn().unwrap(),
        &crate::store::testing::note(B, "B", "", "2026-01-01T00:00:00Z"),
        None,
        &crate::catalog::Catalog::empty(),
    )
    .unwrap();
    past_the_grace(&folder, "A.md");
    let swept = folder.scan().unwrap();
    assert_eq!(swept.trashed, ["A.md"], "{swept:?}");
    let pulled = folder.pull().unwrap();
    assert!(!dir.path().join("A.md").exists(), "{pulled:?}");
}

#[test]
fn a_held_file_back_on_the_disk_inside_the_grace_stays_as_it_is() {
    let (dir, folder, _server, _passes, _) = held_note();
    let path = dir.path().join("A.md");
    let before = std::fs::read(&path).unwrap();
    deleted(&dir, &folder);
    std::fs::write(&path, &before).unwrap();
    let back = folder.scan().unwrap();
    assert_eq!((back.missing, back.trashed.len()), (0, 0), "{back:?}");
    assert!(
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
    folder.pull().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(deletes_queued(&folder).is_empty());
    assert!(held(&folder, "A.md").is_some());
}
