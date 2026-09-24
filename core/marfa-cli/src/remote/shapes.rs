//! The generated crate reads the server's answers through its own operations
//! and models. The binary builds its requests by hand and reads answers raw,
//! so nothing else here would notice a model that cannot decode what the
//! server sends: the generated operations fall back to `UnknownValue` rather
//! than failing.
//!
//! The answers are the server's, copied from a server booted from this tree,
//! with only the ids and times fixed.

use marfa_client::apis::configuration::Configuration;
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
