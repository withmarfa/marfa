//! Restore holds can change between readiness and marking a write sent.

#![cfg(debug_assertions)]

use super::*;
use crate::scripted::{Scripted, certified, json as answer};
use serde_json::Value;

const PATH: &str = "/items/item/tables/steps/rows";
const R: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f70";
const S: &str = "019a5b1e-7c41-7d2e-9f3a-5b8c2d4e6f71";

fn put(id: &str, count: i64) -> Value {
    json!({ "op": "put", "id": id, "values": { "count": count } })
}

fn copy_with(server: &Scripted, writes: &[(&str, &str)]) -> std::sync::Arc<Core> {
    let core = crate::stop_tests::copy(server);
    let conn = core.conn().unwrap();
    store::upsert_item(
        &conn,
        &store::testing::note("item", "T", "", "2026-11-19T09:00:00.000Z"),
        None,
        &marfa_rules::catalog::Indexing::default(),
    )
    .unwrap();
    conn.execute(
        "INSERT INTO item_tables (item_id, name, state) VALUES ('item', 'steps', 'owed')",
        [],
    )
    .unwrap();
    let mut ahead: Option<&str> = None;
    for (seq, (id, row)) in (1_i64..).zip(writes) {
        let op = put(row, seq);
        conn.execute(
            "INSERT INTO queue (seq, id, kind, item_id, row_table, idempotency_key, payload, sent, queued_at, follows)
             VALUES (?1, ?2, 'write_rows', 'item', 'steps', ?2, ?3, 0, 'at', ?4)",
            rusqlite::params![seq, id, json!({ "operations": [&op] }).to_string(), ahead],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rows_laid (write_id, seq, item_id, name, id, ops, at)
             VALUES (?1, ?2, 'item', 'steps', ?3, ?4, 'at')",
            rusqlite::params![id, seq, row, json!([op]).to_string()],
        )
        .unwrap();
        ahead = Some(id);
    }
    drop(conn);
    let results: Vec<Value> = writes
        .iter()
        .map(|(_, row)| json!({ "id": row, "outcome": "created" }))
        .collect();
    server.on(
        PATH,
        vec![certified(answer(
            200,
            &json!({
                "batch": "019a5b1e-9c33-7e5f-8a6b-7c8d9e0f1a2b",
                "last_activity_at": "2026-11-19T11:00:00.000Z",
                "results": results,
            })
            .to_string(),
        ))],
    );
    core
}

fn drain_pausing(core: &Core, lead: &str, meanwhile: impl FnOnce(&Core)) {
    let point = format!("drain-sending:{lead}");
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let drain = scope.spawn(|| core.drain());
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the drain never came to send {lead}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        meanwhile(core);
        crate::fault::release(&point);
        drain.join().unwrap().unwrap();
    });
}

fn unsent(core: &Core, id: &str) -> bool {
    let conn = core.conn().unwrap();
    let write = store::queued_write(&conn, id).unwrap().unwrap();
    write.batched_with.is_none() && store::unsent(&conn, id).unwrap()
}

/// Queues a kept write to the table, as a fill that finds a restore does.
fn keep(core: &Core) -> String {
    let values = json!({ "count": 9 }).as_object().unwrap().clone();
    let kept = crate::row_writes::keep(
        &core.conn().unwrap(),
        "item",
        "steps",
        &[crate::row_writes::Op::Put {
            id: S.into(),
            values,
        }],
    )
    .unwrap();
    assert_eq!(kept.len(), 1);
    kept.into_iter().next().unwrap()
}

/// The unchanged control must send before the changed case can assert silence.
fn held_by(writes: &[(&str, &str)], meanwhile: impl Fn(&Core)) -> (Scripted, std::sync::Arc<Core>) {
    for changed in [false, true] {
        let server = Scripted::start();
        let core = copy_with(&server, writes);
        let lead = writes[0].0;
        drain_pausing(&core, lead, |core| {
            if changed {
                meanwhile(core);
            }
        });
        let sent = server.seen(PATH);
        if !changed {
            assert_eq!(sent.len(), 1, "the witness: the batch is sent");
            continue;
        }
        assert!(sent.is_empty(), "a row write went out past the hold");
        for (id, _) in writes {
            assert!(unsent(&core, id), "{id} was marked sent");
            let write = store::queued_write(&core.conn().unwrap(), id)
                .unwrap()
                .unwrap();
            assert_eq!(
                (write.verdict, write.reason.as_deref()),
                (
                    Some(Verdict::Blocked),
                    Some(crate::model::AWAITING_DEPENDENCY)
                ),
                "{id} does not wait as a held write does"
            );
        }
        return (server, core);
    }
    unreachable!()
}

#[test]
fn a_row_write_whose_table_is_set_aside_after_the_drain_judged_it_ready_is_not_sent() {
    held_by(&[("w", R)], |core| {
        core.conn()
            .unwrap()
            .execute(
                "INSERT INTO held_tables (item_id, name, restored) VALUES ('item', 'steps', 1)",
                [],
            )
            .unwrap();
    });
}

#[test]
fn a_row_write_is_not_sent_while_a_kept_write_queued_after_the_drain_judged_it_waits_ahead() {
    held_by(&[("w", R)], |core| {
        keep(core);
    });
}

#[test]
fn a_row_write_is_not_sent_past_a_kept_write_queued_and_released_after_the_drain_judged_it() {
    let (server, core) = held_by(&[("w", R)], |core| {
        let kept = keep(core);
        assert!(core.release(&kept).unwrap(), "the kept write is released");
    });
    // The next drain sends the kept write first.
    server.on(
        PATH,
        vec![certified(answer(
            200,
            &json!({
                "batch": "019a5b1e-9c33-7e5f-8a6b-7c8d9e0f1a2c",
                "last_activity_at": "2026-11-19T11:01:00.000Z",
                "results": [
                    { "id": S, "outcome": "created" },
                    { "id": R, "outcome": "created" },
                ],
            })
            .to_string(),
        ))],
    );
    core.drain().unwrap();
    let order: Vec<String> = server
        .seen(PATH)
        .iter()
        .flat_map(|seen| {
            let body: Value = serde_json::from_slice(&seen.body).unwrap();
            body["operations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|op| op["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(order, [S, R]);
    assert!(!unsent(&core, "w"));
}

#[test]
fn a_batch_whose_table_is_set_aside_after_the_drain_gathered_it_sends_no_member() {
    held_by(&[("w", R), ("m", S)], |core| {
        core.conn()
            .unwrap()
            .execute(
                "INSERT INTO held_tables (item_id, name, restored) VALUES ('item', 'steps', 1)",
                [],
            )
            .unwrap();
    });
}

#[test]
fn a_row_write_is_not_sent_when_the_copy_was_built_again_after_the_drain_judged_it_ready() {
    let (server, core) = held_by(&[("w", R)], |core| {
        crate::reach::advance_generation(&core.conn().unwrap()).unwrap();
    });
    // The next drain judges it on the copy as it now is.
    core.drain().unwrap();
    assert_eq!(server.seen(PATH).len(), 1);
    assert!(!unsent(&core, "w"));
}
