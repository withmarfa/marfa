use std::time::Duration;

use serde_json::json;

use super::gone_peer_tests::remembering;
use super::registry::{Registered, Registry};
use super::tests::{folder_with, landed};
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
        .map(|waiting| waiting.file.path.as_str())
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

/// Adds `entry` to the registry file as written, as another process would.
fn list_raw(registry: &Registry, entry: Registered) {
    let mut listing: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
    listing["folders"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::to_value(entry).unwrap());
    std::fs::write(
        registry.path(),
        serde_json::to_vec_pretty(&listing).unwrap(),
    )
    .unwrap();
}

/// Every file under `dir` and its bytes, but the files SQLite keeps beside a
/// store for whoever has it open.
fn tree(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(at) = pending.pop() {
        for entry in std::fs::read_dir(&at).unwrap() {
            let path = entry.unwrap().path();
            let name = path.to_string_lossy();
            if path.is_dir() {
                pending.push(path);
            } else if name.ends_with("-shm") || name.ends_with("-wal") {
                assert!(
                    !name.ends_with("-wal") || std::fs::read(&path).unwrap().is_empty(),
                    "{name} holds writes"
                );
            } else {
                let bytes = std::fs::read(&path).unwrap();
                found.push((path.strip_prefix(dir).unwrap().to_path_buf(), bytes));
            }
        }
    }
    found.sort();
    found
}

fn set_journal(folder: &Folder, sql: &str, path: &str) {
    let changed = folder.core.conn().unwrap().execute(sql, [path]).unwrap();
    assert!(changed > 0, "{path} is not journaled");
}

/// A copy of a remembered folder's state listed at another directory is not
/// evidence that the folder is gone, so the folder stays one that a moved
/// file is found in, and forgetting the copy sends no delete.
#[test]
fn a_copy_of_a_remembered_store_listed_elsewhere_leaves_the_folder_remembered() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = remembering([
        "01a00000-0000-7000-8000-000000357821",
        "01a00000-0000-7000-8000-000000357822",
    ]);
    std::fs::write(other.path().join("held.txt"), "held.txt words\n").unwrap();
    let json = crate::store::meta_get(&a.core.conn().unwrap(), elsewhere::META_OTHERS)
        .unwrap()
        .unwrap();
    let entry = serde_json::from_str::<Vec<Registered>>(&json)
        .unwrap()
        .into_iter()
        .find(|entry| entry.dir == other.path())
        .unwrap();
    assert!(entry.store.is_some(), "{entry:?}");
    let copy = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    std::fs::create_dir(copy.path().join(STATE_DIR)).unwrap();
    std::fs::copy(
        other.path().join(STATE_DIR).join("core.sqlite"),
        copy.path().join(STATE_DIR).join("core.sqlite"),
    )
    .unwrap();
    list_raw(
        &registry,
        Registered {
            dir: copy.path().to_path_buf(),
            root: None,
            ..entry
        },
    );
    let found = a.scan().unwrap();
    assert!(found.trashed.is_empty(), "{found:?}");
    assert!(
        elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()),
        "a copied store listed elsewhere dropped the folder it was copied from"
    );
    assert!(Folder::forget(copy.path()).unwrap());
    let copied = copy.path().to_path_buf();
    drop(copy);
    let shown = Folder::remembering(&copied).unwrap();
    drop(a);
    Folder::forget_remembered(&shown).unwrap();
    let a = Folder::open(from.path(), None).unwrap();
    let after = a.scan().unwrap();
    assert!(after.trashed.is_empty(), "{after:?}");
    assert!(other.path().join("held.txt").exists());
}

/// A hold waits on the folder that made it unsure, whatever its reason's
/// words: a path that starts another's does not select it.
#[test]
fn a_hold_for_another_directory_whose_path_starts_with_the_forgotten_one_is_not_shown() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-000000357823",
        "01a00000-0000-7000-8000-000000357824",
    ]);
    let work = other.path().join("Work");
    let archive = other.path().join("Work Archive");
    remembers(&a, &[&archive]);
    let held = a.scan().unwrap();
    assert_eq!(held_paths(&held), ["held.txt"], "{held:?}");
    remembers(&a, &[&archive, &work]);
    let shown = Folder::remembering(&work).unwrap();
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(shown.folders[0].held, [], "{shown:?}");
}

/// A folder that could not be read whole holds a delete for itself, even
/// where the reason names only the part that could not be read.
#[test]
fn a_hold_for_a_folder_with_an_unreadable_part_is_released_by_forgetting_it() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = remembering([
        "01a00000-0000-7000-8000-000000357825",
        "01a00000-0000-7000-8000-000000357826",
    ]);
    let shut = other.path().join("Shut");
    std::fs::create_dir(&shut).unwrap();
    std::fs::write(shut.join("inside.txt"), "inside\n").unwrap();
    {
        let _sealed = crate::test_folders::locked(&shut, 0o000);
        let held = a.scan().unwrap();
        assert_eq!(held_paths(&held), ["held.txt"], "{held:?}");
    }
    std::fs::remove_dir_all(other.path()).unwrap();
    let shown = Folder::remembering(other.path()).unwrap();
    let held: Vec<&str> = shown.folders[0]
        .held
        .iter()
        .map(|waiting| waiting.file.path.as_str())
        .collect();
    assert_eq!(held, ["held.txt"], "{shown:?}");
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
    let a = Folder::open(from.path(), None).unwrap();
    assert_eq!(a.scan().unwrap().trashed, ["held.txt"]);
}

/// A folder whose store was replaced since it was shown is not opened to
/// write: nothing in its state directory changes.
#[test]
fn a_folder_whose_store_was_replaced_is_compared_before_any_write() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357827",
        "01a00000-0000-7000-8000-000000357828",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    drop(a);
    let state = from.path().join(STATE_DIR);
    let db = state.join("core.sqlite");
    let copied = state.join("core.sqlite.copy");
    std::fs::copy(&db, &copied).unwrap();
    std::fs::rename(&copied, &db).unwrap();
    let blobs = state.join("core.sqlite.blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let aged = blobs.join(".incoming-3578");
    std::fs::write(&aged, "partial").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&aged)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(86_400))
        .unwrap();
    let before = tree(&state);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert!(
        aged.exists(),
        "a write-capable open ran before the store was compared"
    );
    assert_eq!(tree(&state), before);
}

/// The directory listed while the forget waits for a watch to let a folder
/// go is a folder every pass finds again, so the folder is left whole.
#[test]
fn a_directory_listed_while_the_forget_waits_changes_nothing() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357829",
        "01a00000-0000-7000-8000-000000357830",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(!shown.listed);
    let target = other.path().to_path_buf();
    let registry_at = registry.clone();
    let holder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        list_raw(
            &registry_at,
            Registered {
                dir: target,
                folder: "01a00000-0000-7000-8000-000000357830".into(),
                store: None,
                root: None,
            },
        );
        drop(a);
    });
    let forgotten = Folder::forget_waiting(&shown, Duration::from_secs(20)).unwrap();
    holder.join().unwrap();
    assert!(forgotten.listed, "{forgotten:?}");
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert!(
        remembered_at(&from.path().join(STATE_DIR).join("core.sqlite"))
            .contains(&other.path().to_path_buf())
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);
}

/// A disappearance after the preview is not the one the person agreed to.
#[test]
fn a_hold_made_after_the_preview_is_not_released() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357831",
        "01a00000-0000-7000-8000-000000357832",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert_eq!(shown.folders[0].held.len(), 1, "{shown:?}");
    std::fs::write(from.path().join("held.txt"), "held.txt words\n").unwrap();
    a.scan().unwrap();
    assert_eq!(a.held_files().unwrap(), []);
    std::fs::remove_file(from.path().join("held.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    set_journal(
        &a,
        "UPDATE folder_journal SET missing_since = '2020-01-02T03:04:05.000Z' WHERE path = ?1",
        "held.txt",
    );
    assert_eq!(held_paths(&a.scan().unwrap()), ["held.txt"]);
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.forgotten[0].released, Vec::<String>::new());
    let a = Folder::open(from.path(), None).unwrap();
    assert_eq!(held_paths(&a.scan().unwrap()), ["held.txt"]);
}

/// A held file passed back that does not wait on the directory, such as one
/// held for its own path, is not released.
#[test]
fn a_hold_that_does_not_wait_on_the_directory_is_not_released_when_passed_back() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357833",
        "01a00000-0000-7000-8000-000000357834",
    ]);
    std::fs::write(from.path().join("own.txt"), "own words\n").unwrap();
    assert_eq!(a.scan().unwrap().created, 1);
    landed(&a, "own.txt");
    std::fs::remove_file(from.path().join("own.txt")).unwrap();
    a.scan().unwrap();
    set_journal(
        &a,
        "UPDATE folder_journal SET kept = 'unsure', reason = 'its path cannot be checked (sealed)' WHERE path = ?1",
        "own.txt",
    );
    let own = a
        .held_files()
        .unwrap()
        .into_iter()
        .find(|file| file.path == "own.txt")
        .unwrap();
    let mut shown = Folder::remembering(other.path()).unwrap();
    shown.folders[0].held.push(forget::WaitingHold {
        file: own,
        still_waits_on: Vec::new(),
    });
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
    let a = Folder::open_without_listing(from.path().to_path_buf(), None, None).unwrap();
    let held: Vec<String> = a
        .held_files()
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(held, ["own.txt"]);
}

/// The path is matched as spelled, never through a link that now stands in
/// one of its parents.
#[cfg(unix)]
#[test]
fn a_link_in_a_parent_does_not_redirect_the_forget() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a) = folder_with(
        "01a00000-0000-7000-8000-000000357835",
        json!({ "query": {} }),
        None,
    );
    a.scan().unwrap();
    let base = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (old, live) = (base.path().join("old"), base.path().join("live"));
    std::fs::create_dir(&old).unwrap();
    std::fs::create_dir(&live).unwrap();
    remembers(&a, &[&old.join("notes"), &live.join("notes")]);
    std::fs::remove_dir(&old).unwrap();
    std::os::unix::fs::symlink(&live, &old).unwrap();
    let shown = Folder::remembering(old.join("notes")).unwrap();
    assert_eq!(shown.dir, old.join("notes"));
    drop(a);
    Folder::forget_remembered(&shown).unwrap();
    let a = Folder::open(from.path(), None).unwrap();
    let still = elsewhere::remembered_dirs(&a);
    assert!(still.contains(&live.join("notes")), "{still:?}");
    assert!(!still.contains(&old.join("notes")), "{still:?}");
}

/// A listed folder whose registry entry records no root, on a volume that
/// is not mounted, may remember the directory, so it is named as not read.
#[test]
fn a_listed_folder_on_an_empty_mount_point_is_named_as_not_read() {
    let (registry, _guard) = registry::tests::own_registry();
    let (_from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357836",
        "01a00000-0000-7000-8000-000000357837",
    ]);
    let (fourth, d) = folder_with(
        "01a00000-0000-7000-8000-000000357838",
        json!({ "query": {} }),
        None,
    );
    d.scan().unwrap();
    remembers(&d, &[other.path()]);
    drop(d);
    let mut listing: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
    for entry in listing["folders"].as_array_mut().unwrap() {
        if entry["dir"] == fourth.path().display().to_string() {
            entry.as_object_mut().unwrap().remove("root");
        }
    }
    std::fs::write(
        registry.path(),
        serde_json::to_vec_pretty(&listing).unwrap(),
    )
    .unwrap();
    std::fs::remove_dir_all(fourth.path().join(STATE_DIR)).unwrap();
    let shown = Folder::remembering(other.path()).unwrap();
    let unread: Vec<&Path> = shown
        .not_read
        .iter()
        .map(|left| left.dir.as_path())
        .collect();
    assert_eq!(unread, [fourth.path()], "{shown:?}");
    drop(a);
}

/// Something standing at the path may hold the moved file, so only nothing
/// or an empty directory there, as at an unmounted volume's mount point, is
/// forgotten.
#[cfg(unix)]
#[test]
fn a_path_where_something_stands_is_not_forgotten() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357839",
        "01a00000-0000-7000-8000-000000357840",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    drop(a);
    std::fs::create_dir(other.path()).unwrap();
    std::fs::write(other.path().join("held.txt"), "held.txt words\n").unwrap();
    assert!(Folder::remembering(other.path()).is_err());
    assert!(Folder::forget_remembered(&shown).is_err());
    std::fs::remove_file(other.path().join("held.txt")).unwrap();
    {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        assert!(Folder::remembering(other.path()).is_err());
        assert!(Folder::forget_remembered(&shown).is_err());
    }
    let a = Folder::open(from.path(), None).unwrap();
    assert!(elsewhere::remembered_dirs(&a).contains(&other.path().to_path_buf()));
    assert_eq!(held_paths(&a.scan().unwrap()), ["held.txt"]);
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
}

/// What a store at `db` remembers, read without opening it as a folder.
fn remembered_at(db: &Path) -> Vec<PathBuf> {
    let conn = rusqlite::Connection::open(db).unwrap();
    crate::store::meta_get(&conn, elsewhere::META_OTHERS)
        .unwrap()
        .map(|json| serde_json::from_str::<Vec<Registered>>(&json).unwrap())
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.dir)
        .collect()
}

fn held_in(dir: &Path) -> Vec<String> {
    Folder::open_without_listing(dir.to_path_buf(), None, None)
        .unwrap()
        .held_files()
        .unwrap()
        .into_iter()
        .map(|file| file.path)
        .collect()
}

/// A volume that comes back while the forget waits for a watch may hold the
/// moved file, so the directory is looked at again as the folder is changed.
#[test]
fn a_directory_filled_while_the_forget_waits_is_not_forgotten() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357841",
        "01a00000-0000-7000-8000-000000357842",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    let target = other.path().to_path_buf();
    let holder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("held.txt"), "held.txt words\n").unwrap();
        drop(a);
    });
    let forgotten = Folder::forget_waiting(&shown, Duration::from_secs(20)).unwrap();
    holder.join().unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    let left: Vec<&Path> = forgotten
        .not_changed
        .iter()
        .map(|left| left.dir.as_path())
        .collect();
    assert_eq!(left, [from.path()], "{forgotten:?}");
    assert!(
        forgotten.not_changed[0].reason.contains("is not empty"),
        "{forgotten:?}"
    );
    assert!(
        remembered_at(&from.path().join(STATE_DIR).join("core.sqlite"))
            .contains(&other.path().to_path_buf())
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);
}

/// An entry recording no root, listed at an empty mount point, is a folder
/// whose volume is not mounted: listed as written, it releases no hold.
#[test]
fn a_directory_listed_at_an_empty_mount_point_while_the_forget_waits_changes_nothing() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357843",
        "01a00000-0000-7000-8000-000000357844",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(!shown.listed);
    std::fs::create_dir(other.path()).unwrap();
    let target = other.path().to_path_buf();
    let registry_at = registry.clone();
    let holder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        list_raw(
            &registry_at,
            Registered {
                dir: target,
                folder: "01a00000-0000-7000-8000-000000357844".into(),
                store: None,
                root: None,
            },
        );
        drop(a);
    });
    let forgotten = Folder::forget_waiting(&shown, Duration::from_secs(20)).unwrap();
    holder.join().unwrap();
    assert!(forgotten.listed, "{forgotten:?}");
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert!(
        remembered_at(&from.path().join(STATE_DIR).join("core.sqlite"))
            .contains(&other.path().to_path_buf())
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);
}

/// A folder moved while the forget waits, with a copy of it listed at its
/// old path, is neither the folder listed nor the one shown.
#[test]
fn a_folder_replaced_at_its_listed_path_while_the_forget_waits_is_left_as_it_was() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357845",
        "01a00000-0000-7000-8000-000000357846",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    let park = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let moved = park.path().join("moved");
    let (old, moved_to, registry_at) = (from.path().to_path_buf(), moved.clone(), registry.clone());
    let holder = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        std::fs::rename(&old, &moved_to).unwrap();
        std::fs::create_dir_all(old.join(STATE_DIR)).unwrap();
        let copy = old.join(STATE_DIR).join("core.sqlite");
        rusqlite::Connection::open(moved_to.join(STATE_DIR).join("core.sqlite"))
            .unwrap()
            .execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
            .unwrap();
        let root = registry::root_identity(&crate::directory::Directory::open(&old).unwrap());
        let mut listing: serde_json::Value =
            serde_json::from_slice(&std::fs::read(registry_at.path()).unwrap()).unwrap();
        for entry in listing["folders"].as_array_mut().unwrap() {
            if entry["dir"] == old.display().to_string() {
                entry["root"] = json!(root);
            }
        }
        std::fs::write(
            registry_at.path(),
            serde_json::to_vec_pretty(&listing).unwrap(),
        )
        .unwrap();
        drop(a);
    });
    let forgotten = Folder::forget_waiting(&shown, Duration::from_secs(20)).unwrap();
    holder.join().unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    let left: Vec<&Path> = forgotten
        .not_changed
        .iter()
        .map(|left| left.dir.as_path())
        .collect();
    assert_eq!(left, [from.path()], "{forgotten:?}");
    let target = other.path().to_path_buf();
    assert!(remembered_at(&moved.join(STATE_DIR).join("core.sqlite")).contains(&target));
    assert!(remembered_at(&from.path().join(STATE_DIR).join("core.sqlite")).contains(&target));
}

/// A listed directory is found again at every pass, so the folder is left
/// whole until the person removes it from the registry.
#[test]
fn a_listed_directory_is_not_forgotten_until_it_is_removed() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357847",
        "01a00000-0000-7000-8000-000000357848",
    ]);
    list_raw(
        &registry,
        Registered {
            dir: other.path().to_path_buf(),
            folder: "01a00000-0000-7000-8000-000000357848".into(),
            store: None,
            root: None,
        },
    );
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(shown.listed, "{shown:?}");
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(shown.folders[0].held, []);
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert!(forgotten.listed);
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert!(
        forgotten.not_changed[0].reason.contains("`folders remove`"),
        "{forgotten:?}"
    );
    assert!(
        remembered_at(&from.path().join(STATE_DIR).join("core.sqlite"))
            .contains(&other.path().to_path_buf())
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);

    assert!(Folder::forget(other.path()).unwrap());
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(!shown.listed);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
}

/// A hold that waits on a directory no folder remembers any longer, as an
/// earlier forget can leave, is still shown and released.
#[test]
fn a_hold_waiting_on_a_directory_no_longer_remembered_is_released_by_forgetting_it() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357849",
        "01a00000-0000-7000-8000-000000357850",
    ]);
    remembers(&a, &[]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    let held: Vec<&str> = shown.folders[0]
        .held
        .iter()
        .map(|waiting| waiting.file.path.as_str())
        .collect();
    assert_eq!(held, ["held.txt"], "{shown:?}");
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
    assert_eq!(held_in(from.path()), Vec::<String>::new());
}

/// What a Mac leaves at a mount point is not a file a folder takes.
#[test]
fn a_mount_point_holding_only_machine_files_is_forgotten() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357851",
        "01a00000-0000-7000-8000-000000357852",
    ]);
    std::fs::create_dir(other.path()).unwrap();
    std::fs::write(other.path().join(".DS_Store"), "finder").unwrap();
    std::fs::create_dir(other.path().join(".Spotlight-V100")).unwrap();
    std::fs::write(
        other.path().join(".Spotlight-V100").join("store.db"),
        "index",
    )
    .unwrap();
    let shown = Folder::remembering(other.path()).unwrap();
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
}

/// A hold that waits on two directories is narrowed by forgetting one, and
/// released only once the other is forgotten too: the other may hold the
/// file, and the hold is the only record of it once no folder remembers it.
#[test]
fn forgetting_one_directory_a_hold_waits_on_keeps_it_held_on_the_other() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357853",
        "01a00000-0000-7000-8000-000000357854",
    ]);
    let second = from.path().with_file_name(format!(
        "{}-second",
        from.path().file_name().unwrap().to_string_lossy()
    ));
    let waits = serde_json::to_string(&[other.path(), second.as_path()]).unwrap();
    set_journal(
        &a,
        &format!("UPDATE folder_journal SET waits_on = '{waits}' WHERE path = ?1"),
        "held.txt",
    );
    remembers(&a, &[]);
    let shown = Folder::remembering(other.path()).unwrap();
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(shown.folders[0].held.len(), 1, "{shown:?}");
    assert_eq!(
        shown.folders[0].held[0].still_waits_on,
        std::slice::from_ref(&second)
    );
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(forgotten.not_changed, [], "{forgotten:?}");
    assert_eq!(
        forgotten.forgotten[0].released,
        Vec::<String>::new(),
        "{forgotten:?}"
    );
    assert_eq!(
        forgotten.forgotten[0].still_held,
        [forget::StillHeld {
            path: "held.txt".into(),
            still_waits_on: vec![second.clone()],
        }],
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);
    let a = Folder::open(from.path(), None).unwrap();
    let kept = a.scan().unwrap();
    assert!(kept.trashed.is_empty(), "{kept:?}");
    assert_eq!(held_paths(&kept), ["held.txt"], "{kept:?}");
    drop(a);

    let shown = Folder::remembering(&second).unwrap();
    assert_eq!(shown.folders.len(), 1, "{shown:?}");
    assert_eq!(
        shown.folders[0].held[0].still_waits_on,
        Vec::<PathBuf>::new()
    );
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert_eq!(
        forgotten.forgotten[0].released,
        ["held.txt"],
        "{forgotten:?}"
    );
    let a = Folder::open(from.path(), None).unwrap();
    assert_eq!(a.scan().unwrap().trashed, ["held.txt"]);
}

/// A store moved out of its state directory while the forget waits for the
/// registry is not the folder's store any longer, so nothing in it changes.
#[test]
fn a_store_moved_out_of_its_state_directory_while_the_forget_waits_is_left_as_it_was() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357855",
        "01a00000-0000-7000-8000-000000357856",
    ]);
    let shown = Folder::remembering(other.path()).unwrap();
    drop(a);
    let lock = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(registry.path().with_extension("lock"))
        .unwrap();
    lock.lock().unwrap();
    let state = from.path().join(STATE_DIR);
    let park = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (state_at, park_at) = (state.clone(), park.path().to_path_buf());
    let mover = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        for name in ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"] {
            if state_at.join(name).exists() {
                std::fs::rename(state_at.join(name), park_at.join(name)).unwrap();
            }
        }
        drop(lock);
    });
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    mover.join().unwrap();
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    let left: Vec<&Path> = forgotten
        .not_changed
        .iter()
        .map(|left| left.dir.as_path())
        .collect();
    assert_eq!(left, [from.path()], "{forgotten:?}");
    assert!(
        forgotten.not_changed[0]
            .reason
            .contains("moved out of its directory"),
        "{forgotten:?}"
    );
    let moved = park.path().join("core.sqlite");
    assert!(remembered_at(&moved).contains(&other.path().to_path_buf()));
    let kept: Option<String> = rusqlite::Connection::open(&moved)
        .unwrap()
        .query_row(
            "SELECT kept FROM folder_journal WHERE path = 'held.txt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept.as_deref(), Some("unsure"));
}

fn held_reasons(dir: &Path) -> Vec<String> {
    Folder::open_without_listing(dir.to_path_buf(), None, None)
        .unwrap()
        .held_files()
        .unwrap()
        .into_iter()
        .map(|file| file.reason)
        .collect()
}

/// `a`'s `held.txt` waits on `other` and on a second gone directory, with
/// the reason a pass gives two folders.
fn holding_on_two_gone_folders(ids: [&str; 2]) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let (from, a, other) = holding_for_a_gone_folder(ids);
    let second = from.path().with_file_name(format!(
        "{}-second",
        from.path().file_name().unwrap().to_string_lossy()
    ));
    let waits = serde_json::to_string(&[other.path(), second.as_path()]).unwrap();
    set_journal(
        &a,
        &format!(
            "UPDATE folder_journal SET waits_on = '{waits}', reason = '2 other folders are on this computer, so Marfa cannot tell its delete from a move into one of them' WHERE path = ?1"
        ),
        "held.txt",
    );
    remembers(&a, &[]);
    (from, other.path().to_path_buf(), second)
}

/// A hold the person was shown as staying held is not released by that
/// confirmation, though another forget took its other directory meanwhile.
#[test]
fn a_hold_shown_as_staying_held_is_not_released_when_its_other_directory_is_forgotten_meanwhile() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, other, second) = holding_on_two_gone_folders([
        "01a00000-0000-7000-8000-000000357857",
        "01a00000-0000-7000-8000-000000357858",
    ]);
    let first = Folder::remembering(&other).unwrap();
    assert_eq!(
        first.folders[0].held[0].still_waits_on,
        std::slice::from_ref(&second)
    );
    let meanwhile = Folder::remembering(&second).unwrap();
    let done = Folder::forget_remembered(&meanwhile).unwrap();
    assert_eq!(done.forgotten[0].still_held.len(), 1, "{done:?}");

    let forgotten = Folder::forget_remembered(&first).unwrap();
    assert_eq!(forgotten.not_changed, [], "{forgotten:?}");
    assert_eq!(
        forgotten.forgotten[0].released,
        Vec::<String>::new(),
        "{forgotten:?}"
    );
    assert_eq!(forgotten.forgotten[0].not_released, ["held.txt"]);
    assert_eq!(held_in(from.path()), ["held.txt"]);

    let again = Folder::remembering(&other).unwrap();
    assert_eq!(
        again.folders[0].held[0].still_waits_on,
        Vec::<PathBuf>::new()
    );
    let forgotten = Folder::forget_remembered(&again).unwrap();
    assert_eq!(forgotten.forgotten[0].released, ["held.txt"]);
    assert_eq!(held_in(from.path()), Vec::<String>::new());
}

/// A narrowed hold names what it still waits on, not the directory forgotten.
#[test]
fn a_narrowed_hold_gives_its_reason_from_the_directories_it_still_waits_on() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, other, second) = holding_on_two_gone_folders([
        "01a00000-0000-7000-8000-000000357859",
        "01a00000-0000-7000-8000-000000357860",
    ]);
    let shown = Folder::remembering(&second).unwrap();
    Folder::forget_remembered(&shown).unwrap();
    let reasons = held_reasons(from.path());
    assert_eq!(reasons.len(), 1);
    let reason = &reasons[0];
    assert!(reason.contains(&other.display().to_string()), "{reason}");
    assert!(!reason.contains(&second.display().to_string()), "{reason}");
    assert!(!reason.contains("2 other folders"), "{reason}");
    assert!(reason.contains("`folders forget`"), "{reason}");
}

/// The answer is the registry as the folders are changed, so a directory
/// taken off it after the preview is not reported listed, and the folders
/// shown a listed directory are left as they were.
#[test]
fn a_directory_removed_from_the_registry_after_the_preview_is_reported_as_read_then() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357861",
        "01a00000-0000-7000-8000-000000357862",
    ]);
    list_raw(
        &registry,
        Registered {
            dir: other.path().to_path_buf(),
            folder: "01a00000-0000-7000-8000-000000357862".into(),
            store: None,
            root: None,
        },
    );
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(shown.listed);
    drop(a);
    assert!(Folder::forget(other.path()).unwrap());
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert!(!forgotten.listed, "{forgotten:?}");
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(forgotten.not_changed.len(), 1, "{forgotten:?}");
    assert!(
        remembered_at(&from.path().join(STATE_DIR).join("core.sqlite"))
            .contains(&other.path().to_path_buf())
    );
    assert_eq!(held_in(from.path()), ["held.txt"]);
}

/// A listed folder's directory holds its own state, and is reported listed
/// rather than refused as occupied.
#[test]
fn a_listed_directory_where_its_folder_stands_is_reported_listed() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other) = holding_for_a_gone_folder([
        "01a00000-0000-7000-8000-000000357863",
        "01a00000-0000-7000-8000-000000357864",
    ]);
    std::fs::create_dir_all(other.path().join(STATE_DIR)).unwrap();
    std::fs::write(other.path().join("note.md"), "words\n").unwrap();
    list_raw(
        &registry,
        Registered {
            dir: other.path().to_path_buf(),
            folder: "01a00000-0000-7000-8000-000000357864".into(),
            store: None,
            root: None,
        },
    );
    let shown = Folder::remembering(other.path()).unwrap();
    assert!(shown.listed, "{shown:?}");
    drop(a);
    let forgotten = Folder::forget_remembered(&shown).unwrap();
    assert!(forgotten.listed, "{forgotten:?}");
    assert_eq!(forgotten.forgotten, [], "{forgotten:?}");
    assert_eq!(held_in(from.path()), ["held.txt"]);
}
