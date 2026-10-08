use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::remote::request::{Body, Method, Request};
use crate::values::Tier;

fn query(request: &Request, key: &str) -> Option<String> {
    request
        .query
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

fn body(request: &Request) -> &serde_json::Value {
    match &request.body {
        Body::Json(value) => value,
        other => panic!("expected a JSON body, got {other:?}"),
    }
}

#[test]
fn a_listing_sends_only_the_filters_it_was_given() {
    let request = items::list_request(&items::ListArgs {
        type_: Some("core.note".into()),
        state: Some(StateFilter::Any),
        tags: vec!["a".into(), "b".into()],
        occurred_after: Some("2026-01-01T00:00:00Z".into()),
        page: PageArgs {
            limit: Some(5),
            cursor: Some("c1".into()),
        },
        ..Default::default()
    });
    assert_eq!(request.method, Method::Get);
    assert_eq!(request.path(), "/items");
    assert_eq!(query(&request, "type").as_deref(), Some("core.note"));
    assert_eq!(query(&request, "state").as_deref(), Some("any"));
    assert_eq!(query(&request, "tags").as_deref(), Some("a,b"));
    assert_eq!(query(&request, "limit").as_deref(), Some("5"));
    assert_eq!(query(&request, "cursor").as_deref(), Some("c1"));
    // An empty `source=` would match nothing.
    assert_eq!(query(&request, "source"), None);
    assert_eq!(query(&request, "tier"), None);
    assert_eq!(query(&request, "include"), None);
    let given = items::list_request(&items::ListArgs {
        source: Some("test/cli".into()),
        tier: Some(TierFilter::All),
        include: vec!["edges".into(), "metadata".into()],
        ..Default::default()
    });
    assert_eq!(query(&given, "source").as_deref(), Some("test/cli"));
    assert_eq!(query(&given, "tier").as_deref(), Some("all"));
    assert_eq!(query(&given, "include").as_deref(), Some("edges,metadata"));
}

#[test]
fn a_create_carries_the_properties_the_tags_and_only_the_fields_named() {
    let request = items::create_request(&items::CreateArgs {
        type_: "core.note".into(),
        properties: PropertyArgs {
            properties: Some(r#"{"title":"Hello"}"#.into()),
            props: vec!["status=draft".into()],
        },
        tags: vec!["inbox".into()],
        tier: Some(Tier::Feed),
        version: Some(3),
        idempotency: items::IdempotencyArgs {
            idempotency_key: Some("k1".into()),
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(request.method, Method::Post);
    assert_eq!(request.path(), "/items");
    assert_eq!(
        body(&request),
        &json!({
            "type": "core.note",
            "properties": { "title": "Hello", "status": "draft" },
            "tags": ["inbox"],
            "tier": "feed",
            "version": 3,
        })
    );
    assert!(
        request
            .headers
            .contains(&("Idempotency-Key".to_string(), "k1".to_string()))
    );
}

#[test]
fn a_property_given_both_ways_is_refused_rather_than_resolved() {
    let refused = PropertyArgs {
        properties: Some(r#"{"title":"one"}"#.into()),
        props: vec!["title=two".into()],
    }
    .read()
    .unwrap_err();
    assert!(refused.to_string().contains("title"), "{refused}");
    assert!(
        PropertyArgs {
            properties: Some("[1]".into()),
            props: vec![],
        }
        .read()
        .is_err(),
        "an array was accepted where the wire takes an object"
    );
}

#[test]
fn an_update_carries_the_version_and_asks_for_resolution_only_when_told() {
    let plain = items::update_request(&items::UpdateArgs {
        id: "i1".into(),
        version: 7,
        properties: PropertyArgs {
            properties: Some(r#"{"title":"new"}"#.into()),
            props: vec![],
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(plain.method, Method::Patch);
    assert_eq!(plain.path(), "/items/i1");
    assert_eq!(query(&plain, "conflict"), None);
    assert_eq!(
        body(&plain),
        &json!({ "version": 7, "properties": { "title": "new" } })
    );

    let resolved = items::update_request(&items::UpdateArgs {
        id: "i1".into(),
        version: 7,
        replace: true,
        source_id: Some("notes/new.md".into()),
        conflict: Some(items::Conflict::Auto),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(query(&resolved, "conflict").as_deref(), Some("auto"));
    assert_eq!(body(&resolved)["properties_mode"], "replace");
    assert_eq!(body(&resolved)["source_id"], "notes/new.md");
    // An empty object would clear everything under `--replace`.
    assert!(body(&resolved).get("properties").is_none());
}

#[test]
fn tags_go_on_as_a_list_and_come_off_one_at_a_time() {
    let on = items::tag_request("i", &["a".into(), "b".into()]);
    assert_eq!(on.method, Method::Post);
    assert_eq!(on.path(), "/items/i/tags");
    assert_eq!(body(&on), &json!({ "tags": ["a", "b"] }));
    let off = items::untag_request("i", "a");
    assert_eq!(off.method, Method::Delete);
    assert_eq!(off.path(), "/items/i/tags/a");
}

#[test]
fn an_item_edge_listing_names_the_direction_by_its_door() {
    let args = items::ItemEdgesArgs {
        id: "i".into(),
        type_: Some("references".into()),
        page: PageArgs::default(),
    };
    assert_eq!(items::edges_request(&args, false).path(), "/items/i/edges");
    assert_eq!(
        items::edges_request(&args, true).path(),
        "/items/i/backrefs"
    );
    assert_eq!(
        query(&items::edges_request(&args, false), "edge_type").as_deref(),
        Some("references")
    );
}

#[test]
fn an_item_history_pages_by_limit_and_cursor() {
    let bare = items::versions_request("i", &PageArgs::default());
    assert_eq!(bare.path(), "/items/i/versions");
    assert_eq!(query(&bare, "limit"), None);
    let page = PageArgs {
        limit: Some(2),
        cursor: Some("next".into()),
    };
    let paged = items::versions_request("i", &page);
    assert_eq!(query(&paged, "limit").as_deref(), Some("2"));
    assert_eq!(query(&paged, "cursor").as_deref(), Some("next"));
}

#[test]
fn a_bulk_action_wraps_the_filter_and_names_its_action() {
    let request = items::bulk_action_request(&items::BulkActionCommand::Transition {
        to: items::TransitionState::Trashed,
        filter: items::BulkFilterArgs {
            type_: Some("core.note".into()),
            tags: vec!["old".into()],
            dry_run: true,
            max_items: Some(10),
            ..Default::default()
        },
    })
    .unwrap();
    assert_eq!(request.path(), "/items/bulk-actions");
    assert_eq!(
        body(&request),
        &json!({
            "action": "transition",
            "state": "trashed",
            "filter": { "type": "core.note", "tags": ["old"] },
            "dry_run": true,
            "max_items": 10,
        })
    );
    let purge = items::bulk_action_request(&items::BulkActionCommand::Purge {
        confirm: Some("PURGE".into()),
        filter: items::BulkFilterArgs::default(),
    })
    .unwrap();
    assert_eq!(
        body(&purge),
        &json!({ "action": "purge", "confirm": "PURGE" })
    );
    let job =
        items::bulk_action_request(&items::BulkActionCommand::Job { id: "j".into() }).unwrap();
    assert_eq!(job.path(), "/items/bulk-actions/jobs/j");
    let cancel =
        items::bulk_action_request(&items::BulkActionCommand::Cancel { id: "j".into() }).unwrap();
    assert_eq!(cancel.method, Method::Post);
    assert_eq!(cancel.path(), "/items/bulk-actions/jobs/j/cancel");
}

#[test]
fn an_attachment_is_an_upload_a_file_item_and_an_edge() {
    let args = items::AttachArgs {
        id: "note".into(),
        file: PathBuf::from("diagram.png"),
        ..Default::default()
    };
    let mime_type = marfa_core::mime_type_for(&args.file, args.mime_type.as_deref());
    assert_eq!(mime_type, "image/png");
    let upload = items::upload_request(&args.file, &mime_type);
    assert_eq!(upload.method, Method::Post);
    assert_eq!(upload.path(), "/blobs");
    assert_eq!(
        upload.body,
        Body::File {
            path: PathBuf::from("diagram.png"),
            content_type: "image/png".into()
        }
    );
    let item = items::file_item_request(&args, &mime_type, "sha256:abc");
    assert_eq!(
        body(&item),
        &json!({
            "type": "core.file.image",
            "properties": { "blob_ref": "sha256:abc", "mime_type": "image/png", "title": "diagram.png" },
        })
    );
    let edge = items::attached_to_request("file-item", "note");
    assert_eq!(
        body(&edge),
        &json!({ "source_id": "file-item", "target_id": "note", "edge_type": "attached-to" })
    );
}

#[test]
fn a_file_added_on_its_own_is_a_file_item_with_its_tags_and_tier() {
    let args = items::AddArgs {
        file: PathBuf::from("talk.pptx"),
        tags: vec!["work".into(), "slides".into()],
        tier: Some(Tier::Feed),
        ..Default::default()
    };
    let mime_type = marfa_core::mime_type_for(&args.file, args.mime_type.as_deref());
    assert_eq!(
        mime_type,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    let item = items::added_file_request(&args, &mime_type, "sha256:abc");
    assert_eq!(item.path(), "/items");
    assert_eq!(
        body(&item),
        &json!({
            "type": "core.file",
            "properties": { "blob_ref": "sha256:abc", "mime_type": mime_type, "title": "talk.pptx" },
            "tags": ["work", "slides"],
            "tier": "feed",
        })
    );
    let bare = items::added_file_request(
        &items::AddArgs {
            file: PathBuf::from("photo.jpeg"),
            title: Some("Harbor".into()),
            ..Default::default()
        },
        "image/jpeg",
        "sha256:abc",
    );
    assert_eq!(
        body(&bare),
        &json!({
            "type": "core.file.image",
            "properties": { "blob_ref": "sha256:abc", "mime_type": "image/jpeg", "title": "Harbor" },
        })
    );
}

#[test]
fn edges_are_created_between_two_items_and_updated_under_a_version() {
    let created = edges::create_request(&edges::EdgeCreateArgs {
        source: "a".into(),
        target: "b".into(),
        type_: "references".into(),
        properties: Some(r#"{"weight":1}"#.into()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(created.path(), "/edges");
    assert_eq!(
        body(&created),
        &json!({ "source_id": "a", "target_id": "b", "edge_type": "references", "properties": { "weight": 1 } })
    );
    let updated = edges::update_request("e", Some(r#"{"weight":2}"#), (None, None), 4).unwrap();
    assert_eq!(updated.method, Method::Patch);
    assert_eq!(
        body(&updated),
        &json!({ "properties": { "weight": 2 }, "version": 4 })
    );
    let moved = edges::update_request("e", None, (None, Some("c".into())), 5).unwrap();
    assert_eq!(body(&moved), &json!({ "target_id": "c", "version": 5 }));
    assert_eq!(edges::delete_request("e").method, Method::Delete);
    let listed = edges::list_request(&edges::EdgeListArgs {
        type_: Some("about".into()),
        updated_after: Some("t".into()),
        ..Default::default()
    });
    assert_eq!(query(&listed, "edge_type").as_deref(), Some("about"));
    assert_eq!(query(&listed, "updated_after").as_deref(), Some("t"));
}

#[test]
fn a_search_sends_its_query_and_its_narrowing() {
    let request = search::request(&search::SearchArgs {
        query: "zebra crossing".into(),
        state: Some(StateFilter::Archived),
        tier: Some(TierFilter::All),
        page: PageArgs {
            limit: Some(3),
            cursor: Some("c6".into()),
        },
        ..Default::default()
    });
    assert_eq!(request.path(), "/search");
    assert_eq!(query(&request, "q").as_deref(), Some("zebra crossing"));
    assert_eq!(query(&request, "state").as_deref(), Some("archived"));
    assert_eq!(query(&request, "tier").as_deref(), Some("all"));
    assert_eq!(query(&request, "limit").as_deref(), Some("3"));
    assert_eq!(query(&request, "cursor").as_deref(), Some("c6"));
}

#[test]
fn an_extension_namespace_is_written_whole_and_must_be_an_object() {
    let written = extensions::write_request("i", "app.cursor", json!({ "at": 3 })).unwrap();
    assert_eq!(written.method, Method::Put);
    assert_eq!(written.path(), "/items/i/extensions/app.cursor");
    assert!(extensions::write_request("i", "app.cursor", json!([1])).is_err());
    assert_eq!(
        extensions::delete_request("i", "app.cursor").method,
        Method::Delete
    );
}

#[test]
fn types_are_reached_at_their_doors_and_a_forced_delete_says_so() {
    assert_eq!(types::get_request("core.note").path(), "/types/core.note");
    assert_eq!(types::register_request(json!({})).method, Method::Post);
    assert_eq!(
        types::replace_request("user.x", json!({})).method,
        Method::Put
    );
    assert_eq!(
        query(&types::delete_request("user.x", true), "force").as_deref(),
        Some("true")
    );
    assert_eq!(
        query(&types::delete_request("user.x", false), "force"),
        None
    );
    assert_eq!(types::drift_request().path(), "/platform-types/drift");
    assert_eq!(
        types::prune_request("core.gone").path(),
        "/platform-types/core.gone"
    );
    assert_eq!(
        edge_types::register_request(json!({})).path(),
        "/edge-types"
    );
    assert_eq!(edge_types::delete_request("x").method, Method::Delete);
}

#[test]
fn a_key_is_minted_with_exactly_the_reach_named() {
    let inherited = keys::create_request(&keys::KeyCreateArgs {
        label: "laptop".into(),
        source: "laptop-1".into(),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        body(&inherited),
        &json!({ "label": "laptop", "source": "laptop-1" })
    );
    let narrowed = keys::create_request(&keys::KeyCreateArgs {
        label: "app".into(),
        source: "app-1".into(),
        maps: keys::PermissionMapArgs {
            permissions: vec![keys::Permission::KeysMint],
            type_permissions: vec!["core.note=write".into()],
            profile_permissions: vec!["*=read".into()],
            ..Default::default()
        },
        default_tier: Some(Tier::Feed),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        body(&narrowed),
        &json!({
            "label": "app",
            "source": "app-1",
            "permissions": ["keys.mint"],
            "type_permissions": { "core.note": "write" },
            "profile_permissions": { "*": "read" },
            "default_tier": "feed",
        })
    );
    let inert = keys::create_request(&keys::KeyCreateArgs {
        label: "inert".into(),
        source: "audit-1".into(),
        no_permissions: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        body(&inert),
        &json!({
            "label": "inert",
            "source": "audit-1",
            "permissions": [],
            "type_permissions": {},
            "extension_permissions": {},
            "edge_permissions": {},
            "metadata_permissions": {},
            "profile_permissions": {},
        })
    );
    let claiming = keys::create_request(&keys::KeyCreateArgs {
        label: "folder".into(),
        source: "laptop-2".into(),
        claims: keys::ClaimArgs {
            claims: vec!["notes".into(), "photos".into()],
            no_claims: false,
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(body(&claiming)["sources"], json!(["notes", "photos"]));
    let claiming_none = keys::create_request(&keys::KeyCreateArgs {
        label: "plain".into(),
        source: "laptop-3".into(),
        claims: keys::ClaimArgs {
            claims: vec![],
            no_claims: true,
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(body(&claiming_none)["sources"], json!([]));
    assert_eq!(body(&inherited).get("sources"), None);
    let reclaimed = keys::update_request(&keys::KeyUpdateArgs {
        id: "k".into(),
        claims: keys::ClaimArgs {
            claims: vec!["notes".into()],
            no_claims: false,
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(body(&reclaimed), &json!({ "sources": ["notes"] }));
    let unclaimed = keys::update_request(&keys::KeyUpdateArgs {
        id: "k".into(),
        claims: keys::ClaimArgs {
            claims: vec![],
            no_claims: true,
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(body(&unclaimed), &json!({ "sources": [] }));
    let narrowed = keys::update_request(&keys::KeyUpdateArgs {
        id: "k".into(),
        no_permissions: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        body(&narrowed),
        &json!({
            "permissions": [],
            "type_permissions": {},
            "extension_permissions": {},
            "edge_permissions": {},
            "metadata_permissions": {},
            "profile_permissions": {},
        })
    );
    assert_eq!(keys::revoke_request("k").method, Method::Delete);
}

#[test]
fn a_key_update_can_empty_each_map_without_naming_other_reach() {
    let cases = [
        (
            "type_permissions",
            keys::KeyUpdateArgs {
                no_type_permissions: true,
                ..Default::default()
            },
        ),
        (
            "extension_permissions",
            keys::KeyUpdateArgs {
                no_extension_permissions: true,
                ..Default::default()
            },
        ),
        (
            "edge_permissions",
            keys::KeyUpdateArgs {
                no_edge_permissions: true,
                ..Default::default()
            },
        ),
        (
            "metadata_permissions",
            keys::KeyUpdateArgs {
                no_metadata_permissions: true,
                ..Default::default()
            },
        ),
        (
            "profile_permissions",
            keys::KeyUpdateArgs {
                no_profile_permissions: true,
                ..Default::default()
            },
        ),
    ];
    for (field, mut args) in cases {
        args.id = "key-id".into();
        let request = keys::update_request(&args).unwrap();
        assert_eq!(request.method, Method::Patch);
        assert_eq!(request.path(), "/keys/key-id");
        assert_eq!(body(&request), &json!({ (field): {} }));
    }
    let mixed = keys::update_request(&keys::KeyUpdateArgs {
        id: "key-id".into(),
        maps: keys::PermissionMapArgs {
            permissions: vec![keys::Permission::AuditRead],
            edge_permissions: vec!["references=write".into()],
            ..Default::default()
        },
        no_type_permissions: true,
        no_metadata_permissions: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        body(&mixed),
        &json!({
            "permissions": ["audit.read"],
            "edge_permissions": { "references": "write" },
            "type_permissions": {},
            "metadata_permissions": {},
        })
    );
}

#[test]
fn a_map_clear_conflicts_with_replacement_and_global_clear() {
    use clap::Parser;

    for (clear, replacement, value) in [
        (
            "--no-type-permissions",
            "--type-permission",
            "core.note=read",
        ),
        (
            "--no-extension-permissions",
            "--extension-permission",
            "app.cursor=read",
        ),
        (
            "--no-edge-permissions",
            "--edge-permission",
            "references=read",
        ),
        (
            "--no-metadata-permissions",
            "--metadata-permission",
            "types=read",
        ),
        (
            "--no-profile-permissions",
            "--profile-permission",
            "email=read",
        ),
    ] {
        let parsed = crate::Cli::try_parse_from(["marfa", "keys", "update", "key-id", clear]);
        assert!(parsed.is_ok(), "{clear}: {parsed:?}");
        let conflict = crate::Cli::try_parse_from([
            "marfa",
            "keys",
            "update",
            "key-id",
            clear,
            replacement,
            value,
        ]);
        assert!(conflict.is_err(), "{clear} accepted {replacement}");
        let global = crate::Cli::try_parse_from([
            "marfa",
            "keys",
            "update",
            "key-id",
            clear,
            "--no-permissions",
        ]);
        assert!(global.is_err(), "{clear} accepted --no-permissions");
    }
    let mixed = crate::Cli::try_parse_from([
        "marfa",
        "keys",
        "update",
        "key-id",
        "--no-type-permissions",
        "--metadata-permission",
        "types=read",
    ]);
    assert!(
        mixed.is_ok(),
        "distinct maps should be independent: {mixed:?}"
    );
}

#[test]
fn the_instance_doors_are_reached_where_the_document_puts_them() {
    assert_eq!(config::get_request().path(), "/config");
    assert_eq!(config::replace_request(json!({})).method, Method::Put);
    let exported = export::request(&export::ExportArgs {
        format: Some(export::ExportFormat::Archive),
        type_: Some("core.note".into()),
        ..Default::default()
    });
    assert_eq!(exported.path(), "/export");
    assert!(exported.stream);
    assert_eq!(query(&exported, "format").as_deref(), Some("archive"));
    let audited = audit::request(&audit::AuditArgs {
        action: Some("item.create".into()),
        created_after: Some("t".into()),
        ..Default::default()
    });
    assert_eq!(audited.path(), "/audit");
    assert_eq!(query(&audited, "action").as_deref(), Some("item.create"));
    let streamed = events::request(&events::EventsArgs {
        types: vec!["core.note".into(), "core.task".into()],
        edges: Some(events::EdgeMode::None),
        from: Some("41".into()),
        r#for: None,
    });
    assert_eq!(streamed.path(), "/events");
    assert!(streamed.stream);
    assert_eq!(
        query(&streamed, "type").as_deref(),
        Some("core.note,core.task")
    );
    assert_eq!(query(&streamed, "edges").as_deref(), Some("none"));
    assert!(
        streamed
            .headers
            .contains(&("Last-Event-ID".to_string(), "41".to_string()))
    );
    assert!(!status::root_request().credential);
    assert!(!status::health_request().credential);
    assert!(status::stats_request().credential);
}

#[test]
fn webhooks_are_registered_with_their_events_and_paused_by_a_flag() {
    let created = webhooks::create_request(&webhooks::WebhookCreateArgs {
        to: "https://hooks.example/in".into(),
        events: vec!["item.created".into()],
        ..Default::default()
    });
    assert_eq!(
        body(&created),
        &json!({ "url": "https://hooks.example/in", "events": ["item.created"] })
    );
    let paused = webhooks::update_request(&webhooks::WebhookUpdateArgs {
        id: "w".into(),
        inactive: true,
        ..Default::default()
    });
    assert_eq!(body(&paused), &json!({ "active": false }));
    assert_eq!(
        query(&webhooks::deliveries_request("w", Some(5)), "limit").as_deref(),
        Some("5")
    );
}

#[test]
fn redelivery_posts_without_a_body_or_minting() {
    let request = webhooks::redeliver_request("webhook id", "delivery/id");
    assert_eq!(request.method, Method::Post);
    assert_eq!(
        request.segments,
        [
            "webhooks",
            "webhook id",
            "deliveries",
            "delivery/id",
            "redeliver"
        ]
    );
    assert_eq!(request.body, Body::None);
    assert!(request.credential);
    assert!(!request.mints);
}

#[test]
fn blobs_are_fetched_as_a_stream_and_a_link_carries_its_ttl() {
    let download = blobs::download_request("sha256:abc");
    assert_eq!(download.path(), "/blobs/sha256:abc");
    assert!(download.stream);
    assert_eq!(
        query(&blobs::url_request("sha256:abc", Some(60)), "ttl").as_deref(),
        Some("60")
    );
}

#[test]
fn a_folder_takes_its_settings_from_json_and_flags_and_refuses_one_given_twice() {
    let created = folders::create_request(&folders::CreateArgs {
        settings: folders::SettingsArgs {
            body: Some(r#"{"search":{"types":["core.note"]}}"#.into()),
            title: Some("Project".into()),
            include: vec!["*.md".into()],
            first_placement: vec!["core.note=Notes".into()],
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap();
    assert_eq!(created.method, Method::Post);
    assert_eq!(created.path(), "/folders");
    assert_eq!(
        body(&created),
        &json!({
            "search": { "types": ["core.note"] },
            "title": "Project",
            "include": ["*.md"],
            "first_placement": { "core.note": "Notes" },
        })
    );

    let changed = folders::change_request(&folders::ChangeArgs {
        id: "f1".into(),
        version: 3,
        settings: folders::SettingsArgs {
            ignore: vec!["drafts/".into()],
            ..Default::default()
        },
        idempotency: items::IdempotencyArgs {
            idempotency_key: Some("k1".into()),
        },
    })
    .unwrap();
    assert_eq!(changed.method, Method::Patch);
    assert_eq!(changed.path(), "/folders/f1");
    assert_eq!(
        body(&changed),
        &json!({ "ignore": ["drafts/"], "version": 3 })
    );
    assert!(
        changed
            .headers
            .iter()
            .any(|(name, value)| name == "Idempotency-Key" && value == "k1")
    );

    let revoked = folders::revoke_request("f1", &items::IdempotencyArgs::default());
    assert_eq!(revoked.method, Method::Post);
    assert_eq!(revoked.path(), "/folders/f1/revoke");
    assert_eq!(revoked.body, Body::None);

    let twice = folders::create_request(&folders::CreateArgs {
        settings: folders::SettingsArgs {
            body: Some(r#"{"title":"a"}"#.into()),
            title: Some("b".into()),
            ..Default::default()
        },
        ..Default::default()
    });
    assert!(matches!(twice, Err(CliError::Invalid(_))), "{twice:?}");
}

#[test]
fn a_connector_registers_under_its_name_and_reports_a_run_whole() {
    let registered = connectors::register_request("mail", Some("reads a mailbox"));
    assert_eq!(registered.method, Method::Post);
    assert_eq!(registered.path(), "/connectors");
    assert_eq!(
        registered.body,
        Body::Json(json!({ "name": "mail", "description": "reads a mailbox" }))
    );
    assert_eq!(
        connectors::register_request("mail", None).body,
        Body::Json(json!({ "name": "mail" })),
        "an absent description is absent, not null"
    );

    let report = connectors::report_request(&connectors::ReportArgs {
        id: "c1".into(),
        outcome: connectors::Outcome::Failed,
        started_at: "2026-09-21T10:00:00Z".into(),
        finished_at: "2026-09-21T10:01:00Z".into(),
        summary: None,
        error: Some("the mailbox refused".into()),
    });
    assert_eq!(report.method, Method::Post);
    assert_eq!(report.path(), "/connectors/c1/runs");
    assert_eq!(
        report.body,
        Body::Json(json!({
            "outcome": "failed",
            "started_at": "2026-09-21T10:00:00Z",
            "finished_at": "2026-09-21T10:01:00Z",
            "error": "the mailbox refused",
        }))
    );

    let runs = connectors::runs_request("c1", Some(5));
    assert_eq!(runs.path(), "/connectors/c1/runs");
    assert_eq!(query(&runs, "limit").as_deref(), Some("5"));
    assert_eq!(query(&connectors::runs_request("c1", None), "limit"), None);
}

#[test]
fn a_connector_makes_endpoints_and_reads_and_marks_its_deliveries() {
    let made = connectors::endpoint_create_request("c1", Some("github"), Some("X-GitHub-Delivery"));
    assert_eq!(made.method, Method::Post);
    assert_eq!(made.path(), "/connectors/c1/endpoints");
    assert_eq!(
        made.body,
        Body::Json(json!({ "label": "github", "duplicate_header": "X-GitHub-Delivery" }))
    );
    assert_eq!(
        connectors::endpoint_create_request("c1", None, None).body,
        Body::Json(json!({})),
        "absent fields are absent, not null"
    );

    let listed = connectors::deliveries_request(
        "c1",
        Some(connectors::DeliveryState::Any),
        Some("e1"),
        &PageArgs {
            limit: Some(10),
            cursor: Some("next".into()),
        },
    );
    assert_eq!(listed.path(), "/connectors/c1/deliveries");
    assert_eq!(query(&listed, "state").as_deref(), Some("any"));
    assert_eq!(query(&listed, "endpoint_id").as_deref(), Some("e1"));
    assert_eq!(query(&listed, "limit").as_deref(), Some("10"));
    assert_eq!(query(&listed, "cursor").as_deref(), Some("next"));
    let bare = connectors::deliveries_request("c1", None, None, &PageArgs::default());
    assert_eq!(query(&bare, "state"), None);
    assert_eq!(query(&bare, "cursor"), None);

    assert_eq!(
        connectors::delivery_body_request("c1", "d1").path(),
        "/connectors/c1/deliveries/d1/body"
    );

    let handled = connectors::handle_request(
        "c1",
        &["d1".into(), "d2".into()],
        connectors::DeliveryOutcome::Duplicate,
    );
    assert_eq!(handled.method, Method::Post);
    assert_eq!(handled.path(), "/connectors/c1/deliveries/handled");
    assert_eq!(
        handled.body,
        Body::Json(json!({ "ids": ["d1", "d2"], "outcome": "duplicate" }))
    );
}

#[test]
fn a_connector_holds_its_registration_and_keeps_its_state_and_agreements() {
    let held = connectors::hold_request("c1", "p1");
    assert_eq!(held.method, Method::Post);
    assert_eq!(held.path(), "/connectors/c1/hold");
    assert_eq!(held.body, Body::Json(json!({ "process": "p1" })));

    let released = connectors::release_request("c1", "p1");
    assert_eq!(released.method, Method::Delete);
    assert_eq!(released.path(), "/connectors/c1/hold");
    assert_eq!(query(&released, "process").as_deref(), Some("p1"));
    assert_eq!(released.body, Body::None);

    let put = connectors::state_put_request("c1", "p1", json!({ "cursor": "c" })).unwrap();
    assert_eq!(put.method, Method::Put);
    assert_eq!(put.path(), "/connectors/c1/state");
    assert_eq!(
        put.body,
        Body::Json(json!({ "process": "p1", "state": { "cursor": "c" } }))
    );
    let not_an_object = connectors::state_put_request("c1", "p1", json!([1]));
    assert!(
        matches!(not_an_object, Err(CliError::Invalid(_))),
        "{not_an_object:?}"
    );

    let written = connectors::agreements_write_request(
        "c1",
        "p1",
        json!({ "set": [{ "item_id": "i1", "waiting": true, "record": {} }], "clear": ["i2"] }),
    )
    .unwrap();
    assert_eq!(written.method, Method::Post);
    assert_eq!(written.path(), "/connectors/c1/agreements");
    assert_eq!(
        written.body,
        Body::Json(json!({
            "process": "p1",
            "set": [{ "item_id": "i1", "waiting": true, "record": {} }],
            "clear": ["i2"],
        }))
    );
    let not_a_batch = connectors::agreements_write_request("c1", "p1", json!("set"));
    assert!(
        matches!(not_a_batch, Err(CliError::Invalid(_))),
        "{not_a_batch:?}"
    );
    let named_twice =
        connectors::agreements_write_request("c1", "p1", json!({ "process": "p2", "clear": [] }));
    assert!(
        matches!(&named_twice, Err(CliError::Invalid(message)) if message.contains("--process")),
        "{named_twice:?}"
    );

    let found = connectors::agreements_lookup_request("c1", &["i1".into(), "i2".into()]);
    assert_eq!(found.method, Method::Post);
    assert_eq!(found.path(), "/connectors/c1/agreements/lookup");
    assert_eq!(found.body, Body::Json(json!({ "item_ids": ["i1", "i2"] })));

    let listed = connectors::agreements_list_request(
        "c1",
        Some(true),
        &PageArgs {
            limit: Some(10),
            cursor: Some("next".into()),
        },
    );
    assert_eq!(listed.method, Method::Get);
    assert_eq!(listed.path(), "/connectors/c1/agreements");
    assert_eq!(query(&listed, "waiting").as_deref(), Some("true"));
    assert_eq!(query(&listed, "limit").as_deref(), Some("10"));
    assert_eq!(query(&listed, "cursor").as_deref(), Some("next"));
    let every = connectors::agreements_list_request("c1", None, &PageArgs::default());
    assert_eq!(query(&every, "waiting"), None);
}

#[test]
fn restore_posts_the_archive_under_its_own_type() {
    let request = restore::request(&restore::RestoreArgs {
        file: PathBuf::from("/nowhere/archive.tar.gz"),
    });
    assert_eq!(request.method, Method::Post);
    assert_eq!(request.path(), "/restore");
    match &request.body {
        Body::File { path, content_type } => {
            assert_eq!(path, &PathBuf::from("/nowhere/archive.tar.gz"));
            assert_eq!(content_type, "application/gzip");
        }
        other => panic!("the archive is not sent as a file: {other:?}"),
    }
}

#[test]
fn every_published_operation_has_a_command() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi.json");
    let document: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display())),
    )
    .unwrap();
    let mut published: Vec<&str> = Vec::new();
    for (_, methods) in document["paths"].as_object().unwrap() {
        for (method, operation) in methods.as_object().unwrap() {
            if !["get", "post", "put", "patch", "delete"].contains(&method.as_str()) {
                continue;
            }
            published.push(operation["operationId"].as_str().unwrap());
        }
    }
    assert!(
        published.len() >= 60,
        "the document publishes {} operations, which is too few to be the whole of it",
        published.len()
    );
    let known: Vec<&str> = operations::OPERATIONS.iter().map(|op| op.id).collect();
    let unknown: Vec<&&str> = published.iter().filter(|id| !known.contains(id)).collect();
    assert!(
        unknown.is_empty(),
        "published operations with no command: {unknown:?}"
    );
    let stale: Vec<&&str> = known.iter().filter(|id| !published.contains(id)).collect();
    assert!(
        stale.is_empty(),
        "entries naming operations the document no longer publishes: {stale:?}"
    );
    let mut seen: Vec<&str> = Vec::new();
    for operation in operations::OPERATIONS {
        assert!(
            !seen.contains(&operation.id),
            "{} appears twice in the table",
            operation.id
        );
        seen.push(operation.id);
    }
}

#[test]
fn every_mapped_command_parses() {
    use clap::CommandFactory;
    for operation in operations::OPERATIONS {
        let mut tree = crate::Cli::command();
        let mut here = &mut tree;
        for word in operation.command.split(' ') {
            here = here.find_subcommand_mut(word).unwrap_or_else(|| {
                panic!(
                    "{}: `marfa {}` names a subcommand the tree does not have ({word})",
                    operation.id, operation.command
                )
            });
        }
    }
}

mod dispatch {
    use super::*;
    use crate::door::{Answer, Door};
    use crate::output::Printer;
    use crate::remote::Remote;

    fn remote_at(door: &Door) -> Remote {
        Remote::keyed(&door.url, "marfa_k1_x").unwrap()
    }

    const QUIET: Printer = Printer { json: true };

    #[test]
    fn a_delete_carries_the_idempotency_key_it_was_given() {
        let door = Door::open(vec![Answer::json("200 OK", r#"{"item":{"id":"i"}}"#)]);
        items::run(
            items::ItemsCommand::Delete {
                id: "i".into(),
                idempotency: items::IdempotencyArgs {
                    idempotency_key: Some("once".into()),
                },
            },
            &remote_at(&door),
            &QUIET,
        )
        .unwrap();
        let received = door.received();
        assert_eq!(received[0].method(), "DELETE");
        assert_eq!(received[0].path(), "/items/i");
        assert_eq!(received[0].header("idempotency-key"), Some("once"));
    }

    #[test]
    fn attach_uploads_then_creates_the_file_item_then_the_edge_from_it() {
        let dir = std::env::temp_dir().join(format!("marfa-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("picture.png");
        std::fs::write(&file, b"png bytes").unwrap();
        let door = Door::open(vec![
            Answer::json(
                "201 Created",
                r#"{"hash":"sha256:h","mime_type":"image/png","size_bytes":9}"#,
            ),
            Answer::json(
                "201 Created",
                r#"{"item":{"id":"f1","type":"core.file.image"}}"#,
            ),
            Answer::json("201 Created", r#"{"edge":{"id":"e1"}}"#),
        ]);
        items::run(
            items::ItemsCommand::Attach(items::AttachArgs {
                id: "target".into(),
                file,
                mime_type: None,
                title: None,
                type_: None,
            }),
            &remote_at(&door),
            &QUIET,
        )
        .unwrap();
        let received = door.received();
        assert_eq!(received[0].method(), "POST");
        assert_eq!(received[0].path(), "/blobs");
        assert_eq!(received[0].header("content-type"), Some("image/png"));
        assert_eq!(received[0].body, "png bytes");
        let item: serde_json::Value = serde_json::from_str(&received[1].body).unwrap();
        assert_eq!(received[1].path(), "/items");
        assert_eq!(item["type"], "core.file.image");
        assert_eq!(item["properties"]["blob_ref"], "sha256:h");
        let edge: serde_json::Value = serde_json::from_str(&received[2].body).unwrap();
        assert_eq!(received[2].path(), "/edges");
        assert_eq!(edge["source_id"], "f1");
        assert_eq!(edge["target_id"], "target");
        assert_eq!(edge["edge_type"], "attached-to");
    }

    #[test]
    fn add_uploads_then_creates_the_file_item_and_links_nothing() {
        let dir = std::env::temp_dir().join(format!("marfa-add-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("novel.epub");
        std::fs::write(&file, b"epub bytes").unwrap();
        let door = Door::open(vec![
            Answer::json(
                "201 Created",
                r#"{"hash":"sha256:h","mime_type":"application/epub+zip","size_bytes":10}"#,
            ),
            Answer::json("201 Created", r#"{"item":{"id":"f1","type":"core.file"}}"#),
        ]);
        items::run(
            items::ItemsCommand::Add(items::AddArgs {
                file,
                tags: vec!["reading".into()],
                ..Default::default()
            }),
            &remote_at(&door),
            &QUIET,
        )
        .unwrap();
        let received = door.received();
        assert_eq!(
            received.len(),
            2,
            "a file added on its own sent more than its upload and its item"
        );
        assert_eq!(received[0].path(), "/blobs");
        assert_eq!(
            received[0].header("content-type"),
            Some("application/epub+zip")
        );
        assert_eq!(received[0].body, "epub bytes");
        let item: serde_json::Value = serde_json::from_str(&received[1].body).unwrap();
        assert_eq!(received[1].path(), "/items");
        assert_eq!(item["type"], "core.file");
        assert_eq!(item["properties"]["blob_ref"], "sha256:h");
        assert_eq!(item["properties"]["title"], "novel.epub");
        assert_eq!(item["tags"], json!(["reading"]));
    }
}

#[test]
fn the_key_doors_send_the_selector_they_were_given() {
    let by_link = items::lookup_request(
        "t",
        &["v".to_string()],
        None,
        &[],
        &[],
        &["edges".to_string()],
    );
    assert_eq!(by_link.method, Method::Post);
    assert_eq!(by_link.path(), "/items/lookup");
    assert_eq!(
        body(&by_link),
        &json!({ "type": "t", "links": ["v"], "include": ["edges"] })
    );
    let by_key = items::lookup_request("t", &[], Some("s"), &["k".to_string()], &[], &[]);
    assert_eq!(
        body(&by_key),
        &json!({ "type": "t", "source": "s", "source_ids": ["k"] })
    );
    let moved =
        items::tombstones_request("t", &["v".to_string()], None, &[], "2026-01-01T00:00:00Z");
    assert_eq!(moved.method, Method::Post);
    assert_eq!(moved.path(), "/items/tombstones");
    assert_eq!(
        body(&moved),
        &json!({ "type": "t", "links": ["v"], "settled_at": "2026-01-01T00:00:00Z" })
    );
}
