//! Storage expressions for the working copy's shared filter compiler.

use marfa_rules::catalog::Catalog;
use marfa_rules::filter::sql::{self, Bind, Items, Relation, Sink};
use marfa_rules::filter::{Expression, parse};
use serde_json::{Number, Value};

use crate::Result;
use crate::error::CoreError;

pub(crate) use marfa_rules::filter::reads;
pub use marfa_rules::filter::{
    EdgeDirection, FilterCondition, FilterExpression, FilterField, FilterJoin, FilterOperator,
    FilterValue, SystemField,
};

/// The edge type `beneath` walks: an edge's source is the parent and its
/// target the child.
pub(crate) const PARENT_OF: &str = "parent-of";

/// An expression the copy cannot answer as the server would is refused,
/// never dropped, but for an edge type the key may not read, which the copy
/// cannot know. `whole` is the edge types the copy holds whole
/// (`store::whole_edge_types`): a `backref` term is answered only on one of
/// them, since a copy holds the other edge types only as its own items draw
/// them. A `status_group` term reads each type's status field from `catalog`.
pub(crate) fn narrow(
    filter: Option<&str>,
    beneath: Option<&str>,
    whole: &[String],
    catalog: &Catalog,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    if let Some(filter) = filter {
        let expression = parse(filter)?;
        clauses.push(expression_clause(&expression, values, whole, catalog)?);
    }
    if let Some(root) = beneath {
        clauses.push(format!("items.id IN ({})", beneath_walk()));
        values.push(Value::String(root.to_string()));
    }
    Ok(())
}

/// The ids under the item bound to its one `?`, and that id, by the
/// `parent-of` edges held, whether or not the copy holds the rows they
/// join. `UNION`, not `UNION ALL`: a copy can hold a cycle the server would
/// refuse, from edges queued locally, and only a set ends the walk.
pub(crate) fn beneath_walk() -> String {
    format!(
        "WITH RECURSIVE beneath(id) AS (
           SELECT ?
           UNION
           SELECT edges.target_id FROM edges JOIN beneath ON edges.source_id = beneath.id
           WHERE edges.edge_type = '{PARENT_OF}'
         ) SELECT id FROM beneath"
    )
}

/// Refuses, before any read, what `narrow` would refuse for this expression
/// on a copy that holds no edge type whole.
pub(crate) fn check(filter: &str) -> Result<()> {
    expression_clause(&parse(filter)?, &mut Vec::new(), &[], &Catalog::empty()).map(|_| ())
}

/// SQL as text with a `?` for each value, the values as the driver is handed them.
#[derive(Default)]
pub(crate) struct Compiled {
    pub(crate) text: String,
    pub(crate) values: Vec<Value>,
}

impl Sink for Compiled {
    fn push(&mut self, text: &str) {
        self.text.push_str(text);
    }

    fn bind(&mut self, value: Bind) {
        self.text.push('?');
        self.values.push(value_of(value));
    }
}

fn value_of(bind: Bind) -> Value {
    match bind {
        Bind::Null => Value::Null,
        Bind::Real(number) => Number::from_f64(number).map_or(Value::Null, Value::Number),
        Bind::Text(text) => Value::String(text),
    }
}

fn expression_clause(
    expression: &Expression,
    values: &mut Vec<Value>,
    whole: &[String],
    catalog: &Catalog,
) -> Result<String> {
    let items = Items {
        alias: "items",
        unreadable_properties: true,
    };
    let mut out = Compiled::default();
    sql::item_filter(&mut out, expression, &items, catalog, |out, relation| {
        match relation {
            // `+` removes text affinity so a number never matches a tag spelled like it.
            Relation::Tag(value) => {
                out.push(
                    "EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id AND +tags.tag = ",
                );
                out.bind(sql::bound(value));
                out.push(")");
            }
            Relation::Tags { present } => out.push(&format!(
                "{}EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id)",
                if present { "" } else { "NOT " }
            )),
            Relation::Edge {
                edge_type,
                backref,
                negated,
                to,
            } => {
                // Incoming edges are complete only when the copy holds their type whole.
                if backref && !whole.iter().any(|held| held == edge_type) {
                    return Err(marfa_rules::RuleError::invalid(format!(
                        "a backref condition on {edge_type:?} is not answered from a working copy that does not hold that edge type whole: hydrate with it as an edge type held whole, or ask the server"
                    )));
                }
                let (own, far) = if backref {
                    ("target_id", "source_id")
                } else {
                    ("source_id", "target_id")
                };
                out.push(if negated { "NOT " } else { "" });
                out.push(&format!(
                    "EXISTS (SELECT 1 FROM edges e WHERE e.{own} = items.id AND e.edge_type = "
                ));
                out.bind(Bind::Text(edge_type.to_string()));
                if let Some(value) = to {
                    out.push(&format!(" AND e.{far} = "));
                    out.bind(sql::bound(value));
                }
                out.push(")");
            }
            Relation::Part { selected } => {
                out.push(if selected { "" } else { "NOT " });
                out.push(PART_SQL);
            }
        }
        Ok(())
    })?;
    values.extend(out.values);
    Ok(out.text)
}

/// A row filter of `marfa_rules::filter::parse_rows` over `table_rows r`, as
/// the server compiles it over its own rows.
pub(crate) fn row_clause(expression: &Expression, values: &mut Vec<Value>) -> Result<String> {
    let column = |out: &mut Compiled, function: &str, name: &str| {
        out.push(&format!("{function}(r.body, "));
        out.bind(Bind::Text(format!("$.{name}")));
        out.push(")");
    };
    let mut out = Compiled::default();
    sql::row_filter(
        &mut out,
        expression,
        |out, name| column(out, "json_extract", name),
        |out, name| column(out, "json_type", name),
    )
    .map_err(CoreError::from)?;
    values.extend(out.values);
    Ok(out.text)
}

/// An item out of the bin that draws an edge of a `with-hosts` type, read
/// from the held catalog so a registered type counts, to a host out of the
/// bin. A host the copy does not hold counts as out of the bin: the copy
/// cannot know its state (`device/filter-part-unheld-host`).
const PART_SQL: &str = "(items.state <> 'trashed' AND EXISTS (
    SELECT 1 FROM edges e LEFT JOIN items h ON h.id = e.target_id
    WHERE e.source_id = items.id
      AND e.edge_type IN (
        SELECT id FROM edge_types
        WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.cascade_on_delete') END = 'with-hosts'
      )
      AND (h.id IS NULL OR h.state <> 'trashed')))";

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::store;
    use crate::store::testing::*;
    use marfa_rules::catalog::Indexing;
    use marfa_rules::filter::parse;

    #[test]
    fn timestamp_comparisons_normalize_and_validate() {
        for field in ["created_at", "updated_at", "occurred_at"] {
            for op in ["eq", "neq", "gt", "gte", "lt", "lte"] {
                let mut values = Vec::new();
                let expression =
                    parse(&format!("{field} {op} \"2026-01-01T01:00:00.500+01:00\"")).unwrap();
                expression_clause(&expression, &mut values, &[], &Catalog::empty()).unwrap();
                assert_eq!(values, [Value::String("2026-01-01T00:00:00.500Z".into())]);
                for invalid in ["42", "true", "null", "\"bad\""] {
                    assert!(
                        matches!(check(&format!("{field} {op} {invalid}")), Err(CoreError::Validation { code, .. }) if code == "validation_error")
                    );
                }
            }
        }
    }

    fn family() -> Connection {
        let conn = conn();
        for (id, properties, tags) in [
            ("root", json!({ "rating": 5, "flag": true }), vec!["5.0"]),
            ("child", json!({ "rating": 2, "note": "A_b" }), vec![]),
            ("grandchild", json!({ "note": "Axb" }), vec![]),
            ("stranger", json!({ "rating": "9" }), vec![]),
        ] {
            let item = wire_item(
                id,
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            let tags: Vec<String> = tags.into_iter().map(str::to_string).collect();
            store::upsert_item(&conn, &item, Some(&tags), &Indexing::default()).unwrap();
        }
        for (id, source, target, edge_type) in [
            ("1", "root", "child", "parent-of"),
            ("2", "child", "grandchild", "parent-of"),
            ("3", "grandchild", "root", "parent-of"),
            ("4", "child", "stranger", "references"),
        ] {
            store::upsert_edge(&conn, &wire_edge(id, source, target, edge_type)).unwrap();
        }
        conn
    }

    /// Tasks with status words, a subtype that adds one, a type with no
    /// status field holding a property of the same name, and a stored word
    /// the type does not declare.
    fn statuses() -> Connection {
        let conn = conn();
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(json!([
                { "id": "acme.task", "fields": { "state": { "type": "status", "status_values": [
                    { "value": "todo", "group": "not_started" },
                    { "value": "doing", "group": "in_progress" },
                    { "value": "done", "group": "completed" },
                    { "value": "dropped", "group": "canceled" }
                ] } } },
                { "id": "acme.chore", "parent": "acme.task", "fields": { "state": { "type": "status", "status_values": [
                    { "value": "waiting", "group": "in_progress" }
                ] } } },
                { "id": "acme.note", "fields": { "state": { "type": "string" } } }
            ]))
            .unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        for (id, r#type, properties) in [
            ("todo", "acme.task", json!({ "state": "todo" })),
            ("doing", "acme.task", json!({ "state": "doing" })),
            ("done", "acme.task", json!({ "state": "done" })),
            ("waiting", "acme.chore", json!({ "state": "waiting" })),
            ("chore-done", "acme.chore", json!({ "state": "done" })),
            ("task-waiting", "acme.task", json!({ "state": "waiting" })),
            ("pending", "acme.task", json!({ "state": "pending" })),
            ("blank", "acme.task", json!({})),
            ("note", "acme.note", json!({ "state": "done" })),
        ] {
            let item = wire_item(id, r#type, "active", "2026-01-01T00:00:00Z", properties);
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        conn
    }

    #[test]
    fn a_status_group_term_reads_each_types_own_words() {
        let conn = statuses();
        for (filter, matched) in [
            ("status_group eq \"in_progress\"", &["doing", "waiting"][..]),
            ("status_group eq \"completed\"", &["chore-done", "done"]),
            ("status_group eq \"canceled\"", &[]),
            (
                "status_group neq \"completed\"",
                &["doing", "todo", "waiting"],
            ),
            (
                "status_group exists",
                &["chore-done", "doing", "done", "todo", "waiting"],
            ),
            (
                "status_group not_exists",
                &["blank", "note", "pending", "task-waiting"],
            ),
            (
                "status_group eq \"not_started\" OR status_group eq \"completed\"",
                &["chore-done", "done", "todo"],
            ),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), matched, "{filter}");
        }
    }

    #[test]
    fn the_shipped_media_types_read_progress_as_their_status_field() {
        let conn = conn();
        store::replace_catalog(&conn, &marfa_rules::builtin::catalog().unwrap()).unwrap();
        for (subtype, word) in [
            ("album", "planned"),
            ("article", "started"),
            ("book", "finished"),
            ("episode", "abandoned"),
            ("film", "finished"),
            ("series", "planned"),
            ("song", "started"),
        ] {
            let item = wire_item(
                subtype,
                &format!("core.media.{subtype}"),
                "active",
                "2026-01-01T00:00:00Z",
                json!({ "title": "x", "progress": word }),
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        // A series' own `status` enum is not a status word, so it joins no group.
        let series = wire_item(
            "ongoing",
            "core.media.series",
            "active",
            "2026-01-01T00:00:00Z",
            json!({ "title": "x", "status": "ongoing" }),
        );
        store::upsert_item(&conn, &series, None, &Indexing::default()).unwrap();

        for (group, matched) in [
            ("not_started", &["album", "series"][..]),
            ("in_progress", &["article", "song"]),
            ("completed", &["book", "film"]),
            ("canceled", &["episode"]),
        ] {
            let filter = format!("status_group eq \"{group}\"");
            assert_eq!(ids(&conn, Some(&filter), None), matched, "{filter}");
        }
        assert_eq!(
            ids(&conn, Some("status_group not_exists"), None),
            ["ongoing"]
        );

        let catalog = crate::catalog::load(&conn).unwrap();
        let written = |word: &str| {
            let mut properties = serde_json::Map::new();
            properties.insert("title".into(), json!("x"));
            properties.insert("progress".into(), json!(word));
            catalog.validate_properties("core.media.book", &properties, true)
        };
        assert!(written("started").is_ok());
        assert!(written("reading").is_err());
    }

    /// Hosts in and out of the bin, archived and not held, and parts on
    /// them by shipped and registered `with-hosts` types, beside an
    /// `orphan` edge that makes no part.
    fn parts() -> Connection {
        let conn = conn();
        let edge_type = |id: &str, mode: &str| {
            json!({ "id": id, "label": id, "reverse_label": id, "cardinality": "many-to-many",
                    "source_type_constraints": ["*"], "target_type_constraints": ["*"],
                    "cascade_on_delete": mode, "property_schema": {}, "written_at": "source" })
        };
        let catalog = marfa_rules::wire::WireCatalog {
            types: Vec::new(),
            edge_types: vec![
                edge_type("comments-on", "with-hosts"),
                edge_type("attached-to", "with-hosts"),
                edge_type("acme.annotates", "with-hosts"),
                edge_type("references", "orphan"),
            ],
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        for (id, state) in [
            ("host", "active"),
            ("binned", "trashed"),
            ("shelved", "archived"),
            ("on-host", "active"),
            ("on-binned", "active"),
            ("on-unheld", "active"),
            ("on-shelved", "active"),
            ("annotation", "active"),
            ("both", "active"),
            ("binned-part", "trashed"),
            ("mention", "active"),
        ] {
            let item = wire_item(id, "core.note", state, "2026-01-01T00:00:00Z", json!({}));
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        for (id, source, target, edge_type) in [
            ("1", "on-host", "host", "comments-on"),
            ("2", "on-binned", "binned", "comments-on"),
            ("3", "on-unheld", "elsewhere", "comments-on"),
            ("4", "on-shelved", "shelved", "attached-to"),
            ("5", "annotation", "host", "acme.annotates"),
            ("6", "both", "binned", "comments-on"),
            ("7", "both", "host", "attached-to"),
            ("8", "binned-part", "host", "comments-on"),
            ("9", "mention", "host", "references"),
        ] {
            store::upsert_edge(&conn, &wire_edge(id, source, target, edge_type)).unwrap();
        }
        conn
    }

    #[test]
    fn a_part_term_selects_items_with_a_host_out_of_the_bin_as_the_copy_holds_them() {
        let conn = parts();
        let selected = ["annotation", "both", "on-host", "on-shelved", "on-unheld"];
        let rest = [
            "binned",
            "binned-part",
            "host",
            "mention",
            "on-binned",
            "shelved",
        ];
        assert_eq!(ids(&conn, Some("part eq true"), None), selected);
        assert_eq!(ids(&conn, Some("part neq false"), None), selected);
        assert_eq!(ids(&conn, Some("part eq false"), None), rest);
        assert_eq!(ids(&conn, Some("part neq true"), None), rest);
        assert_eq!(
            ids(&conn, Some("part eq false AND state eq \"active\""), None),
            ["host", "mention", "on-binned"]
        );
        // The witness for `on-binned`: its host back out of the bin makes it
        // a part again.
        conn.execute("UPDATE items SET state = 'active' WHERE id = 'binned'", [])
            .unwrap();
        assert!(ids(&conn, Some("part eq true"), None).contains(&"on-binned".to_string()));
    }

    #[test]
    fn a_status_group_term_takes_only_a_group_and_the_operators_that_ask_for_one() {
        for (input, said) in [
            ("status_group eq \"todo\"", "Unknown status group \"todo\""),
            ("status_group eq 1", "Unknown status group 1"),
            ("status_group neq true", "Unknown status group true"),
            (
                "status_group contains \"completed\"",
                "is not valid for \"status_group\"",
            ),
            (
                "status_group gt \"completed\"",
                "is not valid for \"status_group\"",
            ),
            (
                "status_group eq null",
                "\"not_exists\" to ask for items with no status word",
            ),
            (
                "status_groups exists",
                "\"status_group\" for a status group, or \"part\" for the parts of other items",
            ),
        ] {
            let Err(CoreError::Validation { code, message, .. }) = check(input) else {
                panic!("{input} was accepted");
            };
            assert_eq!(code, "validation_error");
            assert!(message.contains(said), "{input}: {message}");
        }
        // A copy that holds no status field answers every group with no row.
        let conn = family();
        assert!(ids(&conn, Some("status_group eq \"completed\""), None).is_empty());
        assert_eq!(ids(&conn, Some("status_group not_exists"), None).len(), 4);
    }

    #[test]
    fn a_member_term_matches_any_entry_and_no_field_that_is_not_a_list_of_objects() {
        let conn = conn();
        for (id, properties) in [
            (
                "second",
                json!({ "emails": [{ "value": "a@x.test" }, { "value": "b@x.test" }] }),
            ),
            (
                "first",
                json!({ "emails": [{ "value": "b@x.test", "label": "work" }] }),
            ),
            ("other", json!({ "emails": [{ "value": "c@x.test" }] })),
            ("text", json!({ "emails": "b@x.test" })),
            ("object", json!({ "emails": { "value": "b@x.test" } })),
            (
                "objects",
                json!({ "emails": { "x": { "value": "b@x.test" } } }),
            ),
            ("scalars", json!({ "emails": ["b@x.test", 1, null] })),
            ("member", json!({ "emails": [{ "address": "b@x.test" }] })),
            (
                "number",
                json!({ "ranks": [{ "value": 5.0 }, { "value": "5" }] }),
            ),
        ] {
            let item = wire_item(
                id,
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        conn.execute(
            "UPDATE items SET properties = '{\"emails\":' WHERE id = 'other'",
            [],
        )
        .unwrap();
        for (filter, matched) in [
            (
                "properties.emails.value eq \"b@x.test\"",
                &["first", "second"][..],
            ),
            ("properties.emails.label eq \"work\"", &["first"]),
            ("properties.ranks.value eq 5", &["number"]),
            ("properties.ranks.value eq \"5\"", &["number"]),
            ("properties.emails.value eq 1", &[]),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), matched, "{filter}");
        }
    }

    const CORPUS: &str = include_str!("../../marfa-rules/src/filter/parity.json");

    #[test]
    fn the_filters_both_sides_share_select_the_ids_the_server_selects() {
        let corpus: Value = serde_json::from_str(CORPUS).unwrap();
        let conn = conn();
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(corpus["types"].clone()).unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        for item in corpus["items"].as_array().unwrap() {
            let wire = wire_item(
                item["id"].as_str().unwrap(),
                item["type"].as_str().unwrap(),
                item["state"].as_str().unwrap(),
                item["occurred_at"].as_str().unwrap(),
                item["properties"].clone(),
            );
            let tags: Vec<String> = item["tags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tag| tag.as_str().unwrap().to_string())
                .collect();
            store::upsert_item(&conn, &wire, Some(&tags), &Indexing::default()).unwrap();
        }
        for case in corpus["filters"].as_array().unwrap() {
            let filter = case["filter"].as_str().unwrap();
            assert_eq!(
                json!(ids(&conn, Some(filter), None)),
                case["ids"],
                "{filter}"
            );
        }
    }

    fn ids(conn: &Connection, filter: Option<&str>, beneath: Option<&str>) -> Vec<String> {
        ids_whole(conn, filter, beneath, &[])
    }

    fn ids_whole(
        conn: &Connection,
        filter: Option<&str>,
        beneath: Option<&str>,
        whole: &[&str],
    ) -> Vec<String> {
        let whole: Vec<String> = whole.iter().map(|held| held.to_string()).collect();
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        let catalog = crate::catalog::load(conn).unwrap();
        narrow(filter, beneath, &whole, &catalog, &mut clauses, &mut values).unwrap();
        let mut ids: Vec<String> = store::items_where(
            conn,
            &clauses.join(" AND "),
            "",
            "",
            &values,
            &mut store::Unreadable::Refuse,
        )
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_row_whose_stored_text_is_not_json_matches_no_property_condition_and_fails_no_list() {
        let conn = family();
        conn.execute(
            "UPDATE items SET properties = '{\"rating\":' WHERE id = 'stranger'",
            [],
        )
        .unwrap();
        // The witness: before the guard SQLite raised `malformed JSON` for the
        // whole query, whatever the other rows held.
        let unguarded = conn.query_row(
            "SELECT json_extract(properties, '$.rating') FROM items WHERE id = 'stranger'",
            [],
            |row| row.get::<_, Option<String>>(0),
        );
        assert!(unguarded.is_err(), "{unguarded:?}");
        for (filter, wanted) in [
            ("properties.rating lte 5", vec!["child", "root"]),
            ("properties.rating gt 4", vec!["root"]),
            ("properties.rating eq 2", vec!["child"]),
            ("properties.rating neq 2", vec!["root"]),
            ("properties.note contains \"_\"", vec!["child"]),
            ("properties.rating exists", vec!["child", "root"]),
            ("properties.rating not_exists", vec!["grandchild"]),
            ("properties.flag eq true", vec!["root"]),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), wanted, "{filter}");
        }
    }

    #[test]
    fn answers_each_condition_from_the_copy() {
        let conn = family();
        let filtered = |filter: &str| ids(&conn, Some(filter), None);
        assert_eq!(filtered("properties.rating lte 5"), ["child", "root"]);
        // A number against text: the server casts the property to a number
        // for a numeric bound but preserves text for numeric equality.
        assert_eq!(filtered("properties.rating gt 4"), ["root", "stranger"]);
        assert_eq!(filtered("properties.rating eq 9"), Vec::<String>::new());
        assert_eq!(filtered("properties.flag eq true"), ["root"]);
        assert_eq!(filtered("properties.note contains \"_\""), ["child"]);
        assert_eq!(
            filtered("properties.note starts_with \"a\""),
            ["child", "grandchild"]
        );
        assert_eq!(filtered("tags contains \"5.0\""), ["root"]);
        assert_eq!(filtered("tags contains 5"), Vec::<String>::new());
        assert_eq!(filtered("edge[references] eq \"stranger\""), ["child"]);
        assert_eq!(filtered("edge[parent-of] not_exists"), ["stranger"]);
    }

    #[test]
    fn numeric_equality_uses_the_same_double_as_numeric_bounds() {
        let conn = conn();
        let spellings = [
            "1000000000000000100",
            "-1000000000000000100",
            "9007199254740991",
            "9007199254740992",
            "9007199254740993",
            "-9007199254740993",
            "9223372036854775807",
            "-9223372036854775808",
            "1e18",
            "-1.25e-7",
            "0.125",
            "-0",
            "0",
        ];
        for (index, spelling) in spellings.iter().enumerate() {
            let properties = serde_json::from_str(&format!(r#"{{"n":{spelling}}}"#)).unwrap();
            let item = wire_item(
                &format!("n{index:02}"),
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        for spelling in spellings {
            let number = spelling.parse::<f64>().unwrap();
            let literal = if spelling == "-1.25e-7" {
                "-0.000000125"
            } else if spelling == "1e18" {
                "1000000000000000000"
            } else {
                spelling
            };
            for op in ["eq", "neq", "gte", "lte"] {
                let expected: Vec<String> = spellings
                    .iter()
                    .enumerate()
                    .filter(|(_, candidate)| {
                        let candidate = candidate.parse::<f64>().unwrap();
                        match op {
                            "eq" => candidate == number,
                            "neq" => candidate != number,
                            "gte" => candidate >= number,
                            _ => candidate <= number,
                        }
                    })
                    .map(|(index, _)| format!("n{index:02}"))
                    .collect();
                assert_eq!(
                    ids(&conn, Some(&format!("properties.n {op} {literal}")), None),
                    expected,
                    "{op} {literal}"
                );
            }
        }
        for (id, properties) in [
            ("text", json!({"other":"0"})),
            ("array", json!({"other":[]})),
            ("object", json!({"other":{}})),
            ("null", json!({"other":null})),
            ("missing", json!({})),
            ("false", json!({"other":false})),
            ("true", json!({"other":true})),
        ] {
            store::upsert_item(
                &conn,
                &wire_item(
                    id,
                    "core.note",
                    "active",
                    "2026-01-01T00:00:00Z",
                    properties,
                ),
                None,
                &Indexing::default(),
            )
            .unwrap();
        }
        assert_eq!(ids(&conn, Some("properties.other eq 0"), None), ["false"]);
        assert_eq!(ids(&conn, Some("properties.other eq true"), None), ["true"]);
        assert_eq!(
            ids(&conn, Some("properties.other eq \"0\""), None),
            ["text"]
        );
    }

    #[test]
    fn answers_a_backref_on_an_edge_type_the_copy_holds_whole() {
        let conn = family();
        let held = |filter: &str| ids_whole(&conn, Some(filter), None, &["parent-of"]);
        assert_eq!(
            held("backref[parent-of] exists"),
            ["child", "grandchild", "root"]
        );
        assert_eq!(held("backref[parent-of] not_exists"), ["stranger"]);
        assert_eq!(held("backref[parent-of] eq \"root\""), ["child"]);
        assert_eq!(
            held("backref[parent-of] neq \"root\""),
            ["grandchild", "root", "stranger"]
        );
        assert_eq!(
            held("backref[parent-of] exists AND backref[parent-of] neq \"root\""),
            ["grandchild", "root"]
        );
        // The outbound side of the same type reads the other end of each edge.
        assert_eq!(held("edge[parent-of] eq \"child\""), ["root"]);
    }

    #[test]
    fn refuses_a_backref_the_copy_cannot_answer_whole() {
        let conn = family();
        // The witness: the same expression is answered once the type is held.
        assert_eq!(
            ids_whole(
                &conn,
                Some("backref[references] exists"),
                None,
                &["references"]
            ),
            ["stranger"]
        );
        for (filter, whole) in [
            ("backref[references] exists", vec![]),
            ("backref[references] exists", vec!["parent-of".to_string()]),
            (
                "tags exists OR backref[x] neq \"a\"",
                vec!["references".to_string()],
            ),
        ] {
            let mut clauses = Vec::new();
            let mut values = Vec::new();
            let Err(CoreError::Invalid(message)) = narrow(
                Some(filter),
                None,
                &whole,
                &Catalog::empty(),
                &mut clauses,
                &mut values,
            ) else {
                panic!("{filter} was answered");
            };
            assert!(message.contains("backref"), "{message}");
        }
        // The grammar's own refusal comes first, as the server's does.
        assert!(matches!(
            narrow(
                Some("backref[x] exists AND title eq 1"),
                None,
                &["x".to_string()],
                &Catalog::empty(),
                &mut Vec::new(),
                &mut Vec::new()
            ),
            Err(CoreError::Validation { .. })
        ));
    }
}
