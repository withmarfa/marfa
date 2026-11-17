use super::testing::*;
use super::*;
use serde_json::json;

#[test]
fn a_pinned_rows_purge_is_remembered_until_it_is_let_go() {
    let conn = testing::conn();
    for id in ["pinned", "unpinned"] {
        put_server_item(
            &conn,
            &testing::note(id, id, "", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
    }
    pin(&conn, "pinned").unwrap();
    assert!(purge_item(&conn, "pinned").unwrap());
    assert!(purge_item(&conn, "unpinned").unwrap());
    assert!(purged(&conn, "pinned").unwrap());
    assert!(!purged(&conn, "unpinned").unwrap());
    pin(&conn, "pinned").unwrap();
    assert!(
        purged(&conn, "pinned").unwrap(),
        "a later pin of the gone row"
    );
    forget_purged(&conn, "pinned").unwrap();
    assert!(!purged(&conn, "pinned").unwrap());
}

/// Every value distinct: the helpers repeat a timestamp, which would hide
/// a positional read shifted by one.
#[test]
fn every_column_lands_in_its_own_field() {
    let conn = conn();
    let row = WireItem {
        id: "positional-1".into(),
        r#type: "core.bookmark".into(),
        properties: json!({ "title": "T", "url": "https://example.invalid" })
            .as_object()
            .unwrap()
            .clone(),
        state: "archived".into(),
        tier: Some("feed".into()),
        version: 7,
        schema_version: 3,
        source: "source-value".into(),
        source_id: Some("source-id-value".into()),
        occurred_at: "1999-12-31T23:59:58Z".into(),
        created_at: "2020-02-02T02:02:02Z".into(),
        updated_at: "2031-03-03T03:03:03Z".into(),
        capture_latitude: Some(51.5),
        capture_longitude: Some(-0.25),
        trashed_at: Some("2032-04-04T04:04:04Z".into()),
        read_only: true,
        edges: None,
    };
    upsert_item(&conn, &row, None, &Indexing::default()).unwrap();

    let item = item_by_id(&conn, "positional-1").unwrap().unwrap();
    assert_eq!(item.id, "positional-1");
    assert_eq!(item.r#type, "core.bookmark");
    assert_eq!(item.state, ItemState::Archived);
    assert_eq!(item.tier, Some(Tier::Feed));
    assert_eq!(item.version, 7);
    assert_eq!(item.schema_version, 3);
    assert_eq!(item.source, "source-value");
    assert_eq!(item.source_id.as_deref(), Some("source-id-value"));
    assert_eq!(item.occurred_at, "1999-12-31T23:59:58Z");
    assert_eq!(item.created_at, "2020-02-02T02:02:02Z");
    assert_eq!(item.updated_at, "2031-03-03T03:03:03Z");
    assert_eq!(item.capture_latitude, Some(51.5));
    assert_eq!(item.capture_longitude, Some(-0.25));
    assert_eq!(item.trashed_at.as_deref(), Some("2032-04-04T04:04:04Z"));
    assert!(item.read_only);
    assert_eq!(
        item.properties.get("title").and_then(Value::as_str),
        Some("T")
    );
}

#[test]
fn an_item_round_trips_with_its_tags_and_keeps_them_when_none_are_sent() {
    let conn = conn();
    let note = note("n1", "Hello", "world", "2026-01-01T00:00:00Z");
    upsert_item(
        &conn,
        &note,
        Some(&["a".into(), "b".into()]),
        &Indexing::default(),
    )
    .unwrap();
    let item = item_by_id(&conn, "n1").unwrap().unwrap();
    assert_eq!(item.tags, vec!["a", "b"]);
    assert_eq!(item.properties["title"], "Hello");
    assert_eq!(item.state, ItemState::Active);
    assert_eq!(item.tier, Some(Tier::Library));

    let mut renamed = note.clone();
    renamed.properties = json!({ "title": "Renamed", "body": "world" })
        .as_object()
        .unwrap()
        .clone();
    upsert_item(&conn, &renamed, None, &Indexing::default()).unwrap();
    let item = item_by_id(&conn, "n1").unwrap().unwrap();
    assert_eq!(item.properties["title"], "Renamed");
    assert_eq!(item.tags, vec!["a", "b"]);
    assert_eq!(count(&conn, "items_fts").unwrap(), 1);
}

#[test]
fn tags_read_in_the_order_they_were_first_written() {
    let conn = conn();
    let note = note("n1", "Hello", "world", "2026-01-01T00:00:00Z");
    let written: Vec<String> = ["zeta", "alpha", "mid", "alpha"].map(String::from).into();
    upsert_item(&conn, &note, Some(&written), &Indexing::default()).unwrap();
    let tags = |conn: &Connection| item_by_id(conn, "n1").unwrap().unwrap().tags;
    assert_eq!(tags(&conn), vec!["zeta", "alpha", "mid"]);

    add_tags(&conn, "n1", &["beta".into(), "zeta".into()]).unwrap();
    assert_eq!(tags(&conn), vec!["zeta", "alpha", "mid", "beta"]);
    remove_tag(&conn, "n1", "alpha").unwrap();
    assert_eq!(tags(&conn), vec!["zeta", "mid", "beta"]);
    add_tags(&conn, "n1", &["alpha".into()]).unwrap();
    assert_eq!(tags(&conn), vec!["zeta", "mid", "beta", "alpha"]);
    replace_tags(&conn, "n1", &["b".into(), "a".into(), "b".into()]).unwrap();
    assert_eq!(tags(&conn), vec!["b", "a"]);

    let ids: Vec<String> = (0..1001).map(|n| format!("x{n}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).chain(["n1"]).collect();
    assert_eq!(tags_for(&conn, &ids).unwrap()["n1"], vec!["b", "a"]);
    assert_eq!(tags_for(&conn, &["n1"]).unwrap()["n1"], vec!["b", "a"]);
}

#[test]
fn a_create_answered_with_another_id_moves_everything_onto_it() {
    let conn = conn();
    let indexing = Indexing::default();
    for id in ["local", "server", "other"] {
        upsert_item(
            &conn,
            &note(id, id, "b", "2026-01-01T00:00:00Z"),
            None,
            &indexing,
        )
        .unwrap();
    }
    upsert_edge(&conn, &wire_edge("e1", "local", "other", "references")).unwrap();
    upsert_edge(&conn, &wire_edge("e2", "other", "local", "references")).unwrap();
    upsert_edge(&conn, &wire_edge("e3", "other", "other", "references")).unwrap();
    conn.execute(
        "INSERT INTO queue (id, kind, item_id, to_id, payload, idempotency_key, depends_on, queued_at)
             VALUES ('q1', 'create_edge', 'other', 'local', ?1, 'k1', '[]', ''),
                    ('q2', 'update_item', 'local', NULL, '{}', 'k2', '[]', '')",
        [serde_json::json!({ "from_id": "other", "to_id": "local" }).to_string()],
    )
    .unwrap();

    adopt_answered_id(&conn, "local", "server").unwrap();

    assert!(
        item_by_id(&conn, "local").unwrap().is_none(),
        "the minted row is still held"
    );
    assert!(item_by_id(&conn, "server").unwrap().is_some());
    let endpoints = |id: &str| -> (String, String) {
        conn.query_row(
            "SELECT from_id, to_id FROM edges WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    };
    assert_eq!(endpoints("e1"), ("server".into(), "other".into()));
    assert_eq!(endpoints("e2"), ("other".into(), "server".into()));
    assert_eq!(endpoints("e3"), ("other".into(), "other".into()));
    let queued = |id: &str| -> (Option<String>, Option<String>, String) {
        conn.query_row(
            "SELECT item_id, to_id, payload FROM queue WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    };
    let (item, target, payload) = queued("q1");
    assert_eq!(
        (item.as_deref(), target.as_deref()),
        (Some("other"), Some("server"))
    );
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["from_id"], "other");
    assert_eq!(payload["to_id"], "server");
    assert_eq!(queued("q2").0.as_deref(), Some("server"));
}

#[test]
fn purging_an_item_takes_its_tags_index_row_and_edges() {
    let conn = conn();
    upsert_item(
        &conn,
        &note("n1", "a", "b", "2026-01-01T00:00:00Z"),
        Some(&["t".into()]),
        &Indexing::default(),
    )
    .unwrap();
    upsert_item(
        &conn,
        &note("n2", "c", "d", "2026-01-01T00:00:00Z"),
        None,
        &Indexing::default(),
    )
    .unwrap();
    upsert_edge(&conn, &wire_edge("e1", "n1", "n2", "references")).unwrap();
    upsert_edge(&conn, &wire_edge("e2", "n2", "n1", "references")).unwrap();
    pin(&conn, "n1").unwrap();
    assert!(purge_item(&conn, "n1").unwrap());
    assert!(!purge_item(&conn, "n1").unwrap());
    assert!(!pinned(&conn, "n1").unwrap());
    assert_eq!(count(&conn, "tags").unwrap(), 0);
    assert_eq!(count(&conn, "items_fts").unwrap(), 1);
    assert_eq!(count(&conn, "edges").unwrap(), 0);
    assert!(!item_held(&conn, "n1").unwrap());
    assert!(item_held(&conn, "n2").unwrap());
}

#[test]
fn evicting_an_item_keeps_the_edges_drawn_to_it() {
    let conn = conn();
    for id in ["n1", "n2"] {
        upsert_item(
            &conn,
            &note(id, "a", "b", "2026-01-01T00:00:00Z"),
            Some(&["t".into()]),
            &Indexing::default(),
        )
        .unwrap();
    }
    upsert_edge(&conn, &wire_edge("from", "n1", "n2", "references")).unwrap();
    upsert_edge(&conn, &wire_edge("toward", "n2", "n1", "references")).unwrap();
    assert!(evict_item(&conn, "n1", &[]).unwrap());
    assert!(!evict_item(&conn, "n1", &[]).unwrap());
    assert_eq!(count(&conn, "tags").unwrap(), 1);
    assert_eq!(count(&conn, "items_fts").unwrap(), 1);
    let left: Vec<String> = edges_from(&conn, "n2")
        .unwrap()
        .into_iter()
        .map(|edge| edge.id)
        .collect();
    assert_eq!(left, ["toward"]);
    assert!(edges_from(&conn, "n1").unwrap().is_empty());
    assert!(!item_held(&conn, "n1").unwrap());
    assert!(purge_item(&conn, "n1").unwrap());
    assert!(edges_from(&conn, "n2").unwrap().is_empty());
}

/// A create answered with a row the body rule or a folder line pinned
/// lands its own pin there, which their release must not take
/// (`device/pin-create-lasts`).
#[test]
fn a_create_landing_on_a_row_another_claim_pinned_keeps_its_pin() {
    use crate::folder::state;
    let mut conn = conn();
    for id in ["linked", "linked-alone", "linked-unpinned"] {
        pin(&conn, id).unwrap();
        conn.execute("INSERT INTO body_pins (item_id) VALUES (?1)", [id])
            .unwrap();
    }
    for id in ["lined", "lined-alone", "lined-unpinned"] {
        pin(&conn, id).unwrap();
        state::hold_edge_end(&conn, id, true).unwrap();
    }
    for (minted, answered) in [("minted-a", "linked"), ("minted-b", "lined")] {
        pin(&conn, minted).unwrap();
        adopt_answered_id(&conn, minted, answered).unwrap();
    }
    // A create the copy did not pin leaves each claim its own.
    for (minted, answered) in [
        ("minted-c", "linked-unpinned"),
        ("minted-d", "lined-unpinned"),
    ] {
        adopt_answered_id(&conn, minted, answered).unwrap();
    }

    crate::body::rule::after_answers(&mut conn).unwrap();
    for (id, made) in state::edge_ends(&conn).unwrap() {
        state::release_edge_end(&conn, &id, made).unwrap();
    }

    // The witness: each claim's release takes a pin that is only its own.
    assert_eq!(
        pins(&conn).unwrap(),
        ["lined", "linked"],
        "a create's pin went with a body link's or a folder line's release"
    );
}

#[test]
fn a_pin_moves_to_the_answered_id() {
    let conn = conn();
    assert!(pin(&conn, "minted").unwrap());
    assert!(!pin(&conn, "minted").unwrap());
    adopt_answered_id(&conn, "minted", "answered").unwrap();
    assert_eq!(pins(&conn).unwrap(), ["answered"]);
    pin(&conn, "second").unwrap();
    adopt_answered_id(&conn, "second", "answered").unwrap();
    assert_eq!(pins(&conn).unwrap(), ["answered"]);
    assert!(unpin(&conn, "answered").unwrap());
    assert!(!pinned(&conn, "answered").unwrap());
}

#[test]
fn what_the_body_rule_and_the_folder_hold_of_a_minted_id_moves_to_the_answered_id() {
    let conn = conn();
    for statement in [
        "INSERT INTO body_checks (write_id, item_id, body) VALUES ('check', 'minted', '')",
        "INSERT INTO body_edges (write_id, item_id, kind, other_id) VALUES ('from', 'minted', 'link', 'other')",
        "INSERT INTO body_edges (write_id, item_id, kind, other_id) VALUES ('to', 'other', 'link', 'minted')",
        "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('minted', 'link', 'other', 'resolved', 'other')",
        "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('answered', 'link', 'before', 'resolved', 'before')",
        "INSERT INTO body_names (item_id, kind, text, state, other_id) VALUES ('other', 'link', 'new', 'resolved', 'minted')",
        "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, seen_at) VALUES ('New.md', 'minted', 'h', '[]', '[]', '2026-01-01T00:00:00Z')",
        "INSERT INTO folder_journal (path, item_id, missing_since) VALUES ('Gone.md', 'minted', '2026-01-01T00:00:00Z')",
    ] {
        conn.execute(statement, []).unwrap();
    }
    adopt_answered_id(&conn, "minted", "answered").unwrap();
    let rows = |sql: &str| -> Vec<String> {
        let mut statement = conn.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(rows("SELECT item_id FROM body_checks"), ["answered"]);
    assert_eq!(
        rows("SELECT item_id || '>' || other_id FROM body_edges ORDER BY write_id"),
        ["answered>other", "other>answered"]
    );
    assert_eq!(
        rows("SELECT item_id || ':' || text || '>' || other_id FROM body_names ORDER BY item_id"),
        ["answered:other>other", "other:new>answered"],
        "the names the create's body carries are not the row's"
    );
    assert_eq!(rows("SELECT item_id FROM folder_files"), ["answered"]);
    assert_eq!(rows("SELECT item_id FROM folder_journal"), ["answered"]);
}

#[test]
fn an_unknown_state_is_refused_before_it_is_written() {
    let conn = conn();
    let item = wire_item("x", "core.note", "limbo", "2026-01-01T00:00:00Z", json!({}));
    assert!(matches!(
        upsert_item(&conn, &item, None, &Indexing::default()),
        Err(CoreError::Decoding(_))
    ));
    assert_eq!(count(&conn, "items").unwrap(), 0);
}
