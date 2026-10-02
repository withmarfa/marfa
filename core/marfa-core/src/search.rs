use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::Result;
use crate::catalog::Catalog;
use crate::filter;
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
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
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
    // Before the query is looked at, so an expression the grammar refuses
    // is refused on a search with no words as on any other.
    filter::narrow(
        filters.filter.as_deref(),
        filters.beneath.as_deref(),
        &mut clauses,
        &mut values,
    )?;
    let Some(expression) = fts_expression(query) else {
        return Ok(Vec::new());
    };
    values.insert(0, Value::String(expression));
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
        assert_eq!(ids, vec!["body", "filed", "tag", "title"]);
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
