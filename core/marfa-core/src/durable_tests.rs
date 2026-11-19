//! A system stop cannot be staged here, so these read the setting back from
//! an opened writer. `durable_commit_bench` runs only with
//! `MARFA_TEST_DURABLE_BENCH` set:
//!
//! ```sh
//! MARFA_TEST_DURABLE_BENCH=1 cargo test --release -p marfa-core durable_commit_bench -- --nocapture
//! ```

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::scripted::{self, Scripted};
use crate::stop_tests::{created, holding_a_catalog, note};
use crate::{Core, Server, SliceTier, directory};

const FULL: i64 = 2;

fn pragma(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .unwrap()
}

fn commits_durably(conn: &Connection) {
    assert_eq!(
        pragma(conn, "synchronous"),
        FULL,
        "a commit does not sync the log, so a system stop can drop a write reported as queued"
    );
    assert_eq!(
        pragma(conn, "checkpoint_fullfsync"),
        1,
        "a checkpoint does not flush the drive's cache, so a power cut can leave the store part copied"
    );
}

#[test]
fn a_store_at_a_path_commits_durably() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    commits_durably(&core.conn().unwrap());
}

#[cfg(unix)]
#[test]
fn a_folder_store_commits_durably() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("owned");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join(".marfa")).unwrap();
    let admitted = directory::Directory::open(&root).unwrap();
    let state = admitted.child(Path::new(".marfa"), false).unwrap();
    let core = Core::open_directory(&state, &root.join(".marfa/core.sqlite"), None).unwrap();
    commits_durably(&core.conn().unwrap());
}

fn bench_row(index: usize) -> Value {
    let id = format!("019537a0-7b80-7000-8000-{index:012x}");
    let payload: Value =
        serde_json::from_str(&scripted::item_payload("item.updated", &id, "core.note", 1)).unwrap();
    json!({"item": payload["item"], "metadata": payload["metadata"], "listed": true})
}

#[test]
fn durable_commit_bench() {
    if std::env::var_os("MARFA_TEST_DURABLE_BENCH").is_none() {
        return;
    }
    const ITEMS: usize = 10_000;
    const PAGE: usize = 100;
    const WRITES: usize = 1_000;
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let server = Scripted::start();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    server.on(
        "/edge-types",
        vec![scripted::certified(scripted::edge_types(&[]))],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"write"}}"#,
        ))],
    );
    let rows: Vec<Value> = (0..ITEMS).map(bench_row).collect();
    let pages: Vec<scripted::Answer> = rows
        .chunks(PAGE)
        .enumerate()
        .map(|(n, chunk)| {
            let next = ((n + 1) * PAGE < ITEMS).then(|| (n + 1).to_string());
            let body = json!({"data": chunk, "next_cursor": next});
            scripted::certified_under(scripted::json(200, &body.to_string()), scripted::FENCE)
        })
        .collect();
    server.on("/items", pages);
    server.on(
        "/events",
        vec![
            scripted::stream(
                vec![scripted::copy_marker_under(
                    "stream_cursor",
                    "10",
                    scripted::FENCE,
                )],
                scripted::Then::End,
            ),
            scripted::stream(
                vec![
                    scripted::copy_marker("stream_cursor", "10"),
                    scripted::copy_marker("stream_live", "10"),
                ],
                scripted::Then::End,
            ),
        ],
    );

    let started = Instant::now();
    let report = core
        .hydrate_until(
            &["core.note".into()],
            SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
    println!(
        "hydration of {} items: {:.0} ms",
        report.items,
        started.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(report.items, ITEMS as u64);

    holding_a_catalog(&core);
    let started = Instant::now();
    let queued: Vec<_> = (0..WRITES)
        .map(|_| core.create_item(&note(None)).unwrap())
        .collect();
    println!(
        "{WRITES} queued writes: {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );

    let mut receipts = Vec::new();
    for write in &queued {
        let id = write.item_id.clone().unwrap();
        let (receipt, read) = created(&id, "core.note");
        receipts.push(scripted::json(201, &receipt));
        server.on(&format!("/items/{id}"), vec![read]);
    }
    server.on("/items", receipts);
    let started = Instant::now();
    let drained = core.drain().unwrap();
    println!(
        "drain of {WRITES} writes: {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(drained.answered, WRITES);
}
