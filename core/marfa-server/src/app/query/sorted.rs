//! A listing sorted by a property of one large type, read from `item_sort_keys` in index order.

use marfa_rules::catalog::Catalog as Rules;
use rusqlite::Transaction;
use rusqlite::types::Value;

use super::compile::{Ask, Sql, States};
use super::cursor::Position;
use super::listing::{Found, found};
use super::reach::{Reach, keeps_type};
use crate::app::items::{Reader, sort_keys};
use crate::app::refusal::Result;

pub(super) enum Reading {
    /// The pair's keys are complete: read them in order.
    Keys(String),
    /// Read every item of the type; where the type is named, ask for the pair to be kept so later listings need not.
    Scan(Option<String>),
}

/// An ask whose other conditions leave most keys standing, so that a walk of the keys in order ends soon.
fn walkable(ask: &Ask) -> bool {
    let states = match &ask.states {
        States::Every => true,
        States::Named(states) => states.iter().any(|state| state == "active"),
    };
    states
        && ask.filter.is_none()
        && ask.tags.is_empty()
        && ask.beneath.is_none()
        && ask.source.is_none()
        && ask.tier.is_none()
        && ask.occurred_after.is_none()
        && ask.occurred_before.is_none()
        && ask.updated_after.is_none()
        && ask.updated_before.is_none()
}

/// What the pair stands at, and whether a listing that finds it absent may ask for it to be kept.
struct Held {
    standing: sort_keys::Standing,
    addable: bool,
}

fn choose(
    rules: &Rules,
    reach: &Reach,
    ask: &Ask,
    held: impl FnOnce(&str) -> Result<Held>,
) -> Result<Reading> {
    let narrowed = reach.narrowed(|type_id| keeps_type(rules, &ask.types, ask.system, type_id));
    let Some(type_id) = narrowed.only_type().filter(|_| walkable(ask)) else {
        return Ok(Reading::Scan(None));
    };
    Ok(match held(type_id)? {
        Held {
            standing: sort_keys::Standing::Ready,
            ..
        } => Reading::Keys(type_id.to_string()),
        Held {
            standing: sort_keys::Standing::Absent,
            addable: true,
        } => Reading::Scan(Some(type_id.to_string())),
        _ => Reading::Scan(None),
    })
}

pub(super) fn reading(
    read: &Reader<'_, '_>,
    reach: &Reach,
    ask: &Ask,
    name: &str,
) -> Result<Reading> {
    let rules = &read.catalog.rules;
    choose(rules, reach, ask, |type_id| {
        let standing = sort_keys::standing(read.tx, type_id, name)?;
        let addable = standing == sort_keys::Standing::Absent
            && sort_keys::declares(rules, type_id, name)
            && !sort_keys::dropping(read.tx, type_id, name)?
            && sort_keys::room(read.tx, rules)?
            && sort_keys::large(read.tx, type_id)?;
        Ok(Held { standing, addable })
    })
}

enum Bound {
    All,
    After(Value, String),
    Present,
    Tie(Value, String),
    Below(Value),
    Missing,
    MissingAfter(String),
}

fn segment(
    selected: &Sql,
    (type_id, name): (&str, &str),
    (bound, order): (&Bound, &str),
    take: i64,
) -> Sql {
    let mut sql = Sql::new(
        "SELECT i.seq, k.value, k.id FROM item_sort_keys k CROSS JOIN items i ON i.seq = k.seq \
         WHERE k.type = ",
    );
    sql.bind(type_id.to_string());
    sql.push(" AND k.name = ");
    sql.bind(name.to_string());
    sql.push(" AND ");
    match bound {
        Bound::All => sql.push("1"),
        Bound::After(Value::Null, id) => {
            sql.push("(k.value, k.id) > (X'', ");
            sql.bind(id.clone());
            sql.push(")");
        }
        Bound::After(value, id) => {
            sql.push("(k.value, k.id) > (");
            sql.bind(value.clone());
            sql.push(", ");
            sql.bind(id.clone());
            sql.push(")");
        }
        Bound::Present => sql.push("k.value < X''"),
        Bound::Tie(value, id) => {
            sql.push("k.value = ");
            sql.bind(value.clone());
            sql.push(" AND k.id > ");
            sql.bind(id.clone());
        }
        Bound::Below(value) => {
            sql.push("k.value < ");
            sql.bind(value.clone());
        }
        Bound::Missing => sql.push("k.value = X''"),
        Bound::MissingAfter(id) => {
            sql.push("k.value = X'' AND k.id > ");
            sql.bind(id.clone());
        }
    }
    sql.push(" AND ");
    sql.append(selected);
    sql.push(" ORDER BY ");
    sql.push(order);
    sql.push(" LIMIT ");
    sql.bind(take);
    sql
}

/// The segments of a listing after `position`, in order: each is a range of one index.
fn segments(descending: bool, position: Option<&Position>) -> Vec<(Bound, &'static str)> {
    const ASCENDING: &str = "k.value ASC, k.id ASC";
    const DESCENDING: &str = "k.value DESC, k.id ASC";
    const BY_ID: &str = "k.id ASC";
    let held = position.and_then(|position| position.keys.first().map(|key| (key, &position.id)));
    if !descending {
        return vec![(
            match held {
                Some((key, id)) => Bound::After(key.clone(), id.clone()),
                None => Bound::All,
            },
            ASCENDING,
        )];
    }
    match held {
        None => vec![(Bound::Present, DESCENDING), (Bound::Missing, BY_ID)],
        Some((Value::Null, id)) => vec![(Bound::MissingAfter(id.clone()), BY_ID)],
        Some((key, id)) => vec![
            (Bound::Tie(key.clone(), id.clone()), BY_ID),
            (Bound::Below(key.clone()), DESCENDING),
            (Bound::Missing, BY_ID),
        ],
    }
}

/// One more row than `limit`, so the caller knows whether another page follows.
pub(super) fn page(
    tx: &Transaction<'_>,
    selected: &Sql,
    pair: (&str, &str),
    descending: bool,
    position: Option<&Position>,
    limit: i64,
) -> Result<Vec<Found>> {
    let wanted = limit + 1;
    let mut rows: Vec<Found> = Vec::new();
    for (bound, order) in segments(descending, position) {
        let take = wanted - rows.len() as i64;
        let sql = segment(selected, pair, (&bound, order), take);
        rows.extend(found(tx, &sql, 1)?);
        if rows.len() as i64 >= wanted {
            break;
        }
    }
    for row in &mut rows {
        if let Some(key) = row.position.keys.first_mut()
            && matches!(key, Value::Blob(_))
        {
            *key = Value::Null;
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::*;
    use crate::app::items::sort_keys::{self, Standing};
    use crate::app::query::compile::Filter;
    use crate::db::migrate::MIGRATIONS;
    use marfa_rules::query::property_sort_expression;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn
    }

    fn put(conn: &Connection, n: usize, type_id: &str, properties: &str) {
        conn.execute(
            "INSERT INTO items (id, type, state, source, version, schema_version, occurred_at, \
             created_at, updated_at, last_activity_at, properties) \
             VALUES (?1, ?2, 'active', 's', 1, 0, 't', 't', 't', 't', jsonb(?3))",
            params![format!("id-{n:03}"), type_id, properties],
        )
        .unwrap();
    }

    const VALUES: [&str; 22] = [
        r#"{"p":"b"}"#,
        r#"{"p":"a"}"#,
        r#"{"p":"b"}"#,
        r#"{"p":""}"#,
        r#"{"p":"10"}"#,
        r#"{"p":"9"}"#,
        r#"{"p":10}"#,
        r#"{"p":9.5}"#,
        r#"{"p":9}"#,
        r#"{"p":true}"#,
        r#"{"p":false}"#,
        r#"{"p":1}"#,
        r#"{"p":0}"#,
        r#"{"p":-3.25}"#,
        r#"{"p":null}"#,
        r#"{"p":{"q":1}}"#,
        r#"{"p":[1,2]}"#,
        r#"{"q":"x"}"#,
        r#"{}"#,
        r#"{"p":"é"}"#,
        r#"{"p":"Z"}"#,
        r#"{"p":"a"}"#,
    ];

    fn scan(conn: &Connection, descending: bool) -> Vec<String> {
        let expression = property_sort_expression("properties", "'$.p'");
        let direction = if descending { "DESC" } else { "ASC" };
        let mut statement = conn
            .prepare(&format!(
                "SELECT id FROM items WHERE type = 'core.note' \
                 ORDER BY ({expression}) IS NULL, ({expression}) {direction}, id ASC"
            ))
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|id| id.unwrap())
            .collect()
    }

    fn walked(conn: &Connection, descending: bool, limit: i64) -> Vec<String> {
        let tx = conn.unchecked_transaction().unwrap();
        let selected = Sql::new("+i.type IN ('core.note')");
        let mut ids = Vec::new();
        let mut position: Option<Position> = None;
        loop {
            let pair = ("core.note", "p");
            let mut rows =
                page(&tx, &selected, pair, descending, position.as_ref(), limit).unwrap();
            let more = rows.len() as i64 > limit;
            rows.truncate(limit as usize);
            ids.extend(rows.iter().map(|row| row.position.id.clone()));
            position = rows.last().map(|row| Position {
                keys: row.position.keys.clone(),
                id: row.position.id.clone(),
            });
            if !more {
                return ids;
            }
        }
    }

    fn fill(conn: &Connection) {
        let tx = conn.unchecked_transaction().unwrap();
        while sort_keys::fill_page(&tx).unwrap() {}
        tx.commit().unwrap();
    }

    fn check(conn: &Connection) {
        for descending in [false, true] {
            let wanted = scan(conn, descending);
            for limit in [1, 3, 50] {
                assert_eq!(
                    walked(conn, descending, limit),
                    wanted,
                    "descending {descending}, pages of {limit}"
                );
            }
        }
    }

    #[test]
    fn keys_give_the_order_of_a_scan_however_they_were_made() {
        let conn = db();
        for (n, properties) in VALUES.iter().enumerate().take(11) {
            put(&conn, n, "core.note", properties);
        }
        conn.execute(
            "INSERT INTO sort_indexes (type, name) VALUES ('core.note', 'p')",
            [],
        )
        .unwrap();
        for (n, properties) in VALUES.iter().enumerate().skip(11) {
            put(&conn, n, "core.note", properties);
        }
        put(&conn, 90, "core.task", r#"{"p":"other type"}"#);
        fill(&conn);
        check(&conn);

        conn.execute(
            "UPDATE items SET properties = jsonb('{\"p\":\"b\"}') WHERE id IN ('id-004', 'id-017')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE items SET type = 'core.task' WHERE id = 'id-000'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE items SET type = 'core.note' WHERE id = 'id-090'",
            [],
        )
        .unwrap();
        conn.execute("UPDATE items SET state = 'trashed' WHERE id = 'id-001'", [])
            .unwrap();
        conn.execute("DELETE FROM items WHERE id IN ('id-009', 'id-021')", [])
            .unwrap();
        check(&conn);

        let keys: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_sort_keys", [], |row| row.get(0))
            .unwrap();
        let items: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE type = 'core.note'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(keys, items);
    }

    #[test]
    fn an_item_written_while_the_walk_is_under_way_keeps_one_key() {
        let conn = db();
        for (n, properties) in VALUES.iter().enumerate() {
            put(&conn, n, "core.note", properties);
        }
        conn.execute(
            "INSERT INTO sort_indexes (type, name) VALUES ('core.note', 'p')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE items SET properties = jsonb('{\"p\":\"zz\"}') WHERE id = 'id-020'",
            [],
        )
        .unwrap();
        put(&conn, 95, "core.note", r#"{"p":"late"}"#);
        fill(&conn);
        check(&conn);
    }

    fn held(standing: Standing, addable: bool) -> impl FnOnce(&str) -> Result<Held> {
        move |_| Ok(Held { standing, addable })
    }

    fn chosen(reach: &Reach, ask: &Ask, standing: Standing, addable: bool) -> Option<Reading> {
        choose(&Rules::empty(), reach, ask, held(standing, addable)).ok()
    }

    fn open() -> Reach {
        Reach::testing(&["core.note"], &[], &[])
    }

    fn is_scan(reading: Option<Reading>, add: Option<&str>) -> bool {
        matches!(reading, Some(Reading::Scan(held)) if held.as_deref() == add)
    }

    #[test]
    fn ready_keys_are_read_and_a_walk_under_way_is_not() {
        let ask = Ask::default();
        assert!(matches!(
            chosen(&open(), &ask, Standing::Ready, false),
            Some(Reading::Keys(type_id)) if type_id == "core.note"
        ));
        assert!(is_scan(
            chosen(&open(), &ask, Standing::Filling, true),
            None
        ));
    }

    #[test]
    fn a_reach_held_to_sources_never_reads_keys() {
        let held_reach = Reach::testing(&[], &["core.note"], &["s"]);
        let mixed = Reach::testing(&["core.note"], &["core.task"], &["s"]);
        let two = Reach::testing(&["core.note", "core.task"], &[], &[]);
        for reach in [held_reach, mixed, two] {
            assert!(is_scan(
                chosen(&reach, &Ask::default(), Standing::Ready, true),
                None
            ));
        }
    }

    #[test]
    fn an_ask_that_leaves_few_keys_standing_reads_by_scan() {
        let text = "source eq \"a\"";
        let others = [
            Ask {
                filter: Some(Filter {
                    text: text.to_string(),
                    expression: marfa_rules::filter::parse(text).unwrap(),
                }),
                ..Ask::default()
            },
            Ask {
                tags: vec!["a".to_string()],
                ..Ask::default()
            },
            Ask {
                beneath: Some("id".to_string()),
                ..Ask::default()
            },
            Ask {
                source: Some("s".to_string()),
                ..Ask::default()
            },
            Ask {
                tier: Some("feed".to_string()),
                ..Ask::default()
            },
            Ask {
                occurred_after: Some("t".to_string()),
                ..Ask::default()
            },
            Ask {
                occurred_before: Some("t".to_string()),
                ..Ask::default()
            },
            Ask {
                updated_after: Some("t".to_string()),
                ..Ask::default()
            },
            Ask {
                updated_before: Some("t".to_string()),
                ..Ask::default()
            },
            Ask {
                states: States::Named(vec!["trashed".to_string(), "archived".to_string()]),
                ..Ask::default()
            },
        ];
        for ask in &others {
            assert!(
                is_scan(chosen(&open(), ask, Standing::Ready, true), None),
                "{ask:?}"
            );
        }
        let active = Ask {
            states: States::Named(vec!["trashed".to_string(), "active".to_string()]),
            types: vec!["core.note".to_string()],
            ..Ask::default()
        };
        assert!(matches!(
            chosen(&open(), &active, Standing::Ready, false),
            Some(Reading::Keys(_))
        ));
    }

    #[test]
    fn an_absent_pair_is_asked_for_only_where_it_may_be_added() {
        let ask = Ask::default();
        assert!(is_scan(
            chosen(&open(), &ask, Standing::Absent, true),
            Some("core.note")
        ));
        assert!(is_scan(
            chosen(&open(), &ask, Standing::Absent, false),
            None
        ));
    }
}
