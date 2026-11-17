use super::testing::*;
use super::*;
use crate::model::LastFailure;

#[test]
fn a_queued_write_round_trips_through_every_column() {
    let conn = conn();
    // Every value distinct, because the reader is positional.
    conn.execute(
        "INSERT INTO queue (
                 id, kind, item_id, to_id, edge_id, namespace, tag, blob,
                 base_version, idempotency_key, payload, depends_on, verdict, reason,
                 answer, conflicted_copy_id, refusals, environmental_streak,
                 last_failure, queued_at, answered_at
             ) VALUES (
                 'q-id', 'update_item', 'the-item', 'the-target', 'the-edge',
                 'the-namespace', 'the-tag', 'the-blob', 7, 'the-key', '{}',
                 '[\"first\",\"second\"]', 'blocked', 'key_spent',
                 '{\"error\":\"as sent\"}', 'the-sibling', 3, 2,
                 '{\"status\":413,\"text\":\"too large\"}',
                 '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
             )",
        [],
    )
    .unwrap();

    let writes = queued_writes(&conn).unwrap();
    assert_eq!(writes.len(), 1);
    let write = &writes[0];
    assert_eq!(write.id, "q-id");
    assert_eq!(write.kind, WriteKind::UpdateItem);
    assert_eq!(write.item_id.as_deref(), Some("the-item"));
    assert_eq!(write.to_id.as_deref(), Some("the-target"));
    assert_eq!(write.edge_id.as_deref(), Some("the-edge"));
    assert_eq!(write.namespace.as_deref(), Some("the-namespace"));
    assert_eq!(write.tag.as_deref(), Some("the-tag"));
    assert_eq!(write.blob.as_deref(), Some("the-blob"));
    assert_eq!(write.base_version, Some(7));
    assert_eq!(write.idempotency_key, "the-key");
    assert_eq!(write.depends_on, vec!["first", "second"]);
    assert_eq!(write.verdict, Some(Verdict::Blocked));
    assert_eq!(write.reason.as_deref(), Some("key_spent"));
    assert_eq!(write.answer.as_deref(), Some("{\"error\":\"as sent\"}"));
    assert_eq!(write.conflicted_copy_id.as_deref(), Some("the-sibling"));
    assert_eq!(write.refusals, 3);
    assert_eq!(write.environmental_streak, 2);
    assert_eq!(
        write.last_failure,
        Some(LastFailure {
            status: Some(413),
            text: Some("too large".into())
        })
    );
    assert_eq!(write.queued_at, "2026-01-01T00:00:00Z");
    assert_eq!(write.answered_at.as_deref(), Some("2026-01-02T00:00:00Z"));
}

#[test]
fn a_send_is_numbered_one_past_the_highest_and_before_that_has_no_number() {
    let conn = conn();
    let write = enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UploadBlob,
            item_id: None,
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: Some("a-blob"),
            base_version: None,
            payload: "{}",
            depends_on: &[],
        },
    )
    .unwrap();
    assert_eq!(last_sent_seq(&conn, &write.id).unwrap(), None);
    assert_eq!(last_sent_seq(&conn, "no-such-write").unwrap(), None);

    mark_sent(&conn, &write.id).unwrap();
    assert_eq!(last_sent_seq(&conn, &write.id).unwrap(), Some(1));
    let other = enqueue(
        &conn,
        &NewWrite {
            kind: WriteKind::UploadBlob,
            item_id: None,
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: Some("another-blob"),
            base_version: None,
            payload: "{}",
            depends_on: &[],
        },
    )
    .unwrap();
    mark_sent(&conn, &other.id).unwrap();
    mark_sent(&conn, &write.id).unwrap();
    assert_eq!(
        (
            last_sent_seq(&conn, &other.id).unwrap(),
            last_sent_seq(&conn, &write.id).unwrap()
        ),
        (Some(2), Some(3)),
        "a send was not numbered after every send before it, across writes"
    );
}

/// The progress-handler ticks (one for every 100 steps of SQLite's virtual
/// machine) it takes to mark one write sent, with `queued` writes in the
/// queue, `sent` of them already sent.
fn ticks_to_mark_sent(queued: usize, sent: usize) -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TICKS: AtomicU64 = AtomicU64::new(0);
    let mut conn = conn();
    let mut last = String::new();
    let tx = conn.unchecked_transaction().unwrap();
    for number in 0..queued {
        let write = enqueue(
            &tx,
            &NewWrite {
                kind: WriteKind::UploadBlob,
                item_id: None,
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: Some(&format!("blob-{number}")),
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap();
        if number < sent {
            mark_sent(&tx, &write.id).unwrap();
        }
        last = write.id;
    }
    tx.commit().unwrap();
    TICKS.store(0, Ordering::SeqCst);
    let _ = conn.progress_handler(
        100,
        Some(|| {
            TICKS.fetch_add(1, Ordering::SeqCst);
            false
        }),
    );
    mark_sent(&conn, &last).unwrap();
    let _ = conn.progress_handler(100, None::<fn() -> bool>);
    TICKS.load(Ordering::SeqCst)
}

#[test]
fn marking_a_write_sent_costs_the_same_whatever_the_queue_holds() {
    let small = ticks_to_mark_sent(50, 49);
    let large = ticks_to_mark_sent(3_000, 2_999);
    assert!(
        large <= small + 2,
        "marking a write sent took {large} ticks with 3,000 writes queued and {small} with 50"
    );
}

#[test]
fn a_streak_of_environmental_failures_ends_with_any_other_outcome() {
    let conn = conn();
    let queue = || {
        enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::UploadBlob,
                item_id: None,
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: Some("a-blob"),
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap()
    };
    let met = LastFailure::of(Some(413), b"too large");
    let state = |id: &str| {
        let write = queued_write(&conn, id).unwrap().unwrap();
        (write.environmental_streak, write.last_failure.is_some())
    };
    let began = |id: &str| -> Option<i64> {
        conn.query_row(
            "SELECT environmental_since FROM queue WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
    };
    let fail = |id: &str, times: i64| {
        for _ in 0..times {
            count_environmental(&conn, id, &met).unwrap();
        }
    };

    // A failure more than fifteen minutes after the last, or after a time
    // the clock has not reached, begins a new run.
    let set_last = |id: &str, behind_ms: i64| {
        conn.execute(
            "UPDATE queue SET environmental_since = environmental_since - ?2,
                                  environmental_last = environmental_last - ?2
                  WHERE id = ?1",
            params![id, behind_ms],
        )
        .unwrap();
    };
    let minute = 60_000;
    let old_run = queue();
    fail(&old_run.id, 2);
    set_last(&old_run.id, 14 * minute);
    let kept = count_environmental(&conn, &old_run.id, &met).unwrap();
    assert_eq!(kept.count, 3, "a gap under fifteen minutes began a new run");
    set_last(&old_run.id, 16 * minute);
    let again = count_environmental(&conn, &old_run.id, &met).unwrap();
    assert_eq!(again.count, 1, "a gap over fifteen minutes kept the run");
    assert!(
        now_millis() - again.began_ms < minute,
        "the new run did not begin at the failure"
    );

    let ahead = queue();
    fail(&ahead.id, 2);
    set_last(&ahead.id, -24 * 60 * minute);
    let restarted = count_environmental(&conn, &ahead.id, &met).unwrap();
    assert_eq!(restarted.count, 1, "a run ahead of the clock was kept");
    assert!(
        restarted.began_ms <= now_millis(),
        "the run still began ahead of the clock"
    );

    let counted = queue();
    assert_eq!(began(&counted.id), None);
    let first = count_environmental(&conn, &counted.id, &met).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = count_environmental(&conn, &counted.id, &met).unwrap();
    assert_eq!(
        (first.count, second.count, second.began_ms),
        (1, 2, first.began_ms),
        "a second failure moved the start of the run"
    );
    assert_eq!(state(&counted.id), (2, true));
    assert_eq!(count_refusal(&conn, &counted.id).unwrap(), 1);
    assert_eq!(
        state(&counted.id),
        (0, false),
        "a refusal counted left the run of environmental failures standing"
    );
    assert_eq!(
        began(&counted.id),
        None,
        "a refusal left the start standing"
    );

    let answered = queue();
    fail(&answered.id, 2);
    record_verdict(
        &conn,
        &answered.id,
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert_eq!(state(&answered.id), (0, false));

    // The witness: set aside, the run and the last answer are what the
    // queue shows, so a verdict does not always clear them.
    let aside = queue();
    fail(&aside.id, 3);
    record_verdict(
        &conn,
        &aside.id,
        &Answered {
            verdict: Verdict::Blocked,
            reason: Some(BlockedReason::FailingAlone.as_str()),
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert_eq!(state(&aside.id), (3, true));
    assert!(began(&aside.id).is_some());
    assert!(release(&conn, &aside.id).unwrap());
    assert_eq!(
        (state(&aside.id), began(&aside.id)),
        ((0, false), None),
        "a release left the run of the write it took back"
    );

    // An answer that says nothing of the write is recorded and nothing
    // else moves.
    let limited = queue();
    fail(&limited.id, 2);
    let before = began(&limited.id);
    note_last_failure(&conn, &limited.id, &LastFailure::of(Some(429), b"slow")).unwrap();
    assert_eq!(
        (state(&limited.id), began(&limited.id)),
        ((2, true), before),
        "recording the last answer moved the streak or its start"
    );
    assert_eq!(
        queued_write(&conn, &limited.id)
            .unwrap()
            .unwrap()
            .last_failure
            .map(|failure| failure.status),
        Some(Some(429))
    );
}

#[test]
fn the_closed_sets_agree_with_the_schema_and_the_reader_refuses_the_rest() {
    let conn = conn();
    for kind in WriteKind::ALL {
        let queued = enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some("an-item"),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap_or_else(|error| panic!("{kind} is in the set and the schema refused it: {error}"));
        assert_eq!(queued.kind, kind);
    }
    // A device never queues a purge, so the kind must not be holdable at all.
    assert!("purge_item".parse::<WriteKind>().is_err());
    assert!(
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, queued_at)
                 VALUES ('purge', 'purge_item', 'purge-key', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .is_err(),
        "the schema holds a purge"
    );

    let verdict_row = |id: &str, verdict: &str, reason: Option<&str>| {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, '2026-01-01T00:00:00Z')",
            params![id, verdict, reason],
        )
    };
    for verdict in Verdict::ALL {
        let reason = (verdict == Verdict::Blocked).then_some("key_spent");
        verdict_row(verdict.as_str(), verdict.as_str(), reason).unwrap_or_else(|error| {
            panic!("{verdict} is in the set and the schema refused it: {error}")
        });
    }
    let read = queued_writes(&conn).unwrap();
    for verdict in Verdict::ALL {
        let row = read.iter().find(|row| row.id == verdict.as_str()).unwrap();
        assert_eq!(row.verdict, Some(verdict));
    }
    let blocked = read.iter().find(|row| row.id == "blocked").unwrap();
    assert_eq!(blocked.blocked_reason(), Some(BlockedReason::KeySpent));

    verdict_row("stray", "blocked", Some("no_such_reason")).unwrap();
    assert!(matches!(queued_writes(&conn), Err(CoreError::Store(_))));
}

#[test]
fn timestamp_reprojection_preserves_the_queued_request_and_retry_key() {
    for (spelling, expected) in [
        ("2026-01-01T01:00:00.500+01:00", "2026-01-01T00:00:00.500Z"),
        ("invalid", "invalid"),
    ] {
        let conn = conn();
        let row = note("held", "server", "", "2026-01-01T00:00:00.000Z");
        upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
        let payload =
            serde_json::json!({ "type": "core.note", "occurred_at": spelling, "properties": {} })
                .to_string();
        let queued = enqueue(
            &conn,
            &NewWrite {
                kind: WriteKind::CreateItem,
                item_id: Some("held"),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: &payload,
                depends_on: &[],
            },
        )
        .unwrap();
        for _ in 0..2 {
            lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
            let item = items_by_ids(&conn, &["held".into()])
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(item.occurred_at, expected);
            let waiting = waiting_writes_for_item(&conn, "held")
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(waiting.body, queued.body);
            assert_eq!(waiting.idempotency_key, queued.idempotency_key);
        }
    }
}

#[test]
fn a_drain_unblocks_the_reasons_that_clear_and_no_other() {
    let conn = conn();
    for reason in BlockedReason::ALL
        .map(BlockedReason::as_str)
        .into_iter()
        .chain([crate::model::AWAITING_DEPENDENCY])
    {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', 'blocked', ?1, '2026-01-01T00:00:00Z')",
            [reason],
        )
        .unwrap();
    }
    unblock_self_clearing(&conn).unwrap();
    let mut unblocked: Vec<String> = queued_writes(&conn)
        .unwrap()
        .into_iter()
        .filter(|row| row.verdict.is_none())
        .map(|row| row.id)
        .collect();
    unblocked.sort();
    assert_eq!(unblocked, vec!["awaiting_dependency", "credential_refused"]);
}

#[test]
fn every_write_to_a_row_or_an_edge_follows_the_one_ahead_of_it() {
    let conn = conn();
    let queue = |kind: WriteKind, edge: Option<&str>| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some("row"),
                to_id: None,
                edge_id: edge,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap()
    };
    for subject in [Subject::Item, Subject::Edge] {
        let edge = (subject == Subject::Edge).then_some("link");
        let mut ahead: Option<String> = None;
        for kind in subject.kinds() {
            let queued = queue(kind, edge);
            assert_eq!(
                queued.follows, ahead,
                "a {kind} does not follow the write to the same {subject:?} ahead of it"
            );
            ahead = Some(queued.id);
        }
        for verdict in [Verdict::Refused, Verdict::Dead] {
            let answered = ahead.clone().unwrap();
            record_verdict(
                &conn,
                &answered,
                &Answered {
                    verdict,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            let behind = queue(subject.kinds()[0], edge);
            assert_eq!(
                behind.follows.as_deref(),
                Some(answered.as_str()),
                "a write behind a {verdict} one does not follow it"
            );
            ahead = Some(behind.id);
        }
    }
    assert_eq!(queue(WriteKind::UploadBlob, None).follows, None);
    assert_eq!(
        Subject::Item.kinds().len() + Subject::Edge.kinds().len(),
        13
    );
}

#[test]
fn a_write_follows_the_write_ahead_of_it_to_the_same_row() {
    let conn = conn();
    let queue = |kind: WriteKind, item: &str, edge: Option<&str>| {
        enqueue(
            &conn,
            &NewWrite {
                kind,
                item_id: Some(item),
                to_id: None,
                edge_id: edge,
                namespace: None,
                tag: None,
                blob: None,
                base_version: Some(1),
                payload: "{}",
                depends_on: &[],
            },
        )
        .unwrap()
    };
    let first = queue(WriteKind::UpdateItem, "row", None);
    assert_eq!(first.follows, None);
    let written = queue(WriteKind::AddTag, "row", None);
    assert_eq!(written.follows.as_deref(), Some(first.id.as_str()));
    record_verdict(
        &conn,
        &written.id,
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    let edge = queue(WriteKind::UpdateEdge, "row", Some("link"));
    assert_eq!(edge.follows, None);
    queue(WriteKind::UpdateItem, "other", None);
    let delete = queue(WriteKind::DeleteItem, "row", None);
    assert_eq!(
        delete.follows.as_deref(),
        Some(first.id.as_str()),
        "the delete follows the written tag, an edge or another row rather than the edit ahead of it"
    );
    let next_edge = queue(WriteKind::DeleteEdge, "row", Some("link"));
    assert_eq!(next_edge.follows.as_deref(), Some(edge.id.as_str()));
    let upload = queue(WriteKind::UploadBlob, "row", None);
    assert_eq!(upload.follows, None);
}

#[test]
fn waiting_writes_are_found_through_the_indexes() {
    let conn = conn();
    let plan = |column: &str| -> String {
        conn.prepare(&format!(
            "EXPLAIN QUERY PLAN SELECT {QUEUE_COLUMNS} FROM queue
                  WHERE {column} = ?1 AND (verdict IS NULL OR verdict = ?2) ORDER BY seq ASC"
        ))
        .unwrap()
        .query_map(["x", "blocked"], |row| row.get::<_, String>(3))
        .unwrap()
        .map(|detail| detail.unwrap())
        .collect::<Vec<_>>()
        .join("; ")
    };
    assert!(
        plan("item_id").contains("queue_item"),
        "{}",
        plan("item_id")
    );
    assert!(
        plan("edge_id").contains("queue_edge"),
        "{}",
        plan("edge_id")
    );
}

#[test]
fn named_writes_are_found_through_the_index_on_their_id() {
    let conn = conn();
    let plan = conn
        .prepare(&format!(
            "EXPLAIN QUERY PLAN SELECT {QUEUE_COLUMNS} FROM queue
                  WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY seq ASC"
        ))
        .unwrap()
        .query_map(["[\"x\"]"], |row| row.get::<_, String>(3))
        .unwrap()
        .map(|detail| detail.unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    assert!(
        plan.contains("SEARCH queue USING INDEX sqlite_autoindex_queue"),
        "{plan}"
    );
}
