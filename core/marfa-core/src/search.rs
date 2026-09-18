use rusqlite::{Connection, params};

use crate::Result;
use crate::model::SearchHit;
use crate::store;

pub(crate) fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let Some(expression) = fts_expression(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn.prepare(
        "SELECT items.id, bm25(items_fts, 5.0, 1.0, 2.0), snippet(items_fts, 1, '<mark>', '</mark>', '…', 12)
         FROM items_fts
         JOIN items ON items.seq = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.state != 'trashed'
         ORDER BY bm25(items_fts, 5.0, 1.0, 2.0)
         LIMIT ?2",
    )?;
    let ranked = statement
        .query_map(params![expression, limit as i64], |row| {
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
    use crate::store;
    use crate::store::testing::*;

    #[test]
    fn titles_outrank_bodies_and_the_bin_is_hidden() {
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
            Some("title"),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("title", "Zebra", "nothing here", "2026-01-01T00:00:00Z"),
            None,
            Some("title"),
        )
        .unwrap();
        store::upsert_item(
            &conn,
            &note("tag", "Plain", "plain", "2026-01-01T00:00:00Z"),
            Some(&["zebras".into()]),
            Some("title"),
        )
        .unwrap();
        let mut trashed = note("gone", "Zebra too", "zebra", "2026-01-01T00:00:00Z");
        trashed.state = "trashed".into();
        store::upsert_item(&conn, &trashed, None, Some("title")).unwrap();

        let hits = search(&conn, "zeb", 10).unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
        assert_eq!(ids, vec!["title", "tag", "body"]);
        assert_eq!(search(&conn, "zeb", 2).unwrap().len(), 2);
        assert!(hits[0].score > hits[2].score);
        assert!(hits[2].snippet.contains("<mark>zebra</mark>"));
        assert!(search(&conn, "", 10).unwrap().is_empty());
        assert!(search(&conn, "nothing crossing", 10).unwrap().is_empty());
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
