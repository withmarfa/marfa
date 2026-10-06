use rusqlite::Connection;
use serde_json::Value;

use crate::Result;
use crate::catalog::Catalog;
use crate::filter;
use crate::model::{Item, ListFilters, Sort};
use crate::store;

pub(crate) fn list(
    conn: &Connection,
    catalog: &Catalog,
    filters: &ListFilters,
    sort: Sort,
) -> Result<Vec<Item>> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    narrow_by_type(
        catalog,
        filters.r#type.as_deref(),
        &mut clauses,
        &mut values,
    )?;
    match filters.state {
        Some(state) => {
            clauses.push("state = ?".into());
            values.push(Value::String(state.as_str().into()));
        }
        None if !filters.all_states => clauses.push("state = 'active'".into()),
        None => {}
    }
    if let Some(tier) = filters.tier {
        clauses.push("tier = ?".into());
        values.push(Value::String(tier.as_str().into()));
    }
    narrow_by_tags(&filters.tags, &mut clauses, &mut values);
    // Both ends exclusive, as on the server.
    if let Some(after) = &filters.occurred_after {
        clauses.push("occurred_at > ?".into());
        values.push(Value::String(crate::time::normalize(
            after,
            "occurred_after",
        )?));
    }
    if let Some(before) = &filters.occurred_before {
        clauses.push("occurred_at < ?".into());
        values.push(Value::String(crate::time::normalize(
            before,
            "occurred_before",
        )?));
    }
    filter::narrow(
        filters.filter.as_deref(),
        filters.beneath.as_deref(),
        &mut clauses,
        &mut values,
    )?;
    list_where(conn, &clauses, &values, sort, filters.limit, filters.offset)
}

pub(crate) fn list_where(
    conn: &Connection,
    clauses: &[String],
    values: &[Value],
    sort: Sort,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Item>> {
    let where_sql = if clauses.is_empty() {
        "1 = 1".to_string()
    } else {
        clauses.join(" AND ")
    };
    let order_sql = format!(
        "ORDER BY {} {}, id {}",
        sort.field.as_str(),
        sort.direction.as_sql(),
        sort.direction.as_sql()
    );
    let limit_sql = match (limit, offset) {
        (None, None) => String::new(),
        (limit, offset) => format!(
            "LIMIT {} OFFSET {}",
            limit.map(i64::from).unwrap_or(-1),
            offset.unwrap_or(0)
        ),
    };
    store::items_where(conn, &where_sql, &order_sql, &limit_sql, values)
}

/// A declared type and its subtree, by name and by declared parent, the
/// question `?type=` answers on the server. Shared by the list and the
/// search, so the two cannot answer it differently. A name outside the
/// server's type grammar is refused as the server refuses it.
pub(crate) fn narrow_by_type(
    catalog: &Catalog,
    declared: Option<&str>,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    // An empty filter is no filter, as `?type=` is on the server.
    let Some(declared) = declared.filter(|declared| !declared.is_empty() && *declared != "*")
    else {
        return Ok(());
    };
    if !crate::hydrate::type_pattern(declared)? {
        return Err(crate::error::CoreError::Validation {
            code: "validation_error".into(),
            message: format!("Invalid type identifier: {declared}"),
        });
    }
    let root = Catalog::root(declared);
    let mut alternatives = vec![
        "items.type = ?".to_string(),
        "items.type LIKE ? ESCAPE '\\'".to_string(),
    ];
    values.push(Value::String(root.to_string()));
    values.push(Value::String(format!("{}.%", escape_like(root))));
    let extra = catalog.declared_descendants(root);
    if !extra.is_empty() {
        alternatives.push(format!(
            "items.type IN ({})",
            vec!["?"; extra.len()].join(", ")
        ));
        values.extend(extra.into_iter().map(Value::String));
    }
    clauses.push(format!("({})", alternatives.join(" OR ")));
    Ok(())
}

pub(crate) fn narrow_by_tags(tags: &[String], clauses: &mut Vec<String>, values: &mut Vec<Value>) {
    for tag in tags {
        clauses.push(
            "EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id AND tags.tag = ?)".into(),
        );
        values.push(Value::String(tag.clone()));
    }
}

pub(crate) fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::catalog::Indexing;
    use crate::model::{ItemState, SortDirection, SortField, Tier};
    use crate::store::testing::*;

    fn seeded() -> Connection {
        let conn = conn();
        store::replace_types(
            &conn,
            &[
                wire_type("core.note", None, Some("title")),
                wire_type("core.file", None, Some("title")),
                wire_type("acme.memo", Some("core.note"), None),
            ],
        )
        .unwrap();
        for (id, type_, state, when, tags) in [
            (
                "a",
                "core.note",
                "active",
                "2026-01-01T00:00:00.000Z",
                vec!["x", "y"],
            ),
            (
                "b",
                "core.note.todo",
                "archived",
                "2026-01-02T00:00:00.000Z",
                vec!["x"],
            ),
            (
                "c",
                "acme.memo",
                "active",
                "2026-01-03T00:00:00.000Z",
                vec![],
            ),
            (
                "d",
                "core.file",
                "active",
                "2026-01-04T00:00:00.000Z",
                vec!["y"],
            ),
            (
                "e",
                "core.note",
                "trashed",
                "2026-01-05T00:00:00.000Z",
                vec!["x", "y"],
            ),
        ] {
            let item = wire_item(id, type_, state, when, json!({ "title": id }));
            let tags: Vec<String> = tags.into_iter().map(str::to_string).collect();
            store::upsert_item(&conn, &item, Some(&tags), &Indexing::default()).unwrap();
        }
        let mut feed = wire_item(
            "f",
            "core.note",
            "active",
            "2026-01-06T00:00:00.000Z",
            json!({}),
        );
        feed.tier = Some("feed".into());
        store::upsert_item(&conn, &feed, None, &Indexing::default()).unwrap();
        conn
    }

    fn ids(conn: &Connection, filters: ListFilters, sort: Sort) -> Vec<String> {
        let catalog = Catalog::load(conn).unwrap();
        list(conn, &catalog, &filters, sort)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect()
    }

    #[test]
    fn timestamp_bounds_normalize_before_comparing() {
        let conn = seeded();
        let item = wire_item(
            "half",
            "core.note",
            "active",
            "2026-01-01T00:00:00.500Z",
            json!({}),
        );
        store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        let rows = ids(
            &conn,
            ListFilters {
                occurred_after: Some("2026-01-01T00:00:00Z".into()),
                occurred_before: Some("2026-01-01T00:00:01Z".into()),
                ..Default::default()
            },
            Sort::default(),
        );
        assert_eq!(rows, ["half"]);
    }

    #[test]
    fn a_type_selects_its_subtree_by_name_and_by_declared_parent() {
        let conn = seeded();
        let filters = ListFilters {
            r#type: Some("core.note".into()),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()), vec!["f", "c", "a"]);
        let filters = ListFilters {
            r#type: Some("core.note.*".into()),
            all_states: true,
            ..Default::default()
        };
        assert_eq!(
            ids(&conn, filters, Sort::default()),
            vec!["f", "e", "c", "b", "a"]
        );
        let filters = ListFilters {
            r#type: Some("core.fil".into()),
            ..Default::default()
        };
        assert!(ids(&conn, filters, Sort::default()).is_empty());
        let filters = ListFilters {
            r#type: Some("*".into()),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()).len(), 4);
    }

    #[test]
    fn state_defaults_to_the_active_state() {
        let conn = seeded();
        assert_eq!(
            ids(&conn, ListFilters::default(), Sort::default()),
            vec!["f", "d", "c", "a"]
        );
        let named = ListFilters {
            state: Some(ItemState::Archived),
            ..Default::default()
        };
        assert_eq!(ids(&conn, named, Sort::default()), vec!["b"]);
        let named = ListFilters {
            state: Some(ItemState::Trashed),
            ..Default::default()
        };
        assert_eq!(ids(&conn, named, Sort::default()), vec!["e"]);
        let everything = ListFilters {
            all_states: true,
            ..Default::default()
        };
        assert_eq!(ids(&conn, everything, Sort::default()).len(), 6);
    }

    #[test]
    fn tags_tier_and_time_bounds_narrow_together() {
        let conn = seeded();
        let filters = ListFilters {
            tags: vec!["x".into(), "y".into()],
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()), vec!["a"]);
        let filters = ListFilters {
            tier: Some(Tier::Feed),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()), vec!["f"]);
        let filters = ListFilters {
            occurred_after: Some("2026-01-02T00:00:00Z".into()),
            occurred_before: Some("2026-01-04T00:00:00Z".into()),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()), vec!["c"]);
    }

    #[test]
    fn sort_limit_and_offset() {
        let conn = seeded();
        let ascending = Sort {
            field: SortField::OccurredAt,
            direction: SortDirection::Ascending,
        };
        let filters = ListFilters {
            limit: Some(2),
            offset: Some(1),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, ascending), vec!["c", "d"]);
        let filters = ListFilters {
            offset: Some(3),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, ascending), vec!["f"]);
    }
}
