//! Local YAML edits use grammar-owned byte ranges, never token guesses. The
//! existing semantic reader validates the complete result before it can land.
use std::collections::HashMap;
use std::ops::Range;

use serde_json::Value;
use tree_sitter::{Node, Parser};

use super::document::same_value;
use crate::error::CoreError;

type Result<T> = std::result::Result<T, CoreError>;

fn invalid(reason: impl std::fmt::Display) -> CoreError {
    CoreError::Invalid(format!("cannot preserve this frontmatter: {reason}"))
}

fn parse(source: &str) -> Result<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_yaml::LANGUAGE.into())
        .map_err(invalid)?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| invalid("YAML parsing stopped"))?;
    if tree.root_node().has_error() {
        return Err(invalid("its YAML syntax cannot be edited safely"));
    }
    Ok(tree)
}

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    node.named_children(&mut node.walk())
        .filter(|n| n.kind() != "comment")
        .collect()
}

fn value_node(mut node: Node<'_>) -> Node<'_> {
    while matches!(
        node.kind(),
        "stream" | "document" | "block_node" | "flow_node"
    ) {
        let Some(child) = children(node)
            .into_iter()
            .find(|n| !matches!(n.kind(), "anchor" | "tag"))
        else {
            break;
        };
        node = child;
    }
    node
}

fn key(node: Node<'_>, source: &str) -> Result<String> {
    let value =
        yaml_rust2::YamlLoader::load_from_str(&source[node.byte_range()]).map_err(invalid)?;
    value
        .first()
        .and_then(yaml_rust2::Yaml::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid("a mapping key is not text"))
}

fn entries<'a>(node: Node<'a>, source: &str) -> Result<Vec<(String, Node<'a>)>> {
    children(node)
        .into_iter()
        .map(|pair| {
            let k = pair
                .child_by_field_name("key")
                .or_else(|| (pair.kind() == "flow_node").then_some(pair))
                .ok_or_else(|| invalid("a mapping entry has no key"))?;
            Ok((key(k, source)?, pair))
        })
        .collect()
}

fn json(value: &Value) -> String {
    if let Value::String(text) = value
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '/'))
        && yaml_rust2::YamlLoader::load_from_str(text)
            .ok()
            .is_some_and(|values| values.first().and_then(yaml_rust2::Yaml::as_str) == Some(text))
    {
        return text.clone();
    }
    value.to_string()
}

fn emitted_key(key: &str) -> String {
    if key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && yaml_rust2::YamlLoader::load_from_str(key)
            .ok()
            .is_some_and(|values| values.first().and_then(yaml_rust2::Yaml::as_str) == Some(key))
    {
        key.into()
    } else {
        json(&Value::String(key.into()))
    }
}

struct Edit {
    span: Range<usize>,
    text: String,
}

struct Editor<'a> {
    source: &'a str,
    newline: &'a str,
    edits: Vec<Edit>,
}

impl Editor<'_> {
    fn replace(&mut self, node: Node<'_>, value: &Value) {
        let mut text = json(value);
        if self.source[node.byte_range()].ends_with('\n') {
            text.push_str(self.newline);
        }
        self.edits.push(Edit {
            span: node.byte_range(),
            text,
        });
    }

    fn remove(&mut self, node: Node<'_>, collection: Node<'_>) {
        let mut span = node.byte_range();
        if !collection.kind().starts_with("flow_") {
            let start = self.source[..span.start].rfind('\n').map_or(0, |at| at + 1);
            if self.source[start..span.start].trim().is_empty() {
                span.start = start;
                if !self.source[..span.end].ends_with('\n') {
                    span.end += self.source[span.end..]
                        .find('\n')
                        .map_or(self.source.len() - span.end, |at| at + 1);
                }
            }
        }
        self.edits.push(Edit {
            span,
            text: String::new(),
        });
        if collection.kind().starts_with("flow_") {
            let mut cursor = collection.walk();
            let tokens: Vec<_> = collection.children(&mut cursor).collect();
            let at = tokens.iter().position(|n| *n == node).unwrap_or(0);
            let comma = tokens[at + 1..]
                .iter()
                .find(|n| !n.is_extra())
                .filter(|n| n.kind() == ",")
                .or_else(|| {
                    tokens[..at]
                        .iter()
                        .rev()
                        .find(|n| !n.is_extra())
                        .filter(|n| n.kind() == ",")
                });
            if let Some(comma) = comma {
                self.edits.push(Edit {
                    span: comma.byte_range(),
                    text: String::new(),
                });
            }
        }
    }

    fn append(&mut self, collection: Node<'_>, values: Vec<String>) {
        if values.is_empty() {
            return;
        }
        let flow = collection.kind().starts_with("flow_");
        let (offset, text) = if flow {
            let end = collection.end_byte() - 1;
            let mut cursor = collection.walk();
            let last = collection
                .children(&mut cursor)
                .filter(|n| !n.is_extra() && n.end_byte() <= end)
                .last();
            let prefix = if children(collection).is_empty() {
                ""
            } else if last.is_some_and(|n| n.kind() == ",") {
                " "
            } else {
                ", "
            };
            (end, format!("{prefix}{}", values.join(", ")))
        } else {
            let mut end = collection.end_byte();
            if end > 0 && !self.source[..end].ends_with('\n') {
                end += self.source[end..]
                    .find('\n')
                    .map_or(self.source.len() - end, |n| n + 1);
            }
            let indent = " ".repeat(collection.start_position().column);
            let prefix = if end > 0 && !self.source[..end].ends_with('\n') {
                self.newline
            } else {
                ""
            };
            let text = values
                .into_iter()
                .map(|v| format!("{indent}{v}{}", self.newline))
                .collect::<String>();
            (end, format!("{prefix}{text}"))
        };
        self.edits.push(Edit {
            span: offset..offset,
            text,
        });
    }

    fn insert_before(&mut self, collection: Node<'_>, item: Node<'_>, values: &[Value]) {
        let (offset, text) = if collection.kind() == "flow_sequence" {
            (
                item.start_byte(),
                format!(
                    "{}, ",
                    values.iter().map(json).collect::<Vec<_>>().join(", ")
                ),
            )
        } else {
            let start = self.source[..item.start_byte()]
                .rfind('\n')
                .map_or(0, |at| at + 1);
            let indent = " ".repeat(collection.start_position().column);
            (
                start,
                values
                    .iter()
                    .map(|v| format!("{indent}- {}{}", json(v), self.newline))
                    .collect(),
            )
        };
        self.edits.push(Edit {
            span: offset..offset,
            text,
        });
    }

    fn edit(&mut self, wrapper: Node<'_>, old: &Value, new: &Value) -> Result<()> {
        if same_value(old, new) {
            return Ok(());
        }
        let node = value_node(wrapper);
        match (old, new, node.kind()) {
            (Value::Object(old), Value::Object(new), "block_mapping" | "flow_mapping")
                if !new.is_empty() =>
            {
                let mut present = Vec::new();
                for (name, pair) in entries(node, self.source)? {
                    present.push(name.clone());
                    let old = old
                        .get(&name)
                        .ok_or_else(|| invalid("syntax and field values disagree"))?;
                    match new.get(&name) {
                        None => self.remove(pair, node),
                        Some(new) => match pair.child_by_field_name("value") {
                            Some(value) => self.edit(value, old, new)?,
                            None if !same_value(old, new) => {
                                self.edits.push(Edit {
                                    span: pair.end_byte()..pair.end_byte(),
                                    text: format!(
                                        "{} {}",
                                        if pair.kind() == "flow_node" { ":" } else { "" },
                                        json(new)
                                    ),
                                });
                            }
                            None => {}
                        },
                    }
                }
                self.append(
                    node,
                    new.iter()
                        .filter(|(k, _)| !present.contains(k))
                        .map(|(k, v)| format!("{}: {}", emitted_key(k), json(v)))
                        .collect(),
                );
            }
            (Value::Array(old), Value::Array(new), "block_sequence" | "flow_sequence")
                if !new.is_empty() =>
            {
                let nodes = children(node);
                if nodes.len() != old.len() {
                    return Err(invalid("syntax and sequence values disagree"));
                }
                let matches = aligned(old, new);
                let mut next = 0;
                for (i, child) in nodes.iter().enumerate() {
                    let Some(target) = matches[i] else {
                        self.remove(*child, node);
                        continue;
                    };
                    if next < target {
                        self.insert_before(node, *child, &new[next..target]);
                    }
                    let value = &new[target];
                    let value_node = if child.kind() == "block_sequence_item" {
                        children(*child).first().copied()
                    } else {
                        Some(*child)
                    };
                    if let Some(child) = value_node {
                        self.edit(child, &old[i], value)?;
                    } else if !value.is_null() {
                        self.edits.push(Edit {
                            span: child.end_byte()..child.end_byte(),
                            text: format!(" {}", json(value)),
                        });
                    }
                    next = target + 1;
                }
                let prefix = if node.kind() == "block_sequence" {
                    "- "
                } else {
                    ""
                };
                self.append(
                    node,
                    new[next..]
                        .iter()
                        .map(|v| format!("{prefix}{}", json(v)))
                        .collect(),
                );
            }
            _ => {
                for child in children(wrapper)
                    .into_iter()
                    .filter(|child| child.kind() == "tag")
                {
                    self.edits.push(Edit {
                        span: child.byte_range(),
                        text: String::new(),
                    });
                }
                self.replace(node, new);
            }
        }
        Ok(())
    }
}

/// Retain equal sequence children across insertions/removals. Between equal
/// children, pair replacements so nested values can still be edited locally.
fn aligned(old: &[Value], new: &[Value]) -> Vec<Option<usize>> {
    let mut result = vec![None; old.len()];
    let (mut a, mut b) = (0, 0);
    while a < old.len() && b < new.len() {
        if same_value(&old[a], &new[b]) {
            result[a] = Some(b);
            a += 1;
            b += 1;
            continue;
        }
        let old_match = old[a + 1..]
            .iter()
            .position(|v| same_value(v, &new[b]))
            .map(|i| a + 1 + i);
        let new_match = new[b + 1..]
            .iter()
            .position(|v| same_value(v, &old[a]))
            .map(|i| b + 1 + i);
        match (old_match, new_match) {
            (Some(next), None) => a = next,
            (None, Some(next)) => b = next,
            (Some(next_a), Some(next_b)) if next_a - a <= next_b - b => a = next_a,
            (Some(_), Some(next)) => b = next,
            (None, None) => {
                result[a] = Some(b);
                a += 1;
                b += 1;
            }
        }
    }
    result
}

fn aliases(
    node: Node<'_>,
    source: &str,
    old: &Value,
    new: Option<&Value>,
    anchors: &mut HashMap<String, bool>,
    expand: &mut Vec<Edit>,
) -> Result<()> {
    for child in children(node) {
        if child.kind() == "anchor" {
            anchors.insert(
                source[child.start_byte() + 1..child.end_byte()].into(),
                !new.is_some_and(|new| same_value(old, new)),
            );
        }
    }
    let value = value_node(node);
    match value.kind() {
        "alias"
            if anchors.get(&source[value.start_byte() + 1..value.end_byte()]) == Some(&true) =>
        {
            expand.push(Edit {
                span: value.byte_range(),
                text: json(old),
            });
        }
        "block_mapping" | "flow_mapping" => {
            for (name, pair) in entries(value, source)? {
                if let Some(child) = pair.child_by_field_name("value") {
                    aliases(
                        child,
                        source,
                        &old[&name],
                        new.and_then(|n| n.get(&name)),
                        anchors,
                        expand,
                    )?;
                }
            }
        }
        "block_sequence" | "flow_sequence" => {
            let matches = aligned(
                old.as_array().map_or(&[], Vec::as_slice),
                new.and_then(Value::as_array).map_or(&[], Vec::as_slice),
            );
            for (i, child) in children(value).iter().enumerate() {
                let child = if child.kind() == "block_sequence_item" {
                    children(*child).first().copied()
                } else {
                    Some(*child)
                };
                if let Some(child) = child {
                    aliases(
                        child,
                        source,
                        &old[i],
                        matches
                            .get(i)
                            .copied()
                            .flatten()
                            .and_then(|j| new.and_then(|n| n.get(j))),
                        anchors,
                        expand,
                    )?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn write(source: &str, old: &Value, new: &Value, newline: &str) -> Result<String> {
    let tree = parse(source)?;
    let mut editor = Editor {
        source,
        newline,
        edits: Vec::new(),
    };
    aliases(
        tree.root_node(),
        source,
        old,
        Some(new),
        &mut HashMap::new(),
        &mut editor.edits,
    )?;
    // Descendants with affected aliases must be visited even when their values
    // stay equal. Expand them first, then parse again for the ordinary edits.
    if !editor.edits.is_empty() {
        let expanded = apply(source, editor.edits)?;
        return write(&expanded, old, new, newline);
    }
    let root = value_node(tree.root_node());
    if source.trim().is_empty() || root.kind() == "stream" {
        let Value::Object(map) = new else {
            return Err(invalid("frontmatter is not a map"));
        };
        let addition = map
            .iter()
            .map(|(k, v)| format!("{}: {}{newline}", emitted_key(k), json(v)))
            .collect::<String>();
        return Ok(format!("{source}{addition}"));
    }
    editor.edit(tree.root_node(), old, new)?;
    let result = apply(source, editor.edits)?;
    parse(&result)?;
    Ok(result)
}

fn apply(source: &str, mut edits: Vec<Edit>) -> Result<String> {
    edits.sort_by_key(|edit| (edit.span.start, edit.span.end));
    let mut result = String::new();
    let mut end = 0;
    for edit in edits {
        if edit.span.start < end {
            if edit.text.is_empty() {
                end = end.max(edit.span.end);
                continue;
            }
            return Err(invalid("source edits overlap"));
        }
        result.push_str(&source[end..edit.span.start]);
        result.push_str(&edit.text);
        end = edit.span.end;
    }
    result.push_str(&source[end..]);
    Ok(result)
}
