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

#[test]
fn a_carried_row_write_lays_its_rows_again() {
    let (_dir, path, _) = store_with(0);
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, row_table, idempotency_key, payload, queued_at)
             VALUES ('rows', 'write_rows', 'n1', 'lines', 'k-rows',
                     '{\"operations\":[{\"op\":\"put\",\"id\":\"01890000-0000-7000-8000-000000000001\",\"values\":{\"a\":1}},{\"op\":\"delete\",\"id\":\"01890000-0000-7000-8000-000000000002\"}]}',
                     '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }
    damage_table(&path, "items");
    assert_eq!(set_aside(&path).carried, 1);
    let conn = Connection::open(&path).unwrap();
    let mut laid = conn
        .prepare("SELECT write_id, item_id, name, id FROM rows_laid ORDER BY id")
        .unwrap();
    let laid: Vec<(String, String, String, String)> = laid
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        laid,
        [
            "01890000-0000-7000-8000-000000000001",
            "01890000-0000-7000-8000-000000000002"
        ]
        .map(|id| ("rows".into(), "n1".into(), "lines".into(), id.to_string()))
        .to_vec()
    );
}

#[test]
fn a_store_another_core_writes_is_neither_checked_nor_set_aside() {
    let (_dir, path, _) = store_with(1);
    let writer = Core::open(&path, None).unwrap();
    assert_eq!(Core::check_store(&path), Err(CoreError::ReadingHandle));
    assert_eq!(
        Core::set_aside_damaged(&path),
        Err(CoreError::ReadingHandle)
    );
    drop(writer);
    Core::check_store(&path).unwrap();
}

#[test]
fn a_writer_that_meets_damage_leaves_the_log_and_the_file_as_they_were() {
    // The witness: a store that reads loses its log into the file at close.
    let (_held, healthy, _) = store_with(1);
    in_log(
        &healthy,
        "INSERT INTO meta (key, value) VALUES ('logged', 'x')",
    );
    drop(Core::open(&healthy, None).unwrap());
    assert!(!beside(&healthy, "-wal").exists());

    let (_dir, path) = damaged_with_log();
    let before = bytes(&path);
    let log = bytes(&beside(&path, "-wal"));
    assert!(log.is_some());
    let core = Core::open(&path, None).unwrap();
    assert_eq!(core.status().unwrap_err().code(), "store_damaged");
    drop(core);
    assert!(
        bytes(&beside(&path, "-wal")) == log,
        "the refusal changed the log"
    );
    assert!(bytes(&path) == before, "the refusal changed the store");
    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread), (2, 0));
}

#[test]
fn a_folders_store_whose_header_is_damaged_is_not_removed_or_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join(crate::folder::STATE_DIR);
    std::fs::create_dir(&state).unwrap();
    let path = state.join(store::FOLDER_STORE);
    drop(Core::open(&path, None).unwrap());
    overwrite(&path, 0, 100);
    let before = bytes(&path);

    // The witness: the same file anywhere else is removed.
    let elsewhere = dir.path().join("copy.sqlite");
    std::fs::copy(&path, &elsewhere).unwrap();
    Core::remove_store_losing_all(&elsewhere).unwrap();
    assert!(!elsewhere.exists());

    assert!(matches!(
        Core::remove_store_losing_all(&path),
        Err(CoreError::Invalid(said)) if said.contains("folder's store")
    ));
    assert!(matches!(
        Core::remove_store(&path, 0),
        Err(CoreError::Invalid(_))
    ));
    assert!(matches!(
        Core::replace_refused(&path, None),
        Err(CoreError::Invalid(_))
    ));
    assert!(matches!(
        Core::set_aside_damaged(&path),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(bytes(&path), before);
}

#[cfg(unix)]
#[test]
fn a_listed_folders_store_reached_by_another_name_is_not_removed() {
    let (registry, _own) = crate::folder::registry::tests::own_registry();
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = dir.path().join("folder");
    let state = root.join(crate::folder::STATE_DIR);
    std::fs::create_dir_all(&state).unwrap();
    let store_at = state.join(store::FOLDER_STORE);
    drop(Core::open(&store_at, None).unwrap());
    let link = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&state, &link).unwrap();
    let path = link.join(store::FOLDER_STORE);

    // The witness: unlisted, the folder's state reached by another name is
    // taken for a store of its own.
    overwrite(&path, 0, 100);
    let copy = bytes(&path);
    Core::remove_store_losing_all(&path).unwrap();
    assert!(!store_at.exists());
    std::fs::write(&store_at, copy.as_deref().unwrap()).unwrap();

    registry
        .add(
            &root,
            &crate::directory::Directory::open(&root).unwrap(),
            "f1",
            None,
        )
        .unwrap();
    assert!(matches!(
        Core::remove_store_losing_all(&path),
        Err(CoreError::Invalid(said)) if said.contains("folder's store")
    ));
    assert_eq!(bytes(&store_at), copy);
}

#[cfg(debug_assertions)]
#[test]
fn a_store_whose_set_aside_stopped_is_not_removed_or_replaced_until_it_finishes() {
    let (dir, path, _) = store_with(0);
    let core = Core::open(&path, None).unwrap();
    let source = dir.path().join("offline.txt");
    std::fs::write(&source, b"only upload copy").unwrap();
    core.add_file(&source, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = core
        .queue()
        .unwrap()
        .iter()
        .find(|q| q.kind == crate::WriteKind::UploadBlob)
        .unwrap()
        .blob
        .clone()
        .unwrap();
    drop(core);
    std::fs::remove_file(&source).unwrap();
    damage_table(&path, "items");
    {
        let _stopping = crate::fault::fail_on_this_thread("set-aside-stop:store");
        assert!(Core::set_aside_damaged(&path).is_err());
    }
    assert!(!path.exists());
    let made = beside(&path, ".carrying");
    let carried = bytes(&made);
    let held = || crate::blob::Cache::beside(&path).open_held(&hash).is_ok();
    assert!(held());

    for refused in [
        Core::remove_store(&path, 0).err(),
        Core::remove_store_losing_all(&path).err(),
        Core::replace_refused(&path, None).err(),
    ] {
        let (named, _, said) = damaged(refused.expect("refused"));
        assert_eq!(named, path.display().to_string());
        assert!(said.contains("stopped part way"), "{said}");
        assert!(said.contains("Set it aside"), "{said}");
    }
    assert_eq!(bytes(&made), carried);
    assert!(
        held(),
        "a refused removal took the bytes the carried upload needs"
    );

    let done = set_aside(&path);
    assert!(done.carried > 0);
    assert!(held());
    Core::remove_store_losing_all(&path).unwrap();
    assert!(!path.exists() && !made.exists());
    Core::open(&path, None).unwrap();
}

#[test]
fn a_file_a_set_aside_did_not_make_is_left_where_it_makes_the_new_store() {
    let (_dir, path, _) = store_with(1);
    damage_table(&path, "items");
    let damaged_bytes = bytes(&path);
    let made = beside(&path, ".carrying");

    // The witness: what a set-aside made before it carried anything is its
    // own, and is made again.
    {
        let conn = store::open(&made).unwrap();
        store::meta_set(&conn, "set_aside_making", "true").unwrap();
        store::without_log(&conn).unwrap();
    }
    assert!(matches!(
        Core::open(&path, None).err(),
        Some(CoreError::StoreDamaged { .. })
    ));
    assert_eq!(set_aside(&path).carried, 1);
    store::remove(&path).unwrap();
    std::fs::rename(beside(&path, ".damaged-1"), &path).unwrap();

    for other in [
        b"unrelated bytes".to_vec(),
        bytes(&path).unwrap()[..4096].to_vec(),
    ] {
        std::fs::write(&made, &other).unwrap();
        let before = bytes(&path);
        let said = Core::set_aside_damaged(&path).unwrap_err().to_string();
        assert!(said.contains(&made.display().to_string()), "{said}");
        assert!(said.contains("Move it elsewhere"), "{said}");
        assert_eq!(bytes(&made), Some(other));
        assert_eq!(bytes(&path), before);
        assert!(!beside(&path, ".damaged-1").exists());
        let (_, _, said) = damaged(Core::open(&path, None).err().unwrap());
        assert!(said.contains("is not one a set-aside made"), "{said}");
    }
    assert_eq!(bytes(&path), damaged_bytes);
}

#[test]
fn a_set_aside_carries_every_queue_column_and_keeps_upload_bytes() {
    let (dir, path, _) = store_with(0);
    let core = Core::open(&path, None).unwrap();
    let source = dir.path().join("offline.txt");
    std::fs::write(&source, b"offline upload bytes").unwrap();
    core.add_file(&source, &crate::Attachment::default(), &[])
        .unwrap();
    let queued = core.queue().unwrap();
    let hash = queued
        .iter()
        .find(|q| q.kind == crate::WriteKind::UploadBlob)
        .unwrap()
        .blob
        .clone()
        .unwrap();
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    let rows = |path: &Path| {
        let conn = Connection::open(path).unwrap();
        let mut statement = conn.prepare("SELECT * FROM queue ORDER BY seq").unwrap();
        let count = statement.column_count();
        statement
            .query_map([], |row| {
                (0..count)
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    drop(core);
    let before = rows(&path);
    damage_table(&path, "items");
    assert_eq!(set_aside(&path).carried, queued.len() as u64);
    assert_eq!(rows(&path), before);
    let core = Core::open(&path, None).unwrap();
    core.trim_files().unwrap();
    let mut contents = Vec::new();
    std::io::Read::read_to_end(
        &mut core.cache().unwrap().open_held(&hash).unwrap(),
        &mut contents,
    )
    .unwrap();
    assert_eq!(contents, b"offline upload bytes");
}

/// A store holding an edge write a body made, from a body write that came
/// back conflicted on the body, so the edge must not be sent.
fn store_with_a_lost_bodys_edge() -> (tempfile::TempDir, PathBuf, String) {
    let (dir, path, queued) = store_with(1);
    let write = &queued[0];
    let item = write.item_id.as_ref().unwrap();
    let core = Core::open(&path, None).unwrap();
    let conn = core.conn().unwrap();
    conn.execute(
        "UPDATE queue SET kind = 'update_item', verdict = 'conflicted',
                answer = '{\"conflict_resolution\":{\"fields\":[\"body\"]}}',
                conflicted_copy_id = 'sibling'
          WHERE id = ?1",
        [&write.id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO queue (id, kind, item_id, target_id, edge_id, idempotency_key, payload, depends_on, queued_at)
         VALUES ('edge', 'create_edge', ?1, 'other', 'edge-id', 'edge-key', '{}', ?2, '2026-01-01T00:00:00Z')",
        rusqlite::params![item, serde_json::to_string(&[&write.id]).unwrap()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO body_edges (write_id, item_id, kind, other_id, body_write)
         VALUES ('edge', ?1, 'link', 'other', ?2)",
        rusqlite::params![item, write.id],
    )
    .unwrap();
    let edge = store::queued_write(&conn, "edge").unwrap().unwrap();
    assert!(
        crate::body::rule::lost_body(&conn, &edge)
            .unwrap()
            .is_some()
    );
    drop(conn);
    drop(core);
    (dir, path, "edge".into())
}

fn verdict_of(path: &Path, id: &str) -> (Option<crate::Verdict>, Option<String>) {
    let core = Core::open(path, None).unwrap();
    let conn = core.conn().unwrap();
    let write = store::queued_write(&conn, id).unwrap().unwrap();
    (write.verdict, write.reason)
}

#[test]
fn a_carried_write_whose_guarding_record_does_not_read_is_held() {
    // The witness: with its record read, the edge is carried waiting, and
    // the record goes with it.
    let (_held, path, edge) = store_with_a_lost_bodys_edge();
    damage_table(&path, "items");
    let done = set_aside(&path);
    assert_eq!((done.whole, done.record_unread), (true, 0));
    assert_eq!(verdict_of(&path, &edge), (None, None));
    let rows: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM body_edges", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);

    let (_dir, path, edge) = store_with_a_lost_bodys_edge();
    damage_table(&path, "body_edges");
    let done = set_aside(&path);
    assert_eq!((done.whole, done.record_unread, done.held), (false, 1, 0));
    assert_eq!(
        verdict_of(&path, &edge),
        (
            Some(crate::Verdict::Blocked),
            Some("record_unread".to_string())
        )
    );
}

#[test]
fn a_create_whose_chosen_tier_does_not_read_is_held_and_the_rest_wait_for_the_instance() {
    let (_dir, path, queued) = store_with(2);
    {
        let conn = Connection::open(&path).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::choose_tier(&conn, &queued[0].id, crate::Tier::Feed).unwrap();
    }
    damage_table(&path, "meta");
    let done = set_aside(&path);
    assert_eq!(
        (done.carried, done.whole, done.record_unread, done.held),
        (2, false, 1, 1)
    );
    assert_eq!(
        verdict_of(&path, &queued[0].id).1.as_deref(),
        Some("record_unread")
    );
    assert_eq!(
        verdict_of(&path, &queued[1].id).1.as_deref(),
        Some("instance_changed")
    );
}

#[test]
fn a_log_with_no_store_of_a_set_asides_beside_it_is_left_and_named() {
    for (name, log) in [
        (".carrying", "-wal"),
        (".carrying", "-journal"),
        (".carrying", "-shm"),
        (".making", "-wal"),
    ] {
        let (_dir, path, _) = store_with(1);
        damage_table(&path, "items");
        let stray = beside(&beside(&path, name), log);
        std::fs::write(&stray, b"a person's log").unwrap();
        let before = bytes(&path);
        let said = Core::set_aside_damaged(&path).unwrap_err().to_string();
        assert!(said.contains(&stray.display().to_string()), "{said}");
        assert_eq!(bytes(&stray).as_deref(), Some(&b"a person's log"[..]));
        assert_eq!(bytes(&path), before, "{name}{log}");
        assert!(!beside(&path, ".damaged-1").exists(), "{name}{log}");
        assert!(!beside(&path, name).exists(), "{name}{log}");

        // The witness: with the log moved, the set-aside goes ahead.
        std::fs::remove_file(&stray).unwrap();
        assert_eq!(set_aside(&path).carried, 1, "{name}{log}");
    }
}

#[test]
fn a_new_store_left_part_made_is_removed_only_where_it_holds_nothing_or_a_set_aside_marked_it() {
    let making = |path: &Path| beside(path, ".making");
    let empty = |path: &Path| std::fs::write(making(path), b"").unwrap();
    let marked = |path: &Path| {
        store::make_marked(&making(path), &[("set_aside_making", "true")]).unwrap();
    };
    // A crash part way through the transaction that makes it leaves frames
    // in the log that no commit made part of the store.
    let crashed = |path: &Path| logged(path, false);
    for (left, make) in [
        ("empty", &empty as &dyn Fn(&Path)),
        ("marked", &marked),
        ("crashed", &crashed),
    ] {
        let (_dir, path, _) = store_with(1);
        damage_table(&path, "items");
        make(&path);
        assert_eq!(set_aside(&path).carried, 1, "{left}");
        for log in store::STORE_FILES {
            assert!(!beside(&making(&path), log).exists(), "{left}{log}");
        }
    }

    let unmarked = |path: &Path| drop(store::open(&making(path)).unwrap());
    let other = |path: &Path| std::fs::write(making(path), b"unrelated bytes").unwrap();
    let committed = |path: &Path| logged(path, true);
    for (left, make) in [
        ("unmarked", &unmarked as &dyn Fn(&Path)),
        ("other", &other),
        ("committed", &committed),
    ] {
        let (_dir, path, _) = store_with(1);
        damage_table(&path, "items");
        make(&path);
        let kept = bytes(&making(&path));
        let before = bytes(&path);
        let said = match Core::set_aside_damaged(&path) {
            Err(error) => error.to_string(),
            Ok(done) => panic!("{left}: set aside past what it did not make: {done:?}"),
        };
        assert!(
            said.contains(&making(&path).display().to_string()),
            "{said}"
        );
        assert_eq!(bytes(&making(&path)), kept, "{left}");
        assert_eq!(bytes(&path), before, "{left}");
        assert!(!beside(&path, ".carrying").exists(), "{left}");
        assert!(!beside(&path, ".damaged-1").exists(), "{left}");
    }
}

/// An empty file at `<path>.making` with a log beside it that holds a table
/// of rows, committed or not, as a process that ended part way leaves it.
fn logged(path: &Path, committed: bool) {
    empty_with_log(&beside(path, ".making"), committed);
}

fn empty_with_log(made: &Path, committed: bool) {
    let scratch = beside(made, ".scratch");
    std::fs::write(made, b"").unwrap();
    let conn = Connection::open(&scratch).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = 1;
         BEGIN; CREATE TABLE t (x);
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
         INSERT INTO t SELECT randomblob(1000) FROM n;",
    )
    .unwrap();
    if committed {
        conn.execute_batch("COMMIT").unwrap();
    }
    let log = bytes(&beside(&scratch, "-wal")).unwrap();
    assert!(!log.is_empty());
    std::fs::write(beside(made, "-wal"), log).unwrap();
    drop(conn);
    store::remove(&scratch).unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn a_set_aside_stopped_while_it_makes_the_new_store_leaves_nothing_at_carrying_and_finishes() {
    for stop in ["made", "making"] {
        let (_dir, path, queued) = store_with(1);
        damage_table(&path, "items");
        let damaged_bytes = bytes(&path);
        {
            let _stopping = crate::fault::fail_on_this_thread(&format!("set-aside-stop:{stop}"));
            assert!(Core::set_aside_damaged(&path).is_err(), "{stop}");
        }
        assert!(!beside(&path, ".carrying").exists(), "{stop}");
        assert_eq!(bytes(&path), damaged_bytes, "{stop}");
        let done = set_aside(&path);
        assert_eq!((done.carried, done.unread), (1, 0), "{stop}");
        assert!(done.set_aside.ends_with("core.sqlite.damaged-1"), "{stop}");
        assert!(!beside(&path, ".making").exists(), "{stop}");
        let carried = Core::open(&path, None).unwrap().queue().unwrap();
        assert_eq!(
            carried.iter().map(sent).collect::<Vec<_>>(),
            queued.iter().map(sent).collect::<Vec<_>>()
        );
    }
}

#[test]
fn every_carried_write_whose_record_does_not_read_is_held_whatever_its_verdict() {
    let (_dir, path, queued) = store_with(3);
    {
        let conn = Connection::open(&path).unwrap();
        for write in &queued {
            store::choose_tier(&conn, &write.id, crate::Tier::Feed).unwrap();
        }
        conn.execute(
            "UPDATE queue SET verdict = 'blocked', reason = 'key_spent',
                    answered_at = '2026-01-01T00:00:00Z' WHERE id = ?1",
            [&queued[0].id],
        )
        .unwrap();
        conn.execute(
            "UPDATE queue SET verdict = 'dead', answered_at = '2026-01-01T00:00:00Z' WHERE id = ?1",
            [&queued[1].id],
        )
        .unwrap();
    }
    damage_table(&path, "meta");
    let done = set_aside(&path);
    assert_eq!((done.carried, done.record_unread, done.held), (3, 3, 0));
    for write in &queued {
        assert_eq!(
            verdict_of(&path, &write.id),
            (
                Some(crate::Verdict::Blocked),
                Some("record_unread".to_string())
            ),
            "{}",
            write.id
        );
    }

    // Released, a write keeps the key the server spent, so a drain is
    // refused under it again.
    let core = Core::open(&path, None).unwrap();
    assert!(core.release(&queued[0].id).unwrap());
    let released = core
        .queue()
        .unwrap()
        .into_iter()
        .find(|write| write.id == queued[0].id)
        .unwrap();
    assert_eq!(
        (released.verdict, released.idempotency_key),
        (None, queued[0].idempotency_key.clone())
    );
}

#[test]
fn a_write_held_record_unread_keeps_its_reason_when_the_copy_moves_to_another_instance() {
    let (_dir, path, edge) = store_with_a_lost_bodys_edge();
    damage_table(&path, "body_edges");
    assert_eq!(set_aside(&path).record_unread, 1);
    let core = Core::open(&path, None).unwrap();
    let waiting = core.create_item(&note(None)).unwrap();
    let conn = core.conn().unwrap();
    store::block_for_another_instance(&conn).unwrap();
    let reason = |id: &str| store::queued_write(&conn, id).unwrap().unwrap().reason;
    // The witness: a write that was waiting is held for the instance.
    assert_eq!(reason(&waiting.id).as_deref(), Some("instance_changed"));
    assert_eq!(reason(&edge).as_deref(), Some("record_unread"));
}

#[cfg(unix)]
#[test]
fn a_folders_store_that_fails_to_open_on_damage_keeps_its_log() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let state = dir.path().join(crate::folder::STATE_DIR);
    std::fs::create_dir(&state).unwrap();
    let path = state.join(store::FOLDER_STORE);
    drop(Core::open(&path, None).unwrap());
    damage_table(&path, "meta");
    in_log(
        &path,
        "CREATE TABLE logged (x); INSERT INTO logged VALUES (1);",
    );
    let before = bytes(&path);
    let log = bytes(&beside(&path, "-wal"));
    assert!(log.is_some());
    let directory = crate::directory::Directory::open(&state).unwrap();
    let error = Core::open_directory(&directory, &path, None).err().unwrap();
    assert_eq!(error.code(), "store_damaged", "{error}");
    assert!(
        bytes(&beside(&path, "-wal")) == log,
        "the open changed the log"
    );
    assert!(bytes(&path) == before, "the open changed the store");
}

#[test]
fn an_empty_file_whose_log_holds_writes_keeps_its_log() {
    // SQLite deletes such a log as it opens the file, even to read.
    let (_dir, path, _) = store_with(0);
    store::remove(&path).unwrap();
    empty_with_log(&path, true);
    let log = bytes(&beside(&path, "-wal"));
    let (named, unsent, _) = damaged(Core::check_store(&path).unwrap_err());
    assert_eq!((named, unsent), (path.display().to_string(), None));
    assert_eq!(bytes(&beside(&path, "-wal")), log);
    let done = set_aside(&path);
    assert_eq!(bytes(&beside(Path::new(&done.set_aside), "-wal")), log);

    let (_dir, path, _) = store_with(1);
    damage_table(&path, "items");
    let made = beside(&path, ".carrying");
    empty_with_log(&made, true);
    let log = bytes(&beside(&made, "-wal"));
    let said = Core::set_aside_damaged(&path).unwrap_err().to_string();
    assert!(said.contains(&made.display().to_string()), "{said}");
    assert!(Core::open(&path, None).is_err());
    assert_eq!(bytes(&beside(&made, "-wal")), log);
}

fn reason_of(core: &Core, id: &str) -> Option<String> {
    store::queued_write(&core.conn().unwrap(), id)
        .unwrap()
        .unwrap()
        .reason
}

const ANOTHER_INSTANCE: &str = "another-instance";

/// A store built from `scripted::INSTANCE` whose `count` creates are carried
/// by a set-aside that cannot read their body checks, so each is held
/// `record_unread`.
fn carried_record_unread(count: usize) -> (tempfile::TempDir, PathBuf, Vec<QueuedWrite>) {
    let (dir, path, queued) = store_with(count);
    store::meta_set(
        &Connection::open(&path).unwrap(),
        store::META_INSTANCE_ID,
        crate::scripted::INSTANCE,
    )
    .unwrap();
    damage_table(&path, "body_checks");
    assert_eq!(set_aside(&path).record_unread, count as u64);
    (dir, path, queued)
}

/// What a hydration from another instance does to the store's meta and queue.
fn built_from_another_instance(core: &Core) {
    let conn = core.conn().unwrap();
    store::block_for_another_instance(&conn).unwrap();
    store::meta_set(&conn, store::META_INSTANCE_ID, ANOTHER_INSTANCE).unwrap();
}

#[test]
fn a_write_held_record_unread_whose_instance_changed_needs_a_second_release() {
    let (_dir, path, queued) = carried_record_unread(2);
    let core = Core::open(&path, None).unwrap();
    let (first, second) = (&queued[0].id, &queued[1].id);
    // The witness: with the instance unchanged, one release sends it.
    assert!(core.release(second).unwrap());
    assert_eq!(reason_of(&core, second), None);

    built_from_another_instance(&core);
    assert_eq!(reason_of(&core, first).as_deref(), Some("record_unread"));
    assert!(!core.release(first).unwrap());
    assert_eq!(reason_of(&core, first).as_deref(), Some("instance_changed"));
    assert!(core.release(first).unwrap());
    assert_eq!(reason_of(&core, first), None);
}

#[test]
fn a_later_set_aside_keeps_record_unread_writes_held_for_the_instance() {
    // The witness: with the instance unchanged, a later set-aside's store
    // sends the write on one release.
    for (damaged, moved, held) in [
        ("items", false, false),
        ("items", true, true),
        ("meta", true, true),
    ] {
        let (_dir, path, queued) = carried_record_unread(1);
        if moved {
            built_from_another_instance(&Core::open(&path, None).unwrap());
        }
        damage_table(&path, damaged);
        set_aside(&path);
        let core = Core::open(&path, None).unwrap();
        let id = &queued[0].id;
        assert_eq!(
            reason_of(&core, id).as_deref(),
            Some("record_unread"),
            "{damaged}"
        );
        assert_eq!(core.release(id).unwrap(), !held, "{damaged}, moved {moved}");
        if held {
            assert_eq!(reason_of(&core, id).as_deref(), Some("instance_changed"));
            assert!(core.release(id).unwrap());
        }
        assert_eq!(reason_of(&core, id), None);
    }
}

/// Makes the carried writes one row batch, led by the first.
fn one_batch(core: &Core, queued: &[QueuedWrite]) {
    let conn = core.conn().unwrap();
    conn.execute("UPDATE queue SET kind = 'write_rows'", [])
        .unwrap();
    conn.execute(
        "UPDATE queue SET batched_with = ?1 WHERE id = ?2",
        rusqlite::params![queued[0].id, queued[1].id],
    )
    .unwrap();
}

#[test]
fn a_row_batch_released_from_record_unread_is_held_for_the_instance_as_one() {
    // The witness: with the instance unchanged, a release by reason sends
    // the batch.
    let (_dir, path, queued) = carried_record_unread(2);
    let core = Core::open(&path, None).unwrap();
    one_batch(&core, &queued);
    assert_eq!(
        core.release_reason(crate::BlockedReason::RecordUnread)
            .unwrap(),
        2
    );

    let (_dir, path, queued) = carried_record_unread(2);
    let core = Core::open(&path, None).unwrap();
    one_batch(&core, &queued);
    built_from_another_instance(&core);
    assert_eq!(
        core.release_reason(crate::BlockedReason::RecordUnread)
            .unwrap(),
        0
    );
    for write in &queued {
        assert_eq!(
            reason_of(&core, &write.id).as_deref(),
            Some("instance_changed")
        );
    }

    let (_dir, path, queued) = carried_record_unread(2);
    let core = Core::open(&path, None).unwrap();
    one_batch(&core, &queued);
    built_from_another_instance(&core);
    assert!(!core.release(&queued[1].id).unwrap());
    for write in &queued {
        assert_eq!(
            reason_of(&core, &write.id).as_deref(),
            Some("instance_changed")
        );
    }
    assert_eq!(
        core.release_reason(crate::BlockedReason::InstanceChanged)
            .unwrap(),
        2
    );
}

#[test]
fn a_write_held_record_unread_from_a_store_whose_instance_does_not_read_needs_a_second_release() {
    let (_dir, path, queued) = store_with(2);
    {
        let conn = Connection::open(&path).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::choose_tier(&conn, &queued[0].id, crate::Tier::Feed).unwrap();
    }
    damage_table(&path, "meta");
    let done = set_aside(&path);
    assert_eq!((done.record_unread, done.held), (1, 1));
    let core = Core::open(&path, None).unwrap();
    assert_eq!(
        core.release_reason(crate::BlockedReason::RecordUnread)
            .unwrap(),
        0
    );
    assert_eq!(
        reason_of(&core, &queued[0].id).as_deref(),
        Some("instance_changed")
    );
    assert_eq!(
        core.release_reason(crate::BlockedReason::InstanceChanged)
            .unwrap(),
        2
    );
    assert_eq!(reason_of(&core, &queued[0].id), None);
}

/// A store whose every page is in its log and whose file was emptied, as a
/// truncation or a copy taken of the log alone leaves it.
fn emptied_with_log(count: usize) -> (tempfile::TempDir, PathBuf, Vec<QueuedWrite>) {
    let (dir, path, queued) = store_with(count);
    in_log(&path, "VACUUM;");
    std::fs::write(&path, b"").unwrap();
    (dir, path, queued)
}

#[test]
fn every_open_refuses_an_empty_file_whose_log_holds_writes_and_a_set_aside_carries_them() {
    // The witness: a log with nothing committed beside an empty file is an
    // empty store, which opens.
    let (_dir, path, _) = store_with(0);
    store::remove(&path).unwrap();
    empty_with_log(&path, false);
    drop(Core::open(&path, None).unwrap());

    let (_dir, path, queued) = emptied_with_log(2);
    let log = bytes(&beside(&path, "-wal"));
    let (named, unsent, said) = damaged(Core::open(&path, None).err().unwrap());
    assert_eq!((named, unsent), (path.display().to_string(), None));
    assert!(said.contains("log holds committed writes"), "{said}");
    assert_eq!(bytes(&beside(&path, "-wal")), log);
    assert_eq!(bytes(&path), Some(Vec::new()));
    let (named, _, _) = damaged(Core::open_reader(&path).err().unwrap());
    assert_eq!(named, path.display().to_string());
    assert_eq!(bytes(&beside(&path, "-wal")), log);

    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread), (2, 0));
    let aside = PathBuf::from(&done.set_aside);
    assert_eq!(bytes(&beside(&aside, "-wal")), log);
    assert_eq!(bytes(&aside), Some(Vec::new()));
    let core = Core::open(&path, None).unwrap();
    let carried = core.queue().unwrap();
    assert_eq!(
        carried.iter().map(sent).collect::<Vec<_>>(),
        queued.iter().map(sent).collect::<Vec<_>>()
    );
    let holder = path.parent().unwrap();
    let left: Vec<_> = std::fs::read_dir(holder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().starts_with(".marfa-reading"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[cfg(unix)]
#[test]
fn a_folders_store_whose_file_is_empty_and_whose_log_holds_writes_is_refused_and_kept() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let state = dir.path().join(crate::folder::STATE_DIR);
    std::fs::create_dir(&state).unwrap();
    let path = state.join(store::FOLDER_STORE);
    drop(Core::open(&path, None).unwrap());
    in_log(&path, "VACUUM;");
    std::fs::write(&path, b"").unwrap();
    let log = bytes(&beside(&path, "-wal"));
    let directory = crate::directory::Directory::open(&state).unwrap();
    let (named, _, _) = damaged(Core::open_directory(&directory, &path, None).err().unwrap());
    assert_eq!(named, path.display().to_string());
    assert_eq!(bytes(&beside(&path, "-wal")), log);
    let (named, _, _) = damaged(Core::read_directory(&directory, &path).err().unwrap());
    assert_eq!(named, path.display().to_string());
    assert_eq!(bytes(&beside(&path, "-wal")), log);
    assert_eq!(bytes(&path), Some(Vec::new()));
}

#[test]
fn a_log_of_64_kib_pages_beside_an_empty_file_is_refused_and_carried() {
    let (_dir, path, queued) = store_with(2);
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE; PRAGMA page_size = 65536; VACUUM;
             PRAGMA journal_mode = WAL;",
        )
        .unwrap();
    }
    in_log(&path, "VACUUM;");
    std::fs::write(&path, b"").unwrap();
    let log = bytes(&beside(&path, "-wal")).unwrap();
    assert_eq!(log[8..12], 65_536u32.to_be_bytes());
    damaged(Core::open(&path, None).err().unwrap());
    assert_eq!(bytes(&beside(&path, "-wal")), Some(log.clone()));
    let done = set_aside(&path);
    assert_eq!((done.carried, done.unread), (2, 0), "{done:?}");
    assert_eq!(
        bytes(&beside(Path::new(&done.set_aside), "-wal")),
        Some(log)
    );
    assert_eq!(
        Core::open(&path, None)
            .unwrap()
            .queue()
            .unwrap()
            .iter()
            .map(sent)
            .collect::<Vec<_>>(),
        queued.iter().map(sent).collect::<Vec<_>>()
    );
}

#[test]
fn a_log_whose_tail_is_torn_or_foreign_still_gives_its_committed_writes() {
    for tail in ["torn", "foreign"] {
        let (_dir, path, _) = emptied_with_log(2);
        let log_path = beside(&path, "-wal");
        let mut log = bytes(&log_path).unwrap();
        if tail == "torn" {
            log.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 0, 11]);
        } else {
            // A frame whose salt is not the log's, as a reused log leaves.
            let mut frame = log[32..32 + 24 + 4096].to_vec();
            frame[8] ^= 1;
            log.extend_from_slice(&frame);
        }
        std::fs::write(&log_path, &log).unwrap();
        let done = set_aside(&path);
        assert_eq!(done.carried, 2, "{tail}, {done:?}");
        assert_eq!(
            bytes(&beside(Path::new(&done.set_aside), "-wal")),
            Some(log)
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_log_that_cannot_be_copied_to_be_read_stops_the_set_aside_before_anything_moves() {
    let (dir, path, _) = emptied_with_log(2);
    let log = bytes(&beside(&path, "-wal"));
    let acl = |args: &[&str]| {
        assert!(
            std::process::Command::new("chmod")
                .args(args)
                .arg(dir.path())
                .status()
                .unwrap()
                .success()
        );
    };
    acl(&["+a", "everyone deny add_subdirectory"]);
    let refused = Core::set_aside_damaged(&path);
    acl(&["-N"]);
    let said = refused.unwrap_err().to_string();
    assert!(said.contains("cannot be copied to be read"), "{said}");
    assert_eq!(bytes(&path), Some(Vec::new()));
    assert_eq!(bytes(&beside(&path, "-wal")), log);
    assert!(
        present_beside(&path).is_empty(),
        "{:?}",
        present_beside(&path)
    );
    let done = set_aside(&path);
    assert_eq!(
        (done.carried, done.set_aside.ends_with(".damaged-1")),
        (2, true)
    );
}

/// What stands beside `path` other than its own file, log and writer lock.
fn present_beside(path: &Path) -> Vec<std::ffi::OsString> {
    let own = [
        path.to_path_buf(),
        beside(path, "-wal"),
        beside(path, ".writer-lock"),
    ];
    std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|name| !own.contains(name))
        .map(|name| name.file_name().unwrap().to_owned())
        .collect()
}
