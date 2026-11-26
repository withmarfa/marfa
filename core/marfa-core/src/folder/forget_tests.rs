use std::time::Duration;

use serde_json::json;

use super::gone_peer_tests::remembering;
use super::registry::Registered;
use super::tests::folder_with;
use super::*;

fn held_paths(report: &ScanReport) -> Vec<&str> {
    report
        .unsure
        .iter()
        .map(|file| file.path.as_str())
        .collect()
}

/// Makes `folder` remember `dirs`, as a pass that found them would.
fn remembers(folder: &Folder, dirs: &[&Path]) {
    let entries: Vec<Registered> = dirs
        .iter()
        .map(|dir| Registered {
            dir: dir.to_path_buf(),
            folder: "01a00000-0000-7000-8000-000000003578".into(),
            store: None,
            root: None,
        })
        .collect();
    crate::store::meta_set(
        &folder.core.conn().unwrap(),
        elsewhere::META_OTHERS,
        &serde_json::to_string(&entries).unwrap(),
    )
    .unwrap();
}

/// `a` remembers `other`, whose directory is gone, and holds `held.txt`.
fn holding_for_a_gone_folder(ids: [&str; 2]) -> (tempfile::TempDir, Folder, tempfile::TempDir) {
    let (from, a, other) = remembering(ids);
    // The witness: the remembered directory there but unreadable holds the
    // delete, as an unmounted volume would.
    {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        let unread = a.scan().unwrap();
        assert_eq!(unread.deleted, 0, "{unread:?}");
        assert_eq!(held_paths(&unread), ["held.txt"], "{unread:?}");
    }
    std::fs::remove_dir_all(other.path()).unwrap();
    let gone = a.scan().unwrap();
    assert!(gone.trashed.is_empty(), "{gone:?}");
    assert_eq!(held_paths(&gone), ["held.txt"], "{gone:?}");
    (from, a, other)
}

#[test]
fn forgetting_a_gone_folder_lets_its_held_delete_be_decided_again_and_sent_with_no_other_folder() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357801",
        "01a00000-0000-7000-8000-000000357802",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert_eq!(shown.dir, other.path());
    assert!(!shown.listed);
    assert_eq!(shown.not_read, []);
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(shown.folders[0].dir, from.path());
    let held: Vec<&str> = shown.folders[0]
        .held
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(held, ["held.txt"], "{shown:?}");

    // Showing changes nothing.
    let still = a.scan().unwrap();
    assert!(still.trashed.is_empty(), "{still:?}");
    assert!(elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));

    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.not_changed, [], "{forgotten:?}");
    assert_eq!(forgotten.forgotten.len(), 1, "{forgotten:?}");
    assert_eq!(forgotten.forgotten[0].released, ["held.txt"]);
    let a = Folder::open(from.path(), None).unwrap();
    assert!(!elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));
    let decided = a.scan().unwrap();
    assert_eq!(decided.trashed, ["held.txt"], "{decided:?}");
}

#[test]
fn a_delete_released_by_a_forget_is_held_again_while_another_listed_folder_stands() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = remembering([
        "01a00000-0000-7000-8000-000000357803",
        "01a00000-0000-7000-8000-000000357804",
    ]);
    let (third, c) = folder_with(
        "01a00000-0000-7000-8000-000000357805",
        json!({ "query": {} }),
        None,
    );
    c.scan().unwrap();
    std::fs::remove_dir_all(other.path()).unwrap();
    let held = a.scan().unwrap();
    assert_eq!(held_paths(&held), ["held.txt"], "{held:?}");
    let shown = Folder::remembering(other.path()).unwrap();
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
    let a = Folder::open(from.path(), None).unwrap();
    let decided = a.scan().unwrap();
    assert_eq!(decided.deleted, 0, "{decided:?}");
    let reason = &decided.unsure.first().expect("held again").reason;
    assert!(
        reason.contains(&third.path().display().to_string()),
        "the hold does not name the folder still listed: {reason}"
    );
}

#[test]
fn a_folder_whose_memory_cannot_be_read_is_named_and_left_as_it_was() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357806",
        "01a00000-0000-7000-8000-000000357807",
    ]);
    let (fourth, d) = folder_with(
        "01a00000-0000-7000-8000-000000357808",
        json!({ "query": {} }),
        None,
    );
    d.scan().unwrap();
    remembers(&d, &[other.path()]);
    let shown = {
        let _sealed = crate::test_folders::locked(fourth.path().join(STATE_DIR), 0o000);
        Folder::remembering(other.path()).unwrap()
    };
    let read: Vec<&Path> = shown.folders.iter().map(|f| f.dir.as_path()).collect();
    assert_eq!(read, [from.path()], "{shown:?}");
    assert_eq!(shown.not_read.len(), 1, "{shown:?}");
    assert_eq!(shown.not_read[0].dir, fourth.path());
    assert!(!shown.not_read[0].reason.is_empty());

    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.forgotten.len(), 1, "{forgotten:?}");
    assert_eq!(forgotten.not_changed, shown.not_read, "{forgotten:?}");
    assert!(
        elsewhere::remembered_dirs(&d).contains(&other.path().to_path_buf()),
        "a folder that was not read was changed"
    );
}

#[test]
fn a_folder_whose_store_changed_since_it_was_shown_is_left_as_it_was() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357809",
        "01a00000-0000-7000-8000-000000357810",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    crate::store::meta_set(
        &a.core.conn().unwrap(),
        elsewhere::META_STORE,
        "01a00000-0000-7000-8000-000000357811",
    )
    .unwrap();
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert_eq!(forgotten.not_changed[0].dir, from.path());
    let a = Folder::open(from.path(), None).unwrap();
    assert!(elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));
    let swept = a.scan().unwrap();
    assert!(swept.trashed.is_empty(), "{swept:?}");
    assert_eq!(held_paths(&swept), ["held.txt"]);
}

#[test]
fn a_folder_another_process_does_not_let_go_is_left_as_it_was() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357812",
        "01a00000-0000-7000-8000-000000357813",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    let forgotten = Folder::forget_waiting(&shown, Duration::from_millis(200)).unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert_eq!(forgotten.not_changed[0].dir, from.path());
    assert!(elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));
    assert_eq!(held_paths(&a.scan().unwrap()), ["held.txt"]);
}

#[test]
fn a_path_no_folder_remembers_changes_nothing() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357814",
        "01a00000-0000-7000-8000-000000357815",
    ]);
    let elsewhere_dir = other.path().with_file_name("never-a-folder");
    let shown = Folder::remembering(&elsewhere_dir).unwrap();
    assert_eq!(shown.folders, []);
    assert_eq!(shown.not_read, []);
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.forgotten, []);
    let a = Folder::open(from.path(), None).unwrap();
    assert!(elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));
}

#[test]
fn a_listed_directory_is_forgotten_only_from_what_folders_remember() {
    let (registry, _guard) = registry::tests::own_registry();
    let query = json!({ "query": {} });
    let (from, a) = folder_with("01a00000-0000-7000-8000-000000357816", query.clone(), None);
    let (listed, b) = folder_with("01a00000-0000-7000-8000-000000357817", query, None);
    a.scan().unwrap();
    b.scan().unwrap();
    remembers(&a, &[listed.path()]);
    let shown = Folder::remembering(listed.path()).unwrap();
    assert!(shown.listed, "{shown:?}");
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(shown.folders[0].held, []);
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert!(forgotten.listed);
    assert_eq!(forgotten.forgotten.len(), 1, "{forgotten:?}");
    let a = Folder::open_without_listing(from.path().to_path_buf(), None, None).unwrap();
    assert!(!elsewhere::remembered_dirs(&a).contains(&listed.path().to_path_buf()));
    let still: Vec<PathBuf> = registry
        .read()
        .unwrap()
        .unwrap()
        .into_iter()
        .map(|entry| entry.dir)
        .collect();
    assert!(still.contains(&listed.path().to_path_buf()), "{still:?}");
    drop(b);
}

/// A trailing slash names the same path. Another case in the part of the
/// path that is gone is another path, even on a volume that ignores case, and
/// is only pointed out.
#[test]
fn a_path_is_matched_exactly_as_remembered() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a) = folder_with(
        "01a00000-0000-7000-8000-000000357818",
        json!({ "query": {} }),
        None,
    );
    a.scan().unwrap();
    let gone = from.path().with_file_name(format!(
        "{}-Gone",
        from.path().file_name().unwrap().to_string_lossy()
    ));
    remembers(&a, &[&gone]);
    let slashed = Folder::remembering(format!("{}/", gone.display())).unwrap();
    assert_eq!(slashed.folders.len(), 1, "{slashed:?}");
    let other_case = gone.with_file_name(
        gone.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("-Gone", "-gone"),
    );
    let cased = Folder::remembering(&other_case).unwrap();
    assert_eq!(cased.folders, [], "{cased:?}");
    assert_eq!(cased.alike, [gone]);
}
