//! A part's name in a working copy: "<edge label> <host name>" from the host
//! of its oldest `with-hosts` edge that the copy holds out of the bin, as
//! the server names it (`types/item-name-part`, `device/item-name-part`).

use serde_json::{Map, Value, json};

use crate::scripted::Scripted;
use crate::stop_tests::{copy, holding_a_catalog};
use crate::wire::{WireEdge, WireItem};
use crate::{Core, ItemDisplay, store};

const AT: &str = "2026-01-01T00:00:00Z";

fn row(id: &str, item_type: &str, state: &str, properties: Value) -> WireItem {
    store::testing::wire_item(id, item_type, state, AT, properties)
}

fn put(core: &Core, row: &WireItem) {
    let conn = core.conn().unwrap();
    let catalog = crate::catalog::Catalog::load(&conn).unwrap();
    crate::reach::set_listed(&conn, &row.id, true).unwrap();
    store::put_server_item(&conn, row, Some(&[]), &catalog).unwrap();
}

fn edge(core: &Core, id: &str, source: &str, target: &str, edge_type: &str, created_at: &str) {
    let edge = WireEdge {
        created_at: created_at.into(),
        ..store::testing::wire_edge(id, source, target, edge_type)
    };
    store::upsert_edge(&core.conn().unwrap(), &edge).unwrap();
}

fn shown(core: &Core, id: &str) -> ItemDisplay {
    let item = store::items_by_ids(&core.conn().unwrap(), &[id.to_string()])
        .unwrap()
        .pop()
        .unwrap();
    core.item_displays(&[(Some(id), item.r#type.as_str(), &item.properties)])
        .unwrap()
        .pop()
        .unwrap()
}

fn name(core: &Core, id: &str) -> Option<String> {
    shown(core, id).name
}

fn held_copy(server: &Scripted) -> std::sync::Arc<Core> {
    let core = copy(server);
    holding_a_catalog(&core);
    put(
        &core,
        &row(
            "issue",
            "core.task",
            "active",
            json!({ "title": "Fix login bug" }),
        ),
    );
    put(
        &core,
        &row(
            "comment",
            "core.note",
            "active",
            json!({ "body": "LGTM\n\nShip it" }),
        ),
    );
    edge(&core, "e1", "comment", "issue", "comments-on", AT);
    core
}

#[test]
fn names_a_comment_after_its_issue_and_previews_its_whole_body() {
    let server = Scripted::start();
    let core = held_copy(&server);
    assert_eq!(
        shown(&core, "comment"),
        ItemDisplay {
            name: Some("Comment on Fix login bug".into()),
            preview: Some("LGTM Ship it".into()),
        }
    );
    // Without its id the copy cannot find its hosts, so the body names it.
    let properties: Map<String, Value> = json!({ "body": "LGTM\n\nShip it" })
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(
        core.item_displays(&[(None, "core.note", &properties)])
            .unwrap()[0]
            .name
            .as_deref(),
        Some("LGTM")
    );
}

#[test]
fn follows_a_rename_of_the_host() {
    let server = Scripted::start();
    let core = held_copy(&server);
    let mut renamed = row(
        "issue",
        "core.task",
        "active",
        json!({ "title": "Fix the login page" }),
    );
    renamed.version = 2;
    put(&core, &renamed);
    assert_eq!(
        name(&core, "comment").as_deref(),
        Some("Comment on Fix the login page")
    );
}

#[test]
fn names_a_part_by_its_body_when_no_host_is_held_out_of_the_bin() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(
        &core,
        &row("stray", "core.note", "active", json!({ "body": "Seen it" })),
    );
    edge(&core, "e2", "stray", "elsewhere", "comments-on", AT);
    assert_eq!(name(&core, "stray").as_deref(), Some("Seen it"));
    // A host in the bin names nothing either.
    put(
        &core,
        &row(
            "issue",
            "core.task",
            "trashed",
            json!({ "title": "Fix login bug" }),
        ),
    );
    assert_eq!(name(&core, "comment").as_deref(), Some("LGTM"));
    // The witness: back out of the bin, it names the comment again.
    put(
        &core,
        &row(
            "issue",
            "core.task",
            "active",
            json!({ "title": "Fix login bug" }),
        ),
    );
    assert_eq!(
        name(&core, "comment").as_deref(),
        Some("Comment on Fix login bug")
    );
}

#[test]
fn names_a_reply_after_its_comments_own_name() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(
        &core,
        &row("reply", "core.note", "active", json!({ "body": "Agreed" })),
    );
    edge(&core, "e3", "reply", "comment", "comments-on", AT);
    assert_eq!(name(&core, "reply").as_deref(), Some("Comment on LGTM"));
}

#[test]
fn keeps_a_parts_own_title_and_takes_the_oldest_held_host() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(
        &core,
        &row(
            "scan",
            "core.file",
            "active",
            json!({ "title": "Page one", "filename": "scan.pdf" }),
        ),
    );
    edge(&core, "e4", "scan", "issue", "attached-to", AT);
    assert_eq!(name(&core, "scan").as_deref(), Some("Page one"));

    put(
        &core,
        &row("first", "core.task", "trashed", json!({ "title": "First" })),
    );
    put(
        &core,
        &row(
            "second",
            "core.task",
            "active",
            json!({ "title": "Second" }),
        ),
    );
    put(
        &core,
        &row("third", "core.task", "active", json!({ "title": "Third" })),
    );
    put(
        &core,
        &row(
            "file",
            "core.file",
            "active",
            json!({ "filename": "a.pdf" }),
        ),
    );
    edge(
        &core,
        "e7",
        "file",
        "third",
        "attached-to",
        "2026-01-04T00:00:00Z",
    );
    edge(
        &core,
        "e6",
        "file",
        "second",
        "attached-to",
        "2026-01-03T00:00:00Z",
    );
    edge(
        &core,
        "e5",
        "file",
        "first",
        "attached-to",
        "2026-01-02T00:00:00Z",
    );
    assert_eq!(name(&core, "file").as_deref(), Some("Attached to Second"));
}

#[test]
fn bounds_a_part_name_as_every_name_is_bounded() {
    let server = Scripted::start();
    let core = held_copy(&server);
    put(
        &core,
        &row(
            "issue",
            "core.task",
            "active",
            json!({ "title": "x".repeat(130) }),
        ),
    );
    let got = name(&core, "comment").unwrap();
    assert_eq!(got.chars().count(), 120);
    assert_eq!(
        got,
        format!("Comment on {}…", "x".repeat(120 - "Comment on ".len() - 1))
    );
}

/// The part cases the server's summaries are held to as well
/// (`compliance/item-summaries.test.ts`).
const SHARED: &str = include_str!("../../../conformance/fixtures/item-display.json");

#[derive(serde::Deserialize)]
struct Shared {
    types: Vec<Value>,
    parts: Vec<PartCase>,
}

#[derive(serde::Deserialize)]
struct PartCase {
    description: String,
    host: Shaped,
    edge_type: String,
    part: Shaped,
    name: Option<String>,
    preview: Option<String>,
}

#[derive(serde::Deserialize)]
struct Shaped {
    r#type: String,
    properties: Value,
}

#[test]
fn names_every_shared_part_case_as_the_server_does() {
    let shared: Shared = serde_json::from_str(SHARED).unwrap();
    assert!(!shared.parts.is_empty());
    let server = Scripted::start();
    let core = copy(&server);
    let mut listed = crate::builtin::catalog().unwrap();
    for registered in &shared.types {
        let mut row = registered.clone();
        row["version"] = Value::from(0);
        listed.types.push(serde_json::from_value(row).unwrap());
    }
    store::replace_catalog(&core.conn().unwrap(), &listed).unwrap();
    let mut failed = Vec::new();
    for (at, case) in shared.parts.iter().enumerate() {
        let (host, part) = (format!("host-{at}"), format!("part-{at}"));
        put(
            &core,
            &row(
                &host,
                &case.host.r#type,
                "active",
                case.host.properties.clone(),
            ),
        );
        put(
            &core,
            &row(
                &part,
                &case.part.r#type,
                "active",
                case.part.properties.clone(),
            ),
        );
        edge(
            &core,
            &format!("edge-{at}"),
            &part,
            &host,
            &case.edge_type,
            AT,
        );
        let got = shown(&core, &part);
        let want = ItemDisplay {
            name: case.name.clone(),
            preview: case.preview.clone(),
        };
        if got != want {
            failed.push(format!("{}: got {got:?}, want {want:?}", case.description));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
