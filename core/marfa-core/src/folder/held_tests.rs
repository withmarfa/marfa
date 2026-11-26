//! A missing file is moved only where one readable other folder holds it
//! alone, deleted only where this computer has no other folder, and held for
//! the person in every other case.

use super::tests::{deletes_queued, folder_with, kept, landed, past_the_grace, peers_walked};
use super::*;

const A: &str = "01a00000-0000-7000-8000-0000000000d1";
const B: &str = "01a00000-0000-7000-8000-0000000000d2";
const C: &str = "01a00000-0000-7000-8000-0000000000d3";

/// A folder at `id` that holds every item, scanned once.
fn folder(id: &str) -> (tempfile::TempDir, Folder) {
    let (dir, folder) = folder_with(id, serde_json::json!({ "query": {} }), None);
    folder.scan().unwrap();
    (dir, folder)
}

/// A folder at `id` that pauses every removal for `folders confirm`.
fn pausing(id: &str) -> (tempfile::TempDir, Folder) {
    let (dir, folder) = folder_with(
        id,
        serde_json::json!({
            "query": {},
            "removal_threshold": { "files": 0, "fraction": 0.0 }
        }),
        None,
    );
    folder.scan().unwrap();
    (dir, folder)
}

/// The item of a note at `name` the folder made and the server took.
fn note(dir: &tempfile::TempDir, folder: &Folder, name: &str) -> String {
    std::fs::write(dir.path().join(name), format!("{name} words\n")).unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let item = landed(folder, name);
    folder.pull().unwrap();
    assert!(
        std::fs::read_to_string(dir.path().join(name))
            .unwrap()
            .contains(&item),
        "the note's file carries no id line"
    );
    item
}

/// Deletes each of `names` and scans past the grace, answering the report.
fn deleted(dir: &tempfile::TempDir, folder: &Folder, names: &[&str]) -> ScanReport {
    for name in names {
        std::fs::remove_file(dir.path().join(name)).unwrap();
    }
    assert_eq!(folder.scan().unwrap().missing, names.len());
    for name in names {
        past_the_grace(folder, name);
    }
    peers_walked();
    folder.scan().unwrap()
}

fn held_reason(folder: &Folder, path: &str) -> String {
    match kept(folder, path) {
        Some(state::Kept::Unsure(reason)) => reason,
        other => panic!("{path} is not held: {other:?}"),
    }
}

fn bound_item(folder: &Folder, path: &str) -> Option<String> {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .map(|bound| bound.item_id)
}

#[test]
fn a_missing_note_goes_to_the_bin_only_where_this_computer_has_no_other_folder() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    note(&a_dir, &a, "alone.md");
    note(&a_dir, &a, "note.md");

    let report = deleted(&a_dir, &a, &["alone.md"]);
    assert_eq!(report.trashed, ["alone.md"], "{report:?}");
    assert_eq!(deletes_queued(&a).len(), 1);

    let (_b_dir, _b) = folder(B);
    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert_eq!(deletes_queued(&a).len(), 1);
    let reason = held_reason(&a, "note.md");
    assert!(
        reason.contains("another folder is on this computer"),
        "{reason}"
    );
}

#[test]
fn a_missing_note_is_held_while_two_other_folders_hold_no_trace_of_it() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (_b_dir, _b) = folder(B);
    let (_c_dir, _c) = folder(C);
    note(&a_dir, &a, "note.md");

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    let reason = held_reason(&a, "note.md");
    assert!(reason.contains("2 other folders"), "{reason}");
}

#[test]
fn one_read_of_each_other_folder_decides_every_missing_note_of_a_sweep() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (_b_dir, _b) = folder(B);
    let (_c_dir, _c) = folder(C);
    let names = ["one.md", "two.md", "three.md"];
    for name in names {
        note(&a_dir, &a, name);
    }

    let report = deleted(&a_dir, &a, &names);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert_eq!(a.held_files().unwrap().len(), 3);
    assert_eq!(
        peers_walked(),
        2,
        "the sweep read the other folders again for each file"
    );
}

#[test]
fn a_missing_note_whose_id_line_was_never_written_is_held_while_another_folder_exists() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (_b_dir, _b) = folder(B);
    let shown = "---\ntitle: note\n---\nnote words\n";
    std::fs::write(a_dir.path().join("note.md"), shown).unwrap();
    assert_eq!(a.scan().unwrap().created, 1);
    landed(&a, "note.md");
    a.core
        .conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(a_dir.path().join("note.md")).unwrap(),
        shown
    );

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    held_reason(&a, "note.md");
}

#[test]
fn a_missing_note_moved_where_another_folder_does_not_read_is_held() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    let item = note(&a_dir, &a, "draft.md");
    note(&a_dir, &a, "hidden.md");
    let body = std::fs::read_to_string(a_dir.path().join("draft.md")).unwrap();
    std::fs::write(b_dir.path().join("draft.txt"), format!("{body}more\n")).unwrap();
    std::fs::create_dir(b_dir.path().join(".drafts")).unwrap();
    std::fs::copy(
        a_dir.path().join("hidden.md"),
        b_dir.path().join(".drafts/hidden.md"),
    )
    .unwrap();
    assert!(
        std::fs::read_to_string(b_dir.path().join("draft.txt"))
            .unwrap()
            .contains(&item)
    );

    let report = deleted(&a_dir, &a, &["draft.md", "hidden.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    held_reason(&a, "draft.md");
    held_reason(&a, "hidden.md");
}

#[test]
fn a_missing_note_is_held_while_another_folder_cannot_be_opened() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, b) = folder(B);
    note(&a_dir, &a, "note.md");
    drop(b);
    std::fs::remove_dir_all(b_dir.path().join(STATE_DIR)).unwrap();

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    let reason = held_reason(&a, "note.md");
    assert!(
        reason.contains(&*b_dir.path().to_string_lossy()),
        "{reason}"
    );
}

#[test]
fn a_missing_note_is_held_while_another_folder_is_only_remembered() {
    let (registry, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, b) = folder(B);
    note(&a_dir, &a, "alone.md");
    note(&a_dir, &a, "note.md");
    a.peers().remember().unwrap();
    let store = elsewhere::listed_store(&b.core);
    assert!(registry.unregister(&b.root, store.as_deref()).unwrap());

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    let reason = held_reason(&a, "note.md");
    assert!(
        reason.contains(&*b_dir.path().to_string_lossy()),
        "{reason}"
    );

    // The witness: with nothing remembered, the computer has no other folder.
    crate::store::meta_set(&a.core.conn().unwrap(), elsewhere::META_OTHERS, "[]").unwrap();
    std::fs::remove_file(a_dir.path().join("alone.md")).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "alone.md");
    let report = a.scan().unwrap();
    assert_eq!(report.trashed, ["alone.md"], "{report:?}");
}

#[test]
fn a_missing_note_is_held_where_the_other_folders_could_not_be_recorded() {
    let (registry, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    note(&a_dir, &a, "note.md");
    let (b_dir, b) = folder(B);
    let moved = b_dir.path().join("note.md");
    std::fs::rename(a_dir.path().join("note.md"), &moved).unwrap();
    a.core
        .conn()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_insert BEFORE INSERT ON meta WHEN NEW.key = 'folder_others'
             BEGIN SELECT RAISE(FAIL, 'disk write failed'); END;
             CREATE TRIGGER refuse_update BEFORE UPDATE ON meta WHEN NEW.key = 'folder_others'
             BEGIN SELECT RAISE(FAIL, 'disk write failed'); END;",
        )
        .unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    let store = elsewhere::listed_store(&b.core);
    assert!(registry.unregister(&b.root, store.as_deref()).unwrap());
    a.core
        .conn()
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_insert; DROP TRIGGER refuse_update;")
        .unwrap();

    past_the_grace(&a, "note.md");
    let report = a.scan().unwrap();
    assert!(moved.is_file());
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    let reason = held_reason(&a, "note.md");
    assert!(reason.contains("could not be recorded"), "{reason}");
}

#[test]
fn a_rebound_path_is_held_while_the_list_of_folders_cannot_be_read() {
    let (registry, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    let item = note(&a_dir, &a, "note.md");
    let other = note(&a_dir, &a, "other.md");
    std::fs::rename(a_dir.path().join("note.md"), b_dir.path().join("moved.md")).unwrap();
    a.scan().unwrap();
    std::fs::rename(a_dir.path().join("other.md"), a_dir.path().join("note.md")).unwrap();
    a.scan().unwrap();
    assert_eq!(bound_item(&a, "note.md"), Some(other));
    std::fs::write(registry.path(), "unreadable").unwrap();

    past_the_grace(&a, "note.md");
    let report = a.scan().unwrap();
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    let held = a.held_files().unwrap();
    assert_eq!(
        held.iter()
            .map(|file| (file.path.as_str(), file.item.as_str()))
            .collect::<Vec<_>>(),
        [("note.md", item.as_str())]
    );
}

#[test]
fn a_confirmed_removal_holds_the_notes_it_cannot_tell_from_a_move() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = pausing(A);
    let (_b_dir, _b) = folder(B);
    note(&a_dir, &a, "note.md");
    std::fs::remove_file(a_dir.path().join("note.md")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    past_the_grace(&a, "note.md");
    assert_eq!(a.scan().unwrap().paused, 1);

    let confirmed = a.confirm().unwrap();
    assert_eq!(confirmed.deleted, 0, "{confirmed:?}");
    assert!(deletes_queued(&a).is_empty());
    let reason = held_reason(&a, "note.md");
    assert!(
        reason.contains("another folder is on this computer"),
        "{reason}"
    );

    let settled = a
        .settle_held(&["note.md".to_string()], Settle::Trash)
        .unwrap();
    assert_eq!(settled.trashed, ["note.md"], "{settled:?}");
    assert_eq!(deletes_queued(&a).len(), 1);
}

#[test]
fn confirming_a_removal_within_the_rename_grace_deletes_nothing() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = pausing(A);
    note(&a_dir, &a, "note.md");
    std::fs::remove_file(a_dir.path().join("note.md")).unwrap();
    assert_eq!(a.scan().unwrap().paused, 1);

    let confirmed = a.confirm().unwrap();
    assert_eq!(confirmed.deleted, 0, "{confirmed:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(
        confirmed
            .unsure
            .iter()
            .any(|file| file.path == "note.md" && file.reason.contains("rename grace")),
        "{confirmed:?}"
    );
    // Not confirmed, so its removal stays paused rather than ending.
    assert_eq!(
        state::paused(&a.core.conn().unwrap(), state::Removal::Disk).unwrap(),
        ["note.md"]
    );

    // The witness: past the grace, the same confirmation deletes it.
    assert_eq!(a.scan().unwrap().paused, 1);
    past_the_grace(&a, "note.md");
    assert_eq!(a.scan().unwrap().paused, 1);
    let confirmed = a.confirm().unwrap();
    assert_eq!(confirmed.deleted, 1, "{confirmed:?}");
}

#[cfg(unix)]
#[test]
fn confirming_a_removal_whose_path_cannot_be_checked_holds_the_file() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = pausing(A);
    let sub = a_dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    note(&a_dir, &a, "sub/note.md");
    std::fs::remove_file(sub.join("note.md")).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "sub/note.md");
    assert_eq!(a.scan().unwrap().paused, 1);

    let confirmed = {
        let _sealed = crate::test_folders::locked(&sub, 0o000);
        a.confirm().unwrap()
    };
    assert_eq!(confirmed.deleted, 0, "{confirmed:?}");
    assert_eq!(confirmed.unsure.len(), 1, "{confirmed:?}");
    let reason = held_reason(&a, "sub/note.md");
    assert!(reason.contains("cannot be checked"), "{reason}");
    let report = a.scan().unwrap();
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
}

#[test]
fn a_missing_note_is_held_where_another_folders_copy_holds_its_item_with_a_file_of_its_own() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, b) = folder(B);
    let item = note(&a_dir, &a, "note.md");
    crate::store::upsert_item(
        &b.core.conn().unwrap(),
        &crate::store::testing::note(&item, "note", "note.md words", "2026-01-01T00:00:00Z"),
        None,
        &Default::default(),
    )
    .unwrap();
    std::fs::copy(a_dir.path().join("note.md"), b_dir.path().join("own.md")).unwrap();
    b.scan().unwrap();
    assert_eq!(
        bound_item(&b, "own.md"),
        Some(item.clone()),
        "the other folder did not take its own file of the item"
    );

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert_eq!(report.moved_away, 0, "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    held_reason(&a, "note.md");
}

#[cfg(unix)]
#[test]
fn another_folders_hard_link_to_the_file_is_no_move() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, b) = folder(B);
    let item = note(&a_dir, &a, "note.md");
    crate::store::upsert_item(
        &b.core.conn().unwrap(),
        &crate::store::testing::note(&item, "note", "note.md words", "2026-01-01T00:00:00Z"),
        None,
        &Default::default(),
    )
    .unwrap();
    std::fs::hard_link(a_dir.path().join("note.md"), b_dir.path().join("own.md")).unwrap();
    b.scan().unwrap();
    assert_eq!(bound_item(&b, "own.md"), Some(item));

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert_eq!(report.moved_away, 0, "{report:?}");
    assert!(report.trashed.is_empty(), "{report:?}");
    held_reason(&a, "note.md");
}

#[test]
fn a_missing_note_found_once_in_another_folder_is_moved_not_held() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    note(&a_dir, &a, "note.md");
    std::fs::copy(a_dir.path().join("note.md"), b_dir.path().join("note.md")).unwrap();

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert_eq!(report.moved_away, 1, "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    assert_eq!(kept(&a, "note.md"), None);
}

#[test]
fn a_missing_note_found_in_two_other_folders_is_held() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    let (c_dir, _c) = folder(C);
    note(&a_dir, &a, "note.md");
    for to in [&b_dir, &c_dir] {
        std::fs::copy(a_dir.path().join("note.md"), to.path().join("note.md")).unwrap();
    }

    let report = deleted(&a_dir, &a, &["note.md"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    assert_eq!(report.moved_away, 0, "{report:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(held_reason(&a, "note.md").contains("2 files in other folders"));
}

#[test]
fn two_missing_files_with_the_same_bytes_are_both_held_where_another_folder_has_them() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    let names = ["one.bin", "two.bin"];
    for name in names {
        std::fs::write(a_dir.path().join(name), b"identical").unwrap();
        a.scan().unwrap();
        landed(&a, name);
    }
    std::fs::copy(a_dir.path().join("one.bin"), b_dir.path().join("third.bin")).unwrap();

    let report = deleted(&a_dir, &a, &names);
    assert_eq!(report.moved_away, 0, "{report:?}");
    assert!(report.trashed.is_empty(), "{report:?}");
    for name in names {
        let reason = held_reason(&a, name);
        assert!(reason.contains("2 files in this folder"), "{reason}");
    }
}

#[test]
fn a_missing_file_item_is_held_while_another_folder_exists() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    std::fs::write(a_dir.path().join("photo.bin"), [7, 7, 7]).unwrap();
    assert_eq!(a.scan().unwrap().created, 1);
    landed(&a, "photo.bin");

    // The witness: with no other folder, its delete is sent.
    std::fs::remove_file(a_dir.path().join("photo.bin")).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "photo.bin");
    let alone = a.scan().unwrap();
    assert_eq!(alone.trashed, ["photo.bin"], "{alone:?}");

    let (_b_dir, _b) = folder(B);
    std::fs::write(a_dir.path().join("photo.bin"), [8, 8, 8]).unwrap();
    assert_eq!(a.scan().unwrap().created, 1);
    landed(&a, "photo.bin");
    let report = deleted(&a_dir, &a, &["photo.bin"]);
    assert!(report.trashed.is_empty(), "{report:?}");
    held_reason(&a, "photo.bin");
}

#[test]
fn a_held_file_stays_held_and_shown_across_later_scans() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    for _ in 0..3 {
        let report = a.scan().unwrap();
        assert!(report.trashed.is_empty(), "{report:?}");
    }
    assert!(deletes_queued(&a).is_empty());
    let shown = a.status().unwrap();
    let file = shown
        .files
        .iter()
        .find(|file| file.path == "note.md")
        .unwrap();
    assert_eq!(
        (file.status, file.flag),
        ("held", Some("unsure")),
        "{file:?}"
    );
    let held = Folder::held_of(a_dir.path()).unwrap();
    assert_eq!(
        held.iter()
            .map(|file| (file.path.as_str(), file.item.as_str()))
            .collect::<Vec<_>>(),
        [("note.md", item.as_str())]
    );
}

#[cfg(unix)]
#[test]
fn a_hold_outlasts_a_scan_that_cannot_read_its_directory() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (_b_dir, _b) = folder(B);
    let sub = a_dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    note(&a_dir, &a, "sub/note.md");
    deleted(&a_dir, &a, &["sub/note.md"]);
    let before = a.held_files().unwrap();
    assert_eq!(before.len(), 1);

    {
        let _sealed = crate::test_folders::locked(&sub, 0o000);
        a.scan().unwrap();
    }
    assert_eq!(
        a.held_files().unwrap(),
        before,
        "a pass that could not read the directory ended the hold"
    );
}

/// A note in A whose delete is held because B is on the computer.
fn held_note() -> (
    registry::tests::OwnRegistry,
    tempfile::TempDir,
    Folder,
    tempfile::TempDir,
    Folder,
    String,
) {
    let (_, own) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, b) = folder(B);
    let item = note(&a_dir, &a, "note.md");
    deleted(&a_dir, &a, &["note.md"]);
    held_reason(&a, "note.md");
    (own, a_dir, a, b_dir, b, item)
}

/// Moves `other.md`, a note of its own, onto the held note's path.
fn rebind_onto_the_held_path(a_dir: &tempfile::TempDir, a: &Folder) -> String {
    let other = note(a_dir, a, "other.md");
    std::fs::rename(a_dir.path().join("other.md"), a_dir.path().join("note.md")).unwrap();
    a.scan().unwrap();
    assert_eq!(bound_item(a, "note.md"), Some(other.clone()));
    other
}

#[test]
fn settling_a_held_file_to_the_bin_sends_its_items_delete() {
    let (_own, _a_dir, a, _b_dir, _b, _) = held_note();
    let settled = a.settle_held(&["note.md".into()], Settle::Trash).unwrap();
    assert_eq!(settled.trashed, ["note.md"], "{settled:?}");
    assert_eq!(deletes_queued(&a), [Some(1)]);
    assert!(a.held_files().unwrap().is_empty());
    assert_eq!(bound_item(&a, "note.md"), None);
}

#[test]
fn settling_a_held_file_to_the_bin_answers_moved_where_one_readable_folder_now_holds_it() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = folder(A);
    let (b_dir, _b) = folder(B);
    let (c_dir, c) = folder(C);
    note(&a_dir, &a, "note.md");
    let saved = std::fs::read(a_dir.path().join("note.md")).unwrap();
    deleted(&a_dir, &a, &["note.md"]);
    held_reason(&a, "note.md");
    drop(c);
    std::fs::remove_dir_all(c_dir.path().join(STATE_DIR)).unwrap();
    std::fs::write(b_dir.path().join("restored.md"), saved).unwrap();

    let settled = a.settle_held(&["note.md".into()], Settle::Trash).unwrap();
    assert_eq!(settled.moved, ["note.md"], "{settled:?}");
    assert!(settled.trashed.is_empty(), "{settled:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(a.held_files().unwrap().is_empty());
}

#[test]
fn settling_a_held_file_to_the_bin_answers_moved_after_another_file_took_its_path() {
    let (_own, a_dir, a, b_dir, _b, item) = held_note();
    let other = rebind_onto_the_held_path(&a_dir, &a);
    std::fs::write(
        b_dir.path().join("recovered.md"),
        format!("---\nmarfa_id: {item}\n---\nnote.md words\n"),
    )
    .unwrap();

    let settled = a.settle_held(&["note.md".into()], Settle::Trash).unwrap();
    assert_eq!(settled.moved, ["note.md"], "{settled:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(a.held_files().unwrap().is_empty());
    assert_eq!(bound_item(&a, "note.md"), Some(other));
}

#[test]
fn a_held_file_sent_to_the_bin_while_its_item_keeps_changing_stays_held() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    a.core
        .conn()
        .unwrap()
        .execute_batch(&format!(
            "CREATE TRIGGER edit_while_deciding AFTER INSERT ON meta
             WHEN NEW.key = 'folder_left_at:{item}'
             BEGIN
               UPDATE items SET version = version + 1 WHERE id = '{item}';
               DELETE FROM meta WHERE key = NEW.key;
             END"
        ))
        .unwrap();

    let settled = a.settle_held(&["note.md".into()], Settle::Trash).unwrap();
    assert!(settled.trashed.is_empty(), "{settled:?}");
    assert_eq!(settled.not_settled.len(), 1, "{settled:?}");
    assert!(
        settled.not_settled[0].reason.contains("item changed"),
        "{settled:?}"
    );
    assert!(!a_dir.path().join("note.md").exists());
    assert_eq!(
        a.held_files().unwrap().len(),
        1,
        "a delete that did not happen ended the hold"
    );
}

#[test]
fn keeping_a_held_file_keeps_its_item_and_lets_the_file_go() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    let settled = a
        .settle_held(&["note.md".into()], Settle::Keep { write_back: false })
        .unwrap();
    assert_eq!(settled.kept, ["note.md"], "{settled:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(a.held_files().unwrap().is_empty());
    assert_eq!(bound_item(&a, "note.md"), None);
    assert!(a.core.get(&item).unwrap().is_some());
    a.scan().unwrap();
    assert!(deletes_queued(&a).is_empty());
    assert!(!a_dir.path().join("note.md").exists());
}

#[test]
fn keeping_a_held_file_with_write_back_writes_it_again() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    let settled = a
        .settle_held(&["note.md".into()], Settle::Keep { write_back: true })
        .unwrap();
    assert_eq!(settled.written_back, ["note.md"], "{settled:?}");
    assert!(deletes_queued(&a).is_empty());
    assert!(
        std::fs::read_to_string(a_dir.path().join("note.md"))
            .unwrap()
            .contains(&item)
    );
    assert!(a.held_files().unwrap().is_empty());
}

#[test]
fn keeping_a_held_file_with_write_back_names_only_files_that_exist() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    a.core
        .conn()
        .unwrap()
        .execute(
            "UPDATE items SET properties = json_set(properties, '$.title', 'New title'),
             version = version + 1 WHERE id = ?1",
            [&item],
        )
        .unwrap();
    let settled = a
        .settle_held(&["note.md".into()], Settle::Keep { write_back: true })
        .unwrap();
    assert!(!settled.written_back.is_empty(), "{settled:?}");
    for path in &settled.written_back {
        assert!(a_dir.path().join(path).exists(), "{settled:?}");
    }
}

#[test]
fn a_keep_that_cannot_let_the_file_go_keeps_the_hold() {
    let (_own, a_dir, a, _b_dir, _b, _) = held_note();
    a.core
        .conn()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_unbind BEFORE DELETE ON folder_files
             BEGIN SELECT RAISE(FAIL, 'disk write failed'); END;",
        )
        .unwrap();
    assert!(
        a.settle_held(&["note.md".into()], Settle::Keep { write_back: false })
            .is_err()
    );
    a.core
        .conn()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_unbind;")
        .unwrap();
    assert_eq!(
        a.held_files().unwrap().len(),
        1,
        "a keep that failed ended the hold"
    );

    drop(a);
    let a = Folder::open(a_dir.path(), None).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "note.md");
    let report = a.scan().unwrap();
    assert!(report.trashed.is_empty(), "{report:?}");
    assert!(deletes_queued(&a).is_empty());
}

#[test]
fn a_held_file_whose_path_holds_a_file_again_is_not_settled_and_keeps_its_bytes() {
    let (_own, a_dir, a, _b_dir, _b, _) = held_note();
    let bytes = b"unsent editor bytes\0\xff\n";
    std::fs::write(a_dir.path().join("note.md"), bytes).unwrap();
    for settle in [
        Settle::Trash,
        Settle::Keep { write_back: false },
        Settle::Keep { write_back: true },
    ] {
        let settled = a
            .settle_held(&["note.md".into(), "never.md".into()], settle)
            .unwrap();
        assert!(settled.trashed.is_empty(), "{settled:?}");
        assert!(settled.kept.is_empty(), "{settled:?}");
        assert_eq!(
            settled
                .not_settled
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["note.md", "never.md"]
        );
        assert_eq!(std::fs::read(a_dir.path().join("note.md")).unwrap(), bytes);
    }
    assert!(deletes_queued(&a).is_empty());
}

#[test]
fn a_held_file_whose_path_another_notes_file_takes_stays_shown_and_settles() {
    let (_own, a_dir, a, _b_dir, _b, item) = held_note();
    let other = rebind_onto_the_held_path(&a_dir, &a);
    let held = a.held_files().unwrap();
    assert_eq!(
        held.iter()
            .map(|file| (file.path.as_str(), file.item.as_str()))
            .collect::<Vec<_>>(),
        [("note.md", item.as_str())],
        "a held file whose path another file took was kept from the person"
    );
    let shown = a.status().unwrap();
    assert!(
        shown.files.iter().any(|file| file.path == "note.md"
            && file.item_id.as_deref() == Some(item.as_str())
            && (file.status, file.flag) == ("held", Some("unsure"))),
        "{:?}",
        shown.files
    );

    let refused = a
        .settle_held(&["note.md".into()], Settle::Keep { write_back: true })
        .unwrap();
    assert!(refused.kept.is_empty(), "{refused:?}");
    assert_eq!(
        refused
            .not_settled
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["note.md"]
    );
    assert_eq!(
        a.held_files().unwrap().len(),
        1,
        "a write-back that could not be made ended the hold"
    );
    assert_eq!(bound_item(&a, "note.md"), Some(other.clone()));

    let kept = a
        .settle_held(&["note.md".into()], Settle::Keep { write_back: false })
        .unwrap();
    assert_eq!(kept.kept, ["note.md"], "{kept:?}");
    assert!(a.held_files().unwrap().is_empty());
    assert!(deletes_queued(&a).is_empty());
    assert!(a.core.get(&item).unwrap().is_some());
    assert_eq!(
        bound_item(&a, "note.md"),
        Some(other),
        "keeping a held file rebound the path another item's file holds"
    );
}

#[test]
fn a_held_file_whose_path_another_notes_file_takes_can_go_to_the_bin() {
    let (_own, a_dir, a, _b_dir, _b, _) = held_note();
    let other = rebind_onto_the_held_path(&a_dir, &a);
    let settled = a.settle_held(&["note.md".into()], Settle::Trash).unwrap();
    assert_eq!(settled.trashed, ["note.md"], "{settled:?}");
    assert_eq!(deletes_queued(&a), [Some(1)]);
    assert!(a.held_files().unwrap().is_empty());
    assert!(
        std::fs::read_to_string(a_dir.path().join("note.md"))
            .unwrap()
            .contains(&other)
    );
    assert_eq!(
        bound_item(&a, "note.md"),
        Some(other),
        "sending the held file to the bin let another item's file go"
    );
}
