use super::testing::*;
use super::*;

#[test]
fn each_change_to_the_copy_names_the_items_it_touches() {
    let conn = testing::conn();
    let since = |from: i64| changed_since(&conn, Changes::Items, from, 8).unwrap();
    let ids = |names: &[&str]| Some(names.iter().map(|id| id.to_string()).collect());
    let empty = marfa_rules::catalog::Catalog::empty();
    let from = last_change(&conn, Changes::Items).unwrap();
    for id in ["a", "b", "c"] {
        put_server_item(
            &conn,
            &note(id, id, "", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &empty,
        )
        .unwrap();
    }
    assert_eq!(since(from), ids(&["a", "b", "c"]));

    let from = last_change(&conn, Changes::Items).unwrap();
    assert_eq!(since(from), ids(&[]));
    put_server_edge(&conn, &wire_edge("a-b", "a", "b", "references")).unwrap();
    assert_eq!(since(from), ids(&["a", "b"]));

    let from = last_change(&conn, Changes::Items).unwrap();
    pin(&conn, "c").unwrap();
    assert_eq!(since(from), ids(&["c"]));

    // A change to the types reaches every item, as does one past `most`.
    let from = last_change(&conn, Changes::Items).unwrap();
    replace_types(&conn, &[wire_type("acme.photo", None, None)]).unwrap();
    assert_eq!(since(from), None);
    let from = last_change(&conn, Changes::Items).unwrap();
    for id in 0..9 {
        let id = format!("n{id}");
        put_server_item(
            &conn,
            &note(&id, &id, "", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &empty,
        )
        .unwrap();
    }
    assert_eq!(since(from), None);
    assert_eq!(
        changed_since(&conn, Changes::Items, from, 9)
            .unwrap()
            .map(|ids| ids.len()),
        Some(9)
    );
}

#[test]
fn meta_and_the_hydration_guard() {
    let conn = conn();
    assert_eq!(version(&conn).unwrap(), SCHEMA_VERSION);
    assert_eq!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    );
    meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
    meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
    meta_set(&conn, META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
    meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
    meta_set(&conn, META_SLICE_TIER, "library").unwrap();
    assert!(refuse_unless_hydrated(&conn).is_ok());

    meta_set(&conn, META_SLICE_TYPES, "[]").unwrap();
    assert_eq!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    );
    meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
    meta_delete(&conn, META_SLICE_TIER).unwrap();
    assert_eq!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    );
    meta_set(&conn, META_SLICE_TIER, "library").unwrap();
    meta_delete(&conn, META_EVENT_CURSOR).unwrap();
    assert_eq!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    );
    meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
    meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
    assert!(refuse_unless_hydrated(&conn).is_ok());

    meta_set(&conn, META_HYDRATE_STATE, HYDRATE_IN_PROGRESS).unwrap();
    assert_eq!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    );
    meta_delete(&conn, META_HYDRATE_STATE).unwrap();
    assert!(refuse_unless_hydrated(&conn).is_ok());
}

/// Each table whose change moves the copy's revision, with a row to
/// insert, an update of it and its delete.
const REVISED: [(&str, &str, &str, &str); 8] = [
    (
        "types",
        "INSERT INTO types (id, json) VALUES ('t', '{}')",
        "UPDATE types SET label = 'T' WHERE id = 't'",
        "DELETE FROM types WHERE id = 't'",
    ),
    (
        "edge_types",
        "INSERT INTO edge_types (id, json) VALUES ('e', '{}')",
        "UPDATE edge_types SET json = '{\"id\":\"e\"}' WHERE id = 'e'",
        "DELETE FROM edge_types WHERE id = 'e'",
    ),
    (
        "declared_types",
        "INSERT INTO declared_types (id, json) VALUES ('d', '{}')",
        "UPDATE declared_types SET json = '{\"id\":\"d\"}' WHERE id = 'd'",
        "DELETE FROM declared_types WHERE id = 'd'",
    ),
    (
        "items",
        "INSERT INTO items (id, type, state, version, schema_version, source, occurred_at, created_at, updated_at, properties) VALUES ('i', 'core.note', 'active', 1, 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}')",
        "UPDATE items SET version = 2 WHERE id = 'i'",
        "DELETE FROM items WHERE id = 'i'",
    ),
    (
        "edges",
        "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, created_at, updated_at) VALUES ('g', 'a', 'b', 'references', '{}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        "UPDATE edges SET version = 2 WHERE id = 'g'",
        "DELETE FROM edges WHERE id = 'g'",
    ),
    (
        "tags",
        "INSERT INTO tags (item_id, tag, position) VALUES ('held', 'x', 0)",
        "UPDATE tags SET tag = 'y' WHERE item_id = 'held'",
        "DELETE FROM tags WHERE item_id = 'held'",
    ),
    (
        "pins",
        "INSERT INTO pins (item_id) VALUES ('p')",
        "UPDATE pins SET item_id = 'q' WHERE item_id = 'p'",
        "DELETE FROM pins WHERE item_id = 'q'",
    ),
    (
        "queue",
        "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at) VALUES ('w', 'update_item', 'k', '{}', '2026-01-01T00:00:00Z')",
        "UPDATE queue SET item_id = 'held' WHERE id = 'w'",
        "DELETE FROM queue WHERE id = 'w'",
    ),
];

#[test]
fn the_copy_revision_moves_with_each_change_to_the_copy_or_the_queue_alone() {
    let conn = conn();
    upsert_item(
        &conn,
        &note("held", "t", "b", "2026-01-01T00:00:00Z"),
        None,
        &Indexing::default(),
    )
    .unwrap();
    for (table, insert, update, delete) in REVISED {
        for statement in [insert, update, delete] {
            let before = copy_revision(&conn).unwrap();
            assert_eq!(conn.execute(statement, []).unwrap(), 1, "{statement}");
            assert_eq!(
                copy_revision(&conn).unwrap(),
                before + 1,
                "{table}: {statement}"
            );
        }
    }
    // The witness is each change above; the folder's own record, the
    // file cache's bookkeeping and `meta` itself leave it where it is.
    let before = copy_revision(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, seen_at) VALUES ('a.md', 'held', 'h', '[]', '[]', '2026-01-01T00:00:00Z');
             UPDATE folder_files SET written_hash = 'h' WHERE path = 'a.md';
             INSERT INTO folder_journal (path, item_id, missing_since) VALUES ('a.md', 'held', '2026-01-01T00:00:00Z');
             INSERT INTO folder_stats (path, stat) VALUES ('a.md', '{}');
             INSERT INTO attachment_bytes (hex) VALUES ('00');
             INSERT INTO read_backs (subject, id) VALUES ('item', 'held');",
    )
    .unwrap();
    meta_set(&conn, META_EVENT_CURSOR, "7").unwrap();
    assert_eq!(copy_revision(&conn).unwrap(), before);
    assert_eq!(
        meta_get(&conn, META_COPY_REVISION).unwrap().as_deref(),
        Some(before.to_string().as_str()),
        "the triggers write the key the reader reads"
    );
}

#[test]
fn only_a_write_laid_over_the_copy_changes_it_as_it_leaves_the_queue() {
    let conn = conn();
    let marks = |conn: &Connection| {
        (
            copy_revision(conn).unwrap(),
            last_change(conn, Changes::Items).unwrap(),
        )
    };
    for (verdict, laid_over) in [
        (None, true),
        (Some(Verdict::Blocked), true),
        (Some(Verdict::Dead), true),
        (Some(Verdict::Accepted), false),
        (Some(Verdict::Merged), false),
        (Some(Verdict::Conflicted), false),
        (Some(Verdict::Refused), false),
    ] {
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, to_id, idempotency_key, payload, queued_at, verdict)
                 VALUES ('w', 'create_edge', 'a', 'b', 'k', '{}', '2026-01-01T00:00:00Z', ?1)",
            [verdict.map(Verdict::as_str)],
        )
        .unwrap();
        let (revision, change) = marks(&conn);
        assert_eq!(
            conn.execute("DELETE FROM queue WHERE id = 'w'", [])
                .unwrap(),
            1
        );
        if laid_over {
            assert_eq!(marks(&conn), (revision + 1, change + 1), "{verdict:?}");
            assert_eq!(
                changed_since(&conn, Changes::Items, change, 8).unwrap(),
                Some(["a".to_string(), "b".to_string()].into()),
                "{verdict:?}"
            );
        } else {
            assert_eq!(marks(&conn), (revision, change), "{verdict:?}");
        }
    }
}
