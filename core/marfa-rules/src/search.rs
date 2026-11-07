//! The text of a search as the full-text index takes it, and the excerpt it
//! answers with.

use crate::js;

// FTS5 puts these private-use characters around each match in place of the
// tags, so the excerpt is escaped whole before they become `<mark>` and
// `</mark>`. A row's own text can hold them as well, so each opens only a
// closed mark and closes only an open one.
pub const MARK_OPEN: char = '\u{E000}';
pub const MARK_CLOSE: char = '\u{E001}';

/// The excerpt FTS5 cut, as HTML whose only markup is `<mark>` around
/// matches, written as the server writes `snippet_html`.
pub fn snippet_html(excerpt: &str) -> String {
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
pub fn fts_expression(query: &str) -> Option<String> {
    let query = query.trim_matches(js::is_space);
    if query.chars().count() > 2 && query.starts_with('"') && query.ends_with('"') {
        let inner = &query[1..query.len() - 1];
        return Some(format!("\"{}\"", inner.replace('"', "\"\"")));
    }
    let words: Vec<&str> = query
        .split(js::is_space)
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

#[cfg(test)]
mod tests {
    use super::*;

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
