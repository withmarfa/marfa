use serde_json::json;

use super::health::{Code, Problem};
use super::tests::{folder_with, landed, past_the_grace};
use super::*;

fn held(status: &StatusReport, path: &str) -> Option<(&'static str, Option<&'static str>)> {
    status
        .files
        .iter()
        .find(|file| file.path == path)
        .map(|file| (file.status, file.flag))
}

/// A folder that remembers another, no longer listed, with `held.txt` gone
/// past the grace, and the other folder's directory.
fn remembering(ids: [&str; 2]) -> (tempfile::TempDir, Folder, tempfile::TempDir) {
    let query = json!({ "query": {} });
    let (from, a) = folder_with(ids[0], query.clone(), None);
    let (other, b) = folder_with(ids[1], query, None);
    b.scan().unwrap();
    for name in ["first.txt", "held.txt"] {
        std::fs::write(from.path().join(name), format!("{name} words\n")).unwrap();
    }
    assert_eq!(a.scan().unwrap().created, 2);
    for name in ["first.txt", "held.txt"] {
        landed(&a, name);
    }
    // Deciding this delete finds the other folder, so this one remembers it.
    std::fs::remove_file(from.path().join("first.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    past_the_grace(&a, "first.txt");
    assert_eq!(a.scan().unwrap().deleted, 1);
    drop(b);
    assert!(Folder::forget(other.path()).unwrap());
    std::fs::remove_file(from.path().join("held.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    past_the_grace(&a, "held.txt");
    (from, a, other)
}

fn unsure_reasons(report: &ScanReport) -> Vec<&str> {
    report
        .unsure
        .iter()
        .filter(|file| file.path == "held.txt")
        .map(|file| file.reason.as_str())
        .collect()
}

#[test]
fn a_delete_stays_held_as_a_held_file_for_a_remembered_folder_that_cannot_be_read_or_is_gone() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a1",
        "01a00000-0000-7000-8000-0000000035a2",
    ]);
    {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        let unread = a.scan().unwrap();
        assert_eq!(unread.deleted, 0, "{unread:?}");
        let reasons = unsure_reasons(&unread);
        assert_eq!(reasons.len(), 1, "{unread:?}");
        let mount = format!(
            "the folder {} cannot be reached, and the registry no longer lists it; if its volume is not mounted, mount it",
            other.path().display()
        );
        assert!(
            reasons[0].contains(&mount),
            "the advice names no step that ends the hold: {}",
            reasons[0]
        );
        let status = a.status().unwrap();
        assert_eq!(
            held(&status, "held.txt"),
            Some(("held", Some("unsure"))),
            "a delete held for a folder that cannot be read reads as waiting to be sent"
        );
        a.health_observe(true, false, None, None, false);
        let observed = a.observed_health().unwrap();
        assert!(
            observed.problems.contains(&Problem {
                code: Code::HeldFile,
                count: 1
            }),
            "the held delete is no problem in the folder's health: {observed:?}"
        );
        assert_eq!(observed.pending_uploads, 0, "{observed:?}");
    }

    // Removed from a volume that is mounted, as an unmounted volume's
    // directory also reads, so nothing tells it was removed.
    std::fs::remove_dir_all(other.path()).unwrap();
    let missing = a.scan().unwrap();
    assert!(missing.trashed.is_empty(), "{missing:?}");
    assert_eq!(unsure_reasons(&missing).len(), 1, "{missing:?}");
    let status = a.status().unwrap();
    assert_eq!(held(&status, "held.txt"), Some(("held", Some("unsure"))));
}

/// Another folder's state at the remembered path, as when volumes holding
/// different folders are mounted in turn at one mount point.
#[test]
fn a_delete_stays_held_while_another_folder_stands_at_a_remembered_directory() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a3",
        "01a00000-0000-7000-8000-0000000035a4",
    ]);
    std::fs::remove_dir_all(other.path()).unwrap();
    let state = other.path().join(STATE_DIR);
    std::fs::create_dir_all(&state).unwrap();
    let core = Core::open(state.join("core.sqlite"), None).unwrap();
    settings_file::bind(&core, "01a00000-0000-7000-8000-0000000035a5").unwrap();
    elsewhere::store_id(&core).unwrap();
    drop(core);
    for _ in 0..2 {
        let swept = a.scan().unwrap();
        assert!(
            swept.trashed.is_empty(),
            "a delete was sent because another folder stands at the remembered directory: {swept:?}"
        );
        assert_eq!(unsure_reasons(&swept).len(), 1, "{swept:?}");
    }
}

/// The remembered folder's own store listed now at another directory is read
/// there like any listed folder.
#[test]
fn a_remembered_folder_listed_at_another_directory_is_forgotten_and_the_delete_sent() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a8",
        "01a00000-0000-7000-8000-0000000035a9",
    ]);
    let held_for_it = {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        a.scan().unwrap()
    };
    assert!(held_for_it.trashed.is_empty(), "{held_for_it:?}");
    let away = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let moved = away.path().join("moved");
    std::fs::rename(other.path(), &moved).unwrap();
    drop(Folder::open(&moved, None).unwrap());
    let swept = a.scan().unwrap();
    assert_eq!(
        swept.trashed,
        ["held.txt"],
        "a delete stayed held for a folder listed at another directory: {swept:?}"
    );
    let remembered: Vec<PathBuf> = elsewhere::remembered_dirs(&a);
    assert!(
        !remembered.contains(&other.path().to_path_buf()),
        "{remembered:?}"
    );
    assert!(remembered.contains(&moved), "{remembered:?}");
}

/// A folder with `sub/held.txt`, which a listed folder beside it took part in
/// deciding a delete for, so it remembers that folder too.
fn beside_a_listed_folder(
    ids: [&str; 2],
) -> (tempfile::TempDir, Folder, tempfile::TempDir, Folder) {
    let query = json!({ "query": {} });
    let (from, a) = folder_with(ids[0], query.clone(), None);
    let (other, b) = folder_with(ids[1], query, None);
    b.scan().unwrap();
    std::fs::create_dir(from.path().join("sub")).unwrap();
    for name in ["first.txt", "sub/held.txt"] {
        std::fs::write(from.path().join(name), name).unwrap();
    }
    assert_eq!(a.scan().unwrap().created, 2);
    for name in ["first.txt", "sub/held.txt"] {
        landed(&a, name);
    }
    std::fs::remove_file(from.path().join("first.txt")).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "first.txt");
    assert_eq!(a.scan().unwrap().deleted, 1);
    (from, a, other, b)
}

/// While a remembered folder's volume is away, a registry entry for another
/// store at the same path that records no admitted directory must not take
/// the remembered folder's place, or mounting that store would release the
/// delete of a file that moved into the remembered folder.
#[test]
fn a_rootless_entry_for_another_store_at_a_remembered_path_releases_no_delete() {
    let (registry, _guard) = registry::tests::own_registry();
    let (from, a, other, b) = beside_a_listed_folder([
        "01a00000-0000-7000-8000-0000000035b1",
        "01a00000-0000-7000-8000-0000000035b2",
    ]);
    let (third, c) = folder_with(
        "01a00000-0000-7000-8000-0000000035b3",
        json!({ "query": {} }),
        None,
    );
    c.scan().unwrap();
    let mut entries = registry.folders().unwrap();
    let mut rootless = entries
        .iter()
        .find(|entry| entry.dir == third.path())
        .unwrap()
        .clone();
    rootless.root = None;
    rootless.dir = other.path().to_owned();
    entries.retain(|entry| entry.dir == from.path());
    entries.push(rootless);
    drop(b);
    drop(c);
    std::fs::write(
        registry.path(),
        serde_json::to_vec(&json!({ "folders": entries })).unwrap(),
    )
    .unwrap();
    // The remembered folder's volume goes, leaving its empty mount point,
    // and the file moves into it on the way.
    let away = tempfile::tempdir().unwrap();
    let unmounted = away.path().join("unmounted");
    std::fs::rename(other.path(), &unmounted).unwrap();
    std::fs::create_dir(other.path()).unwrap();
    std::fs::rename(from.path().join("sub/held.txt"), unmounted.join("held.txt")).unwrap();
    a.scan().unwrap();
    past_the_grace(&a, "sub/held.txt");
    let empty_mount = a.scan().unwrap();
    assert_eq!(empty_mount.unsure.len(), 1, "{empty_mount:?}");
    // The other store's volume mounts at the same path.
    std::fs::remove_dir(other.path()).unwrap();
    std::fs::rename(third.path(), other.path()).unwrap();
    let mounted = a.scan().unwrap();
    assert_eq!(
        mounted.deleted, 0,
        "a delete was sent once another store stood at the remembered path: {mounted:?}"
    );
}

/// A pass that cannot read a held file's directory cannot see it come back
/// and go again, so the grace starts afresh at the next pass that reads it.
#[test]
fn a_pass_that_cannot_read_a_held_files_directory_restarts_its_grace() {
    let (_, _guard) = registry::tests::own_registry();
    let (from, a, other, _b) = beside_a_listed_folder([
        "01a00000-0000-7000-8000-0000000035b4",
        "01a00000-0000-7000-8000-0000000035b5",
    ]);
    let away = tempfile::tempdir().unwrap();
    let file = from.path().join("sub/held.txt");
    let outside = away.path().join("held.txt");
    std::fs::rename(&file, &outside).unwrap();
    {
        let _sealed_other = crate::test_folders::locked(other.path(), 0o000);
        a.scan().unwrap();
        past_the_grace(&a, "sub/held.txt");
        assert_eq!(a.scan().unwrap().unsure.len(), 1);
        std::fs::rename(&outside, &file).unwrap();
        let _sealed_parent = crate::test_folders::locked(from.path().join("sub"), 0o000);
        assert!(!a.scan().unwrap().swept);
    }
    std::fs::rename(&file, &outside).unwrap();
    // As though the grace ran out between the unread pass and this one.
    let long_ago = crate::store::iso_at(
        crate::clock::system_time() - RENAME_GRACE - std::time::Duration::from_secs(1),
    );
    a.core
        .conn()
        .unwrap()
        .execute("UPDATE folder_journal SET missing_since = ?1", [&long_ago])
        .unwrap();
    let just_gone = a.scan().unwrap();
    assert_eq!(
        just_gone.deleted, 0,
        "a delete was sent before its grace ran out after a pass that could not read it: {just_gone:?}"
    );
    // The witness: once the grace runs out, the delete is sent.
    past_the_grace(&a, "sub/held.txt");
    let swept = a.scan().unwrap();
    assert_eq!(swept.trashed, ["sub/held.txt"], "{swept:?}");
}
