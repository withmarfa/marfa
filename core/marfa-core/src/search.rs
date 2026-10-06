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
    search_where(conn, query, &clauses, values, limit)
}

/// Ranked as `search` ranks, narrowed by `clauses` on `items`.
pub(crate) fn search_where(
    conn: &Connection,
    query: &str,
    clauses: &[String],
    mut values: Vec<Value>,
    limit: usize,
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
    let items = store::items_by_ids(conn, &ids)?;
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

// FTS5 puts these private-use characters around each match in place of the
// tags, so the excerpt is escaped whole before they become `<mark>` and
// `</mark>`. A row's own text can hold them as well, so each opens only a
// closed mark and closes only an open one.
const MARK_OPEN: char = '\u{E000}';
const MARK_CLOSE: char = '\u{E001}';

/// The excerpt FTS5 cut, as HTML whose only markup is `<mark>` around
/// matches, written as the server writes `snippet_html`.
fn snippet_html(excerpt: &str) -> String {
    let mut html = String::with_capacity(excerpt.len());
    let mut open = false;
    for character in excerpt.chars() {
        match character {
            MARK_OPEN => {
                if !open {
                    html.push_str("<mark>");
                }
                open = true;
            }
            MARK_CLOSE => {
                if open {
                    html.push_str("</mark>");
                }
                open = false;
            }
            '&' => html.push_str("&amp;"),
            '<' => html.push_str("&lt;"),
            '>' => html.push_str("&gt;"),
            '"' => html.push_str("&quot;"),
            '\'' => html.push_str("&#39;"),
            other => html.push(other),
        }
    }
    if open {
        html.push_str("</mark>");
    }
    html
}

/// The server's reading of a query, which `search-and-filters.md` states: a
/// query wholly inside double quotes is one phrase; otherwise each
/// whitespace-separated word is quoted, so nothing a person types is read as
/// FTS5 syntax, and the last word also matches as a prefix.
fn fts_expression(query: &str) -> Option<String> {
    let query = query.trim_matches(is_query_whitespace);
    if query.chars().count() > 2 && query.starts_with('"') && query.ends_with('"') {
        let inner = &query[1..query.len() - 1];
        return Some(format!("\"{}\"", inner.replace('"', "\"\"")));
    }
    let words: Vec<&str> = query
        .split(is_query_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let last = words.len().checked_sub(1)?;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(at, word)| {
                let quoted = format!("\"{}\"", word.replace('"', "\"\""));
                if at == last {
                    format!("{quoted}*")
                } else {
                    quoted
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

// Match JavaScript's trim and \s rules on the server, including pasted BOMs.
fn is_query_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{0085}') || character == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Indexing;
    use crate::model::ItemState;
    use crate::store;
    use crate::store::testing::*;

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
        let hits = search(&conn, &Catalog::load(&conn).unwrap(), "zeb", &default, 10).unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
        // The title and the tag hold one match in three words each, so they
        // tie and the id breaks it; the body's is one in four.
        assert_eq!(ids, vec!["tag", "title", "body"]);
        assert_eq!(
            search(&conn, &Catalog::load(&conn).unwrap(), "zeb", &default, 2)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(hits[0].score, hits[1].score);
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
            &Catalog::load(&conn).unwrap(),
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
    fn markers_the_text_holds_itself_make_only_well_formed_marks() {
        assert_eq!(
            snippet_html("\u{E001}a \u{E000}\u{E000}b\u{E001}\u{E001} c \u{E000}d"),
            "a <mark>b</mark> c <mark>d</mark>"
        );
    }

    #[test]
    fn surrounding_whitespace_keeps_a_quoted_query_a_phrase() {
        for query in [
            " \"quiet landscape\" ",
            "\t\"quiet land\"\n",
            "\u{feff}\"quiet landscape\"\u{feff}",
        ] {
            let expected = if query.contains("land\"") {
                "\"quiet land\""
            } else {
                "\"quiet landscape\""
            };
            assert_eq!(fts_expression(query), Some(expected.into()));
        }
    }

    #[test]
    fn only_the_last_word_is_a_prefix_and_a_quoted_query_is_a_phrase() {
        assert_eq!(
            fts_expression("  hello  wor\"ld OR"),
            Some("\"hello\" \"wor\"\"ld\" \"OR\"*".into())
        );
        assert_eq!(fts_expression("  "), None);
        assert_eq!(fts_expression(""), None);
        assert_eq!(
            fts_expression("\"exact phrase\""),
            Some("\"exact phrase\"".into())
        );
        // Not wholly inside quotes, and a lone pair of quotes: words.
        assert_eq!(
            fts_expression("\"exact\" phrase"),
            Some("\"\"\"exact\"\"\" \"phrase\"*".into())
        );
        assert_eq!(fts_expression("\"\""), Some("\"\"\"\"\"\"*".into()));
    }
}
