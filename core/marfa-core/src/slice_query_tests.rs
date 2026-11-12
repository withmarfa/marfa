//! A copy narrowed by a query holds, of the rows its types and tier take, the
//! ones the query takes: as hydration lists them, as catch-up judges each
//! event, and never at the cost of what waits to be sent
//! (`device/slice-query-outside`, `device/catch-up-query-takes`).

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted, Then, certified};
use crate::{Core, CoreError, Server, SliceQuery, SliceTier, reach, store};
use marfa_rules::wire::WireCatalog;

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

fn note_type(status: &[(&str, &str)]) -> marfa_rules::wire::WireType {
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
        store::mark_read_only_read(&conn).unwrap();
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
    let catalog = crate::catalog::load(&conn).unwrap();
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
    let mut frames = vec![scripted::copy_marker("stream_cursor", first)];
    frames.extend(
        events
            .iter()
            .map(|(id, kind, payload)| scripted::event(id, kind, payload)),
    );
    frames.push(scripted::copy_marker("stream_live", last));
    scripted::stream(frames, Then::End)
}

/// A stream with nothing past `cursor`.
fn at_head(cursor: &str) -> Answer {
    scripted::stream(
        vec![
            scripted::copy_marker("stream_cursor", cursor),
            scripted::copy_marker("stream_live", cursor),
        ],
        Then::End,
    )
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

// A query with `beneath`: membership moves with the `parent-of` edges the
// copy holds whole, so an edge event re-judges the branch it moves
// (`device/catch-up-beneath-enters`, `device/catch-up-beneath-leaves`).

const PARENT_OF: &str = "parent-of";

fn under_root() -> SliceQuery {
    SliceQuery {
        states: Some(vec!["active".into(), "archived".into()]),
        filter: None,
        beneath: Some("root".into()),
    }
}

/// A copy following the stream under `root`, holding `parent-of` whole.
fn following_beneath(server: &Scripted, dir: &Path) -> Arc<Core> {
    let core = following(server, dir, Some(&under_root()));
    store::meta_set(
        &core.conn().unwrap(),
        store::META_SLICE_EDGE_TYPES,
        &serde_json::to_string(&[PARENT_OF]).unwrap(),
    )
    .unwrap();
    core
}

fn edge_json(id: &str, source: &str, target: &str, version: i64) -> Value {
    json!({
        "id": id, "source_id": source, "target_id": target, "edge_type": PARENT_OF,
        "properties": {}, "version": version,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": format!("2026-01-0{version}T00:00:00Z"),
    })
}

fn hold_edge(core: &Core, id: &str, source: &str, target: &str, version: i64) {
    let edge: crate::wire::WireEdge =
        serde_json::from_value(edge_json(id, source, target, version)).unwrap();
    store::put_server_edge(&core.conn().unwrap(), &edge).unwrap();
}

fn edge_event(kind: &str, id: &str, source: &str, target: &str, version: i64) -> String {
    json!({"event_type": kind, "edge": edge_json(id, source, target, version)}).to_string()
}

fn purged(id: &str) -> String {
    json!({
        "event_type": "item.purged",
        "item": row(id, 3, "trashed", json!({"title": id})),
        "listed": true,
    })
    .to_string()
}

/// A listing page of active rows, each drawing the `parent-of` edges named.
fn listed_page(rows: &[(&str, &[(&str, &str)])]) -> Answer {
    let data: Vec<Value> = rows
        .iter()
        .map(|(id, children)| {
            let mut item = row(id, 1, "active", json!({"title": id}));
            let edges: Vec<Value> = children
                .iter()
                .map(|(edge, child)| edge_json(edge, id, child, 1))
                .collect();
            item["edges"] = json!({PARENT_OF: {"data": edges, "next_cursor": null}});
            json!({
                "item": item,
                "metadata": {"item_id": id, "tags": [], "extensions": {}},
                "listed": true,
            })
        })
        .collect();
    certified(scripted::json(
        200,
        &json!({"data": data, "next_cursor": null}).to_string(),
    ))
}

fn held_edge(core: &Core, id: &str) -> bool {
    store::edge_by_id(&core.conn().unwrap(), id)
        .unwrap()
        .is_some()
}

/// Settles the copy as it holds its edges now, as the last settle would
/// have: the walk from the root is the reach, and nothing is owed.
fn settled(core: &Core) {
    let conn = core.conn().unwrap();
    let reach: Vec<String> = crate::slice::beneath_ids(&conn, "root")
        .unwrap()
        .into_iter()
        .collect();
    conn.execute("DELETE FROM beneath_reach", []).unwrap();
    store::enter_beneath_reach(&conn, &reach).unwrap();
    store::meta_delete(&conn, store::META_BENEATH_SETTLE).unwrap();
}

/// The `/items/bulk-get` requests made, each as the ids it asked for.
fn reads(server: &Scripted) -> Vec<Vec<String>> {
    server
        .seen("/items/bulk-get")
        .into_iter()
        .map(|seen| {
            let body: Value = serde_json::from_slice(&seen.body).unwrap();
            let mut asked: Vec<String> = body["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_string())
                .collect();
            asked.sort();
            asked
        })
        .collect()
}

#[test]
fn the_ids_beneath_follow_the_edges_held_and_end_on_a_cycle() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold_edge(&core, "e1", "root", "a", 1);
    hold_edge(&core, "e2", "a", "b", 1);
    hold_edge(&core, "e3", "b", "root", 1);
    hold_edge(&core, "e4", "elsewhere", "c", 1);
    let ids = crate::slice::beneath_ids(&core.conn().unwrap(), "root").unwrap();
    let mut ids: Vec<String> = ids.into_iter().collect();
    ids.sort();
    assert_eq!(
        ids,
        ["a", "b", "root"],
        "rows not held are reached all the same"
    );
}

/// The copy holds `root` and a branch `moved` → `leaf` outside it, which
/// it does not hold; `moved` is then drawn under `root`.
#[test]
fn a_branch_moved_under_the_root_is_read_by_id() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold_edge(&core, "e-leaf", "moved", "leaf", 1);
    settled(&core);
    catalog_answers(&server, &[]);
    server.on(
        "/items/bulk-get",
        vec![read_drawing(&[
            // Drawn under `moved` on the server after the event, and so not
            // yet under it here: the stream brings that edge in its turn.
            ("moved", &[("e-leaf", "leaf"), ("e-ahead", "ahead")]),
            ("leaf", &[]),
        ])],
    );
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.created",
                edge_event("edge.created", "e-far", "x", "y", 1),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", "e-in", "root", "moved", 1),
            ),
        ])],
    );
    let before = kept_beside_rows(&core);

    core.catch_up().unwrap();

    assert_eq!(
        reads(&server),
        [ids(&["leaf", "moved"])],
        "an edge outside the root was read"
    );
    assert!(server.seen("/items").is_empty());
    assert!(held(&core, "moved") && held(&core, "leaf"));
    assert!(
        !held(&core, "ahead") && !held_edge(&core, "e-ahead"),
        "a `parent-of` edge was taken from a read"
    );
    assert!(held_edge(&core, "e-in") && held_edge(&core, "e-far"));
    assert_eq!(kept_beside_rows(&core), before);
}

/// `POST /items/bulk-get` answering each row named, each drawing the
/// `parent-of` edges named.
fn read_drawing(rows: &[(&str, &[(&str, &str)])]) -> Answer {
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, children)| listed_row(id, children)["item"].clone())
        .collect();
    let metadata: Vec<Value> = rows
        .iter()
        .map(|(id, _)| json!({"item_id": id, "tags": []}))
        .collect();
    let listed: Vec<bool> = rows.iter().map(|_| true).collect();
    certified(scripted::json(
        200,
        &json!({"items": items, "metadata": metadata, "listed": listed}).to_string(),
    ))
}

/// The copy holds `root` → `branch` → (`plain`, `bound`, `waiting`):
/// `bound` pinned, as a file's item is, and `waiting` with a write unsent.
fn branch_held(server: &Scripted, dir: &Path) -> Arc<Core> {
    let core = following_beneath(server, dir);
    for id in ["root", "branch", "plain", "bound", "waiting"] {
        hold(&core, id, "active", &[], json!({"title": id}));
    }
    hold_edge(&core, "e-branch", "root", "branch", 1);
    for child in ["plain", "bound", "waiting"] {
        hold_edge(&core, &format!("e-{child}"), "branch", child, 1);
    }
    store::pin(&core.conn().unwrap(), "bound").unwrap();
    core.add_tag("waiting", "mine").unwrap();
    settled(&core);
    catalog_answers(server, &[]);
    core
}

fn held_of(core: &Core) -> Vec<&'static str> {
    ["root", "branch", "plain", "bound", "waiting"]
        .into_iter()
        .filter(|id| held(core, id))
        .collect()
}

#[test]
fn a_branch_moved_out_leaves_but_a_bound_or_waiting_row_stays() {
    for (kind, event) in [
        (
            "edge.deleted",
            edge_event("edge.deleted", "e-branch", "root", "branch", 1),
        ),
        (
            "edge.updated",
            edge_event("edge.updated", "e-branch", "elsewhere", "branch", 2),
        ),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = branch_held(&server, dir.path());
        server.on("/events", vec![replay(&[("11", kind, event)])]);
        let before = kept_beside_rows(&core);

        core.catch_up().unwrap();

        assert_eq!(held_of(&core), ["root", "bound", "waiting"], "{kind}");
        assert!(
            server.seen("/items").is_empty(),
            "{kind}: a leaving branch was listed"
        );
        assert_eq!(kept_beside_rows(&core), before, "{kind}");
        // The tree stays held whole, so the branch can come back.
        assert!(held_edge(&core, "e-plain"), "{kind}");
    }
}

#[test]
fn an_edge_event_older_than_the_edge_held_moves_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold(&core, "branch", "active", &[], json!({"title": "branch"}));
    hold_edge(&core, "e-branch", "root", "branch", 3);
    catalog_answers(&server, &[]);
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.updated",
            edge_event("edge.updated", "e-branch", "elsewhere", "branch", 2),
        )])],
    );

    core.catch_up().unwrap();

    assert!(held(&core, "branch"));
}

/// A move of the edge's target end takes `branch` out from under the root
/// and draws `other` in, in one event.
#[test]
fn a_move_of_the_target_end_lets_one_branch_go_and_reads_the_other() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on("/items/bulk-get", vec![read_by_id(&ids(&["other"]))]);
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.updated",
            edge_event("edge.updated", "e-branch", "root", "other", 2),
        )])],
    );

    core.catch_up().unwrap();

    assert!(held(&core, "other"), "the branch drawn in never arrived");
    assert_eq!(held_of(&core), ["root", "bound", "waiting"]);
}

#[test]
fn the_root_trashed_keeps_the_branch_and_the_root_purged_lets_it_go() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![
            replay(&[
                ("11", "item.deleted", binned("root")),
                ("12", "item.deleted", binned("branch")),
                ("13", "item.deleted", binned("plain")),
            ]),
            replay(&[("14", "item.purged", purged("root"))]),
        ],
    );

    core.catch_up().unwrap();
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"],
        "the bin is in the slice"
    );

    core.catch_up().unwrap();
    assert_eq!(held_of(&core), ["bound", "waiting"]);
}

/// The event that draws `moved` in is applied, and `moved` stays owed
/// until a read answers it.
#[test]
fn a_branch_whose_read_fails_is_read_at_the_next_catch_up() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    catalog_answers(&server, &[]);
    server.on(
        "/items/bulk-get",
        vec![
            certified(scripted::refusal(503, "unavailable")),
            read_by_id(&ids(&["moved"])),
        ],
    );
    server.on(
        "/events",
        vec![
            replay(&[(
                "11",
                "edge.created",
                edge_event("edge.created", "e-in", "root", "moved", 1),
            )]),
            at_head("11"),
        ],
    );

    assert!(core.catch_up().is_err());
    assert_eq!(cursor_of(&core).as_deref(), Some("11"));
    assert!(held_edge(&core, "e-in"));
    assert!(!held(&core, "moved"));

    core.catch_up().unwrap();
    assert!(held(&core, "moved"), "the branch was not read again");
}

#[test]
fn hydration_lists_beneath_and_refuses_it_without_parent_of_whole() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following(&server, dir.path(), None);
    catalog_answers(&server, &[]);

    let refused = core.hydrate_sliced(
        &[NOTE.into()],
        SliceTier::Library,
        &[],
        Some(&under_root()),
        &AtomicBool::new(false),
    );
    assert!(matches!(refused, Err(CoreError::Invalid(_))), "{refused:?}");
    assert!(server.seen("/items").is_empty());

    server.on(
        "/edge-types",
        vec![certified(scripted::edge_types(&[(PARENT_OF, None)]))],
    );
    server.on(
        "/items",
        vec![
            listed_page(&[("root", &[])]),
            listed_page(&[("root", &[("e1", "child")]), ("child", &[])]),
            listed_page(&[]),
        ],
    );
    server.on(
        "/edges",
        vec![certified(scripted::json(
            200,
            &json!({"data": [edge_json("e1", "root", "child", 1)], "next_cursor": null})
                .to_string(),
        ))],
    );
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

    let report = core
        .hydrate_sliced(
            &[NOTE.into()],
            SliceTier::Library,
            &[PARENT_OF.into()],
            Some(&under_root()),
            &AtomicBool::new(false),
        )
        .unwrap();

    assert_eq!(report.query, Some(under_root()));
    let listings: Vec<String> = server
        .seen("/items")
        .into_iter()
        .map(|seen| seen.query)
        .collect();
    assert!(
        listings
            .iter()
            .any(|query| query.contains("beneath=root") && !query.contains("tags=")),
        "{listings:?}"
    );
    assert!(
        listings
            .iter()
            .any(|query| query.contains("tags=conflicted-copy") && !query.contains("beneath=")),
        "{listings:?}"
    );
    assert!(held(&core, "root") && held(&core, "child"));
    let counts: Vec<String> = server
        .seen("/items/stats")
        .into_iter()
        .map(|seen| seen.query)
        .collect();
    assert!(
        counts.iter().all(|query| query.contains("beneath=root")),
        "{counts:?}"
    );
}

fn listed_row(id: &str, children: &[(&str, &str)]) -> Value {
    let mut item = row(id, 1, "active", json!({"title": id}));
    let edges: Vec<Value> = children
        .iter()
        .map(|(edge, child)| edge_json(edge, id, child, 1))
        .collect();
    item["edges"] = json!({PARENT_OF: {"data": edges, "next_cursor": null}});
    json!({
        "item": item,
        "metadata": {"item_id": id, "tags": [], "extensions": {}},
        "listed": true,
    })
}

/// A listing page of childless active rows, with the cursor of the next.
fn paged(ids: &[String], next: Option<&str>) -> Answer {
    let data: Vec<Value> = ids.iter().map(|id| listed_row(id, &[])).collect();
    certified(scripted::json(
        200,
        &json!({"data": data, "next_cursor": next}).to_string(),
    ))
}

/// `POST /items/bulk-get` answering each of `ids`, in order.
fn read_by_id(ids: &[String]) -> Answer {
    let items: Vec<Value> = ids
        .iter()
        .map(|id| row(id, 1, "active", json!({"title": id})))
        .collect();
    let metadata: Vec<Value> = ids
        .iter()
        .map(|id| json!({"item_id": id, "tags": []}))
        .collect();
    let listed: Vec<bool> = ids.iter().map(|_| true).collect();
    certified(scripted::json(
        200,
        &json!({"items": items, "metadata": metadata, "listed": listed}).to_string(),
    ))
}

fn ids(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn cursor_of(core: &Core) -> Option<String> {
    store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap()
}

/// The read of `moved` runs ahead of the stream: it draws `late` under
/// `moved` by an edge the stream brings only in the next catch-up.
#[test]
fn a_row_drawn_into_an_entered_branch_after_its_read_arrives() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold_edge(&core, "e-kid", "moved", "kid", 1);
    settled(&core);
    catalog_answers(&server, &[]);
    server.on(
        "/items/bulk-get",
        vec![
            read_drawing(&[
                ("moved", &[("e-kid", "kid"), ("e-late", "late")]),
                ("kid", &[]),
            ]),
            read_by_id(&ids(&["late"])),
        ],
    );
    server.on(
        "/events",
        vec![
            replay(&[(
                "11",
                "edge.created",
                edge_event("edge.created", "e-in", "root", "moved", 1),
            )]),
            replay(&[(
                "12",
                "edge.created",
                edge_event("edge.created", "e-late", "moved", "late", 1),
            )]),
        ],
    );

    core.catch_up().unwrap();
    assert!(held(&core, "moved") && held(&core, "kid"));
    assert!(
        !held(&core, "late"),
        "a row not yet under the root was taken"
    );
    assert!(
        !held_edge(&core, "e-late"),
        "an edge the stream has not brought was taken from the read"
    );

    core.catch_up().unwrap();
    assert!(held(&core, "late"), "the row drawn in later never arrived");
    assert_eq!(
        reads(&server),
        [ids(&["kid", "moved"]), ids(&["late"])],
        "a row was read twice"
    );
}

/// The device draws `top`, which it holds, under the root itself; `top` has
/// a child on the server the copy does not hold. The echo of its own edge
/// finds the edge held already.
#[test]
fn a_branch_the_devices_own_edge_draws_under_the_root_arrives() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold(&core, "top", "active", &[], json!({"title": "top"}));
    hold_edge(&core, "e-child", "top", "child", 1);
    settled(&core);
    catalog_answers(&server, &[]);
    let own = core
        .create_edge(&crate::EdgeDraft {
            source_id: "root".into(),
            target_id: "top".into(),
            edge_type: PARENT_OF.into(),
            properties: serde_json::Map::new(),
            id: None,
        })
        .unwrap()
        .edge_id
        .unwrap();
    assert!(
        crate::slice::beneath_ids(&core.conn().unwrap(), "root")
            .unwrap()
            .contains("top"),
        "the copy holds its own edge before the echo"
    );
    server.on("/items/bulk-get", vec![read_by_id(&ids(&["child"]))]);
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.created",
            edge_event("edge.created", &own, "root", "top", 1),
        )])],
    );

    core.catch_up().unwrap();

    assert!(held(&core, "child"), "the branch's child never arrived");
    assert_eq!(
        reads(&server),
        [ids(&["child"])],
        "a row the copy holds was read"
    );
}

/// `top`, over 250 rows the copy does not hold, is drawn under the root, so
/// the settle reads 251 rows by id in three requests.
fn branch_of_three_reads(server: &Scripted, dir: &Path) -> (Arc<Core>, Vec<Vec<String>>) {
    let core = following_beneath(server, dir);
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    let mut reached: Vec<String> = (0..250).map(|at| format!("k{at:03}")).collect();
    for (at, id) in reached.iter().enumerate() {
        hold_edge(&core, &format!("e{at}"), "top", id, 1);
    }
    settled(&core);
    reached.push("top".into());
    catalog_answers(server, &[]);
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.created",
            edge_event("edge.created", "e-in", "root", "top", 1),
        )])],
    );
    let chunks = reached
        .chunks(crate::http::BULK_GET_LIMIT)
        .map(<[String]>::to_vec)
        .collect();
    (core, chunks)
}

#[test]
fn a_settle_stops_between_reads_keeps_the_reads_made_and_resumes() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (core, chunks) = branch_of_three_reads(&server, dir.path());
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/items/bulk-get",
        vec![
            read_by_id(&chunks[0]),
            Answer::WaitFor {
                ready: Arc::clone(&ready),
                answer: Box::new(read_by_id(&chunks[1])),
            },
            read_by_id(&chunks[2]),
        ],
    );
    let stop = Arc::new(AtomicBool::new(false));
    let caught = {
        let (core, stop) = (Arc::clone(&core), Arc::clone(&stop));
        std::thread::spawn(move || core.catch_up_until(&stop))
    };
    let started = std::time::Instant::now();
    while server.seen("/items/bulk-get").len() < 2 {
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    ready.store(true, std::sync::atomic::Ordering::SeqCst);

    let ended = caught.join().unwrap();
    assert!(
        matches!(&ended, Err(failed) if matches!(failed.error, CoreError::Canceled)),
        "{:?}",
        ended.map(|_| ())
    );
    assert_eq!(reads(&server).len(), 2, "a read was made after the stop");
    assert!(
        chunks[0].iter().all(|id| held(&core, id)),
        "the first read was lost"
    );
    assert!(!held(&core, &chunks[2][0]));

    server.on("/items/bulk-get", vec![read_by_id(&chunks[2])]);
    server.on("/events", vec![at_head("11")]);
    core.catch_up().unwrap();
    assert!(
        chunks.iter().flatten().all(|id| held(&core, id)),
        "the settle did not resume"
    );
    assert_eq!(
        reads(&server)[2..],
        [chunks[2].clone()],
        "the resumed settle read again what it held"
    );
}

#[test]
fn a_settle_that_fails_part_way_keeps_what_arrived_and_the_retry_completes() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (core, chunks) = branch_of_three_reads(&server, dir.path());
    server.on(
        "/items/bulk-get",
        vec![
            read_by_id(&chunks[0]),
            certified(scripted::refusal(503, "unavailable")),
            read_by_id(&chunks[1]),
            read_by_id(&chunks[2]),
        ],
    );

    assert!(core.catch_up().is_err());
    assert!(
        chunks[0].iter().all(|id| held(&core, id)),
        "the read made before the failure was lost"
    );
    assert!(!held(&core, &chunks[1][0]));

    server.on("/events", vec![at_head("11")]);
    core.catch_up().unwrap();
    assert!(
        chunks.iter().flatten().all(|id| held(&core, id)),
        "the retry did not complete the branch"
    );
    assert_eq!(
        reads(&server)[2..],
        chunks[1..],
        "the retry read again what it held"
    );
    assert_eq!(cursor_of(&core).as_deref(), Some("11"));
}

/// Another device imports `count` notes under the root: each is created,
/// then drawn under the root.
fn imported(count: usize) -> (Scripted, tempfile::TempDir, Arc<Core>, Vec<String>) {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    settled(&core);
    catalog_answers(&server, &[]);
    let notes: Vec<String> = (0..count).map(|at| format!("n{at:04}")).collect();
    let mut events = Vec::new();
    for (at, id) in notes.iter().enumerate() {
        let created = json!({
            "event_type": "item.created",
            "item": row(id, 1, "active", json!({"title": id})),
            "metadata": {"tags": []},
            "listed": true,
        })
        .to_string();
        events.push((format!("{}", 11 + 2 * at), "item.created", created));
        events.push((
            format!("{}", 12 + 2 * at),
            "edge.created",
            edge_event("edge.created", &format!("e-{id}"), "root", id, 1),
        ));
    }
    let events: Vec<(&str, &str, String)> = events
        .iter()
        .map(|(id, kind, payload)| (id.as_str(), *kind, payload.clone()))
        .collect();
    server.on("/events", vec![replay(&events)]);
    server.on(
        "/items/bulk-get",
        notes
            .chunks(crate::http::BULK_GET_LIMIT)
            .map(read_by_id)
            .collect(),
    );
    server.on(
        "/items",
        notes
            .iter()
            .map(|id| paged(std::slice::from_ref(id), None))
            .collect(),
    );
    (server, dir, core, notes)
}

#[test]
fn notes_imported_under_the_root_are_read_by_id_in_bulk() {
    let (server, _dir, core, notes) = imported(500);

    core.catch_up().unwrap();

    assert!(notes.iter().all(|id| held(&core, id)));
    let (listings, reads) = (
        server.seen("/items").len(),
        server.seen("/items/bulk-get").len(),
    );
    assert_eq!((listings, reads), (0, 5), "listings and bulk reads");
}

#[test]
fn a_branch_moved_out_and_back_within_one_catch_up_lets_nothing_go() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "branch", 1),
            ),
        ])],
    );
    let before = kept_beside_rows(&core);

    core.catch_up().unwrap();

    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
    assert!(
        server.seen("/items").is_empty() && server.seen("/items/bulk-get").is_empty(),
        "a branch held whole was read again"
    );
    assert_eq!(kept_beside_rows(&core), before);
}

fn listings(server: &Scripted) -> Vec<String> {
    server
        .seen("/items")
        .into_iter()
        .map(|seen| seen.query)
        .chain(
            server
                .seen("/items/bulk-get")
                .into_iter()
                .map(|seen| seen.path),
        )
        .collect()
}

/// `branch_held`, with `branch` also over `kid`, which the copy does not
/// hold, as for a row its key cannot read, and `other` under the root
/// beside it.
fn mixed_branch_held(server: &Scripted, dir: &Path) -> Arc<Core> {
    let core = branch_held(server, dir);
    hold(&core, "other", "active", &[], json!({"title": "other"}));
    hold_edge(&core, "e-other", "root", "other", 1);
    hold_edge(&core, "e-kid", "branch", "kid", 1);
    settled(&core);
    core
}

#[test]
fn the_devices_own_delete_of_a_branch_edge_lets_the_branch_go_at_its_echo() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    core.delete_edge("e-branch").unwrap();
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.deleted",
            edge_event("edge.deleted", "e-branch", "root", "branch", 1),
        )])],
    );

    core.catch_up().unwrap();

    // `branch` stays for the write that names it, still waiting.
    assert_eq!(held_of(&core), ["root", "branch", "bound", "waiting"]);
    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
}

#[test]
fn the_devices_own_move_of_a_branch_edge_out_lets_the_branch_go_at_its_echo() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    hold(
        &core,
        "elsewhere",
        "active",
        &[],
        json!({"title": "elsewhere"}),
    );
    core.update_edge(
        "e-branch",
        &crate::EdgeEdit {
            source_id: Some("elsewhere".into()),
            base_version: Some(1),
            ..crate::EdgeEdit::default()
        },
    )
    .unwrap()
    .unwrap();
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.updated",
            edge_event("edge.updated", "e-branch", "elsewhere", "branch", 2),
        )])],
    );

    core.catch_up().unwrap();

    // `branch` stays for the write that names it, still waiting.
    assert_eq!(held_of(&core), ["root", "branch", "bound", "waiting"]);
    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
}

/// The device deletes the branch's edge, a catch-up lets the branch go, and
/// the server then refuses the delete: the edge comes back, and the branch
/// with it. Until the next settle the branch is judged as out, so the
/// refusal, which ends the write that kept `branch`, lets it go, and the
/// settle reads it back.
#[test]
fn a_refused_delete_of_a_branch_edge_brings_the_branch_back() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    let delete = core.delete_edge("e-branch").unwrap();
    server.on("/events", vec![at_head("10"), at_head("10")]);
    core.catch_up().unwrap();
    assert_eq!(held_of(&core), ["root", "branch", "bound", "waiting"]);
    server.on(
        "/items/bulk-get",
        vec![read_by_id(&ids(&["branch", "plain"]))],
    );

    store::record_refusal(&core.conn().unwrap(), &delete, "forbidden", None, false).unwrap();
    assert!(held_edge(&core, "e-branch"));
    assert_eq!(held_of(&core), ["root", "bound", "waiting"]);
    core.catch_up().unwrap();

    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
    assert_eq!(
        reads(&server),
        [ids(&["branch", "plain"])],
        "a row the copy kept was read"
    );
}

/// `branch` moves from `root` to `other`, both under the root: the copy
/// holds the branch as it should already, though not its child `kid`.
#[test]
fn a_move_within_the_root_reads_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = mixed_branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[(
            "11",
            "edge.updated",
            edge_event("edge.updated", "e-branch", "other", "branch", 2),
        )])],
    );

    core.catch_up().unwrap();

    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
}

#[test]
fn a_mixed_branch_moved_out_and_back_reads_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = mixed_branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "branch", 1),
            ),
        ])],
    );

    core.catch_up().unwrap();

    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
}

/// A row of a branch that is out from under the root between two settles is
/// judged as the last settle held the branch.
#[test]
fn a_row_of_a_branch_moved_out_and_back_survives_a_change_between() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            ("12", "item.updated", changed("plain", &[])),
            (
                "13",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "branch", 1),
            ),
        ])],
    );

    core.catch_up().unwrap();

    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
}

/// `branch` gains `fresh` while it is out from under the root, then comes
/// back: `fresh` is under the root now and is read.
#[test]
fn a_branch_out_and_back_reads_a_child_drawn_while_it_was_out() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on("/items/bulk-get", vec![read_by_id(&ids(&["fresh"]))]);
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            (
                "12",
                "edge.created",
                edge_event("edge.created", "e-fresh", "branch", "fresh", 1),
            ),
            (
                "13",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "branch", 1),
            ),
        ])],
    );

    core.catch_up().unwrap();

    assert!(
        held(&core, "fresh"),
        "the child drawn while out was not read"
    );
    assert_eq!(reads(&server), [ids(&["fresh"])]);
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
}

/// `plain` moves away from `branch` while the branch is out from under the
/// root; the branch then comes back without it.
#[test]
fn a_branch_out_and_back_lets_go_of_a_child_moved_away_while_it_was_out() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            (
                "12",
                "edge.updated",
                edge_event("edge.updated", "e-plain", "elsewhere", "plain", 2),
            ),
            (
                "13",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "branch", 1),
            ),
        ])],
    );

    core.catch_up().unwrap();

    assert_eq!(
        held_of(&core),
        ["root", "branch", "bound", "waiting"],
        "a child moved away while its branch was out stayed held"
    );
    assert!(listings(&server).is_empty(), "{:?}", listings(&server));
}

/// `plain` moves from `branch`, out from under the root, to the root
/// itself, and then changes: it is under the root throughout.
#[test]
fn a_child_moved_under_the_root_from_a_branch_out_stays_held_through_a_change() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.deleted",
                edge_event("edge.deleted", "e-branch", "root", "branch", 1),
            ),
            (
                "12",
                "edge.updated",
                edge_event("edge.updated", "e-plain", "root", "plain", 2),
            ),
            ("13", "item.updated", changed("plain", &[])),
        ])],
    );

    core.catch_up().unwrap();

    assert_eq!(held_of(&core), ["root", "plain", "bound", "waiting"]);
    assert!(
        listings(&server).is_empty(),
        "a row the copy held throughout was read back: {:?}",
        listings(&server)
    );
}

/// `moved` is drawn under the root, out again and back in, in one batch:
/// the settle reads its branch once.
#[test]
fn a_branch_in_out_and_in_within_one_batch_is_read_once() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold_edge(&core, "e-leaf", "moved", "leaf", 1);
    settled(&core);
    catalog_answers(&server, &[]);
    server.on(
        "/items/bulk-get",
        vec![read_by_id(&ids(&["leaf", "moved"]))],
    );
    server.on(
        "/events",
        vec![replay(&[
            (
                "11",
                "edge.created",
                edge_event("edge.created", "e-in", "root", "moved", 1),
            ),
            (
                "12",
                "edge.deleted",
                edge_event("edge.deleted", "e-in", "root", "moved", 1),
            ),
            (
                "13",
                "edge.created",
                edge_event("edge.created", "e-again", "root", "moved", 1),
            ),
        ])],
    );

    core.catch_up().unwrap();

    assert_eq!(reads(&server), [ids(&["leaf", "moved"])]);
    assert!(held(&core, "moved") && held(&core, "leaf"));
}

/// A refill keeps the reach of the last settle until its edges are listed:
/// `bound`, unpinned while the refill lists its items, is under the root
/// all the same and stays.
#[test]
fn an_unpin_while_a_refill_lists_its_items_lets_go_of_nothing_under_the_root() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = branch_held(&server, dir.path());
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "60"),
                "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\",\"requested\":\"10\"}\n\n".into(),
            ],
            Then::End,
        )],
    );
    assert!(matches!(
        core.catch_up(),
        Err(CoreError::CopyExpired { .. })
    ));

    catalog_answers(&server, &[]);
    server.on(
        "/edge-types",
        vec![certified(scripted::edge_types(&[(PARENT_OF, None)]))],
    );
    server.on(
        "/keys/current",
        vec![certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read"}}"#,
        ))],
    );
    let ready = Arc::new(AtomicBool::new(false));
    let tree = listed_page(&[
        ("root", &[("e-branch", "branch")]),
        (
            "branch",
            &[
                ("e-plain", "plain"),
                ("e-bound", "bound"),
                ("e-waiting", "waiting"),
            ],
        ),
        ("plain", &[]),
        ("bound", &[]),
        ("waiting", &[]),
    ]);
    server.on(
        "/items",
        vec![
            // The probe of the query, then the listing of the items.
            listed_page(&[("root", &[])]),
            Answer::WaitFor {
                ready: Arc::clone(&ready),
                answer: Box::new(tree),
            },
            listed_page(&[]),
            listed_page(&[]),
        ],
    );
    // The refill reads the pinned row first.
    server.on("/items/bulk-get", vec![read_by_id(&ids(&["bound"]))]);
    let edges: Vec<Value> = [
        ("e-branch", "root", "branch"),
        ("e-plain", "branch", "plain"),
        ("e-bound", "branch", "bound"),
        ("e-waiting", "branch", "waiting"),
    ]
    .iter()
    .map(|(id, source, target)| edge_json(id, source, target, 1))
    .collect();
    server.on(
        "/edges",
        vec![certified(scripted::json(
            200,
            &json!({"data": edges, "next_cursor": null}).to_string(),
        ))],
    );
    let head = scripted::stream(
        vec![scripted::copy_marker("stream_cursor", "60")],
        Then::End,
    );
    let live = scripted::stream(
        vec![
            scripted::copy_marker("stream_cursor", "60"),
            scripted::copy_marker("stream_live", "60"),
        ],
        Then::End,
    );
    server.on("/events", vec![head, live]);
    let refill = {
        let core = Arc::clone(&core);
        std::thread::spawn(move || {
            core.hydrate_sliced(
                &[NOTE.into()],
                SliceTier::Library,
                &[PARENT_OF.into()],
                Some(&under_root()),
                &AtomicBool::new(false),
            )
        })
    };
    let started = std::time::Instant::now();
    while server.seen("/items").len() < 2 {
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        crate::hydrate::listing(&core.conn().unwrap()).unwrap(),
        "the refill is not listing its items"
    );

    assert!(core.unpin("bound").unwrap());
    assert!(
        held(&core, "bound"),
        "a row under the root was let go while the refill listed"
    );

    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    // A change to the pins ends the attempt, which the next one resumes.
    let ended = refill.join().unwrap();
    assert!(
        matches!(&ended, Err(CoreError::StreamIncomplete { reason }) if reason == "local_copy_changed"),
        "{:?}",
        ended.map(|_| ())
    );
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );

    server.on(
        "/items",
        vec![
            listed_page(&[("root", &[])]),
            listed_page(&[
                ("root", &[("e-branch", "branch")]),
                (
                    "branch",
                    &[
                        ("e-plain", "plain"),
                        ("e-bound", "bound"),
                        ("e-waiting", "waiting"),
                    ],
                ),
                ("plain", &[]),
                ("bound", &[]),
                ("waiting", &[]),
            ]),
            listed_page(&[]),
            listed_page(&[]),
        ],
    );
    server.on(
        "/edges",
        vec![certified(scripted::json(
            200,
            &json!({"data": edges, "next_cursor": null}).to_string(),
        ))],
    );
    server.on(
        "/events",
        vec![
            scripted::stream(
                vec![scripted::copy_marker("stream_cursor", "60")],
                Then::End,
            ),
            scripted::stream(
                vec![
                    scripted::copy_marker("stream_cursor", "60"),
                    scripted::copy_marker("stream_live", "60"),
                ],
                Then::End,
            ),
        ],
    );
    let report = core
        .hydrate_sliced(
            &[NOTE.into()],
            SliceTier::Library,
            &[PARENT_OF.into()],
            Some(&under_root()),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(report.in_place, "{:?}", report.restarted);
    assert_eq!(
        held_of(&core),
        ["root", "branch", "plain", "bound", "waiting"]
    );
}

/// The copy held `root` → `a`, then went stale while the server let that
/// edge go; the refill's replay then draws `t` under `a`. The edge to `a`
/// is the copy's past, not the server's tree, so `t` is not under the root.
#[test]
fn a_refill_follows_no_edge_it_has_not_brought_again() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = following_beneath(&server, dir.path());
    hold(&core, "root", "active", &[], json!({"title": "root"}));
    hold(&core, "a", "active", &[], json!({"title": "a"}));
    hold_edge(&core, "e-stale", "root", "a", 1);
    catalog_answers(&server, &[]);
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "60"),
                "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\",\"requested\":\"10\"}\n\n".into(),
            ],
            Then::End,
        )],
    );
    assert!(matches!(
        core.catch_up(),
        Err(CoreError::CopyExpired { .. })
    ));

    catalog_answers(&server, &[]);
    server.on(
        "/edge-types",
        vec![certified(scripted::edge_types(&[(PARENT_OF, None)]))],
    );
    server.on(
        "/keys/current",
        vec![certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read"}}"#,
        ))],
    );
    server.on(
        "/items",
        vec![
            listed_page(&[("root", &[])]),
            listed_page(&[("root", &[])]),
            listed_page(&[]),
            listed_page(&[("t", &[])]),
        ],
    );
    server.on("/items/bulk-get", vec![read_by_id(&ids(&["t"]))]);
    server.on(
        "/edges",
        vec![certified(scripted::json(
            200,
            &json!({"data": [], "next_cursor": null}).to_string(),
        ))],
    );
    let head = scripted::stream(
        vec![scripted::copy_marker("stream_cursor", "60")],
        Then::End,
    );
    let events = scripted::stream(
        vec![
            scripted::copy_marker("stream_cursor", "60"),
            scripted::event(
                "61",
                "edge.created",
                &edge_event("edge.created", "e-t", "a", "t", 1),
            ),
            scripted::copy_marker("stream_live", "61"),
        ],
        Then::End,
    );
    server.on("/events", vec![head, events]);

    let report = core
        .hydrate_sliced(
            &[NOTE.into()],
            SliceTier::Library,
            &[PARENT_OF.into()],
            Some(&under_root()),
            &AtomicBool::new(false),
        )
        .unwrap();

    assert!(report.in_place, "{:?}", report.restarted);
    assert!(
        server.seen("/items/bulk-get").is_empty(),
        "a branch the stale edge reached was read"
    );
    assert!(!held(&core, "t"), "a row the stale edge reached was taken");
    assert!(!held(&core, "a") && !held_edge(&core, "e-stale"));
    assert!(held(&core, "root"));
}
