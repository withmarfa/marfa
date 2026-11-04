//! A copy whose rows left gives the disk its freed pages back, only when most
//! of the file is free, and loses nothing by it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use rusqlite::Connection;
use serde_json::json;

use crate::reclaim::{Reclaim, due};
use crate::{Core, SearchFilters, store};

const HELD_AT: &str = "2026-01-01T00:00:00Z";
fn go() -> AtomicBool {
    AtomicBool::new(false)
}

/// Large enough that a few hundred rows fill well past the 1,024 free pages
/// the rule asks for.
fn bulk() -> String {
    "lorem ipsum dolor sit amet ".repeat(400)
}

fn open(dir: &Path) -> Core {
    let core = Core::open(dir.join("core.sqlite"), None).unwrap();
    let conn = core.conn().unwrap();
    store::replace_catalog(&conn, &crate::builtin::catalog().unwrap()).unwrap();
    drop(conn);
    core
}

pub(crate) fn put(core: &Core, id: &str, title: &str) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    crate::reach::set_listed(&conn, id, true).unwrap();
    let row = store::testing::wire_item(
        id,
        "core.note",
        "active",
        HELD_AT,
        json!({ "title": title, "body": bulk() }),
    );
    store::put_server_item(&conn, &row, Some(&[]), &catalog).unwrap();
}

/// A copy that held `held` rows and let all but `kept` go, with a pin, a
/// queued write and a folder file bound to a kept row.
fn shrunk(dir: &Path, held: usize, kept: usize) -> Core {
    let core = open(dir);
    fill_and_let_go(&core, held, kept);
    {
        let conn = core.conn().unwrap();
        store::pin(&conn, "n0000").unwrap();
        conn.execute(
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, seen_at)
         VALUES ('a.md', 'n0001', 'h', '[]', '[]', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
        "INSERT INTO folder_journal (path, item_id, missing_since) VALUES ('b.md', 'n0002', '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
        conn.execute(
            "INSERT INTO folder_stats (path, stat) VALUES ('a.md', 'x')",
            [],
        )
        .unwrap();
    }
    checkpoint(&core);
    core
}

/// `held` rows put in the copy, all but the first `kept` let go.
pub(crate) fn fill_and_let_go(core: &Core, held: usize, kept: usize) {
    for n in 0..held {
        put(core, &format!("n{n:04}"), &format!("note {n} needle{n}"));
    }
    let conn = core.conn().unwrap();
    let whole = store::whole_edge_types(&conn).unwrap();
    for n in kept..held {
        store::evict_item(&conn, &format!("n{n:04}"), &whole).unwrap();
    }
}

fn checkpoint(core: &Core) {
    core.conn()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
}

fn file_size(dir: &Path) -> u64 {
    std::fs::metadata(dir.join("core.sqlite")).unwrap().len()
}

fn wal_size(dir: &Path) -> u64 {
    std::fs::metadata(dir.join("core.sqlite-wal"))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// Every row of every table the store keeps, by table, without the rowids
/// (checked on their own) and without the search index's shadow tables (read
/// through search).
fn rows(conn: &Connection) -> BTreeMap<String, Vec<String>> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table'
             AND name NOT LIKE 'items_fts%' AND name NOT LIKE 'sqlite_%'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables
        .into_iter()
        .map(|table| {
            let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
            let width = statement.column_count();
            let mut lines: Vec<String> = statement
                .query_map([], |row| {
                    Ok((0..width)
                        .map(|n| format!("{:?}", row.get_ref(n).unwrap()))
                        .collect::<Vec<_>>()
                        .join("|"))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            lines.sort();
            (table, lines)
        })
        .collect()
}

fn hits(core: &Core, query: &str) -> Vec<String> {
    let mut ids: Vec<String> = core
        .search(query, &SearchFilters::default(), 50)
        .unwrap()
        .rows
        .into_iter()
        .map(|hit| hit.item.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn the_file_falls_after_a_large_eviction() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let before = file_size(dir.path());
    assert!(
        due(&core.conn().unwrap()).unwrap(),
        "the fixture frees enough"
    );

    let done = core.reclaim_space(&go());

    assert!(matches!(done, Reclaim::Reclaimed { .. }), "{done:?}");
    let after = file_size(dir.path());
    assert!(after * 4 < before, "{before} bytes became {after}");
    assert_eq!(wal_size(dir.path()), 0, "the log does not stay large");
}

#[test]
fn a_store_with_little_to_free_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    // Half the rows kept and a few free pages: no rewrite.
    let core = shrunk(dir.path(), 40, 30);
    let before = (file_size(dir.path()), rows(&core.conn().unwrap()));
    assert!(!due(&core.conn().unwrap()).unwrap());

    assert!(matches!(core.reclaim_space(&go()), Reclaim::Nothing));

    assert_eq!(file_size(dir.path()), before.0);
    assert_eq!(rows(&core.conn().unwrap()), before.1);
}

#[test]
fn many_free_pages_in_a_mostly_live_file_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    // 1,024 free pages are not at least half of a file this size.
    let core = shrunk(dir.path(), 1400, 1000);
    let (pages, free): (i64, i64) = {
        let conn = core.conn().unwrap();
        (
            conn.query_row("PRAGMA page_count", [], |row| row.get(0))
                .unwrap(),
            conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .unwrap(),
        )
    };
    assert!(free >= 1024 && free * 2 < pages, "{free} of {pages}");

    assert!(matches!(core.reclaim_space(&go()), Reclaim::Nothing));
}

#[test]
fn nothing_is_lost_and_search_still_answers() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    store::meta_set(&core.conn().unwrap(), "folder_witness", "kept").unwrap();
    core.create_item(&crate::Draft {
        r#type: "core.note".into(),
        properties: json!({ "title": "queued needleq" })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    })
    .unwrap();
    let before = rows(&core.conn().unwrap());
    let seqs: Vec<(String, i64)> = {
        let conn = core.conn().unwrap();
        let mut statement = conn
            .prepare("SELECT id, seq FROM items ORDER BY seq")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let found = (
        hits(&core, "needle3"),
        hits(&core, "needleq"),
        hits(&core, "needle0"),
    );
    assert_eq!(found.0, vec!["n0003".to_string()]);
    assert_eq!(found.1.len(), 1, "the queued row is found");
    for table in [
        "queue",
        "pins",
        "folder_files",
        "folder_journal",
        "folder_stats",
        "meta",
    ] {
        assert!(!before[table].is_empty(), "{table} is a witness");
    }

    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));

    let conn = core.conn().unwrap();
    assert_eq!(
        rows(&conn),
        before,
        "every table's rows survive as they were"
    );
    let after: Vec<(String, i64)> = conn
        .prepare("SELECT id, seq FROM items ORDER BY seq")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        after, seqs,
        "an item keeps the seq its search entry is keyed by"
    );
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    conn.execute_batch("INSERT INTO items_fts(items_fts) VALUES ('integrity-check')")
        .unwrap();
    drop(conn);
    assert_eq!(
        (
            hits(&core, "needle3"),
            hits(&core, "needleq"),
            hits(&core, "needle0")
        ),
        found
    );
}

#[test]
fn a_second_reclaim_finds_nothing_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Nothing));
}

#[test]
fn a_store_held_by_another_writer_is_skipped_quietly_and_tried_later() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let before = rows(&core.conn().unwrap());
    // Another connection mid-write, as another process's would be.
    let other = Connection::open(dir.path().join("core.sqlite")).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();

    assert!(matches!(core.reclaim_space(&go()), Reclaim::Skipped));
    assert_eq!(rows(&core.conn().unwrap()), before);
    let wait: i64 = core
        .conn()
        .unwrap()
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(wait, 5000, "the connection keeps its wait");

    other.execute_batch("ROLLBACK").unwrap();
    // The refusal is waited out, not tried again at once.
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Skipped));
    *core.reclaim_held_until.lock().unwrap() = None;
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
}

#[test]
fn a_reader_holding_a_view_does_not_make_reclaim_wait() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let reader = Connection::open(dir.path().join("core.sqlite")).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    reader
        .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
        .unwrap();

    let started = std::time::Instant::now();
    let done = core.reclaim_space(&go());

    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "reclaim waited {:?} for a reader while holding the connection: {done:?}",
        started.elapsed()
    );
    let wait: i64 = core
        .conn()
        .unwrap()
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(wait, 5000, "the connection keeps its wait");
}

#[test]
fn a_reader_holding_a_view_delays_the_report_until_the_file_is_smaller() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let size = file_size(dir.path());
    let reader = Connection::open(dir.path().join("core.sqlite")).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let held: i64 = reader
        .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
        .unwrap();

    // The rewrite is in the log, but the file has not shrunk: not reported.
    let first = core.reclaim_space(&go());
    assert!(matches!(first, Reclaim::Skipped), "{first:?}");
    assert!(
        file_size(dir.path()) * 4 > size,
        "the reader keeps the file"
    );
    assert_eq!(
        reader
            .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        held,
        "the reader still sees its own view"
    );

    // The store no longer has free pages, yet the checkpoint is still owed:
    // it waits out the busy backoff, then runs by itself.
    reader.execute_batch("COMMIT").unwrap();
    assert!(!due(&core.conn().unwrap()).unwrap());
    let early = core.reclaim_space(&go());
    assert!(matches!(early, Reclaim::Skipped), "backoff: {early:?}");
    *core.reclaim_held_until.lock().unwrap() = None;

    let second = core.reclaim_space(&go());
    let Reclaim::Reclaimed { from, to } = second else {
        panic!("{second:?}");
    };
    assert!(to * 4 < from, "{from} became {to}");
    assert!(
        file_size(dir.path()) * 4 < size,
        "{} of {size}",
        file_size(dir.path())
    );
    assert_eq!(file_size(dir.path()), to, "the report is the file's size");
    assert_eq!(wal_size(dir.path()), 0);
    assert!(
        matches!(core.reclaim_space(&go()), Reclaim::Nothing),
        "the work is done once"
    );
}

#[test]
fn a_checkpoint_a_reader_prevented_is_made_by_the_next_writer_after_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let size = file_size(dir.path());
    let reader = Connection::open(dir.path().join("core.sqlite")).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    reader
        .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
        .unwrap();
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Skipped));

    // The writer closes with the rewrite in the log; the reader's connection
    // stays open, so nobody makes the last-connection checkpoint.
    reader.execute_batch("COMMIT").unwrap();
    drop(core);
    assert!(
        file_size(dir.path()) * 4 > size,
        "the file is still large: {} of {size}",
        file_size(dir.path())
    );

    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    assert!(!due(&core.conn().unwrap()).unwrap(), "no free pages remain");
    let done = core.reclaim_space(&go());

    let Reclaim::Reclaimed { from, to } = done else {
        panic!("{done:?}");
    };
    assert!(to * 4 < from, "{from} became {to}");
    assert_eq!(file_size(dir.path()), to, "the report is the file's size");
    assert!(file_size(dir.path()) * 4 < size);
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Nothing));
    drop(reader);
}

/// A reader that holds a view of the store, and keeps its connection open
/// after the view is released, so no close makes the last-connection
/// checkpoint.
fn read_view(dir: &Path) -> Connection {
    let reader = Connection::open(dir.join("core.sqlite")).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    reader
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    reader
}

/// Rounds until one answers `Nothing`, each past the backoff, at most `cap`.
fn settle(core: &Core, cap: usize) -> Vec<String> {
    let mut answers = Vec::new();
    for _ in 0..cap {
        *core.reclaim_held_until.lock().unwrap() = None;
        let answer = core.reclaim_space(&go());
        let done = matches!(answer, Reclaim::Nothing);
        answers.push(format!("{answer:?}"));
        if done {
            break;
        }
    }
    answers
}

#[test]
fn a_log_a_reader_kept_from_the_file_is_truncated_once_the_reader_lets_go() {
    // The reader starts before the store grows: the growth stays in the log
    // and the main file stays small, so the file's length says nothing.
    let dir = tempfile::tempdir().unwrap();
    let core = open(dir.path());
    let reader = read_view(dir.path());
    fill_and_let_go(&core, 700, 9);
    let first = core.reclaim_space(&go());
    assert!(
        wal_size(dir.path()) > 4 << 20,
        "the log holds the growth: {first:?}"
    );

    reader.execute_batch("COMMIT").unwrap();
    let rounds = settle(&core, 5);

    assert!(
        wal_size(dir.path()) < 1 << 20,
        "the log is small: {} bytes after {rounds:?}",
        wal_size(dir.path())
    );
    assert_eq!(rounds.last().unwrap(), "Nothing", "it settles: {rounds:?}");
    drop(reader);
}

#[test]
fn a_log_kept_by_a_reader_that_began_after_the_rewrite_is_truncated_after_a_reopen() {
    // The reader starts after VACUUM: the checkpoint may copy everything,
    // but the log cannot be reset, and the file is already as short as its
    // pages.
    let dir = tempfile::tempdir().unwrap();
    let core = open(dir.path());
    fill_and_let_go(&core, 700, 9);
    core.conn().unwrap().execute_batch("VACUUM").unwrap();
    let reader = read_view(dir.path());
    let first = core.reclaim_space(&go());
    assert!(
        wal_size(dir.path()) > 4 << 20,
        "the log stays large: {first:?}"
    );

    reader.execute_batch("COMMIT").unwrap();
    drop(core);
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let rounds = settle(&core, 5);

    assert!(
        wal_size(dir.path()) < 1 << 20,
        "the log is small: {} bytes after {rounds:?}",
        wal_size(dir.path())
    );
    assert_eq!(rounds.last().unwrap(), "Nothing", "it settles: {rounds:?}");
    drop(reader);
}

#[test]
fn a_small_log_costs_a_round_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let core = open(dir.path());
    put(&core, "n0000", "note");
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Nothing));
    assert!(core.reclaim_held_until.lock().unwrap().is_none());
}

#[test]
fn a_statement_of_this_process_holding_the_connection_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let guard = core.conn().unwrap();

    assert!(matches!(core.reclaim_space(&go()), Reclaim::Skipped));

    drop(guard);
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
}

#[test]
fn a_failed_rewrite_leaves_the_store_as_it_was_and_is_not_tried_in_a_loop() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let (before, size) = (rows(&core.conn().unwrap()), file_size(dir.path()));
    // An error of the kind a full disk raises, from inside the rewrite: armed
    // only once the preliminary reads are done, so it cannot fire on them.
    static REWRITING: AtomicBool = AtomicBool::new(false);
    crate::reclaim::TEST_BEFORE_REWRITE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|conn: &Connection| {
            let _ = conn.progress_handler(
                1,
                // Interrupts the rewrite once, then lets later statements run.
                Some(|| !REWRITING.swap(true, std::sync::atomic::Ordering::SeqCst)),
            );
        }));
    });

    let failed = core.reclaim_space(&go());

    crate::reclaim::TEST_BEFORE_REWRITE.with(|hook| *hook.borrow_mut() = None);
    let _ = core
        .conn()
        .unwrap()
        .progress_handler(1, None::<fn() -> bool>);
    assert!(
        REWRITING.load(std::sync::atomic::Ordering::SeqCst),
        "the rewrite had started when it was interrupted"
    );
    let wait: i64 = core
        .conn()
        .unwrap()
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(wait, 5000, "the connection keeps its wait after a failure");
    assert!(matches!(failed, Reclaim::Failed(_)), "{failed:?}");
    assert_eq!(rows(&core.conn().unwrap()), before);
    assert_eq!(file_size(dir.path()), size);
    assert!(
        matches!(core.reclaim_space(&go()), Reclaim::Skipped),
        "held off"
    );
    *core.reclaim_held_until.lock().unwrap() = None;
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
}

#[test]
fn a_stop_in_force_starts_no_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let size = file_size(dir.path());

    assert!(matches!(
        core.reclaim_space(&AtomicBool::new(true)),
        Reclaim::Skipped
    ));
    assert_eq!(file_size(dir.path()), size);
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
}

#[test]
fn a_hydration_in_progress_and_a_reading_handle_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let core = shrunk(dir.path(), 700, 9);
    let size = file_size(dir.path());
    let reader = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    assert_eq!(reader.handle(), crate::Handle::Reader);
    assert!(matches!(reader.reclaim_space(&go()), Reclaim::Skipped));

    let conn = core.conn().unwrap();
    store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
    drop(conn);
    assert!(matches!(core.reclaim_space(&go()), Reclaim::Skipped));
    assert_eq!(file_size(dir.path()), size);

    let conn = core.conn().unwrap();
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        [store::META_HYDRATE_STATE],
    )
    .unwrap();
    drop(conn);
    assert!(matches!(
        core.reclaim_space(&go()),
        Reclaim::Reclaimed { .. }
    ));
}
