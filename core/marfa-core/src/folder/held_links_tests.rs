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

fn about(folder: &Folder, path: &str) -> Vec<String> {
    let mut targets = edges_of(folder, &item_at(folder, path), "about");
    targets.sort();
    targets
}

/// The edge creates from `item` the copy waits to send.
fn edge_creates(folder: &Folder, item: &str) -> i64 {
    folder
        .core
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM queue WHERE kind = 'create_edge' AND item_id = ?1",
            [item],
            |row| row.get(0),
        )
        .unwrap()
}

fn answered(folder: &Folder) {
    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
}

const HELD_LINE: &str = "---\nabout:\n  - \"[[B]]\"\n  - \"[[Ghost]]\"\n---\nA\n";

#[test]
fn a_line_holding_a_name_that_matches_no_item_still_writes_the_edges_of_the_names_that_resolve() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    std::fs::write(dir.path().join("A.md"), HELD_LINE).unwrap();
    let first = folder.scan().unwrap();
    assert_eq!(first.created, 2, "{first:?}");
    let (a, b) = (item_at(&folder, "A.md"), item_at(&folder, "B.md"));
    assert_eq!(about(&folder, "A.md"), std::slice::from_ref(&b));
    let flagged = flags(&first);
    assert_eq!(flagged.len(), 1, "{first:?}");
    assert_eq!((flagged[0].0, flagged[0].1), ("A.md", "edges"), "{first:?}");
    assert!(
        flagged[0]
            .2
            .contains("[[Ghost]] in its about line matches no item")
            && !flagged[0].2.contains("[[B]]"),
        "{first:?}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("A.md")).unwrap(),
        HELD_LINE,
        "the line was not left as typed"
    );

    // The name that resolves is not written again while the other waits.
    let quiet = folder.scan().unwrap();
    assert_eq!(
        about(&folder, "A.md"),
        std::slice::from_ref(&b),
        "{quiet:?}"
    );
    assert!(held(&folder, "A.md").is_some());

    // The witness that the held name makes its edge once an item has it,
    // and that the edge already made is left as it is.
    answered(&folder);
    let edge = folder.core.edges_from(&a).unwrap().pop().unwrap();
    std::fs::write(dir.path().join("Ghost.md"), "Ghost\n").unwrap();
    let second = folder.scan().unwrap();
    assert_eq!(second.created, 1, "{second:?}");
    let ghost = item_at(&folder, "Ghost.md");
    let mut both = [b.clone(), ghost];
    both.sort();
    assert_eq!(about(&folder, "A.md"), both);
    assert_eq!(held(&folder, "A.md"), None);
    assert_eq!(
        edge_creates(&folder, &a),
        1,
        "the edge to B was written again, or the one to Ghost not at all"
    );
    assert!(
        folder
            .core
            .edges_from(&a)
            .unwrap()
            .iter()
            .any(|kept| kept.id == edge.id && kept.target_id == b),
        "the edge to B was replaced"
    );
}

#[test]
fn a_line_holding_a_name_two_items_have_writes_the_edges_of_the_names_that_resolve() {
    const ELSEWHERE: &str = "01a00000-0000-7000-8000-0000000023b1";
    let (dir, folder, _server) = online_folder(nothing_found());
    crate::store::put_server_item(
        &folder.core.conn().unwrap(),
        &crate::store::testing::note(ELSEWHERE, "Ghost", "", "2026-01-01T00:00:00Z"),
        None,
        &crate::catalog::Catalog::empty(),
    )
    .unwrap();
    std::fs::write(dir.path().join("Ghost.md"), "Ghost\n").unwrap();
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    std::fs::write(dir.path().join("A.md"), HELD_LINE).unwrap();
    let first = folder.scan().unwrap();
    assert_eq!(first.created, 3, "{first:?}");
    let b = item_at(&folder, "B.md");
    assert_eq!(about(&folder, "A.md"), std::slice::from_ref(&b));
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.contains("more than one item")),
        "{first:?}"
    );

    // Never guessed: still two, still only the edge to B.
    folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), std::slice::from_ref(&b));

    folder.core.delete_item(ELSEWHERE).unwrap();
    folder.scan().unwrap();
    let ghost = item_at(&folder, "Ghost.md");
    let mut both = [b, ghost];
    both.sort();
    assert_eq!(about(&folder, "A.md"), both);
    assert_eq!(held(&folder, "A.md"), None);
}

#[test]
fn a_line_holding_a_name_the_server_could_not_look_up_writes_no_edge_for_that_name() {
    let (dir, folder, _server) = online_folder(refusal(403, "forbidden"));
    std::fs::write(dir.path().join("A.md"), HELD_LINE).unwrap();
    let first = folder.scan().unwrap();
    let a = item_at(&folder, "A.md");
    assert_eq!(first.created, 1, "{first:?}");
    assert_eq!(about(&folder, "A.md"), Vec::<String>::new());
    assert!(held(&folder, "A.md").is_some());
    assert_eq!(edges_of(&folder, &a, "about"), Vec::<String>::new());
}

#[test]
fn a_name_taken_out_of_a_line_holding_another_takes_its_edge_out() {
    let (dir, folder, _server) = online_folder(nothing_found());
    for name in ["B", "C"] {
        std::fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n")).unwrap();
    }
    std::fs::write(
        dir.path().join("A.md"),
        "---\nabout:\n  - \"[[B]]\"\n  - \"[[C]]\"\n---\nA\n",
    )
    .unwrap();
    folder.scan().unwrap();
    let (b, c) = (item_at(&folder, "B.md"), item_at(&folder, "C.md"));
    let mut both = [b.clone(), c.clone()];
    both.sort();
    assert_eq!(about(&folder, "A.md"), both);
    assert_eq!(held(&folder, "A.md"), None);

    std::fs::write(dir.path().join("A.md"), HELD_LINE).unwrap();
    let edited = folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), [b], "{edited:?}");
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.contains("[[Ghost]]")),
        "{edited:?}"
    );
}

#[test]
fn a_name_that_no_longer_resolves_keeps_the_edge_it_made() {
    let (dir, folder, _server) = online_folder(nothing_found());
    for name in ["B", "C"] {
        std::fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n")).unwrap();
    }
    std::fs::write(
        dir.path().join("A.md"),
        "---\nabout:\n  - \"[[B]]\"\n  - \"[[C]]\"\n---\nA\n",
    )
    .unwrap();
    folder.scan().unwrap();
    let c = item_at(&folder, "C.md");
    let before = about(&folder, "A.md");
    assert_eq!(before.len(), 2);

    // C goes to the bin and its file is gone, so its name matches no item,
    // but the line still names it: the edge to it is not a name taken out.
    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM folder_files WHERE item_id = ?1", [&c])
        .unwrap();
    std::fs::remove_file(dir.path().join("C.md")).unwrap();
    folder.core.delete_item(&c).unwrap();
    let held_line = "---\nabout:\n  - \"[[B]]\"\n  - \"[[C]]\"\n  - \"[[Ghost]]\"\n---\nA\n";
    std::fs::write(dir.path().join("A.md"), held_line).unwrap();
    let report = folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), before, "{report:?}");
    assert!(held(&folder, "A.md").is_some());
}

#[test]
fn a_line_of_names_that_all_match_nothing_changes_no_edge() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    std::fs::write(dir.path().join("A.md"), "---\nabout: \"[[B]]\"\n---\nA\n").unwrap();
    folder.scan().unwrap();
    let b = item_at(&folder, "B.md");
    assert_eq!(about(&folder, "A.md"), std::slice::from_ref(&b));

    std::fs::write(
        dir.path().join("A.md"),
        "---\nabout:\n  - \"[[Ghost]]\"\n  - \"[[Wraith]]\"\n---\nA\n",
    )
    .unwrap();
    let report = folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), [b], "{report:?}");
    assert!(held(&folder, "A.md").is_some_and(|held| held.contains("matches no item")));
}

#[test]
fn a_line_with_room_for_one_item_holding_a_name_writes_no_part_of_itself() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    let typed = "---\nchild-of:\n  - \"[[B]]\"\n  - \"[[Ghost]]\"\n---\nA\n";
    std::fs::write(dir.path().join("A.md"), typed).unwrap();
    let first = folder.scan().unwrap();
    let a = item_at(&folder, "A.md");
    assert_eq!(first.created, 2, "{first:?}");
    assert_eq!(
        folder.core.edges_to(&a).unwrap().len(),
        0,
        "a child was given a parent while its line held another name: {first:?}"
    );
    assert!(held(&folder, "A.md").is_some_and(|held| held.contains("[[Ghost]]")));

    // The witness: the line, once it names one item, makes its edge.
    std::fs::write(
        dir.path().join("A.md"),
        "---\nchild-of: \"[[B]]\"\n---\nA\n",
    )
    .unwrap();
    folder.scan().unwrap();
    assert_eq!(folder.core.edges_to(&a).unwrap().len(), 1);
}

const OLD: &str = "01a00000-0000-7000-8000-0000000023c1";

fn from_elsewhere(folder: &Folder, id: &str, title: &str) {
    crate::store::put_server_item(
        &folder.core.conn().unwrap(),
        &crate::store::testing::note(id, title, "", "2026-01-01T00:00:00Z"),
        None,
        &crate::catalog::Catalog::empty(),
    )
    .unwrap();
}

#[test]
fn a_held_line_keeps_the_edge_of_a_name_whose_item_is_retitled_elsewhere() {
    let (dir, folder, _server) = online_folder(nothing_found());
    from_elsewhere(&folder, OLD, "Old");
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    let typed = "---\nabout:\n  - \"[[B]]\"\n  - \"[[Old]]\"\n  - \"[[Ghost]]\"\n---\nA\n";
    std::fs::write(dir.path().join("A.md"), typed).unwrap();
    folder.scan().unwrap();
    let mut both = [item_at(&folder, "B.md"), OLD.to_string()];
    both.sort();
    assert_eq!(about(&folder, "A.md"), both);
    assert!(held(&folder, "A.md").is_some());

    // Retitled on another device: no item is called Old now, but the file,
    // unchanged, still names the item its edge was made for.
    from_elsewhere(&folder, OLD, "New");
    let again = folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), both, "{again:?}");

    // The witness: the person taking the name out takes its edge out.
    std::fs::write(
        dir.path().join("A.md"),
        "---\nabout:\n  - \"[[B]]\"\n  - \"[[Ghost]]\"\n---\nA\n",
    )
    .unwrap();
    let edited = folder.scan().unwrap();
    assert_eq!(
        about(&folder, "A.md"),
        [item_at(&folder, "B.md")],
        "{edited:?}"
    );
}

#[test]
fn a_held_line_never_makes_again_an_edge_deleted_elsewhere() {
    let (dir, folder, _server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("B.md"), "B\n").unwrap();
    std::fs::write(dir.path().join("A.md"), HELD_LINE).unwrap();
    folder.scan().unwrap();
    let (a, b) = (item_at(&folder, "A.md"), item_at(&folder, "B.md"));
    assert_eq!(about(&folder, "A.md"), std::slice::from_ref(&b));
    answered(&folder);
    let edge = folder.core.edges_from(&a).unwrap().pop().unwrap();
    crate::store::delete_edge(&folder.core.conn().unwrap(), &edge.id).unwrap();
    from_elsewhere(&folder, OLD, "Unrelated");

    let again = folder.scan().unwrap();
    assert_eq!(about(&folder, "A.md"), Vec::<String>::new(), "{again:?}");
    assert_eq!(edge_creates(&folder, &a), 0, "{again:?}");

    // The held name resolving makes its own edge, and only that one.
    std::fs::write(dir.path().join("Ghost.md"), "Ghost\n").unwrap();
    let resolved = folder.scan().unwrap();
    assert_eq!(
        about(&folder, "A.md"),
        [item_at(&folder, "Ghost.md")],
        "{resolved:?}"
    );
    assert_eq!(edge_creates(&folder, &a), 1, "{resolved:?}");
}

#[test]
fn a_body_link_moved_into_a_held_line_is_taken_out_with_its_name() {
    let (dir, folder, _server) = online_folder(nothing_found());
    for name in ["B", "C"] {
        std::fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n")).unwrap();
    }
    std::fs::write(dir.path().join("A.md"), "See [[B]].\n").unwrap();
    folder.scan().unwrap();
    let (a, b, c) = (
        item_at(&folder, "A.md"),
        item_at(&folder, "B.md"),
        item_at(&folder, "C.md"),
    );
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), std::slice::from_ref(&b));

    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM folder_files WHERE item_id = ?1", [&b])
        .unwrap();
    std::fs::remove_file(dir.path().join("B.md")).unwrap();
    folder.core.delete_item(&b).unwrap();
    std::fs::write(
        dir.path().join("A.md"),
        "---\nreferences:\n  - \"[[B]]\"\n  - \"[[C]]\"\n---\nA\n",
    )
    .unwrap();
    let moved = folder.scan().unwrap();
    let mut both = [b.clone(), c.clone()];
    both.sort();
    let mut now = edges_of(&folder, &a, LINK_EDGE);
    now.sort();
    assert_eq!(now, both, "{moved:?}");

    std::fs::write(
        dir.path().join("A.md"),
        "---\nreferences:\n  - \"[[C]]\"\n---\nA\n",
    )
    .unwrap();
    let taken = folder.scan().unwrap();
    assert_eq!(edges_of(&folder, &a, LINK_EDGE), [c], "{taken:?}");
}
