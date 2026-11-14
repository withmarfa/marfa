use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::filter::parse;
use marfa_rules::wire::WireType;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::Value;

use super::compile::{Ask, Filter, selection};
use super::reach::Reach;
use crate::app::catalog::Catalog;

const CORPUS: &str = include_str!("../../../../marfa-rules/src/filter/parity.json");

fn held() -> Connection {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../../db/migrations/0001_baseline.sql"))
        .unwrap();
    for (seq, item) in corpus["items"].as_array().unwrap().iter().enumerate() {
        let at = item["occurred_at"].as_str().unwrap();
        db.execute(
            "INSERT INTO items (seq, id, type, state, tier, source, version, schema_version, \
             occurred_at, created_at, updated_at, last_activity_at, properties) \
             VALUES (?1, ?2, ?3, ?4, 'library', 'test', 1, 1, ?5, ?5, ?5, ?5, jsonb(?6))",
            params![
                seq as i64,
                item["id"].as_str().unwrap(),
                item["type"].as_str().unwrap(),
                item["state"].as_str().unwrap(),
                at,
                item["properties"].to_string(),
            ],
        )
        .unwrap();
        for (position, tag) in item["tags"].as_array().unwrap().iter().enumerate() {
            db.execute(
                "INSERT INTO item_tags (item_seq, tag, position) VALUES (?1, ?2, ?3)",
                params![seq as i64, tag.as_str().unwrap(), position as i64],
            )
            .unwrap();
        }
    }
    db
}

#[test]
fn the_filters_both_sides_share_select_the_ids_the_working_copy_selects() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let types: Vec<WireType> = serde_json::from_value(corpus["types"].clone()).unwrap();
    let mut catalog = Catalog::empty();
    catalog.rules = Rules::from_wire(&types, None);
    let reach = Reach::testing(&["acme.task", "acme.chore", "acme.note"], &[], &[]);
    let db = held();
    for case in corpus["filters"].as_array().unwrap() {
        let text = case["filter"].as_str().unwrap();
        let ask = Ask {
            filter: Some(Filter {
                text: text.to_string(),
                expression: parse(text).unwrap(),
            }),
            ..Ask::default()
        };
        let selected = selection(&reach, &ask, &catalog, false).unwrap();
        let mut statement = db
            .prepare(&format!(
                "SELECT i.id FROM items i WHERE {} ORDER BY i.id",
                selected.text
            ))
            .unwrap();
        let ids: Vec<String> = statement
            .query_map(params_from_iter(selected.values.iter()), |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let wanted: Vec<&str> = case["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        assert_eq!(ids, wanted, "{text}");
    }
}
