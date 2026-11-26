//! An update a caller queues exact, which the server refuses once the item
//! has moved past the version the copy held.

use serde_json::{Value, json};

use crate::model::{BlockedReason, QueuedWrite, Verdict};
use crate::scripted::{self, Answer, Scripted, certified};
use crate::stop_tests::{copy_in_keyed, holding_a_catalog};
use crate::{Core, CoreError, Edit, Tier, store};

const ITEM: &str = "01a1f3ff-ea0f-7520-83bc-0e845f473eed";
const AT: &str = "2026-01-01T00:00:00Z";

fn door() -> String {
    format!("/items/{ITEM}")
}

fn server_item(version: i64, title: &str, tier: &str) -> Value {
    json!({
        "id": ITEM,
        "type": "core.note",
        "properties": { "title": title, "body": "" },
        "state": "active",
        "tier": tier,
        "version": version,
        "schema_version": 1,
        "source": "test",
        "occurred_at": AT,
        "created_at": AT,
        "updated_at": AT,
    })
}

/// A copy holding the item at version 1, in the library.
fn copy(server: &Scripted, dir: &std::path::Path) -> std::sync::Arc<Core> {
    let core = copy_in_keyed(server, dir, "key");
    holding_a_catalog(&core);
    let item = store::testing::note(ITEM, "mine", "", AT);
    store::put_server_item(
        &core.conn().unwrap(),
        &item,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    core
}

/// What the server answers an exact update after another writer moved the
/// item to version 2 (`versions/exact-envelope`).
fn moved() -> Answer {
    let body = json!({
        "error": { "code": "version_conflict", "message": "scripted" },
        "current": server_item(2, "theirs", "library"),
    });
    certified(scripted::json(409, &body.to_string()))
}

fn read_back() -> Answer {
    let read = json!({
        "item": server_item(2, "theirs", "library"),
        "metadata": { "tags": [] },
        "listed": true,
    });
    certified(scripted::json(200, &read.to_string()))
}

fn to_feed(exact: bool) -> Edit {
    Edit {
        base_version: Some(1),
        tier: Some(Tier::Feed),
        exact,
        ..Edit::default()
    }
}

fn row(core: &Core, id: &str) -> QueuedWrite {
    core.queue()
        .unwrap()
        .into_iter()
        .find(|queued| queued.id == id)
        .unwrap()
}

fn patches(server: &Scripted) -> Vec<(String, Value)> {
    server
        .seen(&door())
        .into_iter()
        .filter(|seen| seen.method == "PATCH")
        .map(|seen| (seen.query, serde_json::from_slice(&seen.body).unwrap()))
        .collect()
}

#[test]
fn a_moved_item_refuses_an_exact_tier_change_once_and_the_copy_shows_the_server() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let queued = core.update_item(ITEM, &to_feed(true)).unwrap();
    assert_eq!(
        core.get(ITEM).unwrap().unwrap().tier,
        Some(Tier::Feed),
        "the copy did not show the waiting move"
    );
    server.on(&door(), vec![moved(), read_back()]);

    core.drain().unwrap();
    let refused = row(&core, &queued.id);
    assert_eq!(refused.verdict, Some(Verdict::Refused), "{refused:?}");
    assert_eq!(refused.reason.as_deref(), Some("version_conflict"));
    let answer: Value = serde_json::from_str(refused.answer.as_deref().unwrap()).unwrap();
    assert_eq!(answer["current"]["version"], 2);
    let sent = patches(&server);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "conflict=auto");
    assert_eq!(
        sent[0].1,
        json!({ "properties": {}, "version": 1, "tier": "feed", "version_match": "exact" })
    );
    let shown = core.get(ITEM).unwrap().unwrap();
    assert_eq!(shown.tier, Some(Tier::Library));
    assert_eq!(shown.version, 2);
    assert_eq!(shown.properties["title"], "theirs");

    core.drain().unwrap();
    assert_eq!(
        patches(&server).len(),
        1,
        "a refused exact update went again"
    );
}

#[test]
fn the_same_answer_to_an_update_not_queued_exact_blocks_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let queued = core.update_item(ITEM, &to_feed(false)).unwrap();
    server.on(&door(), vec![moved(), read_back()]);

    core.drain().unwrap();
    let blocked = row(&core, &queued.id);
    assert_eq!(blocked.verdict, Some(Verdict::Blocked), "{blocked:?}");
    assert_eq!(
        blocked.blocked_reason(),
        Some(BlockedReason::ConflictUnresolved)
    );
    assert_eq!(patches(&server)[0].1.get("version_match"), None);
}

#[test]
fn an_exact_update_on_a_version_the_copy_has_moved_past_queues_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy(&server, dir.path());
    let mut newer = store::testing::note(ITEM, "theirs", "", AT);
    newer.version = 2;
    store::put_server_item(
        &core.conn().unwrap(),
        &newer,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    for exact in [true, false] {
        let refused = core.update_item_as_read(ITEM, &to_feed(exact));
        if exact {
            match refused {
                Err(CoreError::Validation {
                    code,
                    details,
                    server: None,
                    ..
                }) => {
                    assert_eq!(code, "version_conflict");
                    assert_eq!(
                        details.as_deref(),
                        Some(&json!({ "expected": 1, "actual": 2 }))
                    );
                }
                other => panic!("an exact update on version 1 was not refused: {other:?}"),
            }
            assert!(core.queue().unwrap().is_empty());
            assert_eq!(core.get(ITEM).unwrap().unwrap().tier, Some(Tier::Library));
        } else {
            // The witness: the same edit, said to be read, merges.
            refused.unwrap();
            assert_eq!(core.queue().unwrap().len(), 1);
        }
    }
    let exact = Edit {
        base_version: Some(2),
        ..to_feed(true)
    };
    core.update_item_as_read(ITEM, &exact).unwrap();
}

fn lay(core: &Core, version: i64) {
    let conn = core.conn().unwrap();
    let mut newer = store::testing::note(ITEM, "theirs", "", AT);
    newer.version = version;
    store::take_server_item(&conn, &newer, None, &marfa_rules::catalog::Catalog::empty()).unwrap();
}

#[test]
fn a_waiting_exact_update_shows_nothing_over_a_later_version_unless_this_devices_own_edit_waits_ahead()
 {
    for (exact, ahead, shown) in [
        (true, false, Tier::Library),
        // The witnesses: an update not queued exact is laid over the later
        // version, and one behind this device's own edit may land on the
        // version that edit makes.
        (false, false, Tier::Feed),
        (true, true, Tier::Feed),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy(&server, dir.path());
        if ahead {
            let retitle = Edit {
                base_version: Some(1),
                properties: json!({ "title": "renamed" }).as_object().unwrap().clone(),
                ..Edit::default()
            };
            core.update_item(ITEM, &retitle).unwrap();
        }
        core.update_item(ITEM, &to_feed(exact)).unwrap();
        lay(&core, 1);
        assert_eq!(core.get(ITEM).unwrap().unwrap().tier, Some(Tier::Feed));
        lay(&core, 2);
        assert_eq!(
            core.get(ITEM).unwrap().unwrap().tier,
            Some(shown),
            "exact {exact}, behind its own edit {ahead}"
        );
    }
}
