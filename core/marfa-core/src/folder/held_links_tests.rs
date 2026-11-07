//! A file held because a name it links matches no item, or more than one,
//! is resolved again once the copy changes, and not before.

use super::tests::{ScannedDir, scanned_folder};
use super::*;
use crate::scripted::{Scripted, refusal};

/// A folder of notes with nothing in it yet, whose copy has synced, over a
/// server that answers every title lookup with `lookup`.
pub(super) fn online_folder(lookup: Answer) -> (ScannedDir, Folder, Scripted) {
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
    server.on("/items/titles", vec![lookup]);
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

pub(super) type Answer = crate::scripted::Answer;

pub(super) fn nothing_found() -> Answer {
    Answer::Titled { found: Vec::new() }
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

pub(super) fn held(folder: &Folder, path: &str) -> Option<String> {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .and_then(|bound| bound.held)
}

fn lookups(server: &Scripted) -> usize {
    server.seen("/items/titles").len()
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
        &marfa_rules::catalog::Catalog::empty(),
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

    // The copy holds the name twice, so the server could not make it one
    // and is not asked, then or when the copy changes; it is never guessed.
    assert_eq!(lookups(&server), 0, "an ambiguous name was asked");
    std::fs::write(dir.path().join("C.md"), "C\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    assert_eq!(lookups(&server), 0, "an ambiguous name was asked");
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

#[test]
fn names_a_lookup_refused_as_a_whole_carried_wait_and_resolve_at_the_next_scan_unedited() {
    // A server older than the title lookup answers it 404; a refusal of
    // several names names none of them.
    for (status, code, said, shown) in [
        (404, "not_found", "no title lookup", "not found"),
        (
            403,
            "type_not_permitted",
            "several names",
            "type_not_permitted",
        ),
    ] {
        let (dir, folder, server) = online_folder(refusal(status, code));
        std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
        std::fs::write(dir.path().join("A.md"), "See [[B]] and [[C]].\n").unwrap();
        let first = folder.scan().unwrap();
        assert_eq!(first.created, 2, "{first:?}");
        let flagged = flags(&first);
        assert_eq!(flagged.len(), 1, "{first:?}");
        assert_eq!((flagged[0].0, flagged[0].1), ("A.md", "edges"), "{first:?}");
        assert!(
            flagged[0]
                .2
                .contains("[[B]] in its body is looked up once the server can be asked")
                && !flagged[0].2.contains("could not be looked up"),
            "{first:?}"
        );
        assert!(
            first
                .lookup_refused
                .as_deref()
                .is_some_and(|why| why.contains(said) && why.contains(shown)),
            "{first:?}"
        );
        assert_eq!(lookups(&server), 1, "{status}");

        // The server now answers; neither file has changed.
        server.on("/items/titles", vec![nothing_found()]);
        let second = folder.scan().unwrap();
        assert_eq!(second.lookup_refused, None, "{second:?}");
        assert!(
            lookups(&server) > 1,
            "{status}: the names were not asked again"
        );
        let (a, b) = (item_at(&folder, "A.md"), item_at(&folder, "B.md"));
        assert_eq!(edges_of(&folder, &a, LINK_EDGE), [b], "{status}");
        let still = held(&folder, "A.md").unwrap();
        assert!(
            still.contains("[[C]] in its body matches no item") && !still.contains("[[B]]"),
            "{still}"
        );
    }
}

#[test]
fn a_lookup_of_one_name_a_server_has_no_route_for_is_a_refusal_of_the_call_not_of_the_name() {
    for (status, code) in [(404, "not_found"), (405, "method_not_allowed")] {
        let (dir, folder, server) = online_folder(refusal(status, code));
        std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
        let first = folder.scan().unwrap();
        let flagged = flags(&first);
        assert_eq!(flagged.len(), 1, "{status}: {first:?}");
        assert!(
            flagged[0]
                .2
                .contains("[[B]] in its body is looked up once the server can be asked")
                && !flagged[0].2.contains("could not be looked up"),
            "{status}: the name was refused, not left waiting: {first:?}"
        );
        assert!(
            first
                .lookup_refused
                .as_deref()
                .is_some_and(|why| why.contains("no title lookup")),
            "{status}: {first:?}"
        );
        assert_eq!(lookups(&server), 1, "{status}");
        assert!(!first.lookup_answered, "{status}: {first:?}");

        // The server now has the lookup, and the file is as it was.
        server.on("/items/titles", vec![nothing_found()]);
        let second = folder.scan().unwrap();
        assert_eq!(second.lookup_refused, None, "{status}: {second:?}");
        assert!(second.lookup_answered, "{status}: {second:?}");
        assert!(
            lookups(&server) > 1,
            "{status}: the name was not asked again"
        );
        assert!(
            held(&folder, "A.md")
                .is_some_and(|held| held.contains("[[B]] in its body matches no item")),
            "{status}: the name was not looked up again"
        );
    }
    // The witness: a refusal of one name that is no missing route is said of
    // that name, and is not the call's.
    let (dir, folder, _server) = online_folder(refusal(403, "forbidden"));
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    let first = folder.scan().unwrap();
    assert!(
        flags(&first)[0].2.contains("could not be looked up"),
        "{first:?}"
    );
    assert_eq!(first.lookup_refused, None, "{first:?}");
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

/// The write transactions `work` commits on the folder's store.
fn commits_during(folder: &Folder, work: impl FnOnce()) -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COMMITS: AtomicUsize = AtomicUsize::new(0);
    COMMITS.store(0, Ordering::SeqCst);
    let _ = folder.core.conn().unwrap().commit_hook(Some(|| {
        COMMITS.fetch_add(1, Ordering::SeqCst);
        false
    }));
    work();
    let _ = folder
        .core
        .conn()
        .unwrap()
        .commit_hook(None::<fn() -> bool>);
    COMMITS.load(Ordering::SeqCst)
}

#[test]
fn a_scan_queues_all_the_edges_of_a_file_in_one_transaction() {
    let (dir, folder, _server) = online_folder(nothing_found());
    let targets = ["B", "C", "D", "E", "F", "G"];
    for name in ["A", "H"].into_iter().chain(targets) {
        std::fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n")).unwrap();
    }
    assert_eq!(folder.scan().unwrap().created, 8);

    let linking = |note: &str, names: &[&str]| {
        let links: Vec<String> = names.iter().map(|name| format!("[[{name}]]")).collect();
        std::fs::write(dir.path().join(note), format!("{}\n", links.join(" "))).unwrap();
    };
    linking("H.md", &["B"]);
    let one = commits_during(&folder, || {
        let report = folder.scan().unwrap();
        assert!(report.flagged.is_empty(), "{report:?}");
    });
    linking("A.md", &targets);
    let six = commits_during(&folder, || {
        let report = folder.scan().unwrap();
        assert!(report.flagged.is_empty(), "{report:?}");
    });
    let a = item_at(&folder, "A.md");
    assert_eq!(
        edges_of(&folder, &a, LINK_EDGE).len(),
        targets.len(),
        "the witness: the six links were queued"
    );
    assert_eq!(
        six, one,
        "a file with six new links committed {six} transactions and one with a single link {one}"
    );
}
