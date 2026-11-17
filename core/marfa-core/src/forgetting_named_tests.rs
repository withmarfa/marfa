use super::*;

fn answered(conn: &Connection, id: &str) {
    conn.execute("INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at) VALUES (?1, 'add_tag', ?1, '{}', 'accepted', 1, '[]', '2026-01-01T00:00:00Z')", [id]).unwrap();
}

/// A body's edge create the server refused as a duplicate: the body rule
/// reads that answer and discards the row.
fn pending_body_duplicate() -> (Core, String) {
    let core = Core::open_in_memory(None).unwrap();
    let note = |title: &str, body: String| {
        core.create_item(&Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({"title": title, "body": body})
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap()
    };
    let target = note("Target", "".into());
    note("Host", format!("[[{}]]", target.item_id.unwrap()));
    let edge = core
        .queue()
        .unwrap()
        .into_iter()
        .find(|row| row.kind == WriteKind::CreateEdge)
        .expect("body link queued its edge")
        .id;
    {
        let conn = core.conn().unwrap();
        conn.execute(
            "UPDATE queue SET verdict='accepted', sent=1 WHERE kind='create_item'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE queue SET verdict='refused', sent=1, answer=?2 WHERE id=?1",
            rusqlite::params![edge, r#"{"error":{"details":{"constraint":"duplicate"}}}"#],
        )
        .unwrap();
        answered(&conn, "consumed");
        assert!(store::queued_write(&conn, &edge).unwrap().is_some());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM body_edges WHERE write_id=?1",
                [&edge],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    (core, edge)
}

#[test]
fn forgetting_named_writes_leaves_a_body_answer_nobody_named() {
    let (core, edge) = pending_body_duplicate();
    assert_eq!(core.forget_answered_ids(&["consumed".into()]).unwrap(), 1);
    assert!(
        core.queue().unwrap().iter().any(|row| row.id == edge),
        "the body rule discarded a refused edge create nobody named"
    );
    // The witness, and the later call that does take it: the body rule
    // still reads the answer, so clearing everything discards it.
    core.forget_answered().unwrap();
    assert!(
        core.queue().unwrap().iter().all(|row| row.id != edge),
        "the body rule did not read the answer it was left"
    );
}

#[test]
fn forgetting_the_body_answer_by_name_takes_it() {
    let (core, edge) = pending_body_duplicate();
    core.forget_answered_ids(std::slice::from_ref(&edge))
        .unwrap();
    let left = core.queue().unwrap();
    assert!(
        left.iter().all(|row| row.id != edge),
        "a refused edge create that was named stayed"
    );
    assert!(left.iter().any(|row| row.id == "consumed"));
}

#[test]
fn forgetting_no_names_changes_nothing() {
    let (core, edge) = pending_body_duplicate();
    let before = core.queue().unwrap();
    assert_eq!(core.forget_answered_ids(&[]).unwrap(), 0);
    assert_eq!(
        core.queue().unwrap(),
        before,
        "an empty list changed the queue while returning zero"
    );
    assert!(before.iter().any(|row| row.id == edge));
}

#[test]
fn a_long_list_of_odd_ids_names_only_what_it_says() {
    let core = Core::open_in_memory(None).unwrap();
    let conn = core.conn().unwrap();
    answered(&conn, "kept");
    answered(&conn, "selected");
    let mut ids: Vec<String> = (0..40_000).map(|i| format!("unknown-{i}")).collect();
    ids.extend([
        "selected".into(),
        "selected".into(),
        "quote\"slash\\".into(),
        "nul\0id".into(),
    ]);
    assert_eq!(store::forget_answered_ids(&conn, &ids).unwrap(), 1);
    assert!(store::queued_write(&conn, "kept").unwrap().is_some());
}

#[test]
fn another_core_on_the_file_cannot_forget() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.db");
    let writer = Core::open(&path, None).unwrap();
    let other = Core::open(&path, None).unwrap();
    answered(&writer.conn().unwrap(), "selected");
    assert_eq!(
        other.forget_answered_ids(&["selected".into()]),
        Err(CoreError::ReadingHandle)
    );
    assert_eq!(writer.forget_answered_ids(&["selected".into()]).unwrap(), 1);
}

#[test]
fn forgetting_a_named_leftover_behind_a_withdrawn_write_takes_it() {
    let core = Core::open_in_memory(None).unwrap();
    {
        let conn = core.conn().unwrap();
        conn.execute("INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at) VALUES ('leftover', 'delete_item', 'leftover', '{}', 'refused', 0, '[\"withdrawn\"]', '2026-01-01T00:00:00Z')", []).unwrap();
        answered(&conn, "other");
    }
    assert_eq!(core.forget_answered_ids(&["leftover".into()]).unwrap(), 1);
    let left: Vec<_> = core.queue().unwrap().into_iter().map(|w| w.id).collect();
    assert_eq!(left, vec!["other".to_string()]);
}
