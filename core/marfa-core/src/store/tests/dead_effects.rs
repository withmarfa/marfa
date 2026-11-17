use super::opening::queue_one;
use super::testing::*;
use super::*;

#[test]
fn a_confirmed_replacement_does_not_replay_a_historical_dead_overlay() {
    let conn = conn();
    let row = note(
        "held",
        "confirmed title",
        "confirmed body",
        "2026-01-01T00:00:00Z",
    );
    upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_item','held','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"title":"old title","body":"old body"},"properties_mode":"replace"}"#]).unwrap();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('later','update_item','held','later',?1,1,NULL,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"confirmed title","body":"confirmed body"}}"#]).unwrap();
    record_verdict(
        &conn,
        "later",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    let original = queued_write(&conn, "dead").unwrap().unwrap();
    for _ in 0..2 {
        lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
        let item = item_by_id(&conn, "held").unwrap().unwrap();
        assert_eq!(item.properties["body"], "confirmed body");
        assert_eq!(item.properties["title"], "confirmed title");
        forget_answered(&conn).unwrap();
        assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
    }
}

fn effect_fixture() -> Connection {
    let conn = conn();
    replace_types(&conn, &[wire_type("core.note", None, Some("title"))]).unwrap();
    let row = note(
        "held",
        "server title",
        "server body",
        "2026-01-01T00:00:00Z",
    );
    upsert_item(&conn, &row, None, &Indexing::default()).unwrap();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,read,sent,verdict,queued_at) VALUES ('dead','update_item','held','old-attempt',?1,?2,1,'dead','2026-01-01T00:00:00Z')", params![r#"{"properties":{"title":"old title","body":"old body"},"properties_mode":"replace"}"#, r#"{"properties":{"title":"before","body":"before","description":"remove me"}}"#]).unwrap();
    conn
}

fn effect_answer(conn: &Connection, id: &str, payload: &str, verdict: Verdict) {
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES (?1,'update_item','held',?1,?2,1,'2026-01-01T00:00:01Z')", params![id, payload]).unwrap();
    record_verdict(
        conn,
        id,
        &Answered {
            verdict,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
}

#[test]
fn dead_partial_effects_mask_both_payload_and_read_and_merge_null_is_noop() {
    let conn = effect_fixture();
    let original = queued_write(&conn, "dead").unwrap().unwrap();
    let original_read = read_of(&conn, "dead").unwrap();
    effect_answer(
        &conn,
        "title",
        r#"{"properties":{"title":"server title","body":null}}"#,
        Verdict::Accepted,
    );
    lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
    let item = item_by_id(&conn, "held").unwrap().unwrap();
    assert_eq!(
        item.properties["title"], "server title",
        "masked captured read must not delete the confirmed title"
    );
    assert_eq!(
        item.properties["body"], "old body",
        "merge null did not apply a body replacement"
    );
    assert!(!item.properties.contains_key("description"));
    assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
    effect_answer(
        &conn,
        "body",
        r#"{"properties":{"body":"confirmed body"}}"#,
        Verdict::Accepted,
    );
    assert_eq!(
        current_item_writes(&conn, "held").unwrap().len(),
        1,
        "unconfirmed removal still waits"
    );
    effect_answer(
        &conn,
        "whole",
        r#"{"properties":{"title":"confirmed title","body":"confirmed body"},"properties_mode":"replace"}"#,
        Verdict::Accepted,
    );
    assert!(current_item_writes(&conn, "held").unwrap().is_empty());
    assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
    assert_eq!(read_of(&conn, "dead").unwrap(), original_read);
    assert_eq!(forget_answered(&conn).unwrap(), 3);
    assert!(current_item_writes(&conn, "held").unwrap().is_empty());
    assert!(release(&conn, "dead").unwrap());
    let released = queued_write(&conn, "dead").unwrap().unwrap();
    assert_eq!(released.body, original.body);
    assert_eq!(released.idempotency_key, original.idempotency_key);
    lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
    assert_eq!(
        item_by_id(&conn, "held").unwrap().unwrap().properties["title"],
        "old title"
    );
    record_verdict(
        &conn,
        "dead",
        &Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
}

#[test]
fn only_accepted_effects_settle_dead_intent_and_receipt_rollback_is_atomic() {
    for verdict in [
        Verdict::Merged,
        Verdict::Conflicted,
        Verdict::Refused,
        Verdict::Dead,
        Verdict::Blocked,
    ] {
        let conn = effect_fixture();
        effect_answer(
            &conn,
            "later",
            r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#,
            verdict,
        );
        assert!(
            remaining_dead_fields(&conn, &queued_write(&conn, "dead").unwrap().unwrap())
                .unwrap()
                .unwrap()
                .len()
                >= 3
        );
    }
    let conn = effect_fixture();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_item','held','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#]).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_effect BEFORE INSERT ON meta WHEN NEW.key LIKE 'dead_effect/%' BEGIN SELECT RAISE(ABORT, 'effect write failed'); END;").unwrap();
    assert!(
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None
            }
        )
        .is_err()
    );
    assert!(
        queued_write(&conn, "later")
            .unwrap()
            .unwrap()
            .verdict
            .is_none()
    );
    assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_none());
    assert!(!current_item_writes(&conn, "held").unwrap().is_empty());
}

#[test]
fn a_dead_delete_is_settled_by_an_accepted_restore_but_release_restores_delete() {
    let conn = effect_fixture();
    conn.execute(
        "UPDATE queue SET kind='delete_item', payload='{}', read=NULL WHERE id='dead'",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('restore','restore_item','held','restore','{}',1,'2026-01-01T00:00:01Z')", []).unwrap();
    record_verdict(
        &conn,
        "restore",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert!(current_item_writes(&conn, "held").unwrap().is_empty());
    assert!(release(&conn, "dead").unwrap());
    record_verdict(
        &conn,
        "dead",
        &Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    // Re-reading the old receipt must not suppress the released attempt.
    record_verdict(
        &conn,
        "restore",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
    assert_eq!(
        conn.query_row("SELECT state FROM items WHERE id='held'", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "trashed"
    );
}

#[test]
fn delayed_pre_release_receipts_do_not_cover_the_new_attempt() {
    let conn = effect_fixture();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('inflight','update_item','held','old-inflight',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#]).unwrap();
    assert!(release(&conn, "dead").unwrap());
    record_verdict(
        &conn,
        "dead",
        &Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    record_verdict(
        &conn,
        "inflight",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert!(!current_item_writes(&conn, "held").unwrap().is_empty());
    // A released witness the server answers without a replay covers it.
    conn.execute("UPDATE queue SET verdict='dead' WHERE id='inflight'", [])
        .unwrap();
    assert!(release(&conn, "inflight").unwrap());
    readmit_attempt(&conn, "old-inflight").unwrap();
    record_verdict(
        &conn,
        "inflight",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    assert!(current_item_writes(&conn, "held").unwrap().is_empty());
}

#[test]
fn a_released_write_keeps_its_key_unless_the_server_holds_a_refusal_under_it() {
    let conn = conn();
    // A write that met no answer the server keeps may be held applied
    // under its key; one refused `409` or met `key_spent` is not.
    let cases = [
        ("blocked", Some(BlockedReason::FailingAlone), false),
        ("blocked", Some(BlockedReason::CredentialRefused), false),
        ("blocked", Some(BlockedReason::InstanceChanged), false),
        ("dead", None, false),
        ("blocked", Some(BlockedReason::KeySpent), true),
        ("blocked", Some(BlockedReason::ConflictUnresolved), true),
        ("blocked", Some(BlockedReason::AncestorUnavailable), true),
    ];
    for kind in WriteKind::ALL {
        for (verdict, reason, fresh) in cases {
            let id = format!("{kind}-{verdict}-{}", reason.map_or("none", |r| r.as_str()));
            conn.execute(
                "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, verdict, reason, sent, queued_at)
                     VALUES (?1, ?2, 'held', ?1, '{}', ?3, ?4, 1, '2026-01-01T00:00:00Z')",
                params![id, kind.as_str(), verdict, reason.map(BlockedReason::as_str)],
            )
            .unwrap();
            assert!(release(&conn, &id).unwrap(), "{id} was not released");
            let after = queued_write(&conn, &id).unwrap().unwrap();
            assert_eq!(after.verdict, None, "{id}");
            assert_eq!(
                after.idempotency_key != id,
                fresh,
                "{id} was released under {}: a write whose answer is unknown \
                     goes again only under its key, and one the server refused \
                     under its key only under a fresh one",
                after.idempotency_key
            );
            let spent: Vec<String> = conn
                .query_row("SELECT spent_keys FROM queue WHERE id = ?1", [&id], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .unwrap()
                .map(|json| serde_json::from_str(&json).unwrap())
                .unwrap_or_default();
            assert_eq!(spent.contains(&id), fresh, "{id} spent {spent:?}");
        }
    }
}

#[test]
fn a_release_cut_short_leaves_the_write_as_it_was_and_a_finished_one_under_its_key() {
    let conn = conn();
    conn.execute(
        "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, verdict, reason, sent, queued_at)
             VALUES ('aside', 'replace_tags', 'held', 'first', '{\"tags\":[\"mine\"]}', 'blocked', 'failing_alone', 1, '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
    let before = queued_write(&conn, "aside").unwrap().unwrap();
    {
        let tx = conn.unchecked_transaction().unwrap();
        assert!(release(&tx, "aside").unwrap());
    }
    let after = queued_write(&conn, "aside").unwrap().unwrap();
    assert_eq!(
        (
            after.verdict,
            after.reason.as_deref(),
            after.idempotency_key.as_str()
        ),
        (before.verdict, before.reason.as_deref(), "first"),
        "a release that never committed moved the write"
    );
    assert!(meta_get(&conn, &effect_key("aside")).unwrap().is_none());

    assert!(release(&conn, "aside").unwrap());
    assert!(
        !release(&conn, "aside").unwrap(),
        "a write already released was released again"
    );
    let released = queued_write(&conn, "aside").unwrap().unwrap();
    assert_eq!(
        (released.verdict, released.idempotency_key.as_str()),
        (None, "first")
    );
}

#[test]
fn a_witness_released_under_its_key_covers_a_dead_write_only_once_answered_without_a_replay() {
    let conn = effect_fixture();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('witness','update_item','held','witness-key',?1,1,'dead','2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"new","body":"new"},"properties_mode":"replace"}"#]).unwrap();
    assert!(release(&conn, "dead").unwrap());
    let excluded = |id: &str| {
        let effect: DeadEffect =
            serde_json::from_str(&meta_get(&conn, &effect_key(id)).unwrap().unwrap()).unwrap();
        effect.excluded_attempts.contains("witness-key")
    };
    assert!(excluded("dead"), "the fixture did not exclude the witness");
    assert!(release(&conn, "witness").unwrap());
    assert_eq!(
        queued_write(&conn, "witness")
            .unwrap()
            .unwrap()
            .idempotency_key,
        "witness-key"
    );
    assert!(
        excluded("dead"),
        "a release took the witness for one applied after the dead write, though the server may replay its first answer"
    );
    readmit_attempt(&conn, "witness-key").unwrap();
    assert!(
        !excluded("dead"),
        "a witness applied after the dead write was still taken for one sent before it"
    );
}

#[test]
fn partial_dead_edge_projection_keeps_only_unresolved_properties() {
    let conn = conn();
    let mut edge = wire_edge("edge", "source", "target", "references");
    edge.properties =
        serde_json::from_value(serde_json::json!({"a":"server a","b":"server b"})).unwrap();
    upsert_edge(&conn, &edge).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":"old a","b":"old b"}}"#]).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"a":"server a"}}"#]).unwrap();
    record_verdict(
        &conn,
        "later",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    lay_waiting_edge_writes_over(&conn, "edge").unwrap();
    let current = edge_by_id(&conn, "edge").unwrap().unwrap();
    assert_eq!(current.properties["a"], "server a");
    assert_eq!(current.properties["b"], "old b");
    assert_eq!(forget_answered(&conn).unwrap(), 1);
    lay_waiting_edge_writes_over(&conn, "edge").unwrap();
    assert_eq!(
        edge_by_id(&conn, "edge").unwrap().unwrap().properties["a"],
        "server a"
    );
    assert_eq!(
        queued_write(&conn, "dead").unwrap().unwrap().body["properties"]["a"],
        "old a"
    );
}

#[test]
fn review_purge_must_still_refuse_releasable_dead_work() {
    let core = crate::Core::open_in_memory(None).unwrap();
    {
        let conn = core.conn().unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_item','held','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"title":"old"}}"#]).unwrap();
    }
    assert!(
        matches!(core.purge_item("held", Some(1)), Err(CoreError::Invalid(_))),
        "witness: pending dead write blocks before server transport"
    );
    {
        let conn = core.conn().unwrap();
        effect_answer(
            &conn,
            "later",
            r#"{"properties":{"title":"new"}}"#,
            Verdict::Accepted,
        );
        assert_eq!(
            queued_write(&conn, "dead").unwrap().unwrap().verdict,
            Some(Verdict::Dead)
        );
    }
    let result = core.purge_item("held", Some(1));
    eprintln!("covered dead purge result: {result:?}");
    assert!(
        matches!(result, Err(CoreError::Invalid(_))),
        "coverage must not bypass device/purge-waiting protection"
    );
}

#[test]
fn review_accepted_metadata_replace_must_cover_dead_tag() {
    let conn = effect_fixture();
    conn.execute(
        "UPDATE queue SET kind='add_tag',tag='stale',payload=?1,read=NULL WHERE id='dead'",
        [r#"{"tags":["stale"]}"#],
    )
    .unwrap();
    lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
    assert!(
        item_by_id(&conn, "held")
            .unwrap()
            .unwrap()
            .tags
            .contains(&"stale".to_string()),
        "witness: unresolved tag projects"
    );
    remove_tag(&conn, "held", "stale").unwrap();
    conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('later','replace_tags','held','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"tags":[]}"#]).unwrap();
    record_verdict(
        &conn,
        "later",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
    assert!(
        !item_by_id(&conn, "held")
            .unwrap()
            .unwrap()
            .tags
            .contains(&"stale".to_string()),
        "accepted replacement must keep the dead tag from returning"
    );
}

#[test]
fn review_accepted_edge_null_must_cover_dead_property() {
    let conn = conn();
    let mut edge = wire_edge("edge", "source", "target", "references");
    edge.properties = serde_json::from_value(serde_json::json!({"a":null,"b":"server b"})).unwrap();
    upsert_edge(&conn, &edge).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":"old a","b":"old b"}}"#]).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"a":null}}"#]).unwrap();
    record_verdict(
        &conn,
        "later",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    lay_waiting_edge_writes_over(&conn, "edge").unwrap();
    let current = edge_by_id(&conn, "edge").unwrap().unwrap();
    assert_eq!(
        current.properties["b"], "old b",
        "witness: unresolved b remains projected"
    );
    assert!(
        current.properties["a"].is_null(),
        "edge merge stores null; the old dead a must not overwrite it"
    );
}

#[test]
fn metadata_tag_coverage_keeps_partial_membership_and_raw_releasable_work() {
    let cases = [
        (
            "add_tag",
            Some("stale"),
            r#"{"tags":["stale"]}"#,
            "replace_tags",
            None,
            r#"{"tags":[]}"#,
            vec![],
            vec![],
            false,
        ),
        (
            "remove_tag",
            Some("stale"),
            "{}",
            "replace_tags",
            None,
            r#"{"tags":["stale"]}"#,
            vec!["stale"],
            vec!["stale"],
            false,
        ),
        (
            "replace_tags",
            None,
            r#"{"tags":["old","keep"]}"#,
            "replace_tags",
            None,
            r#"{"tags":["new"]}"#,
            vec!["new"],
            vec!["new"],
            false,
        ),
        (
            "replace_tags",
            None,
            r#"{"tags":["old","keep"]}"#,
            "add_tag",
            Some("new"),
            r#"{"tags":["new"]}"#,
            vec!["new", "other"],
            vec!["old", "keep", "new"],
            true,
        ),
        (
            "replace_tags",
            None,
            r#"{"tags":["old","keep"]}"#,
            "remove_tag",
            Some("old"),
            "{}",
            vec![],
            vec!["keep"],
            true,
        ),
        (
            "remove_tag",
            Some("stale"),
            "{}",
            "add_tag",
            Some("stale"),
            r#"{"tags":["stale"]}"#,
            vec!["stale"],
            vec!["stale"],
            false,
        ),
        (
            "add_tag",
            Some("stale"),
            r#"{"tags":["stale"]}"#,
            "add_tag",
            Some("other"),
            r#"{"tags":["other"]}"#,
            vec!["other"],
            vec!["other", "stale"],
            true,
        ),
    ];
    for (kind, tag, payload, later_kind, later_tag, later_payload, baseline, expected, current) in
        cases
    {
        let conn = effect_fixture();
        conn.execute(
            "UPDATE queue SET kind=?1, tag=?2, payload=?3, read=NULL WHERE id='dead'",
            params![kind, tag, payload],
        )
        .unwrap();
        replace_tags(
            &conn,
            "held",
            &baseline
                .iter()
                .map(|tag| tag.to_string())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        conn.execute("INSERT INTO queue (id,kind,item_id,tag,idempotency_key,payload,sent,queued_at) VALUES ('later',?1,'held',?2,'later',?3,1,'2026-01-01T00:00:01Z')", params![later_kind,later_tag,later_payload]).unwrap();
        let original = queued_write(&conn, "dead").unwrap().unwrap();
        record_verdict(
            &conn,
            "later",
            &Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        for _ in 0..2 {
            lay_waiting_writes_over(&conn, "held", &|_| Indexing::default()).unwrap();
            assert_eq!(
                item_by_id(&conn, "held").unwrap().unwrap().tags,
                expected,
                "{kind} -> {later_kind}"
            );
            assert_eq!(
                !current_item_writes(&conn, "held").unwrap().is_empty(),
                current
            );
            assert_eq!(
                waiting_writes_for_item(&conn, "held").unwrap().len(),
                1,
                "covered work remains releasable"
            );
            assert_eq!(queued_write(&conn, "dead").unwrap().unwrap(), original);
            forget_answered(&conn).unwrap();
        }
        release(&conn, "dead").unwrap();
        record_verdict(
            &conn,
            "dead",
            &Answered {
                verdict: Verdict::Dead,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        assert_eq!(current_item_writes(&conn, "held").unwrap().len(), 1);
    }
}

#[test]
fn partial_dead_edge_null_remains_projected_and_releasable_after_coverage() {
    let conn = conn();
    let mut edge = wire_edge("edge", "source", "target", "references");
    edge.properties =
        serde_json::from_value(serde_json::json!({"a":"server a","b":"new b"})).unwrap();
    upsert_edge(&conn, &edge).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('dead','update_edge','edge','dead',?1,1,'dead','2026-01-01T00:00:00Z')", [r#"{"properties":{"a":null,"b":"old b"}}"#]).unwrap();
    conn.execute("INSERT INTO queue (id,kind,edge_id,idempotency_key,payload,sent,queued_at) VALUES ('later','update_edge','edge','later',?1,1,'2026-01-01T00:00:01Z')", [r#"{"properties":{"b":"new b"}}"#]).unwrap();
    record_verdict(
        &conn,
        "later",
        &Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    lay_waiting_edge_writes_over(&conn, "edge").unwrap();
    let edge = edge_by_id(&conn, "edge").unwrap().unwrap();
    assert!(edge.properties["a"].is_null());
    assert_eq!(edge.properties["b"], "new b");
    assert_eq!(current_edge_writes(&conn, "edge").unwrap().len(), 1);
    assert_eq!(waiting_writes_for_edge(&conn, "edge").unwrap().len(), 1);
}

#[test]
fn clearing_removed_queue_rows_cleans_their_effect_slot_without_mutating_rejected_stores() {
    let conn = effect_fixture();
    release(&conn, "dead").unwrap();
    assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_some());
    conn.execute("UPDATE queue SET kind='remove_tag', tag='stale', verdict='refused', sent=1 WHERE id='dead'",[]).unwrap();
    assert_eq!(forget_answered(&conn).unwrap(), 1);
    assert!(meta_get(&conn, &effect_key("dead")).unwrap().is_none());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let malformed = open(&path).unwrap();
    queue_one(&malformed);
    meta_set(
        &malformed,
        "dead_effect/orphan",
        "fixture must survive refusal",
    )
    .unwrap();
    malformed
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    assert!(matches!(open(&path), Err(CoreError::WrongSchema { .. })));
    assert!(matches!(
        open_to_read(&path),
        Err(CoreError::WrongSchema { .. })
    ));
    assert_eq!(
        meta_get(&malformed, "dead_effect/orphan")
            .unwrap()
            .as_deref(),
        Some("fixture must survive refusal")
    );
}
