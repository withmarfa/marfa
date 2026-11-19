use super::*;

#[test]
fn a_create_drawn_to_a_create_that_lands_on_a_held_row_carries_over_and_draws_to_it() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let other = store::testing::note("other", "other", "", "2026-01-01T00:00:00Z");
    store::upsert_item(&core.conn().unwrap(), &other, None, &Default::default()).unwrap();
    let edges_of = |conn: &rusqlite::Connection, id: &str| -> Vec<(String, String)> {
        store::edges_from(conn, id)
            .unwrap()
            .into_iter()
            .map(|edge| (edge.id, edge.to_id))
            .collect()
    };
    let projected = crate::model::projected_edge_id;
    let (create, drawn) = {
        let conn = core.conn().unwrap();
        let queue = |id: &str, target: &str, after: &[String]| {
            let draft = crate::model::Draft {
                r#type: "core.note".into(),
                edges: [("references".to_string(), vec![target.to_string()])].into(),
                ..Default::default()
            };
            let row = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &row, None, &Default::default()).unwrap();
            for edge in draft.projected_edges(id, "2026-01-01T00:00:00Z") {
                store::upsert_edge(&conn, &edge).unwrap();
            }
            let payload = draft.payload(id).unwrap();
            let mut new = write(WriteKind::CreateItem, id, None, None, after);
            new.payload = &payload;
            store::enqueue(&conn, &new).unwrap()
        };
        let create = queue("local", "other", &[]);
        let drawn = queue("drawn", "local", std::slice::from_ref(&create.id));
        // The witness: both creates show their edges before the landing.
        assert_eq!(
            edges_of(&conn, "local"),
            [(projected("local", "references", "other"), "other".into())]
        );
        (create, drawn)
    };
    let mut body: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
        "item.updated",
        "server",
        "core.note",
        1,
    ))
    .unwrap();
    body["listed"] = true.into();
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::json(
            200,
            &body.to_string(),
        ))],
    );
    let answer = Ok(Answer {
        status: 409,
        code: "version_conflict".into(),
        body: "{}".into(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    });
    let settled = land(
        &core,
        &crate::NEVER_STOPPED,
        &create,
        &answer,
        "server",
        "version_conflict".into(),
        &mut ReachChange::default(),
    )
    .unwrap();
    assert!(settled.also.is_empty(), "{:?}", settled.also);
    {
        let conn = core.conn().unwrap();
        let moved = store::queued_write(&conn, &drawn.id).unwrap().unwrap();
        assert_eq!(moved.verdict, None);
        assert!(moved.depends_on.is_empty());
        let payload: serde_json::Value =
            serde_json::from_str(&store::payload_of(&conn, &drawn.id).unwrap()).unwrap();
        assert_eq!(
            payload["edges"]["references"],
            serde_json::json!(["server"])
        );
        assert_eq!(
            edges_of(&conn, "drawn"),
            [(projected("drawn", "references", "server"), "server".into())]
        );
        // The refused create's own edge was never drawn by the server.
        assert!(edges_of(&conn, "server").is_empty());
    }
    let mut item = serde_json::from_str::<serde_json::Value>(&crate::scripted::item_payload(
        "item.created",
        "drawn",
        "core.note",
        1,
    ))
    .unwrap()["item"]
        .clone();
    item["edges"] = serde_json::json!({"references": {"data": [{
        "id": "0190a000-0000-7000-8000-000000000001", "from_id": "drawn",
        "to_id": "server", "edge_type": "references", "properties": {},
        "version": 1, "created_at": "2026-01-02T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z"
    }], "next_cursor": null}});
    server.on(
        "/items",
        vec![crate::scripted::json(
            201,
            &serde_json::json!({ "item": item }).to_string(),
        )],
    );
    server.on(
        "/items/drawn",
        vec![crate::scripted::certified(crate::scripted::json(
            200,
            &serde_json::json!({"item": item, "metadata": {"tags": []}, "listed": true})
                .to_string(),
        ))],
    );
    core.drain().unwrap();
    let sent: serde_json::Value = serde_json::from_slice(&server.seen("/items")[0].body).unwrap();
    assert_eq!(sent["edges"]["references"], serde_json::json!(["server"]));
    let conn = core.conn().unwrap();
    assert_eq!(
        store::queued_write(&conn, &drawn.id)
            .unwrap()
            .unwrap()
            .verdict,
        Some(Verdict::Accepted)
    );
    assert_eq!(
        edges_of(&conn, "drawn"),
        [(
            "0190a000-0000-7000-8000-000000000001".to_string(),
            "server".to_string()
        )]
    );
}

/// When the person clears the time of the item a create makes.
#[derive(Clone, Copy, PartialEq)]
enum Clear {
    Never,
    /// Before the create is first sent.
    Unsent,
    /// After the create was sent once and met a gateway's failure, so
    /// the server may or may not have made it.
    InFlight,
}

/// A create of a note at a time of its own, which a pass then answers
/// with the row the server holds under the same natural key.
#[derive(Clone, Copy)]
struct Landing<'a> {
    keyed: bool,
    clear: Clear,
    /// A time the person sets after the clear.
    later: Option<&'a str>,
    /// The answered row's own time; its creation time is 2026-01-01.
    held_time: &'a str,
    /// The state the read of the answered row finds it in.
    state: &'a str,
    /// The status the server refuses the create with, where it does. A
    /// 409 names the answered row as the one holding the natural key.
    refused: Option<u16>,
    /// Whether a drain before the person's later time sends the create,
    /// has it answered, and meets a gateway's failure reading its row.
    unread_answer: bool,
    /// Whether the store is full as the clear the answer owes is queued.
    full_at_clear: bool,
}

impl Default for Landing<'_> {
    fn default() -> Self {
        Landing {
            keyed: true,
            clear: Clear::Unsent,
            later: None,
            held_time: "2020-01-01T00:00:00.000Z",
            state: "active",
            refused: None,
            unread_answer: false,
            full_at_clear: false,
        }
    }
}

/// What one drain of a `Landing` did.
struct Landed {
    /// The bodies of every create sent, in order.
    creates: Vec<serde_json::Value>,
    /// The bodies of every edit sent, in order.
    edits: Vec<serde_json::Value>,
    drained: Result<DrainReport>,
    /// The bodies the queue still holds after that drain.
    queued: Vec<serde_json::Value>,
    /// Whether the copy still keeps the create's clear for its answer.
    marked: bool,
    /// The edits of the item the queue reports refused.
    refused_edits: usize,
    /// Whether a second drain after it succeeds.
    again: Result<DrainReport>,
    /// The bodies of the edits that second drain sent.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    edits_again: Vec<serde_json::Value>,
}

const LANDED_CREATED_AT: &str = "2026-01-01T00:00:00.000Z";

fn cleared_create_lands(landing: Landing<'_>) -> Landed {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let made = core
        .create_item(&crate::model::Draft {
            r#type: "core.note".into(),
            source: Some("test".into()),
            source_id: landing.keyed.then(|| "key".to_string()),
            occurred_at: Some("2020-01-01T00:00:00Z".into()),
            ..Default::default()
        })
        .unwrap();
    let local = made.item_id.clone().unwrap();
    let edit = |edit: crate::model::Edit| {
        let version = core.get(&local).unwrap().unwrap().version;
        core.update_item(
            &local,
            &crate::model::Edit {
                base_version: Some(version),
                ..edit
            },
        )
        .unwrap();
    };
    let clear = || {
        edit(crate::model::Edit {
            clear_occurred_at: true,
            ..Default::default()
        });
    };
    if landing.clear == Clear::Unsent {
        clear();
    }
    if landing.clear == Clear::InFlight {
        server.on("/items", vec![crate::scripted::unnamed(502, "bad_gateway")]);
        core.drain().unwrap();
        assert!(!store::unsent(&core.conn().unwrap(), &made.id).unwrap());
        clear();
    }
    let mut item = serde_json::from_str::<serde_json::Value>(&crate::scripted::item_payload(
        "item.created",
        "server",
        "core.note",
        2,
    ))
    .unwrap()["item"]
        .clone();
    item["created_at"] = LANDED_CREATED_AT.into();
    item["occurred_at"] = landing.held_time.into();
    let answer = serde_json::json!({ "item": item, "acknowledged": false }).to_string();
    server.on(
        "/items",
        vec![match landing.refused {
            Some(409) => crate::scripted::json(
                409,
                r#"{"error":{"code":"version_conflict","message":"scripted"},"current":{"id":"server"}}"#,
            ),
            Some(status) => crate::scripted::refusal(status, "validation_error"),
            None => crate::scripted::json(200, &answer),
        }],
    );
    server.on(
        &format!("/items/{local}"),
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    let mut read = item.clone();
    read["state"] = landing.state.into();
    let read = crate::scripted::certified(crate::scripted::json(
        200,
        &serde_json::json!({"item": read, "metadata": {"tags": []}, "listed": true, "acknowledged": false})
            .to_string(),
    ));
    if landing.unread_answer {
        server.on(
            "/items/server",
            vec![crate::scripted::unnamed(502, "bad_gateway")],
        );
        core.drain().unwrap();
        assert!(
            store::meta_get(&core.conn().unwrap(), &receipt_key(&made.id))
                .unwrap()
                .is_some()
        );
    }
    if let Some(time) = landing.later {
        edit(crate::model::Edit {
            occurred_at: Some(time.into()),
            ..Default::default()
        });
    }
    server.on("/items/server", vec![read]);
    let drained = {
        #[cfg(debug_assertions)]
        let _full = landing
            .full_at_clear
            .then(|| crate::fault::fail_on_this_thread("owed-time-clear"));
        #[cfg(not(debug_assertions))]
        assert!(
            !landing.full_at_clear,
            "faults compile only with debug assertions"
        );
        core.drain()
    };
    let sent = |path: &str| -> Vec<serde_json::Value> {
        server
            .seen(path)
            .iter()
            .filter(|seen| !seen.body.is_empty())
            .map(|seen| serde_json::from_slice(&seen.body).unwrap())
            .collect()
    };
    let queued = core
        .queue()
        .unwrap()
        .iter()
        .filter(|write| write.verdict.is_none())
        .map(|write| {
            serde_json::from_str(&store::payload_of(&core.conn().unwrap(), &write.id).unwrap())
                .unwrap()
        })
        .collect();
    let marked = store::meta_get(&core.conn().unwrap(), &store::cleared_time_key(&made.id))
        .unwrap()
        .is_some();
    let refused_edits = core
        .queue()
        .unwrap()
        .iter()
        .filter(|write| {
            write.kind == WriteKind::UpdateItem && write.verdict == Some(Verdict::Refused)
        })
        .count();
    let (creates, edits) = (sent("/items"), sent("/items/server"));
    let again = core.drain();
    let edits_again = sent("/items/server").split_off(edits.len());
    Landed {
        creates,
        edits,
        drained,
        queued,
        marked,
        refused_edits,
        again,
        edits_again,
    }
}

/// The times the bodies name, in order.
fn times(bodies: &[serde_json::Value]) -> Vec<String> {
    bodies
        .iter()
        .filter_map(|body| body["occurred_at"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn a_cleared_time_on_a_keyed_create_that_lands_on_a_held_row_is_sent_in_the_same_drain() {
    let landed = cleared_create_lands(Landing::default());
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    assert!(times(&landed.creates).is_empty(), "{:?}", landed.creates);
    assert_eq!(
        times(&landed.edits),
        [LANDED_CREATED_AT],
        "{:?}",
        landed.edits
    );
    assert!(landed.queued.is_empty(), "{:?}", landed.queued);
    assert!(!landed.marked);
}

#[test]
fn a_keyed_create_whose_time_was_not_cleared_leaves_the_held_rows_time_alone() {
    // The witness: the same landing without the clear sends no edit, and
    // the one that clears does.
    let landed = cleared_create_lands(Landing {
        clear: Clear::Never,
        ..Default::default()
    });
    assert_eq!(times(&landed.creates), ["2020-01-01T00:00:00Z"]);
    assert!(times(&landed.edits).is_empty(), "{:?}", landed.edits);
}

#[test]
fn a_cleared_time_that_lands_on_a_row_already_at_its_creation_time_sends_no_edit() {
    let landed = cleared_create_lands(Landing {
        held_time: LANDED_CREATED_AT,
        ..Default::default()
    });
    assert!(times(&landed.edits).is_empty(), "{:?}", landed.edits);
    assert!(!landed.marked);
}

#[test]
fn a_time_set_after_the_clear_is_sent_and_no_clear_follows_it() {
    let landed = cleared_create_lands(Landing {
        later: Some("2024-01-01T00:00:00Z"),
        ..Default::default()
    });
    let times = times(&[landed.creates, landed.edits].concat());
    assert!(
        !times.iter().any(|time| time == LANDED_CREATED_AT),
        "{times:?}"
    );
    assert!(
        times.iter().any(|time| time.starts_with("2024-01-01")),
        "{times:?}"
    );
}

#[test]
fn an_unkeyed_create_cleared_while_unsent_sends_no_follow_up_edit() {
    let landed = cleared_create_lands(Landing {
        keyed: false,
        ..Default::default()
    });
    assert!(times(&landed.creates).is_empty(), "{:?}", landed.creates);
    assert!(times(&landed.edits).is_empty(), "{:?}", landed.edits);
    assert!(!landed.marked);
}

#[test]
fn a_cleared_create_answered_with_a_row_the_copy_does_not_hold_live_settles_and_queues_nothing() {
    let landed = cleared_create_lands(Landing {
        state: "trashed",
        ..Default::default()
    });
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    assert!(landed.again.is_ok(), "{:?}", landed.again);
    assert!(times(&landed.edits).is_empty(), "{:?}", landed.edits);
    assert!(landed.queued.is_empty(), "{:?}", landed.queued);
    assert!(!landed.marked);
}

#[test]
fn a_time_cleared_while_its_create_is_in_flight_is_sent_once_as_the_answered_creation_time() {
    let landed = cleared_create_lands(Landing {
        clear: Clear::InFlight,
        ..Default::default()
    });
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    // The create was sent before the clear, so it names its own time.
    assert!(!times(&landed.creates).is_empty(), "{:?}", landed.creates);
    assert_eq!(
        times(&landed.edits),
        [LANDED_CREATED_AT],
        "{:?}",
        landed.edits
    );
    assert!(!landed.marked);
}

#[test]
fn a_time_set_after_a_clear_whose_create_answer_went_unread_is_the_only_time_sent() {
    let landed = cleared_create_lands(Landing {
        clear: Clear::InFlight,
        unread_answer: true,
        later: Some("2024-01-01T00:00:00Z"),
        ..Default::default()
    });
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    assert_eq!(
        times(&landed.edits),
        ["2024-01-01T00:00:00Z"],
        "{:?}",
        landed.edits
    );
    assert!(!landed.marked);
}

#[test]
fn a_time_cleared_while_its_create_answer_went_unread_is_still_sent() {
    // The witness for the test above: with no later time, the clear the
    // unread answer carries is sent.
    let landed = cleared_create_lands(Landing {
        clear: Clear::InFlight,
        unread_answer: true,
        ..Default::default()
    });
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    assert_eq!(
        times(&landed.edits),
        [LANDED_CREATED_AT],
        "{:?}",
        landed.edits
    );
    assert!(!landed.marked);
}

#[test]
fn a_time_cleared_on_a_keyed_create_refused_onto_another_row_is_refused_with_its_edits() {
    for clear in [Clear::Unsent, Clear::InFlight] {
        let landed = cleared_create_lands(Landing {
            clear,
            refused: Some(409),
            ..Default::default()
        });
        assert!(landed.drained.is_ok(), "{:?}", landed.drained);
        // Made against this device's row, the clear is never sent to the
        // row another device made (`queue-and-verdicts/landed-takes-refused`).
        assert!(landed.edits.is_empty(), "{:?}", landed.edits);
        assert_eq!(landed.refused_edits, 1);
        assert!(landed.queued.is_empty(), "{:?}", landed.queued);
        assert!(!landed.marked);
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_full_store_while_queueing_an_owed_clear_keeps_the_clear_for_the_next_drain() {
    let landed = cleared_create_lands(Landing {
        full_at_clear: true,
        ..Default::default()
    });
    assert!(
        matches!(landed.drained, Err(CoreError::StorageFull(_))),
        "{:?}",
        landed.drained
    );
    assert!(landed.edits.is_empty(), "{:?}", landed.edits);
    assert!(landed.marked);
    // The next drain, with room again, replays the kept answer and sends
    // the clear.
    assert!(landed.again.is_ok(), "{:?}", landed.again);
    assert_eq!(
        times(&landed.edits_again),
        [LANDED_CREATED_AT],
        "{:?}",
        landed.edits_again
    );
}

#[test]
fn a_time_cleared_on_a_create_the_server_refuses_leaves_no_mark() {
    let landed = cleared_create_lands(Landing {
        refused: Some(422),
        ..Default::default()
    });
    assert!(landed.drained.is_ok(), "{:?}", landed.drained);
    assert!(landed.edits.is_empty(), "{:?}", landed.edits);
    assert!(!landed.marked);
}

#[test]
fn natural_key_landing_admits_source_excluded_row_under_its_moved_pin() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let create = {
        let conn = core.conn().unwrap();
        store::upsert_item(
            &conn,
            &store::testing::note("local", "mine", "", "2026-01-01T00:00:00Z"),
            None,
            &Default::default(),
        )
        .unwrap();
        store::pin(&conn, "local").unwrap();
        store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "local", None, None, &[]),
        )
        .unwrap()
    };
    let mut body: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
        "item.updated",
        "server",
        "core.note",
        1,
    ))
    .unwrap();
    body["listed"] = false.into();
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::json(
            200,
            &body.to_string(),
        ))],
    );
    let answer = Ok(Answer {
        status: 409,
        code: "version_conflict".into(),
        body: "{}".into(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    });
    let settled = land(
        &core,
        &crate::NEVER_STOPPED,
        &create,
        &answer,
        "server",
        "version_conflict".into(),
        &mut ReachChange::default(),
    )
    .unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Refused));
    let conn = core.conn().unwrap();
    assert_eq!(
        store::queued_write(&conn, &create.id)
            .unwrap()
            .unwrap()
            .item_id
            .as_deref(),
        Some("server")
    );
    assert!(store::pinned(&conn, "server").unwrap());
    assert!(store::item_held(&conn, "server").unwrap());
    assert!(!store::item_held(&conn, "local").unwrap());
}

#[test]
fn natural_key_receipt_keeps_dependent_work_until_certified_landing() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let (create, dependant) = {
        let conn = core.conn().unwrap();
        let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
        store::pin(&conn, "local").unwrap();
        let create = store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "local", None, None, &[]),
        )
        .unwrap();
        let mut tag = write(
            WriteKind::AddTag,
            "local",
            None,
            None,
            std::slice::from_ref(&create.id),
        );
        tag.tag = Some("kept");
        let dependant = store::enqueue(&conn, &tag).unwrap();
        (create, dependant)
    };
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    let answer = Ok(Answer {
        status: 409,
        code: "version_conflict".into(),
        body: "{}".into(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    });
    let settled = land(
        &core,
        &crate::NEVER_STOPPED,
        &create,
        &answer,
        "server",
        "version_conflict".into(),
        &mut ReachChange::default(),
    )
    .unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Refused));
    // An absent target leaves the receipt owed without ending the pass.
    assert!(settled.unavailable.is_none());
    {
        let conn = core.conn().unwrap();
        assert!(
            store::pending_landings(&conn)
                .unwrap()
                .contains_key(&create.id)
        );
        assert_eq!(
            store::queued_write(&conn, &dependant.id).unwrap().unwrap(),
            dependant
        );
        assert!(store::item_held(&conn, "local").unwrap());
        reach::advance_generation(&conn).unwrap();
    }
    let mut body: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
        "item.updated",
        "server",
        "core.note",
        1,
    ))
    .unwrap();
    body["listed"] = serde_json::Value::Bool(true);
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::json(
            200,
            &body.to_string(),
        ))],
    );
    assert!(
        read_owed_backs(&core, &crate::NEVER_STOPPED, &mut ReachChange::default())
            .unwrap()
            .is_none()
    );
    let conn = core.conn().unwrap();
    let moved = store::queued_write(&conn, &dependant.id).unwrap().unwrap();
    assert_eq!(moved.item_id.as_deref(), Some("server"));
    assert_eq!(moved.body, dependant.body);
    assert_eq!(moved.idempotency_key, dependant.idempotency_key);
    assert!(moved.depends_on.is_empty());
    assert!(
        store::meta_get(&conn, &receipt_key(&create.id))
            .unwrap()
            .is_none()
    );
}

/// A create refused onto `server`, which no read finds, with an edit and
/// a tag of its row waiting on it and an edit waiting on that edit.
fn unfound_landing(
    server: &crate::scripted::Scripted,
    pinned: bool,
) -> (tempfile::TempDir, Core, QueuedWrite, Vec<QueuedWrite>) {
    let (dir, core) = deleting(server, &[]);
    let (create, waiting) = {
        let conn = core.conn().unwrap();
        let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
        if pinned {
            store::pin(&conn, "local").unwrap();
        }
        let create = store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "local", None, None, &[]),
        )
        .unwrap();
        store::mark_sent(&conn, &create.id).unwrap();
        let mut tag = write(
            WriteKind::AddTag,
            "local",
            None,
            None,
            std::slice::from_ref(&create.id),
        );
        tag.tag = Some("kept");
        let tag = store::enqueue(&conn, &tag).unwrap();
        let mut edit = write(
            WriteKind::UpdateItem,
            "local",
            None,
            Some(0),
            std::slice::from_ref(&create.id),
        );
        edit.payload = r#"{"properties":{"title":"mine"}}"#;
        let edit = store::enqueue(&conn, &edit).unwrap();
        let mut later = write(
            WriteKind::UpdateItem,
            "local",
            None,
            Some(0),
            std::slice::from_ref(&edit.id),
        );
        later.payload = r#"{"properties":{"title":"later"}}"#;
        let later = store::enqueue(&conn, &later).unwrap();
        (create, vec![tag, edit, later])
    };
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    let answer = Ok(Answer {
        status: 409,
        code: "version_conflict".into(),
        body: "{}".into(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    });
    land(
        &core,
        &crate::NEVER_STOPPED,
        &create,
        &answer,
        "server",
        "version_conflict".into(),
        &mut ReachChange::default(),
    )
    .unwrap();
    assert!(
        store::pending_landings(&core.conn().unwrap())
            .unwrap()
            .contains_key(&create.id)
    );
    (dir, core, create, waiting)
}

#[test]
fn a_discarded_create_no_read_can_land_refuses_unsent_what_waits_on_it() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core, create, waiting) = unfound_landing(&server, false);
    assert!(core.discard(&create.id).unwrap());
    {
        let conn = core.conn().unwrap();
        assert!(store::queued_write(&conn, &create.id).unwrap().is_none());
        for before in &waiting {
            let after = store::queued_write(&conn, &before.id).unwrap().unwrap();
            assert_eq!(after.verdict, Some(Verdict::Refused));
            assert_eq!(
                after.reason.as_deref(),
                Some("the create_item it waits for was discarded")
            );
            assert_eq!(after.body, before.body);
            assert_eq!(after.idempotency_key, before.idempotency_key);
        }
        assert!(!store::item_held(&conn, "local").unwrap());
        assert!(store::pending_landings(&conn).unwrap().is_empty());
        assert!(
            store::meta_get(&conn, &receipt_key(&create.id))
                .unwrap()
                .is_none()
        );
        assert!(
            store::owed_read_backs(&conn).unwrap().is_empty(),
            "the copy still owes a read of the row only the discarded create named"
        );
    }
    for each in &waiting {
        assert!(!core.release(&each.id).unwrap());
    }
    let reads = server.seen("/items/server").len();
    assert!(reads > 0);
    assert!(
        read_owed_backs(&core, &crate::NEVER_STOPPED, &mut ReachChange::default())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        server.seen("/items/server").len(),
        reads,
        "a drain after the discard read the row the discarded create's key names"
    );
    for each in waiting.iter().rev() {
        assert!(core.discard(&each.id).unwrap());
    }
    assert!(core.queue().unwrap().is_empty());
}

#[test]
fn a_write_withdrawn_alone_lets_every_write_behind_it_go() {
    use crate::scripted::{certified, json};
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let (ahead, behind) = {
        let conn = core.conn().unwrap();
        let item = store::testing::note("local", "Local", "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
        let ahead = store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, "local", None, Some(1), &[]),
        )
        .unwrap();
        store::mark_sent(&conn, &ahead.id).unwrap();
        store::record_verdict(
            &conn,
            &ahead.id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::ConflictUnresolved.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        let waits = [ahead.id.clone()];
        let behind = store::enqueue(
            &conn,
            &write(WriteKind::UpdateItem, "local", None, Some(1), &waits),
        )
        .unwrap();
        assert_eq!(behind.follows.as_deref(), Some(ahead.id.as_str()));
        (ahead, behind)
    };
    let mut theirs: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
        "item.updated",
        "local",
        "core.note",
        2,
    ))
    .unwrap();
    theirs["listed"] = true.into();
    server.on(
        "/items/local",
        vec![certified(json(200, &theirs.to_string()))],
    );
    assert!(core.withdraw_alone(&ahead.id).unwrap());
    let conn = core.conn().unwrap();
    assert_eq!(store::queued_write(&conn, &ahead.id).unwrap(), None);
    let left = store::queued_write(&conn, &behind.id).unwrap().unwrap();
    assert_eq!(
        (left.verdict, left.depends_on.len(), left.follows.as_deref()),
        (None, 0, None),
        "the write behind was refused or still waits on one the queue no longer holds"
    );
}

fn dead_update(core: &Core) -> QueuedWrite {
    let conn = core.conn().unwrap();
    let item = store::testing::note("local", "Local", "", "2026-01-01T00:00:00Z");
    store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
    let dead = store::enqueue(
        &conn,
        &write(WriteKind::UpdateItem, "local", None, Some(1), &[]),
    )
    .unwrap();
    store::mark_sent(&conn, &dead.id).unwrap();
    store::record_verdict(
        &conn,
        &dead.id,
        &store::Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    dead
}

#[test]
fn a_dead_write_is_withdrawn_and_the_copy_holds_what_the_server_does() {
    use crate::scripted::{certified, json};
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let dead = dead_update(&core);
    let mut theirs: serde_json::Value = serde_json::from_str(&crate::scripted::item_payload(
        "item.updated",
        "local",
        "core.note",
        2,
    ))
    .unwrap();
    theirs["listed"] = true.into();
    server.on(
        "/items/local",
        vec![certified(json(200, &theirs.to_string()))],
    );
    assert_eq!(core.withdraw(&dead.id).unwrap(), vec![dead.id.clone()]);
    let conn = core.conn().unwrap();
    assert_eq!(store::queued_write(&conn, &dead.id).unwrap(), None);
    assert_eq!(
        store::item_by_id(&conn, "local").unwrap().unwrap().version,
        2,
        "the copy kept the dead write's value over what the server holds"
    );
    drop(conn);
    assert_eq!(
        core.withdraw(&dead.id).unwrap_err().code(),
        "not_found",
        "the same write was withdrawn twice"
    );
}

#[test]
fn a_purge_refusal_names_only_the_exits_each_waiting_write_has() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["a"]);
    let delete = core.queue().unwrap().remove(0);
    let refusal = |core: &Core| match core.purge_item("a", Some(1)).unwrap_err() {
        CoreError::Invalid(message) => message,
        other => panic!("{other:?}"),
    };
    let waiting = refusal(&core);
    assert!(
        waiting.contains("drain") && !waiting.contains("withdraw") && !waiting.contains("discard"),
        "{waiting}"
    );
    {
        let conn = core.conn().unwrap();
        store::mark_sent(&conn, &delete.id).unwrap();
        store::record_verdict(
            &conn,
            &delete.id,
            &store::Answered {
                verdict: Verdict::Dead,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }
    let dead = refusal(&core);
    assert!(
        dead.contains("withdraw") && dead.contains("release") && !dead.contains("discard"),
        "{dead}"
    );
    {
        let conn = core.conn().unwrap();
        store::release(&conn, &delete.id).unwrap();
        store::record_verdict(
            &conn,
            &delete.id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::KeySpent.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }
    let spent = refusal(&core);
    assert!(
        spent.contains("release") && !spent.contains("withdraw") && !spent.contains("discard"),
        "{spent}"
    );
}

#[test]
fn a_drain_keeps_a_refusal_a_withdraw_recorded_while_it_ran() {
    use crate::scripted::{Answer, certified, json, refusal};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let create = {
        let conn = core.conn().unwrap();
        for id in ["local", "u"] {
            let item = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
        }
        let create = store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "local", None, None, &[]),
        )
        .unwrap();
        store::mark_sent(&conn, &create.id).unwrap();
        store::record_verdict(
            &conn,
            &create.id,
            &store::Answered {
                verdict: Verdict::Blocked,
                reason: Some(BlockedReason::AncestorUnavailable.as_str()),
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        create
    };
    // Sent while the withdraw runs, between the drain's read of the queue
    // and its coming to the write held for the create.
    core.delete_item("u").unwrap();
    let dependant = {
        let conn = core.conn().unwrap();
        let mut edit = write(
            WriteKind::UpdateItem,
            "local",
            None,
            Some(0),
            std::slice::from_ref(&create.id),
        );
        edit.payload = r#"{"properties":{"title":"mine"}}"#;
        store::enqueue(&conn, &edit).unwrap()
    };
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/items/u",
        vec![
            Answer::WaitFor {
                ready: ready.clone(),
                answer: Box::new(json(200, r#"{"ok":true}"#)),
            },
            certified(refusal(404, "item_not_found")),
        ],
    );
    server.on(
        "/items/local",
        vec![
            certified(refusal(404, "item_not_found")),
            certified(refusal(404, "item_not_found")),
        ],
    );
    // The bin holds `u`, which this device trashed, and not `local`,
    // which the server never held.
    server.on("/items", vec![in_the_bin(&[("u", 1)])]);
    std::thread::scope(|scope| {
        let drained = scope.spawn(|| core.drain());
        server.wait_for("/items/u", 1, Duration::from_secs(5));
        assert_eq!(core.withdraw(&create.id).unwrap(), vec![create.id.clone()]);
        ready.store(true, Ordering::Relaxed);
        drained.join().unwrap().unwrap();
    });
    held_in_the_bin(&core, "u", 1);
    let after = store::queued_write(&core.conn().unwrap(), &dependant.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (after.verdict, after.reason.as_deref()),
        (
            Some(Verdict::Refused),
            Some("the create_item it waits for was withdrawn")
        ),
        "the drain held the write behind a create the queue no longer holds, over its refusal"
    );
}

#[test]
fn a_discard_of_a_create_no_read_can_land_waits_for_a_running_drain() {
    use std::time::Duration;
    let server = crate::scripted::Scripted::start();
    let (_dir, core, create, _) = unfound_landing(&server, false);
    let running = core.one_drain();
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| sent.send(core.discard(&create.id)).unwrap());
        assert!(
            received.recv_timeout(Duration::from_millis(250)).is_err(),
            "the discard refused writes a running drain had read as waiting"
        );
        assert!(
            store::queued_write(&core.conn().unwrap(), &create.id)
                .unwrap()
                .is_some()
        );
        drop(running);
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            Ok(true)
        );
    });
}

#[test]
fn a_discarded_landing_keeps_a_read_another_write_owes_for_its_row() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core, create, _) = unfound_landing(&server, false);
    {
        let conn = core.conn().unwrap();
        let theirs = store::testing::note("server", "theirs", "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &theirs, None, &Default::default()).unwrap();
    }
    assert!(core.discard(&create.id).unwrap());
    let conn = core.conn().unwrap();
    assert_eq!(
        store::owed_read_backs(&conn)
            .unwrap()
            .into_iter()
            .map(|owed| owed.id)
            .collect::<Vec<_>>(),
        vec!["server".to_string()],
        "a discard dropped a read of a row the copy holds"
    );
}

#[test]
fn a_discarded_landing_reads_its_pinned_row_before_the_pin_goes() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core, create, _) = unfound_landing(&server, true);
    assert!(core.discard(&create.id).unwrap());
    let conn = core.conn().unwrap();
    assert!(!store::item_held(&conn, "local").unwrap());
    assert!(store::pinned(&conn, "local").unwrap());
    assert_eq!(
        store::owed_read_backs(&conn)
            .unwrap()
            .into_iter()
            .map(|owed| owed.id)
            .collect::<Vec<_>>(),
        vec!["local".to_string()],
        "no read will say whether the server holds the pinned row"
    );
}

#[test]
fn natural_key_landing_on_a_row_in_the_bin_keeps_waiting() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let (create, dependant) = {
        let conn = core.conn().unwrap();
        let local = store::testing::note("local", "draft", "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &local, None, &Default::default()).unwrap();
        let create = store::enqueue(
            &conn,
            &write(WriteKind::CreateItem, "local", None, None, &[]),
        )
        .unwrap();
        let mut tag = write(
            WriteKind::AddTag,
            "local",
            None,
            None,
            std::slice::from_ref(&create.id),
        );
        tag.tag = Some("kept");
        let dependant = store::enqueue(&conn, &tag).unwrap();
        (create, dependant)
    };
    server.on(
        "/items/server",
        vec![crate::scripted::certified(crate::scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    server.on("/items", vec![in_the_bin(&[("server", 3)])]);
    let answer = Ok(Answer {
        status: 409,
        code: "version_conflict".into(),
        body: "{}".into(),
        retry_after_seconds: None,
        replayed: false,
        contract_named: true,
    });
    let settled = land(
        &core,
        &crate::NEVER_STOPPED,
        &create,
        &answer,
        "server",
        "version_conflict".into(),
        &mut ReachChange::default(),
    )
    .unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Refused));
    assert!(settled.unavailable.is_none());
    let conn = core.conn().unwrap();
    assert!(
        store::pending_landings(&conn)
            .unwrap()
            .contains_key(&create.id)
    );
    assert_eq!(
        store::queued_write(&conn, &dependant.id).unwrap().unwrap(),
        dependant
    );
    assert!(store::item_held(&conn, "local").unwrap());
    assert!(
        !store::item_held(&conn, "server").unwrap(),
        "a row in the bin is not the row a natural key landed on"
    );
    drop(conn);

    // A later drain reads the target again for the landing alone.
    assert!(
        read_owed_backs(&core, &crate::NEVER_STOPPED, &mut ReachChange::default())
            .unwrap()
            .is_none()
    );
    assert_eq!(server.seen("/items/server").len(), 2);
    assert!(
        server.seen("/items").is_empty(),
        "a waiting landing's target was looked for in the bin"
    );
    let conn = core.conn().unwrap();
    assert!(
        store::pending_landings(&conn)
            .unwrap()
            .contains_key(&create.id)
    );
    assert!(!store::item_held(&conn, "server").unwrap());
    assert_eq!(
        store::owed_read_backs(&conn)
            .unwrap()
            .iter()
            .map(|owed| owed.id.as_str())
            .collect::<Vec<_>>(),
        ["server"]
    );
}
