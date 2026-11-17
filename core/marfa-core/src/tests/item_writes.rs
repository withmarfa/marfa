use super::*;

#[test]
fn an_edit_records_what_it_read_only_on_the_version_held() {
    let conn = store::open_in_memory().unwrap();
    let mut row = store::testing::note("row", "title", "held", "2026-01-01T00:00:00Z");
    row.version = 5;
    store::upsert_item(
        &conn,
        &row,
        None,
        &marfa_rules::catalog::Indexing::default(),
    )
    .unwrap();
    store::replace_types(
        &conn,
        &[store::testing::wire_type("core.note", None, Some("title"))],
    )
    .unwrap();
    let catalog = crate::catalog::load(&conn).unwrap();
    let edit = |base| Edit {
        properties: serde_json::json!({ "body": "edited", "notes": "new" })
            .as_object()
            .unwrap()
            .clone(),
        base_version: Some(base),
        source_id: None,
        ..Edit::default()
    };
    let held = queue_update(&conn, &catalog, "row", &edit(5), &[], Based::OnHeld).unwrap();
    let read: Value =
        serde_json::from_str(&store::read_of(&conn, &held.id).unwrap().unwrap()).unwrap();
    assert_eq!(
        read,
        serde_json::json!({ "properties": { "body": "held", "notes": null } })
    );
    let earlier = queue_update(&conn, &catalog, "row", &edit(3), &[], Based::AsRead).unwrap();
    assert_eq!(store::read_of(&conn, &earlier.id).unwrap(), None);
}

fn clearing_copy() -> Core {
    let core = held_copy();
    let mut row = store::testing::wire_item(
        "row",
        "core.note",
        "active",
        "2026-01-01T00:00:00Z",
        serde_json::json!({
            "title": "server",
            "body": "body",
            "notes": "to clear",
            "courier": { "nested": ["undeclared", 1] },
        }),
    );
    row.version = 3;
    store::put_server_item(
        &core.conn().unwrap(),
        &row,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    core
}

fn clear(base: i64, names: &[&str]) -> Edit {
    Edit {
        base_version: Some(base),
        clear_properties: names.iter().map(|name| (*name).to_string()).collect(),
        ..Edit::default()
    }
}

#[test]
fn a_clear_removes_only_the_properties_it_names_and_sends_them() {
    let core = clearing_copy();
    let queued = core
        .update_item("row", &clear(3, &["notes", "never-held"]))
        .unwrap();
    assert_eq!(
        core.get("row").unwrap().unwrap().properties,
        properties(serde_json::json!({
            "title": "server",
            "body": "body",
            "courier": { "nested": ["undeclared", 1] },
        }))
    );
    let queue = core.queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue[0].body,
        serde_json::json!({
            "properties": {},
            "version": 3,
            "clear_properties": ["notes", "never-held"],
        })
    );
    let read: Value = serde_json::from_str(
        &store::read_of(&core.conn().unwrap(), &queued.id)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        read,
        serde_json::json!({ "properties": { "notes": "to clear", "never-held": null } })
    );
}

#[test]
fn a_clear_beside_a_set_lays_both_and_refuses_one_name_in_both() {
    let core = clearing_copy();
    let both = Edit {
        properties: properties(serde_json::json!({ "notes": "new" })),
        ..clear(3, &["notes"])
    };
    let before = core.get("row").unwrap();
    let Err(CoreError::Validation { code, message, .. }) = core.update_item("row", &both) else {
        panic!("a property both set and cleared was queued");
    };
    assert_eq!(code, "validation_error");
    assert!(message.contains("notes"), "{message}");
    assert_eq!(core.get("row").unwrap(), before);
    assert!(core.queue().unwrap().is_empty());

    assert!(matches!(
        core.update_item("row", &clear(3, &[""])),
        Err(CoreError::Validation { .. })
    ));
    assert!(core.queue().unwrap().is_empty());

    // The witness: setting one property and clearing another is queued.
    let apart = Edit {
        properties: properties(serde_json::json!({ "title": "mine" })),
        ..clear(3, &["notes"])
    };
    core.update_item("row", &apart).unwrap();
    let shown = core.get("row").unwrap().unwrap().properties;
    assert_eq!(shown.get("title"), Some(&Value::from("mine")));
    assert!(!shown.contains_key("notes"));
}

#[test]
fn a_clear_of_a_required_field_is_refused_on_the_held_and_an_earlier_version() {
    let core = validation_copy();
    let mut row = store::testing::wire_item(
        "typed",
        "acme.child",
        "active",
        "2026-01-01T00:00:00Z",
        serde_json::json!({ "title": "valid", "read": true }),
    );
    row.version = 3;
    store::put_server_item(
        &core.conn().unwrap(),
        &row,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    for (based, edit) in [
        (Based::OnHeld, clear(3, &["title"])),
        (Based::AsRead, clear(1, &["title"])),
    ] {
        let refused = match based {
            Based::OnHeld => core.update_item("typed", &edit),
            Based::AsRead => core.update_item_as_read("typed", &edit),
            Based::Exact => unreachable!("not among the cases"),
        };
        let Err(CoreError::Validation { code, .. }) = refused else {
            panic!("a clear of a required field was queued: {refused:?}");
        };
        assert_eq!(code, "invalid_properties");
        assert!(core.queue().unwrap().is_empty());
    }
    // The witness: an optional field clears.
    core.update_item("typed", &clear(3, &["read"])).unwrap();
    assert!(
        !core
            .get("typed")
            .unwrap()
            .unwrap()
            .properties
            .contains_key("read")
    );
}

#[test]
fn a_waiting_clear_stays_shown_over_a_newer_server_row_and_keeps_what_it_did_not_name() {
    let core = clearing_copy();
    core.update_item("row", &clear(3, &["notes"])).unwrap();
    let conn = core.conn().unwrap();
    let mut newer = store::testing::wire_item(
        "row",
        "core.note",
        "active",
        "2026-01-01T00:00:00Z",
        serde_json::json!({
            "title": "changed elsewhere",
            "body": "body",
            "notes": "to clear",
            "courier": { "nested": ["undeclared", 1] },
            "added": "since",
        }),
    );
    newer.version = 4;
    store::put_server_item(&conn, &newer, None, &marfa_rules::catalog::Catalog::empty()).unwrap();
    store::lay_waiting_writes_over(&conn, "row", &|_| marfa_rules::catalog::Indexing::default())
        .unwrap();
    drop(conn);
    assert_eq!(
        core.get("row").unwrap().unwrap().properties,
        properties(serde_json::json!({
            "title": "changed elsewhere",
            "body": "body",
            "courier": { "nested": ["undeclared", 1] },
            "added": "since",
        }))
    );
}

#[test]
fn a_moved_clear_drops_a_name_it_never_read_a_value_for() {
    let core = clearing_copy();
    let queued = core
        .update_item("row", &clear(3, &["notes", "never-held"]))
        .unwrap();
    let conn = core.conn().unwrap();
    store::move_edit(&conn, &queued.id, 5, None).unwrap();
    let body: Value = serde_json::from_str(&store::payload_of(&conn, &queued.id).unwrap()).unwrap();
    assert_eq!(body["version"], 5);
    // On version 5 the server would remove a `never-held` written since,
    // which this edit never saw.
    assert_eq!(body["clear_properties"], serde_json::json!(["notes"]));
}

#[test]
fn a_create_with_state_location_and_edges_is_one_write_the_copy_already_shows() {
    let core = held_copy();
    let target = server_held_item(&core, "core.note", serde_json::json!({}));
    let draft = Draft {
        r#type: "core.note".into(),
        properties: serde_json::json!({ "title": "Pinned" })
            .as_object()
            .unwrap()
            .clone(),
        state: Some(ItemState::Archived),
        capture_latitude: Some(51.5),
        capture_longitude: Some(-0.25),
        edges: [("references".to_string(), vec![target.clone()])].into(),
        ..Default::default()
    };
    let queued = core.create_item(&draft).unwrap();
    let id = queued.item_id.clone().unwrap();
    // One write carries all three, as the server takes them.
    let writes = core.queue().unwrap();
    assert_eq!(writes.len(), 1);
    let body: Value =
        serde_json::from_str(&store::payload_of(&core.conn().unwrap(), &queued.id).unwrap())
            .unwrap();
    assert_eq!(body["state"], "archived");
    assert_eq!(body["capture_latitude"], 51.5);
    assert_eq!(body["edges"], serde_json::json!({ "references": [target] }));
    let shown = core.get(&id).unwrap().unwrap();
    assert_eq!(shown.state, ItemState::Archived);
    assert_eq!(
        (shown.capture_latitude, shown.capture_longitude),
        (Some(51.5), Some(-0.25))
    );
    let edges = core.edges_from(&id).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(
        (edges[0].to_id.as_str(), edges[0].edge_type.as_str()),
        (target.as_str(), "references")
    );
}

#[test]
fn an_edit_sets_the_items_own_time_and_clearing_it_returns_the_creation_time() {
    let core = held_copy();
    let edit = |change: Edit| {
        let version = core.get("row").unwrap().unwrap().version;
        core.update_item(
            "row",
            &Edit {
                base_version: Some(version),
                ..change
            },
        )
    };
    edit(Edit {
        occurred_at: Some("2025-06-01T12:00:00Z".into()),
        ..Default::default()
    })
    .unwrap();
    let held = core.get("row").unwrap().unwrap();
    assert_eq!(held.occurred_at, "2025-06-01T12:00:00.000Z");
    edit(Edit {
        clear_occurred_at: true,
        ..Default::default()
    })
    .unwrap();
    let cleared = core.get("row").unwrap().unwrap();
    assert_eq!(cleared.occurred_at, "2026-01-01T00:00:00.000Z");
    assert!(matches!(
        edit(Edit {
            occurred_at: Some("2025-06-01T12:00:00Z".into()),
            clear_occurred_at: true,
            ..Default::default()
        }),
        Err(CoreError::Invalid(_))
    ));
}

#[test]
fn a_keyed_create_naming_no_tier_leaves_the_held_rows_tier_and_sends_none() {
    for slice in ["all", "feed"] {
        let core = held_copy();
        {
            let conn = core.conn().unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, slice).unwrap();
            let mut inbox = store::testing::note("inbox", "server", "body", "2026-01-01T00:00:00Z");
            inbox.tier = Some("feed".into());
            inbox.source = "reader".into();
            inbox.source_id = Some("article-1".into());
            store::put_server_item(
                &conn,
                &inbox,
                Some(&[]),
                &marfa_rules::catalog::Catalog::empty(),
            )
            .unwrap();
        }
        let keyed = |source_id: &str| Draft {
            r#type: "core.note".into(),
            properties: properties(serde_json::json!({ "title": "Synced", "body": "again" })),
            source: Some("reader".into()),
            source_id: Some(source_id.into()),
            ..Default::default()
        };
        let resynced = core.create_item(&keyed("article-1")).unwrap();
        // The witness: a key naming no held row is queued at the slice's
        // tier, which the drain sends where a lookup finds no row.
        let fresh = core.create_item(&keyed("article-2")).unwrap();
        // A key naming a create still waiting is queued at that create's tier,
        // which it lands at whether or not the first is refused.
        let again = core.create_item(&keyed("article-2")).unwrap();
        let shown = |write: &QueuedWrite| {
            core.get(write.item_id.as_deref().unwrap())
                .unwrap()
                .unwrap()
                .tier
        };
        assert_eq!(shown(&resynced), Some(Tier::Feed), "{slice}");
        let conn = core.conn().unwrap();
        let sent = |write: &QueuedWrite| {
            serde_json::from_str::<Value>(&store::payload_of(&conn, &write.id).unwrap())
                .unwrap()
                .get("tier")
                .cloned()
        };
        assert_eq!(
            sent(&resynced),
            None,
            "a resync from a slice at {slice} moved the row"
        );
        let slice_tier: SliceTier = slice.parse().unwrap();
        assert_eq!(
            sent(&fresh),
            Some(Value::String(slice_tier.create_tier().as_str().into())),
            "{slice}"
        );
        assert_eq!(sent(&again), sent(&fresh), "{slice}");
        assert!(!store::pinned(&conn, resynced.item_id.as_deref().unwrap()).unwrap());

        // Laid back over a copy hydrated again, the re-save shows the tier
        // of the row its key names.
        let resynced_id = resynced.item_id.clone().unwrap();
        store::clear_slice(&conn).unwrap();
        let mut inbox = store::testing::note("inbox", "server", "body", "2026-01-01T00:00:00Z");
        inbox.tier = Some("feed".into());
        inbox.source = "reader".into();
        inbox.source_id = Some("article-1".into());
        store::put_server_item(
            &conn,
            &inbox,
            Some(&[]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
        assert!(!store::item_held(&conn, &resynced_id).unwrap());
        let catalog = crate::catalog::load(&conn).unwrap();
        hydrate::lay_queue_over(&conn, &catalog, &[], None).unwrap();
        assert_eq!(
            store::items_by_ids(&conn, std::slice::from_ref(&resynced_id))
                .unwrap()
                .pop()
                .and_then(|item| item.tier),
            Some(Tier::Feed),
            "{slice}"
        );
    }
}

#[test]
fn a_create_naming_no_tier_takes_the_slices_and_library_in_a_slice_of_both() {
    for (slice, named, sent, pinned) in [
        ("all", None, Tier::Library, false),
        ("all", Some(Tier::Feed), Tier::Feed, false),
        ("feed", None, Tier::Feed, false),
        ("library", None, Tier::Library, false),
        // The witness that a create the slice does not hold is told apart.
        ("library", Some(Tier::Feed), Tier::Feed, true),
    ] {
        let core = held_copy();
        store::meta_set(&core.conn().unwrap(), store::META_SLICE_TIER, slice).unwrap();
        let queued = core
            .create_item(&Draft {
                r#type: "core.note".into(),
                properties: properties(serde_json::json!({ "title": "Inbox" })),
                tier: named,
                ..Default::default()
            })
            .unwrap();
        let id = queued.item_id.clone().unwrap();
        assert_eq!(
            core.get(&id).unwrap().unwrap().tier,
            Some(sent),
            "shown from a slice at {slice}"
        );
        let conn = core.conn().unwrap();
        let body: Value =
            serde_json::from_str(&store::payload_of(&conn, &queued.id).unwrap()).unwrap();
        assert_eq!(body["tier"], sent.as_str(), "sent from a slice at {slice}");
        assert_eq!(
            store::pinned(&conn, &id).unwrap(),
            pinned,
            "pinned from a slice at {slice}"
        );
    }
}
