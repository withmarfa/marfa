use super::*;

#[test]
fn a_damaged_edge_is_not_edited_or_deleted_over_and_a_server_copy_repairs_it() {
    let core = held_copy();
    let damaged = r#"{"position":1,"note":"#;
    let stored = |core: &Core| -> String {
        core.conn()
            .unwrap()
            .query_row(
                "SELECT properties FROM edges WHERE id = 'link'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    core.conn()
        .unwrap()
        .execute(
            "UPDATE edges SET properties = ?1 WHERE id = 'link'",
            [damaged],
        )
        .unwrap();
    let version = core.edges_from_kept("row").unwrap()[0].0.version;
    let edit = EdgeEdit {
        properties: properties(serde_json::json!({ "position": 2 })),
        base_version: Some(version),
        ..EdgeEdit::default()
    };
    // The witness: the same edit on a readable edge is queued.
    let sound = held_copy();
    assert!(sound.update_edge("link", &edit).unwrap().is_some());

    assert!(core.update_edge("link", &edit).is_err());
    assert!(core.delete_edge("link").is_err());
    assert_eq!(stored(&core), damaged, "the damaged text was written over");
    assert_eq!(core.queue().unwrap().len(), 0);
    let conn = core.conn().unwrap();
    let beneath: i64 = conn
        .query_row("SELECT COUNT(*) FROM beneath", [], |row| row.get(0))
        .unwrap();
    assert_eq!(beneath, 0, "a row of empty properties was held beneath");
    // What needs only an edge's ends and type still finds a damaged one.
    assert!(store::edge_ends(&conn, "link").unwrap().is_some());
    drop(conn);

    // The server's copy replaces it.
    let conn = core.conn().unwrap();
    store::put_server_edge(
        &conn,
        &store::testing::wire_edge("link", "row", "row", "references"),
    )
    .unwrap();
    drop(conn);
    assert_eq!(core.edges_from("row").unwrap().len(), 1);
}

#[test]
fn a_refused_edge_write_never_brings_back_an_edge_the_copy_let_go_of() {
    let core = held_copy();
    let unlinked = core.delete_edge("link").unwrap();
    {
        let conn = core.conn().unwrap();
        // The witness: while its source is held, a refusal puts it back.
        assert!(store::beneath_edge(&conn, "link").unwrap().is_some());
        store::evict_item(&conn, "row", &[]).unwrap();
    }
    refuse(&core, &unlinked);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link").unwrap(),
        None,
        "a refused delete put back an edge whose source left the copy"
    );
    assert_eq!(store::beneath_edge(&conn, "link").unwrap(), None);
}

#[test]
fn a_refused_edge_delete_never_brings_back_an_edge_to_a_purged_row() {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        let other = store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z");
        store::put_server_item(&conn, &other, None, &marfa_rules::catalog::Catalog::empty())
            .unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("link2", "row", "other", "references"),
        )
        .unwrap();
    }
    let unlinked = core.delete_edge("link2").unwrap();
    {
        let conn = core.conn().unwrap();
        assert!(store::beneath_edge(&conn, "link2").unwrap().is_some());
        store::purge_item(&conn, "other").unwrap();
    }
    refuse(&core, &unlinked);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link2").unwrap(),
        None,
        "a refused delete put back an edge to a row the server purged"
    );
}

#[test]
fn a_refused_edge_delete_never_brings_back_an_edge_of_a_type_held_whole_from_a_purged_row() {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SLICE_EDGE_TYPES, "[\"references\"]").unwrap();
    }
    let unlinked = core.delete_edge("link").unwrap();
    {
        let conn = core.conn().unwrap();
        store::purge_item(&conn, "row").unwrap();
    }
    refuse(&core, &unlinked);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link").unwrap(),
        None,
        "a refused delete put back an edge from a row the server purged"
    );
}

/// The server moved `link` to start at `elsewhere`, a row the copy does
/// not hold, while a write of this device's to it waited.
fn moved_off_the_slice(core: &Core) {
    let conn = core.conn().unwrap();
    let mut moved = store::testing::wire_edge("link", "elsewhere", "row", "references");
    moved.version = 2;
    store::put_server_edge(&conn, &moved).unwrap();
    store::lay_waiting_edge_writes_over(&conn, "link").unwrap();
}

#[test]
fn a_row_leaving_keeps_an_edge_a_waiting_write_moved_off_it() {
    let core = movable_link();
    core.update_edge(
        "link",
        &EdgeEdit {
            base_version: Some(1),
            from_id: Some("other".into()),
            ..EdgeEdit::default()
        },
    )
    .unwrap();
    let conn = core.conn().unwrap();
    store::evict_item(&conn, "row", &[]).unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link")
            .unwrap()
            .map(|edge| edge.from_id),
        Some("other".to_string()),
        "a row leaving took an edge a waiting write moved to a row the copy holds"
    );
    assert!(store::beneath_edge(&conn, "link").unwrap().is_some());
}

/// `link` as a `supersedes` edge from `row` to `older`, so its source can
/// move, and `other`, a row it can move to.
fn movable_link() -> Core {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        let other = store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z");
        store::put_server_item(&conn, &other, None, &marfa_rules::catalog::Catalog::empty())
            .unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("link", "row", "older", "supersedes"),
        )
        .unwrap();
    }
    core
}

fn moving(from_id: Option<&str>, to_id: Option<&str>) -> EdgeEdit {
    EdgeEdit {
        base_version: Some(1),
        from_id: from_id.map(str::to_string),
        to_id: to_id.map(str::to_string),
        ..EdgeEdit::default()
    }
}

/// A copy holding `row` and `count` more notes, `n0` onward.
fn copy_with_notes(count: usize) -> Core {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        for number in 0..count {
            let id = format!("n{number}");
            let note = store::testing::note(&id, &id, "body", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &note, None, &marfa_rules::catalog::Catalog::empty())
                .unwrap();
        }
    }
    core
}

fn reference(source: &str, target: &str) -> EdgeDraft {
    EdgeDraft {
        from_id: source.into(),
        to_id: target.into(),
        edge_type: "references".into(),
        ..EdgeDraft::default()
    }
}

/// The write transactions `work` commits on the copy's connection.
fn commits_in(core: &Core, work: impl FnOnce()) -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static COMMITS: AtomicUsize = AtomicUsize::new(0);
    COMMITS.store(0, Ordering::SeqCst);
    let _ = core.conn().unwrap().commit_hook(Some(|| {
        COMMITS.fetch_add(1, Ordering::SeqCst);
        false
    }));
    work();
    let _ = core.conn().unwrap().commit_hook(None::<fn() -> bool>);
    COMMITS.load(Ordering::SeqCst)
}

fn edge_ops(count: usize) -> Vec<EdgeOp> {
    (0..count)
        .map(|number| EdgeOp::Create(reference("row", &format!("n{number}"))))
        .collect()
}

#[test]
fn a_batch_of_edges_is_queued_in_one_transaction() {
    let one_by_one = copy_with_notes(20);
    let separate = commits_in(&one_by_one, || {
        for op in edge_ops(20) {
            let EdgeOp::Create(draft) = op else {
                unreachable!()
            };
            one_by_one.create_edge(&draft).unwrap();
        }
    });
    assert_eq!(separate, 20, "witness: each edge alone commits alone");

    let batched = copy_with_notes(20);
    let mut results = Vec::new();
    let together = commits_in(&batched, || {
        results = batched.queue_edge_ops(&edge_ops(20), |_| false).unwrap();
    });
    assert_eq!(together, 1);
    assert_eq!(results.len(), 20);
    let written: Vec<_> = results
        .iter()
        .map(|result| result.as_ref().unwrap().as_ref().unwrap().clone())
        .collect();
    let queue = batched.queue().unwrap();
    assert_eq!(
        queue.iter().map(|write| &write.id).collect::<Vec<_>>(),
        written.iter().map(|write| &write.id).collect::<Vec<_>>(),
        "the queue holds the writes in the order of the operations"
    );
    assert_eq!(
        batched.edges_from("row").unwrap().len(),
        21,
        "the copy shows each edge"
    );
}

#[test]
fn a_batch_decides_each_operation_on_what_the_ones_before_it_wrote() {
    let core = copy_with_notes(2);
    let first = reference("row", "n0");
    let id = uuid::Uuid::now_v7().to_string();
    let made = EdgeDraft {
        id: Some(id.clone()),
        ..reference("row", "n1")
    };
    let results = core
        .queue_edge_ops(
            &[
                EdgeOp::Create(first),
                EdgeOp::Create(made),
                EdgeOp::Delete(id.clone()),
            ],
            |_| false,
        )
        .unwrap();
    let queued: Vec<QueuedWrite> = results
        .into_iter()
        .map(|result| result.unwrap().unwrap())
        .collect();
    assert_eq!(queued[2].kind, WriteKind::DeleteEdge);
    assert_eq!(
        queued[2].depends_on,
        vec![queued[1].id.clone()],
        "a delete waits on the create of the edge it removes"
    );
    assert_eq!(queued[2].follows, Some(queued[1].id.clone()));
    assert!(core.edges_from("row").unwrap().iter().all(|e| e.id != id));
}

#[test]
fn a_failure_part_way_through_a_batch_leaves_none_of_it() {
    let core = copy_with_notes(3);
    let before = core.queue().unwrap();
    let held = core.edges_from("row").unwrap();
    let mut ops = edge_ops(3);
    ops.push(EdgeOp::Delete("no-such-edge".into()));
    let failure = core.queue_edge_ops(&ops, |_| false).unwrap_err();
    assert!(
        matches!(&failure, CoreError::NotFound { code, .. } if code == "edge_not_found"),
        "{failure:?}"
    );
    assert_eq!(
        core.queue().unwrap(),
        before,
        "part of the batch was queued"
    );
    assert_eq!(core.edges_from("row").unwrap(), held);

    // The witness: without the failing operation the same batch queues.
    let results = core.queue_edge_ops(&edge_ops(3), |_| false).unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(core.queue().unwrap().len(), before.len() + 3);
}

#[test]
fn an_edge_the_copy_refuses_in_a_batch_is_reported_and_the_others_queue() {
    let core = copy_with_notes(2);
    let ops = vec![
        EdgeOp::Create(reference("row", "n0")),
        EdgeOp::Create(reference("n0", "n0")),
        EdgeOp::Create(reference("row", "n1")),
    ];
    let admission = |error: &CoreError| matches!(error, CoreError::Validation { code, .. } if code == "edge_cycle");
    let results = core.queue_edge_ops(&ops, admission).unwrap();
    assert!(matches!(results[0], Ok(Some(_))));
    assert!(matches!(&results[1], Err(error) if admission(error)));
    assert!(matches!(results[2], Ok(Some(_))));
    assert_eq!(core.queue().unwrap().len(), 2);
    assert!(core.edges_from("n0").unwrap().is_empty());

    // The witness: a refusal the caller does not tolerate fails the batch.
    assert!(core.queue_edge_ops(&ops, |_| false).is_err());
    assert_eq!(core.queue().unwrap().len(), 2);
}

#[test]
fn an_edit_that_changes_nothing_in_a_batch_queues_nothing() {
    let core = movable_link();
    let results = core
        .queue_edge_ops(
            &[EdgeOp::Update {
                id: "link".into(),
                edit: EdgeEdit {
                    base_version: Some(1),
                    ..EdgeEdit::default()
                },
            }],
            |_| false,
        )
        .unwrap();
    assert!(matches!(results[0], Ok(None)));
    assert!(core.queue().unwrap().is_empty());
}

#[test]
fn an_edge_move_the_server_always_refuses_is_refused_before_it_is_queued() {
    let core = movable_link();
    {
        let conn = core.conn().unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("many", "row", "other", "references"),
        )
        .unwrap();
    }
    let before = core.queue().unwrap();
    for (id, edit, code) in [
        (
            "link",
            moving(Some("other"), Some("row")),
            "validation_error",
        ),
        ("many", moving(Some("other"), None), "validation_error"),
        ("many", moving(None, Some("older")), "validation_error"),
        ("link", moving(Some("older"), None), "edge_cycle"),
        ("link", moving(None, Some("row")), "edge_cycle"),
    ] {
        let failure = core.update_edge(id, &edit).unwrap_err();
        assert!(
            matches!(&failure, CoreError::Validation { code: refused, .. } if refused == code),
            "{id} {edit:?}: {failure:?}"
        );
    }
    let failure = core
        .create_edge(&EdgeDraft {
            from_id: "row".into(),
            to_id: "row".into(),
            edge_type: "references".into(),
            ..EdgeDraft::default()
        })
        .unwrap_err();
    assert!(
        matches!(&failure, CoreError::Validation { code, .. } if code == "edge_cycle"),
        "{failure:?}"
    );
    assert_eq!(core.queue().unwrap(), before, "a refused move was queued");
    let conn = core.conn().unwrap();
    let link = store::edge_by_id(&conn, "link").unwrap().unwrap();
    assert_eq!(
        (link.from_id.as_str(), link.to_id.as_str()),
        ("row", "older")
    );

    // The witness: the same edge moves where the server would take it.
    drop(conn);
    let moved = core
        .update_edge("link", &moving(Some("other"), None))
        .unwrap()
        .unwrap();
    assert_eq!(moved.body["from_id"], "other");
}

#[test]
fn an_edge_move_naming_the_end_that_stays_as_it_is_moves_the_other_one() {
    let core = movable_link();
    let edit = core
        .update_edge("link", &moving(Some("row"), Some("other")))
        .unwrap()
        .unwrap();
    assert_eq!(edit.body.get("from_id"), None, "{}", edit.body);
    assert_eq!(edit.body["to_id"], "other");
    let conn = core.conn().unwrap();
    let link = store::edge_by_id(&conn, "link").unwrap().unwrap();
    assert_eq!(
        (link.from_id.as_str(), link.to_id.as_str()),
        ("row", "other")
    );
}

#[test]
fn an_edge_edit_that_changes_nothing_queues_nothing() {
    let core = movable_link();
    let before = core.queue().unwrap();
    for (what, edit) in [
        ("a move to the source it holds", moving(Some("row"), None)),
        ("a move to the target it holds", moving(None, Some("older"))),
        (
            "a move to both ends it holds",
            moving(Some("row"), Some("older")),
        ),
        ("no property and no move", moving(None, None)),
    ] {
        let queued = core.update_edge("link", &edit).unwrap();
        assert_eq!(queued, None, "{what} was queued");
    }
    assert_eq!(core.queue().unwrap(), before, "a no-op edit was queued");
    let conn = core.conn().unwrap();
    assert_eq!(
        store::beneath_edge(&conn, "link").unwrap(),
        None,
        "a no-op edit held the edge beneath a write that does not exist"
    );
    drop(conn);

    // The witness: the same edge, edited to something, is queued.
    let moved = core
        .update_edge("link", &moving(Some("other"), None))
        .unwrap();
    assert!(moved.is_some(), "an edit that moves an end was not queued");
}

#[test]
fn a_no_op_edge_edit_is_still_refused_where_it_names_no_version_or_a_stale_one() {
    let core = movable_link();
    let unversioned = EdgeEdit {
        base_version: None,
        ..moving(Some("row"), None)
    };
    let stale = EdgeEdit {
        base_version: Some(7),
        ..moving(Some("row"), None)
    };
    for edit in [unversioned, stale] {
        let failure = core.update_edge("link", &edit).unwrap_err();
        assert!(matches!(failure, CoreError::Invalid(_)), "{failure:?}");
    }
    let failure = core.update_edge("absent", &moving(None, None)).unwrap_err();
    assert!(matches!(failure, CoreError::NotFound { .. }), "{failure:?}");
}

#[test]
fn an_edge_edit_naming_the_end_it_holds_and_a_property_sends_only_the_property() {
    let core = movable_link();
    let edit = EdgeEdit {
        properties: serde_json::json!({ "note": "mine" })
            .as_object()
            .unwrap()
            .clone(),
        ..moving(Some("row"), Some("older"))
    };
    let queued = core
        .update_edge("link", &edit)
        .unwrap()
        .expect("an edit that changes a property was not queued");
    assert_eq!(
        queued.body,
        serde_json::json!({ "properties": { "note": "mine" }, "version": 1 })
    );
}

#[test]
fn an_edge_move_waits_on_its_new_end_and_follows_that_create_to_its_answered_id() {
    let core = movable_link();
    let created = core
        .create_item(&Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "new" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap();
    let local = created.item_id.clone().unwrap();
    let moved = core
        .update_edge("link", &moving(Some(&local), None))
        .unwrap()
        .unwrap();
    assert_eq!(moved.depends_on, vec![created.id.clone()]);
    assert_eq!(
        core.edges_from(&local).unwrap().len(),
        1,
        "the move is not shown at once"
    );

    let conn = core.conn().unwrap();
    store::adopt_answered_id(&conn, &local, "answered").unwrap();
    let row = store::queued_write(&conn, &moved.id).unwrap().unwrap();
    let body = &row.body;
    assert_eq!(body["from_id"], "answered");
    assert_eq!(
        store::edge_by_id(&conn, "link").unwrap().unwrap().from_id,
        "answered"
    );
}

#[test]
fn an_edge_move_onto_a_create_that_lands_on_a_held_row_goes_to_that_row() {
    let core = movable_link();
    let created = core
        .create_item(&Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "new" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap();
    let local = created.item_id.clone().unwrap();
    let moved = core
        .update_edge("link", &moving(Some(&local), None))
        .unwrap()
        .unwrap();
    let conn = core.conn().unwrap();
    let refused = store::land_on_held_row(&conn, &created, "other").unwrap();
    assert!(refused.is_empty(), "{refused:?}");
    let row = store::queued_write(&conn, &moved.id).unwrap().unwrap();
    assert_eq!(row.verdict, None);
    assert!(row.depends_on.is_empty());
    let body = &row.body;
    assert_eq!(body["from_id"], "other");
}

#[test]
fn a_refused_edge_delete_never_brings_back_an_edge_moved_off_the_slice() {
    let core = held_copy();
    let unlinked = core.delete_edge("link").unwrap();
    moved_off_the_slice(&core);
    refuse(&core, &unlinked);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link").unwrap(),
        None,
        "a refused delete put back an edge whose source the copy does not hold"
    );
}

#[test]
fn a_refused_edge_edit_lets_go_of_an_edge_moved_off_the_slice() {
    let core = held_copy();
    let edited = core
        .update_edge(
            "link",
            &EdgeEdit {
                properties: serde_json::json!({ "note": "mine" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(1),
                ..EdgeEdit::default()
            },
        )
        .unwrap()
        .unwrap();
    moved_off_the_slice(&core);
    assert!(core.edges_from("elsewhere").unwrap().len() == 1);
    refuse(&core, &edited);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::edge_by_id(&conn, "link").unwrap(),
        None,
        "a refused edit left an edge whose source the copy does not hold"
    );
}
