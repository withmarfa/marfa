use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use marfa_rules::server_log::{
    DatabaseUpgrade, RefusedUpgrade, UpgradeRefusal, last_upgrade, refused_upgrade, upgraded,
};
use rusqlite::{Connection, Transaction, ffi};
use tempfile::TempDir;

use super::migrate::{MIGRATIONS, Migration};
use super::{Db, Lock, Options, Write};
use crate::app::faults::Faults;
use crate::app::items::bulk::each;
use crate::app::provenance;
use crate::app::refusal::{Code, Refusal, Result};
use crate::failure::Failure;
use crate::settings::DatabasePath;

const BASE: Migration = Migration {
    version: 1,
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE TABLE child (
              parent INTEGER REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED
          ) STRICT;",
    done: None,
};
const ONE: &[Migration] = &[BASE];
const TWO: &[Migration] = &[
    BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        done: None,
    },
];
const THREE: &[Migration] = &[
    BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        done: None,
    },
    Migration {
        version: 3,
        sql: "CREATE INDEX notes_pinned ON notes (pinned);",
        done: None,
    },
];
const SETTINGS_BASE: Migration = Migration {
    version: 1,
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;",
    done: None,
};
const SETTINGS_ONE: &[Migration] = &[SETTINGS_BASE];
const SETTINGS_TWO: &[Migration] = &[
    SETTINGS_BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        done: None,
    },
];
const INDEXED: &[Migration] = &[Migration {
    version: 1,
    sql: "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE INDEX IF NOT EXISTS notes_body ON notes (body);
          CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY) STRICT;",
    done: None,
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
        write_wait: Duration::from_millis(200),
        readers: 2,
        migrations,
        reserve: 0,
        upgrade_marks: None,
    }
}

/// As a start does: the lock first, then the file.
fn db_open(options: &Options, faults: Arc<Faults>) -> std::result::Result<Db, Failure> {
    Db::open(options, Lock::take(&options.path)?, faults)
}

fn open(file: &Path) -> Db {
    open_with(file, Arc::new(Faults::default()))
}

fn open_with(file: &Path, faults: Arc<Faults>) -> Db {
    db_open(&options(file, ONE), faults)
        .map_err(|f| f.message)
        .unwrap()
}

fn refused(file: &Path, migrations: &'static [Migration]) -> Failure {
    match db_open(&options(file, migrations), Arc::default()) {
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
    assert_eq!(refusal.code, Code::InsufficientStorage);
    assert_eq!(refusal.details.unwrap()["write_outcome"], "unknown");
    assert!(refusal.message.contains("may or may not have been saved"));
    assert!(ids(&db).await.is_empty());
}

#[tokio::test]
async fn a_volume_full_before_the_commit_is_refused_as_not_written() {
    let place = folder();
    let db = open(&place.file);
    let refusal = db
        .write(WRITE, |tx| {
            let pages: i64 = tx.query_row("PRAGMA page_count", [], |row| row.get(0))?;
            tx.query_row(&format!("PRAGMA max_page_count = {pages}"), [], |_| Ok(()))?;
            let body = "x".repeat(65_536);
            tx.execute("INSERT INTO notes (id, body) VALUES (1, ?1)", [body])?;
            Ok(())
        })
        .await
        .unwrap_err();
    assert_eq!(refusal.code, Code::InsufficientStorage);
    assert!(!refusal.commit_failed);
    assert!(refusal.details.is_none());
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
async fn a_write_is_listed_as_queued_from_its_admission_until_it_starts() {
    let place = folder();
    let faults = Arc::new(Faults::default());
    let db = Arc::new(open_with(&place.file, faults.clone()));
    let (release, released) = mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let busy = {
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
    assert!(faults.queued_writes().is_empty());
    let named = {
        let db = db.clone();
        tokio::spawn(async move { db.write(WRITE, |tx| add(tx, 2)).await })
    };
    while faults.queued_writes().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let own = {
        let db = db.clone();
        tokio::spawn(async move { db.write(Write::own(), |tx| add(tx, 3)).await })
    };
    while faults.queued_writes().len() < 2 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let holding = db
        .hold_writes(Refusal::new(Code::WriteContention, "held"))
        .unwrap();
    db.write(WRITE, |tx| add(tx, 4)).await.unwrap_err();
    assert_eq!(faults.queued_writes(), [Some("key.create"), None]);
    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    named.await.unwrap().unwrap();
    own.await.unwrap().unwrap();
    drop(holding);
    assert!(faults.queued_writes().is_empty());
    assert_eq!(ids(&db).await, [1, 2, 3]);
}

#[tokio::test]
async fn a_hold_refuses_a_callers_write_at_once_and_queues_its_own_and_background_writes() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let (release, released) = mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let busy = {
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
    let holding = db
        .hold_writes(Refusal::new(Code::WriteContention, "held"))
        .unwrap();
    let own = {
        let db = db.clone();
        tokio::spawn(
            holding
                .permit()
                .run(async move { db.write(WRITE, |tx| add(tx, 3)).await }),
        )
    };
    let ran = Arc::new(AtomicBool::new(false));
    let seen = ran.clone();
    let asked = std::time::Instant::now();
    let refusal = db
        .write(WRITE, move |tx| {
            seen.store(true, Ordering::SeqCst);
            add(tx, 2)
        })
        .await
        .unwrap_err();
    assert!(asked.elapsed() < Duration::from_millis(100));
    assert_eq!(refusal.message, "held");
    assert!(refusal.details.is_none());
    assert!(db.writes_held().is_some());
    let background = {
        let db = db.clone();
        tokio::spawn(async move { db.write(Write::own(), |tx| add(tx, 4)).await })
    };
    tokio::task::yield_now().await;
    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    own.await.unwrap().unwrap();
    background.await.unwrap().unwrap();
    drop(holding);
    assert!(db.writes_held().is_none());
    db.write(WRITE, |tx| add(tx, 5)).await.unwrap();
    assert!(!ran.load(Ordering::SeqCst));
    assert_eq!(ids(&db).await, [1, 3, 4, 5]);
}

#[tokio::test]
async fn a_hold_refuses_bookkeeping_a_request_starts_on_another_task_and_queues_the_servers() {
    let place = folder();
    let db = Arc::new(open(&place.file));
    let _holding = db
        .hold_writes(Refusal::new(Code::WriteContention, "held"))
        .unwrap();
    let request = provenance::within(provenance::Origin::default(), async {
        let spawned = {
            let db = db.clone();
            tokio::spawn(provenance::carried(async move {
                db.write(Write::own(), |tx| add(tx, 1)).await
            }))
        };
        let blocking = {
            let db = db.clone();
            let handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(provenance::carried_blocking(move || {
                handle.block_on(db.write(Write::own(), |tx| add(tx, 2)))
            }))
        };
        let servers = {
            let db = db.clone();
            tokio::spawn(async move { db.write(Write::own(), |tx| add(tx, 3)).await })
        };
        (spawned.await, blocking.await, servers.await)
    });
    let (spawned, blocking, servers) = request.await;
    assert_eq!(spawned.unwrap().unwrap_err().message, "held");
    assert_eq!(blocking.unwrap().unwrap_err().message, "held");
    servers.unwrap().unwrap();
    assert_eq!(ids(&db).await, [3]);
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
        db_open(&memory, Arc::default())
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
    assert_eq!(
        names_beside(&file),
        ["caf\u{e9} 100%.db", "caf\u{e9} 100%.db.server-lock"],
        "a second file was made beside the first"
    );
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
    db_open(&options(file, migrations), faults)
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

fn logged_while_opening(file: &Path, migrations: &'static [Migration]) -> (Db, String) {
    crate::log::captured(|| opened(file, migrations, Arc::default()))
}

fn upgrade_lines(log: &str) -> Vec<serde_json::Value> {
    log.lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["message"] == upgraded::MESSAGE)
        .collect()
}

#[tokio::test]
async fn an_upgrade_logs_one_line_naming_its_versions_and_its_copy() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;

    let (db, log) = logged_while_opening(&place.file, TWO);
    db.close().await;
    let lines = upgrade_lines(&log);
    assert_eq!(lines.len(), 1, "{log}");
    assert_eq!(
        last_upgrade(&log, None),
        Some(DatabaseUpgrade {
            from: 1,
            to: 2,
            copy: Some(copy_of(&place.file).to_string_lossy().into_owned()),
        })
    );
    assert!(copy_of(&place.file).exists());
    assert_eq!(
        last_upgrade(&log, Some(env!("CARGO_PKG_VERSION"))).map(|up| up.to),
        Some(2),
        "the line names the release that wrote it: {log}"
    );

    let (db, log) = logged_while_opening(&place.file, TWO);
    db.close().await;
    assert!(upgrade_lines(&log).is_empty(), "{log}");
}

#[tokio::test]
async fn an_upgrade_of_a_database_with_no_rows_logs_its_versions_and_no_copy() {
    let place = folder();
    open(&place.file).close().await;

    let (db, log) = logged_while_opening(&place.file, TWO);
    db.close().await;
    let lines = upgrade_lines(&log);
    assert_eq!(lines.len(), 1, "{log}");
    assert!(lines[0].get(upgraded::COPY).is_none(), "{log}");
    assert_eq!(
        last_upgrade(&log, None),
        Some(DatabaseUpgrade {
            from: 1,
            to: 2,
            copy: None
        })
    );
}

#[tokio::test]
async fn a_refused_copy_logs_no_upgrade_and_names_its_refusal() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    let faults = Arc::new(Faults::default());
    faults.set("free:database", Some("4096")).unwrap();
    let (result, log) = crate::log::captured(|| db_open(&options(&place.file, TWO), faults));
    let failure = result.err().expect("the upgrade was not refused");
    assert!(upgrade_lines(&log).is_empty(), "{log}");
    assert_eq!(failure.refusal, Some(UpgradeRefusal::CopyNotMade));

    // The line the server writes as it stops carries the refusal the command line reads.
    let (_, stopped) = crate::log::captured(|| crate::log::start_failed(&failure));
    assert_eq!(
        refused_upgrade(&stopped),
        Some(RefusedUpgrade {
            refusal: UpgradeRefusal::CopyNotMade,
            error: failure.message.clone()
        }),
        "{stopped}"
    );
}

#[tokio::test]
async fn an_unreadable_stored_setting_is_refused_as_unreadable_settings() {
    let place = folder();
    with_stored_reserve(&place.file, "plenty").await;
    let failure = refused(&place.file, SETTINGS_TWO);
    assert_eq!(failure.refusal, Some(UpgradeRefusal::SettingsUnreadable));
}

#[tokio::test]
async fn a_failure_that_is_not_a_refused_upgrade_names_no_refusal() {
    let place = folder();
    open(&place.file).close().await;
    let failure = refused(&place.file, &[]);
    assert_eq!(failure.refusal, None);
    let (_, stopped) = crate::log::captured(|| crate::log::start_failed(&failure));
    assert_eq!(refused_upgrade(&stopped), None, "{stopped}");
    assert!(stopped.contains("Failed to start server"), "{stopped}");
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
    let failure = match db_open(&options(&place.file, TWO), faults) {
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

async fn with_stored_reserve(file: &Path, reserve: &'static str) {
    let db = opened(file, SETTINGS_ONE, Arc::default());
    db.write(WRITE, move |tx| {
        add(tx, 1)?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('disk_reserve_bytes', ?1)",
            [reserve],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    db.close().await;
}

#[tokio::test]
async fn an_upgrade_keeps_the_disk_reserve_the_file_stores() {
    let place = folder();
    with_stored_reserve(&place.file, "1000000").await;
    let faults = Arc::new(Faults::default());
    faults.set("free:database", Some("900000")).unwrap();
    let failure = match db_open(&options(&place.file, SETTINGS_TWO), faults) {
        Ok(_) => panic!("the upgrade was not refused"),
        Err(failure) => failure,
    };
    assert!(
        failure.message.contains("disk reserve of 1000000 bytes"),
        "{}",
        failure.message
    );
}

#[tokio::test]
async fn an_upgrade_is_refused_when_the_stored_disk_reserve_does_not_read() {
    let place = folder();
    with_stored_reserve(&place.file, "plenty").await;
    let before = std::fs::read(&place.file).unwrap();
    let names = names_beside(&place.file);

    let faults = Arc::new(Faults::default());
    faults.set("free:database", Some("1073741824")).unwrap();
    let failure = match db_open(&options(&place.file, SETTINGS_TWO), faults) {
        Ok(_) => panic!("the upgrade was not refused"),
        Err(failure) => failure,
    };
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("disk_reserve_bytes"),
        "{}",
        failure.message
    );
    assert_eq!(std::fs::read(&place.file).unwrap(), before);
    assert_eq!(names_beside(&place.file), names);
    assert_eq!(version_of(&place.file), 1);
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
    db_open(&options(&place.file, INDEXED), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DROP TABLE notes;")
        .unwrap();

    db_open(&options(&place.file, INDEXED), Arc::default())
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
    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("DELETE FROM webhook_position; DROP TABLE items; DROP TABLE audit_log;")
        .unwrap();

    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
}

#[tokio::test]
async fn a_shipped_file_missing_a_table_and_holding_a_row_is_refused() {
    let place = folder();
    db_open(&options(&place.file, MIGRATIONS), Arc::default())
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
    db_open(&options(&place.file, INDEXED), Arc::default())
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
    db_open(&options(&place.file, TWO), Arc::default())
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
    let name = place
        .file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        names_beside(&place.file),
        [name.clone(), format!("{name}.server-lock")]
    );
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

fn synchronous(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.pragma_query_value(None, "synchronous", |row| row.get(0))?)
}

#[tokio::test]
async fn every_connection_syncs_each_commit_in_full() {
    let place = folder();
    let db = open(&place.file);
    let settings = db.connection_settings().await.unwrap();
    let full = serde_json::json!({
        "journal_mode": "wal",
        "synchronous": 2,
        "fullfsync": 1,
        "checkpoint_fullfsync": 1,
        "foreign_keys": 1,
    });
    assert_eq!(settings["writer"], full);
    let readers = settings["readers"].as_array().unwrap();
    assert_eq!(readers.len(), 2);
    for reader in readers {
        assert_eq!(reader["synchronous"], 2);
        assert_eq!(reader["fullfsync"], 1);
        assert_eq!(reader["checkpoint_fullfsync"], 1);
    }
}

#[tokio::test]
async fn only_an_unsynced_write_commits_unsynced() {
    let place = folder();
    let db = open(&place.file);
    let during = db
        .write(WRITE.unsynced(), |tx| {
            add(tx, 1)?;
            synchronous(tx)
        })
        .await
        .unwrap();
    assert_eq!(during, 1);
    assert_eq!(db.write(WRITE, synchronous).await.unwrap(), 2);

    let refused = db
        .write(WRITE.unsynced(), |_| -> Result<()> {
            Err(Refusal::internal("refused"))
        })
        .await;
    assert!(refused.is_err());
    assert_eq!(db.write(WRITE, synchronous).await.unwrap(), 2);
    assert_eq!(ids(&db).await, [1]);
}

#[tokio::test]
async fn a_damaged_page_met_after_an_entry_landed_ends_the_page_and_marks_the_file() {
    let folder = folder();
    let db = open(&folder.file);
    let faults = Faults::default();
    let pulse = db.pulse();

    let refused = db
        .write(WRITE, move |tx| {
            each(
                tx,
                "items.bulk",
                &faults,
                &pulse,
                vec![Ok(1), Ok(2)],
                |index, id: i64| {
                    if index == 1 {
                        let corrupt = ffi::Error::new(ffi::SQLITE_CORRUPT);
                        return Err(rusqlite::Error::SqliteFailure(corrupt, None).into());
                    }
                    tx.execute("INSERT INTO notes (id, body) VALUES (?1, 'kept')", [id])?;
                    Ok(serde_json::json!({ "index": index, "outcome": "created" }))
                },
            )
        })
        .await
        .map(drop);

    assert_eq!(refused.unwrap_err().code, Code::InternalError);
    assert!(db.damaged());
    let notes: i64 = db
        .read(|tx| Ok(tx.query_row("SELECT count(*) FROM notes", [], |row| row.get(0))?))
        .await
        .unwrap();
    assert_eq!(notes, 0);
}

const KIN_BASE: Migration = Migration {
    version: 1,
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
          CREATE TABLE tags (
              note INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
              tag TEXT NOT NULL
          ) STRICT;
          CREATE INDEX tags_note ON tags (note);
          CREATE TABLE stores (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT, WITHOUT ROWID;
          CREATE TABLE copies (
              store TEXT NOT NULL REFERENCES stores (id),
              hash TEXT NOT NULL
          ) STRICT;",
    done: None,
};
const KIN_ONE: &[Migration] = &[KIN_BASE];
/// SQLite's steps for changing a table's definition, for a parent of a cascading child and a
/// parent of a child that does not cascade.
const KIN_REBUILT: &[Migration] = &[
    KIN_BASE,
    Migration {
        version: 2,
        sql: "CREATE TABLE notes_new (
                  id INTEGER PRIMARY KEY,
                  body TEXT NOT NULL CHECK (body <> ''),
                  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
              ) STRICT;
              INSERT INTO notes_new (id, body) SELECT id, body FROM notes;
              DROP TABLE notes;
              ALTER TABLE notes_new RENAME TO notes;
              CREATE TABLE stores_new (
                  id TEXT PRIMARY KEY,
                  kind TEXT NOT NULL CHECK (kind IN ('disk', 's3'))
              ) STRICT, WITHOUT ROWID;
              INSERT INTO stores_new (id, kind) SELECT id, kind FROM stores;
              DROP TABLE stores;
              ALTER TABLE stores_new RENAME TO stores;",
        done: None,
    },
];
/// Moves the old table aside before making the new one, so its children follow the old name.
const KIN_DANGLING: &[Migration] = &[
    KIN_BASE,
    Migration {
        version: 2,
        sql: "ALTER TABLE notes RENAME TO notes_old;
              CREATE TABLE notes (
                  id INTEGER PRIMARY KEY,
                  body TEXT NOT NULL CHECK (body <> '')
              ) STRICT;
              INSERT INTO notes (id, body) SELECT id, body FROM notes_old;
              DROP TABLE notes_old;",
        done: None,
    },
];
/// Fails at its last statement, after the old table has gone and the new one took its name.
const KIN_FAILING: &[Migration] = &[
    KIN_BASE,
    Migration {
        version: 2,
        sql: "CREATE TABLE notes_new (
                  id INTEGER PRIMARY KEY,
                  body TEXT NOT NULL CHECK (body <> '')
              ) STRICT;
              INSERT INTO notes_new (id, body) SELECT id, body FROM notes;
              DROP TABLE notes;
              ALTER TABLE notes_new RENAME TO notes;
              INSERT INTO copies (store, hash) VALUES ('disk-1', NULL);",
        done: None,
    },
];

async fn kin_with_rows(file: &Path) {
    let db = opened(file, KIN_ONE, Arc::default());
    db.write(WRITE, |tx| {
        tx.execute_batch(
            "INSERT INTO notes (id, body) VALUES (1, 'one'), (2, 'two'), (3, 'three');
             INSERT INTO tags (note, tag) VALUES (1, 'a'), (1, 'b'), (2, 'c'), (3, 'd');
             INSERT INTO stores (id, kind) VALUES ('disk-1', 'disk'), ('s3-1', 's3');
             INSERT INTO copies (store, hash) VALUES ('disk-1', 'h1'), ('disk-1', 'h2'), ('s3-1', 'h1');",
        )?;
        Ok(())
    })
    .await
    .unwrap();
    db.close().await;
}

fn counts(file: &Path) -> Vec<(String, i64)> {
    let conn = Connection::open(file).unwrap();
    ["notes", "tags", "stores", "copies"]
        .iter()
        .map(|table| {
            let count = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            (table.to_string(), count)
        })
        .collect()
}

fn columns_of(file: &Path, table: &str) -> Vec<String> {
    Connection::open(file)
        .unwrap()
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .unwrap()
        .query_map([table], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn kin_counts() -> Vec<(String, i64)> {
    [("notes", 3), ("tags", 4), ("stores", 2), ("copies", 3)]
        .iter()
        .map(|(table, count)| (table.to_string(), *count))
        .collect()
}

#[tokio::test]
async fn an_upgrade_that_rebuilds_parent_tables_keeps_every_row_of_their_children() {
    let place = folder();
    kin_with_rows(&place.file).await;

    let db = opened(&place.file, KIN_REBUILT, Arc::default());
    let settings = db.connection_settings().await.unwrap();
    assert_eq!(settings["writer"]["foreign_keys"], 1);
    let dangling = db
        .write(WRITE, |tx| {
            tx.execute(
                "INSERT INTO copies (store, hash) VALUES ('nowhere', 'h3')",
                [],
            )?;
            Ok(())
        })
        .await;
    assert!(dangling.is_err(), "foreign keys were not enforced again");
    db.close().await;

    assert_eq!(version_of(&place.file), 2);
    assert_eq!(counts(&place.file), kin_counts());
    assert_eq!(columns_of(&place.file, "notes"), ["id", "body", "pinned"]);
    let cascade: i64 = Connection::open(&place.file)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM pragma_foreign_key_list('tags') WHERE \"table\" = 'notes'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cascade, 1);

    let again = opened(&place.file, KIN_REBUILT, Arc::default());
    again.close().await;
    assert_eq!(counts(&place.file), kin_counts());
}

#[tokio::test]
async fn a_rebuild_that_leaves_a_reference_to_a_missing_row_is_refused_and_changes_nothing() {
    let place = folder();
    kin_with_rows(&place.file).await;

    let failure = refused(&place.file, KIN_DANGLING);
    assert_eq!(failure.status, 78, "a start again would meet the same rows");
    assert!(failure.message.contains("tags"), "{}", failure.message);
    assert!(
        failure.message.contains("Nothing was changed"),
        "{}",
        failure.message
    );
    assert_eq!(version_of(&place.file), 1);
    assert_eq!(counts(&place.file), kin_counts());
    assert_eq!(columns_of(&place.file, "notes"), ["id", "body"]);
    assert!(columns_of(&place.file, "notes_old").is_empty());

    opened(&place.file, KIN_ONE, Arc::default()).close().await;
}

#[tokio::test]
async fn an_upgrade_marks_when_it_began_and_when_it_ended_for_the_run_that_times_the_start() {
    use marfa_rules::update_record::{Folder as Record, Upgrade};
    let open_marked = |file: &Path, migrations: &'static [Migration]| {
        let record = Record::beside(file);
        let options = Options {
            upgrade_marks: Some(record.clone()),
            ..options(file, migrations)
        };
        (db_open(&options, Arc::default()), record)
    };

    let fresh = folder();
    let (db, record) = open_marked(&fresh.file, KIN_ONE);
    db.map_err(|f| f.message).unwrap().close().await;
    assert_eq!(
        record.upgrade().unwrap(),
        None,
        "a new file is not upgraded"
    );

    let place = folder();
    kin_with_rows(&place.file).await;
    let (refused, record) = open_marked(&place.file, KIN_FAILING);
    assert!(refused.is_err());
    assert_eq!(record.upgrade().unwrap(), Some(Upgrade::Began));
    let (db, record) = open_marked(&place.file, KIN_REBUILT);
    db.map_err(|f| f.message).unwrap().close().await;
    assert_eq!(record.upgrade().unwrap(), Some(Upgrade::Ended));
}

#[tokio::test]
async fn a_rebuild_that_fails_part_way_leaves_the_database_and_its_version_as_they_were() {
    let place = folder();
    kin_with_rows(&place.file).await;

    let failure = refused(&place.file, KIN_FAILING);
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("Nothing was changed"),
        "{}",
        failure.message
    );
    assert_eq!(version_of(&place.file), 1);
    assert_eq!(counts(&place.file), kin_counts());
    assert_eq!(columns_of(&place.file, "notes"), ["id", "body"]);
    assert!(columns_of(&place.file, "notes_new").is_empty());

    opened(&place.file, KIN_ONE, Arc::default()).close().await;
}

#[tokio::test]
async fn a_database_another_server_has_open_is_refused_however_its_path_is_written() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    let through = place._dir.path().join("through");
    std::os::unix::fs::symlink(place._dir.path(), &through).unwrap();
    let paths = [
        DatabasePath::File(place.file.clone()),
        DatabasePath::File(through.join("marfa.db")),
        DatabasePath::Uri(format!("file:{}", place.file.display())),
    ];
    for path in paths {
        let mut second = options(&place.file, TWO);
        second.path = path;
        let failure = match db_open(&second, Arc::default()) {
            Ok(_) => panic!("the second start was not refused"),
            Err(failure) => failure,
        };
        assert_eq!(failure.status, 1);
        assert!(
            failure.message.contains("is open in another Marfa server"),
            "{}",
            failure.message
        );
        assert!(!copy_of(&place.file).exists());
        assert_eq!(version_of(&place.file), 1);
    }
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    assert_eq!(ids(&db).await, [1, 2]);
    db.close().await;

    opened(&place.file, TWO, Arc::default()).close().await;
    assert_eq!(version_of(&place.file), 2);
    assert!(copy_of(&place.file).exists());
}

const HELD_DATABASE: &str = "MARFA_TEST_HELD_DATABASE";
const HELD_TO_READ: &str = "MARFA_TEST_HELD_TO_READ";

/// Another process that has `file` open until it is killed: as a server does, or as a program
/// that only reads it, holding a read snapshot and taking no lock file.
struct Holder(std::process::Child);

impl Holder {
    fn start(file: &Path) -> Holder {
        Holder::run(&std::env::current_exe().unwrap(), file, false)
    }

    fn reader(program: &Path, file: &Path) -> Holder {
        Holder::run(program, file, true)
    }

    fn run(program: &Path, file: &Path, to_read: bool) -> Holder {
        use std::io::BufRead as _;
        let mut command = std::process::Command::new(program);
        command
            .args([
                "--exact",
                "db::tests::holds_a_database_open_for_another_test",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HELD_DATABASE, file)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        if to_read {
            command.env(HELD_TO_READ, "1");
        }
        let mut child = command.spawn().unwrap();
        let out = child.stdout.take().unwrap();
        let held = std::io::BufReader::new(out)
            .lines()
            .any(|line| line.is_ok_and(|line| line.contains("database held")));
        assert!(held, "the other process did not open the database");
        Holder(child)
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "run in a process of its own by the tests that need another holder"]
fn holds_a_database_open_for_another_test() {
    let Some(file) = std::env::var_os(HELD_DATABASE) else {
        return;
    };
    let path = DatabasePath::File(PathBuf::from(file));
    let to_read = std::env::var_os(HELD_TO_READ).is_some();
    let _lock = (!to_read).then(|| Lock::take(&path).unwrap());
    let conn = Connection::open(path.file().unwrap()).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    if to_read {
        conn.execute_batch("BEGIN").unwrap();
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .unwrap();
    println!("database held");
    let mut rest = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut rest);
}

#[test]
fn a_database_whose_lock_file_was_removed_or_replaced_while_another_process_has_it_is_refused() {
    for replaced in [false, true] {
        let place = folder();
        drop(open(&place.file));
        let holder = Holder::start(&place.file);
        let sidecar = place._dir.path().join("marfa.db.server-lock");
        std::fs::remove_file(&sidecar).unwrap();
        if replaced {
            std::fs::write(&sidecar, b"").unwrap();
        }
        let failure = Lock::take(&DatabasePath::File(place.file.clone())).unwrap_err();
        assert!(
            failure
                .message
                .contains(&format!("(process {})", holder.0.id())),
            "{}",
            failure.message
        );
        assert_eq!(sidecar.exists(), replaced);
        // The witness: once the other process ends, the database opens.
        drop(holder);
        drop(Lock::take(&DatabasePath::File(place.file.clone())).unwrap());
    }
}

#[tokio::test]
async fn a_database_another_program_holds_a_read_snapshot_of_opens_with_its_lock_file_or_without() {
    let place = folder();
    let program = place._dir.path().join("reader");
    std::fs::copy(std::env::current_exe().unwrap(), &program).unwrap();
    let sidecar = place._dir.path().join("marfa.db.server-lock");
    for removed in [false, true] {
        let db = open(&place.file);
        db.write(WRITE, move |tx| add(tx, i64::from(removed)))
            .await
            .unwrap();
        db.close().await;
        if removed {
            std::fs::remove_file(&sidecar).unwrap();
        }
        // The witness: the same snapshot, held by a program named as the server is, is refused.
        let as_server = Holder::reader(&std::env::current_exe().unwrap(), &place.file);
        let failure = Lock::take(&DatabasePath::File(place.file.clone())).unwrap_err();
        assert!(
            failure.message.contains("is open in another Marfa server"),
            "{}",
            failure.message
        );
        drop(as_server);

        let reader = Holder::reader(&program, &place.file);
        let db = open(&place.file);
        db.write(WRITE, move |tx| add(tx, 10 + i64::from(removed)))
            .await
            .unwrap();
        db.close().await;
        drop(reader);
        let db = open(&place.file);
        assert_eq!(ids(&db).await.len(), if removed { 4 } else { 2 });
        db.close().await;
    }
}

#[tokio::test]
async fn a_database_is_let_go_when_its_server_drops_it_without_closing() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    drop(db);
    assert_eq!(ids(&open(&place.file)).await, [1]);
}

#[tokio::test]
async fn two_databases_in_memory_open_side_by_side() {
    let mut memory = options(Path::new("unused"), ONE);
    memory.path = DatabasePath::Memory;
    let first = db_open(&memory, Arc::default())
        .map_err(|f| f.message)
        .unwrap();
    let second = db_open(&memory, Arc::default())
        .map_err(|f| f.message)
        .unwrap();
    first.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    assert!(ids(&second).await.is_empty());
}

#[test]
fn a_database_whose_file_system_keeps_no_write_ahead_log_is_refused_saying_so() {
    let place = folder();
    let mut no_log = options(&place.file, ONE);
    no_log.path = DatabasePath::Uri(format!("file:{}?vfs=unix-dotfile", place.file.display()));
    let failure = match db_open(&no_log, Arc::default()) {
        Ok(_) => panic!("the start was not refused"),
        Err(failure) => failure,
    };
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("write-ahead log"),
        "{}",
        failure.message
    );
    let mut witness = options(&place.file, ONE);
    witness.path = DatabasePath::Uri(format!("file:{}", place.file.display()));
    drop(
        db_open(&witness, Arc::default())
            .map_err(|f| f.message)
            .unwrap(),
    );
}

#[tokio::test]
async fn a_database_file_with_a_second_hard_link_is_refused_by_either_name() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    let link = place._dir.path().join("copy.db");
    std::fs::hard_link(&place.file, &link).unwrap();
    let linked = |named: &Path| {
        let failure = match db_open(&options(named, ONE), Arc::default()) {
            Ok(_) => panic!("{} was opened", named.display()),
            Err(failure) => failure,
        };
        assert_eq!(failure.status, 1);
        assert!(
            failure.message.contains("has 2 hard links"),
            "{}",
            failure.message
        );
    };
    linked(&link);
    assert!(!place._dir.path().join("copy.db-wal").exists());
    db.write(WRITE, |tx| add(tx, 2)).await.unwrap();
    db.close().await;
    linked(&place.file);

    std::fs::remove_file(&link).unwrap();
    assert_eq!(ids(&open(&place.file)).await, [1, 2]);
}

unsafe extern "C" fn refuse_commit(_: *mut std::ffi::c_void) -> std::ffi::c_int {
    1
}

#[tokio::test]
async fn an_upgrade_whose_commit_fails_says_it_may_have_committed() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    let mut conn = Connection::open(&place.file).unwrap();
    // SAFETY: the hook takes no data and outlives nothing, and the connection is open.
    unsafe {
        ffi::sqlite3_commit_hook(conn.handle(), Some(refuse_commit), std::ptr::null_mut());
    }
    let unapplied = super::migrate::upgrade(&mut conn, TWO, 1).unwrap_err();
    assert!(
        matches!(unapplied, super::migrate::Unapplied::CommitFailed(_)),
        "{unapplied:?}"
    );
    let failure = unapplied.failure("marfa.db", Some(1), TWO);
    assert_eq!(failure.status, 1);
    assert!(
        failure.message.contains("may have been upgraded") && !failure.message.contains("Nothing"),
        "{}",
        failure.message
    );
}

#[tokio::test]
async fn a_start_refused_for_its_log_keeps_the_last_copy_from_before_an_upgrade() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    std::fs::write(copy_of(&place.file), b"the last copy").unwrap();
    let mut shm = place.file.as_os_str().to_owned();
    shm.push("-shm");
    // SQLite opens the shared memory without following a link, so it cannot keep the log.
    std::os::unix::fs::symlink(place._dir.path().join("nowhere"), PathBuf::from(&shm)).unwrap();

    let failure = refused(&place.file, TWO);
    assert!(
        failure.message.contains("write-ahead log"),
        "{}",
        failure.message
    );
    assert_eq!(
        std::fs::read(copy_of(&place.file)).unwrap(),
        b"the last copy"
    );

    std::fs::remove_file(PathBuf::from(&shm)).unwrap();
    assert_eq!(version_of(&place.file), 1);
    opened(&place.file, TWO, Arc::default()).close().await;
    assert_ne!(
        std::fs::read(copy_of(&place.file)).unwrap(),
        b"the last copy"
    );
}

/// Puts back the database's first page from a rollback journal, as a crash part-way through a
/// commit leaves it, after the page in the file was overwritten.
fn leave_hot_journal(file: &Path) {
    const SECTOR: usize = 512;
    const NONCE: u32 = 0x5eed_0001;
    let conn = Connection::open(file).unwrap();
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    let page_size: u32 = conn
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .unwrap();
    let pages: u32 = conn
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .unwrap();
    drop(conn);
    let size = page_size as usize;
    let mut bytes = std::fs::read(file).unwrap();
    let first = bytes[..size].to_vec();
    let mut journal = vec![0u8; SECTOR];
    journal[..8].copy_from_slice(&[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
    journal[8..12].copy_from_slice(&1u32.to_be_bytes());
    journal[12..16].copy_from_slice(&NONCE.to_be_bytes());
    journal[16..20].copy_from_slice(&pages.to_be_bytes());
    journal[20..24].copy_from_slice(&(SECTOR as u32).to_be_bytes());
    journal[24..28].copy_from_slice(&page_size.to_be_bytes());
    journal.extend_from_slice(&1u32.to_be_bytes());
    journal.extend_from_slice(&first);
    let checksum = (1..=(size - 1) / 200)
        .map(|step| size - 200 * step)
        .fold(NONCE, |sum, at| sum.wrapping_add(u32::from(first[at])));
    journal.extend_from_slice(&checksum.to_be_bytes());
    let mut path = file.as_os_str().to_owned();
    path.push("-journal");
    std::fs::write(PathBuf::from(path), journal).unwrap();
    bytes[100..size].fill(0);
    std::fs::write(file, bytes).unwrap();
}

#[tokio::test]
async fn a_rollback_journal_left_by_a_crash_is_put_back_before_the_file_is_judged() {
    let place = folder();
    let db = open(&place.file);
    db.write(WRITE, |tx| add(tx, 1)).await.unwrap();
    db.close().await;
    leave_hot_journal(&place.file);

    let db = open(&place.file);
    assert_eq!(ids(&db).await, [1]);
    db.close().await;
    let mut journal = place.file.as_os_str().to_owned();
    journal.push("-journal");
    assert!(!PathBuf::from(journal).exists());
}

fn has_login_after(file: &Path) -> bool {
    Connection::open(file)
        .unwrap()
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_table_info('oauth_consents') \
             WHERE name = 'login_after')",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[tokio::test]
async fn a_database_at_schema_version_1_gains_login_after_and_keeps_its_rows() {
    let place = folder();
    db_open(&options(&place.file, &MIGRATIONS[..1]), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch("INSERT INTO instance (key, value) VALUES ('kept', 'yes');")
        .unwrap();
    assert!(!has_login_after(&place.file));

    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;

    assert!(has_login_after(&place.file));
    let conn = Connection::open(&place.file).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as u32);
    let kept: String = conn
        .query_row("SELECT value FROM instance WHERE key = 'kept'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(kept, "yes");
    assert!(copy_of(&place.file).exists());
}

fn compatible_with_of(file: &Path, id: &str) -> Option<String> {
    Connection::open(file)
        .unwrap()
        .query_row(
            "SELECT json_extract(definition, '$.compatible_with') FROM types WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

#[tokio::test]
async fn a_database_at_schema_version_2_loses_compatible_with_and_keeps_the_rest_of_each_type() {
    let place = folder();
    db_open(&options(&place.file, &MIGRATIONS[..2]), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(&place.file)
        .unwrap()
        .execute_batch(
            "INSERT INTO types (id, parent, origin, definition, created_at, updated_at) VALUES \
             ('user.reader', NULL, 'user', \
              '{\"id\":\"user.reader\",\"label\":\"Reader\",\"compatible_with\":[\"core.note\"]}', 't', 't'), \
             ('user.plain', NULL, 'user', '{\"id\":\"user.plain\",\"label\":\"Plain\"}', 't', 't');",
        )
        .unwrap();
    assert_eq!(
        compatible_with_of(&place.file, "user.reader").as_deref(),
        Some("[\"core.note\"]")
    );

    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;

    assert_eq!(compatible_with_of(&place.file, "user.reader"), None);
    let conn = Connection::open(&place.file).unwrap();
    let kept: String = conn
        .query_row(
            "SELECT definition FROM types WHERE id = 'user.reader'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept, "{\"id\":\"user.reader\",\"label\":\"Reader\"}");
    let plain: String = conn
        .query_row(
            "SELECT definition FROM types WHERE id = 'user.plain'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(plain, "{\"id\":\"user.plain\",\"label\":\"Plain\"}");
}

#[tokio::test]
async fn a_new_database_is_made_with_login_after() {
    let place = folder();
    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    assert!(has_login_after(&place.file));
}

#[tokio::test]
async fn a_database_named_by_a_uri_that_asks_for_rw_is_upgraded_with_its_copy() {
    let place = folder();
    upgraded_by_uri(
        &place.file,
        &format!("file:{}?mode=rw", place.file.display()),
    )
    .await;
}

#[tokio::test]
async fn a_database_named_by_a_bare_file_name_uri_is_upgraded_with_its_copy() {
    let place = folder();
    std::env::set_current_dir(place.file.parent().unwrap()).unwrap();
    upgraded_by_uri(&place.file, "file:marfa.db?mode=rw").await;
}

async fn upgraded_by_uri(file: &Path, uri: &str) {
    db_open(&options(file, &MIGRATIONS[..1]), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    Connection::open(file)
        .unwrap()
        .execute_batch("INSERT INTO instance (key, value) VALUES ('kept', 'yes');")
        .unwrap();
    let by_uri = Options {
        path: DatabasePath::Uri(uri.to_string()),
        ..options(file, MIGRATIONS)
    };

    db_open(&by_uri, Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;

    assert!(has_login_after(file));
    assert!(copy_of(file).exists());
}

fn vendors_of(file: &Path) -> Vec<(String, Option<String>)> {
    Connection::open(file)
        .unwrap()
        .prepare("SELECT vendor, client_id FROM app_vendors ORDER BY vendor")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn backup_changes(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT coalesce((SELECT changes FROM backup_state WHERE id = 1), 0)",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn a_database_at_schema_version_2_gives_a_vendor_to_an_app_only_when_one_known_app_made_all_its_types()
 {
    let place = folder();
    db_open(&options(&place.file, &MIGRATIONS[..2]), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;
    let client = |id: &str| {
        format!(
            "INSERT INTO oauth_clients (client_id, application_type, redirect_uris, grant_types, \
             response_types, scopes, contacts, created_at) \
             VALUES ('{id}', 'native', '[]', '[]', '[]', '', '[]', '2026-11-01T00:00:00.000Z');"
        )
    };
    let made = |id: &str, by: &str, at: &str| {
        format!(
            "INSERT INTO types (id, origin, created_by, definition, created_at, updated_at) \
             VALUES ('{id}', 'user', {by}, '{{}}', '{at}', '{at}');"
        )
    };
    let by_app = |grant: &str| format!(r#"'{{"kind":"app","id":"{grant}","name":"App"}}'"#);
    let by_key = |key: &str| format!(r#"'{{"kind":"key","id":"{key}","name":"Key"}}'"#);
    let local = r#"'{"kind":"local","id":"local","name":"Local command"}'"#;
    let batch = [
        client("client-a"),
        client("client-b"),
        "INSERT INTO owner (id, name, username, password, created_at, updated_at) \
         VALUES ('owner', 'Owner', 'owner', 'x', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');"
            .to_string(),
        "INSERT INTO oauth_consents (client_id, owner_id, grant_id, scopes, created_at, updated_at) VALUES \
         ('client-a', 'owner', 'grant-a', 'content:write', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), \
         ('client-b', 'owner', 'grant-b', 'content:write', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');"
            .to_string(),
        "INSERT INTO api_keys (id, hash, label, source, oauth_client_id, permissions, type_permissions, \
         edge_permissions, extension_permissions, metadata_permissions, profile_permissions, created_at) \
         VALUES ('key-b', 'hash-b', 'B', 'b', 'client-b', '[]', '{}', '{}', '{}', '{}', '{}', \
         '2026-11-01T00:00:00.000Z'), ('key-owner', 'hash-o', 'O', 'o', NULL, '[]', '{}', '{}', '{}', \
         '{}', '{}', '2026-11-01T00:00:00.000Z'), ('key-through-a', 'hash-ta', 'TA', 'ta', NULL, '[]', \
         '{}', '{}', '{}', '{}', '{}', '2026-11-01T00:00:00.000Z'), ('key-through-b', 'hash-tb', 'TB', \
         'tb', NULL, '[]', '{}', '{}', '{}', '{}', '{}', '2026-11-01T00:00:00.000Z'), ('key-chained', \
         'hash-c', 'C', 'c', NULL, '[]', '{}', '{}', '{}', '{}', '{}', '2026-11-01T00:00:00.000Z');"
            .to_string(),
        "INSERT INTO audit_log (id, created_at, key_id, actor, action, kind, resource_type, \
         resource_id, details) VALUES \
         ('audit-1', '2026-11-01T00:00:00.000Z', 'token-a', '{\"kind\":\"app\",\"id\":\"grant-a\",\"name\":\"A\"}', \
         'key.create', 'access', 'key', 'key-through-a', '{\"owner_key\":true}'), \
         ('audit-2', '2026-11-01T00:00:00.000Z', 'key-b', '{\"kind\":\"key\",\"id\":\"key-b\",\"name\":\"B\"}', \
         'key.create', 'access', 'key', 'key-through-b', '{\"owner_key\":true}'), \
         ('audit-3', '2026-11-01T00:00:00.000Z', 'key-through-b', \
         '{\"kind\":\"key\",\"id\":\"key-through-b\",\"name\":\"TB\"}', \
         'key.create', 'access', 'key', 'key-chained', '{}'), \
         ('audit-4', '2026-11-01T00:00:00.000Z', 'key-owner', '{\"kind\":\"key\",\"id\":\"key-owner\",\"name\":\"O\"}', \
         'key.create', 'access', 'key', 'key-b', '{}');"
            .to_string(),
        made("app.alpha.setting", &by_app("grant-a"), "2026-11-02T00:00:00.000Z"),
        made("app.alpha.later", &by_app("grant-b"), "2026-11-03T00:00:00.000Z"),
        made("app.beta.setting", &by_key("key-b"), "2026-11-02T00:00:00.000Z"),
        made("app.beta.later", &by_app("grant-b"), "2026-11-03T00:00:00.000Z"),
        made("app.gamma.setting", &by_key("key-owner"), "2026-11-02T00:00:00.000Z"),
        made("app.delta.setting", local, "2026-11-02T00:00:00.000Z"),
        made("app.epsilon.setting", &by_app("grant-gone"), "2026-11-02T00:00:00.000Z"),
        made("app.zeta.setting", &by_key("key-owner"), "2026-11-01T00:00:00.000Z"),
        made("app.zeta.later", &by_app("grant-a"), "2026-11-03T00:00:00.000Z"),
        made("app.eta.setting", "NULL", "2026-11-02T00:00:00.000Z"),
        made("app.theta.setting", &by_key("key-gone"), "2026-11-02T00:00:00.000Z"),
        made("app.iota.setting", &by_key("key-through-a"), "2026-11-02T00:00:00.000Z"),
        made("app.kappa.setting", &by_key("key-chained"), "2026-11-02T00:00:00.000Z"),
        made("acme.widget", &by_app("grant-a"), "2026-11-02T00:00:00.000Z"),
    ]
    .concat();
    Connection::open(&place.file)
        .unwrap()
        .execute_batch(&batch)
        .unwrap();

    db_open(&options(&place.file, MIGRATIONS), Arc::default())
        .map_err(|f| f.message)
        .unwrap()
        .close()
        .await;

    assert_eq!(version_of(&place.file), super::migrate::latest(MIGRATIONS));
    let owner = |vendor: &str| (vendor.to_string(), None);
    let app = |vendor: &str, client: &str| (vendor.to_string(), Some(client.to_string()));
    assert_eq!(
        vendors_of(&place.file),
        [
            owner("app.alpha"),
            app("app.beta", "client-b"),
            owner("app.delta"),
            owner("app.epsilon"),
            owner("app.eta"),
            owner("app.gamma"),
            app("app.iota", "client-a"),
            app("app.kappa", "client-b"),
            owner("app.theta"),
            owner("app.zeta"),
        ]
    );

    let conn = Connection::open(&place.file).unwrap();
    let makers: Vec<(String, Option<String>, Option<String>)> = conn
        .prepare("SELECT id, oauth_client_id, made_by_client FROM api_keys ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let key = |id: &str, client: Option<&str>, maker: Option<&str>| {
        (
            id.to_string(),
            client.map(str::to_string),
            maker.map(str::to_string),
        )
    };
    assert_eq!(
        makers,
        [
            key("key-b", Some("client-b"), Some("client-b")),
            key("key-chained", None, Some("client-b")),
            key("key-owner", None, None),
            key("key-through-a", None, Some("client-a")),
            key("key-through-b", None, Some("client-b")),
        ]
    );
    let before = backup_changes(&conn);
    conn.execute(
        "UPDATE app_vendors SET client_id = 'client-a' WHERE vendor = 'app.alpha'",
        [],
    )
    .unwrap();
    assert_eq!(backup_changes(&conn), before + 1);
}
