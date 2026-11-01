//! A row or edge this device removed stays gone while the copy reads events
//! from before its removal, until the event of the removal itself
//! (`device/deleted-stays-gone`, `device/deleted-edge-stays-gone` and
//! `device/deleted-row-edges-stay-gone`).

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted, Then, certified};
use crate::wire::WireCatalog;
use crate::{Core, Server, reach, store};

const NOTE: &str = "core.note";

fn open(server: &Scripted, dir: &Path) -> Arc<Core> {
    Arc::new(
        Core::open(
            dir.join("core.sqlite"),
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap(),
    )
}

/// A copy that has followed the stream to `10`.
fn following(server: &Scripted, dir: &Path) -> Arc<Core> {
    server.on("/types", vec![certified(scripted::types(&[(NOTE, None)]))]);
    server.on("/edge-types", vec![certified(scripted::edge_types(&[]))]);
    let core = open(server, dir);
    {
        let conn = core.conn().unwrap();
        for (key, value) in [
            (store::META_EVENT_CURSOR, "10"),
            (reach::FENCE, scripted::FENCE),
            (store::META_INSTANCE_ID, scripted::INSTANCE),
            (store::META_SLICE_TYPES, "[\"core.note\"]"),
            (store::META_SLICE_TIER, "library"),
            (store::META_SLICE_EDGE_TYPES, "[]"),
        ] {
            store::meta_set(&conn, key, value).unwrap();
        }
        store::replace_catalog(
            &conn,
            &WireCatalog {
                types: vec![store::testing::wire_type(NOTE, None, Some("title"))],
                edge_types: Vec::new(),
            },
        )
        .unwrap();
    }
    core
}

fn row(id: &str, version: i64, state: &str, title: &str, updated_at: &str) -> Value {
    json!({
        "id": id, "type": NOTE, "properties": {"title": title}, "state": state,
        "tier": "library", "version": version, "schema_version": 1, "source": "test",
        "occurred_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
        "updated_at": updated_at,
    })
}

fn item_event(kind: &str, item: Value) -> String {
    json!({"event_type": kind, "item": item, "metadata": {"tags": []}, "listed": true}).to_string()
}

fn edge(id: &str, source: &str, target: &str, version: i64) -> Value {
    json!({
        "id": id, "source_id": source, "target_id": target, "edge_type": "core.related",
        "properties": {"version": version}, "version": version,
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
    })
}

fn edge_event(kind: &str, edge: Value) -> String {
    json!({"event_type": kind, "edge": edge}).to_string()
}

/// One catch-up's stream: each event as `(id, kind, payload)`, then the
/// marker that says it is live, so the catch-up ends there.
fn replay(events: &[(&str, &str, String)]) -> Answer {
    let first = events.first().map_or("10", |(id, ..)| id);
    let last = events.last().map_or("10", |(id, ..)| id);
    let mut frames = vec![
        scripted::connected(),
        scripted::copy_marker("stream_cursor", first),
    ];
    frames.extend(
        events
            .iter()
            .map(|(id, kind, payload)| scripted::event(id, kind, payload)),
    );
    frames.push(scripted::copy_marker("stream_live", last));
    scripted::stream(frames, Then::End)
}

fn ok() -> Answer {
    scripted::json(200, "{\"ok\":true}")
}

fn held(core: &Core, id: &str) -> bool {
    store::item_held(&core.conn().unwrap(), id).unwrap()
}

fn edge_held(core: &Core, id: &str) -> bool {
    store::edge_by_id(&core.conn().unwrap(), id)
        .unwrap()
        .is_some()
}

fn marks(core: &Core) -> i64 {
    core.conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'removal/%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

/// Takes the marks away as though the core kept none.
fn without_marks(core: &Core) {
    core.conn()
        .unwrap()
        .execute("DELETE FROM meta WHERE key LIKE 'removal/%'", [])
        .unwrap();
}

/// How the row `id`, held at version 1, is removed.
#[derive(Clone, Copy, Debug)]
enum Removal {
    View,
    Purge,
}

impl Removal {
    fn state(self) -> &'static str {
        match self {
            Removal::View => "active",
            Removal::Purge => "trashed",
        }
    }

    fn remove(self, server: &Scripted, core: &Core, id: &str) {
        match self {
            Removal::View => {
                server.on(&format!("/views/{id}"), vec![ok()]);
                core.delete_view(id, None).unwrap();
            }
            Removal::Purge => {
                server.on(&format!("/items/{id}/purge"), vec![ok()]);
                core.purge_item(id, None).unwrap();
            }
        }
    }
}

/// The copy holds `gone`, and `stays` with the edge `link` drawn from it to
/// `gone`. It removes `gone`, then reads an older change to it and to the
/// edge, the connection dropping before the purge's events. Answers whether
/// the delayed events put either back, after the copy is opened again.
fn delayed_after(removal: Removal, marked: bool) -> (bool, bool) {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "item.created",
                item_event("item.created", row("gone", 1, removal.state(), "first", at)),
            ),
            (
                "12",
                "item.created",
                item_event("item.created", row("stays", 1, "active", "stays", at)),
            ),
            (
                "13",
                "edge.created",
                edge_event("edge.created", edge("link", "stays", "gone", 1)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    assert!(held(&core, "gone") && edge_held(&core, "link"));

    removal.remove(&server, &core, "gone");
    assert!(!held(&core, "gone") && !edge_held(&core, "link"));
    if !marked {
        without_marks(&core);
    }
    drop(core);

    let core = open(&server, dir.path());
    // An entering row's edges are read by id, which the server now refuses.
    server.on(
        "/items/gone",
        vec![certified(scripted::refusal(404, "item_not_found"))],
    );
    server.on(
        "/events",
        vec![replay(&[
            (
                "14",
                "item.updated",
                item_event(
                    "item.updated",
                    row("gone", 2, removal.state(), "second", "2026-01-02T00:00:00Z"),
                ),
            ),
            (
                "15",
                "edge.updated",
                edge_event("edge.updated", edge("link", "stays", "gone", 2)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    (held(&core, "gone"), edge_held(&core, "link"))
}

#[test]
fn a_row_removed_here_stays_gone_through_older_events_and_a_reopen() {
    for removal in [Removal::View, Removal::Purge] {
        // The witness: with no mark, the delayed events put both back.
        assert_eq!(
            delayed_after(removal, false),
            (true, true),
            "{removal:?}: the delayed events changed nothing even with no mark"
        );
        assert_eq!(
            delayed_after(removal, true),
            (false, false),
            "{removal:?}: an event from before the removal put back the row or its edge"
        );
    }
}

#[test]
fn the_removal_event_ends_the_mark_so_a_row_restored_under_the_id_comes_back() {
    for removal in [Removal::View, Removal::Purge] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = following(&server, dir.path());
        let at = "2026-01-01T00:00:00Z";
        server.on(
            "/events",
            vec![replay(&[(
                "11",
                "item.created",
                item_event("item.created", row("gone", 1, removal.state(), "first", at)),
            )])],
        );
        core.catch_up().unwrap();
        removal.remove(&server, &core, "gone");
        assert_eq!(marks(&core), 1, "{removal:?}");

        server.on(
            "/events",
            vec![replay(&[
                (
                    "12",
                    "item.purged",
                    item_event("item.purged", row("gone", 1, removal.state(), "first", at)),
                ),
                (
                    "13",
                    "item.created",
                    item_event("item.created", row("gone", 1, "active", "restored", at)),
                ),
            ])],
        );
        core.catch_up().unwrap();
        assert!(
            held(&core, "gone"),
            "{removal:?}: a row restored under the id after its purge was hidden"
        );
        assert_eq!(
            marks(&core),
            0,
            "{removal:?}: the purge's event left its mark"
        );
    }
}

#[test]
fn a_removal_whose_event_the_copy_reads_while_it_is_out_leaves_no_mark() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    for removal in [Removal::View, Removal::Purge] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = following(&server, dir.path());
        let at = "2026-01-01T00:00:00Z";
        server.on(
            "/events",
            vec![replay(&[(
                "11",
                "item.created",
                item_event("item.created", row("gone", 1, removal.state(), "first", at)),
            )])],
        );
        core.catch_up().unwrap();
        let ready = Arc::new(AtomicBool::new(false));
        let path = match removal {
            Removal::View => "/views/gone".to_string(),
            Removal::Purge => "/items/gone/purge".to_string(),
        };
        server.on(
            &path,
            vec![Answer::WaitFor {
                ready: ready.clone(),
                answer: Box::new(ok()),
            }],
        );
        let removing = core.clone();
        let worker = std::thread::spawn(move || match removal {
            Removal::View => removing.delete_view("gone", None),
            Removal::Purge => removing.purge_item("gone", None),
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.seen(&path).is_empty() {
            assert!(Instant::now() < deadline, "the removal was never sent");
            std::thread::sleep(Duration::from_millis(1));
        }
        // The event of the removal arrives before its answer.
        server.on(
            "/events",
            vec![replay(&[(
                "12",
                "item.purged",
                item_event("item.purged", row("gone", 1, removal.state(), "first", at)),
            )])],
        );
        core.catch_up().unwrap();
        ready.store(true, Ordering::SeqCst);
        worker.join().unwrap().unwrap();
        assert_eq!(
            marks(&core),
            0,
            "{removal:?}: a mark outlived the event it waits for"
        );
        server.on(
            "/events",
            vec![replay(&[(
                "13",
                "item.created",
                item_event("item.created", row("gone", 1, "active", "restored", at)),
            )])],
        );
        core.catch_up().unwrap();
        assert!(
            held(&core, "gone"),
            "{removal:?}: a restored row was hidden"
        );
    }
}

#[test]
fn a_refused_removal_leaves_no_mark_and_hides_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "item.created",
            item_event("item.created", row("kept", 1, "trashed", "first", at)),
        )])],
    );
    core.catch_up().unwrap();
    server.on(
        "/items/kept/purge",
        vec![scripted::refusal(409, "version_conflict")],
    );
    assert!(core.purge_item("kept", None).is_err());
    server.on(
        "/views/kept",
        vec![scripted::refusal(403, "type_not_permitted")],
    );
    assert!(core.delete_view("kept", None).is_err());
    assert_eq!(marks(&core), 0);
    server.on(
        "/events",
        vec![replay(&[(
            "12",
            "item.updated",
            item_event(
                "item.updated",
                row("kept", 2, "active", "second", "2026-01-02T00:00:00Z"),
            ),
        )])],
    );
    core.catch_up().unwrap();
    assert_eq!(
        store::item_by_id(&core.conn().unwrap(), "kept")
            .unwrap()
            .map(|item| item.version),
        Some(2)
    );
}

/// The copy holds `source` and the edge `link` from it, deletes the edge and
/// drains, the server accepting. Answers the copy and the server.
fn edge_deleted(server: &Scripted, dir: &Path) -> Arc<Core> {
    let core = following(server, dir);
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "item.created",
                item_event("item.created", row("source", 1, "active", "source", at)),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", edge("link", "source", "target", 1)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    assert!(edge_held(&core, "link"));
    core.delete_edge("link").unwrap();
    server.on(
        "/edges/link",
        vec![ok(), certified(scripted::refusal(404, "edge_not_found"))],
    );
    let report = core.drain().unwrap();
    assert_eq!(report.answered, 1, "{report:?}");
    assert!(!edge_held(&core, "link"));
    core
}

#[test]
fn an_edge_deleted_here_stays_gone_through_older_events_and_a_reopen() {
    for marked in [false, true] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = edge_deleted(&server, dir.path());
        if !marked {
            without_marks(&core);
        }
        drop(core);
        let core = open(&server, dir.path());
        server.on(
            "/events",
            vec![replay(&[(
                "13",
                "edge.updated",
                edge_event("edge.updated", edge("link", "source", "target", 2)),
            )])],
        );
        core.catch_up().unwrap();
        // The witness is the run with no mark, which takes the edge back.
        assert_eq!(
            edge_held(&core, "link"),
            !marked,
            "marked {marked}: an older change to an edge deleted here decided wrongly"
        );
    }
}

#[test]
fn the_edge_deleted_event_ends_the_mark_so_an_edge_made_again_under_the_id_comes_back() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = edge_deleted(&server, dir.path());
    assert_eq!(marks(&core), 1);
    server.on(
        "/events",
        vec![replay(&[
            (
                "13",
                "edge.deleted",
                edge_event("edge.deleted", edge("link", "source", "target", 1)),
            ),
            (
                "14",
                "edge.created",
                edge_event("edge.created", edge("link", "source", "target", 1)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    assert!(edge_held(&core, "link"), "an edge made again was hidden");
    assert_eq!(marks(&core), 0, "the edge.deleted event left its mark");
}

#[test]
fn an_edge_delete_refused_as_already_gone_stays_gone_until_its_event() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "item.created",
                item_event("item.created", row("source", 1, "active", "source", at)),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", edge("link", "source", "target", 1)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    core.delete_edge("link").unwrap();
    server.on(
        "/edges/link",
        vec![
            scripted::refusal(404, "edge_not_found"),
            certified(scripted::refusal(404, "edge_not_found")),
        ],
    );
    core.drain().unwrap();
    assert!(!edge_held(&core, "link"));
    server.on(
        "/events",
        vec![replay(&[(
            "13",
            "edge.updated",
            edge_event("edge.updated", edge("link", "source", "target", 2)),
        )])],
    );
    core.catch_up().unwrap();
    assert!(
        !edge_held(&core, "link"),
        "an edge another device deleted first came back from an older event"
    );
}

#[test]
fn an_edge_delete_refused_or_withdrawn_leaves_no_mark() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "item.created",
                item_event("item.created", row("source", 1, "active", "source", at)),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", edge("refused", "source", "target", 1)),
            ),
            (
                "13",
                "edge.created",
                edge_event("edge.created", edge("withdrawn", "source", "target", 1)),
            ),
        ])],
    );
    core.catch_up().unwrap();
    core.delete_edge("refused").unwrap();
    core.delete_edge("withdrawn").unwrap();
    assert_eq!(
        marks(&core),
        2,
        "the witness: each delete is marked while it waits"
    );
    store::withdraw_edge_writes(&core.conn().unwrap(), "withdrawn", None).unwrap();
    server.on(
        "/edges/refused",
        vec![
            scripted::refusal(422, "validation_error"),
            certified(scripted::json(
                200,
                &json!({"edge": edge("refused", "source", "target", 1)}).to_string(),
            )),
        ],
    );
    core.drain().unwrap();
    assert!(edge_held(&core, "refused") && edge_held(&core, "withdrawn"));
    assert_eq!(marks(&core), 0);
}

#[test]
fn a_row_deleted_to_the_bin_needs_no_mark_since_its_answer_is_later() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "item.created",
            item_event("item.created", row("binned", 1, "active", "first", at)),
        )])],
    );
    core.catch_up().unwrap();
    core.delete_item("binned").unwrap();
    let trashed = json!({
        "item": row("binned", 1, "trashed", "first", "2026-01-03T00:00:00Z"),
        "metadata": {"item_id": "binned", "tags": []}, "listed": true,
    });
    server.on(
        "/items/binned",
        vec![ok(), certified(scripted::json(200, &trashed.to_string()))],
    );
    core.drain().unwrap();
    assert_eq!(marks(&core), 0);
    let state = |core: &Core| {
        store::items_by_ids(&core.conn().unwrap(), &["binned".to_string()])
            .unwrap()
            .pop()
            .map(|item| (item.state.as_str().to_string(), item.version))
    };
    assert_eq!(state(&core), Some(("trashed".into(), 1)));
    server.on(
        "/events",
        vec![replay(&[(
            "12",
            "item.updated",
            item_event(
                "item.updated",
                row("binned", 1, "active", "older", "2026-01-02T00:00:00Z"),
            ),
        )])],
    );
    core.catch_up().unwrap();
    assert_eq!(
        state(&core),
        Some(("trashed".into(), 1)),
        "an event from before the delete brought the row out of the bin"
    );
    // The witness: an event later than the delete's answer is applied.
    server.on(
        "/events",
        vec![replay(&[(
            "13",
            "item.restored",
            item_event(
                "item.restored",
                row("binned", 1, "active", "first", "2026-01-04T00:00:00Z"),
            ),
        )])],
    );
    core.catch_up().unwrap();
    assert_eq!(state(&core), Some(("active".into(), 1)));
}

#[test]
fn marks_do_not_grow_with_removals_whose_events_are_read() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    let ids: Vec<String> = (0..20).map(|n| format!("row{n}")).collect();
    let created: Vec<(String, String)> = ids
        .iter()
        .enumerate()
        .map(|(n, id)| {
            (
                (11 + n).to_string(),
                item_event("item.created", row(id, 1, "trashed", "first", at)),
            )
        })
        .collect();
    let events: Vec<(&str, &str, String)> = created
        .iter()
        .map(|(n, payload)| (n.as_str(), "item.created", payload.clone()))
        .collect();
    server.on("/events", vec![replay(&events)]);
    core.catch_up().unwrap();
    for id in &ids {
        server.on(&format!("/items/{id}/purge"), vec![ok()]);
        core.purge_item(id, None).unwrap();
    }
    assert_eq!(marks(&core), 20);
    let purged: Vec<(String, String)> = ids
        .iter()
        .enumerate()
        .map(|(n, id)| {
            (
                (31 + n).to_string(),
                item_event("item.purged", row(id, 1, "trashed", "first", at)),
            )
        })
        .collect();
    let events: Vec<(&str, &str, String)> = purged
        .iter()
        .map(|(n, payload)| (n.as_str(), "item.purged", payload.clone()))
        .collect();
    server.on("/events", vec![replay(&events)]);
    core.catch_up().unwrap();
    assert_eq!(marks(&core), 0);
}

/// The copy removes `gone` and the server accepts, then a second removal of
/// the same id is refused before any of the removal's events are read.
/// Answers whether an event from before the first removal puts the row back.
fn older_event_after_a_second_refused_removal(removal: Removal, marked: bool) -> bool {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path());
    let at = "2026-01-01T00:00:00Z";
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "item.created",
            item_event("item.created", row("gone", 1, removal.state(), "first", at)),
        )])],
    );
    core.catch_up().unwrap();
    removal.remove(&server, &core, "gone");
    match removal {
        Removal::View => {
            server.on(
                "/views/gone",
                vec![certified(scripted::refusal(404, "item_not_found"))],
            );
            assert!(core.delete_view("gone", None).is_err());
        }
        Removal::Purge => {
            server.on(
                "/items/gone/purge",
                vec![certified(scripted::refusal(404, "item_not_found"))],
            );
            assert!(core.purge_item("gone", Some(1)).is_err());
        }
    }
    if !marked {
        without_marks(&core);
    }
    server.on(
        "/items/gone",
        vec![certified(scripted::refusal(404, "item_not_found"))],
    );
    server.on(
        "/events",
        vec![replay(&[(
            "12",
            "item.updated",
            item_event(
                "item.updated",
                row("gone", 2, removal.state(), "second", "2026-01-02T00:00:00Z"),
            ),
        )])],
    );
    core.catch_up().unwrap();
    held(&core, "gone")
}

#[test]
fn a_second_refused_removal_keeps_the_first_removals_mark() {
    for removal in [Removal::View, Removal::Purge] {
        assert!(
            older_event_after_a_second_refused_removal(removal, false),
            "{removal:?}: the witness, with no mark, kept the row out"
        );
        assert!(
            !older_event_after_a_second_refused_removal(removal, true),
            "{removal:?}: a refused second removal took the accepted removal's mark away"
        );
    }
}

#[test]
fn an_edge_made_again_and_its_delete_withdrawn_keeps_the_first_deletes_mark() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = edge_deleted(&server, dir.path());
    let removed = |core: &Core| {
        store::removed(&core.conn().unwrap(), crate::model::Subject::Edge, "link").unwrap()
    };
    assert!(removed(&core), "the accepted delete left no mark");
    // The edge made again under its id, before the first delete's event.
    let again: crate::wire::WireEdge =
        serde_json::from_value(edge("link", "source", "target", 1)).unwrap();
    store::upsert_edge(&core.conn().unwrap(), &again).unwrap();
    core.delete_edge("link").unwrap();
    store::withdraw_edge_writes(&core.conn().unwrap(), "link", None).unwrap();
    // The witness: the withdrawal put the edge back, so it undid the delete.
    assert!(edge_held(&core, "link"));
    assert!(
        removed(&core),
        "a withdrawn second delete took the accepted delete's mark away"
    );
}

/// A hydration starting on either side of the mark never leaves the row
/// purged with no mark: before it, the purge stands and is marked; after it,
/// the copy the hydration filled is kept and so is no mark.
#[test]
fn a_hydration_on_either_side_of_the_mark_never_purges_unmarked() {
    let hydration_starts = |core: &Core| {
        let mut conn = core.conn().unwrap();
        let tx = conn.transaction().unwrap();
        store::forget_removals(&tx).unwrap();
        reach::advance_generation(&tx).unwrap();
        tx.commit().unwrap();
    };
    for during in [false, true] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = following(&server, dir.path());
        server.on(
            "/events",
            vec![replay(&[(
                "11",
                "item.created",
                item_event(
                    "item.created",
                    row("gone", 1, "trashed", "first", "2026-01-01T00:00:00Z"),
                ),
            )])],
        );
        core.catch_up().unwrap();
        if !during {
            hydration_starts(&core);
        }
        core.purge_sent("gone", || {
            assert_eq!(marks(&core), 1, "the purge went out unmarked");
            if during {
                hydration_starts(&core);
            }
            Ok(())
        })
        .unwrap();
        let marked =
            store::removed(&core.conn().unwrap(), crate::model::Subject::Item, "gone").unwrap();
        assert_eq!(
            (held(&core, "gone"), marked),
            (during, !during),
            "hydration during the request {during}"
        );
    }
}
