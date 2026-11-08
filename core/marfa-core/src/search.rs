use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::Result;
use crate::filter;
use crate::model::{SearchFilters, SearchHit};
use crate::query;
use crate::store::{self, Unreadable};
use marfa_rules::catalog::Catalog;
use marfa_rules::search::{MARK_CLOSE, MARK_OPEN, fts_expression, snippet_html};

pub(crate) fn search(
    conn: &Connection,
    catalog: &Catalog,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
    unreadable: &mut Unreadable,
) -> Result<Vec<SearchHit>> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    query::narrow_by_types(catalog, filters.types.as_deref(), &mut clauses, &mut values)?;
    query::narrow_by_states(
        filters.states.as_deref(),
        filters.all_states,
        &mut clauses,
        &mut values,
    )?;
    if let Some(tier) = filters.tier {
        clauses.push("items.tier = ?".into());
        values.push(Value::String(tier.as_str().into()));
    }
    query::narrow_by_tags(&filters.tags, &mut clauses, &mut values);
    query::narrow_by_own_time(
        filters.occurred_after.as_deref(),
        filters.occurred_before.as_deref(),
        &mut clauses,
        &mut values,
    )?;
    // Before the query is looked at, so an expression the grammar refuses
    // is refused on a search with no words as on any other.
    filter::narrow(
        filters.filter.as_deref(),
        filters.beneath.as_deref(),
        &store::whole_edge_types(conn)?,
        catalog,
        &mut clauses,
        &mut values,
    )?;
    search_where(conn, query, &clauses, values, limit, unreadable)
}

/// Ranked as `search` ranks, narrowed by `clauses` on `items`.
pub(crate) fn search_where(
    conn: &Connection,
    query: &str,
    clauses: &[String],
    mut values: Vec<Value>,
    limit: usize,
    unreadable: &mut Unreadable,
) -> Result<Vec<SearchHit>> {
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
        "SELECT items.id, bm25(items_fts), snippet(items_fts, -1, '{MARK_OPEN}', '{MARK_CLOSE}', '...', 32)
         FROM items_fts
         JOIN items ON items.seq = items_fts.rowid
         WHERE items_fts MATCH ?{narrowing}
         ORDER BY bm25(items_fts), items.id
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
    let items = store::items_by_ids_with(conn, &ids, unreadable)?;
    Ok(ranked
        .into_iter()
        .filter_map(|(id, rank, snippet)| {
            let item = items.iter().find(|item| item.id == id)?.clone();
            Some(SearchHit {
                item,
                score: -rank,
                snippet: snippet_html(&snippet),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ItemState, Tier};
    use crate::store;
    use crate::store::testing::*;
    use marfa_rules::catalog::Indexing;

    fn search(
        conn: &Connection,
        catalog: &Catalog,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        super::search(
            conn,
            catalog,
            query,
            filters,
            limit,
            &mut Unreadable::Refuse,
        )
    }

    #[test]
    fn hits_rank_by_bm25_then_id_and_only_the_active_state_answers() {
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
            &Indexing::default(),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("title", "Zebra", "nothing here", "2026-01-01T00:00:00Z"),
            None,
            &Indexing::default(),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("tag", "Plain", "plain", "2026-01-01T00:00:00Z"),
            Some(&["zebras".into()]),
            &Indexing::default(),
        )
        .unwrap();
        let mut trashed = note("gone", "Zebra too", "zebra", "2026-01-01T00:00:00Z");
        trashed.state = "trashed".into();
        store::upsert_item(&conn, &trashed, None, &Indexing::default()).unwrap();
        let mut archived = note("filed", "Zebra filed", "zebra", "2026-01-01T00:00:00Z");
        archived.state = "archived".into();
        store::upsert_item(&conn, &archived, None, &Indexing::default()).unwrap();

        let default = SearchFilters::default();
        let hits = search(
            &conn,
            &crate::catalog::load(&conn).unwrap(),
            "zeb",
            &default,
            10,
        )
        .unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
        // The title and the tag hold one match in three words each, so they
        // tie and the id breaks it; the body's is one in four.
        assert_eq!(ids, vec!["tag", "title", "body"]);
        assert_eq!(
            search(
                &conn,
                &crate::catalog::load(&conn).unwrap(),
                "zeb",
                &default,
                2
            )
            .unwrap()
            .len(),
            2
        );
        assert_eq!(hits[0].score, hits[1].score);
        assert!(hits[0].score > hits[2].score);
        assert!(hits[2].snippet.contains("<mark>zebra</mark>"));
        assert!(
            search(
                &conn,
                &crate::catalog::load(&conn).unwrap(),
                "",
                &default,
                10
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            search(
                &conn,
                &crate::catalog::load(&conn).unwrap(),
                "nothing crossing",
                &default,
                10
            )
            .unwrap()
            .is_empty()
        );

        let filed = SearchFilters {
            states: Some(vec![ItemState::Archived]),
            ..Default::default()
        };
        let ids: Vec<String> = search(
            &conn,
            &crate::catalog::load(&conn).unwrap(),
            "zeb",
            &filed,
            10,
        )
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
            &crate::catalog::load(&conn).unwrap(),
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
    fn an_excerpt_escapes_the_text_and_marks_only_the_match() {
        let conn = conn();
        store::upsert_item(
            &conn,
            &note(
                "markup",
                "Plain",
                "<b>numbat</b> & \"q\" 'p'",
                "2026-01-01T00:00:00Z",
            ),
            None,
            &Indexing::default(),
        )
        .unwrap();
        let hits = search(
            &conn,
            &crate::catalog::load(&conn).unwrap(),
            "numbat",
            &SearchFilters::default(),
            10,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].snippet,
            "&lt;b&gt;<mark>numbat</mark>&lt;/b&gt; &amp; &quot;q&quot; &#39;p&#39;"
        );
    }

    #[test]
    fn a_tier_and_a_range_of_own_time_narrow_a_search_from_either_end() {
        let conn = conn();
        for (id, when, tier) in [
            ("one", "2026-01-01T00:00:00.000Z", "library"),
            ("two", "2026-01-02T00:00:00.000Z", "library"),
            ("three", "2026-01-03T00:00:00.000Z", "feed"),
        ] {
            let mut item = note(id, "Zebra", "zebra", when);
            item.tier = Some(tier.into());
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        let catalog = crate::catalog::load(&conn).unwrap();
        let found = |filters: SearchFilters| -> Vec<String> {
            let mut ids: Vec<String> = search(&conn, &catalog, "zebra", &filters, 10)
                .unwrap()
                .into_iter()
                .map(|hit| hit.item.id)
                .collect();
            ids.sort();
            ids
        };
        let at = |tier: Option<Tier>, after: Option<&str>, before: Option<&str>| SearchFilters {
            tier,
            occurred_after: after.map(Into::into),
            occurred_before: before.map(Into::into),
            ..Default::default()
        };
        assert_eq!(found(at(None, None, None)), ["one", "three", "two"]);
        assert_eq!(found(at(Some(Tier::Feed), None, None)), ["three"]);
        // Both ends are left out of the range, and one end works alone.
        assert_eq!(
            found(at(None, Some("2026-01-01T00:00:00Z"), None)),
            ["three", "two"]
        );
        assert_eq!(
            found(at(None, None, Some("2026-01-03T00:00:00Z"))),
            ["one", "two"]
        );
        assert_eq!(
            found(at(
                Some(Tier::Library),
                Some("2026-01-01T00:00:00Z"),
                Some("2026-01-03T00:00:00Z")
            )),
            ["two"]
        );
    }
}
