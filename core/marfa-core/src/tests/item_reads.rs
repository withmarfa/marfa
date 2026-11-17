use super::*;

#[test]
fn a_row_with_unreadable_properties_stays_in_a_kept_read_and_fails_a_refusing_one() {
    let core = held_copy();
    {
        let conn = core.conn().unwrap();
        for id in ["torn", "bare", "calm"] {
            let row = store::testing::note(id, id, "zebra", "2026-01-01T00:00:00Z");
            store::put_server_item(
                &conn,
                &row,
                Some(&[]),
                &marfa_rules::catalog::Catalog::empty(),
            )
            .unwrap();
        }
        // A conflicted copy of "row", whose properties are among the damaged.
        let copy = store::testing::note("copy", "copy", "kept", "2026-01-01T00:00:00Z");
        store::put_server_item(
            &conn,
            &copy,
            Some(&[CONFLICTED_COPY_TAG.to_string()]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("derived", "copy", "row", CONFLICTED_COPY_EDGE),
        )
        .unwrap();
        conn.execute("UPDATE items SET properties = '' WHERE id = 'copy'", [])
            .unwrap();
        let unreadable = |table: &str, id: &str, text: &str| {
            conn.execute(
                &format!("UPDATE {table} SET properties = ?1 WHERE id = ?2"),
                [text, id],
            )
            .unwrap();
        };
        // Text that is not JSON, and JSON that is not an object.
        unreadable("items", "torn", r#"{"title":"#);
        unreadable("items", "bare", "[1]");
        unreadable("edges", "link", "{");
    }
    let filters = ListFilters::default();
    let search = SearchFilters::default();

    // The witness: each refusing read fails whole on the same store.
    assert!(matches!(
        core.list_shown(&filters, Sort::default()),
        Err(CoreError::Store(message)) if message.contains("torn") || message.contains("bare")
    ));
    assert!(core.search_shown("zebra", &search, 10).is_err());
    assert!(core.get_shown("torn").is_err());
    assert!(core.edges_from("row").is_err());

    let kept = core.list_kept(&filters, Sort::default()).unwrap().rows;
    let ids: Vec<&str> = kept.iter().map(|(item, _)| item.id.as_str()).collect();
    assert_eq!(ids.len(), 5, "{ids:?}");
    for (item, shown) in &kept {
        match item.id.as_str() {
            "row" | "calm" => assert_eq!(shown.unreadable_properties, None),
            id => {
                assert!(item.properties.is_empty(), "{id}");
                assert!(shown.unreadable_properties.is_some(), "{id}");
                assert_eq!(shown.title, None);
            }
        }
    }
    let torn = &kept.iter().find(|(item, _)| item.id == "torn").unwrap().1;
    let reason = torn.unreadable_properties.as_deref().unwrap();
    assert!(reason.contains("not JSON"), "{reason}");
    assert!(
        !reason.contains("title"),
        "the stored text is not echoed: {reason}"
    );
    let bare = &kept.iter().find(|(item, _)| item.id == "bare").unwrap().1;
    assert!(
        bare.unreadable_properties
            .as_deref()
            .unwrap()
            .contains("not a JSON object")
    );

    // A damaged row matches no property condition, so a filtered list and
    // a filtered search leave it out and still answer.
    let titled = |title: &str| format!(r#"properties.title eq "{title}""#);
    let only_calm = core
        .list_kept(
            &ListFilters {
                filter: Some(titled("calm")),
                ..ListFilters::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
    assert_eq!(
        only_calm
            .iter()
            .map(|(item, _)| item.id.as_str())
            .collect::<Vec<_>>(),
        ["calm"]
    );
    let found = core
        .search_kept(
            "zebra",
            &SearchFilters {
                filter: Some(titled("calm")),
                ..SearchFilters::default()
            },
            10,
        )
        .unwrap()
        .rows;
    assert_eq!(
        found
            .iter()
            .map(|(hit, _)| hit.item.id.as_str())
            .collect::<Vec<_>>(),
        ["calm"]
    );

    let hits = core.search_kept("zebra", &search, 10).unwrap().rows;
    assert_eq!(hits.len(), 3);
    assert_eq!(
        hits.iter()
            .filter(|(hit, shown)| hit.item.properties.is_empty()
                && shown.unreadable_properties.is_some())
            .count(),
        2
    );
    let (item, shown) = core.get_kept("torn").unwrap().unwrap();
    assert!(item.properties.is_empty() && shown.unreadable_properties.is_some());
    assert_eq!(
        core.get_kept("row")
            .unwrap()
            .unwrap()
            .1
            .unreadable_properties,
        None
    );

    assert!(core.conflicted_copies_of("row").is_err());
    let copies = core.conflicted_copies_kept("row").unwrap();
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0].0.id, "copy");
    assert!(copies[0].0.properties.is_empty() && copies[0].1.unreadable_properties.is_some());

    let edges = core.edges_from_kept("row").unwrap();
    assert_eq!(edges.len(), 1);
    assert!(edges[0].0.properties.is_empty() && edges[0].1.is_some());
    assert_eq!(core.edges_to_kept("row").unwrap().len(), 2);
    assert_eq!(core.edges_of_type_kept("references").unwrap().len(), 1);

    // Contained to the row: a write to a readable row still queues.
    core.update_item(
        "calm",
        &Edit {
            properties: properties(serde_json::json!({ "body": "next" })),
            base_version: Some(1),
            ..Edit::default()
        },
    )
    .unwrap();
    assert!(
        core.update_item(
            "torn",
            &Edit {
                properties: properties(serde_json::json!({ "body": "next" })),
                base_version: Some(1),
                ..Edit::default()
            },
        )
        .is_err()
    );
}

#[test]
fn every_edge_of_one_type_is_read_at_once() {
    let core = Core::open_in_memory(None).unwrap();
    // A copy that has never reached a server answers from what it holds,
    // which is nothing yet.
    assert_eq!(core.edges_of_type("in-thread"), Ok(Vec::new()));
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
    }
    assert_eq!(
        core.edges_of_type("in-thread"),
        Err(CoreError::HydrationIncomplete)
    );
    {
        let conn = core.conn().unwrap();
        store::meta_delete(&conn, store::META_HYDRATE_STATE).unwrap();
    }
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        for id in ["root", "first", "second"] {
            let row = store::testing::note(id, id, id, "2026-01-01T00:00:00Z");
            store::upsert_item(
                &conn,
                &row,
                None,
                &marfa_rules::catalog::Indexing::default(),
            )
            .unwrap();
        }
        for (id, source, target, edge_type) in [
            ("reply-first", "first", "root", "in-thread"),
            ("cites", "first", "second", "references"),
            ("reply-second", "second", "root", "in-thread"),
        ] {
            store::upsert_edge(
                &conn,
                &store::testing::wire_edge(id, source, target, edge_type),
            )
            .unwrap();
        }
    }
    let queued = core
        .create_edge(&EdgeDraft {
            from_id: "root".into(),
            to_id: "first".into(),
            edge_type: "in-thread".into(),
            ..Default::default()
        })
        .unwrap();
    let ids = |edge_type: &str| -> Vec<String> {
        core.edges_of_type(edge_type)
            .unwrap()
            .into_iter()
            .map(|edge| edge.id)
            .collect()
    };
    assert_eq!(
        ids("in-thread"),
        vec![
            "reply-first".to_string(),
            "reply-second".to_string(),
            queued.edge_id.unwrap(),
        ],
        "the read is not every edge of the type the copy holds, the unanswered one with them"
    );
    assert_eq!(ids("references"), vec!["cites".to_string()]);
    assert!(ids("attached-to").is_empty());
}

#[test]
fn a_thumbnail_is_read_from_the_held_row_and_never_searched() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    let server = crate::scripted::Scripted::start();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(
            &conn,
            store::META_SLICE_TYPES,
            "[\"core.note\",\"acme.photo\"]",
        )
        .unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
        photo.rest.insert(
            "fields".into(),
            serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
        );
        store::replace_types(
            &conn,
            &[
                store::testing::wire_type("core.note", None, Some("title")),
                photo,
                store::testing::wire_type("acme.photo.raw", Some("acme.photo"), None),
            ],
        )
        .unwrap();
    }
    // A PNG's signature, then base64 that spells a word a search could
    // find: `/` splits it into a token of its own.
    let data = "iVBORw0KGgoA/unicornsXYZ";
    let thumbnail = format!("data:image/png;base64,{data}");
    let create = |r#type: &str, properties: Value| {
        core.create_item(&Draft {
            r#type: r#type.into(),
            properties: properties.as_object().unwrap().clone(),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap()
    };
    let photo = create(
        "acme.photo",
        serde_json::json!({ "title": "Holiday", "thumbnail": thumbnail }),
    );
    let raw = create(
        "acme.photo.raw",
        serde_json::json!({ "title": "Raw", "thumbnail": thumbnail }),
    );
    let note = create(
        "core.note",
        serde_json::json!({ "title": "Plain", "body": "b" }),
    );

    let held = core
        .thumbnail(&photo)
        .unwrap()
        .expect("the photo's thumbnail");
    assert_eq!(held.mime_type, "image/png");
    assert_eq!(
        held.bytes,
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap()
    );
    assert_eq!(
        core.thumbnail(&raw).unwrap().map(|found| found.bytes),
        Some(held.bytes.clone()),
        "a subtype's item lost the thumbnail its parent declares"
    );
    assert_eq!(core.thumbnail(&note).unwrap(), None);
    assert!(
        matches!(core.thumbnail("not-held"), Err(CoreError::NotFound { code, .. }) if code == "not_held"),
        "an item the copy does not hold read as one that carries no thumbnail"
    );
    let bare = create("acme.photo", serde_json::json!({ "title": "Bare" }));
    assert_eq!(core.thumbnail(&bare).unwrap(), None);
    let broken = server_held_item(
        &core,
        "acme.photo",
        serde_json::json!({ "title": "Broken", "thumbnail": "data:image/png;base64,***" }),
    );
    assert!(matches!(
        core.thumbnail(&broken),
        Err(CoreError::Decoding(_))
    ));
    assert_eq!(
        server.asked(),
        0,
        "a thumbnail was asked of the server rather than read from the row the copy holds"
    );

    let found = |query: &str| {
        core.search(query, &SearchFilters::default(), 10)
            .unwrap()
            .rows
            .into_iter()
            .map(|hit| hit.item.id)
            .collect::<Vec<_>>()
    };
    let witness = create(
        "core.note",
        serde_json::json!({ "title": "Beside", "body": "unicornsXYZ" }),
    );
    assert_eq!(found("unicornsXYZ"), vec![witness]);
    assert_eq!(found("Holiday"), vec![photo]);

    assert_eq!(
        server.asked(),
        0,
        "a read or a search asked the server rather than the copy"
    );
    let _ = core.drain();
    assert!(
        server.asked() > 0,
        "the drain reached no server, so the silence above is the transport's"
    );
}

#[test]
fn a_field_leaves_the_index_when_the_catalog_stops_declaring_it_a_string() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let photo = |cover: &str| {
        let mut wire = store::testing::wire_type("acme.photo", None, Some("title"));
        wire.rest.insert(
            "fields".into(),
            serde_json::json!({ "cover": { "type": cover } }),
        );
        wire
    };
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::replace_types(&conn, &[photo("string")]).unwrap();
    }
    let id = core
        .create_item(&Draft {
            r#type: "acme.photo".into(),
            properties: serde_json::json!({
                "title": "Holiday",
                "cover": "unicornsXYZ",
                "undeclared": "narwhalsABC",
            })
            .as_object()
            .unwrap()
            .clone(),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap();
    let found = |query: &str| {
        core.search(query, &SearchFilters::default(), 10)
            .unwrap()
            .rows
            .into_iter()
            .map(|hit| hit.item.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
    assert!(
        found("narwhalsABC").is_empty(),
        "a property the type does not declare was indexed"
    );
    let adopt = |wire| {
        let conn = core.conn().unwrap();
        store::replace_types(&conn, &[wire]).unwrap();
    };
    adopt(photo("thumbnail"));
    assert!(
        found("unicornsXYZ").is_empty(),
        "the catalog made the field a thumbnail and the row's index entry still holds its text"
    );
    assert_eq!(found("Holiday"), vec![id.clone()]);
    adopt(photo("string"));
    assert_eq!(found("unicornsXYZ"), vec![id.clone()]);
}

#[test]
fn an_unreadable_thumbnail_is_refused_naming_its_item() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
    photo.rest.insert(
        "fields".into(),
        serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
    );
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::replace_types(&conn, &[photo]).unwrap();
    }
    let id = server_held_item(
        &core,
        "acme.photo",
        serde_json::json!({"title": "Old", "thumbnail": "hello"}),
    );
    match core.thumbnail(&id) {
        Err(CoreError::Decoding(reason)) => assert!(reason.starts_with(&id), "{reason}"),
        other => panic!("an unreadable thumbnail read as {other:?}"),
    }
}

#[test]
fn a_thumbnail_that_is_not_text_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let mut photo = store::testing::wire_type("acme.photo", None, Some("title"));
    photo.rest.insert(
        "fields".into(),
        serde_json::json!({ "thumbnail": { "type": "thumbnail" } }),
    );
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.photo\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::replace_types(&conn, &[photo]).unwrap();
    }
    let holding = |value: Value| {
        server_held_item(
            &core,
            "acme.photo",
            serde_json::json!({"title": "Held", "thumbnail": value}),
        )
    };
    assert_eq!(core.thumbnail(&holding(Value::Null)).unwrap(), None);
    for value in [
        serde_json::json!(42),
        serde_json::json!(true),
        serde_json::json!(["data:image/png;base64,iVBORw0KGgo="]),
        serde_json::json!({ "data": "iVBORw0KGgo=" }),
    ] {
        let id = holding(value.clone());
        match core.thumbnail(&id) {
            Err(CoreError::Decoding(reason)) => assert!(reason.starts_with(&id), "{reason}"),
            other => panic!("a thumbnail held as {value} read as {other:?}"),
        }
    }
}
