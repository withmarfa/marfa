//! A search's text as the full-text index takes it, and the excerpt it answers with.

use serde_json::{Map, Value};

use crate::catalog::Indexing;
use crate::error::{FieldError, RuleError, field_code};

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

/// Most characters a search's text holds, counted after the surrounding whitespace is trimmed.
pub const MAX_QUERY_CHARS: usize = 500;

/// Most distinct words a search's text holds.
pub const MAX_QUERY_TERMS: usize = 16;

/// Most distinct tags a listing or a search narrows by.
pub const MAX_FILTER_TAGS: usize = crate::validation::MAX_TAGS_PER_ITEM;

/// An input past a bound: the request part and a message naming the bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastBound {
    pub field: &'static str,
    pub message: String,
}

impl From<PastBound> for RuleError {
    fn from(past: PastBound) -> RuleError {
        let path = past.field;
        RuleError::validation(past.message.clone()).with_fields(vec![FieldError::new(
            path,
            field_code::TOO_LONG,
            past.message,
        )])
    }
}

/// A query wholly inside double quotes is one phrase; otherwise each distinct whitespace-separated word is quoted, so nothing a person types is FTS5 syntax, and the last word also matches as a prefix. A word typed again is dropped.
pub fn fts_expression(query: &str) -> Option<String> {
    fts_phrases(query).map(|phrases| phrases.join(" "))
}

/// The phrases of [`fts_expression`], in its order.
pub fn fts_phrases(query: &str) -> Option<Vec<String>> {
    let query = query.trim();
    if query.chars().count() > 2 && query.starts_with('"') && query.ends_with('"') {
        let inner = &query[1..query.len() - 1];
        return Some(vec![format!("\"{}\"", inner.replace('"', "\"\""))]);
    }
    let typed: Vec<&str> = query
        .split(char::is_whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let newest = typed.last()?;
    // A last word typed earlier too is already required whole, which also covers it as a prefix.
    let prefix = typed.iter().filter(|word| *word == newest).count() == 1;
    let mut words: Vec<&str> = Vec::new();
    for word in &typed {
        if !words.contains(word) {
            words.push(word);
        }
    }
    let last = words.len() - 1;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(at, word)| {
                let quoted = format!("\"{}\"", word.replace('"', "\"\""));
                if at == last && prefix {
                    format!("{quoted}*")
                } else {
                    quoted
                }
            })
            .collect(),
    )
}

/// Refuses a search's text longer than [`MAX_QUERY_CHARS`] characters or holding more than [`MAX_QUERY_TERMS`] distinct words.
pub fn check_query(query: &str) -> Result<(), PastBound> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(PastBound {
            field: "q",
            message: format!("q holds at most {MAX_QUERY_CHARS} characters."),
        });
    }
    if fts_phrases(query).is_some_and(|phrases| phrases.len() > MAX_QUERY_TERMS) {
        return Err(PastBound {
            field: "q",
            message: format!("q holds at most {MAX_QUERY_TERMS} distinct words."),
        });
    }
    Ok(())
}

/// The tags a list narrows by: each trimmed, blank ones and repeats dropped, in the order given. Refuses more than [`MAX_FILTER_TAGS`] of them, or one longer than [`MAX_TAG_LENGTH`](crate::validation::MAX_TAG_LENGTH) characters.
pub fn filter_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>, PastBound> {
    let mut kept: Vec<String> = Vec::new();
    for tag in tags
        .into_iter()
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
    {
        if tag.chars().count() > crate::validation::MAX_TAG_LENGTH {
            return Err(PastBound {
                field: "tags",
                message: format!(
                    "Each tag in tags holds at most {} characters.",
                    crate::validation::MAX_TAG_LENGTH
                ),
            });
        }
        if kept.iter().any(|seen| seen == tag) {
            continue;
        }
        if kept.len() == MAX_FILTER_TAGS {
            return Err(PastBound {
                field: "tags",
                message: format!("tags holds at most {MAX_FILTER_TAGS} distinct tags."),
            });
        }
        kept.push(tag.to_string());
    }
    Ok(kept)
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

    #[test]
    fn a_repeated_word_is_searched_once_and_is_a_prefix_only_when_typed_last_and_once() {
        assert_eq!(fts_expression("the the the"), Some("\"the\"".into()));
        assert_eq!(fts_expression("a b a"), Some("\"a\" \"b\"".into()));
        assert_eq!(fts_expression("a b b"), Some("\"a\" \"b\"".into()));
        assert_eq!(fts_expression("a a b"), Some("\"a\" \"b\"*".into()));
    }

    #[test]
    fn the_query_bounds_count_characters_and_distinct_words() {
        let words = |count: usize| {
            (0..count)
                .map(|n| format!("w{n}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert!(check_query(&words(MAX_QUERY_TERMS)).is_ok());
        assert_eq!(
            check_query(&words(MAX_QUERY_TERMS + 1)).unwrap_err().field,
            "q"
        );
        assert!(check_query(&format!("{} w0 w1 w1", words(MAX_QUERY_TERMS))).is_ok());
        assert!(check_query(&"\u{1F600}".repeat(MAX_QUERY_CHARS)).is_ok());
        assert!(check_query(&"\u{1F600}".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(check_query(&format!("  {}  ", "x".repeat(MAX_QUERY_CHARS))).is_ok());
        assert!(check_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(check_query("\"open quote").is_ok());
        assert!(check_query(&" ".repeat(2000)).is_ok());
    }

    #[test]
    fn the_tag_bounds_count_distinct_tags_and_ignore_blank_entries() {
        let many = |count: usize| (0..count).map(|n| format!("t{n}")).collect::<Vec<_>>();
        let list = |tags: &[String]| filter_tags(tags.iter().map(String::as_str));
        assert_eq!(list(&many(MAX_FILTER_TAGS)).unwrap().len(), MAX_FILTER_TAGS);
        assert_eq!(list(&many(MAX_FILTER_TAGS + 1)).unwrap_err().field, "tags");
        let mut padded = many(MAX_FILTER_TAGS);
        padded.extend(["".into(), "  ".into(), "t0".into(), " t1 ".into()]);
        assert_eq!(list(&padded).unwrap().len(), MAX_FILTER_TAGS);
        assert!(list(&["x".repeat(128)]).is_ok());
        assert!(list(&["\u{1F600}".repeat(128)]).is_ok());
        assert!(list(&["x".repeat(129)]).is_err());
    }
}
