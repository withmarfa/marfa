//! Which property sorts are read from `item_sort_keys`, the walk that gives existing items their keys, and the removal of a dropped pair's keys.

use marfa_rules::catalog::Catalog as Rules;
use marfa_rules::query::property_sort_expression;
use rusqlite::{OptionalExtension, Transaction, params};

use crate::app::refusal::Result;

/// A type with fewer items sorts faster by reading them all than by keeping keys for each write.
pub const MIN_ITEMS: i64 = 20_000;

/// Each pair costs every write to its type, so the number a server keeps is bounded.
const MAX_PAIRS: i64 = 16;

/// Item numbers one write walks, so no write holds the writer for more than a bounded range.
const FILL_WINDOW: i64 = 10_000;

/// Keys one write removes from a dropped pair.
const DROP_PAGE: i64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Absent,
    Filling,
    Ready,
}

pub fn standing(tx: &Transaction<'_>, type_id: &str, name: &str) -> Result<Standing> {
    let ready: Option<i64> = tx
        .prepare_cached("SELECT ready FROM sort_indexes WHERE type = ?1 AND name = ?2")?
        .query_row([type_id, name], |row| row.get(0))
        .optional()?;
    Ok(match ready {
        None => Standing::Absent,
        Some(0) => Standing::Filling,
        Some(_) => Standing::Ready,
    })
}

pub fn large(tx: &Transaction<'_>, type_id: &str) -> Result<bool> {
    let held: i64 = tx
        .prepare_cached("SELECT COUNT(*) FROM (SELECT 1 FROM items WHERE type = ?1 LIMIT ?2)")?
        .query_row(params![type_id, MIN_ITEMS], |row| row.get(0))?;
    Ok(held >= MIN_ITEMS)
}

/// Whether the type, or one it inherits from, declares the property.
pub fn declares(rules: &Rules, type_id: &str, name: &str) -> bool {
    rules
        .resolved(type_id)
        .is_ok_and(|fields| fields.contains_key(name))
}

fn kept(tx: &Transaction<'_>) -> Result<Vec<(String, String)>> {
    Ok(tx
        .prepare_cached("SELECT type, name FROM sort_indexes")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Whether the pair's keys are still being removed, so it may not be added again yet.
pub fn dropping(tx: &Transaction<'_>, type_id: &str, name: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM sort_indexes_dropping WHERE type = ?1 AND name = ?2)",
        )?
        .query_row([type_id, name], |row| row.get(0))?)
}

/// Whether another pair may be kept; a pair of a type or property no longer declared does not count.
pub fn room(tx: &Transaction<'_>, rules: &Rules) -> Result<bool> {
    let live = kept(tx)?
        .iter()
        .filter(|(type_id, name)| declares(rules, type_id, name))
        .count();
    Ok((live as i64) < MAX_PAIRS)
}

/// Adds a pair to the ones kept, and says whether it did; `fill_page` keys the items already written.
pub fn add(tx: &Transaction<'_>, rules: &Rules, type_id: &str, name: &str) -> Result<bool> {
    if !declares(rules, type_id, name) || standing(tx, type_id, name)? != Standing::Absent {
        return Ok(false);
    }
    if dropping(tx, type_id, name)? || !room(tx, rules)? || !large(tx, type_id)? {
        return Ok(false);
    }
    tx.prepare_cached("INSERT INTO sort_indexes (type, name) VALUES (?1, ?2)")?
        .execute([type_id, name])?;
    Ok(true)
}

/// Stops keeping each pair whose type or property is no longer declared; `fill_page` removes its keys.
pub fn drop_undeclared(tx: &Transaction<'_>, rules: &Rules) -> Result<()> {
    for (type_id, name) in kept(tx)? {
        if declares(rules, &type_id, &name) {
            continue;
        }
        tx.prepare_cached("DELETE FROM sort_indexes WHERE type = ?1 AND name = ?2")?
            .execute([&type_id, &name])?;
        tx.prepare_cached(
            "INSERT OR IGNORE INTO sort_indexes_dropping (type, name) VALUES (?1, ?2)",
        )?
        .execute([&type_id, &name])?;
    }
    Ok(())
}

fn drop_page(tx: &Transaction<'_>) -> Result<bool> {
    let pair: Option<(String, String)> = tx
        .prepare_cached("SELECT type, name FROM sort_indexes_dropping LIMIT 1")?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((type_id, name)) = pair else {
        return Ok(false);
    };
    let removed = tx
        .prepare_cached(
            "DELETE FROM item_sort_keys WHERE (type, name, value, id) IN \
             (SELECT type, name, value, id FROM item_sort_keys WHERE type = ?1 AND name = ?2 LIMIT ?3)",
        )?
        .execute(params![type_id, name, DROP_PAGE])?;
    if (removed as i64) < DROP_PAGE {
        tx.prepare_cached("DELETE FROM sort_indexes_dropping WHERE type = ?1 AND name = ?2")?
            .execute([&type_id, &name])?;
    }
    Ok(true)
}

/// One page of work: removing the keys of a dropped pair, else walking the first pair not yet ready.
/// Says whether any is still to do.
pub fn fill_page(tx: &Transaction<'_>) -> Result<bool> {
    if drop_page(tx)? {
        return Ok(true);
    }
    let pair: Option<(String, String, i64)> = tx
        .prepare_cached(
            "SELECT type, name, filled_through FROM sort_indexes WHERE ready = 0 LIMIT 1",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((type_id, name, after)) = pair else {
        return Ok(false);
    };
    let top: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) FROM items", [], |row| {
        row.get(0)
    })?;
    if after >= top {
        tx.prepare_cached("UPDATE sort_indexes SET ready = 1 WHERE type = ?1 AND name = ?2")?
            .execute([&type_id, &name])?;
        return more(tx);
    }
    let through = top.min(after + FILL_WINDOW);
    let path = format!("$.{name}");
    let value = format!(
        "COALESCE({}, X'')",
        property_sort_expression("properties", "?2")
    );
    tx.prepare_cached(&format!(
        "INSERT OR IGNORE INTO item_sort_keys (type, name, value, id, seq) \
         SELECT type, ?3, {value}, id, seq FROM items NOT INDEXED \
         WHERE seq > ?4 AND seq <= ?5 AND type = ?1"
    ))?
    .execute(params![type_id, path, name, after, through])?;
    tx.prepare_cached("UPDATE sort_indexes SET filled_through = ?3 WHERE type = ?1 AND name = ?2")?
        .execute(params![type_id, name, through])?;
    Ok(true)
}

fn more(tx: &Transaction<'_>) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM sort_indexes WHERE ready = 0) \
         OR EXISTS (SELECT 1 FROM sort_indexes_dropping)",
        [],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use marfa_rules::catalog::CatalogEntry;
    use rusqlite::Connection;
    use serde_json::{Map, Value, json};

    use super::*;
    use crate::db::migrate::MIGRATIONS;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn
    }

    fn items(conn: &Connection, type_id: &str, count: i64) {
        conn.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) \
             INSERT INTO items (id, type, state, source, version, schema_version, occurred_at, \
             created_at, updated_at, last_activity_at, properties) \
             SELECT ?1 || i, ?1, 'active', 's', 1, 0, 't', 't', 't', 't', jsonb('{\"p\":\"x\"}') FROM n",
            params![type_id, count],
        )
        .unwrap();
    }

    fn rules(types: &[(&str, &[&str])]) -> Rules {
        inheriting(
            &types
                .iter()
                .map(|(id, fields)| (*id, None, *fields))
                .collect::<Vec<_>>(),
        )
    }

    fn inheriting(types: &[(&str, Option<&str>, &[&str])]) -> Rules {
        let entries: HashMap<String, CatalogEntry> = types
            .iter()
            .map(|(id, parent, fields)| {
                let definitions: Map<String, Value> = fields
                    .iter()
                    .map(|name| (name.to_string(), json!({"type": "string"})))
                    .collect();
                let entry = CatalogEntry {
                    parent: parent.map(str::to_string),
                    title_field: None,
                    thumbnail_field: None,
                    body_field: None,
                    name_from_body: None,
                    icon: None,
                    fields: definitions.keys().cloned().collect(),
                    definitions,
                };
                (id.to_string(), entry)
            })
            .collect();
        Rules::new(entries, None)
    }

    fn pairs(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM sort_indexes", [], |row| row.get(0))
            .unwrap()
    }

    fn keys(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM item_sort_keys", [], |row| row.get(0))
            .unwrap()
    }

    fn drain(conn: &Connection) {
        loop {
            let tx = conn.unchecked_transaction().unwrap();
            let more = fill_page(&tx).unwrap();
            tx.commit().unwrap();
            if !more {
                break;
            }
        }
    }

    #[test]
    fn an_undeclared_name_never_adds_a_pair() {
        let conn = db();
        items(&conn, "core.note", MIN_ITEMS);
        let rules = rules(&[("core.note", &["p"])]);
        let tx = conn.unchecked_transaction().unwrap();
        assert!(!add(&tx, &rules, "core.note", "made_up").unwrap());
        assert!(!add(&tx, &rules, "core.unknown", "p").unwrap());
        assert_eq!(pairs(&conn), 0);
        assert!(add(&tx, &rules, "core.note", "p").unwrap());
        assert_eq!(pairs(&conn), 1);
    }

    #[test]
    fn a_pair_still_being_dropped_is_not_added_again() {
        let conn = db();
        items(&conn, "core.note", MIN_ITEMS);
        let rules = rules(&[("core.note", &["p"])]);
        conn.execute(
            "INSERT INTO sort_indexes_dropping (type, name) VALUES ('core.note', 'p')",
            [],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(dropping(&tx, "core.note", "p").unwrap());
        assert!(!add(&tx, &rules, "core.note", "p").unwrap());
        assert_eq!(pairs(&conn), 0);
        tx.execute("DELETE FROM sort_indexes_dropping", []).unwrap();
        assert!(!dropping(&tx, "core.note", "p").unwrap());
        assert!(add(&tx, &rules, "core.note", "p").unwrap());
    }

    #[test]
    fn a_property_declared_by_a_parent_type_counts_for_the_child() {
        let rules = inheriting(&[
            ("core.base", None, &["p"]),
            ("core.note", Some("core.base"), &["q"]),
        ]);
        assert!(declares(&rules, "core.note", "p"));
        assert!(declares(&rules, "core.note", "q"));
        assert!(!declares(&rules, "core.base", "q"));
        assert!(!declares(&rules, "core.note", "r"));
    }

    #[test]
    fn the_cap_holds() {
        let conn = db();
        let names: Vec<String> = (0..=MAX_PAIRS).map(|n| format!("p{n}")).collect();
        let fields: Vec<&str> = names.iter().map(String::as_str).collect();
        items(&conn, "core.note", MIN_ITEMS);
        let rules = rules(&[("core.note", &fields)]);
        let tx = conn.unchecked_transaction().unwrap();
        for name in &names[..MAX_PAIRS as usize] {
            assert!(add(&tx, &rules, "core.note", name).unwrap());
        }
        assert!(!room(&tx, &rules).unwrap());
        assert!(!add(&tx, &rules, "core.note", &names[MAX_PAIRS as usize]).unwrap());
        assert_eq!(pairs(&conn), MAX_PAIRS);
    }

    #[test]
    fn a_removed_type_or_dropped_field_frees_its_pairs_and_keys() {
        let conn = db();
        items(&conn, "core.note", MIN_ITEMS);
        let both = rules(&[("core.note", &["p", "q"])]);
        let tx = conn.unchecked_transaction().unwrap();
        assert!(add(&tx, &both, "core.note", "p").unwrap());
        assert!(add(&tx, &both, "core.note", "q").unwrap());
        tx.commit().unwrap();
        drain(&conn);
        assert_eq!(keys(&conn), 2 * MIN_ITEMS);

        let without_q = rules(&[("core.note", &["p"])]);
        let tx = conn.unchecked_transaction().unwrap();
        assert!(room(&tx, &without_q).unwrap());
        drop_undeclared(&tx, &without_q).unwrap();
        tx.commit().unwrap();
        assert_eq!(pairs(&conn), 1);
        drain(&conn);
        assert_eq!(keys(&conn), MIN_ITEMS);

        let none = rules(&[]);
        let tx = conn.unchecked_transaction().unwrap();
        drop_undeclared(&tx, &none).unwrap();
        tx.commit().unwrap();
        assert_eq!(pairs(&conn), 0);
        drain(&conn);
        assert_eq!(keys(&conn), 0);
        let dropping: i64 = conn
            .query_row("SELECT COUNT(*) FROM sort_indexes_dropping", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(dropping, 0);
    }

    #[test]
    fn pairs_of_a_removed_type_do_not_count_against_the_cap() {
        let conn = db();
        let names: Vec<String> = (0..MAX_PAIRS).map(|n| format!("p{n}")).collect();
        let fields: Vec<&str> = names.iter().map(String::as_str).collect();
        items(&conn, "core.note", MIN_ITEMS);
        items(&conn, "core.task", MIN_ITEMS);
        let both = rules(&[("core.note", &fields), ("core.task", &["p0"])]);
        let tx = conn.unchecked_transaction().unwrap();
        for name in &names {
            assert!(add(&tx, &both, "core.note", name).unwrap());
        }
        assert!(!add(&tx, &both, "core.task", "p0").unwrap());
        let removed = rules(&[("core.task", &["p0"])]);
        assert!(room(&tx, &removed).unwrap());
        assert!(add(&tx, &removed, "core.task", "p0").unwrap());
    }

    #[test]
    fn the_walk_reads_a_bounded_range_and_keys_every_item_once() {
        let conn = db();
        items(&conn, "core.note", 2 * FILL_WINDOW + 5);
        conn.execute(
            "INSERT INTO sort_indexes (type, name) VALUES ('core.note', 'p')",
            [],
        )
        .unwrap();
        let mut pages = 0;
        loop {
            let tx = conn.unchecked_transaction().unwrap();
            let more = fill_page(&tx).unwrap();
            tx.commit().unwrap();
            let through: i64 = conn
                .query_row("SELECT filled_through FROM sort_indexes", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert!(keys(&conn) <= through);
            assert!(through <= pages * FILL_WINDOW + FILL_WINDOW);
            pages += 1;
            if !more {
                break;
            }
        }
        assert_eq!(keys(&conn), 2 * FILL_WINDOW + 5);
        let ready: i64 = conn
            .query_row("SELECT ready FROM sort_indexes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ready, 1);
    }
}
