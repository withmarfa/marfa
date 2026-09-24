use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::Result;
use crate::catalog::Catalog;
use crate::model::{SearchFilters, SearchHit};
use crate::query;
use crate::store;

pub(crate) fn search(
    conn: &Connection,
    catalog: &Catalog,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    let Some(expression) = fts_expression(query) else {
        return Ok(Vec::new());
    };
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = vec![Value::String(expression)];
    // The same three-way rule the list takes: a named state wins, the
    // widening suppresses the narrowing, and a caller who said neither is
    // answered the active state.
    match filters.state {
        Some(state) => {
            clauses.push("items.state = ?".into());
            values.push(Value::String(state.as_str().into()));
        }
        None if !filters.all_states => clauses.push("items.state = 'active'".into()),
        None => {}
    }
    query::narrow_by_type(
        catalog,
        filters.r#type.as_deref(),
        &mut clauses,
        &mut values,
    );
    query::narrow_by_tags(&filters.tags, &mut clauses, &mut values);
    let narrowing: String = clauses
        .iter()
        .map(|clause| format!(" AND {clause}"))
        .collect();
    values.push(Value::from(limit as i64));
    let mut statement = conn.prepare(&format!(
        "SELECT items.id, bm25(items_fts, 5.0, 1.0, 2.0), snippet(items_fts, 1, '<mark>', '</mark>', '…', 12)
         FROM items_fts
         JOIN items ON items.seq = items_fts.rowid
         WHERE items_fts MATCH ?{narrowing}
         ORDER BY bm25(items_fts, 5.0, 1.0, 2.0)
         LIMIT ?"
    ))?;
    let params: Vec<rusqlite::types::Value> = values.iter().map(store::sql_value).collect();
    let ranked = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let ids: Vec<String> = ranked.iter().map(|(id, _, _)| id.clone()).collect();
    let items = store::items_by_ids(conn, &ids)?;
    Ok(ranked
        .into_iter()
        .filter_map(|(id, rank, snippet)| {
            let item = items.iter().find(|item| item.id == id)?.clone();
            Some(SearchHit {
                item,
                score: -rank,
                snippet,
            })
        })
        .collect())
}

/// Every whitespace-separated token as a quoted prefix term, implicitly
/// ANDed, so nothing a person types is read as FTS5 syntax.
fn fts_expression(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|token| token.replace('"', ""))
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Indexing;
    use crate::model::ItemState;
    use crate::store;
    use crate::store::testing::*;
    use serde_json::json;

    #[test]
    fn titles_outrank_bodies_and_only_the_active_state_answers() {
        let conn = conn();
        store::upsert_item(
            &conn,
            &note(
                "body",
                "Other",
                "the zebra crossing",
                "2026-01-01T00:00:00Z",
            ),
            None,
            &Indexing::titled("title"),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("title", "Zebra", "nothing here", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::titled("title"),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("tag", "Plain", "plain", "2026-01-01T00:00:00Z"),
            Some(&["zebras".into()]),
            &Indexing::titled("title"),
        )
        .unwrap();
        // Both of the states a row can be put away in. A search that
        // answered one and hid the other would give two answers to one
        // question, and a case that seeded only the bin would not see it.
        let mut trashed = note("gone", "Zebra too", "zebra", "2026-01-01T00:00:00Z");
        trashed.state = "trashed".into();
        store::upsert_item(&conn, &trashed, None, &Indexing::titled("title")).unwrap();
        let mut archived = note("filed", "Zebra filed", "zebra", "2026-01-01T00:00:00Z");
        archived.state = "archived".into();
        store::upsert_item(&conn, &archived, None, &Indexing::titled("title")).unwrap();

        let default = SearchFilters::default();
        let hits = search(&conn, &Catalog::load(&conn).unwrap(), "zeb", &default, 10).unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
        assert_eq!(ids, vec!["title", "tag", "body"]);
        assert_eq!(
            search(&conn, &Catalog::load(&conn).unwrap(), "zeb", &default, 2)
                .unwrap()
                .len(),
            2
        );
        assert!(hits[0].score > hits[2].score);
        assert!(hits[2].snippet.contains("<mark>zebra</mark>"));
        assert!(
            search(&conn, &Catalog::load(&conn).unwrap(), "", &default, 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            search(
                &conn,
                &Catalog::load(&conn).unwrap(),
                "nothing crossing",
                &default,
                10
            )
            .unwrap()
            .is_empty()
        );

        // A caller who names a state is answered it, and the widening
        // answers every state. Without both, the default above is the only
        // selection the door has and "when the caller names none" describes
        // a setting nothing else can reach.
        let filed = SearchFilters {
            state: Some(ItemState::Archived),
            ..Default::default()
        };
        let ids: Vec<String> = search(&conn, &Catalog::load(&conn).unwrap(), "zeb", &filed, 10)
            .unwrap()
            .into_iter()
            .map(|hit| hit.item.id)
            .collect();
        assert_eq!(ids, vec!["filed"]);

        let everything = SearchFilters {
            all_states: true,
            ..Default::default()
        };
        let mut ids: Vec<String> = search(
            &conn,
            &Catalog::load(&conn).unwrap(),
            "zeb",
            &everything,
            10,
        )
        .unwrap()
        .into_iter()
        .map(|hit| hit.item.id)
        .collect();
        ids.sort();
        // The archive joins the widening and the bin does not: a trashed
        // row leaves the index on the write that trashes it, here as on
        // the server, so no state value reaches it through a search.
        assert_eq!(ids, vec!["body", "filed", "tag", "title"]);
    }

    /// A type narrows by its subtree and tags narrow by every tag given,
    /// exactly as a list narrows. The control is the unnarrowed search
    /// matching all five, so each absence below is the narrowing.
    #[test]
    fn a_type_and_tags_narrow_a_search_as_they_narrow_a_list() {
        let conn = conn();
        store::replace_types(
            &conn,
            &[
                wire_type("core.note", None, Some("title")),
                wire_type("core.file", None, Some("title")),
                wire_type("core.file.image", Some("core.file"), Some("title")),
                wire_type("core.bookmark", None, Some("title")),
                wire_type("user.photo", Some("core.file"), Some("title")),
            ],
        )
        .unwrap();
        let row = |id: &str, type_: &str, tags: &[&str]| {
            let item = wire_item(
                id,
                type_,
                "active",
                "2026-01-01T00:00:00Z",
                json!({ "title": format!("heron {id}") }),
            );
            let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
            store::upsert_item(&conn, &item, Some(&tags), &Indexing::titled("title")).unwrap();
        };
        row("note", "core.note", &["garden", "birds"]);
        row("image", "core.file.image", &["birds"]);
        row("file", "core.file", &[]);
        row("bookmark", "core.bookmark", &["birds"]);
        // A subtype by declared parent alone: its name shares no prefix with
        // `core.file`, so only the parent puts it in that subtree.
        row("photo", "user.photo", &["garden"]);
        let catalog = Catalog::load(&conn).unwrap();
        let ids = |filters: SearchFilters| {
            let mut ids: Vec<String> = search(&conn, &catalog, "heron", &filters, 10)
                .unwrap()
                .into_iter()
                .map(|hit| hit.item.id)
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(
            ids(SearchFilters::default()),
            vec!["bookmark", "file", "image", "note", "photo"]
        );
        assert_eq!(
            ids(SearchFilters {
                r#type: Some("core.file".into()),
                ..Default::default()
            }),
            vec!["file", "image", "photo"]
        );
        assert_eq!(
            ids(SearchFilters {
                tags: vec!["birds".into()],
                ..Default::default()
            }),
            vec!["bookmark", "image", "note"]
        );
        // Every tag given, with no type to do the narrowing for it: three rows
        // carry one of the two and one carries both.
        assert_eq!(
            ids(SearchFilters {
                tags: vec!["birds".into(), "garden".into()],
                ..Default::default()
            }),
            vec!["note"]
        );
        assert_eq!(
            ids(SearchFilters {
                r#type: Some("core.note".into()),
                tags: vec!["birds".into(), "garden".into()],
                ..Default::default()
            }),
            vec!["note"]
        );
    }

    #[test]
    fn tokens_are_quoted_prefixes() {
        assert_eq!(
            fts_expression("  hello  wor\"ld OR"),
            Some("\"hello\"* \"world\"* \"OR\"*".into())
        );
        assert_eq!(fts_expression("  \"  "), None);
    }
}
