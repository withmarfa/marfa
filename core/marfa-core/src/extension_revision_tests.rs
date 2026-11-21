//! An extension write guarded by the namespace's revision the caller read.

use crate::model::{BlockedReason, QueuedWrite, Verdict, WriteKind};
use crate::restored::Lost;
use crate::scripted::{self, Answer, Scripted, certified};
use crate::stop_tests::{copy_in_keyed, holding_a_catalog};
use crate::{Core, store};

const ITEM: &str = "01a1f3ff-ea0f-7520-83bc-0e845f473eec";
const NAMESPACE: &str = "app.notes";
const AT: &str = "2026-01-01T00:00:00Z";
const READ: &str = "9f2c41d07be35a68c1e04f9d2a7b8e16";

fn door() -> String {
    format!("/items/{ITEM}/extensions/{NAMESPACE}")
}

fn copy(server: &Scripted, dir: &std::path::Path) -> std::sync::Arc<Core> {
    let core = copy_in_keyed(server, dir, "key");
    holding_a_catalog(&core);
    let item = store::testing::note(ITEM, ITEM, "", AT);
    store::upsert_item(&core.conn().unwrap(), &item, None, &Default::default()).unwrap();
    let read = serde_json::json!({
        "item": serde_json::from_str::<serde_json::Value>(
            &scripted::item_payload("item.updated", ITEM, "core.note", 1),
        )
        .unwrap()["item"],
        "metadata": { "tags": [] },
        "listed": true,
    });
    server.on(
        &format!("/items/{ITEM}"),
        vec![certified(scripted::json(200, &read.to_string()))],
    );
    core
}

/// The server's refusal of a guarded write, with the namespace now.
fn conflict(document: serde_json::Value) -> Answer {
    let body = serde_json::json!({
        "error": { "code": "version_conflict", "message": "scripted" },
        "current": { "namespace": NAMESPACE, "document": document, "revision": "3e8b17c95d20fa46b7c1d03e9a5f2b84" },
    });
    certified(scripted::json(409, &body.to_string()))
}

fn taken() -> Answer {
    certified(scripted::json(200, r#"{"data":[]}"#))
}

fn row(core: &Core, id: &str) -> QueuedWrite {
    core.queue()
        .unwrap()
        .into_iter()
        .find(|queued| queued.id == id)
        .unwrap()
}

fn queries(server: &Scripted) -> Vec<String> {
    server
        .seen(&door())
        .into_iter()
        .filter(|seen| seen.method != "GET")
        .map(|seen| seen.query)
        .collect()
}

fn write(core: &Core, read: Option<&str>) -> QueuedWrite {
    core.write_extension(ITEM, NAMESPACE, r#"{"pinned":true}"#, read)
        .unwrap()
}

#[test]
fn keeps_the_revision_read_with_the_write_and_refuses_an_empty_one() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let guarded = write(&core, Some(READ));
    let removal = core
        .delete_extension(ITEM, NAMESPACE, Some("absent"))
        .unwrap();
    let unguarded = write(&core, None);
    let conn = core.conn().unwrap();
    assert_eq!(
        store::read_revision(&conn, &guarded.id).unwrap().as_deref(),
        Some(READ)
    );
    assert_eq!(
        store::read_revision(&conn, &removal.id).unwrap().as_deref(),
        Some("absent")
    );
    assert_eq!(store::read_revision(&conn, &unguarded.id).unwrap(), None);
    drop(conn);
    assert!(matches!(
        core.write_extension(ITEM, NAMESPACE, "{}", Some("")),
        Err(crate::CoreError::Invalid(_))
    ));
    assert_eq!(core.queue().unwrap().len(), 3, "an empty revision queued");
}

#[test]
fn names_the_revision_read_and_blocks_a_refusal_keeping_the_value_then_sends_unguarded_once_released()
 {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let queued = write(&core, Some(READ));
    server.on(
        &door(),
        vec![conflict(serde_json::json!({ "theirs": true })), taken()],
    );

    core.drain().unwrap();
    let blocked = row(&core, &queued.id);
    assert_eq!(blocked.verdict, Some(Verdict::Blocked));
    assert_eq!(
        blocked.blocked_reason(),
        Some(BlockedReason::ConflictUnresolved)
    );
    assert_eq!(blocked.body, serde_json::json!({ "pinned": true }));
    assert_eq!(queries(&server), [format!("read_revision={READ}")]);

    assert!(core.release(&queued.id).unwrap());
    assert_eq!(
        store::read_revision(&core.conn().unwrap(), &queued.id).unwrap(),
        None
    );
    core.drain().unwrap();
    let released = row(&core, &queued.id);
    assert_eq!(released.verdict, Some(Verdict::Accepted));
    assert_ne!(released.idempotency_key, queued.idempotency_key);
    assert_eq!(
        queries(&server)[1],
        "",
        "a released write still named the revision it read"
    );
}

#[test]
fn takes_a_resend_whose_refusal_shows_the_namespace_holds_what_it_leaves() {
    for (removes, holds, accepted) in [
        (false, serde_json::json!({ "pinned": true }), true),
        (true, serde_json::Value::Null, true),
        // The witnesses: a namespace holding something else is a conflict.
        (false, serde_json::json!({ "pinned": false }), false),
        (true, serde_json::json!({ "pinned": true }), false),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&server, dir.path());
        let queued = if removes {
            core.delete_extension(ITEM, NAMESPACE, Some(READ)).unwrap()
        } else {
            write(&core, Some(READ))
        };
        server.on(
            &door(),
            vec![
                scripted::unnamed(502, "bad_gateway"),
                conflict(holds.clone()),
            ],
        );
        core.drain().unwrap();
        assert_eq!(row(&core, &queued.id).verdict, None, "the answer was lost");

        core.drain().unwrap();
        let settled = row(&core, &queued.id);
        let case = format!("removes {removes}, holds {holds}");
        if accepted {
            assert_eq!(settled.verdict, Some(Verdict::Accepted), "{case}");
        } else {
            assert_eq!(settled.verdict, Some(Verdict::Blocked), "{case}");
            assert_eq!(
                settled.blocked_reason(),
                Some(BlockedReason::ConflictUnresolved),
                "{case}"
            );
        }
        let sent = server.seen(&door());
        assert_eq!(sent.len(), 2, "{case}");
        assert_eq!(sent[0].idempotency_key, sent[1].idempotency_key, "{case}");
        assert!(
            sent.iter()
                .all(|seen| seen.query == format!("read_revision={READ}")),
            "{case}"
        );
    }
}

#[test]
fn a_write_made_to_wait_on_a_create_a_restore_keeps_names_no_revision_read() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let queued = write(&core, Some(READ));
    let held = core.get(ITEM).unwrap().unwrap();
    {
        let mut conn = core.conn().unwrap();
        let tx = conn.transaction().unwrap();
        let catalog = crate::catalog::load(&tx).unwrap();
        crate::restored::keep(&tx, &catalog, Some(Lost::creating(vec![held]))).unwrap();
        tx.commit().unwrap();
    }

    let create = core
        .queue()
        .unwrap()
        .into_iter()
        .find(|write| write.kind == WriteKind::CreateItem)
        .unwrap();
    let waiting = row(&core, &queued.id);
    assert!(waiting.depends_on.contains(&create.id), "{waiting:?}");
    assert_eq!(
        store::read_revision(&core.conn().unwrap(), &queued.id).unwrap(),
        None,
        "a write over an item made again still names the revision read before the restore"
    );
}

#[test]
fn blocks_a_first_send_refused_even_where_the_namespace_holds_what_it_leaves() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let queued = write(&core, Some(READ));
    server.on(
        &door(),
        vec![conflict(serde_json::json!({ "pinned": true }))],
    );
    core.drain().unwrap();
    assert_eq!(
        row(&core, &queued.id).blocked_reason(),
        Some(BlockedReason::ConflictUnresolved)
    );
}
