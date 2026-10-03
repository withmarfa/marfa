//! A file's bytes as frontmatter and a body, and back: one module, because a
//! file read in and written straight back out must be the same file.

use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::error::CoreError;

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub front: Map<String, Value>,
    /// What follows the frontmatter, or the whole text where there is none.
    pub body: String,
    pub links: Vec<String>,
    pub unreadable: Option<String>,
    source: Option<Source>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Presentation {
    front: Map<String, Value>,
    body: String,
}

impl Document {
    pub(super) fn presentation(&self) -> Presentation {
        Presentation {
            front: self.front.clone(),
            body: self.body.clone(),
        }
    }
}

impl Presentation {
    pub(super) fn document(&self) -> Document {
        Document {
            front: self.front.clone(),
            body: self.body.clone(),
            links: links(&self.body),
            unreadable: None,
            source: None,
        }
    }

    pub(super) fn agrees(
        &self,
        other: &Presentation,
        edge_types: &super::edge_types::EdgeTypes,
    ) -> bool {
        self.body == other.body
            && same_value(
                &Value::Object(super::fields::presentation(&self.front, edge_types)),
                &Value::Object(super::fields::presentation(&other.front, edge_types)),
            )
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Source {
    yaml: String,
    opening: String,
    closing: String,
}

const FENCE: &str = "---";

enum Front<'a> {
    /// No fence pair, or one holding a list or a line of text: Markdown.
    Body,
    Fields(Map<String, Value>, &'a str, Source),
    Unreadable(String),
}

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
    let opening_len = text.len() - rest.len();
    let closing_len = rest.len() - front.len() - body.len();
    Front::Fields(
        fields,
        body,
        Source {
            yaml: front.into(),
            opening: text[..opening_len].into(),
            closing: rest[front.len()..front.len() + closing_len].into(),
        },
    )
}

/// A UTF-8 byte-order mark, which some editors open every file with: a file
/// is read past it and written without it.
pub(super) const MARK: char = '\u{feff}';

pub fn read(text: &str) -> Document {
    let text = text.strip_prefix(MARK).unwrap_or(text);
    match frontmatter(text) {
        Front::Body => read_body(text),
        Front::Fields(front, body, source) => Document {
            source: Some(source),
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
    let mut lines = text.strip_prefix(MARK).unwrap_or(text).lines();
    if lines.next()? != FENCE {
        return None;
    }
    lines
        .take_while(|line| line.trim_end() != FENCE)
        .find_map(|line| line.strip_prefix("marfa_id:"))
        .map(|id| id.trim().trim_matches(['"', '\'']).to_string())
        .filter(|id| !id.is_empty())
}

pub fn read_body(text: &str) -> Document {
    Document {
        source: None,
        front: Map::new(),
        body: text.to_string(),
        links: links(text),
        unreadable: None,
    }
}

pub(super) fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            if a == b {
                return true;
            }
            let integer = |n: &serde_json::Number| {
                n.as_i64()
                    .map(i128::from)
                    .or_else(|| n.as_u64().map(i128::from))
            };
            let integral_float = |n: &serde_json::Number| {
                n.as_f64()
                    .filter(|f| f.is_finite() && f.fract() == 0.0)
                    .map(|f| f as i128)
            };
            match (integer(a), integer(b)) {
                (Some(a), None) => Some(a) == integral_float(b),
                (None, Some(b)) => integral_float(a) == Some(b),
                _ => false,
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same_value(a, b)))
        }
        _ => left == right,
    }
}

pub fn write(
    front: &Map<String, Value>,
    body: &str,
    original: Option<&Document>,
) -> Result<String, CoreError> {
    let Some(original) = original else {
        return canonical(front, body);
    };
    if let Some(reason) = &original.unreadable {
        return Err(CoreError::Invalid(format!(
            "cannot rewrite unreadable frontmatter: {reason}"
        )));
    }
    let Some(source) = &original.source else {
        return canonical(front, body);
    };
    let newline = if source.opening.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let yaml = super::preserve::write(
        &source.yaml,
        &Value::Object(original.front.clone()),
        &Value::Object(front.clone()),
        newline,
    )?;
    let rendered = format!("{}{yaml}{}{body}", source.opening, source.closing);
    let checked = read(&rendered);
    if checked.unreadable.is_some()
        || !same_value(&Value::Object(checked.front), &Value::Object(front.clone()))
        || checked.body != body
    {
        return Err(CoreError::Invalid(
            "cannot preserve this frontmatter without changing its values".into(),
        ));
    }
    Ok(rendered)
}

pub fn canonical(front: &Map<String, Value>, body: &str) -> Result<String, CoreError> {
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

fn merges(value: &Yaml) -> bool {
    match value {
        Yaml::Hash(hash) => hash
            .iter()
            .any(|(key, value)| key.as_str() == Some("<<") || merges(value)),
        Yaml::Array(items) => items.iter().any(merges),
        _ => false,
    }
}

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

/// An embed, `![[target]]`, is not a link.
pub fn links(body: &str) -> Vec<String> {
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

pub fn render_link(target: &str) -> String {
    format!("[[{target}]]")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Embed {
    /// `![[name]]`, the name before any `|` or `#`.
    Named { raw: String, name: String },
    /// `![alt](path)`, the path decoded and without its query or fragment.
    Path { raw: String, path: String },
    /// `![alt](a b.png)`: a raw space, which ends a Markdown path, so what
    /// the parentheses hold is kept whole to say so.
    Spaced { raw: String, path: String },
}

impl Embed {
    pub fn raw(&self) -> &str {
        match self {
            Embed::Named { raw, .. } | Embed::Path { raw, .. } | Embed::Spaced { raw, .. } => raw,
        }
    }
}

pub fn embeds(body: &str) -> Vec<Embed> {
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
    fn metadata_keeps_the_persons_unchanged_frontmatter() {
        let source = "---\r\n# café\r\nquoted: 'hi' # stay\r\nnumber: 1.10\r\nlist: [a, b]\r\nblock: |\r\n  é\r\n---\r\nBody\r\n";
        let document = read(source);
        let mut front = document.front.clone();
        front.insert("marfa_id".into(), Value::String("id".into()));
        let rendered = write(&front, &document.body, Some(&document)).unwrap();
        assert_eq!(read(&rendered).front["marfa_id"], "id");
        assert!(rendered.starts_with(source.split("---\r\nBody").next().unwrap()));
    }

    #[test]
    fn a_changed_value_keeps_unrelated_yaml_syntax() {
        for source in [
            "---\r\n# café\r\nquoted: 'hi' # stay\r\nnumber: 1.10\r\nlist: [a, b]\r\nblock: |\r\n  é\r\n---\r\nBody\r\n",
            "---\n{quoted: 'hi', number: 1.10, list: [a, b]} # stay\n---\nBody\n",
            "---\nquoted: hi\nnested:\n  keep: 'élan' # keep\n  count: 3\n---\n",
        ] {
            let original = read(source);
            let mut front = original.front.clone();
            front.insert("quoted".into(), Value::String("bye".into()));
            let output = write(&front, &original.body, Some(&original)).unwrap();
            let expected = if source.contains("'hi'") {
                source.replace("'hi'", "bye")
            } else {
                source.replace("quoted: hi", "quoted: bye")
            };
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn nested_values_and_sequence_children_keep_their_source() {
        let source = "---\r\nnested:\r\n  keep: 'élan' # keep\r\n  count: 3\r\nsequence: [one, 'two', {keep: 1.10, change: old}]\r\n---\r\n";
        let original = read(source);
        let mut front = original.front.clone();
        front["nested"]["count"] = Value::from(4);
        front["sequence"][2]["change"] = Value::String("new".into());
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert_eq!(
            output,
            source
                .replace("count: 3", "count: 4")
                .replace("change: old", "change: new")
        );
    }

    #[test]
    fn flow_map_insertions_and_removals_keep_comments() {
        let source = "---\r\n{a: 1, # keep\r\n b: [x, y], c: 'é'} # last\r\n---\r\n";
        let original = read(source);
        let mut front = original.front.clone();
        front.remove("b");
        front.insert("new".into(), serde_json::json!(["z"]));
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert!(output.contains("a: 1, # keep\r\n"));
        assert!(output.contains("c: 'é'"));
        assert!(output.contains("# last\r\n"));
        assert_eq!(read(&output).front, front);
    }

    #[test]
    fn changing_or_removing_an_anchor_expands_only_affected_aliases() {
        for remove in [false, true] {
            let source = "---\nbase: &base {keep: 'é', change: old}\ncopy: *base # alias\nother: &other [a, b]\nuntouched: *other\n---\n";
            let original = read(source);
            let mut front = original.front.clone();
            if remove {
                front.remove("base");
            } else {
                front["base"]["change"] = Value::String("new".into());
            }
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert!(output.contains("other: &other [a, b]\nuntouched: *other\n"));
            assert!(output.contains("# alias\n"));
            assert!(!output.contains("copy: *base"));
            assert_eq!(read(&output).front, front);
        }
    }

    #[test]
    fn literal_and_folded_values_can_change_without_touching_neighbours() {
        for style in ["|", ">-"] {
            let source = format!(
                "---\r\nkeep: 'é' # stay\r\nblock: {style}\r\n  old\r\nnext: [a, b]\r\n---\r\n"
            );
            let original = read(&source);
            let mut front = original.front.clone();
            front["block"] = Value::String("new\ntext\n".into());
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert!(output.contains("keep: 'é' # stay\r\n"));
            assert!(output.contains("next: [a, b]\r\n"));
            assert_eq!(read(&output).front, front);
        }
    }

    #[test]
    fn sequence_insertions_and_removals_keep_unchanged_children() {
        for source in [
            "---\nitems: ['one', 'two', 'three',]\n---\n",
            "---\r\nitems:\r\n  - 'one' # first\r\n  - 'two' # second\r\n  - 'three' # third\r\n---\r\n",
        ] {
            let original = read(source);
            let mut front = original.front.clone();
            front["items"] = serde_json::json!(["zero", "one", "three", "four"]);
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert!(output.contains("'one'"));
            assert!(output.contains("'three'"));
            if source.contains("# first") {
                assert!(output.contains("'one' # first\r\n"));
                assert!(output.contains("'three' # third\r\n"));
            }
            assert_eq!(read(&output).front, front);
        }
    }

    #[test]
    fn metadata_preserves_supported_yaml_mapping_forms() {
        for yaml in [
            "# comment only\n",
            "",
            "{}\n",
            "{a, b}\n",
            "? 'explicit key'\n: value\n",
            "nested:\n  last: |\n    café\nnext: [a, b]\n",
            "a: !!str 42\nb: &value {kept: 'é'}\nc: *value\n",
            "a: &first same\nb: *first\nc: &first other\nd: *first\n",
        ] {
            let source = format!("---\n{yaml}---\nbody\n");
            let original = read(&source);
            assert_eq!(original.unreadable, None, "{source}");
            let mut front = original.front.clone();
            front.insert("marfa_id".into(), Value::String("id".into()));
            let output = write(&front, &original.body, Some(&original))
                .unwrap_or_else(|e| panic!("{source}: {e}"));
            if !yaml.trim_start().starts_with('{') {
                assert!(output.starts_with(&format!("---\n{yaml}")), "{output}");
            }
        }
    }

    #[test]
    fn a_changed_tagged_value_and_nested_append_preserve_other_fields() {
        let source = "---\r\na: !!str 42 # keep\r\nnested:\r\n  last: |\r\n    café\r\nnext: [a, b]\r\n---\r\n";
        let original = read(source);
        let mut front = original.front.clone();
        front["a"] = Value::from(43);
        front["nested"]["new"] = Value::Bool(true);
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert!(output.contains("# keep\r\n"));
        assert!(output.contains("last: |\r\n    café\r\n"));
        assert!(output.contains("next: [a, b]\r\n"));
        assert_eq!(read(&output).front, front);
    }

    #[test]
    fn flow_replacement_uses_surviving_separators() {
        for (yaml, desired) in [
            ("{a: 1}", serde_json::json!({"b": 2})),
            (
                "{keep: 1, a: 2, b: 3}",
                serde_json::json!({"keep": 1, "new": 4}),
            ),
            (
                "{a: 1, keep: 'é', b: 3,}",
                serde_json::json!({"keep": "é", "new": 4}),
            ),
        ] {
            let original = read(&format!("---\nnested: {yaml}\n---\n"));
            let mut front = original.front.clone();
            front["nested"] = desired;
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert_eq!(read(&output).front, front);
            if yaml.contains("'é'") {
                assert!(output.contains("keep: 'é'"));
            }
        }
    }

    #[test]
    fn mapping_keys_participate_in_anchor_lifetimes() {
        for (yaml, remove) in [
            ("a: &k key\n*k : old\n", None),
            ("&k first: old\nb: *k\n", Some("first")),
            (
                "&k first: old\na: *k\n&k second: other\nb: *k\n",
                Some("first"),
            ),
        ] {
            let source = format!("---\n{yaml}---\n");
            let original = read(&source);
            assert_eq!(original.unreadable, None);
            let mut front = original.front.clone();
            if let Some(key) = remove {
                front.remove(key);
            }
            front.insert("metadata".into(), Value::String("added".into()));
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert_eq!(read(&output).front, front);
            if remove.is_none() {
                assert!(output.starts_with(&format!("---\n{yaml}")));
            }
            if yaml.contains("second") {
                assert!(output.contains("&k second: other\nb: *k\n"));
            }
        }
    }

    #[test]
    fn moved_sequence_children_keep_their_syntax_and_comments() {
        let source = "---\r\nitems:\r\n  - 'one' # first\r\n  - 'two' # second\r\n  - {keep: 'é', count: 1.00} # third\r\n---\r\n";
        let original = read(source);
        for desired in [
            serde_json::json!([{"keep":"é", "count":1}, "two", "one"]),
            serde_json::json!(["two", "new", {"keep":"é", "count":1}, "one"]),
        ] {
            let mut front = original.front.clone();
            front["items"] = desired;
            let output = write(&front, &original.body, Some(&original)).unwrap();
            for unchanged in [
                "'one' # first\r\n",
                "'two' # second\r\n",
                "{keep: 'é', count: 1.00} # third\r\n",
            ] {
                assert!(output.contains(unchanged), "{output}");
            }
            assert!(same_value(
                &Value::Object(read(&output).front),
                &Value::Object(front)
            ));
        }
    }

    #[test]
    fn moved_flow_children_keep_comments_quotes_and_duplicate_spellings() {
        let source = "---\r\nitems: ['same', # first\r\n {keep: 'é', number: 1.00}, # nested\r\n \"same\", # second\r\n 'last']\r\n---\r\n";
        let original = read(source);
        let mut front = original.front.clone();
        front["items"] = serde_json::json!(["last", "same", "same", {"keep":"é", "number":1}]);
        let output = write(&front, &original.body, Some(&original)).unwrap();
        for kept in [
            "'same', # first\r\n",
            "\"same\", # second\r\n",
            "{keep: 'é', number: 1.00} # nested\r\n",
            "'last'",
        ] {
            assert!(output.contains(kept), "{output}");
        }
        assert!(same_value(
            &Value::Object(read(&output).front),
            &Value::Object(front)
        ));
    }

    #[test]
    fn moved_block_children_keep_literal_content_nested_syntax_and_duplicates() {
        let source = "---\r\nitems:\r\n  - | # literal\r\n    text\r\n  - ['é', 'x'] # nested\r\n  - 'same' # first\r\n  - \"same\" # second\r\n---\r\n";
        let original = read(source);
        let mut front = original.front.clone();
        front["items"] = serde_json::json!(["same", ["é", "x"], "same", "text\n"]);
        let output = write(&front, &original.body, Some(&original)).unwrap();
        for kept in [
            "- | # literal\r\n    text\r\n",
            "- ['é', 'x'] # nested\r\n",
            "- 'same' # first\r\n",
            "- \"same\" # second\r\n",
        ] {
            assert!(output.contains(kept), "{output}");
        }
        assert_eq!(read(&output).front, front);
    }

    #[test]
    fn moved_aliases_expand_only_when_the_preceding_anchor_no_longer_agrees() {
        for source in [
            "---\nitems:\n  - {label: first, value: &k 'one'} # anchor\n  - {label: second, value: *k} # alias\n---\n",
            "---\nitems: [{label: first, value: &k 'one'}, {label: second, value: *k}]\n---\n",
        ] {
            let original = read(source);
            let mut front = original.front.clone();
            front["items"].as_array_mut().unwrap().reverse();
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert!(source.contains("value: *k"));
            assert!(!output.contains("value: *k"), "{output}");
            assert!(output.contains("value: &k 'one'"), "{output}");
            assert_eq!(read(&output).front, front);
        }
    }

    #[test]
    fn reordered_reused_anchor_names_resolve_at_each_alias_position() {
        let source = "---\nitems:\n  - {label: first, value: &k 'one'}\n  - {label: second, value: *k}\n  - {label: third, value: &k 'two'}\n  - {label: fourth, value: *k}\nother: &other 'keep'\ncopy: *other\n---\n";
        let original = read(source);
        let mut front = original.front.clone();
        let before = front["items"].as_array().unwrap();
        front["items"] = Value::Array([2, 1, 0, 3].map(|i| before[i].clone()).to_vec());
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert_eq!(source.matches("value: *k").count(), 2);
        assert!(!output.contains("value: *k"), "{output}");
        assert!(output.contains("value: &k 'one'"));
        assert!(output.contains("value: &k 'two'"));
        assert!(output.contains("other: &other 'keep'\ncopy: *other\n"));
        assert_eq!(read(&output).front, front);
    }

    #[test]
    fn every_flow_survivor_subset_can_append_without_losing_comments() {
        for trailing in ["", ","] {
            let source = format!(
                "---\r\nnested: {{a: 'one', # first\r\n b: 'two', # second\r\n c: 'three'{trailing}}}\r\n---\r\n"
            );
            let original = read(&source);
            for mask in 0..8 {
                let mut front = original.front.clone();
                let map = front["nested"].as_object_mut().unwrap();
                for (i, key) in ["a", "b", "c"].iter().enumerate() {
                    if mask & (1 << i) == 0 {
                        map.remove(*key);
                    }
                }
                map.insert("added".into(), Value::String("new".into()));
                let output = write(&front, &original.body, Some(&original)).unwrap();
                assert_eq!(read(&output).front, front);
                assert!(output.contains("# first\r\n"));
                assert!(output.contains("# second\r\n"));
                for (i, kept) in ["a: 'one'", "b: 'two'", "c: 'three'"].iter().enumerate() {
                    if mask & (1 << i) != 0 {
                        assert!(output.contains(kept));
                    }
                }
            }
        }
    }

    #[test]
    fn an_implicit_alias_key_can_gain_a_value() {
        let original = read("---\na: &k key\nnested: {*k}\n---\n");
        assert_eq!(original.unreadable, None);
        let mut front = original.front.clone();
        front["nested"]["key"] = Value::String("new".into());
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert!(output.contains("nested: {*k : new}"), "{output}");
        assert_eq!(read(&output).front, front);
    }

    #[test]
    fn joint_anchor_and_alias_changes_keep_the_reference() {
        let source = "---\na: &a old\nb: *a # reference\n---\n";
        let original = read(source);
        let mut front = original.front.clone();
        front["a"] = Value::String("new".into());
        front["b"] = Value::String("new".into());
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert_eq!(output, source.replace("&a old", "&a new"));
    }

    #[test]
    fn duplicate_mapping_keys_stay_unreadable() {
        assert!(read("---\na: one\na: two\n---\n").unreadable.is_some());
        assert!(
            read("---\nnested: {a: one, a: two}\n---\n")
                .unreadable
                .is_some()
        );
    }

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
        let empty = read("---\n---\nbody\n");
        assert_eq!(empty.body, "body\n");
        assert!(empty.front.is_empty() && empty.unreadable.is_none());
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_frontmatter() {
        let plain = "---\ntitle: A note\nmarfa_id: n1\n---\nThe body.\n";
        let marked = format!("\u{feff}{plain}");
        assert_eq!(
            read(&marked),
            read(plain),
            "a file that opens with a byte-order mark lost its frontmatter, \
             so its fields land in the body and its type and title are gone"
        );
        assert_eq!(
            id_line("\u{feff}---\nmarfa_id: n1\n  bad\n---\n").as_deref(),
            Some("n1")
        );

        let body = read("\u{feff}No frontmatter.\n");
        assert_eq!(
            body.body, "No frontmatter.\n",
            "the mark reached the body, where it is an invisible character \
             the server keeps"
        );

        let document = read(&marked);
        let written = write(&document.front, &document.body, Some(&document)).unwrap();
        assert_eq!(
            written, plain,
            "what the folder writes back carries the mark"
        );
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
            let written = write(&document.front, &document.body, Some(&document)).unwrap();
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
