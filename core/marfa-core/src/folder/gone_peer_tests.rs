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

    assert!(
        Folder::remembered_by(from.path()).unwrap().is_empty(),
        "a listed folder was taken for one only remembered"
    );
    assert!(
        Folder::remembered_by(other.path().join("never"))
            .unwrap()
            .is_empty(),
        "a directory no folder remembers was taken for one remembered"
    );
    let root = a.root.clone();
    assert_eq!(
        Folder::remembered_by(other.path()).unwrap(),
        std::slice::from_ref(&root)
    );
    drop(a);
    assert_eq!(
        Folder::forget_remembered(other.path()).unwrap(),
        std::slice::from_ref(&root)
    );
    assert!(Folder::remembered_by(other.path()).unwrap().is_empty());
    let a = Folder::open(&root, None).unwrap();
    let swept = a.scan().unwrap();
    assert_eq!(swept.trashed, ["held.txt"], "{swept:?}");
    assert!(swept.unsure.is_empty(), "{swept:?}");
}

#[test]
fn a_remembered_folder_whose_directory_holds_another_folder_is_forgotten() {
    let (_, _registry) = registry::tests::own_registry();
    let (_from, a, other) = remembering([
        "01a00000-0000-7000-8000-0000000035a3",
        "01a00000-0000-7000-8000-0000000035a4",
    ]);
    std::fs::remove_dir_all(other.path()).unwrap();
    let held_for_it = a.scan().unwrap();
    assert!(held_for_it.trashed.is_empty(), "{held_for_it:?}");

    let state = other.path().join(STATE_DIR);
    std::fs::create_dir_all(&state).unwrap();
    let core = Core::open(state.join("core.sqlite"), None).unwrap();
    settings_file::bind(&core, "01a00000-0000-7000-8000-0000000035a5").unwrap();
    elsewhere::store_id(&core).unwrap();
    drop(core);
    let swept = a.scan().unwrap();
    assert_eq!(
        swept.trashed,
        ["held.txt"],
        "a delete stayed held for a folder whose directory holds another folder: {swept:?}"
    );
}
