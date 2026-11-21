//! A write whose answer was lost under one credential, drained under
//! another: the server keeps an idempotency key to the credential that sent
//! it, so the copy reads the subject before it sends the write again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use crate::model::{BlockedReason, ItemState, QueuedWrite, Verdict, WriteKind};
use crate::scripted::{self, Answer, Scripted, Seen, certified};
use crate::stop_tests::{copy_in_keyed, holding_a_catalog};
use crate::{Core, CoreError, store};

const EDITED: &str = "01a1f3ff-ea0f-7520-83bc-0e845f473eec";
const DELETED: &str = "01a1f3ff-ea14-70b6-af77-45cf0d28ecae";
const LINK: &str = "01a1f3ff-ea18-7c2e-9d1b-6f0a3b2c4d5e";
const NAMESPACE: &str = "app.notes";
const AT: &str = "2026-01-01T00:00:00Z";
const WAIT: Duration = Duration::from_secs(2);

fn path(id: &str) -> String {
    format!("/items/{id}")
}

fn item(id: &str, title: &str, version: i64) -> serde_json::Value {
    let mut item = serde_json::from_str::<serde_json::Value>(&scripted::item_payload(
        "item.updated",
        id,
        "core.note",
        version,
    ))
    .unwrap()["item"]
        .clone();
    item["properties"] = serde_json::json!({ "title": title, "body": "" });
    item
}

/// The item as the server reads it at `version`, with `title`.
fn held(id: &str, title: &str, version: i64) -> Answer {
    held_as(id, title, version, "active", &[])
}

fn held_as(id: &str, title: &str, version: i64, state: &str, tags: &[&str]) -> Answer {
    let mut item = item(id, title, version);
    item["state"] = state.into();
    if state == "trashed" {
        item["trashed_at"] = AT.into();
    }
    let read = serde_json::json!({
        "item": item,
        "metadata": { "tags": tags },
        "listed": true,
    });
    certified(scripted::json(200, &read.to_string()))
}

/// The server answers a read by id `404` for an item in the bin, and finds
/// it in every state.
fn binned(server: &Scripted, id: &str) {
    let mut trashed = item(id, id, 2);
    trashed["state"] = "trashed".into();
    trashed["trashed_at"] = AT.into();
    let page = serde_json::json!({
        "data": [{ "item": trashed, "metadata": { "tags": [] }, "listed": true }],
        "next_cursor": null,
        "listed": true,
    });
    server.on_query(
        &path(id),
        "state=any",
        vec![held_as(id, id, 2, "trashed", &[])],
    );
    server.on(
        &path(id),
        vec![certified(scripted::refusal(404, "item_not_found"))],
    );
    server.on(
        "/items",
        vec![certified(scripted::json(200, &page.to_string()))],
    );
}

fn edge(version: i64, note: &str) -> Answer {
    let edge = serde_json::json!({
        "edge": {
            "id": LINK,
            "from_id": EDITED,
            "to_id": DELETED,
            "edge_type": "references",
            "properties": { "note": note },
            "version": version,
            "created_at": AT,
            "updated_at": AT,
        }
    });
    certified(scripted::json(200, &edge.to_string()))
}

fn extension(document: serde_json::Value) -> Answer {
    let read = serde_json::json!({ "namespace": NAMESPACE, "document": document });
    certified(scripted::json(200, &read.to_string()))
}

fn edit(core: &Core) -> QueuedWrite {
    core.update_item(
        EDITED,
        &crate::Edit {
            properties: serde_json::json!({ "title": "edited" })
                .as_object()
                .unwrap()
                .clone(),
            base_version: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
}

fn remove(core: &Core) -> QueuedWrite {
    core.delete_item(DELETED).unwrap()
}

fn trash(core: &Core) -> QueuedWrite {
    core.transition_item(EDITED, ItemState::Trashed).unwrap()
}

fn restore(core: &Core) -> QueuedWrite {
    let mut binned = store::testing::note(DELETED, DELETED, "", AT);
    binned.state = "trashed".into();
    binned.trashed_at = Some(AT.into());
    store::upsert_item(&core.conn().unwrap(), &binned, None, &Default::default()).unwrap();
    core.restore_item(DELETED).unwrap()
}

fn add_tag(core: &Core) -> QueuedWrite {
    core.add_tag(EDITED, "kept").unwrap()
}

fn remove_tag(core: &Core) -> QueuedWrite {
    core.remove_tag(EDITED, "gone").unwrap()
}

fn replace_tags(core: &Core) -> QueuedWrite {
    core.replace_tags(
        EDITED,
        &crate::model::TagsWrite {
            tags: vec!["first".into(), "second".into()],
        },
    )
    .unwrap()
}

fn write_extension(core: &Core) -> QueuedWrite {
    core.write_extension(EDITED, NAMESPACE, r#"{"pinned":true}"#, None)
        .unwrap()
}

fn delete_extension(core: &Core) -> QueuedWrite {
    core.delete_extension(EDITED, NAMESPACE, None).unwrap()
}

fn edit_edge(core: &Core) -> QueuedWrite {
    core.update_edge(
        LINK,
        &crate::model::EdgeEdit {
            properties: serde_json::json!({ "note": "edited" })
                .as_object()
                .unwrap()
                .clone(),
            base_version: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap()
}

fn delete_edge(core: &Core) -> QueuedWrite {
    core.delete_edge(LINK).unwrap()
}

/// Where `queued` is sent.
fn door(queued: &QueuedWrite) -> String {
    let item = || path(queued.item_id.as_deref().unwrap());
    match queued.kind {
        WriteKind::TransitionItem => format!("{}/transition", item()),
        WriteKind::RestoreItem => format!("{}/restore", item()),
        WriteKind::AddTag | WriteKind::ReplaceTags => format!("{}/tags", item()),
        WriteKind::RemoveTag => format!("{}/tags/{}", item(), queued.tag.as_deref().unwrap()),
        WriteKind::WriteExtension | WriteKind::DeleteExtension => {
            format!("{}/extensions/{NAMESPACE}", item())
        }
        WriteKind::UpdateEdge | WriteKind::DeleteEdge => format!("/edges/{LINK}"),
        _ => item(),
    }
}

/// Queues one write on a copy under the key `first`, and sends it with its
/// answer lost: a lost answer ends a drain, so each write has its own copy.
fn lost_under_first(
    server: &Scripted,
    dir: &std::path::Path,
    write: fn(&Core) -> QueuedWrite,
) -> QueuedWrite {
    let core = copy_in_keyed(server, dir, "first");
    holding_a_catalog(&core);
    {
        let conn = core.conn().unwrap();
        for id in [EDITED, DELETED] {
            let item = store::testing::note(id, id, "", AT);
            store::upsert_item(&conn, &item, Some(&["gone".into()]), &Default::default()).unwrap();
        }
        store::upsert_edge(
            &conn,
            &store::testing::wire_edge(LINK, EDITED, DELETED, "references"),
        )
        .unwrap();
    }
    let queued = write(&core);
    server.on(&door(&queued), vec![scripted::unnamed(502, "bad_gateway")]);
    let report = core.drain().unwrap();
    assert_eq!(report.undelivered, 1, "{report:?}");
    assert!(
        sent(&core, &queued.id),
        "the lost write was not kept as sent"
    );
    assert_eq!(
        sent_as(&core, &queued.id),
        Some(store::credential_digest("Bearer first"))
    );
    queued
}

fn sent(core: &Core, id: &str) -> bool {
    !store::unsent(&core.conn().unwrap(), id).unwrap()
}

fn sent_as(core: &Core, id: &str) -> Option<String> {
    store::sent_as(&core.conn().unwrap(), id).unwrap()
}

fn row_of(core: &Core, id: &str) -> QueuedWrite {
    core.queue()
        .unwrap()
        .into_iter()
        .find(|queued| queued.id == id)
        .unwrap()
}

fn verdict(core: &Core, id: &str) -> Option<Verdict> {
    row_of(core, id).verdict
}

fn under(server: &Scripted, path: &str, key: &str) -> Vec<Seen> {
    server
        .seen(path)
        .into_iter()
        .filter(|seen| seen.authorization.as_deref() == Some(&format!("Bearer {key}")))
        .collect()
}

/// Each request to `subject` under `key`, in order, as `"read"` or `"write"`.
fn asked_under(server: &Scripted, subject: &str, key: &str) -> Vec<&'static str> {
    under(server, subject, key)
        .into_iter()
        .map(|seen| {
            if seen.method == "GET" {
                "read"
            } else {
                "write"
            }
        })
        .collect()
}

fn writes_under(server: &Scripted, subject: &str, key: &str) -> Vec<Seen> {
    under(server, subject, key)
        .into_iter()
        .filter(|seen| seen.method != "GET")
        .collect()
}

#[test]
fn settles_an_edit_the_server_applied_under_another_key_from_its_read_without_sending_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), edit);

    server.on(&path(EDITED), vec![held(EDITED, "edited", 2)]);
    let core = copy_in_keyed(&server, dir.path(), "second");
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    // The second read is the read-back every write the server holds gets.
    assert_eq!(
        asked_under(&server, &path(EDITED), "second"),
        ["read", "read"],
        "an edit the server held went out again under the new key"
    );
    let row = core.get(EDITED).unwrap().unwrap();
    assert_eq!(
        (row.version, row.properties["title"].clone()),
        (2, "edited".into())
    );
}

#[test]
fn settles_a_delete_the_server_applied_under_another_key_from_its_read_without_sending_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), remove);

    binned(&server, DELETED);
    let core = copy_in_keyed(&server, dir.path(), "second");
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    assert!(
        under(&server, &path(DELETED), "second")[0]
            .query
            .contains("state=any"),
        "the read did not look in the bin"
    );
    assert_eq!(
        asked_under(&server, &path(DELETED), "second"),
        ["read", "read"],
        "a delete the server held went out again under the new key"
    );
    let rows = store::items_by_ids(&core.conn().unwrap(), &[DELETED.to_string()]).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.state).collect::<Vec<_>>(),
        [ItemState::Trashed]
    );
}

#[test]
fn sends_an_edit_and_a_delete_the_server_never_applied_again_under_the_new_key() {
    for (write, subject) in [
        (edit as fn(&Core) -> QueuedWrite, EDITED),
        (remove, DELETED),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), write);

        if subject == EDITED {
            server.on(
                &path(EDITED),
                vec![held(EDITED, EDITED, 1), held(EDITED, "edited", 2)],
            );
        } else {
            binned(&server, DELETED);
            server.on_query(&path(DELETED), "state=any", vec![held(DELETED, DELETED, 1)]);
            server.on(
                &path(DELETED),
                vec![
                    certified(scripted::json(200, "{\"ok\":true}")),
                    certified(scripted::refusal(404, "item_not_found")),
                ],
            );
        }
        let core = copy_in_keyed(&server, dir.path(), "second");
        let report = core.drain().unwrap();

        assert_eq!(report.undelivered, 0, "{subject}: {report:?}");
        assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
        // A write the server took is read back once it answers.
        assert_eq!(
            asked_under(&server, &path(subject), "second"),
            ["read", "write", "read"],
            "{subject}"
        );
        assert_eq!(
            sent_as(&core, &queued.id),
            Some(store::credential_digest("Bearer second"))
        );
    }
}

/// One kind of write, judged from a read of `read`: `holds` is what the
/// server answers where the lost send landed, `lacks` where it did not, and
/// `answer` the door's answer to the write sent again.
struct Judged {
    write: fn(&Core) -> QueuedWrite,
    read: String,
    holds: Answer,
    lacks: Answer,
    answer: Answer,
    /// The version the write sent again names, where its door takes one.
    names: Option<&'static str>,
}

/// Both items as the server holds them, for the read a settled write's
/// answer owes.
fn both_held(server: &Scripted) {
    for id in [EDITED, DELETED] {
        server.on(&path(id), vec![held(id, id, 1)]);
    }
}

fn every_kind() -> Vec<Judged> {
    let tags = |tags: &[&str]| held_as(EDITED, EDITED, 1, "active", tags);
    let plain = || certified(scripted::json(200, "{}"));
    vec![
        Judged {
            write: add_tag,
            read: path(EDITED),
            holds: tags(&["gone", "kept"]),
            lacks: tags(&["gone"]),
            answer: plain(),
            names: Some("version=1"),
        },
        Judged {
            write: remove_tag,
            read: path(EDITED),
            holds: tags(&[]),
            lacks: tags(&["gone"]),
            answer: plain(),
            names: Some("version=1"),
        },
        Judged {
            write: replace_tags,
            read: path(EDITED),
            holds: tags(&["first", "second"]),
            lacks: tags(&["first"]),
            answer: plain(),
            names: None,
        },
        Judged {
            write: write_extension,
            read: format!("{}/extensions/{NAMESPACE}", path(EDITED)),
            holds: extension(serde_json::json!({ "pinned": true })),
            lacks: extension(serde_json::Value::Null),
            answer: plain(),
            names: None,
        },
        Judged {
            write: delete_extension,
            read: format!("{}/extensions/{NAMESPACE}", path(EDITED)),
            holds: extension(serde_json::Value::Null),
            lacks: extension(serde_json::json!({ "pinned": true })),
            answer: plain(),
            names: None,
        },
        Judged {
            write: restore,
            read: path(DELETED),
            holds: held(DELETED, DELETED, 1),
            lacks: held_as(DELETED, DELETED, 1, "trashed", &[]),
            answer: held(DELETED, DELETED, 1),
            names: Some("version=1"),
        },
        Judged {
            write: trash,
            read: path(EDITED),
            holds: held_as(EDITED, EDITED, 1, "trashed", &[]),
            lacks: held(EDITED, EDITED, 1),
            answer: held_as(EDITED, EDITED, 1, "trashed", &[]),
            names: Some("version=1"),
        },
        Judged {
            write: edit_edge,
            read: format!("/edges/{LINK}"),
            holds: edge(2, "edited"),
            lacks: edge(1, ""),
            answer: edge(2, "edited"),
            names: None,
        },
    ]
}

#[test]
fn settles_each_kind_of_write_the_server_holds_under_another_key_without_sending_it() {
    for case in every_kind() {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), case.write);
        let kind = queued.kind;

        both_held(&server);
        if case.read == door(&queued) {
            server.on(&case.read, vec![case.holds]);
        } else {
            if kind == WriteKind::TransitionItem {
                binned(&server, EDITED);
            } else {
                server.on(&case.read, vec![case.holds.clone()]);
            }
            server.on_query(&case.read, "state=any", vec![case.holds]);
            // A state move the server made already, sent again, is refused.
            server.on(
                &door(&queued),
                vec![certified(scripted::refusal(409, "invalid_transition"))],
            );
        }
        let core = copy_in_keyed(&server, dir.path(), "second");
        let report = core.drain().unwrap();

        assert_eq!(
            verdict(&core, &queued.id),
            Some(Verdict::Accepted),
            "{kind}: {report:?}"
        );
        assert!(
            writes_under(&server, &door(&queued), "second").is_empty(),
            "{kind}: a write the server held went out again under the new key"
        );
    }
}

#[test]
fn sends_each_kind_of_write_the_server_lacks_again_naming_the_version_it_was_sent_at() {
    for case in every_kind() {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), case.write);
        let kind = queued.kind;

        both_held(&server);
        if case.read == door(&queued) {
            server.on(&case.read, vec![case.lacks, case.answer]);
        } else {
            server.on(&case.read, vec![case.lacks, case.holds]);
            server.on(&door(&queued), vec![case.answer]);
        }
        let core = copy_in_keyed(&server, dir.path(), "second");
        let report = core.drain().unwrap();

        assert_eq!(
            verdict(&core, &queued.id),
            Some(Verdict::Accepted),
            "{kind}: {report:?}"
        );
        let writes = writes_under(&server, &door(&queued), "second");
        assert_eq!(writes.len(), 1, "{kind}: the write did not go out again");
        let query = &writes[0].query;
        match case.names {
            Some(version) => assert!(query.contains(version), "{kind}: {query}"),
            None => assert!(!query.contains("version="), "{kind}: {query}"),
        }
    }
}

/// The edge delete's read answers `404` for an edge that is gone and for
/// one this credential may not read, and the item delete's for one gone or
/// of a type it may not read.
#[test]
fn a_removal_whose_subject_reads_as_absent_is_never_accepted_and_never_sent() {
    for write in [remove as fn(&Core) -> QueuedWrite, delete_edge, trash] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), write);
        let kind = queued.kind;
        let (read, code) = if kind == WriteKind::DeleteEdge {
            (format!("/edges/{LINK}"), "edge_not_found")
        } else {
            (path(queued.item_id.as_deref().unwrap()), "item_not_found")
        };
        server.on(&read, vec![certified(scripted::refusal(404, code))]);
        if read != door(&queued) {
            server.on(
                &door(&queued),
                vec![certified(scripted::json(200, "{\"ok\":true}"))],
            );
        }
        let core = copy_in_keyed(&server, dir.path(), "second");

        let report = core.drain().unwrap();
        assert_eq!(report.undelivered, 1, "{kind}: {report:?}");
        assert_eq!(verdict(&core, &queued.id), None, "{kind}");
        let left = row_of(&core, &queued.id);
        assert_eq!(
            left.last_failure
                .as_ref()
                .and_then(|failure| failure.status),
            Some(404),
            "{kind}"
        );
        assert_eq!(left.refusals, 1, "{kind}");
        for _ in 1..store::CEILING {
            core.drain().unwrap();
        }
        let dead = row_of(&core, &queued.id);
        assert_eq!(
            (
                dead.verdict,
                dead.last_failure.and_then(|failure| failure.status)
            ),
            (Some(Verdict::Dead), Some(404)),
            "{kind}"
        );
        assert!(
            writes_under(&server, &door(&queued), "second").is_empty(),
            "{kind}: a removal nothing could judge went out again"
        );

        // The witness: released, and drained under the credential that sent
        // it, it goes out again under its key.
        assert!(core.release(&queued.id).unwrap(), "{kind}");
        drop(core);
        let ok = || certified(scripted::json(200, "{\"ok\":true}"));
        match kind {
            WriteKind::DeleteEdge => {
                server.on(&read, vec![ok(), certified(scripted::refusal(404, code))])
            }
            WriteKind::DeleteItem => {
                binned(&server, DELETED);
                server.on(&read, vec![ok(), certified(scripted::refusal(404, code))]);
            }
            _ => {
                binned(&server, EDITED);
                server.on(
                    &door(&queued),
                    vec![held_as(EDITED, EDITED, 2, "trashed", &[])],
                );
            }
        }
        let core = copy_in_keyed(&server, dir.path(), "first");
        core.drain().unwrap();
        let again = writes_under(&server, &door(&queued), "first");
        assert_eq!(again.len(), 2, "{kind}");
        assert_eq!(again[0].idempotency_key, again[1].idempotency_key, "{kind}");
    }
}

#[test]
fn a_tag_sent_again_meets_a_conflict_where_its_item_moved_and_goes_unguarded_once_released() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), add_tag);

    server.on(
        &path(EDITED),
        vec![held_as(EDITED, "moved", 2, "active", &["gone"])],
    );
    server.on(
        &door(&queued),
        vec![
            certified(scripted::refusal(409, "version_conflict")),
            certified(scripted::json(200, "{}")),
        ],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    core.drain().unwrap();

    let blocked = row_of(&core, &queued.id);
    assert_eq!(
        (blocked.verdict, blocked.reason.as_deref()),
        (
            Some(Verdict::Blocked),
            Some(BlockedReason::ConflictUnresolved.as_str())
        )
    );
    assert!(core.release(&queued.id).unwrap());
    core.drain().unwrap();

    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    let writes = writes_under(&server, &door(&queued), "second");
    assert_eq!(writes.len(), 2);
    assert!(writes[0].query.contains("version=1"), "{}", writes[0].query);
    assert!(!writes[1].query.contains("version="), "{}", writes[1].query);
    assert_ne!(writes[0].idempotency_key, writes[1].idempotency_key);
}

#[test]
fn a_write_sent_again_names_the_same_version_on_every_later_send_under_its_key() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), add_tag);

    server.on(&path(EDITED), vec![held(EDITED, EDITED, 1)]);
    server.on(
        &door(&queued),
        vec![
            scripted::unnamed(502, "bad_gateway"),
            certified(scripted::json(200, "{}")),
        ],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    assert_eq!(core.drain().unwrap().undelivered, 1);
    core.drain().unwrap();

    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    let writes = writes_under(&server, &door(&queued), "second");
    assert_eq!(writes.len(), 2);
    for write in &writes {
        assert!(write.query.contains("version=1"), "{}", write.query);
    }
    assert_eq!(writes[0].idempotency_key, writes[1].idempotency_key);
}

#[test]
fn a_read_that_fails_leaves_the_write_owed_and_marks_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), edit);

    server.on(&path(EDITED), vec![scripted::unnamed(503, "unavailable")]);
    let core = copy_in_keyed(&server, dir.path(), "second");
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 1, "{report:?}");
    assert!(report.unavailable.is_some(), "{report:?}");
    assert_eq!(verdict(&core, &queued.id), None);
    assert!(sent(&core, &queued.id));
    assert_eq!(asked_under(&server, &path(EDITED), "second"), ["read"]);
    assert_eq!(
        sent_as(&core, &queued.id),
        Some(store::credential_digest("Bearer first")),
        "a write that never went out under the new key was marked as sent under it"
    );

    // The witness: once the read answers, the same drain settles it.
    server.on(&path(EDITED), vec![held(EDITED, "edited", 2)]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    assert_eq!(
        asked_under(&server, &path(EDITED), "second"),
        ["read", "read", "read"]
    );
}

#[test]
fn a_read_stopped_partway_leaves_the_write_owed_and_marks_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), remove);

    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        &path(DELETED),
        vec![Answer::WaitFor {
            ready: ready.clone(),
            answer: Box::new(certified(scripted::refusal(404, "item_not_found"))),
        }],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    let stop = Arc::new(AtomicBool::new(false));
    let (done, result) = mpsc::channel();
    {
        let (core, stop) = (core.clone(), stop.clone());
        std::thread::spawn(move || {
            let _ = done.send(core.drain_until(&stop));
        });
    }
    server.wait_for(&path(DELETED), 2, WAIT);
    stop.store(true, Ordering::Relaxed);
    let ended = result
        .recv_timeout(WAIT)
        .expect("a stopped drain waited on its read");
    assert_eq!(ended.unwrap_err(), CoreError::Canceled);
    ready.store(true, Ordering::Relaxed);

    assert_eq!(verdict(&core, &queued.id), None);
    assert!(sent(&core, &queued.id));
    assert_eq!(
        sent_as(&core, &queued.id),
        Some(store::credential_digest("Bearer first"))
    );
    assert_eq!(asked_under(&server, &path(DELETED), "second"), ["read"]);
}

#[test]
fn a_renewed_token_sends_a_lost_write_again_under_its_key_without_a_read() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "first");
    core.renew_credential_with(Box::new(|_| Ok("fresh".into())));
    holding_a_catalog(&core);
    {
        let conn = core.conn().unwrap();
        let item = store::testing::note(EDITED, EDITED, "", AT);
        store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
    }
    let queued = edit(&core);
    let replayed = |answer: Answer| match answer {
        Answer::Json {
            status,
            body,
            mut headers,
        } => {
            headers.push(("Idempotency-Replayed".into(), "true".into()));
            Answer::Json {
                status,
                body,
                headers,
            }
        }
        other => other,
    };
    server.on(
        &path(EDITED),
        vec![
            scripted::unnamed(502, "bad_gateway"),
            scripted::refusal(401, "unauthorized"),
            scripted::unnamed(502, "bad_gateway"),
            replayed(held(EDITED, "edited", 2)),
        ],
    );
    assert_eq!(core.drain().unwrap().undelivered, 1);
    // The token is renewed while the edit is sent again, and the answer is
    // lost once more.
    assert_eq!(core.drain().unwrap().undelivered, 1);
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    // The witness: the renewal happened, and the edit went out under it.
    // The read is the replayed answer's own, once the edit is taken.
    assert_eq!(
        asked_under(&server, &path(EDITED), "fresh"),
        ["write", "write", "read"],
        "a renewed token, the same credential, read the subject before sending"
    );
    let keys: std::collections::HashSet<_> = server
        .seen(&path(EDITED))
        .into_iter()
        .filter_map(|seen| seen.idempotency_key)
        .collect();
    assert_eq!(keys.len(), 1, "the edit went out under another key");
}

#[test]
fn discarding_or_withdrawing_a_write_sent_before_forgets_what_it_was_sent_with() {
    for discarded in [true, false] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), add_tag);

        server.on(&path(EDITED), vec![held(EDITED, EDITED, 1)]);
        server.on(
            &door(&queued),
            vec![certified(if discarded {
                scripted::refusal(422, "validation_error")
            } else {
                scripted::refusal(409, "version_conflict")
            })],
        );
        let core = copy_in_keyed(&server, dir.path(), "second");
        core.drain().unwrap();
        let kept = |core: &Core| {
            let conn = core.conn().unwrap();
            ["sent_as/", "sent_at_version/", "resent_at_version/"]
                .into_iter()
                .filter(|prefix| {
                    store::meta_get(&conn, &format!("{prefix}{}", queued.id))
                        .unwrap()
                        .is_some()
                })
                .collect::<Vec<_>>()
        };
        // The witness: the write kept what it was sent with until it left.
        assert!(kept(&core).contains(&"sent_as/"), "{discarded}");

        if discarded {
            assert_eq!(verdict(&core, &queued.id), Some(Verdict::Refused));
            assert!(core.discard(&queued.id).unwrap());
        } else {
            assert_eq!(verdict(&core, &queued.id), Some(Verdict::Blocked));
            assert!(!core.withdraw(&queued.id).unwrap().is_empty());
        }
        assert!(kept(&core).is_empty(), "{discarded}: {:?}", kept(&core));
    }
}

/// The server's item for a create by the natural key `ext-1`, stamped with
/// the source of the key `first`.
fn made_by_first(id: &str) -> serde_json::Value {
    let mut made = item(id, "made", 1);
    made["source"] = "first-source".into();
    made["source_id"] = "ext-1".into();
    made
}

/// Queues a create by the natural key `ext-1` naming no source on a copy
/// under the key `first`, whose source is `first-source`, and sends it with
/// its answer lost.
fn create_lost_under_first(server: &Scripted, dir: &std::path::Path) -> QueuedWrite {
    create_lost_under(
        server,
        dir,
        "first",
        certified(scripted::json(200, r#"{"source":"first-source"}"#)),
    )
}

/// As `create_lost_under_first`, under `key`, whose own source is what
/// `current` answers for `GET /keys/current`.
fn create_lost_under(
    server: &Scripted,
    dir: &std::path::Path,
    key: &str,
    current: Answer,
) -> QueuedWrite {
    let core = copy_in_keyed(server, dir, key);
    holding_a_catalog(&core);
    let queued = core
        .create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "made" })
                .as_object()
                .unwrap()
                .clone(),
            source_id: Some("ext-1".into()),
            ..Default::default()
        })
        .unwrap();
    server.on("/keys/current", vec![current]);
    server.on("/items", vec![scripted::unnamed(502, "bad_gateway")]);
    assert_eq!(core.drain().unwrap().undelivered, 1);
    queued
}

/// `GET /keys/current` refuses a credential that is not a key, such as a
/// signed-in app's token.
fn not_a_key() -> Answer {
    scripted::refusal(403, "forbidden")
}

/// Two tokens of one app share the source the server stamps their writes
/// with, so a create naming none goes again under the second and the
/// server merges it by its natural key.
#[test]
fn a_create_naming_no_source_goes_again_under_a_token_where_neither_source_is_known() {
    let made = "01a1f3ff-eadc-7476-9ca3-487fa3a2282b";
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = create_lost_under(&server, dir.path(), "first-token", not_a_key());

    let mut stamped = made_by_first(made);
    stamped["source"] = "app-source".into();
    server.on(
        "/items",
        vec![certified(scripted::json(
            200,
            &serde_json::json!({ "item": stamped }).to_string(),
        ))],
    );
    server.on(
        &path(made),
        vec![certified(scripted::json(
            200,
            &serde_json::json!({ "item": stamped, "metadata": { "tags": [] }, "listed": true })
                .to_string(),
        ))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second-token");
    server.on("/keys/current", vec![not_a_key()]);
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    assert_eq!(under(&server, "/items", "second-token").len(), 1);
    assert_eq!(
        crate::store::rows_under_key(&core.conn().unwrap(), "ext-1", None, None)
            .unwrap()
            .len(),
        1,
        "a second item was made under the natural key"
    );
}

/// Where only one of the source the create was stamped with and the
/// current credential's own is known, the two may differ.
#[test]
fn a_create_naming_no_source_is_held_where_only_one_source_is_known() {
    for (first, second) in [("first", "second-token"), ("first-token", "second")] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let first_current = |key: &str| {
            if key.ends_with("-token") {
                not_a_key()
            } else {
                certified(scripted::json(
                    200,
                    &serde_json::json!({ "source": format!("{key}-source") }).to_string(),
                ))
            }
        };
        let queued = create_lost_under(&server, dir.path(), first, first_current(first));

        found_by_key(&server, Vec::new());
        server.on(
            "/items",
            vec![certified(scripted::json(
                201,
                &serde_json::json!({ "item": made_by_first(LINK) }).to_string(),
            ))],
        );
        server.on(
            &path(LINK),
            vec![certified(scripted::json(
                200,
                &serde_json::json!({
                    "item": made_by_first(LINK), "metadata": { "tags": [] }, "listed": true,
                })
                .to_string(),
            ))],
        );
        let core = copy_in_keyed(&server, dir.path(), second);
        server.on("/keys/current", vec![first_current(second)]);
        let report = core.drain().unwrap();

        assert_eq!(
            under(&server, "/items", second).len(),
            0,
            "{first} to {second}: a second item was made"
        );
        assert_eq!(report.undelivered, 1, "{first} to {second}: {report:?}");
        let row = row_of(&core, &queued.id);
        assert_eq!(
            (row.verdict, row.refusals),
            (None, 1),
            "{first} to {second}"
        );
        assert!(sent(&core, &queued.id));
    }
}

/// A lookup is no conditional read, so its answer carries no reach.
fn found_by_key(server: &Scripted, found: Vec<serde_json::Value>) {
    server.on(
        "/items/lookup",
        vec![scripted::json(
            200,
            &serde_json::json!({ "data": found }).to_string(),
        )],
    );
}

#[test]
fn settles_a_create_by_natural_key_sent_under_another_key_from_a_lookup_of_the_key_it_was_stamped_with()
 {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = create_lost_under_first(&server, dir.path());

    let made = "01a1f3ff-eadc-7476-9ca3-487fa3a2282b";
    found_by_key(&server, vec![made_by_first(made)]);
    let read = serde_json::json!({
        "item": made_by_first(made),
        "metadata": { "tags": [] },
        "listed": true,
    });
    server.on(
        &path(made),
        vec![certified(scripted::json(200, &read.to_string()))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    server.on(
        "/keys/current",
        vec![certified(scripted::json(
            200,
            r#"{"source":"second-source"}"#,
        ))],
    );
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    let lookups = under(&server, "/items/lookup", "second");
    assert_eq!(lookups.len(), 1);
    let asked: serde_json::Value = serde_json::from_slice(&lookups[0].body).unwrap();
    assert_eq!(
        asked["source"], "first-source",
        "the lookup did not ask for the source the create was stamped with"
    );
    assert_eq!(authorizations(&server, "/items"), vec!["Bearer first"]);
    assert!(core.get(made).unwrap().is_some());
}

/// Sent again naming no source, a create the server does not hold is
/// stamped with the new key's source, so under a key of another source it
/// would make a second item under the same natural key.
#[test]
fn a_create_naming_no_source_goes_again_only_under_a_key_of_the_source_it_was_stamped_with() {
    let made = "01a1f3ff-eadc-7476-9ca3-487fa3a2282b";
    for (source, sent_again) in [("second-source", false), ("first-source", true)] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = create_lost_under_first(&server, dir.path());

        found_by_key(&server, Vec::new());
        server.on(
            "/items",
            vec![certified(scripted::json(
                201,
                &serde_json::json!({ "item": made_by_first(made) }).to_string(),
            ))],
        );
        server.on(
            &path(made),
            vec![certified(scripted::json(
                200,
                &serde_json::json!({
                    "item": made_by_first(made), "metadata": { "tags": [] }, "listed": true,
                })
                .to_string(),
            ))],
        );
        let core = copy_in_keyed(&server, dir.path(), "second");
        server.on(
            "/keys/current",
            vec![certified(scripted::json(
                200,
                &serde_json::json!({ "source": source }).to_string(),
            ))],
        );
        let report = core.drain().unwrap();

        let creates = under(&server, "/items", "second").len();
        let row = row_of(&core, &queued.id);
        if sent_again {
            assert_eq!(creates, 1, "{source}: {report:?}");
            assert_eq!(row.verdict, Some(Verdict::Accepted), "{source}");
        } else {
            assert_eq!(creates, 0, "{source}: a second item was made");
            assert_eq!(report.undelivered, 1, "{source}: {report:?}");
            assert_eq!((row.verdict, row.refusals), (None, 1), "{source}");
            assert!(sent(&core, &queued.id), "{source}");
        }
    }
}

/// A create by natural key whose row the server holds with every property
/// sent, and without the edge or state the create names, or with them. An
/// edge the read does not show may be one this key may not read.
#[test]
fn a_create_by_natural_key_is_held_only_with_the_state_and_edges_it_names() {
    let made = "01a1f3ff-eadc-7476-9ca3-487fa3a2282b";
    for (holds, state, linked) in [
        (Some(true), "archived", true),
        (None, "archived", false),
        (Some(false), "active", true),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "first");
        holding_a_catalog(&core);
        {
            let conn = core.conn().unwrap();
            let target = store::testing::note(EDITED, EDITED, "", AT);
            store::upsert_item(&conn, &target, None, &Default::default()).unwrap();
        }
        let queued = core
            .create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "made" })
                    .as_object()
                    .unwrap()
                    .clone(),
                source: Some("first-source".into()),
                source_id: Some("ext-1".into()),
                state: Some(ItemState::Archived),
                edges: [("references".to_string(), vec![EDITED.to_string()])].into(),
                ..Default::default()
            })
            .unwrap();
        server.on("/items", vec![scripted::unnamed(502, "bad_gateway")]);
        assert_eq!(core.drain().unwrap().undelivered, 1);
        drop(core);

        let mut found = made_by_first(made);
        found["state"] = state.into();
        found_by_key(&server, vec![found.clone()]);
        let mut whole = found.clone();
        whole["edges"] = serde_json::json!({
            "references": {
                "data": if linked {
                    vec![serde_json::json!({
                        "id": LINK, "from_id": made, "to_id": EDITED,
                        "edge_type": "references", "properties": {}, "version": 1,
                        "created_at": AT, "updated_at": AT,
                    })]
                } else {
                    Vec::new()
                },
                "next_cursor": null,
            }
        });
        let read = serde_json::json!({
            "item": whole,
            "metadata": { "tags": [] },
            "listed": true,
        });
        server.on(
            &path(made),
            vec![certified(scripted::json(200, &read.to_string()))],
        );
        server.on(
            "/items",
            vec![certified(scripted::json(
                200,
                &serde_json::json!({ "item": whole }).to_string(),
            ))],
        );
        let core = copy_in_keyed(&server, dir.path(), "second");
        let report = core.drain().unwrap();

        let row = row_of(&core, &queued.id);
        assert_eq!(
            (row.verdict, row.refusals),
            match holds {
                Some(_) => (Some(Verdict::Accepted), 0),
                None => (None, 1),
            },
            "{state} {linked}: {report:?}"
        );
        let creates = under(&server, "/items", "second").len();
        assert_eq!(
            creates,
            usize::from(holds == Some(false)),
            "{state} {linked}: whether the create went out again"
        );
    }
}

fn link_to(id: &str, from: &str, to: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "from_id": from, "to_id": to, "edge_type": "references",
        "properties": {}, "version": 1, "created_at": AT, "updated_at": AT,
    })
}

/// An edge type holding more targets than one block of an item read
/// carries is read to its end through the listing that continues it.
#[test]
fn a_create_whose_edge_type_holds_more_than_a_block_is_judged_from_every_page() {
    let made = "01a1f3ff-eadc-7476-9ca3-487fa3a2282b";
    let targets: Vec<String> = (1..=51)
        .map(|n| format!("01a1f3ff-eb00-7000-8000-{n:012}"))
        .collect();
    let stranger = "01a1f3ff-eb00-7000-8000-999999999999";
    for (holds, last) in [(true, targets[50].as_str()), (false, stranger)] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "first");
        holding_a_catalog(&core);
        {
            let conn = core.conn().unwrap();
            for target in &targets {
                let note = store::testing::note(target, target, "", AT);
                store::upsert_item(&conn, &note, None, &Default::default()).unwrap();
            }
        }
        let queued = core
            .create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "made" })
                    .as_object()
                    .unwrap()
                    .clone(),
                source: Some("first-source".into()),
                source_id: Some("ext-1".into()),
                edges: [("references".to_string(), targets.clone())].into(),
                ..Default::default()
            })
            .unwrap();
        server.on("/items", vec![scripted::unnamed(502, "bad_gateway")]);
        assert_eq!(core.drain().unwrap().undelivered, 1);
        drop(core);

        found_by_key(&server, vec![made_by_first(made)]);
        let link = |n: usize| format!("01a1f3ff-ec00-7000-8000-{n:012}");
        let mut whole = made_by_first(made);
        whole["edges"] = serde_json::json!({
            "references": {
                "data": targets[..50]
                    .iter()
                    .enumerate()
                    .map(|(n, to)| link_to(&link(n), made, to))
                    .collect::<Vec<_>>(),
                "next_cursor": "more",
            }
        });
        let read = serde_json::json!({ "item": whole, "metadata": { "tags": [] }, "listed": true });
        server.on(
            &path(made),
            vec![certified(scripted::json(200, &read.to_string()))],
        );
        server.on_query(
            &format!("{}/edges", path(made)),
            "cursor=more",
            vec![certified(scripted::json(
                200,
                &serde_json::json!({ "data": [link_to(&link(50), made, last)], "next_cursor": null })
                    .to_string(),
            ))],
        );
        server.on(
            "/items",
            vec![certified(scripted::json(
                200,
                &serde_json::json!({ "item": whole }).to_string(),
            ))],
        );
        let core = copy_in_keyed(&server, dir.path(), "second");
        let report = core.drain().unwrap();

        assert_eq!(
            verdict(&core, &queued.id),
            Some(Verdict::Accepted),
            "{holds}: {report:?}"
        );
        assert_eq!(
            under(&server, "/items", "second").len(),
            if holds { 0 } else { 1 },
            "{holds}: whether the create went out again"
        );
        assert!(
            under(&server, &format!("{}/edges", path(made)), "second")
                .iter()
                .any(|seen| seen.query.contains("cursor=more")),
            "{holds}: the listing the block continues was not read"
        );
    }
}

/// A release that mints a fresh key forgets the version the write was
/// first sent at, so under a third credential it goes unguarded, as released.
#[test]
fn a_write_released_with_a_fresh_key_is_not_blocked_again_under_a_third_key() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), add_tag);

    server.on(
        &path(EDITED),
        vec![held_as(EDITED, "moved", 2, "active", &["gone"])],
    );
    server.on(
        &door(&queued),
        vec![certified(scripted::refusal(409, "version_conflict"))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    core.drain().unwrap();
    assert_eq!(
        row_of(&core, &queued.id).reason.as_deref(),
        Some(BlockedReason::ConflictUnresolved.as_str())
    );
    assert!(core.release(&queued.id).unwrap());
    drop(core);

    server.on(&door(&queued), vec![certified(scripted::json(200, "{}"))]);
    let core = copy_in_keyed(&server, dir.path(), "third");
    let report = core.drain().unwrap();

    assert_eq!(
        verdict(&core, &queued.id),
        Some(Verdict::Accepted),
        "{report:?}"
    );
    let writes = writes_under(&server, &door(&queued), "third");
    assert_eq!(writes.len(), 1);
    assert!(!writes[0].query.contains("version="), "{}", writes[0].query);
}

/// A create by natural key on a row the copy held when it was first sent
/// merges into that row, and sent again names the version it held.
#[test]
fn a_create_merged_into_a_held_row_names_the_version_it_was_first_sent_at() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "first");
    holding_a_catalog(&core);
    let mut row = made_by_first(EDITED);
    row["version"] = 3.into();
    {
        let conn = core.conn().unwrap();
        let held: crate::wire::WireItem = serde_json::from_value(row.clone()).unwrap();
        store::upsert_item(&conn, &held, None, &Default::default()).unwrap();
    }
    let queued = core
        .create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "merged" })
                .as_object()
                .unwrap()
                .clone(),
            source: Some("first-source".into()),
            source_id: Some("ext-1".into()),
            ..Default::default()
        })
        .unwrap();
    server.on("/items", vec![scripted::unnamed(502, "bad_gateway")]);
    assert_eq!(core.drain().unwrap().undelivered, 1);
    let first = under(&server, "/items", "first");
    let sent: serde_json::Value = serde_json::from_slice(&first[0].body).unwrap();
    assert!(sent.get("version").is_none(), "{sent}");
    drop(core);

    found_by_key(&server, vec![row.clone()]);
    let mut merged = row.clone();
    merged["properties"]["title"] = "merged".into();
    merged["version"] = 4.into();
    server.on(
        "/items",
        vec![certified(scripted::json(
            200,
            &serde_json::json!({ "item": merged }).to_string(),
        ))],
    );
    server.on(
        &path(EDITED),
        vec![certified(scripted::json(
            200,
            &serde_json::json!({ "item": merged, "metadata": { "tags": [] }, "listed": true })
                .to_string(),
        ))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    core.drain().unwrap();

    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    let again = under(&server, "/items", "second");
    assert_eq!(again.len(), 1);
    let sent: serde_json::Value = serde_json::from_slice(&again[0].body).unwrap();
    assert_eq!(sent["version"], 3, "{sent}");
}

fn authorizations(server: &Scripted, path: &str) -> Vec<String> {
    server
        .seen(path)
        .into_iter()
        .filter_map(|seen| seen.authorization)
        .collect()
}

#[test]
fn judges_a_write_sent_under_another_key_on_the_drain_s_one_confirmation_of_the_instance() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = lost_under_first(&server, dir.path(), edit);
    let before = server.seen("/").len();

    server.on(&path(EDITED), vec![held(EDITED, "edited", 2)]);
    let core = copy_in_keyed(&server, dir.path(), "second");
    core.drain().unwrap();

    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
    assert_eq!(
        asked_under(&server, &path(EDITED), "second"),
        ["read", "read"]
    );
    assert_eq!(
        server.seen("/").len() - before,
        1,
        "the judging read confirmed the instance apart from the drain: {:?}",
        server.paths()
    );
}

#[test]
fn a_judging_read_renewed_partway_sends_no_item_id_to_another_instance_at_the_address() {
    const OTHER: &str = "00000000-0000-7000-8000-0000000000fe";
    for replaced in [false, true] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let queued = lost_under_first(&server, dir.path(), edit);

        server.on(
            &path(EDITED),
            vec![
                scripted::refusal(401, "unauthorized"),
                held(EDITED, "edited", 2),
            ],
        );
        let second = if replaced { OTHER } else { scripted::INSTANCE };
        server.on(
            "/",
            vec![scripted::root(scripted::INSTANCE), scripted::root(second)],
        );
        let core = copy_in_keyed(&server, dir.path(), "second");
        core.renew_credential_with(Box::new(|_| Ok("fresh".into())));
        let drained = core.drain();

        if !replaced {
            // The witness: the read goes on under the renewed credential.
            assert_eq!(drained.unwrap().undelivered, 0);
            assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
            assert_eq!(asked_under(&server, &path(EDITED), "fresh")[0], "read");
            continue;
        }
        match drained {
            Err(CoreError::CopyExpired { reason, .. }) => {
                assert_eq!(reason, crate::http::INSTANCE_CHANGED);
            }
            other => panic!("a judge that met another instance ended {other:?}"),
        }
        assert!(
            under(&server, &path(EDITED), "fresh").is_empty(),
            "the item id reached the instance that replaced the copy's own"
        );
        assert!(writes_under(&server, &path(EDITED), "second").is_empty());
        // Held for the instance now at the address, which has seen no attempt.
        assert!(!sent(&core, &queued.id));
        assert_eq!(verdict(&core, &queued.id), None);
    }
}

const NAMED: &str = "01a1f3ff-eae0-7c1d-8f2b-3a4c5d6e7f80";

/// The server's item for a create naming the id `NAMED` and the natural key
/// `ext-1` under the source `claimed`, at `version`, with `title`.
fn named_item(title: &str, version: i64) -> serde_json::Value {
    let mut made = item(NAMED, title, version);
    made["source"] = "claimed".into();
    made["source_id"] = "ext-1".into();
    made
}

fn named_read(item: serde_json::Value) -> Answer {
    certified(scripted::json(
        200,
        &serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true })
            .to_string(),
    ))
}

/// Queues a create naming its id, a source and a natural key on a copy under
/// the key `first`, with an edit of it behind, and sends the create with its
/// answer lost.
fn named_create_lost_under_first(
    server: &Scripted,
    dir: &std::path::Path,
) -> (QueuedWrite, QueuedWrite) {
    let core = copy_in_keyed(server, dir, "first");
    holding_a_catalog(&core);
    let queued = core
        .create_item(&crate::Draft {
            r#type: "core.note".into(),
            id: Some(NAMED.into()),
            properties: serde_json::json!({ "title": "made" })
                .as_object()
                .unwrap()
                .clone(),
            source: Some("claimed".into()),
            source_id: Some("ext-1".into()),
            ..Default::default()
        })
        .unwrap();
    let later = core
        .update_item(
            NAMED,
            &crate::Edit {
                properties: serde_json::json!({ "body": "later" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
    server.on(
        "/keys/current",
        vec![certified(scripted::json(
            200,
            r#"{"source":"first-source"}"#,
        ))],
    );
    server.on("/items", vec![scripted::unnamed(502, "bad_gateway")]);
    core.drain().unwrap();
    assert!(
        sent(&core, &queued.id),
        "the lost create was not kept as sent"
    );
    assert!(!sent(&core, &later.id));
    let first = under(server, "/items", "first");
    let sent: serde_json::Value = serde_json::from_slice(&first[0].body).unwrap();
    assert_eq!(
        (&sent["id"], &sent["source_id"]),
        (&NAMED.into(), &"ext-1".into())
    );
    (queued, later)
}

/// Sent again under another key, a create naming its id and a natural key is
/// a natural-key upsert, which would replace an edit made since it landed.
#[test]
fn a_create_naming_its_id_and_natural_key_is_settled_from_its_item_without_replacing_a_later_edit()
{
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (queued, later) = named_create_lost_under_first(&server, dir.path());

    server.on_query(
        &path(NAMED),
        "state=any",
        vec![named_read(named_item("edited elsewhere", 2))],
    );
    let mut answered = named_item("edited elsewhere", 3);
    answered["properties"]["body"] = "later".into();
    server.on(&path(NAMED), vec![named_read(answered)]);
    server.on(
        "/items",
        vec![certified(scripted::json(
            200,
            &serde_json::json!({ "item": named_item("made", 3) }).to_string(),
        ))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    server.on(
        "/keys/current",
        vec![certified(scripted::json(200, r#"{"source":"claimed"}"#))],
    );
    let report = core.drain().unwrap();

    assert!(
        under(&server, "/items", "second").is_empty(),
        "the create went again and would replace the later edit"
    );
    assert_eq!(asked_under(&server, &path(NAMED), "second")[0], "read");
    assert_eq!(
        verdict(&core, &queued.id),
        Some(Verdict::Accepted),
        "{report:?}"
    );
    let edits = writes_under(&server, &path(NAMED), "second");
    assert_eq!(edits.len(), 1, "{report:?}");
    let sent: serde_json::Value = serde_json::from_slice(&edits[0].body).unwrap();
    assert_eq!(
        sent["version"], 1,
        "the later edit was not sent on the version the create made"
    );
    assert_eq!(verdict(&core, &later.id), Some(Verdict::Accepted));
}

/// The witness: a create the server holds nothing of at its id goes again,
/// once, under the new key.
#[test]
fn a_create_naming_its_id_and_natural_key_that_never_landed_goes_again_under_another_key() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (queued, _) = named_create_lost_under_first(&server, dir.path());

    server.on_query(
        &path(NAMED),
        "state=any",
        vec![certified(scripted::refusal(404, "item_not_found"))],
    );
    server.on(&path(NAMED), vec![named_read(named_item("made", 1))]);
    server.on(
        "/items",
        vec![certified(scripted::json(
            201,
            &serde_json::json!({ "item": named_item("made", 1) }).to_string(),
        ))],
    );
    let core = copy_in_keyed(&server, dir.path(), "second");
    server.on(
        "/keys/current",
        vec![certified(scripted::json(200, r#"{"source":"claimed"}"#))],
    );
    let report = core.drain().unwrap();

    assert_eq!(under(&server, "/items", "second").len(), 1, "{report:?}");
    assert_eq!(verdict(&core, &queued.id), Some(Verdict::Accepted));
}
