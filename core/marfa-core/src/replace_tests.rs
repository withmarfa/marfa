//! Replacing a store `Core::open` refuses `wrong_schema`: only under the
//! writer lock, only with nothing unsent, and never losing the store when it
//! cannot finish.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::{Core, CoreError, Handle};

/// `path` with `suffix` appended to its file name, as SQLite names a store's
/// log and the core names its lock.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The length and a digest of the store and of each of its logs, `None`
/// where a file is absent. The shared-memory index is left out: it is
/// rebuilt from the log by whoever opens the store, so it holds nothing of
/// the store's own.
fn files(path: &Path) -> Vec<(PathBuf, Option<(usize, u64)>)> {
    use std::hash::{Hash, Hasher};
    ["", "-wal", "-journal"]
        .into_iter()
        .map(|suffix| {
            let file = beside(path, suffix);
            let held = std::fs::read(&file).ok().map(|bytes| {
                let mut digest = std::collections::hash_map::DefaultHasher::new();
                bytes.hash(&mut digest);
                (bytes.len(), digest.finish())
            });
            (file, held)
        })
        .collect()
}

fn queue_one(conn: &Connection) {
    conn.execute(
        "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
         VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
}

/// What another build would have left: this build's store with one column
/// of its queue under another name, holding one unsent write where `unsent`.
fn refused_store(unsent: bool) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    drop(Core::open(&path, None).unwrap());
    let conn = Connection::open(&path).unwrap();
    if unsent {
        queue_one(&conn);
    }
    crate::store::meta_set(
        &conn,
        crate::store::META_SERVER_ORIGIN,
        "https://earlier.example",
    )
    .unwrap();
    conn.execute_batch("ALTER TABLE queue RENAME COLUMN follows TO after_write")
        .unwrap();
    (dir, path)
}

/// Runs `sql` so that what it wrote stays in the store's write-ahead log, as
/// a process that ended without closing the store leaves it: the store file
/// alone does not hold it.
fn in_log(path: &Path, sql: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    conn.execute_batch(sql).unwrap();
    let kept = beside(path, ".kept");
    std::fs::copy(path, &kept).unwrap();
    std::fs::copy(beside(path, "-wal"), beside(&kept, "-wal")).unwrap();
    // Closing checkpoints the log into the store and removes it.
    drop(conn);
    std::fs::rename(&kept, path).unwrap();
    std::fs::rename(beside(&kept, "-wal"), beside(path, "-wal")).unwrap();
    let _ = std::fs::remove_file(beside(path, "-shm"));
}

fn refusal(path: &Path) -> CoreError {
    match Core::open(path, None) {
        Err(error) => error,
        Ok(_) => panic!("{} opened", path.display()),
    }
}

fn no_set_aside_copy(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let aside = beside(&beside(path, ".refused"), suffix);
        assert!(!aside.exists(), "{} was left behind", aside.display());
    }
}

#[test]
fn a_refused_store_holding_nothing_unsent_is_replaced_and_opened_as_the_writer() {
    let (_dir, path) = refused_store(false);
    // The witness: the store is refused, holding nothing unsent.
    assert!(matches!(
        refusal(&path),
        CoreError::WrongSchema {
            unsent: Some(0),
            ..
        }
    ));

    let core = Core::replace_refused(&path, None).unwrap();
    assert_eq!(core.handle(), Handle::Writer);
    assert!(core.queue().unwrap().is_empty());
    drop(core);
    no_set_aside_copy(&path);

    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        crate::store::meta_get(&conn, crate::store::META_SERVER_ORIGIN).unwrap(),
        None,
        "the new store holds what the refused one held"
    );
    drop(conn);
    drop(Core::open(&path, None).expect("the new store is refused"));
}

#[test]
fn a_refused_store_holding_unsent_writes_is_refused_with_the_count_and_left_as_it_was() {
    let (_dir, path) = refused_store(true);
    let before = files(&path);

    match Core::replace_refused(&path, None) {
        Err(CoreError::WrongSchema {
            path: named,
            unsent,
            ..
        }) => {
            assert_eq!(unsent, Some(1));
            assert_eq!(named, path.display().to_string());
        }
        other => panic!("replaced as {:?}", other.map(|core| core.handle())),
    }
    assert_eq!(files(&path), before, "the refused store changed");
    no_set_aside_copy(&path);

    // A queue whose shape hides its count is refused too, since what it
    // holds cannot be known.
    Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE queue RENAME COLUMN verdict TO answer_kind")
        .unwrap();
    let before = files(&path);
    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::WrongSchema { unsent: None, .. })
    ));
    assert_eq!(files(&path), before, "the uncounted store changed");
}

#[test]
fn a_write_held_only_in_the_log_is_counted_and_the_log_goes_with_its_store() {
    let (_dir, path) = refused_store(false);
    in_log(
        &path,
        "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
         VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
    );
    let before = files(&path);
    assert!(before[1].1.is_some_and(|(length, _)| length > 0));
    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::WrongSchema {
            unsent: Some(1),
            ..
        })
    ));
    assert_eq!(files(&path), before, "the store or its log changed");

    // With the write answered in the log, the store and its log are both
    // replaced: a log left beside the new store would be read into it.
    in_log(&path, "UPDATE queue SET verdict = 'accepted', sent = 1");
    assert!(matches!(
        refusal(&path),
        CoreError::WrongSchema {
            unsent: Some(0),
            ..
        }
    ));
    let core = Core::replace_refused(&path, None).unwrap();
    assert!(core.queue().unwrap().is_empty());
    drop(core);
    no_set_aside_copy(&path);
    drop(Core::open(&path, None).expect("the new store is refused"));
}

#[test]
fn a_store_another_process_writes_is_refused_as_held_and_never_replaced() {
    let (_dir, path) = refused_store(false);
    let before = files(&path);
    let held = crate::lock::WriterLock::claim(Some(&path)).unwrap();
    assert_eq!(held.handle(), Handle::Writer);

    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::ReadingHandle)
    ));
    assert_eq!(
        files(&path),
        before,
        "a store another process holds changed"
    );

    // The witness: once let go, the same store is replaced.
    drop(held);
    let core = Core::replace_refused(&path, None).unwrap();
    assert_eq!(core.handle(), Handle::Writer);
}

#[test]
fn a_store_this_build_opens_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let core = Core::open(&path, None).unwrap();
        drop(core);
        let conn = Connection::open(&path).unwrap();
        crate::store::meta_set(
            &conn,
            crate::store::META_SERVER_ORIGIN,
            "https://kept.example",
        )
        .unwrap();
    }
    let before = files(&path);
    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::Invalid(message)) if message.contains("nothing to replace")
    ));
    assert_eq!(files(&path), before, "a store this build opens changed");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        crate::store::meta_get(&conn, crate::store::META_SERVER_ORIGIN)
            .unwrap()
            .as_deref(),
        Some("https://kept.example")
    );
}

#[test]
fn no_store_and_a_file_that_is_not_a_store_are_refused_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent.sqlite");
    assert!(matches!(
        Core::replace_refused(&absent, None),
        Err(CoreError::Invalid(_))
    ));
    assert!(
        !absent.exists(),
        "a replacement made a store where there was none"
    );

    let words = dir.path().join("words.sqlite");
    std::fs::write(&words, "words, not a database. ".repeat(40)).unwrap();
    let before = files(&words);
    match Core::replace_refused(&words, None) {
        Err(CoreError::WrongSchema { .. }) | Ok(_) => {
            panic!("a file that is not a store was replaced")
        }
        Err(_) => {}
    }
    assert_eq!(files(&words), before);
}

#[test]
fn a_store_that_cannot_be_made_leaves_the_refused_one_where_it_was() {
    let (_dir, path) = refused_store(false);
    in_log(
        &path,
        "UPDATE meta SET value = value WHERE key = 'schema_version'",
    );
    let before = files(&path);
    crate::fault::set_failing("replace-refused-make", true);
    let failed = Core::replace_refused(&path, None);
    crate::fault::set_failing("replace-refused-make", false);
    assert!(
        matches!(&failed, Err(CoreError::Store(message)) if message.contains("replace-refused-make")),
        "{:?}",
        failed.map(|core| core.handle())
    );
    assert_eq!(
        files(&path),
        before,
        "the refused store was not put back whole"
    );
    no_set_aside_copy(&path);
    assert!(matches!(
        refusal(&path),
        CoreError::WrongSchema {
            unsent: Some(0),
            ..
        }
    ));

    // The witness: without the fault, the same call replaces it.
    assert_eq!(
        Core::replace_refused(&path, None).unwrap().handle(),
        Handle::Writer
    );
}

#[test]
fn a_copy_left_set_aside_by_a_replacement_that_did_not_finish_is_never_overwritten() {
    let (_dir, path) = refused_store(false);
    let aside = beside(&path, ".refused");
    std::fs::write(&aside, b"what an interrupted replacement set aside").unwrap();
    let before = files(&path);
    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::Store(message)) if message.contains(&aside.display().to_string())
    ));
    assert_eq!(files(&path), before);
    assert_eq!(
        std::fs::read(&aside).unwrap(),
        b"what an interrupted replacement set aside"
    );
}

#[test]
fn a_store_whose_path_holds_characters_a_uri_reserves_is_read_where_it_is() {
    let (dir, path) = refused_store(true);
    let odd = dir.path().join("100% notes?#1 b");
    std::fs::create_dir(&odd).unwrap();
    let moved = odd.join("core.sqlite");
    std::fs::rename(&path, &moved).unwrap();
    let before = files(&moved);
    assert!(matches!(
        Core::replace_refused(&moved, None),
        Err(CoreError::WrongSchema {
            unsent: Some(1),
            ..
        })
    ));
    assert_eq!(files(&moved), before);
}
