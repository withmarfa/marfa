//! The reads of many rows in one call answer what the reads of one row
//! answer, and `changes_since` names what changed since a cursor.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;

use crate::hydrate_refill_tests::{aged_out, head, hydrate, pinned_row, refill_pages, replay};
use crate::scripted::{self, Scripted, Then, event, item_payload};
use crate::stop_tests::{copy, holding_a_catalog};
use crate::{Completeness, CopyChanges, Core, CoreError, store};

const NOTE: &str = "core.note";

fn note(core: &Core, id: &str, title: &str, body: &str) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    let row = store::testing::wire_item(
        id,
        NOTE,
        "active",
        "2026-01-01T00:00:00Z",
        json!({ "title": title, "body": body }),
    );
    crate::reach::set_listed(&conn, id, true).unwrap();
    store::put_server_item(&conn, &row, Some(&["kept".into()]), &catalog).unwrap();
}

fn edge(core: &Core, id: &str, source: &str, target: &str, edge_type: &str) {
    let conn = core.conn().unwrap();
    store::put_server_edge(
        &conn,
        &store::testing::wire_edge(id, source, target, edge_type),
    )
    .unwrap();
}

fn damage(core: &Core, id: &str) {
    core.conn()
        .unwrap()
        .execute(
            "UPDATE items SET properties = 'not json' WHERE id = ?1",
            [id],
        )
        .unwrap();
}

fn hydrating(core: &Core) {
    store::meta_set(
        &core.conn().unwrap(),
        store::META_HYDRATE_STATE,
        store::HYDRATE_IN_PROGRESS,
    )
    .unwrap();
}

fn ids(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

/// A whole copy of the notes `a`, `b` and `c`, with `ab` from `a` to `b` and
/// `ba` back.
fn notes(server: &Scripted) -> Arc<Core> {
    let core = copy(server);
    holding_a_catalog(&core);
    note(&core, "a", "A", "about [[B]]");
    note(&core, "b", "B", "about [[A]]");
    note(&core, "c", "C", "");
    edge(&core, "ab", "a", "b", "references");
    edge(&core, "ba", "b", "a", "references");
    core
}

fn item_ids(rows: &[(crate::Item, crate::Shown)]) -> Vec<&str> {
    rows.iter().map(|(item, _)| item.id.as_str()).collect()
}

#[test]
fn get_items_answers_each_held_row_once_in_the_order_named_and_the_bin_only_when_asked() {
    let server = Scripted::start();
    let core = notes(&server);
    core.delete_item("c").unwrap();
    let named = ids(&["c", "b", "never-held", "a", "b"]);

    let outside = core.get_items_shown(&named, false).unwrap();
    assert_eq!(item_ids(&outside.rows), ["b", "a"]);
    assert_eq!(outside.completeness, Completeness::Complete);
    for (item, shown) in &outside.rows {
        assert_eq!(
            core.get_shown(&item.id).unwrap(),
            Some((item.clone(), shown.clone()))
        );
    }
    let with_bin = core.get_items_shown(&named, true).unwrap();
    assert_eq!(item_ids(&with_bin.rows), ["c", "b", "a"]);
    assert_eq!(with_bin.rows[0].0.state, crate::ItemState::Trashed);
    assert_eq!(
        core.get_shown("c").unwrap(),
        None,
        "a read of one row answers the bin, so leaving it out proves nothing"
    );
}

#[test]
fn get_items_part_way_through_a_hydration_answers_what_has_arrived_marked_partial() {
    let server = Scripted::start();
    let core = notes(&server);
    hydrating(&core);

    let answer = core.get_items_kept(&ids(&["a", "not-yet"]), false).unwrap();

    assert_eq!(item_ids(&answer.rows), ["a"]);
    assert_eq!(answer.completeness, Completeness::Partial);
    assert!(
        matches!(core.get("not-yet"), Err(CoreError::HydrationIncomplete)),
        "a read of the one row would refuse it"
    );
}

#[test]
fn get_items_kept_keeps_a_row_it_cannot_read_where_shown_refuses_it() {
    let server = Scripted::start();
    let core = notes(&server);
    damage(&core, "b");

    let kept = core.get_items_kept(&ids(&["a", "b"]), false).unwrap();
    assert_eq!(item_ids(&kept.rows), ["a", "b"]);
    assert!(kept.rows[1].0.properties.is_empty());
    assert!(kept.rows[1].1.unreadable_properties.is_some());
    assert_eq!(
        Some(kept.rows[1].clone()),
        core.get_kept("b").unwrap(),
        "the batch answered the row otherwise than a read of it"
    );
    let refused = core.get_items_shown(&ids(&["a", "b"]), false).unwrap_err();
    assert!(store::unreadable(&refused), "{refused:?}");
}

#[test]
fn get_edges_answers_each_held_edge_once_and_where_it_was_moved() {
    let server = Scripted::start();
    let core = notes(&server);
    let named = ids(&["ba", "gone", "ab", "ba"]);

    let held: Vec<String> = core
        .get_edges(&named)
        .unwrap()
        .into_iter()
        .map(|edge| edge.id)
        .collect();
    assert_eq!(held, ["ba", "ab"]);
    let mut moved = store::testing::wire_edge("ab", "a", "c", "references");
    moved.version = 2;
    store::put_server_edge(&core.conn().unwrap(), &moved).unwrap();
    let answered = core.get_edges(&ids(&["ab"])).unwrap();
    assert_eq!(
        (answered[0].target_id.as_str(), answered[0].version),
        ("c", 2)
    );
    let kept = core.get_edges_kept(&ids(&["ab"])).unwrap();
    assert_eq!(kept, [(answered[0].clone(), None)]);
}

#[test]
fn get_edge_answers_one_edge_and_keeps_one_it_cannot_read_only_when_kept() {
    let server = Scripted::start();
    let core = notes(&server);
    assert_eq!(core.get_edge("ab").unwrap().unwrap().target_id, "b");
    assert_eq!(core.get_edge("gone").unwrap(), None);
    assert_eq!(core.get_edge_kept("gone").unwrap(), None);
    core.conn()
        .unwrap()
        .execute(
            "UPDATE edges SET properties = 'not json' WHERE id = 'ab'",
            [],
        )
        .unwrap();

    assert!(core.get_edge("ab").is_err());
    assert!(core.get_edges(&ids(&["ab"])).is_err());
    let (kept, why) = core.get_edge_kept("ab").unwrap().unwrap();
    assert_eq!((kept.id.as_str(), why.is_some()), ("ab", true));
    let batch = core.get_edges_kept(&ids(&["ba", "ab"])).unwrap();
    assert_eq!(
        batch
            .iter()
            .map(|(edge, why)| (edge.id.as_str(), why.is_some()))
            .collect::<Vec<_>>(),
        [("ba", false), ("ab", true)]
    );
}

#[test]
fn get_edges_is_refused_part_way_through_a_hydration_as_every_read_of_edges_is() {
    let server = Scripted::start();
    let core = notes(&server);
    assert_eq!(core.get_edges(&ids(&["ab"])).unwrap().len(), 1);
    hydrating(&core);

    assert!(matches!(
        core.get_edges(&ids(&["ab"])),
        Err(CoreError::HydrationIncomplete)
    ));
    assert!(matches!(
        core.get_edge("ab"),
        Err(CoreError::HydrationIncomplete)
    ));
    assert!(matches!(
        core.body_links_of(&ids(&["a"])),
        Err(CoreError::HydrationIncomplete)
    ));
}

#[test]
fn body_links_of_answers_what_body_links_answers_for_each_item_it_can_read() {
    let server = Scripted::start();
    let core = notes(&server);
    note(&core, "photo", "photo.png", "");
    note(
        &core,
        "host",
        "Host",
        "See [[A]], [[Nowhere]] and [[a]] again, then ![[photo.png]] and ![[missing.pdf]].",
    );
    edge(&core, "host-a", "host", "a", "references");
    note(&core, "binned", "Binned", "about [[A]]");
    core.delete_item("binned").unwrap();
    note(&core, "damaged", "Damaged", "about [[A]]");
    damage(&core, "damaged");
    let named = ids(&["host", "a", "b", "c", "binned", "damaged", "never-held"]);

    let answer = core.body_links_of(&named).unwrap();

    let mut answered: Vec<&str> = answer.keys().map(String::as_str).collect();
    answered.sort();
    assert_eq!(answered, ["a", "b", "c", "host"]);
    for (id, links) in &answer {
        assert_eq!(links, &core.body_links(id).unwrap(), "{id}");
    }
    assert!(answer["host"].links.len() == 3 && answer["host"].embeds.len() == 2);
    assert!(
        core.body_links("binned").is_err() && core.body_links("damaged").is_err(),
        "a read of one would refuse what the batch leaves out"
    );
}

/// The events of a catch-up after cursor 10, ending live at `last`.
fn caught_up(server: &Scripted, core: &Core, events: Vec<String>, last: &str) {
    let mut frames = vec![scripted::copy_marker("stream_cursor", "10")];
    frames.extend(events);
    frames.push(scripted::copy_marker("stream_live", last));
    server.on("/events", vec![scripted::stream(frames, Then::End)]);
    core.catch_up().unwrap();
}

fn edge_event(kind: &str, id: &str, source: &str, target: &str, version: i64) -> String {
    json!({
        "event_type": kind,
        "edge": {
            "id": id, "source_id": source, "target_id": target, "edge_type": "references",
            "properties": {}, "version": version,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": format!("2026-01-0{version}T00:00:00Z"),
        },
    })
    .to_string()
}

fn listed_event(kind: &str, id: &str, version: i64) -> String {
    let mut payload: serde_json::Value =
        serde_json::from_str(&item_payload(kind, id, NOTE, version)).unwrap();
    payload["listed"] = json!(true);
    payload.to_string()
}

fn none() -> CopyChanges {
    CopyChanges {
        cursor: String::new(),
        everything: false,
        items: Vec::new(),
        removed_items: Vec::new(),
        edges: Vec::new(),
        removed_edges: Vec::new(),
    }
}

fn without_cursor(changes: CopyChanges) -> CopyChanges {
    CopyChanges {
        cursor: String::new(),
        ..changes
    }
}

#[test]
fn changes_since_names_the_rows_and_edges_changed_moved_and_purged() {
    let server = Scripted::start();
    let core = notes(&server);
    // The first catch-up holds the server's catalog in place of the one the
    // copy was made with, which is a change to every row.
    caught_up(&server, &core, Vec::new(), "10");
    let first = core.changes_since(None, 100).unwrap();
    assert!(first.everything);
    let quiet = core.changes_since(Some(&first.cursor), 100).unwrap();
    assert_eq!(without_cursor(quiet.clone()), none());

    caught_up(
        &server,
        &core,
        vec![
            event("11", "item.updated", &listed_event("item.updated", "c", 2)),
            event(
                "12",
                "edge.updated",
                &edge_event("edge.updated", "ab", "a", "c", 2),
            ),
            event("13", "item.purged", &listed_event("item.purged", "b", 2)),
        ],
        "13",
    );
    let changes = core.changes_since(Some(&quiet.cursor), 100).unwrap();

    assert_eq!(
        without_cursor(changes.clone()),
        CopyChanges {
            items: ids(&["a", "c"]),
            removed_items: ids(&["b"]),
            edges: ids(&["ab"]),
            removed_edges: ids(&["ba"]),
            ..none()
        }
    );
    let after = core.changes_since(Some(&changes.cursor), 100).unwrap();
    assert_eq!(without_cursor(after), none());
}

#[test]
fn changes_since_names_a_row_written_and_binned_on_the_device() {
    let server = Scripted::start();
    let core = notes(&server);
    let since = core.changes_since(None, 100).unwrap().cursor;

    core.delete_item("a").unwrap();
    let changes = core.changes_since(Some(&since), 100).unwrap();

    assert_eq!(
        without_cursor(changes),
        CopyChanges {
            items: ids(&["a"]),
            ..none()
        },
        "a row in the bin is held, so it is named changed, not removed"
    );
}

#[test]
fn changes_since_names_what_a_refill_changed_and_took_out() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let since = core.changes_since(None, 100).unwrap().cursor;
    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);

    assert!(hydrate(&core).unwrap().in_place);
    let changes = core.changes_since(Some(&since), 100).unwrap();

    // The refill writes again each row and edge it brings, so the rows it
    // left as they were are named too.
    assert_eq!(
        without_cursor(changes),
        CopyChanges {
            items: ids(&["added", "changed", "kept", "pinned"]),
            removed_items: ids(&["gone"]),
            edges: ids(&["stays"]),
            removed_edges: ids(&["dropped"]),
            ..none()
        }
    );
}

#[test]
fn changes_since_answers_everything_for_a_cursor_it_cannot_follow_one_by_one() {
    let server = Scripted::start();
    let core = notes(&server);
    let since = core.changes_since(None, 100).unwrap().cursor;
    let other = Core::open_in_memory(None).unwrap();
    let elsewhere = other.changes_since(None, 100).unwrap().cursor;

    assert!(
        core.changes_since(Some(&elsewhere), 100)
            .unwrap()
            .everything
    );
    let (store_id, _) = since.split_once('.').unwrap();
    let ahead = format!("{store_id}.999.0");
    assert!(core.changes_since(Some(&ahead), 100).unwrap().everything);
    for malformed in ["", "x", "x.1", "x.1.2.3", "x.-1.0", ".1.0", "x.one.0"] {
        assert!(
            matches!(
                core.changes_since(Some(malformed), 100),
                Err(CoreError::Invalid(_))
            ),
            "{malformed:?}"
        );
    }

    note(&core, "d", "D", "");
    note(&core, "e", "E", "");
    note(&core, "f", "F", "");
    assert!(core.changes_since(Some(&since), 2).unwrap().everything);
    let named = core.changes_since(Some(&since), 3).unwrap();
    assert_eq!(named.items, ids(&["d", "e", "f"]));

    store::replace_types(
        &core.conn().unwrap(),
        &[
            store::testing::wire_type(NOTE, None, Some("title")),
            store::testing::wire_type("app.other", None, Some("title")),
        ],
    )
    .unwrap();
    assert!(
        core.changes_since(Some(&named.cursor), 100)
            .unwrap()
            .everything,
        "a change to the types changes how every row is shown"
    );
}

#[test]
fn declaring_the_same_types_again_is_no_change() {
    let core = Core::open_in_memory(None).unwrap();
    let types = [json!({"id": "app.acme.task", "fields": {"title": {"type": "string"}}})];
    core.declare_types(&types).unwrap();
    let since = core.changes_since(None, 100).unwrap().cursor;

    core.declare_types(&types).unwrap();
    let again = core.changes_since(Some(&since), 100).unwrap();
    assert!(!again.everything, "{again:?}");

    core.declare_types(&[json!({"id": "app.acme.task", "fields": {}})])
        .unwrap();
    assert!(
        core.changes_since(Some(&again.cursor), 100)
            .unwrap()
            .everything,
        "another set is a change, so the same set's silence proves something"
    );
}

#[test]
fn a_cursor_outlasts_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = Core::open(&path, None).unwrap();
    let since = core.changes_since(None, 100).unwrap().cursor;
    drop(core);

    let reopened = Core::open(&path, None).unwrap();
    let changes = reopened.changes_since(Some(&since), 100).unwrap();
    assert_eq!(without_cursor(changes.clone()), none());
    assert_eq!(changes.cursor, since);
    let elsewhere = Core::open(dir.path().join("other.sqlite"), None).unwrap();
    assert!(
        elsewhere
            .changes_since(Some(&since), 100)
            .unwrap()
            .everything
    );
}

#[test]
fn the_batch_reads_answer_nothing_for_no_ids() {
    let server = Scripted::start();
    let core = notes(&server);
    let answer: HashMap<String, crate::BodyLinks> = core.body_links_of(&[]).unwrap();
    assert!(answer.is_empty());
    assert!(core.get_items_shown(&[], true).unwrap().rows.is_empty());
    assert!(core.get_edges(&[]).unwrap().is_empty());
}
