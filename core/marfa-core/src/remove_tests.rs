//! Removing a store: only under the writer lock, only losing the writes the
//! caller was shown, and only the store's own names.

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

/// What `held` returns but the shared-memory index.
fn held_but_index(path: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let index = beside(path, "-shm");
    held(path)
        .into_iter()
        .filter(|(name, _)| *name != index)
        .collect()
}

fn gone(path: &Path) {
    let left: Vec<PathBuf> = names(path)
        .into_iter()
        .filter(|name| name.symlink_metadata().is_ok())
        .collect();
    assert!(left.is_empty(), "{left:?} was left behind");
}

fn queue_one(path: &Path) {
    queue(path, "q1");
}

fn queue(path: &Path, id: &str) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
             VALUES (?1, 'create_item', ?1, '{}', '2026-01-01T00:00:00Z')",
            [id],
        )
        .unwrap();
}

/// The confirmation `read_unsent` gives, as an app takes it when it shows
/// the writes.
fn shown(path: &Path) -> String {
    Core::read_unsent(path).unwrap().confirmation
}

/// The confirmation of no writes, which a path with no store answers.
fn nothing() -> String {
    crate::store::confirmation(&[])
}

/// The confirmation of the one write `queue_one` makes.
fn q1() -> String {
    crate::store::confirmation(&[crate::UnsentWrite {
        id: "q1".into(),
        kind: "create_item".into(),
        item_id: None,
        body: "{}".into(),
        verdict: None,
    }])
}

/// Changes the stored write `id` with `set`, as a drain or an edit can
/// while no app holds the writes it showed.
fn change(path: &Path, id: &str, set: &str) {
    let changed = Connection::open(path)
        .unwrap()
        .execute(&format!("UPDATE queue SET {set} WHERE id = ?1"), [id])
        .unwrap();
    assert_eq!(changed, 1);
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

fn differs(result: crate::Result<()>) -> Option<u64> {
    match result {
        Err(CoreError::UnsentDiffers { unsent, .. }) => unsent,
        other => panic!("answered {other:?}"),
    }
}

#[test]
fn a_store_whose_unsent_writes_are_those_shown_is_removed_with_its_names() {
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
    let listed = Core::read_unsent(&path).unwrap();
    assert_eq!(
        listed
            .writes
            .iter()
            .map(|write| write.id.as_str())
            .collect::<Vec<_>>(),
        ["q1"]
    );

    Core::remove_store(&path, &listed.confirmation).unwrap();

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

/// Each field `read_unsent` shows, changed under the same write id after
/// the person was shown it, refuses the removal and leaves the store whole.
#[test]
fn a_write_changed_after_it_was_shown_refuses_the_removal() {
    for set in [
        "payload = '{\"properties\":{\"title\":\"changed\"}}'",
        "verdict = 'blocked', reason = 'record_unread'",
        "verdict = 'dead'",
        "kind = 'update_item'",
        "item_id = 'another'",
    ] {
        let (_dir, path) = store_with_one_unsent();
        change(
            &path,
            "q1",
            "payload = '{\"properties\":{\"title\":\"shown\"}}'",
        );
        let agreed = shown(&path);
        change(&path, "q1", set);
        let ids: Vec<String> = Core::read_unsent(&path)
            .unwrap()
            .writes
            .into_iter()
            .map(|write| write.id)
            .collect();
        assert_eq!(ids, ["q1"], "{set}: the witness, the same id is held");
        let before = held(&path);

        assert_eq!(
            differs(Core::remove_store(&path, &agreed)),
            Some(1),
            "{set}"
        );
        assert_eq!(held(&path), before, "{set}: the store changed when refused");
    }
}

#[test]
fn a_write_queued_after_the_writes_were_shown_refuses_the_removal() {
    let (_dir, path) = store_with_one_unsent();
    let agreed = shown(&path);
    queue(&path, "q2");
    let before = held(&path);

    assert_eq!(differs(Core::remove_store(&path, &agreed)), Some(2));
    assert_eq!(held(&path), before, "the store changed when refused");
    assert_eq!(Core::open(&path, None).unwrap().queue().unwrap().len(), 2);
}

/// The race a count or an id list cannot see together: the write shown is
/// answered and another queued, so the store holds as many writes as were
/// shown, and not the ones shown.
#[test]
fn a_write_answered_and_another_queued_after_the_writes_were_shown_refuses_the_removal() {
    let (_dir, path) = store_with_one_unsent();
    let agreed = shown(&path);
    change(
        &path,
        "q1",
        "verdict = 'accepted', answered_at = '2026-01-01T00:00:01Z'",
    );
    queue(&path, "q2");
    let before = held(&path);

    assert_eq!(differs(Core::remove_store(&path, &agreed)), Some(1));
    assert_eq!(held(&path), before, "the store changed when refused");
    let kept = Core::open(&path, None).unwrap().queue().unwrap();
    assert!(
        kept.iter()
            .any(|write| write.id == "q2" && write.verdict.is_none())
    );
}

#[test]
fn a_write_answered_after_the_writes_were_shown_refuses_the_removal() {
    let (_dir, path) = store_with_one_unsent();
    let agreed = shown(&path);
    change(
        &path,
        "q1",
        "verdict = 'accepted', answered_at = '2026-01-01T00:00:01Z'",
    );

    assert_eq!(differs(Core::remove_store(&path, &agreed)), Some(0));
    assert!(path.exists());
    Core::remove_store(&path, &shown(&path)).unwrap();
    gone(&path);
}

#[test]
fn a_confirmation_that_is_not_one_refuses_the_removal() {
    let (_dir, path) = store_with_one_unsent();
    let before = held(&path);
    for agreed in [
        String::new(),
        nothing(),
        "q1".to_string(),
        shown(&path).to_uppercase(),
    ] {
        assert_eq!(differs(Core::remove_store(&path, &agreed)), Some(1));
        assert_eq!(held(&path), before, "the store changed when refused");
    }
}

/// The confirmation covers what removing the store loses, which is the
/// writes, so a copy of the store holding the same writes takes it too.
#[test]
fn the_same_writes_at_another_path_are_removed_with_their_confirmation() {
    let (dir, path) = store_with_one_unsent();
    queue(&path, "q2");
    let agreed = shown(&path);
    let copy = dir.path().join("copy-2.sqlite");
    std::fs::copy(&path, &copy).unwrap();

    Core::remove_store(&copy, &agreed).unwrap();
    gone(&copy);
    Core::remove_store(&path, &agreed).unwrap();
    gone(&path);
}

#[test]
fn a_store_holding_nothing_unsent_is_removed_with_the_confirmation_of_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    drop(Core::open(&path, None).unwrap());
    let listed = Core::read_unsent(&path).unwrap();
    assert!(listed.writes.is_empty());
    assert_eq!(listed.confirmation, nothing());

    // The witness: the confirmation of a store holding a write is refused.
    let (_other_dir, other) = store_with_one_unsent();
    assert_eq!(differs(Core::remove_store(&path, &shown(&other))), Some(0));
    assert!(path.exists());

    Core::remove_store(&path, &listed.confirmation).unwrap();
    gone(&path);
}

#[test]
fn a_store_another_process_writes_is_refused_and_left_as_it_was() {
    let (_dir, path) = store_with_one_unsent();
    let writer = Core::open(&path, None).unwrap();
    let before = held(&path);

    assert!(matches!(
        Core::remove_store(&path, &q1()),
        Err(CoreError::ReadingHandle)
    ));
    assert_eq!(held(&path), before);

    // The witness: once the writer lets go, the same call removes it.
    drop(writer);
    Core::remove_store(&path, &q1()).unwrap();
    gone(&path);
}

#[test]
fn a_store_of_another_schema_is_removed_with_the_writes_it_lists() {
    let (_dir, path) = store_with_one_unsent();
    Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version = 0")
        .unwrap();
    let Err(CoreError::WrongSchema {
        unsent: Some(shown),
        ..
    }) = Core::open(&path, None)
    else {
        panic!("the store at another version was not refused wrong_schema");
    };
    assert_eq!(shown, 1);
    let listed = self::shown(&path);
    assert_eq!(listed, q1());

    assert_eq!(differs(Core::remove_store(&path, &nothing())), Some(1));
    Core::remove_store(&path, &listed).unwrap();
    gone(&path);
}

#[test]
fn a_write_held_only_in_the_log_is_read() {
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

    // SQLite may make a shared-memory index to read the log, so the check
    // leaves it out.
    let before = held_but_index(&path);
    assert_eq!(differs(Core::remove_store(&path, &nothing())), Some(1));
    assert_eq!(held_but_index(&path), before);
    Core::remove_store(&path, &q1()).unwrap();
    gone(&path);
}

#[test]
fn a_store_whose_writes_cannot_be_read_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    std::fs::write(&path, vec![7u8; 8192]).unwrap();
    let before = std::fs::read(&path).unwrap();

    assert_eq!(differs(Core::remove_store(&path, &nothing())), None);
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

    assert_eq!(differs(Core::remove_store(&path, &q1())), Some(0));
    assert!(beside(&path, ".blobs").exists());
    // An app reading the path again is shown no writes.
    let listed = Core::read_unsent(&path).unwrap();
    assert!(listed.writes.is_empty());
    Core::remove_store(&path, &listed.confirmation).unwrap();
    gone(&path);

    // Nothing at all, not even the folder.
    let absent = dir.path().join("absent").join("copy.sqlite");
    assert_eq!(Core::read_unsent(&absent).unwrap().confirmation, nothing());
    // Reading a path with no store makes no lock there.
    let unmade = dir.path().join("unmade.sqlite");
    assert_eq!(Core::read_unsent(&unmade).unwrap().confirmation, nothing());
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    Core::remove_store(&absent, &nothing()).unwrap();
    assert!(!dir.path().join("absent").exists());
}

/// No lock is made at a path with no store, so a folder the app cannot write
/// to still lists no writes.
#[cfg(unix)]
#[test]
fn a_path_with_no_store_in_a_folder_that_cannot_be_written_lists_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    let _locked = crate::test_folders::locked(dir.path(), 0o500);
    if std::fs::write(dir.path().join("probe"), b"").is_ok() {
        // Permissions do not bind this user, so the folder cannot be locked.
        return;
    }

    let listed = Core::read_unsent(&path).unwrap();
    assert!(listed.writes.is_empty());
    assert_eq!(listed.confirmation, nothing());
    assert!(!beside(&path, ".writer-lock").exists());
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
        Core::remove_store(&path, &q1()),
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

    Core::remove_store(&path, &nothing()).unwrap();
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
    Core::remove_store(&path, &q1()).unwrap();
    gone(&path);
    assert_eq!(std::fs::read(&outside).unwrap(), b"kept");
    assert!(target_store.exists());
}

#[test]
fn a_store_a_folder_made_before_it_was_bound_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join(crate::folder::STATE_DIR);
    std::fs::create_dir(&state).unwrap();
    let path = state.join("core.sqlite");
    drop(Core::open(&path, None).unwrap());
    queue_one(&path);
    let before = held(&path);

    // The witness: this store names no folder, and the same store anywhere
    // else is removed.
    let elsewhere = dir.path().join("copy.sqlite");
    std::fs::copy(&path, &elsewhere).unwrap();
    Core::remove_store(&elsewhere, &q1()).unwrap();

    assert!(matches!(
        Core::remove_store(&path, &q1()),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(held(&path), before);
}

/// A removal that fails after the fetched bytes are gone, as a crash there
/// would, leaves the store, and asking again finishes it.
#[cfg(unix)]
#[test]
fn a_removal_that_stopped_after_the_fetched_bytes_is_finished_by_asking_again() {
    use std::os::unix::fs::PermissionsExt;

    let (_dir, path) = store_with_one_unsent();
    // A shared-memory name that cannot be removed yet.
    let stuck = beside(&path, "-shm");
    std::fs::create_dir_all(stuck.join("inner")).unwrap();
    std::fs::write(stuck.join("inner").join("file"), b"").unwrap();
    let _stuck = crate::test_folders::locked(stuck.join("inner"), 0o500);
    if std::fs::remove_dir_all(&stuck).is_ok() {
        // Permissions do not bind this user, so the stop cannot be made.
        return;
    }

    assert!(matches!(
        Core::remove_store(&path, &q1()),
        Err(CoreError::Store(_))
    ));
    assert!(path.exists(), "the store went before the removal stopped");
    assert!(
        !beside(&path, ".blobs").exists(),
        "the fetched bytes outlived the removal's first step"
    );

    std::fs::set_permissions(stuck.join("inner"), std::fs::Permissions::from_mode(0o700)).unwrap();
    Core::remove_store(&path, &q1()).unwrap();
    gone(&path);

    // A new store at the path keeps none of the old fetched bytes.
    drop(Core::open(&path, None).unwrap());
    assert!(
        !beside(&path, ".blobs").join("fetched").exists(),
        "an old fetched file came back"
    );
}
