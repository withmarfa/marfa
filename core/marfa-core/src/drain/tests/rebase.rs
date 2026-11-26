use super::*;

fn based_on(conn: &rusqlite::Connection, id: &str) -> (Option<i64>, Option<i64>) {
    let row = store::queued_write(conn, id).unwrap().unwrap();
    let body: serde_json::Value =
        serde_json::from_str(&store::payload_of(conn, id).unwrap()).unwrap();
    (row.base_version, body["version"].as_i64())
}

const SUBJECTS: [(WriteKind, WriteKind, &str, Option<&str>); 2] = [
    (WriteKind::CreateItem, WriteKind::UpdateItem, "mine", None),
    (
        WriteKind::CreateEdge,
        WriteKind::UpdateEdge,
        "link",
        Some("link"),
    ),
];

#[test]
fn only_an_answer_about_the_row_itself_rebases_an_edit_of_it() {
    let conn = store::testing::conn();
    for (created, edited, subject, edge) in SUBJECTS {
        let create = store::enqueue(&conn, &write(created, "mine", edge, None, &[])).unwrap();
        let depends_on = [create.id.clone()];
        let edit =
            store::enqueue(&conn, &write(edited, "mine", edge, Some(0), &depends_on)).unwrap();
        let issued =
            store::enqueue(&conn, &write(edited, "mine", edge, Some(3), &depends_on)).unwrap();

        move_edits_behind(&conn, &create, Verdict::Accepted, false, "theirs", &at(5)).unwrap();
        assert_eq!(
            based_on(&conn, &edit.id),
            (Some(0), None),
            "an answer about another row rebased an edit of this one"
        );
        move_edits_behind(&conn, &create, Verdict::Accepted, false, subject, &at(5)).unwrap();
        assert_eq!(based_on(&conn, &edit.id), (Some(5), Some(5)));
        assert_eq!(based_on(&conn, &issued.id), (Some(3), None));
    }
}

fn at(version: i64) -> AnsweredAt<'static> {
    AnsweredAt {
        version,
        item: None,
        made: None,
    }
}

#[test]
fn an_item_edit_moves_only_onto_a_later_answer_that_holds_what_it_read() {
    let conn = store::testing::conn();
    let queue = |base| {
        store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, "mine", None, Some(base), &[]),
        )
        .unwrap()
    };
    let first = queue(3);
    let read = queue(3);
    let unread = queue(3);
    let later = queue(6);
    for edit in [&read, &later] {
        store::record_read(&conn, &edit.id, &json!({ "properties": {} })).unwrap();
    }
    let answered = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
    let answer = AnsweredAt {
        version: 5,
        item: Some(&answered),
        made: None,
    };
    move_edits_behind(&conn, &first, Verdict::Accepted, false, "mine", &answer).unwrap();
    assert_eq!(based_on(&conn, &read.id), (Some(5), Some(5)));
    assert_eq!(
        based_on(&conn, &unread.id),
        (Some(3), None),
        "an edit whose reading was never recorded was moved onto an answer"
    );
    assert_eq!(
        based_on(&conn, &later.id),
        (Some(6), None),
        "an edit made on a later version was moved back onto an older answer"
    );
}

#[test]
fn an_edit_holds_where_the_answer_keeps_every_property_it_changed_as_read() {
    let answered = |properties: serde_json::Value| {
        let mut item = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
        item.properties = properties.as_object().unwrap().clone();
        item.version = 5;
        item
    };
    for (read, sent, row, expected) in [
        (
            json!({ "body": "first", "title": "held" }),
            json!({ "body": "second", "title": "held" }),
            json!({ "body": "first", "title": "elsewhere" }),
            true,
        ),
        (
            json!({ "body": "first", "title": "held" }),
            json!({ "body": "second", "title": "mine" }),
            json!({ "body": "first", "title": "elsewhere" }),
            false,
        ),
        (
            json!({ "body": "first", "title": "held" }),
            json!({ "body": "second", "title": "mine" }),
            json!({ "body": "first", "title": "held" }),
            true,
        ),
        (
            json!({ "notes": "kept" }),
            json!({ "notes": "mine" }),
            json!({ "body": "first" }),
            false,
        ),
        (
            json!({ "notes": null }),
            json!({ "notes": "mine" }),
            json!({ "body": "first" }),
            true,
        ),
    ] {
        let conn = store::testing::conn();
        let body = json!({ "version": 3, "properties": sent }).to_string();
        let edit = store::enqueue(
            &conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
            },
        )
        .unwrap();
        store::record_read(&conn, &edit.id, &json!({ "properties": read })).unwrap();
        let item = answered(row.clone());
        let at = AnsweredAt {
            version: 5,
            item: Some(&item),
            made: None,
        };
        assert_eq!(
            holds(&conn, &edit.id, &at).unwrap(),
            expected,
            "an edit that read {read} and carries {sent}, against an answer holding {row}"
        );
    }
}

#[test]
fn a_first_answer_not_retained_settles_by_the_status_it_carried() {
    let not_retained = |details: serde_json::Value| {
        Ok(Answer {
            status: 422,
            code: "idempotency_result_not_retained".into(),
            body: json!({
                "error": {
                    "code": "idempotency_result_not_retained",
                    "message": "too large to keep",
                    "details": details,
                }
            })
            .to_string(),
            retry_after_seconds: None,
            replayed: false,
            contract_named: true,
            request_id: None,
        })
    };
    let succeeded = not_retained(json!({ "original_status": 201 }));
    assert_eq!(classify(&succeeded), Classified::Delivered);
    for details in [
        json!({ "original_status": 404 }),
        json!({ "original_status": "200" }),
        json!({}),
    ] {
        assert_eq!(
            classify(&not_retained(details.clone())),
            Classified::Contract,
            "{details}"
        );
    }

    let conn = store::testing::conn();
    for (payload, expected) in [
        (
            json!({ "id": "mine", "type": "core.note" }),
            Classified::Delivered,
        ),
        (
            json!({ "type": "core.note", "source": "app", "source_id": "k" }),
            Classified::Contract,
        ),
    ] {
        let body = payload.to_string();
        let create = store::enqueue(
            &conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::CreateItem, "mine", None, None, &[])
            },
        )
        .unwrap();
        assert_eq!(
            refine(&create, &body, &succeeded, classify(&succeeded), false),
            expected,
            "{payload}"
        );
    }
}

#[test]
fn failed_verdicts_restore_unsent_followers_base_without_reading_or_rewriting_sent_work() {
    for kind in [WriteKind::UpdateItem, WriteKind::UpdateEdge] {
        for code in [
            "ancestor_unavailable",
            "version_conflict",
            "idempotency_key_reused",
            "unauthorized",
            "dead",
        ] {
            let dir = tempfile::tempdir().unwrap();
            // No server and no reach: this is a correction of what a
            // queued edit read, not adoption of a server baseline.
            let core = Core::open(dir.path().join("copy.sqlite"), None).unwrap();
            let (ahead, follows, apart, sent, sent_before, key) = {
                let conn = core.conn().unwrap();
                let queue = |base, properties: serde_json::Value| {
                    let body = json!({"version": base, "properties": properties}).to_string();
                    store::enqueue(
                        &conn,
                        &store::NewWrite {
                            payload: &body,
                            ..write(
                                kind,
                                "mine",
                                (kind == WriteKind::UpdateEdge).then_some("edge"),
                                Some(base),
                                &[],
                            )
                        },
                    )
                    .unwrap()
                };
                let ahead = queue(1, json!({"body": "first"}));
                let follows = queue(2, json!({"body": "second", "title": "held"}));
                let apart = queue(2, json!({"title": "other"}));
                let sent = queue(2, json!({"body": "already sent"}));
                store::record_read(
                    &conn,
                    &follows.id,
                    &json!({"properties": {"body": "first", "title": "held"}}),
                )
                .unwrap();
                store::mark_sent(&conn, &ahead.id).unwrap();
                store::mark_sent(&conn, &sent.id).unwrap();
                if code == "dead" {
                    for _ in 1..store::CEILING {
                        store::count_refusal(&conn, &ahead.id).unwrap();
                    }
                }
                let sent_before = store::queued_write(&conn, &sent.id).unwrap().unwrap();
                let key = follows.idempotency_key.clone();
                (ahead, follows, apart, sent, sent_before, key)
            };
            let answer = if code == "dead" {
                Err(CoreError::Decoding("unreadable receipt".into()))
            } else {
                Ok(Answer {
                    status: match code {
                        "unauthorized" => 401,
                        "idempotency_key_reused" => 422,
                        _ => 409,
                    },
                    code: code.into(),
                    body: "{}".into(),
                    retry_after_seconds: None,
                    replayed: false,
                    contract_named: true,
                    request_id: None,
                })
            };
            settle(
                &core,
                &crate::NEVER_STOPPED,
                &ahead,
                &answer,
                classify(&answer),
                Shape::Item,
                &mut ReachChange::default(),
            )
            .unwrap();
            let conn = core.conn().unwrap();
            let expected = if code == "unauthorized" { 2 } else { 1 };
            assert_eq!(
                based_on(&conn, &follows.id),
                (Some(expected), Some(expected)),
                "{kind:?} {code}"
            );
            assert_eq!(based_on(&conn, &apart.id), (Some(2), Some(2)));
            assert_eq!(
                store::queued_write(&conn, &sent.id).unwrap().unwrap(),
                sent_before
            );
            let current = store::queued_write(&conn, &follows.id).unwrap().unwrap();
            assert_eq!(current.idempotency_key, key);
            let properties = if code == "unauthorized" {
                json!({"body": "second", "title": "held"})
            } else {
                json!({"body": "second"})
            };
            assert_eq!(current.body["properties"], properties);
            assert_eq!(
                store::payload_of(&conn, &ahead.id).unwrap(),
                ahead.body.to_string()
            );
            assert!(store::owed_read_backs(&conn).unwrap().is_empty());
        }
    }
}

#[test]
fn an_edit_made_against_one_that_did_not_land_goes_back_onto_its_base() {
    let conn = store::testing::conn();
    let queue = |base: i64, properties: serde_json::Value| {
        let body = json!({ "version": base, "properties": properties }).to_string();
        store::enqueue(
            &conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::UpdateItem, "mine", None, Some(base), &[])
            },
        )
        .unwrap()
    };
    let ahead = queue(3, json!({ "body": "first" }));
    let shares = queue(4, json!({ "body": "second", "title": "held" }));
    let apart = queue(4, json!({ "title": "mine" }));
    let alongside = queue(3, json!({ "body": "third" }));
    store::record_read(
        &conn,
        &shares.id,
        &json!({ "properties": { "body": "first", "title": "held" } }),
    )
    .unwrap();
    move_edits_back(&conn, &ahead).unwrap();
    let moved: serde_json::Value =
        serde_json::from_str(&store::payload_of(&conn, &shares.id).unwrap()).unwrap();
    assert_eq!(
        moved,
        json!({ "version": 3, "properties": { "body": "second" } }),
        "the edit made against the first's body did not go back onto its base"
    );
    assert_eq!(
        store::queued_write(&conn, &apart.id)
            .unwrap()
            .unwrap()
            .base_version,
        Some(4),
        "an edit sharing nothing with the first went back onto its base"
    );
    assert_eq!(
        store::queued_write(&conn, &alongside.id)
            .unwrap()
            .unwrap()
            .base_version,
        Some(3)
    );
}

#[test]
fn a_move_drops_what_the_edit_carries_unchanged() {
    let conn = store::testing::conn();
    let body =
        json!({ "version": 3, "properties": { "title": "held", "body": "second" } }).to_string();
    let edit = store::enqueue(
        &conn,
        &store::NewWrite {
            payload: &body,
            ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
        },
    )
    .unwrap();
    store::record_read(
        &conn,
        &edit.id,
        &json!({ "properties": { "title": "held", "body": "first" } }),
    )
    .unwrap();
    store::move_edit(&conn, &edit.id, 5, None).unwrap();
    let moved: serde_json::Value =
        serde_json::from_str(&store::payload_of(&conn, &edit.id).unwrap()).unwrap();
    assert_eq!(
        moved,
        json!({ "version": 5, "properties": { "body": "second" } })
    );
}

#[test]
fn a_whole_edit_moves_as_the_answer_with_its_changes_laid_over() {
    let conn = store::testing::conn();
    let body = json!({
        "version": 3,
        "properties_mode": "replace",
        "properties": { "title": "held", "body": "second" },
    })
    .to_string();
    let edit = store::enqueue(
        &conn,
        &store::NewWrite {
            payload: &body,
            ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
        },
    )
    .unwrap();
    store::record_read(
        &conn,
        &edit.id,
        &json!({ "properties": { "title": "held", "body": "first", "notes": "gone" } }),
    )
    .unwrap();
    let answer = json!({ "title": "theirs", "body": "first", "notes": "gone", "added": 1 });
    store::move_edit(&conn, &edit.id, 5, answer.as_object()).unwrap();
    let moved: serde_json::Value =
        serde_json::from_str(&store::payload_of(&conn, &edit.id).unwrap()).unwrap();
    assert_eq!(
        moved["properties"],
        json!({ "title": "theirs", "body": "second", "added": 1 })
    );
    assert_eq!(moved["properties_mode"], "replace");
    assert_eq!(moved["version"], 5);
}

#[test]
fn only_the_waiting_unsent_edits_queued_after_it_are_behind_it() {
    let conn = store::testing::conn();
    let queue = |item: &str| {
        store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, item, None, Some(3), &[]),
        )
        .unwrap()
    };
    let _earlier = queue("mine");
    let first = queue("mine");
    let sent = queue("mine");
    store::mark_sent(&conn, &sent.id).unwrap();
    let refused = queue("mine");
    let blocked = queue("mine");
    for (id, verdict) in [
        (&refused.id, Verdict::Refused),
        (&blocked.id, Verdict::Blocked),
    ] {
        store::record_verdict(
            &conn,
            id,
            &store::Answered {
                verdict,
                reason: (verdict == Verdict::Blocked).then_some(crate::model::AWAITING_DEPENDENCY),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }
    let waiting = queue("mine");
    let _other = queue("theirs");

    let behind = store::edits_behind(&conn, &first, "mine").unwrap();
    assert_eq!(
        behind,
        vec![(blocked.id.clone(), Some(3)), (waiting.id.clone(), Some(3))],
        "the edits behind named one queued before the answered one, one already sent, one refused by the drain, or one of another row"
    );
}

/// An exact edit and, as its witness, the same edit not queued exact, each
/// read as holding what the answer holds.
fn exact_and_not(
    conn: &rusqlite::Connection,
    base: i64,
    depends_on: &[String],
) -> (QueuedWrite, QueuedWrite) {
    let body = json!({ "version": base, "properties": { "body": "mine" } }).to_string();
    let queue = || {
        let edit = store::enqueue(
            conn,
            &store::NewWrite {
                payload: &body,
                ..write(WriteKind::UpdateItem, "mine", None, Some(base), depends_on)
            },
        )
        .unwrap();
        store::record_read(conn, &edit.id, &json!({ "properties": { "body": "mine" } })).unwrap();
        edit
    };
    let exact = queue();
    store::refuse_when_moved(conn, &exact.id).unwrap();
    (exact, queue())
}

#[test]
fn an_exact_edit_moves_only_onto_the_version_its_own_edit_ahead_made_from_its_base() {
    let answered = |version| {
        let mut item = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
        item.version = version;
        item
    };
    for (verdict, acknowledged, version, moved) in [
        (Verdict::Accepted, false, 4, true),
        (Verdict::Merged, false, 4, true),
        (Verdict::Merged, false, 5, false),
        (Verdict::Accepted, true, 3, false),
    ] {
        let conn = store::testing::conn();
        let ahead = store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, "mine", None, Some(3), &[]),
        )
        .unwrap();
        let (exact, witness) = exact_and_not(&conn, 3, &[]);
        let item = answered(version);
        let at = AnsweredAt {
            version,
            item: Some(&item),
            made: None,
        };
        move_edits_behind(&conn, &ahead, verdict, acknowledged, "mine", &at).unwrap();
        let case = format!("{verdict:?} at {version}, acknowledged {acknowledged}");
        let expected = if moved {
            (Some(4), Some(4))
        } else {
            (Some(3), Some(3))
        };
        assert_eq!(based_on(&conn, &exact.id), expected, "{case}");
        if version > 3 {
            assert_eq!(
                based_on(&conn, &witness.id),
                (Some(version), Some(version)),
                "{case}"
            );
        }
    }
}

#[test]
fn an_exact_edit_behind_its_own_create_moves_onto_the_version_the_create_made() {
    let conn = store::testing::conn();
    let create = store::enqueue(
        &conn,
        &write(WriteKind::CreateItem, "mine", None, None, &[]),
    )
    .unwrap();
    let (exact, witness) = exact_and_not(&conn, 0, std::slice::from_ref(&create.id));
    let mut item = store::testing::note("mine", "title", "body", "2026-01-01T00:00:00Z");
    item.version = 5;
    let at = AnsweredAt {
        version: 5,
        item: Some(&item),
        made: Some(1),
    };
    move_edits_behind(&conn, &create, Verdict::Accepted, false, "mine", &at).unwrap();
    assert_eq!(based_on(&conn, &exact.id), (Some(1), Some(1)));
    assert_eq!(based_on(&conn, &witness.id), (Some(5), Some(5)));
}

#[test]
fn an_exact_edit_does_not_go_back_onto_the_base_of_one_that_did_not_land() {
    let conn = store::testing::conn();
    let body = json!({ "version": 3, "properties": { "body": "first" } }).to_string();
    let ahead = store::enqueue(
        &conn,
        &store::NewWrite {
            payload: &body,
            ..write(WriteKind::UpdateItem, "mine", None, Some(3), &[])
        },
    )
    .unwrap();
    let (exact, witness) = exact_and_not(&conn, 4, &[]);
    move_edits_back(&conn, &ahead).unwrap();
    assert_eq!(based_on(&conn, &exact.id), (Some(4), Some(4)));
    assert_eq!(based_on(&conn, &witness.id), (Some(3), Some(3)));
}
