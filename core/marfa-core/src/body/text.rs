//! A body's links and embeds, read as Obsidian shows them.

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
            name: raw
                .split(['|', '#'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string(),
        }
    }
}

/// An embed, `![[target]]`, is not a link.
pub(crate) fn links(body: &str) -> Vec<String> {
    let body = without_code(body);
    let mut found = Vec::new();
    let bytes = body.as_bytes();
    let mut at = 0usize;
    while let Some(start) = body[at..].find("[[") {
        let open = at + start + 2;
        let Some(end) = body[open..].find("]]") else {
            break;
        };
        let embedded = at + start > 0 && bytes[at + start - 1] == b'!';
        let target = body[open..open + end].trim();
        // A heading without a note stays within this document, so it is no edge.
        if !embedded
            && !target.is_empty()
            && !target.starts_with('#')
            && !target.contains('\n')
            && !found.iter().any(|held| held == target)
        {
            found.push(target.to_string());
        }
        at = open + end + 2;
        if at >= bytes.len() {
            break;
        }
    }
    found
}

pub(crate) fn render_link(target: &str) -> String {
    format!("[[{target}]]")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Embed {
    /// `![[name]]`, the name before any `|` or `#`.
    Named { raw: String, name: String },
    /// `![alt](path)`, the path decoded and without its query or fragment.
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
    let mut found: Vec<Embed> = Vec::new();
    let mut at = 0usize;
    while let Some(start) = text[at..].find("![") {
        let open = at + start;
        let rest = &text[open + 2..];
        let (embed, used) = match rest.strip_prefix('[') {
            Some(inner) => match inner.find("]]") {
                Some(end) if !inner[..end].contains('\n') => {
                    let name = inner[..end]
                        .split(['|', '#'])
                        .next()
                        .unwrap_or_default()
                        .trim();
                    let used = 3 + end + 2;
                    let embed = (!name.is_empty()).then(|| Embed::Named {
                        raw: body[open..open + used].to_string(),
                        name: name.to_string(),
                    });
                    (embed, used)
                }
                _ => (None, 3),
            },
            None => match image(rest) {
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
            },
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

fn local(destination: &str) -> String {
    let path = destination.split(['?', '#']).next().unwrap_or_default();
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(byte) = path
                .get(at + 1..at + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            at += 3;
        } else {
            decoded.push(bytes[at]);
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
}
