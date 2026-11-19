use std::cell::RefCell;

use rusqlite::trace::{TraceEvent, TraceEventCodes};

use super::testing::conn;
use super::*;

thread_local! {
    static SEEN: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn scans_meta(conn: &Connection, sql: &str) -> bool {
    let mut plan = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
    let mut rows = plan.raw_query();
    while let Some(row) = rows.next().unwrap() {
        let detail: String = row.get(3).unwrap();
        if detail.starts_with("SCAN") && detail.contains("meta") {
            return true;
        }
    }
    false
}

#[test]
fn a_prefix_range_holds_exactly_the_keys_that_start_with_it() {
    use rusqlite::types::Value;
    assert_eq!(
        prefix_end("item_listed/"),
        Value::Text("item_listed0".into())
    );
    assert_eq!(prefix_end("a\u{D7FF}"), Value::Text("a\u{E000}".into()));
    assert_eq!(prefix_end("a\u{10FFFF}"), Value::Text("b".into()));
    assert_eq!(prefix_end("\u{10FFFF}"), Value::Blob(Vec::new()));
    assert_eq!(prefix_end(""), Value::Blob(Vec::new()));

    let conn = conn();
    let keys = [
        "a%/1",
        "a%/2",
        "ax/3",
        "a_/4",
        "A%/5",
        "a%",
        "a%0",
        "a\u{10FFFF}",
        "a\u{10FFFF}z",
        "b",
        "\u{10FFFF}",
        "\u{10FFFF}\u{10FFFF}x",
    ];
    for key in keys {
        meta_set(&conn, key, "v").unwrap();
    }
    let asked = |prefix: &str| -> Vec<String> {
        let mut found: Vec<String> = keys
            .iter()
            .filter(|key| key.starts_with(prefix))
            .map(|key| key.to_string())
            .collect();
        found.sort();
        assert_eq!(meta_keys(&conn, prefix).unwrap(), found, "{prefix:?}");
        found
    };
    assert_eq!(asked("a%/").len(), 2);
    assert_eq!(asked("a_/").len(), 1);
    assert_eq!(asked("a\u{10FFFF}").len(), 2);
    assert_eq!(asked("\u{10FFFF}").len(), 2);
    let every = meta_keys(&conn, "").unwrap();
    assert!(keys.iter().all(|key| every.iter().any(|held| held == key)));
    let under = meta_under(&conn, "a%/").unwrap();
    assert_eq!(under, [("1".into(), "v".into()), ("2".into(), "v".into())]);
    meta_delete_under(&conn, "a%/").unwrap();
    assert_eq!(meta_keys(&conn, "a%").unwrap(), ["a%", "a%0"]);
}

#[test]
fn a_prefix_lookup_on_meta_never_reads_the_whole_table() {
    let witness = "SELECT key FROM meta WHERE substr(key, 1, length(?1)) = ?1";
    assert!(
        scans_meta(&conn(), witness),
        "the plan check cannot see a scan"
    );

    let mut conn = conn();
    SEEN.with(|seen| seen.borrow_mut().clear());
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT,
        Some(|event: TraceEvent<'_>| {
            if let TraceEvent::Stmt(_, sql) = event {
                SEEN.with(|seen| seen.borrow_mut().push(sql.to_string()));
            }
        }),
    )
    .unwrap();
    meta_keys(&conn, "dead_effect/").unwrap();
    readmit_attempt(&conn, "attempt").unwrap();
    pending_landings(&conn).unwrap();
    forget_removals(&conn).unwrap();
    forget_answered(&conn).unwrap();
    move_sent_as(&conn, "a", "b").unwrap();
    read_of_row_owed_elsewhere(&conn, "id").unwrap();
    clear_slice(&conn).unwrap();
    start_refill(&conn).unwrap();
    sweep_refill(&conn).unwrap();
    conn.trace_v2(TraceEventCodes::empty(), None::<fn(TraceEvent<'_>)>)
        .unwrap();

    let mut asked: Vec<String> = SEEN.with(|seen| seen.borrow().clone());
    asked.retain(|sql| sql.contains("meta") && !sql.starts_with("--"));
    asked.sort();
    asked.dedup();
    assert!(asked.len() >= 8, "only saw {asked:?}");
    let scanning: Vec<&String> = asked.iter().filter(|sql| scans_meta(&conn, sql)).collect();
    assert!(scanning.is_empty(), "these read all of meta: {scanning:#?}");
}

/// What `lapsed` was before it asked for as little as it could.
fn lapsed_by_each_part(conn: &Connection) -> Result<bool, CoreError> {
    Ok(hydration_complete(conn)?
        && holds_slice(conn)?
        && meta_get(conn, META_EVENT_CURSOR)?.is_some()
        && !hydrated(conn)?)
}

#[test]
fn a_copy_lapses_exactly_where_it_holds_a_slice_it_cannot_keep_current() {
    let conn = conn();
    let set = |key: &str, value: Option<&str>| match value {
        Some(value) => meta_set(&conn, key, value).unwrap(),
        None => meta_delete(&conn, key).unwrap(),
    };
    let fence = crate::scripted::FENCE;
    let instance = crate::scripted::INSTANCE;
    let mut lapsed_states = 0;
    for state in [None, Some(HYDRATE_IN_PROGRESS)] {
        for cursor in [None, Some("10"), Some("garbage")] {
            for fence in [None, Some(fence), Some("garbage")] {
                for instance in [None, Some(""), Some(instance)] {
                    for types in [None, Some("[]"), Some("[\"core.note\"]")] {
                        for tier in [None, Some("library")] {
                            set(META_HYDRATE_STATE, state);
                            set(META_EVENT_CURSOR, cursor);
                            set(crate::reach::FENCE, fence);
                            set(META_INSTANCE_ID, instance);
                            set(META_SLICE_TYPES, types);
                            set(META_SLICE_TIER, tier);
                            let now = lapsed(&conn).unwrap();
                            assert_eq!(
                                now,
                                lapsed_by_each_part(&conn).unwrap(),
                                "{state:?} {cursor:?} {fence:?} {instance:?} {types:?} {tier:?}"
                            );
                            lapsed_states += usize::from(now);
                        }
                    }
                }
            }
        }
    }
    assert!(
        lapsed_states > 0,
        "no state lapsed, so nothing was compared"
    );
}

#[test]
fn a_copy_that_is_current_is_judged_on_a_few_reads() {
    let conn = conn();
    meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
    meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
    meta_set(&conn, META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
    meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
    meta_set(&conn, META_SLICE_TIER, "library").unwrap();
    assert!(hydrated(&conn).unwrap());

    let mut conn = conn;
    SEEN.with(|seen| seen.borrow_mut().clear());
    conn.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT,
        Some(|event: TraceEvent<'_>| {
            if let TraceEvent::Stmt(_, sql) = event {
                SEEN.with(|seen| seen.borrow_mut().push(sql.to_string()));
            }
        }),
    )
    .unwrap();
    assert!(!lapsed(&conn).unwrap());
    conn.trace_v2(TraceEventCodes::empty(), None::<fn(TraceEvent<'_>)>)
        .unwrap();
    let asked = SEEN.with(|seen| seen.borrow().len());
    assert!(asked > 0, "the trace saw no statement");
    assert!(asked <= 3, "judging a current copy took {asked} statements");
}

/// Times SQLite prepared the statement again over the three runs from the cache after its first.
fn reprepares(conn: &Connection, sql: &str) -> i32 {
    let mut count = 0;
    let mut first = 0;
    for run in 0..4 {
        let mut statement = conn.prepare_cached(sql).unwrap();
        let values: Vec<&str> = vec!["a"; statement.parameter_count()];
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), |_| Ok(()))
            .unwrap();
        assert_eq!(rows.count(), 0);
        count = statement.get_status(rusqlite::StatementStatus::RePrepare);
        if run == 0 {
            first = count;
        }
    }
    count - first
}

#[test]
fn a_cached_statement_is_prepared_once_however_often_it_is_run() {
    let statements = [
        "SELECT id FROM edges WHERE from_id = ?1 ORDER BY created_at, id",
        "SELECT id FROM queue WHERE item_id = ?1 AND kind = ?2",
        "SELECT id FROM items WHERE id = ?1 AND source IS NOT ?2",
    ];
    let conn = conn();
    for sql in statements {
        assert_eq!(reprepares(&conn, sql), 0, "{sql}");
    }

    // The witness: without the setting, each run from the cache plans again.
    let plain = Connection::open_in_memory().unwrap();
    plain.execute_batch(crate::store::SCHEMA).unwrap();
    assert_eq!(reprepares(&plain, statements[0]), 3);
}
