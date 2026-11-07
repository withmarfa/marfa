//! An item's `read_only` in the copy: what an answer brings, what a copy made
//! before it held the flag becomes, what the copy learns with no event, and
//! that the flag never stops a write.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::scripted::{self, Answer, Scripted, Then, certified};
use crate::stop_tests::{copy, copy_in_keyed};
use crate::wire::WireCatalog;
use crate::{Core, CoreError, Draft, Edit, Item, Server, store};

const NOTE: &str = "core.note";
const BOOKMARK: &str = "core.bookmark";
const MADE_HERE: &str = "019a0000-0000-7000-8000-000000000001";
const AT: &str = "2026-01-01T00:00:00Z";

fn row(id: &str, version: i64, read_only: Option<bool>) -> Value {
    let mut row = json!({
        "id": id, "type": NOTE, "properties": {"title": id}, "state": "active",
        "tier": "library", "version": version, "schema_version": 1, "source": "test",
        "occurred_at": AT, "created_at": AT, "updated_at": AT,
    });
    if let Some(read_only) = read_only {
        row["read_only"] = json!(read_only);
    }
    row
}

fn frame(kind: &str, item: Value) -> String {
    json!({"event_type": kind, "item": item, "metadata": {"tags": []}, "listed": true}).to_string()
}

/// One catch-up's stream: each event as `(id, payload)`, then the marker that
/// says it is live.
fn replay(events: &[(&str, String)]) -> Answer {
    let first = events.first().map_or("10", |(id, _)| id);
    let last = events.last().map_or("10", |(id, _)| id);
    let mut frames = vec![
        scripted::connected(),
        scripted::copy_marker("stream_cursor", first),
    ];
    frames.extend(events.iter().map(|(id, payload)| {
        let kind = serde_json::from_str::<Value>(payload).unwrap();
        scripted::event(id, kind["event_type"].as_str().unwrap(), payload)
    }));
    frames.push(scripted::copy_marker("stream_live", last));
    scripted::stream(frames, Then::End)
}

/// `POST /items/bulk-get` answering each row as `(id, source, read_only)`.
fn asked(rows: &[(&str, &str, Option<bool>)]) -> Answer {
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, source, read_only)| {
            let mut item = row(id, 1, *read_only);
            item["source"] = json!(source);
            item
        })
        .collect();
    certified(scripted::json(
        200,
        &json!({"items": items, "metadata": [], "listed": []}).to_string(),
    ))
}

fn put(core: &Core, id: &str, source: &str, read_only: bool) {
    let mut row: crate::wire::WireItem =
        serde_json::from_value(row(id, 1, Some(read_only))).unwrap();
    row.source = source.into();
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    crate::reach::set_listed(&conn, &row.id, true).unwrap();
    store::put_server_item(&conn, &row, Some(&[]), &catalog).unwrap();
    store::lay_waiting_writes_over(&conn, &row.id, &|type_id| catalog.indexing(type_id)).unwrap();
}

/// The server and the copy agree on the catalog, so a catch-up changes none
/// of it and `changes_since` can name rows.
fn holding_the_servers_catalog(server: &Scripted, core: &Core) {
    store::replace_catalog(
        &core.conn().unwrap(),
        &WireCatalog {
            types: vec![
                store::testing::wire_type(NOTE, None, Some("title")),
                store::testing::wire_type(BOOKMARK, None, Some("title")),
            ],
            edge_types: Vec::new(),
        },
    )
    .unwrap();
    store::meta_set(&core.conn().unwrap(), store::META_SLICE_EDGE_TYPES, "[]").unwrap();
    server.on(
        "/types",
        vec![certified(scripted::types(&[
            (NOTE, None),
            (BOOKMARK, None),
        ]))],
    );
    server.on("/events", vec![replay(&[])]);
}

fn held_copy(server: &Scripted) -> Arc<Core> {
    let core = copy(server);
    holding_the_servers_catalog(server, &core);
    core
}

/// As a copy long past its last look, whichever the store it holds.
fn owed(core: &Core) {
    store::meta_set(&core.conn().unwrap(), store::META_READ_ONLY_READ, "0").unwrap();
}

fn held(core: &Core, id: &str) -> Item {
    core.get(id).unwrap().unwrap()
}

fn flag(core: &Core, id: &str) -> bool {
    held(core, id).read_only
}

fn titled(title: &str) -> Edit {
    let mut properties = Map::new();
    properties.insert("title".into(), json!(title));
    Edit {
        properties,
        base_version: Some(1),
        ..Edit::default()
    }
}

fn title(item: &Item) -> &str {
    item.properties["title"].as_str().unwrap()
}

fn beneath(core: &Core, id: &str) -> Value {
    let kept: String = core
        .conn()
        .unwrap()
        .query_row(
            "SELECT row FROM beneath WHERE subject = 'item' AND id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&kept).unwrap()
}

fn asks(server: &Scripted) -> usize {
    server.seen("/items/bulk-get").len()
}

#[test]
fn an_event_without_the_field_holds_false_and_one_with_it_holds_what_it_says() {
    let server = Scripted::start();
    let core = held_copy(&server);
    let follows =
        |id, version, read_only| (id, frame("item.updated", row("a", version, read_only)));

    server.on(
        "/events",
        vec![replay(&[("11", frame("item.created", row("a", 1, None)))])],
    );
    core.catch_up().unwrap();
    assert!(!flag(&core, "a"), "a row with no answer read true");

    server.on("/events", vec![replay(&[follows("12", 2, Some(true))])]);
    core.catch_up().unwrap();
    assert!(flag(&core, "a"), "a later event did not raise the flag");

    server.on("/events", vec![replay(&[follows("13", 3, Some(false))])]);
    core.catch_up().unwrap();
    assert!(!flag(&core, "a"), "a later event did not lower the flag");
}

#[test]
fn a_flag_that_flips_with_no_event_reaches_every_row_of_its_source_and_type() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    put(&core, "b", "connector", false);
    put(&core, "c", "other", false);
    owed(&core);
    let before = store::copy_revision(&core.conn().unwrap()).unwrap();
    let changes = core.changes_since(None, 100).unwrap().cursor;
    server.on(
        "/items/bulk-get",
        vec![asked(&[
            ("a", "connector", Some(true)),
            ("c", "other", Some(false)),
        ])],
    );

    let report = core.catch_up().unwrap();

    assert_eq!(report.applied, 2);
    assert!(flag(&core, "a") && flag(&core, "b"));
    assert!(!flag(&core, "c"));
    assert_eq!(
        held(&core, "a").version,
        1,
        "a flag moved the row's version"
    );
    assert_eq!(
        server.seen("/items/bulk-get").len(),
        1,
        "the copy read more than one row of a source and type"
    );
    let sent: Value = serde_json::from_slice(&server.seen("/items/bulk-get")[0].body).unwrap();
    assert_eq!(sent["ids"].as_array().unwrap().len(), 2, "{sent}");
    assert!(store::copy_revision(&core.conn().unwrap()).unwrap() > before);
    let mut told = core.changes_since(Some(&changes), 100).unwrap().items;
    told.sort();
    assert_eq!(told, ["a", "b"], "an app was not told what moved");

    server.on(
        "/items/bulk-get",
        vec![asked(&[("a", "connector", Some(false))])],
    );
    owed(&core);
    core.catch_up().unwrap();
    assert!(
        !flag(&core, "a") && !flag(&core, "b"),
        "it did not flip back"
    );
}

#[test]
fn a_copy_that_looked_within_the_interval_asks_nothing() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);

    core.catch_up().unwrap();
    assert_eq!(asks(&server), 0);

    // The witness: the same copy past its interval does ask.
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("a", "connector", Some(false))])],
    );
    core.catch_up().unwrap();
    assert_eq!(asks(&server), 1);
    core.catch_up().unwrap();
    assert_eq!(asks(&server), 1, "the look was not recorded");
}

#[test]
fn a_clock_set_back_past_the_last_look_owes_one() {
    let server = Scripted::start();
    let core = held_copy(&server);
    let conn = core.conn().unwrap();
    let every = std::time::Duration::from_secs(60);
    store::meta_set(&conn, store::META_READ_ONLY_READ, &u64::MAX.to_string()).unwrap();
    assert!(store::read_only_owed(&conn, every).unwrap());
    store::mark_read_only_read(&conn).unwrap();
    assert!(!store::read_only_owed(&conn, every).unwrap());
}

#[test]
fn an_answer_without_the_field_changes_nothing() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", true);
    owed(&core);
    server.on("/items/bulk-get", vec![asked(&[("a", "connector", None)])]);

    assert_eq!(core.catch_up().unwrap().applied, 0);

    assert!(flag(&core, "a"), "a server that does not say cleared it");
}

#[test]
fn a_row_the_server_leaves_out_of_its_answer_changes_nothing() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", true);
    put(&core, "b", "other", false);
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("b", "other", Some(true))])],
    );

    core.catch_up().unwrap();

    assert!(flag(&core, "a"));
    assert!(flag(&core, "b"), "the rows answered were not held to it");
}

#[test]
fn a_failed_look_leaves_the_catch_up_and_is_owed_again() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![
            scripted::json(500, "{}"),
            asked(&[("a", "connector", Some(true))]),
        ],
    );

    core.catch_up().unwrap();
    assert!(!flag(&core, "a"));
    assert_eq!(asks(&server), 1);

    core.catch_up().unwrap();
    assert_eq!(asks(&server), 2, "a failed look was counted as made");
    assert!(flag(&core, "a"));
}

#[test]
fn a_look_answered_outside_the_copys_reach_expires_it_as_any_read_does() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    let waiting = core.update_item("a", &titled("kept")).unwrap();
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![scripted::json(200, r#"{"items":[],"metadata":[]}"#)],
    );

    assert!(matches!(
        core.catch_up(),
        Err(CoreError::CopyExpired { reason }) if reason == "reach_invalid"
    ));

    let queue = core.queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, waiting.id);
}

#[test]
fn a_row_the_server_has_not_taken_stays_false_until_it_answers() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    let created = core
        .create_item(&Draft {
            r#type: NOTE.into(),
            id: Some(MADE_HERE.into()),
            properties: titled("new").properties,
            source: Some("connector".into()),
            ..Draft::default()
        })
        .unwrap();
    assert!(!flag(&core, MADE_HERE));
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("a", "connector", Some(true))])],
    );

    core.catch_up().unwrap();

    assert!(flag(&core, "a"));
    assert!(
        !flag(&core, MADE_HERE),
        "a local create took the server's flag"
    );
    let sent: Value = serde_json::from_slice(&server.seen("/items/bulk-get")[0].body).unwrap();
    assert_eq!(sent["ids"], json!(["a"]), "the copy asked of an unsent row");
    assert_eq!(core.queue().unwrap()[0].id, created.id);
}

#[test]
fn a_row_with_a_waiting_edit_takes_the_flag_and_keeps_the_edit() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    put(&core, "b", "connector", false);
    core.update_item("a", &titled("waiting")).unwrap();
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("b", "connector", Some(true))])],
    );

    core.catch_up().unwrap();

    let item = held(&core, "a");
    assert!(item.read_only);
    assert_eq!(title(&item), "waiting", "the flag took a waiting edit");
    assert_eq!(beneath(&core, "a")["read_only"], json!(true));
    assert_eq!(
        beneath(&core, "a")["properties"]["title"],
        json!("a"),
        "the row beneath took the edit"
    );
    assert_eq!(core.queue().unwrap().len(), 1);
}

#[test]
fn a_row_retyped_by_a_waiting_edit_answers_to_the_type_the_server_holds() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    put(&core, "b", "connector", false);
    core.update_item(
        "a",
        &Edit {
            r#type: Some(BOOKMARK.into()),
            ..titled("retyped")
        },
    )
    .unwrap();
    assert_eq!(held(&core, "a").r#type, BOOKMARK);
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("b", "connector", Some(true))])],
    );

    core.catch_up().unwrap();

    assert!(flag(&core, "a"), "the row was judged by its waiting type");
}

#[test]
fn a_row_in_the_bin_takes_the_flag_of_its_source_and_type() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    put(&core, "b", "connector", false);
    let mut binned = row("b", 2, Some(false));
    binned["state"] = json!("trashed");
    binned["source"] = json!("connector");
    binned["trashed_at"] = json!(AT);
    server.on(
        "/events",
        vec![replay(&[("11", frame("item.updated", binned))])],
    );
    core.catch_up().unwrap();
    owed(&core);
    server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::connected(),
                scripted::copy_marker("stream_cursor", "11"),
                scripted::copy_marker("stream_live", "11"),
            ],
            Then::End,
        )],
    );
    server.on(
        "/items/bulk-get",
        vec![asked(&[("a", "connector", Some(true))])],
    );

    core.catch_up().unwrap();

    let ids: Vec<String> = serde_json::from_slice::<Value>(&server.seen("/items/bulk-get")[0].body)
        .unwrap()["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids,
        ["a"],
        "a row in the bin was asked of, which a server may omit"
    );
    assert!(
        core.get_items_kept(&["b".into()], true).unwrap().rows[0]
            .0
            .read_only
    );
}

#[test]
fn an_edit_of_a_read_only_row_is_sent_and_lands_with_the_flag_kept() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", true);

    core.update_item("a", &titled("changed")).unwrap();
    let local = held(&core, "a");
    assert_eq!(title(&local), "changed");
    assert!(local.read_only, "the waiting edit cleared the flag");

    let mut landed = row("a", 2, Some(true));
    landed["properties"]["title"] = json!("changed");
    landed["source"] = json!("connector");
    server.on(
        "/items/a",
        vec![
            scripted::json(200, "{\"ok\":true}"),
            certified(scripted::json(
                200,
                &json!({"item": landed, "metadata": {"item_id": "a", "tags": []}, "listed": true})
                    .to_string(),
            )),
        ],
    );
    core.drain().unwrap();

    let sent = server.seen("/items/a");
    assert!(
        String::from_utf8_lossy(&sent[0].body).contains("changed"),
        "the edit was not sent: {sent:?}"
    );
    assert_eq!(
        core.queue().unwrap()[0].verdict,
        Some(crate::model::Verdict::Accepted),
        "the write did not land"
    );
    let item = held(&core, "a");
    assert_eq!((title(&item), item.version), ("changed", 2));
    assert!(item.read_only);
}

#[test]
fn a_delete_and_a_create_are_not_stopped_by_the_flag() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", true);

    core.delete_item("a").unwrap();
    core.create_item(&Draft {
        r#type: NOTE.into(),
        properties: titled("new").properties,
        source: Some("connector".into()),
        ..Draft::default()
    })
    .unwrap();

    assert_eq!(core.queue().unwrap().len(), 2);
}

/// Takes the store back to how a build before `read_only` left it.
fn from_before_the_field(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "UPDATE beneath SET row = json_remove(row, '$.read_only');
         DELETE FROM meta WHERE key = 'read_only_read_at';
         DROP INDEX items_read_only;
         ALTER TABLE items DROP COLUMN read_only;",
    )
    .unwrap();
}

#[test]
fn a_copy_from_before_the_field_opens_with_its_work_and_learns_the_flags_at_its_next_sync() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = copy_in_keyed(&server, dir.path(), "k");
    holding_the_servers_catalog(&server, &core);
    for id in ["edited", "blocked", "plain"] {
        put(&core, id, "connector", false);
    }
    put(&core, "other", "other", false);
    core.update_item("blocked", &titled("blocked here"))
        .unwrap();
    server.on(
        "/items/blocked",
        vec![scripted::refusal(409, "version_conflict")],
    );
    core.drain().unwrap();
    core.update_item("edited", &titled("edited here")).unwrap();
    core.create_item(&Draft {
        r#type: NOTE.into(),
        id: Some(MADE_HERE.into()),
        properties: titled("made here").properties,
        source: Some("connector".into()),
        ..Draft::default()
    })
    .unwrap();
    let queue = core.queue().unwrap();
    assert_eq!(queue.len(), 3, "{queue:?}");
    assert!(
        queue
            .iter()
            .any(|write| write.verdict == Some(crate::model::Verdict::Blocked)),
        "no write was left blocked: {queue:?}"
    );
    drop(core);
    from_before_the_field(&path);

    let server_at = Server {
        url: server.url(),
        key: "k".into(),
    };
    let core = Core::open(&path, Some(server_at.clone())).unwrap();
    assert_eq!(core.queue().unwrap(), queue, "opening moved the queue");
    assert_eq!(title(&held(&core, "edited")), "edited here");
    assert_eq!(title(&held(&core, "blocked")), "blocked here");
    assert_eq!(title(&held(&core, MADE_HERE)), "made here");
    assert!(!flag(&core, "edited"), "an old row read other than false");
    assert_eq!(beneath(&core, "edited").get("read_only"), None);
    assert!(core.pending_landings().is_ok());
    server.on(
        "/items/bulk-get",
        vec![asked(&[
            ("plain", "connector", Some(true)),
            ("other", "other", Some(false)),
        ])],
    );

    core.catch_up().unwrap();

    assert_eq!(
        asks(&server),
        1,
        "a copy with no look on record did not ask"
    );
    for id in ["plain", "edited", "blocked"] {
        assert!(flag(&core, id), "{id} did not learn its flag");
    }
    assert!(!flag(&core, "other"));
    assert!(!flag(&core, MADE_HERE));
    assert_eq!(core.queue().unwrap(), queue, "the sync moved the queue");
    assert_eq!(title(&held(&core, "edited")), "edited here");
    assert_eq!(title(&held(&core, "blocked")), "blocked here");
    assert_eq!(beneath(&core, "edited")["read_only"], json!(true));
    assert_eq!(
        beneath(&core, "edited")["properties"]["title"],
        json!("edited")
    );

    drop(core);
    let core = Core::open(&path, Some(server_at)).unwrap();
    assert!(flag(&core, "plain"), "a reopen lost the flag");
    assert_eq!(core.queue().unwrap(), queue);
}

#[test]
fn a_row_beneath_written_before_the_field_is_read_and_lands_false() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    core.update_item("a", &titled("waiting")).unwrap();
    core.conn()
        .unwrap()
        .execute_batch("UPDATE beneath SET row = json_remove(row, '$.read_only')")
        .unwrap();
    assert_eq!(beneath(&core, "a").get("read_only"), None);
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("a", "connector", Some(false))])],
    );

    assert_eq!(core.catch_up().unwrap().applied, 0);

    assert_eq!(title(&held(&core, "a")), "waiting");
    assert!(!flag(&core, "a"));
}

#[test]
fn a_row_beneath_that_cannot_be_read_is_left_as_it_was() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(&core, "a", "connector", false);
    put(&core, "b", "connector", false);
    core.update_item("a", &titled("waiting")).unwrap();
    core.conn()
        .unwrap()
        .execute_batch("UPDATE beneath SET row = 'not json' WHERE id = 'a'")
        .unwrap();
    owed(&core);
    server.on(
        "/items/bulk-get",
        vec![asked(&[("b", "connector", Some(true))])],
    );

    core.catch_up().unwrap();

    assert!(flag(&core, "b"), "one unreadable row stopped the others");
    let kept: String = core
        .conn()
        .unwrap()
        .query_row("SELECT row FROM beneath WHERE id = 'a'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(kept, "not json");
}
