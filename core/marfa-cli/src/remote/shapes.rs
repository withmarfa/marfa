//! The generated crate reads the server's answers through its own operations
//! and models, and writes the bodies it sends. The binary builds its
//! requests by hand and reads answers raw, so nothing else here would notice
//! a model that cannot decode what the server sends: the generated
//! operations fall back to `UnknownValue` rather than failing.
//!
//! The answers are the server's, copied from a server booted from this tree,
//! with only the ids and times fixed.

use marfa_client::apis::configuration::Configuration;
use marfa_client::apis::housekeeping_api::{ListHousekeepingSuccess, list_housekeeping};
use marfa_client::apis::items_api::{
    GetItemParams, GetItemSuccess, ListItemsParams, ListItemsSuccess, get_item, list_items,
};
use marfa_client::models::{ItemListRow, ItemState};

use crate::door::{Answer, Door};

const ITEM: &str = r#"{"id":"01a0d0d0-139f-730c-9f33-b36287371376","type":"core.note","state":"active","tier":"library","properties":{"body":"Its body.","title":"A note"},"created_at":"2026-09-24T00:28:12.575Z","updated_at":"2026-09-24T00:28:12.575Z","occurred_at":"2026-09-24T00:28:12.575Z","version":1,"source":"probe","schema_version":1,"edges":{}}"#;

const METADATA: &str =
    r#"{"item_id":"01a0d0d0-139f-730c-9f33-b36287371376","tags":["reading"],"extensions":{}}"#;

fn configured(door: &Door) -> Configuration {
    Configuration {
        base_path: door.url.clone(),
        bearer_access_token: Some("marfa_k1_x".into()),
        ..Configuration::default()
    }
}

fn params() -> ListItemsParams {
    ListItemsParams {
        r#type: None,
        state: None,
        source: None,
        tier: None,
        tags: None,
        filter: None,
        sort: None,
        direction: None,
        occurred_after: None,
        occurred_before: None,
        updated_after: None,
        updated_before: None,
        limit: None,
        cursor: None,
        include: None,
    }
}

#[test]
fn a_page_of_items_decodes_into_the_generated_page() {
    let door = Door::open(vec![Answer::json(
        "200 OK",
        &format!(r#"{{"data":[{ITEM}],"next_cursor":"eyJ2IjoiIn0"}}"#),
    )]);
    let answer = list_items(&configured(&door), params()).unwrap();
    match answer.entity {
        Some(ListItemsSuccess::Status200(page)) => {
            assert_eq!(page.next_cursor.as_deref(), Some("eyJ2IjoiIn0"));
            match page.data.as_slice() {
                [ItemListRow::Item(item)] => {
                    assert_eq!(item.id, "01a0d0d0-139f-730c-9f33-b36287371376");
                    assert_eq!(item.r#type, "core.note");
                }
                other => panic!("a plain row read as {other:?}"),
            }
        }
        other => panic!("GET /items did not decode into ItemPage: {other:?}"),
    }
    assert!(door.received()[0].line.starts_with("GET /items "));
}

#[test]
fn a_page_of_items_with_their_metadata_decodes_into_the_generated_page() {
    let door = Door::open(vec![Answer::json(
        "200 OK",
        &format!(r#"{{"data":[{{"item":{ITEM},"metadata":{METADATA}}}],"next_cursor":null}}"#),
    )]);
    let answer = list_items(&configured(&door), params()).unwrap();
    match answer.entity {
        Some(ListItemsSuccess::Status200(page)) => {
            assert_eq!(page.next_cursor, None);
            match page.data.as_slice() {
                [ItemListRow::ItemWithMetadata(row)] => {
                    assert_eq!(row.item.id, "01a0d0d0-139f-730c-9f33-b36287371376");
                    assert_eq!(row.metadata.tags, vec!["reading".to_string()]);
                }
                other => panic!("a row with its metadata read as {other:?}"),
            }
        }
        other => panic!("GET /items?include=metadata did not decode into ItemPage: {other:?}"),
    }
    door.received();
}

#[test]
fn an_item_decodes_into_the_generated_detail() {
    let door = Door::open(vec![Answer::json(
        "200 OK",
        &format!(
            r#"{{"item":{ITEM},"metadata":{METADATA},"backrefs":{{}},"versions":{{"data":[],"next_cursor":null}}}}"#
        ),
    )]);
    let answer = get_item(
        &configured(&door),
        GetItemParams {
            id: "01a0d0d0-139f-730c-9f33-b36287371376".into(),
            include: Some("backrefs,versions".into()),
        },
    )
    .unwrap();
    match answer.entity {
        Some(GetItemSuccess::Status200(detail)) => {
            assert_eq!(detail.item.id, "01a0d0d0-139f-730c-9f33-b36287371376");
            assert_eq!(detail.item.state, ItemState::Active);
            assert_eq!(detail.item.properties["title"], "A note");
            assert_eq!(detail.metadata.tags, vec!["reading".to_string()]);
            assert_eq!(detail.versions.map(|page| page.data.len()), Some(0));
        }
        other => panic!("GET /items/{{id}} did not decode into ItemDetail: {other:?}"),
    }
    door.received();
}

#[test]
fn a_housekeeping_report_decodes_every_kind_of_value_it_carries() {
    // A report's values are numbers, booleans, strings or null: the
    // heartbeat's `ok` and `status` beside a count and a store's name.
    let door = Door::open(vec![Answer::json(
        "200 OK",
        r#"{"data":[{"name":"trash-purge","interval_ms":86400000,"next_run_at":"2026-09-24T00:54:44.048Z","running_since":null,"last_started_at":"2026-09-24T00:54:44.006Z","last_finished_at":"2026-09-24T00:54:44.007Z","last_outcome":"ok","last_error":null,"last_result":{"deleted":0,"ok":true,"status":null,"store":"disk"}}],"next_cursor":null}"#,
    )]);
    let answer = list_housekeeping(&configured(&door)).unwrap();
    match answer.entity {
        Some(ListHousekeepingSuccess::Status200(page)) => {
            let report = page.data[0].last_result.clone().unwrap();
            assert_eq!(report["deleted"], 0);
            assert_eq!(report["ok"], true);
            assert!(report["status"].is_null());
            assert_eq!(report["store"], "disk");
        }
        other => panic!("GET /housekeeping did not decode into its page: {other:?}"),
    }
    door.received();
}

#[test]
fn a_type_registration_carries_compatible_with_in_either_spelling() {
    // A request body, so it is written rather than read: the crate has to
    // send `compatible_with` as the name or the list it was given.
    for compatible_with in [r#""user.a""#, r#"["user.a","user.b"]"#] {
        let body =
            format!(r#"{{"id":"user.t","fields":{{}},"compatible_with":{compatible_with}}}"#);
        let input: marfa_client::models::TypeDefinitionInput = serde_json::from_str(&body).unwrap();
        assert_eq!(
            serde_json::to_value(&input).unwrap()["compatible_with"],
            serde_json::from_str::<serde_json::Value>(compatible_with).unwrap()
        );
    }
}

/// Every `.rs` file under `dir`, at any depth.
fn sources(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(sources(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
    found
}

/// An object the generator wrote with no fields, which reads nothing: what
/// it emits for a union it cannot express.
fn is_empty_struct(text: &str) -> bool {
    text.lines()
        .any(|line| line.starts_with("pub struct ") && line.trim_end().ends_with(" {}"))
}

#[test]
fn no_generated_model_is_an_object_with_no_fields() {
    // The witness: the rule flags the struct the generator wrote for the
    // housekeeping report's values before `schemaMappings` stopped it.
    assert!(is_empty_struct("pub struct HousekeepingReportValue {}\n"));
    let models =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../marfa-client/src/models");
    let files = sources(&models);
    assert!(files.len() > 100, "read {} models", files.len());
    let empty: Vec<_> = files
        .iter()
        .filter(|path| is_empty_struct(&std::fs::read_to_string(path).unwrap()))
        .collect();
    assert!(empty.is_empty(), "models with no fields: {empty:?}");
}

#[test]
fn no_command_calls_a_generated_operation() {
    // The generated operations send a request and read its answer without
    // the contract check, so the binary reaches the wire through `Remote`
    // alone; this module's tests are the one place that calls them.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let own = root.join("remote/shapes.rs");
    let calls = |text: &str| {
        text.lines().any(|line| {
            line.contains("marfa_client::apis::") && !line.contains("apis::configuration")
        })
    };
    assert!(calls(
        "use marfa_client::apis::audit_api::list_audit_log;\n"
    ));
    let offending: Vec<_> = sources(&root)
        .into_iter()
        .filter(|path| *path != own && calls(&std::fs::read_to_string(path).unwrap()))
        .collect();
    assert!(
        offending.is_empty(),
        "calling a generated operation: {offending:?}"
    );
}
