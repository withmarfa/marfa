//! Local YAML edits use grammar-owned byte ranges, never token guesses. The
//! existing semantic reader validates the complete result before it can land.
use std::collections::{HashMap, HashSet};
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

/// Resolve keys in their complete document context: aliases can name keys, and
/// YAML's ordered mapping preserves the correspondence to grammar entries.
fn keys(
    node: Node<'_>,
    yaml: &yaml_rust2::Yaml,
    result: &mut HashMap<usize, String>,
) -> Result<()> {
    let node = value_node(node);
    match (node.kind(), yaml) {
        ("block_mapping" | "flow_mapping", yaml_rust2::Yaml::Hash(map)) => {
            let pairs = children(node);
            if pairs.len() != map.len() {
                return Err(invalid("syntax and mapping values disagree"));
            }
            for (pair, (key, value)) in pairs.into_iter().zip(map.iter()) {
                result.insert(
                    pair.start_byte(),
                    key.as_str()
                        .ok_or_else(|| invalid("a mapping key is not text"))?
                        .into(),
                );
                if let Some(child) = pair.child_by_field_name("value") {
                    keys(child, value, result)?;
                }
            }
        }
        ("block_sequence" | "flow_sequence", yaml_rust2::Yaml::Array(values)) => {
            let nodes = children(node);
            if nodes.len() != values.len() {
                return Err(invalid("syntax and sequence values disagree"));
            }
            for (child, value) in nodes.into_iter().zip(values) {
                if let Some(child) = sequence_value(child) {
                    keys(child, value, result)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn entries<'a>(node: Node<'a>, keys: &HashMap<usize, String>) -> Result<Vec<(String, Node<'a>)>> {
    children(node)
        .into_iter()
        .map(|pair| {
            Ok((
                keys.get(&pair.start_byte())
                    .ok_or_else(|| invalid("a mapping entry has no key"))?
                    .clone(),
                pair,
            ))
        })
        .collect()
}

fn sequence_value(child: Node<'_>) -> Option<Node<'_>> {
    if child.kind() == "block_sequence_item" {
        children(child).first().copied()
    } else {
        Some(child)
    }
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
    keys: &'a HashMap<usize, String>,
    safe_aliases: &'a HashSet<usize>,
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
    }

    /// Keep exactly one existing comma between each surviving pair of entries.
    /// A trailing comma remains only when the original collection had one.
    fn separators(&mut self, collection: Node<'_>, surviving: &[Node<'_>]) {
        let mut cursor = collection.walk();
        let commas: Vec<_> = collection
            .children(&mut cursor)
            .filter(|n| n.kind() == ",")
            .collect();
        let original = children(collection);
        let trailing = commas.last().is_some_and(|comma| {
            original
                .last()
                .is_some_and(|last| comma.start_byte() >= last.end_byte())
        });
        let mut kept = HashSet::new();
        for pair in surviving.windows(2) {
            if let Some(comma) = commas.iter().find(|comma| {
                comma.start_byte() >= pair[0].end_byte() && comma.end_byte() <= pair[1].start_byte()
            }) {
                kept.insert(comma.start_byte());
            }
        }
        if trailing
            && let (Some(last), Some(comma)) = (surviving.last(), commas.last())
            && comma.start_byte() >= last.end_byte()
        {
            kept.insert(comma.start_byte());
        }
        for comma in commas {
            if !kept.contains(&comma.start_byte()) {
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
            let retained = |node: &Node<'_>| {
                !self.edits.iter().any(|edit| {
                    edit.text.is_empty()
                        && edit.span.start <= node.start_byte()
                        && edit.span.end >= node.end_byte()
                })
            };
            let last = collection
                .children(&mut cursor)
                .filter(|n| !n.is_extra() && n.end_byte() <= end && retained(n))
                .last();
            let prefix = if children(collection).iter().all(|n| !retained(n)) {
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

    fn through_line(&self, end: usize) -> usize {
        if self.source[..end].ends_with('\n') {
            end
        } else {
            end + self.source[end..]
                .find('\n')
                .map_or(self.source.len() - end, |at| at + 1)
        }
    }

    fn sequence(&mut self, node: Node<'_>, old: &[Value], new: &[Value]) -> Result<()> {
        let nodes = children(node);
        if nodes.len() != old.len() {
            return Err(invalid("syntax and sequence values disagree"));
        }
        let matches = aligned(old, new);
        let flow = node.kind() == "flow_sequence";
        let indent = " ".repeat(node.start_position().column);
        let end = if flow {
            node.end_byte()
        } else {
            self.through_line(nodes.last().unwrap().end_byte())
        };
        let mut pieces = Vec::new();
        for (target, desired) in new.iter().enumerate() {
            if let Some(i) = matches.iter().position(|m| *m == Some(target)) {
                let child = nodes[i];
                let span = if flow {
                    child.byte_range()
                } else {
                    child.start_byte()
                        ..nodes
                            .get(i + 1)
                            .map_or(end, |next| next.start_byte() - indent.len())
                };
                let before = self.edits.len();
                if let Some(value) = sequence_value(child) {
                    self.edit(value, &old[i], desired)?;
                } else if !desired.is_null() {
                    self.edits.push(Edit {
                        span: child.end_byte()..child.end_byte(),
                        text: format!(" {}", json(desired)),
                    });
                }
                let mut edits = self.edits.split_off(before);
                for edit in &mut edits {
                    if edit.span.start < span.start || edit.span.end > span.end {
                        return Err(invalid("a child edit exceeds its source range"));
                    }
                    edit.span = (edit.span.start - span.start)..(edit.span.end - span.start);
                }
                let rendered = apply(&self.source[span], edits)?;
                let tail = if flow {
                    // Commas belong to the collection. All other bytes in the
                    // gap travel with the child, including inline comments.
                    let tail = child.end_byte()
                        ..nodes
                            .get(i + 1)
                            .map_or(node.end_byte() - 1, Node::start_byte);
                    let mut cursor = node.walk();
                    let edits = node
                        .children(&mut cursor)
                        .filter(|n| {
                            n.kind() == ","
                                && n.start_byte() >= tail.start
                                && n.end_byte() <= tail.end
                        })
                        .map(|comma| Edit {
                            span: (comma.start_byte() - tail.start)
                                ..(comma.end_byte() - tail.start),
                            text: String::new(),
                        })
                        .collect();
                    apply(&self.source[tail], edits)?
                } else {
                    String::new()
                };
                pieces.push((rendered, tail));
            } else {
                pieces.push(if flow {
                    (json(desired), String::new())
                } else {
                    (
                        format!("- {}{}", json(desired), self.newline),
                        String::new(),
                    )
                });
            }
        }
        let (span, text) = if flow {
            let mut text = self.source
                [node.start_byte()..nodes.first().map_or(node.end_byte() - 1, Node::start_byte)]
                .to_owned();
            let mut cursor = node.walk();
            let trailing = node.children(&mut cursor).any(|n| {
                n.kind() == ","
                    && nodes
                        .last()
                        .is_some_and(|last| n.start_byte() >= last.end_byte())
            });
            for (i, (piece, tail)) in pieces.iter().enumerate() {
                text.push_str(piece);
                if i + 1 < pieces.len() || trailing {
                    text.push(',');
                }
                text.push_str(tail);
            }
            text.push(']');
            (node.byte_range(), text)
        } else {
            (
                node.start_byte()..end,
                pieces
                    .into_iter()
                    .map(|(piece, _)| piece)
                    .collect::<Vec<_>>()
                    .join(&indent),
            )
        };
        if self.source[span.clone()] != text {
            self.edits.push(Edit { span, text });
        }
        Ok(())
    }

    fn edit(&mut self, wrapper: Node<'_>, old: &Value, new: &Value) -> Result<()> {
        let node = value_node(wrapper);
        if node.kind() == "alias" {
            if !self.safe_aliases.contains(&node.start_byte()) {
                self.replace(node, new);
            }
            return Ok(());
        }
        match (old, new, node.kind()) {
            (Value::Object(old), Value::Object(new), "block_mapping" | "flow_mapping")
                if !new.is_empty() =>
            {
                let mut present = Vec::new();
                let mut surviving = Vec::new();
                for (name, pair) in entries(node, self.keys)? {
                    present.push(name.clone());
                    let old = old
                        .get(&name)
                        .ok_or_else(|| invalid("syntax and field values disagree"))?;
                    match new.get(&name) {
                        None => self.remove(pair, node),
                        Some(new) => {
                            surviving.push(pair);
                            let key_node = pair.child_by_field_name("key").unwrap_or(pair);
                            let key_value = Value::String(name.clone());
                            self.edit(key_node, &key_value, &key_value)?;
                            match pair.child_by_field_name("value") {
                                Some(value) => self.edit(value, old, new)?,
                                None if !same_value(old, new) => {
                                    self.edits.push(Edit {
                                        span: pair.end_byte()..pair.end_byte(),
                                        text: format!(
                                            "{} {}",
                                            if pair.kind() == "flow_node" { " :" } else { "" },
                                            json(new)
                                        ),
                                    });
                                }
                                None => {}
                            }
                        }
                    }
                }
                if node.kind() == "flow_mapping" {
                    self.separators(node, &surviving);
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
                if old.len() != new.len() || old.iter().zip(new).any(|(a, b)| !same_value(a, b)) {
                    self.sequence(node, old, new)?;
                } else {
                    for (child, value) in children(node).into_iter().zip(old) {
                        if let Some(child) = sequence_value(child) {
                            self.edit(child, value, value)?;
                        }
                    }
                }
            }
            _ if same_value(old, new) => {}
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

/// Match equal children globally before pairing changed children. Each source
/// child is used once, so reorderings and duplicate values keep their spelling.
fn aligned(old: &[Value], new: &[Value]) -> Vec<Option<usize>> {
    let mut result = vec![None; old.len()];
    let mut used = vec![false; new.len()];
    for (i, value) in old.iter().enumerate() {
        if let Some(j) = new
            .iter()
            .enumerate()
            .position(|(j, target)| !used[j] && same_value(value, target))
        {
            result[i] = Some(j);
            used[j] = true;
        }
    }
    let mut remaining = used
        .iter()
        .enumerate()
        .filter_map(|(i, used)| (!used).then_some(i));
    for matched in &mut result {
        if matched.is_none() {
            *matched = remaining.next();
        }
    }
    result
}

/// Visit the planned source order, including mapping keys. An alias can retain
/// its spelling exactly when the preceding surviving anchor has its desired
/// value. This also handles reused names and sequence children that move.
fn aliases(
    wrapper: Node<'_>,
    source: &str,
    old: &Value,
    new: &Value,
    keys: &HashMap<usize, String>,
    anchors: &mut HashMap<String, Value>,
    safe: &mut HashSet<usize>,
) -> Result<()> {
    for child in children(wrapper) {
        if child.kind() == "anchor" {
            anchors.insert(
                source[child.start_byte() + 1..child.end_byte()].into(),
                new.clone(),
            );
        }
    }
    let node = value_node(wrapper);
    match (node.kind(), old, new) {
        ("alias", _, _) => {
            if anchors
                .get(&source[node.start_byte() + 1..node.end_byte()])
                .is_some_and(|referent| same_value(referent, new))
            {
                safe.insert(node.start_byte());
            }
        }
        ("block_mapping" | "flow_mapping", Value::Object(old), Value::Object(new))
            if !new.is_empty() =>
        {
            for (name, pair) in entries(node, keys)? {
                if let Some(desired) = new.get(&name) {
                    let key = Value::String(name.clone());
                    aliases(
                        pair.child_by_field_name("key").unwrap_or(pair),
                        source,
                        &key,
                        &key,
                        keys,
                        anchors,
                        safe,
                    )?;
                    if let Some(value) = pair.child_by_field_name("value") {
                        aliases(value, source, &old[&name], desired, keys, anchors, safe)?;
                    }
                }
            }
        }
        ("block_sequence" | "flow_sequence", Value::Array(old), Value::Array(new))
            if !new.is_empty() =>
        {
            let nodes = children(node);
            let matches = aligned(old, new);
            for (j, desired) in new.iter().enumerate() {
                if let Some(i) = matches.iter().position(|m| *m == Some(j))
                    && let Some(child) = sequence_value(nodes[i])
                {
                    aliases(child, source, &old[i], desired, keys, anchors, safe)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn write(source: &str, old: &Value, new: &Value, newline: &str) -> Result<String> {
    let tree = parse(source)?;
    let semantic = yaml_rust2::YamlLoader::load_from_str(source).map_err(invalid)?;
    let mut key_names = HashMap::new();
    if let Some(yaml) = semantic.first() {
        keys(tree.root_node(), yaml, &mut key_names)?;
    }
    let mut safe_aliases = HashSet::new();
    aliases(
        tree.root_node(),
        source,
        old,
        new,
        &key_names,
        &mut HashMap::new(),
        &mut safe_aliases,
    )?;
    let mut editor = Editor {
        source,
        newline,
        edits: Vec::new(),
        keys: &key_names,
        safe_aliases: &safe_aliases,
    };
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
