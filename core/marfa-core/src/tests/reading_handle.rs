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
            "trash_items",
            reader
                .trash_items(&TrashPreview {
                    items: vec![TrashPreviewItem {
                        id: "x".into(),
                        r#type: "core.note".into(),
                        version: 1,
                        takes: Vec::new(),
                        count: 1,
                        truncated: false,
                    }],
                    count: 1,
                    digest: "d".repeat(64),
                })
                .unwrap_err(),
        ),
        (
            "transition_item_from",
            reader
                .transition_item_from("x", ItemState::Archived, None)
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
            reader.write_extension("x", "ns", "{}", None).unwrap_err(),
        ),
        (
            "delete_extension",
            reader.delete_extension("x", "ns", None).unwrap_err(),
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
        61,
        "an entry has gone from the list above, and a door dropped from \
         it is a door nothing here covers"
    );

    // Functions that call `refuse_unless_writer` and are not doors a test can
    // hand a reading handle to.
    let helpers: &[&str] = &[
        "send_to_view_door",
        "send_to_folder_door",
        "working",
        "keep_relocated_origin",
        "with_upload",
        "with_upload_reader",
        // Makes a core rather than taking one, so no reading handle can
        // reach it; `replace_tests` claims the role first and is refused.
        "replace_refused",
        // Take no core either; `remove_tests` and `damage_tests` hold the
        // role from another core and are refused.
        // `read_unsent` and `remove_agreed` claim through it.
        "claim_unsent",
        "check_store",
        "set_aside_damaged",
        "catch_up_pass",
        "follow_from",
        "hydrate_filling",
        "transition_locally",
        "tag_write",
        "extension_write",
        "write_create",
        "write_update",
        "drain_checked",
        // A folder's core is made only by `opened`, which refuses a
        // reading lock, so no reading handle reaches a core that calls this.
        "clear_answered",
        // Makes a folder's core from a lock rather than taking one.
        "opened",
    ];

    // Every file of the crate, so a door in any folder is read, except the
    // files that hold only tests.
    fn sources(folder: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name != "tests") {
                    sources(&path, found);
                }
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && !path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().ends_with("_tests.rs"))
            {
                found.push(path);
            }
        }
    }
    let mut files = Vec::new();
    sources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );

    let listed: Vec<&str> = refusals.iter().map(|(door, _)| *door).collect();
    let mut guarded = Vec::new();
    for file in &files {
        let source = std::fs::read_to_string(file).unwrap();
        let mut current: Option<&str> = None;
        let mut in_tests = false;
        let mut after_cfg_test = false;
        for line in source.lines() {
            // A test module, top level and closed at column 0, is
            // passed over; anything after it is read again.
            if line.starts_with("mod tests {")
                || (after_cfg_test && line.starts_with("mod ") && line.ends_with(" {"))
            {
                in_tests = true;
            }
            after_cfg_test = line == "#[cfg(test)]";
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
                guarded.push((name.to_owned(), file.clone()));
            }
        }
    }
    for witness in ["create_item", "clear_answered"] {
        assert!(
            guarded.iter().any(|(name, _)| name == witness),
            "the scan did not find `{witness}`, so it is not reading the \
             whole crate and the check below passes on too little"
        );
    }
    for (name, file) in guarded {
        assert!(
            listed.contains(&name.as_str()) || helpers.contains(&name.as_str()),
            "{name} in {} calls `refuse_unless_writer` and is not in the \
             list above, so a reading handle reaching it is never tried",
            file.display()
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
        CoreError::StoreDamaged { path, reason, unsent: None, .. }
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
                release,
            } => {
                assert!(folder.is_none(), "a device store was refused as a folder's");
                assert_eq!(release, None, "a store with no meta recorded a release");
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

fn store_files(path: &std::path::Path) -> [Option<Vec<u8>>; 2] {
    let log = std::path::PathBuf::from(format!("{}-wal", path.display()));
    [path, log.as_path()].map(|file| std::fs::read(file).ok())
}

fn save_rows(writer: &Core) {
    let conn = writer.conn().unwrap();
    for at in 0..50 {
        store::meta_set(&conn, &format!("row-{at}"), &"x".repeat(2000)).unwrap();
    }
}

#[test]
fn a_reading_handle_that_closes_last_changes_neither_the_store_nor_its_log() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");

    let writer = Core::open(&path, None).unwrap();
    save_rows(&writer);
    let reader = Core::open(&path, None).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    drop(writer);

    let left = store_files(&path);
    assert!(
        left[1].is_some(),
        "the writer left no log, so there is nothing for a reader to checkpoint"
    );
    let seen: i64 = reader
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'row-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seen, 50, "the reader did not read what the writer saved");
    drop(reader);
    assert!(
        store_files(&path) == left,
        "a reading handle that closed last changed the store or its log"
    );
}

#[test]
fn a_connection_that_can_write_and_closes_last_checkpoints_the_log_of_the_writer_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");

    let writer = Core::open(&path, None).unwrap();
    save_rows(&writer);
    let second = store::open(&path).unwrap();
    drop(writer);
    let left = store_files(&path);
    assert!(left[1].is_some());
    drop(second);
    assert!(
        store_files(&path) != left,
        "closing the last writable connection left the store and its log unchanged"
    );
}

#[test]
fn a_reading_handle_opened_where_a_writer_holds_the_directory_store_leaves_it_unchanged() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let state = dir.path().join("state");
    std::fs::create_dir(&state).unwrap();
    let path = state.join("core.sqlite");
    let directory = directory::Directory::open(&state).unwrap();

    let writer = Core::open_directory(&directory, &path, None).unwrap();
    save_rows(&writer);
    let lock = Arc::new(Core::claim_directory(&directory).unwrap());
    assert_eq!(lock.handle(), Handle::Reader);
    let reader = Core::open_claimed(&directory, &path, None, lock).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    drop(writer);
    let left = store_files(&path);
    assert!(left[1].is_some());
    drop(reader);
    assert!(
        store_files(&path) == left,
        "a reading handle on a folder's store changed it when it closed"
    );
}

#[test]
fn a_reading_handle_cannot_write_to_the_store_through_its_connection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let writer = Core::open(&path, None).unwrap();
    let reader = Core::open(&path, None).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    let conn = reader.conn().unwrap();
    assert!(conn.is_readonly("main").unwrap());
    assert!(store::meta_set(&conn, "from-the-reader", "x").is_err());
    drop(conn);
    drop(writer);
}

#[test]
fn a_reading_handle_opens_a_store_a_writer_has_not_yet_made_with_a_refusal_and_makes_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let held = lock::WriterLock::claim(Some(&path)).unwrap();
    assert_eq!(held.handle(), Handle::Writer);
    assert!(Core::open(&path, None).is_err());
    assert!(
        !path.exists(),
        "a reading handle made the store the writer had not yet made"
    );
}

#[cfg(unix)]
#[test]
fn a_reader_alone_reads_what_a_writer_left_in_its_log() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let writer = Core::open(&path, None).unwrap();
    save_rows(&writer);
    // A crashed writer can leave committed pages in the log without a shared index.
    let left = dir.path().join("left");
    std::fs::create_dir(&left).unwrap();
    let copy = left.join("core.sqlite");
    std::fs::copy(&path, &copy).unwrap();
    std::fs::copy(
        format!("{}-wal", path.display()),
        format!("{}-wal", copy.display()),
    )
    .unwrap();
    drop(writer);

    let before = store_files(&copy);
    let reader = Core::open_reader(&copy).unwrap();
    let seen: i64 = reader
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'row-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seen, 50, "the reader did not read the saves the log held");
    drop(reader);
    assert!(
        store_files(&copy) == before,
        "reading a log the writer left changed the store or the log"
    );
}

#[cfg(unix)]
#[test]
fn a_reader_that_cannot_make_the_logs_index_refuses_and_changes_nothing() {
    for with_log in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let writer = Core::open(&path, None).unwrap();
        save_rows(&writer);
        let copy_into = |name: &str| {
            let folder = dir.path().join(name);
            std::fs::create_dir(&folder).unwrap();
            let copy = folder.join("core.sqlite");
            std::fs::copy(&path, &copy).unwrap();
            if with_log {
                std::fs::copy(
                    format!("{}-wal", path.display()),
                    format!("{}-wal", copy.display()),
                )
                .unwrap();
            }
            (folder, copy)
        };
        // Without the log, both copies need the writer's final checkpoint.
        let copies = if with_log {
            let copies = (copy_into("writable"), copy_into("left"));
            drop(writer);
            copies
        } else {
            drop(writer);
            assert!(!std::path::Path::new(&format!("{}-wal", path.display())).exists());
            (copy_into("writable"), copy_into("left"))
        };
        let ((_, writable), (left, locked)) = copies;

        let reader = Core::open_reader(&writable).unwrap_or_else(|error| {
            panic!("a reader in a writable folder refused, with a log: {with_log}: {error:?}")
        });
        let seen: i64 = reader
            .conn()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM meta WHERE key LIKE 'row-%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seen, 50, "with a log: {with_log}");
        drop(reader);

        let before = store_files(&locked);
        let _locked = crate::test_folders::locked(&left, 0o555);
        assert!(
            Core::open_reader(&locked).is_err(),
            "a reader in a folder it cannot write answered, with a log: {with_log}"
        );
        assert!(store_files(&locked) == before);
    }
}

#[test]
fn a_clean_store_stays_unchanged_and_a_new_log_stays_empty_after_a_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let log = std::path::PathBuf::from(format!("{}-wal", path.display()));
    let writer = Core::open(&path, None).unwrap();
    save_rows(&writer);
    drop(writer);
    assert!(
        !log.exists(),
        "the writer left a log, so the store is not clean"
    );
    let before = std::fs::read(&path).unwrap();

    let reader = Core::open_reader(&path).unwrap();
    let seen: i64 = reader
        .conn()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'row-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seen, 50, "the reader did not read the store");
    drop(reader);
    assert!(
        std::fs::read(&path).unwrap() == before,
        "a reader changed the store file"
    );
    if let Ok(left) = std::fs::metadata(&log) {
        assert_eq!(left.len(), 0, "a reader wrote into the log");
    }

    // The witness: the same read through a writable open changes the file.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("DELETE FROM meta WHERE key = ?1", [store::META_STORE_ID])
        .unwrap();
    drop(conn);
    assert!(!log.exists(), "the store is not checkpointed and clean");
    let copy_into = |name: &str| {
        let folder = dir.path().join(name);
        std::fs::create_dir(&folder).unwrap();
        let copy = folder.join("core.sqlite");
        std::fs::copy(&path, &copy).unwrap();
        copy
    };
    let (writable, read_only) = (copy_into("writable"), copy_into("read-only"));
    let before = std::fs::read(&writable).unwrap();
    assert!(before == std::fs::read(&read_only).unwrap());
    let rows = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE 'row-%'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };

    let conn = store::open(&writable).unwrap();
    assert_eq!(rows(&conn), 50);
    assert!(
        store::meta_get(&conn, store::META_STORE_ID)
            .unwrap()
            .is_some()
    );
    drop(conn);
    assert!(
        std::fs::read(&writable).unwrap() != before,
        "a writable open of a store with no id left it unchanged"
    );

    let reader = Core::open_reader(&read_only).unwrap();
    assert_eq!(rows(&reader.conn().unwrap()), 50);
    drop(reader);
    assert!(
        std::fs::read(&read_only).unwrap() == before,
        "a reader of a store with no id changed it"
    );
}
