use super::testing::*;
use super::*;

/// The device fixtures reach an edit, a tag and a delete; this reaches
/// the other kinds and their order.
#[test]
fn waiting_writes_are_laid_back_over_the_row_in_queue_order() {
    let conn = conn();
    replace_types(&conn, &[wire_type("core.note", None, Some("title"))]).unwrap();
    let server_row = note(
        "n1",
        "from the server",
        "server body",
        "2026-01-01T00:00:00Z",
    );
    upsert_item(
        &conn,
        &server_row,
        Some(&["kept".into()]),
        &Indexing::default(),
    )
    .unwrap();
    let queue = |kind: WriteKind, payload: &str, tag: Option<&str>| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some("n1"),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag,
                blob: None,
                base_version: None,
                payload,
                depends_on: &[],
            },
        )
        .unwrap()
    };
    queue(
        WriteKind::UpdateItem,
        r#"{"properties":{"title":"edited"},"version":1,"source_id":"moved.md"}"#,
        None,
    );
    queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
    queue(WriteKind::RestoreItem, "{}", None);
    queue(WriteKind::ReplaceTags, r#"{"tags":["a","b"]}"#, None);
    queue(WriteKind::AddTag, r#"{"tags":["c"]}"#, Some("c"));
    queue(WriteKind::RemoveTag, "{}", Some("a"));
    let answered = queue(
        WriteKind::AddTag,
        r#"{"tags":["answered"]}"#,
        Some("answered"),
    );
    record_verdict(
        &conn,
        &answered.id,
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();

    lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
    let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
    assert_eq!(item.properties["title"], "edited");
    assert_eq!(
        item.properties.get("body").and_then(Value::as_str),
        Some("server body"),
        "a field no waiting write names keeps the server's value"
    );
    assert_eq!(item.source_id.as_deref(), Some("moved.md"));
    assert_eq!(item.state, ItemState::Active);
    assert_eq!(item.tags, vec!["b", "c"]);

    queue(WriteKind::DeleteItem, "{}", None);
    lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
    let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
    assert_eq!(item.state, ItemState::Trashed);

    queue(WriteKind::TransitionItem, r#"{"state":"archived"}"#, None);
    lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
    let item = items_by_ids(&conn, &["n1".into()]).unwrap().pop().unwrap();
    assert_eq!(item.state, ItemState::Archived);
}

#[test]
fn a_row_whose_stored_properties_cannot_be_read_is_left_as_it_is_under_its_waiting_writes() {
    let conn = conn();
    let mut edge = wire_edge("e1", "a", "b", "references");
    edge.properties.insert("weight".into(), Value::from(1));
    upsert_edge(&conn, &edge).unwrap();
    upsert_item(
        &conn,
        &note("n1", "t", "b", "2026-01-01T00:00:00Z"),
        Some(&[]),
        &Indexing::default(),
    )
    .unwrap();
    let queue = |kind: WriteKind, item: &str, edge_id: Option<&str>, payload: &str| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some(item),
                to_id: edge_id.map(|_| "b"),
                edge_id,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload,
                depends_on: &[],
            },
        )
        .unwrap()
    };
    queue(
        WriteKind::UpdateEdge,
        "a",
        Some("e1"),
        r#"{"properties":{"weight":2}}"#,
    );
    queue(
        WriteKind::UpdateItem,
        "n1",
        None,
        r#"{"properties":{"title":"edited"},"version":1}"#,
    );
    // The witness: the readable rows take what waits.
    lay_waiting_edge_writes_over(&conn, "e1").unwrap();
    lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
    assert_eq!(
        edge_by_id(&conn, "e1").unwrap().unwrap().properties["weight"],
        2
    );

    for table in ["edges", "items"] {
        conn.execute(&format!("UPDATE {table} SET properties = '{{\"a\":'"), [])
            .unwrap();
    }
    // Damaged and not fetched again, they cannot have the writes laid
    // over them: they stay as they are, and the writes stay queued.
    lay_waiting_edge_writes_over(&conn, "e1").unwrap();
    lay_waiting_writes_over(&conn, "n1", &|_| Indexing::default()).unwrap();
    let stored: String = conn
        .query_row("SELECT properties FROM edges", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, r#"{"a":"#);
    assert_eq!(read_writes(&conn, "", []).unwrap().len(), 2);
}

#[test]
fn waiting_edge_writes_are_laid_back_over_the_edge() {
    let conn = conn();
    let mut edge = wire_edge("e1", "a", "b", "references");
    edge.properties.insert("weight".into(), Value::from(1));
    upsert_edge(&conn, &edge).unwrap();
    let queue = |kind: WriteKind, payload: &str| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some("a"),
                to_id: Some("b"),
                edge_id: Some("e1"),
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload,
                depends_on: &[],
            },
        )
        .unwrap()
    };
    let answered = queue(
        WriteKind::UpdateEdge,
        r#"{"properties":{"note":"answered"}}"#,
    );
    record_verdict(
        &conn,
        &answered.id,
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    queue(WriteKind::UpdateEdge, r#"{"properties":{"weight":2}}"#);
    lay_waiting_edge_writes_over(&conn, "e1").unwrap();
    let held = edge_by_id(&conn, "e1").unwrap().unwrap();
    assert_eq!(held.properties.get("weight"), Some(&Value::from(2)));
    assert_eq!(
        held.properties.get("note"),
        None,
        "an answered write was laid back, and its answer is already the edge"
    );
    queue(WriteKind::DeleteEdge, r#"{"edge_type":"references"}"#);
    lay_waiting_edge_writes_over(&conn, "e1").unwrap();
    assert_eq!(edge_by_id(&conn, "e1").unwrap(), None);
}

#[test]
fn a_landing_orders_the_row_again_by_the_order_writes_were_queued() {
    let conn = conn();
    let queue = |kind: WriteKind, item: &str| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some(item),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: Some(1),
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap()
    };
    let own = queue(WriteKind::UpdateItem, "held");
    let create = queue(WriteKind::CreateItem, "minted");
    let moved = queue(WriteKind::UpdateItem, "minted");
    assert_eq!(moved.follows.as_deref(), Some(create.id.as_str()));
    adopt_answered_id(&conn, "minted", "held").unwrap();
    refollow(&conn, "held", &create.id).unwrap();
    let moved = queued_write(&conn, &moved.id).unwrap().unwrap();
    assert_eq!(
        moved.follows.as_deref(),
        Some(own.id.as_str()),
        "the write moved onto the row does not follow the row's own write ahead of it"
    );
    assert_eq!(queued_write(&conn, &own.id).unwrap().unwrap().follows, None);
}

#[test]
fn a_row_is_older_than_a_later_version_held_or_one_stamped_later_at_the_same() {
    let conn = conn();
    let held_at = "2026-01-01T00:00:01.500Z";
    let mut row = note("row", "title", "body", "2026-01-01T00:00:00Z");
    row.version = 5;
    row.updated_at = held_at.into();
    upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
    let mut edge = wire_edge("link", "row", "row", "references");
    edge.version = 5;
    edge.updated_at = held_at.into();
    upsert_edge(&conn, &edge).unwrap();
    for (subject, id) in [(Subject::Item, "row"), (Subject::Edge, "link")] {
        assert!(holds_later(&conn, subject, id, 4, "2027-01-01T00:00:00Z").unwrap());
        assert!(holds_later(&conn, subject, id, 5, "2026-01-01T00:00:01Z").unwrap());
        // The same instant written another way is a tie, which is no
        // later.
        assert!(!holds_later(&conn, subject, id, 5, "2026-01-01T01:00:01.5+01:00").unwrap());
        assert!(!holds_later(&conn, subject, id, 5, "2026-01-01T00:00:02Z").unwrap());
        assert!(!holds_later(&conn, subject, id, 6, "2020-01-01T00:00:00Z").unwrap());
        // A time that cannot be read leaves the version alone to order.
        assert!(!holds_later(&conn, subject, id, 5, "yesterday").unwrap());
        assert!(!holds_later(&conn, subject, "elsewhere", 1, held_at).unwrap());
    }
}

#[test]
fn a_server_row_never_goes_in_over_a_later_one() {
    let conn = conn();
    let mut later = note("row", "later", "body", "2026-01-01T00:00:00Z");
    later.version = 3;
    later.state = "archived".into();
    later.updated_at = "2026-01-02T00:00:00.000Z".into();
    assert!(put_server_item(&conn, &later, None, &marfa_rules::catalog::Catalog::empty()).unwrap());
    let mut older = later.clone();
    older.state = "active".into();
    older.properties.insert("title".into(), "older".into());
    older.updated_at = "2026-01-01T12:00:00.000Z".into();
    owe_read_back(
        &conn,
        &Owed {
            subject: Subject::Item,
            id: "row".into(),
            from_id: None,
            edge_type: None,
            moved: false,
        },
    )
    .unwrap();
    assert!(
        !put_server_item(&conn, &older, None, &marfa_rules::catalog::Catalog::empty()).unwrap(),
        "a row stamped before the one held went in over it"
    );
    let held = item_by_id(&conn, "row").unwrap().unwrap();
    assert_eq!(held.state, ItemState::Archived);
    assert_eq!(held.properties["title"], "later");
    assert!(
        owed_read_backs(&conn).unwrap().is_empty(),
        "a server row in the copy left the read-back owed for it"
    );

    let mut edge = wire_edge("link", "row", "row", "references");
    edge.version = 2;
    edge.updated_at = "2026-01-02T00:00:00Z".into();
    assert!(put_server_edge(&conn, &edge).unwrap());
    let mut stale = edge.clone();
    stale.version = 1;
    stale.updated_at = "2026-03-01T00:00:00Z".into();
    assert!(!put_server_edge(&conn, &stale).unwrap());
    assert_eq!(edge_by_id(&conn, "link").unwrap().unwrap().version, 2);
}

#[test]
fn taking_a_server_item_lays_the_waiting_writes_over_it_unless_the_copy_holds_a_later_one() {
    let conn = conn();
    let catalog = marfa_rules::catalog::Catalog::empty();
    enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UpdateItem,
            item_id: Some("n1"),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: r#"{"properties":{"title":"edited"},"version":1}"#,
            depends_on: &[],
        },
    )
    .unwrap();
    let mut server = note(
        "n1",
        "from the server",
        "server body",
        "2026-01-01T00:00:00Z",
    );
    server.version = 2;
    server.updated_at = "2026-01-02T00:00:00.000Z".into();
    assert!(take_server_item(&conn, &server, Some(&[]), &catalog).unwrap());
    let held = item_by_id(&conn, "n1").unwrap().unwrap();
    assert_eq!(held.properties["title"], "edited");
    assert_eq!(held.properties["body"], "server body");

    // Queued after the take, so not laid over the held row: a refused
    // take must leave it so.
    enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UpdateItem,
            item_id: Some("n1"),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: r#"{"properties":{"title":"edited again"},"version":2}"#,
            depends_on: &[],
        },
    )
    .unwrap();
    let mut older = server.clone();
    older.version = 1;
    older.updated_at = "2026-01-01T00:00:00.000Z".into();
    older.properties.insert("title".into(), "older".into());
    assert!(!take_server_item(&conn, &older, Some(&[]), &catalog).unwrap());
    assert_eq!(item_by_id(&conn, "n1").unwrap().unwrap(), held);
}

#[test]
fn taking_a_server_edge_lays_the_waiting_writes_over_it_unless_the_copy_holds_a_later_one() {
    let conn = conn();
    enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UpdateEdge,
            item_id: Some("a"),
            to_id: Some("b"),
            edge_id: Some("e1"),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: r#"{"properties":{"weight":2}}"#,
            depends_on: &[],
        },
    )
    .unwrap();
    let mut server = wire_edge("e1", "a", "b", "references");
    server.version = 2;
    server.updated_at = "2026-01-02T00:00:00Z".into();
    server.properties.insert("weight".into(), Value::from(1));
    server
        .properties
        .insert("note".into(), Value::from("server"));
    assert!(take_server_edge(&conn, &server).unwrap());
    let held = edge_by_id(&conn, "e1").unwrap().unwrap();
    assert_eq!(held.properties["weight"], 2);
    assert_eq!(held.properties["note"], "server");

    // Queued after the take, so not laid over the held edge: a refused
    // take must leave it so.
    enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UpdateEdge,
            item_id: Some("a"),
            to_id: Some("b"),
            edge_id: Some("e1"),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: r#"{"properties":{"weight":3}}"#,
            depends_on: &[],
        },
    )
    .unwrap();
    let mut older = server.clone();
    older.version = 1;
    older.updated_at = "2026-01-01T00:00:00Z".into();
    older.properties.insert("note".into(), Value::from("older"));
    assert!(!take_server_edge(&conn, &older).unwrap());
    assert_eq!(edge_by_id(&conn, "e1").unwrap().unwrap(), held);
}
