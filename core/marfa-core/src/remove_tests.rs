//! Removing a store: only under the writer lock, only losing the writes the
//! caller agreed to lose, and only the store's own names.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::{Core, CoreError};

fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Every name the store at `path` is made of.
fn names(path: &Path) -> Vec<PathBuf> {
    ["", "-wal", "-shm", "-journal", ".blobs", ".writer-lock"]
        .into_iter()
        .map(|suffix| beside(path, suffix))
        .collect()
}

/// Each name beside `path`'s store that is there, with the bytes of the
/// store, its log and each file of bytes it keeps.
fn held(path: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut held = Vec::new();
    for name in names(path) {
        let Ok(meta) = name.symlink_metadata() else {
            continue;
        };
        if meta.is_dir() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&name)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            entries.sort();
            for entry in entries {
                held.push((entry.clone(), std::fs::read(&entry).unwrap_or_default()));
            }
            held.push((name, Vec::new()));
        } else if name.ends_with("-shm") || name.to_string_lossy().ends_with(".writer-lock") {
            held.push((name, Vec::new()));
        } else {
            held.push((name.clone(), std::fs::read(&name).unwrap_or_default()));
        }
    }
    held
}

fn gone(path: &Path) {
    let left: Vec<PathBuf> = names(path)
        .into_iter()
        .filter(|name| name.symlink_metadata().is_ok())
        .collect();
    assert!(left.is_empty(), "{left:?} was left behind");
}

fn queue_one(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
             VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
}

/// A store this build opens, holding one write the server has not taken and
/// one file of fetched bytes, let go of by every core.
fn store_with_one_unsent() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    drop(Core::open(&path, None).unwrap());
    queue_one(&path);
    std::fs::create_dir_all(beside(&path, ".blobs")).unwrap();
    std::fs::write(beside(&path, ".blobs").join("fetched"), b"bytes").unwrap();
    (dir, path)
}

fn differs(result: crate::Result<()>) -> (Option<u64>, u64) {
    match result {
        Err(CoreError::UnsentDiffers { unsent, agreed, .. }) => (unsent, agreed),
        other => panic!("answered {other:?}"),
    }
}

#[test]
fn a_store_whose_unsent_writes_are_the_agreed_count_is_removed_with_its_names() {
    let (dir, path) = store_with_one_unsent();
    // Not the store's own names, so they stay.
    let neighbors = [
        dir.path().join("copy.db"),
        dir.path().join("copy.sqlite.refused-1"),
        dir.path().join("notes.txt"),
    ];
    for neighbor in &neighbors {
        std::fs::write(neighbor, b"kept").unwrap();
    }
    assert!(!held(&path).is_empty());

    Core::remove_store(&path, 1).unwrap();

    gone(&path);
    for neighbor in &neighbors {
        assert_eq!(std::fs::read(neighbor).unwrap(), b"kept");
    }
    let mut left: Vec<PathBuf> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    left.sort();
    let mut kept = neighbors.to_vec();
    kept.sort();
    assert_eq!(left, kept, "a name of the store was left behind");
    // The path is free for a new store.
    drop(Core::open(&path, None).unwrap());
}

#[test]
fn a_store_holding_another_count_is_refused_with_its_count_and_left_as_it_was() {
    let (_dir, path) = store_with_one_unsent();
    let before = held(&path);

    for agreed in [0, 2] {
        assert_eq!(
            differs(Core::remove_store(&path, agreed)),
            (Some(1), agreed)
        );
        assert_eq!(held(&path), before, "the store changed when refused");
    }
    assert_eq!(Core::open(&path, None).unwrap().queue().unwrap().len(), 1);
}

#[test]
fn a_store_another_process_writes_is_refused_and_left_as_it_was() {
    let (_dir, path) = store_with_one_unsent();
    let writer = Core::open(&path, None).unwrap();
    let before = held(&path);

    assert!(matches!(
        Core::remove_store(&path, 1),
        Err(CoreError::ReadingHandle)
    ));
    assert_eq!(held(&path), before);

    // The witness: once the writer lets go, the same call removes it.
    drop(writer);
    Core::remove_store(&path, 1).unwrap();
    gone(&path);
}

#[test]
fn a_store_of_another_schema_is_removed_under_its_own_count() {
    let (_dir, path) = store_with_one_unsent();
    Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE queue RENAME COLUMN follows TO after_write")
        .unwrap();
    let Err(CoreError::WrongSchema {
        unsent: Some(shown),
        ..
    }) = Core::open(&path, None)
    else {
        panic!("the reshaped store was not refused wrong_schema");
    };
    assert_eq!(shown, 1);

    assert_eq!(differs(Core::remove_store(&path, 0)), (Some(1), 0));
    Core::remove_store(&path, shown).unwrap();
    gone(&path);
}

#[test]
fn a_write_held_only_in_the_log_is_counted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    drop(Core::open(&path, None).unwrap());
    // A process that ended without closing the store leaves its writes in
    // the log.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    conn.execute(
        "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
         VALUES ('q1', 'create_item', 'k1', '{}', '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
    let kept = beside(&path, ".kept");
    std::fs::copy(&path, &kept).unwrap();
    std::fs::copy(beside(&path, "-wal"), beside(&kept, "-wal")).unwrap();
    drop(conn);
    std::fs::rename(&kept, &path).unwrap();
    std::fs::rename(beside(&kept, "-wal"), beside(&path, "-wal")).unwrap();

    assert_eq!(differs(Core::remove_store(&path, 0)), (Some(1), 0));
    Core::remove_store(&path, 1).unwrap();
    gone(&path);
}

#[test]
fn a_store_whose_writes_cannot_be_counted_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    std::fs::write(&path, vec![7u8; 8192]).unwrap();
    let before = std::fs::read(&path).unwrap();

    assert_eq!(differs(Core::remove_store(&path, 0)), (None, 0));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn a_path_with_no_store_is_removed_with_what_is_left_there() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    // What a removal stopped part way leaves.
    std::fs::create_dir_all(beside(&path, ".blobs")).unwrap();
    std::fs::write(beside(&path, ".blobs").join("fetched"), b"bytes").unwrap();
    std::fs::write(beside(&path, ".writer-lock"), b"").unwrap();

    assert_eq!(differs(Core::remove_store(&path, 1)), (Some(0), 1));
    assert!(beside(&path, ".blobs").exists());
    Core::remove_store(&path, 0).unwrap();
    gone(&path);

    // Nothing at all, not even the folder.
    Core::remove_store(dir.path().join("absent").join("copy.sqlite"), 0).unwrap();
    assert!(!dir.path().join("absent").exists());
}

#[test]
fn a_folders_store_is_refused() {
    let (_dir, path) = store_with_one_unsent();
    crate::store::meta_set(
        &Connection::open(&path).unwrap(),
        crate::folder::settings_file::META_FOLDER,
        "a-folder",
    )
    .unwrap();
    let before = held(&path);

    assert!(matches!(
        Core::remove_store(&path, 1),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(held(&path), before);
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_removed_and_what_it_leads_to_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    let outside = elsewhere.join("outside.txt");
    std::fs::write(&outside, b"kept").unwrap();
    let target_store = elsewhere.join("target.sqlite");
    drop(Core::open(&target_store, None).unwrap());
    let target_bytes = elsewhere.join("bytes");
    std::fs::create_dir(&target_bytes).unwrap();
    std::fs::write(target_bytes.join("fetched"), b"kept").unwrap();

    let path = dir.path().join("copy.sqlite");
    std::os::unix::fs::symlink(&target_store, &path).unwrap();
    std::os::unix::fs::symlink(&target_bytes, beside(&path, ".blobs")).unwrap();
    std::os::unix::fs::symlink(&outside, beside(&path, "-wal")).unwrap();

    Core::remove_store(&path, 0).unwrap();
    gone(&path);
    assert_eq!(std::fs::read(&outside).unwrap(), b"kept");
    assert_eq!(
        std::fs::read(target_bytes.join("fetched")).unwrap(),
        b"kept"
    );
    assert!(target_store.exists());

    // A link inside the folder of bytes goes, and what it leads to stays.
    let (_held, path) = store_with_one_unsent();
    std::os::unix::fs::symlink(&outside, beside(&path, ".blobs").join("link")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, beside(&path, ".blobs").join("folder")).unwrap();
    Core::remove_store(&path, 1).unwrap();
    gone(&path);
    assert_eq!(std::fs::read(&outside).unwrap(), b"kept");
    assert!(target_store.exists());
}
