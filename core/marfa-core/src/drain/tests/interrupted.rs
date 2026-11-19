use super::*;
use crate::scripted::{self, Scripted};
use std::time::{Duration, Instant};

const ROWS: [&str; 4] = ["a", "b", "c", "d"];

/// The delete, then the read-back that finds the item gone.
fn accepted() -> Vec<scripted::Answer> {
    vec![
        scripted::json(200, r#"{"ok":true}"#),
        scripted::certified(scripted::refusal(404, "item_not_found")),
    ]
}

/// The writes sent to the item: its reads carry no idempotency key.
fn sent(server: &Scripted, id: &str) -> Vec<String> {
    server
        .seen(&format!("/items/{id}"))
        .into_iter()
        .filter_map(|seen| seen.idempotency_key)
        .collect()
}

fn reopened(dir: &tempfile::TempDir, server: &Scripted) -> Core {
    Core::open(
        dir.path().join("core.sqlite"),
        Some(crate::Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap()
}

fn all_in_the_bin() -> scripted::Answer {
    in_the_bin(&[("a", 1), ("b", 1), ("c", 1), ("d", 1)])
}

#[test]
fn a_drain_ended_between_writes_is_finished_by_the_next_core_with_nothing_lost_or_sent_twice() {
    let server = Scripted::start();
    server.on("/items", vec![all_in_the_bin()]);
    server.on("/items/a", accepted());
    server.on("/items/b", accepted());
    server.on("/items/c", vec![scripted::refusal(503, "unavailable")]);
    server.on("/items/d", vec![scripted::refusal(503, "unavailable")]);
    let (dir, core) = deleting(&server, &ROWS);
    let queued = core.queue().unwrap();

    let first = core.drain().unwrap();
    assert_eq!(first.answered, 2, "{first:?}");
    assert_eq!(first.undelivered, 2, "{first:?}");
    drop(core);

    // The process ended here, and the next finds the rest waiting.
    server.on("/items/c", accepted());
    server.on("/items/d", accepted());
    let core = reopened(&dir, &server);
    let waiting: Vec<String> = core
        .queue()
        .unwrap()
        .into_iter()
        .filter(|row| row.verdict.is_none())
        .map(|row| row.item_id.unwrap())
        .collect();
    assert_eq!(waiting, ["c", "d"]);

    let second = core.drain().unwrap();
    assert_eq!(second.answered, 2, "{second:?}");
    assert_eq!((second.undelivered, second.unsent), (0, 0), "{second:?}");
    let after = core.queue().unwrap();
    assert_eq!(after.len(), queued.len());
    assert!(
        after
            .iter()
            .all(|row| row.verdict == Some(Verdict::Accepted)),
        "{after:?}"
    );
    for id in ["a", "b"] {
        assert_eq!(
            sent(&server, id).len(),
            1,
            "{id} was sent again after the server took it"
        );
    }
    // A write the server did not take is sent again under its own key.
    let keys = sent(&server, "c");
    assert_eq!(keys.len(), 2, "{keys:?}");
    assert_eq!(keys[0], keys[1], "the retry named another key");
    assert_eq!(sent(&server, "d").len(), 1);
}

#[test]
fn a_drain_a_rate_limit_cut_short_keeps_what_it_did_not_send_and_the_next_one_sends_it() {
    let server = Scripted::start();
    server.on("/items", vec![all_in_the_bin()]);
    server.on("/items/a", accepted());
    server.on(
        "/items/b",
        vec![
            scripted::Answer::Json {
                status: 429,
                body: r#"{"error":{"code":"rate_limited","message":"wait"}}"#.into(),
                headers: vec![("Retry-After".into(), "2".into())],
            },
            accepted()[0].clone(),
            accepted()[1].clone(),
        ],
    );
    server.on("/items/c", accepted());
    server.on("/items/d", accepted());
    let (_dir, core) = deleting(&server, &ROWS);

    let cut = core.drain().unwrap();
    assert_eq!(cut.answered, 1, "{cut:?}");
    assert_eq!(cut.retry_after_seconds, Some(2), "{cut:?}");
    assert!(cut.unavailable.is_some(), "{cut:?}");
    assert!(sent(&server, "c").is_empty(), "sent past the limit");
    assert!(sent(&server, "d").is_empty(), "sent past the limit");
    let left = core
        .queue()
        .unwrap()
        .into_iter()
        .filter(|row| row.verdict.is_none())
        .count();
    assert_eq!(left, 3);

    let done = core.drain().unwrap();
    assert_eq!(done.answered, 3, "{done:?}");
    assert!(
        core.queue()
            .unwrap()
            .iter()
            .all(|row| row.verdict == Some(Verdict::Accepted))
    );
    assert_eq!(sent(&server, "a").len(), 1);
}

#[test]
fn a_slow_server_delays_a_drain_and_loses_none_of_its_writes() {
    let server = Scripted::start();
    server.on("/items", vec![all_in_the_bin()]);
    for id in ROWS {
        server.on(
            &format!("/items/{id}"),
            vec![
                scripted::Answer::Slow {
                    after: Duration::from_millis(150),
                    answer: Box::new(accepted()[0].clone()),
                },
                accepted()[1].clone(),
            ],
        );
    }
    let (_dir, core) = deleting(&server, &ROWS);
    let began = Instant::now();
    let report = core.drain().unwrap();
    assert!(
        began.elapsed() >= Duration::from_millis(150 * 4),
        "the witness: the server was slow"
    );
    assert_eq!(report.answered, 4, "{report:?}");
    assert!(
        core.queue()
            .unwrap()
            .iter()
            .all(|row| row.verdict == Some(Verdict::Accepted))
    );
    for id in ROWS {
        assert_eq!(sent(&server, id).len(), 1, "{id}");
    }
}
