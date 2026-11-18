//! Counts of linked items and of table rows, answered as the server's `POST /items/counts`.

use std::collections::HashMap;

use marfa_rules::catalog::{Catalog, STATUS_GROUPS};
use marfa_rules::filter::parse;
use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::error::CoreError;
use crate::model::SliceTier;
use crate::{Core, Result, filter, query, store, tables};

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

/// Refuses an edge type or a table name the server would refuse.
fn refuse_unnamed(counted: &Counted) -> Result<()> {
    match counted {
        Counted::Backref(edge_type) | Counted::Edge(edge_type)
            if !marfa_rules::filter::edge_type_named(edge_type) =>
        {
            Err(refused(
                "an edge type is not blank, has no space and no closing bracket.",
            ))
        }
        Counted::Table(table) if !marfa_rules::catalog::api_name(table) => Err(refused(
            "a table is a lowercase letter and then at most 63 lowercase letters, digits and underscores.",
        )),
        _ => Ok(()),
    }
}

/// A full slice can exclude an absent endpoint because the server's listing excludes it too.
fn holds_every_listed_item(conn: &Connection) -> Result<bool> {
    let Some((types, tier)) = store::slice(conn)? else {
        return Ok(false);
    };
    if tier != SliceTier::All || !types.iter().any(|held| held == store::EVERY_TYPE) {
        return Ok(false);
    }
    Ok(match store::slice_query(conn)? {
        None => true,
        Some(query) => {
            query.filter.is_none()
                && query.beneath.is_none()
                && query
                    .states
                    .is_none_or(|states| states.iter().any(|state| state == "active"))
        }
    })
}

/// The server lists an edge only if its source item is visible (`edges/read-source-filter`).
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
        return Err(CoreError::NotAnswerable(format!(
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
    let mut counted: Vec<String> = Vec::new();
    let mut counted_values: Vec<Value> = Vec::new();
    query::narrow_by_states(None, false, &mut counted, &mut counted_values)?;
    let counted = counted.join(" AND ");
    let marks = vec!["?"; ids.len()].join(", ");
    let mut found: HashMap<String, (i64, [i64; 4])> = HashMap::new();
    let gap = format!(
        "SELECT 1 FROM edges e
          WHERE e.edge_type = ? AND e.{anchor} IN ({marks})
            AND NOT EXISTS (SELECT 1 FROM items WHERE items.id = e.{other})
          LIMIT 1"
    );
    let bound = |ids: &[String], first: &str| -> Vec<rusqlite::types::Value> {
        std::iter::once(first.to_string())
            .chain(ids.iter().cloned())
            .map(rusqlite::types::Value::Text)
            .collect()
    };
    if !holds_every_listed_item(conn)?
        && conn
            .prepare_cached(&gap)?
            .exists(params_from_iter(bound(ids, edge_type)))?
    {
        return Err(CoreError::NotAnswerable(format!(
            "a count of {edge_type:?} reaches an item this working copy does not hold, so it cannot say how many the server counts: ask the server"
        )));
    }
    if !ids.is_empty() {
        let sql = format!(
            "SELECT e.{anchor}, COUNT(*){groups}
               FROM edges e CROSS JOIN items ON items.id = e.{other}
              WHERE e.edge_type = ? AND e.{anchor} IN ({marks})
                AND {counted} AND items.type NOT LIKE 'system.%' AND {listed}
              GROUP BY e.{anchor}",
            listed = crate::query::LISTED
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

impl Core {
    /// Counts linked items or table rows for up to [`MOST_IDS`] IDs, once per distinct ID in request order.
    /// Link counts follow the server's anchored listing with its default state.
    /// A link count returns `NotAnswerable`, and no other refusal, if the copy lacks edges or items needed for the count.
    /// The server counts rows for tables the copy does not hold whole; an answer that is not the asked IDs once each, in order, fails the call.
    pub fn counts(&self, ids: &[String], counted: &Counted) -> Result<Vec<ItemCount>> {
        let ids = distinct(ids)?;
        refuse_unnamed(counted)?;
        match counted {
            Counted::Backref(edge_type) | Counted::Edge(edge_type) => {
                let backref = matches!(counted, Counted::Backref(_));
                store::read_marked(&mut *self.conn()?, |conn, _| {
                    store::refuse_unless_usable(conn)?;
                    let catalog = crate::catalog::load(conn)?;
                    linked(conn, &catalog, &ids, edge_type, backref)
                })
            }
            Counted::Table(table) => {
                self.lay_rows()?;
                let held: Vec<Option<i64>> = store::read_marked(&mut *self.conn()?, |conn, _| {
                    tables::held_row_counts(conn, &ids, table)
                })?;
                let asked: Vec<&String> = ids
                    .iter()
                    .zip(&held)
                    .filter(|(_, held)| held.is_none())
                    .map(|(id, _)| id)
                    .collect();
                let mut served = if asked.is_empty() {
                    Vec::new()
                } else {
                    self.http()?.item_counts(&asked, counted)?
                }
                .into_iter()
                .map(|(total, _)| total);
                ids.iter()
                    .zip(held)
                    .map(|(id, held)| {
                        let total = match held {
                            Some(total) => total,
                            None => served.next().ok_or_else(|| {
                                CoreError::Decoding("the server's counts end early".into())
                            })?,
                        };
                        Ok(ItemCount {
                            id: id.clone(),
                            total,
                            status_groups: None,
                            held: held.is_some(),
                        })
                    })
                    .collect()
            }
        }
    }

    /// Asks the copy's own server for the counts of up to [`MOST_IDS`] IDs, once per
    /// distinct ID in request order, under the copy's instance check and current key.
    /// Refuses an answer that is not the asked IDs once each in order, a link count
    /// without its four status groups and a count of rows with any.
    pub fn served_counts(&self, ids: &[String], counted: &Counted) -> Result<Vec<ItemCount>> {
        let ids = distinct(ids)?;
        refuse_unnamed(counted)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let asked: Vec<&String> = ids.iter().collect();
        let served = self.http()?.item_counts(&asked, counted)?;
        Ok(ids
            .into_iter()
            .zip(served)
            .map(|(id, (total, status_groups))| ItemCount {
                id,
                total,
                status_groups,
                held: false,
            })
            .collect())
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
                assert!(
                    matches!(refusal, CoreError::NotAnswerable(_)),
                    "{refusal:?}"
                );
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
        assert!(
            matches!(refusal, CoreError::NotAnswerable(_)),
            "{refusal:?}"
        );
        // An anchor with no edge is not a gap.
        assert_eq!(
            linked(&conn, &catalog, &named(&["lone"]), "parent-of", true).unwrap()[0].total,
            0
        );
        // An anchor the copy lacks is no gap: an edge the copy holds is one the server reads from.
        store::upsert_edge(&conn, &wire_edge("up", "unheld", "lone", "parent-of")).unwrap();
        assert_eq!(
            linked(&conn, &catalog, &named(&["unheld"]), "parent-of", true).unwrap()[0].total,
            1
        );
        // From the other end the counted item is the one that links to the anchor, which the copy lacks.
        let refusal = linked(&conn, &catalog, &named(&["lone"]), "parent-of", false).unwrap_err();
        assert!(
            matches!(refusal, CoreError::NotAnswerable(_)),
            "{refusal:?}"
        );
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

    fn holding_every_listed_item(conn: &Connection) {
        store::meta_set(conn, store::META_SLICE_TYPES, "[\"*\"]").unwrap();
        store::meta_set(conn, store::META_SLICE_TIER, "all").unwrap();
    }

    #[test]
    fn a_pinned_child_the_server_did_not_list_is_not_counted() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        put(&conn, "hidden", "acme.task", "active", json!({}));
        store::upsert_edge(&conn, &wire_edge("h", "lone", "hidden", "parent-of")).unwrap();
        store::pin(&conn, "hidden").unwrap();
        // The witness: the same pin, listed, is counted in both directions.
        crate::reach::set_listed(&conn, "hidden", true).unwrap();
        let counted = |anchor: &str, backref| {
            linked(&conn, &catalog, &named(&[anchor]), "parent-of", backref).unwrap()[0].total
        };
        assert_eq!(counted("lone", true), 1);
        assert_eq!(counted("hidden", false), 1);
        store::upsert_edge(&conn, &wire_edge("i", "hidden", "lone", "parent-of")).unwrap();
        assert_eq!(counted("lone", false), 1);
        crate::reach::set_listed(&conn, "hidden", false).unwrap();
        assert_eq!(counted("lone", true), 0);
        assert_eq!(counted("lone", false), 0);
    }

    #[test]
    fn a_child_a_refill_keeps_unlisted_is_not_counted_as_the_listing_leaves_it_out() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        put(&conn, "hidden", "acme.task", "active", json!({}));
        store::upsert_edge(&conn, &wire_edge("h", "lone", "hidden", "parent-of")).unwrap();
        store::pin(&conn, "hidden").unwrap();
        let counted =
            || linked(&conn, &catalog, &named(&["lone"]), "parent-of", true).unwrap()[0].total;
        let listing = || listed(&conn, "id eq \"hidden\"");
        // The witness: listed before the refill, the child is counted and listed after it too.
        crate::reach::set_listed(&conn, "hidden", true).unwrap();
        store::start_refill(&conn).unwrap();
        assert_eq!((counted(), listing()), (1, 1));
        crate::reach::set_listed(&conn, "hidden", false).unwrap();
        store::start_refill(&conn).unwrap();
        assert_eq!(listing(), 0);
        assert_eq!(counted(), 0);
    }

    #[test]
    fn an_anchor_outside_the_slice_is_answered_while_every_counted_item_is_held() {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"acme.task\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        put(&conn, "child", "acme.task", "active", json!({}));
        store::upsert_edge(&conn, &wire_edge("a", "outside", "child", "parent-of")).unwrap();
        let anchors = named(&["outside"]);
        assert_eq!(
            linked(&conn, &catalog, &anchors, "parent-of", true).unwrap()[0].total,
            1
        );
        // The witness: a counted item the narrow slice lacks is still refused.
        store::upsert_edge(&conn, &wire_edge("b", "outside", "elsewhere", "parent-of")).unwrap();
        let refusal = linked(&conn, &catalog, &anchors, "parent-of", true).unwrap_err();
        assert!(
            matches!(refusal, CoreError::NotAnswerable(_)),
            "{refusal:?}"
        );
    }

    #[test]
    fn a_copy_holding_every_listed_item_answers_for_a_counted_item_it_lacks_and_a_narrower_one_refuses()
     {
        let conn = tasks();
        let catalog = crate::catalog::load(&conn).unwrap();
        // The source filter leaves the child out, so the copy never held it.
        store::upsert_edge(&conn, &wire_edge("far", PARENT, "filtered", "parent-of")).unwrap();
        let anchors = named(&[PARENT]);
        let refusal = linked(&conn, &catalog, &anchors, "parent-of", true).unwrap_err();
        assert!(
            matches!(refusal, CoreError::NotAnswerable(_)),
            "{refusal:?}"
        );
        holding_every_listed_item(&conn);
        assert_eq!(
            linked(&conn, &catalog, &anchors, "parent-of", true).unwrap()[0].total,
            8
        );
        // A slice that leaves out a tier, a state or a type may lack a child the server counts.
        for (types, tier, query) in [
            ("[\"*\"]", "library", None),
            ("[\"acme.task\"]", "all", None),
            ("[\"*\"]", "all", Some("{\"states\":[\"archived\"]}")),
            (
                "[\"*\"]",
                "all",
                Some("{\"filter\":\"state eq \\\"todo\\\"\"}"),
            ),
        ] {
            store::meta_set(&conn, store::META_SLICE_TYPES, types).unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, tier).unwrap();
            if let Some(query) = query {
                store::meta_set(&conn, store::META_SLICE_QUERY, query).unwrap();
            }
            let refusal = linked(&conn, &catalog, &anchors, "parent-of", true).unwrap_err();
            assert!(
                matches!(refusal, CoreError::NotAnswerable(_)),
                "{types} {tier} {query:?}: {refusal:?}"
            );
            conn.execute("DELETE FROM meta WHERE key = ?1", [store::META_SLICE_QUERY])
                .unwrap();
        }
    }

    #[test]
    fn a_served_answer_that_is_not_the_asked_ids_once_each_in_order_is_refused_whole() {
        let one = "01a1011a-4902-76cf-a4a9-88e99c038c8d";
        let two = "01a1011c-2f86-76b6-9594-050c109f4957";
        let three = "01a1011c-2f86-76b6-9594-050c109f4958";
        let row = |id: &str| json!({ "id": id, "total": 3 });
        let asked = [one.to_string(), two.to_string(), one.to_string()];
        for (what, answer) in [
            ("missing", vec![row(one)]),
            ("reordered", vec![row(two), row(one)]),
            ("repeated", vec![row(one), row(one)]),
            ("extra", vec![row(one), row(two), row(three)]),
            ("repeated after both", vec![row(one), row(two), row(one)]),
        ] {
            let server = Scripted::start();
            let core = copy(&server);
            holding_a_catalog(&core);
            server.on(
                "/items/counts",
                vec![scripted::json(
                    200,
                    &json!({ "counts": answer }).to_string(),
                )],
            );
            let refusal = core
                .counts(&asked, &Counted::Table("messages".into()))
                .unwrap_err();
            assert!(
                matches!(refusal, CoreError::Decoding(_)),
                "{what}: {refusal:?}"
            );
        }
        // The witness: the asked ids once each, in order, are answered.
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        server.on(
            "/items/counts",
            vec![scripted::json(
                200,
                &json!({ "counts": [row(one), row(two)] }).to_string(),
            )],
        );
        let answered = core
            .counts(&asked, &Counted::Table("messages".into()))
            .unwrap();
        assert_eq!(
            answered
                .iter()
                .map(|count| count.id.as_str())
                .collect::<Vec<_>>(),
            [one, two]
        );
    }

    #[test]
    fn a_failure_asking_the_server_for_rows_is_itself_and_never_not_answerable() {
        let ids = ["01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string()];
        let table = Counted::Table("messages".into());
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        server.on(
            "/items/counts",
            vec![scripted::refusal(429, "rate_limited")],
        );
        let refusal = core.counts(&ids, &table).unwrap_err();
        assert!(
            matches!(refusal, CoreError::RateLimited { .. }),
            "{refusal:?}"
        );
        for failure in [
            CoreError::Invalid("the renewer could not renew".into()),
            CoreError::SignedOut {
                origin: server.url(),
            },
            CoreError::Network("offline".into()),
        ] {
            let server = Scripted::start();
            let core = copy(&server);
            holding_a_catalog(&core);
            server.on(
                "/items/counts",
                vec![scripted::refusal(401, "unauthorized")],
            );
            let expected = failure.clone();
            core.renew_credential_with(Box::new(move |_| Err(failure.clone())));
            let refusal = core.counts(&ids, &table).unwrap_err();
            assert_eq!(refusal, CoreError::RenewalFailed(Box::new(expected)));
            assert_ne!(refusal.code(), "not_answerable");
        }
    }

    fn groups(total: i64) -> Value {
        json!({ "not_started": total, "in_progress": 0, "completed": 0, "canceled": 0 })
    }

    #[test]
    fn served_counts_ask_the_copys_server_once_per_distinct_id_and_say_so() {
        let one = "01a1011a-4902-76cf-a4a9-88e99c038c8d";
        let two = "01a1011c-2f86-76b6-9594-050c109f4957";
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/items/counts",
            vec![scripted::json(
                200,
                &json!({ "counts": [
                    { "id": one, "total": 2, "status_groups": groups(2) },
                    { "id": two, "total": 0, "status_groups": groups(0) }
                ] })
                .to_string(),
            )],
        );
        let asked = [one.to_string(), two.to_string(), one.to_string()];
        let served = core
            .served_counts(&asked, &Counted::Backref("parent-of".into()))
            .unwrap();
        assert_eq!(
            served,
            [
                ItemCount {
                    id: one.into(),
                    total: 2,
                    status_groups: Some(StatusGroups::of([2, 0, 0, 0])),
                    held: false,
                },
                ItemCount {
                    id: two.into(),
                    total: 0,
                    status_groups: Some(StatusGroups::default()),
                    held: false,
                },
            ]
        );
        let sent: Value = serde_json::from_slice(&server.seen("/items/counts")[0].body).unwrap();
        assert_eq!(sent, json!({ "ids": [one, two], "backref": "parent-of" }));
        assert!(
            core.served_counts(&[], &Counted::Edge("in-collection".into()))
                .unwrap()
                .is_empty()
        );
        assert_eq!(server.seen("/items/counts").len(), 1);
    }

    #[test]
    fn a_served_answer_with_the_wrong_ids_or_status_groups_is_refused_whole() {
        let one = "01a1011a-4902-76cf-a4a9-88e99c038c8d";
        let two = "01a1011c-2f86-76b6-9594-050c109f4957";
        let link = Counted::Edge("in-collection".into());
        let rows = Counted::Table("messages".into());
        let grouped = |id: &str| json!({ "id": id, "total": 1, "status_groups": groups(1) });
        let bare = |id: &str| json!({ "id": id, "total": 1 });
        let asked = [one.to_string(), two.to_string()];
        let cases = [
            ("reordered", &link, vec![grouped(two), grouped(one)]),
            ("missing", &link, vec![grouped(one)]),
            ("repeated", &link, vec![grouped(one), grouped(one)]),
            (
                "a link without groups",
                &link,
                vec![grouped(one), bare(two)],
            ),
            (
                "a link missing a group",
                &link,
                vec![
                    grouped(one),
                    json!({ "id": two, "total": 1, "status_groups": { "not_started": 1 } }),
                ],
            ),
            ("rows with groups", &rows, vec![bare(one), grouped(two)]),
        ];
        for (what, counted, answer) in cases {
            let server = Scripted::start();
            let core = copy(&server);
            server.on(
                "/items/counts",
                vec![scripted::json(
                    200,
                    &json!({ "counts": answer }).to_string(),
                )],
            );
            let refusal = core.served_counts(&asked, counted).unwrap_err();
            assert!(
                matches!(refusal, CoreError::Decoding(_)),
                "{what}: {refusal:?}"
            );
        }
        // The witness: each kind is answered when its answer is whole.
        for (counted, answer) in [
            (&link, vec![grouped(one), grouped(two)]),
            (&rows, vec![bare(one), bare(two)]),
        ] {
            let server = Scripted::start();
            let core = copy(&server);
            server.on(
                "/items/counts",
                vec![scripted::json(
                    200,
                    &json!({ "counts": answer }).to_string(),
                )],
            );
            assert_eq!(core.served_counts(&asked, counted).unwrap().len(), 2);
        }
    }

    #[test]
    fn served_counts_send_no_id_to_a_server_that_is_not_the_copys() {
        let server = Scripted::start();
        server.on(
            "/",
            vec![scripted::root("00000000-0000-7000-8000-000000000001")],
        );
        server.on(
            "/items/counts",
            vec![scripted::json(200, r#"{"counts":[]}"#)],
        );
        let (_dir, core) =
            crate::relocation_tests::moving_copy(&server.url(), Some(scripted::INSTANCE));
        let refusal = core
            .served_counts(
                &["01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string()],
                &Counted::Backref("parent-of".into()),
            )
            .unwrap_err();
        assert!(
            matches!(refusal, CoreError::WrongServer { .. }),
            "{refusal:?}"
        );
        assert!(server.seen("/items/counts").is_empty());
        // The witness: the same copy whose server answers as its own instance asks it.
        let server = Scripted::start();
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        server.on(
            "/items/counts",
            vec![scripted::json(
                200,
                &json!({ "counts": [{ "id": "01a1011a-4902-76cf-a4a9-88e99c038c8d", "total": 0, "status_groups": groups(0) }] })
                    .to_string(),
            )],
        );
        let (_dir, core) =
            crate::relocation_tests::moving_copy(&server.url(), Some(scripted::INSTANCE));
        core.served_counts(
            &["01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string()],
            &Counted::Backref("parent-of".into()),
        )
        .unwrap();
        assert_eq!(server.seen("/items/counts").len(), 1);
    }

    #[test]
    fn served_counts_without_a_server_are_no_server() {
        let core = Core::open_in_memory(None).unwrap();
        let refusal = core
            .served_counts(
                &["01a1011a-4902-76cf-a4a9-88e99c038c8d".to_string()],
                &Counted::Backref("parent-of".into()),
            )
            .unwrap_err();
        assert_eq!(refusal, CoreError::NoServer);
    }

    #[test]
    fn held_rows_are_the_stored_count_of_a_whole_table_its_host_declares() {
        let conn = conn();
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(json!([
                { "id": "acme.ledger", "fields": {},
                  "tables": { "lines": { "columns": { "memo": { "type": "string" } } } } },
                { "id": "acme.note", "fields": {} }
            ]))
            .unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        let hosts = [
            ("whole", "acme.ledger", "active", "whole", 3),
            ("binned", "acme.ledger", "trashed", "whole", 3),
            ("owed", "acme.ledger", "active", "owed", 0),
            ("online", "acme.ledger", "active", "online", 0),
            ("undeclared", "acme.note", "active", "whole", 3),
        ];
        for (id, kind, state, table, rows) in hosts {
            put(&conn, id, kind, state, json!({}));
            conn.execute(
                "INSERT INTO item_tables (item_id, name, state, rows) VALUES (?1, 'lines', ?2, ?3)",
                rusqlite::params![id, table, rows],
            )
            .unwrap();
        }
        let ids = named(&["whole", "binned", "owed", "online", "undeclared", "absent"]);
        assert_eq!(
            tables::held_row_counts(&conn, &ids, "lines").unwrap(),
            [Some(3), None, None, None, None, None]
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
