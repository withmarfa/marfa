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
    let core = copy(server);
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
    assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
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
    let core = Arc::new(core);
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
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
