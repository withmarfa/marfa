//! A copy narrowed by a query holds, of the rows its types and tier take, the
//! ones the query takes: as hydration lists them, as catch-up judges each
//! event, and never at the cost of what waits to be sent
//! (`device/slice-query-outside`, `device/catch-up-query-takes`).

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted, Then, certified};
use crate::wire::WireCatalog;
use crate::{Core, CoreError, Server, SliceQuery, SliceTier, reach, store};

const NOTE: &str = "core.note";
const WORK: &str = r#"tags contains "work""#;

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

fn work() -> SliceQuery {
    SliceQuery {
        states: Some(vec!["active".into(), "archived".into()]),
        filter: Some(WORK.into()),
        beneath: None,
    }
}

/// A query of one member state, so a row the copy did not hold may have
/// been archived and enter at a delete.
fn active_work() -> SliceQuery {
    SliceQuery {
        states: Some(vec!["active".into()]),
        ..work()
    }
}

fn note_json(status: &[(&str, &str)]) -> Value {
    let mut wire = json!({"id": NOTE, "display_hints": {"title_field": "title"}});
    if !status.is_empty() {
        let values: Vec<Value> = status
            .iter()
            .map(|(value, group)| json!({"value": value, "group": group}))
            .collect();
        wire["fields"] = json!({"stage": {"type": "status", "status_values": values}});
    }
    wire
}

fn note_type(status: &[(&str, &str)]) -> crate::wire::WireType {
    serde_json::from_value(note_json(status)).unwrap()
}

/// A copy that has followed the stream to `10`, narrowed by `query`.
fn following(server: &Scripted, dir: &Path, query: Option<&SliceQuery>) -> Arc<Core> {
    following_typed(server, dir, query, &[])
}

fn following_typed(
    server: &Scripted,
    dir: &Path,
    query: Option<&SliceQuery>,
    status: &[(&str, &str)],
) -> Arc<Core> {
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
        if let Some(query) = query {
            store::meta_set(
                &conn,
                store::META_SLICE_QUERY,
                &serde_json::to_string(query).unwrap(),
            )
            .unwrap();
        }
        store::replace_catalog(
            &conn,
            &WireCatalog {
                types: vec![note_type(status)],
                edge_types: Vec::new(),
            },
        )
        .unwrap();
    }
    core
}

fn hold(core: &Core, id: &str, state: &str, tags: &[&str], props: Value) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    let item = store::testing::wire_item(id, NOTE, state, "2026-01-01T00:00:00Z", props);
    let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
    store::put_server_item(&conn, &item, Some(&tags), &catalog).unwrap();
    reach::set_listed(&conn, id, true).unwrap();
}

fn row(id: &str, version: i64, state: &str, props: Value) -> Value {
    json!({
        "id": id, "type": NOTE, "properties": props, "state": state,
        "tier": "library", "version": version, "schema_version": 1, "source": "test",
        "occurred_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
        "updated_at": format!("2026-01-0{version}T00:00:00Z"),
    })
}

fn changed(id: &str, tags: &[&str]) -> String {
    json!({
        "event_type": "item.updated",
        "item": row(id, 2, "active", json!({"title": id})),
        "metadata": {"tags": tags},
        "listed": true,
    })
    .to_string()
}

/// A delete, which carries no metadata.
fn binned(id: &str) -> String {
    json!({
        "event_type": "item.deleted",
        "item": row(id, 2, "trashed", json!({"title": id})),
        "listed": true,
    })
    .to_string()
}

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

fn catalog_answers(server: &Scripted, status: &[(&str, &str)]) {
    let types = json!({"data": [note_json(status)], "next_cursor": null});
    server.on(
        "/types",
        vec![certified(scripted::json(200, &types.to_string()))],
    );
    server.on("/edge-types", vec![certified(scripted::edge_types(&[]))]);
}

/// The bin's answer to a read of one trashed row by id.
fn in_bin(id: &str, tags: &[&str]) -> Answer {
    let body = json!({
        "data": [{
            "item": row(id, 2, "trashed", json!({"title": id})),
            "metadata": {"item_id": id, "tags": tags, "extensions": {}},
            "listed": true,
        }],
        "next_cursor": null,
    });
    certified(scripted::json(200, &body.to_string()))
}

/// A row read by id that the server no longer shows outside the bin, as an
/// entering row's edges are read.
fn unread(server: &Scripted, ids: &[&str]) {
    for id in ids {
        server.on(
            &format!("/items/{id}"),
            vec![certified(scripted::refusal(404, "item_not_found"))],
        );
    }
}

fn tags_of(core: &Core, id: &str) -> Vec<String> {
    let conn = core.conn().unwrap();
    let mut statement = conn
        .prepare("SELECT tag FROM tags WHERE item_id = ?1 ORDER BY tag")
        .unwrap();
    statement
        .query_map([id], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn held(core: &Core, id: &str) -> bool {
    store::item_held(&core.conn().unwrap(), id).unwrap()
}

/// What the copy keeps beyond its rows, which no eviction may touch.
fn kept_beside_rows(core: &Core) -> Vec<String> {
    let conn = core.conn().unwrap();
    let mut kept = Vec::new();
    for table in ["queue", "pins", "read_backs"] {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = statement.column_count();
        let rows: Vec<String> = statement
            .query_map([], |row| {
                let mut values = Vec::new();
                for at in 0..columns {
                    let value: rusqlite::types::Value = row.get(at)?;
                    values.push(format!("{value:?}"));
                }
                Ok(format!("{table}: {}", values.join(" | ")))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        kept.extend(rows);
    }
    let mut statement = conn
        .prepare(
            "SELECT key, value FROM meta WHERE key LIKE 'folder%' OR key LIKE 'purged%' \
             OR key LIKE 'removal/%' ORDER BY key",
        )
        .unwrap();
    kept.extend(
        statement
            .query_map([], |row| {
                Ok(format!(
                    "meta: {} = {}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?
                ))
            })
            .unwrap()
            .map(Result::unwrap),
    );
    kept
}

/// The copy holds `left` (tagged work), `pinned` (tagged work and pinned)
/// and `waiting` (tagged work, with a tag of its own waiting to be sent);
/// each then loses its tag on the server, and `entering` and `outside`,
/// not held, change there with and without the tag. Answers which the copy
/// holds afterwards.
fn caught_up_under(query: Option<&SliceQuery>) -> Vec<&'static str> {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), query);
    for id in ["left", "pinned", "waiting"] {
        hold(&core, id, "active", &["work"], json!({"title": id}));
    }
    store::pin(&core.conn().unwrap(), "pinned").unwrap();
    core.add_tag("waiting", "mine").unwrap();
    catalog_answers(&server, &[]);
    unread(&server, &["entering", "outside"]);
    server.on(
        "/events",
        vec![replay(&[
            ("11", "item.updated", changed("left", &[])),
            ("12", "item.updated", changed("pinned", &[])),
            ("13", "item.updated", changed("waiting", &[])),
            ("14", "item.updated", changed("entering", &["work"])),
            ("15", "item.updated", changed("outside", &[])),
        ])],
    );
    let before = kept_beside_rows(&core);
    core.catch_up().unwrap();
    assert_eq!(
        kept_beside_rows(&core),
        before,
        "the catch-up changed what the copy keeps beside its rows"
    );
    let reads: Vec<String> = server
        .seen("/items/outside")
        .into_iter()
        .map(|seen| seen.path)
        .collect();
    if query.is_some() {
        assert!(reads.is_empty(), "a row the query leaves out was read");
    }
    ["left", "pinned", "waiting", "entering", "outside"]
        .into_iter()
        .filter(|id| held(&core, id))
        .collect()
}

#[test]
fn catch_up_lets_go_of_a_row_leaving_the_query_and_takes_one_entering() {
    // The witness: with no query, every row the stream names is held.
    assert_eq!(
        caught_up_under(None),
        ["left", "pinned", "waiting", "entering", "outside"]
    );
    assert_eq!(
        caught_up_under(Some(&work())),
        ["pinned", "waiting", "entering"]
    );
}

#[test]
fn catch_up_reads_the_tags_a_delete_does_not_carry() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&active_work()));
    hold(
        &core,
        "member",
        "active",
        &["work"],
        json!({"title": "member"}),
    );
    catalog_answers(&server, &[]);
    server.on(
        "/items",
        vec![in_bin("tagged", &["work"]), in_bin("bare", &[])],
    );
    unread(&server, &["tagged", "bare"]);
    server.on(
        "/events",
        vec![replay(&[
            ("11", "item.deleted", binned("member")),
            ("12", "item.deleted", binned("tagged")),
            ("13", "item.deleted", binned("bare")),
        ])],
    );

    core.catch_up().unwrap();

    let reads = server.seen("/items");
    assert_eq!(reads.len(), 2, "{reads:?}");
    assert!(
        reads.iter().all(|seen| seen.query.contains("filter=")),
        "{reads:?}"
    );
    // A member trashed stays in the copy, as its tags held.
    assert!(held(&core, "member"));
    assert_eq!(tags_of(&core, "member"), ["work"]);
    assert!(held(&core, "tagged"));
    assert_eq!(tags_of(&core, "tagged"), ["work"]);
    assert!(!held(&core, "bare"));
}

#[test]
fn catch_up_leaves_out_a_row_whose_tags_it_cannot_read() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&active_work()));
    catalog_answers(&server, &[]);
    server.on(
        "/items",
        vec![certified(scripted::json(
            200,
            r#"{"data":[],"next_cursor":null}"#,
        ))],
    );
    server.on(
        "/events",
        vec![replay(&[("11", "item.deleted", binned("unread"))])],
    );

    core.catch_up().unwrap();

    assert_eq!(server.seen("/items").len(), 1);
    assert!(!held(&core, "unread"));
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap(),
        Some("11".into()),
        "the event was not passed"
    );
}

#[test]
fn catch_up_reads_nothing_for_a_delete_of_a_row_the_copy_could_not_have_left_out() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&work()));
    catalog_answers(&server, &[]);
    server.on(
        "/events",
        vec![replay(&[("11", "item.deleted", binned("bare"))])],
    );

    core.catch_up().unwrap();

    assert!(server.seen("/items").is_empty());
    assert!(!held(&core, "bare"));
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap(),
        Some("11".into()),
        "the event was not passed"
    );
}

#[test]
fn a_state_query_lets_go_of_a_row_archived_on_the_server() {
    let active = SliceQuery {
        states: Some(vec!["active".into()]),
        filter: None,
        beneath: None,
    };
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&active));
    hold(&core, "a", "active", &[], json!({"title": "a"}));
    catalog_answers(&server, &[]);
    let archived = json!({
        "event_type": "item.updated",
        "item": row("a", 2, "archived", json!({"title": "a"})),
        "metadata": {"tags": []},
        "listed": true,
    })
    .to_string();
    server.on("/events", vec![replay(&[("11", "item.updated", archived)])]);

    core.catch_up().unwrap();

    assert!(!held(&core, "a"));
}

#[test]
fn a_property_query_judges_the_row_an_event_carries() {
    let done = SliceQuery {
        states: None,
        filter: Some("properties.done eq true".into()),
        beneath: None,
    };
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&done));
    hold(
        &core,
        "a",
        "active",
        &[],
        json!({"title": "a", "done": true}),
    );
    catalog_answers(&server, &[]);
    let event = |id: &str, done: bool| {
        json!({
            "event_type": "item.updated",
            "item": row(id, 2, "active", json!({"title": id, "done": done})),
            "metadata": {"tags": []},
            "listed": true,
        })
        .to_string()
    };
    unread(&server, &["b"]);
    server.on(
        "/events",
        vec![replay(&[
            ("11", "item.updated", event("a", false)),
            ("12", "item.updated", event("b", true)),
        ])],
    );

    core.catch_up().unwrap();

    assert!(!held(&core, "a"));
    assert!(held(&core, "b"));
}

#[test]
fn a_change_to_a_status_field_the_query_reads_ends_the_copy() {
    let doing = SliceQuery {
        states: None,
        filter: Some(r#"status_group eq "in_progress""#.into()),
        beneath: None,
    };
    let before = [("doing", "in_progress"), ("done", "done")];
    let after = [("doing", "done"), ("done", "done")];
    for (query, ends) in [(work(), false), (doing, true)] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = following_typed(&server, dir.path(), Some(&query), &before);
        catalog_answers(&server, &after);
        server.on("/events", vec![replay(&[])]);

        let ended = core.catch_up();

        if ends {
            match ended {
                Err(CoreError::CopyExpired { reason }) => {
                    assert!(reason.contains("catalog_changed"), "{reason}");
                }
                other => panic!("a changed status field ended {other:?}"),
            }
        } else {
            // The witness: a query that reads no status field carries on.
            ended.unwrap();
        }
    }
}

#[test]
fn a_create_the_query_does_not_take_is_pinned() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), Some(&work()));
    let tagged = core
        .create_item(&crate::Draft {
            r#type: NOTE.into(),
            properties: json!({"title": "kept"}).as_object().unwrap().clone(),
            tags: vec!["work".into()],
            ..Default::default()
        })
        .unwrap();
    let bare = core
        .create_item(&crate::Draft {
            r#type: NOTE.into(),
            properties: json!({"title": "bare"}).as_object().unwrap().clone(),
            ..Default::default()
        })
        .unwrap();
    let conn = core.conn().unwrap();
    assert!(!store::pinned(&conn, &tagged.item_id.unwrap()).unwrap());
    assert!(store::pinned(&conn, &bare.item_id.unwrap()).unwrap());
}

/// A hydration narrowed by `work` over a copy holding `outside` (untagged),
/// `pinned` (untagged, pinned) and `waiting` (untagged, a tag waiting to be
/// sent, which the queue keeps whatever the copy holds).
#[test]
fn hydration_lists_the_query_and_its_conflicted_copies_apart() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), None);
    for id in ["outside", "pinned", "waiting"] {
        hold(&core, id, "active", &[], json!({"title": id}));
    }
    store::pin(&core.conn().unwrap(), "pinned").unwrap();
    core.add_tag("waiting", "mine").unwrap();
    catalog_answers(&server, &[]);
    let page = |rows: &[(&str, &[&str])]| {
        let data: Vec<Value> = rows
            .iter()
            .map(|(id, tags)| {
                json!({
                    "item": row(id, 1, "active", json!({"title": id})),
                    "metadata": {"item_id": id, "tags": tags, "extensions": {}},
                    "listed": true,
                })
            })
            .collect();
        certified(scripted::json(
            200,
            &json!({"data": data, "next_cursor": null}).to_string(),
        ))
    };
    server.on(
        "/items",
        vec![
            page(&[("member", &["work"])]),
            page(&[("member", &["work"])]),
            page(&[("copy", &["conflicted-copy"])]),
        ],
    );
    let bulk = |ids: &[&str]| {
        let body = json!({
            "items": ids.iter().map(|id| row(id, 1, "active", json!({"title": id}))).collect::<Vec<_>>(),
            "metadata": ids.iter().map(|id| json!({"item_id": id, "tags": [], "extensions": {}})).collect::<Vec<_>>(),
            "listed": ids.iter().map(|_| true).collect::<Vec<_>>(),
        });
        certified(scripted::json(200, &body.to_string()))
    };
    server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
    server.on(
        "/keys/current",
        vec![certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read"}}"#,
        ))],
    );
    let head = scripted::stream(
        vec![scripted::copy_marker("stream_cursor", "10")],
        Then::End,
    );
    let empty = scripted::stream(
        vec![
            scripted::copy_marker("stream_cursor", "10"),
            scripted::copy_marker("stream_live", "10"),
        ],
        Then::End,
    );
    server.on("/events", vec![head, empty]);
    let before = kept_beside_rows(&core);

    let report = core
        .hydrate_sliced(
            &[NOTE.into()],
            SliceTier::Library,
            &[],
            Some(&work()),
            &AtomicBool::new(false),
        )
        .unwrap();

    assert_eq!(report.query, Some(work()));
    let listings: Vec<String> = server
        .seen("/items")
        .into_iter()
        .map(|seen| seen.query)
        .collect();
    assert!(
        listings
            .iter()
            .all(|query| query.contains("state=active%2Carchived%2Ctrashed")),
        "{listings:?}"
    );
    assert!(
        listings
            .iter()
            .any(|query| query.contains("filter=") && !query.contains("tags=")),
        "{listings:?}"
    );
    assert!(
        listings
            .iter()
            .any(|query| query.contains("tags=conflicted-copy") && !query.contains("filter=")),
        "{listings:?}"
    );
    assert!(held(&core, "member") && held(&core, "copy"));
    assert!(!held(&core, "outside"), "a row the query leaves out stayed");
    assert!(held(&core, "pinned"));
    assert_eq!(kept_beside_rows(&core), before);
    assert_eq!(
        store::slice_query(&core.conn().unwrap()).unwrap(),
        Some(work())
    );
}

#[test]
fn a_query_the_server_refuses_clears_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), None);
    hold(&core, "outside", "active", &[], json!({"title": "outside"}));
    catalog_answers(&server, &[]);
    server.on(
        "/items",
        vec![certified(scripted::refusal(400, "validation_error"))],
    );

    let refused = core.hydrate_sliced(
        &[NOTE.into()],
        SliceTier::Library,
        &[],
        Some(&work()),
        &AtomicBool::new(false),
    );

    assert!(refused.is_err(), "{refused:?}");
    assert!(held(&core, "outside"));
    assert_eq!(store::slice_query(&core.conn().unwrap()).unwrap(), None);
}

#[test]
fn a_relational_query_is_refused_for_a_copy() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), None);
    let edge = SliceQuery {
        states: None,
        filter: Some("edge[core.related] exists".into()),
        beneath: None,
    };
    let refused = core.hydrate_sliced(
        &[NOTE.into()],
        SliceTier::Library,
        &[],
        Some(&edge),
        &AtomicBool::new(false),
    );
    assert!(matches!(refused, Err(CoreError::Invalid(_))), "{refused:?}");
}
