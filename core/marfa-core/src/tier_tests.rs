//! The tier a keyed create naming none is sent with, decided by a lookup of
//! its natural key before its first send.

use std::path::Path;

use serde_json::{Value, json};

use crate::scripted::{self, Scripted};
use crate::{Core, Draft, QueuedWrite, Server, Tier, catalog, store};

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
fn library_copy(server: &Scripted, dir: &Path) -> Core {
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

fn keyed(source_id: &str, tier: Option<Tier>) -> Draft {
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
fn found(held: &[&str]) -> scripted::Answer {
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
fn a_lookup_the_server_cannot_answer_holds_the_create_and_a_refused_one_sends_the_slices_tier() {
    for (answer, unavailable) in [
        (scripted::refusal(503, "unavailable"), true),
        (scripted::refusal(429, "rate_limited"), true),
        (scripted::refusal(403, "type_not_permitted"), false),
    ] {
        let server = Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = library_copy(&server, dir.path());
        core.create_item(&keyed("article-1", None)).unwrap();

        server.on("/items/lookup", vec![answer]);
        let report = core.drain().unwrap();
        let sent = bodies(&server, "/items");
        if unavailable {
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
                sent.is_empty(),
                "a create went before its key was looked up"
            );
            // The witness: the next pass, answered, sends it.
            server.on("/items/lookup", vec![found(&["article-1"])]);
            core.drain().unwrap();
            let sent = bodies(&server, "/items");
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0].get("tier"), None);
        } else {
            assert_eq!(sent.len(), 1, "{report:?}");
            assert_eq!(sent[0]["tier"], "library");
        }
    }
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
        store::put_server_item(&conn, &held, Some(&[]), &catalog::Indexing::default()).unwrap();
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
