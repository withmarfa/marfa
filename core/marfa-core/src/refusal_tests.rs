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
    for malformed in ["", "core", "Core.note", "keys.thing"] {
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

#[test]
fn a_copy_with_no_server_is_refused_a_read_of_the_servers_catalog() {
    let core = Core::open_in_memory(None).unwrap();
    assert_eq!(
        core.server_catalog_until(&crate::NEVER_STOPPED),
        Err(CoreError::NoServer)
    );
    assert!(core.item_types().is_ok());
}

fn bookmark(properties: serde_json::Value) -> crate::Draft {
    crate::Draft {
        r#type: "core.bookmark".into(),
        properties: properties.as_object().unwrap().clone(),
        ..Default::default()
    }
}

fn payload_of(core: &Core, queued: &crate::QueuedWrite) -> serde_json::Value {
    let conn = core.conn().unwrap();
    let payload: String = conn
        .query_row(
            "SELECT payload FROM queue WHERE id = ?1",
            [&queued.id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&payload).unwrap()
}

#[test]
fn a_url_is_trimmed_in_the_row_and_in_the_queued_write_as_the_server_keeps_it() {
    let core = copy(&Scripted::start());
    let queued = core
        .create_item(&bookmark(serde_json::json!({
            "url": "\u{3000}https://example.com/a\u{feff}",
            "source_url": " https://exa\tmple.com/b ",
            "title": "  kept as written  ",
        })))
        .unwrap();
    let id = queued.item_id.clone().unwrap();
    let held = core.get(&id).unwrap().unwrap();
    assert_eq!(held.properties["url"], "https://example.com/a");
    assert_eq!(held.properties["source_url"], "https://example.com/b");
    assert_eq!(held.properties["title"], "  kept as written  ");
    let sent = payload_of(&core, &queued);
    assert_eq!(sent["properties"]["url"], "https://example.com/a");

    let edit = crate::Edit {
        properties: serde_json::json!({ "url": "\u{feff}https://example.com/c " })
            .as_object()
            .unwrap()
            .clone(),
        base_version: Some(held.version),
        ..Default::default()
    };
    let queued = core.update_item(&id, &edit).unwrap();
    assert_eq!(
        core.get(&id).unwrap().unwrap().properties["url"],
        "https://example.com/c"
    );
    assert_eq!(
        payload_of(&core, &queued)["properties"]["url"],
        "https://example.com/c"
    );
}

#[test]
fn a_url_the_server_refuses_is_refused_and_one_it_takes_is_not() {
    let core = copy(&Scripted::start());
    for refused in [
        "not a url",
        "\u{85}https://example.com",
        "http://xn--é/",
        "http://xn--",
        "http://xn--%41",
        "   ",
    ] {
        let error = core
            .create_item(&bookmark(serde_json::json!({ "url": refused })))
            .unwrap_err();
        assert!(
            matches!(&error, CoreError::Validation { code, message }
                if code == "invalid_properties" && message == "url: Must be a valid URL"),
            "{refused:?}: {error:?}"
        );
    }
    assert!(core.queue().unwrap().is_empty());
    for taken in ["http://xn--mnchen-3ya.de", "https://xn--80ak6aa92e.com/"] {
        let queued = core
            .create_item(&bookmark(serde_json::json!({ "url": taken })))
            .unwrap();
        let id = queued.item_id.unwrap();
        assert_eq!(core.get(&id).unwrap().unwrap().properties["url"], taken);
    }
}

#[test]
fn a_whole_number_a_float_would_change_is_refused_before_it_is_queued() {
    let core = copy(&Scripted::start());
    let mut kept = 0;
    for (value, refused) in [
        (1_500_000_000_000_000_001_i64, Some("1500000000000000000")),
        (9_223_372_036_854_775_807, Some("9223372036854776000")),
        (-9_007_199_254_740_993, Some("-9007199254740992")),
        (1_152_921_504_606_846_976, Some("1152921504606847000")),
        (1_152_921_504_606_847_000, None),
        (9_007_199_254_740_991, None),
    ] {
        for (properties, field) in [
            (serde_json::json!({ "undeclared": value }), "undeclared"),
            (
                serde_json::json!({ "nested": { "list": [0, value] } }),
                "nested.list.1",
            ),
        ] {
            let result = core.create_item(&bookmark(properties));
            if let Some(kept_as) = refused {
                let Err(CoreError::Validation { code, message }) = result else {
                    panic!("{value} at {field} was not refused");
                };
                assert_eq!(code, "invalid_properties");
                assert_eq!(
                    message,
                    format!(
                        "{field}: Must be a whole number that Marfa serves back with the same digits, not {value}, which it serves as {kept_as}. Send it as a string."
                    )
                );
            } else {
                result.unwrap();
                kept += 1;
            }
        }
    }
    assert_eq!(core.queue().unwrap().len(), kept);
}

#[test]
fn a_float_a_binding_hands_over_is_held_in_the_digits_the_server_serves() {
    // The Node binding passes these large JavaScript numbers as floats,
    // as does the Swift binding's `Number(f64)` case.
    // Swift's separate `Integer(i64)` case reaches the integer guard.
    let core = copy(&Scripted::start());
    let float = |number: f64| serde_json::Number::from_f64(number).unwrap();
    for (number, served) in [
        (2f64.powi(60), "1152921504606847000"),
        (-(2f64.powi(60)), "-1152921504606847000"),
        (9_007_199_254_740_992.0, "9007199254740992"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
    ] {
        let queued = core
            .create_item(&bookmark(
                serde_json::json!({ "n": float(number), "list": [float(number)] }),
            ))
            .unwrap();
        let id = queued.item_id.clone().unwrap();
        let row: String = core
            .conn()
            .unwrap()
            .query_row("SELECT properties FROM items WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(row, format!(r#"{{"n":{served},"list":[{served}]}}"#));
        // The witness that the text differs and the number does not: the write
        // carries the float as it was given, which the server reads as the
        // same number.
        let payload = payload_of(&core, &queued);
        assert_eq!(payload["properties"]["n"].as_f64(), Some(number));
    }
}
