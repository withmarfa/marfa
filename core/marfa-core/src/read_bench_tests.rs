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

use crate::catalog::Catalog;
use crate::model::ListFilters;
use crate::{Core, reach, scripted, store};

/// Every tenth note links to the two notes after it, with the `references`
/// edges a hydration would bring for those links.
fn linked(index: usize) -> bool {
    index.is_multiple_of(10)
}

fn note_id(index: usize) -> String {
    format!("note-{index:06}")
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
        let catalog = Catalog::load(&tx).unwrap();
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
