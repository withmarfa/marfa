//! Counts of linked items and of table rows, answered as the server's `POST /items/counts`.

use std::collections::HashMap;

use marfa_rules::catalog::{Catalog, STATUS_GROUPS};
use marfa_rules::filter::parse;
use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::error::CoreError;
use crate::{Core, Result, filter, store, tables};

/// The most ids one count takes.
pub const MOST_IDS: usize = 100;

/// What a count counts for each item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Counted {
    /// The items an edge of the type leaves the item for: `backref[<type>]`.
    Backref(String),
    /// The items that have an edge of the type to the item: `edge[<type>]`.
    Edge(String),
    /// The rows the item holds in the table.
    Table(String),
}

/// The counted items in each status group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct StatusGroups {
    pub not_started: i64,
    pub in_progress: i64,
    pub completed: i64,
    pub canceled: i64,
}

impl StatusGroups {
    fn of(counts: [i64; 4]) -> Self {
        let [not_started, in_progress, completed, canceled] = counts;
        StatusGroups {
            not_started,
            in_progress,
            completed,
            canceled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ItemCount {
    pub id: String,
    pub total: i64,
    /// None for a table's rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_groups: Option<StatusGroups>,
    /// True where the copy answered, false where the server did.
    pub held: bool,
}

fn refused(message: impl Into<String>) -> CoreError {
    CoreError::Validation {
        server: None,
        code: "validation_error".into(),
        message: message.into(),
        details: None,
    }
}

/// The distinct ids in the order they first appear, refused as the server refuses them.
fn distinct(ids: &[String]) -> Result<Vec<String>> {
    if ids.len() > MOST_IDS {
        return Err(refused(format!("Maximum {MOST_IDS} ids per call")));
    }
    let mut seen = std::collections::HashSet::new();
    let mut distinct = Vec::new();
    for id in ids {
        marfa_rules::validation::id("id", id)?;
        if seen.insert(id.as_str()) {
            distinct.push(id.clone());
        }
    }
    Ok(distinct)
}

/// A copy that leaves an item out cannot count it, so it refuses where an
/// edge of the counted type reaches an item it does not hold: whether the
/// server counts that item depends on what the copy lacks.
fn linked(
    conn: &Connection,
    catalog: &Catalog,
    ids: &[String],
    edge_type: &str,
    backref: bool,
) -> Result<Vec<ItemCount>> {
    if !store::whole_edge_types(conn)?
        .iter()
        .any(|held| held == edge_type)
    {
        return Err(CoreError::Invalid(format!(
            "a count of {edge_type:?} is not answered from a working copy that does not hold that edge type whole: hydrate with it as an edge type held whole, or ask the server"
        )));
    }
    let (anchor, other) = if backref {
        ("from_id", "to_id")
    } else {
        ("to_id", "from_id")
    };
    let whole = [edge_type.to_string()];
    let mut values: Vec<Value> = Vec::new();
    let mut groups = String::new();
    for group in STATUS_GROUPS {
        let expression = parse(&format!("status_group eq \"{group}\""))?;
        groups.push_str(", SUM(CASE WHEN ");
        groups.push_str(&filter::expression_clause(
            &expression,
            &mut values,
            &whole,
            catalog,
        )?);
        groups.push_str(" THEN 1 ELSE 0 END)");
    }
    let marks = vec!["?"; ids.len()].join(", ");
    let mut found: HashMap<String, (i64, [i64; 4])> = HashMap::new();
    // A backref count is the server's only for an anchor it reads, which a
    // copy that lacks the anchor cannot tell, so that counts as a gap too.
    let gap = format!(
        "SELECT 1 FROM edges e
          WHERE e.edge_type = ? AND e.{anchor} IN ({marks})
            AND (NOT EXISTS (SELECT 1 FROM items WHERE items.id = e.{other})
                 {anchor_gap})
          LIMIT 1",
        anchor_gap = if backref {
            "OR NOT EXISTS (SELECT 1 FROM items WHERE items.id = e.from_id)"
        } else {
            ""
        }
    );
    let bound = |ids: &[String], first: &str| -> Vec<rusqlite::types::Value> {
        std::iter::once(first.to_string())
            .chain(ids.iter().cloned())
            .map(rusqlite::types::Value::Text)
            .collect()
    };
    if conn
        .prepare_cached(&gap)?
        .exists(params_from_iter(bound(ids, edge_type)))?
    {
        return Err(CoreError::Invalid(format!(
            "a count of {edge_type:?} reaches an item this working copy does not hold, so it cannot say how many the server counts: ask the server"
        )));
    }
    if !ids.is_empty() {
        let sql = format!(
            "SELECT e.{anchor}, COUNT(*){groups}
               FROM edges e CROSS JOIN items ON items.id = e.{other}
              WHERE e.edge_type = ? AND e.{anchor} IN ({marks})
                AND items.state = 'active' AND items.type NOT LIKE 'system.%'
              GROUP BY e.{anchor}"
        );
        let mut params: Vec<rusqlite::types::Value> = values.iter().map(store::sql_value).collect();
        params.extend(bound(ids, edge_type));
        let mut statement = conn.prepare_cached(&sql)?;
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                [row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?],
            ))
        })?;
        for row in rows {
            let (id, total, groups) = row?;
            found.insert(id, (total, groups));
        }
    }
    Ok(ids
        .iter()
        .map(|id| {
            let (total, counts) = found.get(id).copied().unwrap_or((0, [0; 4]));
            ItemCount {
                id: id.clone(),
                total,
                status_groups: Some(StatusGroups::of(counts)),
                held: true,
            }
        })
        .collect())
}

/// `None` where the copy does not hold the table whole, so the server counts it.
fn rows_held(conn: &Connection, id: &str, table: &str) -> Result<Option<i64>> {
    if tables::local_table(conn, id, table)?.is_none() {
        return Ok(None);
    }
    Ok(Some(conn.query_row(
        "SELECT COUNT(*) FROM table_rows WHERE item_id = ?1 AND name = ?2",
        [id, table],
        |row| row.get(0),
    )?))
}

impl Core {
    /// For each of up to `MOST_IDS` ids, once each in the order they first
    /// appear, how many items an edge of the type links to it, or how many
    /// rows it holds in a table. A count equals what a local list anchored
    /// by the same `backref` or `edge` filter, with no `state`, lists: active
    /// items only, none in the bin, archived or `system.*`. Links are counted
    /// from the copy, and refused `Invalid` where it does not hold the edge
    /// type whole or lacks an item an edge reaches. Rows are counted from the
    /// copy for a table it holds whole and by the server for the rest.
    pub fn counts(&self, ids: &[String], counted: &Counted) -> Result<Vec<ItemCount>> {
        let ids = distinct(ids)?;
        match counted {
            Counted::Backref(edge_type) | Counted::Edge(edge_type) => {
                if !marfa_rules::filter::edge_type_named(edge_type) {
                    return Err(refused(
                        "an edge type is not blank, has no space and no closing bracket.",
                    ));
                }
                let backref = matches!(counted, Counted::Backref(_));
                store::read_marked(&mut *self.conn()?, |conn, _| {
                    store::refuse_unless_usable(conn)?;
                    let catalog = crate::catalog::load(conn)?;
                    linked(conn, &catalog, &ids, edge_type, backref)
                })
            }
            Counted::Table(table) => {
                if !marfa_rules::catalog::api_name(table) {
                    return Err(refused(
                        "a table is a lowercase letter and then at most 63 lowercase letters, digits and underscores.",
                    ));
                }
                self.lay_rows()?;
                let held: Vec<Option<i64>> = store::read_marked(&mut *self.conn()?, |conn, _| {
                    ids.iter().map(|id| rows_held(conn, id, table)).collect()
                })?;
                let asked: Vec<&String> = ids
                    .iter()
                    .zip(&held)
                    .filter(|(_, held)| held.is_none())
                    .map(|(id, _)| id)
                    .collect();
                let mut answered: HashMap<String, i64> = HashMap::new();
                if !asked.is_empty() {
                    answered = self.http()?.item_counts(&asked, table)?;
                }
                Ok(ids
                    .iter()
                    .zip(held)
                    .map(|(id, held)| ItemCount {
                        id: id.clone(),
                        total: held
                            .unwrap_or_else(|| answered.get(id).copied().unwrap_or_default()),
                        status_groups: None,
                        held: held.is_some(),
                    })
                    .collect())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use marfa_rules::catalog::Indexing;
    use serde_json::json;

    use super::*;
    use crate::model::ListFilters;
    use crate::scripted::{self, Scripted};
    use crate::stop_tests::{copy, holding_a_catalog};
    use crate::store::testing::*;

    const PARENT: &str = "parent";

    fn put(conn: &Connection, id: &str, kind: &str, state: &str, properties: Value) {
        let item = wire_item(id, kind, state, "2026-01-01T00:00:00Z", properties);
        store::upsert_item(conn, &item, None, &Indexing::default()).unwrap();
    }

    /// A task with a child in every group and each kind of child that is not counted.
    fn tasks() -> Connection {
        let conn = conn();
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(json!([
                { "id": "acme.task", "fields": { "state": { "type": "status", "status_values": [
                    { "value": "todo", "group": "not_started" },
                    { "value": "doing", "group": "in_progress" },
                    { "value": "done", "group": "completed" },
                    { "value": "dropped", "group": "canceled" }
                ] } } },
                { "id": "acme.note", "fields": { "state": { "type": "string" } } },
                { "id": "system.job", "fields": {} }
            ]))
            .unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        put(&conn, PARENT, "acme.task", "active", json!({}));
        put(&conn, "lone", "acme.task", "active", json!({}));
        let children = [
            ("todo", "acme.task", "active", json!({ "state": "todo" })),
            ("todo2", "acme.task", "active", json!({ "state": "todo" })),
            ("doing", "acme.task", "active", json!({ "state": "doing" })),
            ("done", "acme.task", "active", json!({ "state": "done" })),
            (
                "dropped",
                "acme.task",
                "active",
                json!({ "state": "dropped" }),
            ),
            (
                "undeclared",
                "acme.task",
                "active",
                json!({ "state": "pending" }),
            ),
            ("blank", "acme.task", "active", json!({})),
            ("note", "acme.note", "active", json!({ "state": "done" })),
            (
                "archived",
                "acme.task",
                "archived",
                json!({ "state": "done" }),
            ),
            ("binned", "acme.task", "trashed", json!({ "state": "done" })),
            ("system", "system.job", "active", json!({ "state": "done" })),
        ];
        for (index, (id, kind, state, properties)) in children.into_iter().enumerate() {
            put(&conn, id, kind, state, properties);
            store::upsert_edge(
                &conn,
                &wire_edge(&format!("e{index}"), PARENT, id, "parent-of"),
            )
            .unwrap();
        }
        // The child of `todo`, so a count has more than one anchor with children.
        put(
            &conn,
            "grandchild",
            "acme.task",
            "active",
            json!({ "state": "done" }),
        );
        store::upsert_edge(&conn, &wire_edge("g", "todo", "grandchild", "parent-of")).unwrap();
        put(&conn, "set", "acme.task", "active", json!({}));
        store::upsert_edge(&conn, &wire_edge("m", "todo", "set", "in-collection")).unwrap();
        hold_whole(&conn, &["parent-of", "in-collection"]);
        conn
    }

    fn hold_whole(conn: &Connection, types: &[&str]) {
        store::meta_set(
            conn,
            store::META_SLICE_EDGE_TYPES,
            &serde_json::to_string(types).unwrap(),
        )
        .unwrap();
    }

    fn named(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    /// The local list leaves nothing out by type, so `system.*` is removed here, as the count rule removes it.
    fn listed(conn: &Connection, filter: &str) -> i64 {
        let catalog = crate::catalog::load(conn).unwrap();
        let filters = ListFilters {
            filter: Some(filter.into()),
            ..ListFilters::default()
        };
        let items = crate::query::list(conn, &catalog, &filters, None).unwrap();
        items
            .iter()
            .filter(|item| !item.r#type.starts_with("system."))
            .count() as i64
    }

    #[test]
    fn a_count_equals_the_local_list_it_names_in_both_directions() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        let anchors = named(&[PARENT, "todo", "lone", "missing", "grandchild"]);
        for (backref, edge_type) in [
            (true, "parent-of"),
            (false, "parent-of"),
            (false, "in-collection"),
        ] {
            let counts = linked(&conn, &catalog, &anchors, edge_type, backref).unwrap();
            let word = if backref { "backref" } else { "edge" };
            for count in &counts {
                let filter = format!("{word}[{edge_type}] eq \"{}\"", count.id);
                assert_eq!(count.total, listed(&conn, &filter), "{filter}");
                let groups = count.status_groups.unwrap();
                for (group, counted) in [
                    ("not_started", groups.not_started),
                    ("in_progress", groups.in_progress),
                    ("completed", groups.completed),
                    ("canceled", groups.canceled),
                ] {
                    let filter = format!("{filter} AND status_group eq \"{group}\"");
                    assert_eq!(counted, listed(&conn, &filter), "{filter}");
                }
            }
        }
        // The witness: the fixture has something in every group and
        // something the rule leaves out, so the equality is not zero equals zero.
        let counts = linked(&conn, &catalog, &anchors, "parent-of", true).unwrap();
        assert_eq!(counts[0].total, 8);
        assert_eq!(
            counts[0].status_groups,
            Some(StatusGroups {
                not_started: 2,
                in_progress: 1,
                completed: 1,
                canceled: 1
            })
        );
        assert_eq!(counts[1].total, 1);
        assert_eq!(counts[3].total, 0);
        assert!(counts.iter().all(|count| count.held));
    }

    #[test]
    fn an_edge_type_not_held_whole_is_refused_and_a_held_one_answered() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        let anchors = named(&[PARENT]);
        linked(&conn, &catalog, &anchors, "parent-of", true).unwrap();
        for held in [&[][..], &["in-collection"][..]] {
            hold_whole(&conn, held);
            for backref in [true, false] {
                let refusal = linked(&conn, &catalog, &anchors, "parent-of", backref).unwrap_err();
                assert!(matches!(refusal, CoreError::Invalid(_)), "{refusal:?}");
            }
        }
    }

    #[test]
    fn a_count_that_reaches_an_item_the_copy_lacks_is_refused() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        let anchors = named(&[PARENT]);
        // The witness: the same count is answered while the copy holds every item.
        assert_eq!(
            linked(&conn, &catalog, &anchors, "parent-of", true).unwrap()[0].total,
            8
        );
        // A child outside the slice, held as an edge only.
        store::upsert_edge(&conn, &wire_edge("far", PARENT, "elsewhere", "parent-of")).unwrap();
        let refusal = linked(&conn, &catalog, &anchors, "parent-of", true).unwrap_err();
        assert!(matches!(refusal, CoreError::Invalid(_)), "{refusal:?}");
        // An anchor with no edge is not a gap.
        assert_eq!(
            linked(&conn, &catalog, &named(&["lone"]), "parent-of", true).unwrap()[0].total,
            0
        );
        // An anchor the copy lacks, with edges, may be one the server does not read.
        store::upsert_edge(&conn, &wire_edge("up", "unheld", "lone", "parent-of")).unwrap();
        let refusal = linked(&conn, &catalog, &named(&["unheld"]), "parent-of", true).unwrap_err();
        assert!(matches!(refusal, CoreError::Invalid(_)), "{refusal:?}");
        // From the other end the counted item is the one that links to the anchor, which the copy lacks.
        let refusal = linked(&conn, &catalog, &named(&["lone"]), "parent-of", false).unwrap_err();
        assert!(matches!(refusal, CoreError::Invalid(_)), "{refusal:?}");
    }

    #[test]
    fn ids_are_refused_as_the_server_refuses_them_and_answered_once_in_order() {
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        let counted = Counted::Backref("parent-of".into());
        let many: Vec<String> = (0..=MOST_IDS).map(|n| format!("{n}")).collect();
        let refusal = core.counts(&many, &counted).unwrap_err();
        assert!(
            matches!(&refusal, CoreError::Validation { code, .. } if code == "validation_error"),
            "{refusal:?}"
        );
        let refusal = core.counts(&named(&["not-an-id"]), &counted).unwrap_err();
        assert!(
            matches!(&refusal, CoreError::Validation { code, .. } if code == "invalid_id"),
            "{refusal:?}"
        );
        for blank in [
            Counted::Backref(String::new()),
            Counted::Edge("a b".into()),
            Counted::Table("Bad".into()),
        ] {
            let refusal = core.counts(&[], &blank).unwrap_err();
            assert!(
                matches!(refusal, CoreError::Validation { .. }),
                "{refusal:?}"
            );
        }
        let one = "01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string();
        let two = "01a1011c-2f86-76b6-9594-050c109f4957".to_string();
        let edge = Counted::Backref("parent-of".into());
        store::meta_set(
            &core.conn().unwrap(),
            store::META_SLICE_EDGE_TYPES,
            "[\"parent-of\"]",
        )
        .unwrap();
        let answered = core
            .counts(&[two.clone(), one.clone(), two.clone()], &edge)
            .unwrap();
        assert_eq!(
            answered
                .iter()
                .map(|count| count.id.clone())
                .collect::<Vec<_>>(),
            [two, one]
        );
    }

    #[test]
    fn rows_of_a_table_not_held_whole_are_the_servers_and_say_so() {
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        let one = "01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string();
        let two = "01a1011c-2f86-76b6-9594-050c109f4957".to_string();
        server.on(
            "/items/counts",
            vec![scripted::json(
                200,
                &json!({ "counts": [{ "id": one, "total": 214 }, { "id": two, "total": 0 }] })
                    .to_string(),
            )],
        );
        let answered = core
            .counts(
                &[one.clone(), two.clone()],
                &Counted::Table("messages".into()),
            )
            .unwrap();
        assert_eq!(
            answered,
            [
                ItemCount {
                    id: one,
                    total: 214,
                    status_groups: None,
                    held: false
                },
                ItemCount {
                    id: two,
                    total: 0,
                    status_groups: None,
                    held: false
                },
            ]
        );
        let body = &server.seen("/items/counts")[0];
        let body = String::from_utf8_lossy(&body.body);
        assert!(body.contains("\"table\":\"messages\""), "{body}");
    }
}
