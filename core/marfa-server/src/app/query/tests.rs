//! A listing cannot be compiled without its reach: each shape of query below is
//! compiled, and each must carry the reach it was given.

use marfa_rules::filter;
use rusqlite::types::Value;

use super::compile::{Ask, Filter, Sql, States, selection};
use super::cursor::{Position, Secret};
use super::listing::{By, page_sql, stats_sql};
use super::order::{Order, Sort};
use super::reach::Reach;
use super::search::search_sql;
use crate::app::catalog::Catalog;

const OPEN: &str = "core.open";
const HELD: &str = "core.held";
const SOURCE: &str = "reach-source";

fn reach() -> Reach {
    Reach::testing(&[OPEN], &[HELD], &[SOURCE])
}

fn filtered(text: &str) -> Ask {
    Ask {
        filter: Some(Filter {
            text: text.to_string(),
            expression: filter::parse(text).unwrap(),
        }),
        ..Ask::default()
    }
}

fn asks() -> Vec<Ask> {
    let mut asks = vec![
        Ask::default(),
        Ask {
            types: vec![OPEN.to_string(), HELD.to_string()],
            ..Ask::default()
        },
        Ask {
            types: vec!["core.*".to_string()],
            ..Ask::default()
        },
        Ask {
            states: States::Named(vec!["trashed".to_string()]),
            ..Ask::default()
        },
        Ask {
            system: true,
            source: Some("other".to_string()),
            tier: Some("feed".to_string()),
            tags: vec!["a".to_string()],
            occurred_after: Some("2026-01-01T00:00:00.000Z".to_string()),
            updated_before: Some("2026-01-01T00:00:00.000Z".to_string()),
            ..Ask::default()
        },
        Ask {
            beneath: Some("01920000-0000-7000-8000-000000000000".to_string()),
            ..Ask::default()
        },
    ];
    asks.extend(
        [
            r#"state eq "active""#,
            r#"properties.a eq "x" OR properties.b gt 1"#,
            r#"properties.a contains "x""#,
            "properties.a not_exists",
            r#"tags contains "x""#,
            "tags exists",
            r#"edge[about] eq "01920000-0000-7000-8000-000000000000""#,
            "edge[about] not_exists",
            r#"backref[about] eq "01920000-0000-7000-8000-000000000000""#,
            "backref[about] exists",
            "backref[about] not_exists",
        ]
        .map(filtered),
    );
    asks
}

fn holds(sql: &Sql, wanted: &str, times: usize) -> bool {
    let bound = |value: &Value| matches!(value, Value::Text(text) if text == wanted);
    sql.values.iter().filter(|value| bound(value)).count() >= times
}

fn assert_reached(sql: &Sql, ask: &Ask) {
    let context = format!("{ask:?} compiled to {}", sql.text);
    assert_eq!(sql.text.matches('?').count(), sql.values.len(), "{context}");
    assert!(sql.text.contains(".type IN ("), "{context}");
    assert!(holds(sql, OPEN, 1), "{context}");
    assert!(holds(sql, HELD, 1), "{context}");
    assert!(holds(sql, SOURCE, 1), "{context}");
    let walks = usize::from(ask.beneath.is_some())
        + ask.filter.as_ref().map_or(0, |filter| {
            filter
                .expression
                .conditions
                .iter()
                .filter(|condition| {
                    matches!(condition.term, filter::Term::Edge { backref: true, .. })
                })
                .count()
        });
    assert!(holds(sql, SOURCE, 1 + walks), "{context}");
}

#[test]
fn every_compiled_read_carries_the_callers_reach() {
    let catalog = Catalog::empty();
    let reach = reach();
    for ask in asks() {
        assert_reached(&selection(&reach, &ask, &catalog, true).unwrap(), &ask);
        let selected = selection(&reach, &ask, &catalog, false).unwrap();
        assert_reached(&selected, &ask);

        let order = Order::listing(&Sort::default(), &ask);
        assert_reached(&page_sql(&selected, &order, None, 50), &ask);

        for by in [By::State, By::Type, By::Source] {
            assert_reached(&stats_sql(&reach, &ask, &catalog, by).unwrap(), &ask);
        }

        let order = Order::search(&Sort::default());
        assert_reached(
            &search_sql(&reach, &ask, &catalog, "word", &order, 21, 0).unwrap(),
            &ask,
        );
    }
}

#[test]
fn a_named_type_never_widens_the_reach() {
    let catalog = Catalog::empty();
    let ask = Ask {
        types: vec!["core.other".to_string()],
        ..Ask::default()
    };
    let selected = selection(&reach(), &ask, &catalog, false).unwrap();
    assert!(
        selected.text.starts_with("(i.type IN ())"),
        "{}",
        selected.text
    );
    assert!(!holds(&selected, "core.other", 1));
}

#[test]
fn a_cursor_opens_only_under_the_scope_it_was_issued_for() {
    let secret = Secret(vec![7; 32]);
    let position = Position {
        keys: vec![Value::Real(1.5), Value::Text("x".to_string()), Value::Null],
        id: "id".to_string(),
    };
    let cursor = secret.issue("scope", &position.payload()).unwrap();
    let opened = secret.open("scope", &cursor).unwrap();
    let back = Position::from_payload(&opened, 3).unwrap();
    assert_eq!(back.keys, position.keys);

    assert!(secret.open("another", &cursor).is_err());
    assert!(Secret(vec![8; 32]).open("scope", &cursor).is_err());
    let mut tampered = cursor.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == '0' { '1' } else { '0' });
    assert!(secret.open("scope", &tampered).is_err());
    assert!(secret.open("scope", "").is_err());
    assert!(Position::from_payload(&opened, 2).is_err());
}
