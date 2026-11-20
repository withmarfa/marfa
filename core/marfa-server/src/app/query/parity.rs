use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::filter::parse;
use marfa_rules::wire::WireType;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};

use super::compile::{Ask, Filter, selection};
use super::order::property_key;
use super::reach::Reach;
use crate::app::catalog::Catalog;

const CORPUS: &str = include_str!("../../../../marfa-rules/src/filter/parity.json");

fn held(items: &Value) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    crate::db::migrate::make_all(&db).unwrap();
    for (seq, item) in items.as_array().unwrap().iter().enumerate() {
        let at = item["occurred_at"]
            .as_str()
            .unwrap_or("2026-01-01T00:00:00Z");
        db.execute(
            "INSERT INTO items (seq, id, type, state, tier, source, version, schema_version, \
             occurred_at, created_at, updated_at, last_activity_at, properties) \
             VALUES (?1, ?2, ?3, ?4, 'library', 'test', 1, 1, ?5, ?5, ?5, ?5, jsonb(?6))",
            params![
                seq as i64,
                item["id"].as_str().unwrap(),
                item["type"].as_str().unwrap(),
                item["state"].as_str().unwrap_or("active"),
                at,
                item["properties"].to_string(),
            ],
        )
        .unwrap();
        for (position, tag) in item["tags"].as_array().into_iter().flatten().enumerate() {
            db.execute(
                "INSERT INTO item_tags (item_seq, tag, position) VALUES (?1, ?2, ?3)",
                params![seq as i64, tag.as_str().unwrap(), position as i64],
            )
            .unwrap();
        }
    }
    db
}

fn catalog_of(corpus: &Value) -> Catalog {
    let types: Vec<WireType> = serde_json::from_value(corpus["types"].clone()).unwrap();
    let mut catalog = Catalog::empty();
    catalog.rules = Rules::from_wire(&types, None);
    catalog
}

fn selected_ids(db: &Connection, catalog: &Catalog, text: &str) -> Vec<String> {
    let reach = Reach::testing(
        &[
            "acme.task",
            "acme.chore",
            "acme.note",
            "acme.event",
            "acme.log",
        ],
        &[],
        &[],
    );
    let ask = Ask {
        filter: Some(Filter {
            text: text.to_string(),
            expression: parse(text).unwrap(),
        }),
        ..Ask::default()
    };
    let selected = selection(&reach, &ask, catalog, false).unwrap();
    let mut statement = db
        .prepare(&format!(
            "SELECT i.id FROM items i WHERE {} ORDER BY i.id",
            selected.text
        ))
        .unwrap();
    statement
        .query_map(params_from_iter(selected.values.iter()), |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn the_filters_both_sides_share_select_the_ids_the_working_copy_selects() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let catalog = catalog_of(&corpus);
    let db = held(&corpus["items"]);
    for case in corpus["filters"].as_array().unwrap() {
        let text = case["filter"].as_str().unwrap();
        assert_eq!(
            json!(selected_ids(&db, &catalog, text)),
            case["ids"],
            "{text}"
        );
    }
}

#[test]
fn the_ordered_items_are_filtered_and_sorted_as_the_working_copy_does() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let catalog = catalog_of(&corpus);
    let ordered = &corpus["ordered"];
    let db = held(&ordered["items"]);
    for case in ordered["filters"].as_array().unwrap() {
        let text = case["filter"].as_str().unwrap();
        assert_eq!(
            json!(selected_ids(&db, &catalog, text)),
            case["ids"],
            "{text}"
        );
    }
    for case in ordered["sorts"].as_array().unwrap() {
        let key = property_key(case["by"].as_str().unwrap());
        for (direction, ids) in [("ASC", &case["ascending"]), ("DESC", &case["descending"])] {
            let mut statement = db
                .prepare(&format!(
                    "SELECT i.id FROM items i ORDER BY ({0}) {direction} NULLS LAST, i.id ASC",
                    key.text
                ))
                .unwrap();
            let found: Vec<String> = statement
                .query_map(params_from_iter(key.values.iter()), |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(json!(found), *ids, "{} {direction}", case["by"]);
        }
    }
}
