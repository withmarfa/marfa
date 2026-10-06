//! What a working copy refuses before it sends, and how it puts itself back
//! when the server refuses what it sent.

use crate::scripted::{self, Scripted};
use crate::stop_tests::{copy, holding_a_catalog, note};
use crate::{Core, CoreError, ListFilters, Server, SliceTier, Sort, store};

#[test]
fn a_drain_on_a_copy_without_its_read_view_sends_nothing() {
    let server = Scripted::start();
    let core = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: "k".into(),
    }))
    .unwrap();
    core.create_item(&note(None)).unwrap();
    core.create_item(&note(None)).unwrap();
    assert_eq!(core.drain(), Err(CoreError::NoCursor));
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
    }
    assert_eq!(core.drain(), Err(CoreError::HydrationIncomplete));
    {
        let conn = core.conn().unwrap();
        store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    assert!(matches!(core.drain(), Err(CoreError::CopyExpired { .. })));
    assert_eq!(server.asked(), 0);
    let queue = core.queue().unwrap();
    assert_eq!(queue.len(), 2);
    assert!(queue.iter().all(|row| row.verdict.is_none()));
    // With no server to be reached the refusal is the same.
    let offline = Core::open_in_memory(Some(Server {
        url: "http://127.0.0.1:9".into(),
        key: "k".into(),
    }))
    .unwrap();
    offline.create_item(&note(None)).unwrap();
    assert_eq!(offline.drain(), Err(CoreError::NoCursor));
}

#[test]
fn a_create_or_an_edge_naming_an_id_the_server_refuses_is_refused_before_it_is_queued() {
    let core = copy(&Scripted::start());
    holding_a_catalog(&core);
    let refused = |error: CoreError| matches!(error, CoreError::Validation { code, .. } if code == "invalid_id");
    assert!(refused(
        core.create_item(&note(Some("my-note-1"))).unwrap_err()
    ));
    assert!(core.queue().unwrap().is_empty());
    assert_eq!(core.get("my-note-1").unwrap(), None);
    let one = core.create_item(&note(None)).unwrap().item_id.unwrap();
    let other = core.create_item(&note(None)).unwrap().item_id.unwrap();
    let edge = |id: Option<&str>, target: &str| crate::EdgeDraft {
        source_id: one.clone(),
        target_id: target.into(),
        edge_type: "references".into(),
        id: id.map(str::to_string),
        ..Default::default()
    };
    assert!(refused(
        core.create_edge(&edge(Some("link-1"), &other)).unwrap_err()
    ));
    assert_eq!(core.queue().unwrap().len(), 2);
    let named = uuid::Uuid::now_v7().to_string();
    core.create_item(&note(Some(&named))).unwrap();
    core.create_edge(&edge(Some(&uuid::Uuid::now_v7().to_string()), &other))
        .unwrap();
}

#[test]
fn a_create_refused_for_its_id_is_put_back_and_can_be_discarded() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    // Queued as a store an earlier build made could hold it.
    {
        let conn = core.conn().unwrap();
        let ghost = note(Some("my-note-1"));
        let mut row = ghost.wire("my-note-1");
        row.tier = Some("library".into());
        store::upsert_item(&conn, &row, Some(&[]), &Default::default()).unwrap();
        store::enqueue(
            &conn,
            &store::NewWrite {
                kind: crate::WriteKind::CreateItem,
                item_id: Some("my-note-1"),
                target_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: &ghost.payload("my-note-1").unwrap(),
                depends_on: &[],
            },
        )
        .unwrap();
    }
    server.on("/items", vec![scripted::refusal(400, "invalid_id")]);
    server.on(
        "/items/my-note-1",
        vec![scripted::refusal(400, "invalid_id")],
    );
    let report = core.drain().unwrap();
    assert_eq!(report.verdicts.len(), 1);
    assert_eq!(core.get("my-note-1").unwrap(), None);
    let queued = core.queue().unwrap();
    assert_eq!(queued[0].verdict, Some(crate::Verdict::Refused));
    assert!(core.discard(&queued[0].id).unwrap());
    assert!(core.queue().unwrap().is_empty());
}

#[test]
fn a_type_name_is_held_to_the_servers_grammar_before_anything_is_read() {
    for (name, takes) in [
        ("core.note", true),
        ("app.notes.entry", true),
        ("user.recipe", true),
        ("acme.calendar.event", true),
        ("aic.*", true),
        ("app.*", true),
        ("keys.*", true),
        ("app.notes", false),
        ("app.notes.entry.deep", false),
        ("keys.thing", false),
        ("webhooks.hook", false),
        ("aic", false),
        ("Core.note", false),
        ("core..note", false),
        ("core/note", false),
        (".*", false),
        ("*", false),
    ] {
        assert_eq!(crate::hydrate::type_pattern(name), Ok(takes), "{name}");
    }
    let server = Scripted::start();
    let core = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: "k".into(),
    }))
    .unwrap();
    core.create_item(&note(None)).unwrap();
    assert!(matches!(
        core.hydrate(&["app.notes".into()], SliceTier::Library),
        Err(CoreError::Invalid(_))
    ));
    assert_eq!(server.asked(), 0);
    let listed = |r#type: &str| {
        core.list(
            &ListFilters {
                r#type: Some(r#type.into()),
                ..Default::default()
            },
            Sort::default(),
        )
    };
    assert_eq!(listed("core.note").unwrap().len(), 1);
    assert_eq!(listed("core.*").unwrap().len(), 1);
    for malformed in ["core", "Core.note", "keys.thing"] {
        assert!(
            matches!(
                listed(malformed),
                Err(CoreError::Validation { code, .. }) if code == "validation_error"
            ),
            "{malformed}"
        );
        assert!(matches!(
            core.search(
                "a",
                &crate::SearchFilters {
                    r#type: Some(malformed.into()),
                    ..Default::default()
                },
                10,
            ),
            Err(CoreError::Validation { .. })
        ));
    }
}
