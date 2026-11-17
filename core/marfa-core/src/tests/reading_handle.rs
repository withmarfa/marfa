use super::*;

/// A new door reaching the guard only through a helper is the one case
/// this does not see.
#[test]
fn a_reading_handle_is_refused_at_every_write_door() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");

    let writer = Core::open(&path, None).unwrap();
    {
        // Hydrated by hand: an unhydrated store refuses every write anyway,
        // and a case that leaned on that would pass with no lock at all.
        let conn = writer.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::replace_types(
            &conn,
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
    }

    {
        let conn = writer.conn().unwrap();
        for (id, verdict, reason) in [
            ("answered", "accepted", None),
            ("blocked", "blocked", Some("key_spent")),
            ("dead", "dead", None),
        ] {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, 1, '2026-01-01T00:00:00Z')",
                rusqlite::params![id, verdict, reason],
            )
            .unwrap();
        }
    }
    let held = || {
        let conn = writer.conn().unwrap();
        let queue: Vec<String> = conn
            .prepare("SELECT id, verdict, reason, idempotency_key FROM queue ORDER BY seq")
            .unwrap()
            .query_map([], |row| {
                Ok(format!(
                    "{}:{:?}:{:?}:{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?
                ))
            })
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        let items: i64 = conn
            .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
            .unwrap();
        (queue, items)
    };
    let before = held();

    let reader = Core::open(&path, None).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    assert_eq!(writer.handle(), Handle::Writer);

    let draft = Draft {
        r#type: "core.note".into(),
        ..Default::default()
    };
    let edit = Edit {
        base_version: Some(1),
        ..Default::default()
    };
    let folder_changes = serde_json::json!({ "title": "Renamed" })
        .as_object()
        .unwrap()
        .clone();
    let refusals: Vec<(&str, CoreError)> = vec![
        ("create_item", reader.create_item(&draft).unwrap_err()),
        ("update_item", reader.update_item("x", &edit).unwrap_err()),
        (
            "update_item_as_read",
            reader.update_item_as_read("x", &edit).unwrap_err(),
        ),
        ("delete_item", reader.delete_item("x").unwrap_err()),
        (
            "delete_item_at",
            reader
                .delete_item_at(
                    "x",
                    &Seen {
                        item: Item::from_wire(
                            crate::store::testing::wire_item(
                                "x",
                                "core.note",
                                "active",
                                "2026-01-01T00:00:00Z",
                                serde_json::json!({}),
                            ),
                            Vec::new(),
                        )
                        .unwrap(),
                        edges: Vec::new(),
                    },
                )
                .unwrap_err(),
        ),
        ("restore_item", reader.restore_item("x").unwrap_err()),
        ("purge_item", reader.purge_item("x", None).unwrap_err()),
        (
            "transition_item",
            reader
                .transition_item("x", ItemState::Archived)
                .unwrap_err(),
        ),
        (
            "create_edge",
            reader.create_edge(&EdgeDraft::default()).unwrap_err(),
        ),
        (
            "update_edge",
            reader.update_edge("x", &EdgeEdit::default()).unwrap_err(),
        ),
        ("delete_edge", reader.delete_edge("x").unwrap_err()),
        (
            "queue_edge_ops",
            reader
                .queue_edge_ops(&[EdgeOp::Delete("x".into())], |_| false)
                .unwrap_err(),
        ),
        ("add_tag", reader.add_tag("x", "t").unwrap_err()),
        ("remove_tag", reader.remove_tag("x", "t").unwrap_err()),
        (
            "replace_tags",
            reader.replace_tags("x", &TagsWrite::default()).unwrap_err(),
        ),
        (
            "write_extension",
            reader.write_extension("x", "ns", "{}").unwrap_err(),
        ),
        (
            "delete_extension",
            reader.delete_extension("x", "ns").unwrap_err(),
        ),
        ("release", reader.release("blocked").unwrap_err()),
        (
            "release_reason",
            reader.release_reason(BlockedReason::KeySpent).unwrap_err(),
        ),
        (
            "rebase_on_held",
            reader.rebase_on_held("blocked").unwrap_err(),
        ),
        ("withdraw", reader.withdraw("blocked").unwrap_err()),
        (
            "withdraw_alone",
            reader.withdraw_alone("blocked").unwrap_err(),
        ),
        // Refused at the handle before the missing server, so not `NoServer`.
        ("drain", reader.drain().unwrap_err()),
        ("forget_answered", reader.forget_answered().unwrap_err()),
        (
            "forget_answered_ids",
            reader.forget_answered_ids(&[]).unwrap_err(),
        ),
        ("take_answered", reader.take_answered().unwrap_err()),
        ("discard", reader.discard("refused").unwrap_err()),
        (
            "put_blob",
            reader
                .put_blob(Path::new("no-such-file.png"), None)
                .unwrap_err(),
        ),
        (
            "set_file_budget",
            reader.set_file_budget(FileBudget::KeepAll).unwrap_err(),
        ),
        ("trim_files", reader.trim_files().unwrap_err()),
        (
            "remove_fetched_files",
            reader.remove_fetched_files().unwrap_err(),
        ),
        (
            "fetch_kept_until",
            reader
                .fetch_kept_until(&std::sync::atomic::AtomicBool::new(false))
                .unwrap_err(),
        ),
        (
            "attach",
            reader
                .attach("x", Path::new("no-such-file.png"), &Attachment::default())
                .unwrap_err(),
        ),
        (
            "add_file",
            reader
                .add_file(Path::new("no-such-file.png"), &Attachment::default(), &[])
                .unwrap_err(),
        ),
        (
            "create_file_item",
            reader
                .create_file_item(Path::new("no-such-file.png"), &draft)
                .unwrap_err(),
        ),
        (
            "update_file_item",
            reader
                .update_file_item("x", Path::new("no-such-file.png"), &edit, Based::OnHeld)
                .unwrap_err(),
        ),
        (
            "hydrate",
            reader
                .hydrate(&["core.note".into()], SliceTier::Library)
                .unwrap_err(),
        ),
        (
            "hydrate_with",
            reader
                .hydrate_with(
                    &["core.note".into()],
                    SliceTier::Library,
                    &["parent-of".into()],
                )
                .unwrap_err(),
        ),
        ("catch_up", reader.catch_up().unwrap_err()),
        (
            "catch_up_until",
            reader
                .catch_up_until(&std::sync::atomic::AtomicBool::new(false))
                .unwrap_err()
                .error,
        ),
        (
            "hydrate_until",
            reader
                .hydrate_until(
                    &["core.note".into()],
                    SliceTier::Library,
                    &[],
                    &std::sync::atomic::AtomicBool::new(false),
                )
                .unwrap_err(),
        ),
        (
            "hydrate_in_place_only",
            reader
                .hydrate_in_place_only(
                    &["core.note".into()],
                    SliceTier::Library,
                    &[],
                    &std::sync::atomic::AtomicBool::new(false),
                )
                .unwrap_err(),
        ),
        (
            "drain_until",
            reader
                .drain_until(&std::sync::atomic::AtomicBool::new(false))
                .unwrap_err(),
        ),
        (
            "follow_observed",
            reader
                .follow_observed(
                    &std::sync::atomic::AtomicBool::new(true),
                    false,
                    |_| {},
                    |_| {},
                )
                .unwrap_err(),
        ),
        (
            "create_folder",
            reader
                .create_folder(&serde_json::Map::new(), None)
                .unwrap_err(),
        ),
        (
            "change_folder",
            reader
                .change_folder("x", &folder_changes, 1, None)
                .unwrap_err(),
        ),
        (
            "revoke_folder",
            reader.revoke_folder("x", None).unwrap_err(),
        ),
        ("declare_types", reader.declare_types(&[]).unwrap_err()),
        (
            "create_view",
            reader
                .create_view(&serde_json::Map::new(), None)
                .unwrap_err(),
        ),
        (
            "change_view",
            reader
                .change_view("x", &folder_changes, 1, None)
                .unwrap_err(),
        ),
        ("delete_view", reader.delete_view("x", None).unwrap_err()),
        ("pin", reader.pin("x").unwrap_err()),
        ("pin_page", reader.pin_page(&["x".to_owned()]).unwrap_err()),
        ("unpin", reader.unpin("x").unwrap_err()),
        (
            "hold_table_until",
            reader
                .hold_table_until("core.note", "x", &NEVER_STOPPED)
                .unwrap_err(),
        ),
        (
            "let_go_table",
            reader.let_go_table("core.note", "x").unwrap_err(),
        ),
        (
            "fill_tables",
            reader.fill_tables(&NEVER_STOPPED).unwrap_err(),
        ),
        (
            "write_rows",
            reader
                .write_rows(
                    "x",
                    "x",
                    &[serde_json::json!({ "op": "delete", "id": "x" })],
                )
                .unwrap_err(),
        ),
        ("undo_rows", reader.undo_rows("x", "x", "x").unwrap_err()),
        (
            "follow",
            reader
                .follow(&std::sync::atomic::AtomicBool::new(true), false, |_| {})
                .unwrap_err(),
        ),
    ];
    for (door, refusal) in &refusals {
        assert_eq!(
            refusal,
            &CoreError::ReadingHandle,
            "the {door} door let a second opener through, so two processes \
             queue into one file and neither sees the other's rows"
        );
    }
    assert_eq!(
        held(),
        before,
        "a door refused a reading handle only after it had written"
    );
    assert_eq!(
        refusals.len(),
        60,
        "an entry has gone from the list above, and a door dropped from \
         it is a door nothing here covers"
    );

    let listed: Vec<&str> = refusals.iter().map(|(door, _)| *door).collect();
    let mut guarded = Vec::new();
    let others: &[&str] = &[];
    for (source, helpers) in [
        (include_str!("../blob.rs"), others),
        (include_str!("../catalog.rs"), others),
        (include_str!("../catch_up.rs"), others),
        (include_str!("../error.rs"), others),
        (include_str!("../lock.rs"), others),
        (include_str!("../http.rs"), others),
        (include_str!("../hydrate.rs"), others),
        (include_str!("../model.rs"), others),
        (include_str!("../query.rs"), others),
        (include_str!("../search.rs"), others),
        (include_str!("../sse.rs"), others),
        (include_str!("../store.rs"), others),
        (include_str!("../wire.rs"), others),
        (
            include_str!("../view_writes.rs"),
            &["send_to_view_door"][..],
        ),
        (
            include_str!("../folder_settings.rs"),
            &["send_to_folder_door"][..],
        ),
        (include_str!("../folder/mod.rs"), &["working"][..]),
        (include_str!("../folder/document.rs"), others),
        (include_str!("../folder/identity.rs"), others),
        (include_str!("../folder/pull.rs"), others),
        (include_str!("../folder/push.rs"), others),
        (include_str!("../folder/scan.rs"), others),
        (include_str!("../folder/settings.rs"), others),
        (include_str!("../folder/state.rs"), others),
        (include_str!("../lib.rs"), others),
        (include_str!("../edge_writes.rs"), others),
        (include_str!("../item_reads.rs"), others),
        (include_str!("../holds.rs"), others),
        (include_str!("../sending.rs"), others),
        (include_str!("../types.rs"), others),
        (
            include_str!("../files.rs"),
            &["keep_relocated_origin", "with_upload", "with_upload_reader"][..],
        ),
        (
            include_str!("../open.rs"),
            &[
                // Makes a core rather than taking one, so no reading
                // handle can reach it; `replace_tests` claims the role
                // first and is refused.
                "replace_refused",
                // Take no core either; `remove_tests` and `damage_tests`
                // hold the role from another core and are refused.
                "remove_agreed",
                "check_store",
                "read_unsent",
                "set_aside_damaged",
            ][..],
        ),
        (
            include_str!("../streams.rs"),
            &["catch_up_pass", "follow_from", "hydrate_filling"][..],
        ),
        (
            include_str!("../write.rs"),
            &[
                "transition_locally",
                "tag_write",
                "extension_write",
                "write_create",
                "write_update",
            ][..],
        ),
        (include_str!("../drain.rs"), &["drain_checked"][..]),
    ] {
        let mut current: Option<&str> = None;
        let mut in_tests = false;
        for line in source.lines() {
            // A test module, top level and closed at column 0, is
            // passed over; anything after it is read again.
            if line.starts_with("mod tests") {
                in_tests = true;
            }
            if in_tests {
                in_tests = line != "}";
                continue;
            }
            let declared = line.trim_start();
            let declared = declared
                .strip_prefix("pub(crate) ")
                .or_else(|| declared.strip_prefix("pub(super) "))
                .or_else(|| declared.strip_prefix("pub "))
                .unwrap_or(declared);
            if let Some(name) = declared.strip_prefix("fn ") {
                let end = name
                    .find(|glyph: char| !(glyph.is_alphanumeric() || glyph == '_'))
                    .unwrap_or(name.len());
                current = Some(&name[..end]);
            }
            if line.contains("refuse_unless_writer()")
                && let Some(name) = current
            {
                guarded.push((name, helpers));
            }
        }
    }
    assert!(
        guarded.iter().any(|(name, _)| *name == "create_item"),
        "the scan did not find `create_item`, so it is reading the wrong \
         source and the check below passes on nothing"
    );
    for (name, helpers) in guarded {
        assert!(
            listed.contains(&name) || helpers.contains(&name),
            "{name} calls `refuse_unless_writer` and is not in the list \
             above, so a reading handle reaching it is never tried"
        );
    }

    let queued = writer.create_item(&draft).unwrap();
    assert_eq!(queued.kind, WriteKind::CreateItem);

    assert!(
        reader
            .list(&ListFilters::default(), Sort::default())
            .is_ok()
    );
}

#[test]
fn a_store_opened_to_read_never_claims_the_writer_and_is_told_of_saves() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    assert!(
        Core::open_reader(&path).is_err(),
        "a reading open answered for a path where no store was made"
    );
    assert!(
        !path.exists(),
        "a reading open made a store it was only meant to read"
    );
    drop(Core::open(&path, None).unwrap());
    let reader = Core::open_reader(&path).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    let writer = Core::open(&path, None).unwrap();
    assert_eq!(
        writer.handle(),
        Handle::Writer,
        "a reader opened first took the writer role, so the app is locked out of its own store"
    );

    let before = reader.data_version().unwrap();
    assert_eq!(
        reader.data_version().unwrap(),
        before,
        "the signal moved with no save, so a reader cannot tell a save from nothing"
    );
    {
        let conn = writer.conn().unwrap();
        store::meta_set(&conn, "saved", "yes").unwrap();
    }
    assert_ne!(
        reader.data_version().unwrap(),
        before,
        "the writer saved and the reader's signal did not move"
    );
}

#[test]
fn a_reading_open_names_what_is_wrong_with_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let at = |name: &str| dir.path().join(name);
    let made = |name: &str, sql: &str| {
        let path = at(name);
        Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        path
    };
    let refusal = |path: &Path| match Core::open_reader(path) {
        Err(error) => error,
        Ok(_) => panic!("{} opened to read", path.display()),
    };
    let not_a_store = |path: &Path| match refusal(path) {
        CoreError::Invalid(message) => message,
        other => panic!("{} was refused as {other:?}", path.display()),
    };

    let absent = at("absent.sqlite");
    assert!(not_a_store(&absent).contains("never makes one"));
    assert!(!absent.exists());
    let tableless = made("tableless.sqlite", "CREATE TABLE other (x);");
    assert!(not_a_store(&tableless).contains("has no schema to read"));
    let words = at("words.sqlite");
    std::fs::write(&words, "words, not a database. ".repeat(40)).unwrap();
    assert!(matches!(
        refusal(&words),
        CoreError::StoreDamaged { path, reason, unsent: None }
            if path == words.display().to_string() && reason.contains("not a database")
    ));

    let meta = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
    let older = made(
        "older.sqlite",
        &format!("{meta} INSERT INTO meta VALUES ('schema_version', '0');"),
    );
    let unversioned = made("unversioned.sqlite", meta);
    let newer = made(
        "newer.sqlite",
        &format!(
            "{meta} PRAGMA user_version = {};",
            store::SCHEMA_VERSION + 1
        ),
    );
    for (path, found) in [
        (&older, "schema version 0".to_string()),
        (&unversioned, "schema version 0".to_string()),
        (
            &newer,
            format!("schema version {}", store::SCHEMA_VERSION + 1),
        ),
    ] {
        match refusal(path) {
            CoreError::WrongSchema {
                path: named,
                reason,
                unsent,
                folder,
            } => {
                assert!(folder.is_none(), "a device store was refused as a folder's");
                assert_eq!(named, path.display().to_string());
                assert!(reason.contains(&found), "{reason}");
                assert_eq!(unsent, None, "a store with no queue was counted");
            }
            other => panic!("{} was refused as {other:?}", path.display()),
        }
    }
    drop(Core::open(at("store.sqlite"), None).unwrap());
    assert!(Core::open_reader(at("store.sqlite")).is_ok());
}

#[test]
fn a_reading_open_answers_held_bytes_and_says_why_it_fetches_no_others() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let writer = Core::open(&path, None).unwrap();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, b"held here").unwrap();
    let hash = writer
        .cache()
        .unwrap()
        .take_reader(&file, std::fs::File::open(&file).unwrap())
        .unwrap()
        .hash;

    let reader = Core::open_reader(&path).unwrap();
    let held = reader.blob(&hash).unwrap();
    assert_eq!(std::fs::read(held.path()).unwrap(), b"held here");
    let other = blob::name_of(b"never held");
    let reason = |core: &Core| match core.blob(&other) {
        Err(CoreError::BytesAbsent { reason, .. }) => reason,
        answer => panic!("{answer:?}"),
    };
    assert!(reason(&reader).contains("reading handle"));
    assert!(!reason(&writer).contains("reading handle"));
}
