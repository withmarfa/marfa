//! An item's name and preview, read from its properties and its type's
//! effective display hints: `types/item-name-fields`, `types/item-name-text`,
//! `device/item-name-none` and the `device/item-preview-*` statements.

use serde_json::{Map, Value};

const NAME_POINTS: usize = 120;
const PREVIEW_POINTS: usize = 240;
const BODY_PROPERTY: &str = "body";

/// What an app shows for an item in a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemDisplay {
    /// None where no name field holds text, so each app chooses its own word.
    pub name: Option<String>,
    /// The body's text with its Markdown removed. None where it holds no
    /// text, or none beyond the line the item is named by.
    pub preview: Option<String>,
}

pub(crate) fn display(
    properties: &Map<String, Value>,
    title_field: Option<&str>,
    body_field: Option<&str>,
) -> ItemDisplay {
    let named = name(properties, title_field, body_field);
    let body_property = body_field.unwrap_or(BODY_PROPERTY);
    let preview = properties
        .get(body_property)
        .and_then(Value::as_str)
        .and_then(|body| match &named {
            Some((field, _)) if *field == body_property => preview(after_first_line(body)),
            _ => preview(body),
        });
    ItemDisplay {
        name: named.map(|(_, name)| name),
        preview,
    }
}

/// The name, and the property it was taken from.
fn name<'a>(
    properties: &Map<String, Value>,
    title_field: Option<&'a str>,
    body_field: Option<&'a str>,
) -> Option<(&'a str, String)> {
    let candidates = [
        title_field,
        Some("title"),
        Some("name"),
        body_field,
        Some(BODY_PROPERTY),
        Some("text"),
        Some("filename"),
        Some("url"),
        Some("address"),
    ];
    candidates.into_iter().flatten().find_map(|field| {
        let value = properties.get(field)?.as_str()?;
        let mut plain = Plain::new(NAME_POINTS);
        plain.push_str(first_line(value));
        plain.finish().map(|name| (field, name))
    })
}

/// The whitespace ECMAScript's `trim` and `\s` match, which the server's
/// name is computed with. It differs from Rust's `char::is_whitespace` in
/// U+0085 and U+FEFF.
fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

const LINE_BREAKS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

fn first_line(text: &str) -> &str {
    let text = text.trim_matches(is_space);
    text.split(LINE_BREAKS).next().unwrap_or("")
}

fn after_first_line(text: &str) -> &str {
    let text = text.trim_matches(is_space);
    match text.find(LINE_BREAKS) {
        Some(at) if text[at..].starts_with("\r\n") => &text[at + 2..],
        Some(at) => {
            let rest = &text[at..];
            &rest[rest.chars().next().map_or(0, char::len_utf8)..]
        }
        None => "",
    }
}

/// Text with each control character read as a space, each run of
/// whitespace collapsed to one space and the ends trimmed, cut at `limit`
/// code points. It stops taking text once it holds more than `limit`, so a
/// long body is not read to its end.
struct Plain {
    text: String,
    points: usize,
    space: bool,
    limit: usize,
}

impl Plain {
    fn new(limit: usize) -> Self {
        Plain {
            text: String::new(),
            points: 0,
            space: false,
            limit,
        }
    }

    fn full(&self) -> bool {
        self.points > self.limit
    }

    fn push(&mut self, c: char) {
        if self.full() {
            return;
        }
        let c = if c.is_control() { ' ' } else { c };
        if is_space(c) {
            self.space = self.points > 0;
            return;
        }
        if self.space {
            self.text.push(' ');
            self.points += 1;
            self.space = false;
        }
        self.text.push(c);
        self.points += 1;
    }

    fn push_str(&mut self, text: &str) {
        for c in text.chars() {
            if self.full() {
                return;
            }
            self.push(c);
        }
    }

    fn finish(self) -> Option<String> {
        if self.points == 0 {
            return None;
        }
        if !self.full() {
            return Some(self.text);
        }
        let cut = self
            .text
            .char_indices()
            .nth(self.limit - 1)
            .map_or(self.text.len(), |(at, _)| at);
        Some(format!("{}…", &self.text[..cut]))
    }
}

/// The body's text with its Markdown removed, by the `device/item-preview-*`
/// statements from `device/item-preview-fence` to `device/item-preview-text`.
fn preview(text: &str) -> Option<String> {
    let mut plain = Plain::new(PREVIEW_POINTS);
    let mut fence: Option<(char, usize)> = None;
    let mut lines = text.split("\r\n").flat_map(|part| part.split(LINE_BREAKS));
    while !plain.full() {
        let Some(line) = lines.next() else { break };
        let content = line.trim_start_matches(is_space);
        if let Some((mark, length)) = fence {
            if closes_fence(content, mark, length) {
                fence = None;
            } else {
                plain.push_str(line);
                plain.push(' ');
            }
            continue;
        }
        if let Some(opened) = opens_fence(content) {
            fence = Some(opened);
            continue;
        }
        if is_break(content) || is_reference(content) {
            continue;
        }
        inline(strip_blocks(content), &mut plain);
        plain.push(' ');
    }
    plain.finish()
}

fn run_of(text: &str, mark: char) -> usize {
    text.chars().take_while(|&c| c == mark).count()
}

fn opens_fence(content: &str) -> Option<(char, usize)> {
    ['`', '~'].into_iter().find_map(|mark| {
        let length = run_of(content, mark);
        (length >= 3).then_some((mark, length))
    })
}

fn closes_fence(content: &str, mark: char, length: usize) -> bool {
    let content = content.trim_end_matches(is_space);
    content.chars().count() >= length && content.chars().all(|c| c == mark)
}

/// A thematic break, or a heading's `=` underline.
fn is_break(content: &str) -> bool {
    let marks: Vec<char> = content.chars().filter(|&c| !is_space(c)).collect();
    let Some(&first) = marks.first() else {
        return false;
    };
    let same = marks.iter().all(|&c| c == first);
    same && (first == '='
        && !content.starts_with(is_space)
        && content.trim_end_matches(is_space).chars().all(|c| c == '=')
        || matches!(first, '-' | '*' | '_') && marks.len() >= 3)
}

/// `[label]: destination`.
fn is_reference(content: &str) -> bool {
    let Some(rest) = content.strip_prefix('[') else {
        return false;
    };
    let Some(close) = rest.find("]:") else {
        return false;
    };
    close > 0 && !rest[..close].contains(']') && rest[close + 2..].chars().any(|c| !is_space(c))
}

/// Followed by whitespace or the end of the line.
fn marker<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(prefix)?;
    (rest.is_empty() || rest.starts_with(is_space)).then_some(rest)
}

fn list_marker(line: &str) -> Option<&str> {
    if let Some(rest) = ["-", "*", "+"].iter().find_map(|m| marker(line, m)) {
        return Some(rest);
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if !(1..=9).contains(&digits) {
        return None;
    }
    let rest = &line[digits..];
    marker(rest, ".").or_else(|| marker(rest, ")"))
}

/// Removes quote, heading, list and task markers from the start of a line,
/// and a heading's closing `#` run.
fn strip_blocks(mut line: &str) -> &str {
    loop {
        line = line.trim_start_matches(is_space);
        if let Some(rest) = line.strip_prefix('>') {
            line = rest;
            continue;
        }
        let hashes = run_of(line, '#');
        if (1..=6).contains(&hashes)
            && let Some(rest) = marker(line, &line[..hashes])
        {
            let rest = rest.trim_end_matches(is_space);
            let kept = rest.trim_end_matches('#');
            return if kept.is_empty() || kept.ends_with(is_space) {
                kept
            } else {
                rest
            };
        }
        if let Some(rest) = list_marker(line) {
            let rest = rest.trim_start_matches(is_space);
            line = ["[ ]", "[x]", "[X]"]
                .iter()
                .find_map(|box_| marker(rest, box_))
                .unwrap_or(rest);
            continue;
        }
        return line;
    }
}

fn find(chars: &[char], from: usize, needle: &[char]) -> Option<usize> {
    (from..chars.len().saturating_sub(needle.len() - 1)).find(|&at| chars[at..].starts_with(needle))
}

/// The end of a link or image whose `[` is at `open`: its text, and the
/// index after its `(destination)` or `[label]`.
fn link_end(chars: &[char], open: usize) -> Option<(usize, usize, usize)> {
    let close = find(chars, open + 1, &[']'])?;
    let closer = match chars.get(close + 1)? {
        '(' => ')',
        '[' => ']',
        _ => return None,
    };
    let end = find(chars, close + 2, &[closer])?;
    Some((open + 1, close, end + 1))
}

fn autolink_end(chars: &[char], open: usize) -> Option<usize> {
    let scheme = chars[open + 1..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        .count();
    if !(2..=32).contains(&scheme) || !chars[open + 1].is_ascii_alphabetic() {
        return None;
    }
    if chars.get(open + 1 + scheme) != Some(&':') {
        return None;
    }
    let mut at = open + 2 + scheme;
    while let Some(&c) = chars.get(at) {
        match c {
            '>' => return Some(at),
            '<' => return None,
            c if is_space(c) => return None,
            _ => at += 1,
        }
    }
    None
}

fn word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric())
}

fn inline(text: &str, out: &mut Plain) {
    let chars: Vec<char> = text.chars().collect();
    inline_chars(&chars, out);
}

fn inline_chars(chars: &[char], out: &mut Plain) {
    let mut at = 0;
    while at < chars.len() && !out.full() {
        let c = chars[at];
        let next = chars.get(at + 1);
        match c {
            '\\' if next.is_some_and(char::is_ascii_punctuation) => {
                out.push(chars[at + 1]);
                at += 2;
            }
            '`' => {
                let length = chars[at..].iter().take_while(|&&c| c == '`').count();
                let fence = vec!['`'; length];
                let close = find(chars, at + length, &fence)
                    .filter(|&close| chars.get(close + length) != Some(&'`'));
                match close {
                    Some(close) => {
                        chars[at + length..close].iter().for_each(|&c| out.push(c));
                        at = close + length;
                    }
                    None => {
                        fence.iter().for_each(|&c| out.push(c));
                        at += length;
                    }
                }
            }
            '!' if chars[at + 1..].starts_with(&['[', '[']) => {
                match find(chars, at + 3, &[']', ']']) {
                    Some(end) => at = end + 2,
                    None => {
                        out.push('!');
                        at += 1;
                    }
                }
            }
            '[' if next == Some(&'[') => match find(chars, at + 2, &[']', ']']) {
                Some(end) => {
                    let inner = &chars[at + 2..end];
                    let shown = inner
                        .iter()
                        .position(|&c| c == '|')
                        .map_or(inner, |bar| &inner[bar + 1..]);
                    shown.iter().for_each(|&c| out.push(c));
                    at = end + 2;
                }
                None => {
                    out.push('[');
                    at += 1;
                }
            },
            '!' if next == Some(&'[') => match link_end(chars, at + 1) {
                Some((_, _, after)) => at = after,
                None => {
                    out.push('!');
                    at += 1;
                }
            },
            '[' => match link_end(chars, at) {
                Some((start, close, after)) => {
                    inline_chars(&chars[start..close], out);
                    at = after;
                }
                None => {
                    out.push('[');
                    at += 1;
                }
            },
            '<' => match autolink_end(chars, at) {
                Some(close) => {
                    chars[at + 1..close].iter().for_each(|&c| out.push(c));
                    at = close + 1;
                }
                None => {
                    out.push('<');
                    at += 1;
                }
            },
            '*' | '_' | '~' => {
                let length = chars[at..].iter().take_while(|&&m| m == c).count();
                let removed = if length >= 2 {
                    true
                } else if c == '~' {
                    false
                } else {
                    let before = at.checked_sub(1).and_then(|b| chars.get(b));
                    word(before) != word(chars.get(at + 1))
                };
                if !removed {
                    (0..length).for_each(|_| out.push(c));
                }
                at += length;
            }
            _ => {
                out.push(c);
                at += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::catalog::Catalog;
    use crate::store;
    use crate::wire::{WireCatalog, WireType};

    /// The cases the server's summaries are held to as well, so the two
    /// implementations of the name cannot drift apart.
    const SHARED: &str = include_str!("../../../conformance/fixtures/item-display.json");

    #[derive(Deserialize)]
    struct Shared {
        types: Vec<Value>,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        description: String,
        r#type: String,
        properties: Map<String, Value>,
        name: Option<String>,
        preview: Option<String>,
    }

    fn catalog(types: &[Value]) -> Catalog {
        let mut listed: WireCatalog = crate::builtin::catalog().unwrap();
        for registered in types {
            let mut row = registered.clone();
            row["version"] = Value::from(0);
            listed
                .types
                .push(serde_json::from_value::<WireType>(row).unwrap());
        }
        let conn = store::open_in_memory().unwrap();
        store::replace_catalog(&conn, &listed).unwrap();
        Catalog::load(&conn).unwrap()
    }

    #[test]
    fn names_and_previews_every_shared_case() {
        let shared: Shared = serde_json::from_str(SHARED).unwrap();
        let catalog = catalog(&shared.types);
        let mut failed = Vec::new();
        for case in &shared.cases {
            let got = catalog.display(&case.r#type, &case.properties);
            let want = ItemDisplay {
                name: case.name.clone(),
                preview: case.preview.clone(),
            };
            if got != want {
                failed.push(format!("{}: got {got:?}, want {want:?}", case.description));
            }
        }
        assert!(failed.is_empty(), "{}", failed.join("\n"));
    }

    #[test]
    fn passes_over_values_that_are_not_strings() {
        let properties = serde_json::json!({
            "title": {}, "name": 17, "body": [], "text": null, "filename": " document.pdf "
        });
        let shown = display(properties.as_object().unwrap(), None, None);
        assert_eq!(shown.name.as_deref(), Some("document.pdf"));
        assert_eq!(shown.preview, None);
    }

    #[test]
    fn names_an_unknown_type_by_the_fallback_fields() {
        let catalog = catalog(&[]);
        let properties = serde_json::json!({ "body": "Fallback\nrest" });
        let shown = catalog.display("user.nothing-registered", properties.as_object().unwrap());
        assert_eq!(shown.name.as_deref(), Some("Fallback"));
        assert_eq!(shown.preview.as_deref(), Some("rest"));
    }

    #[test]
    fn reads_an_unclosed_fence_and_unclosed_markup_as_text() {
        let properties = serde_json::json!({
            "title": "T",
            "body": "[not a link\n`open code and *open em\n```\nkept *as* code"
        });
        let shown = display(properties.as_object().unwrap(), None, None);
        assert_eq!(
            shown.preview.as_deref(),
            Some("[not a link `open code and open em kept *as* code")
        );
    }

    #[test]
    fn stops_reading_a_long_body_once_the_preview_is_full() {
        let body = format!("{}\n{}", "a ".repeat(200), "b".repeat(1_000_000));
        let properties = serde_json::json!({ "title": "T", "body": body });
        let shown = display(properties.as_object().unwrap(), None, None);
        let preview = shown.preview.unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_POINTS);
        assert!(preview.ends_with('…'));
        assert!(preview.starts_with("a a a"));
    }
}
