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
    move_uploads_sent_as(&conn, "a", "b").unwrap();
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
