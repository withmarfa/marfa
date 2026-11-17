use super::*;

/// The server's own id for the edge from `made` to target `index`.
fn served_id(index: usize) -> String {
    format!("0190a000-0000-7000-8000-{index:012}")
}

fn served_edge(index: usize) -> serde_json::Value {
    json!({
        "id": served_id(index), "from_id": "made", "to_id": format!("t{index:02}"),
        "edge_type": "references", "properties": {}, "version": 1,
        "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
    })
}

/// One page of `made`'s `references` edges, as the item's edge listing
/// answers it.
fn edge_page(targets: std::ops::Range<usize>, next: Option<&str>) -> crate::scripted::Answer {
    crate::scripted::certified(crate::scripted::json(
        200,
        &json!({"data": targets.map(served_edge).collect::<Vec<_>>(), "next_cursor": next})
            .to_string(),
    ))
}

/// A copy holding `count` targets and a waiting create of `made` drawn
/// to each of them by `references`. The server answers the create with
/// `edges` as its edge blocks (`None` for no `edges` at all),
/// acknowledged where `acknowledged`, and the read of `made` with it.
fn drawn_to(
    server: &crate::scripted::Scripted,
    count: usize,
    edges: Option<serde_json::Value>,
    acknowledged: bool,
) -> (tempfile::TempDir, Core) {
    let (dir, core) = deleting(server, &[]);
    let conn = core.conn().unwrap();
    let targets: Vec<String> = (0..count).map(|index| format!("t{index:02}")).collect();
    for id in targets.iter().map(String::as_str).chain(["made"]) {
        let row = store::testing::note(id, id, "", "2026-01-01T00:00:00Z");
        store::upsert_item(&conn, &row, None, &Default::default()).unwrap();
    }
    let draft = crate::model::Draft {
        r#type: "core.note".into(),
        edges: [("references".to_string(), targets)].into(),
        ..Default::default()
    };
    for edge in draft.projected_edges("made", "2026-01-01T00:00:00Z") {
        store::upsert_edge(&conn, &edge).unwrap();
    }
    let payload = draft.payload("made").unwrap();
    let mut new = write(WriteKind::CreateItem, "made", None, None, &[]);
    new.payload = &payload;
    store::enqueue(&conn, &new).unwrap();
    let mut item = serde_json::from_str::<serde_json::Value>(&crate::scripted::item_payload(
        "item.created",
        "made",
        "core.note",
        1,
    ))
    .unwrap()["item"]
        .clone();
    if let Some(edges) = edges {
        item["edges"] = edges;
    }
    server.on(
        "/items",
        vec![crate::scripted::json(
            201,
            &json!({ "item": item, "acknowledged": acknowledged }).to_string(),
        )],
    );
    server.on(
        "/items/made",
        vec![crate::scripted::certified(crate::scripted::json(
            200,
            &json!({"item": item, "metadata": {"tags": []}, "listed": true}).to_string(),
        ))],
    );
    // The server never holds an id a device made (`edges/create-invalid-id`).
    for index in 0..count {
        server.on(
            &format!("/edges/{}", projected(index)),
            vec![
                crate::scripted::refusal(404, "edge_not_found"),
                crate::scripted::certified(crate::scripted::refusal(404, "edge_not_found")),
            ],
        );
    }
    drop(conn);
    (dir, core)
}

/// An edge's door as a delete of it is answered, then read back.
fn gone_after_delete() -> Vec<crate::scripted::Answer> {
    vec![
        crate::scripted::json(204, ""),
        crate::scripted::certified(crate::scripted::refusal(404, "edge_not_found")),
    ]
}

/// Every edge path a write was sent to, in order.
fn edge_doors(server: &crate::scripted::Scripted, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| !server.seen(&format!("/edges/{id}")).is_empty())
        .cloned()
        .collect()
}

fn shown_ids(core: &Core) -> Vec<String> {
    let mut ids: Vec<String> = store::edges_from(&core.conn().unwrap(), "made")
        .unwrap()
        .into_iter()
        .map(|edge| edge.id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn a_delete_of_an_edge_the_create_answer_cut_off_is_sent_to_the_servers_edge() {
    let server = crate::scripted::Scripted::start();
    // The answer's block holds the newest 50 of 60 and a cursor.
    let block = json!({
        "data": (10..60).map(served_edge).collect::<Vec<_>>(),
        "next_cursor": "c1",
    });
    let (_dir, core) = drawn_to(&server, 60, Some(json!({ "references": block })), false);
    server.on("/items/made/edges", vec![edge_page(0..10, None)]);
    server.on(&format!("/edges/{}", served_id(4)), gone_after_delete());
    let delete = core.delete_edge(&projected(4)).unwrap();
    core.drain().unwrap();
    let reads = server.seen("/items/made/edges");
    assert_eq!(reads.len(), 1);
    assert!(reads[0].query.contains("cursor=c1"), "{}", reads[0].query);
    assert_eq!(
        edge_doors(&server, &[projected(4), served_id(4)]),
        [served_id(4)],
        "the delete went to a door other than the server's edge"
    );
    let settled = store::queued_write(&core.conn().unwrap(), &delete.id)
        .unwrap()
        .unwrap();
    assert_eq!(settled.verdict, Some(Verdict::Accepted));
    assert_eq!(settled.edge_id.as_deref(), Some(served_id(4).as_str()));
    let mut expected: Vec<String> = (0..60).filter(|i| *i != 4).map(served_id).collect();
    expected.sort();
    assert_eq!(
        shown_ids(&core),
        expected,
        "a device-made id outlived the read"
    );
}

#[test]
fn an_answer_with_no_block_is_read_from_the_start_and_an_edit_follows_the_read() {
    // A source filter that leaves the block out, and a repeat answered as
    // acknowledged, which carries no edges.
    for (edges, acknowledged) in [(Some(json!({})), false), (None, true)] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = drawn_to(&server, 2, edges, acknowledged);
        server.on("/items/made/edges", vec![edge_page(0..2, None)]);
        let edited = core
            .update_edge(
                &projected(1),
                &crate::model::EdgeEdit {
                    base_version: Some(0),
                    properties: json!({ "note": "edited" }).as_object().unwrap().clone(),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        let mut answered = served_edge(1);
        answered["version"] = 2.into();
        let answered = json!({ "edge": answered, "acknowledged": false }).to_string();
        server.on(
            &format!("/edges/{}", served_id(1)),
            vec![
                crate::scripted::json(200, &answered),
                crate::scripted::certified(crate::scripted::json(200, &answered)),
            ],
        );
        core.drain().unwrap();
        let reads = server.seen("/items/made/edges");
        assert_eq!(reads.len(), 1, "acknowledged {acknowledged}");
        assert!(!reads[0].query.contains("cursor="), "{}", reads[0].query);
        assert_eq!(
            edge_doors(&server, &[projected(1), served_id(1)]),
            [served_id(1)]
        );
        let sent: serde_json::Value =
            serde_json::from_slice(&server.seen(&format!("/edges/{}", served_id(1)))[0].body)
                .unwrap();
        assert_eq!(
            sent["version"], 1,
            "the edit was not based on the edge the create made"
        );
        assert_eq!(
            store::queued_write(&core.conn().unwrap(), &edited.id)
                .unwrap()
                .unwrap()
                .verdict,
            Some(Verdict::Accepted)
        );
        assert_eq!(shown_ids(&core), [served_id(0), served_id(1)]);
    }
}

#[test]
fn an_offline_read_keeps_the_edge_shown_and_the_delete_held_until_the_next_drain() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = drawn_to(&server, 2, None, false);
    server.on(
        "/items/made/edges",
        vec![
            crate::scripted::unnamed(503, "unavailable"),
            edge_page(0..2, None),
        ],
    );
    server.on(&format!("/edges/{}", served_id(1)), gone_after_delete());
    let delete = core.delete_edge(&projected(1)).unwrap();
    let first = core.drain().unwrap();
    assert!(first.unavailable.is_some(), "{first:?}");
    let waiting = |core: &Core| {
        store::queued_write(&core.conn().unwrap(), &delete.id)
            .unwrap()
            .unwrap()
    };
    assert_eq!(
        waiting(&core).verdict.filter(|v| *v != Verdict::Blocked),
        None
    );
    assert_eq!(
        edge_doors(&server, &[projected(1), served_id(1)]),
        Vec::<String>::new()
    );
    assert_eq!(
        shown_ids(&core),
        [projected(0)],
        "the edge went before a read brought the server's"
    );
    core.drain().unwrap();
    assert_eq!(server.seen("/items/made/edges").len(), 2);
    assert_eq!(
        edge_doors(&server, &[projected(1), served_id(1)]),
        [served_id(1)]
    );
    assert_eq!(waiting(&core).verdict, Some(Verdict::Accepted));
    assert_eq!(shown_ids(&core), [served_id(0)]);
}

#[test]
fn a_server_edge_that_arrives_before_the_read_takes_the_waiting_delete() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = drawn_to(&server, 2, None, false);
    server.on(
        "/items/made/edges",
        vec![
            crate::scripted::unnamed(503, "unavailable"),
            edge_page(0..2, None),
        ],
    );
    let delete = core.delete_edge(&projected(1)).unwrap();
    core.drain().unwrap();
    // The edge's event, as catch-up applies it.
    let edge: crate::wire::WireEdge = serde_json::from_value(served_edge(1)).unwrap();
    assert!(store::take_server_edge(&core.conn().unwrap(), &edge).unwrap());
    let moved = store::queued_write(&core.conn().unwrap(), &delete.id)
        .unwrap()
        .unwrap();
    assert_eq!(moved.edge_id.as_deref(), Some(served_id(1).as_str()));
    assert!(!shown_ids(&core).contains(&projected(1)));
    server.on(&format!("/edges/{}", served_id(1)), gone_after_delete());
    core.drain().unwrap();
    assert_eq!(
        edge_doors(&server, &[projected(1), served_id(1)]),
        [served_id(1)]
    );
    assert_eq!(shown_ids(&core), [served_id(0)]);
}

#[test]
fn a_whole_read_without_the_edge_refuses_its_waiting_write_unsent() {
    // A source filter hides the item's edges from the listing as well.
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = drawn_to(&server, 1, None, false);
    server.on("/items/made/edges", vec![edge_page(0..0, None)]);
    let delete = core.delete_edge(&projected(0)).unwrap();
    core.drain().unwrap();
    assert_eq!(server.seen("/items/made/edges").len(), 1);
    assert_eq!(edge_doors(&server, &[projected(0)]), Vec::<String>::new());
    let refused = store::queued_write(&core.conn().unwrap(), &delete.id)
        .unwrap()
        .unwrap();
    assert_eq!(refused.verdict, Some(Verdict::Refused));
    assert!(shown_ids(&core).is_empty());
    assert!(
        store::meta_keys(&core.conn().unwrap(), "create_edges/")
            .unwrap()
            .is_empty()
    );
}

fn accepted_create(report: &DrainReport) -> bool {
    report.verdicts.iter().any(|verdict| {
        verdict.kind == WriteKind::CreateItem && verdict.verdict == Some(Verdict::Accepted)
    })
}

#[test]
fn a_read_refused_for_its_request_settles_the_edges_as_unread_and_lets_the_queue_go() {
    let page = |next: &str| {
        crate::scripted::certified(crate::scripted::json(
            200,
            &json!({"data": [], "next_cursor": next}).to_string(),
        ))
    };
    let cases: Vec<(&str, Vec<crate::scripted::Answer>)> = vec![
        (
            "refused",
            vec![crate::scripted::refusal(400, "validation_error")],
        ),
        (
            "malformed",
            // Text that is not JSON; JSON of another shape is a proof of
            // reach the copy cannot accept, which expires it.
            vec![crate::scripted::certified(crate::scripted::json(
                200, "<html>",
            ))],
        ),
        ("repeated cursor", vec![page("c9"), page("c9")]),
    ];
    for (case, listing) in cases {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = drawn_to(&server, 2, None, false);
        server.on("/items/made/edges", listing);
        let delete = core.delete_edge(&projected(1)).unwrap();
        let first = core
            .drain()
            .unwrap_or_else(|error| panic!("{case}: {error}"));
        assert!(
            accepted_create(&first),
            "{case}: the create's report was lost: {first:?}"
        );
        assert!(first.unavailable.is_none(), "{case}: {first:?}");
        let refused = store::queued_write(&core.conn().unwrap(), &delete.id)
            .unwrap()
            .unwrap();
        assert_eq!(refused.verdict, Some(Verdict::Refused), "{case}");
        assert!(
            first
                .verdicts
                .iter()
                .any(|verdict| verdict.id == delete.id
                    && verdict.verdict == Some(Verdict::Refused)),
            "{case}: the refused delete is in no verdict: {first:?}"
        );
        assert_eq!(first.unsent, 1, "{case}: {first:?}");
        assert_eq!(
            edge_doors(&server, &[projected(1)]),
            Vec::<String>::new(),
            "{case}"
        );
        // Unread, not known gone: each edge the server holds stays shown.
        assert_eq!(
            shown_ids(&core),
            {
                let mut ids = vec![projected(0), projected(1)];
                ids.sort();
                ids
            },
            "{case}"
        );
        assert_eq!(
            store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR)
                .unwrap()
                .as_deref(),
            Some("10"),
            "{case}: the copy expired"
        );
        let reads = server.seen("/items/made/edges").len();
        // A later write goes out, and the read is not asked again.
        server.on(
            "/items/t00",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![in_the_bin(&[("t00", 1)])]);
        core.delete_item("t00").unwrap();
        core.drain()
            .unwrap_or_else(|error| panic!("{case}: {error}"));
        assert!(
            !server.seen("/items/t00").is_empty(),
            "{case}: a later write was not sent"
        );
        assert_eq!(server.seen("/items/made/edges").len(), reads, "{case}");
    }
}

#[test]
fn a_read_of_a_created_items_edges_the_copy_cannot_make_ends_the_pass() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = drawn_to(&server, 2, None, false);
    server.on(
        "/items/made/edges",
        vec![crate::scripted::refusal(409, "reach_changed")],
    );
    server.on(
        "/items/t00",
        vec![crate::scripted::json(200, r#"{"ok":true}"#)],
    );
    core.delete_item("t00").unwrap();
    let error = core.drain().unwrap_err();
    assert!(
        matches!(error, CoreError::CopyExpired { .. }),
        "the pass went on: {error:?}"
    );
    assert_eq!(server.seen("/items/made/edges").len(), 1);
    assert!(
        server.seen("/items/t00").is_empty(),
        "a write was sent after the read ended the pass"
    );
    let conn = core.conn().unwrap();
    let create = store::queued_writes(&conn)
        .unwrap()
        .into_iter()
        .find(|row| row.kind == WriteKind::CreateItem)
        .unwrap();
    assert_eq!(create.verdict, Some(Verdict::Accepted));
}

#[test]
fn an_owed_read_is_tried_again_by_a_drain_with_nothing_queued() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = drawn_to(&server, 2, None, false);
    server.on(
        "/items/made/edges",
        vec![
            crate::scripted::unnamed(503, "unavailable"),
            edge_page(0..2, None),
        ],
    );
    let first = core.drain().unwrap();
    assert!(first.unavailable.is_some(), "{first:?}");
    let mut drawn = vec![projected(0), projected(1)];
    drawn.sort();
    assert_eq!(shown_ids(&core), drawn);
    core.drain().unwrap();
    assert_eq!(server.seen("/items/made/edges").len(), 2);
    assert_eq!(shown_ids(&core), [served_id(0), served_id(1)]);
}

/// An edge write no read owes an id to goes out: an edge the server gave
/// a version 4 id, which an archive restore can carry, and an edge a
/// create was shown with in a copy that recorded no read for it.
#[test]
fn an_edge_write_no_read_owes_is_sent() {
    let ids = [
        "4f1c2a7e-9b3d-4c5e-8a6f-0d1e2f3a4b5c".to_string(),
        projected(0),
    ];
    for id in ids {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &[]);
        {
            let conn = core.conn().unwrap();
            for item in ["made", "t00"] {
                let row = store::testing::note(item, item, "", "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &row, None, &Default::default()).unwrap();
            }
            let mut edge: crate::wire::WireEdge = serde_json::from_value(served_edge(0)).unwrap();
            edge.id = id.clone();
            store::upsert_edge(&conn, &edge).unwrap();
        }
        server.on(&format!("/edges/{id}"), gone_after_delete());
        let delete = core.delete_edge(&id).unwrap();
        core.drain().unwrap();
        assert_eq!(
            edge_doors(&server, std::slice::from_ref(&id)),
            [id.as_str()]
        );
        assert_eq!(
            store::queued_write(&core.conn().unwrap(), &delete.id)
                .unwrap()
                .unwrap()
                .verdict,
            Some(Verdict::Accepted)
        );
    }
}

#[test]
fn a_whole_answer_block_without_the_edge_refuses_its_waiting_write_unsent() {
    let server = crate::scripted::Scripted::start();
    let block = json!({ "data": [served_edge(0)], "next_cursor": null });
    let (_dir, core) = drawn_to(&server, 2, Some(json!({ "references": block })), false);
    let delete = core.delete_edge(&projected(1)).unwrap();
    core.drain().unwrap();
    assert!(server.seen("/items/made/edges").is_empty());
    assert_eq!(edge_doors(&server, &[projected(1)]), Vec::<String>::new());
    let refused = store::queued_write(&core.conn().unwrap(), &delete.id)
        .unwrap()
        .unwrap();
    assert_eq!(refused.verdict, Some(Verdict::Refused));
    assert_eq!(shown_ids(&core), [served_id(0)]);
}
