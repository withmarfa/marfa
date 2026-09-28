//! A file's bytes as frontmatter and a body, and back: one module, because a
//! file read in and written straight back out must be the same file.

use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::error::CoreError;

/// A file, read.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    /// The frontmatter, every line of it, in the order the file wrote it.
    pub front: Map<String, Value>,
    /// What follows the frontmatter, or the whole text where there is none.
    pub body: String,
    /// The ids this file links to, in the order they appear.
    pub links: Vec<String>,
    /// Why the frontmatter cannot be read, where the file delimits some that
    /// does not parse as fields (`folders.md` 8, 10).
    pub unreadable: Option<String>,
}

/// What a file opens with, when it opens with frontmatter.
const FENCE: &str = "---";

/// What a file's opening fence pair holds.
enum Front<'a> {
    /// No fence pair, or one holding a list or a line of text: Markdown.
    Body,
    Fields(Map<String, Value>, &'a str),
    /// A fence pair holding YAML that does not parse as fields.
    Unreadable(String),
}

/// The frontmatter a file opens with, and the body after it (`folders.md`
/// 8). Only a fence pair says there is frontmatter; what it holds says
/// whether it can be read.
fn frontmatter(text: &str) -> Front<'_> {
    // The opening fence is its own line: `----` is a horizontal rule and
    // `--- x` is text, and neither opens frontmatter.
    let Some(rest) = text.strip_prefix(FENCE).and_then(|rest| {
        rest.strip_prefix('\n')
            .or_else(|| rest.strip_prefix("\r\n"))
    }) else {
        return Front::Body;
    };
    // A blank line after the fence is a thematic break: `---\n\nNote: x\n\n---`
    // is two rules around a sentence that also parses as YAML.
    if rest.starts_with('\n') || rest.starts_with("\r\n") {
        return Front::Body;
    }
    let mut offset = 0usize;
    let (front, body) = loop {
        let Some(line) = rest
            .get(offset..)
            .and_then(|tail| tail.split_inclusive('\n').next())
        else {
            return Front::Body;
        };
        if line.trim_end_matches(['\r', '\n']) == FENCE {
            break (&rest[..offset], &rest[offset + line.len()..]);
        }
        offset += line.len();
        // Opened and never closed: a horizontal rule, or a file someone is
        // still typing.
        if offset >= rest.len() {
            return Front::Body;
        }
    };
    let documents = match YamlLoader::load_from_str(front) {
        Ok(documents) => documents,
        Err(error) => return Front::Unreadable(error.to_string()),
    };
    // A merge key would arrive as a property named `<<`, not as what it merges.
    if documents.iter().any(merges) {
        return Front::Unreadable(
            "it uses a YAML merge key, `<<`, which a folder does not expand".into(),
        );
    }
    let mut fields = Map::new();
    match documents.first() {
        // An empty fence pair is frontmatter with nothing in it.
        None | Some(Yaml::Null) => {}
        Some(Yaml::Hash(hash)) => {
            for (key, value) in hash {
                let Some(key) = key.as_str() else {
                    return Front::Unreadable(format!("a key that is not text: {key:?}"));
                };
                let Some(value) = from_yaml(value) else {
                    return Front::Unreadable(format!("{key} holds a value no item can"));
                };
                fields.insert(key.to_string(), value);
            }
        }
        // A rule, a list or a setext heading, and a rule: Markdown.
        Some(_) => return Front::Body,
    }
    Front::Fields(fields, body)
}

/// Reads a file that can carry frontmatter.
pub fn read(text: &str) -> Document {
    match frontmatter(text) {
        Front::Body => read_body(text),
        Front::Fields(front, body) => Document {
            front,
            body: body.to_string(),
            links: links(body),
            unreadable: None,
        },
        Front::Unreadable(reason) => Document {
            unreadable: Some(reason),
            ..read_body(text)
        },
    }
}

/// The `marfa_id` line of frontmatter that does not parse, read as text.
pub fn id_line(text: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()? != FENCE {
        return None;
    }
    lines
        .take_while(|line| line.trim_end() != FENCE)
        .find_map(|line| line.strip_prefix("marfa_id:"))
        .map(|id| id.trim().trim_matches(['"', '\'']).to_string())
        .filter(|id| !id.is_empty())
}

/// Reads a file that carries no frontmatter: all of it is the body.
pub fn read_body(text: &str) -> Document {
    Document {
        front: Map::new(),
        body: text.to_string(),
        links: links(text),
        unreadable: None,
    }
}

/// Writes frontmatter and a body back out as a file.
pub fn write(front: &Map<String, Value>, body: &str) -> Result<String, CoreError> {
    if front.is_empty() {
        return Ok(body.to_string());
    }
    let mut rendered = String::new();
    YamlEmitter::new(&mut rendered)
        .dump(&to_yaml(&Value::Object(front.clone())))
        .map_err(|error| {
            CoreError::Invalid(format!("this item's fields will not render: {error}"))
        })?;
    // The emitter's own document start is the opening fence.
    let rendered = rendered.trim_start_matches("---\n");
    Ok(format!("{FENCE}\n{rendered}\n{FENCE}\n{body}"))
}

/// A whole YAML document that is one map, as a folder's settings file
/// holds it; the reason where it is not one.
pub fn read_map(text: &str) -> Result<Map<String, Value>, String> {
    let documents = YamlLoader::load_from_str(text).map_err(|error| error.to_string())?;
    let Some(Yaml::Hash(hash)) = documents.first() else {
        return Err("it is not one map of settings".into());
    };
    let mut map = Map::new();
    for (key, value) in hash {
        let key = key
            .as_str()
            .ok_or_else(|| format!("a key that is not text: {key:?}"))?;
        let value =
            from_yaml(value).ok_or_else(|| format!("{key} holds an alias or a bad value"))?;
        map.insert(key.to_string(), value);
    }
    Ok(map)
}

/// A map written as one YAML document, the inverse of `read_map`.
pub fn write_map(map: &Map<String, Value>) -> Result<String, CoreError> {
    let mut rendered = String::new();
    YamlEmitter::new(&mut rendered)
        .dump(&to_yaml(&Value::Object(map.clone())))
        .map_err(|error| CoreError::Invalid(format!("these settings will not render: {error}")))?;
    Ok(format!("{}\n", rendered.trim_start_matches("---\n")))
}

/// A YAML value as an item's property. `None` where it cannot be carried as
/// it is, which makes the frontmatter unreadable.
fn from_yaml(value: &Yaml) -> Option<Value> {
    Some(match value {
        Yaml::Real(text) => match text.parse::<f64>() {
            Ok(number) => serde_json::Number::from_f64(number)
                .map(Value::Number)
                // An infinity or a NaN: YAML has them and JSON does not, so
                // the text is kept rather than the value being lost.
                .unwrap_or_else(|| Value::String(text.clone())),
            Err(_) => Value::String(text.clone()),
        },
        Yaml::Integer(number) => Value::Number((*number).into()),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Boolean(yes) => Value::Bool(*yes),
        Yaml::Array(items) => {
            Value::Array(items.iter().map(from_yaml).collect::<Option<Vec<_>>>()?)
        }
        Yaml::Hash(hash) => {
            let mut map = Map::new();
            for (key, value) in hash {
                map.insert(key.as_str()?.to_string(), from_yaml(value)?);
            }
            Value::Object(map)
        }
        Yaml::Null => Value::Null,
        // The loader resolves every alias, so neither arrives from a document.
        Yaml::Alias(_) | Yaml::BadValue => return None,
    })
}

/// Whether a YAML value holds a merge key at any depth.
fn merges(value: &Yaml) -> bool {
    match value {
        Yaml::Hash(hash) => hash
            .iter()
            .any(|(key, value)| key.as_str() == Some("<<") || merges(value)),
        Yaml::Array(items) => items.iter().any(merges),
        _ => false,
    }
}

/// An item's property as a YAML value.
fn to_yaml(value: &Value) -> Yaml {
    match value {
        Value::Null => Yaml::Null,
        Value::Bool(yes) => Yaml::Boolean(*yes),
        Value::Number(number) => match number.as_i64() {
            Some(whole) => Yaml::Integer(whole),
            None => Yaml::Real(number.to_string()),
        },
        Value::String(text) => Yaml::String(text.clone()),
        Value::Array(items) => Yaml::Array(items.iter().map(to_yaml).collect()),
        Value::Object(map) => {
            let mut hash = yaml_rust2::yaml::Hash::new();
            for (key, value) in map {
                hash.insert(Yaml::String(key.clone()), to_yaml(value));
            }
            Yaml::Hash(hash)
        }
    }
}

/// The `[[target]]` links a body carries, in order and without repeats. An
/// embed, `![[target]]`, is not a link (`folders.md` 12).
pub fn links(body: &str) -> Vec<String> {
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
        // An alias — `[[id|shown]]` — links to what is before the bar.
        let target = target.split('|').next().unwrap_or(target).trim();
        if !embedded && !target.is_empty() && !found.iter().any(|held| held == target) {
            found.push(target.to_string());
        }
        at = open + end + 2;
        if at >= bytes.len() {
            break;
        }
    }
    found
}

/// One wiki link, as an edge's line names its target.
pub fn render_link(target: &str) -> String {
    format!("[[{target}]]")
}

/// A body embed that names a file in the folder rather than an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Embed {
    /// `![[name]]`, the name before any `|` or `#`.
    Named { raw: String, name: String },
    /// `![alt](path)`, the path decoded and without its query or fragment.
    Path { raw: String, path: String },
}

impl Embed {
    /// The embed as the body writes it.
    pub fn raw(&self) -> &str {
        match self {
            Embed::Named { raw, .. } | Embed::Path { raw, .. } => raw,
        }
    }
}

/// The embeds a body carries, in order and once each: `![[name]]` and
/// `![alt](path)`, an address such as `https://` aside.
pub fn embeds(body: &str) -> Vec<Embed> {
    let mut found: Vec<Embed> = Vec::new();
    let mut at = 0usize;
    while let Some(start) = body[at..].find("![") {
        let open = at + start;
        let rest = &body[open + 2..];
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
            None => {
                match image(rest) {
                    Some((path, length)) => {
                        let used = 2 + length;
                        let embed = (!is_address(&path)).then(|| Embed::Path {
                            raw: body[open..open + used].to_string(),
                            path: local(&path),
                        });
                        (embed.filter(|embed| !matches!(embed, Embed::Path { path, .. } if path.is_empty())), used)
                    }
                    None => (None, 2),
                }
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

/// A Markdown image's destination and how much of `rest`, the text after
/// its `![`, it takes.
fn image(rest: &str) -> Option<(String, usize)> {
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
    // What follows is a title, if anything, and then the closing parenthesis.
    let paren = tail[after..].find(')')?;
    if tail[after..after + paren].contains('\n') {
        return None;
    }
    Some((destination.to_string(), from + skipped + after + paren + 1))
}

/// Whether a destination is an address rather than a path: a scheme, a
/// network path, or a fragment of this file.
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

/// A path as the filesystem names it: percent escapes decoded, and any query
/// or fragment, `a.pdf#page=2` say, taken off.
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
    fn frontmatter_is_read_in_order_and_the_body_stays_the_body() {
        let document = read(
            "---\ntitle: A note\ncount: 3\ntags:\n  - alpha\n  - beta\nnested:\n  deep: true\n---\nThe body.\n",
        );
        assert_eq!(document.front["title"], "A note");
        assert_eq!(document.front["count"], 3);
        assert_eq!(document.front["tags"], serde_json::json!(["alpha", "beta"]));
        assert_eq!(
            document.front["nested"],
            serde_json::json!({ "deep": true }),
            "a nested field was flattened or dropped, and a file's fields \
             travel whole or not at all"
        );
        assert_eq!(
            document.front.keys().collect::<Vec<_>>(),
            ["title", "count", "tags", "nested"]
        );
        assert_eq!(document.body, "The body.\n");
        assert_eq!(document.unreadable, None);
    }

    /// Each opens as frontmatter does and is not frontmatter (`folders.md` 8).
    #[test]
    fn a_body_that_opens_with_a_horizontal_rule_is_a_body() {
        let cases = [
            (
                "---\n\nA paragraph after a rule.\n",
                "a rule with nothing that closes it",
            ),
            (
                "---\n\nA paragraph.\n\n---\n\nAnother.\n",
                "two rules, which look exactly like a fence pair",
            ),
            (
                "----\nstill a body\n",
                "four dashes, which is a rule and not a fence",
            ),
            (
                "--- not a fence\nstill a body\n",
                "a fence with something after it on the same line",
            ),
            ("---\ntitle: A note\n", "an opening fence nobody closed"),
            (
                "---\n- just\n- a list\n---\nbody\n",
                "a fence pair holding a list, which is not a set of fields",
            ),
            (
                "---\njust a string\n---\nbody\n",
                "a fence pair holding one string",
            ),
            // The case every other gate lets through: it parses, it is a
            // mapping, and its field converts. Only the blank line after the
            // fence says it is two rules around a sentence.
            (
                "---\n\nNote: remember the milk\n\n---\n\nThe real content.\n",
                "a first paragraph of the form `Word: text`, which is ordinary prose \
                 and valid YAML at the same time",
            ),
            (
                "---\n\ntitle: not frontmatter\n---\nbody\n",
                "a blank line after the fence, which is what a thematic break has",
            ),
            (
                "---\r\n\r\nWord: text\r\n\r\n---\r\n",
                "the same thing with the other line ending",
            ),
        ];
        for (text, why) in cases {
            let document = read(text);
            assert_eq!(
                document.body, text,
                "this was read as frontmatter and it is {why}; the first \
                 paragraph is gone and the loss is written back"
            );
            assert!(
                document.front.is_empty() && document.unreadable.is_none(),
                "this yielded frontmatter and it is {why}: {document:?}",
            );
        }
    }

    /// A fence pair whose YAML does not parse as fields is frontmatter that
    /// cannot be read, held rather than taken as a body (`folders.md` 10).
    #[test]
    fn a_fence_pair_that_does_not_parse_as_fields_is_unreadable() {
        for text in [
            "---\n[unclosed: bracket\n---\nbody\n",
            "---\ntitle: fine\n  bad: indent\n---\nbody\n",
            "---\nnested:\n  1: not text\n---\nbody\n",
            "---\n1: one\n---\nbody\n",
            "---\nbase: &b {x: 1}\nmerged:\n  <<: *b\n  y: 2\n---\nbody\n",
        ] {
            let document = read(text);
            assert!(
                document.unreadable.is_some(),
                "{text:?} was read as fields or as a body, and a person's \
                 frontmatter with a typo in it is neither"
            );
            assert!(document.front.is_empty());
            assert_eq!(
                document.body, text,
                "an unreadable file lost bytes in the reading"
            );
        }
        // The control: an empty fence pair is frontmatter with nothing in it.
        let empty = read("---\n---\nbody\n");
        assert_eq!(empty.body, "body\n");
        assert!(empty.front.is_empty() && empty.unreadable.is_none());
    }

    #[test]
    fn a_file_read_and_written_back_is_the_same_file() {
        for text in [
            "---\ntitle: A note\ncount: 3\n---\nThe body.\n",
            "no frontmatter at all\n",
            "---\n\nA rule, not a fence.\n",
            "---\n- just\n- a list\n---\nbody\n",
        ] {
            let document = read(text);
            let written = write(&document.front, &document.body).unwrap();
            assert_eq!(
                read(&written),
                document,
                "a file read in and written straight back out is a different \
                 file, so every scan that touches it pushes a change nobody made"
            );
        }
    }

    #[test]
    fn a_settings_map_written_reads_back_the_same() {
        let settings = serde_json::json!({
            "folder": "f1",
            "version": 3,
            "search": { "types": ["core.note"], "filter": "tags contains \"a\"", "state": ["active"] },
            "defaults": { "properties": { "n": 1.5, "flag": true }, "edges": { "parent-of": ["p"] } },
            "include": ["*.md", "notes/**"],
            "first_placement": {},
        });
        let Value::Object(map) = settings else {
            unreachable!()
        };
        let text = write_map(&map).unwrap();
        assert_eq!(read_map(&text).unwrap(), map, "{text}");
        assert!(read_map("search: [open\n").is_err());
        assert!(read_map("- a list\n").is_err());
    }

    #[test]
    fn links_are_read_in_order_and_once_each() {
        assert_eq!(
            links("see [[one]] and [[two|as shown]] and [[one]] again"),
            vec!["one", "two"],
            "a link was missed, repeated or read past its alias, so the edges \
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
    }
}
