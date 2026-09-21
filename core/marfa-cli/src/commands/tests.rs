//! The shape each leaf sends, held without a server.
//!
//! A command is its arguments turned into a method, a path, a query and a
//! body; that turn is pure, so it is asserted here for every door that
//! carries something a caller could get wrong, and the scenario suite holds
//! the answers against a real server.

use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::remote::request::{Body, Method, Request};

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
    // Absent rather than sent empty: an empty `source=` is a filter that
    // matches nothing, and a caller who gave none asked for everything.
    assert_eq!(query(&request, "source"), None);
    assert_eq!(query(&request, "tier"), None);
    assert_eq!(query(&request, "include"), None);
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
        force_snapshot: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(query(&resolved, "conflict").as_deref(), Some("auto"));
    assert_eq!(body(&resolved)["properties_mode"], "replace");
    assert_eq!(body(&resolved)["source_id"], "notes/new.md");
    assert_eq!(body(&resolved)["force_snapshot"], true);
    // No properties were given, so none are sent: an empty object would be
    // a replace-with-nothing under `--replace`.
    assert!(body(&resolved).get("properties").is_none());
}

#[test]
fn the_lifecycle_doors_take_the_verb_the_document_publishes() {
    assert_eq!(items::delete_request("i").method, Method::Delete);
    assert_eq!(items::delete_request("i").path(), "/items/i");
    assert_eq!(items::restore_request("i").path(), "/items/i/restore");
    assert_eq!(items::purge_request("i").method, Method::Delete);
    assert_eq!(items::purge_request("i").path(), "/items/i/purge");
    let archived = items::transition_request("i", items::TransitionState::Archived);
    assert_eq!(archived.path(), "/items/i/transition");
    assert_eq!(body(&archived), &json!({ "state": "archived" }));
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
    assert_eq!(cancel.method, Method::Delete);
}

#[test]
fn an_attachment_is_an_upload_a_file_item_and_an_edge() {
    let args = items::AttachArgs {
        id: "note".into(),
        file: PathBuf::from("diagram.png"),
        ..Default::default()
    };
    let mime_type = items::mime_type_for(&args.file, args.mime_type.as_deref());
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
    assert_eq!(items::file_type_for("application/pdf", None), "core.file");
    assert_eq!(items::file_type_for("audio/mpeg", None), "core.file.audio");
    assert_eq!(
        items::file_type_for("image/png", Some("user.scan")),
        "user.scan"
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
    let updated = edges::update_request("e", r#"{"weight":2}"#, 4).unwrap();
    assert_eq!(updated.method, Method::Patch);
    assert_eq!(
        body(&updated),
        &json!({ "properties": { "weight": 2 }, "version": 4 })
    );
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
        limit: Some(3),
        offset: Some(6),
        ..Default::default()
    });
    assert_eq!(request.path(), "/search");
    assert_eq!(query(&request, "q").as_deref(), Some("zebra crossing"));
    assert_eq!(query(&request, "state").as_deref(), Some("archived"));
    assert_eq!(query(&request, "tier").as_deref(), Some("all"));
    assert_eq!(query(&request, "limit").as_deref(), Some("3"));
    assert_eq!(query(&request, "offset").as_deref(), Some("6"));
}

#[test]
fn metadata_is_replaced_whole_or_merged_and_tags_are_listed_from_their_own_door() {
    let replaced = metadata::replace_request("i", &["a".into()]);
    assert_eq!(replaced.method, Method::Put);
    assert_eq!(replaced.path(), "/items/i/metadata");
    let merged = metadata::merge_request("i", &["b".into()]);
    assert_eq!(merged.method, Method::Patch);
    assert_eq!(body(&merged), &json!({ "tags": ["b"] }));
    assert_eq!(metadata::tags_request().path(), "/metadata/tags");
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
        types::update_request("user.x", json!({})).method,
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
    assert_eq!(types::drift_request().path(), "/admin/platform-types/drift");
    assert_eq!(
        types::prune_request("core.gone").path(),
        "/admin/platform-types/core.gone"
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
    assert_eq!(body(&inert)["permissions"], json!([]));
    let operator = keys::create_request(&keys::KeyCreateArgs {
        label: "second".into(),
        source: "operator-2".into(),
        operator: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(body(&operator)["is_operator"], true);
    assert_eq!(keys::revoke_request("k").method, Method::Delete);
    assert_eq!(keys::bootstrap_request().path(), "/keys");
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
    assert_eq!(grants::list_request().path(), "/auth/grants");
    assert_eq!(
        query(&grants::revoke_request("g", true), "revoke_keys").as_deref(),
        Some("true")
    );
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
fn blobs_are_fetched_as_a_stream_and_a_link_carries_its_ttl() {
    let download = blobs::download_request("sha256:abc");
    assert_eq!(download.path(), "/blobs/sha256:abc");
    assert!(download.stream);
    assert_eq!(
        query(&blobs::url_request("sha256:abc", Some(60)), "ttl").as_deref(),
        Some("60")
    );
}

/// The stores and the location log are reached where the document puts
/// them, and a dropped copy names the store in the path rather than a body.
#[test]
fn the_stores_and_the_location_log_are_reached_at_their_doors() {
    assert_eq!(blobs::stores_request().path(), "/blobs/stores");
    assert_eq!(blobs::orphans_request().path(), "/blobs/orphans");
    assert_eq!(
        blobs::locations_request("sha256:abc").path(),
        "/blobs/sha256:abc/locations"
    );
    let dropped = blobs::drop_request("sha256:abc", "disk");
    assert_eq!(dropped.method, Method::Delete);
    assert_eq!(dropped.path(), "/blobs/sha256:abc/locations/disk");
    assert_eq!(dropped.body, Body::None);
}

#[test]
fn a_housekeeping_job_is_listed_and_run_by_name() {
    assert_eq!(housekeeping::list_request().path(), "/housekeeping");
    let run = housekeeping::run_request("blob-orphans");
    assert_eq!(run.method, Method::Post);
    assert_eq!(run.path(), "/housekeeping/blob-orphans/run");
    assert_eq!(run.body, Body::None);
}

/// Every operation the document publishes has a command, and every command
/// in the table names an operation the document still publishes.
///
/// The document is the one at the repository root, read relative to the
/// crate, so a door added to the server is red here before it reaches a
/// pull request; the scenario suite reads the same table from the binary.
#[test]
fn every_published_operation_has_a_command() {
    let path = std::env::var("MARFA_OPENAPI")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi.json"));
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
        "published operations with neither a command nor a pending entry: {unknown:?}"
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

/// Every command the table names is one the tree accepts, so the table
/// cannot advertise a command that does not exist; and a pending entry
/// names no command, so an operation that gained one cannot stay pending.
#[test]
fn every_mapped_command_parses_and_a_pending_entry_is_truly_unreached() {
    use clap::CommandFactory;
    for operation in operations::OPERATIONS {
        let command = match operation.reach {
            operations::Reach::Command(command) => command,
            operations::Reach::Pending(reason) => {
                assert!(
                    !reason.is_empty(),
                    "{} is pending with no reason",
                    operation.id
                );
                continue;
            }
        };
        let mut tree = crate::Cli::command();
        let mut here = &mut tree;
        for word in command.split(' ') {
            here = here.find_subcommand_mut(word).unwrap_or_else(|| {
                panic!(
                    "{}: `marfa {}` names a subcommand the tree does not have ({word})",
                    operation.id, command
                )
            });
        }
    }
    // A pending entry names the leaf that will reach it, in backticks,
    // and that leaf must not exist yet: the day it is built, the entry
    // moves to a command or this test says so.
    let tree = crate::Cli::command();
    for operation in operations::OPERATIONS {
        if let operations::Reach::Pending(reason) = operation.reach {
            let named: Vec<&str> = reason
                .split('`')
                .filter_map(|part| part.strip_prefix("marfa "))
                .collect();
            for leaf in named {
                assert!(
                    tree.find_subcommand(leaf).is_none(),
                    "{} is pending on `marfa {leaf}`, which now exists",
                    operation.id
                );
            }
        }
    }
}
