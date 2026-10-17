//! The tier a keyed create naming none is sent with, decided by a lookup of
//! its natural key before its first send.

use std::path::Path;

use serde_json::{Value, json};

use crate::scripted::{self, Scripted};
use crate::{Core, Draft, QueuedWrite, Server, Tier, store};

fn open(server: &Scripted, dir: &Path) -> Core {
    Core::open(
        dir.join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap()
}

/// A copy of the library holding `core.note`, which holds no row under any
/// natural key, and whose server answers every create unavailable, so a
/// create stays sent and unanswered under the body it went with.
pub(crate) fn library_copy(server: &Scripted, dir: &Path) -> Core {
    let core = open(server, dir);
    {
        let conn = core.conn().unwrap();
        store::replace_types(
            &conn,
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::read_view::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    server.on("/items", vec![scripted::refusal(503, "unavailable")]);
    core
}

pub(crate) fn keyed(source_id: &str, tier: Option<Tier>) -> Draft {
    Draft {
        r#type: "core.note".into(),
        properties: json!({ "title": "Synced", "body": "again" })
            .as_object()
            .unwrap()
            .clone(),
        source: Some("reader".into()),
        source_id: Some(source_id.into()),
        tier,
        ..Default::default()
    }
}

/// What `POST /items/lookup` answers where the server holds `held`, each a
/// row at the feed under the source `reader`.
pub(crate) fn found(held: &[&str]) -> scripted::Answer {
    let data: Vec<Value> = held
        .iter()
        .enumerate()
        .map(|(at, source_id)| {
            json!({
                "id": format!("01a00000-0000-7000-8000-00000000000{at}"),
                "type": "core.note",
                "state": "active",
                "tier": "feed",
                "version": 2,
                "source": "reader",
                "source_id": source_id,
                "properties": { "title": "Moved" },
            })
        })
        .collect();
    scripted::json(200, &json!({ "data": data, "tombstones": [] }).to_string())
}

fn bodies(server: &Scripted, path: &str) -> Vec<Value> {
    server
        .seen(path)
        .iter()
        .map(|seen| serde_json::from_slice(&seen.body).unwrap())
        .collect()
}

fn shown_tier(core: &Core, write: &QueuedWrite) -> Option<Tier> {
    core.get(write.item_id.as_deref().unwrap())
        .unwrap()
        .unwrap()
        .tier
}

#[test]
fn a_keyed_create_whose_key_names_a_server_row_goes_with_no_tier_decided_once() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let queued = {
        let core = library_copy(&server, dir.path());
        core.create_item(&keyed("article-1", None)).unwrap()
    };
    // The choice outlives the process that queued the create.
    let core = open(&server, dir.path());
    assert_eq!(shown_tier(&core, &queued), Some(Tier::Library));
    server.on(
        "/items/lookup",
        // Asked again, the server would say it holds no such row.
        vec![found(&["article-1"]), found(&[])],
    );

    let report = core.drain().unwrap();
    assert_eq!(report.undelivered, 1, "{report:?}");
    assert_eq!(
        bodies(&server, "/items/lookup"),
        [json!({ "type": "core.note", "source": "reader", "source_ids": ["article-1"] })]
    );
    let sent = bodies(&server, "/items");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].get("tier"),
        None,
        "a re-save from a copy of the library moved a row the server holds at the feed"
    );
    assert_eq!(sent[0]["source_id"], "article-1");
    assert_eq!(
        shown_tier(&core, &queued),
        Some(Tier::Library),
        "the copy showed the row elsewhere before any answer"
    );

    // Sent again under its key, the body is the one first sent, whatever a
    // lookup would answer now.
    core.drain().unwrap();
    assert_eq!(server.seen("/items/lookup").len(), 1);
    let sent = bodies(&server, "/items");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1], sent[0]);
}

#[test]
fn a_keyed_create_whose_key_names_no_server_row_goes_at_the_slices_tier() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let first = core.create_item(&keyed("article-2", None)).unwrap();
    let second = core.create_item(&keyed("article-3", None)).unwrap();
    server.on("/items/lookup", vec![found(&[])]);

    core.drain().unwrap();
    // One lookup asks for every waiting create of the type and source.
    assert_eq!(
        bodies(&server, "/items/lookup"),
        [json!({
            "type": "core.note",
            "source": "reader",
            "source_ids": ["article-2", "article-3"],
        })]
    );
    let sent = bodies(&server, "/items");
    assert_eq!(
        sent.len(),
        1,
        "the pass ends at the first unavailable answer"
    );
    assert_eq!(sent[0]["tier"], "library");
    assert_eq!(shown_tier(&core, &first), Some(Tier::Library));
    assert_eq!(shown_tier(&core, &second), Some(Tier::Library));
}

#[test]
fn a_lookup_the_server_cannot_answer_now_holds_the_create() {
    for answer in [
        scripted::refusal(503, "unavailable"),
        scripted::refusal(429, "rate_limited"),
        scripted::refusal(425, "too_early"),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = library_copy(&server, dir.path());
        core.create_item(&keyed("article-1", None)).unwrap();

        server.on("/items/lookup", vec![answer]);
        let report = core.drain().unwrap();
        let queued = core.queue().unwrap();
        assert!(
            store::unsent(&core.conn().unwrap(), &queued[0].id).unwrap(),
            "a create whose key could not be looked up was marked sent"
        );
        assert!(
            report
                .unavailable
                .as_deref()
                .is_some_and(|why| why.contains("natural key")),
            "{report:?}"
        );
        assert_eq!((report.answered, report.undelivered), (0, 1));
        assert!(
            bodies(&server, "/items").is_empty(),
            "a create went before its key was looked up"
        );
        // The witness: the next pass, answered, sends it.
        server.on("/items/lookup", vec![found(&["article-1"])]);
        core.drain().unwrap();
        let sent = bodies(&server, "/items");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].get("tier"), None);
    }
}

#[test]
fn a_lookup_refused_for_good_sends_the_create_with_no_tier() {
    for (answer, why) in [
        (scripted::refusal(403, "type_not_permitted"), "403"),
        (scripted::refusal(404, "not_found"), "404"),
        (scripted::refusal(400, "unknown_type"), "400 unknown_type"),
        (scripted::refusal(400, "validation_error"), "400"),
        (scripted::refusal(405, "method_not_allowed"), "405"),
        (scripted::refusal(413, "request_too_large"), "413"),
        (scripted::json(200, "{}"), "an answer it cannot read"),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = library_copy(&server, dir.path());
        core.create_item(&keyed("article-1", None)).unwrap();
        server.on("/items/lookup", vec![answer]);
        let report = core.drain().unwrap();
        let sent = bodies(&server, "/items");
        assert_eq!(sent.len(), 1, "{why}: {report:?}");
        assert_eq!(
            sent[0].get("tier"),
            None,
            "{why}: a lookup that could not say whether a row holds the key sent a tier that could move it"
        );
    }
}

#[test]
fn a_lookup_another_instance_refuses_expires_the_copy_and_sends_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let queued = core.create_item(&keyed("article-1", None)).unwrap();
    server.on(
        "/items/lookup",
        vec![scripted::refusal(409, crate::http::INSTANCE_CHANGED)],
    );
    assert_eq!(
        core.drain().unwrap_err(),
        crate::CoreError::CopyExpired {
            reason: crate::http::INSTANCE_CHANGED.into()
        }
    );
    assert_eq!(
        server.seen("/items/lookup")[0].instance.as_deref(),
        Some(scripted::INSTANCE)
    );
    assert!(bodies(&server, "/items").is_empty(), "the create was sent");
    let conn = core.conn().unwrap();
    assert!(
        crate::read_view::expired(&conn).unwrap(),
        "the drain told of another instance and left the copy current"
    );
    let row = crate::store::queued_write(&conn, &queued.id)
        .unwrap()
        .unwrap();
    assert_eq!((row.verdict, row.refusals), (None, 0));
}

#[test]
fn a_lookup_refused_for_several_keys_asks_again_in_halves_down_to_one() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    for key in ["article-a", "article-bad", "article-c"] {
        core.create_item(&keyed(key, None)).unwrap();
    }
    // Each create is counted and left unanswered, so the drain goes on to
    // the next.
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    server.on(
        "/items/lookup",
        vec![
            scripted::refusal(400, "validation_error"),
            found(&["article-a"]),
            scripted::refusal(413, "request_too_large"),
            scripted::refusal(400, "validation_error"),
            found(&[]),
        ],
    );
    core.drain().unwrap();
    let asked: Vec<Value> = bodies(&server, "/items/lookup")
        .into_iter()
        .map(|body| body["source_ids"].clone())
        .collect();
    assert_eq!(
        asked,
        [
            json!(["article-a", "article-bad", "article-c"]),
            json!(["article-a"]),
            json!(["article-bad", "article-c"]),
            json!(["article-bad"]),
            json!(["article-c"]),
        ]
    );
    let tiers: Vec<Option<Value>> = bodies(&server, "/items")
        .iter()
        .map(|body| body.get("tier").cloned())
        .collect();
    assert_eq!(
        tiers,
        [None, None, Some(json!("library"))],
        "one key refused decided the tier of the keys asked beside it"
    );
}

#[test]
fn a_lookup_is_sized_by_its_bytes_as_well_as_its_keys() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let long = |at: usize| format!("{at}-{}", "k".repeat(100_000));
    for at in 0..6 {
        core.create_item(&keyed(&long(at), None)).unwrap();
    }
    server.on("/items/lookup", vec![found(&[])]);
    core.drain().unwrap();
    let seen = server.seen("/items/lookup");
    let mut asked = Vec::new();
    for request in &seen {
        assert!(
            request.body.len() <= crate::http::LOOKUP_BODY_BYTES,
            "a lookup of {} bytes was sent",
            request.body.len()
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        for key in body["source_ids"].as_array().unwrap() {
            asked.push(key.as_str().unwrap().to_string());
        }
    }
    assert!(seen.len() > 1);
    assert_eq!(asked, (0..6).map(long).collect::<Vec<_>>());
}

#[test]
fn a_keyed_create_naming_no_source_is_looked_up_under_its_credentials_own() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let unsourced = |source_id: &str| Draft {
        source: None,
        ..keyed(source_id, None)
    };
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    let first = core.create_item(&unsourced("article-1")).unwrap();
    assert_eq!(
        store::chosen_tier(&core.conn().unwrap(), &first.id).unwrap(),
        Some(Tier::Library),
        "a create carrying a source_id and no source was not taken as keyed"
    );
    server.on(
        "/keys/current",
        vec![scripted::json(
            200,
            &json!({ "id": "key", "source": "reader" }).to_string(),
        )],
    );
    server.on("/items/lookup", vec![found(&["article-1"])]);
    core.drain().unwrap();
    assert_eq!(
        bodies(&server, "/items/lookup"),
        [json!({ "type": "core.note", "source": "reader", "source_ids": ["article-1"] })]
    );
    let sent = bodies(&server, "/items");
    assert_eq!(sent[0].get("tier"), None);
    assert_eq!(
        sent[0].get("source"),
        None,
        "the device named a source the caller did not"
    );

    // Learned once for the credential: the next create asks the lookup alone.
    core.create_item(&unsourced("article-2")).unwrap();
    server.on("/items/lookup", vec![found(&[])]);
    core.drain().unwrap();
    assert_eq!(server.seen("/keys/current").len(), 1);
    assert_eq!(bodies(&server, "/items/lookup")[1]["source"], "reader");

    // A row the copy holds under the learned source is the row the key names.
    {
        let conn = core.conn().unwrap();
        let mut held = store::testing::note("held", "server", "body", "2026-01-01T00:00:00Z");
        held.version = 2;
        held.tier = Some("feed".into());
        held.source = "reader".into();
        held.source_id = Some("held-1".into());
        store::put_server_item(&conn, &held, Some(&[]), &crate::catalog::Catalog::empty()).unwrap();
    }
    let resaved = core.create_item(&unsourced("held-1")).unwrap();
    assert_eq!(
        store::chosen_tier(&core.conn().unwrap(), &resaved.id).unwrap(),
        None
    );
    assert_eq!(shown_tier(&core, &resaved), Some(Tier::Feed));
}

#[test]
fn a_keyed_create_whose_source_cannot_be_learned_goes_with_no_tier() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    core.create_item(&Draft {
        source: None,
        ..keyed("article-1", None)
    })
    .unwrap();
    // A signed-in app's token, which that door refuses.
    server.on("/keys/current", vec![scripted::refusal(403, "forbidden")]);
    core.drain().unwrap();
    assert!(server.seen("/items/lookup").is_empty());
    let sent = bodies(&server, "/items");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].get("tier"), None);
}

#[test]
fn a_key_no_lookup_can_take_goes_with_no_tier_unasked() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    core.create_item(&keyed("", None)).unwrap();
    server.on("/items/lookup", vec![found(&[])]);
    core.drain().unwrap();
    assert!(server.seen("/items/lookup").is_empty());
    assert_eq!(bodies(&server, "/items")[0].get("tier"), None);
}

#[test]
fn only_a_keyed_create_whose_tier_the_slice_chose_is_looked_up() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    {
        let conn = core.conn().unwrap();
        let mut held = store::testing::note("held", "server", "body", "2026-01-01T00:00:00Z");
        held.version = 2;
        held.source = "reader".into();
        held.source_id = Some("held-1".into());
        store::put_server_item(&conn, &held, Some(&[]), &crate::catalog::Catalog::empty()).unwrap();
    }
    server.on("/items/lookup", vec![found(&[])]);
    // A tier named, a key naming a held row, and no key at all.
    core.create_item(&keyed("named-1", Some(Tier::Feed)))
        .unwrap();
    core.create_item(&keyed("held-1", None)).unwrap();
    core.create_item(&Draft {
        source_id: None,
        ..keyed("", None)
    })
    .unwrap();
    for write in core.queue().unwrap() {
        assert_eq!(
            store::chosen_tier(&core.conn().unwrap(), &write.id).unwrap(),
            None
        );
    }
    // The witness: a key the copy holds no row under is chosen a tier.
    let chosen = core.create_item(&keyed("article-1", None)).unwrap();
    assert_eq!(
        store::chosen_tier(&core.conn().unwrap(), &chosen.id).unwrap(),
        Some(Tier::Library)
    );
    // A create behind one still waiting under its key is asked about too, at
    // the tier that create goes with.
    for (source_id, tier) in [("article-1", Tier::Library), ("named-1", Tier::Feed)] {
        let again = core.create_item(&keyed(source_id, None)).unwrap();
        assert_eq!(
            store::chosen_tier(&core.conn().unwrap(), &again.id).unwrap(),
            Some(tier),
            "{source_id}"
        );
    }
}

#[test]
fn a_clearing_takes_a_chosen_tier_no_queued_write_names_and_keeps_the_rest() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let queued = core.create_item(&keyed("article-1", None)).unwrap();
    store::meta_set(&core.conn().unwrap(), "chosen_tier/gone", "library").unwrap();
    core.forget_answered().unwrap();
    let conn = core.conn().unwrap();
    assert_eq!(store::meta_get(&conn, "chosen_tier/gone").unwrap(), None);
    assert_eq!(
        store::chosen_tier(&conn, &queued.id).unwrap(),
        Some(Tier::Library)
    );
}

#[test]
fn a_lookup_refusing_the_credential_parks_the_queue_and_sends_nothing() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = library_copy(&server, dir.path());
    let queued = core.create_item(&keyed("article-1", None)).unwrap();
    server.on(
        "/items/lookup",
        vec![scripted::refusal(401, "unauthorized")],
    );
    let report = core.drain().unwrap();
    assert!(report.stopped.is_some(), "{report:?}");
    assert!(server.seen("/items").is_empty());
    let row = core.queue().unwrap().pop().unwrap();
    assert_eq!(row.verdict, Some(crate::Verdict::Blocked));
    assert_eq!(row.reason.as_deref(), Some("credential_refused"));
    // Released, it is decided again, since it never went.
    assert!(store::unsent(&core.conn().unwrap(), &queued.id).unwrap());
}

#[test]
fn a_source_learned_for_another_credential_is_not_taken_for_the_one_in_use() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    server.on(
        "/keys/current",
        vec![scripted::json(
            200,
            &json!({ "id": "key", "source": "reader" }).to_string(),
        )],
    );
    server.on("/items/lookup", vec![found(&[])]);
    let unsourced = |source_id: &str| Draft {
        source: None,
        ..keyed(source_id, None)
    };
    {
        let core = library_copy(&server, dir.path());
        core.create_item(&unsourced("article-1")).unwrap();
        core.drain().unwrap();
        let conn = core.conn().unwrap();
        let mut held = store::testing::note("held", "server", "body", "2026-01-01T00:00:00Z");
        held.version = 2;
        held.tier = Some("feed".into());
        held.source = "reader".into();
        held.source_id = Some("held-1".into());
        store::put_server_item(&conn, &held, Some(&[]), &crate::catalog::Catalog::empty()).unwrap();
    }
    // The same copy with another key, whose own source is not yet known.
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "another".into(),
        }),
    )
    .unwrap();
    let resaved = core.create_item(&unsourced("held-1")).unwrap();
    assert_eq!(
        store::chosen_tier(&core.conn().unwrap(), &resaved.id).unwrap(),
        Some(Tier::Library),
        "a create under a new credential was matched to a row under the old credential's source, so the drain will not decide its tier"
    );
    // The witness: under the credential it was learned for, the row is matched.
    drop(core);
    let core = open(&server, dir.path());
    let matched = core.create_item(&unsourced("held-1")).unwrap();
    assert_eq!(
        store::chosen_tier(&core.conn().unwrap(), &matched.id).unwrap(),
        None
    );
}
