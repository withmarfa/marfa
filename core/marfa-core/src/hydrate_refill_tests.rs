//! A copy whose cursor the event log let go answers what it holds marked
//! stale and queues writes, and the next hydration under the same instance,
//! reach and slice fills it again over those rows, taking out only what the
//! walk and the replay did not bring once both are done.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted, Then};
use crate::stop_tests::copy;
use crate::{Completeness, Core, CoreError, Edit, HydrateReport, SliceTier, store};

const TOO_OLD: &str = "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\",\"requested\":\"10\"}\n\n";

/// A note at `version`, with the edges named as `(id, target)` inline.
fn row(id: &str, version: i64, edges: &[(&str, &str)]) -> Value {
    let payload: Value = serde_json::from_str(&scripted::item_payload(
        "item.updated",
        id,
        "core.note",
        version,
    ))
    .unwrap();
    let mut item = payload["item"].clone();
    if !edges.is_empty() {
        let data: Vec<Value> = edges
            .iter()
            .map(|(edge, target)| edge_of(edge, id, target))
            .collect();
        item["edges"] = json!({"core.related": {"data": data, "next_cursor": null}});
    }
    json!({"item": item, "metadata": payload["metadata"], "listed": true})
}

fn edge_of(id: &str, source: &str, target: &str) -> Value {
    json!({
        "id": id, "source_id": source, "target_id": target, "edge_type": "core.related",
        "properties": {}, "version": 1,
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
    })
}

fn page(rows: Vec<Value>, next: Option<&str>) -> Answer {
    page_under(rows, next, scripted::FENCE)
}

fn page_under(rows: Vec<Value>, next: Option<&str>, fence: &str) -> Answer {
    let body = json!({"data": rows, "next_cursor": next});
    scripted::certified_under(scripted::json(200, &body.to_string()), fence)
}

fn no_pins() -> Answer {
    let body = json!({"items": [], "metadata": [], "listed": []});
    scripted::certified(scripted::json(200, &body.to_string()))
}

fn head(cursor: &str) -> Answer {
    head_under(cursor, scripted::FENCE)
}

fn head_under(cursor: &str, fence: &str) -> Answer {
    scripted::stream(
        vec![scripted::copy_marker_under("stream_cursor", cursor, fence)],
        Then::End,
    )
}

fn replay(events: Vec<String>, live: &str) -> Answer {
    let mut frames = vec![scripted::copy_marker("stream_cursor", live)];
    frames.extend(events);
    frames.push(scripted::copy_marker("stream_live", live));
    scripted::stream(frames, Then::End)
}

fn hydrate(core: &Core) -> crate::Result<HydrateReport> {
    core.hydrate_until(
        &["core.note".into()],
        SliceTier::Library,
        &[],
        &AtomicBool::new(false),
    )
}

fn listed(core: &Core) -> crate::Result<(Completeness, Vec<(String, i64)>)> {
    let rows = core.list(&crate::ListFilters::default(), crate::Sort::default())?;
    let mut held: Vec<(String, i64)> = rows
        .rows
        .into_iter()
        .map(|item| (item.id, item.version))
        .collect();
    held.sort();
    Ok((rows.completeness, held))
}

fn ids(held: &[(String, i64)]) -> Vec<&str> {
    held.iter().map(|(id, _)| id.as_str()).collect()
}

fn edge_held(core: &Core, id: &str) -> bool {
    store::edge_by_id(&core.conn().unwrap(), id)
        .unwrap()
        .is_some()
}

fn put(core: &Core, rows: &[Value]) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    for row in rows {
        let item: crate::wire::WireItem = serde_json::from_value(row["item"].clone()).unwrap();
        crate::reach::set_listed(&conn, &item.id, true).unwrap();
        store::put_server_item(&conn, &item, Some(&[]), &catalog).unwrap();
        for block in item.edges.iter().flat_map(|blocks| blocks.values()) {
            for edge in &block.data {
                store::put_server_edge(&conn, edge).unwrap();
            }
        }
    }
}

/// A whole copy of `kept`, `changed`, `gone` and `pinned`, each at version 1,
/// with the edges `stays` from `kept` and `dropped` from `changed`, whose
/// catch-up then found the log aged past its cursor.
fn aged_out(server: &Scripted) -> Arc<Core> {
    aged_out_on(server, copy(server))
}

/// `aged_out` for `core`, a copy `scripted_copy` made.
fn aged_out_on(server: &Scripted, core: Arc<Core>) -> Arc<Core> {
    aged_out_after(server, core, |_| {})
}

/// `aged_out_on`, with `before` done to the whole copy before its cursor ages
/// out.
fn aged_out_after(server: &Scripted, core: Arc<Core>, before: impl FnOnce(&Core)) -> Arc<Core> {
    crate::stop_tests::holding_a_catalog(&core);
    put(
        &core,
        &[
            row("kept", 1, &[("stays", "changed")]),
            row("changed", 1, &[("dropped", "kept")]),
            row("gone", 1, &[]),
            row("pinned", 1, &[]),
        ],
    );
    store::pin(&core.conn().unwrap(), "pinned").unwrap();
    before(&core);
    server.on(
        "/events",
        vec![scripted::stream(
            vec![scripted::copy_marker("stream_cursor", "60"), TOO_OLD.into()],
            Then::End,
        )],
    );
    assert!(matches!(
        core.catch_up(),
        Err(CoreError::CopyExpired { .. })
    ));
    assert_eq!(core.status().unwrap().hydration, crate::Hydration::Stale);
    core
}

/// The pages a refill reads: `kept` as it was, `changed` at version 2 without
/// the edge it had, and `added`; the pinned row read by id.
fn refill_pages() -> Vec<Answer> {
    vec![
        page(
            vec![
                row("kept", 1, &[("stays", "changed")]),
                row("changed", 2, &[]),
            ],
            Some("2"),
        ),
        page(vec![row("added", 1, &[])], None),
    ]
}

fn pinned_row() -> Answer {
    let rows = [row("pinned", 1, &[])];
    let body = json!({
        "items": rows.iter().map(|row| row["item"].clone()).collect::<Vec<_>>(),
        "metadata": [{"item_id": "pinned", "tags": [], "extensions": {}}],
        "listed": [true],
    });
    scripted::certified(scripted::json(200, &body.to_string()))
}

#[test]
fn a_copy_whose_cursor_aged_out_answers_what_it_holds_marked_stale() {
    let server = Scripted::start();
    let core = aged_out(&server);

    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Stale);
    assert_eq!(ids(&held), ["changed", "gone", "kept", "pinned"]);
    let found = core
        .search("gone", &crate::SearchFilters::default(), 10)
        .unwrap();
    assert_eq!(found.completeness, Completeness::Stale);
    assert_eq!(found.rows.len(), 1);
    assert_eq!(core.get("gone").unwrap().unwrap().version, 1);
    assert_eq!(
        core.get("never-held").unwrap(),
        None,
        "a stale copy answers what it holds"
    );
}

#[test]
fn a_refill_in_place_changes_adds_and_takes_out_rows_and_edges_once_done() {
    let server = Scripted::start();
    let core = aged_out(&server);
    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);

    let report = hydrate(&core).unwrap();

    assert!(report.in_place);
    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Complete);
    assert_eq!(
        held,
        [
            ("added".to_string(), 1),
            ("changed".to_string(), 2),
            ("kept".to_string(), 1),
            ("pinned".to_string(), 1),
        ]
    );
    assert!(edge_held(&core, "stays"));
    assert!(
        !edge_held(&core, "dropped"),
        "an edge the walk left out stayed"
    );
    let conn = core.conn().unwrap();
    assert_eq!(store::meta_get(&conn, store::META_REFILL).unwrap(), None);
    let marks: i64 = conn
        .query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'edge_brought/%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marks, 0);
}

#[test]
fn a_refill_interrupted_half_way_stays_stale_and_in_place_and_sweeps_nothing_early() {
    let server = Scripted::start();
    let core = aged_out(&server);
    server.on(
        "/items",
        vec![
            page(
                vec![
                    row("kept", 1, &[("stays", "changed")]),
                    row("changed", 2, &[]),
                ],
                Some("2"),
            ),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("60")]);
    assert!(matches!(hydrate(&core), Err(CoreError::Server { .. })));

    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Stale);
    assert_eq!(
        held,
        [
            ("changed".to_string(), 2),
            ("gone".to_string(), 1),
            ("kept".to_string(), 1),
            ("pinned".to_string(), 1),
        ],
        "the page taken changed rows in place, and a row the walk had not reached went"
    );
    assert!(edge_held(&core, "dropped"));

    server.on("/items", vec![page(vec![row("added", 1, &[])], None)]);
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on(
        "/events",
        vec![head("60"), replay(vec![], "60"), replay(vec![], "60")],
    );
    let report = hydrate(&core).unwrap();

    assert!(report.resumed, "{report:?}");
    assert!(report.in_place);
    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Complete);
    assert_eq!(ids(&held), ["added", "changed", "kept", "pinned"]);
    assert!(!edge_held(&core, "dropped"));
}

#[test]
fn a_refill_on_disk_carries_on_in_place_after_the_process_ends_part_way() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    {
        let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
        crate::stop_tests::holding_a_catalog(&core);
        put(&core, &[row("kept", 1, &[]), row("gone", 1, &[])]);
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "60"), TOO_OLD.into()],
                    Then::End,
                ),
                head("60"),
            ],
        );
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::CopyExpired { .. })
        ));
        server.on(
            "/items",
            vec![
                page(vec![row("kept", 2, &[])], Some("2")),
                scripted::refusal(503, "unavailable"),
            ],
        );
        assert!(hydrate(&core).is_err());
    }
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(crate::Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Stale);
    assert_eq!(
        held,
        [("gone".to_string(), 1), ("kept".to_string(), 2)],
        "a copy opened again part way through its refill lost a row or a change"
    );

    server.on("/items", vec![page(vec![row("added", 1, &[])], None)]);
    server.on(
        "/events",
        vec![head("60"), replay(vec![], "60"), replay(vec![], "60")],
    );
    let report = hydrate(&core).unwrap();
    assert!(report.resumed && report.in_place, "{report:?}");
    assert_eq!(ids(&listed(&core).unwrap().1), ["added", "kept"]);
}

#[test]
fn a_refill_keeps_a_pinned_row_and_a_row_a_waiting_write_names_that_the_walk_left_out() {
    let server = Scripted::start();
    let core = aged_out(&server);
    core.add_tag("gone", "mine").unwrap();
    server.on("/items", vec![page(vec![row("kept", 1, &[])], None)]);
    // The server leaves the pin out of its answer as it does for a row gone.
    server.on("/items/bulk-get", vec![no_pins()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);

    hydrate(&core).unwrap();

    let (_, held) = listed(&core).unwrap();
    assert_eq!(ids(&held), ["gone", "kept", "pinned"]);
    assert_eq!(core.get("gone").unwrap().unwrap().tags, ["mine"]);
    assert!(
        !held.iter().any(|(id, _)| id == "changed"),
        "the witness: a row neither pinned nor written to that the walk left out stayed"
    );
}

#[test]
fn a_refill_under_another_reach_clears_the_copy_first() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    server.on(
        "/types",
        vec![scripted::certified_under(
            scripted::types(&[("core.note", None)]),
            other,
        )],
    );
    server.on(
        "/edge-types",
        vec![scripted::certified_under(scripted::edge_types(&[]), other)],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified_under(
            scripted::json(200, r#"{"type_permissions":{"core.note":"read"}}"#),
            other,
        )],
    );
    server.on(
        "/items",
        vec![
            page_under(vec![row("kept", 1, &[])], Some("2"), other),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head_under("60", other)]);

    assert!(hydrate(&core).is_err());

    let (completeness, held) = listed(&core).unwrap();
    assert_eq!(completeness, Completeness::Partial);
    assert_eq!(
        ids(&held),
        ["kept"],
        "a row read under the old reach stayed"
    );
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_REFILL).unwrap(),
        None
    );
}

#[test]
fn a_copy_expired_for_another_reason_refuses_reads_and_writes() {
    let server = Scripted::start();
    let core = aged_out(&server);
    assert!(
        listed(&core).is_ok(),
        "the witness: an aged-out copy answers"
    );
    {
        let conn = core.conn().unwrap();
        crate::reach::expire(&conn).unwrap();
    }
    assert_eq!(listed(&core), Err(CoreError::HydrationIncomplete));
    assert_eq!(
        core.add_tag("kept", "mine"),
        Err(CoreError::HydrationIncomplete)
    );
}

#[test]
fn a_write_while_the_copy_is_stale_is_queued_on_the_held_version_and_sent_after_the_refill() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let mut edit = Edit {
        base_version: Some(1),
        ..Default::default()
    };
    edit.properties.insert("title".into(), json!("mine"));
    let queued = core.update_item("changed", &edit).unwrap();
    assert_eq!(queued.base_version, Some(1));
    let created = core.create_item(&crate::stop_tests::note(None)).unwrap();
    core.delete_item("gone").unwrap();
    assert_eq!(
        core.add_tag("never-held", "mine"),
        Err(CoreError::HydrationIncomplete),
        "a row a stale copy does not hold may be one the server has"
    );
    let asked = server.asked();
    assert!(core.drain().is_err());
    assert_eq!(
        server.asked(),
        asked,
        "a drain of a stale copy sent a write"
    );
    assert_eq!(core.queue().unwrap().len(), 3);

    // The walk brings `changed` at version 2 beneath the waiting update.
    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);
    hydrate(&core).unwrap();

    let held = core.get("changed").unwrap().unwrap();
    assert_eq!(held.version, 2);
    assert_eq!(
        held.properties["title"],
        json!("mine"),
        "the waiting write was not laid over the newer row"
    );
    let waiting = core.queue().unwrap();
    assert_eq!(waiting.len(), 3);
    let update = waiting.iter().find(|row| row.id == queued.id).unwrap();
    assert_eq!(
        update.base_version,
        Some(1),
        "the version the write was made against moved, so the server cannot judge it"
    );
    assert!(
        core.get(created.item_id.as_deref().unwrap())
            .unwrap()
            .is_some()
    );
    assert!(
        store::item_held(&core.conn().unwrap(), "gone").unwrap(),
        "a row a waiting delete names was taken out before the delete was sent"
    );
}

/// A copy never hydrated whose first fill took one page holding `held` and
/// failed asking for the next.
fn first_fill_interrupted(server: &Scripted) -> Arc<Core> {
    let core = Core::open_in_memory(Some(crate::Server {
        url: server.url(),
        key: "k".into(),
    }))
    .unwrap();
    first_fill_interrupted_on(server, core, &[("core.note", None)])
}

/// `first_fill_interrupted` for `core`, under a catalog of `types`.
fn first_fill_interrupted_on(
    server: &Scripted,
    core: Core,
    types: &[(&str, Option<&str>)],
) -> Arc<Core> {
    let core = Arc::new(core);
    server.on("/types", vec![scripted::certified(scripted::types(types))]);
    server.on(
        "/edge-types",
        vec![scripted::certified(scripted::edge_types(&[]))],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read"}}"#,
        ))],
    );
    server.on(
        "/items",
        vec![
            page(vec![row("held", 1, &[])], Some("2")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("10")]);
    assert!(hydrate(&core).is_err());
    assert_eq!(listed(&core).unwrap().0, Completeness::Partial);
    core
}

#[test]
fn a_write_during_a_first_fill_is_taken_for_a_held_row_or_a_new_one_and_refused_for_another() {
    let server = Scripted::start();
    let core = first_fill_interrupted(&server);
    let mut edit = Edit {
        base_version: Some(1),
        ..Default::default()
    };
    edit.properties.insert("title".into(), json!("mine"));

    let updated = core.update_item("held", &edit).unwrap();
    assert_eq!(updated.base_version, Some(1));
    core.create_item(&crate::stop_tests::note(None)).unwrap();
    assert_eq!(
        core.update_item("arriving", &edit),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        core.delete_item("arriving"),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        core.add_tag("arriving", "mine"),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(core.queue().unwrap().len(), 2);
    let asked = server.seen("/items").len();
    assert_eq!(core.drain().unwrap_err(), CoreError::HydrationIncomplete);
    assert_eq!(server.seen("/items").len(), asked);
    assert_eq!(core.queue().unwrap().len(), 2);

    // The rest of the fill brings `held` at a later version beneath the write.
    server.on(
        "/items",
        vec![page(
            vec![row("held", 3, &[]), row("arriving", 1, &[])],
            None,
        )],
    );
    server.on(
        "/events",
        vec![head("10"), replay(vec![], "10"), replay(vec![], "10")],
    );
    hydrate(&core).unwrap();
    let held = core.get("held").unwrap().unwrap();
    assert_eq!(held.version, 3);
    assert_eq!(held.properties["title"], json!("mine"));
    let waiting = core.queue().unwrap();
    assert_eq!(
        waiting
            .iter()
            .find(|row| row.id == updated.id)
            .unwrap()
            .base_version,
        Some(1)
    );
}

/// An `item.updated` event at `id` (the event's position) for the note
/// `item` at `version`, listed as `listed` says.
fn item_event(id: &str, item: &str, version: i64, listed: bool) -> String {
    let mut payload: Value = serde_json::from_str(&scripted::item_payload(
        "item.updated",
        item,
        "core.note",
        version,
    ))
    .unwrap();
    payload["listed"] = listed.into();
    scripted::event(id, "item.updated", &payload.to_string())
}

#[test]
fn a_held_row_only_the_replay_brings_keeps_the_edges_it_reads() {
    let server = Scripted::start();
    let core = aged_out(&server);
    // `kept` was out of the slice's listing while the walk read it, and the
    // replay brings it back.
    server.on("/items", vec![page(vec![row("changed", 2, &[])], None)]);
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on(
        "/items/kept",
        vec![scripted::certified(scripted::json(
            200,
            &row("kept", 2, &[("stays", "changed")]).to_string(),
        ))],
    );
    server.on(
        "/events",
        vec![
            head("60"),
            scripted::stream(
                vec![
                    scripted::copy_marker("stream_cursor", "60"),
                    item_event("61", "kept", 2, true),
                    scripted::copy_marker("stream_live", "61"),
                ],
                Then::End,
            ),
        ],
    );

    let report = hydrate(&core).unwrap();

    assert!(report.in_place);
    assert_eq!(core.get("kept").unwrap().unwrap().version, 2);
    assert!(
        edge_held(&core, "stays"),
        "the sweep took the edges of a row only the replay brought"
    );
    assert!(
        !edge_held(&core, "dropped"),
        "the witness: an edge nothing brought stayed"
    );
}

#[test]
fn a_refill_keeps_the_rows_a_waiting_edge_write_names_as_either_end() {
    let server = Scripted::start();
    let mut aimed = None;
    // The edge writes are queued while the copy is whole: one that is not
    // takes none (`device/write-edge-refused-incomplete`).
    let core = aged_out_after(&server, copy(&server), |core| {
        put(
            core,
            &[
                row("moved-to", 1, &[]),
                row("aimed-at", 1, &[]),
                row("idle", 1, &[]),
            ],
        );
        // `stays` moves from `kept` to `moved-to`, and a new edge points at
        // `aimed-at`; the walk brings neither row.
        core.update_edge(
            "stays",
            &crate::EdgeEdit {
                base_version: Some(1),
                source_id: Some("moved-to".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        aimed = Some(
            core.create_edge(&crate::EdgeDraft {
                source_id: "kept".into(),
                target_id: "aimed-at".into(),
                edge_type: "core.related".into(),
                ..Default::default()
            })
            .unwrap(),
        );
    });
    let aimed = aimed.unwrap();
    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);

    hydrate(&core).unwrap();

    let conn = core.conn().unwrap();
    assert!(
        store::item_held(&conn, "moved-to").unwrap(),
        "the moved edge's new source went"
    );
    assert!(
        store::item_held(&conn, "aimed-at").unwrap(),
        "a waiting edge's target went"
    );
    assert!(
        !store::item_held(&conn, "idle").unwrap(),
        "the witness: a row nothing names that the walk left out stayed"
    );
    drop(conn);
    let moved = store::edge_by_id(&core.conn().unwrap(), "stays")
        .unwrap()
        .unwrap();
    assert_eq!(moved.source_id, "moved-to");
    assert!(edge_held(&core, aimed.edge_id.as_deref().unwrap()));
    assert_eq!(core.queue().unwrap().len(), 2);
}

#[test]
fn a_row_leaving_the_slice_keeps_an_edge_a_waiting_write_names() {
    let server = Scripted::start();
    let core = copy(&server);
    crate::stop_tests::holding_a_catalog(&core);
    put(
        &core,
        &[
            row("leaving", 1, &[("edited", "other"), ("idle", "other")]),
            row("other", 1, &[]),
        ],
    );
    let mut edit = crate::EdgeEdit {
        base_version: Some(1),
        ..Default::default()
    };
    edit.properties.insert("note".into(), json!("mine"));
    core.update_edge("edited", &edit).unwrap().unwrap();
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "10"),
                item_event("11", "leaving", 2, false),
                scripted::copy_marker("stream_live", "11"),
            ],
            Then::End,
        )],
    );

    core.catch_up().unwrap();

    assert!(!store::item_held(&core.conn().unwrap(), "leaving").unwrap());
    assert!(
        !edge_held(&core, "idle"),
        "the witness: an edge of the row that left, which nothing names, stayed"
    );
    let kept = store::edge_by_id(&core.conn().unwrap(), "edited").unwrap();
    assert_eq!(
        kept.map(|edge| edge.properties["note"].clone()),
        Some(json!("mine")),
        "the row that left took an edge a waiting write names"
    );
    let beneath: i64 = core
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM beneath WHERE subject = 'edge' AND id = 'edited'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(beneath, 1, "the edge's baseline went with the row");
}

#[test]
fn a_narrowed_reach_after_the_cursor_aged_out_ends_the_stale_copy() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let narrowed = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    server.on(
        "/types",
        vec![scripted::certified_under(
            scripted::types(&[("core.note", None)]),
            narrowed,
        )],
    );
    server.on(
        "/edge-types",
        vec![scripted::certified_under(
            scripted::edge_types(&[]),
            narrowed,
        )],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified_under(
            scripted::json(200, r#"{"type_permissions":{"core.note":"none"}}"#),
            narrowed,
        )],
    );
    server.on("/events", vec![head_under("60", narrowed)]);

    match hydrate(&core) {
        Err(CoreError::Forbidden { code, .. }) => assert_eq!(code, "type_not_permitted"),
        other => panic!("{other:?}"),
    }

    assert_eq!(
        listed(&core),
        Err(CoreError::HydrationIncomplete),
        "a copy built under the old reach still answered"
    );
    assert_eq!(
        core.add_tag("kept", "mine"),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_REFILL).unwrap(),
        None
    );
}

#[test]
fn a_refill_whose_server_was_restored_clears_rather_than_keep_later_versions() {
    let server = Scripted::start();
    let core = aged_out(&server);
    // The refill takes `kept` at version 5 and is cut off.
    server.on(
        "/items",
        vec![
            page(vec![row("kept", 5, &[])], Some("2")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("60")]);
    assert!(hydrate(&core).is_err());
    assert_eq!(core.get("kept").unwrap().unwrap().version, 5);

    // The server is restored from a backup whose log ends at 2, holding
    // `kept` at version 2.
    server.on(
        "/items",
        vec![page(
            vec![row("kept", 2, &[]), row("changed", 1, &[])],
            None,
        )],
    );
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on(
        "/events",
        vec![
            head("2"),
            scripted::stream(vec![scripted::copy_marker("stream_cursor", "2")], Then::End),
            replay(vec![], "2"),
        ],
    );
    let report = hydrate(&core).unwrap();

    assert_eq!(report.restarted, Some(crate::HydrateRestart::HeadPastLog));
    assert!(!report.in_place, "{report:?}");
    assert_eq!(
        core.get("kept").unwrap().unwrap().version,
        2,
        "the copy kept a version the restored server never had"
    );
    assert_eq!(
        ids(&listed(&core).unwrap().1),
        ["changed", "kept", "pinned"]
    );
}

#[test]
fn a_drain_or_catch_up_of_a_stale_copy_says_its_cursor_aged_out() {
    let server = Scripted::start();
    let core = aged_out(&server);
    for (call, answer) in [
        ("drain", core.drain().map(|_| ())),
        ("catch-up", core.catch_up().map(|_| ())),
    ] {
        assert_eq!(
            answer,
            Err(CoreError::CopyExpired {
                reason: "catchup_too_old".into()
            }),
            "{call}"
        );
    }
    assert_eq!(listed(&core).unwrap().0, Completeness::Stale);

    // A refill begun and broken off leaves the copy stale, and it says so.
    server.on(
        "/items",
        vec![
            page(vec![row("kept", 1, &[])], Some("2")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("60")]);
    assert!(hydrate(&core).is_err());
    for (call, answer) in [
        ("drain", core.drain().map(|_| ())),
        ("catch-up", core.catch_up().map(|_| ())),
    ] {
        assert_eq!(
            answer,
            Err(CoreError::CopyExpired {
                reason: "catchup_too_old".into()
            }),
            "{call} part way through a refill"
        );
    }
}

#[test]
fn the_status_of_a_stale_copy_says_stale_until_its_refill_completes() {
    let server = Scripted::start();
    let core = aged_out(&server);
    assert_eq!(core.status().unwrap().hydration, crate::Hydration::Stale);
    server.on(
        "/items",
        vec![
            page(vec![row("kept", 1, &[])], Some("2")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("60")]);
    assert!(hydrate(&core).is_err());
    let status = core.status().unwrap();
    assert_eq!(status.hydration, crate::Hydration::Stale);
    assert_eq!(status.items_listed, Some(1));

    server.on("/items", vec![page(vec![], None)]);
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on(
        "/events",
        vec![head("60"), replay(vec![], "60"), replay(vec![], "60")],
    );
    hydrate(&core).unwrap();
    assert_eq!(core.status().unwrap().hydration, crate::Hydration::Complete);

    // The witness: a copy expired for another reason reports expired.
    crate::reach::expire(&core.conn().unwrap()).unwrap();
    assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
}

const FILE_TYPES: &[(&str, Option<&str>)] = &[
    ("core.note", None),
    ("core.file", None),
    ("core.file.image", Some("core.file")),
];

/// A note and an image file, on disk where a file's bytes are held.
fn files_in(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let photo = dir.join("photo.png");
    std::fs::write(&photo, b"twelve bytes").unwrap();
    let longer = dir.join("longer.png");
    std::fs::write(&longer, b"fifteen bytes!!").unwrap();
    (photo, longer)
}

/// Each file write the copy takes while it is not whole: a new file, a file
/// added or attached to a held row, and new bytes for a held file; and one
/// it refuses, for a row it does not hold.
fn file_writes_while_not_whole(core: &Core, dir: &std::path::Path, held: &str) -> String {
    let (photo, longer) = files_in(dir);
    let draft = crate::Draft {
        r#type: "core.file.image".into(),
        properties: json!({ "title": "photo.png" }).as_object().unwrap().clone(),
        ..Default::default()
    };
    let created = core
        .create_file_item(&photo, &draft)
        .unwrap()
        .item_id
        .unwrap();
    core.add_file(&photo, &crate::Attachment::default(), &[])
        .unwrap();
    let attached = core
        .attach(held, &longer, &crate::Attachment::default())
        .unwrap();
    let edit = Edit {
        base_version: Some(core.get(&created).unwrap().unwrap().version),
        ..Default::default()
    };
    core.update_file_item(&created, &longer, &edit, crate::Based::OnHeld)
        .unwrap();
    assert_eq!(
        core.update_file_item("never-held", &longer, &edit, crate::Based::OnHeld),
        Err(CoreError::HydrationIncomplete),
    );
    assert_eq!(
        core.attach("never-held", &longer, &crate::Attachment::default())
            .map(|_| ()),
        Err(CoreError::HydrationIncomplete),
    );
    attached.upload.blob.unwrap()
}

#[test]
fn a_stale_copy_queues_file_writes_to_held_rows_and_new_files() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(FILE_TYPES))],
    );
    let core = aged_out_on(&server, core);
    let asked = server.asked();
    let attached = file_writes_while_not_whole(&core, dir.path(), "kept");
    assert_eq!(
        server.asked(),
        asked,
        "a file write on a stale copy reached the server"
    );
    // Four uploads, three file items, an attachment edge and an update.
    assert_eq!(core.queue().unwrap().len(), 9);
    assert!(core.blob_held(&attached).unwrap());
}

#[test]
fn a_first_fill_queues_file_writes_to_held_rows_and_new_files_and_keeps_their_bytes() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(crate::Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    let core = first_fill_interrupted_on(&server, core, FILE_TYPES);
    let attached = file_writes_while_not_whole(&core, dir.path(), "held");
    assert_eq!(core.queue().unwrap().len(), 9);

    server.on("/items", vec![page(vec![row("arriving", 1, &[])], None)]);
    // The server holds none of the files yet, so it leaves out the pins
    // their bodies hold.
    server.on("/items/bulk-get", vec![no_pins()]);
    server.on(
        "/events",
        vec![head("10"), replay(vec![], "10"), replay(vec![], "10")],
    );
    hydrate(&core).unwrap();
    assert!(
        core.blob_held(&attached).unwrap(),
        "the bytes of a file attached during the fill went when it completed"
    );
}

#[test]
fn a_follow_waits_out_a_refill_begun_and_refuses_a_stale_copy_none_has_begun() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let stop = AtomicBool::new(false);
    // The witness: a stale copy no refill has begun is refused at once.
    assert_eq!(
        core.follow(&stop, false, |_| {}),
        Err(CoreError::CopyExpired {
            reason: "catchup_too_old".into()
        })
    );

    server.on(
        "/items",
        vec![
            page(vec![row("kept", 1, &[])], Some("2")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("60")]);
    assert!(hydrate(&core).is_err());
    let asked = server.seen("/events").len();
    let stop = Arc::new(AtomicBool::new(false));
    let (done, ended) = std::sync::mpsc::channel();
    {
        let (core, stop) = (Arc::clone(&core), Arc::clone(&stop));
        std::thread::spawn(move || {
            let _ = done.send(core.follow(&stop, false, |_| {}));
        });
    }
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        ended.try_recv().is_err(),
        "a follow on a copy part way through a refill ended rather than waiting"
    );
    assert_eq!(
        server.seen("/events").len(),
        asked,
        "the waiting follow asked the server"
    );
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        ended
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the waiting follow did not end when stopped"),
        Ok(crate::FollowReport::default())
    );
}

#[test]
fn a_refusal_of_the_credential_or_reach_before_a_refill_reads_a_page_ends_the_stale_copy() {
    // The witness: a refusal that says nothing of the credential or the
    // reach leaves the copy stale.
    let server = Scripted::start();
    let core = aged_out(&server);
    server.on("/events", vec![scripted::refusal(503, "unavailable")]);
    assert!(hydrate(&core).is_err());
    assert_eq!(listed(&core).unwrap().0, Completeness::Stale);

    for (path, answer, reason) in [
        (
            "/events",
            scripted::refusal(401, "unauthorized"),
            "credential_ended",
        ),
        (
            "/types",
            scripted::refusal(409, "reach_changed"),
            "reach_changed",
        ),
    ] {
        let server = Scripted::start();
        let core = aged_out(&server);
        server.on("/events", vec![head("60")]);
        server.on(path, vec![answer]);

        assert_eq!(
            hydrate(&core),
            Err(CoreError::CopyExpired {
                reason: reason.into()
            })
        );

        assert_eq!(
            listed(&core),
            Err(CoreError::HydrationIncomplete),
            "{reason}: the copy still answered stale"
        );
        assert_eq!(
            core.add_tag("kept", "mine"),
            Err(CoreError::HydrationIncomplete),
            "{reason}: the copy still took a write"
        );
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
        assert_eq!(
            store::meta_get(&core.conn().unwrap(), store::META_REFILL).unwrap(),
            None
        );
    }
}

#[test]
fn a_server_restored_before_any_refill_clears_rather_than_fill_over_later_versions() {
    let server = Scripted::start();
    // The copy holds `kept` at version 5, read before its cursor 10 aged out.
    let core = aged_out_after(&server, copy(&server), |core| {
        put(core, &[row("kept", 5, &[])]);
    });
    assert_eq!(core.get("kept").unwrap().unwrap().version, 5);

    // The server is restored from a backup whose log ends at 2, holding
    // `kept` at version 2.
    server.on(
        "/items",
        vec![page(
            vec![row("kept", 2, &[]), row("changed", 1, &[])],
            None,
        )],
    );
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("2"), replay(vec![], "2")]);
    let report = hydrate(&core).unwrap();

    assert!(
        !report.in_place,
        "a refill of a restored server filled over rows it may never have held"
    );
    assert_eq!(
        core.get("kept").unwrap().unwrap().version,
        2,
        "the copy kept a version the restored server never had"
    );
    assert_eq!(
        ids(&listed(&core).unwrap().1),
        ["changed", "kept", "pinned"]
    );
}

#[test]
fn a_refill_from_a_head_level_with_the_cursor_it_held_fills_in_place() {
    let server = Scripted::start();
    let core = aged_out(&server);
    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("10"), replay(vec![], "10")]);
    assert!(hydrate(&core).unwrap().in_place);
}

#[test]
fn an_edge_write_waits_for_a_whole_copy_and_an_item_write_does_not() {
    let server = Scripted::start();
    let core = aged_out(&server);
    let queued = core.queue().unwrap().len();
    let moved = crate::EdgeEdit {
        base_version: Some(1),
        target_id: Some("gone".into()),
        ..Default::default()
    };
    let created = crate::EdgeDraft {
        source_id: "kept".into(),
        target_id: "gone".into(),
        edge_type: "core.related".into(),
        ..Default::default()
    };
    let mut edited = crate::EdgeEdit {
        base_version: Some(1),
        ..Default::default()
    };
    edited.properties.insert("note".into(), json!("mine"));
    assert_eq!(
        core.create_edge(&created).map(|_| ()),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        core.update_edge("stays", &moved).map(|_| ()),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        core.update_edge("stays", &edited).map(|_| ()),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(
        core.delete_edge("stays").map(|_| ()),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(core.queue().unwrap().len(), queued);
    assert_eq!(
        store::edge_by_id(&core.conn().unwrap(), "stays")
            .unwrap()
            .map(|edge| edge.target_id),
        Some("changed".into())
    );
    // An item write is still taken.
    core.add_tag("kept", "mine").unwrap();

    server.on("/items", refill_pages());
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);
    hydrate(&core).unwrap();

    // The witness: the whole copy takes each of them.
    core.update_edge("stays", &edited).unwrap().unwrap();
    core.create_edge(&crate::EdgeDraft {
        target_id: "added".into(),
        ..created
    })
    .unwrap();
    core.delete_edge("stays").unwrap();
}

#[test]
fn an_edge_write_part_way_through_a_first_fill_is_refused() {
    let server = Scripted::start();
    let core = first_fill_interrupted(&server);
    let new = core
        .create_item(&crate::stop_tests::note(None))
        .unwrap()
        .item_id
        .unwrap();
    assert_eq!(
        core.create_edge(&crate::EdgeDraft {
            source_id: "held".into(),
            target_id: new,
            edge_type: "core.related".into(),
            ..Default::default()
        })
        .map(|_| ()),
        Err(CoreError::HydrationIncomplete)
    );
    assert_eq!(core.queue().unwrap().len(), 1);
}

/// `row`, a note whose body links to `linked` by id, with the `references`
/// edge `edge` that link made.
fn linking_row(id: &str, version: i64, linked: &str, edge: &str) -> Value {
    let mut row = row(id, version, &[]);
    row["item"]["properties"]["body"] = json!(format!("see [[{linked}]]"));
    let mut reference = edge_of(edge, id, linked);
    reference["edge_type"] = json!(crate::body::rule::LINK_EDGE);
    row["item"]["edges"] = json!({
        crate::body::rule::LINK_EDGE: {"data": [reference], "next_cursor": null}
    });
    row
}

#[test]
fn a_body_edit_of_a_held_note_with_links_is_queued_while_the_copy_is_stale() {
    let server = Scripted::start();
    let core = aged_out_after(&server, copy(&server), |core| {
        put(core, &[linking_row("linking", 1, "kept", "link")]);
    });
    assert!(edge_held(&core, "link"));
    let mut edit = Edit {
        base_version: Some(1),
        ..Default::default()
    };
    edit.properties
        .insert("body".into(), json!("see [[changed]] and not the other"));

    let queued = core.update_item("linking", &edit).unwrap();

    assert_eq!(
        core.get("linking").unwrap().unwrap().properties["body"],
        json!("see [[changed]] and not the other")
    );
    let waiting = core.queue().unwrap();
    assert_eq!(
        waiting
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        [queued.id.as_str()],
        "the edit queued edge writes while the copy was not whole"
    );
    let checks: i64 = core
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM body_checks WHERE write_id = ?1",
            [&queued.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 1, "the edit's links are not read on its answer");
    assert_eq!(
        core.body_links("linking"),
        Err(CoreError::HydrationIncomplete)
    );

    server.on(
        "/items",
        vec![page(
            vec![
                linking_row("linking", 1, "kept", "link"),
                row("kept", 1, &[]),
                row("changed", 1, &[]),
            ],
            None,
        )],
    );
    server.on("/items/bulk-get", vec![pinned_row()]);
    server.on("/events", vec![head("60"), replay(vec![], "60")]);
    hydrate(&core).unwrap();

    // Whole again, the copy answers the links the edit's body carries.
    let links = core.body_links("linking").unwrap();
    assert_eq!(
        links
            .links
            .iter()
            .map(|link| link.name.as_str())
            .collect::<Vec<_>>(),
        ["changed"]
    );
    assert_eq!(
        core.get("linking").unwrap().unwrap().properties["body"],
        json!("see [[changed]] and not the other")
    );
}
