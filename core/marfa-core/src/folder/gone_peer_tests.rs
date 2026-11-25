//! A directory the registry no longer lists, which a folder found in an
//! earlier pass: when its loss holds a delete, and how the hold shows.

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

#[test]
fn a_delete_waits_while_a_remembered_folder_cannot_be_read_and_is_sent_once_it_is_gone_from_its_volume()
 {
    let (_, _registry) = registry::tests::own_registry();
    let query = json!({ "query": {} });
    let (from, a) = folder_with("01a00000-0000-7000-8000-0000000035a1", query.clone(), None);
    let (other, b) = folder_with("01a00000-0000-7000-8000-0000000035a2", query, None);
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

    // The witness: while the remembered directory stands but cannot be read,
    // the delete is held, and the hold is a problem, not a file in step.
    std::fs::remove_file(from.path().join("held.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    past_the_grace(&a, "held.txt");
    {
        let _sealed = crate::test_folders::locked(other.path(), 0o000);
        let unread = a.scan().unwrap();
        assert_eq!(unread.deleted, 0, "{unread:?}");
        let reasons: Vec<&str> = unread
            .unsure
            .iter()
            .filter(|file| file.path == "held.txt")
            .map(|file| file.reason.as_str())
            .collect();
        assert_eq!(reasons.len(), 1, "{unread:?}");
        assert!(
            !reasons[0].contains("folders remove") && reasons[0].contains("mount"),
            "the advice names no step that works for a folder the registry does not list: {}",
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

    std::fs::remove_dir_all(other.path()).unwrap();
    let swept = a.scan().unwrap();
    assert_eq!(
        swept.trashed,
        ["held.txt"],
        "a delete stayed held for a folder gone from a volume that is mounted: {swept:?}"
    );
    assert!(swept.unsure.is_empty(), "{swept:?}");
    let status = a.status().unwrap();
    assert_ne!(
        held(&status, "held.txt").map(|(_, flag)| flag),
        Some(Some("unsure"))
    );
}
