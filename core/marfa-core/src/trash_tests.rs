//! Previewing and trashing several items at once (`device/trash-accepted-copy`,
//! `device/trash-waiting-write` and the rules beside them).

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

/// The server's bin as `GET /items?state=trashed` answers it under the
/// copy's reach: each row trashed at `version`.
fn in_the_bin(rows: &[(&str, i64)]) -> Answer {
    let data: Vec<Value> = rows
        .iter()
        .map(|(id, version)| {
            let mut row: Value =
                serde_json::from_str(&scripted::item_payload("item.trashed", id, NOTE, *version))
                    .unwrap();
            row.as_object_mut().unwrap().remove("event_type");
            row["item"]["state"] = "trashed".into();
            row["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
            row["listed"] = true.into();
            row
        })
        .collect();
    certified(scripted::json(
        200,
        &json!({ "data": data, "next_cursor": null }).to_string(),
    ))
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
fn an_accepted_trash_lays_every_held_row_in_the_bin_at_once_at_the_versions_read() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    // `c` is named and taken by nobody the copy holds; `d` is taken and held.
    let core = copy(Some(&server), dir.path(), &["a", "b", "d", "keep"]);
    let preview = previewed(&core, &server, &["a", "b", "c"], &[("d", "")]);
    server.on("/items/trash", vec![scripted::json(200, r#"{"ok":true}"#)]);
    server.on("/items", vec![in_the_bin(&[("a", 2), ("b", 2), ("d", 2)])]);
    let before = core.changes_since(None, 100).unwrap().cursor;
    core.trash_items(&preview).unwrap();
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
    assert_eq!(
        state_of(&core, "c"),
        None,
        "the copy does not take a row it never held"
    );
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
        server.on("/items", vec![in_the_bin(&[("a", 2), ("d", 2)])]);
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
        assert!(server.seen("/items").is_empty(), "no read after a refusal");
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
    server.on("/items", vec![in_the_bin(&[("a", 2)])]);
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
