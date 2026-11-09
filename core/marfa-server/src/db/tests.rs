use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::{Connection, Transaction};
use tempfile::TempDir;

use super::migrate::{MIGRATIONS, Migration};
use super::{Db, Options, Write};
use crate::app::faults::Faults;
use crate::app::refusal::{Code, Refusal, Result};
use crate::failure::Failure;
use crate::settings::DatabasePath;

const BASE: Migration = Migration {
    version: 1,
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE TABLE child (
              parent INTEGER REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED
          ) STRICT;",
};
const ONE: &[Migration] = &[BASE];
const TWO: &[Migration] = &[
    BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    },
];
const THREE: &[Migration] = &[
    BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    },
    Migration {
        version: 3,
        sql: "CREATE INDEX notes_pinned ON notes (pinned);",
    },
];
const INDEXED: &[Migration] = &[Migration {
    version: 1,
    sql: "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE INDEX IF NOT EXISTS notes_body ON notes (body);
          CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY) STRICT;",
}];

const WRITE: Write = Write::caller("key.create");

struct Folder {
    _dir: TempDir,
    file: PathBuf,
}

fn folder() -> Folder {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("marfa.db");
    Folder { _dir: dir, file }
}

fn options(file: &Path, migrations: &'static [Migration]) -> Options {
    Options {
        path: DatabasePath::File(file.to_path_buf()),
        busy_budget: Duration::from_millis(200),
        readers: 2,
        migrations,
        reserve: 0,
    }
}

fn open(file: &Path) -> Db {
    open_with(file, Arc::new(Faults::default()))
}

fn open_with(file: &Path, faults: Arc<Faults>) -> Db {
    Db::open(&options(file, ONE), faults)
        .map_err(|f| f.message)
        .unwrap()
}

fn refused(file: &Path, migrations: &'static [Migration]) -> Failure {
    match Db::open(&options(file, migrations), Arc::default()) {
        Ok(_) => panic!("the start was not refused"),
        Err(failure) => failure,
    }
}

fn add(tx: &Transaction<'_>, id: i64) -> Result<()> {
    tx.execute("INSERT INTO notes (id, body) VALUES (?1, 'note')", [id])?;
    Ok(())
}

async fn ids(db: &Db) -> Vec<i64> {
    db.read(|tx| {
        let mut rows = tx.prepare("SELECT id FROM notes ORDER BY id")?;
        let found = rows.query_map([], |row| row.get(0))?;
        Ok(found.collect::<rusqlite::Result<Vec<i64>>>()?)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn a_panic_in_a_write_rolls_back_and_the_writer_goes_on() {
    let place = folder();
    let db = open(&place.file);
    let answer: Result<()> = db
        .write(WRITE, |tx| {
            add(tx, 1)?;
            panic!("inside the job");
        })
        .await;
    assert_eq!(answer.unwrap_err().code, Code::InternalError);
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    assert_eq!(ids(&db).await, [2]);
}

#[tokio::test]
async fn an_error_after_a_partial_write_rolls_back() {
    let place = folder();
    let db = open(&place.file);
    let answer = db
        .write(WRITE, |tx| {
            add(tx, 1)?;
            add(tx, 2)?;
            Err::<(), _>(Refusal::validation("no"))
        })
        .await;
    assert_eq!(answer.unwrap_err().code, Code::ValidationError);
    assert!(ids(&db).await.is_empty());
}

#[tokio::test]
async fn a_commit_that_fails_keeps_nothing_and_leaves_no_transaction_open() {
    let place = folder();
    let db = open(&place.file);
    let answer = db
        .write(WRITE, |tx| {
            add(tx, 1)?;
            tx.execute("INSERT INTO child (parent) VALUES (99)", [])?;
            Ok(())
        })
        .await;
    assert!(answer.is_err());
    assert!(ids(&db).await.is_empty());
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    assert_eq!(ids(&db).await, [2]);
}

#[tokio::test]
async fn a_failed_commit_on_a_full_volume_says_its_outcome_is_unknown() {
    let place = folder();
    let faults = Arc::new(Faults::default());
    let db = open_with(&place.file, faults.clone());
    faults.set("fail:commit-full", None).unwrap();
    let refusal = db.write(WRITE, |tx| add(tx, 1)).await.unwrap_err();
    assert_eq!(refusal.details.unwrap()["write_outcome"], "unknown");
    assert!(ids(&db).await.is_empty());
}

#[tokio::test]
async fn a_stop_runs_what_is_queued_before_it() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let (release, released) = mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let first = {
        let db = db.clone();
        tokio::spawn(async move {
            db.write(WRITE, move |tx| {
                let _ = started.send(());
                let _ = released.recv();
                add(tx, 1)
            })
            .await
        })
    };
    running.await.unwrap();
    let queued = {
        let db = db.clone();
        tokio::spawn(async move { db.write(WRITE, |tx| add(tx, 2)).await })
    };
    tokio::task::yield_now().await;
    let closing = {
        let db = db.clone();
        tokio::spawn(async move { db.close().await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    release.send(()).unwrap();
    first.await.unwrap().unwrap();
    queued.await.unwrap().unwrap();
    closing.await.unwrap();

    let conn = Connection::open(&place.file).unwrap();
    let kept: i64 = conn
        .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, 2);
    assert_eq!(
        std::fs::metadata(wal(&place.file)).map_or(0, |m| m.len()),
        0
    );
}

fn wal(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

#[tokio::test]
async fn a_write_withdrawn_from_the_queue_never_runs() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let (release, released) = mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let first = {
        let db = db.clone();
        tokio::spawn(async move {
            db.write(WRITE, move |tx| {
                let _ = started.send(());
                let _ = released.recv();
                add(tx, 1)
            })
            .await
        })
    };
    running.await.unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let seen = ran.clone();
    let refusal = db
        .write(WRITE, move |tx| {
            seen.store(true, Ordering::SeqCst);
            add(tx, 2)
        })
        .await
        .unwrap_err();
    assert_eq!(refusal.code, Code::WriteContention);
    release.send(()).unwrap();
    first.await.unwrap().unwrap();
    db.write(WRITE, |tx| add(tx, 3)).await.unwrap();
    assert!(!ran.load(Ordering::SeqCst));
    assert_eq!(ids(&db).await, [1, 3]);
}

#[tokio::test]
async fn a_slow_write_does_not_block_a_read() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    let (release, released) = mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let slow = {
        let db = db.clone();
        tokio::spawn(async move {
            db.write(WRITE, move |tx| {
                add(tx, 2)?;
                let _ = started.send(());
                let _ = released.recv();
                Ok(())
            })
            .await
        })
    };
    running.await.unwrap();
    let read = tokio::time::timeout(Duration::from_secs(2), ids(&db)).await;
    release.send(()).unwrap();
    assert_eq!(read.unwrap(), [1]);
    slow.await.unwrap().unwrap();
}

/// The runtime here has one worker, which must stay free to send the answer
/// the read waits for.
#[tokio::test(flavor = "current_thread")]
async fn a_read_does_not_hold_an_async_worker() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let (tell, told) = mpsc::channel::<()>();
    let reading = {
        let db = db.clone();
        tokio::spawn(async move {
            db.read(move |_| Ok(told.recv_timeout(Duration::from_secs(2)).is_ok()))
                .await
        })
    };
    tokio::task::yield_now().await;
    tell.send(()).unwrap();
    assert!(reading.await.unwrap().unwrap());
}

#[tokio::test]
async fn a_read_is_one_snapshot_while_a_write_commits() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    let (tell, told) = mpsc::channel::<()>();
    let (started, reading) = tokio::sync::oneshot::channel();
    let read = {
        let db = db.clone();
        tokio::spawn(async move {
            db.read(move |tx| {
                let count = |tx: &Transaction<'_>| -> rusqlite::Result<i64> {
                    tx.query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
                };
                let before = count(tx)?;
                let _ = started.send(());
                let _ = told.recv();
                Ok((before, count(tx)?))
            })
            .await
        })
    };
    reading.await.unwrap();
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    tell.send(()).unwrap();
    assert_eq!(read.await.unwrap().unwrap(), (1, 1));
}

#[tokio::test]
async fn a_read_of_a_database_in_memory_is_one_snapshot_too() {
    let mut memory = options(Path::new("unused"), ONE);
    memory.path = DatabasePath::Memory;
    let db = Arc::new(
        Db::open(&memory, Arc::default())
            .map_err(|f| f.message)
            .unwrap(),
    );
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    let (tell, told) = mpsc::channel::<()>();
    let (started, reading) = tokio::sync::oneshot::channel();
    let read = {
        let db = db.clone();
        tokio::spawn(async move {
            db.read(move |tx| {
                let count = |tx: &Transaction<'_>| -> rusqlite::Result<i64> {
                    tx.query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
                };
                let before = count(tx)?;
                let _ = started.send(());
                let _ = told.recv();
                Ok((before, count(tx)?))
            })
            .await
        })
    };
    reading.await.unwrap();
    let held_back = db.write(WRITE, |tx| add(tx, 2)).await;
    tell.send(()).unwrap();
    assert_eq!(read.await.unwrap().unwrap(), (1, 1));
    assert_eq!(held_back.unwrap_err().code, Code::WriteContention);
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    assert_eq!(ids(&db).await, [1, 2]);
}

#[tokio::test]
async fn a_path_outside_ascii_opens_as_the_same_file_again() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("caf\u{e9} 100%.db");
    let db = open(&file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;

    let again = open(&file);
    assert_eq!(ids(&again).await, [1]);
    again.close().await;
    let names = std::fs::read_dir(dir.path()).unwrap().count();
    assert_eq!(names, 1, "a second file was made beside the first");
}

fn copy_of(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(super::open::BEFORE_UPGRADE);
    PathBuf::from(name)
}

fn version_of(file: &Path) -> u32 {
    Connection::open(file)
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn names_beside(file: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn opened(file: &Path, migrations: &'static [Migration], faults: Arc<Faults>) -> Db {
    Db::open(&options(file, migrations), faults)
        .map_err(|f| f.message)
        .unwrap()
}

#[tokio::test]
async fn an_older_database_holding_rows_is_copied_beside_it_then_upgraded() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;

    let db = opened(&place.file, TWO, Arc::default());
    assert_eq!(ids(&db).await, [1]);
    let pinned: i64 = db
        .read(|tx| {
            Ok(
                tx.query_row("SELECT pinned FROM notes WHERE id = 1", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(pinned, 0);
    db.close().await;
    assert_eq!(version_of(&place.file), 2);

    let copy = copy_of(&place.file);
    assert_eq!(version_of(&copy), 1);
    let kept: Vec<String> = Connection::open(&copy)
        .unwrap()
        .prepare("SELECT name FROM pragma_table_info('notes')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(kept, ["id", "body"]);
}

#[tokio::test]
async fn only_the_copy_from_before_the_last_upgrade_is_kept() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    opened(&place.file, TWO, Arc::default()).close().await;
    assert_eq!(version_of(&copy_of(&place.file)), 1);

    opened(&place.file, THREE, Arc::default()).close().await;
    assert_eq!(version_of(&copy_of(&place.file)), 2);
    assert_eq!(
        names_beside(&place.file)
            .iter()
            .filter(|name| name.contains("before-upgrade"))
            .count(),
        1
    );
}

#[tokio::test]
async fn an_older_database_holding_no_rows_is_upgraded_with_no_copy() {
    let place = folder();
    open(&place.file).close().await;

    opened(&place.file, TWO, Arc::default()).close().await;
    assert_eq!(version_of(&place.file), 2);
    assert!(!copy_of(&place.file).exists());
}

#[tokio::test]
async fn an_upgrade_with_no_room_for_its_copy_is_refused_and_changes_nothing() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    let before = std::fs::read(&place.file).unwrap();
    let names = names_beside(&place.file);

    let faults = Arc::new(Faults::default());
    faults.set("free:database", Some("4096")).unwrap();
    let failure = match Db::open(&options(&place.file, TWO), faults) {
        Ok(_) => panic!("the upgrade was not refused"),
        Err(failure) => failure,
    };
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("before-upgrade"),
        "{}",
        failure.message
    );
    assert!(
        failure.message.contains("4096 bytes are free"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), before);
    assert_eq!(names_beside(&place.file), names);
    assert_eq!(version_of(&place.file), 1);

    let witness = Arc::new(Faults::default());
    witness.set("free:database", Some("1073741824")).unwrap();
    opened(&place.file, TWO, witness).close().await;
    assert_eq!(version_of(&place.file), 2);
}

#[tokio::test]
async fn an_upgrade_whose_copy_fails_to_write_is_refused_and_changes_nothing() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    let before = std::fs::read(&place.file).unwrap();
    let mut blocked = place.file.as_os_str().to_owned();
    blocked.push(".before-upgrade.partial");
    let blocked = PathBuf::from(blocked);
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(blocked.join("held"), b"x").unwrap();

    let failure = refused(&place.file, TWO);
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("Nothing was changed"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), before);
    assert!(!copy_of(&place.file).exists());
    assert_eq!(version_of(&place.file), 1);
}

#[tokio::test]
async fn an_older_database_whose_schema_is_not_that_versions_is_refused() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("CREATE INDEX stray ON notes (body);")
        .unwrap();
    let before = std::fs::read(&place.file).unwrap();

    let failure = refused(&place.file, TWO);
    assert_eq!(failure.status, 78);
    assert!(
        failure.message.contains("is not this build's"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), before);
    assert!(!copy_of(&place.file).exists());
}

#[tokio::test]
async fn a_table_gone_with_its_index_is_made_again_with_it() {
    let place = folder();
    Db::open(&options(&place.file, INDEXED), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DROP TABLE notes;")
        .unwrap();

    Db::open(&options(&place.file, INDEXED), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;

    let held: i64 = Connection::open(&place.file)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('notes', 'notes_body')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(held, 2);
}

#[tokio::test]
async fn a_shipped_file_missing_tables_and_holding_no_rows_is_completed() {
    let place = folder();
    Db::open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DELETE FROM webhook_position; DROP TABLE items; DROP TABLE audit_log;")
        .unwrap();

    Db::open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
}

#[tokio::test]
async fn a_shipped_file_missing_a_table_and_holding_a_row_is_refused() {
    let place = folder();
    Db::open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DROP TABLE audit_log; INSERT INTO items_fts_pending (seq) VALUES (1);")
        .unwrap();

    let failure = refused(&place.file, MIGRATIONS);
    assert!(
        failure.message.contains("lacks the audit_log table"),
        "{}",
        failure.message
    );
}

#[tokio::test]
async fn an_index_gone_from_a_table_still_there_is_refused() {
    let place = folder();
    Db::open(&options(&place.file, INDEXED), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DROP INDEX notes_body;")
        .unwrap();

    let failure = refused(&place.file, INDEXED);
    assert!(
        failure.message.contains("lacks the notes_body index"),
        "{}",
        failure.message
    );
}

#[tokio::test]
async fn a_newer_database_is_refused_and_left_as_it_was() {
    let place = folder();
    Db::open(&options(&place.file, TWO), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    let before = std::fs::read(&place.file).unwrap();

    let failure = refused(&place.file, ONE);
    assert_eq!(failure.status, 78);
    assert!(
        failure.message.contains("newer build"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), before);
}

#[test]
fn a_file_that_is_not_a_database_is_refused_and_left_as_it_was() {
    let place = folder();
    let bytes = b"this is plainly not a database, though it is long enough to look";
    std::fs::write(&place.file, bytes).unwrap();

    let failure = refused(&place.file, ONE);
    assert!(
        failure.message.ends_with("is not a database"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), bytes);
    let beside = std::fs::read_dir(place.file.parent().unwrap()).unwrap();
    assert_eq!(beside.count(), 1);
}

async fn long_write(db: &Arc<Db>, naps: u32, beats: bool) -> tokio::task::JoinHandle<Result<()>> {
    let (holding, held) = tokio::sync::oneshot::channel();
    let pulse = db.pulse();
    let writing = db.clone();
    let write = tokio::spawn(async move {
        writing
            .write(WRITE, move |_| {
                let _ = holding.send(());
                for _ in 0..naps {
                    std::thread::sleep(Duration::from_millis(100));
                    if beats {
                        pulse.tick();
                    }
                }
                Ok(())
            })
            .await
    });
    held.await.unwrap();
    write
}

#[tokio::test]
async fn a_write_behind_a_job_that_keeps_beating_waits_until_it_ends() {
    let folder = folder();
    let db = Arc::new(open(&folder.file));
    let write = long_write(&db, 8, true).await;

    db.write(WRITE, |_| Ok(())).await.unwrap();

    write.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_write_behind_a_job_that_stopped_beating_meets_its_budget() {
    let folder = folder();
    let db = Arc::new(open(&folder.file));
    let write = long_write(&db, 8, false).await;

    let refused = db.write(WRITE, |_| Ok(())).await.unwrap_err();

    assert_eq!(refused.code, Code::WriteContention);
    write.await.unwrap().unwrap();
}

#[test]
fn a_database_locked_elsewhere_is_refused_within_its_budget() {
    let place = folder();
    let holder = Connection::open(&place.file).unwrap();
    holder.execute_batch(BASE.sql).unwrap();
    holder.pragma_update(None, "user_version", 1).unwrap();
    holder.execute_batch("BEGIN EXCLUSIVE").unwrap();

    let failure = refused(&place.file, ONE);
    assert!(
        failure.message.ends_with("is locked by another process"),
        "{}",
        failure.message
    );
    holder.execute_batch("ROLLBACK").unwrap();
    drop(holder);
    drop(open(&place.file));
}

#[tokio::test]
async fn a_commit_raises_the_watch_after_its_rows_can_be_read() {
    let place = folder();
    let db = open(&place.file);
    let mut commits = db.commits();
    let seen = *commits.borrow_and_update();
    assert!(!commits.has_changed().unwrap());

    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    commits.changed().await.unwrap();
    assert!(*commits.borrow_and_update() > seen);
    assert_eq!(ids(&db).await, [1]);
}

#[tokio::test]
async fn a_commit_that_errors_raises_the_watch_all_the_same() {
    let place = folder();
    let db = open(&place.file);
    let mut commits = db.commits();
    commits.borrow_and_update();

    let answer = db
        .write(WRITE, |tx| {
            add(tx, 1)?;
            tx.execute("INSERT INTO child (parent) VALUES (99)", [])?;
            Ok(())
        })
        .await;
    assert!(answer.is_err());
    assert!(
        commits.has_changed().unwrap(),
        "a stream would not look for a write that landed despite the error"
    );
}

#[tokio::test]
async fn a_write_that_rolls_back_raises_nothing() {
    let place = folder();
    let db = open(&place.file);
    let mut commits = db.commits();
    commits.borrow_and_update();

    let refused = db
        .write(WRITE, |tx| {
            add(tx, 1)?;
            Err::<(), _>(Refusal::validation("no"))
        })
        .await;
    assert!(refused.is_err());
    assert!(!commits.has_changed().unwrap());

    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    assert!(commits.has_changed().unwrap());
}

#[tokio::test]
async fn a_reader_woken_by_a_commit_never_misses_one_that_follows() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let mut commits = db.commits();
    let reader = {
        let db = db.clone();
        tokio::spawn(async move {
            let mut seen = 0;
            while seen < 40 {
                commits.borrow_and_update();
                let found = ids(&db).await.len();
                assert!(found >= seen);
                seen = found;
                if seen < 40 {
                    commits.changed().await.unwrap();
                }
            }
            seen
        })
    };
    for id in 0..40 {
        db.write(WRITE, move |tx| add(tx, id)).await.unwrap();
    }
    let reached = tokio::time::timeout(Duration::from_secs(5), reader)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reached, 40);
}
