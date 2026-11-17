#[test]
fn the_stated_size_is_the_largest_whole_number_an_item_states_for_the_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let conn = super::open(&temp.path().join("core.sqlite")).unwrap();
    let put_typed = |id: &str, kind: &str, properties: &str| {
        conn.execute(
            "INSERT INTO items (id, type, state, version, schema_version, source,
                   occurred_at, created_at, updated_at, properties)
                 VALUES (?1, ?3, 'active', 1, 1, 'test', 't', 't', 't', ?2)",
            [id, properties, kind],
        )
        .unwrap();
    };
    let put = |id: &str, properties: &str| put_typed(id, "core.file", properties);
    let stated = |hash: &str| super::stated_size(&conn, hash).unwrap();
    assert_eq!(stated("sha256:aa"), None);
    put("one", r#"{"blob_ref":"sha256:aa","size_bytes":300}"#);
    assert_eq!(stated("sha256:aa"), Some(300));
    put("two", r#"{"blob_ref":"sha256:aa","size_bytes":900}"#);
    put("other", r#"{"blob_ref":"sha256:bb","size_bytes":5000}"#);
    put("text", r#"{"blob_ref":"sha256:aa","size_bytes":"99999"}"#);
    put("zero", r#"{"blob_ref":"sha256:aa","size_bytes":0}"#);
    put("broken", "not json");
    assert_eq!(stated("sha256:aa"), Some(900));
    assert_eq!(stated("sha256:cc"), None);

    // Only a file, or a subtype of one, states the size of its bytes: a
    // note naming the same bytes with a smaller size does not bound them.
    put_typed(
        "note",
        "core.note",
        r#"{"blob_ref":"sha256:dd","size_bytes":10}"#,
    );
    assert_eq!(stated("sha256:dd"), None);
    put_typed(
        "image",
        "core.file.image",
        r#"{"blob_ref":"sha256:dd","size_bytes":400}"#,
    );
    put_typed(
        "lookalike",
        "core.filesystem",
        r#"{"blob_ref":"sha256:dd","size_bytes":9999}"#,
    );
    assert_eq!(stated("sha256:dd"), Some(400));
}

#[test]
fn an_attachment_is_a_held_file_attached_to_a_held_item_out_of_the_bin() {
    let temp = tempfile::tempdir().unwrap();
    let conn = super::open(&temp.path().join("core.sqlite")).unwrap();
    let put = |id: &str, kind: &str, state: &str, properties: &str| {
        conn.execute(
            "INSERT INTO items (id, type, state, version, schema_version, source,
                   occurred_at, created_at, updated_at, properties)
                 VALUES (?1, ?2, ?3, 1, 1, 'test', 't', 't', 't', ?4)",
            [id, kind, state, properties],
        )
        .unwrap();
    };
    let edge = |id: &str, source: &str, target: &str, kind: &str| {
        conn.execute(
            "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version,
                   created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '{}', 1, 't', 't')",
            [id, source, target, kind],
        )
        .unwrap();
    };
    let found = || {
        let found = super::attachments(&conn).unwrap();
        let ids: Vec<String> = found.into_iter().map(|found| found.item_id).collect();
        (ids, super::attachments_not_in_copy(&conn).unwrap())
    };
    put("note", "core.note", "active", "{}");
    put("binned", "core.note", "trashed", "{}");
    put(
        "photo",
        "core.file.image",
        "active",
        r#"{"blob_ref":"sha256:aa","size_bytes":5}"#,
    );
    put(
        "loose",
        "core.file",
        "active",
        r#"{"blob_ref":"sha256:bb"}"#,
    );
    put(
        "to-bin",
        "core.file",
        "active",
        r#"{"blob_ref":"sha256:cc"}"#,
    );
    put(
        "gone",
        "core.file",
        "trashed",
        r#"{"blob_ref":"sha256:dd"}"#,
    );
    put("broken", "core.file", "active", "not json");
    put(
        "lookalike",
        "core.note",
        "active",
        r#"{"blob_ref":"sha256:ee"}"#,
    );
    assert_eq!(found(), (vec![], 0));

    edge("e1", "photo", "note", "attached-to");
    edge("e2", "loose", "note", "references");
    edge("e3", "to-bin", "binned", "attached-to");
    edge("e4", "gone", "note", "attached-to");
    edge("e5", "broken", "note", "attached-to");
    edge("e6", "lookalike", "note", "attached-to");
    edge("e7", "photo", "absent", "attached-to");
    edge("e8", "unheld-file", "note", "attached-to");
    edge("e9", "unheld-file", "binned", "attached-to");
    let (held, outside) = (
        super::attachments(&conn).unwrap(),
        super::attachments_not_in_copy(&conn).unwrap(),
    );
    assert_eq!(
        held,
        [super::Attachment {
            item_id: "photo".into(),
            hash: "sha256:aa".into(),
            stated: Some(5),
        }]
    );
    assert_eq!(outside, 1);

    conn.execute("DELETE FROM edges WHERE id = 'e1'", [])
        .unwrap();
    assert_eq!(found(), (vec![], 1));
}
