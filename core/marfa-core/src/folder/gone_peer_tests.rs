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
fn a_delete_stays_held_for_a_remembered_folder_whose_directory_is_gone_until_it_is_forgotten() {
    let (_, _registry) = registry::tests::own_registry();
    let (from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a1",
        "01a00000-0000-7000-8000-0000000035a2",
    ]);
    {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        let unread = a.scan().unwrap();
        assert_eq!(unread.deleted, 0, "{unread:?}");
        let reasons = unsure_reasons(&unread);
        assert_eq!(reasons.len(), 1, "{unread:?}");
        let forgets = format!(
            "`marfa folders remove {}` forgets it",
            other.path().display()
        );
        assert!(
            reasons[0].contains(&forgets),
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

    assert_eq!(
        Folder::remembering(from.path()).unwrap(),
        None,
        "a listed folder was taken for one only remembered"
    );
    assert!(
        holders(other.path().join("never")).is_empty(),
        "a directory no folder remembers was taken for one remembered"
    );
    let root = a.root.clone();
    assert_eq!(holders(other.path()), std::slice::from_ref(&root));
    drop(a);
    let shown = Folder::remembering(other.path()).unwrap().unwrap();
    let done = Folder::forget_remembered(&shown);
    assert_eq!(done.forgotten, std::slice::from_ref(&root));
    assert!(done.unchanged.is_empty(), "{done:?}");
    assert!(holders(other.path()).is_empty());
    let a = Folder::open(&root, None).unwrap();
    let swept = a.scan().unwrap();
    assert_eq!(swept.trashed, ["held.txt"], "{swept:?}");
    assert!(swept.unsure.is_empty(), "{swept:?}");
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

#[test]
fn a_delete_stays_held_while_a_remembered_folder_state_is_moved_aside() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a6",
        "01a00000-0000-7000-8000-0000000035a7",
    ]);
    std::fs::rename(
        other.path().join(STATE_DIR),
        other.path().join(".marfa-aside"),
    )
    .unwrap();
    for _ in 0..2 {
        let swept = a.scan().unwrap();
        assert!(
            swept.trashed.is_empty(),
            "a delete was sent because the remembered folder's state is not at its path: {swept:?}"
        );
        assert_eq!(unsure_reasons(&swept).len(), 1, "{swept:?}");
    }
}

/// The one case shown safe: the remembered folder's own store is listed now
/// at another directory, which is then read like any listed folder.
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

fn holders(dir: impl AsRef<std::path::Path>) -> Vec<PathBuf> {
    Folder::remembering(dir)
        .unwrap()
        .map(|found| found.holders.into_iter().map(|holder| holder.dir).collect())
        .unwrap_or_default()
}

fn entry(dir: &std::path::Path, store: &str) -> Registered {
    Registered {
        dir: dir.to_path_buf(),
        folder: format!("folder-{store}"),
        store: Some(store.to_string()),
        root: None,
    }
}

/// A listed folder over `query`, with no remembered folder yet.
fn listed(id: &str) -> (tempfile::TempDir, Folder) {
    let (dir, folder) = folder_with(id, json!({ "query": {} }), None);
    folder.scan().unwrap();
    elsewhere::set_remembered(&folder, &[]);
    (dir, folder)
}

#[test]
fn a_remembered_directory_is_matched_by_the_exact_path_named_and_no_other_spelling() {
    let (_, _registry) = registry::tests::own_registry();
    let (_a_dir, a) = listed("01a00000-0000-7000-8000-0000000035b1");
    let away = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let real = away.path().join("real");
    let link = away.path().join("link");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    elsewhere::set_remembered(&a, &[entry(&link, "store-x"), entry(&real, "store-y")]);
    drop(a);

    let shown = Folder::remembering(&link).unwrap().unwrap();
    assert_eq!(shown.holders.len(), 1, "{shown:?}");
    assert_eq!(
        shown.holders[0].entries,
        [entry(&link, "store-x")],
        "the path named matched a remembered folder by another spelling"
    );
    let done = Folder::forget_remembered(&shown);
    assert!(done.unchanged.is_empty(), "{done:?}");
    let a = Folder::open(_a_dir.path(), None).unwrap();
    assert_eq!(elsewhere::remembered_dirs(&a), [real]);
}

#[test]
fn looking_up_a_remembered_directory_writes_nothing() {
    let (registry, _registry) = registry::tests::own_registry();
    let (a_dir, a) = listed("01a00000-0000-7000-8000-0000000035b2");
    let gone = a_dir.path().with_extension("gone");
    elsewhere::set_remembered(&a, &[entry(&gone, "store-gone")]);
    drop(a);
    // A duplicate entry, which any tidy of the registry rewrites.
    let mut listing: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry.path()).unwrap()).unwrap();
    let first = listing["folders"][0].clone();
    listing["folders"].as_array_mut().unwrap().push(first);
    std::fs::write(registry.path(), serde_json::to_vec(&listing).unwrap()).unwrap();
    let before = std::fs::read(registry.path()).unwrap();
    let state = a_dir.path().join(STATE_DIR).join("core.sqlite");
    let stored = std::fs::read(&state).unwrap();

    assert_eq!(holders(&gone), [a_dir.path().to_path_buf()]);
    assert_eq!(std::fs::read(registry.path()).unwrap(), before);
    assert_eq!(std::fs::read(&state).unwrap(), stored);

    // The witness: the registry's own read rewrites the duplicate.
    registry.folders().unwrap();
    assert_ne!(std::fs::read(registry.path()).unwrap(), before);
}

#[test]
fn forgetting_removes_only_the_entries_shown() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = listed("01a00000-0000-7000-8000-0000000035b3");
    let gone = a_dir.path().with_extension("gone");
    elsewhere::set_remembered(&a, &[entry(&gone, "store-shown")]);
    drop(a);
    let shown = Folder::remembering(&gone).unwrap().unwrap();
    let a = Folder::open(a_dir.path(), None).unwrap();
    elsewhere::set_remembered(
        &a,
        &[entry(&gone, "store-shown"), entry(&gone, "store-later")],
    );
    drop(a);
    let done = Folder::forget_remembered(&shown);
    assert_eq!(done.forgotten, [a_dir.path().to_path_buf()], "{done:?}");
    let a = Folder::open(a_dir.path(), None).unwrap();
    assert_eq!(elsewhere::remembered_dirs(&a), [gone]);
}

#[test]
fn forgetting_reports_each_folder_it_could_not_open_as_unchanged() {
    let (_, _registry) = registry::tests::own_registry();
    let (a_dir, a) = listed("01a00000-0000-7000-8000-0000000035b4");
    let (c_dir, c) = listed("01a00000-0000-7000-8000-0000000035b5");
    let gone = a_dir.path().with_extension("gone");
    for folder in [&a, &c] {
        elsewhere::set_remembered(folder, &[entry(&gone, "store-gone")]);
    }
    drop((a, c));
    let shown = Folder::remembering(&gone).unwrap().unwrap();
    assert_eq!(shown.holders.len(), 2, "{shown:?}");
    let done = {
        let _sealed = crate::test_folders::locked(c_dir.path(), 0o000);
        Folder::forget_remembered(&shown)
    };
    assert_eq!(done.forgotten, [a_dir.path().to_path_buf()], "{done:?}");
    let unchanged: Vec<&PathBuf> = done.unchanged.iter().map(|(dir, _)| dir).collect();
    assert_eq!(unchanged, [&c_dir.path().to_path_buf()], "{done:?}");
    let c = Folder::open(c_dir.path(), None).unwrap();
    assert_eq!(elsewhere::remembered_dirs(&c), [gone]);
}
