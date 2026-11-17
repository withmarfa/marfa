//! Reads across a large working copy. Each test builds a hydrated copy of a
//! few hundred notes, a tenth of them linking to others, and checks what the
//! reads answer. With `MARFA_READ_BENCH_ROWS` set, `read_bench_times_the_reads`
//! builds that many and prints how long each read takes; run it in a release
//! build:
//!
//! ```sh
//! MARFA_READ_BENCH_ROWS=50000 cargo test --release -p marfa-core read_bench -- --nocapture
//! ```

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::model::ListFilters;
use crate::{Core, reach, scripted, store};

/// Every tenth note links to the two notes after it, with the `references`
/// edges a hydration would bring for those links.
fn linked(index: usize) -> bool {
    index.is_multiple_of(10)
}

pub(crate) fn note_id(index: usize) -> String {
    format!("019537a0-7b80-7000-8000-{index:012x}")
}

pub(crate) fn large_copy(dir: &Path, rows: usize) -> Core {
    let core = Core::open(dir.join("core.sqlite"), None).unwrap();
    {
        let mut conn = core.conn().unwrap();
        let tx = conn.transaction().unwrap();
        store::replace_types(
            &tx,
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
        store::meta_set(&tx, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&tx, reach::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&tx, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(&tx, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&tx, store::META_SLICE_TIER, "library").unwrap();
        let catalog = crate::catalog::load(&tx).unwrap();
        let filler = "Some ordinary prose that a note carries, long enough to look like one. ";
        for index in 0..rows {
            let mut body = filler.repeat(6);
            if linked(index) {
                body.push_str(&format!(
                    "See [[Note {}]] and [[Note {}]].",
                    (index + 1) % rows,
                    (index + 2) % rows
                ));
            }
            let when = format!(
                "2026-01-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                1 + index % 28,
                (index / 3600) % 24,
                (index / 60) % 60,
                index % 60,
                index % 1000
            );
            let mut row = store::testing::wire_item(
                &note_id(index),
                "core.note",
                if index.is_multiple_of(50) {
                    "archived"
                } else {
                    "active"
                },
                &when,
                json!({ "title": format!("Note {index}"), "body": body }),
            );
            row.version = 1 + (index % 7) as i64;
            let tags: Vec<String> = if index.is_multiple_of(2) {
                vec!["even".into(), format!("group-{}", index % 20)]
            } else {
                Vec::new()
            };
            store::put_server_item(&tx, &row, Some(&tags), &catalog).unwrap();
        }
        for index in (0..rows).filter(|index| linked(*index)) {
            for step in [1, 2] {
                let edge = store::testing::wire_edge(
                    &format!("edge-{index:06}-{step}"),
                    &note_id(index),
                    &note_id((index + step) % rows),
                    "references",
                );
                store::upsert_edge(&tx, &edge).unwrap();
            }
        }
        tx.commit().unwrap();
    }
    core
}

fn linked_ids(rows: usize) -> Vec<String> {
    (0..rows)
        .filter(|index| linked(*index))
        .map(note_id)
        .collect()
}

/// The notes each active linked note links to first, which each have an
/// incoming link that counts.
fn linked_targets(rows: usize) -> Vec<String> {
    (0..rows)
        .filter(|index| linked(*index) && !index.is_multiple_of(50))
        .map(|index| note_id((index + 1) % rows))
        .collect()
}

fn timed<T>(label: &str, rows: usize, read: impl Fn() -> T) -> T {
    let mut best = Duration::MAX;
    let mut answer = None;
    for _ in 0..5 {
        let started = Instant::now();
        let read = read();
        best = best.min(started.elapsed());
        answer = Some(read);
    }
    println!(
        "{rows:>7} rows  {label:<44} {:>10.1} ms",
        best.as_secs_f64() * 1000.0
    );
    answer.expect("read five times")
}

#[test]
fn read_bench_times_the_reads() {
    let rows = std::env::var("MARFA_READ_BENCH_ROWS")
        .ok()
        .and_then(|rows| rows.parse().ok())
        .unwrap_or(300);
    let dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let core = large_copy(dir.path(), rows);
    println!(
        "{rows:>7} rows  {:<44} {:>10.1} ms",
        "build the copy",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let every = ListFilters {
        all_states: true,
        ..Default::default()
    };
    if std::env::var_os("MARFA_READ_BENCH_ROWS").is_some() {
        let conn = core.conn().unwrap();
        for sql in [
            "SELECT id FROM items WHERE 1 = 1 ORDER BY created_at DESC, id DESC",
            "SELECT id FROM items WHERE state = 'active' ORDER BY created_at DESC, id DESC",
        ] {
            let mut plan = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let steps: Vec<String> = plan
                .query_map([], |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            println!("plan of {sql}: {steps:?}");
        }
    }
    let active = timed("list the active rows (list_kept)", rows, || {
        core.list_kept(&ListFilters::default(), None).unwrap()
    });
    assert!(active.rows.len() < rows);
    let listed = timed("list every row (list_kept, all states)", rows, || {
        core.list_kept(&every, None).unwrap()
    });
    assert_eq!(listed.rows.len(), rows);
    let ids = linked_ids(rows);
    let one_by_one = timed("links of each linking item, one call each", rows, || {
        ids.iter()
            .map(|id| core.body_links(id).unwrap())
            .collect::<Vec<_>>()
    });
    assert!(one_by_one.iter().all(|links| links.links.len() == 2));
    let batched = timed("links of each linking item, one call", rows, || {
        core.body_links_of(&ids).unwrap()
    });
    for (id, links) in ids.iter().zip(&one_by_one) {
        assert_eq!(&batched[id], links);
    }
    let every_id: Vec<String> = listed
        .rows
        .iter()
        .map(|(item, _)| item.id.clone())
        .collect();
    let all_links = timed("links of every item, one call", rows, || {
        core.body_links_of(&every_id).unwrap()
    });
    assert_eq!(all_links.len(), rows);
    let thousand: Vec<String> = every_id
        .iter()
        .step_by(rows.div_ceil(1000))
        .cloned()
        .collect();
    let got = timed(
        &format!("get {} items by id, one call", thousand.len()),
        rows,
        || core.get_items_kept(&thousand, false).unwrap(),
    );
    assert_eq!(got.rows.len(), thousand.len());
    let since = core.changes_since(None, 1000).unwrap().cursor;
    let quiet = timed("changes since a cursor, none", rows, || {
        core.changes_since(Some(&since), 1000).unwrap()
    });
    assert!(quiet.items.is_empty() && !quiet.everything);
    {
        let conn = core.conn().unwrap();
        conn.execute(
            "UPDATE items SET version = version + 1 WHERE id IN (SELECT id FROM items ORDER BY id LIMIT 100)",
            [],
        )
        .unwrap();
    }
    let hundred = timed("changes since a cursor, 100 items", rows, || {
        core.changes_since(Some(&since), 1000).unwrap()
    });
    assert_eq!(hundred.items.len(), 100);
}

/// 100 anchors counted in one call equal the list each count names, and with
/// `MARFA_READ_BENCH_ROWS` set the call's 95th percentile is printed.
#[test]
fn read_bench_times_the_counts() {
    use crate::{Counted, counts::MOST_IDS};
    let rows = std::env::var("MARFA_READ_BENCH_ROWS")
        .ok()
        .and_then(|rows| rows.parse().ok())
        .unwrap_or(300);
    let dir = tempfile::tempdir().unwrap();
    let core = large_copy(dir.path(), rows);
    store::meta_set(
        &core.conn().unwrap(),
        store::META_SLICE_EDGE_TYPES,
        "[\"references\"]",
    )
    .unwrap();
    for counted in [
        Counted::Backref("references".into()),
        Counted::Edge("references".into()),
    ] {
        // An anchor of `backref` links out and one of `edge` is linked to, so
        // each is counted where it has something to count.
        let (anchors, expected) = match counted {
            Counted::Backref(_) => (linked_ids(rows), 2),
            _ => (linked_targets(rows), 1),
        };
        let anchors: Vec<String> = anchors.into_iter().take(MOST_IDS).collect();
        assert!(!anchors.is_empty());
        let answer = core.counts(&anchors, &counted).unwrap();
        assert_eq!(answer.len(), anchors.len());
        assert!(
            answer.iter().all(|count| count.held
                && count.total == expected
                && count.status_groups.is_some()),
            "{counted:?}"
        );
        let mut times: Vec<Duration> = (0..40)
            .map(|_| {
                let started = Instant::now();
                core.counts(&anchors, &counted).unwrap();
                started.elapsed()
            })
            .collect();
        times.sort();
        if std::env::var_os("MARFA_READ_BENCH_ROWS").is_some() {
            println!(
                "{rows:>7} rows  {:<44} median {:>7.2} ms  p95 {:>7.2} ms",
                format!("count {} anchors, {counted:?}", anchors.len()),
                times[times.len() / 2].as_secs_f64() * 1000.0,
                times[times.len() * 95 / 100].as_secs_f64() * 1000.0,
            );
        }
    }
}

/// 100 held tables counted in one call give the rows each holds, and with
/// `MARFA_READ_BENCH_ROWS` set, over that many items of 130 types and
/// `MARFA_READ_BENCH_TABLE_ROWS` rows in each table, the call's 95th
/// percentile is printed.
#[test]
fn read_bench_times_the_row_counts() {
    use crate::Counted;
    use crate::counts::MOST_IDS;
    let rows: usize = std::env::var("MARFA_READ_BENCH_ROWS")
        .ok()
        .and_then(|rows| rows.parse().ok())
        .unwrap_or(300);
    let table_rows: usize = std::env::var("MARFA_READ_BENCH_TABLE_ROWS")
        .ok()
        .and_then(|rows| rows.parse().ok())
        .unwrap_or(5);
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let mut types = vec![json!({
        "id": "acme.ledger",
        "fields": {},
        "tables": { "lines": { "columns": { "memo": { "type": "string" } } } }
    })];
    types.extend((0..129).map(|n| json!({ "id": format!("acme.kind{n}"), "fields": {} })));
    let hosts: Vec<String> = (0..MOST_IDS).map(note_id).collect();
    {
        let mut conn = core.conn().unwrap();
        let tx = conn.transaction().unwrap();
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(json!(types)).unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&tx, &catalog).unwrap();
        for index in 0..rows.max(MOST_IDS) {
            let kind = if index < MOST_IDS {
                "acme.ledger".to_string()
            } else {
                format!("acme.kind{}", index % 129)
            };
            let item = store::testing::wire_item(
                &note_id(index),
                &kind,
                "active",
                "2026-01-01T00:00:00Z",
                json!({}),
            );
            store::upsert_item(&tx, &item, None, &marfa_rules::catalog::Indexing::default())
                .unwrap();
        }
        let mut add = tx
            .prepare(
                "INSERT INTO table_rows (item_id, name, id, body, updated_at)
                 VALUES (?1, 'lines', ?2, '{\"memo\":\"m\"}', '2026-01-01T00:00:00Z')",
            )
            .unwrap();
        for host in &hosts {
            for row in 0..table_rows {
                add.execute(rusqlite::params![host, format!("row-{row:08}")])
                    .unwrap();
            }
            tx.execute(
                "INSERT INTO item_tables (item_id, name, state, rows) VALUES (?1, 'lines', 'whole', ?2)",
                rusqlite::params![host, table_rows as i64],
            )
            .unwrap();
        }
        drop(add);
        tx.commit().unwrap();
    }
    let counted = Counted::Table("lines".into());
    let answer = core.counts(&hosts, &counted).unwrap();
    assert_eq!(answer.len(), MOST_IDS);
    assert!(
        answer
            .iter()
            .all(|count| count.held && count.total == table_rows as i64)
    );
    let mut times: Vec<Duration> = (0..40)
        .map(|_| {
            let started = Instant::now();
            core.counts(&hosts, &counted).unwrap();
            started.elapsed()
        })
        .collect();
    times.sort();
    if std::env::var_os("MARFA_READ_BENCH_ROWS").is_some() {
        println!(
            "{rows:>7} items  {:<44} median {:>7.2} ms  p95 {:>7.2} ms",
            format!("count {MOST_IDS} held tables of {table_rows} rows"),
            times[times.len() / 2].as_secs_f64() * 1000.0,
            times[times.len() * 95 / 100].as_secs_f64() * 1000.0,
        );
    }
}
