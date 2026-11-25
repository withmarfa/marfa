use super::*;

#[test]
fn local_fields_distinguish_an_absent_type_from_a_known_empty_type() {
    let core = held_copy();
    assert!(
        core.update_item(
            "row",
            &Edit {
                base_version: Some(3),
                properties: serde_json::json!({"custom": 1})
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            }
        )
        .is_ok()
    );
    store::replace_types(&core.conn().unwrap(), &[]).unwrap();
    let before = core.queue().unwrap();
    assert!(matches!(
        core.update_item(
            "row",
            &Edit {
                base_version: Some(3),
                ..Default::default()
            }
        ),
        Err(CoreError::UnknownType { .. })
    ));
    assert_eq!(core.queue().unwrap(), before);
    assert!(core.add_tag("row", "after-type-deletion").is_ok());
}

#[test]
fn local_fields_refuse_before_the_copy_or_queue_changes() {
    let core = validation_copy();
    let witness = core
        .create_item(&validation_draft(serde_json::json!({
            "title": "😀abcd", "read": null, "choice": "yes", "count": 2.0,
            "list": [false, {}], "date": "2000-02-29", "time": "2026-01-01T23:59+23:59",
            "email": "reader+tag@example.test", "url": "mailto:reader@example.test",
            "image": "data:image/png;base64,iVBORw0KGgo=", "object": {},
            "annotated": "not an email", "custom": {"anything": null}
        })))
        .unwrap();
    let before = core.queue().unwrap();
    let rows = core
        .list(&ListFilters::default(), Sort::default())
        .unwrap()
        .rows;
    for (field, value) in [
        ("title", Value::Null),
        ("title", serde_json::json!("😀abcde")),
        ("title", serde_json::json!("a\u{0000}b")),
        ("read", serde_json::json!("yes")),
        ("choice", serde_json::json!("maybe")),
        ("count", serde_json::json!(2.5)),
        ("list", serde_json::json!([1, 2, 3])),
        ("date", serde_json::json!("1900-02-29")),
        ("time", serde_json::json!("2026-01-01T00:00:00")),
        ("email", serde_json::json!("a..b@example.test")),
        ("url", serde_json::json!("relative")),
        (
            "image",
            serde_json::json!("data:image/png;base64,iVBORw0KGgp="),
        ),
        ("object", serde_json::json!([])),
    ] {
        let mut draft = validation_draft(serde_json::json!({"title": "valid"}));
        draft.properties.insert(field.into(), value);
        let failure = core.create_item(&draft).unwrap_err();
        assert!(
            matches!(&failure, CoreError::Validation {code, message, .. } if code == "invalid_properties" && message.contains(field)),
            "{failure:?}"
        );
        assert_eq!(core.queue().unwrap(), before);
        assert_eq!(
            core.list(&ListFilters::default(), Sort::default())
                .unwrap()
                .rows,
            rows
        );
    }
    assert!(
        core.create_item(&validation_draft(serde_json::json!({})))
            .is_err()
    );
    assert!(
        core.get(witness.item_id.as_deref().unwrap())
            .unwrap()
            .is_some()
    );
}

/// What the server refuses as a tag, beside what it takes at the bound.
fn refused_tags() -> Vec<(String, &'static str)> {
    vec![
        (String::new(), "empty"),
        ("   ".into(), "blank"),
        ("\t\u{a0}\u{2003}\u{85}".into(), "blank"),
        (".".into(), "URL path"),
        ("..".into(), "URL path"),
        ("a".repeat(MAX_TAG_LENGTH + 1), "at most"),
        ("😀".repeat(MAX_TAG_LENGTH + 1), "at most"),
    ]
}

fn accepted_tags() -> Vec<String> {
    vec![
        "a".repeat(MAX_TAG_LENGTH),
        "😀".repeat(MAX_TAG_LENGTH),
        "\u{feff}".into(),
        " padded ".into(),
    ]
}

#[test]
fn a_tag_the_server_refuses_is_refused_before_the_copy_or_queue_changes() {
    let core = held_copy();
    for tag in accepted_tags() {
        assert!(core.add_tag("row", &tag).is_ok(), "{tag:?} was refused");
    }
    let before = core.queue().unwrap();
    let held = core.get("row").unwrap().unwrap();
    let unchanged = |what: &str| {
        assert_eq!(core.queue().unwrap(), before, "{what} queued a write");
        assert_eq!(core.get("row").unwrap().unwrap(), held, "{what} saved");
    };
    for (tag, reason) in refused_tags() {
        let named = format!("{tag:?}");
        let failures = [
            ("add_tag", core.add_tag("row", &tag).unwrap_err()),
            (
                "replace",
                core.replace_tags(
                    "row",
                    &TagsWrite {
                        tags: vec![tag.clone()],
                    },
                )
                .unwrap_err(),
            ),
            (
                "create",
                core.create_item(&Draft {
                    r#type: "core.note".into(),
                    tags: vec![tag.clone()],
                    ..Default::default()
                })
                .unwrap_err(),
            ),
        ];
        for (door, failure) in failures {
            assert!(
                matches!(&failure, CoreError::Validation { code, message, .. }
                    if code == "validation_error" && message.contains(reason)),
                "{door} with {named}: {failure:?}"
            );
            unchanged(door);
        }
    }
    // Replacing with no tags clears them, and a removal is not held to
    // the bound: a row restored from an archive can hold a tag the bound
    // refuses and must be able to shed it.
    assert!(
        core.replace_tags("row", &TagsWrite { tags: vec![] })
            .is_ok()
    );
    store::add_tags(&core.conn().unwrap(), "row", &[String::new()]).unwrap();
    assert!(core.remove_tag("row", "").is_ok());
    // A dot tag held from before the bound is shed by a replace, whose
    // request does not name it in a URL path.
    let dots = vec![".".to_string(), "..".to_string()];
    store::add_tags(&core.conn().unwrap(), "row", &dots).unwrap();
    assert_eq!(core.get("row").unwrap().unwrap().tags, dots);
    assert!(
        core.replace_tags(
            "row",
            &TagsWrite {
                tags: vec!["fine".into()],
            }
        )
        .is_ok()
    );
    assert_eq!(core.get("row").unwrap().unwrap().tags, vec!["fine"]);
}

#[test]
fn a_property_with_no_name_is_refused_before_the_copy_or_queue_changes() {
    let core = held_copy();
    let named = |name: &str| {
        serde_json::json!({ "title": "t", name: 1 })
            .as_object()
            .unwrap()
            .clone()
    };
    let edit = |name: &str, replace| Edit {
        base_version: Some(3),
        properties: named(name),
        replace_properties: replace,
        ..Default::default()
    };
    let draft = |name: &str| Draft {
        r#type: "core.note".into(),
        properties: named(name),
        ..Default::default()
    };
    // The witness: the same writes with a name are taken.
    assert!(core.create_item(&draft("named")).is_ok());
    assert!(core.update_item("row", &edit("named", false)).is_ok());
    assert!(
        core.update_item_as_read("row", &edit("other", false))
            .is_ok()
    );
    let before = core.queue().unwrap();
    let held = core.get("row").unwrap().unwrap();
    for failure in [
        core.create_item(&draft("")).unwrap_err(),
        core.update_item("row", &edit("", false)).unwrap_err(),
        core.update_item("row", &edit("", true)).unwrap_err(),
        core.update_item_as_read("row", &edit("", false))
            .unwrap_err(),
    ] {
        assert!(
            matches!(&failure, CoreError::Validation { code, message, .. }
                if code == "validation_error" && message.contains("property name")),
            "{failure:?}"
        );
        assert_eq!(core.queue().unwrap(), before);
        assert_eq!(core.get("row").unwrap().unwrap(), held);
    }
}

#[test]
fn an_update_that_sets_a_bad_entry_is_refused_naming_the_field_the_position_and_the_member() {
    let core = Core::open_in_memory(None).unwrap();
    core.declare_types(&[serde_json::json!({
        "id": "app.recipe.entry",
        "fields": { "list": { "type": "array", "items_type": "object", "items_fields": {
            "value": { "type": "email", "required": true },
            "rank": { "type": "integer", "minimum": 1, "maximum": 5 },
        } } },
    })])
    .unwrap();
    let created = core
        .create_item(&Draft {
            r#type: "app.recipe.entry".into(),
            properties: properties(serde_json::json!({ "list": [{ "value": "a@example.test" }] })),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap();
    let queued = core.queue().unwrap().len();
    let edit = |list: Value| Edit {
        base_version: Some(0),
        properties: properties(serde_json::json!({ "list": list })),
        ..Default::default()
    };
    for (bad, named) in [
        (
            serde_json::json!([{ "value": "a@example.test" }, { "rank": 1 }]),
            "list: Item 1: value: Required",
        ),
        (
            serde_json::json!([{ "value": "a@example.test", "rank": 6 }]),
            "list: Item 0: rank: Must be at most 5",
        ),
        (
            serde_json::json!([{ "value": "a@example.test", "x": 1 }]),
            "list: Item 0: x: Is not a member of the entry",
        ),
    ] {
        let Err(CoreError::Validation { message, .. }) = core.update_item(&created, &edit(bad))
        else {
            panic!("an update setting a bad entry was queued");
        };
        assert!(message.contains(named), "{message}");
    }
    assert_eq!(
        core.queue().unwrap().len(),
        queued,
        "a refused update was queued"
    );
    // The witness: a good entry is queued.
    assert!(
        core.update_item(
            &created,
            &edit(serde_json::json!([{ "value": "b@example.test", "rank": 5 }]))
        )
        .is_ok()
    );
}

#[test]
fn local_fields_judge_current_whole_edits_but_only_stale_supplied_values() {
    let core = validation_copy();
    let mut row = store::testing::note("typed", "valid", "body", "2026-01-01T00:00:00Z");
    row.r#type = "acme.child".into();
    row.version = 3;
    store::put_server_item(
        &core.conn().unwrap(),
        &row,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    let edit = |base, properties: Value, replace| Edit {
        base_version: Some(base),
        properties: properties.as_object().unwrap().clone(),
        replace_properties: replace,
        ..Default::default()
    };
    let before = core.get("typed").unwrap();
    for bad in [
        edit(3, serde_json::json!({}), true),
        edit(3, serde_json::json!({"title": null}), false),
    ] {
        assert!(matches!(
            core.update_item("typed", &bad),
            Err(CoreError::Validation { .. })
        ));
        assert_eq!(core.get("typed").unwrap(), before);
        assert!(core.queue().unwrap().is_empty());
    }
    assert!(
        core.update_item("typed", &edit(3, serde_json::json!({"read": null}), false))
            .is_ok()
    );
    assert!(
        core.update_item_as_read("typed", &edit(1, serde_json::json!({"read": false}), true))
            .is_ok()
    );
    assert!(matches!(
        core.update_item_as_read("typed", &edit(1, serde_json::json!({"read": "yes"}), true)),
        Err(CoreError::Validation { .. })
    ));
    let created = core
        .create_item(&validation_draft(serde_json::json!({"title": "draft"})))
        .unwrap()
        .item_id
        .unwrap();
    assert!(matches!(
        core.update_item(&created, &edit(0, serde_json::json!({}), true)),
        Err(CoreError::Validation { .. })
    ));
    let retype = Edit {
        r#type: Some("acme.parent".into()),
        ..edit(3, serde_json::json!({}), false)
    };
    assert!(matches!(
        core.update_item("typed", &retype),
        Err(CoreError::Validation { .. })
    ));
}

#[test]
fn local_fields_keep_unanswered_keyed_placeholders_unresolved() {
    let core = validation_copy();
    let keyed = |value: Value| Draft {
        source: Some("fixture".into()),
        source_id: Some("unseen".into()),
        ..validation_draft(value)
    };
    let first = core
        .create_item(&keyed(serde_json::json!({"read": true})))
        .unwrap();
    let id = first.item_id.unwrap();
    assert!(
        core.create_item(&keyed(serde_json::json!({"read": false})))
            .is_ok()
    );
    let edit = |value: Value| Edit {
        base_version: Some(0),
        properties: value.as_object().unwrap().clone(),
        replace_properties: true,
        ..Default::default()
    };
    assert!(
        core.update_item(&id, &edit(serde_json::json!({"read": false})))
            .is_ok()
    );
    let before = core.queue().unwrap();
    assert!(matches!(
        core.create_item(&keyed(serde_json::json!({"read": "yes"}))),
        Err(CoreError::Validation { .. })
    ));
    assert!(matches!(
        core.update_item(&id, &edit(serde_json::json!({"read": "yes"}))),
        Err(CoreError::Validation { .. })
    ));
    assert_eq!(core.queue().unwrap(), before);
    let ordinary = core
        .create_item(&validation_draft(serde_json::json!({"title": "valid"})))
        .unwrap()
        .item_id
        .unwrap();
    core.update_item(
        &ordinary,
        &Edit {
            source_id: Some("later-key".into()),
            ..edit(serde_json::json!({"title": "valid"}))
        },
    )
    .unwrap();
    assert!(matches!(
        core.update_item(&ordinary, &edit(serde_json::json!({}))),
        Err(CoreError::Validation { .. })
    ));
}

#[test]
fn local_fields_judge_a_known_upsert_and_defer_an_unknown_targets_missing_fields() {
    let core = validation_copy();
    let mut row = store::testing::note("keyed", "valid", "body", "2026-01-01T00:00:00Z");
    row.r#type = "acme.child".into();
    row.source = "fixture".into();
    row.source_id = Some("known".into());
    row.version = 3;
    store::put_server_item(
        &core.conn().unwrap(),
        &row,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    let keyed = |key: &str, properties: Value| Draft {
        source: Some("fixture".into()),
        source_id: Some(key.into()),
        ..validation_draft(properties)
    };
    assert!(
        core.create_item(&keyed("known", serde_json::json!({"read": true})))
            .is_ok()
    );
    assert!(matches!(
        core.create_item(&keyed("known", serde_json::json!({"title": null}))),
        Err(CoreError::Validation { .. })
    ));
    assert!(
        core.create_item(&keyed("unknown", serde_json::json!({"read": false})))
            .is_ok()
    );
    assert!(matches!(
        core.create_item(&keyed("unknown", serde_json::json!({"read": "yes"}))),
        Err(CoreError::Validation { .. })
    ));
}

#[test]
fn a_write_nested_past_what_the_server_reads_is_refused_before_it_is_queued() {
    // The server refuses a request body nested more than `MAX_JSON_DEPTH`
    // levels (`items/json-depth`), so the largest `deep` is the one that
    // leaves the body, with its wrapper, at the limit: an item's and an
    // edge's properties sit one level down, an extension's body is the
    // object itself.
    let at = MAX_JSON_DEPTH - 2;
    let core = held_copy();
    store::put_server_item(
        &core.conn().unwrap(),
        &store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z"),
        Some(&[]),
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    let version = core.get("row").unwrap().unwrap().version;
    let queued = |core: &Core| core.queue().unwrap().len();
    let edit = |arrays: usize| Edit {
        properties: nested(arrays),
        base_version: Some(version),
        ..Edit::default()
    };
    let draft = |arrays: usize| Draft {
        r#type: "core.note".into(),
        properties: nested(arrays),
        ..Default::default()
    };
    let edge = |arrays: usize| EdgeDraft {
        from_id: "row".into(),
        to_id: "other".into(),
        edge_type: "references".into(),
        properties: nested(arrays),
        ..Default::default()
    };
    let edge_edit = |arrays: usize| EdgeEdit {
        properties: nested(arrays),
        base_version: Some(1),
        ..EdgeEdit::default()
    };
    let extension = |arrays: usize| serde_json::to_string(&Value::Object(nested(arrays))).unwrap();
    for (what, refused) in [
        ("create", core.create_item(&draft(at + 1)).map(|_| ())),
        ("update", core.update_item("row", &edit(at + 1)).map(|_| ())),
        ("edge", core.create_edge(&edge(at + 1)).map(|_| ())),
        (
            "edge update",
            core.update_edge("link", &edge_edit(at + 1)).map(|_| ()),
        ),
        (
            "extension",
            core.write_extension("row", "acme.x", &extension(at + 2), None)
                .map(|_| ()),
        ),
    ] {
        assert!(
            matches!(refused, Err(CoreError::Invalid(_))),
            "{what}: {refused:?}"
        );
    }
    assert_eq!(queued(&core), 0, "a refused write was queued");
    // The witnesses: one level less is taken, and so is the limit itself.
    assert!(core.create_item(&draft(at)).is_ok());
    assert!(core.create_item(&draft(at - 1)).is_ok());
    assert!(core.update_item("row", &edit(at)).is_ok());
    assert!(core.create_edge(&edge(at)).is_ok());
    assert!(core.update_edge("link", &edge_edit(at)).is_ok());
    assert!(
        core.write_extension("row", "acme.x", &extension(at + 1), None)
            .is_ok()
    );
    assert_eq!(queued(&core), 6);
    // What was queued reads back, so no later read of the queue fails.
    assert_eq!(core.queue().unwrap().len(), 6);
}

#[test]
fn a_create_the_server_would_refuse_for_its_state_location_or_edges_is_refused_before_it_is_queued()
{
    let core = held_copy();
    let base = || Draft {
        r#type: "core.note".into(),
        ..Default::default()
    };
    let bad = [
        Draft {
            state: Some(ItemState::Revoked),
            ..base()
        },
        Draft {
            capture_latitude: Some(f64::NAN),
            ..base()
        },
        Draft {
            edges: [(String::new(), vec![uuid::Uuid::now_v7().to_string()])].into(),
            ..base()
        },
        Draft {
            edges: [("references".to_string(), vec![String::new()])].into(),
            ..base()
        },
    ];
    for (n, draft) in bad.iter().enumerate() {
        let refused = core.create_item(draft);
        // The server answers an empty edge type `edge_type_not_found`.
        let as_served = if n == 2 {
            matches!(&refused, Err(CoreError::NotFound { code, .. }) if code == "edge_type_not_found")
        } else {
            matches!(&refused, Err(CoreError::Validation { .. }))
        };
        assert!(as_served, "{draft:?}: {refused:?}");
    }
    assert!(core.queue().unwrap().is_empty());
}

#[test]
fn a_whole_number_a_float_would_change_is_refused_in_an_edge_and_an_extension() {
    let core = held_copy();
    store::put_server_item(
        &core.conn().unwrap(),
        &store::testing::note("other", "other", "body", "2026-01-01T00:00:00Z"),
        Some(&[]),
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    let edge = |properties: serde_json::Value| EdgeDraft {
        from_id: "row".into(),
        to_id: "other".into(),
        edge_type: "references".into(),
        properties: properties.as_object().unwrap().clone(),
        ..Default::default()
    };
    let edge_edit = |properties: serde_json::Value| EdgeEdit {
        properties: properties.as_object().unwrap().clone(),
        base_version: Some(1),
        ..EdgeEdit::default()
    };
    let refused = |result: Result<()>, where_: &str| match result {
        Err(CoreError::Validation { code, message, .. }) => {
            assert_eq!(code, "invalid_properties", "{where_}");
            assert!(
                message.contains("Must be a whole number that Marfa serves back"),
                "{where_}: {message}"
            );
        }
        other => panic!("{where_} was not refused: {other:?}"),
    };
    refused(
        core.create_edge(&edge(
            serde_json::json!({ "weight": 9_999_999_999_999_999_999_u64 }),
        ))
        .map(|_| ()),
        "a new edge",
    );
    refused(
        core.create_edge(&edge(
            serde_json::json!({ "n": { "list": [1_152_921_504_606_846_976_i64] } }),
        ))
        .map(|_| ()),
        "a new edge, nested",
    );
    refused(
        core.update_edge(
            "link",
            &edge_edit(serde_json::json!({ "weight": 1_152_921_504_606_846_976_i64 })),
        )
        .map(|_| ()),
        "an edge edit",
    );
    for body in [
        r#"{"weight":9999999999999999999}"#,
        r#"{"a":{"b":[1152921504606846976]}}"#,
        r#"{"a":[1,{"b":-0}]}"#,
    ] {
        refused(
            core.write_extension("row", "acme.x", body, None)
                .map(|_| ()),
            "an extension",
        );
    }
    assert_eq!(core.queue().unwrap().len(), 0, "a refused write was queued");

    // The witnesses: a number a float keeps, and a string of the digits.
    core.create_edge(&edge(
        serde_json::json!({ "weight": 1_152_921_504_606_847_000_i64 }),
    ))
    .unwrap();
    core.update_edge(
        "link",
        &edge_edit(serde_json::json!({ "weight": "9999999999999999999" })),
    )
    .unwrap();
    core.write_extension(
        "row",
        "acme.x",
        r#"{"weight":1152921504606847000,"s":"9999999999999999999","zero":-0.0,"minus":-1}"#,
        None,
    )
    .unwrap();
    assert_eq!(core.queue().unwrap().len(), 3);
}

#[test]
fn an_item_write_to_a_system_row_is_refused_before_anything_is_saved_or_queued() {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        store::replace_types(
            &conn,
            &[
                store::testing::wire_type("core.note", None, Some("title")),
                store::testing::wire_type(FOLDER_TYPE, None, Some("title")),
            ],
        )
        .unwrap();
        let folder = store::testing::wire_item(
            "folder",
            FOLDER_TYPE,
            "active",
            "2026-01-01T00:00:00Z",
            serde_json::json!({ "title": "Inbox" }),
        );
        store::put_server_item(
            &conn,
            &folder,
            Some(&[]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
    }
    let before = core.get("folder").unwrap();
    let held = store::count(&core.conn().unwrap(), "items").unwrap();
    let refused = |result: Result<QueuedWrite>, what: &str| match result {
        Err(CoreError::Forbidden { code, message, .. }) => {
            assert_eq!(code, "type_not_permitted", "{what}");
            assert!(message.contains("folders create"), "{what}: {message}");
        }
        other => panic!("{what} was not refused type_not_permitted: {other:?}"),
    };
    refused(
        core.create_item(&Draft {
            r#type: FOLDER_TYPE.into(),
            properties: properties(serde_json::json!({ "title": "New" })),
            ..Default::default()
        }),
        "a create",
    );
    let edit = |r#type: Option<&str>| Edit {
        properties: properties(serde_json::json!({ "title": "Renamed" })),
        base_version: Some(1),
        r#type: r#type.map(str::to_string),
        ..Edit::default()
    };
    refused(core.update_item("folder", &edit(None)), "an edit");
    refused(
        core.update_item("folder", &edit(Some("core.note"))),
        "a retype from",
    );
    refused(core.delete_item("folder"), "a delete");
    refused(
        core.transition_item_from("folder", ItemState::Archived, None),
        "a transition",
    );
    refused(core.restore_item("folder"), "a restore");
    let retyped = Edit {
        base_version: Some(3),
        ..edit(Some(FOLDER_TYPE))
    };
    refused(core.update_item("row", &retyped), "a retype to");
    assert!(core.queue().unwrap().is_empty());
    assert_eq!(core.get("folder").unwrap(), before);
    assert_eq!(core.get("row").unwrap().unwrap().r#type, "core.note");
    assert_eq!(store::count(&core.conn().unwrap(), "items").unwrap(), held);

    // The witness: the same doors queue a write of a row that is not.
    core.update_item(
        "row",
        &Edit {
            base_version: Some(3),
            ..edit(None)
        },
    )
    .unwrap();
    core.transition_item_from("row", ItemState::Archived, None)
        .unwrap();
    core.create_item(&Draft {
        r#type: "core.note".into(),
        properties: properties(serde_json::json!({ "title": "New" })),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(core.queue().unwrap().len(), 3);
}

#[test]
fn a_move_to_the_revoked_state_is_refused_as_the_server_refuses_it() {
    let core = Core::open_in_memory(None).unwrap();
    let held = core
        .create_item(&Draft {
            r#type: "core.note".into(),
            properties: properties(serde_json::json!({ "title": "Held" })),
            ..Default::default()
        })
        .unwrap();
    let id = held.item_id.unwrap();
    let queued = core.queue().unwrap().len();
    match core.transition_item_from(&id, ItemState::Revoked, None) {
        Err(CoreError::Validation {
            code,
            details: None,
            server: None,
            ..
        }) => assert_eq!(code, "validation_error"),
        other => panic!("a move to revoked was answered {other:?}"),
    }
    // The witness: a state a device may name is queued.
    core.transition_item_from(&id, ItemState::Archived, None)
        .unwrap();
    assert_eq!(core.queue().unwrap().len(), queued + 1);
}

#[test]
fn a_hydration_in_progress_or_expired_still_refuses_what_it_holds_and_what_is_saved() {
    let core = Core::open_in_memory(None).unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    // A slice and no cursor is a copy that cannot be kept current.
    for refusal in [
        core.create_item(&Draft {
            r#type: "core.note".into(),
            ..Default::default()
        })
        .map(|_| ())
        .unwrap_err(),
        core.get("x").map(|_| ()).unwrap_err(),
    ] {
        assert_eq!(refusal, CoreError::HydrationIncomplete);
    }
}

#[test]
fn a_full_store_refuses_a_local_edit_without_losing_the_queue() {
    let core = held_copy();
    let before = core.queue().unwrap();
    {
        let conn = core.conn().unwrap();
        let pages: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        conn.pragma_update(None, "max_page_count", pages).unwrap();
    }
    let edit = Edit {
        base_version: Some(3),
        properties: serde_json::json!({ "body": "x".repeat(1024 * 1024) })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    };
    let failure = core.update_item("row", &edit);
    assert!(
        matches!(failure, Err(CoreError::StorageFull(_))),
        "{failure:?}"
    );
    assert_eq!(core.queue().unwrap(), before);
    core.conn()
        .unwrap()
        .pragma_update(None, "max_page_count", 10000)
        .unwrap();
    assert!(core.update_item("row", &edit).is_ok());
}
