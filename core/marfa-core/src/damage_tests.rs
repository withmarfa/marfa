//! A store SQLite cannot read: refused by name with what its queue holds,
//! and set aside for a new store that carries every write it can read.
//!
//! The interrupted set-aside flips a fault for its own thread, so these run
//! with `cargo nextest` like the rest (`core/AGENTS.md`).

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::stop_tests::note;
use crate::{Core, CoreError, QueuedWrite, SetAside, store};

fn beside(path: &Path, suffix: &str) -> PathBuf {
    store::suffixed(path, suffix)
}

/// A store holding `count` creates the server has not taken, closed so its
/// log is emptied into the file.
fn store_with(count: usize) -> (tempfile::TempDir, PathBuf, Vec<QueuedWrite>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = Core::open(&path, None).unwrap();
    for _ in 0..count {
        core.create_item(&note(None)).unwrap();
    }
    let queued = core.queue().unwrap();
    drop(core);
    (dir, path, queued)
}

/// What a write is: what carries it to the server and what it says.
fn sent(write: &QueuedWrite) -> (String, String, String, Option<i64>, Option<String>) {
    (
        write.id.clone(),
        write.idempotency_key.clone(),
        write.kind.to_string(),
        write.base_version,
        write.item_id.clone(),
    )
}

fn page_of(path: &Path, table: &str) -> (u64, u64) {
    let conn = Connection::open(path).unwrap();
    let size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap();
    let root: i64 = conn
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .unwrap();
    (size as u64, root as u64)
}

/// Overwrites the page that holds `table`'s rows, as a failing disk would.
fn damage_table(path: &Path, table: &str) {
    let (size, root) = page_of(path, table);
    overwrite(path, (root - 1) * size, size as usize);
}

fn overwrite(path: &Path, at: u64, length: usize) {
    let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.seek(SeekFrom::Start(at)).unwrap();
    file.write_all(&vec![0xA5; length]).unwrap();
}

fn bytes(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn damaged(error: CoreError) -> (String, Option<u64>, String) {
    let said = error.to_string();
    match error {
        CoreError::StoreDamaged { path, unsent, .. } => (path, unsent, said),
        other => panic!("refused with something other than store_damaged: {other:?}"),
    }
}

fn set_aside(path: &Path) -> SetAside {
    Core::set_aside_damaged(path).unwrap()
}

#[test]
fn a_store_damaged_outside_its_queue_is_refused_by_name_with_its_writes_counted() {
    let (_dir, path, queued) = store_with(2);
    // The witness: the store opens and reads before it is damaged.
    Core::check_store(&path).unwrap();
    damage_table(&path, "items");
    let before = bytes(&path);

    // The damage is met part way through a read, which names no path.
    let core = Core::open(&path, None).unwrap();
    let id = queued[0].item_id.clone().unwrap();
    let error = core.get(&id).unwrap_err();
    assert_eq!(error.code(), "store_damaged");
    let (named, _, said) = damaged(error);
    assert!(named.is_empty(), "{said}");
    assert!(said.contains("Check it"), "{said}");
    drop(core);

    let (named, unsent, said) = damaged(Core::check_store(&path).unwrap_err());
    assert_eq!(named, path.display().to_string());
    assert_eq!(unsent, Some(2), "{said}");
    assert!(
        said.contains("holds 2 writes the server has not taken"),
        "{said}"
    );
    assert!(said.contains("Set it aside"), "{said}");
    assert!(!said.to_lowercase().contains("delete"), "{said}");
    assert_eq!(bytes(&path), before, "refusing the store changed it");
}

#[test]
fn a_store_whose_header_is_damaged_is_refused_at_open_and_its_queue_unread() {
    let (_dir, path, _) = store_with(1);
    overwrite(&path, 0, 100);
    for error in [
        Core::open(&path, None).err().unwrap(),
        Core::open_reader(&path).err().unwrap(),
    ] {
        let (named, unsent, said) = damaged(error);
        assert_eq!(named, path.display().to_string());
        assert_eq!(unsent, None);
        assert!(said.contains("cannot be read whole"), "{said}");
    }
    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread, done.whole), (0, 0, false));
    assert!(beside(&path, ".damaged-1").exists());
    Core::open(&path, None).unwrap();
}

#[test]
fn a_set_aside_keeps_the_damaged_store_and_carries_every_write_it_can_read() {
    let (dir, path, queued) = store_with(2);
    std::fs::write(beside(&path, ".damaged-1"), "taken").unwrap();
    damage_table(&path, "items");
    let damaged_bytes = bytes(&path);

    let done = set_aside(&path);
    let aside = dir.path().join("core.sqlite.damaged-2");
    assert_eq!(done.set_aside, aside.display().to_string());
    assert_eq!(
        (done.carried, done.unread, done.whole, done.held),
        (2, 0, true, 0)
    );
    assert_eq!(bytes(&aside), damaged_bytes, "the store set aside changed");
    assert_eq!(
        std::fs::read_to_string(beside(&path, ".damaged-1")).unwrap(),
        "taken",
        "a file at a taken name was overwritten"
    );
    assert!(!beside(&path, ".carrying").exists());

    let core = Core::open(&path, None).unwrap();
    let carried = core.queue().unwrap();
    assert_eq!(
        carried.iter().map(sent).collect::<Vec<_>>(),
        queued.iter().map(sent).collect::<Vec<_>>()
    );
    let conn = core.conn().unwrap();
    for write in &queued {
        assert_eq!(
            store::payload_of(&conn, &write.id).unwrap(),
            payload_in(&aside, &write.id),
        );
    }
}

fn payload_in(path: &Path, id: &str) -> String {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT payload FROM queue WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn writes_whose_rows_do_not_read_are_counted_and_named_by_id() {
    let (_dir, path, queued) = store_with(2);
    damage_table(&path, "queue");
    let (_, unsent, _) = damaged(Core::check_store(&path).unwrap_err());
    assert_eq!(unsent, None);

    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread, done.whole), (0, 2, true));
    let mut named = done.unread_ids.clone();
    named.sort();
    let mut ids: Vec<String> = queued.iter().map(|write| write.id.clone()).collect();
    ids.sort();
    assert_eq!(named, ids);
}

#[test]
fn a_store_that_opens_is_not_set_aside() {
    let (_dir, path, _) = store_with(1);
    let before = bytes(&path);
    assert!(matches!(
        Core::set_aside_damaged(&path),
        Err(CoreError::Invalid(said)) if said.contains("opens as it is")
    ));
    assert_eq!(bytes(&path), before);
    assert!(!beside(&path, ".damaged-1").exists());
}

/// Runs `sql` so that what it wrote stays in the store's write-ahead log, as
/// a process that ended without closing the store leaves it.
fn in_log(path: &Path, sql: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    conn.execute_batch(sql).unwrap();
    let kept = beside(path, ".kept");
    std::fs::copy(path, &kept).unwrap();
    std::fs::copy(beside(path, "-wal"), beside(&kept, "-wal")).unwrap();
    drop(conn);
    std::fs::rename(&kept, path).unwrap();
    std::fs::rename(beside(&kept, "-wal"), beside(path, "-wal")).unwrap();
    let _ = std::fs::remove_file(beside(path, "-shm"));
}

/// A store whose last write is only in its log, a crash's, and whose file
/// is damaged outside the queue.
fn damaged_with_log() -> (tempfile::TempDir, PathBuf) {
    let (dir, path, _) = store_with(1);
    damage_table(&path, "items");
    in_log(
        &path,
        "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at)
         VALUES ('logged', 'add_tag', 'n1', 'k-logged', '{\"tag\":\"a\"}', '2026-01-01T00:00:00Z')",
    );
    (dir, path)
}

#[test]
fn a_set_aside_reads_the_log_a_crash_left_and_moves_it_with_the_store() {
    let (_dir, path) = damaged_with_log();
    let log = bytes(&beside(&path, "-wal"));
    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread), (2, 0));
    let aside = PathBuf::from(&done.set_aside);
    assert_eq!(
        bytes(&beside(&aside, "-wal")),
        log,
        "the log did not move with its store"
    );
    let core = Core::open(&path, None).unwrap();
    assert!(
        core.queue()
            .unwrap()
            .iter()
            .any(|write| write.id == "logged" && write.idempotency_key == "k-logged")
    );
}

#[cfg(debug_assertions)]
#[test]
fn a_set_aside_that_stops_part_way_loses_nothing_and_asking_again_finishes_it() {
    for stop in ["-wal", "store"] {
        let (_dir, path) = damaged_with_log();
        {
            let _stopping = crate::fault::fail_on_this_thread(&format!("set-aside-stop:{stop}"));
            assert!(Core::set_aside_damaged(&path).is_err(), "{stop}");
        }
        let (named, unsent, said) = damaged(Core::open(&path, None).err().unwrap());
        assert_eq!(named, path.display().to_string());
        assert_eq!(unsent, Some(2), "{stop}: {said}");
        assert!(said.contains("stopped part way"), "{said}");

        let done = set_aside(&path);
        assert_eq!((done.carried, done.unread), (2, 0), "{stop}");
        let aside = PathBuf::from(&done.set_aside);
        assert!(
            aside.ends_with("core.sqlite.damaged-1"),
            "{stop}: {aside:?}"
        );
        assert!(beside(&aside, "-wal").exists(), "{stop}");
        assert_eq!(Core::open(&path, None).unwrap().queue().unwrap().len(), 2);
    }
}

#[test]
fn writes_from_a_store_whose_instance_does_not_read_are_held_until_released() {
    let (_dir, path, queued) = store_with(1);
    store::meta_set(
        &Connection::open(&path).unwrap(),
        store::META_INSTANCE_ID,
        crate::scripted::INSTANCE,
    )
    .unwrap();
    damage_table(&path, "meta");
    let done = set_aside(&path);
    assert_eq!((done.carried, done.held), (1, 1));
    let core = Core::open(&path, None).unwrap();
    let held = core.queue().unwrap();
    assert_eq!(held[0].id, queued[0].id);
    assert_eq!(held[0].verdict, Some(crate::Verdict::Blocked));
    assert_eq!(held[0].reason.as_deref(), Some("instance_changed"));
}

#[test]
fn the_new_store_keeps_the_instance_and_a_drain_before_it_is_hydrated_sends_nothing() {
    let server = crate::scripted::Scripted::start();
    let (_dir, path, queued) = store_with(1);
    {
        let conn = Connection::open(&path).unwrap();
        store::meta_set(&conn, store::META_SERVER_ORIGIN, &server.url()).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
    }
    damage_table(&path, "items");
    let done = set_aside(&path);
    assert_eq!((done.carried, done.held), (1, 0));
    let core = Core::open(
        &path,
        Some(crate::Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_INSTANCE_ID)
            .unwrap()
            .as_deref(),
        Some(crate::scripted::INSTANCE)
    );
    assert_eq!(core.drain(), Err(CoreError::NoCursor));
    assert_eq!(server.asked(), 0);
    let kept = core.queue().unwrap();
    assert_eq!(
        kept.iter().map(sent).collect::<Vec<_>>(),
        queued.iter().map(sent).collect::<Vec<_>>()
    );
    assert!(kept.iter().all(|write| write.verdict.is_none()));
}

#[test]
fn a_damaged_store_is_removed_only_when_every_write_is_agreed_lost() {
    let (_dir, path, _) = store_with(1);
    damage_table(&path, "queue");
    assert!(matches!(
        Core::remove_store(&path, 1),
        Err(CoreError::UnsentDiffers { unsent: None, .. })
    ));
    assert!(path.exists());
    Core::remove_store_losing_all(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn a_folders_store_is_not_set_aside() {
    let (_dir, path, _) = store_with(1);
    store::meta_set(
        &Connection::open(&path).unwrap(),
        crate::folder::settings_file::META_FOLDER,
        "f1",
    )
    .unwrap();
    damage_table(&path, "items");
    assert!(matches!(
        Core::set_aside_damaged(&path),
        Err(CoreError::Invalid(said)) if said.contains("folder's store")
    ));
    assert!(!beside(&path, ".damaged-1").exists());
}
