//! A body's links and embeds, read as Obsidian shows them.

use std::ops::Range;

use serde::Serialize;

/// What was typed inside `[[ ]]`, in a body's link or a frontmatter line,
/// and the name it is read as, which is what comes before a `|` or a `#`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Typed {
    pub(crate) raw: String,
    pub(crate) name: String,
}

impl Typed {
    pub(crate) fn new(raw: &str) -> Typed {
        let raw = raw.trim();
        Typed {
            raw: raw.to_string(),
            name: raw[split(raw).name].to_string(),
        }
    }
}

/// Byte ranges into the text between a link's brackets: the name up to the
/// first `|` or `#`; where `#` comes first, a heading up to the next `|`; and
/// an alias after the first `|`. Each is trimmed, and an empty heading or
/// alias is none.
struct Split {
    name: Range<usize>,
    heading: Option<Range<usize>>,
    alias: Option<Range<usize>>,
}

fn split(inner: &str) -> Split {
    let present =
        |range: Range<usize>| Some(trimmed(inner, range)).filter(|range| !range.is_empty());
    let Some(at) = inner.find(['|', '#']) else {
        return Split {
            name: trimmed(inner, 0..inner.len()),
            heading: None,
            alias: None,
        };
    };
    let name = trimmed(inner, 0..at);
    if inner.as_bytes()[at] == b'|' {
        return Split {
            name,
            heading: None,
            alias: present(at + 1..inner.len()),
        };
    }
    match inner[at + 1..].find('|') {
        Some(bar) => Split {
            name,
            heading: present(at + 1..at + 1 + bar),
            alias: present(at + 2 + bar..inner.len()),
        },
        None => Split {
            name,
            heading: present(at + 1..inner.len()),
            alias: None,
        },
    }
}

/// `range` of `text` without the white space `str::trim` takes off; an
/// empty range where nothing is left, at its start.
fn trimmed(text: &str, range: Range<usize>) -> Range<usize> {
    let part = &text[range.clone()];
    let start = range.start + (part.len() - part.trim_start().len());
    let end = range.end - (part.len() - part.trim_end().len());
    if start >= end {
        range.start..range.start
    } else {
        start..end
    }
}

/// A `[[`…`]]` in a body outside code and comments: its byte range, the
/// `!` of an embed included, and the range between its brackets.
struct Bracketed {
    whole: Range<usize>,
    inner: Range<usize>,
    embed: bool,
}

/// Each `[[`…`]]` and `![[`…`]]` in `body` outside code and comments, in one
/// pass. One holds no line break and no `[[`: the last `[[` before a `]]` on
/// its line opens it, so a bracket left open never takes in the link after
/// it. The brackets are found with code and comments blanked, so a `]]` in a
/// code span closes nothing; the caller reads what they hold from `body`.
fn bracketed(body: &str) -> Vec<Bracketed> {
    let text = without_code(body);
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut open: Option<usize> = None;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'[' if bytes.get(at + 1) == Some(&b'[') => {
                open = Some(at);
                at += 2;
            }
            b']' if bytes.get(at + 1) == Some(&b']') && open.is_some() => {
                let start = open.take().expect("checked above");
                let embed = start > 0 && bytes[start - 1] == b'!';
                found.push(Bracketed {
                    whole: if embed { start - 1 } else { start }..at + 2,
                    inner: start + 2..at,
                    embed,
                });
                at += 2;
            }
            b'\n' => {
                open = None;
                at += 1;
            }
            _ => at += 1,
        }
    }
    found
}

/// The links of `body`: each `[[`…`]]` that is not an embed.
fn link_ranges(body: &str) -> impl Iterator<Item = (Range<usize>, Range<usize>)> {
    bracketed(body)
        .into_iter()
        .filter(|found| !found.embed)
        .map(|found| (found.whole, found.inner))
}

/// The text of each link in a body that names another item, without its
/// brackets, in order and once each. A link naming only a heading stays
/// within this document, so it is no edge.
pub(crate) fn links(body: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for (_, inner) in link_ranges(body) {
        let target = body[inner].trim();
        if !target.is_empty()
            && !target.starts_with('#')
            && !found.iter().any(|held| held == target)
        {
            found.push(target.to_string());
        }
    }
    found
}

/// A link in a text, as `link_parts` reads it. Every position is a range of
/// UTF-16 code units in the text, as an editor counts them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkParts {
    /// As it appears in the text, brackets included.
    pub text: String,
    pub start: u64,
    pub end: u64,
    /// The text between the brackets, trimmed, which is what a link is bound
    /// by and what `link_candidates` takes.
    pub target: String,
    /// What the link names. Empty for a link to a heading of the same text.
    pub name: LinkPart,
    pub heading: Option<LinkPart>,
    pub alias: Option<LinkPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkPart {
    pub text: String,
    pub start: u64,
    pub end: u64,
}

/// Every link in `text` in order, repeats included: each that the edges of a
/// body are read from, and each naming only a heading.
pub fn link_parts(text: &str) -> Vec<LinkParts> {
    let mut units = Utf16::new(text);
    let mut found = Vec::new();
    for (whole, inner) in link_ranges(text) {
        let content = &text[inner.clone()];
        let target = trimmed(content, 0..content.len());
        if target.is_empty() {
            continue;
        }
        let parts = split(content);
        let base = inner.start;
        let start = units.at(whole.start);
        let mut part = |range: Range<usize>| LinkPart {
            text: text[base + range.start..base + range.end].to_string(),
            start: units.at(base + range.start),
            end: units.at(base + range.end),
        };
        let name = part(parts.name);
        let heading = parts.heading.map(&mut part);
        let alias = parts.alias.map(&mut part);
        found.push(LinkParts {
            text: text[whole.clone()].to_string(),
            start,
            end: units.at(whole.end),
            target: content[target].to_string(),
            name,
            heading,
            alias,
        });
    }
    found
}

/// Byte offsets as UTF-16 offsets, asked in increasing order, in one pass
/// over the text.
struct Utf16<'a> {
    text: &'a str,
    byte: usize,
    unit: u64,
}

impl<'a> Utf16<'a> {
    fn new(text: &'a str) -> Utf16<'a> {
        Utf16 {
            text,
            byte: 0,
            unit: 0,
        }
    }

    fn at(&mut self, byte: usize) -> u64 {
        debug_assert!(byte >= self.byte, "offsets are asked in order");
        self.unit += self.text[self.byte..byte].encode_utf16().count() as u64;
        self.byte = byte;
        self.unit
    }
}

pub(crate) fn render_link(target: &str) -> String {
    format!("[[{target}]]")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Embed {
    /// `![[name]]`, the name before any `|` or `#`, with `\|` read as `|` in
    /// a table cell.
    Named { raw: String, name: String },
    /// `![alt](path)`, the path as `local` reads it.
    Path { raw: String, path: String },
    /// `![alt](a b.png)`: a raw space, which ends a Markdown path, so what
    /// the parentheses hold is kept whole to say so.
    Spaced { raw: String, path: String },
}

impl Embed {
    pub(crate) fn raw(&self) -> &str {
        match self {
            Embed::Named { raw, .. } | Embed::Path { raw, .. } | Embed::Spaced { raw, .. } => raw,
        }
    }
}

pub(crate) fn embeds(body: &str) -> Vec<Embed> {
    let text = without_code(body);
    let mut named = bracketed(body)
        .into_iter()
        .filter(|found| found.embed)
        .peekable();
    let mut found: Vec<Embed> = Vec::new();
    let mut table_cells: Option<Vec<Range<usize>>> = None;
    let mut at = 0usize;
    while let Some(start) = text[at..].find("![") {
        let open = at + start;
        let rest = &text[open + 2..];
        while named
            .next_if(|bracket| bracket.whole.start < open)
            .is_some()
        {}
        let (embed, used) = if rest.starts_with('[') {
            match named.next_if(|bracket| bracket.whole.start == open) {
                Some(bracket) => {
                    let inner = &body[bracket.inner.clone()];
                    let in_cell = inner.contains("\\|")
                        && table_cells
                            .get_or_insert_with(|| table_cells_of(body))
                            .iter()
                            .any(|cell| cell.contains(&bracket.whole.start));
                    let name = if in_cell {
                        Typed::new(&inner.replace("\\|", "|")).name
                    } else {
                        Typed::new(inner).name
                    };
                    let embed = (!name.is_empty()).then(|| Embed::Named {
                        raw: body[bracket.whole.clone()].to_string(),
                        name,
                    });
                    (embed, bracket.whole.len())
                }
                None => (None, 3),
            }
        } else {
            match image(rest) {
                Some(Image::Path(path, length)) => {
                    let used = 2 + length;
                    let path = (!is_address(&path)).then(|| local(&path));
                    let embed = path
                        .filter(|path| !path.is_empty())
                        .map(|path| Embed::Path {
                            raw: body[open..open + used].to_string(),
                            path,
                        });
                    (embed, used)
                }
                Some(Image::Spaced(path, length)) => {
                    let used = 2 + length;
                    let embed = (!is_address(&path)).then(|| Embed::Spaced {
                        raw: body[open..open + used].to_string(),
                        path: local(&path),
                    });
                    (embed, used)
                }
                None => (None, 2),
            }
        };
        if let Some(embed) = embed
            && !found.contains(&embed)
        {
            found.push(embed);
        }
        at = open + used;
    }
    found
}

/// The byte ranges of the table cells in `text`, in a quote or a callout too.
/// Read from the raw body: a blanked code span would change what a header
/// row says and so whether a table is one. `![[` is never found in code, so
/// a table in a fenced block adds no embed.
fn table_cells_of(text: &str) -> Vec<Range<usize>> {
    pulldown_cmark::Parser::new_ext(text, pulldown_cmark::Options::ENABLE_TABLES)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(
                event,
                pulldown_cmark::Event::Start(pulldown_cmark::Tag::TableCell)
            )
            .then_some(range)
        })
        .collect()
}

/// A body with its code and comments blanked, byte for byte, since Obsidian
/// shows an embed in either as text: fenced blocks, inline spans, `%%` and `<!-- -->`.
fn without_code(body: &str) -> String {
    let blank = |out: &mut [u8]| {
        out.iter_mut()
            .filter(|byte| !matches!(**byte, b'\n' | b'\r'))
            .for_each(|byte| *byte = b' ');
    };
    let code_ranges = |text: &str| {
        pulldown_cmark::Parser::new(text)
            .into_offset_iter()
            .filter_map(|(event, range)| {
                matches!(
                    event,
                    pulldown_cmark::Event::Code(_)
                        | pulldown_cmark::Event::Start(pulldown_cmark::Tag::CodeBlock(_))
                )
                .then_some(range)
            })
            .collect::<Vec<_>>()
    };
    let bytes = body.as_bytes();
    let mut out = bytes.to_vec();
    let mut comments = vec![false; bytes.len()];
    let mut codes = code_ranges(body).into_iter().peekable();
    let mut at = 0;
    // Obsidian comments are not Markdown syntax. A comment marker inside
    // code is literal, but code opened inside a comment cannot extend past it.
    while at < bytes.len() {
        while codes.peek().is_some_and(|range| range.end <= at) {
            codes.next();
        }
        if codes.peek().is_some_and(|range| range.start <= at) {
            at = codes.next().expect("checked above").end;
            continue;
        }
        let comment = if bytes[at..].starts_with(b"%%") {
            Some((2, &b"%%"[..]))
        } else if bytes[at..].starts_with(b"<!--") {
            Some((4, &b"-->"[..]))
        } else {
            None
        };
        let Some((opened, close)) = comment else {
            at += 1;
            continue;
        };
        let end = bytes[at + opened..]
            .windows(close.len())
            .position(|window| window == close)
            .map_or(bytes.len(), |offset| at + opened + offset + close.len());
        blank(&mut out[at..end]);
        comments[at..end].fill(true);
        while codes.peek().is_some_and(|range| range.start < end) {
            codes.next();
        }
        at = end;
    }
    // Parse again without comments: a fence or span inside one must not hide
    // visible text after it. A comment before visible text must not turn its
    // replacement spaces into an indented code block.
    let mut parsing = out.clone();
    let mut start = 0;
    for line in out.split_inclusive(|byte| *byte == b'\n') {
        if let Some(visible) = line.iter().position(|byte| !byte.is_ascii_whitespace())
            && let Some(comment) = comments[start..start + visible]
                .iter()
                .position(|held| *held)
        {
            parsing[start + comment] = b'x';
        }
        start += line.len();
    }
    let uncommented = String::from_utf8(parsing).expect("only whole characters were blanked");
    for range in code_ranges(&uncommented) {
        blank(&mut out[range]);
    }
    String::from_utf8(out).expect("only whole characters were blanked")
}

enum Image {
    /// A destination, and how much of the text after `![` the image takes.
    Path(String, usize),
    /// Text a raw space runs through, which is no destination.
    Spaced(String, usize),
}

/// `rest` is the text after the image's `![`.
fn image(rest: &str) -> Option<Image> {
    let close = rest.find(']')?;
    if rest[..close].contains('\n') || !rest[close + 1..].starts_with('(') {
        return None;
    }
    let from = close + 2;
    let tail = &rest[from..];
    let skipped = tail.len() - tail.trim_start_matches([' ', '\t']).len();
    let tail = &tail[skipped..];
    let (destination, after) = match tail.strip_prefix('<') {
        Some(inner) => {
            let end = inner.find('>')?;
            (&inner[..end], 1 + end + 1)
        }
        None => {
            let end = tail
                .find(|glyph: char| glyph.is_whitespace() || glyph == ')')
                .unwrap_or(tail.len());
            (&tail[..end], end)
        }
    };
    let paren = tail[after..].find(')')?;
    let between = &tail[after..after + paren];
    if between.contains('\n') {
        return None;
    }
    let length = from + skipped + after + paren + 1;
    // A title is quoted; anything else after a space is the path going on.
    let title = between.trim();
    if title.is_empty()
        || title.len() >= 2
            && (title.starts_with('"') && title.ends_with('"')
                || title.starts_with('\'') && title.ends_with('\''))
    {
        Some(Image::Path(destination.to_string(), length))
    } else {
        Some(Image::Spaced(
            tail[..after + paren].trim().to_string(),
            length,
        ))
    }
}

fn is_address(destination: &str) -> bool {
    if destination.starts_with("//") || destination.starts_with('#') {
        return true;
    }
    let scheme = destination.split(':').next().unwrap_or_default();
    destination.contains(':')
        && scheme.starts_with(|glyph: char| glyph.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|glyph| glyph.is_ascii_alphanumeric() || matches!(glyph, '+' | '.' | '-'))
}

/// The file a destination names, read in CommonMark's order: a backslash
/// before ASCII punctuation is that character, then the first `?` or `#`
/// ends the path (an escaped one is literal in the destination, which is
/// still a URL), then each percent escape is its byte. `%5C` and `%23` so
/// stay a backslash and a `#` in the name.
fn local(destination: &str) -> String {
    let bytes = destination.as_bytes();
    let mut unescaped = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' && bytes.get(at + 1).is_some_and(u8::is_ascii_punctuation) {
            unescaped.push(bytes[at + 1]);
            at += 2;
        } else {
            unescaped.push(bytes[at]);
            at += 1;
        }
    }
    let end = unescaped
        .iter()
        .position(|byte| matches!(byte, b'?' | b'#'))
        .unwrap_or(unescaped.len());
    let path = &unescaped[..end];
    let mut decoded = Vec::with_capacity(path.len());
    let mut at = 0;
    while at < path.len() {
        let byte = (path[at] == b'%')
            .then(|| path.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = byte {
            decoded.push(byte);
            at += 3;
        } else {
            decoded.push(path[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_read_in_order_and_once_each() {
        assert_eq!(
            links("see [[one]] and [[two|as shown]] and [[one]] again"),
            vec!["one", "two|as shown"],
            "a link was missed, repeated or lost its alias, so the edges \
             this body becomes are not the links it carries"
        );
        assert!(links("a [[ ]] and an [[unclosed").is_empty());
        assert_eq!(
            links("![[picture.png]] beside [[note]]"),
            vec!["note"],
            "an embed was read as a link, so a picture shown in a note became a reference"
        );
        assert_eq!(render_link("abc"), "[[abc]]");
    }

    #[test]
    fn an_unclosed_or_reopened_link_does_not_swallow_the_next() {
        assert_eq!(links("[[open\n[[next]]"), ["next"]);
        assert_eq!(links("[[outer [[inner]] after"), ["inner"]);
        assert_eq!(links("[[unclosed and [[a]] then [[b]]"), ["a", "b"]);
        assert_eq!(
            links("[[[b]] [[[[c]]"),
            ["[b", "c"],
            "pairs of `[` are read from the start of the line, a lone `[` after a pair \
             being part of the name"
        );
    }

    #[test]
    fn an_embed_is_bounded_as_a_link_is_so_a_span_is_read_once() {
        assert_eq!(links("![[a [[b]]"), ["b"]);
        assert!(
            embeds("![[a [[b]]").is_empty(),
            "an embed took in a link, so one span was read as both"
        );
        assert_eq!(
            embeds("![[open\n![[x.png]] [[a]] ![[a ![[y.png|20]]"),
            vec![
                Embed::Named {
                    raw: "![[x.png]]".into(),
                    name: "x.png".into()
                },
                Embed::Named {
                    raw: "![[y.png|20]]".into(),
                    name: "y.png".into()
                },
            ]
        );
    }

    #[test]
    fn code_inside_a_link_neither_closes_it_nor_leaves_its_name() {
        assert_eq!(
            links("[[a `b` c]]"),
            ["a `b` c"],
            "a code span inside a link was blanked out of its name"
        );
        assert_eq!(
            links("[[a `]]` c]]"),
            ["a `]]` c"],
            "a `]]` inside a code span closed a link"
        );
        let parts = link_parts("x [[a `]]` c|al]]");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].name.text, "a `]]` c");
        assert_eq!(parts[0].alias.as_ref().unwrap().text, "al");
        assert_eq!(
            embeds("![[a `]]` b.png]]"),
            vec![Embed::Named {
                raw: "![[a `]]` b.png]]".into(),
                name: "a `]]` b.png".into()
            }]
        );
    }

    fn shown(parts: &LinkParts) -> (String, Option<String>, Option<String>) {
        (
            parts.name.text.clone(),
            parts.heading.as_ref().map(|part| part.text.clone()),
            parts.alias.as_ref().map(|part| part.text.clone()),
        )
    }

    #[test]
    fn link_parts_split_a_link_as_its_edge_is_read() {
        let text = "[[ Plan # Goals | the plan ]] [[Plan|C#]] [[#local]] [[a#]] [[|bare]] [[Plan]]";
        let parts = link_parts(text);
        let some = |text: &str| Some(text.to_string());
        assert_eq!(
            parts.iter().map(shown).collect::<Vec<_>>(),
            vec![
                ("Plan".into(), some("Goals"), some("the plan")),
                ("Plan".into(), None, some("C#")),
                (String::new(), some("local"), None),
                ("a".into(), None, None),
                (String::new(), None, some("bare")),
                ("Plan".into(), None, None),
            ]
        );
        for part in &parts {
            assert_eq!(part.name.text, Typed::new(&part.target).name);
        }
        assert_eq!(parts[0].target, "Plan # Goals | the plan");
        assert_eq!(
            links(text),
            ["Plan # Goals | the plan", "Plan|C#", "a#", "|bare", "Plan"],
            "the links a body's edges are read from are not the links read for their parts"
        );
    }

    #[test]
    fn link_parts_place_each_part_in_utf16_units() {
        let text = "é😀 [[Café 😀#Über|naïve]] then [[x]]";
        let parts = link_parts(text);
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let at = |start: u64, end: u64| {
            String::from_utf16(&utf16[start as usize..end as usize]).unwrap()
        };
        let first = &parts[0];
        assert_eq!(at(first.start, first.end), "[[Café 😀#Über|naïve]]");
        assert_eq!(
            first.start, 4,
            "an offset was counted in bytes or characters, not UTF-16 units"
        );
        assert_eq!(at(first.name.start, first.name.end), "Café 😀");
        let heading = first.heading.as_ref().unwrap();
        assert_eq!(at(heading.start, heading.end), "Über");
        let alias = first.alias.as_ref().unwrap();
        assert_eq!(at(alias.start, alias.end), "naïve");
        assert_eq!(at(parts[1].start, parts[1].end), "[[x]]");
        assert_eq!(at(parts[1].name.start, parts[1].name.end), "x");
    }

    #[test]
    fn link_parts_leave_out_code_comments_embeds_and_what_never_closes() {
        let text = "`[[inline]]` <!-- [[html]] --> %% [[comment]] %% ![[embed.png]] [[ ]] [[a\nb]] \\[[escaped]] [[x\\]] [[open\n```\n[[fenced]]\n```\n[[seen]] [[seen]]";
        let parts = link_parts(text);
        assert_eq!(
            parts
                .iter()
                .map(|part| part.text.as_str())
                .collect::<Vec<_>>(),
            ["[[escaped]]", "[[x\\]]", "[[seen]]", "[[seen]]"],
            "a link in code, a comment or an embed was read, a backslash was read as an escape, \
             or a repeat was dropped where an editor needs every place a link is"
        );
    }

    #[test]
    fn link_parts_read_a_long_text_in_one_pass() {
        let opened = "[[".repeat(200_000);
        let started = std::time::Instant::now();
        assert_eq!(link_parts(&format!("{opened}tail]]")).len(), 1);
        let many = "[[a]] ".repeat(100_000);
        assert_eq!(link_parts(&many).len(), 100_000);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "reading took {:?}, so a long text is not read in one pass",
            started.elapsed()
        );
    }

    #[test]
    fn body_links_keep_names_and_ignore_code_comments_and_self_headings() {
        assert_eq!(
            links(
                "[[Note#Heading|shown]] [[#local]] `[[inline]]` <!-- [[html]] --> %% [[comment]] %% ![[embed]]\n```md\n[[fenced]]\n```\n~~~\n[[tilde]]\n~~~\n[[real]]"
            ),
            ["Note#Heading|shown", "real"]
        );
    }

    #[test]
    fn code_masking_preserves_visible_links_and_ignores_markdown_code() {
        for body in [
            "```literal```\n[[Visible]] `[[Hidden]]`\n",
            "`first\n[[Hidden]]\nlast`\n[[Visible]]\n",
            "> ```\n> [[Hidden]]\n> ```\n\n[[Visible]]\n",
            "- item\n\n  ```\n  [[Hidden]]\n  ```\n\n[[Visible]]\n",
            "    [[Hidden]]\n\n[[Visible]]\n",
            "- outer\n\n    [[Visible]]\n",
        ] {
            assert_eq!(links(body), ["Visible"], "{body}");
            let embedded = body.replace("[[", "![[");
            assert_eq!(embeds(&embedded).len(), 1, "{embedded}");
        }
    }

    #[test]
    fn comment_markers_in_code_and_code_markers_in_comments_stay_literal() {
        for body in [
            "`%%` [[Visible]]",
            "`<!--` [[Visible]]",
            "%%\n```\n[[Hidden]]\n%%\n[[Visible]]",
            "<!--\n```\n[[Hidden]]\n-->\n[[Visible]]",
            "%% ` %% [[Visible]] `",
            "%% [[Hidden]] %% [[Visible]] <!-- [[Hidden]] -->",
            "[[Visible]] %% [[Hidden]]",
        ] {
            assert_eq!(links(body), ["Visible"], "{body}");
        }
    }

    #[test]
    fn embeds_are_read_in_order_and_once_each() {
        let named = |raw: &str, name: &str| Embed::Named {
            raw: raw.into(),
            name: name.into(),
        };
        let path = |raw: &str, path: &str| Embed::Path {
            raw: raw.into(),
            path: path.into(),
        };
        assert_eq!(
            embeds(
                "![[a.png|300]] and ![shown](img/b%20c.png \"title\") and \
                 ![](<d e.png>) and ![[a.png|300]] and [[link]] and \
                 ![](https://example.com/x.png) and ![](doc.pdf#page=2) and ![[#part]]"
            ),
            vec![
                named("![[a.png|300]]", "a.png"),
                path("![shown](img/b%20c.png \"title\")", "img/b c.png"),
                path("![](<d e.png>)", "d e.png"),
                path("![](doc.pdf#page=2)", "doc.pdf"),
            ],
            "an embed was missed, repeated or read past its size, title or fragment, \
             or an address was read as a file in the folder"
        );
        assert!(
            embeds("![alt\ntext](x.png) and ![unclosed](x.png").is_empty(),
            "an image split across lines, or never closed, was read as an embed"
        );
        assert_eq!(
            embeds(
                "```md\n![](a.png)\n```\n`![](b.png)` and ``![[c.png]]`` ~~~\n![](d.png) ![[é.png]]"
            ),
            vec![path("![](d.png)", "d.png"), named("![[é.png]]", "é.png"),],
            "an embed shown in code was read as one, or one after the code was missed"
        );
        assert_eq!(
            embeds(
                "````\n```\n![](in.png)\n````\n%% ![](a.png)\n![](b.png) %% <!-- ![[c.png]]\n--> ![](seen.png)"
            ),
            vec![path("![](seen.png)", "seen.png")],
            "an embed in a comment, or in a fence a shorter run did not close, was read"
        );
        assert_eq!(
            embeds("![](raw x.png) and ![](y.png 'title')"),
            vec![
                Embed::Spaced {
                    raw: "![](raw x.png)".into(),
                    path: "raw x.png".into()
                },
                path("![](y.png 'title')", "y.png"),
            ],
            "a raw space was read as ending the path, or a title as part of it"
        );
    }

    fn named(raw: &str, name: &str) -> Embed {
        Embed::Named {
            raw: raw.into(),
            name: name.into(),
        }
    }

    #[test]
    fn a_sized_embed_in_a_table_cell_reads_its_escaped_pipe_as_the_bar() {
        let table = "| h | h |\n| - | - |\n| a | ![[t.png\\|200]] |";
        assert_eq!(
            embeds(table),
            vec![named("![[t.png\\|200]]", "t.png")],
            "the escaped pipe cut the name at the backslash"
        );
        let callout = "> [!note]\n> | h | h |\n> | - | - |\n> | a | ![[t.png\\|200]] |";
        assert_eq!(embeds(callout), vec![named("![[t.png\\|200]]", "t.png")]);
        // Witnesses: the same text outside a table keeps the backslash.
        assert_eq!(
            embeds("| a | ![[t.png\\|200]] |"),
            vec![named("![[t.png\\|200]]", "t.png\\")],
            "a line that is no table cell read the backslash as an escape"
        );
        assert_eq!(
            embeds("![[t.png\\|200]]"),
            vec![named("![[t.png\\|200]]", "t.png\\")]
        );
        // A code span in the header row does not stop the table being one.
        let coded = "| `a|b` | h |\n| - | - | - |\n| a | ![[t.png\\|200]] | c |";
        assert_eq!(embeds(coded), vec![named("![[t.png\\|200]]", "t.png")]);
    }

    #[test]
    fn an_embed_path_reads_markdown_escapes_and_percent_escapes_once() {
        let path = |text: &str| match embeds(text).remove(0) {
            Embed::Path { path, .. } | Embed::Spaced { path, .. } => path,
            other => panic!("{other:?}"),
        };
        assert_eq!(path("![](my\\_pic.png)"), "my_pic.png");
        assert_eq!(path("![](my\\_pic%20one.png)"), "my_pic one.png");
        assert_eq!(path("![](<my\\_pic.png>)"), "my_pic.png");
        assert_eq!(path("![](<my\\_pic one.png>)"), "my_pic one.png");
        assert_eq!(path("![](my\\_pic one.png)"), "my_pic one.png");
        assert_eq!(path("![](a\\b.png)"), "a\\b.png");
        assert_eq!(path("![](my%5C_pic.png)"), "my\\_pic.png");
        assert_eq!(path("![](a\\%41.png)"), "aA.png");
        // An escaped `?` or `#` is literal in the destination, which is still
        // a URL, so it ends the path; a percent escape of either stays.
        assert_eq!(path("![](a\\#b.png#frag)"), "a");
        assert_eq!(path("![](a\\?b.png?x=1)"), "a");
        assert_eq!(path("![](a%23b.png#frag)"), "a#b.png");
        assert_eq!(path("![](a%3Fb.png?x=1)"), "a?b.png");
        assert_eq!(
            embeds("![[my\\_pic.png]]"),
            vec![named("![[my\\_pic.png]]", "my\\_pic.png")],
            "a wiki embed's name was unescaped, which Obsidian does not do"
        );
    }
}
