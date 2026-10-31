use rusqlite::Connection;
use serde_json::Value;

use crate::Result;
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::filter;
use crate::model::{Item, ItemState, ListFilters, Sort, SortField};
use crate::store::{self, Unreadable};

pub(crate) fn list(
    conn: &Connection,
    catalog: &Catalog,
    filters: &ListFilters,
    sort: Option<Sort>,
) -> Result<Vec<Item>> {
    list_with(conn, catalog, filters, sort, &mut Unreadable::Refuse)
}

pub(crate) fn list_with(
    conn: &Connection,
    catalog: &Catalog,
    filters: &ListFilters,
    sort: Option<Sort>,
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let sort = ordered(filters, sort)?;

    narrow_by_types(catalog, filters.types.as_deref(), &mut clauses, &mut values)?;
    narrow_by_states(
        filters.states.as_deref(),
        filters.all_states,
        &mut clauses,
        &mut values,
    )?;
    if let Some(tier) = filters.tier {
        clauses.push("tier = ?".into());
        values.push(Value::String(tier.as_str().into()));
    }
    if let Some(source) = &filters.source {
        clauses.push("source = ?".into());
        values.push(Value::String(source.clone()));
    }
    narrow_by_tags(&filters.tags, &mut clauses, &mut values);
    narrow_by_own_time(
        filters.occurred_after.as_deref(),
        filters.occurred_before.as_deref(),
        &mut clauses,
        &mut values,
    )?;
    // The lower end is inclusive, so a caller resuming from the latest
    // `updated_at` it holds misses no row that shares the instant.
    if let Some(after) = &filters.updated_after {
        clauses.push("updated_at >= ?".into());
        values.push(Value::String(crate::time::normalize(
            after,
            "updated_after",
        )?));
    }
    if let Some(before) = &filters.updated_before {
        clauses.push("updated_at < ?".into());
        values.push(Value::String(crate::time::normalize(
            before,
            "updated_before",
        )?));
    }
    filter::narrow(
        filters.filter.as_deref(),
        filters.beneath.as_deref(),
        &store::whole_edge_types(conn)?,
        catalog,
        &mut clauses,
        &mut values,
    )?;
    list_where_with(
        conn,
        &clauses,
        &values,
        sort,
        filters.limit,
        filters.offset,
        unreadable,
    )
}

/// The order a list is answered in. A named `updated_after` orders by
/// `updated_at` and then id, ascending, the only order a caller can resume
/// from, so a list naming another is refused, as the server refuses it.
fn ordered(filters: &ListFilters, sort: Option<Sort>) -> Result<Sort> {
    match (sort, filters.updated_after.is_some()) {
        (None, true) => Ok(Sort::RESUMED),
        (None, false) => Ok(Sort::default()),
        (Some(sort), true) if sort != Sort::RESUMED => Err(CoreError::Validation {
            code: "validation_error".into(),
            message: "updated_after orders by updated_at, ascending; leave out sort and direction"
                .into(),
        }),
        (Some(sort), _) => Ok(sort),
    }
}

/// Both ends exclusive, as on the server: the row sitting on a bound is left
/// out. One end alone narrows by that end.
pub(crate) fn narrow_by_own_time(
    after: Option<&str>,
    before: Option<&str>,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    if let Some(after) = after {
        clauses.push("items.occurred_at > ?".into());
        values.push(Value::String(crate::time::normalize(
            after,
            "occurred_after",
        )?));
    }
    if let Some(before) = before {
        clauses.push("items.occurred_at < ?".into());
        values.push(Value::String(crate::time::normalize(
            before,
            "occurred_before",
        )?));
    }
    Ok(())
}

pub(crate) fn list_where(
    conn: &Connection,
    clauses: &[String],
    values: &[Value],
    sort: Sort,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Item>> {
    list_where_with(
        conn,
        clauses,
        values,
        sort,
        limit,
        offset,
        &mut Unreadable::Refuse,
    )
}

pub(crate) fn list_where_with(
    conn: &Connection,
    clauses: &[String],
    values: &[Value],
    sort: Sort,
    limit: Option<u32>,
    offset: Option<u32>,
    unreadable: &mut Unreadable,
) -> Result<Vec<Item>> {
    let where_sql = if clauses.is_empty() {
        "1 = 1".to_string()
    } else {
        clauses.join(" AND ")
    };
    // The name is spliced into the SQL path, so it is held to the grammar
    // here whoever built the sort.
    if let SortField::Property(name) = &sort.field {
        SortField::property(name)?;
    }
    let order_sql = match &sort.field {
        // Rows with no scalar there go last in either direction, and ties
        // fall to the id ascending in both, as on the server
        // (`search-and-filters/sort-property-*`). A number is compared as a
        // real, as the server compares it, and SQLite puts numbers before
        // text, a boolean being 0 or 1.
        SortField::Property(name) => format!(
            "ORDER BY {expression} IS NULL, {expression} {}, id ASC",
            sort.direction.as_sql(),
            expression = property_sort_expression(name),
        ),
        field => format!(
            "ORDER BY {field} {}, id {}",
            sort.direction.as_sql(),
            sort.direction.as_sql()
        ),
    };
    let limit_sql = match (limit, offset) {
        (None, None) => String::new(),
        (limit, offset) => format!(
            "LIMIT {} OFFSET {}",
            limit.map(i64::from).unwrap_or(-1),
            offset.unwrap_or(0)
        ),
    };
    store::items_where(conn, &where_sql, &order_sql, &limit_sql, values, unreadable)
}

/// `name` is a property name `SortField::property` has checked, so it is
/// safe inside the path.
fn property_sort_expression(name: &str) -> String {
    format!(
        "CASE WHEN json_type(items.properties, '$.{name}') IN ('integer', 'real') THEN CAST(json_extract(items.properties, '$.{name}') AS REAL) WHEN json_type(items.properties, '$.{name}') IN ('text', 'true', 'false') THEN json_extract(items.properties, '$.{name}') ELSE NULL END"
    )
}

/// The most entries a `type` list may name, as on the server
/// (`search-and-filters/type-list-max`).
const MAX_TYPE_ENTRIES: usize = 10;

/// A `type` list, as the server reads one (`search-and-filters/type-list`): a
/// row matches when any entry selects it. Each entry is refused as it would be
/// alone, in the order given; `*` among them narrows nothing.
pub(crate) fn narrow_by_types(
    catalog: &Catalog,
    types: Option<&[String]>,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    let Some(types) = types else {
        return Ok(());
    };
    if types.is_empty() {
        return Err(CoreError::Validation {
            code: "validation_error".into(),
            message: "The type filter names no type. Name a type, or leave the filter out.".into(),
        });
    }
    if types.len() > MAX_TYPE_ENTRIES {
        return Err(CoreError::Validation {
            code: "validation_error".into(),
            message: format!("Too many types in filter (max {MAX_TYPE_ENTRIES})"),
        });
    }
    let mut alternatives = Vec::new();
    let mut entry_values = Vec::new();
    let mut every_type = false;
    for declared in types {
        if declared == "*" {
            every_type = true;
            continue;
        }
        let mut entry = Vec::new();
        narrow_by_type(catalog, Some(declared), &mut entry, &mut entry_values)?;
        refuse_unknown_type(catalog, Some(declared))?;
        alternatives.extend(entry);
    }
    if !every_type {
        clauses.push(format!("({})", alternatives.join(" OR ")));
        values.extend(entry_values);
    }
    Ok(())
}

/// A `state` list, as the server reads one (`search-and-filters/state-list`).
/// Unset, the active state unless `all_states` lifts it. An empty list names
/// nothing and is refused, as the server refuses a `state` with no entry
/// (`search-and-filters/state-empty`), and so is a list beside `all_states`,
/// as the server refuses `any` beside a state (`search-and-filters/state-any-alone`).
pub(crate) fn narrow_by_states(
    states: Option<&[ItemState]>,
    all_states: bool,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    match states {
        None if all_states => {}
        None => clauses.push("items.state = 'active'".into()),
        Some([]) => {
            return Err(CoreError::Validation {
                code: "validation_error".into(),
                message: "The state filter names no state. Name a state, or leave the filter out."
                    .into(),
            });
        }
        Some(_) if all_states => {
            return Err(CoreError::Validation {
                code: "validation_error".into(),
                message: "The state filter names states beside every state. Name the states, or ask for every state, not both.".into(),
            });
        }
        Some(states) => {
            let mut named: Vec<&str> = states.iter().map(|state| state.as_str()).collect();
            named.sort_unstable();
            named.dedup();
            clauses.push(format!(
                "items.state IN ({})",
                vec!["?"; named.len()].join(", ")
            ));
            values.extend(named.into_iter().map(|state| Value::String(state.into())));
        }
    }
    Ok(())
}

/// A concrete type the copy's catalog does not hold is refused `unknown_type`,
/// as the server refuses one nothing registers (`device/type-unknown`). A
/// wildcard is never refused: what it names may be nothing. A name outside the
/// grammar is left to `narrow_by_type`, which refuses it first on the server's
/// code. The server answers `type_not_permitted` for a registered type its key
/// may not read, so only a type the catalog lacks is refused here: the catalog
/// is the server's whole registry, whatever the key reads.
pub(crate) fn refuse_unknown_type(catalog: &Catalog, declared: Option<&str>) -> Result<()> {
    let Some(declared) = declared else {
        return Ok(());
    };
    if declared == "*" || declared.ends_with(".*") || !crate::hydrate::type_pattern(declared)? {
        return Ok(());
    }
    if catalog.known(declared) {
        return Ok(());
    }
    Err(CoreError::UnknownType {
        message: format!("Unknown type: {declared}"),
    })
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
    let Some(declared) = declared.filter(|declared| *declared != "*") else {
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
        list(conn, &catalog, &filters, Some(sort))
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
            types: Some(vec!["core.note".into()]),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()), vec!["f", "c", "a"]);
        let filters = ListFilters {
            types: Some(vec!["core.note.*".into()]),
            all_states: true,
            ..Default::default()
        };
        assert_eq!(
            ids(&conn, filters, Sort::default()),
            vec!["f", "e", "c", "b", "a"]
        );
        let filters = ListFilters {
            types: Some(vec!["core.fil.*".into()]),
            ..Default::default()
        };
        assert!(ids(&conn, filters, Sort::default()).is_empty());
        let filters = ListFilters {
            types: Some(vec!["*".into()]),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, Sort::default()).len(), 4);
    }

    #[test]
    fn a_concrete_type_the_catalog_does_not_hold_is_refused_and_a_wildcard_is_not() {
        let conn = seeded();
        let catalog = Catalog::load(&conn).unwrap();
        let named = |name: &str| ListFilters {
            types: Some(vec![name.into()]),
            ..Default::default()
        };
        // The witnesses: a held type answers, and a wildcard that names
        // nothing answers an empty page.
        assert!(list(&conn, &catalog, &named("core.note"), None).is_ok());
        assert!(
            list(&conn, &catalog, &named("core.taks.*"), None)
                .unwrap()
                .is_empty()
        );
        assert!(list(&conn, &catalog, &named("core.taks"), None).is_err());
        assert_eq!(
            list(&conn, &catalog, &named("core.taks"), None).unwrap_err(),
            crate::error::CoreError::UnknownType {
                message: "Unknown type: core.taks".into()
            }
        );
        assert!(matches!(
            list(&conn, &catalog, &named("core.Taks"), None).unwrap_err(),
            crate::error::CoreError::Validation { .. }
        ));
    }

    #[test]
    fn an_empty_type_is_refused_as_the_server_refuses_it() {
        let conn = seeded();
        let catalog = Catalog::load(&conn).unwrap();
        let filters = ListFilters {
            types: Some(vec![String::new()]),
            ..Default::default()
        };
        let refused = list(&conn, &catalog, &filters, None).unwrap_err();
        assert!(matches!(
            refused,
            crate::error::CoreError::Validation { ref code, .. } if code == "validation_error"
        ));
    }

    #[test]
    fn state_defaults_to_the_active_state() {
        let conn = seeded();
        assert_eq!(
            ids(&conn, ListFilters::default(), Sort::default()),
            vec!["f", "d", "c", "a"]
        );
        let named = ListFilters {
            states: Some(vec![ItemState::Archived]),
            ..Default::default()
        };
        assert_eq!(ids(&conn, named, Sort::default()), vec!["b"]);
        let named = ListFilters {
            states: Some(vec![ItemState::Trashed]),
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
    fn a_type_list_answers_what_any_entry_selects() {
        let conn = seeded();
        let both = ListFilters {
            types: Some(vec!["acme.memo".into(), "core.file".into()]),
            ..Default::default()
        };
        assert_eq!(ids(&conn, both, Sort::default()), vec!["d", "c"]);
        let with_every = ListFilters {
            types: Some(vec!["core.file".into(), "*".into()]),
            ..Default::default()
        };
        assert_eq!(
            ids(&conn, with_every, Sort::default()),
            vec!["f", "d", "c", "a"]
        );
    }

    #[test]
    fn a_state_list_answers_rows_in_any_state_it_names() {
        let conn = seeded();
        let filed_and_binned = ListFilters {
            states: Some(vec![ItemState::Trashed, ItemState::Archived]),
            ..Default::default()
        };
        assert_eq!(
            ids(&conn, filed_and_binned, Sort::default()),
            vec!["e", "b"]
        );
    }

    #[test]
    fn a_list_naming_nothing_or_too_much_is_refused() {
        let conn = seeded();
        let catalog = Catalog::load(&conn).unwrap();
        let eleven: Vec<String> = (0..11).map(|i| format!("acme{i}.*")).collect();
        let ten = ListFilters {
            types: Some(eleven[..10].to_vec()),
            ..Default::default()
        };
        assert!(list(&conn, &catalog, &ten, None).unwrap().is_empty());
        for refused in [
            ListFilters {
                types: Some(vec![]),
                ..Default::default()
            },
            ListFilters {
                states: Some(vec![]),
                ..Default::default()
            },
            ListFilters {
                types: Some(eleven),
                ..Default::default()
            },
            ListFilters {
                states: Some(vec![ItemState::Active]),
                all_states: true,
                ..Default::default()
            },
        ] {
            assert!(
                matches!(
                    list(&conn, &catalog, &refused, None),
                    Err(crate::error::CoreError::Validation { ref code, .. }) if code == "validation_error"
                ),
                "{refused:?} was answered"
            );
        }
        let unknown = ListFilters {
            types: Some(vec!["core.note".into(), "core.nosuch".into()]),
            ..Default::default()
        };
        assert!(matches!(
            list(&conn, &catalog, &unknown, None),
            Err(crate::error::CoreError::UnknownType { .. })
        ));
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
        assert_eq!(ids(&conn, filters, ascending.clone()), vec!["c", "d"]);
        let filters = ListFilters {
            offset: Some(3),
            ..Default::default()
        };
        assert_eq!(ids(&conn, filters, ascending), vec!["f"]);
    }

    fn listed(conn: &Connection, filters: ListFilters, sort: Option<Sort>) -> Result<Vec<String>> {
        let catalog = Catalog::load(conn).unwrap();
        Ok(list(conn, &catalog, &filters, sort)?
            .into_iter()
            .map(|item| item.id)
            .collect())
    }

    #[test]
    fn a_source_selects_only_the_items_stamped_with_it() {
        let conn = seeded();
        let mut other = wire_item(
            "g",
            "core.note",
            "active",
            "2026-01-07T00:00:00.000Z",
            json!({}),
        );
        other.source = "notes".into();
        store::upsert_item(&conn, &other, None, &Indexing::default()).unwrap();
        let only = |source: &str| {
            let filters = ListFilters {
                source: Some(source.into()),
                ..Default::default()
            };
            listed(&conn, filters, None).unwrap()
        };
        assert_eq!(only("notes"), ["g"]);
        assert_eq!(only("test"), ["f", "d", "c", "a"]);
    }

    #[test]
    fn updated_after_keeps_its_bound_and_updated_before_leaves_its_own_out() {
        let conn = seeded();
        let range = |after: Option<&str>, before: Option<&str>| {
            let filters = ListFilters {
                all_states: true,
                updated_after: after.map(Into::into),
                updated_before: before.map(Into::into),
                ..Default::default()
            };
            listed(&conn, filters, None).unwrap()
        };
        // Oldest change first, ties by id: the order a resumed sync reads in.
        assert_eq!(range(Some("2026-01-04T00:00:00Z"), None), ["d", "e", "f"]);
        // Alone, the upper bound leaves the default order, newest first.
        assert_eq!(range(None, Some("2026-01-03T00:00:00Z")), ["b", "a"]);
        assert_eq!(
            range(Some("2026-01-02T00:00:00Z"), Some("2026-01-04T00:00:00Z")),
            ["b", "c"]
        );
    }

    #[test]
    fn updated_after_refuses_another_order_but_takes_its_own() {
        let conn = seeded();
        let filters = || ListFilters {
            updated_after: Some("2026-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        let refused = listed(&conn, filters(), Some(Sort::default())).unwrap_err();
        assert!(matches!(
            refused,
            CoreError::Validation { ref code, .. } if code == "validation_error"
        ));
        let own = Sort {
            field: SortField::UpdatedAt,
            direction: SortDirection::Ascending,
        };
        assert_eq!(
            listed(&conn, filters(), Some(own)).unwrap(),
            ["a", "c", "d", "f"]
        );
        // Either half of its own order is taken alone, and either half of
        // another refused, as the server takes and refuses them.
        for (field, direction, taken) in [
            (Some(SortField::UpdatedAt), None, true),
            (None, Some(SortDirection::Ascending), true),
            (Some(SortField::CreatedAt), None, false),
            (None, Some(SortDirection::Descending), false),
        ] {
            let sort = Sort::named(field.clone(), direction, true);
            assert_eq!(
                listed(&conn, filters(), sort).is_ok(),
                taken,
                "{field:?} {direction:?}"
            );
        }
        assert_eq!(Sort::named(None, None, true), None);
        assert_eq!(
            Sort::named(Some(SortField::UpdatedAt), None, false),
            Some(Sort {
                field: SortField::UpdatedAt,
                direction: SortDirection::Descending,
            })
        );
    }

    #[test]
    fn a_range_of_own_time_works_from_one_end_and_leaves_both_bounds_out() {
        let conn = seeded();
        let range = |after: Option<&str>, before: Option<&str>| {
            let filters = ListFilters {
                occurred_after: after.map(Into::into),
                occurred_before: before.map(Into::into),
                ..Default::default()
            };
            listed(&conn, filters, None).unwrap()
        };
        assert_eq!(range(Some("2026-01-03T00:00:00Z"), None), ["f", "d"]);
        assert_eq!(range(None, Some("2026-01-03T00:00:00Z")), ["a"]);
    }

    fn with_property(conn: &Connection, id: &str, properties: serde_json::Value) {
        let item = wire_item(
            id,
            "core.note",
            "active",
            "2026-02-01T00:00:00.000Z",
            properties,
        );
        store::upsert_item(conn, &item, None, &Indexing::default()).unwrap();
    }

    fn by_property(conn: &Connection, direction: SortDirection) -> Vec<String> {
        let filters = ListFilters {
            tier: Some(Tier::Library),
            occurred_after: Some("2026-01-31T00:00:00Z".into()),
            ..Default::default()
        };
        let sort = Sort {
            field: SortField::property("n").unwrap(),
            direction,
        };
        listed(conn, filters, Some(sort)).unwrap()
    }

    #[test]
    fn a_property_sort_puts_numbers_then_text_then_the_rest_with_ties_by_id() {
        let conn = seeded();
        for (id, properties) in [
            ("n10", json!({ "n": 10 })),
            ("n2b", json!({ "n": 2 })),
            ("n2a", json!({ "n": 2.0 })),
            ("yes", json!({ "n": true })),
            ("no", json!({ "n": false })),
            ("tb", json!({ "n": "b" })),
            ("ta", json!({ "n": "a" })),
            ("none", json!({})),
            ("null", json!({ "n": null })),
            ("list", json!({ "n": [1] })),
        ] {
            with_property(&conn, id, properties);
        }
        // Missing, null and non-scalar values go last in either direction,
        // and equal values fall to the id ascending in both.
        assert_eq!(
            by_property(&conn, SortDirection::Ascending),
            [
                "no", "yes", "n2a", "n2b", "n10", "ta", "tb", "list", "none", "null"
            ]
        );
        assert_eq!(
            by_property(&conn, SortDirection::Descending),
            [
                "tb", "ta", "n10", "n2a", "n2b", "yes", "no", "list", "none", "null"
            ]
        );
    }

    #[test]
    fn a_property_name_outside_the_servers_grammar_is_refused_before_it_reaches_the_sql() {
        let conn = seeded();
        assert!(SortField::property("a-b").is_err());
        let sort = Sort {
            field: SortField::Property("n') OR 1=1 --".into()),
            direction: SortDirection::Ascending,
        };
        assert!(matches!(
            listed(&conn, ListFilters::default(), Some(sort)).unwrap_err(),
            CoreError::Validation { .. }
        ));
    }
}
