use super::*;

#[test]
fn a_drain_stopped_before_it_sends_leaves_every_write_queued_and_unsent() {
    use std::sync::atomic::AtomicBool;
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::json(200, r#"{"ok":true}"#),
            crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
        ],
    );
    server.on("/items", vec![in_the_bin(&[("a", 1)])]);
    let (_dir, core) = deleting(&server, &["a"]);
    let before = core.queue().unwrap();
    assert_eq!(
        core.drain_until(&AtomicBool::new(true)).unwrap_err(),
        CoreError::Canceled
    );
    assert!(server.seen("/items/a").is_empty());
    assert_eq!(core.queue().unwrap(), before);
    // The witness: not stopped, the same drain reaches the server.
    core.drain_until(&AtomicBool::new(false)).unwrap();
    assert!(!server.seen("/items/a").is_empty());
    held_in_the_bin(&core, "a", 1);
}

/// A pass that holds a write behind its dependency decides on the queue
/// it read when it began. A hydration from another instance that blocks
/// the write meanwhile must keep its reason, which only a person clears,
/// rather than see it turned into one the next pass clears by itself.
#[cfg(debug_assertions)]
#[test]
fn a_write_a_hydration_held_for_another_instance_mid_pass_keeps_its_reason() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["a", "b"]);
    let queue = core.queue().unwrap();
    let (ahead, behind) = (queue[0].id.clone(), queue[1].id.clone());
    {
        let conn = core.conn().unwrap();
        conn.execute(
            "UPDATE queue SET depends_on = ?2 WHERE id = ?1",
            rusqlite::params![behind, serde_json::to_string(&[&ahead]).unwrap()],
        )
        .unwrap();
        store::record_verdict(
            &conn,
            &ahead,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(crate::model::BlockedReason::ConflictUnresolved.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }
    let reason = |core: &Core| {
        let row = store::queued_write(&core.conn().unwrap(), &behind)
            .unwrap()
            .unwrap();
        (row.verdict, row.reason)
    };

    // The witness: with no hydration between, the pass holds it as
    // waiting on its dependency.
    core.drain().unwrap();
    assert_eq!(
        reason(&core),
        (
            Some(Verdict::Blocked),
            Some(crate::model::AWAITING_DEPENDENCY.to_string())
        )
    );

    let point = format!("drain-holding:{behind}");
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let drain = scope.spawn(|| core.drain());
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the drain never held the write behind its dependency"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // What a hydration from another instance commits as it begins.
        store::block_for_another_instance(&core.conn().unwrap()).unwrap();
        crate::fault::release(&point);
        drain.join().unwrap().unwrap();
    });
    assert_eq!(
        reason(&core),
        (
            Some(Verdict::Blocked),
            Some(
                crate::model::BlockedReason::InstanceChanged
                    .as_str()
                    .to_string()
            )
        ),
        "the drain turned a write held for another instance into one waiting on its dependency"
    );
}

#[test]
fn redirected_writes_and_read_backs_leave_the_queue_uncounted() {
    for read_back in [false, true] {
        let server = crate::scripted::Scripted::start();
        let redirect = crate::scripted::Answer::Json {
            status: 307,
            body: "{}".into(),
            headers: vec![("Location".into(), "/next".into())],
        };
        let mut answers = Vec::new();
        if read_back {
            answers.push(crate::scripted::refusal(400, "invalid"));
        }
        answers.push(redirect);
        server.on("/items/a", answers);
        let (_dir, core) = deleting(&server, &["a", "b"]);
        let before = core.queue().unwrap();
        for _ in 0..6 {
            assert_eq!(
                core.drain().unwrap_err(),
                CoreError::Redirected {
                    origin: server.url(),
                    status: 307,
                    location: Some("/next".into()),
                }
            );
            let after = core.queue().unwrap();
            for (old, new) in before.iter().zip(&after) {
                assert_eq!(old.idempotency_key, new.idempotency_key);
                assert_eq!(old.body, new.body);
                assert_eq!(new.refusals, 0);
            }
            assert_eq!(after[0].verdict, read_back.then_some(Verdict::Refused));
            assert_eq!(after[1].verdict, None);
        }
        assert!(server.seen("/next").is_empty());
        assert!(server.seen("/items/b").is_empty());
    }
}

#[test]
fn accepted_receipt_owes_a_fresh_read_even_without_a_generation_change() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::json(200, r#"{"ok":true}"#),
            crate::scripted::refusal(503, "unavailable"),
        ],
    );
    let (_dir, core) = deleting(&server, &["a"]);
    let original = core.queue().unwrap().remove(0);
    let report = core.drain().unwrap();
    assert_eq!(
        server.seen("/items/a").len(),
        2,
        "a receipt cannot certify the baseline"
    );
    assert!(report.unavailable.is_some());
    let requests = server.seen("/items/a");
    assert!(
        requests[0].reach.is_none(),
        "writes do not carry read preconditions"
    );
    assert_eq!(requests[1].reach.as_deref(), Some(crate::scripted::FENCE));
    let settled = store::queued_write(&core.conn().unwrap(), &original.id)
        .unwrap()
        .unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Accepted));
    assert_eq!(settled.refusals, 0);
    assert_eq!(settled.idempotency_key, original.idempotency_key);
    assert_eq!(settled.body, original.body);
    assert_eq!(
        store::owed_read_backs(&core.conn().unwrap()).unwrap().len(),
        1
    );
    assert_eq!(store::forget_answered(&core.conn().unwrap()).unwrap(), 0);
    server.on(
        "/items/a",
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    server.on("/items", vec![in_the_bin(&[("a", 1)])]);
    core.drain().unwrap();
    assert_eq!(
        server.seen("/items/a").len(),
        3,
        "retry reads without resending the settled write"
    );
    held_in_the_bin(&core, "a", 1);
    assert!(
        store::owed_read_backs(&core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
    assert_eq!(store::forget_answered(&core.conn().unwrap()).unwrap(), 1);
}

#[test]
fn uncertified_read_after_success_keeps_original_receipt_and_expires() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::json(200, r#"{"ok":true}"#),
            crate::scripted::refusal(404, "item_not_found"),
        ],
    );
    let (_dir, core) = deleting(&server, &["a"]);
    let original = core.queue().unwrap().remove(0);
    assert_eq!(core.drain().unwrap_err(), reach::invalid());
    let conn = core.conn().unwrap();
    let settled = store::queued_write(&conn, &original.id).unwrap().unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Accepted));
    assert_eq!(settled.refusals, 0);
    assert_eq!(settled.idempotency_key, original.idempotency_key);
    assert_eq!(settled.body, original.body);
    assert!(
        store::meta_get(&conn, store::META_EVENT_CURSOR)
            .unwrap()
            .is_none()
    );
    assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
    assert!(
        store::meta_get(&conn, &receipt_key(&original.id))
            .unwrap()
            .is_some()
    );
}

#[test]
fn late_read_back_cannot_install_or_delete_or_settle_new_copy_debt() {
    // The server holds the row, holds it in the bin, or holds it nowhere.
    for (present, binned) in [(true, false), (false, true), (false, false)] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &["a"]);
        let row = core.queue().unwrap().remove(0);
        let answer =
            if present {
                let mut body: serde_json::Value = serde_json::from_str(
                    &crate::scripted::item_payload("item.updated", "a", "core.note", 1),
                )
                .unwrap();
                body["listed"] = serde_json::Value::Bool(true);
                crate::scripted::json(200, &body.to_string())
            } else {
                crate::scripted::refusal(404, "item_not_found")
            };
        server.on("/items/a", vec![crate::scripted::certified(answer)]);
        server.on(
            "/items",
            vec![if binned {
                in_the_bin(&[("a", 1)])
            } else {
                crate::scripted::certified(crate::scripted::json(
                    200,
                    r#"{"data":[],"next_cursor":null}"#,
                ))
            }],
        );
        let owed = store::owed_of(&core.conn().unwrap(), &row)
            .unwrap()
            .unwrap();
        let read = read_owed(&core, &owed, Bin::Held, &mut ReachChange::default(), false).unwrap();
        {
            let conn = core.conn().unwrap();
            reach::advance_generation(&conn).unwrap();
            let newer = store::testing::note("a", "rebuilt", "", "2026-02-01T00:00:00Z");
            store::upsert_item(&conn, &newer, None, &Default::default()).unwrap();
            store::owe_read_back(&conn, &owed).unwrap();
        }
        assert!(matches!(
            apply_owed(&core, &owed, &read),
            Err(CoreError::StreamIncomplete { .. })
        ));
        let conn = core.conn().unwrap();
        assert_eq!(
            store::item_by_id(&conn, "a").unwrap().unwrap().properties["title"],
            "rebuilt"
        );
        assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
    }
}

#[test]
fn an_accepted_delete_keeps_the_row_the_bin_holds_trashed_and_pinned() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::json(200, r#"{"ok":true}"#),
            crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
        ],
    );
    server.on("/items", vec![in_the_bin(&[("a", 4)])]);
    let (_dir, core) = deleting(&server, &["a"]);
    store::pin(&core.conn().unwrap(), "a").unwrap();
    // The slice no longer takes the row, so only the pin holds it.
    store::meta_set(
        &core.conn().unwrap(),
        store::META_SLICE_TYPES,
        "[\"core.task\"]",
    )
    .unwrap();
    let report = core.drain().unwrap();
    assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
    let asked = server.seen("/items");
    assert_eq!(asked.len(), 1, "the read by id answered gone, so the bin");
    assert!(asked[0].query.contains("state=trashed"));
    assert_eq!(asked[0].reach.as_deref(), Some(crate::scripted::FENCE));
    held_in_the_bin(&core, "a", 4);
    let conn = core.conn().unwrap();
    assert!(store::pinned(&conn, "a").unwrap());
    assert!(store::owed_read_backs(&conn).unwrap().is_empty());
}

#[test]
fn a_refused_write_keeps_the_row_the_bin_holds() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::refusal(404, "item_not_found"),
            crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
        ],
    );
    server.on("/items", vec![in_the_bin(&[("a", 2)])]);
    let (_dir, core) = deleting(&server, &["a"]);
    let report = core.drain().unwrap();
    assert_eq!(report.verdicts[0].verdict, Some(Verdict::Refused));
    assert_eq!(server.seen("/items").len(), 1, "the bin was asked");
    held_in_the_bin(&core, "a", 2);
    assert!(
        store::owed_read_backs(&core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_row_neither_the_read_by_id_nor_the_bin_holds_is_forgotten() {
    let bin_answers = [
        crate::scripted::certified(crate::scripted::json(
            200,
            r#"{"data":[],"next_cursor":null}"#,
        )),
        crate::scripted::certified(crate::scripted::refusal(403, "forbidden")),
    ];
    for bin in bin_answers {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/items/a",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![bin]);
        let (_dir, core) = deleting(&server, &["a"]);
        store::pin(&core.conn().unwrap(), "a").unwrap();
        // The witness: the copy holds the row until the drain.
        assert!(store::item_held(&core.conn().unwrap(), "a").unwrap());
        core.drain().unwrap();
        assert_eq!(server.seen("/items").len(), 1, "the bin was asked");
        let conn = core.conn().unwrap();
        assert!(!store::item_held(&conn, "a").unwrap());
        assert!(!store::pinned(&conn, "a").unwrap());
        assert!(store::owed_read_backs(&conn).unwrap().is_empty());
    }
}

#[test]
fn a_bin_read_that_fails_keeps_the_row_and_the_read_owed() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![
            crate::scripted::json(200, r#"{"ok":true}"#),
            crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
        ],
    );
    server.on(
        "/items",
        vec![crate::scripted::refusal(503, "server_unavailable")],
    );
    let (_dir, core) = deleting(&server, &["a"]);
    let report = core.drain().unwrap();
    assert!(report.unavailable.is_some(), "{report:?}");
    assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
    assert_eq!(server.seen("/items").len(), 1);
    {
        let conn = core.conn().unwrap();
        assert!(store::item_held(&conn, "a").unwrap());
        assert_eq!(store::owed_read_backs(&conn).unwrap().len(), 1);
    }
    // The next drain reads again, sending nothing, and keeps the row.
    server.on("/items", vec![in_the_bin(&[("a", 1)])]);
    core.drain().unwrap();
    assert_eq!(server.seen("/items/a").len(), 3);
    held_in_the_bin(&core, "a", 1);
    assert!(
        store::owed_read_backs(&core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
}
