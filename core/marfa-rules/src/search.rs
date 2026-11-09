//! A search's text as the full-text index takes it, and the excerpt it answers with.

use serde_json::{Map, Value};

use crate::catalog::Indexing;

// FTS5 wraps each match in private-use characters; the excerpt is escaped whole before they become `<mark>`. A row's own text can hold them too, so each opens only a closed mark and closes only an open one.
pub const MARK_OPEN: char = '\u{E000}';
pub const MARK_CLOSE: char = '\u{E001}';

/// HTML whose only markup is `<mark>` around matches.
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

/// A query wholly inside double quotes is one phrase; otherwise each whitespace-separated word is quoted, so nothing a person types is FTS5 syntax, and the last word also matches as a prefix.
pub fn fts_expression(query: &str) -> Option<String> {
    let query = query.trim();
    if query.chars().count() > 2 && query.starts_with('"') && query.ends_with('"') {
        let inner = &query[1..query.len() - 1];
        return Some(format!("\"{}\"", inner.replace('"', "\"\"")));
    }
    let words: Vec<&str> = query
        .split(char::is_whitespace)
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

#[derive(Debug, Default, PartialEq, Eq)]
pub struct FtsText {
    pub title: String,
    pub body: String,
    pub description: String,
    pub name: String,
    pub extra: String,
}

/// The four core properties when they hold a string, the type's other declared string properties joined by a space, and nothing undeclared. A thumbnail is not a string property, so its base64 is never indexed.
pub fn fts_text(properties: &Map<String, Value>, indexing: &Indexing) -> FtsText {
    let core = |name: &str| -> String {
        if indexing.opted_out.iter().any(|opted| opted == name) {
            return String::new();
        }
        properties
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let extra: Vec<&str> = indexing
        .extra
        .iter()
        .filter_map(|name| properties.get(name).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect();
    FtsText {
        title: core("title"),
        body: core("body"),
        description: core("description"),
        name: core("name"),
        extra: extra.join(" "),
    }
}

/// In byte order, so the same tags in another order are the same text.
pub fn fts_tags(tags: &[String]) -> String {
    let mut sorted: Vec<&str> = tags.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.join(" ")
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
            "\u{85}\"quiet landscape\"\u{2003}",
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
        assert_eq!(
            fts_expression("\"exact\" phrase"),
            Some("\"\"\"exact\"\"\" \"phrase\"*".into())
        );
        assert_eq!(fts_expression("\"\""), Some("\"\"\"\"\"\"*".into()));
    }
}
