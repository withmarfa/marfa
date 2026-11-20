//! An item's name and preview, read from its properties and its type's effective display hints.

use std::cell::OnceCell;
use std::iter::{Enumerate, Peekable};

use serde_json::{Map, Value};

const NAME_POINTS: usize = 120;
const PREVIEW_POINTS: usize = 240;
const BODY_PROPERTY: &str = "body";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemDisplay {
    /// None where no name field holds text, so each app chooses its own word.
    pub name: Option<String>,
    /// The body's text with Markdown removed; None where nothing is left beyond the line the item is named by.
    pub preview: Option<String>,
}

pub fn display(
    properties: &Map<String, Value>,
    title_field: Option<&str>,
    body_field: Option<&str>,
    name_from_body: bool,
) -> ItemDisplay {
    let named = name(properties, title_field, body_field, name_from_body);
    let body_property = body_field.unwrap_or(BODY_PROPERTY);
    let preview = properties
        .get(body_property)
        .and_then(Value::as_str)
        .and_then(|body| {
            let skipped = named
                .as_ref()
                .filter(|named| named.field == body_property)
                .map(|named| named.line);
            preview(body, skipped)
        });
    ItemDisplay {
        name: named.map(|named| named.text),
        preview,
    }
}

/// From the effective `display_hints.title_field`, then `title`, then `name`; none where none holds text.
pub fn title_name(properties: &Map<String, Value>, title_field: Option<&str>) -> Option<String> {
    let mut tried: Vec<&str> = Vec::with_capacity(3);
    [title_field, Some("title"), Some("name")]
        .into_iter()
        .flatten()
        .find_map(|field| {
            if tried.contains(&field) {
                return None;
            }
            tried.push(field);
            plain_name(properties.get(field)?.as_str()?).map(|(_, text)| text)
        })
}

/// A part named after its host: the edge type's label, a space and the host's name. Its name comes from no line of its body, so the preview keeps every line.
pub fn part_display(
    properties: &Map<String, Value>,
    body_field: Option<&str>,
    label: &str,
    host_name: &str,
) -> ItemDisplay {
    let mut plain = Plain::new(NAME_POINTS);
    plain.push_str(label);
    plain.push(' ');
    plain.push_str(host_name);
    ItemDisplay {
        name: plain.finish(),
        preview: properties
            .get(body_field.unwrap_or(BODY_PROPERTY))
            .and_then(Value::as_str)
            .and_then(|body| preview(body, None)),
    }
}

struct Named<'a> {
    field: &'a str,
    line: usize,
    text: String,
}

/// The body properties are left out where the type's `name_from_body` is false.
fn name<'a>(
    properties: &Map<String, Value>,
    title_field: Option<&'a str>,
    body_field: Option<&'a str>,
    name_from_body: bool,
) -> Option<Named<'a>> {
    let body = |field: Option<&'a str>| field.filter(|_| name_from_body);
    let candidates = [
        (title_field, false),
        (Some("title"), false),
        (Some("name"), false),
        (body(body_field), true),
        (body(Some(BODY_PROPERTY)), true),
        (body(Some("text")), true),
        (Some("filename"), false),
        (Some("url"), false),
        (Some("address"), false),
    ];
    let mut tried: Vec<&str> = Vec::with_capacity(candidates.len());
    candidates.into_iter().find_map(|(field, markdown)| {
        let field = field?;
        if tried.contains(&field) {
            return None;
        }
        tried.push(field);
        let value = properties.get(field)?.as_str()?;
        let (line, text) = if markdown {
            markdown_name(value)
        } else {
            plain_name(value)
        }?;
        Some(Named { field, line, text })
    })
}

fn plain_name(value: &str) -> Option<(usize, String)> {
    let (at, line) = lines(value)
        .enumerate()
        .find(|(_, line)| line.chars().any(|c| !c.is_whitespace()))?;
    let mut plain = Plain::new(NAME_POINTS);
    plain.push_str(line);
    plain.finish().map(|text| (at, text))
}

fn markdown_name(value: &str) -> Option<(usize, String)> {
    let notes = Notes::new(value);
    for (at, line) in Markdown::new(value) {
        let mut plain = Plain::new(NAME_POINTS);
        line.write(&mut plain, &notes);
        if plain.seen {
            return plain.finish().map(|text| (at, text));
        }
    }
    None
}

const LINE_BREAKS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

#[derive(Clone)]
struct Lines<'a> {
    rest: Option<&'a str>,
}

fn lines(text: &str) -> Lines<'_> {
    Lines { rest: Some(text) }
}

impl<'a> Iterator for Lines<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        let rest = self.rest?;
        let Some(at) = rest.find(LINE_BREAKS) else {
            self.rest = None;
            return Some(rest);
        };
        let width = if rest[at..].starts_with("\r\n") {
            2
        } else {
            rest[at..].chars().next().map_or(1, char::len_utf8)
        };
        self.rest = Some(&rest[at + width..]);
        Some(&rest[..at])
    }
}

/// Control characters read as spaces, whitespace runs collapsed, ends trimmed, cut at `limit` code points. It stops taking text past `limit`, so a long body is not read to its end.
struct Plain {
    text: String,
    points: usize,
    space: bool,
    /// Whether it was given anything but whitespace, a control character included.
    seen: bool,
    limit: usize,
}

impl Plain {
    fn new(limit: usize) -> Self {
        Plain {
            text: String::new(),
            points: 0,
            space: false,
            seen: false,
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
        self.seen |= !c.is_whitespace();
        let c = if c.is_control() { ' ' } else { c };
        if c.is_whitespace() {
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

/// Lines up to and including the index `skipped` are left out.
fn preview(text: &str, skipped: Option<usize>) -> Option<String> {
    let mut plain = Plain::new(PREVIEW_POINTS);
    let notes = Notes::new(text);
    for (at, line) in Markdown::new(text) {
        if plain.full() {
            break;
        }
        if skipped.is_some_and(|skipped| at <= skipped) {
            continue;
        }
        line.write(&mut plain, &notes);
        plain.push(' ');
    }
    plain.finish()
}

enum Line<'a> {
    Code(&'a str),
    Text(&'a str),
    /// A table row, its cells split at the pipes that are not escaped or in code.
    Cells(Vec<String>),
}

impl Line<'_> {
    fn write(&self, out: &mut Plain, notes: &Notes) {
        match self {
            Line::Code(line) => out.push_str(line),
            Line::Text(line) => inline(line, out, notes),
            Line::Cells(cells) => {
                for cell in cells {
                    inline(cell, out, notes);
                    out.push(' ');
                }
            }
        }
    }
}

/// The footnote labels a text defines, read on the first reference that asks.
struct Notes<'a> {
    text: &'a str,
    defined: OnceCell<Vec<&'a str>>,
}

impl<'a> Notes<'a> {
    fn new(text: &'a str) -> Self {
        Notes {
            text,
            defined: OnceCell::new(),
        }
    }

    fn defines(&self, label: &str) -> bool {
        let folded = |text: &str| {
            text.chars()
                .flat_map(char::to_lowercase)
                .collect::<Vec<_>>()
        };
        let wanted = folded(label);
        self.defined
            .get_or_init(|| {
                lines(self.text)
                    .filter_map(|line| {
                        footnote_definition(line.trim_start_matches(char::is_whitespace))
                    })
                    .collect()
            })
            .iter()
            .any(|defined| folded(defined) == wanted)
    }
}

/// The label of a footnote definition that opens `content`, `[^label]:`.
fn footnote_definition(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("[^")?;
    let close = rest.find(']')?;
    let label = &rest[..close];
    (footnote_label(label) && rest[close + 1..].starts_with(':')).then_some(label)
}

fn footnote_label(label: &str) -> bool {
    !label.is_empty() && !label.contains(|c: char| c.is_whitespace() || c == '[')
}

/// The index of the line that closes front matter, where the text opens with it: a first line of `---`, not followed by an empty line, and the next line of `---`.
fn front_matter_end(text: &str) -> Option<usize> {
    let mut rest = lines(text.strip_prefix('\u{feff}').unwrap_or(text));
    if rest.next()? != "---" || rest.clone().next()?.is_empty() {
        return None;
    }
    rest.position(|line| line == "---").map(|at| at + 1)
}

struct Markdown<'a> {
    lines: Peekable<Enumerate<Lines<'a>>>,
    fence: Option<(char, usize)>,
    /// Inside a footnote definition, which runs on over the indented lines after its first.
    footnote: bool,
    /// Inside a table, whose rows follow its delimiter row.
    table: bool,
}

impl<'a> Markdown<'a> {
    fn new(text: &'a str) -> Self {
        let mut lines = lines(text).enumerate().peekable();
        if let Some(end) = front_matter_end(text) {
            lines.nth(end);
        }
        Markdown {
            lines,
            fence: None,
            footnote: false,
            table: false,
        }
    }
}

impl<'a> Iterator for Markdown<'a> {
    type Item = (usize, Line<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let (at, line) = self.lines.next()?;
            let in_table = std::mem::take(&mut self.table);
            let content = line.trim_start_matches(char::is_whitespace);
            if let Some((mark, length)) = self.fence {
                if closes_fence(content, mark, length) {
                    self.fence = None;
                    continue;
                }
                return Some((at, Line::Code(line)));
            }
            if self.footnote {
                if content.is_empty() || line.starts_with("    ") || line.starts_with('\t') {
                    continue;
                }
                self.footnote = false;
            }
            if let Some(opened) = opens_fence(content) {
                self.fence = Some(opened);
                continue;
            }
            if footnote_definition(content).is_some() {
                self.footnote = true;
                continue;
            }
            if is_break(content) || is_reference(content) {
                continue;
            }
            let text = strip_blocks(content);
            if in_table && text.contains('|') {
                self.table = true;
                return Some((at, Line::Cells(cells(text))));
            }
            if text.contains('|') {
                let header = cells(text);
                let delimiter = self
                    .lines
                    .peek()
                    .and_then(|(_, next)| delimiter_columns(strip_blocks(next)));
                if delimiter == Some(header.len()) {
                    self.lines.next();
                    self.table = true;
                    return Some((at, Line::Cells(header)));
                }
            }
            return Some((at, Line::Text(text)));
        }
    }
}

/// A table row's cells: the text between the pipes that are not escaped or in a code span, without a pipe at either end. An escaped pipe is a pipe.
fn cells(row: &str) -> Vec<String> {
    let chars: Vec<char> = row.trim().chars().collect();
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut at = usize::from(chars.first() == Some(&'|'));
    let mut closed = at == chars.len();
    while at < chars.len() {
        closed = false;
        match chars[at] {
            '\\' if chars.get(at + 1) == Some(&'|') => {
                cell.push('|');
                at += 2;
            }
            '\\' if at + 1 < chars.len() => {
                cell.extend(&chars[at..at + 2]);
                at += 2;
            }
            '`' => {
                let length = run_at(&chars, at, '`');
                let end = closing_run(&chars, at + length, length)
                    .map_or(at + length, |close| close + length);
                let span: String = chars[at..end].iter().collect();
                cell.push_str(&span.replace("\\|", "|"));
                at = end;
            }
            '|' => {
                cells.push(std::mem::take(&mut cell));
                closed = true;
                at += 1;
            }
            c => {
                cell.push(c);
                at += 1;
            }
        }
    }
    if !closed {
        cells.push(cell);
    }
    cells
}

/// The number of columns a delimiter row marks, where `row` is one: cells of dashes, each with an optional colon at either end, and a pipe among them.
fn delimiter_columns(row: &str) -> Option<usize> {
    let row = row.trim();
    if !row.contains('|') {
        return None;
    }
    let row = row.strip_prefix('|').unwrap_or(row);
    let row = row.strip_suffix('|').unwrap_or(row);
    let mut columns = 0;
    for cell in row.split('|') {
        let dashes = cell.trim().trim_start_matches(':').trim_end_matches(':');
        if dashes.is_empty() || !dashes.chars().all(|c| c == '-') {
            return None;
        }
        columns += 1;
    }
    Some(columns)
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
    let content = content.trim_end_matches(char::is_whitespace);
    content.chars().count() >= length && content.chars().all(|c| c == mark)
}

fn is_break(content: &str) -> bool {
    let marks: Vec<char> = content.chars().filter(|&c| !c.is_whitespace()).collect();
    let Some(&first) = marks.first() else {
        return false;
    };
    let same = marks.iter().all(|&c| c == first);
    same && (first == '='
        && content
            .trim_end_matches(char::is_whitespace)
            .chars()
            .all(|c| c == '=')
        || matches!(first, '-' | '*' | '_') && marks.len() >= 3)
}

fn is_reference(content: &str) -> bool {
    let Some(rest) = content.strip_prefix('[') else {
        return false;
    };
    let Some(close) = rest.find("]:") else {
        return false;
    };
    close > 0
        && !rest[..close].contains(']')
        && rest[close + 2..].chars().any(|c| !c.is_whitespace())
}

fn marker<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(prefix)?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then_some(rest)
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

/// The marker `[!type]` of a callout, with the `+` or `-` that folds it, at the start of `line`.
fn callout_marker(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("[!")?;
    let close = rest.find(']')?;
    let kind = &rest[..close];
    if kind.is_empty()
        || !kind
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
    {
        return None;
    }
    let rest = &rest[close + 1..];
    let rest = rest.strip_prefix(['+', '-']).unwrap_or(rest);
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then_some(rest)
}

fn strip_blocks(mut line: &str) -> &str {
    let mut quoted = false;
    loop {
        line = line.trim_start_matches(char::is_whitespace);
        if let Some(rest) = line.strip_prefix('>') {
            line = rest;
            quoted = true;
            continue;
        }
        if quoted && let Some(rest) = callout_marker(line) {
            line = rest;
            quoted = false;
            continue;
        }
        let hashes = run_of(line, '#');
        if (1..=6).contains(&hashes)
            && let Some(rest) = marker(line, &line[..hashes])
        {
            let rest = rest.trim_end_matches(char::is_whitespace);
            let kept = rest.trim_end_matches('#');
            return if kept.is_empty() || kept.ends_with(char::is_whitespace) {
                kept
            } else {
                rest
            };
        }
        if let Some(rest) = list_marker(line) {
            let rest = rest.trim_start_matches(char::is_whitespace);
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
            c if c.is_whitespace() => return None,
            _ => at += 1,
        }
    }
    None
}

fn run_at(chars: &[char], at: usize, mark: char) -> usize {
    chars[at..].iter().take_while(|&&c| c == mark).count()
}

fn closing_run(chars: &[char], from: usize, length: usize) -> Option<usize> {
    let mut at = from;
    while at < chars.len() {
        if chars[at] != '`' {
            at += 1;
            continue;
        }
        let run = run_at(chars, at, '`');
        if run == length {
            return Some(at);
        }
        at += run;
    }
    None
}

fn word(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric())
}

fn inline(text: &str, out: &mut Plain, notes: &Notes) {
    let chars: Vec<char> = text.chars().collect();
    inline_chars(&chars, out, notes);
}

/// The character reference at the start of `chars`, such as `&amp;`, `&#169;` or `&#xA9;`, with the characters it takes, none where the text is no reference. The Markdown parser the core already links decides, so an unknown name or an out-of-range number stays as written.
fn reference(chars: &[char]) -> Option<(String, usize)> {
    let name = chars[1..]
        .iter()
        .take(32)
        .take_while(|c| c.is_ascii_alphanumeric() || **c == '#')
        .count();
    if name == 0 || chars.get(name + 1) != Some(&';') {
        return None;
    }
    let source: String = chars[..name + 2].iter().collect();
    let decoded: String = pulldown_cmark::Parser::new(&source)
        .filter_map(|event| match event {
            pulldown_cmark::Event::Text(text) => Some(text.into_string()),
            _ => None,
        })
        .collect();
    (decoded != source).then_some((decoded, name + 2))
}

/// The index of the `==` that closes a highlight whose text starts at `from`, skipping escapes and code spans.
fn highlight_close(chars: &[char], from: usize) -> Option<usize> {
    let mut at = from;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            '`' => {
                let length = run_at(chars, at, '`');
                at = closing_run(chars, at + length, length)
                    .map_or(at + length, |close| close + length);
            }
            '=' => {
                let length = run_at(chars, at, '=');
                if length == 2 && !chars[at - 1].is_whitespace() {
                    return Some(at);
                }
                at += length;
            }
            _ => at += 1,
        }
    }
    None
}

fn inline_chars(chars: &[char], out: &mut Plain, notes: &Notes) {
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
                let length = run_at(chars, at, '`');
                match closing_run(chars, at + length, length) {
                    Some(close) => {
                        chars[at + length..close].iter().for_each(|&c| out.push(c));
                        at = close + length;
                    }
                    None => {
                        (0..length).for_each(|_| out.push('`'));
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
            '[' if next == Some(&'^') => {
                let close = find(chars, at + 2, &[']']);
                let label: Option<String> =
                    close.map(|close| chars[at + 2..close].iter().collect());
                match close.zip(label) {
                    Some((close, label)) if footnote_label(&label) && notes.defines(&label) => {
                        at = close + 1;
                    }
                    _ => {
                        out.push('[');
                        at += 1;
                    }
                }
            }
            '[' => match link_end(chars, at) {
                Some((start, close, after)) => {
                    inline_chars(&chars[start..close], out, notes);
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
            '&' => match reference(&chars[at..]) {
                Some((decoded, length)) => {
                    out.push_str(&decoded);
                    at += length;
                }
                None => {
                    out.push('&');
                    at += 1;
                }
            },
            '=' => {
                let length = run_at(chars, at, '=');
                let opens = length == 2 && chars.get(at + 2).is_some_and(|c| !c.is_whitespace());
                match opens.then(|| highlight_close(chars, at + 2)).flatten() {
                    Some(close) => {
                        inline_chars(&chars[at + 2..close], out, notes);
                        at = close + 2;
                    }
                    None => {
                        (0..length).for_each(|_| out.push('='));
                        at += length;
                    }
                }
            }
            '*' | '_' | '~' => {
                let length = run_at(chars, at, c);
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
    use crate::wire::WireType;

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
        let mut listed = crate::builtin::catalog().unwrap();
        for registered in types {
            let mut row = registered.clone();
            row["version"] = Value::from(0);
            listed
                .types
                .push(serde_json::from_value::<WireType>(row).unwrap());
        }
        Catalog::from_wire(&listed.types, None)
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
        let shown = display(properties.as_object().unwrap(), None, None, true);
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
    fn stops_reading_a_long_body_once_the_preview_is_full() {
        let body = format!("{}\n{}", "a ".repeat(200), "b".repeat(1_000_000));
        let properties = serde_json::json!({ "title": "T", "body": body });
        let shown = display(properties.as_object().unwrap(), None, None, true);
        let preview = shown.preview.unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_POINTS);
        assert!(preview.ends_with('…'));
        assert!(preview.starts_with("a a a"));
    }

    #[test]
    fn stops_reading_a_long_body_after_front_matter_and_a_table() {
        let body = format!(
            "---\ntitle: x\n---\n| a | b |\n|---|---|\n{}",
            "| 1 | 2 |\n".repeat(100_000)
        );
        let properties = serde_json::json!({ "title": "T", "body": body });
        let preview = display(properties.as_object().unwrap(), None, None, true)
            .preview
            .unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_POINTS);
        assert!(preview.starts_with("a b 1 2 1 2"));
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn reads_untidy_markup_within_the_limit_and_without_panicking() {
        #[rustfmt::skip]
        let pieces = [
            "|", "\\", "`", "=", "==", "&", "#", ";", "[", "]", "^", ">", "-", "---", ":", "\n", "\r\n",
            "!", "*", "_", "~", "x", "1", " ", "    ", "\t", "[^1]", "[^1]:", "[!n]", "| a |", "|-|",
            "&#x20;", "&amp;", "\u{2028}", "é", "\u{1F600}", "\u{feff}",
        ];
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut draw = |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        for _ in 0..30_000 {
            let body: String = (0..draw(40)).map(|_| pieces[draw(pieces.len())]).collect();
            let properties = serde_json::json!({ "body": body });
            let shown = display(properties.as_object().unwrap(), None, None, draw(2) == 0);
            if let Some(preview) = shown.preview {
                assert!(preview.chars().count() <= PREVIEW_POINTS, "{body:?}");
                assert!(!preview.is_empty(), "{body:?}");
            }
        }
    }
}
