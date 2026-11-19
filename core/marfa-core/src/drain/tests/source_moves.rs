use super::*;

#[test]
fn adoption_remaps_unsent_held_edges_without_rewriting_sent_attempts() {
    let conn = store::testing::conn();
    for verdict in [None, Some(Verdict::Blocked), Some(Verdict::Dead)] {
        for sent in [false, true] {
            let id = format!("edge-{:?}-{sent}", verdict);
            let mut queued = write(WriteKind::CreateEdge, "local", Some(&id), Some(3), &[]);
            queued.to_id = Some("local");
            queued.payload = r#"{"from_id":"local","to_id":"local","edge_type":"references","properties":{"note":"unsent content"}}"#;
            let row = store::enqueue(&conn, &queued).unwrap();
            if let Some(verdict) = verdict {
                store::record_verdict(
                    &conn,
                    &row.id,
                    &store::Answered {
                        verdict,
                        reason: (verdict == Verdict::Blocked)
                            .then_some(crate::model::AWAITING_DEPENDENCY),
                        answer: None,
                        conflicted_copy_id: None,
                    },
                )
                .unwrap();
            }
            if sent {
                store::mark_sent(&conn, &row.id).unwrap();
            }
        }
    }
    let before = store::queued_writes(&conn).unwrap();
    store::adopt_answered_id(&conn, "local", "server").unwrap();
    for original in before {
        let row = store::queued_write(&conn, &original.id).unwrap().unwrap();
        let sent = original.edge_id.as_ref().unwrap().ends_with("true");
        let expected = if sent { "local" } else { "server" };
        assert_eq!(row.item_id.as_deref(), Some(expected));
        assert_eq!(row.to_id.as_deref(), Some(expected));
        assert_eq!(row.body["from_id"], expected);
        assert_eq!(row.body["to_id"], expected);
        assert_eq!(row.body["properties"], original.body["properties"]);
        assert_eq!(row.idempotency_key, original.idempotency_key);
        assert_eq!(row.base_version, original.base_version);
        assert_eq!(row.verdict, original.verdict);
        if sent {
            assert_eq!(row, original);
        }
    }
}

/// A copy holding the notes `p1` and `p2`, and for each name in `edges` a
/// note `c-<name>` and the edge `<name>` from `p1` to it.
fn holding_edges(server: &crate::scripted::Scripted, edges: &[&str]) -> (tempfile::TempDir, Core) {
    let (dir, core) = deleting(server, &[]);
    {
        let conn = core.conn().unwrap();
        let held = ["p1", "p2"]
            .into_iter()
            .map(str::to_string)
            .chain(edges.iter().map(|name| format!("c-{name}")));
        for id in held {
            let item = store::testing::note(&id, &id, "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
        }
        for name in edges {
            store::put_server_edge(
                &conn,
                &store::testing::wire_edge(name, "p1", &format!("c-{name}"), "parent-of"),
            )
            .unwrap();
        }
    }
    (dir, core)
}

fn edge_answered(id: &str, source: &str, version: i64) -> crate::scripted::Answer {
    crate::scripted::json(
        200,
        &json!({
            "edge": {
                "id": id,
                "from_id": source,
                "to_id": format!("c-{id}"),
                "edge_type": "parent-of",
                "properties": {},
                "version": version,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-02-01T00:00:00Z",
            },
            "acknowledged": false,
        })
        .to_string(),
    )
}

fn moved_to_p2(core: &Core, edge: &str) -> QueuedWrite {
    core.update_edge(
        edge,
        &crate::model::EdgeEdit {
            base_version: Some(1),
            from_id: Some("p2".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap()
}

fn rank_edit(core: &Core, edge: &str) -> QueuedWrite {
    core.update_edge(
        edge,
        &crate::model::EdgeEdit {
            base_version: Some(1),
            properties: json!({ "rank": 1 }).as_object().unwrap().clone(),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap()
}

#[test]
fn a_run_of_source_moves_is_sent_whole_and_expires_the_copy_once_at_its_end() {
    let server = crate::scripted::Scripted::start();
    let names = ["e1", "e2", "e3"];
    let (_dir, core) = holding_edges(&server, &names);
    let queued: Vec<QueuedWrite> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
    for name in names {
        // The move, then the read of the edge under a reach the move changed.
        server.on(
            &format!("/edges/{name}"),
            vec![
                edge_answered(name, "p2", 2),
                crate::scripted::refusal(409, "reach_changed"),
            ],
        );
    }
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    let conn = core.conn().unwrap();
    for row in &queued {
        let settled = store::queued_write(&conn, &row.id).unwrap().unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Accepted), "{}", row.id);
    }
    let reads = |name: &str| {
        server
            .seen(&format!("/edges/{name}"))
            .iter()
            .filter(|seen| seen.reach.is_some())
            .count()
    };
    // The witness: the move that changed the reach was read back under it.
    assert_eq!(reads("e1"), 1);
    for name in ["e2", "e3"] {
        assert_eq!(
            server.seen(&format!("/edges/{name}")).len(),
            1,
            "{name} was not sent once"
        );
        assert_eq!(
            reads(name),
            0,
            "{name} was read under a reach known to have changed"
        );
    }
    assert!(reach::expired(&conn).unwrap());
    assert_eq!(
        store::owed_read_backs(&conn).unwrap().len(),
        3,
        "the reads stay owed for the hydration that follows"
    );
}

#[test]
fn a_reach_change_met_anywhere_but_in_a_source_move_ends_the_drain_at_once() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
    let (first, second) = (rank_edit(&core, "e1"), rank_edit(&core, "e2"));
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p1", 2),
            crate::scripted::refusal(409, "reach_changed"),
        ],
    );
    server.on("/edges/e2", vec![edge_answered("e2", "p1", 2)]);
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    let conn = core.conn().unwrap();
    let verdict = |id: &str| store::queued_write(&conn, id).unwrap().unwrap().verdict;
    assert_eq!(verdict(&first.id), Some(Verdict::Accepted));
    assert_eq!(verdict(&second.id), None);
    assert!(
        server.seen("/edges/e2").is_empty(),
        "a write behind was sent after the reach changed under a write that moved no source"
    );
    assert!(reach::expired(&conn).unwrap());
}

#[test]
fn a_verdict_whose_own_read_meets_a_changed_reach_is_told_with_the_cut() {
    // The witness: the same answers with the read let through end well
    // and tell the verdict as any drain does.
    for (verdict, answer) in [
        (Verdict::Accepted, edge_answered("e1", "p1", 2)),
        (
            Verdict::Refused,
            crate::scripted::refusal(422, "validation_failed"),
        ),
    ] {
        for changed in [false, true] {
            let server = crate::scripted::Scripted::start();
            let (_dir, core) = holding_edges(&server, &["e1"]);
            let row = rank_edit(&core, "e1");
            let read = if changed {
                crate::scripted::refusal(409, "reach_changed")
            } else {
                crate::scripted::certified(edge_answered(
                    "e1",
                    "p1",
                    1 + i64::from(verdict == Verdict::Accepted),
                ))
            };
            server.on("/edges/e1", vec![answer.clone(), read]);
            let report = match drain_keeping(&core, &crate::NEVER_STOPPED) {
                Ok(report) => {
                    assert!(
                        !changed,
                        "{verdict:?}: the changed reach did not end the drain"
                    );
                    report
                }
                Err(cut) => {
                    assert!(changed, "{verdict:?}: {:?}", cut.error);
                    assert_eq!(cut.error, reach_changed());
                    *cut.settled
                }
            };
            assert_eq!(
                store::queued_write(&core.conn().unwrap(), &row.id)
                    .unwrap()
                    .unwrap()
                    .verdict,
                Some(verdict)
            );
            assert_eq!(
                report.answered, 1,
                "{verdict:?}, reach changed {changed}: {report:?}"
            );
            assert_eq!(
                report
                    .verdicts
                    .iter()
                    .map(|entry| (entry.id.as_str(), entry.verdict))
                    .collect::<Vec<_>>(),
                vec![(row.id.as_str(), Some(verdict))],
                "{verdict:?}, reach changed {changed}: the verdict the queue holds left the report"
            );
            if verdict == Verdict::Refused {
                assert_eq!(
                    report.verdicts[0]
                        .refusal
                        .as_ref()
                        .and_then(|refusal| refusal.code.as_deref()),
                    Some("validation_failed")
                );
            }
        }
    }
}

#[test]
fn a_write_refused_unsent_whose_read_meets_a_changed_reach_is_told_with_the_cut() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/items/a",
        vec![crate::scripted::refusal(409, "reach_changed")],
    );
    let (_dir, core) = deleting(&server, &["a"]);
    let row = core.queue().unwrap().pop().unwrap();
    // A delete with no server version is refused before it is sent.
    core.conn()
        .unwrap()
        .execute("UPDATE queue SET base_version = 0 WHERE id = ?1", [&row.id])
        .unwrap();
    let cut = drain_keeping(&core, &crate::NEVER_STOPPED).unwrap_err();
    assert_eq!(cut.error, reach_changed());
    // The witness: the read the refusal owes was made, and met the change.
    assert_eq!(server.seen("/items/a").len(), 1);
    assert_eq!(
        (cut.settled.unsent, cut.settled.verdicts.len()),
        (1, 1),
        "{:?}",
        cut.settled
    );
    assert_eq!(cut.settled.verdicts[0].id, row.id);
    assert_eq!(cut.settled.verdicts[0].verdict, Some(Verdict::Refused));
}

fn instance_changed() -> CoreError {
    CoreError::expired_by(INSTANCE_CHANGED, 409, INSTANCE_CHANGED)
}

#[test]
fn another_instance_refusing_a_write_ends_the_drain_with_the_queue_kept_and_unsent() {
    // The witness: the same status under another code is about the write,
    // which the drain counts and goes on past.
    for (code, counted) in [
        ("idempotency_key_in_flight", true),
        (INSTANCE_CHANGED, false),
    ] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
        let (first, second) = (rank_edit(&core, "e1"), rank_edit(&core, "e2"));
        server.on("/edges/e1", vec![crate::scripted::refusal(409, code)]);
        server.on(
            "/edges/e2",
            vec![
                edge_answered("e2", "p1", 2),
                crate::scripted::certified(edge_answered("e2", "p1", 2)),
            ],
        );
        let drained = core.drain();
        let conn = core.conn().unwrap();
        let row = |id: &str| store::queued_write(&conn, id).unwrap().unwrap();
        assert_eq!(
            server.seen("/edges/e1")[0].instance.as_deref(),
            Some(crate::scripted::INSTANCE),
            "the write did not name the copy's instance"
        );
        if counted {
            assert!(drained.is_ok(), "{drained:?}");
            assert_eq!(row(&first.id).refusals, 1);
            assert_eq!(server.seen("/edges/e2").len(), 2, "sent and read back");
            assert!(!reach::expired(&conn).unwrap());
            continue;
        }
        assert_eq!(drained.unwrap_err(), instance_changed());
        let kept = row(&first.id);
        assert_eq!(
            kept.verdict, None,
            "the refusal was recorded as the write's verdict"
        );
        assert_eq!(kept.refusals, 0);
        assert_eq!(kept.idempotency_key, first.idempotency_key);
        assert!(
            store::unsent(&conn, &first.id).unwrap(),
            "the write stays marked sent though the refusal proves it was not applied"
        );
        assert_eq!(row(&second.id).verdict, None);
        assert!(
            server.seen("/edges/e2").is_empty(),
            "a write was sent after another instance refused one"
        );
        assert!(reach::expired(&conn).unwrap());
    }
}

#[test]
fn another_instance_refusing_a_write_an_earlier_attempt_sent_marks_it_unsent() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1"]);
    let first = rank_edit(&core, "e1");
    store::mark_sent(&core.conn().unwrap(), &first.id).unwrap();
    server.on(
        "/edges/e1",
        vec![crate::scripted::refusal(409, INSTANCE_CHANGED)],
    );
    assert_eq!(core.drain().unwrap_err(), instance_changed());
    let conn = core.conn().unwrap();
    // The copy is built again from the instance now at the address,
    // which never saw an earlier attempt, so the write is judged afresh.
    assert!(
        store::unsent(&conn, &first.id).unwrap(),
        "the write stays marked sent to an instance the copy no longer follows"
    );
    assert_eq!(
        store::queued_write(&conn, &first.id)
            .unwrap()
            .unwrap()
            .verdict,
        None
    );
}

#[test]
fn another_instance_after_an_accepted_source_move_ends_the_drain_at_once() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1", "e2", "e3"]);
    let moved = moved_to_p2(&core, "e1");
    let (refused, behind) = (rank_edit(&core, "e2"), rank_edit(&core, "e3"));
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::refusal(409, "reach_changed"),
        ],
    );
    server.on(
        "/edges/e2",
        vec![crate::scripted::refusal(409, INSTANCE_CHANGED)],
    );
    server.on("/edges/e3", vec![edge_answered("e3", "p1", 2)]);
    assert_eq!(core.drain().unwrap_err(), instance_changed());
    let conn = core.conn().unwrap();
    let verdict = |id: &str| store::queued_write(&conn, id).unwrap().unwrap().verdict;
    assert_eq!(verdict(&moved.id), Some(Verdict::Accepted));
    assert_eq!(verdict(&refused.id), None);
    assert!(store::unsent(&conn, &refused.id).unwrap());
    assert_eq!(verdict(&behind.id), None);
    assert!(
        server.seen("/edges/e3").is_empty(),
        "a write was sent after another instance refused one, though a source move had deferred the expiry"
    );
    assert!(reach::expired(&conn).unwrap());
}

#[test]
fn the_reads_a_run_of_source_moves_left_owed_are_made_by_the_drain_after_the_copy_is_built_again() {
    let server = crate::scripted::Scripted::start();
    let names = ["e1", "e2"];
    let (_dir, core) = holding_edges(&server, &names);
    for name in names {
        moved_to_p2(&core, name);
        server.on(
            &format!("/edges/{name}"),
            vec![
                edge_answered(name, "p2", 2),
                crate::scripted::refusal(409, "reach_changed"),
            ],
        );
    }
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    // A hydration, as far as the drain can tell.
    {
        let conn = core.conn().unwrap();
        reach::advance_generation(&conn).unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "20").unwrap();
        store::meta_set(&conn, reach::FENCE, &"a".repeat(64)).unwrap();
    }
    for name in names {
        server.on(
            &format!("/edges/{name}"),
            vec![crate::scripted::certified(edge_answered(name, "p2", 2))],
        );
    }
    let report = core.drain().unwrap();
    assert_eq!(
        report.answered, 0,
        "a write already answered was sent again"
    );
    let conn = core.conn().unwrap();
    assert!(store::owed_read_backs(&conn).unwrap().is_empty());
    for name in names {
        assert_eq!(
            store::edge_by_id(&conn, name).unwrap().unwrap().from_id,
            "p2"
        );
    }
}

#[test]
fn an_edit_behind_a_source_move_goes_on_the_version_the_move_made() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1"]);
    let moved = moved_to_p2(&core, "e1");
    let edited = rank_edit(&core, "e1");
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::refusal(409, "reach_changed"),
            edge_answered("e1", "p2", 3),
        ],
    );
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    let conn = core.conn().unwrap();
    for row in [&moved, &edited] {
        let settled = store::queued_write(&conn, &row.id).unwrap().unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Accepted), "{}", row.id);
    }
    let sent: Vec<serde_json::Value> = server
        .seen("/edges/e1")
        .iter()
        .filter(|seen| seen.reach.is_none())
        .map(|seen| serde_json::from_slice(&seen.body).unwrap())
        .collect();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["from_id"], "p2");
    assert_eq!(
        sent[1]["version"], 2,
        "the edit went on the version it was based on"
    );
}

#[test]
fn a_write_refused_behind_a_source_move_is_judged_as_it_would_have_been() {
    let server = crate::scripted::Scripted::start();
    let names = ["e1", "e2", "e3"];
    let (_dir, core) = holding_edges(&server, &names);
    let queued: Vec<QueuedWrite> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::refusal(409, "reach_changed"),
        ],
    );
    server.on(
        "/edges/e2",
        vec![crate::scripted::refusal(404, "item_not_found")],
    );
    server.on("/edges/e3", vec![edge_answered("e3", "p2", 2)]);
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    let conn = core.conn().unwrap();
    let verdicts: Vec<Option<Verdict>> = queued
        .iter()
        .map(|row| {
            store::queued_write(&conn, &row.id)
                .unwrap()
                .unwrap()
                .verdict
        })
        .collect();
    assert_eq!(
        verdicts,
        vec![
            Some(Verdict::Accepted),
            Some(Verdict::Refused),
            Some(Verdict::Accepted)
        ]
    );
}

/// The copy as a hydration leaves it, as far as the drain can tell.
fn hydrated_again(core: &Core) {
    let conn = core.conn().unwrap();
    reach::advance_generation(&conn).unwrap();
    store::meta_set(&conn, store::META_EVENT_CURSOR, "20").unwrap();
    store::meta_set(&conn, reach::FENCE, &"a".repeat(64)).unwrap();
}

#[test]
fn a_refusal_left_to_its_read_behind_a_source_move_does_not_rebase_the_writes_behind_it_again() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
    moved_to_p2(&core, "e1");
    let refused = rank_edit(&core, "e2");
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::refusal(409, "reach_changed"),
            crate::scripted::certified(edge_answered("e1", "p2", 2)),
        ],
    );
    server.on(
        "/edges/e2",
        vec![
            crate::scripted::refusal(404, "item_not_found"),
            crate::scripted::certified(edge_answered("e2", "p1", 1)),
        ],
    );
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    {
        let conn = core.conn().unwrap();
        let settled = store::queued_write(&conn, &refused.id).unwrap().unwrap();
        assert_eq!(settled.verdict, Some(Verdict::Refused));
        assert!(
            store::meta_get(&conn, &receipt_key(&refused.id))
                .unwrap()
                .is_none(),
            "the refusal's queue work is done, yet its receipt stands to do it again"
        );
        assert!(
            store::owed_read_backs(&conn)
                .unwrap()
                .iter()
                .any(|owed| owed.id == "e2"),
            "the refusal's read is no longer owed"
        );
    }
    hydrated_again(&core);
    // A later edit of the same property, moved onto version 2 since.
    let later = {
        let conn = core.conn().unwrap();
        store::enqueue(
            &conn,
            &store::NewWrite {
                kind: WriteKind::UpdateEdge,
                item_id: Some("p1"),
                to_id: Some("c-e2"),
                edge_id: Some("e2"),
                namespace: None,
                tag: None,
                blob: None,
                base_version: Some(2),
                payload: r#"{"properties":{"rank":2},"version":2}"#,
                depends_on: &[],
            },
        )
        .unwrap()
    };
    read_owed_backs(&core, &crate::NEVER_STOPPED, &mut ReachChange::default()).unwrap();
    let conn = core.conn().unwrap();
    assert_eq!(
        store::queued_write(&conn, &later.id)
            .unwrap()
            .unwrap()
            .base_version,
        Some(2),
        "recovering the refusal rebased a later edit a second time, back onto version 1"
    );
}

#[test]
fn a_wait_the_server_asks_for_after_a_source_move_is_reported_with_the_expiry() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
    let moves = [moved_to_p2(&core, "e1"), moved_to_p2(&core, "e2")];
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::refusal(409, "reach_changed"),
        ],
    );
    server.on(
        "/edges/e2",
        vec![crate::scripted::Answer::Json {
            status: 429,
            body: r#"{"error":{"code":"rate_limited","message":"slow down"}}"#.into(),
            headers: vec![("Retry-After".into(), "120".into())],
        }],
    );
    let report = core.drain().unwrap();
    assert_eq!(report.retry_after_seconds, Some(120));
    assert!(report.unavailable.is_some());
    let conn = core.conn().unwrap();
    assert!(reach::expired(&conn).unwrap(), "the copy was left current");
    let verdicts: Vec<_> = moves
        .iter()
        .map(|row| {
            store::queued_write(&conn, &row.id)
                .unwrap()
                .unwrap()
                .verdict
        })
        .collect();
    assert_eq!(verdicts, vec![Some(Verdict::Accepted), None]);
    drop(conn);
    assert!(matches!(
        core.drain().unwrap_err(),
        CoreError::CopyExpired { .. }
    ));
}

#[test]
fn a_read_owed_from_an_earlier_pass_ends_the_drain_at_once_where_the_reach_has_changed() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = holding_edges(&server, &["e1", "e2"]);
    moved_to_p2(&core, "e1");
    let behind = moved_to_p2(&core, "e2");
    server.on(
        "/edges/e1",
        vec![
            edge_answered("e1", "p2", 2),
            crate::scripted::json(503, r#"{"error":{"code":"unavailable","message":"busy"}}"#),
            crate::scripted::refusal(409, "reach_changed"),
        ],
    );
    server.on("/edges/e2", vec![edge_answered("e2", "p2", 2)]);
    let first = core.drain().unwrap();
    assert!(first.unavailable.is_some(), "the witness: the read failed");
    assert!(server.seen("/edges/e2").is_empty());
    assert_eq!(core.drain().unwrap_err(), reach_changed());
    assert!(
        server.seen("/edges/e2").is_empty(),
        "a write was sent after an earlier pass's read met a changed reach"
    );
    let conn = core.conn().unwrap();
    assert_eq!(
        store::queued_write(&conn, &behind.id)
            .unwrap()
            .unwrap()
            .verdict,
        None
    );
    assert!(reach::expired(&conn).unwrap());
}

#[test]
fn moves_the_server_refuses_leave_the_copy_current() {
    let server = crate::scripted::Scripted::start();
    let names = ["e1", "e2"];
    let (_dir, core) = holding_edges(&server, &names);
    let moves: Vec<_> = names.iter().map(|name| moved_to_p2(&core, name)).collect();
    for name in names {
        server.on(
            &format!("/edges/{name}"),
            vec![
                crate::scripted::refusal(404, "item_not_found"),
                crate::scripted::certified(crate::scripted::refusal(404, "edge_not_found")),
            ],
        );
    }
    let report = core.drain().unwrap();
    assert_eq!(report.answered, 2);
    let conn = core.conn().unwrap();
    for row in &moves {
        assert_eq!(
            store::queued_write(&conn, &row.id)
                .unwrap()
                .unwrap()
                .verdict,
            Some(Verdict::Refused)
        );
    }
    assert!(
        !reach::expired(&conn).unwrap(),
        "a refused move expired the copy"
    );
}

#[test]
fn an_edge_read_back_uses_direct_certified_absence() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let owed = store::Owed {
        subject: Subject::Edge,
        id: "edge".into(),
        from_id: Some("source".into()),
        edge_type: Some("references".into()),
        moved: false,
    };
    store::owe_read_back(&core.conn().unwrap(), &owed).unwrap();
    server.on(
        "/edges/edge",
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "edge_not_found",
        ))],
    );
    let read = read_owed(
        &core,
        &crate::NEVER_STOPPED,
        &owed,
        Bin::Held,
        &mut ReachChange::default(),
        false,
    )
    .unwrap();
    apply_owed(&core, &owed, &read).unwrap();
    assert_eq!(server.seen("/edges/edge").len(), 1);
    assert!(server.seen("/items/source/edges").is_empty());
    assert!(
        store::owed_read_backs(&core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_shown_edge_leaves_only_where_the_answer_shows_the_servers_in_its_place() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let conn = core.conn().unwrap();
    for id in ["one", "two", "made"] {
        let row = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &row, None, &Default::default()).unwrap();
    }
    let draft = crate::model::Draft {
        r#type: "core.note".into(),
        edges: [(
            "references".to_string(),
            vec!["one".to_string(), "two".to_string()],
        )]
        .into(),
        ..Default::default()
    };
    let payload = draft.payload("made").unwrap();
    let mut new = write(WriteKind::CreateItem, "made", None, None, &[]);
    new.payload = &payload;
    let create = store::enqueue(&conn, &new).unwrap();
    let shown = |conn: &rusqlite::Connection| -> Vec<String> {
        let mut ids: Vec<String> = store::edges_from(conn, "made")
            .unwrap()
            .into_iter()
            .map(|edge| edge.to_id)
            .collect();
        ids.sort();
        ids
    };
    let server_edge = |target: &str| crate::wire::WireEdge {
        id: format!("0190a000-0000-7000-8000-00000000000{}", target.len()),
        from_id: "made".into(),
        to_id: target.into(),
        edge_type: "references".into(),
        properties: Default::default(),
        version: 1,
        created_at: "2026-01-02T00:00:00Z".into(),
        updated_at: "2026-01-02T00:00:00Z".into(),
    };
    let answered = |edges: Option<serde_json::Value>| {
        let mut item = store::testing::note("made", "made", "", "2026-01-01T00:00:00Z");
        item.edges = edges.map(|edges| serde_json::from_value(edges).unwrap());
        item
    };
    let page = |targets: &[&str], more: bool| {
        serde_json::json!({"references": {
            "data": targets.iter().map(|target| server_edge(target)).collect::<Vec<_>>(),
            "next_cursor": more.then_some("next"),
        }})
    };
    let draw = || {
        for edge in draft.projected_edges("made", "2026-01-01T00:00:00Z") {
            store::upsert_edge(&conn, &edge).unwrap();
        }
    };
    // An acknowledged repeat, a source filter's empty answer and a page
    // naming another pair leave both shown.
    for edges in [
        None,
        Some(serde_json::json!({})),
        Some(page(&["other"], true)),
    ] {
        draw();
        assert_eq!(shown(&conn), ["one", "two"]);
        drop_projected_edges(&conn, &create, "made", Some(&answered(edges.clone()))).unwrap();
        assert_eq!(shown(&conn), ["one", "two"], "{edges:?}");
    }
    // A page naming one pair takes that one only, and the read that
    // brings the other's server edge takes the other.
    drop_projected_edges(
        &conn,
        &create,
        "made",
        Some(&answered(Some(page(&["one"], true)))),
    )
    .unwrap();
    assert_eq!(shown(&conn), ["two"]);
    assert!(store::take_server_edge(&conn, &server_edge("two")).unwrap());
    assert_eq!(
        store::edges_from(&conn, "made")
            .unwrap()
            .into_iter()
            .map(|edge| edge.version)
            .collect::<Vec<_>>(),
        [1]
    );
    // A whole page takes every pair it does not name.
    draw();
    drop_projected_edges(
        &conn,
        &create,
        "made",
        Some(&answered(Some(page(&[], false)))),
    )
    .unwrap();
    assert_eq!(shown(&conn), ["two"]);
}
