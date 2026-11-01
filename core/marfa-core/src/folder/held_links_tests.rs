//! A file held because a name it links matches no item, or more than one,
//! is resolved again once the copy changes, and not before.

use super::tests::{ScannedDir, scanned_folder};
use super::*;
use crate::scripted::{Scripted, certified, json, refusal};

/// A folder of notes with nothing in it yet, whose copy has synced, over a
/// server that answers every name lookup with `lookup`.
fn online_folder(lookup: Answer) -> (ScannedDir, Folder, Scripted) {
    let (dir, folder) = scanned_folder();
    {
        use crate::store::{self, meta_set};
        let conn = folder.core.conn().unwrap();
        meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    drop(folder);
    let server = Scripted::start();
    server.on("/items", vec![certified(lookup)]);
    let folder = Folder::open(
        dir.path(),
        Some(crate::Server {
            url: server.url(),
            key: "fixture".into(),
        }),
    )
    .unwrap();
    (dir, folder, server)
}

type Answer = crate::scripted::Answer;

fn nothing_found() -> Answer {
    json(200, r#"{"data":[],"next_cursor":null}"#)
}

fn flags(report: &ScanReport) -> Vec<(&str, &str, &str)> {
    report
        .flagged
        .iter()
        .map(|flagged| (flagged.path.as_str(), flagged.flag, flagged.reason.as_str()))
        .collect()
}

fn item_at(folder: &Folder, path: &str) -> String {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .unwrap_or_else(|| panic!("{path} has no item"))
        .item_id
}

fn edges_of(folder: &Folder, from: &str, edge_type: &str) -> Vec<String> {
    folder
        .core
        .edges_from(from)
        .unwrap()
        .into_iter()
        .filter(|edge| edge.edge_type == edge_type)
        .map(|edge| edge.target_id)
        .collect()
}

fn held(folder: &Folder, path: &str) -> Option<String> {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .and_then(|bound| bound.held)
}

fn lookups(server: &Scripted) -> usize {
    server.seen("/items").len()
}

#[test]
fn a_link_written_before_its_target_resolves_once_the_target_is_made() {
    let (dir, folder, server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    let first = folder.scan().unwrap();
    assert_eq!(first.created, 1, "{first:?}");
    let flagged = flags(&first);
    assert_eq!(flagged.len(), 1, "{first:?}");
    assert_eq!((flagged[0].0, flagged[0].1), ("A.md", "edges"), "{first:?}");
    assert!(flagged[0].2.contains("matches no item"), "{first:?}");

    // Nothing in the copy changed, so nothing is asked again.
    let asked = lookups(&server);
    for _ in 0..3 {
        folder.scan().unwrap();
        assert!(held(&folder, "A.md").is_some_and(|held| held.contains("matches no item")));
    }
    assert_eq!(lookups(&server), asked, "a quiet folder asked again");

    // The target, written in a later pass, names the first as its parent.
    std::fs::write(
        dir.path().join("B.md"),
        "---\nchild-of: \"[[A]]\"\n---\nB\n",
    )
    .unwrap();
    let second = folder.scan().unwrap();
    assert_eq!(second.created, 1, "{second:?}");
    assert!(second.flagged.is_empty(), "{second:?}");
    let (a, b) = (item_at(&folder, "A.md"), item_at(&folder, "B.md"));
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), std::slice::from_ref(&b));
    assert_eq!(edges_of(&folder, &a, crate::filter::PARENT_OF), [b]);
    assert_eq!(held(&folder, "A.md"), None);

    // Resolved, the file is asked about no more.
    let asked = lookups(&server);
    let after = folder.scan().unwrap();
    assert!(after.flagged.is_empty(), "{after:?}");
    assert_eq!(lookups(&server), asked);
}

#[test]
fn two_new_documents_that_link_each_other_are_both_made_and_linked() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    std::fs::write(
        dir.path().join("B.md"),
        "---\nchild-of: \"[[A]]\"\n---\nB\n",
    )
    .unwrap();
    let report = folder.scan().unwrap();
    assert_eq!(report.created, 2, "{report:?}");
    assert!(report.flagged.is_empty(), "{report:?}");
    let (a, b) = (item_at(&folder, "A.md"), item_at(&folder, "B.md"));
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), std::slice::from_ref(&b));
    assert_eq!(edges_of(&folder, &a, crate::filter::PARENT_OF), [b]);
}

#[test]
fn a_name_two_items_have_stays_held_until_one_goes_to_the_bin() {
    const ELSEWHERE: &str = "01a00000-0000-7000-8000-0000000023a1";
    let (dir, folder, server) = online_folder(nothing_found());
    crate::store::put_server_item(
        &folder.core.conn().unwrap(),
        &crate::store::testing::note(ELSEWHERE, "Same", "", "2026-01-01T00:00:00Z"),
        None,
        &crate::catalog::Catalog::empty(),
    )
    .unwrap();
    std::fs::write(dir.path().join("Same.md"), "same\n").unwrap();
    std::fs::write(dir.path().join("A.md"), "See [[Same]].\n").unwrap();
    let first = folder.scan().unwrap();
    assert_eq!(first.created, 2, "{first:?}");
    let flagged = flags(&first);
    assert_eq!(flagged.len(), 1, "{first:?}");
    assert!(flagged[0].2.contains("more than one item"), "{first:?}");
    let a = item_at(&folder, "A.md");
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), Vec::<String>::new());

    // Asked again once the copy changes, it is still never guessed.
    let asked = lookups(&server);
    std::fs::write(dir.path().join("C.md"), "C\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    assert!(
        lookups(&server) > asked,
        "the held name was not asked again"
    );
    assert!(held(&folder, "A.md").is_some_and(|held| held.contains("more than one item")));
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), Vec::<String>::new());

    folder.core.delete_item(ELSEWHERE).unwrap();
    folder.scan().unwrap();
    assert_eq!(held(&folder, "A.md"), None);
    assert_eq!(
        edges_of(&folder, &a, LINK_EDGE),
        [item_at(&folder, "Same.md")]
    );
}

#[test]
fn a_name_the_server_refused_to_look_up_is_not_asked_again_while_the_file_is_unchanged() {
    let (dir, folder, server) = online_folder(refusal(403, "forbidden"));
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    let first = folder.scan().unwrap();
    let flagged = flags(&first);
    assert_eq!(flagged.len(), 1, "{first:?}");
    assert!(flagged[0].2.contains("could not be looked up"), "{first:?}");
    let asked = lookups(&server);
    assert!(asked > 0);

    // The witness that the copy changed: a new note is made, and its own
    // name is no lookup the held file makes.
    std::fs::write(dir.path().join("C.md"), "C\n").unwrap();
    let next = folder.scan().unwrap();
    assert_eq!(next.created, 1, "{next:?}");
    assert!(held(&folder, "A.md").is_some_and(|held| held.contains("could not be looked up")));
    assert_eq!(lookups(&server), asked, "a refused lookup was asked again");
}

/// Sets when the file at `path` is judged again, as a store written before
/// that was recorded holds it with `None`.
fn set_rejudge(folder: &Folder, path: &str, rejudge: Option<state::Rejudge>) {
    let conn = folder.core.conn().unwrap();
    let mut bound = state::bound_at(&conn, path).unwrap().unwrap();
    bound.writes.rejudge = rejudge;
    state::bind(&conn, &bound).unwrap();
}

#[test]
fn a_hold_from_a_store_that_never_recorded_when_to_judge_it_again_is_judged_again() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    folder.scan().unwrap();
    assert!(held(&folder, "A.md").is_some_and(|held| held.contains("matches no item")));
    let a = item_at(&folder, "A.md");

    // The witness: held for nothing a change to the copy can fix, the file
    // is not judged again, even once its target exists.
    set_rejudge(&folder, "A.md", Some(state::Rejudge::FileChanged));
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    assert!(held(&folder, "A.md").is_some());
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), Vec::<String>::new());

    set_rejudge(&folder, "A.md", None);
    let report = folder.scan().unwrap();
    assert!(report.flagged.is_empty(), "{report:?}");
    assert_eq!(held(&folder, "A.md"), None);
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), [item_at(&folder, "B.md")]);
}

#[test]
fn an_unmatched_name_is_asked_again_while_a_refused_name_in_the_same_file_is_not() {
    // How many lookups one name takes, so the refusal lands on the second.
    let per_name = {
        let (dir, folder, server) = online_folder(nothing_found());
        std::fs::write(dir.path().join("Probe.md"), "See [[Elsewhere]].\n").unwrap();
        folder.scan().unwrap();
        lookups(&server)
    };
    assert!(per_name > 0);
    let mut answers = vec![nothing_found(); per_name];
    answers.push(refusal(403, "forbidden"));
    let (dir, folder, server) = online_folder(nothing_found());
    server.on("/items", answers);
    std::fs::write(dir.path().join("A.md"), "See [[B]] and [[Common]].\n").unwrap();
    folder.scan().unwrap();
    let first = held(&folder, "A.md").unwrap();
    assert!(
        first.contains("[[B]] in its body matches no item"),
        "{first}"
    );
    assert!(
        first.contains("[[Common]] in its body could not be looked up"),
        "{first}"
    );
    let asked = lookups(&server);
    let a = item_at(&folder, "A.md");

    server.on("/items", vec![nothing_found()]);
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), [item_at(&folder, "B.md")]);
    let still = held(&folder, "A.md").unwrap();
    assert!(!still.contains("[[B]]"), "{still}");
    assert!(
        still.contains("[[Common]] in its body could not be looked up"),
        "{still}"
    );
    let since: Vec<_> = server.seen("/items").into_iter().skip(asked).collect();
    assert_eq!(since.len(), per_name, "{since:?}");
    assert!(
        since.iter().all(|seen| !seen.query.contains("Common")),
        "the refused name was asked again: {since:?}"
    );
}
