//! Previewing and trashing several items at once.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use crate::model::ItemState;
use crate::scripted::{self, Answer, Scripted, Then, certified};
use crate::{Core, CoreError, Server, TrashPreview, reach, store};
use marfa_rules::wire::WireCatalog;

const NOTE: &str = "core.note";
const AT: &str = "2026-01-01T00:00:00Z";

fn open(server: Option<&Scripted>, dir: &Path) -> Core {
    Core::open(
        dir.join("core.sqlite"),
        server.map(|server| Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap()
}

/// A hydrated copy holding `rows`, each active at version 1.
fn copy(server: Option<&Scripted>, dir: &Path, rows: &[&str]) -> Core {
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
        store::mark_read_only_read(&conn).unwrap();
        store::replace_catalog(
            &conn,
            &WireCatalog {
                types: vec![store::testing::wire_type(NOTE, None, Some("title"))],
                edge_types: Vec::new(),
            },
        )
        .unwrap();
        for id in rows {
            let item = store::testing::note(id, id, "", AT);
            store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
        }
    }
    core
}

fn waiting_write(core: &Core, id: &str, item: &str) {
    core.conn()
        .unwrap()
        .execute(
            "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at)
             VALUES (?1, 'update_item', ?2, ?1, '{}', ?3)",
            rusqlite::params![id, item, AT],
        )
        .unwrap();
}

fn queue_len(core: &Core) -> i64 {
    core.conn()
        .unwrap()
        .query_row("SELECT count(*) FROM queue", [], |row| row.get(0))
        .unwrap()
}

fn preview_body(named: &[&str], takes: &[(&str, &str)], truncated: bool) -> String {
    let items: Vec<Value> = named
        .iter()
        .enumerate()
        .map(|(n, id)| {
            let mut item = json!({
                "id": id, "type": NOTE, "version": 1, "count": 1,
                "takes": if n == 0 {
                    takes.iter().map(|(taken, _)| json!({"id": taken, "type": NOTE, "version": 1})).collect()
                } else { Vec::<Value>::new() },
            });
            if truncated && n == 0 {
                item["truncated"] = true.into();
            }
            item
        })
        .collect();
    json!({"items": items, "count": named.len() + takes.len(), "digest": "d".repeat(64)})
        .to_string()
}

fn previewed(
    core: &Core,
    server: &Scripted,
    named: &[&str],
    takes: &[(&str, &str)],
) -> TrashPreview {
    server.on(
        "/items/trash-preview",
        vec![scripted::json(200, &preview_body(named, takes, false))],
    );
    let ids: Vec<String> = named.iter().map(|id| id.to_string()).collect();
    core.preview_trash(&ids).unwrap()
}

fn trashed_event(id: &str, version: i64) -> String {
    let mut event: Value =
        serde_json::from_str(&scripted::item_payload("item.trashed", id, NOTE, version)).unwrap();
    event["item"]["state"] = "trashed".into();
    event["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
    event["listed"] = true.into();
    event.to_string()
}

/// The server's log after the cursor the copy holds: `item.trashed` for each
/// of `rows` at its version, as a catch-up reads it.
fn log_holds(server: &Scripted, rows: &[(&str, i64)]) {
    server.on("/types", vec![certified(scripted::types(&[(NOTE, None)]))]);
    server.on("/edge-types", vec![certified(scripted::edge_types(&[]))]);
    let mut frames = vec![scripted::copy_marker("stream_cursor", "10")];
    let mut last = 10;
    for (id, version) in rows {
        last += 1;
        frames.push(scripted::event(
            &last.to_string(),
            "item.trashed",
            &trashed_event(id, *version),
        ));
    }
    frames.push(scripted::copy_marker("stream_live", &last.to_string()));
    server.on("/events", vec![scripted::stream(frames, Then::End)]);
}

fn edit() -> crate::Edit {
    crate::Edit {
        properties: serde_json::from_value(json!({"title": "new work"})).unwrap(),
        base_version: Some(1),
        ..Default::default()
    }
}

fn being_removed(result: crate::Result<crate::QueuedWrite>, id: &str) {
    match result {
        Err(CoreError::Validation {
            code,
            details,
            server: None,
            ..
        }) => {
            assert_eq!(code, "item_being_removed");
            assert_eq!(
                details.map(|details| details["id"].clone()),
                Some(json!(id))
            );
        }
        other => panic!("{other:?}"),
    }
}

fn state_of(core: &Core, id: &str) -> Option<(ItemState, i64)> {
    store::items_by_ids(&core.conn().unwrap(), &[id.to_string()])
        .unwrap()
        .pop()
        .map(|item| (item.state, item.version))
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| id.to_string()).collect()
}

#[test]
fn a_preview_names_each_item_once_confirms_the_instance_and_answers_typed() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    server.on(
        "/items/trash-preview",
        vec![scripted::json(
            200,
            &preview_body(&["a", "b"], &[("c", "")], true),
        )],
    );
    let preview = core.preview_trash(&ids(&["a", "b", "a"])).unwrap();
    assert_eq!(preview.count, 3);
    assert_eq!(preview.digest, "d".repeat(64));
    assert_eq!(preview.items.len(), 2);
    assert!(preview.items[0].truncated && !preview.items[1].truncated);
    assert_eq!(preview.items[0].takes[0].id, "c");
    let seen = server.seen("/items/trash-preview");
    assert_eq!(seen.len(), 1);
    let sent: Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(sent, json!({"ids": ["a", "b"]}));
    assert_eq!(seen[0].instance.as_deref(), Some(scripted::INSTANCE));
    assert!(
        !server.seen("/").is_empty(),
        "the root confirmed the instance"
    );
    assert_eq!(state_of(&core, "a"), Some((ItemState::Active, 1)));
}

#[test]
fn a_preview_refuses_no_id_and_more_than_twenty_before_sending() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &[]);
    let many: Vec<String> = (0..21).map(|n| format!("i{n}")).collect();
    for refused in [Vec::new(), many.clone()] {
        match core.preview_trash(&refused).unwrap_err() {
            CoreError::Validation { code, .. } => assert_eq!(code, "validation_error"),
            other => panic!("{other:?}"),
        }
    }
    let mut twenty_with_repeat = many[..20].to_vec();
    twenty_with_repeat.push(many[0].clone());
    server.on(
        "/items/trash-preview",
        vec![scripted::json(200, &preview_body(&["i0"], &[], false))],
    );
    core.preview_trash(&twenty_with_repeat).unwrap();
    assert_eq!(server.seen("/items/trash-preview").len(), 1);
}

#[test]
fn a_preview_offline_fails_with_the_network_error_and_without_a_server_with_no_server() {
    let dir = tempfile::tempdir().unwrap();
    let server = Scripted::start();
    let core = copy(Some(&server), dir.path(), &["a"]);
    drop(server);
    let error = core.preview_trash(&ids(&["a"])).unwrap_err();
    assert!(error.is_unreachable(), "{error:?}");
    let bare = tempfile::tempdir().unwrap();
    let core = copy(None, bare.path(), &["a"]);
    assert!(matches!(
        core.preview_trash(&ids(&["a"])).unwrap_err(),
        CoreError::NoServer
    ));
}

#[test]
fn a_preview_at_another_instance_expires_the_copy_and_asks_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    server.on(
        "/",
        vec![scripted::root("00000000-0000-7000-8000-0000000000ff")],
    );
    let error = core.preview_trash(&ids(&["a"])).unwrap_err();
    assert!(matches!(error, CoreError::CopyExpired { .. }), "{error:?}");
    assert!(server.seen("/items/trash-preview").is_empty());
}

#[test]
fn an_accepted_trash_settles_the_copy_from_the_servers_events() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    // `c` is named and the copy does not hold it; `d` is taken and held.
    let core = copy(Some(&server), dir.path(), &["a", "b", "d", "keep"]);
    let preview = previewed(&core, &server, &["a", "b", "c"], &[("d", "")]);
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    log_holds(&server, &[("a", 2), ("b", 2), ("d", 2)]);
    let before = core.changes_since(None, 100).unwrap().cursor;
    let report = core.trash_items(&preview).unwrap();
    assert_eq!(
        report,
        crate::TrashReport {
            settled: true,
            behind: None
        }
    );
    let seen = server.seen("/items/trash");
    assert_eq!(seen.len(), 1);
    let sent: Value = serde_json::from_slice(&seen[0].body).unwrap();
    assert_eq!(
        sent,
        json!({"ids": ["a", "b", "c"], "digest": "d".repeat(64)})
    );
    assert!(seen[0].idempotency_key.is_some());
    assert_eq!(seen[0].instance.as_deref(), Some(scripted::INSTANCE));
    for id in ["a", "b", "d"] {
        assert_eq!(state_of(&core, id), Some((ItemState::Trashed, 2)), "{id}");
    }
    assert_eq!(state_of(&core, "keep"), Some((ItemState::Active, 1)));
    assert_eq!(queue_len(&core), 0);
    let told = core.changes_since(Some(&before), 100).unwrap();
    assert!(
        ["a", "b", "d"]
            .iter()
            .all(|id| told.items.iter().any(|item| item == id))
    );
}

#[test]
fn a_trash_is_refused_while_a_write_waits_for_a_named_or_a_taken_item() {
    for waiting_for in ["a", "d"] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy(Some(&server), dir.path(), &["a", "d", "other"]);
        let preview = previewed(&core, &server, &["a"], &[("d", "")]);
        waiting_write(&core, "w1", "other");
        // The witness: a write for an unrelated item does not stop it.
        server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
        log_holds(&server, &[("a", 2), ("d", 2)]);
        waiting_write(&core, "w2", waiting_for);
        match core.trash_items(&preview).unwrap_err() {
            CoreError::Invalid(message) => {
                assert!(
                    message.contains("w2") && !message.contains("w1"),
                    "{message}"
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(server.seen("/items/trash").is_empty(), "{waiting_for}");
        assert_eq!(queue_len(&core), 2);
        assert_eq!(state_of(&core, waiting_for), Some((ItemState::Active, 1)));
        core.conn()
            .unwrap()
            .execute("DELETE FROM queue WHERE id = 'w2'", [])
            .unwrap();
        core.trash_items(&preview).unwrap();
        assert_eq!(state_of(&core, "a"), Some((ItemState::Trashed, 2)));
    }
}

#[test]
fn a_truncated_preview_is_refused_while_any_item_write_waits() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "other"]);
    server.on(
        "/items/trash-preview",
        vec![scripted::json(200, &preview_body(&["a"], &[], true))],
    );
    let preview = core.preview_trash(&ids(&["a"])).unwrap();
    waiting_write(&core, "w1", "other");
    assert!(matches!(
        core.trash_items(&preview).unwrap_err(),
        CoreError::Invalid(_)
    ));
    assert!(server.seen("/items/trash").is_empty());
    assert_eq!(queue_len(&core), 1);
}

#[test]
fn a_changed_digest_or_any_refusal_changes_nothing_and_comes_back_typed() {
    for (status, code) in [
        (409, "trash_plan_changed"),
        (400, "edge_constraint_violation"),
        (403, "type_not_permitted"),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy(Some(&server), dir.path(), &["a", "d"]);
        let preview = previewed(&core, &server, &["a"], &[("d", "")]);
        server.on("/items/trash", vec![scripted::refusal(status, code)]);
        let error = core.trash_items(&preview).unwrap_err();
        assert!(
            matches!(&error, CoreError::Server { code: got, .. } | CoreError::Validation { code: got, .. } | CoreError::Forbidden { code: got, .. } if got == code),
            "{error:?}"
        );
        assert!(
            server.seen("/events").is_empty(),
            "no catch-up after a refusal"
        );
        for id in ["a", "d"] {
            assert_eq!(state_of(&core, id), Some((ItemState::Active, 1)));
        }
    }
}

#[test]
fn a_trash_offline_fails_with_the_network_error_and_the_events_settle_a_lost_answer() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    drop(core);
    let down = Scripted::start();
    let core = copy(Some(&down), dir.path(), &[]);
    drop(down);
    let error = core.trash_items(&preview).unwrap_err();
    assert!(error.is_unreachable(), "{error:?}");
    assert_eq!(state_of(&core, "a"), Some((ItemState::Active, 1)));
    drop(core);

    // The server did trash them: the events say so once the copy follows.
    let server = Scripted::start();
    server.on("/types", vec![certified(scripted::types(&[(NOTE, None)]))]);
    server.on("/edge-types", vec![certified(scripted::edge_types(&[]))]);
    let event = json!({
        "event_type": "item.trashed",
        "item": {
            "id": "a", "type": NOTE, "properties": {"title": "a"}, "state": "trashed",
            "tier": "library", "version": 2, "schema_version": 1, "source": "test",
            "occurred_at": AT, "created_at": AT, "updated_at": "2026-03-01T00:00:00Z",
        },
        "metadata": {"tags": []}, "listed": true,
    })
    .to_string();
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "10"),
                scripted::event("11", "item.trashed", &event),
                scripted::copy_marker("stream_live", "11"),
            ],
            Then::End,
        )],
    );
    let core = copy(Some(&server), dir.path(), &[]);
    core.catch_up().unwrap();
    assert_eq!(state_of(&core, "a"), Some((ItemState::Trashed, 2)));
}

#[test]
fn a_slow_trash_does_not_hold_the_copy_from_other_writers() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "z"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    server.on(
        "/items/trash",
        vec![Answer::Slow {
            after: Duration::from_millis(800),
            answer: Box::new(scripted::json(200, r#"{"ok":true}"#)),
        }],
    );
    log_holds(&server, &[("a", 2)]);
    std::thread::scope(|scope| {
        let trashing = scope.spawn(|| core.trash_items(&preview));
        server.wait_for("/items/trash", 1, Duration::from_secs(10));
        let started = std::time::Instant::now();
        core.delete_item("z").unwrap();
        assert!(started.elapsed() < Duration::from_millis(600));
        trashing.join().unwrap().unwrap();
    });
    assert_eq!(state_of(&core, "a"), Some((ItemState::Trashed, 2)));
}

#[test]
fn a_trash_at_another_instance_expires_the_copy_and_sends_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    server.on(
        "/",
        vec![scripted::root("00000000-0000-7000-8000-0000000000ff")],
    );
    let error = core.trash_items(&preview).unwrap_err();
    assert!(matches!(error, CoreError::CopyExpired { .. }), "{error:?}");
    assert!(server.seen("/items/trash").is_empty());
}

#[test]
fn a_reading_handle_may_preview_and_cannot_trash() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let writer = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&writer, &server, &["a"], &[]);
    let reader = open(Some(&server), dir.path());
    assert_eq!(reader.handle(), crate::Handle::Reader);
    reader.preview_trash(&ids(&["a"])).unwrap();
    assert!(reader.trash_items(&preview).is_err());
    assert!(server.seen("/items/trash").is_empty());
}

#[test]
fn an_accepted_trash_whose_copy_cannot_catch_up_says_so_and_the_events_settle_it_later() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "b"]);
    let preview = previewed(&core, &server, &["a", "b"], &[]);
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    server.on("/events", vec![scripted::refusal(503, "unavailable")]);
    let report = core.trash_items(&preview).unwrap();
    assert!(!report.settled, "{report:?}");
    assert!(report.behind.is_some(), "{report:?}");
    assert_eq!(state_of(&core, "b"), Some((ItemState::Active, 1)));

    log_holds(&server, &[("a", 2), ("b", 2)]);
    core.catch_up().unwrap();
    for id in ["a", "b"] {
        assert_eq!(state_of(&core, id), Some((ItemState::Trashed, 2)), "{id}");
    }
}

#[test]
fn a_cut_cascade_lays_a_held_item_it_did_not_list_in_the_bin() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "omitted"]);
    let names: Vec<String> = (0..100).map(|n| format!("child{n}")).collect();
    let takes: Vec<(&str, &str)> = names.iter().map(|id| (id.as_str(), "")).collect();
    let mut body: Value = serde_json::from_str(&preview_body(&["a"], &takes, true)).unwrap();
    body["count"] = 102.into();
    body["items"][0]["count"] = 102.into();
    server.on(
        "/items/trash-preview",
        vec![scripted::json(200, &body.to_string())],
    );
    let preview = core.preview_trash(&ids(&["a"])).unwrap();
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    log_holds(&server, &[("a", 2), ("omitted", 2)]);
    assert!(core.trash_items(&preview).unwrap().settled);
    assert_eq!(state_of(&core, "omitted"), Some((ItemState::Trashed, 2)));
}

#[test]
fn a_restore_the_copy_took_before_the_answer_is_kept() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/items/trash",
        vec![Answer::WaitFor {
            ready: ready.clone(),
            answer: Box::new(scripted::json(200, r#"{"ok":true}"#)),
        }],
    );
    server.on("/types", vec![certified(scripted::types(&[(NOTE, None)]))]);
    server.on("/edge-types", vec![certified(scripted::edge_types(&[]))]);
    let mut restored: Value =
        serde_json::from_str(&scripted::item_payload("item.restored", "a", NOTE, 3)).unwrap();
    restored["item"]["updated_at"] = "2026-03-02T00:00:00Z".into();
    restored["listed"] = true.into();
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "10"),
                scripted::event("11", "item.trashed", &trashed_event("a", 2)),
                scripted::event("12", "item.restored", &restored.to_string()),
                scripted::copy_marker("stream_live", "12"),
            ],
            Then::End,
        )],
    );
    std::thread::scope(|scope| {
        let trashing = scope.spawn(|| core.trash_items(&preview));
        server.wait_for("/items/trash", 1, Duration::from_secs(10));
        core.catch_up().unwrap();
        assert_eq!(state_of(&core, "a"), Some((ItemState::Active, 3)));
        ready.store(true, Ordering::Relaxed);
        assert!(trashing.join().unwrap().unwrap().settled);
    });
    assert_eq!(state_of(&core, "a"), Some((ItemState::Active, 3)));
}

/// Holds the trash at its instance check, runs `during`, then lets it go.
fn while_held(
    core: &Core,
    server: &Scripted,
    preview: &TrashPreview,
    during: impl FnOnce(),
) -> crate::Result<crate::TrashReport> {
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    held_at_instance_check(server, || core.trash_items(preview), during)
}

fn held_at_instance_check<T: Send>(
    server: &Scripted,
    act: impl FnOnce() -> T + Send,
    during: impl FnOnce(),
) -> T {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let ready = Arc::new(AtomicBool::new(false));
    let roots = server.seen("/").len();
    server.on(
        "/",
        vec![Answer::WaitFor {
            ready: ready.clone(),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    std::thread::scope(|scope| {
        let acting = scope.spawn(act);
        server.wait_for("/", roots + 1, Duration::from_secs(10));
        during();
        ready.store(true, Ordering::Relaxed);
        acting.join().unwrap()
    })
}

#[test]
fn a_write_to_an_item_the_trash_holds_is_refused_until_it_returns_and_others_are_not() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "d", "z"]);
    let preview = previewed(&core, &server, &["a"], &[("d", "")]);
    log_holds(&server, &[("a", 2), ("d", 2)]);
    let report = while_held(&core, &server, &preview, || {
        being_removed(core.update_item("a", &edit()), "a");
        being_removed(core.delete_item("d"), "d");
        core.update_item("z", &edit()).unwrap();
    })
    .unwrap();
    assert!(report.settled);
    assert_eq!(server.seen("/items/trash").len(), 1);
    assert_eq!(queue_len(&core), 1, "only the write to z was queued");
    core.restore_item("a").unwrap();
}

#[test]
fn a_cut_preview_holds_every_item_while_its_trash_is_out() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "other"]);
    server.on(
        "/items/trash-preview",
        vec![scripted::json(200, &preview_body(&["a"], &[], true))],
    );
    let preview = core.preview_trash(&ids(&["a"])).unwrap();
    log_holds(&server, &[("a", 2)]);
    while_held(&core, &server, &preview, || {
        match core.update_item("other", &edit()) {
            Err(CoreError::Validation { code, .. }) => assert_eq!(code, "item_being_removed"),
            other => panic!("{other:?}"),
        }
    })
    .unwrap();
    core.update_item("other", &edit()).unwrap();
}

#[test]
fn a_second_trash_of_an_item_a_trash_holds_is_refused() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "b"]);
    let first = previewed(&core, &server, &["a"], &[]);
    let second = previewed(&core, &server, &["b"], &[("a", "")]);
    log_holds(&server, &[("a", 2)]);
    while_held(&core, &server, &first, || match core.trash_items(&second) {
        Err(CoreError::Validation { code, .. }) => assert_eq!(code, "item_being_removed"),
        other => panic!("{other:?}"),
    })
    .unwrap();
    assert_eq!(server.seen("/items/trash").len(), 1);
}

#[test]
fn a_trash_lets_its_items_go_after_a_refusal_a_network_failure_and_no_server() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);

    server.on(
        "/items/trash",
        vec![scripted::refusal(409, "trash_plan_changed")],
    );
    core.trash_items(&preview).unwrap_err();
    core.update_item("a", &edit()).unwrap();
    clear_queue(&core);

    drop(server);
    assert!(core.trash_items(&preview).unwrap_err().is_unreachable());
    core.update_item("a", &edit()).unwrap();
    clear_queue(&core);
    drop(core);

    let core = copy(None, dir.path(), &["a"]);
    assert!(matches!(
        core.trash_items(&preview).unwrap_err(),
        CoreError::NoServer
    ));
    core.update_item("a", &edit()).unwrap();
}

/// Holds `ids` as a trash does, outside any request.
fn hold(core: &Core, ids: &[&str]) -> store::HeldRemoving {
    let conn = core.conn().unwrap();
    core.hold_removing(
        &conn,
        ids.iter().map(|id| id.to_string()).collect(),
        store::Removing::Trash,
    )
    .unwrap()
}

#[test]
fn a_hold_ends_with_the_core_that_took_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = copy(None, dir.path(), &["a"]);
    std::mem::forget(hold(&core, &["a"]));
    being_removed(core.update_item("a", &edit()), "a");
    drop(core);
    let core = open(None, dir.path());
    core.update_item("a", &edit()).unwrap();
}

#[test]
fn a_hold_ends_when_its_holder_unwinds() {
    let dir = tempfile::tempdir().unwrap();
    let core = copy(None, dir.path(), &["a"]);
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = hold(&core, &["a"]);
        being_removed(core.update_item("a", &edit()), "a");
        panic!("unwinding while the hold is out");
    }));
    assert!(unwound.is_err());
    core.update_item("a", &edit()).unwrap();
}

fn clear_queue(core: &Core) {
    core.conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
}

fn in_the_bin(core: &Core, id: &str) {
    let item = store::testing::wire_item(id, NOTE, "trashed", AT, json!({ "title": id }));
    store::upsert_item(&core.conn().unwrap(), &item, None, &Default::default()).unwrap();
}

#[test]
fn a_write_to_an_item_a_purge_has_out_is_refused_until_it_returns() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "z"]);
    in_the_bin(&core, "a");
    server.on(
        "/items/a/purge",
        vec![scripted::json(200, r#"{"ok":true}"#)],
    );
    held_at_instance_check(
        &server,
        || core.purge_item("a", None),
        || {
            being_removed(core.restore_item("a"), "a");
            core.update_item("z", &edit()).unwrap();
        },
    )
    .unwrap();
    assert_eq!(queue_len(&core), 1, "only the write to z was queued");
    assert_eq!(server.seen("/items/a/purge").len(), 1);
    core.refuse_removing(Some("a")).unwrap();
}

#[test]
fn a_refused_purge_lets_its_item_go() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    in_the_bin(&core, "a");
    server.on(
        "/items/a/purge",
        vec![scripted::refusal(409, "version_conflict")],
    );
    core.purge_item("a", None).unwrap_err();
    core.restore_item("a").unwrap();
}

fn keyed(core: &Core, id: &str) -> crate::Draft {
    core.conn()
        .unwrap()
        .execute(
            "UPDATE items SET source = 'test', source_id = 'natural' WHERE id = ?1",
            [id],
        )
        .unwrap();
    crate::Draft {
        r#type: NOTE.into(),
        source: Some("test".into()),
        source_id: Some("natural".into()),
        properties: serde_json::from_value(json!({"title": "new work"})).unwrap(),
        ..Default::default()
    }
}

fn refused_as_being_removed<T: std::fmt::Debug>(result: crate::Result<T>) {
    match result {
        Err(CoreError::Validation { code, .. }) => assert_eq!(code, "item_being_removed"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_create_under_the_natural_key_of_an_item_the_trash_holds_is_refused() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let draft = keyed(&core, "a");
    let witness = core.create_item(&draft).unwrap();
    assert_ne!(witness.item_id.as_deref(), Some("a"));
    clear_queue(&core);
    core.conn()
        .unwrap()
        .execute(
            "DELETE FROM items WHERE id = ?1",
            [witness.item_id.unwrap()],
        )
        .unwrap();
    let preview = previewed(&core, &server, &["a"], &[]);
    log_holds(&server, &[("a", 2)]);
    while_held(&core, &server, &preview, || {
        being_removed(core.create_item(&draft), "a");
    })
    .unwrap();
    assert_eq!(queue_len(&core), 0);
}

#[test]
fn a_create_waiting_under_the_natural_key_of_a_named_item_refuses_the_trash() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let draft = keyed(&core, "a");
    let create = core.create_item(&draft).unwrap();
    let preview = previewed(&core, &server, &["a"], &[]);
    match core.trash_items(&preview) {
        Err(CoreError::Invalid(message)) => assert!(message.contains(&create.id), "{message}"),
        other => panic!("{other:?}"),
    }
    assert!(server.seen("/items/trash").is_empty());
    core.update_item("a", &edit()).unwrap();
}

#[test]
fn a_create_waiting_under_the_natural_key_of_an_item_in_the_bin_refuses_its_purge() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    in_the_bin(&core, "a");
    let draft = keyed(&core, "a");
    let create = core.create_item(&draft).unwrap();
    server.on(
        "/items/a/purge",
        vec![scripted::json(200, r#"{"ok":true}"#)],
    );
    match core.purge_item("a", None) {
        Err(CoreError::Invalid(message)) => assert!(message.contains(&create.id), "{message}"),
        other => panic!("{other:?}"),
    }
    assert!(server.seen("/items/a/purge").is_empty());
}

#[test]
fn releasing_a_refused_write_to_an_item_the_trash_holds_is_refused() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let write = core.update_item("a", &edit()).unwrap();
    let refuse = || {
        core.conn()
            .unwrap()
            .execute(
                "UPDATE queue SET verdict = 'refused', reason = 'dependency_refused', sent = 0
                  WHERE id = ?1",
                [&write.id],
            )
            .unwrap();
    };
    refuse();
    assert!(core.release(&write.id).unwrap());
    refuse();
    let preview = previewed(&core, &server, &["a"], &[]);
    log_holds(&server, &[("a", 2)]);
    while_held(&core, &server, &preview, || {
        refused_as_being_removed(core.release(&write.id));
        let verdict: Option<String> = core
            .conn()
            .unwrap()
            .query_row("SELECT verdict FROM queue WHERE id = ?1", [&write.id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(verdict.as_deref(), Some("refused"));
    })
    .unwrap();
}

#[test]
fn a_trash_lets_its_items_go_when_the_store_cannot_be_written() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    let result = held_at_instance_check(
        &server,
        || core.trash_items(&preview),
        || {
            server.on(
                "/items/trash",
                vec![scripted::refusal(409, "trash_plan_changed")],
            );
            being_removed(core.update_item("a", &edit()), "a");
            core.conn()
                .unwrap()
                .execute_batch("PRAGMA query_only = ON")
                .unwrap();
        },
    );
    assert!(
        matches!(result, Err(CoreError::Server { ref code, .. }) if code == "trash_plan_changed"),
        "{result:?}"
    );
    core.conn()
        .unwrap()
        .execute_batch("PRAGMA query_only = OFF")
        .unwrap();
    core.update_item("a", &edit()).unwrap();
}

#[test]
fn a_purge_of_an_item_the_trash_holds_is_refused_as_being_removed() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    log_holds(&server, &[("a", 2)]);
    while_held(&core, &server, &preview, || {
        refused_as_being_removed(core.purge_item("a", Some(1)));
    })
    .unwrap();
    assert!(server.seen("/items/a/purge").is_empty());
}

#[test]
fn a_cut_preview_holds_creates_and_a_refused_purge_keeps_its_hold() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a", "b"]);
    in_the_bin(&core, "b");
    let mut preview = previewed(&core, &server, &["a"], &[]);
    preview.items[0].truncated = true;
    log_holds(&server, &[("a", 2)]);
    let draft = crate::Draft {
        r#type: NOTE.into(),
        ..Default::default()
    };
    while_held(&core, &server, &preview, || {
        refused_as_being_removed(core.create_item(&draft));
        refused_as_being_removed(core.purge_item("b", None));
        refused_as_being_removed(core.create_item(&draft));
    })
    .unwrap();
    core.create_item(&draft).unwrap();
    core.restore_item("b").unwrap();
}

#[test]
fn a_view_or_folder_the_trash_holds_is_neither_changed_nor_deleted() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    log_holds(&server, &[("a", 2)]);
    let settings: serde_json::Map<String, Value> =
        serde_json::from_value(json!({"title": "kept"})).unwrap();
    while_held(&core, &server, &preview, || {
        refused_as_being_removed(core.change_view("a", &settings, 1, None));
        refused_as_being_removed(core.delete_view("a", None));
        refused_as_being_removed(core.change_folder("a", &settings, 1, None));
        refused_as_being_removed(core.revoke_folder("a", None));
    })
    .unwrap();
    assert!(server.seen("/views/a").is_empty());
    assert!(server.seen("/folders/a").is_empty());
    assert!(server.seen("/folders/a/revoke").is_empty());
}

#[test]
fn a_cut_preview_holds_a_new_view_or_folder() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let mut preview = previewed(&core, &server, &["a"], &[]);
    preview.items[0].truncated = true;
    log_holds(&server, &[("a", 2)]);
    let settings: serde_json::Map<String, Value> =
        serde_json::from_value(json!({"title": "new"})).unwrap();
    while_held(&core, &server, &preview, || {
        refused_as_being_removed(core.create_view(&settings, None));
        refused_as_being_removed(core.create_folder(&settings, None));
    })
    .unwrap();
    assert!(server.seen("/views").is_empty());
    assert!(server.seen("/folders").is_empty());
}

#[test]
fn an_accepted_trash_whose_log_stalls_returns_not_settled_and_a_catch_up_settles_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(Some(&server), dir.path(), &["a"]);
    let preview = previewed(&core, &server, &["a"], &[]);
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    server.on("/events", vec![Answer::Stall]);
    let started = std::time::Instant::now();
    let report = core.trash_items(&preview).unwrap();
    assert!(!report.settled && report.behind.is_some(), "{report:?}");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(state_of(&core, "a"), Some((ItemState::Active, 1)));
    core.update_item("a", &edit()).unwrap();
    clear_queue(&core);
    log_holds(&server, &[("a", 2)]);
    core.catch_up().unwrap();
    assert_eq!(state_of(&core, "a"), Some((ItemState::Trashed, 2)));
}
