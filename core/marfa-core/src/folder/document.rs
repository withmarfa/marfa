//! A file's bytes as an item's fields, and back.
//!
//! The two directions are one module because they have to agree: a file read
//! in and written straight back out must be the same file, and the only way
//! to be sure of that is for one place to own both halves.

use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::error::CoreError;

/// The property an item's body is carried in.
pub const BODY_FIELD: &str = "body";

/// The property the folder writes a file's name into.
pub const TITLE_FIELD: &str = "title";

/// A file, read.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    /// The frontmatter as properties, with the body among them.
    pub properties: Map<String, Value>,
    /// The ids this file links to, in the order they appear.
    pub links: Vec<String>,
}

/// What a file opens with, when it opens with frontmatter.
const FENCE: &str = "---";

/// The frontmatter a file opens with, and the body after it.
///
/// **Frontmatter is only what a file opens with and delimits as frontmatter**
/// (`folders.md` 6), and this is total: every condition that fails makes the
/// whole text a body rather than a refusal or a half-reading. The file opens
/// with the fence on a line of its own, a later line is the fence again, what
/// lies between parses, it is a set of fields, and every one of those fields
/// converts. Anything less is a body that happens to start with a horizontal
/// rule.
///
/// **Never a refusal, and that is the point.** A body read as frontmatter
/// loses its first paragraph and then writes the loss back to the server; a
/// file refused for frontmatter it meant is a file the folder stops carrying.
/// Falling back to a body loses nothing in either direction — the text is
/// still there, and a file read in and written straight back out is the same
/// file.
fn frontmatter(text: &str) -> Option<(Map<String, Value>, &str)> {
    // The opening fence is its own line: `----` is a horizontal rule and
    // `--- x` is text, and neither opens frontmatter.
    let rest = text.strip_prefix(FENCE).and_then(|rest| {
        rest.strip_prefix('\n')
            .or_else(|| rest.strip_prefix("\r\n"))
    })?;
    // **Frontmatter begins immediately.** A blank line after the fence means
    // a thematic break, and this is the condition that tells the two apart
    // when every other one agrees: `---\n\nNote: remember the milk\n\n---`
    // is two horizontal rules around a sentence, and it parses, and it is a
    // mapping, and its one field converts. Without this the first paragraph
    // becomes a property called `Note`, leaves the body, and is written back
    // to the server that way — which is the loss statement 6 forbids, in the
    // one form that is ordinary prose and valid YAML at once.
    if rest.starts_with('\n') || rest.starts_with("\r\n") {
        return None;
    }
    let mut offset = 0usize;
    let (front, body) = loop {
        let line = rest.get(offset..)?.split_inclusive('\n').next()?;
        if line.trim_end_matches(['\r', '\n']) == FENCE {
            break (&rest[..offset], &rest[offset + line.len()..]);
        }
        offset += line.len();
        // Opened and never closed: a horizontal rule, or a file someone is
        // still typing.
        if offset >= rest.len() {
            return None;
        }
    };
    let documents = YamlLoader::load_from_str(front).ok()?;
    let mut properties = Map::new();
    match documents.first() {
        // An empty fence pair is frontmatter with nothing in it, which is
        // not the same as a fence pair holding something unreadable.
        None | Some(Yaml::Null) => {}
        Some(Yaml::Hash(hash)) => {
            for (key, value) in hash {
                // A key an item's properties cannot be keyed by, or a value
                // they cannot hold. The file meant something this build
                // cannot carry, so it is carried as what it plainly is.
                properties.insert(key.as_str()?.to_string(), from_yaml(value)?);
            }
        }
        Some(_) => return None,
    }
    Some((properties, body))
}

/// Reads a file into the fields an item carries.
pub fn read(text: &str) -> Document {
    let (mut properties, body) = frontmatter(text).unwrap_or_else(|| (Map::new(), text));
    properties.insert(BODY_FIELD.into(), Value::String(body.to_string()));
    Document {
        links: links(body),
        properties,
    }
}

/// Writes an item's fields back out as a file.
pub fn write(properties: &Map<String, Value>) -> Result<String, CoreError> {
    let body = properties
        .get(BODY_FIELD)
        .and_then(Value::as_str)
        .unwrap_or_default();
    let front: Map<String, Value> = properties
        .iter()
        .filter(|(key, _)| key.as_str() != BODY_FIELD)
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if front.is_empty() {
        return Ok(body.to_string());
    }
    let mut hash = yaml_rust2::yaml::Hash::new();
    for (key, value) in &front {
        hash.insert(Yaml::String(key.clone()), to_yaml(value));
    }
    let mut rendered = String::new();
    YamlEmitter::new(&mut rendered)
        .dump(&Yaml::Hash(hash))
        .map_err(|error| {
            CoreError::Invalid(format!("this item's fields will not render: {error}"))
        })?;
    // The emitter opens with its own `---`, which is the document start and
    // is exactly the fence this file needs; anything else would be a second
    // one.
    let rendered = rendered.trim_start_matches("---\n");
    Ok(format!("{FENCE}\n{rendered}\n{FENCE}\n{body}"))
}

/// A YAML value as an item's property.
///
/// `None` where this build cannot carry the value, which makes the whole
/// file a body: `folders.md` 5 says nothing a file carries is dropped on the
/// way in, and a property quietly converted to something else is dropped in
/// the way that is hardest to see.
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
        // An anchor this load did not resolve, or something that would not
        // read. Either way the field would arrive holding other than what
        // the file says.
        Yaml::Alias(_) | Yaml::BadValue => return None,
    })
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

/// The wiki links a body carries, in order and without repeats.
///
/// `[[target]]`, which is what a folder writes and what the notes it holds
/// are written with. A link the folder cannot express stays on the item
/// rather than being dropped (`folders.md` 7), which is why this reads links
/// and never removes one.
pub fn links(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = body.as_bytes();
    let mut at = 0usize;
    while let Some(start) = body[at..].find("[[") {
        let open = at + start + 2;
        let Some(end) = body[open..].find("]]") else {
            break;
        };
        let target = body[open..open + end].trim();
        // An alias — `[[id|shown]]` — links to what is before the bar.
        let target = target.split('|').next().unwrap_or(target).trim();
        if !target.is_empty() && !found.iter().any(|held| held == target) {
            found.push(target.to_string());
        }
        at = open + end + 2;
        if at >= bytes.len() {
            break;
        }
    }
    found
}

/// One wiki link, as a folder writes it.
pub fn render_link(target: &str) -> String {
    format!("[[{target}]]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(document: &Document) -> &str {
        document.properties[BODY_FIELD].as_str().unwrap()
    }

    #[test]
    fn frontmatter_becomes_properties_and_the_body_stays_the_body() {
        let document = read(
            "---\ntitle: A note\ncount: 3\ntags:\n  - alpha\n  - beta\nnested:\n  deep: true\n---\nThe body.\n",
        );
        assert_eq!(document.properties["title"], "A note");
        assert_eq!(document.properties["count"], 3);
        assert_eq!(
            document.properties["tags"],
            serde_json::json!(["alpha", "beta"])
        );
        assert_eq!(
            document.properties["nested"],
            serde_json::json!({ "deep": true }),
            "a nested field was flattened or dropped, and a file's fields \
             travel whole or not at all"
        );
        assert_eq!(body_of(&document), "The body.\n");
    }

    /// The statement this module exists for (`folders.md` 6).
    ///
    /// Each of these opens with the three characters frontmatter opens with
    /// and is not frontmatter. Reading one as frontmatter loses the first
    /// paragraph and then writes the loss back to the server, in both
    /// directions, with nothing anywhere reporting it.
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
                "---\n1: one\n---\nbody\n",
                "a field keyed by something an item's properties cannot be keyed by",
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
                body_of(&document),
                text,
                "this was read as frontmatter and it is {why}; the first \
                 paragraph is gone and the loss is written back"
            );
            assert_eq!(
                document.properties.len(),
                1,
                "this yielded properties and it is {why}: {:?}",
                document.properties
            );
        }
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
            let written = write(&document.properties).unwrap();
            assert_eq!(
                read(&written),
                document,
                "a file read in and written straight back out is a different \
                 file, so every scan that touches it pushes a change nobody made"
            );
        }
    }

    /// Nothing is refused and nothing is half-read.
    ///
    /// A file the fence rule turns down keeps every byte it had, in the body,
    /// and comes back out as itself. That is what makes falling back to a
    /// body safe where refusing or half-reading would not be.
    #[test]
    fn a_file_this_build_cannot_read_as_frontmatter_keeps_every_byte() {
        for text in [
            "---\n[unclosed: bracket\n---\nbody\n",
            "---\nnested:\n  1: not text\n---\nbody\n",
            "---\n- a list\n---\nbody\n",
        ] {
            let document = read(text);
            assert_eq!(
                body_of(&document),
                text,
                "a file whose frontmatter this build cannot carry lost part of \
                 itself, and every byte of it is still on the disk"
            );
            assert_eq!(
                write(&document.properties).unwrap(),
                text,
                "it does not come back out as itself, so the next scan pushes \
                 a change nobody made"
            );
        }
        // The control: an empty fence pair is frontmatter with nothing in it,
        // which is not the same as a fence pair this build cannot read.
        let empty = read("---\n---\nbody\n");
        assert_eq!(body_of(&empty), "body\n");
        assert_eq!(empty.properties.len(), 1);
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
        assert_eq!(render_link("abc"), "[[abc]]");
    }
}
