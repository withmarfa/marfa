use std::sync::atomic::Ordering;

use serde_json::Value;

use super::*;
use marfa_rules::validation::MAX_TAG_LENGTH;

mod declared_types;
mod edge_writes;
mod files;
mod item_reads;
mod item_writes;
mod opening;
mod reading_handle;
mod sending;
mod streams;
mod validation;

fn server_held_item(core: &Core, type_id: &str, properties: Value) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    let mut row = store::testing::note(&id, "held", "body", "2026-01-01T00:00:00Z");
    row.r#type = type_id.into();
    row.properties = properties.as_object().unwrap().clone();
    store::put_server_item(
        &core.conn().unwrap(),
        &row,
        None,
        &marfa_rules::catalog::Catalog::empty(),
    )
    .unwrap();
    id
}

fn unreachable_server(url: &str) -> Option<Server> {
    Some(Server {
        url: url.into(),
        key: "marfa_k1_test".into(),
    })
}

fn held_copy() -> Core {
    let core = Core::open_in_memory(None).unwrap();
    {
        let conn = core.conn().unwrap();
        store::replace_types(
            &conn,
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        let mut row = store::testing::note("row", "server", "body", "2026-01-01T00:00:00Z");
        row.version = 3;
        store::put_server_item(
            &conn,
            &row,
            Some(&["a".into()]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge("link", "row", "row", "references"),
        )
        .unwrap();
    }
    core
}

fn properties(value: serde_json::Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

/// `{"deep": [[...]]}` with `arrays` arrays inside the one object.
fn nested(arrays: usize) -> serde_json::Map<String, Value> {
    let mut inner = Value::Null;
    for _ in 0..arrays {
        inner = Value::Array(vec![inner]);
    }
    properties(serde_json::json!({ "deep": inner }))
}

pub(crate) fn refuse(core: &Core, write: &QueuedWrite) {
    let conn = core.conn().unwrap();
    store::mark_sent(&conn, &write.id).unwrap();
    let row = store::queued_write(&conn, &write.id).unwrap().unwrap();
    store::record_refusal(&conn, &row, "type_not_permitted", None, false).unwrap();
}

pub(crate) fn validation_copy() -> Core {
    let core = held_copy();
    let mut parent = store::testing::wire_type("acme.parent", None, Some("title"));
    parent.rest.insert(
        "fields".into(),
        serde_json::json!({
            "title": {"type": "string", "required": true, "max_length": 4},
            "read": {"type": "boolean"},
            "choice": {"type": "enum", "enum_values": ["yes", "no"]},
            "count": {"type": "integer"},
            "list": {"type": "array", "max_items": 2, "items": {"type": "string"}},
            "date": {"type": "date"}, "time": {"type": "datetime"},
            "email": {"type": "email"}, "url": {"type": "url"},
            "image": {"type": "thumbnail"}, "object": {"type": "object"},
            "annotated": {"type": "string", "format": "email"}
        }),
    );
    let mut child = store::testing::wire_type("acme.child", Some("acme.parent"), None);
    child.rest.insert(
        "fields".into(),
        serde_json::json!({
            "title": {"type": "string", "required": true, "max_length": 5}
        }),
    );
    store::replace_types(&core.conn().unwrap(), &[parent, child]).unwrap();
    core
}

fn validation_draft(properties: Value) -> Draft {
    Draft {
        r#type: "acme.child".into(),
        properties: properties.as_object().unwrap().clone(),
        ..Default::default()
    }
}
