//! A file's bytes as frontmatter and a body, and back: one module, because a
//! file read in and written straight back out must be the same file.

use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::body::text::links;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unindented_sequence_edits_keep_child_source() {
        let source =
            "---\nitems:\n- 'one' # first\n- 'two' # second\nkeep: 1.00 # precision\n---\nBody\n";
        let original = read(source);
        assert!(original.unreadable.is_none());
        assert_eq!(original.front["items"], serde_json::json!(["one", "two"]));
        let mut front = original.front.clone();
        front["items"] = serde_json::json!(["two", "one"]);
        let output = write(&front, &original.body, Some(&original)).unwrap();
        assert_eq!(
            output,
            source.replace(
                "- 'one' # first\n- 'two' # second",
                "- 'two' # second\n- 'one' # first"
            )
        );
    }

    #[test]
    fn unindented_sequence_replacements_stay_values_of_their_keys() {
        for source in [
            "---\nitems:\n- 'one' # first\n- 'two' # second\nkeep: 1.00 # precision\n---\nBody\n",
            "---\nouter:\n  items:\n  - 'one' # first\n  - 'two' # second\nkeep: 1.00 # precision\n---\nBody\n",
        ] {
            let original = read(source);
            for value in [
                serde_json::json!([]),
                serde_json::json!({}),
                serde_json::json!(null),
                serde_json::json!("scalar"),
            ] {
                let mut front = original.front.clone();
                if source.contains("outer:") {
                    front["outer"]["items"] = value;
                } else {
                    front["items"] = value;
                }
                let output = write(&front, &original.body, Some(&original)).unwrap();
                assert_eq!(read(&output).front, front);
                assert_eq!(read(&output).body, "Body\n");
                assert!(output.contains("keep: 1.00 # precision\n"));
            }
        }
    }

    #[test]
    fn first_property_removal_keeps_a_frontmatter_opening() {
        for newline in ["\n", "\r\n"] {
            let source = "---\nremove: old\n\nkeep: 'é' # keep\n---\nBody\n".replace('\n', newline);
            let original = read(&source);
            assert!(original.unreadable.is_none());
            let mut front = original.front.clone();
            front.remove("remove");
            let output = write(&front, &original.body, Some(&original)).unwrap();
            assert_eq!(
                output,
                source.replace(&format!("remove: old{newline}{newline}"), "")
            );
        }
    }

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
}
