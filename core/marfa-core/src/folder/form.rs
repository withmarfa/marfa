//! How a file writes its frontmatter, apart from what it says: the keys in
//! order, which are empty, and each value's style. A placement carries it, so
//! a directory that never had the file writes it as the file was written.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tree_sitter::Node;

use super::document::{self, Document, same_value};
use super::edge_types::EdgeTypes;
use super::placement::{self, PLACEMENT_EDGE, Withheld};
use super::{Folder, Scanned, fields, preserve, state};
use crate::Result;
use crate::body::embed::carries_frontmatter;
use crate::model::EdgeEdit;

/// The placement property that holds a file's form.
pub(super) const FORM_PROPERTY: &str = "form";

/// The most a form may take as JSON: a larger one is not kept.
const FORM_LIMIT: usize = 8 * 1024;

/// How far a block's lines sit under their key.
const BLOCK_INDENT: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Form {
    pub keys: Vec<Key>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Key {
    pub key: String,
    pub style: Style,
    /// The style of a list's first item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Style>,
    /// How far a block list's items sit right of their key.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub indent: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Style {
    Empty,
    Plain,
    Single,
    Double,
    Literal,
    Folded,
    /// A date alone, `2026-10-11`.
    Day,
    Flow,
    Block,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

impl Form {
    /// The form of the document's frontmatter, keeping only the keys `keeps`
    /// answers for, given each key's value. `None` where the frontmatter
    /// cannot be read as one block of keys.
    pub(super) fn of(document: &Document, keeps: impl Fn(&str, &Value) -> bool) -> Option<Form> {
        if document.unreadable.is_some() {
            return None;
        }
        let text = document.frontmatter_text()?;
        let tree = preserve::parse(text).ok()?;
        let semantic = yaml_rust2::YamlLoader::load_from_str(text).ok()?;
        let mut names = std::collections::HashMap::new();
        preserve::keys(tree.root_node(), semantic.first()?, &mut names).ok()?;
        let root = preserve::value_node(tree.root_node());
        if root.kind() != "block_mapping" {
            return None;
        }
        let mut keys = Vec::new();
        for (key, pair) in preserve::entries(root, &names).ok()? {
            let value = document.front.get(&key)?;
            if !keeps(&key, value) {
                continue;
            }
            keys.push(match pair.child_by_field_name("value") {
                None => Key::styled(key, Style::Empty),
                Some(node) => key_of(key, pair, preserve::value_node(node), text),
            });
        }
        let form = Form { keys };
        (serde_json::to_vec(&form).ok()?.len() <= FORM_LIMIT).then_some(form)
    }

    /// The form a placement's property holds, where it is one.
    pub(super) fn read(value: &Value) -> Option<Form> {
        serde_json::from_value(value.clone()).ok()
    }

    pub(super) fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// A file's frontmatter in this form, showing `front`, the lines a file
    /// written without a form shows: a key `front` lacks is written only where
    /// it is empty, and the rest follow in `front`'s order. `occurred_at` is
    /// the item's, for an `occurred_at` key `front` leaves out. `None` where
    /// the result would not read back as one key a line.
    pub(super) fn stand_in(
        &self,
        front: &Map<String, Value>,
        occurred_at: &str,
    ) -> Option<Document> {
        let mut yaml = String::new();
        let mut emitted: HashSet<&str> = HashSet::new();
        for key in &self.keys {
            if emitted.contains(key.key.as_str()) {
                continue;
            }
            let value = match front.get(&key.key) {
                Some(value) => Some(value.clone()),
                None if key.key == fields::OCCURRED_AT_FIELD && key.style != Style::Empty => {
                    Some(Value::String(occurred_at.to_string()))
                }
                None => None,
            };
            yaml.push_str(&match value {
                Some(value) => key.line(&value),
                None if key.style == Style::Empty => {
                    format!("{}:\n", preserve::emitted_key(&key.key))
                }
                None => continue,
            });
            emitted.insert(&key.key);
        }
        for (name, value) in front {
            if emitted.insert(name) {
                yaml.push_str(&format!(
                    "{}: {}\n",
                    preserve::emitted_key(name),
                    preserve::json(value)
                ));
            }
        }
        let map = document::read_map(&yaml).ok()?;
        if map.len() != emitted.len() {
            return None;
        }
        let stand_in = document::read(&format!("---\n{yaml}---\n"));
        stand_in.frontmatter_text().is_some().then_some(stand_in)
    }
}

impl Folder {
    /// The form to keep on the item's placement for `document`: the keys of
    /// its own fields, its edges and the properties the item holds, and every
    /// empty one. `None` where the server's placement takes no form.
    pub(super) fn form_for(
        &self,
        item_id: &str,
        document: &Document,
        edge_types: &EdgeTypes,
    ) -> Result<Option<Value>> {
        let takes = edge_types.get(PLACEMENT_EDGE).is_some_and(|placement| {
            placement
                .properties
                .iter()
                .any(|field| field.name == FORM_PROPERTY)
        });
        if !takes || document.frontmatter_text().is_none() {
            return Ok(None);
        }
        let Some(item) = self.core.get(item_id)? else {
            return Ok(None);
        };
        Ok(Form::of(document, |key, value| {
            value.is_null()
                || fields::reserved(key, edge_types)
                || item.properties.contains_key(key)
        })
        .map(|form| form.value()))
    }

    /// Sends the form of each document the pass read whose placement holds
    /// another: one this pass found changed, or any whose placement holds
    /// none. A file this directory wrote and nobody changed since sends
    /// nothing, so the form follows the directory where a person last wrote.
    pub(super) fn send_forms(
        &self,
        files: &[Scanned],
        snapshot: &[state::Bound],
        edge_types: &EdgeTypes,
        withheld: &Withheld,
    ) -> Result<()> {
        let before: std::collections::HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|bound| (bound.path.as_str(), bound))
            .collect();
        for file in files {
            if file.deferred || file.unreadable.is_some() || !carries_frontmatter(&file.path) {
                continue;
            }
            let Some(bound) = state::bound_at(&*self.core.conn()?, &file.key)? else {
                continue;
            };
            if bound.held.is_some() || bound.holds_refusal() || bound.content_hash != file.hash {
                continue;
            }
            let Some(edge) = self.placement(&bound.item_id)? else {
                continue;
            };
            let Some(path) =
                placement::path_of(&edge).filter(|path| marfa_rules::names::same(path, &file.key))
            else {
                continue;
            };
            let changed = before
                .get(file.key.as_str())
                .is_none_or(|was| was.item_id != bound.item_id || was.content_hash != file.hash);
            let held = edge.properties.get(FORM_PROPERTY);
            if held.is_some() && !changed || withheld.contains_key(&bound.item_id) {
                continue;
            }
            let document = document::read(&file.text);
            let Some(form) = self.form_for(&bound.item_id, &document, edge_types)? else {
                continue;
            };
            if held == Some(&form) {
                continue;
            }
            let mut properties = Map::new();
            properties.insert(
                placement::PATH_PROPERTY.into(),
                Value::String(path.to_string()),
            );
            properties.insert(FORM_PROPERTY.into(), form);
            self.core.update_edge(
                &edge.id,
                &EdgeEdit {
                    properties,
                    base_version: Some(edge.version),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }
}

impl Key {
    fn styled(key: String, style: Style) -> Key {
        Key {
            key,
            style,
            items: None,
            indent: 0,
        }
    }

    /// The key's line, or lines, showing `value`: in the key's style where
    /// that reads back as what is meant, else as a rewrite writes a value.
    fn line(&self, value: &Value) -> String {
        let key = preserve::emitted_key(&self.key);
        let plain = format!("{key}: {}\n", preserve::json(value));
        if value.is_null() {
            return format!("{key}:\n");
        }
        let (meant, text) = match (self.style, value) {
            (Style::Day, Value::String(time)) => match day_of(time) {
                Some(day) => (Value::String(day.clone()), format!(" {day}\n")),
                None => return plain,
            },
            (Style::Flow | Style::Block, Value::Array(values)) => {
                (value.clone(), self.list(values).unwrap_or_default())
            }
            (Style::Plain | Style::Single | Style::Double, Value::Array(values))
                if self.key == fields::TAGS_FIELD
                    && values
                        .iter()
                        .all(|tag| tag.as_str().is_some_and(|tag| !tag.contains(',')))
                    && values.len() > 1 =>
            {
                let joined = Value::String(
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                (
                    joined.clone(),
                    scalar(self.style, &joined).unwrap_or_default(),
                )
            }
            // A list of one shown on its own, as a line naming one item is.
            (_, Value::Array(values)) if values.len() == 1 => (
                values[0].clone(),
                scalar(self.style, &values[0]).unwrap_or_default(),
            ),
            (Style::Flow | Style::Block, single @ (Value::String(_) | Value::Number(_))) => {
                let values = vec![single.clone()];
                (
                    Value::Array(values.clone()),
                    self.list(&values).unwrap_or_default(),
                )
            }
            (style, value) => (value.clone(), scalar(style, value).unwrap_or_default()),
        };
        let line = format!("{key}:{text}");
        if !text.is_empty() && reads_as(&line, &self.key, &meant) {
            line
        } else {
            plain
        }
    }

    fn list(&self, values: &[Value]) -> Option<String> {
        if values.is_empty() {
            return Some(" []\n".into());
        }
        let style = self.items.unwrap_or(Style::Plain);
        let items: Vec<String> = values
            .iter()
            .map(|value| scalar_item(style, value))
            .collect::<Option<_>>()?;
        Some(match self.style {
            Style::Block => {
                let indent = " ".repeat(self.indent);
                let lines: String = items
                    .iter()
                    .map(|item| format!("{indent}-{item}\n"))
                    .collect();
                format!("\n{lines}")
            }
            _ => {
                let items: Vec<&str> = items.iter().map(|item| item.trim_start()).collect();
                format!(" [{}]\n", items.join(", "))
            }
        })
    }
}

/// A list item in `style`, after its `-` or `[`, with the space before it.
fn scalar_item(style: Style, value: &Value) -> Option<String> {
    let text = scalar(style, value)
        .filter(|text| {
            !text.contains('\n') || text.ends_with('\n') && text.matches('\n').count() == 1
        })
        .unwrap_or_else(|| format!(" {}\n", preserve::json(value)));
    let text = text.strip_suffix('\n').unwrap_or(&text);
    (!text.contains('\n')).then(|| text.to_string())
}

/// A scalar in `style`, with the space after its key's colon and its line
/// end.
fn scalar(style: Style, value: &Value) -> Option<String> {
    let Value::String(text) = value else {
        return Some(format!(" {}\n", preserve::json(value)));
    };
    match style {
        Style::Single if !text.contains(['\n', '\r']) => {
            Some(format!(" '{}'\n", text.replace('\'', "''")))
        }
        Style::Double => Some(format!(" {}\n", serde_json::to_string(text).ok()?)),
        Style::Literal => block(text, '|'),
        Style::Folded if !text.trim_end_matches('\n').contains('\n') => block(text, '>'),
        Style::Folded => block(text, '|'),
        Style::Plain | Style::Day if !text.contains(['\n', '\r']) && !text.trim().is_empty() => {
            Some(format!(" {text}\n"))
        }
        _ => None,
    }
}

/// A block scalar of `text`, kept by `|` or folded by `>`.
fn block(text: &str, indicator: char) -> Option<String> {
    let (lines, chomp) = match text.strip_suffix('\n') {
        Some(rest) if !rest.ends_with('\n') => (rest, ""),
        Some(_) => return None,
        None => (text, "-"),
    };
    if lines.contains('\r') || lines.starts_with([' ', '\t']) || lines.is_empty() {
        return None;
    }
    let indent = " ".repeat(BLOCK_INDENT);
    let body: String = lines
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                "\n".to_string()
            } else {
                format!("{indent}{line}\n")
            }
        })
        .collect();
    Some(format!(" {indicator}{chomp}\n{body}"))
}

/// Whether `line` reads back as `key` holding `meant`.
fn reads_as(line: &str, key: &str, meant: &Value) -> bool {
    document::read_map(line)
        .is_ok_and(|map| map.len() == 1 && map.get(key).is_some_and(|held| same_value(held, meant)))
}

/// The date alone of a time that is exactly midnight in UTC.
fn day_of(time: &str) -> Option<String> {
    let normalized = marfa_rules::time::normalize_bound(time, fields::OCCURRED_AT_FIELD).ok()?;
    let day = normalized.strip_suffix("T00:00:00.000Z")?;
    (day.len() == 10).then(|| day.to_string())
}

fn key_of(key: String, pair: Node<'_>, node: Node<'_>, text: &str) -> Key {
    match node.kind() {
        "block_sequence" | "flow_sequence" => {
            let first = preserve::children(node)
                .into_iter()
                .next()
                .and_then(preserve::sequence_value)
                .map(preserve::value_node);
            Key {
                key,
                style: if node.kind() == "block_sequence" {
                    Style::Block
                } else {
                    Style::Flow
                },
                items: first.and_then(|first| scalar_style(first, text)),
                indent: if node.kind() == "block_sequence" {
                    node.start_position()
                        .column
                        .saturating_sub(pair.start_position().column)
                } else {
                    0
                },
            }
        }
        "block_mapping" => Key::styled(key, Style::Block),
        "flow_mapping" => Key::styled(key, Style::Flow),
        _ => {
            let raw = text[node.byte_range()].trim();
            let style = match scalar_style(node, text) {
                Some(Style::Plain) if day_of(raw).as_deref() == Some(raw) => Style::Day,
                Some(style) => style,
                None => Style::Plain,
            };
            Key::styled(key, style)
        }
    }
}

fn scalar_style(node: Node<'_>, text: &str) -> Option<Style> {
    match node.kind() {
        "plain_scalar" => Some(Style::Plain),
        "single_quote_scalar" => Some(Style::Single),
        "double_quote_scalar" => Some(Style::Double),
        "block_scalar" => Some(if text[node.byte_range()].starts_with('>') {
            Style::Folded
        } else {
            Style::Literal
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn form(yaml: &str) -> Form {
        Form::of(
            &document::read(&format!("---\n{yaml}---\nbody\n")),
            |_, _| true,
        )
        .unwrap()
    }

    fn front(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn written(form: &Form, front: &Map<String, Value>) -> String {
        form.stand_in(front, "2026-10-11T00:00:00.000Z")
            .unwrap()
            .frontmatter_text()
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_form_holds_each_keys_style_in_order_and_no_value() {
        let yaml = "title: A title\nsaid: 'Said once'\nquoted: \"Said twice\"\noccurred_at: 2026-10-11\nstarts_at:\ntext: |\n  one\n  two\nabout: [\"[[A]]\", \"[[B]]\"]\ntags:\n  - a\n  - b\n";
        let found = form(yaml);
        let styles: Vec<(&str, Style)> = found
            .keys
            .iter()
            .map(|key| (key.key.as_str(), key.style))
            .collect();
        assert_eq!(
            styles,
            vec![
                ("title", Style::Plain),
                ("said", Style::Single),
                ("quoted", Style::Double),
                ("occurred_at", Style::Day),
                ("starts_at", Style::Empty),
                ("text", Style::Literal),
                ("about", Style::Flow),
                ("tags", Style::Block),
            ]
        );
        assert_eq!(found.keys[6].items, Some(Style::Double));
        assert_eq!(found.keys[7].items, Some(Style::Plain));
        assert_eq!(found.keys[7].indent, 2);
        let sent = found.value().to_string();
        for value in [
            "A title",
            "Said once",
            "Said twice",
            "2026-10-11",
            "one",
            "[[A]]",
        ] {
            assert!(!sent.contains(value), "the form holds {value}: {sent}");
        }
    }

    #[test]
    fn a_form_written_again_gives_the_same_frontmatter() {
        let yaml = "title: Plain\nsaid: 'it''s'\nquoted: \"double\"\noccurred_at: 2026-10-11\nstarts_at:\ntext: |\n  one\n  two\nabout: [\"[[A]]\", \"[[B]]\"]\ntags:\n- a\n- b\nfolded: >-\n  one line\nmarfa_id: 0193a1b2-0000-7000-8000-000000000001\nmarfa_version: 4\n";
        let read = document::read(&format!("---\n{yaml}---\n"));
        let found = Form::of(&read, |_, _| true).unwrap();
        let mut values = read.front.clone();
        values.remove("starts_at");
        values.insert("occurred_at".into(), json!("2026-10-11T00:00:00.000Z"));
        assert_eq!(written(&found, &values), yaml);
    }

    #[test]
    fn a_day_is_written_as_a_day_only_at_midnight_in_utc() {
        let found = form("occurred_at: 2026-10-11\n");
        assert_eq!(
            written(
                &found,
                &front(json!({"occurred_at": "2026-10-11T00:00:00.000Z"}))
            ),
            "occurred_at: 2026-10-11\n"
        );
        assert_eq!(
            written(
                &found,
                &front(json!({"occurred_at": "2026-10-11T09:30:00.000Z"}))
            ),
            "occurred_at: \"2026-10-11T09:30:00.000Z\"\n"
        );
    }

    #[test]
    fn a_full_time_stays_full() {
        let found = form("occurred_at: 2026-10-11T00:00:00.000Z\n");
        assert_eq!(found.keys[0].style, Style::Plain);
        assert_eq!(
            written(
                &found,
                &front(json!({"occurred_at": "2026-10-11T00:00:00.000Z"}))
            ),
            "occurred_at: 2026-10-11T00:00:00.000Z\n"
        );
    }

    #[test]
    fn an_empty_key_is_written_empty_and_a_key_with_no_value_left_out() {
        let found = form("title: A\nstarts_at:\ngone: x\n");
        assert_eq!(
            written(&found, &front(json!({"title": "A"}))),
            "title: A\nstarts_at:\n"
        );
    }

    #[test]
    fn keys_new_to_the_form_follow_in_the_lines_order() {
        let found = form("b: 1\na: 2\n");
        assert_eq!(
            written(&found, &front(json!({"a": 2, "c": 3, "b": 1}))),
            "b: 1\na: 2\nc: 3\n"
        );
    }

    #[test]
    fn comments_are_not_carried_and_the_rest_of_the_form_is() {
        let found = form("# a comment\ntitle: 'A' # after\nstarts_at:\n");
        assert_eq!(
            found.keys,
            vec![
                Key::styled("title".into(), Style::Single),
                Key::styled("starts_at".into(), Style::Empty)
            ]
        );
        assert_eq!(
            written(&found, &front(json!({"title": "A"}))),
            "title: 'A'\nstarts_at:\n"
        );
    }

    #[test]
    fn a_key_left_out_is_not_in_the_form() {
        let read = document::read("---\ntitle: A\nrefused: secret\n---\n");
        let found = Form::of(&read, |key, _| key != "refused").unwrap();
        assert_eq!(found.keys, vec![Key::styled("title".into(), Style::Plain)]);
        assert!(!found.value().to_string().contains("refused"));
    }

    #[test]
    fn a_value_the_style_cannot_show_is_written_as_a_rewrite_writes_it() {
        let found = form("said: 'one'\n");
        assert_eq!(
            written(&found, &front(json!({"said": "two\nlines"}))),
            "said: \"two\\nlines\"\n"
        );
    }

    #[test]
    fn tags_written_on_one_line_stay_on_one_line() {
        let found = form("tags: a, b\n");
        assert_eq!(
            written(&found, &front(json!({"tags": ["a", "b"]}))),
            "tags: a, b\n"
        );
    }

    #[test]
    fn a_form_that_is_not_one_is_read_as_none() {
        assert_eq!(Form::read(&json!("plain")), None);
        assert_eq!(
            Form::read(&json!({"keys": [{"key": "a", "style": "loud"}]})),
            None
        );
        assert_eq!(Form::read(&form("a: 1\n").value()), Some(form("a: 1\n")));
    }

    #[test]
    fn a_form_too_large_to_send_is_not_kept() {
        let yaml: String = (0..400)
            .map(|at| format!("key_with_a_long_name_{at}: 1\n"))
            .collect();
        let read = document::read(&format!("---\n{yaml}---\n"));
        assert_eq!(Form::of(&read, |_, _| true), None);
    }
}
