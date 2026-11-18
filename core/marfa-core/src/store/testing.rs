use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::*;
use crate::wire::{WireEdge, WireItem};
use marfa_rules::catalog::Indexing;
use marfa_rules::wire::{WireDisplayHints, WireType};

/// A store no trash or purge holds anything in.
pub fn conn() -> Connection {
    let conn = open_in_memory().unwrap();
    Removals::serve(&std::sync::Arc::default(), &conn).unwrap();
    conn
}

/// The queue another build made, whose `CHECK` also admits `kind`.
pub fn queue_admitting(conn: &Connection, kind: &str) {
    let made: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'queue'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let other = made
        .replacen("'replace_tags',", &format!("'replace_tags', '{kind}',"), 1)
        .replacen("CREATE TABLE queue", "CREATE TABLE queue_other", 1);
    assert!(other.contains(kind));
    conn.execute_batch(&format!(
        "PRAGMA foreign_keys = OFF;
             {other};
             INSERT INTO queue_other SELECT * FROM queue;
             DROP TABLE queue;
             ALTER TABLE queue_other RENAME TO queue;
             PRAGMA foreign_keys = ON;"
    ))
    .unwrap();
}

pub fn wire_type(id: &str, parent: Option<&str>, title_field: Option<&str>) -> WireType {
    WireType {
        id: id.into(),
        parent: parent.map(str::to_string),
        label: None,
        display_hints: Some(WireDisplayHints {
            title_field: title_field.map(str::to_string),
            body_field: None,
            name_from_body: None,
            icon: None,
        }),
        rest: Map::new(),
    }
}

pub fn wire_item(id: &str, type_: &str, state: &str, occurred_at: &str, props: Value) -> WireItem {
    let properties = match props {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    WireItem {
        id: id.into(),
        r#type: type_.into(),
        properties,
        state: state.into(),
        tier: Some("library".into()),
        version: 1,
        schema_version: 1,
        source: "test".into(),
        source_id: None,
        occurred_at: occurred_at.into(),
        created_at: occurred_at.into(),
        updated_at: occurred_at.into(),
        capture_latitude: None,
        capture_longitude: None,
        trashed_at: (state == "trashed").then(|| occurred_at.into()),
        read_only: false,
        edges: None,
    }
}

/// A copy holding the shared parity corpus's types and the items of `items`.
pub fn corpus_copy(corpus: &Value, items: &Value) -> Connection {
    let conn = conn();
    let catalog = marfa_rules::wire::WireCatalog {
        types: serde_json::from_value(corpus["types"].clone()).unwrap(),
        edge_types: Vec::new(),
    };
    replace_catalog(&conn, &catalog).unwrap();
    for item in items.as_array().unwrap() {
        let wire = wire_item(
            item["id"].as_str().unwrap(),
            item["type"].as_str().unwrap(),
            item["state"].as_str().unwrap_or("active"),
            item["occurred_at"]
                .as_str()
                .unwrap_or("2026-01-01T00:00:00Z"),
            item["properties"].clone(),
        );
        let tags: Vec<String> = item["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|tag| tag.as_str().unwrap().to_string())
            .collect();
        upsert_item(&conn, &wire, Some(&tags), &Indexing::default()).unwrap();
    }
    conn
}

pub fn wire_edge(id: &str, source: &str, target: &str, edge_type: &str) -> WireEdge {
    WireEdge {
        id: id.into(),
        from_id: source.into(),
        to_id: target.into(),
        edge_type: edge_type.into(),
        properties: Map::new(),
        version: 1,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    }
}

pub fn note(id: &str, title: &str, body: &str, occurred_at: &str) -> WireItem {
    wire_item(
        id,
        "core.note",
        "active",
        occurred_at,
        json!({ "title": title, "body": body }),
    )
}
