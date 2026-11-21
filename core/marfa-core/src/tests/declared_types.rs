use super::*;

#[test]
fn a_copy_that_has_never_reached_a_server_saves_against_the_types_marfa_ships() {
    let core = Core::open_in_memory(None).unwrap();
    let note = core
        .create_item(&Draft {
            r#type: "core.note".into(),
            properties: properties(
                serde_json::json!({ "title": "First", "body": "Saved offline" }),
            ),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(note.kind, WriteKind::CreateItem);
    assert_eq!(note.outcome().unwrap(), None);
    // Held, read and found, at the tier an app reads unless it says.
    let id = note.item_id.clone().unwrap();
    let held = core.get(&id).unwrap().unwrap();
    assert_eq!(held.tier, Some(Tier::Library));
    assert_eq!(
        core.list(&ListFilters::default(), Sort::default())
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(
        core.search("offline", &SearchFilters::default(), 10)
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(core.queue().unwrap().len(), 1);
    assert_eq!(core.status().unwrap().hydration, Hydration::Never);
    // The catalog is Marfa's own, and the server's is not held.
    assert!(
        core.item_types()
            .unwrap()
            .iter()
            .any(|held| held.id == "core.note")
    );
    assert!(!core.edge_types().unwrap().is_empty());
    assert_eq!(core.status().unwrap().catalog_version, None);
    // What the type refuses is refused here, before anything is queued.
    assert!(matches!(
        core.create_item(&Draft {
            r#type: "core.note".into(),
            properties: properties(serde_json::json!({ "title": 7 })),
            ..Default::default()
        }),
        Err(CoreError::Validation { .. })
    ));
    assert!(matches!(
        core.create_item(&Draft {
            r#type: "app.unheard-of.entry".into(),
            ..Default::default()
        }),
        Err(CoreError::UnknownType { .. })
    ));
    assert_eq!(core.queue().unwrap().len(), 1);
    // Nothing here can send it: a drain waits for a server and a copy.
    assert!(core.drain().is_err());
}

#[test]
fn a_copy_checks_what_it_queues_against_the_types_the_app_declares() {
    let core = Core::open_in_memory(None).unwrap();
    let recipe = serde_json::json!({
        "id": "app.recipe.entry",
        "fields": {
            "title": { "type": "string", "required": true },
            "servings": { "type": "number" },
        },
    });
    let create = |value: serde_json::Value| {
        core.create_item(&Draft {
            r#type: "app.recipe.entry".into(),
            properties: properties(value),
            ..Default::default()
        })
    };
    // The witness: the type is refused until it is declared.
    assert!(matches!(
        create(serde_json::json!({ "title": "Soup" })),
        Err(CoreError::UnknownType { .. })
    ));
    core.declare_types(std::slice::from_ref(&recipe)).unwrap();
    assert!(create(serde_json::json!({ "title": "Soup", "servings": 4 })).is_ok());
    assert!(matches!(
        create(serde_json::json!({ "servings": 4 })),
        Err(CoreError::Validation { .. })
    ));
    assert!(matches!(
        create(serde_json::json!({ "title": "Soup", "servings": "four" })),
        Err(CoreError::Validation { .. })
    ));
    // Declared again, it is the new declaration; declared types survive a
    // reopen, which is how an app that declares at launch finds them.
    let renumbered = serde_json::json!({
        "id": "app.recipe.entry",
        "fields": { "title": { "type": "number", "required": true } },
    });
    core.declare_types(&[renumbered]).unwrap();
    assert!(matches!(
        create(serde_json::json!({ "title": "Soup" })),
        Err(CoreError::Validation { .. })
    ));
    assert!(create(serde_json::json!({ "title": 3 })).is_ok());
    assert_eq!(core.declared_types().unwrap().len(), 1);
    assert_eq!(core.declared_types().unwrap()[0]["version"], 0);
}

#[test]
fn a_declaration_is_the_whole_set_the_app_holds() {
    let core = Core::open_in_memory(None).unwrap();
    let draft = |kind: &str| Draft {
        r#type: kind.into(),
        properties: serde_json::json!({ "title": "t" })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    };
    core.declare_types(&[serde_json::json!({ "id": "app.recipe.entry", "fields": {} })])
        .unwrap();
    assert!(core.create_item(&draft("app.recipe.entry")).is_ok());
    // The app renames its type: the old one is no longer one it holds a
    // write to, and no longer one a hydration would register.
    core.declare_types(&[serde_json::json!({ "id": "app.dish.entry", "fields": {} })])
        .unwrap();
    assert!(matches!(
        core.create_item(&draft("app.recipe.entry")),
        Err(CoreError::UnknownType { .. })
    ));
    assert!(core.create_item(&draft("app.dish.entry")).is_ok());
    let held: Vec<String> = core
        .declared_types()
        .unwrap()
        .iter()
        .filter_map(|held| held["id"].as_str().map(str::to_string))
        .collect();
    assert_eq!(held, ["app.dish.entry"]);
}

#[test]
fn a_declaration_refuses_app_names_without_exactly_three_segments() {
    let core = Core::open_in_memory(None).unwrap();
    for id in ["app.recipe", "app.recipe.entry.child"] {
        assert!(
            matches!(
                core.declare_types(&[serde_json::json!({ "id": id, "fields": {} })]),
                Err(CoreError::Invalid(_))
            ),
            "{id} cannot register but was declared"
        );
    }
    assert!(core.declared_types().unwrap().is_empty());
    core.declare_types(&[serde_json::json!({ "id": "app.recipe.entry", "fields": {} })])
        .unwrap();
}

#[test]
fn a_declaration_refuses_a_list_of_entries_and_a_currency_the_server_refuses() {
    let core = Core::open_in_memory(None).unwrap();
    let entries = |members: serde_json::Value| serde_json::json!({ "type": "array", "items_type": "object", "items_fields": members });
    let declare = |field: serde_json::Value| {
        core.declare_types(&[serde_json::json!({
            "id": "app.recipe.entry",
            "fields": { "list": field },
        })])
    };
    let refused: Vec<(&str, serde_json::Value)> = vec![
        (
            "a member with no type",
            entries(serde_json::json!({ "m": {} })),
        ),
        (
            "a member of an unknown type",
            entries(serde_json::json!({ "m": { "type": "strong" } })),
        ),
        (
            "a member that is not an object",
            entries(serde_json::json!({ "m": "string" })),
        ),
        ("no member", entries(serde_json::json!({}))),
        (
            "members that are not an object",
            entries(serde_json::json!(["m"])),
        ),
        (
            "items_fields on a string",
            serde_json::json!({ "type": "string", "items_fields": { "m": { "type": "string" } } }),
        ),
        (
            "items_fields on a list of strings",
            serde_json::json!({ "type": "array", "items_type": "string", "items_fields": { "m": { "type": "string" } } }),
        ),
        (
            "a max_length on a currency field",
            serde_json::json!({ "type": "string", "format": "currency", "max_length": 2 }),
        ),
        (
            "a max_length on a currency member",
            entries(
                serde_json::json!({ "m": { "type": "string", "format": "currency", "max_length": 2 } }),
            ),
        ),
    ];
    for kind in ["array", "object", "status", "thumbnail"] {
        let member = entries(serde_json::json!({ "m": { "type": kind } }));
        assert!(
            matches!(declare(member), Err(CoreError::Invalid(_))),
            "a member of kind {kind} was declared"
        );
    }
    for (what, field) in refused {
        assert!(
            matches!(declare(field), Err(CoreError::Invalid(_))),
            "{what} was declared"
        );
    }
    // The witness: the same fields, mended, are declared and judge a write.
    declare(entries(serde_json::json!({
        "a": { "type": "string", "required": true },
        "b": { "type": "integer", "minimum": 1 },
        "c": { "type": "string", "format": "currency" },
    })))
    .unwrap();
    declare(serde_json::json!({ "type": "string", "format": "currency" })).unwrap();
    // Nothing of a refused declaration was kept.
    assert_eq!(core.declared_types().unwrap().len(), 1);
}

#[test]
fn a_declaration_holds_a_member_of_entries_to_the_checks_it_makes_of_a_field() {
    let core = Core::open_in_memory(None).unwrap();
    let declare = |field: serde_json::Value| {
        core.declare_types(&[serde_json::json!({
            "id": "app.recipe.member",
            "fields": { "f": field },
        })])
    };
    let words = serde_json::json!([{ "value": "open", "group": "not_started" }]);
    // Each is refused on a field of its own, and so on a member.
    let checks = [
        (
            "status_values on a string",
            serde_json::json!({ "type": "string", "status_values": words }),
        ),
        (
            "items_fields on a string",
            serde_json::json!({ "type": "string", "items_fields": { "n": { "type": "string" } } }),
        ),
        (
            "items_type status",
            serde_json::json!({ "type": "string", "items_type": "status" }),
        ),
        (
            "a max_length on a currency",
            serde_json::json!({ "type": "string", "format": "currency", "max_length": 3 }),
        ),
    ];
    for (what, check) in checks {
        assert!(
            matches!(declare(check.clone()), Err(CoreError::Invalid(_))),
            "{what} was declared on a field"
        );
        let member = serde_json::json!({
            "type": "array", "items_type": "object", "items_fields": { "m": check }
        });
        assert!(
            matches!(declare(member), Err(CoreError::Invalid(_))),
            "{what} was declared on a member"
        );
    }
    // The witness: the mended members are declared.
    declare(serde_json::json!({
        "type": "array", "items_type": "object", "items_fields": {
            "a": { "type": "string" },
            "b": { "type": "string", "format": "currency" },
        }
    }))
    .unwrap();
}

#[test]
fn a_declared_format_that_is_a_kind_is_judged_as_the_server_judges_that_kind() {
    let core = Core::open_in_memory(None).unwrap();
    let declare = |fields: serde_json::Value| {
        core.declare_types(&[serde_json::json!({
            "id": "app.recipe.format",
            "fields": fields,
        })])
    };
    let entries = |member: serde_json::Value| serde_json::json!({ "type": "array", "items_type": "object", "items_fields": { "m": member } });
    // The server turns a string's format into the kind (`normalizeFieldDefinition`),
    // and an entry does not take a thumbnail.
    assert!(
        matches!(
            declare(serde_json::json!({
                "list": entries(serde_json::json!({ "type": "string", "format": "thumbnail" }))
            })),
            Err(CoreError::Invalid(_))
        ),
        "a member that is a thumbnail by its format was declared"
    );
    declare(serde_json::json!({
        "site": { "type": "string", "format": "url" },
        "sites": { "type": "array", "items_type": "string", "format": "url" },
        "list": entries(serde_json::json!({ "type": "string", "format": "url" })),
        "when": { "type": "string", "format": "date" },
        "image": { "type": "string", "format": "thumbnail" },
    }))
    .unwrap();
    let create = |properties: serde_json::Value| {
        core.create_item(&Draft {
            r#type: "app.recipe.format".into(),
            properties: properties.as_object().unwrap().clone(),
            ..Default::default()
        })
    };
    let id = create(serde_json::json!({
        "site": "  https://example.com/a\t ",
        "sites": [" https://example.com/b "],
        "list": [{ "m": "\thttps://example.com/c\n" }],
    }))
    .unwrap()
    .item_id
    .unwrap();
    let kept = core.get(&id).unwrap().unwrap().properties;
    assert_eq!(kept["site"], "https://example.com/a");
    assert_eq!(kept["sites"], serde_json::json!(["https://example.com/b"]));
    assert_eq!(
        kept["list"],
        serde_json::json!([{ "m": "https://example.com/c" }])
    );
    for (named, bad) in [
        ("site", serde_json::json!({ "site": "not a url" })),
        ("sites", serde_json::json!({ "sites": ["not a url"] })),
        (
            "list",
            serde_json::json!({ "list": [{ "m": "not a url" }] }),
        ),
        ("when", serde_json::json!({ "when": "tomorrow" })),
        ("image", serde_json::json!({ "image": "not an image" })),
    ] {
        let Err(CoreError::Validation { message, .. }) = create(bad) else {
            panic!("{named}: a value its format refuses was queued");
        };
        assert!(message.contains(named), "{message}");
    }
    // The witness: the plain kinds judge the same.
    assert!(
        create(serde_json::json!({ "site": "https://example.com/" })).is_ok(),
        "a url was refused"
    );
}

#[test]
fn a_declaration_refuses_reserved_type_roots() {
    let core = Core::open_in_memory(None).unwrap();
    let mut taken = Vec::new();
    for root in [
        "schema", "keys", "items", "webhooks", "config", "audit", "grants", "content", "metadata",
        "edge", "profile", "space", "marfa", "backups", "sign_ins",
    ] {
        let id = format!("{root}.entry");
        if !matches!(
            core.declare_types(&[serde_json::json!({ "id": id, "fields": {} })]),
            Err(CoreError::Invalid(_))
        ) {
            taken.push(id);
        }
    }
    assert!(
        taken.is_empty(),
        "unregisterable roots were declared: {taken:?}"
    );
    assert!(core.declared_types().unwrap().is_empty());
}

#[test]
fn a_declaration_holds_to_app_types_alone() {
    let core = Core::open_in_memory(None).unwrap();
    for id in [
        "user.x",
        "common.ticket",
        "acme.calendar.event",
        "acme-publisher.recipe",
    ] {
        match core.declare_types(&[serde_json::json!({ "id": id, "fields": {} })]) {
            Err(CoreError::Invalid(message)) => assert!(
                message.contains("app."),
                "{id}: the refusal does not say what a declaration holds to: {message}"
            ),
            other => panic!("{id} was declared: {other:?}"),
        }
    }
    assert!(core.declared_types().unwrap().is_empty());
    core.declare_types(&[serde_json::json!({ "id": "app.acme.setting", "fields": {} })])
        .unwrap();
    assert_eq!(core.declared_types().unwrap().len(), 1);
}

#[test]
fn a_declaration_accepts_depth_and_the_identifier_boundary() {
    let core = Core::open_in_memory(None).unwrap();
    let boundary = format!("app.acme.{}", "a".repeat(119));
    let ids = [
        "app.recipe.entry",
        "app.acme.calendar_event",
        "app.acme-publisher.recipe",
        boundary.as_str(),
    ];
    let definitions: Vec<_> = ids
        .iter()
        .map(|id| serde_json::json!({ "id": id, "fields": {} }))
        .collect();
    core.declare_types(&definitions).unwrap();
    let before = core.declared_types().unwrap();
    assert_eq!(before.len(), ids.len());
    for id in [
        format!("{boundary}a"),
        "app.recipe".into(),
        "keys.entry".into(),
    ] {
        assert!(
            matches!(
                core.declare_types(&[
                    definitions[0].clone(),
                    serde_json::json!({ "id": id, "fields": {} })
                ]),
                Err(CoreError::Invalid(_))
            ),
            "{id} was declared"
        );
        assert_eq!(core.declared_types().unwrap(), before);
    }
}

#[test]
fn a_declaration_is_refused_when_it_names_marfas_types_or_breaks_the_rules() {
    let core = Core::open_in_memory(None).unwrap();
    for (declaration, said) in [
        (serde_json::json!("app.x.entry"), "an object"),
        (serde_json::json!({ "fields": {} }), "names its id"),
        (
            serde_json::json!({ "id": "recipe" }),
            "not a type to declare",
        ),
        (
            serde_json::json!({ "id": "app.*" }),
            "not a type to declare",
        ),
        (serde_json::json!({ "id": "core.note" }), "Marfa's"),
        (serde_json::json!({ "id": "core.mine" }), "Marfa's"),
        (serde_json::json!({ "id": "system.mine" }), "Marfa's"),
        (
            serde_json::json!({ "id": "app.x.entry", "fields": [] }),
            "an object by name",
        ),
        (
            serde_json::json!({ "id": "app.x.entry", "fields": { "a": { "required": true } } }),
            "no type",
        ),
        (
            serde_json::json!({ "id": "app.x.entry", "fields": { "a": { "type": "nonsense" } } }),
            "not a field type",
        ),
        (
            serde_json::json!({ "id": "app.x.entry", "parent": "app.absent.entry" }),
            "neither a type Marfa ships nor one declared",
        ),
    ] {
        match core.declare_types(std::slice::from_ref(&declaration)) {
            Err(CoreError::Invalid(message)) => {
                assert!(message.contains(said), "{declaration}: {message}")
            }
            other => panic!("{declaration} was taken: {other:?}"),
        }
    }
    assert!(core.declared_types().unwrap().is_empty());
    // A parent may be declared in the same call, after its child, or be one
    // Marfa ships.
    core.declare_types(&[
        serde_json::json!({ "id": "app.child.entry", "parent": "app.parent.entry" }),
        serde_json::json!({ "id": "app.parent.entry", "parent": "core.note" }),
    ])
    .unwrap();
    assert_eq!(core.declared_types().unwrap().len(), 2);
}

#[test]
fn an_unchanged_type_catalog_is_not_written_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let writer = Core::open(&path, None).unwrap();
    let reader = Core::open_reader(&path).unwrap();
    let catalog = [store::testing::wire_type("core.note", None, Some("title"))];
    let replace = |types: &[marfa_rules::wire::WireType]| {
        let mut conn = writer.conn().unwrap();
        let tx = conn.transaction().unwrap();
        store::replace_types(&tx, types).unwrap();
        tx.commit().unwrap();
    };
    replace(&catalog);
    let before = reader.data_version().unwrap();
    replace(&catalog);
    assert_eq!(
        reader.data_version().unwrap(),
        before,
        "the same catalog was written again, and a reader was told of a save that changed nothing"
    );
    // The same catalog in another order is the same catalog.
    let two = [
        store::testing::wire_type("core.note", None, Some("title")),
        store::testing::wire_type("user.recipe", None, Some("title")),
    ];
    replace(&two);
    let before = reader.data_version().unwrap();
    replace(&[two[1].clone(), two[0].clone()]);
    assert_eq!(
        reader.data_version().unwrap(),
        before,
        "the same catalog in another order was written again"
    );
    replace(&[store::testing::wire_type("core.note", None, Some("body"))]);
    assert_ne!(reader.data_version().unwrap(), before);
}
